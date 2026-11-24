// The fitting wizard (spec/ui.md steps 1 -> 2 -> 3.1 -> 3.2, spec/ui-pages.md): the entry of
// picture-control-jpg-fit.html. The session shell (spec/ui-plan.md §3) around the editor core
// (lib/editor-core.js): RAW-first pair cards, preparation, the fit/refit Workers, Compare, the
// report, the coverage advice and the versions; the editor is step 3.1 — manual adjustment of the
// selected fitted version (reset/marks against it, the leave warning). No NP3 import here:
// profiles enter the wizard only through a fit; Save NP3 and the share link stay (the link
// opens the profile editor page).
// Since stage 13 (spec/ui.md decision #11) Compare is the hub after the first fit: more pairs,
// removal, the coverage and the refit live there; starting over is a page reload.
// State by contract: the session fields — step (start | compare | edit; "edit" is the
// manual adjustment step 3.1 — the name predates the full flow and stays for the tests),
// pairs: [{ id, rawFile, targetFile, raw, target, warnings, blocked, targetError }] (RAW first, decision #7),
// selectedPairId, versions: [the current profile { id, name, control, parentId, kind,
// pairIds, fitVector, … }] — one entry since decision #12 (no version history in the UI; a
// refit replaces it, the id changes: draft, r1, r2, …), selectedVersionId, fitting, profileName (the fit's NP3 name), advice, reportAggregate —
// plus the editor state of the core. Compare (step 2) reuses the editor's strength — it lives
// in the session and survives step changes.
// Ownership: this file orchestrates; web/lib/session.js — pure pair/name rules,
// web/lib/start.js — the Start screen, web/lib/compare-view.js — the Comparison screen,
// web/lib/report-view.js — the report, web/lib/coverage-view.js — the color-coverage advice.
import { t, register, initLang, reTranslate } from "./i18n.js";
import { mountLangMenu } from "./lang-select.js";
import { mountInfoPop } from "./info-pop.js";
import EDITOR_RU from "./i18n-editor-ru.js";
import EDITOR_DE from "./i18n-editor-de.js";
import EDITOR_FR from "./i18n-editor-fr.js";
import FIT_RU from "./i18n-fit-ru.js";
import FIT_DE from "./i18n-fit-de.js";
import FIT_FR from "./i18n-fit-fr.js";
import { createEditorCore, $, rawErrorText } from "./editor-core.js";
import { createStart } from "./start.js";
import { createCompare, compareUsable } from "./compare-view.js";
import { createReport } from "./report-view.js";
import { computeAdvice, frameOf } from "./coverage-view.js";
import { viewRemap, applyRemap } from "./pair-prepare.js";
import { frameGeometry, sensorPerWorking, planRegion, rotateRegion } from "./zoom-plan.js";
import { resizeF } from "./resample.js";
import { addRawPair, canAttachTarget, defaultProfileName, isRawReady, isTargetReady,
         isCompletePair, dimsCompatible, draftVersion, refitPairIds,
         makeRefitVersion, prepSlots } from "./session.js";
import { isDirty } from "./baseline.js";
import { decodeTarget, editGain, editWarningCodes, wbMultipliers, MIN_TARGET } from "./target.js";
import { scaled } from "./strength.js";

// ---------- language (spec/ui-pages.md "Languages") ----------
// The wizard speaks the editor pages' languages: the editor dictionaries cover the shared
// modules (the panel, the quick editor), i18n-fit-* the wizard's own screens. Picked before
// anything is built, so every widget is created in it; a later switch: see the bottom.
for (const [code, ...dicts] of [["ru", EDITOR_RU, FIT_RU], ["de", EDITOR_DE, FIT_DE], ["fr", EDITOR_FR, FIT_FR]])
  for (const d of dicts) register(code, d);
initLang();

// ---------- the editor core + the session ----------
const core = await createEditorCore({
  extraState: {
    step: "start",              // start | compare | edit (manual adjustment, step 3.1)
    pairs: [],                  // [{ id, rawFile, targetFile, raw, target, warnings, blocked, targetError }]
    selectedPairId: null,
    versions: [],               // fit versions (draft, _r1, …) — created by the fitting stages
    selectedVersionId: null,
    fitted: null,               // the last fitted (fit/refit, not manual) profile: Revert to fit, the
                                // editor's marks and resets (decision #17)
    advice: null,               // computeAdvice() over the frame records (coverage-view.js)
    reportAggregate: null,      // the aggregate report over the pairs (spec §3)
    fitting: false,             // a fit runs in the fit Worker (progress in the status line)
    profileName: "",            // the NP3 name for the fit: 1–19 ASCII (the np3.serialize rule)
  },
  statusIds: ["start-status", "cmp-status"],
  hooks: {
    // the LUT is ready: the Compare screen re-requests its render side, the editor redraws
    onLutReady: () => {
      if (onHub() && compareView) { compareView.scheduleRender(); return true; }
      return false;
    },
    // the quick editor (decision #16): every edit redraws the Compare render side with the
    // manual control; the curve backdrop reads the compare frame
    // Space on Compare too (before-after.js): the neutral preview of the compare side
    onRender: () => {
      if (!onHub() || !compareView) return false;
      if (state.step === "edit") compareView.syncStrength();
      compareView.scheduleRender();
      return true;
    },
    hasFrame: () => state.step === "edit" && compareFramePair != null,
    onLoaderUpdate: (st) => pairLoaderUpdate(st),
  },
});
const { state, setStatus, renderer, loader, panel, hist, curveEditor, blendingView, gradingView,
        beforeAfter, transfer, renderCurrent, getBaseline, setBaseline, applyEditorFrame } = core;

// Compare is the hub (decision #11); the quick editor ("edit", decision #16) is Compare with the
// parameter panel in place of the report — the strip, the viewer and the pairs stay.
function onHub() { return state.step === "compare" || state.step === "edit"; }

// ---------- the Comparison screen (stage 4, spec/ui.md step 2) ----------
// The render side: the developed frame through the renderer (neutral + profile LUT + detail),
// then the warpToView() geometry (as a cached viewRemap map) applies the pair's fitted transform chain (the same parameters
// pair-prepare computed, devignette included — the prepared x is devignetted, the renderer's
// frame is not). It covers the same image-space rectangle as the H3×W3 report grid (0..W, 0..H
// of the working size) but sampled at up to the developed frame's own resolution (≤ 2048 px
// long) instead of W/3 — the report overlays land on the same pixels, the render side is no
// longer a 256-px thumbnail (the ui-plan.md §6 risk "Preview/report geometry", compare-view.js).
// Generation-checked: a result for a superseded request resolves null and never applies; while
// its LUT builds, the previous good frame stays on the screen.
let compareFramePair = null;    // which pair the renderer frame belongs to
let compareFramePrep = null;    // …and which preparation (its edit gain)
const compareMaps = new WeakMap();   // preparation -> its viewRemap (the compare geometry)

// The compare frame: the pair's linear RAW frame times the preparation's edit gain — the same
// x * gain the fit and the report develop (the target's XMP exposure/WB edits compensated),
// so the screen compares what the error map measures. Without it a target edited by -0.9 EV
// showed a render ~0.9 EV brighter than the target. The editor keeps the ungained frame.
function gainedFrame(pair) {
  const img = pair.raw.image, g = pair.prepared?.gain;
  if (!g || (g[0] === 1 && g[1] === 1 && g[2] === 1)) return img;
  const rgb = new Float32Array(img.rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = img.rgb[i] * g[0]; rgb[i + 1] = img.rgb[i + 1] * g[1]; rgb[i + 2] = img.rgb[i + 2] * g[2];
  }
  return { ...img, rgb };
}

// A small LRU of finished render sides: (pair preparation, version, strength) fully determine
// the image (versions are immutable), so going back to a pair or a strength already seen
// skips the GPU develop + readback (most of a pair switch on a slow GPU).
const compareRenders = new Map();
const COMPARE_RENDERS_MAX = 6;

