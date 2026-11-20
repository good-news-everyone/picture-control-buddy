// The Comparison screen (spec/ui.md step 2, spec/ui-plan.md §4 stage 4): the fitted render
// next to the decoded target — side by side or a curtain, with a shared zoom/pan; the strength
// slider. One current profile, no version history (decision #12). Since stage 13 (spec/ui.md decision #11) it is the hub after
// the first fit: the strip at the top is the pair list (every pair a tile: active = in the
// selected version, dimmed otherwise; × removes a pair; the whole strip takes RAW drops, an
// inactive tile takes its JPEG), the color coverage sits above Versions and Refit at the
// bottom of the side panel.
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
import { isRawReady, isTargetReady, canAttachTarget, pickTargetFile,
         refitPairIds } from "./session.js";
import { renderCoverage, pairHints } from "./coverage-view.js";
import { fitCount } from "./start.js";

const $ = (id) => document.getElementById(id);

// The compare modes (spec/ui.md step 2; the key-toggle mode is removed, decision #8).
const MODES = ["side", "curtain"];

// A pair is selectable for the comparison: decoded, prepared and not blocked (a RAW error,
// a failed alignment — ncc_low — or a too-small target excludes it, as in the fit).
export function compareUsable(p) {
  return !!p && isRawReady(p) && isTargetReady(p) && !!p.prepared
    && !p.blocked && !p.prepared.blocked && !p.fitBlocked;
}

/** True when the pair is in the version's fit set (the version stores pair ids as strings). */
export function inVersion(p, v) {
  return !!v && (v.pairIds ?? []).includes(String(p.id));
}

