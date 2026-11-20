// The parallel Jacobian for the browser fit (a pure speed-up of fit.lm, spec/ui-plan.md §6
// "LM performance"): the 56 central-difference columns of every LM iteration are spread over
// a pool of helper Workers (lib/fit-jac-worker.js). Every helper rebuilds the same sampled
// pairs and the same residual (fit.makeResidual), and computes a column with the same
// fit.jacobianColumn as the single-thread path, so the assembled Jacobian — and the fit — is
// bit-identical to fit.fit(). Runs inside lib/fit-worker.js (nested Workers); no
// SharedArrayBuffer, so no COOP/COEP headers are needed on the static host.
//
// Messages to a helper:
//   { type: "init", profileMeta, profileBin, pairs: [{ n, rgb, tlab, W, crgb, ct, cmask }] }
//   { type: "col", gen, x, i }          — column i at the base point x (one LM iteration = one gen)
// Messages from a helper:
//   { type: "ready" } | { type: "col", gen, i, col } (col transferred) | { type: "error", detail }

import { NB, NG, NX } from "./fit.js";

/** The column order: the expensive full-pipeline columns first, the cheap curve ones last (load balance). */
function columnOrder(nx) {
  const order = [];
  for (let i = NB; i < NB + NG; i++) order.push(i);         // grade
  for (let i = NX; i < nx; i++) order.push(i);               // Saturation, zone brightness, Blending, Balance
  for (let i = 0; i < NB; i++) order.push(i);                // blender
  for (let i = NB + NG; i < NX; i++) order.push(i);          // curve
  return order;
}

/** The pool size for this machine: one helper per spare core, at most `max`; 0 = run single-threaded. */
export function poolSize(hardwareConcurrency, max = 8) {
  const n = Math.min(max, (hardwareConcurrency || 1) - 1);
  return n >= 2 ? n : 0;
}

/**
 * Starts `size` helpers and loads the sampled pairs qs (prepareFitPair objects) into each.
 * spawn() -> a Worker-like object (postMessage/onmessage/onerror/terminate).
 * Resolves to { jacobian(x, m) -> Promise<row-major m x nx | null>, terminate(), size };
 * rejects with code "pool_unavailable" when a helper cannot be started.
 * shouldCancel() is polled before each column dispatch; a cancelled Jacobian resolves null.
 */
export function createFitPool({ spawn, size, profileMeta, profileBin, qs, shouldCancel = null }) {
  const helpers = [];
  const terminate = () => { for (const h of helpers) { try { h.w.terminate(); } catch { /* already gone */ } } };
  const unavailable = (detail) => Object.assign(new Error(`fit pool unavailable: ${detail}`), { code: "pool_unavailable" });
  const pairs = qs.map((q) => ({
    n: q.n, rgb: q.px.rgb, tlab: q.tlab, W: q.W,
    crgb: q.cpx ? q.cpx.rgb : null, ct: q.ct, cmask: q.cmask,
  }));

  let job = null;   // the running Jacobian: { gen, x, m, nx, J, order, next, done, resolve, reject }
  let gen = 0;
  let failed = null;

  const fail = (err) => {
    failed = err;
    if (job) { const j = job; job = null; j.reject(err); }
  };
  const dispatch = (h) => {
    const j = job;
    if (!j) return;
    if (shouldCancel && shouldCancel()) { job = null; j.resolve(null); return; }
    if (j.next >= j.order.length) return;
    const i = j.order[j.next++];
    h.w.postMessage({ type: "col", gen: j.gen, x: j.x, i });
  };

  function jacobian(x, m) {
    if (failed) return Promise.reject(failed);
    const nx = x.length;
    return new Promise((resolve, reject) => {
      job = { gen: ++gen, x: Float64Array.from(x), m, nx, J: new Float64Array(m * nx),
              order: columnOrder(nx), next: 0, done: 0, resolve, reject };
      for (const h of helpers) dispatch(h);
    });
  }

  return new Promise((resolve, reject) => {
    let ready = 0;
    let settled = false;
    const helperFail = (detail) => {
      if (settled) { fail(Object.assign(new Error(`fit helper failed: ${detail}`), { code: "fit_failed" })); return; }
      settled = true;
      terminate();
      reject(unavailable(detail));
    };
    try {
      for (let k = 0; k < size; k++) {
        const h = { w: spawn() };
        helpers.push(h);
        h.w.onerror = (e) => {
          if (e && e.preventDefault) e.preventDefault();
          helperFail(e && e.message ? e.message : "worker error");
        };
        h.w.onmessage = (e) => {
          const m = e.data;
          if (m.type === "ready") {
            if (++ready === size && !settled) {
              settled = true;
              resolve({ jacobian, terminate, size });
            }
          } else if (m.type === "col") {
            const j = job;
            if (!j || m.gen !== j.gen) return;               // stale: a cancelled iteration
            const { J, nx } = j;
            const col = m.col;
            for (let r = 0; r < j.m; r++) J[r * nx + m.i] = col[r];
            if (++j.done === j.order.length) { job = null; j.resolve(J); return; }
            dispatch(h);
          } else if (m.type === "error") {
            helperFail(m.detail);
          }
        };
        h.w.postMessage({ type: "init", profileMeta, profileBin, pairs });
      }
    } catch (err) {
      helperFail(String((err && err.message) || err));
    }
  });
}