async function renderCompareSide(pair, version, strength, gen) {
  if (!compareUsable(pair)) return null;
  // the quick editor renders the live manual control: no memo (it changes on every edit)
  if (state.step === "edit" && !state.showNeutral) return renderCompareSideUncached(pair, version, strength, gen);
  // Space held (before-after.js): the Nikon neutral without the profile — one per preparation
  const memoKey = state.showNeutral ? `${objId(pair.prepared)}|neutral` : compareRenderKey(pair, version, strength);
  const memo = compareRenders.get(memoKey);
  if (memo) {
    compareRenders.delete(memoKey); compareRenders.set(memoKey, memo);   // most recent last
    return memo;
  }
  const side = await renderCompareSideUncached(pair, version, strength, gen);
  if (side) {
    compareRenders.set(memoKey, side);
    while (compareRenders.size > COMPARE_RENDERS_MAX) compareRenders.delete(compareRenders.keys().next().value);
  }
  return side;
}

const compareObjIds = new WeakMap();   // object identity -> a number (preparations, versions)
let compareObjSeq = 0;
const objId = (o) => {
  let id = compareObjIds.get(o);
  if (!id) { id = ++compareObjSeq; compareObjIds.set(o, id); }
  return id;
};
function compareRenderKey(pair, version, strength) {
  return `${objId(pair.prepared)}|${objId(version)}|${strength}`;
}

async function renderCompareSideUncached(pair, version, strength, gen) {
  if (compareFramePair !== pair || compareFramePrep !== pair.prepared || !renderer.frame) {
    core.setFrameImage(gainedFrame(pair));   // one develop per pair — strength/version changes reuse it
    compareFramePair = pair;
    compareFramePrep = pair.prepared;
  }
  // the neutral preview (Space held): the developed neutral, no LUT, strength or detail — as the
  // profile editor's before view (renderer.neutralToScreen)
  if (state.showNeutral) return remapCompareSide(pair, renderer.neutralRGBA());
  // the quick editor: the manual control, the editor's LUT size (17 while a slider moves,
  // 33 after the release); otherwise the version at the final 33
  const editing = state.step === "edit";
  const ctl = scaled(editing ? state.control : version.control, strength);
  renderer.setProfile(ctl);
  if (!editing) renderer.lutN = 33;       // the final LUT for the comparison
  const n = renderer.lutN;
  const key = renderer.lutCacheKey(n);
  if (!renderer.hasLut(key) && !core.lutDead) {
    core.requestLut(ctl, n);              // async: the ready path re-requests the render side
    return null;
  }
  return remapCompareSide(pair, renderer.render({ toScreen: false }));
}

// RGBA readback of the decoded frame -> RGB -> the compare geometry
function remapCompareSide(pair, rgba) {
  const img = pair.raw.image;
  const rgb = new Float32Array(img.w * img.h * 3);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgb[i] = rgba[j]; rgb[i + 1] = rgba[j + 1]; rgb[i + 2] = rgba[j + 2];
  }
  return applyRemap({ data: rgb, w: img.w, h: img.h }, compareMap(pair));
}

// the warpToView geometry as one cached inverse map (built once per preparation; a pair
// switch or a strength/version change is a ~30 ms gather instead of ~1 s of resampling)
function compareMap(pair) {
  const img = pair.raw.image;
  const unrotate = (4 - (DECODER_TURNS[pair.raw.info.orientation] ?? 0)) % 4;
  let map = compareMaps.get(pair.prepared);
  if (!map || map.fw !== img.w || map.fh !== img.h || map.unrotate !== unrotate) {
    map = viewRemap(pair.prepared, img.w, img.h, unrotate);
    map.unrotate = unrotate;
    compareMaps.set(pair.prepared, map);
  }
  return map;
}

// The detail fit's input for a pair (lib/detail-fit.js, spec/ui.md decision #19): the gained
// linear frame on the compare grid (NaN outside the source; the worker develops it and renders
// the fitted profile with its detail, as the Renderer draws Compare) and the target's Y' box-
// resized to the same grid. scale — full-frame px per grid pixel (the detail model's radii).
function detailInput(pair, meta) {
  const img = gainedFrame(pair);
  const map = compareMap(pair);
  const lin = applyRemap({ data: img.rgb, w: img.w, h: img.h }, map).data;
  for (let i = 0; i < map.sx.length; i++)
    if (map.sx[i] !== map.sx[i]) lin[3 * i] = lin[3 * i + 1] = lin[3 * i + 2] = NaN;
  const tg = pair.target;
  const tr = resizeF(tg.rgb, map.w, map.h, tg.width, tg.height, "box", 3).data;
  const [yr, yg, yb] = meta.YW;
  const ty = new Float32Array(map.w * map.h);
  for (let i = 0, p = 0; i < ty.length; i++, p += 3) ty[i] = yr * tr[p] + yg * tr[p + 1] + yb * tr[p + 2];
  // frame px per grid px along the middle row (crops and the alignment scale included)
  const r = Math.floor(map.h / 2) * map.w;
  let a = -1, b = -1;
  for (let x = 0; x < map.w; x++) if (map.sx[r + x] === map.sx[r + x]) { if (a < 0) a = x; b = x; }
  const step = b > a ? Math.hypot(map.sx[r + b] - map.sx[r + a], map.sy[r + b] - map.sy[r + a]) / (b - a) : 1;
  const scale = meta.SENSOR_LONG / Math.max(img.w, img.h) * Math.max(step, 1e-6);
  return { name: String(pair.id), lin, ty, w: map.w, h: map.h, scale };
}

// ---------- the zoom: ROI rendering (spec/ui-zoom-plan.md Z3, decisions D1-D8) ----------
// Beyond the fitted view the Compare screen asks for the visible region of the RAW at the sensor's own
// resolution: the raw worker holds the selected pair's mosaic (hold), develops a rectangle of it (roi:
// half-sensor "level 2" or the full-sensor PPG demosaic "level 1"), we rotate it into the decoded
// orientation, multiply the pair's edit gain, render it through the Renderer's separate region textures
// (renderRegion: neutral -> the profile LUT -> detail at the region's own scale) and gather it onto the
// working-space grid with a window of the compare geometry (viewRemap { k, window }, applyRemap).
// Geometry (pure, tested in test-node-zoom-plan.mjs): lib/zoom-plan.js. The decoder jobs go through
// rawQueue, after any RAW decode in flight (D4); a superseded request skips its turn. When raw.wasm has
// no zoom exports (zoom_unsupported) or the Renderer has no renderRegion, render() resolves null and the
// Compare screen keeps the stretched compare render.
let zoomSupported = null;               // null: unknown, false: raw.wasm lacks hold/roi (rebuild web/raw.wasm)
let zoomBusy = 0;                       // zoom jobs queued or running (a hold, a roi, a release)
const zoomState = { holdPair: null, holdRaw: null, held: null, epoch: 0, latestGen: 0, everHeld: false, memo: null };
const zoomFailed = new WeakSet();       // RAW states whose hold failed (a corrupt file: not retried)
const zoomGeoms = new WeakMap();        // preparation -> { geom, spw, ... } (the readout factor)
const tick = () => new Promise((r) => setTimeout(r, 0));    // let the viewer paint its loader between the heavy steps

// The decoded frame's geometry and sensor px per working px (the zoom readout, D1) for a pair.
function zoomGeometry(pair) {
  const img = pair?.raw?.image, info = pair?.raw?.info;
  if (!pair?.prepared || !img || !info) return null;
  let g = zoomGeoms.get(pair.prepared);
  if (g && g.w === img.w && g.h === img.h && g.k === info.k && g.orientation === info.orientation) return g;
  const geom = frameGeometry({ w: img.w, h: img.h, k: info.k ?? 1, orientation: info.orientation });
  g = { w: img.w, h: img.h, k: info.k, orientation: info.orientation, geom,
        spw: sensorPerWorking(compareMap(pair), geom, pair.prepared.size.w) };
  zoomGeoms.set(pair.prepared, g);
  return g;
}

