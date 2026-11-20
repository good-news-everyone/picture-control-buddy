// The Comparison screen (spec/ui.md step 2, spec/ui-plan.md §4 stage 4): the fitted render
// next to the decoded target — side by side, a curtain or a hold-key swap, with a shared
// zoom/pan; the pair strip, the strength slider and the version history; the two exits.
//
// Geometry decision (the ui-plan.md §6 risk "Preview/report geometry", recorded here and in
// the stage-4 status): the render side covers the aligned working rectangle (0..W, 0..H) —
// app.js develops the frame through the renderer, then warpToView() (web/lib/pair-prepare.js)
// applies the pair's fitted transform chain at up to the developed frame's resolution (until
// 2026-11-20 it was the H3×W3 grid itself, a 256-px thumbnail). The report grid is the same
// rectangle 3×3-shrunk (warpToWorking), so the error map and the region highlight overlay the
// same pixels; the target side is its own full-color bitmap fit into the same
// viewport mapping. The canonical image space for the view math is the working size W×H
// (prepared.size): a report pixel covers exactly a 3×3 block of it.
//
// Ownership: this module owns the DOM, the view state (mode/zoom/pan/curtain) and the
// generation bookkeeping of the render requests; app.js owns the session and produces the
// developed+warped render side via the renderSide callback (generation-checked: a stale
// result resolves null and the last good frame stays on the screen).
import { t } from "./i18n.js";
import { isRawReady, isTargetReady } from "./session.js";

const $ = (id) => document.getElementById(id);

// The compare modes (spec/ui.md step 2).
const MODES = ["side", "curtain", "toggle"];

// A pair is selectable for the comparison: decoded, prepared and not blocked (a RAW error,
// a failed alignment — ncc_low — or a too-small target excludes it, as in the fit).
export function compareUsable(p) {
  return !!p && isRawReady(p) && isTargetReady(p) && !!p.prepared
    && !p.blocked && !p.prepared.blocked && !p.fitBlocked;
}

