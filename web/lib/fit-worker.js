// Fitting worker (spec/ui-plan.md §3, stage 3): a thin lifecycle wrapper around the pure
// web/lib/sample.js runFreeFit (free sampling + LM + control, spec/web-schemas.md §3.2/§6.4).
// One fit at a time — a new fit message supersedes the running one (the cancel flag, checked
// by lm between outer iterations and between the Jacobian columns). The main thread owns the
// generations; results carry the caller's generation back and stale ones are discarded there
// (same rule as lib/pair-worker.js / lib/raw-worker.js).
//
// Messages in:
//   { type: "fit", id, generation, seed, iters, baseName,
//     devMeta, devLut, profileMeta, profileBin,     — the CPU dev/profile models (cloned)
//     files,                                        — { raw, target } base names (envelope)
//     pairs: [{ name, ncc, x, y, masks, gain }],    — prepared pairs; x/y/mask/gain buffers transferred
//     detail?: { meta, bin, pairs: [{ name, lin, ty, w, h, scale }] }
//                                                   — the detail fit's input (lib/detail-fit.js): the
//                                                     compare-grid linear frame (NaN outside) and the
//                                                     target's Y'; buffers transferred
//     poolSize? }                                   — optional: the helper count (tests; 0 = single-threaded)
//   { type: "cancel", id }
// Messages out:
//   { type: "progress", id, generation, iteration, total, cost, lambda }   — per accepted LM iteration
//   { type: "progress", id, generation, stage: "detail", done, total }      — the detail fit, per pair
//   { type: "ready", id, generation, result, ms }   — FitResult (spec §3.2), fitVector transferred
//   { type: "error", id, generation, code, detail }
// A cancelled task posts nothing at all.
//
// Speed (spec/ui-plan.md §6 "LM performance"): the Jacobian columns run in a pool of nested
// helper Workers (lib/fit-pool.js, one per spare core, at most 8) — bit-identical to the
// single-thread fit. Where nested Workers are unavailable, or on a machine with fewer than
// 3 cores, the fit runs in this Worker as before. Awaiting the pool also lets a "cancel"
// message land between Jacobian columns.

import { loadModel } from "./profile.js";
import { loadDev, jacobianSteps } from "./fit.js";
import { runFreeFit, runFreeFitParallel } from "./sample.js";
import { createFitPool, poolSize } from "./fit-pool.js";
import { loadDetail } from "./detail.js";
import { fitDetailPairs, TOOLS as DETAIL_TOOLS } from "./detail-fit.js";

const spawnHelper = () => new Worker(new URL("./fit-jac-worker.js", import.meta.url), { type: "module" });
const POOL_SIZE = typeof Worker === "function" ? poolSize(self.navigator && self.navigator.hardwareConcurrency) : 0;

let task = null;   // { id, cancelled }

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "cancel") {
    if (task && task.id === m.id) task.cancelled = true;
    return;
  }
  if (m.type !== "fit") return;
  if (task) task.cancelled = true;          // one at a time: the running fit is stale
  const cur = { id: m.id, cancelled: false };
  task = cur;
  const stale = () => cur.cancelled || task !== cur;

  try {
    const dev = loadDev(m.devMeta, m.devLut);
    const model = loadModel(m.profileMeta, m.profileBin);
    const hooks = {
      onIteration: (run, requested, cost, lambda) => {
        if (!stale())
          self.postMessage({ type: "progress", id: m.id, generation: m.generation,
                             iteration: run, total: requested, cost, lambda });
      },
      shouldCancel: stale,
    };
    const t0 = Date.now();
    const opts = { dev, model, seed: m.seed ?? 0, iters: m.iters ?? 30, baseName: m.baseName, hooks };
    let out = null;
    const size = m.poolSize ?? POOL_SIZE;     // poolSize: a test override (0 = single-threaded)
    if (size > 0) {
      try {
        out = await runFreeFitParallel(m.pairs, { ...opts,
          makePool: (qs) => createFitPool({ spawn: spawnHelper, size, profileMeta: m.profileMeta,
                                            profileBin: m.profileBin, qs, shouldCancel: stale }) });
      } catch (err) {
        if (err.code !== "pool_unavailable") throw err;
        out = null;                           // no nested Workers here: the single-thread fit below
      }
    }
    if (stale()) return;                      // cancelled: exit without a result
    if (out === null) out = runFreeFit(m.pairs, opts);
    if (stale()) return;
    // Clarity and Mid-range for the fitted color (lib/detail-fit.js, spec/ui.md decision #19)
    let detail = null;
    if (m.detail && m.detail.pairs && m.detail.pairs.length) {
      const progress = (done, total) => {
        if (!stale())
          self.postMessage({ type: "progress", id: m.id, generation: m.generation, stage: "detail", done, total });
      };
      progress(0, m.detail.pairs.length);
      const r = await fitDetailPairs({ dev, model, detail: loadDetail(m.detail.meta, m.detail.bin),
                                       control: out.control, pairs: m.detail.pairs,
                                       onPair: progress, shouldCancel: stale });
      if (stale()) return;
      if (r && r.pairs) {
        for (const t of DETAIL_TOOLS) out.control[t] = r.values[t];
        detail = { values: r.values, raw: r.raw, cost: r.cost, cost0: r.cost0, pairs: r.pairs };
      }
    }
    const result = {
      schemaVersion: 1,
      kind: "fitResult",
      id: m.versionId ?? "draft",
      files: m.files ?? { raw: "", target: "" },
      generation: m.generation ?? null,
      fitVector: out.x,                       // transferred below
      cost: out.cost,
      iterations: out.iterations,
      jacobianSteps: jacobianSteps(out.x.length),
      seed: m.seed ?? 0,
      control: out.control,
      scores: out.scores,
      pairs: out.names,
      init: out.init,                         // the winning STARTS entry (fit.js)
      starts: out.starts,
      detail,                                 // the detail fit (null: not run or no usable pixels)
    };
    self.postMessage({ type: "ready", id: m.id, generation: m.generation,
                       result, ms: Date.now() - t0 }, [out.x.buffer]);
  } catch (err) {
    if (stale()) return;
    self.postMessage({ type: "error", id: m.id, generation: m.generation,
                       code: err.code || "fit_failed", detail: String(err.message || err) });
  }
};