// Level 1 (full sensor) needs big textures and memory (D11): MAX_TEXTURE_SIZE >= 4096, no known low-memory
// device (deviceMemory < 4 GB) — below that the zoom stays at half sensor.
function zoomLevel1Ok() {
  const gl = renderer.gl;
  const tex = gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) ?? 0;
  const mem = navigator.deviceMemory;
  return tex >= 4096 && !(typeof mem === "number" && mem < 4);
}
const zoomMaxTex = () => { const gl = renderer.gl; return gl?.getParameter?.(gl.MAX_TEXTURE_SIZE) ?? 0; };

// A decoder job after everything queued on rawQueue (RAW decodes, earlier zoom jobs); it never breaks the chain.
function zoomJob(fn) {
  zoomBusy++;
  const run = rawQueue.then(fn);
  rawQueue = run.then(() => {}, () => {});
  return run.finally(() => { zoomBusy--; });
}

// Holds the pair's mosaic in the worker (once per pair; a new hold replaces the previous one there).
async function zoomEnsureHold(pair, epoch) {
  if (zoomSupported === false || zoomFailed.has(pair.raw)) return false;
  if (zoomState.holdPair === pair && zoomState.holdRaw === pair.raw) return true;
  zoomState.holdPair = null; zoomState.holdRaw = null; zoomState.held = null;
  if (!pair.rawFile) return false;
  const bytes = new Uint8Array(await pair.rawFile.arrayBuffer());
  zoomState.everHeld = true;
  try {
    const r = await loader.zoomCall({ type: "hold", bytes }, [bytes.buffer]);
    if (!Array.isArray(r.info?.held)) {
      // an older raw-worker.js (e.g. from the browser cache) answers a hold as a develop: no zoom
      console.warn("zoom: the RAW worker does not support hold (stale raw-worker.js / raw.wasm?)", r.info);
      zoomSupported = false;
      return false;
    }
    if (epoch !== zoomState.epoch) return false;       // released meanwhile: its release job runs next
    zoomState.holdPair = pair; zoomState.holdRaw = pair.raw; zoomState.held = r.info.held;
    return true;
  } catch (err) {
    console.warn(`zoom: hold failed (${err.code}: ${err.detail ?? err.message})`);
    if (err.code === "zoom_unsupported") zoomSupported = false;
    else zoomFailed.add(pair.raw);
    return false;
  }
}

// Drops the hold, the region textures and the memo: a pair switch, a removal, leaving Compare (D11).
function zoomRelease() {
  zoomState.epoch++;
  zoomState.memo = null;
  zoomState.holdPair = null; zoomState.holdRaw = null; zoomState.held = null;
  if (typeof renderer.disposeRegion === "function") renderer.disposeRegion();
  if (zoomState.everHeld && zoomSupported !== false) {
    zoomState.everHeld = false;
    zoomJob(() => loader.zoomCall({ type: "release" })).catch(() => {});
  }
}
// Zoomed back out: the region textures go (hundreds of MB at 5 MP), the hold stays (a re-hold costs a decode).
function zoomTrim() {
  zoomState.memo = null;
  if (typeof renderer.disposeRegion === "function") renderer.disposeRegion();
}

// The ROI render for the visible working-space rectangle viewRect at `level` (1 | 2; 1 degrades to 2 when
// the region is too big). Resolves { rgba (Uint8ClampedArray, w*h*4, sRGB-encoded as the compare render),
// w, h, rect (the working-space rectangle it covers), level, wanted } or null (superseded, not supported,
// the LUT is still building - the ready path re-requests -, or nothing of the source is visible).
// gen: the caller's request generation; a newer call makes this one stale.
async function renderZoomSide(pair, version, strength, viewRect, level, gen) {
  if (!compareUsable(pair) || zoomSupported === false || typeof renderer.renderRegion !== "function") return null;
  zoomState.latestGen = Math.max(zoomState.latestGen, gen);
  const epoch = zoomState.epoch;
  const stale = () => gen !== zoomState.latestGen || epoch !== zoomState.epoch || !inSession(pair);
  const editing = state.step === "edit";
  const neutral = state.showNeutral;       // Space held: the region's neutral (renderRegion neutralOnly)
  const ctl = scaled(editing ? state.control : version.control, strength);
  const rectKey = (r) => [r.x, r.y, r.w, r.h].map((v) => v.toFixed(2)).join(",");
  // a small memo (not in the quick editor: the control changes on every edit)
  const memoKey = neutral ? `${objId(pair.prepared)}|neutral|${level}|${rectKey(viewRect)}`
    : editing ? null : `${compareRenderKey(pair, version, strength)}|${level}|${rectKey(viewRect)}`;
  if (memoKey && zoomState.memo?.key === memoKey) return zoomState.memo.result;
  return zoomJob(async () => {
    if (stale()) return null;
    const g = zoomGeometry(pair);
    if (!g) return null;
    // the profile and its LUT, as the compare render (the LUT builds in a Worker; the ready path re-requests)
    renderer.setProfile(ctl);
    if (!editing) renderer.lutN = 33;
    const n = renderer.lutN;
    if (!neutral && !renderer.hasLut(renderer.lutCacheKey(n)) && !core.lutDead) { core.requestLut(ctl, n); return null; }
    if (!(await zoomEnsureHold(pair, epoch)) || stale()) return null;
    await tick();
    if (stale()) return null;
    // the main compare frame of this pair on the renderer: Clarity's large blurs come from it (lowRes)
    const mainOk = () => compareFramePair === pair && compareFramePrep === pair.prepared && !!renderer.frame
      && renderer.frame.w === pair.raw.image.w && renderer.frame.h === pair.raw.image.h;
    const lowRes = mainOk();
    let plan = null;
    for (const lv of level === 1 ? [1, 2] : [2]) {
      const r = planRegion({ prepared: pair.prepared, geom: g.geom, level: lv, rect: viewRect, spw: g.spw,
                             lowRes, hold: zoomState.held, maxTex: zoomMaxTex() });
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
      if (err.code === "zoom_unsupported") zoomSupported = false;
      else if (err.code === "no_hold") { zoomState.holdPair = null; zoomState.holdRaw = null; }
      return null;
    }
    if (stale() || roi.w !== plan.roi.w || roi.h !== plan.roi.h) return null;
    const gain = pair.prepared.gain;
    const hasGain = gain && !(gain[0] === 1 && gain[1] === 1 && gain[2] === 1);
    const rgb = rotateRegion(roi.rgb, plan.roi, plan.region, plan.turns, plan.ufw, plan.ufh, hasGain ? gain : null);
    await tick();
    if (stale() || (plan.lowRes && !mainOk())) return null;
    renderer.setProfile(ctl);                // the compare render may have run in between
    if (!editing) renderer.lutN = 33;
    const rgba = renderer.renderRegion({ rgb, w: plan.region.w, h: plan.region.h, scale: plan.scale,
                                         lowRes: plan.lowRes, neutralOnly: neutral });
    if (!rgba) {                             // the LUT of this size is not uploaded yet
      const nn = renderer.lutN;
      if (!renderer.hasLut(renderer.lutCacheKey(nn)) && !core.lutDead) core.requestLut(ctl, nn);
      return null;
    }
    const m = plan.region.w * plan.region.h;
    const frame = new Float32Array(m * 3);
    for (let i = 0, j = 0; i < frame.length; i += 3, j += 4) { frame[i] = rgba[j]; frame[i + 1] = rgba[j + 1]; frame[i + 2] = rgba[j + 2]; }
    await tick();
    if (stale()) return null;
    const out = applyRemap({ data: frame, w: plan.region.w, h: plan.region.h }, plan.map);
    const u8 = new Uint8ClampedArray(out.w * out.h * 4);
    for (let i = 0, j = 0, q = 0; i < out.w * out.h; i++, j += 3, q += 4) {
      u8[q] = Math.round(255 * out.data[j]); u8[q + 1] = Math.round(255 * out.data[j + 1]);
      u8[q + 2] = Math.round(255 * out.data[j + 2]); u8[q + 3] = 255;
    }
    const result = { rgba: u8, w: out.w, h: out.h, rect: plan.rect, level: plan.level, wanted: level };
    if (memoKey) zoomState.memo = { key: memoKey, result };
    return result;
  });
}

