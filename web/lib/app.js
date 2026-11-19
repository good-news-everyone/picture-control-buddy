// The application: the session shell (spec/ui-plan.md §3) around the manual editor.
// State by contract: the session fields — step (start | compare | edit | more; "edit" is the
// manual adjustment step 3.1 — the name predates the full flow and stays for the tests),
// pairs: [{ id, rawFile, targetFile, raw, target, warnings, included, blocked }],
// selectedPairId, versions: [{ id, name, control, parentId, kind, pairIds, fitVector, … }],
// selectedVersionId, fitting, profileName (the fit's NP3 name),
// strength, generation, status — plus the editor state, preserved unchanged:
// { raw: {bytes,image,info,name}|null, control, strength, showNeutral, generation, status }.
// The panel shows the base control; strength is applied only via scaled(control, strength)
// at render time. Compare (spec/ui.md step 2) reuses the same strength — it lives in the
// session and survives step changes.
// Ownership: this file orchestrates; web/lib/session.js — pure pair/name rules,
// web/lib/start.js — the Start screen, web/lib/compare-view.js — the Comparison screen,
// web/lib/history.js — the Ctrl+Z edit history,
// panels.js — the editor panel. CD brings #import/#export and #curve-slot to life, EF — #ba-slot
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
import { createHistory } from "./history.js";
import { createStart } from "./start.js";
import { createCompare, compareUsable } from "./compare-view.js";
import { createReport } from "./report-view.js";
import { warpToWorking } from "./pair-prepare.js";
import { assignFile, pruneEmpty, defaultProfileName, isRawReady, isTargetReady,
         isCompletePair, dimsCompatible, draftVersion } from "./session.js";
import { neutralControl, isDirty, fieldDeltas } from "./baseline.js";
import { decodeTarget, editGain, editWarningCodes, setWbMapWeights, wbMultipliers,
         MIN_TARGET } from "./target.js";

const $ = (id) => document.getElementById(id);
applyI18n();

// The on-screen canvas is the WebGL2 context itself: the final pass goes into it directly,
// without readback/putImageData (slow on 1600 px frames — see the perf analysis in the plan).
const view = $("c");
const gl = view.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });

if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
  document.body.querySelectorAll("aside, main, #start").forEach((el) => { el.hidden = true; });
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
  // --- session (spec/ui-plan.md §3) ---
  step: "start",              // start | compare | edit (manual adjustment) | more (stage-7 stub)
  pairs: [],                  // [{ id, rawFile, targetFile, raw, target, warnings, included, blocked }]
  selectedPairId: null,
  versions: [],               // fit versions (draft, _r1, …) — created by the fitting stages
  selectedVersionId: null,
  reportAggregate: null,      // the aggregate report over the pairs (spec §3; stage 5A compute, 5B display)
  fitting: false,             // a fit runs in the fit Worker (progress in the status line)
  profileName: "",            // the NP3 name for the fit: 1–19 ASCII (the np3.serialize rule)
  // --- the manual-adjustment baseline (stage 6, web/lib/baseline.js) ---
  // { versionId, control } — a deep copy of the selected fit version's control while the
  // editor works in the fitting flow; null in standalone editing (resets go to neutral).
  // Resets, the changed marks and the leave warning compare against it; the version
  // objects themselves are never mutated.
  baseline: null,
  // --- the manual editor state (unchanged) ---
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
const startStatusEl = $("start-status");
function setStatus(s) {
  state.status = s;
  statusEl.textContent = s;
  if (startStatusEl) startStatusEl.textContent = s;
}

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
    hist.push();         // a finished action — a snapshot for Ctrl+Z
    renderCurrent();
    requestManualReport();
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
  // the LUT is ready — finish drawing the current step (the compare view re-requests its
  // render side; the editor finishes renderCurrent)
  if (state.step === "compare" && compareView) compareView.scheduleRender();
  else renderCurrent();
};
lutWorker.onerror = () => {
  lutDead = true;
  lutPending = null;
  state.renderPending = false;
  setStatus(t("LUT worker failed"));
  renderCurrent();
};

// ---------- the baseline provider (stage 6) ----------
// One provider for every widget: the selected fit version in the fitting flow, the neutral
// defaults in standalone editing (spec/ui.md "Decisions" #2).
const NEUTRAL = neutralControl();
function getBaseline() {
  return state.baseline ? { control: state.baseline.control, fitted: true, versionId: state.baseline.versionId }
                        : { control: NEUTRAL, fitted: false, versionId: null };
}

// ---------- panel ----------
let transfer = null;   // CD: transfer appears below; the name callback reaches it later
const panel = createPanel({ scroll: $("panel-scroll"), foot: $("panel-foot") },
  { state, onChange: scheduleRender, onNameValid: () => transfer?.updateExport(), getBaseline });
// The specialized editors' edits also refresh the panel's group marks.
const onEdit = (live) => { panel.updateMarks(); scheduleRender(live); };