export function createCompare({ state, renderSide, onVersionSelected, onStrength,
                                onManual, onMore, onStart, onPairSelected }) {
  const canvas = $("cc");
  const ctx = canvas.getContext("2d");
  const stripEl = $("cmp-strip");
  const versionsEl = $("cmp-versions");
  const strengthInput = $("cmp-strength");
  const strengthVal = $("cmp-strength-val");

  // ---------- view state ----------
  let mode = "side";
  let curtain = 0.5;             // the divider position, a fraction of the canvas width
  let showTarget = false;        // the hold-key swap (Space)
  const view = { scale: 1, x: 0, y: 0 };   // user zoom multiplier + pan in canvas pixels
  let renderBitmap = null;       // { data, w, h } — the render side (the working rectangle, finer)
  let targetBitmap = null;       // { data, w, h } — the decoded target at its own resolution
  let renderCv = null, targetCv = null;    // the ImageData canvases
  let requestedGen = 0;          // the generation of the latest render request
  let appliedGen = 0;            // the generation of the frame on the screen
  let pending = false;           // a request is outstanding (its result not yet applied/discarded)
  let region = null;             // the report row highlight: { labels, group } (stage 5B)
  let regionCv = null;           // the cached overlay canvas (rebuilt when `region` changes)
  let mapCv = null;              // the report error-map canvas overlaid on the image (stage 5B)

  const pair = () => state.pairs.find((p) => p.id === state.selectedPairId);
  const version = () => state.versions.find((v) => v.id === state.selectedVersionId);

  // ---------- bitmaps ----------
  function toCanvas(bmp) {
    const c = document.createElement("canvas");
    c.width = bmp.w; c.height = bmp.h;
    const cx = c.getContext("2d");
    const im = cx.createImageData(bmp.w, bmp.h);
    for (let i = 0, j = 0; i < im.data.length; i += 4, j += 3) {
      im.data[i] = Math.round(255 * Math.min(1, Math.max(0, bmp.data[j])));
      im.data[i + 1] = Math.round(255 * Math.min(1, Math.max(0, bmp.data[j + 1])));
      im.data[i + 2] = Math.round(255 * Math.min(1, Math.max(0, bmp.data[j + 2])));
      im.data[i + 3] = 255;
    }
    cx.putImageData(im, 0, 0);
    return c;
  }

  // The target canvases, built once per decoded target (keyed by the target object): the
  // display canvas (capped at TARGET_LONG px on the long side — a 24-MP float→RGBA conversion
  // on every pair switch and every refresh cost ~0.5 s per pair, the strip rebuilt all of them)
  // and the strip thumbnail. A re-dropped target is a new object, so the cache follows it.
  const TARGET_LONG = 4096;
  const targetCache = new WeakMap();
  function targetCanvases(tg) {
    let c = targetCache.get(tg);
    if (c) return c;
    const full = toCanvas({ data: tg.rgb, w: tg.width, h: tg.height });
    const fit = (cv, long) => {
      const s = Math.min(1, long / Math.max(cv.width, cv.height));
      if (s === 1) return cv;
      const o = document.createElement("canvas");
      o.width = Math.max(1, Math.round(cv.width * s));
      o.height = Math.max(1, Math.round(cv.height * s));
      const ox = o.getContext("2d");
      ox.imageSmoothingEnabled = true;
      ox.imageSmoothingQuality = "high";
      ox.drawImage(cv, 0, 0, o.width, o.height);
      return o;
    };
    const display = fit(full, TARGET_LONG);
    c = { display, thumb: fit(display, 72) };
    targetCache.set(tg, c);
    return c;
  }

  // ---------- the render request (generation-checked, the loader.js rule) ----------
  function scheduleRender() {
    const p = pair(), v = version();
    if (!p || !v || !compareUsable(p)) return;
    const gen = ++requestedGen;
    pending = true;
    renderSide(p, v, state.strength, gen).then((side) => {
      if (gen !== requestedGen) return;      // superseded: the newer request owns the flag
      if (side) {                            // null — the LUT is still building; the ready
        pending = false;                     // path re-requests; the frame on the screen stays
        renderBitmap = side;
        renderCv = toCanvas(side);
        appliedGen = gen;
        draw();
      }
    }).catch(() => { if (gen === requestedGen) pending = false; });
  }

  // ---------- drawing ----------
  // The canvas coordinate space must equal the element's CSS box: every view mapping
  // (base(), viewportAt(), mapPoint(), the wheel/drag handlers) runs in canvas pixels,
  // while the mouse arrives in CSS pixels through getBoundingClientRect(). clientWidth/
  // clientHeight truncate a fractional box (e.g. 655.15 -> 655), stretching the bitmap
  // and skewing the mapping by up to a pixel; rounding the box keeps the three modes on
  // the same image-space mapping at any window size.
  function sizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // The shared mapping: image space (0..W, 0..H of the working size) -> canvas pixels.
  // Both halves/sides are placed through the same base scale and the same view, so the zoom
  // and the pan are shared by the render and the target (spec/ui.md step 2).
  function base() {
    const p = pair();
    if (!p) return 1;
    const { w: W, h: H } = p.prepared.size;
    return Math.min(canvas.width / W, canvas.height / H);
  }

  // The viewport rect an image point is shown through: the half under the cursor in the
  // side-by-side mode, the whole canvas otherwise. Both halves share the view, so the zoom
  // anchors at the cursor's own viewport.
  function viewportAt(x) {
    const cw = canvas.width, ch = canvas.height;
    if (mode === "side") {
      return x < cw / 2 ? { x: 0, y: 0, w: cw / 2, h: ch }
                        : { x: cw / 2, y: 0, w: cw / 2, h: ch };
    }
    return { x: 0, y: 0, w: cw, h: ch };
  }

  // All viewports an overlay spans: the two halves in the side-by-side mode, the whole
  // canvas otherwise (overlays share the view mapping with the images).
  function viewports() {
    const cw = canvas.width, ch = canvas.height;
    return mode === "side" ? [{ x: 0, y: 0, w: cw / 2, h: ch },
                              { x: cw / 2, y: 0, w: cw / 2, h: ch }]
                           : [{ x: 0, y: 0, w: cw, h: ch }];
  }

  // Draws an image-sized canvas through the shared mapping of one viewport, on top of
  // the placed images (the report overlays: the region highlight and the error map).
  function placeThrough(img, rect, { alpha = 1, smoothing = true } = {}) {
    const p = pair();
    const { w: W, h: H } = p.prepared.size;
    const s = base() * view.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.translate(rect.x + rect.w / 2 + view.x, rect.y + rect.h / 2 + view.y);
    ctx.scale(s, s);
    ctx.translate(-W / 2, -H / 2);
    ctx.imageSmoothingEnabled = smoothing;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, 0, 0, W, H);
    ctx.restore();
  }

  // The report row highlight (stage 5B): the group's pixels from the report labels,
  // one report pixel = one 3×3 block of the working grid (the stage-4 geometry).
  function drawRegion() {
    const p = pair();
    if (!region || !p?.prepared) return;
    const { w: W, h: H } = p.prepared.size;
    const w3 = Math.floor(W / 3), h3 = Math.floor(H / 3);
    if (region.labels.length !== w3 * h3) return;
    if (!regionCv || regionCv._key !== region) {
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const cx = cv.getContext("2d");
      cx.fillStyle = "rgba(230, 230, 230, 0.45)";
      const { labels, group } = region;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== group) continue;
        cx.fillRect((i % w3) * 3, Math.floor(i / w3) * 3, 3, 3);
      }
      cv._key = region;
      regionCv = cv;
    }
    for (const rect of viewports()) placeThrough(regionCv, rect);
  }

  // The report error map overlaid on the image (the H3×W3 grid upscaled 3x, pixelated).
  function drawMap() {
    if (!mapCv || !pair()?.prepared) return;
    for (const rect of viewports())
      placeThrough(mapCv, rect, { alpha: 0.65, smoothing: false });
  }

  // Where an image point (fractions 0..1) lands on the screen; half — which side-mode half.
  function mapPoint(u, v2, half = "L") {
    const p = pair();
    const { w: W, h: H } = p.prepared.size;
    const rect = mode === "side" ? viewportAt(half === "L" ? 0 : canvas.width - 1)
                                 : viewportAt(0);
    const s = base() * view.scale;
    return { x: rect.x + rect.w / 2 + view.x + (u * W - W / 2) * s,
             y: rect.y + rect.h / 2 + view.y + (v2 * H - H / 2) * s };
  }

  function place(img, rect, clip, label) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.x, rect.y, clip.w, rect.h);
      ctx.clip();
    }
    const p = pair();
    const { w: W, h: H } = p.prepared.size;
    const s = base() * view.scale;
    ctx.translate(rect.x + rect.w / 2 + view.x, rect.y + rect.h / 2 + view.y);
    ctx.scale(s, s);
    ctx.translate(-W / 2, -H / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, W, H);
    ctx.restore();
    if (label) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fillRect(rect.x + 6, rect.y + 6, ctx.measureText(label).width + 12, 18);
      ctx.fillStyle = "#e6e6e6";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(label, rect.x + 12, rect.y + 19);
      ctx.restore();
    }
  }

  function draw() {
    sizeCanvas();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const p = pair();
    if (!p || !renderCv || !targetCv) return;
    const cw = canvas.width, ch = canvas.height;
    const full = { x: 0, y: 0, w: cw, h: ch };
    const labelR = t("RAW + NP3"), labelT = t("Target");
    if (mode === "side") {
      place(renderCv, { x: 0, y: 0, w: cw / 2, h: ch }, null, labelR);
      place(targetCv, { x: cw / 2, y: 0, w: cw / 2, h: ch }, null, labelT);
      ctx.fillStyle = "#3a3a3a";
      ctx.fillRect(cw / 2 - 1, 0, 2, ch);
    } else if (mode === "curtain") {
      const x = cw * curtain;
      place(renderCv, full, { x: 0, w: x }, null);
      place(targetCv, full, { x, w: cw - x }, null);
      ctx.fillStyle = "#e6e6e6";
      ctx.fillRect(x - 1, 0, 2, ch);
    } else {
      place(showTarget ? targetCv : renderCv, full, null, showTarget ? labelT : labelR);
    }
    drawRegion();
    drawMap();
  }

  // ---------- interactions ----------
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const rect = viewportAt(mx);
    const next = Math.min(40, Math.max(0.2, view.scale * Math.exp(-e.deltaY * 0.002)));
    const s0 = base() * view.scale, s1 = base() * next;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    // zoom to the cursor: keep the image point under the cursor fixed
    view.x = mx - cx - (mx - cx - view.x) * (s1 / s0);
    view.y = my - cy - (my - cy - view.y) * (s1 / s0);
    view.scale = next;
    draw();
  }, { passive: false });

  let drag = null;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    // in the curtain mode a drag on the divider moves it; anywhere else pans
    const onDivider = mode === "curtain" && Math.abs(x - canvas.width * curtain) <= 8;
    drag = { startX: x, startY: y, viewX: view.x, viewY: view.y, curtain: onDivider };
    if (onDivider) { curtain = Math.min(1, Math.max(0, x / canvas.width)); draw(); }
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (drag.curtain) {
      curtain = Math.min(1, Math.max(0, x / canvas.width));
    } else {
      view.x = drag.viewX + (x - drag.startX);
      view.y = drag.viewY + (y - drag.startY);
    }
    draw();
  });
  window.addEventListener("mouseup", () => { drag = null; });
  window.addEventListener("resize", () => draw());
  // The box also changes size without a window resize — the step switch (editor -> compare)
  // lays the screen out after the first draw, the report panel fills in, a scrollbar comes or
  // goes. A canvas buffer sized for the old box is then stretched by CSS (the image shows
  // shrunk/offset until the next interaction); redraw whenever the box itself changes.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { if (canvas.getBoundingClientRect().width > 0) draw(); })
      .observe(canvas.parentElement);
  }

  // the hold-key swap (Space) — before/after in the editor is guarded to the edit step,
  // so the key is free here. Ignored while a form control has the focus.
  window.addEventListener("keydown", (e) => {
    if (e.key !== " " || e.repeat || state.step !== "compare") return;
    if (e.target.closest?.("input, textarea, select, button")) return;
    e.preventDefault();
    showTarget = true;
    draw();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " " && showTarget) { showTarget = false; draw(); }
  });

  $("cmp-reset").addEventListener("click", () => {
    view.scale = 1; view.x = 0; view.y = 0;
    draw();
  });
  $("cmp-manual").addEventListener("click", () => onManual());
  $("cmp-more").addEventListener("click", () => onMore());
  $("cmp-start").addEventListener("click", () => onStart());

  for (const btn of document.querySelectorAll("#cmp-modes button")) {
    btn.addEventListener("click", () => {
      mode = btn.dataset.mode;
      for (const b of document.querySelectorAll("#cmp-modes button"))
        b.classList.toggle("active", b === btn);
      draw();
    });
  }

  // ---------- strength (0–150, spec/ui.md "Profile strength"; the report re-run is stage 5) ----------
  function paintStrength() {
    strengthInput.style.setProperty("--fill",
      `${(100 * (state.strength - 0) / 150).toFixed(1)}%`);
    strengthVal.textContent = `${state.strength}%`;
  }
  strengthInput.addEventListener("input", () => {
    onStrength(parseFloat(strengthInput.value));   // app.js: state + the panel + a re-render
  });

  // ---------- the pair strip ----------
  function thumbnail(p) {
    const box = document.createElement("div");
    box.className = "cmp-th";
    box.dataset.pairId = String(p.id);
    const blocked = !compareUsable(p);
    if (blocked) box.classList.add("blocked");
    if (p.id === state.selectedPairId) box.classList.add("selected");
    const src = targetCanvases(p.target).thumb;
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    box.append(c);
    box.title = p.rawFile ? p.rawFile.name : (p.targetFile ? p.targetFile.name : "");
    if (blocked) {
      const badge = document.createElement("span");
      badge.className = "cmp-th-badge";
      badge.dataset.i18n = "blocked";
      badge.textContent = t("blocked");
      box.append(badge);
    }
    box.addEventListener("click", () => {
      if (blocked) return;              // a blocked pair cannot be selected for compare
      state.selectedPairId = p.id;
      refresh();
      onPairSelected?.(p);              // the report view follows the pair (stage 5B)
    });
    return box;
  }

  // ---------- the version history ----------
  function versionButton(v) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.version = v.id;
    if (v.id === state.selectedVersionId) btn.classList.add("active");
    const id = document.createElement("span");
    id.className = "cmp-v-id";
    id.textContent = v.id;
    const badge = document.createElement("span");
    badge.className = "cmp-v-badge";
    const n = v.pairIds?.length ?? 0;
    badge.textContent = `${v.kind} · ${t("{n} pair(s)", { n })}`;
    btn.append(id, badge);
    btn.addEventListener("click", () => {
      if (state.selectedVersionId === v.id) return;
      state.selectedVersionId = v.id;
      onVersionSelected(v);      // app.js: the manual editor baseline, history untouched
      refresh();
    });
    return btn;
  }

  // ---------- refresh ----------
  function refresh() {
    stripEl.replaceChildren(...state.pairs.filter(isTargetReady).map(thumbnail));
    versionsEl.replaceChildren(...state.versions.map(versionButton));
    strengthInput.value = String(state.strength);
    paintStrength();
    const p = pair();
    if (p && isTargetReady(p)) {
      targetBitmap = { data: p.target.rgb, w: p.target.width, h: p.target.height };
      targetCv = targetCanvases(p.target).display;
    } else {
      targetBitmap = null; targetCv = null;
    }
    scheduleRender();
  }

  // for the tests: the view/mapping/generation state, no DOM internals
  function debug() {
    const p = pair();
    return {
      mode, curtain, showTarget,
      view: { ...view },
      requestedGen, appliedGen, pending,
      base: base(),
      working: p?.prepared ? { ...p.prepared.size } : null,
      aligned: renderBitmap ? { w: renderBitmap.w, h: renderBitmap.h } : null,
      mapPoint,
    };
  }

  return { refresh, draw, scheduleRender, debug,
           // stage 5B: the report view's overlays on the compare image
           showRegion(labels, group) {
             region = labels && group != null ? { labels, group } : null;
             if (!region) regionCv = null;
             draw();
           },
           setMapOverlay(cv) { mapCv = cv; draw(); },
           get pending() { return pending; },
           get appliedGen() { return appliedGen; },
           get requestedGen() { return requestedGen; } };
}