// What the Compare view needs of the zoom: the readout factor, the level-1 guard, the ROI render, the releases.
const zoomApi = {
  geometry: zoomGeometry, level1Ok: zoomLevel1Ok, render: renderZoomSide,
  release: zoomRelease, trim: zoomTrim,
  get supported() { return zoomSupported !== false && typeof renderer.renderRegion === "function"; },
  get busy() { return zoomBusy > 0; },
};

const compareView = createCompare({ state,
  renderSide: renderCompareSide,
  zoom: zoomApi,
  onPairSelected: () => reportView.refresh(),   // the report follows the pair (stage 5B)
  onStrength: (v) => {
    state.strength = v;                   // the session strength — kept across the steps
    panel.refresh();                      // the editor slider shows the same value
    compareView.scheduleRender();         // re-renders here…
    requestReport();                      // …and the report follows the strength (spec/ui.md step 2)
  },
  onManual: () => {
    const p = state.pairs.find((q) => q.id === state.selectedPairId);
    if (p) enterEditor(p);                // the quick editor on Compare (decision #16)
  },
  onShare: () => transfer.shareNow(),     // Copy link moved from step 3.1 to Compare
  // the pair strip and the refit (decision #11)
  onAddRaws: (files) => { for (const f of files) addRawFile(f); },
  onAddTarget: (pair, file) => addTargetFile(pair, file),
  onRemovePair: (p) => removePair(p),
  onRefit: () => confirmRefit(),
  onRevert: () => confirmRevert(),
  refitRestoresFit: () => refitRestoresFit(),
  onCancelRefit: () => cancelFit(t("Refit cancelled — the session is unchanged")),
  // Download NP3 right from Compare: the current profile at the current strength (the same
  // export as the editor's, transfer.exportNow)
  onDownload: () => {
    const name = `${state.control.name}.NP3`;
    transfer.exportNow();
    // what to do with the file (UX review, decision #15; the card layout of spec/np3-format.md)
    if (state.status === t("Exported: {name}", { name })) {
      setStatus(t("Downloaded {name}. Put it into NIKON/CUSTOMPC on the memory card, then on the camera: Manage Picture Control → Load/save → Copy to camera.", { name }));
    }
  },
  setStatus: (text, kind) => setStatus(text, kind),
});

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
// Stage 9 (decision #7): RAW first — the JPEG is added on its card; "Remove from fit" on
// every card; no include checkbox and no editor entry from Start (the manual editor is
// reached from Compare only).
const start = createStart({ state, setStatus,
  onAddRaws: (files) => { for (const f of files) addRawFile(f); },
  onAddTarget: (pair, file) => addTargetFile(pair, file),
  onRemovePair: (p) => removePair(p),
  onFit: () => runFitPreparation(),
  onCancelFit: () => { if (fitPending) cancelFit(t("Fit cancelled — press Fit to run it again")); },
});

function refreshPairsUI() {
  start.refresh();
  if (onHub()) compareView.refreshPairs();   // the strip, the coverage, Refit
}

// ---------- pair preparation (stage 2, spec/web-schemas.md §2) ----------
// The pure port runs in a Worker (lib/pair-worker.js): the main thread stays responsive
// during the alignment search. Generations: a re-dropped file bumps the pair's prepGen —
// a result with an older generation is stale and discarded (the loader.js rule). The target
// goes to the Worker pre-quantized to uint8 (the pipeline's target path is 8-bit; the
// quantization of decodeTarget's u8/255 floats is exact) — three times less to transfer.
const DECODER_TURNS = { 3: 2, 6: 3, 8: 1 };       // render.TURNS — the decoder's EXIF rotation
// Decision #17: a pool of up to PREP_SLOTS pair Workers (session.prepSlots: more than one only on
// a desktop known to have >= 8 GB); every Worker runs one preparation at a time, a request
// waits for a free one. Each pair keeps its own generation, so parallel results never mix.
const PREP_SLOTS = prepSlots(navigator, location.search);
const pairSlots = [];            // [{ w: Worker, busy }] — created on demand, at most PREP_SLOTS
const slotWaiters = [];          // resolvers of requests waiting for a free Worker
let pairSeq = 0;
const pairPending = new Map();   // task id -> { pair, resolve, onProgress, slot }

function onPairMessage(e) {
  const m = e.data;
  const p = pairPending.get(m.id);
  if (!p) return;
  if (m.type === "progress") { p.onProgress?.(m.stage); return; }
  pairPending.delete(m.id);
  releasePairSlot(p.slot);
  const stale = m.generation && m.generation.pair !== p.pair.prepGen;
  if (m.type === "ready" && !stale) p.resolve({ prepared: m.prepared });
  else if (m.type === "error" && !stale) p.resolve({ error: { code: m.code, detail: m.detail } });
  else p.resolve(null);          // stale: nothing is applied
}
function spawnPairSlot() {
  const s = { w: new Worker("lib/pair-worker.js", { type: "module" }), busy: false };
  s.w.onmessage = onPairMessage;
  pairSlots.push(s);
  return s;
}
spawnPairSlot();                 // the first Worker up front, as before; the others on demand (bounded)
function acquirePairSlot() {
  let s = pairSlots.find((x) => !x.busy);
  if (!s && pairSlots.length < PREP_SLOTS) s = spawnPairSlot();
  if (s) { s.busy = true; return Promise.resolve(s); }
  return new Promise((resolve) => slotWaiters.push(resolve));
}
function releasePairSlot(s) {
  const next = slotWaiters.shift();
  if (next) next(s);               // handed over busy
  else s.busy = false;
}

async function prepareInWorker(pair, payload, transfer, onProgress) {
  const slot = await acquirePairSlot();
  // superseded (a changed file, a removed pair) while it waited for a Worker: nothing to run
  if (payload.generation.pair !== pair.prepGen || !inSession(pair)) { releasePairSlot(slot); return null; }
  const id = ++pairSeq;
  return new Promise((resolve) => {
    pairPending.set(id, { pair, resolve, onProgress, slot });
    slot.w.postMessage({ type: "prepare", id, ...payload }, transfer);
  });
}

function cancelPreparation(pair) {
  for (const [id, p] of pairPending) {
    if (p.pair !== pair) continue;
    p.slot.w.postMessage({ type: "cancel", id });   // a cancelled task posts nothing back
    pairPending.delete(id);
    releasePairSlot(p.slot);
    p.resolve(null);
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
  pair.frame = null;                   // …and so did the advice frame record (stage 7)
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
    fetch("model/detail.json").then((r) => r.json()),
    fetch("model/detail.bin").then((r) => r.arrayBuffer()),
  ]);
  return fitModelBytesPromise;
}

