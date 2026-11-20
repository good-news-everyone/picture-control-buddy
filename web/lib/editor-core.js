// The editor core (spec/ui-pages.md "Code structure"): everything the NP3 editor needs on any
// page — the WebGL canvas and the renderer, the LUT Worker, the panel and the specialized
// editors (curve, Color Blender, Color Grading), the Ctrl+Z history, before/after, the RAW
// loader and NP3 export/share. Two entries use it:
//   lib/editor-app.js — the profile editor pages (picture-control-editor*.html): one RAW,
//                       NP3 import/export/share, resets to the neutral defaults;
//   lib/fit-app.js    — the fitting wizard (picture-control-jpg-fit.html): the session
//                       around it, the editor is step 3.1 against a fitted baseline.
// The core owns no session logic; the entries plug in through the hooks below.
//
// State by contract (the editor part): { raw: {bytes,image,info,name}|null, control,
// strength, showNeutral, generation, status, nameValid, renderPending, baseline }. The panel
// shows the base control; strength is applied only via scaled(control, strength) at render
// time. The entries add their own fields through `extraState`.
import { newProfile, COLORS, ZONES } from "./np3.js";
import { scaled } from "./strength.js";
import { loadModel as loadNeutral } from "./neutral.js";
import { fetchModel } from "./profile.js";
import { fetchDetail } from "./detail.js";
import { Renderer } from "./renderer.js";
import { createRawLoader } from "./loader.js";
import { t, applyI18n, i18nSet } from "./i18n.js";
import { createPanel } from "./panels.js";
import { createCurveEditor } from "./curve-editor.js";
import { createBlendingView } from "./blending.js";
import { createGradingView } from "./grading.js";
import { createBeforeAfter } from "./before-after.js";
import { setupTransfer } from "./transfer.js";
import { createHistory } from "./history.js";
import { neutralControl } from "./baseline.js";
import { setWbMapWeights } from "./target.js";

export const $ = (id) => document.getElementById(id);

const ERRORS = {
  nef_high_efficiency: "NEF High Efficiency compression is not supported",
  not_bayer: "Only Bayer-sensor files are supported",
  decode_failed: "Failed to decode the file",
  wasm_failed: "The RAW unpacker (WASM) failed to initialize",
};
export const rawErrorText = (code) => t(ERRORS[code] || code);

/**
 * Builds the editor on the current page and loads the models. Options:
 *   extraState     — fields merged into the state before anything reads it (the session);
 *   statusIds      — element ids that mirror the status line (besides #status);
 *   hooks.onFinishedEdit() — after a finished edit / an undo (the wizard re-runs the report);
 *   hooks.onLutReady()     — a LUT landed; return true when the entry redrew itself (the
 *                            wizard's Compare screen), false to finish renderCurrent here;
 *   hooks.onLoaderUpdate(st) — a loader event with a tag (the wizard's pair decodes); return
 *                            true when handled; untagged ready frames go to the editor;
 *   hooks.onRender()       — before every editor render; return true when the entry draws the
 *                            current control itself (the wizard's quick editor on Compare);
 *   hooks.hasFrame()       — true when the renderer holds a frame though no RAW is open in the
 *                            editor (the curve backdrop histogram then reads it);
 *   transfer       — setupTransfer options (import on/off, the share target).
 * Resolves to the core API once the models are loaded and the renderer exists.
 */
