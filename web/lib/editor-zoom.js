// 100% zoom of the desktop profile editor (spec/ui-zoom-plan.md "Profile editor"; the Compare screen's
// compare-view.js / fit-app.js zoom is the model). Created by lib/editor-app.js on the desktop page only.
//
// The base: the WebGL canvas #c stays the source of the current full-frame render (and the only thing shown
// at the fitted view: nothing changes there). Once zoomed in, a 2D overlay canvas #zv (pointer-events: none,
// exactly over #c) draws #c through the view transform (a plain scale + offset: the editor frame is the
// renderer's main frame), so zoom and pan never re-render. On top of it the detailed layer (D2): the visible
// region demosaiced from the held RAW by the raw worker (hold / roi), developed by renderer.renderRegion
// (lowRes = the main frame) and drawn in the same mapping. Before/after (Space) shows #c's neutral and the
// region's neutral (renderRegion({ neutralOnly })). Geometry: lib/zoom-plan.js (planEditorRegion, ...).
//
// Hooks into the shared core are the optional hooks.onDrawn / hooks.onFrame of lib/editor-core.js.
import { scaled } from "./strength.js";
import { frameGeometry, pickLevel, visibleRect, rectContains, rotateRegion, planEditorRegion,
         editorPercent, editorScaleForPercent, clampPan, zoomViewAt } from "./zoom-plan.js";

const SETTLE_MS = 100;          // the region is requested this long after the last zoom / pan / render
const MAX_PERCENT = 4;          // the wheel range: up to 400% (one sensor px = four device px)
const PIXELATE_FROM = 3;        // device px per region px from which the region layer is drawn pixelated
const ROI_LUT_N = 33;           // the final LUT size, as the editor's committed renders and Compare's ROI
const tick = () => new Promise((r) => setTimeout(r, 0));   // let the loader paint between the heavy steps

/**
 * core: the editor core API; hooks: the object passed to createEditorCore (onDrawn / onFrame are set here);
 * getFile(gen): the RAW File opened by the loader generation `gen` (the loader transfers the bytes away,
 * so the hold re-reads the file). Returns null when the page has no zoom markup (the mobile page).
 */