fitWorker.onmessage = (e) => {
  const m = e.data;
  if (!fitPending || m.id !== fitPending.id) return;    // stale: nothing is applied
  if (m.type === "progress" && m.stage === "detail") {
    // the detail fit after the color fit (decision #19): per pair, the bar stays full
    setStatus(t("Fitting detail: frame {i} of {n}", { i: Math.min(m.done + 1, m.total), n: m.total }));
    start.setFitProgress(1);
    if (fitPending.kind === "refit") {
      const rb = $("cmp-refit");
      if (rb) rb.dataset.sub = t("Detail {i}/{n}", { i: Math.min(m.done + 1, m.total), n: m.total });
    }
    return;
  }
  if (m.type === "progress") {
    // no LM cost in the UI (UX review, decision #15): the iteration and a progress bar
    setStatus(fitPending.kind === "refit"
      ? t("Refitting: iteration {it} of up to {total}", { it: m.iteration, total: m.total })
      : t("Fitting: iteration {it} of up to {total}", { it: m.iteration, total: m.total }));
    start.setFitProgress(m.iteration / m.total);
    if (fitPending.kind === "refit") {
      const rb = $("cmp-refit");
      if (rb) rb.dataset.sub = t("Refit {it}/{total}", { it: m.iteration, total: m.total });
    }
    return;
  }
  const task = fitPending;
  start.setFitProgress(null);
  fitPending = null;
  state.fitting = false;
  const refit = task.kind === "refit";
  if (m.type === "ready" && refit) {
    // Decision #12: there is one current profile — the refit replaces it (the same name, a new
    // id so the report/render caches never mix the two); the strength is kept.
    const parent = state.versions.find((v) => v.id === task.parentId) ?? state.versions[0];
    const r = makeRefitVersion(state.versions, parent, m.result);
    const v = { ...r, name: parent.name, control: { ...r.control, name: parent.name } };
    adoptVersion(v, { show: false });
    setStatus(t("Refit finished: {name} in {sec} s", { name: v.name, sec: (m.ms / 1000).toFixed(1) }));
    enterCompare();              // the refit stays on Compare (decision #11)
  } else if (m.type === "ready") {
    // The current profile (decision #12: no version history); the strength is kept.
    // the NP3 name is the field as typed (decision #15), not controlOf's "NPF-" + upper[-15:]
    const name = task.baseName ?? m.result.control.name;
    const result = { ...m.result, control: { ...m.result.control, name } };
    state.versions = [draftVersion(result)];
    state.selectedVersionId = "draft";
    state.fitted = state.versions[0];
    // the editor control follows the new profile at once: Download NP3 on Compare writes
    // state.control, which stayed the neutral NPF-MANUAL until the manual step was opened
    setBaseline(state.versions[0]);
    setStatus("");               // no "Fit finished" line (2026-11-24): the Compare screen itself shows the result
    enterCompare();              // stage 4: a successful fit goes to step 2 (spec/ui.md scenario)
  } else if (m.type === "error") {
    // A failure keeps the previous session state: no partial versions.
    setStatus(refit ? t("Refit failed: {error}", { error: m.detail })
                    : t("Fit failed: {error}", { error: m.detail }));
  } else {
    setStatus(refit ? t("Refit cancelled — the session is unchanged")
                    : t("Fit cancelled — press Fit to run it again"));
  }
  refreshPairsUI();
};

// Makes `v` the current profile (decision #12: one profile, no history): the editor's
// baseline follows it (stage 6), the report re-runs and Compare re-renders. Used by the refit;
// also the tests' entry point for "the profile changed".
function adoptVersion(v, { show = true } = {}) {
  state.versions = [v];
  state.selectedVersionId = v.id;
  if (!v.manual) state.fitted = v;     // a manual version keeps the fit it was made from
  setBaseline(v);
  if (!show) return;
  requestReport();
  if (onHub()) compareView.refresh();
}

// Cancels the running fit or refit: nothing it computed is applied (a refit leaves every
// version and the selection as they were). `msg` — the status text (default: inputs changed).
function cancelFit(msg = null) {
  // a plain Fit is cancellable once it is in the Worker (unchanged stage-3 rule); a refit
  // also while its pairs prepare / the models are fetched (state.fitting is set up front)
  if (!fitPending && !(state.fitting && fitKind === "refit")) return;
  if (fitPending) fitWorker.postMessage({ type: "cancel", id: fitPending.id });
  const refit = fitPending?.kind === "refit" || fitKind === "refit";
  fitPending = null;
  state.fitting = false;
  ++fitGen;                          // a refit still preparing/fetching sees this and stops
  setStatus(msg ?? (refit ? t("Refit cancelled — the inputs changed")
                          : t("Fit cancelled — the inputs changed")));
  refreshPairsUI();
}

let fitKind = "fit";                 // the kind of the running fit ("fit" | "refit")
async function startFit(pairs, { kind = "fit", parentId = null, baseName = state.profileName } = {}) {
  state.fitting = true;
  fitKind = kind;
  refreshPairsUI();
  setStatus(kind === "refit" ? t("Refitting…") : t("Fitting…"));
  try {
    const [devMeta, devLut, profileMeta, profileBin, detailMeta, detailBin] = await fitModelBytes();
    if (!state.fitting) return false;      // superseded while the models were fetched
    // the detail step is optional: a pair whose input cannot be built is left out of it
    const detailPairs = [];
    for (const p of pairs) {
      try { detailPairs.push(detailInput(p, detailMeta)); } catch (err) { void err; }
    }
    const payload = {
      type: "fit", id: ++fitSeq, generation: { session: 0, pair: 0, task: ++fitGen },
      seed: 0, iters: 30, baseName,         // decision #3: the zero init, the seed of the draft
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
      detail: { meta: detailMeta, bin: detailBin, pairs: detailPairs },   // the bin is cloned (cached)
    };
    const transfer = [];
    for (const q of payload.pairs) {
      transfer.push(q.x.buffer, q.y.buffer, q.gain.buffer,
                    q.masks.clipMask.buffer, q.masks.reportMask.buffer,
                    q.masks.validMask.buffer, q.masks.nearWhiteMask.buffer);
    }
    for (const q of detailPairs) transfer.push(q.lin.buffer, q.ty.buffer);
    if (!state.fitting) return true;       // cancelled while the payload was assembled
    fitPending = { id: payload.id, kind, parentId, baseName };
    if (kind === "fit") start.setFitProgress(0);
    fitWorker.postMessage(payload, transfer);
    return true;
  } catch (err) {
    state.fitting = false;
    refreshPairsUI();
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
  if (m.type === "frames" || m.frames) { framesLanded(m); return; }
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
  } else if (m.type === "error" && m.code === "cache_miss") {
    for (const n of m.pairs ?? []) reportWorkerPairs.delete(n);   // the next request resends
  }
  // an error keeps the previous reports; rendering is unaffected
};
reportWorker.onerror = () => { /* the report is optional: rendering is unaffected */ };

async function requestReport() {
  if (state.step === "edit") return;          // hidden while editing; Done / Cancel re-request it
  try {
    const version = state.versions.find((v) => v.id === state.selectedVersionId);
    const usable = state.pairs.filter(compareUsable);
    if (!version || !usable.length) return;
    // the report is always the current profile's (the quick editor hides it, decision #16;
    // the step-3.1 "<version>+manual" report with field deltas is gone with that screen)
    const control = version.control, versionId = version.id;
    const deltas = null, fittedRenderDE = null;
    const gen = ++reportGen;                  // supersede whatever is running/fetching
    const [devMeta, devLut, profileMeta, profileBin] = await fitModelBytes();
    if (gen !== reportGen) return;            // superseded while the models were fetched
    // the entries are built right before the post (no await in between): a pair is marked
    // as held by the worker exactly when its arrays are posted (stage 7 — the frame
    // requests share the cache, and the worker registers arrays in posting order)
    const pairs = [], transfer = [];
    for (const p of usable) {
      if (!compareUsable(p)) continue;        // removed/invalidated while the models were fetched
      pairs.push(reportEntry(p, transfer));
    }
    if (!pairs.length) return;
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

// A report-worker pair entry: the heavy arrays only until the worker holds this pair
// generation (the §4.1 cache); shared by the report and the stage-7 frame requests.
function reportEntry(p, transfer) {
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
  return entry;
}

// ---------- stage 7: the advice frame records ----------
// Route (the cheapest correct one): the report worker already develops and caches the
// neutral of every pair it holds (rec.fb = develop(dev, x*gain), Python's m.dev(raw["x"]*g)),
// so it builds the analyze.frame record there (advice.buildFrame) and returns only the small
// record — no second develop, no neutral array copied back. Pairs reach the worker through
// the same cache protocol as the reports (reportEntry). A record is keyed by the pair's
// preparation generation; a stale one is ignored.
let framesSeq = 0;
const framesPending = new Map();       // id -> true
function frameCandidate(p) {
  return isCompletePair(p) && p.prepared && p.prepared.x && !p.blocked && !p.fitBlocked
    && !p.prepError && !frameOf(p);
}
async function requestFrames() {
  const need = state.pairs.filter(frameCandidate);
  if (!need.length) return;
  try {
    const [devMeta, devLut, profileMeta, profileBin] = await fitModelBytes();
    const transfer = [];
    const pairs = need.filter(frameCandidate).map((p) => {
      const e = reportEntry(p, transfer);
      e.ncc = p.prepared.ncc;
      e.warnings = (p.warnings ?? []).map((w) => ({ ...w }));
      return e;
    });
    if (!pairs.length) return;
    const id = `f${++framesSeq}`;
    framesPending.set(id, pairs.map((e) => e.name));
    reportWorker.postMessage({ type: "frames", id, pairs, devMeta, devLut, profileMeta, profileBin },
                             transfer);
  } catch (err) { void err; /* the advice is optional */ }
}
let framesRetries = 0;
function framesLanded(m) {
  const names = framesPending.get(m.id);
  if (!names) return;
  framesPending.delete(m.id);
  if (m.type === "error") {
    // a cache miss (the worker lost or never got a pair's arrays): forget the marks and resend
    // once more; any other error leaves the advice without those frames
    for (const n of m.pairs ?? names) reportWorkerPairs.delete(n);
    if (m.code === "cache_miss" && framesRetries++ < 3) requestFrames();
  }
  if (m.type === "frames") {
    framesRetries = 0;
    for (const f of m.frames) {
      const p = state.pairs.find((q) => String(q.id) === f.name);
      if (p && (p.prepGen ?? 0) === f.generation) p.frame = { gen: f.generation, rec: f.rec };
    }
  }
  updateAdvice();
}
function updateAdvice() {
  state.advice = computeAdvice(state);
  if (onHub()) compareView.refreshPairs();
  refreshPairsUI();
}

async function prepareOne(pair) {
  pair.preparing = true;
  pair.prepStage = "queued";
  pair.prepStageAt = performance.now();
  pair.prepError = null;
  refreshPairsUI();
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
      if (pair.prepGen === gen) { pair.prepStage = stage; pair.prepStageAt = performance.now(); refreshPairsUI(); }
    });
    if (pair.prepGen !== gen) return false;    // superseded mid-flight: nothing is applied
    if (res && res.error) pair.prepError = res.error.detail;
    else if (res) { pair.prepared = res.prepared; pair.prepStage = "done"; }
  } catch (err) {
    pair.prepError = String(err.message || err);
  } finally {
    if (pair.prepGen === gen) pair.preparing = false;
    refreshPairsUI();
  }
  return true;
}