// ---------- edit history: Ctrl+Z (spec/ui-manual-mvp.md "Edit history") ----------
// Lives in web/lib/history.js: up to 20 states in sessionStorage, no redo, RAW change / NP3
// import resets it (clear() at those points).
const hist = createHistory({
  snapshot: () => JSON.parse(JSON.stringify({ control: state.control, strength: state.strength })),
  apply: (s) => {
    Object.assign(state.control, s.control);   // the state.control identity is preserved
    state.strength = s.strength;
    panel.refresh();
    renderCurrent();
    requestManualReport();           // an undone edit is a finished edit for the report too
  },
});

// ---------- curve editor (CD) ----------
// histogram — the neutral luma histogram for the backdrop under the curve (only when the curve is enabled).
const curveEditor = createCurveEditor($("curve-slot"), { state, onChange: onEdit, panel, getBaseline,
  histogram: () => (renderer && state.raw) ? renderer.lumaHistogram() : null });
// ---------- Color Blender (UI-2 package): Adjust HSL/Color ----------
const blendingView = createBlendingView($("blending-slot"), { state, onChange: onEdit, panel, getBaseline });
// ---------- Color Grading (UI-2 package): zone x HSL/Color ----------
const gradingView = createGradingView($("grading-slot"), { state, onChange: onEdit, panel, getBaseline });
// After an NP3 import the editors also re-read the values from the new control.
const baseRefresh = panel.refresh;
panel.refresh = () => { baseRefresh(); curveEditor.sync(); blendingView.sync(); gradingView.sync(); };

/** Rebaselines the editor (stage 6): `version` — the selected fit version (the fitting
 *  flow) or null (standalone, neutral). The manual control is reloaded from the version, the
 *  edit history restarts at it (undo never crosses a baseline change) and every mark is
 *  re-evaluated. The version object is only read (deep-copied). */
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

// ---------- before/after (EF) ----------
const beforeAfter = createBeforeAfter($("ba-slot"), { state, renderCurrent });

// ---------- the Comparison screen (stage 4, spec/ui.md step 2) ----------
// The render side: the developed frame through the renderer (neutral + profile LUT + detail),
// then warpToWorking() applies the pair's fitted transform chain (the same parameters
// pair-prepare computed, devignette included — the prepared x is devignetted, the renderer's
// frame is not) and the 3×3 shrink. The result is H3×W3: pixel (y, x) of it == pixel (y, x) of
// the prepared x/y arrays and of the future report — the on-screen upscaling is presentation
// only (the ui-plan.md §6 risk "Preview/report geometry", recorded in compare-view.js).
// Generation-checked: a result for a superseded request resolves null and never applies; while
// its LUT builds, the previous good frame stays on the screen.
let compareFramePair = null;    // which pair the renderer frame belongs to

async function renderCompareSide(pair, version, strength, gen) {
  if (!compareUsable(pair)) return null;
  if (compareFramePair !== pair || !renderer.frame) {
    pendingFrame = pair.raw.image;
    renderer.setFrame(null);              // one develop per pair — strength/version changes reuse it
    compareFramePair = pair;
  }
  const ctl = scaled(version.control, strength);
  renderer.setProfile(ctl);
  renderer.lutN = 33;                     // the final LUT for the comparison
  const key = renderer.lutCacheKey(33);
  if (!renderer.hasLut(key) && !lutDead) {
    requestLut(ctl, 33);                  // async: the ready path re-requests the render side
    return null;
  }
  const rgba = renderer.render({ toScreen: false });
  const img = pair.raw.image;
  const rgb = new Float32Array(img.w * img.h * 3);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgb[i] = rgba[j]; rgb[i + 1] = rgba[j + 1]; rgb[i + 2] = rgba[j + 2];
  }
  const unrotate = (4 - (DECODER_TURNS[pair.raw.info.orientation] ?? 0)) % 4;
  return warpToWorking({ data: rgb, w: img.w, h: img.h }, pair.prepared, unrotate);
}

const compareView = createCompare({ state,
  renderSide: renderCompareSide,
  onPairSelected: () => reportView.refresh(),   // the report follows the pair (stage 5B)
  onVersionSelected: (v) => {
    // the manual editor's baseline becomes the selected version (stage 6): the control is
    // reloaded, the edit history restarts, the marks follow the new baseline
    setBaseline(v);
    requestReport();                      // the report re-runs on every version change (spec/ui.md step 2)
  },
  onStrength: (v) => {
    state.strength = v;                   // the session strength — kept across the steps
    panel.refresh();                      // the editor slider shows the same value
    compareView.scheduleRender();         // re-renders here…
    requestReport();                      // …and the report follows the strength (spec/ui.md step 2)
  },
  onManual: () => {
    const p = state.pairs.find((q) => q.id === state.selectedPairId);
    if (p) enterEditor(p);                // step 3.1 with the selected version as the baseline
  },
  onMore: () => { state.step = "more"; syncStep(); },   // the stage-7 stub
  onStart: () => showStart(),
});
$("more-back").addEventListener("click", () => { state.step = "compare"; syncStep(); });