export function createEditorZoom({ core, hooks, getFile }) {
  const $ = (id) => document.getElementById(id);
  const cv = $("c"), main = $("view"), zv = $("zv"), tip = $("zoomtip");
  if (!cv || !main || !zv || !tip) return null;
  const spinEl = $("zoom-spin"), valEl = $("zoom-val");
  const { state, renderer, loader } = core;

  // ---------- state ----------
  const view = { scale: 1, x: 0, y: 0 };      // zoom multiplier over the fit, pan in CSS px (from the centre)
  let geo = null;                             // frameGeometry of the decoded frame; null before the first RAW
  let rawRef = null, rawFile = null;          // state.raw of the current frame and the File it came from
  let afterKey = null;                        // the content key of the "after" render on the canvas
  const layers = { after: null, before: null };   // { cv, rect (frame px), level, wanted, key }
  let gen = 0;                                // the generation of the latest region request
  let pending = false;                        // a region request is outstanding (a decode, hold or render in flight)
  let timer = 0;
  let drag = null, mouse = null, hovering = false;
  // the decoder side (as fit-app.js): jobs after any RAW decode in flight, one hold at a time
  let rawQueue = Promise.resolve();
  let zoomBusy = 0;
  let supported = null;                       // null unknown, false: raw.wasm lacks hold/roi (or a stale worker)
  const hz = { raw: null, held: null, epoch: 0, everHeld: false };
  const failed = new WeakSet();               // RAW states whose hold failed (a corrupt file: not retried)

  const showSpin = (on) => { if (spinEl) spinEl.hidden = !on; };

  // ---------- geometry of the view ----------
  function boxNow() {
    if (!geo || cv.hidden) return null;
    const r = cv.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const m = main.getBoundingClientRect();
    return { cw: r.width, ch: r.height,
             left: r.left - m.left - main.clientLeft + main.scrollLeft,
             top: r.top - m.top - main.clientTop + main.scrollTop,
             mw: main.clientWidth, mh: main.clientHeight };
  }
  const baseOf = (b) => Math.min(b.cw / geo.w, b.ch / geo.h);        // CSS px per frame px at the fit
  const dprNow = () => Math.max(1, window.devicePixelRatio || 1);
  const vpOf = (b) => ({ x: 0, y: 0, w: b.cw, h: b.ch });
  const percentOf = (b, scale = view.scale) => editorPercent(geo, baseOf(b), dprNow(), scale);   // 1 = 100%
  const scaleFor = (b, pc) => editorScaleForPercent(geo, baseOf(b), dprNow(), pc);
  const maxScale = (b) => Math.max(1, scaleFor(b, MAX_PERCENT));
  function level1Ok() {                       // D11: big textures and memory; else the zoom stays at half sensor
    const gl = renderer.gl;
    const tex = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) ?? 0;
    const mem = navigator.deviceMemory;
    return tex >= 4096 && !(typeof mem === "number" && mem < 4);
  }
  const maxTex = () => { const gl = renderer.gl; return gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) ?? 0; };
  function wantLevel(b = boxNow()) {
    if (!b) return 0;
    return pickLevel({ percent: percentOf(b), scale: view.scale, level1: level1Ok() });
  }
  function visibleNow(b = boxNow()) {
    return b ? visibleRect(vpOf(b), view, baseOf(b) * view.scale, geo.w, geo.h) : null;
  }

  // ---------- drawing ----------
  function draw() {
    const b = boxNow();
    if (!b) { zv.hidden = true; tip.hidden = true; return; }
    const dpr = dprNow();
    const p = clampPan(view, vpOf(b), baseOf(b) * view.scale, geo.w, geo.h);
    view.x = p.x; view.y = p.y;
    tip.style.right = `${b.mw - (b.left + b.cw) + 8}px`;
    tip.style.bottom = `${b.mh - (b.top + b.ch) + 8}px`;
    tip.hidden = false;
    if (valEl) valEl.textContent = `${Math.round(100 * percentOf(b))}%`;
    const zoomed = view.scale > 1.0005;
    cv.style.cursor = zoomed ? (drag ? "grabbing" : "grab") : "";
    if (!zoomed) { zv.hidden = true; return; }
    const W = Math.round(b.cw * dpr), H = Math.round(b.ch * dpr);
    if (zv.width !== W || zv.height !== H) { zv.width = W; zv.height = H; }
    zv.style.left = `${b.left}px`; zv.style.top = `${b.top}px`;
    zv.style.width = `${b.cw}px`; zv.style.height = `${b.ch}px`;
    zv.hidden = false;
    const ctx = zv.getContext("2d");
    const kx = W / b.cw, ky = H / b.ch, s = baseOf(b) * view.scale;
    const ox = (b.cw - s * geo.w) / 2 + view.x, oy = (b.ch - s * geo.h) / 2 + view.y;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(kx * s, 0, 0, ky * s, kx * ox, ky * oy);   // frame px -> overlay bitmap px
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cv, 0, 0, geo.w, geo.h);                      // the stretched current render (or the neutral)
    const L = state.showNeutral ? layers.before : (layers.after && layers.after.key === afterKey ? layers.after : null);
    if (L) {                                                    // the detailed layer, same mapping
      ctx.imageSmoothingEnabled = kx * s * L.rect.w / L.cv.width < PIXELATE_FROM;
      ctx.drawImage(L.cv, L.rect.x, L.rect.y, L.rect.w, L.rect.h);
    }
  }

  // ---------- the decoder side ----------
  function job(fn) {                           // after everything queued (RAW decodes, earlier jobs); never breaks the chain
    zoomBusy++;
    const run = rawQueue.then(fn);
    rawQueue = run.then(() => {}, () => {});
    return run.finally(() => { zoomBusy--; });
  }
  // a RAW decode started by the editor: the zoom jobs queue behind it (D4)
  function decodeStarted(p) { rawQueue = rawQueue.then(() => p).then(() => {}, () => {}); }

  async function ensureHold(epoch, rr, file) {
    if (supported === false || failed.has(rr)) return false;
    if (hz.raw === rr && hz.held) return true;
    hz.raw = null; hz.held = null;
    if (!file) return false;
    const bytes = new Uint8Array(await file.arrayBuffer());
    hz.everHeld = true;
    try {
      const r = await loader.zoomCall({ type: "hold", bytes }, [bytes.buffer]);
      if (!Array.isArray(r.info?.held)) {
        // an older raw-worker.js (e.g. from the browser cache) answers a hold as a develop: no zoom
        console.warn("zoom: the RAW worker does not support hold (stale raw-worker.js / raw.wasm?)", r.info);
        supported = false;
        return false;
      }
      if (epoch !== hz.epoch) return false;    // released meanwhile: its release job runs next
      hz.raw = rr; hz.held = r.info.held;
      return true;
    } catch (err) {
      console.warn(`zoom: hold failed (${err.code}: ${err.detail ?? err.message})`);
      if (err.code === "zoom_unsupported") supported = false; else failed.add(rr);
      return false;
    }
  }

  // Drops the hold and the region textures (a new RAW, the page hiding; D11).
  function release() {
    hz.epoch++;
    hz.raw = null; hz.held = null;
    if (typeof renderer.disposeRegion === "function") renderer.disposeRegion();
    if (hz.everHeld && supported !== false) {
      hz.everHeld = false;
      job(() => loader.zoomCall({ type: "release" })).catch(() => {});
    }
  }

  // The ROI layer for the visible rectangle `vis` (frame px) at `level`; neutral: the Nikon neutral (before view).
  // Resolves { cv, rect, level, wanted, key } or null (superseded, unsupported, the LUT is still building, ...).
  function renderRoi({ vis, level, neutral, g, key }) {
    const rr = rawRef, file = rawFile, epoch = hz.epoch;
    const stale = () => g !== gen || epoch !== hz.epoch || state.raw !== rr || (!neutral && key !== afterKey);
    const withProfile = (ctl, fn) => {          // the committed profile + LUT size, restoring the main path's state
      const prevN = renderer.lutN, prevCtl = renderer.control;
      renderer.setProfile(ctl);
      renderer.lutN = ROI_LUT_N;
      try { return fn(); } finally { renderer.lutN = prevN; if (prevCtl) renderer.setProfile(prevCtl); }
    };
    return job(async () => {
      if (stale()) return null;
      if (!neutral) {
        const ctl = scaled(state.control, state.strength);
        const have = withProfile(ctl, () => {
          const ok = renderer.hasLut(renderer.lutCacheKey(ROI_LUT_N));
          if (!ok && !core.lutDead && !state.renderPending) core.requestLut(ctl, ROI_LUT_N);   // lands -> renderCurrent -> onDrawn
          return ok;
        });
        if (!have) return null;
      }
      if (!(await ensureHold(epoch, rr, file)) || stale()) return null;
      await tick();
      if (stale()) return null;
      let plan = null;
      for (const lv of level === 1 ? [1, 2] : [2]) {
        const r = planEditorRegion({ geom: geo, level: lv, rect: vis, hold: hz.held, maxTex: maxTex() });
        if (r.empty) return null;
        if (!r.tooLarge) { plan = r; break; }
      }
      if (!plan) return null;
      await tick();
      if (stale()) return null;
      let roi;
      try {
        roi = await loader.zoomCall({ type: "roi", ...plan.roi, level: plan.level });
      } catch (err) {
        console.warn(`zoom: roi failed (${err.code}: ${err.detail ?? err.message})`);
        if (err.code === "zoom_unsupported") supported = false;
        else if (err.code === "no_hold") { hz.raw = null; hz.held = null; }
        return null;
      }
      if (stale() || roi.w !== plan.roi.w || roi.h !== plan.roi.h) return null;
      const rgb = rotateRegion(roi.rgb, plan.roi, plan.region, plan.turns, plan.ufw, plan.ufh, null);
      await tick();
      if (stale()) return null;
      const rw = plan.region.w, rh = plan.region.h;
      const rgba = neutral
        ? renderer.renderRegion({ rgb, w: rw, h: rh, scale: plan.scale, neutralOnly: true })
        : withProfile(scaled(state.control, state.strength),
            () => renderer.renderRegion({ rgb, w: rw, h: rh, scale: plan.scale, lowRes: plan.lowRes }));
      if (!rgba) return null;                   // the LUT of this size is not uploaded yet
      const { x: x0, y: y0, w: cw2, h: ch2 } = plan.crop;
      const u8 = new Uint8ClampedArray(cw2 * ch2 * 4);
      for (let y = 0; y < ch2; y++) {
        let i = ((y0 + y) * rw + x0) * 4, o = y * cw2 * 4;
        for (let x = 0; x < cw2; x++, i += 4, o += 4) {
          u8[o] = 255 * rgba[i]; u8[o + 1] = 255 * rgba[i + 1]; u8[o + 2] = 255 * rgba[i + 2]; u8[o + 3] = 255;
        }
      }
      await tick();
      if (stale()) return null;
      const out = document.createElement("canvas");
      out.width = cw2; out.height = ch2;
      out.getContext("2d").putImageData(new ImageData(u8, cw2, ch2), 0, 0);
      return { cv: out, rect: plan.rect, level: plan.level, wanted: level, key: neutral ? null : key };
    });
  }

  // ---------- requesting the detailed layer ----------
  function cancelPending() { gen++; pending = false; showSpin(false); }
  function dropLayers({ trim = false } = {}) {
    layers.after = null; layers.before = null;
    cancelPending();
    clearTimeout(timer); timer = 0;
    if (trim && typeof renderer.disposeRegion === "function") renderer.disposeRegion();   // the hold stays
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(requestZoom, ms); }

  function requestZoom() {
    timer = 0;
    const b = boxNow();
    if (!b || state.raw !== rawRef) return;
    const lv = wantLevel(b);
    if (!lv) {
      if (layers.after || layers.before || pending) dropLayers({ trim: true });
      draw();
      return;
    }
    if (supported === false || typeof renderer.renderRegion !== "function") return;   // the stretched zoom stays
    const neutral = state.showNeutral;
    if (!neutral && state.renderPending) return;        // a LUT is building: its arrival redraws and re-schedules
    const vis = visibleNow(b);
    if (!vis) return;
    const slot = layers[neutral ? "before" : "after"];
    if (slot && slot.wanted === lv && rectContains(slot.rect, vis) && (neutral || slot.key === afterKey)) return;
    const g = ++gen, key = afterKey;
    pending = true;
    showSpin(true);
    renderRoi({ vis, level: lv, neutral, g, key }).then((res) => {
      if (g !== gen) return;                            // superseded: the newer request owns the flag
      pending = false;
      showSpin(false);
      if (!res) return;
      layers[neutral ? "before" : "after"] = res;
      draw();
    }).catch((err) => {
      console.warn("zoom: region render failed", err);
      if (g === gen) { pending = false; showSpin(false); }
    });
  }

  // A view change: redraw now, the region once the input settles (a level-0 view drops the layers at once).
  function viewChanged() {
    draw();
    if (wantLevel() === 0) { if (layers.after || layers.before || pending) dropLayers({ trim: true }); }
    else schedule(SETTLE_MS);
  }
  function zoomTo(next, mx, my, b) {
    const v = zoomViewAt(view, next, mx, my, vpOf(b), baseOf(b));
    view.scale = v.scale; view.x = v.x; view.y = v.y;
    viewChanged();
  }
  function fit() {
    view.scale = 1; view.x = 0; view.y = 0;
    viewChanged();
  }
  // 100% (D1): one sensor px per device px, anchored at (mx, my) - the middle of the image area by default
  function zoom100(mx = null, my = null) {
    const b = boxNow();
    if (!b) return;
    const target = scaleFor(b, 1);
    if (!(target > 1.0005)) { fit(); return; }          // the fit is already at or above 100%
    if (mx == null) { mx = b.cw / 2; my = b.ch / 2; }
    zoomTo(Math.min(maxScale(b), target), mx, my, b);
  }

  // ---------- hooks of the editor core ----------
  // a frame (the result, the cached final or the neutral) went to the canvas
  function onDrawn() {
    if (!geo || state.raw !== rawRef) return;
    const k = JSON.stringify([state.control, state.strength]);
    if (k !== afterKey) {                               // the profile or the strength changed: the "after" layer is stale
      afterKey = k;
      layers.after = null;
      if (!state.showNeutral) cancelPending();
    }
    draw();
    if (wantLevel() === 0) { if (layers.after || layers.before || pending) dropLayers({ trim: true }); return; }
    schedule(state.showNeutral ? 0 : SETTLE_MS);
  }
  // a new RAW frame: the old view, layers and hold are gone
  function onFrame(st) {
    dropLayers();
    release();
    const im = state.raw?.image, info = state.raw?.info;
    rawRef = state.raw;
    rawFile = getFile ? getFile(st?.gen) : null;
    geo = im && info ? frameGeometry({ w: im.w, h: im.h, k: info.k ?? 1, orientation: info.orientation }) : null;
    view.scale = 1; view.x = 0; view.y = 0;
    afterKey = null;
    draw();
  }
  hooks.onDrawn = onDrawn;
  hooks.onFrame = onFrame;

  // ---------- interactions (on #c: the overlay does not take pointer events) ----------
  const cursorPoint = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener("wheel", (e) => {
    const b = boxNow();
    if (!b) return;
    e.preventDefault();
    const [mx, my] = cursorPoint(e);
    zoomTo(Math.min(maxScale(b), Math.max(1, view.scale * Math.exp(-e.deltaY * 0.002))), mx, my, b);
  }, { passive: false });
  cv.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !boxNow()) return;
    e.preventDefault();
    main.focus({ preventScroll: true });                // preventDefault stops the native focus: the keys (Z, 0) need it
    const [x, y] = cursorPoint(e);
    drag = { startX: x, startY: y, viewX: view.x, viewY: view.y };
    cv.style.cursor = view.scale > 1.0005 ? "grabbing" : "";
  });
  cv.addEventListener("mousemove", (e) => { const [x, y] = cursorPoint(e); mouse = { x, y }; });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const [x, y] = cursorPoint(e);
    view.x = drag.viewX + (x - drag.startX);
    view.y = drag.viewY + (y - drag.startY);
    draw();
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    draw();
    if (wantLevel() > 0) schedule(SETTLE_MS);
  });
  // a double click: below 100% it zooms to 100% at the cursor, at 100% or more it returns to the fit
  cv.addEventListener("dblclick", (e) => {
    const b = boxNow();
    if (!b) return;
    e.preventDefault();
    if (percentOf(b) >= 0.995) { fit(); return; }
    const [mx, my] = cursorPoint(e);
    zoom100(mx, my);
  });
  $("zoom-fit")?.addEventListener("click", () => fit());
  $("zoom-100")?.addEventListener("click", () => zoom100());
  main.addEventListener("mouseenter", () => { hovering = true; });
  main.addEventListener("mouseleave", () => { hovering = false; mouse = null; });
  // Z (100% at the cursor) and 0 (fit) while the image area is hovered or focused; never while typing,
  // never with a modifier (Space stays before/after, Ctrl+Z undo). A focused slider is not typing.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
    if (e.key !== "z" && e.key !== "Z" && e.key !== "0") return;
    const el = e.target?.closest?.("input, textarea, select, [contenteditable]");
    if (el && el.type !== "range") return;
    if (!hovering && !main.contains(document.activeElement)) return;
    const b = boxNow();
    if (!b) return;
    e.preventDefault();
    if (e.key === "0") { fit(); return; }
    if (mouse && mouse.x >= 0 && mouse.y >= 0 && mouse.x <= b.cw && mouse.y <= b.ch) zoom100(mouse.x, mouse.y);
    else zoom100();
  });
  // the box changes with the window, the side panels and a new frame's aspect: redraw (the pan is re-clamped)
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => { draw(); if (view.scale > 1.0005 && wantLevel() > 0) schedule(SETTLE_MS); });
    ro.observe(main);
    ro.observe(cv);
  }
  // D11: a hidden page gives the held mosaic and the region textures back; coming back re-requests the layer
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { dropLayers({ trim: true }); release(); }
    else if (geo && wantLevel() > 0) schedule(0);
  });

  return {
    zoom100: () => zoom100(), fitView: () => fit(), release, decodeStarted,
    get supported() { return supported !== false && typeof renderer.renderRegion === "function"; },
    /** For the tests: the percent (100 = one sensor px per device px), levels, the view and the layers. */
    debug() {
      const b = boxNow();
      const shown = state.showNeutral ? layers.before : layers.after;
      return {
        percent: b ? 100 * percentOf(b) : null, level: shown?.level ?? 0, wanted: b ? wantLevel(b) : 0,
        busy: pending || zoomBusy > 0, supported: supported !== false, view: { ...view },
        roiRect: shown ? { ...shown.rect } : null, held: hz.held,
        layers: { after: !!layers.after, before: !!layers.before },
      };
    },
  };
}