// Fit (stages 2–3): prepare every pair, then send the prepared pairs to the fit Worker
// (stage 3). Since stage 9 the pairs are prepared as soon as their JPEG decodes (the same
// chain as Compare uses), so Fit normally finds them ready; the loop below still prepares
// whatever is left. A preparation superseded mid-run (the user changed a file) aborts the
// run — the inputs no longer match what the remaining pairs would prepare against.
async function runFitPreparation() {
  if (state.fitting) return;
  await autoPrepare();                        // the auto-preparation (parallel) finishes first
  const pairs = state.pairs.filter((p) => isCompletePair(p));
  if (!pairs.length) {
    setStatus(t("Assemble at least one RAW + JPEG pair to fit"));
    return;
  }
  for (const p of pairs) {
    if (p.preparing) continue;
    if (p.prepared) continue;                  // already prepared for this input
    if (sizeBlocked(p)) { refreshPairsUI(); continue; }
    if (!(await prepareOne(p))) {
      setStatus(t("Preparation interrupted by a changed file — press Fit again"));
      return;
    }
  }
  // only the prepared, unblocked pairs are fitted — the exact ids go into the version
  const eligible = pairs.filter((p) => p.prepared && !p.prepared.blocked && !p.fitBlocked);
  if (!eligible.length) {
    setStatus(t("Nothing to fit: every pair is blocked"));
    return;
  }
  if (!(await startFit(eligible))) {
    setStatus(t("Fit interrupted by a changed file — press Fit again"));
  }
}

// ---------- auto-preparation, removal, refit (stages 7 and 9) ----------
// Every complete pair is prepared as soon as both files are decoded — on Start (stage 9: the
// card shows the alignment before Fit) and on Compare (the coverage needs the frame record
// before any refit) — with the same checks as Fit: the size pre-check, the alignment, NCC. Up to
// PREP_SLOTS pairs at once (decision #17); a pair is tried once per generation, so a superseded
// preparation waits for its re-dropped file instead of looping. autoPrepare() resolves when
// nothing is left to start and nothing runs; then the frames, the report and the advice follow.
let autoRunning = 0, autoAny = false, autoIdle = null, autoIdleResolve = null;
function sizeBlocked(p) {
  // the pre-fit check (match.MIN_TARGET): a small target is a preview inside a DNG
  if (Math.max(p.target.width, p.target.height) < MIN_TARGET) {
    p.fitBlocked = { code: "target_too_small", detail: `${p.target.width}×${p.target.height}` };
    return true;
  }
  return false;
}
function autoPump() {
  while (autoRunning < PREP_SLOTS) {
    const p = state.pairs.find((q) => isCompletePair(q) && !q.blocked && !q.prepared
      && !q.preparing && !q.prepError && !q.fitBlocked && q.prepTried !== (q.prepGen ?? 0));
    if (!p) break;
    if (sizeBlocked(p)) { refreshPairsUI(); continue; }
    p.prepTried = p.prepGen ?? 0;
    if (!autoIdle) autoIdle = new Promise((resolve) => { autoIdleResolve = resolve; });
    autoRunning++;
    autoAny = true;
    prepareOne(p).finally(() => {
      autoRunning--;
      autoPump();                               // the freed slot takes the next pair
      if (!autoRunning) autoSettle();
    });
  }
}
function autoTail() {
  const any = autoAny;
  autoAny = false;
  if (state.step !== "start") requestFrames();   // the advice records (Compare's coverage)
  if (any && state.versions.length) requestReport();   // renderDE of the new pairs (exclusion hints)
  updateAdvice();
}
function autoSettle() {
  autoTail();
  const resolve = autoIdleResolve;
  autoIdle = null;
  autoIdleResolve = null;
  resolve?.();
}
function autoPrepare() {
  autoPump();
  if (autoRunning) return autoIdle;
  autoTail();
  return Promise.resolve();
}

// "Remove from fit" (decision #7): the pair leaves the session for good — its files, decode,
// preparation, advice record and report/worker caches are released, its running decode or
// preparation is cancelled (a late result finds the pair gone and is dropped), and a running
// fit or refit is cancelled (it may include the pair). Versions are kept unchanged.
function removePair(p) {
  const i = state.pairs.indexOf(p);
  if (i < 0) return;
  const name = p.rawFile?.name ?? `#${p.id}`;
  let msg = t("Removed {name} from the fit", { name });
  if (state.fitting) {
    msg = fitKind === "refit" ? t("Refit cancelled — {name} was removed from the fit", { name })
                              : t("Fit cancelled — {name} was removed from the fit", { name });
    cancelFit(msg);
  }
  cancelPreparation(p);
  p.prepGen = (p.prepGen ?? 0) + 1;        // whatever is still in flight for it is stale
  if (zoomState.holdPair === p) zoomRelease();    // the held mosaic and the region textures go with the pair
  state.pairs.splice(i, 1);
  reportWorkerPairs.delete(String(p.id));
  p.prepared = null;                       // release the big arrays held by the pair
  p.raw = null;
  p.target = null;
  p.report = null;
  p.frame = null;
  if (state.selectedPairId === p.id) {
    const next = state.pairs[i] ?? state.pairs[i - 1] ?? null;
    state.selectedPairId = next ? next.id : null;
    compareFramePair = null;
  }
  state.reportAggregate = null;
  if (onHub()) compareView.refresh();      // the next pair on the canvas
  if (state.versions.length) requestReport();   // the aggregate over the remaining pairs
  setStatus(msg);
  refreshPairsUI();
  updateAdvice();
}