// ---------- the report panel (stage 5B, spec/ui.md "Report") ----------
// The same component on the Compare screen and beside the manual editor (step 3.1); it
// renders the §4.3 DTOs the report worker lands on the session (pairs[].report,
// reportAggregate) and owns no computation itself. The row highlight and the error-map
// overlay are drawn on the compare image through the compare view (the stage-4 geometry).
const reportView = createReport({ state,
  onHighlight: (labels, group) => compareView.showRegion(labels, group),
  onMapOverlay: (cv) => compareView.setMapOverlay(cv) });

// ---------- Start screen (stages 1–3 of the full flow) ----------
// Pair assembly, the profile name and Fit live here. Stage 2: Fit runs the pair preparation
// (web/lib/pair-prepare.js in the pair Worker) for every assembled pair — progress, the
// aligned NCC and the blocked state land on the pair cards. Stage 3: the prepared pairs go
// to the fit Worker (lib/fit-worker.js) — progress in the status line, cancel on a re-drop
// or on navigation, the immutable draft version on success.
const start = createStart({ state, setStatus,
  onAddRaws: (files) => { for (const f of files) addRawFile(f); },
  onAddTargets: (files) => { for (const f of files) addTargetFile(f); },
  onEditPair: (pair) => enterEditor(pair),
  onFit: () => runFitPreparation(),
});

// ---------- pair preparation (stage 2, spec/web-schemas.md §2) ----------
// The pure port runs in a Worker (lib/pair-worker.js): the main thread stays responsive
// during the alignment search. Generations: a re-dropped file bumps the pair's prepGen —
// a result with an older generation is stale and discarded (the loader.js rule). The target
// goes to the Worker pre-quantized to uint8 (the pipeline's target path is 8-bit; the
// quantization of decodeTarget's u8/255 floats is exact) — three times less to transfer.
const DECODER_TURNS = { 3: 2, 6: 3, 8: 1 };       // render.TURNS — the decoder's EXIF rotation
const pairWorker = new Worker("lib/pair-worker.js", { type: "module" });
let pairSeq = 0;
const pairPending = new Map();

pairWorker.onmessage = (e) => {
  const m = e.data;
  const p = pairPending.get(m.id);
  if (!p) return;
  if (m.type === "progress") { p.onProgress?.(m.stage); return; }
  pairPending.delete(m.id);
  const stale = m.generation && m.generation.pair !== p.pair.prepGen;
  if (m.type === "ready" && !stale) p.resolve({ prepared: m.prepared });
  else if (m.type === "error" && !stale) p.resolve({ error: { code: m.code, detail: m.detail } });
  else p.resolve(null);          // stale: nothing is applied
};

function prepareInWorker(pair, payload, transfer, onProgress) {
  const id = ++pairSeq;
  return new Promise((resolve) => {
    pairPending.set(id, { pair, resolve, onProgress });
    pairWorker.postMessage({ type: "prepare", id, ...payload }, transfer);
  });
}

function cancelPreparation(pair) {
  for (const [id, p] of pairPending) {
    if (p.pair === pair) { pairWorker.postMessage({ type: "cancel", id }); p.resolve(null); }
  }
}

// A new file invalidates whatever the pair had prepared (the user changed the input).
function invalidatePreparation(pair) {
  pair.prepGen = (pair.prepGen ?? 0) + 1;
  pair.prepared = null;
  pair.preparing = false;
  pair.prepStage = null;
  pair.prepError = null;
  pair.fitBlocked = null;
  pair.report = null;                  // the report belonged to the old preparation
  state.reportAggregate = null;
  reportWorkerPairs.delete(String(pair.id));
  reportView.refresh();
  cancelPreparation(pair);
  cancelFit();               // the running fit, if any, was computed from the old inputs
}

// ---------- fitting (stage 3, spec/web-schemas.md §3) ----------
// The free fit runs in a Worker (lib/fit-worker.js): free sampling through a seeded
// mulberry32 (spec §6.4) and the LM fit, with progress per accepted iteration. The heavy
// prepared arrays are sent as copies with transferred buffers, so the session's prepared
// pairs stay valid whatever the outcome (cancel, error — the Worker keeps its copies).
const fitWorker = new Worker("lib/fit-worker.js", { type: "module" });
let fitSeq = 0;
let fitGen = 0;              // the task generation: a cancel/re-fit supersedes the running fit
let fitPending = null;       // { id }
let fitModelBytesPromise = null;

function fitModelBytes() {
  fitModelBytesPromise ??= Promise.all([
    fetch("model/dev.json").then((r) => r.json()),
    fetch("model/dev_lut.bin").then((r) => r.arrayBuffer()),
    fetch("model/profile.json").then((r) => r.json()),
    fetch("model/profile.bin").then((r) => r.arrayBuffer()),
  ]);
  return fitModelBytesPromise;
}

