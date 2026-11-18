// The application: the frame and the preview pipeline (part AB of plan section 5).
// State by contract: { raw: {bytes,image,info,name}|null, control, strength, showNeutral,
// generation, status }. The panel shows the base control; strength is applied only
// via scaled(control, strength) at render time.
// Ownership: this file + panels.js. CD brings #import/#export and #curve-slot to life, EF — #ba-slot
// (before/after: state.showNeutral = true + renderCurrent() already shows the neutral without LUT/strength).
import { newProfile, COLORS, ZONES } from "./np3.js";
import { scaled } from "./strength.js";
import { loadModel as loadNeutral } from "./neutral.js";
import { fetchModel } from "./profile.js";
import { fetchDetail } from "./detail.js";
import { Renderer } from "./renderer.js";
import { createRawLoader } from "./loader.js";
import { t, applyI18n } from "./i18n.js";
import { createPanel } from "./panels.js";
import { createCurveEditor } from "./curve-editor.js";
import { createBlendingView } from "./blending.js";
import { createGradingView } from "./grading.js";
import { createBeforeAfter } from "./before-after.js";
import { setupTransfer } from "./transfer.js";

const $ = (id) => document.getElementById(id);
applyI18n();

// The on-screen canvas is the WebGL2 context itself: the final pass goes into it directly,
// without readback/putImageData (slow on 1600 px frames — see the perf analysis in the plan).
const view = $("c");
const gl = view.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });

if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
  document.body.querySelectorAll("aside, main").forEach((el) => { el.hidden = true; });
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
  raw: null,
  control,
  strength: 100,
  showNeutral: false,
  generation: 0,
  status: "idle",
  nameValid: true,          // CD: block export when false
  renderPending: false,     // the LUT is built in a Worker: tests wait for a render by this flag
};
const statusEl = $("status");
function setStatus(s) { state.status = s; statusEl.textContent = s; }

// RAW is decoded in a Worker (lib/loader.js), and renderer.setFrame expects {develop} in place.
// So develop is a stub returning the already-ready frame from the latest ready event:
// no repeated decoding on the main thread, the one-develop-per-frame invariant is kept.
let pendingFrame = null;
let renderer = null;

// ---------- render ----------
// The profile LUT is built in a Worker (lib/lut-worker.js) and picked up ready: until the LUT
// arrives, the previous frame stays on the screen. The generation (state.renderPending, lutSeq) discards
// stale results: finishing a LUT build for an older state cannot override a newer one.
// rAF limits the request rate during continuous slider movement.
function renderCurrent() {
  if (!state.raw || !renderer) return;
  if (state.showNeutral) {           // EF: "before" — the Nikon neutral without any NP3 tools
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
    pushHist();          // a finished action — a snapshot for Ctrl+Z
    renderCurrent();
  }
}

// ---------- edit history: Ctrl+Z (plan/spec "Edit history") ----------
// Up to 20 last slider states (control + strength) in the tab's sessionStorage.
// A snapshot is taken on every finished action (change/release/button). Changing RAW or
// importing an NP3 resets the history. No redo: a new action cuts off the undone steps.
const HIST_KEY = "np3hist";
let hist = { stack: [], idx: -1 };
try {
  const raw0 = JSON.parse(sessionStorage.getItem(HIST_KEY));
  if (raw0 && Array.isArray(raw0.stack)) hist = raw0;
} catch { /* sessionStorage unavailable — the history is memory-only */ }

function saveHist() {
  try { sessionStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch { }
}
function snapshotHist() {
  return JSON.parse(JSON.stringify({ control: state.control, strength: state.strength }));
}
function pushHist() {
  hist.stack = hist.stack.slice(0, hist.idx + 1);   // cut off the undone future
  hist.stack.push(snapshotHist());
  if (hist.stack.length > 20) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  saveHist();
}
function clearHist() {
  hist = { stack: [], idx: -1 };
  saveHist();
}
function applyHist(s) {
  Object.assign(state.control, JSON.parse(JSON.stringify(s.control)));  // the state.control identity is preserved
  state.strength = s.strength;
  panel.refresh();
  renderCurrent();
  saveHist();
}
function undo() {
  if (hist.idx <= 0) return;
  hist.idx--;
  applyHist(hist.stack[hist.idx]);
}
window.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "z" || ev.shiftKey) return;
  // in text fields Ctrl+Z is the native input undo
  const el = ev.target.closest?.("input:not([type=range]), textarea, select, [contenteditable='true']");
  if (el) return;
  ev.preventDefault();
  undo();
});

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
  renderCurrent();                   // the LUT is ready — finish drawing the current state
};
lutWorker.onerror = () => {
  lutDead = true;
  lutPending = null;
  state.renderPending = false;
  setStatus(t("LUT worker failed"));
  renderCurrent();
};