// Refit (spec/ui.md step 3.2, decision #3): a new deterministic fit from the zero init over
// exactly refitPairIds(session) — the unprepared selected pairs are prepared first, a pair the
// preparation blocks drops out. The result is the next immutable version after the selected
// one; a cancelled or superseded refit leaves the session unchanged.
async function runRefit() {
  if (state.fitting || !state.versions.length) return;
  const parent = state.versions.find((v) => v.id === state.selectedVersionId) ?? state.versions[0];
  state.fitting = true;                       // locks the button while the pairs prepare
  fitKind = "refit";
  const gen = ++fitGen;
  setStatus(t("Refitting…"));
  refreshPairsUI();
  await autoPrepare();
  if (gen !== fitGen || !state.fitting) return;   // cancelled / superseded while preparing
  const ids = refitPairIds(state);
  const pairs = ids.map((id) => state.pairs.find((p) => p.id === id))
    .filter((p) => p && p.prepared && !p.prepared.blocked && !p.prepError && !p.fitBlocked);
  if (!pairs.length) {
    state.fitting = false;
    setStatus(t("Nothing to refit: select at least one usable pair"));
    refreshPairsUI();
    return;
  }
  await startFit(pairs, { kind: "refit", parentId: parent.id, baseName: parent.name });
}

// ---------- pair RAW decodes (the loader events tagged { kind: "pair" }) ----------
function pairLoaderUpdate(st) {
  if (st.tag?.kind !== "pair") return false;
  const p = st.tag.pair;
  if (st.type === "busy") {
    setStatus(t("unpacking {name}…", { name: st.name }));
  } else if (st.type === "error") {
    // A RAW that does not decode blocks its pair (spec/ui.md checks table); the other
    // pairs and the editor state stay untouched.
    const msg = rawErrorText(st.code);
    if (inSession(p) && p.rawFile && p.rawFile.name === st.name) {
      p.raw = "error";
      p.rawError = `${msg}${st.detail ? " — " + st.detail : ""}`;
      p.blocked = true;
      refreshPair(p);
    }
    setStatus(`${st.name}: ${msg}${st.detail ? " — " + st.detail : ""}`);
    refreshPairsUI();
  } else if (st.type === "ready") {
    if (inSession(p) && p.rawFile && p.rawFile.name === st.name && p.raw === "pending") {
      p.raw = { name: st.name, image: st.image, info: st.info, warn: st.warn };
      refreshPair(p);
      setStatus(isTargetReady(p) ? t("{name} decoded", { name: st.name })
                                 : t("{name} decoded — add its JPEG", { name: st.name }));
    }
    refreshPairsUI();
  }
  return true;
}

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
const inSession = (p) => state.pairs.includes(p);
function addRawFile(file) {
  const got = addRawPair(state.pairs, file);
  if (!got) {
    setStatus(t("{name} is already in the list — skipped", { name: file.name }));
    return rawQueue;
  }
  const pair = got.pair;
  if (state.selectedPairId == null) state.selectedPairId = pair.id;
  pair.raw = "pending";
  pair.rawError = null;
  pair.blocked = false;    // a re-drop retries the decode (addRawPair matches the same-name card)
  pair.targetError = null;
  invalidatePreparation(pair);
  start.setNameDefault(defaultProfileName(state.pairs[0].rawFile.name));
  refreshPairsUI();
  rawQueue = rawQueue.then(async () => {
    if (!inSession(pair) || pair.rawFile !== file) return;   // removed / re-dropped meanwhile
    const bytes = new Uint8Array(await file.arrayBuffer());
    try { pair.wbMult = wbMultipliers(bytes); } catch { pair.wbMult = null; }
    const image = await loader.open(bytes, { name: file.name, tag: { kind: "pair", pair } });
    if (image === null && pair.raw === "pending" && inSession(pair)) {
      // Superseded by a newer editor load before it started: the card stays pending for a
      // re-drop of the same RAW.
      setStatus(t("Decoding of {name} was interrupted — drop the file again", { name: file.name }));
    }
    if (!inSession(pair)) return;
    refreshPair(pair);
    refreshPairsUI();
    autoPrepare();
  });
  return rawQueue;
}

// The JPEG of one card (decision #7): only on a decoded RAW; add or replace. The card's
// previous target, preparation and advice are dropped at once; a rejected JPEG leaves the
// card without a target and the reason on the card.
async function addTargetFile(pair, file) {
  if (!inSession(pair) || !canAttachTarget(pair)) return;
  pair.targetFile = file;
  pair.target = "pending";
  pair.targetError = null;
  invalidatePreparation(pair);
  refreshPair(pair);
  refreshPairsUI();
  const reject = (msg) => {
    pair.target = null;
    pair.targetFile = null;
    pair.targetError = msg;
    setStatus(msg);
  };
  try {
    const target = await decodeTarget(file);
    if (!inSession(pair) || pair.targetFile !== file) return;   // removed / replaced meanwhile
    // The stage-1 dimension guard (web/lib/session.js): a target whose aspect ratio does not
    // match the RAW frame is rejected before the alignment.
    if (!dimsCompatible(pair.raw.image, target)) {
      reject(t("{name}: dimensions do not match the RAW frame — the target is skipped", { name: file.name }));
    } else {
      pair.target = target;
    }
  } catch {
    if (!inSession(pair) || pair.targetFile !== file) return;
    reject(t("{name}: could not be read as a JPEG target — the file is skipped", { name: file.name }));
  }
  refreshPair(pair);
  refreshPairsUI();
  autoPrepare();
}

// ---------- the quick editor on Compare (spec/ui.md decision #16) ----------
// "Manual adjustments" keeps Compare — the strip, the viewer with the target, pair switching —
// and puts the parameter panel in place of the report. The render side follows every edit
// (hooks.onRender above). Done makes the edits the current profile (a new immutable "manual"
// version with the same pairs; Download NP3 writes it); Cancel returns the control to the
// profile it started from. The report is hidden meanwhile and recomputes on the way out.
// state.step "edit" is this mode (the separate step-3.1 screen is gone).
function enterEditor(pair) {
  if (!state.versions.length || state.step === "edit") return;
  if (pair && compareUsable(pair)) state.selectedPairId = pair.id;
  if (!state.pairs.some((p) => p.id === state.selectedPairId && compareUsable(p))) return;
  if (state.fitting) cancelFit();      // a running refit would replace the profile under the edits
  const v = state.versions.find((x) => x.id === state.selectedVersionId) ?? state.versions[0];
  // decision #17: marks and resets compare against the fitted profile (decision #2), so a reset
  // of the whole profile is a way back to the fit; the edits start from the current profile
  // (a manual one included) and Cancel returns to it
  const fitted = state.fitted ?? v;
  setBaseline(fitted);
  editEntry = JSON.parse(JSON.stringify(v.control));
  if (fitted !== v) {
    Object.assign(state.control, JSON.parse(JSON.stringify(v.control)));
    panel.refresh();
    hist.clear();
    hist.push();
  }
  state.step = "edit";
  syncStep();
  compareView.refresh();               // the strip (Refit hidden), the render side with the control
}

let manualSeq = 0;                     // manual version ids: <parent>m<n>, unique in the session
let editEntry = null;                  // the control the quick editor was entered with (Cancel)
function exitEditor({ save }) {
  if (state.step !== "edit") return;
  const v = state.versions.find((x) => x.id === state.selectedVersionId) ?? state.versions[0];
  const entry = editEntry ?? v.control;
  editEntry = null;
  const dirty = isDirty(state.control, entry);
  const backToFit = save && dirty && v.manual && state.fitted && !isDirty(state.control, state.fitted.control);
  state.step = "compare";
  syncStep();
  if (backToFit) {
    // every field reset to the fit: the fitted version itself comes back (its caches, no
    // manual mark) rather than a manual copy equal to it
    adoptVersion(state.fitted, { show: false });
    setStatus(t("Back to the fitted profile {name}: the manual adjustments are discarded", { name: state.fitted.name }));
  } else if (save && dirty) {
    // the edits become the current profile: same pairs and fit metadata, a new id (the render
    // and report caches never mix the two), marked manual — a refit asks before replacing it
    const control = JSON.parse(JSON.stringify(state.control));
    adoptVersion({ ...v, id: `${v.id.replace(/m\d+$/, "")}m${++manualSeq}`, name: control.name,
                   control, parentId: v.id, kind: "manual", manual: true }, { show: false });
    setStatus(t("Manual adjustments saved to {name}", { name: control.name }));
  } else {
    // Cancel: back to the profile the editor started from; outside the editor the baseline is
    // the current profile again
    setBaseline(v);
    if (dirty) setStatus(t("Manual adjustments discarded"));
  }
  compareView.refresh();
  requestReport();
  reportView.refresh();
}
$("adj-done").addEventListener("click", () => exitEditor({ save: true }));
$("adj-cancel").addEventListener("click", () => exitEditor({ save: false }));