fitWorker.onmessage = (e) => {
  const m = e.data;
  if (!fitPending || m.id !== fitPending.id) return;    // stale: nothing is applied
  if (m.type === "progress") {
    setStatus(t("Fitting: iteration {it} of {total}, cost {cost}",
                { it: m.iteration, total: m.total, cost: m.cost.toFixed(2) }));
    return;
  }
  fitPending = null;
  state.fitting = false;
  if (m.type === "ready") {
    // The immutable draft version (spec/ui-plan.md §3); the strength is kept for display/export.
    state.versions = [draftVersion(m.result)];
    state.selectedVersionId = "draft";
    setStatus(t("Fit finished: {name} ({it} iterations, cost {cost} in {sec}s)", {
      name: m.result.control.name, it: m.result.iterations.run,
      cost: m.result.cost.toFixed(2), sec: (m.ms / 1000).toFixed(1),
    }));
    enterCompare();              // stage 4: a successful fit goes to step 2 (spec/ui.md scenario)
  } else if (m.type === "error") {
    // A failure keeps the previous session state: no partial versions.
    setStatus(t("Fit failed: {error}", { error: m.detail }));
  } else {
    setStatus(t("Fit cancelled — press Fit to run it again"));
  }
  start.refresh();
};

function cancelFit() {
  if (!fitPending) return;
  fitWorker.postMessage({ type: "cancel", id: fitPending.id });
  fitPending = null;
  state.fitting = false;
  setStatus(t("Fit cancelled — the inputs changed"));
}

async function startFit(pairs) {
  state.fitting = true;
  start.refresh();
  setStatus(t("Fitting…"));
  try {
    const [devMeta, devLut, profileMeta, profileBin] = await fitModelBytes();
    if (!state.fitting) return false;      // superseded while the models were fetched
    const payload = {
      type: "fit", id: ++fitSeq, generation: { session: 0, pair: 0, task: ++fitGen },
      seed: 0, iters: 30, baseName: state.profileName,
      devMeta, devLut, profileMeta, profileBin,    // clones: the cached buffers are kept
      files: { raw: pairs[0].rawFile.name, target: pairs[0].targetFile.name },
      pairs: pairs.map((p) => ({
        name: String(p.id), ncc: p.prepared.ncc,
        x: p.prepared.x.slice(), y: p.prepared.y.slice(),
        masks: {
          clipMask: p.prepared.masks.clipMask.slice(),
          reportMask: p.prepared.masks.reportMask.slice(),
          validMask: p.prepared.masks.validMask.slice(),
          nearWhiteMask: p.prepared.masks.nearWhiteMask.slice(),
        },
        gain: p.prepared.gain.slice(),
      })),
    };
    const transfer = [];
    for (const q of payload.pairs) {
      transfer.push(q.x.buffer, q.y.buffer, q.gain.buffer,
                    q.masks.clipMask.buffer, q.masks.reportMask.buffer,
                    q.masks.validMask.buffer, q.masks.nearWhiteMask.buffer);
    }
    fitPending = { id: payload.id };
    fitWorker.postMessage(payload, transfer);
    return true;
  } catch (err) {
    state.fitting = false;
    start.refresh();
    setStatus(t("Fit failed: {error}", { error: String(err.message || err) }));
    return true;                           // reported: the Fit flow ends here
  }
}

// ---------- the report worker (stage 5A, spec/web-schemas.md §4) ----------
// Reports run in the background on the stage-4 hooks (a version/strength change, entering
// Compare, a finished fit) and land on the session: pairs[].report per pair plus the
// aggregate over the compared pairs (spec §3). The heavy prepared arrays go to the Worker
// only until it holds that pair generation; afterwards a request references the caches.
// A failing or stale report never blocks rendering — the comparison owns its own frames.
const reportWorker = new Worker("lib/report-worker.js", { type: "module" });
let reportSeq = 0;
let reportGen = 0;                 // the task generation: a newer request supersedes the running one
let reportPending = null;          // { id }
const reportWorkerPairs = new Map();   // pair name -> the pair generation the Worker holds

reportWorker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "progress") return;          // the map progress is not surfaced (fast)
  if (!reportPending || m.id !== reportPending.id) return;
  reportPending = null;
  if (!m.generation || m.generation.task !== reportGen) return;   // stale: nothing is applied
  reportView.setUpdating(false);
  if (m.type === "ready") {
    for (const r of m.reports) {
      const p = state.pairs.find((q) => String(q.id) === r.pair);
      if (!p) continue;
      p.report = r;                           // the §4.3 DTO at the current version + strength
      // the fitted version's own dE — the reference of the manual fittedDelta (stage 6)
      if (!String(m.versionId).endsWith("+manual"))
        p.fittedDE = { versionId: m.versionId, strength: m.strength, value: r.summary.renderDE };
    }
    state.reportAggregate = m.aggregate;
    reportView.refresh();
  }
  // an error keeps the previous reports; rendering is unaffected
};
reportWorker.onerror = () => { /* the report is optional: rendering is unaffected */ };