export async function createEditorCore({ extraState = {}, statusIds = [], hooks = {},
                                         transfer: transferOpts = {} } = {}) {
  // view-route.js is moving the editor to the other page: stop before any download
  if (window.NP3_REDIRECTING) throw new Error("redirecting to the other page");
  // The page declares itself with window.NP3_SHELL = { kind: "desktop" | "mobile" } before this
  // module loads (missing = desktop). The mobile page (spec/ui-mobile.md) puts the curve chart
  // over the photo, starts before/after with a long press, soft-disables export/share and
  // exports through the share sheet; lib/mobile.js drives its shell.
  const shell = window.NP3_SHELL || { kind: "desktop" };
  const isMobile = shell.kind === "mobile";
  let mobile = null;   // the mobile shell (lib/mobile.js) registers itself: syncUndo, onBlocked, …
  applyI18n();

  // The on-screen canvas is the WebGL2 context itself: the final pass goes into it directly,
  // without readback/putImageData (slow on 1600 px frames — see the perf analysis in the plan).
  const view = $("c");
  const gl = view.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
    document.body.querySelectorAll("aside, main, section, header, nav, [data-shell-hide]")
      .forEach((el) => { el.hidden = true; });
    $("nogl").hidden = false;
    throw new Error("WebGL2 required");
  }
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  view.hidden = true;   // empty state: the canvas appears with the first frame (renderCurrent)

  // ---------- state (contract) ----------
  const control = newProfile();
  for (const c of COLORS) control.blender[c] = [0, 0, 0];   // newProfile leaves empty dicts
  for (const z of ZONES) control.grade[z] = [0, 0, 0];
  const state = {
    ...extraState,
    // the manual-adjustment baseline (stage 6, web/lib/baseline.js): { versionId, control }
    // — a deep copy of the selected fit version's control while the wizard's editor works
    // against it; null in the profile editor (resets go to neutral)
    baseline: null,
    raw: null,
    control,
    strength: 100,
    showNeutral: false,
    generation: 0,
    status: "idle",
    statusKind: "info",       // info | progress | error — the kind of the latest status
    nameValid: true,          // block export when false
    renderPending: false,     // the LUT is built in a Worker: tests wait for a render by this flag
  };
  const statusEl = $("status");
  const mirrors = statusIds.map($).filter(Boolean);
  // kind: "info" | "progress" | "error" (spec/ui-mobile-plan.md §2.4); mobile.js listens
  // through the onStatus hook of the returned API.
  let onStatus = null;
  function setStatus(s, kind = "info") {
    state.status = s;
    state.statusKind = kind;
    if (statusEl) statusEl.textContent = s;
    for (const el of mirrors) el.textContent = s;
    onStatus?.(s, kind);
  }

  // RAW is decoded in a Worker (lib/loader.js), and renderer.setFrame expects {develop} in place.
  // So develop is a stub returning the already-ready frame from the latest ready event:
  // no repeated decoding on the main thread, the one-develop-per-frame invariant is kept.
  let pendingFrame = null;
  let renderer = null;

  // ---------- render ----------
  // The profile LUT is built in a Worker (lib/lut-worker.js) and picked up ready: until the LUT
  // arrives, the previous frame stays on the screen. The generation (state.renderPending, lutSeq)
  // discards stale results. rAF limits the request rate during continuous slider movement.
  function renderCurrent() {
    if (renderer && hooks.onRender?.()) return;
    if (!state.raw || !renderer) return;
    if (state.showNeutral) {           // "before" — the Nikon neutral without any NP3 tools
      reveal();
      renderer.neutralToScreen();
      return;
    }
    const ctl = scaled(state.control, state.strength);
    renderer.setProfile(ctl);
    const key = renderer.lutCacheKey(renderer.lutN);
    if (!renderer.hasLut(key) && !lutDead) {
      requestLut(ctl, renderer.lutN);
      return;                          // the previous frame stays until the LUT is ready
    }
    reveal();
    if (renderer.hasFinal()) { renderer.blitFinal(); return; }   // before/after: the result without a full render
    renderer.render({ toScreen: true });
  }

  function reveal() {
    view.hidden = false;               // empty state: the canvas appears with the first frame
    const { w, h } = renderer.frame;
    if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  }

  let raf = 0;
  function scheduleRender(live) {
    if (renderer) renderer.lutN = live ? 17 : 33;
    if (live) {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderCurrent(); });
    } else {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      hist.push();         // a finished action — a snapshot for Ctrl+Z
      renderCurrent();
      hooks.onFinishedEdit?.();
    }
  }

  // ---------- LUT building in a Worker (plan §5, P1) ----------
  let lutSeq = 0;            // monotonic request generation
  let lutPending = null;     // {gen, key, n} — an unapplied request
  let lutDead = false;       // the Worker is unavailable — fallback to the synchronous buildLUT in render
  const lutWorker = new Worker("lib/lut-worker.js", { type: "module" });

  function requestLut(ctl, n) {
    const key = renderer.lutCacheKey(n);
    if (renderer.hasLut(key)) return;
    if (lutPending && lutPending.key === key) return;
    const gen = ++lutSeq;
    lutPending = { gen, key, n };
    state.renderPending = true;
    lutWorker.postMessage({ id: gen, gen, control: ctl, n });
  }

  lutWorker.onmessage = (e) => {
    const { id, lut, error } = e.data;
    const p = lutPending;
    if (!p || p.gen !== id) return;    // stale result: the current request is still building
    lutPending = null;
    if (error) {
      lutDead = true;
      setStatus(t("LUT worker failed: {error}", { error }));
    } else {
      renderer.uploadLut(p.key, p.n, lut);
    }
    state.renderPending = false;
    // the LUT is ready — finish drawing the current screen (the wizard's Compare re-requests
    // its render side; the editor finishes renderCurrent)
    if (!hooks.onLutReady?.()) renderCurrent();
  };
  lutWorker.onerror = () => {
    lutDead = true;
    lutPending = null;
    state.renderPending = false;
    setStatus(t("LUT worker failed"));
    renderCurrent();
  };

  // ---------- the baseline provider (stage 6) ----------
  // One provider for every widget: the selected fit version in the wizard, the neutral
  // defaults in the profile editor (spec/ui.md "Decisions" #2).
  const NEUTRAL = neutralControl();
  function getBaseline() {
    return state.baseline ? { control: state.baseline.control, fitted: true, versionId: state.baseline.versionId }
                          : { control: NEUTRAL, fitted: false, versionId: null };
  }

  // ---------- panel ----------
  let transfer = null;   // transfer appears below; the name callback reaches it later
  const panel = createPanel({ scroll: $("panel-scroll"), foot: $("panel-foot") },
    { state, onChange: scheduleRender, onNameValid: () => transfer?.updateExport(), getBaseline });
  // The specialized editors' edits also refresh the panel's group marks.
  const onEdit = (live) => { panel.updateMarks(); scheduleRender(live); };

  // ---------- edit history: Ctrl+Z (spec/ui-manual-mvp.md "Edit history") ----------
  const hist = createHistory({
    snapshot: () => JSON.parse(JSON.stringify({ control: state.control, strength: state.strength })),
    apply: (s) => {
      Object.assign(state.control, s.control);   // the state.control identity is preserved
      state.strength = s.strength;
      panel.refresh();
      renderCurrent();
      hooks.onFinishedEdit?.();        // an undone edit is a finished edit for the report too
    },
    onChange: () => mobile?.syncUndo?.(),   // the mobile Undo button follows the history
  });

  // ---------- the specialized editors ----------
  // histogram — the neutral luma histogram for the backdrop under the curve.
  const curveEditor = createCurveEditor($("curve-slot"), { state, onChange: onEdit, panel, getBaseline,
    chartSlot: isMobile ? $("curve-chart") : null,
    histogram: () => (renderer && (state.raw || hooks.hasFrame?.())) ? renderer.lumaHistogram() : null });
  const blendingView = createBlendingView($("blending-slot"), { state, onChange: onEdit, panel, getBaseline });
  const gradingView = createGradingView($("grading-slot"), { state, onChange: onEdit, panel, getBaseline });
  // After an NP3 import the editors also re-read the values from the new control.
  const baseRefresh = panel.refresh;
  panel.refresh = () => { baseRefresh(); curveEditor.sync(); blendingView.sync(); gradingView.sync(); };

  /** Rebaselines the editor (stage 6): `version` — the selected fit version (the wizard) or
   *  null (neutral). The manual control is reloaded from the version, the edit history
   *  restarts at it and every mark is re-evaluated. The version is only read (deep-copied). */
  function setBaseline(version) {
    if (version) {
      state.baseline = { versionId: version.id, control: JSON.parse(JSON.stringify(version.control)) };
      Object.assign(state.control, JSON.parse(JSON.stringify(version.control)));
    } else {
      state.baseline = null;
    }
    panel.refresh();
    hist.clear();
    hist.push();
  }

  // ---------- before/after ----------
  const beforeAfter = createBeforeAfter($("ba-slot"), { state, renderCurrent,
    hint: !isMobile, longPressTarget: $("c") });

  // ---------- models ----------
  setStatus(t("loading models…"), "progress");
  const [dev, profile, detail] = await Promise.all([
    loadNeutral(),          // model/dev.json + dev_lut.bin
    fetchModel("model"),    // model/profile.json + profile.bin
    fetchDetail(""),        // model/detail.json + detail.bin
    fetch("model/wbmap.json").then((r) => r.json()).then((j) => setWbMapWeights(j.weights)),
  ]);
  renderer = new Renderer(gl, { dev, profile, detail }, { develop: () => pendingFrame });

  // Applies a ready frame to the editor (the loader's editor path and the wizard entering the
  // editor from a pair share it — the frame is already decoded, develop is not called).
  function applyEditorFrame(st) {
    state.generation = st.gen ?? state.generation;
    state.raw = { bytes: null, image: st.image, info: st.info, name: st.name };
    pendingFrame = st.image;
    renderer.setFrame(null);                 // the frame is from the Worker (or a pair), develop is not called
    hist.clear();                            // changing RAW resets the edit history
    hist.push();                             // base snapshot: the current profile on the new frame
    curveEditor.sync();                      // the backdrop histogram moves to the new frame
    renderCurrent();
    const i = st.info;
    const info = $("info");
    if (info) {
      info.innerHTML =
        `<dt data-i18n="File">${t("File")}</dt><dd>${st.name}</dd>` +
        `<dt data-i18n="Camera">${t("Camera")}</dt><dd>${i.make} ${i.model}${i.dng ? ", DNG" : ""}</dd>` +
        `<dt data-i18n="Frame">${t("Frame")}</dt><dd>${st.image.w}×${st.image.h}</dd>`;
    }
    const warn = $("warn");
    if (warn) {
      warn.hidden = !st.warn;
      if (st.warn) i18nSet(warn, "text", "Camera is not Nikon Z f: development is approximate");
    }
    beforeAfter.update();        // before/after is available only after a successful development
    setStatus(t("Ready"));
  }

  const loader = createRawLoader({ worker: "lib/raw-worker.js", onUpdate: (st) => {
    if (st.tag && hooks.onLoaderUpdate?.(st)) return;
    if (st.type === "busy") {
      setStatus(t("unpacking {name}…", { name: st.name }), "progress");
    } else if (st.type === "error") {
      // the previous frame and profile are not touched: a new file's error goes only to the status
      setStatus(`${st.name}: ${rawErrorText(st.code)}${st.detail ? " — " + st.detail : ""}`, "error");
    } else if (st.type === "ready") {
      applyEditorFrame(st);
    }
  }});

  // ---------- NP3 import/export/share ----------
  transfer = setupTransfer({ state, panel, renderCurrent, setStatus,
    onReset: () => { hist.clear(); hist.push(); },   // an NP3 import resets the edit history
    softDisable: isMobile, shareExport: isMobile,
    onBlocked: isMobile ? (kind, payload) => mobile?.onBlocked?.(kind, payload) : null,
    ...transferOpts });

  hist.push();              // base snapshot of the new profile for Ctrl+Z

  /** Puts an already developed image (the wizard's compare side) into the renderer: one
   *  develop per frame, strength/version changes reuse it. */
  function setFrameImage(image) {
    pendingFrame = image;
    renderer.setFrame(null);
  }

  return { state, setStatus, renderer, loader, panel, hist, curveEditor, blendingView,
           gradingView, beforeAfter, transfer, renderCurrent, scheduleRender, getBaseline,
           setBaseline, applyEditorFrame, setFrameImage, requestLut, NEUTRAL, shell, isMobile,
           get lutDead() { return lutDead; },
           get mobile() { return mobile; }, set mobile(m) { mobile = m; },
           get onStatus() { return onStatus; }, set onStatus(fn) { onStatus = fn; } };
}