// ---------- panel ----------
let transfer = null;   // CD: transfer appears below; the name callback reaches it later
const panel = createPanel({ scroll: $("panel-scroll"), foot: $("panel-foot") },
  { state, onChange: scheduleRender, onNameValid: () => transfer?.updateExport() });

// ---------- curve editor (CD) ----------
// histogram — the neutral luma histogram for the backdrop under the curve (only when the curve is enabled).
const curveEditor = createCurveEditor($("curve-slot"), { state, onChange: scheduleRender, panel,
  histogram: () => (renderer && state.raw) ? renderer.lumaHistogram() : null });
// ---------- Color Blender (UI-2 package): Adjust HSL/Color ----------
const blendingView = createBlendingView($("blending-slot"), { state, onChange: scheduleRender, panel });
// ---------- Color Grading (UI-2 package): zone x HSL/Color ----------
const gradingView = createGradingView($("grading-slot"), { state, onChange: scheduleRender, panel });
// After an NP3 import the editors also re-read the values from the new control.
const baseRefresh = panel.refresh;
panel.refresh = () => { baseRefresh(); curveEditor.sync(); blendingView.sync(); gradingView.sync(); };

// ---------- before/after (EF) ----------
const beforeAfter = createBeforeAfter($("ba-slot"), { state, renderCurrent });

// ---------- model and RAW loading ----------
setStatus(t("loading models…"));
const [dev, profile, detail] = await Promise.all([
  loadNeutral(),          // model/dev.json + dev_lut.bin
  fetchModel("model"),    // model/profile.json + profile.bin
  fetchDetail(""),        // model/detail.json + detail.bin
]);
renderer = new Renderer(gl, { dev, profile, detail }, { develop: () => pendingFrame });

const ERRORS = {
  nef_high_efficiency: "NEF High Efficiency compression is not supported",
  not_bayer: "Only Bayer-sensor files are supported",
  decode_failed: "Failed to decode the file",
  wasm_failed: "The RAW unpacker (WASM) failed to initialize",
};

const loader = createRawLoader({ worker: "lib/raw-worker.js", onUpdate: (st) => {
  if (st.type === "busy") {
    setStatus(t("unpacking {name}…", { name: st.name }));
  } else if (st.type === "error") {
    // We do not touch the previous frame and profile: a new file's error goes only to the status.
    const msg = t(ERRORS[st.code] || st.code);
    setStatus(`${st.name}: ${msg}${st.detail ? " — " + st.detail : ""}`);
  } else if (st.type === "ready") {
    state.generation = st.gen;
    state.raw = { bytes: null, image: st.image, info: st.info, name: st.name };
    pendingFrame = st.image;
    renderer.setFrame(null);                 // the frame is from the Worker, develop is not called
    clearHist();                             // changing RAW resets the edit history
    pushHist();                              // base snapshot: the current profile on the new frame
    curveEditor.sync();                      // the backdrop histogram moves to the new frame
    renderCurrent();
    const i = st.info;
    $("info").innerHTML =
      `<dt>${t("File")}</dt><dd>${st.name}</dd>` +
      `<dt>${t("Camera")}</dt><dd>${i.make} ${i.model}${i.dng ? ", DNG" : ""}</dd>` +
      `<dt>${t("Frame")}</dt><dd>${st.image.w}×${st.image.h}</dd>`;
    $("warn").hidden = !st.warn;
    if (st.warn) $("warn").textContent = t("Camera is not Nikon Z f: development is approximate");
    beforeAfter.update();        // before/after is available only after a successful development
    setStatus(t("Ready"));
  }
}});

// ---------- files: input + drag-and-drop ----------
const drop = $("drop");
drop.onclick = () => $("file").click();
$("file").onchange = (ev) => { const f = ev.target.files[0]; if (f) loader.open(f); };
for (const ev2 of ["dragenter", "dragover"]) document.addEventListener(ev2, (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
for (const ev2 of ["dragleave", "drop"]) document.addEventListener(ev2, (e) => {
  e.preventDefault();
  drop.classList.remove("over");
});
// Routing by extension: without it, an NP3 dropped onto the page went to the RAW decoder
// and died with "Failed to decode", although the file was valid.
document.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (ext === "np3") transfer.importFile(f);
  else if (ext === "nef" || ext === "dng") loader.open(f);
  else setStatus(t("Unsupported file: {name} — drop a NEF, DNG or NP3", { name: f.name }));
});

// ---------- NP3 import/export (CD) ----------
transfer = setupTransfer({ state, panel, renderCurrent, setStatus,
  onReset: () => { clearHist(); pushHist(); } });   // an NP3 import resets the edit history

setStatus(t("Drop a NEF or DNG"));
pushHist();              // base snapshot of the new profile for Ctrl+Z
transfer.importFromUrl(); // the ?np3= share parameter, if any

// For the end-to-end tests (EF) and the following parts: the state and entry points.
window.__np3app = { state, panel, renderer, loader, renderCurrent, curveEditor, blendingView, gradingView, transfer, beforeAfter };