// Step 3.1 (stage 6): a finished manual edit re-runs the report on the manual control — the
// "<version>+manual" report with the field deltas vs the fitted baseline and fittedDelta
// against the fitted version's own dE at the same strength. Outside the flow — nothing.
function requestManualReport() {
  if (state.step === "edit" && state.baseline) requestReport();
}

async function requestReport() {
  try {
    const version = state.versions.find((v) => v.id === state.selectedVersionId);
    const usable = state.pairs.filter(compareUsable);
    if (!version || !usable.length) return;
    // the manual control replaces the version's while the editor works on that baseline
    const manual = state.step === "edit" && state.baseline?.versionId === version.id
                   && isDirty(state.control, state.baseline.control);
    const control = manual ? JSON.parse(JSON.stringify(state.control)) : version.control;
    const versionId = manual ? `${version.id}+manual` : version.id;
    let deltas = null, fittedRenderDE = null;
    if (manual) {
      deltas = fieldDeltas(state.control, state.baseline.control);
      // the worker takes one reference dE for the task: exact for a single pair; with more
      // pairs the delta would mix pairs, so it is left out (shown as absent)
      const ref = usable.length === 1 ? usable[0].fittedDE : null;
      if (ref && ref.versionId === version.id && ref.strength === state.strength) fittedRenderDE = ref.value;
    }
    const gen = ++reportGen;                  // supersede whatever is running/fetching
    const pairs = [], transfer = [];
    for (const p of usable) {
      const pgen = p.prepGen ?? 0;
      const entry = { name: String(p.id), generation: pgen,
                      files: { raw: p.rawFile?.name ?? "", target: p.targetFile?.name ?? "" },
                      w3: Math.floor(p.prepared.size.w / 3), h3: Math.floor(p.prepared.size.h / 3) };
      if (reportWorkerPairs.get(entry.name) !== pgen) {
        entry.x = p.prepared.x.slice();       // copies: the session's prepared arrays survive
        entry.y = p.prepared.y.slice();
        entry.masks = { reportMask: p.prepared.masks.reportMask.slice() };
        entry.gain = p.prepared.gain.slice();
        transfer.push(entry.x.buffer, entry.y.buffer,
                      entry.masks.reportMask.buffer, entry.gain.buffer);
        reportWorkerPairs.set(entry.name, pgen);
      }
      pairs.push(entry);
    }
    const [devMeta, devLut, profileMeta, profileBin] = await fitModelBytes();
    if (gen !== reportGen) return;            // superseded while the models were fetched
    const id = ++reportSeq;
    reportPending = { id };
    reportWorker.postMessage({ type: "report", id,
      generation: { session: 0, pair: 0, task: gen },
      versionId, control, strength: state.strength,
      fittedRenderDE, deltas,                 // stage 6: set only for a manual report
      pairs, devMeta, devLut, profileMeta, profileBin }, transfer);
    reportView.setUpdating(true);             // the previous report stays, dimmed (spec/ui.md step 3.1)
  } catch (err) {
    /* never blocks rendering */ void err;
  }
}

async function prepareOne(pair) {
  pair.preparing = true;
  pair.prepStage = "queued";
  pair.prepError = null;
  start.refresh();
  const gen = pair.prepGen;
  try {
    const rawBytes = new Uint8Array(await pair.rawFile.arrayBuffer());
    if (gen !== pair.prepGen) return false;    // superseded while the file was read
    const g = editGain(pair.target.xmp, pair.wbMult ?? null);
    // the target as uint8 (the preparePair contract also accepts the Float32Array directly)
    const rgb = pair.target.rgb;
    const targetU8 = new Uint8Array(rgb.length);
    for (let i = 0; i < rgb.length; i++) targetU8[i] = Math.round(Math.max(0, Math.min(1, rgb[i])) * 255);
    const res = await prepareInWorker(pair, {
      pairId: String(pair.id),
      files: { raw: pair.rawFile.name, target: pair.targetFile.name },
      generation: { session: 0, pair: gen, task: 0 },
      linear: pair.raw.image.rgb.slice(),       // a copy: the editor keeps the original frame
      lw: pair.raw.image.w, lh: pair.raw.image.h,
      unrotate: (4 - (DECODER_TURNS[pair.raw.info.orientation] ?? 0)) % 4,
      targetU8, tw: pair.target.width, th: pair.target.height,
      xmp: pair.target.xmp, rawBytes,
      gain: g.gain, gainNote: g.note,
    }, [rawBytes.buffer, targetU8.buffer], (stage) => {
      if (pair.prepGen === gen) { pair.prepStage = stage; start.refresh(); }
    });
    if (pair.prepGen !== gen) return false;    // superseded mid-flight: nothing is applied
    if (res && res.error) pair.prepError = res.error.detail;
    else if (res) { pair.prepared = res.prepared; pair.prepStage = "done"; }
  } catch (err) {
    pair.prepError = String(err.message || err);
  } finally {
    if (pair.prepGen === gen) pair.preparing = false;
    start.refresh();
  }
  return true;
}

