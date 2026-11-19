// The report worker (stage 5A, spec/web-schemas.md §4): a thin lifecycle wrapper around
// the pure web/lib/analyze.js engine. One report task at a time — a new task supersedes
// the running one; the cancel flag is observed between map chunks (the computation awaits
// a macro-task yield there, so the message queue is pumped and the flag is real, not just
// a main-thread discard). The main thread owns the generations; a stale result is
// discarded there (same rule as lib/fit-worker.js / lib/pair-worker.js).
//
// Per-pair session cache (spec §4.1): targetLab, group labels, bins, the developed neutral
// and the neutral-vs-target sums are built once per pair and reused across strength/version
// changes; the cache is invalidated only by a pair name/generation change. The caller sends
// the heavy x/y/mask/gain arrays only until the worker holds that generation.
//
// Messages in:
//   { type: "report", id, generation, versionId, control, strength, fittedRenderDE,
//     deltas,                                          — deltas: parameters.deltas (null at draft)
//     devMeta, devLut, profileMeta, profileBin,        — the CPU dev/profile models (first task)
//     pairs: [{ name, generation, files, w3, h3,
//               x?, y?, masks?: { reportMask }, gain? }] }
//                                                    — arrays present only on a cache miss
//   { type: "frames", id, devMeta, devLut, profileMeta, profileBin,
//     pairs: [{ name, generation, files, w3, h3, ncc, warnings, x?, y?, masks?, gain? }] }
//                                                    — stage 7: the analyze.frame records of
//                                                      the pairs (advice.buildFrame over the
//                                                      cached developed neutral `fb`); same
//                                                      cache protocol, never cancels a report
//   { type: "cancel", id }
// fittedRenderDE: a number (one reference for every pair) or { pairName: number } — the
// per-pair reference of the manual fittedDelta (stage 7; a missing name gives null).
// Messages out:
//   { type: "progress", id, pair, stage: "maps", done, total }   — between map chunks
//   { type: "ready", id, generation, versionId, strength, reports, aggregate, ms }
//                                                    — reports: the §4.3 DTOs per pair, the
//                                                      maps buffers transferred; aggregate:
//                                                      totalSums over the task's pairs + its
//                                                      binMean and table
//   { type: "frames", id, frames: [{ name, generation, rec }] }    — rec: the frame record
//   { type: "error", id, generation, code, detail }
// A cancelled/superseded task posts nothing at all.

import { srgbToLab } from "./color.js";
import { loadModel, paramsOf, Pixels } from "./profile.js";
import { loadDev, develop } from "./fit.js";
import { scaled } from "./strength.js";
import { buildFrame } from "./advice.js";
import { labelsOf, binsOf, regionSums, binMean, totalSums, summaryOf, tableOf, mapsOf,
       } from "./analyze.js";

// Node (level 1g) has no `self`: map the web Worker surface onto worker_threads (the
// onmessage event shape and postMessage(message, transfer) are the same).
const scope = typeof self !== "undefined" ? self
  : (await import("node:worker_threads")).parentPort;

const yield0 = () => new Promise((r) => setTimeout(r, 0));

let models = null;              // { dev, model } — built from the first task's model bytes
const pairs = new Map();        // name -> the §4.1 per-pair cache { generation, ... }
let task = null;                // { id, cancelled }

function buildPairCache(rec, dev) {
  const y = Float64Array.from(rec.y);
  rec.targetLab = srgbToLab(y);
  rec.labels = labelsOf(rec.targetLab, rec.reportMask);
  rec.bins = binsOf(rec.targetLab);
  const xg = new Float64Array(rec.x.length);
  for (let i = 0; i < xg.length; i++) xg[i] = rec.x[i] * rec.gain[i % 3];
  rec.fb = develop(dev, xg);              // the developed neutral, float64 (n, 3)
  // the neutral-vs-target sums: cached independently of profile edits (§4.1)
  rec.neutralSums = regionSums(rec.fb, rec.targetLab, rec.labels, rec.bins, rec.reportMask);
  rec.neutralAll = rec.neutralSums.all;
}

function ensureModels(m) {
  if (!models)
    models = { dev: loadDev(m.devMeta, m.devLut), model: loadModel(m.profileMeta, m.profileBin) };
  return models;
}

// The arrays of a message are registered when the message is RECEIVED (synchronously in
// onmessage, in posting order) — not when a task gets to the pair: a report task yields
// between pairs, and a frames request posted after it may reference a pair whose arrays
// travelled with the report. The expensive derived cache is built lazily (ensurePair).
function register(m) {
  for (const q of m.pairs ?? []) {
    if (!q.x) continue;
    pairs.set(q.name, { generation: q.generation, x: q.x, y: q.y, reportMask: q.masks.reportMask,
                        gain: q.gain, files: q.files, w3: q.w3, h3: q.h3 });
  }
}