// ---------- the in-page confirmation (an alertdialog, never window.confirm) ----------
// Used before a refit replaces a profile with manual adjustments (decision #16).
const confirmBox = $("confirm-box");
let confirmGo = null;
function askConfirm(text, yesLabel, go) {
  $("confirm-text").textContent = text;
  $("confirm-yes").textContent = yesLabel;
  confirmGo = go;
  confirmBox.hidden = false;
  $("confirm-no").focus();
}
function confirmClose() { confirmGo = null; confirmBox.hidden = true; }
$("confirm-no").addEventListener("click", confirmClose);
$("confirm-yes").addEventListener("click", () => { const go = confirmGo; confirmClose(); go?.(); });
confirmBox.addEventListener("keydown", (e) => { if (e.key === "Escape") confirmClose(); });

// A refit starts from zero (decision #3): manual adjustments on the current profile are lost —
// ask first. A running refit is cancelled by the same button without asking.
function confirmRefit() {
  const v = state.versions.find((x) => x.id === state.selectedVersionId);
  if (state.fitting || !v?.manual) { runRefit(); return; }
  if (refitRestoresFit()) {
    // the refit is deterministic (decision #3): over the fit's own pairs it gives the fitted
    // profile again, so it is restored at once instead of recomputed (decision #17)
    askConfirm(t("The pairs have not changed, so a refit gives the fitted profile again — it is restored at once: the manual adjustments of {name} will be lost.",
                 { name: v.name }), t("Revert to fit"), () => revertToFit());
    return;
  }
  askConfirm(t("Refit starts from zero over the pairs: the manual adjustments of {name} will be lost.",
               { name: v.name }), t("Refit anyway"), () => runRefit());
}

// Over a manual profile with the fit's own pairs a refit equals the fitted profile.
function refitRestoresFit() {
  const v = state.versions.find((x) => x.id === state.selectedVersionId);
  const f = state.fitted;
  if (!v?.manual || !f) return false;
  const ids = refitPairIds(state).map(String), have = (f.pairIds ?? []).map(String);
  return ids.length === have.length && ids.every((id) => have.includes(id));
}

// "Revert to fit" (decision #17): the manual profile is dropped, the fitted one it was made
// from is the current profile again — at once, with its renders and report from the caches.
function revertToFit() {
  const v = state.versions.find((x) => x.id === state.selectedVersionId);
  const f = state.fitted;
  if (!v?.manual || !f || state.step === "edit" || state.fitting) return;
  adoptVersion(f);
  setStatus(t("Back to the fitted profile {name}: the manual adjustments are discarded", { name: f.name }));
  reportView.refresh();
}
function confirmRevert() {
  const v = state.versions.find((x) => x.id === state.selectedVersionId);
  if (!v?.manual || !state.fitted) return;
  askConfirm(t("Revert to the fitted profile: the manual adjustments of {name} will be lost.", { name: v.name }),
             t("Revert to fit"), () => revertToFit());
}

function showStart() {
  if (state.step === "edit") exitEditor({ save: false });
  state.step = "start";
  syncStep();
  refreshPairsUI();       // the assembled session is kept across the navigation
}

// The Comparison screen (spec/ui.md step 2, stage 4): requires a fitted version — from Fit
// (the ready handler above) or, later, a refit. Leaving it keeps the prepared pairs and the
// versions; the selected pair skips blocked ones (they cannot be compared, as they cannot fit).
function enterCompare() {
  if (state.step === "edit") exitEditor({ save: false });
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
  updateAdvice();                  // the coverage above Versions (decision #11)…
  autoPrepare();                   // …over prepared pairs (anything added meanwhile prepares)
  requestFrames();
  requestReport();                 // the report recomputes with the comparison (spec/ui.md step 2)
  reportView.refresh();            // the last good report shows while the new one computes
}

function syncStep() {
  document.body.classList.toggle("step-start", state.step === "start");
  document.body.classList.toggle("step-edit", state.step === "edit");
  document.body.classList.toggle("step-compare", state.step === "compare");
  if (state.step === "start") confirmClose();           // a pending question never outlives the hub
  if (!onHub()) zoomRelease();                          // leaving Compare: the held mosaic and region textures go
}

// ---------- files dropped on the page ----------
// The Start zone, the pair cards and the Compare strip handle their own drops (stopPropagation).
// A RAW dropped elsewhere on Start or Compare becomes a new pair; JPEGs belong to a card; there is no NP3
// import in the wizard (spec/ui-pages.md) — the profile editor page has it.
for (const ev2 of ["dragenter", "dragover", "dragleave"]) document.addEventListener(ev2, (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  for (const f of [...(e.dataTransfer?.files || [])]) routeFile(f);
});

function routeFile(f) {
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (ext === "nef" || ext === "dng") {
    if (state.step === "start" || onHub()) addRawFile(f);
    else setStatus(t("{name}: add RAW files on the Comparison screen", { name: f.name }), "error");
  } else if (ext === "jpg" || ext === "jpeg") {
    // RAW first (decision #7): a JPEG belongs to a card, not to the page
    setStatus(t("{name}: add the JPEG on its RAW's card", { name: f.name }));
  } else if (ext === "np3") {
    setStatus(t("{name}: NP3 profiles are opened in the profile editor, not in the fitting wizard", { name: f.name }));
  } else {
    setStatus(t("Unsupported file: {name} — drop a NEF or DNG, or a JPG onto its card", { name: f.name }));
  }
}

// a phone gets a non-blocking note: fitting is designed for a desktop (spec/ui-pages.md)
{
  const banner = $("phone-banner");
  const phone = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;
  if (banner && phone) {
    banner.hidden = false;
    $("phone-banner-close")?.addEventListener("click", () => { banner.hidden = true; });
  }
}

syncStep();
setStatus(t("Add RAW files to assemble pairs"));

// A language switch (a globe at the Start title or on the Compare panel) is applied in place: the data-i18n*
// texts re-translate (i18n.js), the screens built from state re-render, a plain status is
// re-translated; the session, the fit and the opened frames are untouched.
let shownLang = document.documentElement.lang;
function onLangChange(lang) {
  const s = reTranslate(state.status, shownLang);
  shownLang = lang;
  if (s !== state.status) {
    state.status = s;
    for (const id of ["status", "start-status", "cmp-status"]) if ($(id)) $(id).textContent = s;
  }
  start.refresh();
  if (onHub()) { compareView.refreshPairs(); compareView.draw(); }
  reportView.refresh();
}
// two globes: at the Start title and at the bottom of the Compare panel (#cmp-sidepanel)
if ($("lang-btn")) mountLangMenu($("lang-btn"), $("lang-menu"), onLangChange);
if ($("side-lang-btn")) mountLangMenu($("side-lang-btn"), $("side-lang-menu"), onLangChange);
// the hotkeys behind the (i) of the Compare panel
if ($("side-info-btn")) mountInfoPop($("side-info-btn"), $("cmp-hint"));

// The session lives in this tab's memory only (decisions #4/#12): closing or reloading the tab
// with pairs loaded asks first (UX review, decision #15). Browsers show their own text and
// only after a user gesture on the page.
window.addEventListener("beforeunload", (e) => {
  if (!state.pairs.length) return;
  e.preventDefault();
  e.returnValue = "";
});

// For the end-to-end tests and the following parts: the state and entry points.
window.__np3app = { state, panel, renderer, loader, renderCurrent, curveEditor, blendingView,
                    gradingView, transfer, beforeAfter, start, hist, compare: compareView,
                    report: reportView, getBaseline, setBaseline,
                    enterEditor, showStart, enterCompare, addRawFile, addTargetFile, routeFile,
                    runFitPreparation, prepareOne, autoPrepare,
                    runRefit, removePair, computeAdvice, adoptVersion, confirmRefit, exitEditor,
                    revertToFit, confirmRevert, prepSlots: PREP_SLOTS, zoom: zoomApi, zoomState };