// Fit (stages 2–3): prepare every included pair, then send the prepared pairs to the fit
// Worker (stage 3). A preparation superseded mid-run (the user changed a file) aborts the
// run — the inputs no longer match what the remaining pairs would prepare against.
async function runFitPreparation() {
  if (state.fitting) return;
  const pairs = state.pairs.filter((p) => isCompletePair(p) && p.included);
  if (!pairs.length) {
    setStatus(t("Assemble at least one RAW + JPEG pair to fit"));
    return;
  }
  for (const p of pairs) {
    if (p.preparing) continue;
    if (p.prepared) continue;                  // already prepared for this input
    // the pre-fit check (match.MIN_TARGET): a small target is a preview inside a DNG
    if (Math.max(p.target.width, p.target.height) < MIN_TARGET) {
      p.fitBlocked = { code: "target_too_small", detail: `${p.target.width}×${p.target.height}` };
      start.refresh();
      continue;
    }
    if (!(await prepareOne(p))) {
      setStatus(t("Preparation interrupted by a changed file — press Fit again"));
      return;
    }
  }
  // only the prepared, unblocked included pairs are fitted — the exact ids go into the version
  const eligible = pairs.filter((p) => p.prepared && !p.prepared.blocked && !p.fitBlocked);
  if (!eligible.length) {
    setStatus(t("Nothing to fit: every included pair is blocked"));
    return;
  }
  if (!(await startFit(eligible))) {
    setStatus(t("Fit interrupted by a changed file — press Fit again"));
  }
}

// ---------- model and RAW loading ----------
setStatus(t("loading models…"));
const [dev, profile, detail] = await Promise.all([
  loadNeutral(),          // model/dev.json + dev_lut.bin
  fetchModel("model"),    // model/profile.json + profile.bin
  fetchDetail(""),        // model/detail.json + detail.bin
  fetch("model/wbmap.json").then((r) => r.json()).then((j) => setWbMapWeights(j.weights)),
]);
renderer = new Renderer(gl, { dev, profile, detail }, { develop: () => pendingFrame });

const ERRORS = {
  nef_high_efficiency: "NEF High Efficiency compression is not supported",
  not_bayer: "Only Bayer-sensor files are supported",
  decode_failed: "Failed to decode the file",
  wasm_failed: "The RAW unpacker (WASM) failed to initialize",
};

// Applies a ready frame to the manual editor (the loader's editor path and entering the
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
  $("info").innerHTML =
    `<dt>${t("File")}</dt><dd>${st.name}</dd>` +
    `<dt>${t("Camera")}</dt><dd>${i.make} ${i.model}${i.dng ? ", DNG" : ""}</dd>` +
    `<dt>${t("Frame")}</dt><dd>${st.image.w}×${st.image.h}</dd>`;
  $("warn").hidden = !st.warn;
  if (st.warn) $("warn").textContent = t("Camera is not Nikon Z f: development is approximate");
  beforeAfter.update();        // before/after is available only after a successful development
  setStatus(t("Ready"));
}

const loader = createRawLoader({ worker: "lib/raw-worker.js", onUpdate: (st) => {
  if (st.type === "busy") {
    setStatus(t("unpacking {name}…", { name: st.name }));
  } else if (st.type === "error") {
    const msg = t(ERRORS[st.code] || st.code);
    const full = `${st.name}: ${msg}${st.detail ? " — " + st.detail : ""}`;
    if (st.tag?.kind === "pair") {
      // A RAW that does not decode blocks its pair (spec/ui.md checks table); the other
      // pairs and the editor state stay untouched.
      const p = st.tag.pair;
      if (p.rawFile && p.rawFile.name === st.name) {
        p.raw = "error";
        p.rawError = `${msg}${st.detail ? " — " + st.detail : ""}`;
        p.blocked = true;
        p.included = false;
        refreshPair(p);
      }
    }
    // We do not touch the previous frame and profile: a new file's error goes only to the status.
    setStatus(full);
    start.refresh();
  } else if (st.type === "ready") {
    if (st.tag?.kind === "pair") {
      const p = st.tag.pair;
      if (p.rawFile && p.rawFile.name === st.name && p.raw === "pending") {
        p.raw = { name: st.name, image: st.image, info: st.info, warn: st.warn };
        refreshPair(p);
        setStatus(t("Ready"));
      }
      start.refresh();
    } else {
      applyEditorFrame(st);
    }
  }
}});