export function createCompare({ state, renderSide, onStrength,
                                onManual, onPairSelected, onAddRaws, onAddTarget, onRemovePair,
                                onRefit, onCancelRefit, onDownload, onShare, setStatus = () => {} }) {
  const canvas = $("cc");
  const ctx = canvas.getContext("2d");
  const stripEl = $("cmp-strip");
  const coverageEl = $("cmp-coverage");
  const refitBtn = $("cmp-refit");
  const rawPicker = $("cmp-raw-file");
  const strengthInput = $("cmp-strength");
  const strengthVal = $("cmp-strength-val");

  // ---------- view state ----------
  let mode = "side";
  let curtain = 0.5;             // the divider position, a fraction of the canvas width
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
  // HiDPI (UX review, decision #15): the mapping stays in CSS pixels (cw × ch), the bitmap is
  // cw·dpr × ch·dpr and draw() scales the context by dpr — sharp on Retina / scaled Windows.
  let cw = 1, ch = 1, dpr = 1;
  function sizeCanvas() {
    const r = canvas.getBoundingClientRect();
    cw = Math.max(1, Math.round(r.width)); ch = Math.max(1, Math.round(r.height));
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // The shared mapping: image space (0..W, 0..H of the working size) -> canvas pixels.
  // Both halves/sides are placed through the same base scale and the same view, so the zoom
  // and the pan are shared by the render and the target (spec/ui.md step 2).
  function base() {
    const p = pair();
    if (!p) return 1;
    const { w: W, h: H } = p.prepared.size;
    return Math.min(cw / W, ch / H);
  }

  // The viewport rect an image point is shown through: the half under the cursor in the
  // side-by-side mode, the whole canvas otherwise. Both halves share the view, so the zoom
  // anchors at the cursor's own viewport.
  function viewportAt(x) {
    if (mode === "side") {
      return x < cw / 2 ? { x: 0, y: 0, w: cw / 2, h: ch }
                        : { x: cw / 2, y: 0, w: cw / 2, h: ch };
    }
    return { x: 0, y: 0, w: cw, h: ch };
  }

  // All viewports an overlay spans: the two halves in the side-by-side mode, the whole
  // canvas otherwise (overlays share the view mapping with the images).
  function viewports() {
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
    const rect = mode === "side" ? viewportAt(half === "L" ? 0 : cw - 1)
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
    if (label) drawLabel(label, rect.x + 6, rect.y + 6);
  }

  // A caption plate; `right` anchors it by its right edge. The font is set before measuring
  // (the plate used to be measured in the default 10px font and the 12px text overflowed it).
  function drawLabel(label, x, y, right = false) {
    ctx.save();
    ctx.font = "12px system-ui, sans-serif";
    const w = ctx.measureText(label).width + 12;
    const x0 = right ? x - w : x;
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(x0, y, w, 18);
    ctx.fillStyle = "#e6e6e6";
    ctx.fillText(label, x0 + 6, y + 13);
    ctx.restore();
  }

  function draw() {
    sizeCanvas();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    const p = pair();
    if (!p || !renderCv || !targetCv) return;
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
      // the handle in the middle of the divider and the side captions (decision #15)
      ctx.beginPath();
      ctx.arc(x, ch / 2, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1b1b1b";
      ctx.beginPath();
      ctx.moveTo(x - 3, ch / 2 - 5); ctx.lineTo(x - 7, ch / 2); ctx.lineTo(x - 3, ch / 2 + 5);
      ctx.moveTo(x + 3, ch / 2 - 5); ctx.lineTo(x + 7, ch / 2); ctx.lineTo(x + 3, ch / 2 + 5);
      ctx.fill();
      if (x > 90) drawLabel(labelR, x - 8, 6, true);
      if (cw - x > 70) drawLabel(labelT, x + 8, 6);
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
    const onDivider = nearDivider(x, y);
    drag = { startX: x, startY: y, viewX: view.x, viewY: view.y, curtain: onDivider };
    if (onDivider) { curtain = Math.min(1, Math.max(0, x / cw)); draw(); }
    canvas.style.cursor = onDivider ? "col-resize" : "grabbing";
  });
  // the divider takes a drag within 8 px of the line or on its round handle
  function nearDivider(x, y) {
    if (mode !== "curtain") return false;
    const dx = Math.abs(x - cw * curtain);
    return dx <= 8 || Math.hypot(dx, y - ch / 2) <= 14;
  }
  canvas.addEventListener("mousemove", (e) => {
    if (drag) return;
    const r = canvas.getBoundingClientRect();
    canvas.style.cursor = nearDivider(e.clientX - r.left, e.clientY - r.top) ? "col-resize" : "";
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (drag.curtain) {
      curtain = Math.min(1, Math.max(0, x / cw));
    } else {
      view.x = drag.viewX + (x - drag.startX);
      view.y = drag.viewY + (y - drag.startY);
    }
    draw();
  });
  window.addEventListener("mouseup", () => { if (drag) canvas.style.cursor = ""; drag = null; });
  window.addEventListener("resize", () => draw());
  // The box also changes size without a window resize — the step switch (editor -> compare)
  // lays the screen out after the first draw, the report panel fills in, a scrollbar comes or
  // goes. A canvas buffer sized for the old box is then stretched by CSS (the image shows
  // shrunk/offset until the next interaction); redraw whenever the box itself changes.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => { if (canvas.getBoundingClientRect().width > 0) draw(); })
      .observe(canvas.parentElement);
  }

  // a double click on the image returns zoom and pan to the fitted view (spec/ui.md
  // decision #8: there is no "Reset view" button)
  function resetView() {
    view.scale = 1; view.x = 0; view.y = 0;
    draw();
  }
  canvas.addEventListener("dblclick", (e) => { e.preventDefault(); resetView(); });
  $("cmp-manual").addEventListener("click", () => onManual());
  $("cmp-download").addEventListener("click", () => onDownload?.());
  $("cmp-share")?.addEventListener("click", () => onShare?.());
  refitBtn.addEventListener("click", () => (state.fitting ? onCancelRefit() : onRefit()));

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
    paintStrength();                               // the label shows the live value (decision #8)
  });

  // ---------- the pair strip (decision #11) ----------
  // A RAW thumbnail from the decoded linear frame: a quick display transform (the 99th
  // percentile to white, gamma 2.2) — only a recognizable preview until the JPEG arrives.
  const rawCache = new WeakMap();
  function rawThumb(img) {
    let c = rawCache.get(img);
    if (c) return c;
    const long = 72, sc = Math.min(1, long / Math.max(img.w, img.h));
    const w = Math.max(1, Math.round(img.w * sc)), h = Math.max(1, Math.round(img.h * sc));
    const px = new Float32Array(w * h * 3);
    const lum = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.w - 1, Math.floor(x / sc)), sy = Math.min(img.h - 1, Math.floor(y / sc));
        const i = (sy * img.w + sx) * 3, o = (y * w + x) * 3;
        px[o] = img.rgb[i]; px[o + 1] = img.rgb[i + 1]; px[o + 2] = img.rgb[i + 2];
        lum.push(Math.max(px[o], px[o + 1], px[o + 2]));
      }
    }
    lum.sort((u, v) => u - v);
    const white = lum[Math.floor(lum.length * 0.99)] || 1;
    c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d"), im = cx.createImageData(w, h);
    for (let i = 0, j = 0; i < im.data.length; i += 4, j += 3) {
      for (let k = 0; k < 3; k++) im.data[i + k] = Math.round(255 * Math.min(1, Math.max(0, px[j + k] / white)) ** (1 / 2.2));
      im.data[i + 3] = 255;
    }
    cx.putImageData(im, 0, 0);
    rawCache.set(img, c);
    return c;
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // The tile state (decision #11) — a code and a caption.
  function tileState(p, v) {
    if (p.raw === "pending") return ["decoding", t("decoding…")];
    if (p.raw === "error") return ["blocked", t("RAW error")];
    if (p.target === "pending") return ["jpeg", t("decoding…")];
    if (!isTargetReady(p)) return ["no_jpeg", t("Add JPEG")];
    if (p.fitBlocked || p.prepError || p.prepared?.blocked) return ["blocked", t("blocked")];
    if (p.preparing || !p.prepared) return ["preparing", t("preparing…")];
    if (!inVersion(p, v)) return ["new", t("Refit to include")];
    return ["active", null];
  }

  function blockedTitle(p) {
    if (p.raw === "error") return t("RAW is unreadable — this pair cannot be used");
    if (p.prepError) return t("Preparation failed: {error} — this pair cannot be used", { error: p.prepError });
    if (p.prepared?.blocked?.code === "ncc_low")
      return t("Alignment failed (NCC {ncc}) — this pair cannot be used in the fit", { ncc: p.prepared.ncc.toFixed(2) });
    if (p.fitBlocked?.code === "target_too_small")
      return t("The target is too small ({detail}) — give a full-size JPEG", p.fitBlocked);
    return "";
  }

  // One JPEG for an inactive tile (the decision #7 card rules): a rejection goes to the status.
  function takeTargets(p, files) {
    if (!files.length) return;
    if (!canAttachTarget(p) || p.target === "pending") {
      setStatus(p.raw === "error" ? t("The RAW is unreadable — remove this pair")
                                  : t("Wait until the RAW is decoded, then add its JPEG"), "error");
      return;
    }
    const pick = pickTargetFile(files);
    if (pick.error) {
      setStatus(pick.error === "count" ? t("Drop one JPEG per card ({n} files dropped)", { n: files.length })
                                       : t("{name} is not a JPEG — the card takes one .JPG", { name: files[0].name }), "error");
      return;
    }
    onAddTarget?.(p, pick.file);
  }

  function thumbnail(p) {
    const v = version();
    const [code, caption] = tileState(p, v);
    const box = el("div", "cmp-th");
    box.dataset.pairId = String(p.id);
    box.dataset.state = code;
    const usable = compareUsable(p);
    if (code !== "active") box.classList.add("inactive");
    if (code === "blocked") box.classList.add("blocked");
    if (p.id === state.selectedPairId && usable) box.classList.add("selected");
    let src = null;
    if (isTargetReady(p)) src = targetCanvases(p.target).thumb;
    else if (isRawReady(p)) src = rawThumb(p.raw.image);
    if (src) {
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      box.append(c);
    } else {
      box.append(el("div", "cmp-th-empty"));
    }
    box.title = [p.rawFile?.name ?? "", code === "blocked" ? blockedTitle(p) : ""].filter(Boolean).join(" — ");
    if (caption) {
      const cap = el("span", `cmp-th-badge ${code === "blocked" ? "bad" : ""}`.trim(), caption);
      box.append(cap);
    }
    const hints = code === "blocked" ? [] : pairHints(p, state);
    if (hints.length) {
      const w = el("span", "cmp-th-warn", "!");
      w.title = hints.join("\n");
      box.append(w);
    }
    // × — "Remove from fit" (decision #7): the pair leaves the session
    const rm = el("button", "cmp-th-x", "×");
    rm.type = "button";
    rm.title = t("Remove from fit");
    rm.setAttribute("aria-label", t("Remove from fit"));
    rm.addEventListener("click", (e) => { e.stopPropagation(); onRemovePair?.(p); });
    box.append(rm);
    // the JPEG of an inactive tile: a click opens the picker, a drop takes one file
    if (code === "no_jpeg") {
      const picker = el("input", "cmp-th-file");
      picker.type = "file";
      picker.accept = ".jpg,.JPG,.jpeg,.JPEG";
      picker.hidden = true;
      picker.addEventListener("change", () => { takeTargets(p, [...picker.files]); picker.value = ""; });
      box.append(picker);
    }
    for (const ev of ["dragenter", "dragover"]) box.addEventListener(ev, (e) => {
      e.preventDefault();
      if (code === "no_jpeg") box.classList.add("over");
    });
    box.addEventListener("dragleave", () => box.classList.remove("over"));
    box.addEventListener("drop", (e) => {
      box.classList.remove("over");
      const files = [...(e.dataTransfer?.files || [])];
      // a JPEG dropped on a tile is that tile's; RAWs go on to the strip (a new tile)
      if (files.some((f) => /\.(jpe?g)$/i.test(f.name))) {
        e.preventDefault();
        e.stopPropagation();
        takeTargets(p, files);
      }
    });
    // keyboard (UX review, decision #15): a selectable tile or one waiting for its JPEG is a
    // focusable button; Enter / Space act as a click
    if (code === "no_jpeg" || usable) {
      box.tabIndex = 0;
      box.setAttribute("role", "button");
      box.setAttribute("aria-label", `${p.rawFile?.name ?? ""}${caption ? " — " + caption : ""}`);
      if (p.id === state.selectedPairId && usable) box.setAttribute("aria-pressed", "true");
      box.addEventListener("keydown", (e) => {
        if (e.target !== box || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        box.click();
      });
    }
    box.addEventListener("click", () => {
      if (code === "no_jpeg") { box.querySelector(".cmp-th-file").click(); return; }
      if (!usable) return;                  // only a prepared, unblocked pair can be compared
      state.selectedPairId = p.id;
      refresh();
      onPairSelected?.(p);                  // the report view follows the pair (stage 5B)
    });
    return box;
  }

  // the drop button at the end of the strip: a click opens the RAW picker
  function addTile() {
    const b = el("button", "cmp-add");
    b.type = "button";
    b.id = "cmp-add";
    b.title = t("Add RAW files (or drop them anywhere on the strip)");
    b.append(el("span", "cmp-add-plus", "+"), el("span", "cmp-add-text", t("RAW")));
    b.addEventListener("click", () => rawPicker.click());
    return b;
  }
  rawPicker.addEventListener("change", () => { onAddRaws?.([...rawPicker.files]); rawPicker.value = ""; });
  // the whole strip is a RAW drop zone
  for (const ev of ["dragenter", "dragover"]) stripEl.addEventListener(ev, (e) => {
    e.preventDefault();
    stripEl.classList.add("over");
  });
  stripEl.addEventListener("dragleave", (e) => { if (!stripEl.contains(e.relatedTarget)) stripEl.classList.remove("over"); });
  stripEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();                    // the page-level router must not see these files
    stripEl.classList.remove("over");
    const files = [...(e.dataTransfer?.files || [])];
    const raws = files.filter((f) => /\.(nef|dng)$/i.test(f.name));
    for (const f of files) {
      if (raws.includes(f)) continue;
      setStatus(/\.(jpe?g)$/i.test(f.name) ? t("{name}: drop the JPEG onto its RAW's tile", { name: f.name })
                                           : t("Skipped {name}: the strip takes .NEF/.DNG", { name: f.name }), "error");
    }
    if (raws.length) onAddRaws?.(raws);
  });

  // ---------- the refit button (decision #11) ----------
  function renderRefit() {
    const v = version();
    const ids = refitPairIds(state);
    const same = v && ids.length === (v.pairIds ?? []).length
      && ids.every((id) => (v.pairIds ?? []).includes(String(id)));
    const preparing = state.pairs.some((p) => p.preparing || p.raw === "pending" || p.target === "pending");
    refitBtn.dataset.pairIds = ids.join(",");
    if (state.step === "edit") {
      // the quick editor (decision #16): the layout stays, the hub actions wait for Done / Cancel
      refitBtn.textContent = t("Refit");
      refitBtn.dataset.sub = t("Editing");
      refitBtn.disabled = true;
      refitBtn.classList.remove("running");
      refitBtn.title = t("Finish the manual adjustments first (Done or Cancel)");
      return;
    }
    if (state.fitting) {
      refitBtn.textContent = t("Cancel");                // a one-word label fits the square (decision #15)
      refitBtn.dataset.sub = t("Refitting…");
      refitBtn.disabled = false;
      refitBtn.classList.add("running");
    } else {
      refitBtn.textContent = t("Refit");                 // no pair count in the label (decision #11)
      refitBtn.disabled = !ids.length || !state.versions.length || preparing || same;
      refitBtn.classList.remove("running");
      // the state as a short one-line sub-label under "Refit" (decision #15: the reason it is off
      // is visible, not only in the tooltip); drawn by CSS ::after, so the label text stays "Refit"
      const have = new Set((v?.pairIds ?? []).map(String));
      const added = ids.filter((id) => !have.has(String(id))).length;
      const removed = [...have].filter((id) => !ids.some((x) => String(x) === id)).length;
      refitBtn.dataset.sub = !ids.length ? t("No pairs")
        : preparing ? t("Preparing…")
        : same ? t("Up to date")
        : [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ")
          + " " + (added + removed === 1 ? t("pair") : t("pairs"));
    }
    const { m, k } = fitCount(state);
    let txt = same ? t("The profile is already fitted on these pairs") : "";
    if (m || k) {
      const skipped = [];
      if (m) skipped.push(t("{m} without a JPEG", { m }));
      if (k) skipped.push(t("{k} blocked", { k }));
      txt += (txt ? "; " : "") + t("skipped: {list}", { list: skipped.join(", ") });
    }
    refitBtn.title = txt;                                // the reason it is off / skipped pairs: tooltip only
  }

  // The hub actions are disabled in the quick editor (decision #16): the layout does not change,
  // the state is unambiguous — the panel's Done / Cancel lead out first.
  function syncActions() {
    const editing = state.step === "edit";
    const why = editing ? t("Finish the manual adjustments first (Done or Cancel)") : "";
    for (const id of ["cmp-manual", "cmp-download", "cmp-share"]) {
      const b = $(id);
      if (!b) continue;
      b.disabled = editing;
      b.dataset.title0 ??= b.title;           // the button's own tooltip, restored after editing
      b.title = editing ? why : b.dataset.title0;
    }
    strengthInput.disabled = editing;
  }

  /** Re-renders the strip, the coverage and the refit button (pair changes, advice, fits). */
  function refreshPairs() {
    syncActions();
    // the strip is rebuilt: a focused tile keeps the keyboard focus across the rebuild
    const focused = stripEl.contains(document.activeElement)
      ? document.activeElement.closest(".cmp-th")?.dataset.pairId ?? (document.activeElement.id || null) : null;
    stripEl.replaceChildren(...state.pairs.map(thumbnail), addTile());
    if (focused) (stripEl.querySelector(`.cmp-th[data-pair-id="${focused}"]`) ?? document.getElementById(focused))?.focus();
    renderCoverage(coverageEl, state);
    renderRefit();
  }

  // ---------- refresh ----------
  function refresh() {
    refreshPairs();
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
      mode, curtain,
      view: { ...view },
      requestedGen, appliedGen, pending,
      base: base(),
      working: p?.prepared ? { ...p.prepared.size } : null,
      aligned: renderBitmap ? { w: renderBitmap.w, h: renderBitmap.h } : null,
      mapPoint,
    };
  }

  /** The strength slider and its label follow state.strength (the quick editor's panel moves it). */
  function syncStrength() {
    strengthInput.value = String(state.strength);
    paintStrength();
  }

  return { refresh, refreshPairs, draw, scheduleRender, debug, syncStrength,
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