// the per-pair cache entry; the derived cache is built on first use
function ensurePair(q, dev) {
  const rec = pairs.get(q.name);
  if (!rec || rec.generation !== q.generation) {
    const err = new Error(`no arrays for pair ${q.name} (generation ${q.generation})`);
    err.code = "cache_miss";
    err.pairs = [q.name];
    throw err;
  }
  if (!rec.fb) {
    buildPairCache(rec, dev);
    return { rec, built: true };
  }
  return { rec, built: false };
}

// Stage 7: the analyze.frame records for the advice. The neutral is the cached `fb` —
// develop(dev, x*gain), exactly Python's m.dev(raw["x"]*g) — and the target is the prepared
// y (Python's raw["t"]); no second develop, no copy back to the main thread.
function runFrames(m) {
  const { dev } = ensureModels(m);
  const frames = [];
  for (const q of m.pairs) {
    const { rec } = ensurePair(q, dev);
    frames.push({ name: q.name, generation: q.generation,
                  rec: buildFrame({ name: q.name, target: q.files?.target ?? null, ncc: q.ncc,
                                    warnings: q.warnings ?? [], targetSrgb: rec.y, neutralSrgb: rec.fb }) });
  }
  scope.postMessage({ type: "frames", id: m.id, frames });
}

async function runReport(m, stale) {
  const { dev, model } = ensureModels(m);
  // the prediction at the applied strength: strength.scaled(base, strength, base.name) —
  // the Python call keeps the base name (web/lib/strength.js scaled() appends "-<p>"; the
  // report result does not rename the profile)
  const result = scaled(JSON.parse(JSON.stringify(m.control)), m.strength);
  result.name = m.control.name;
  const p = paramsOf(result, model);
  const reports = [], allSums = [];
  const transfer = [];
  const t0 = Date.now();
  for (const q of m.pairs) {
    if (stale()) return;
    const { rec, built } = ensurePair(q, dev);
    if (built) {
      await yield0();                       // pump the queue: an early cancel lands here
      if (stale()) return;
    }
    const pred = new Pixels(model, rec.fb).apply(p);
    if (stale()) return;
    const sums = regionSums(pred, rec.targetLab, rec.labels, rec.bins, rec.reportMask);
    allSums.push(sums);
    const maps = await mapsOf(pred, rec.targetLab, rec.reportMask, async (done, total) => {
      if (stale()) return false;
      scope.postMessage({ type: "progress", id: m.id, pair: q.name, stage: "maps",
                          done, total });
      await yield0();                       // the cancel message is delivered at this yield
      return !stale();
    });
    if (stale()) return;
    for (const k of ["dE", "dL", "dC", "dh"]) transfer.push(maps[k].buffer);
    reports.push({
      schemaVersion: 1,
      kind: "report",
      id: `${m.versionId}:${q.name}`,
      pair: q.name,
      files: rec.files ?? { raw: "", target: "" },
      generation: m.generation ?? null,
      strength: m.strength,
      // the group labels (a copy — the cache stays valid) + the H3×W3 geometry for the
      // stage-5B report view: the row highlight overlays these pixels on the compare image
      w3: rec.w3, h3: rec.h3,
      labels: rec.labels.slice(),
      summary: summaryOf(sums, rec.neutralAll, m.strength,
                         refDE(m.fittedRenderDE, q.name) == null ? null
                           : sums.all - refDE(m.fittedRenderDE, q.name)),
      table: tableOf(sums),
      regionSums: sums,
      maps: { ...maps, mode: "dE" },
      parameters: { base: m.control, result, deltas: m.deltas ?? null },
      // the §4.4 download document is assembled from the report + the session aggregate by
      // the caller (analyze.downloadDoc) — no per-report copy here
    });
  }
  let aggregate = null;
  if (allSums.length) {
    const sums = totalSums(allSums);
    aggregate = { regionSums: sums, binMean: binMean(sums), table: tableOf(sums) };
  }
  if (stale()) return;
  scope.postMessage({ type: "ready", id: m.id, generation: m.generation,
                      versionId: m.versionId, strength: m.strength,
                      reports, aggregate, ms: Date.now() - t0 }, transfer);
}

const refDE = (f, name) => (f !== null && typeof f === "object" ? (f[name] ?? null) : f);

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "frames" || m.type === "report") register(m);
  if (m.type === "frames") {               // independent of the report task (no supersede)
    try { runFrames(m); } catch (err) {
      scope.postMessage({ type: "error", id: m.id, frames: true, code: err.code || "frames_failed",
                          pairs: err.pairs ?? null, detail: String(err.message || err) });
    }
    return;
  }
  if (m.type === "cancel") {
    if (task && task.id === m.id) task.cancelled = true;
    return;
  }
  if (m.type !== "report") return;
  if (task) task.cancelled = true;         // one at a time: the running report is stale
  const cur = { id: m.id, cancelled: false };
  task = cur;
  const stale = () => cur.cancelled || task !== cur;
  runReport(m, stale).catch((err) => {
    if (stale()) return;
    scope.postMessage({ type: "error", id: m.id, generation: m.generation, pairs: err.pairs ?? null,
                        code: err.code || "report_failed", detail: String(err.message || err) });
  });
};