// ---------- pair assembly (spec/ui.md step 1, stage 1) ----------
// The pairing rule lives in web/lib/session.js: same base name first, otherwise in order.

// Recomputes the structured warnings of a pair (camera, target XMP checks, the edit-gain note).
function refreshPair(p) {
  const w = [];
  if (isRawReady(p) && p.raw.warn) w.push({ code: "camera" });
  if (isTargetReady(p)) {
    const tgt = p.target;
    if (p.targetFile) {
      for (const c of editWarningCodes(p.targetFile.name, [tgt.width, tgt.height], tgt.xmp)) w.push(c);
    }
    const g = editGain(tgt.xmp, p.wbMult ?? null);
    if (g.note) w.push({ code: "gain_note", note: g.note });
  }
  if (p.raw === "error") w.push({ code: "raw_error", error: p.rawError || t("Failed to decode the file") });
  p.warnings = w;
}

// RAW decodes are serialized: the loader is single-generation, so a second concurrent open
// would make the first one stale and its pair would never resolve.
let rawQueue = Promise.resolve();
function addRawFile(file) {
  const pair = assignFile(state.pairs, "raw", file);
  if (state.selectedPairId == null) state.selectedPairId = pair.id;
  pair.raw = "pending";
  pair.blocked = false;    // a re-drop retries the decode (assignFile matches the same-name slot)
  invalidatePreparation(pair);
  start.setNameDefault(defaultProfileName(file.name));
  start.refresh();
  rawQueue = rawQueue.then(async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try { pair.wbMult = wbMultipliers(bytes); } catch { pair.wbMult = null; }
    const image = await loader.open(bytes, { name: file.name, tag: { kind: "pair", pair } });
    if (image === null && pair.raw === "pending") {
      // Superseded by a newer editor load before it started: the slot stays pending
      // for a re-drop (the user can also enter the editor from any ready pair).
      setStatus(t("Decoding of {name} was interrupted — drop the file again", { name: file.name }));
    }
    refreshPair(pair);
    start.refresh();
  });
  return rawQueue;
}

async function addTargetFile(file) {
  const pair = assignFile(state.pairs, "target", file);
  if (state.selectedPairId == null) state.selectedPairId = pair.id;
  pair.target = "pending";
  invalidatePreparation(pair);
  start.refresh();
  try {
    const target = await decodeTarget(file);
    // The stage-1 dimension guard (web/lib/session.js): a target whose aspect ratio does not
    // match the RAW frame is rejected — real alignment and NCC arrive in stage 2.
    if (isRawReady(pair) && !dimsCompatible(pair.raw.image, target)) {
      pair.target = null;
      pair.targetFile = null;
      pruneEmpty(state.pairs);
      setStatus(t("{name}: dimensions do not match the RAW frame — the target is skipped", { name: file.name }));
      start.refresh();
      return;
    }
    pair.target = target;
  } catch {
    // Reject the file only: the pair (and the rest of the session) keeps its last valid state.
    pair.target = null;
    pair.targetFile = null;
    pruneEmpty(state.pairs);
    setStatus(t("{name}: could not be read as a JPEG target — the file is skipped", { name: file.name }));
  }
  refreshPair(pair);
  start.refresh();
}

// ---------- navigation: Start <-> the manual editor ----------
function enterEditor(pair) {
  if (!isRawReady(pair) || pair.blocked) return;
  cancelFit();                         // navigation cancels a running fit
  state.selectedPairId = pair.id;
  state.step = "edit";
  syncStep();
  reportView.refresh();                // the report shows beside the editor (spec/ui.md step 3.1)
  // entering the editor loads the selected version's control as the immutable baseline
  // (stage 6): resets/marks/undo work against it; without a fitted version the editor is
  // the standalone one (the control is kept, resets go to neutral). The version history is
  // never touched.
  const v = state.versions.find((x) => x.id === state.selectedVersionId);
  if (v) setBaseline(v);
  else if (state.baseline) setBaseline(null);
  applyEditorFrame({ name: pair.raw.name, image: pair.raw.image, info: pair.raw.info, warn: pair.raw.warn });
}

// ---------- leaving the manual adjustment (stage 6, spec/ui-plan.md stage 6) ----------
// Returning to fitting (Start / Compare) from step 3.1 with manual edits on a fitted
// baseline warns first: the edits are discarded (the version stays unchanged; manual edits
// never carry into a refit). The warning is an in-page alertdialog, not window.confirm —
// non-blocking for the page and the browser tooling. Without edits, or in standalone
// editing (nothing is discarded there), navigation is immediate.
const leaveBox = $("leave-confirm");
let leavePending = null;
function guardLeave(go) {
  if (state.step !== "edit" || !state.baseline || !isDirty(state.control, state.baseline.control))
    return false;
  leavePending = go;
  leaveBox.hidden = false;
  $("leave-keep").focus();
  return true;
}
function leaveKeep() {
  leavePending = null;
  leaveBox.hidden = true;
}
function leaveDiscard() {
  const go = leavePending;
  leavePending = null;
  leaveBox.hidden = true;
  Object.assign(state.control, JSON.parse(JSON.stringify(state.baseline.control)));
  panel.refresh();
  hist.clear();
  hist.push();
  go?.();
}
$("leave-keep").addEventListener("click", leaveKeep);
$("leave-discard").addEventListener("click", leaveDiscard);
leaveBox.addEventListener("keydown", (e) => { if (e.key === "Escape") leaveKeep(); });

function showStart() {
  if (guardLeave(showStart)) return;
  state.step = "start";
  syncStep();
  start.refresh();       // the assembled session is kept across the navigation
}

// The Comparison screen (spec/ui.md step 2, stage 4): requires a fitted version — from Fit
// (the ready handler above) or, later, a refit. Leaving it keeps the prepared pairs and the
// versions; the selected pair skips blocked ones (they cannot be compared, as they cannot fit).
function enterCompare() {
  if (guardLeave(enterCompare)) return;
  if (!state.versions.length) {
    setStatus(t("Fit a profile first — the Comparison step needs a version"));
    return;
  }
  let pair = state.pairs.find((p) => p.id === state.selectedPairId);
  if (!compareUsable(pair)) pair = state.pairs.find(compareUsable);
  if (!pair) {
    setStatus(t("No prepared pair to compare — Fit first"));
    return;
  }
  state.selectedPairId = pair.id;
  state.step = "compare";
  compareFramePair = null;         // the render side loads the selected pair's frame
  syncStep();
  compareView.refresh();
  requestReport();                 // the report recomputes with the comparison (spec/ui.md step 2)
  reportView.refresh();            // the last good report shows while the new one computes
}

function syncStep() {
  document.body.classList.toggle("step-start", state.step === "start");
  document.body.classList.toggle("step-edit", state.step === "edit");
  document.body.classList.toggle("step-compare", state.step === "compare");
  document.body.classList.toggle("step-more", state.step === "more");
  $("ed-to-compare").hidden = !state.versions.length;   // the editor's way back to Compare
  if (state.step !== "edit") leaveKeep();               // a pending warning never outlives the step
}

$("to-start").addEventListener("click", showStart);
$("to-compare").addEventListener("click", enterCompare);
$("ed-to-compare").addEventListener("click", enterCompare);

// An editor-step RAW load: the standalone manual-editor behavior (the frame is replaced,
// the profile and strength are kept). Pair assembly happens on the Start screen.
function editorOpenRaw(file) {
  return loader.open(file);
}

// ---------- files: input + drag-and-drop ----------
const drop = $("drop");
drop.onclick = () => $("file").click();
$("file").onchange = (ev) => { const f = ev.target.files[0]; if (f) editorOpenRaw(f); };
for (const ev2 of ["dragenter", "dragover"]) document.addEventListener(ev2, (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
for (const ev2 of ["dragleave", "drop"]) document.addEventListener(ev2, (e) => {
  e.preventDefault();
  drop.classList.remove("over");
});
// Routing by extension: without it, an NP3 dropped onto the page went to the RAW decoder
// and died with "Failed to decode", although the file was valid. On the Start screen NEF/DNG
// and JPG assemble pairs; in the editor a RAW keeps the single-RAW behavior, a JPEG goes to
// the target path. The Start-screen zones stopPropagation and handle their own drops.
document.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  for (const f of files) routeFile(f);
});

function routeFile(f) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (ext === "np3") { transfer.importFile(f); return; }
  if (ext === "nef" || ext === "dng") {
    if (state.step === "start") addRawFile(f);
    else editorOpenRaw(f);
  } else if (ext === "jpg" || ext === "jpeg") {
    addTargetFile(f);
  } else {
    setStatus(t("Unsupported file: {name} — drop a NEF, DNG, JPG or NP3", { name: f.name }));
  }
}

// ---------- NP3 import/export (CD) ----------
transfer = setupTransfer({ state, panel, renderCurrent, setStatus,
  onReset: () => { hist.clear(); hist.push(); } });   // an NP3 import resets the edit history

syncStep();
setStatus(t("Add RAW and JPEG files to assemble pairs"));
hist.push();              // base snapshot of the new profile for Ctrl+Z
transfer.importFromUrl(); // the ?np3= share parameter, if any

// For the end-to-end tests (EF) and the following parts: the state and entry points.
// The session fields (step, pairs, selectedPairId, versions, selectedVersionId, profileName)
// are added alongside the existing editor keys — nothing is removed.
window.__np3app = { state, panel, renderer, loader, renderCurrent, curveEditor, blendingView,
                    gradingView, transfer, beforeAfter, start, hist, compare: compareView,
                    report: reportView, getBaseline, setBaseline,
                    enterEditor, showStart, enterCompare, addRawFile, addTargetFile, routeFile,
                    runFitPreparation, prepareOne };
