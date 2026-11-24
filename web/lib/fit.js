// The browser fitting engine core: a port of fit.py (the 56-parameter packing, LM solver)
// and the fit half of match.py (the dE2000-weighted residual over match.Pairs, control
// conversion) plus the CPU development model of devmodel.py/ceiling.Lut (the prediction
// input). The profile prediction reuses web/lib/profile.js Pixels, the same CPU path as the
// LUT builder. Pure TypedArray math, deterministic, no DOM — runs in Node and Workers.
// Python is the source of truth, quirks included; constants repeat fit.py/match.py exactly.

import { srgbToLab } from "./color.js";
import { Pixels } from "./profile.js";

// ---------- the 56-parameter layout (fit.py / spec/web-schemas.md §3.1) ----------

export const COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta"]; // np3.COLORS
export const ZONES = ["shadows", "midtone", "highlights"];   // np3.ZONES, dark to light
export const XS = Float64Array.from([0, 13, 27, 40, 54, 67, 81, 94, 107, 121, 134, 148, 161, 174, 188, 201, 215, 228, 242, 255],
                                    (v) => v / 255);
export const NB = 24;          // blender: 8 colors x 3 attrs, color-major
export const NG = 6;           // grade: 3 zones x 2 cartesian components
export const NC = 20;          // curve increments at XS
export const NX = NB + NG + NC;
export const SMOOTH = 0.3;
export const RIDGE = 0.012;
export const LIMIT = 60.0;     // sweeps measured the response up to +-60; beyond is extrapolation
export const WHITE = 30.0;     // the curve end is pinned to 1
export const RING = 0.02;      // neighboring colors of the wheel pull towards each other
export const BEND = Float64Array.from([...Array(14).fill(1), ...Array(4).fill(0.25)]); // the shoulder bends steeper
export const EXTRA_DEFAULT = Float64Array.from([0.0, 0.0, 0.0, 0.0, 50.0, 0.0]); // Sat, zone bright H/M/S, Blending, Balance
export const EXTRA_LOW = [-100, -100, -100, -100, 0, -100];
export const EXTRA_HIGH = [100, 100, 100, 100, 100, 100];
export const CLIP = 0.98;      // a target channel at or above this counts as pinned in white
export const NEAR_WHITE = 0.8;
export const CLIP_PIXELS = 3000;
export const KC = 0.5;         // chroma weight of dE2000: below 1 is stricter on chroma
export const FLAT_L = true;    // no dE2000 SL: the curve's white knee holds as in dE76
export const ROBUST = 6.0;     // Cauchy scale on each pixel's weighted dE (match.ROBUST)
// the fit starts (match.STARTS): zone brightness of each; the first always runs, the others only
// when it got stuck (fewer than STUCK accepted iterations); the lower final cost wins
export const STARTS = [["zero", {}], ["zones", { shadows: -50, midtone: 30 }]];
export const STUCK = 5;

const GRID257 = Float64Array.from({ length: 257 }, (_, i) => i / 256);

/** Zero initialization: blender/grade = 0, curve = [0, diff(XS)], extra = EXTRA_DEFAULT (match.Matcher.fit x0). */
export function zeroInit() {
  const x = new Float64Array(NX + 6);
  for (let i = 0; i < NC - 1; i++) x[NB + NG + 1 + i] = XS[i + 1] - XS[i];
  for (let i = 0; i < 6; i++) x[NX + i] = EXTRA_DEFAULT[i];
  return x;
}

/** The initial vector of a STARTS entry (match.start): zeroInit plus its zone brightness. */
export function startInit(zones) {
  const x = zeroInit();
  for (const [z, v] of Object.entries(zones)) x[NX + 1 + ZONES.indexOf(z)] = v;
  return x;
}

/** Monotone curve: knots = cumsum(|increments|). Port of fit.knots (match.knots slice: x[NB+NG:NX]). */
export function knotsOf(x, from = NB + NG, to = NX) {
  const k = new Float64Array(to - from);
  let s = 0;
  for (let i = 0; i < k.length; i++) { s += Math.abs(x[from + i]); k[i] = s; }
  return k;
}

/** np.interp port: xp increasing, edges constant. */
export function interp1(x, xp, fp) {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
  return fp[lo] + (fp[hi] - fp[lo]) * t;
}

/** The 257-entry curve table: clip(interp(linspace(0,1,257), XS, knots), 0, 1). Port of fit.table. */
export function tableOfKnots(k) {
  const out = new Float64Array(257);
  for (let i = 0; i < 257; i++) out[i] = Math.min(1, Math.max(0, interp1(i / 256, XS, k)));
  return out;
}

/**
 * The 56-vector -> model.Params for profile.js Pixels. Port of match.unpack: blender floats,
 * grade as (hue deg, chroma) from the cartesian (u, v), the extra tail clipped to the slider
 * ranges, the curve always present (the fit packs it as increments).
 */
export function unpackParams(x) {
  const e = [];
  for (let i = 0; i < 6; i++) e.push(Math.min(EXTRA_HIGH[i], Math.max(EXTRA_LOW[i], x[NX + i])));
  const blender = {}, grade = {}, grade_bright = {};
  for (let i = 0; i < 8; i++) blender[COLORS[i]] = [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]];
  for (let z = 0; z < 3; z++) {
    const u = x[NB + z * 2], v = x[NB + z * 2 + 1];
    grade[ZONES[z]] = [((Math.atan2(v, u) * 180 / Math.PI) % 360 + 360) % 360, Math.hypot(u, v)];
    grade_bright[ZONES[z]] = e[1 + z];
  }
  return {
    saturation: e[0], blender, grade, grade_bright,
    curve: tableOfKnots(knotsOf(x)), tone: {},
    blending: e[4], balance: e[5],
  };
}

// ---------- development model (devmodel.Dev.__call__ + ceiling.Lut.__call__, trust = 1 per §6.5) ----------

/** The dev model from web/model (export_model.py): M, the log2 curve over uniform knots, the residual LUT. */
export function loadDev(meta, buf) {
  const w = Float64Array.from(meta.w);
  const nk = w.length;
  return {
    M: meta.M, w, nk, floor: meta.floor, n: meta.n,
    k0: meta.knots[0], kscale: (nk - 1) / (meta.knots[1] - meta.knots[0]),
    lut: new Float32Array(buf),
  };
}

/** Linear camera RGB (n, 3) -> developed neutral sRGB (n, 3). Port of devmodel.Dev.__call__. */
export function develop(dev, rgb) {
  const n = rgb.length / 3;
  // Dev.base: z = clip(x @ M.T, floor), b = clip(interp(log2 z, uniform knots, w), 0, 1)
  const b = new Float64Array(rgb.length);
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) {
      const m = dev.M[c];
      const z = Math.max(m[0] * rgb[p * 3] + m[1] * rgb[p * 3 + 1] + m[2] * rgb[p * 3 + 2], dev.floor);
      const t = (Math.log2(z) - dev.k0) * dev.kscale;     // uniform knots, clamped at both ends
      const i = Math.min(Math.max(Math.floor(t), 0), dev.nk - 2);
      b[p * 3 + c] = Math.min(1, Math.max(0, dev.w[i] + (dev.w[i + 1] - dev.w[i]) * (t - i)));
    }
  }
  // ceiling.Lut.__call__: trilinear delta over (r, g, b) nodes, out = clip(b + delta, 0, 1)
  const N = dev.n, lut = dev.lut;
  const out = new Float64Array(rgb.length);
  for (let p = 0; p < n; p++) {
    const u0 = Math.min(1, Math.max(0, b[p * 3])) * (N - 1);
    const u1 = Math.min(1, Math.max(0, b[p * 3 + 1])) * (N - 1);
    const u2 = Math.min(1, Math.max(0, b[p * 3 + 2])) * (N - 1);
    const i0 = Math.min(Math.floor(u0), N - 2), f0 = u0 - i0;
    const i1 = Math.min(Math.floor(u1), N - 2), f1 = u1 - i1;
    const i2 = Math.min(Math.floor(u2), N - 2), f2 = u2 - i2;
    for (let c = 0; c < 3; c++) {
      let d = 0;
      for (let dx = 0; dx <= 1; dx++)
        for (let dy = 0; dy <= 1; dy++)
          for (let dz = 0; dz <= 1; dz++) {
            const wgt = (dx ? f0 : 1 - f0) * (dy ? f1 : 1 - f1) * (dz ? f2 : 1 - f2);
            d += wgt * lut[(((i0 + dx) * N + i1 + dy) * N + i2 + dz) * 3 + c];
          }
      out[p * 3 + c] = Math.min(1, Math.max(0, b[p * 3 + c] + d));
    }
  }
  return out;
}

// ---------- the staged prediction (a pure speed-up, bit-identical to Pixels.apply) ----------
//
// Pixels.apply runs three stages: toned (grading + Saturation + the blender inputs — the
// expensive part), the blender, the curve. Each parameter block feeds only some of them:
//   toned   <- grade (u, v) x[NB, NB+NG) and the extra tail x[NX, NX+6)
//   blender <- the blender x[0, NB) (plus everything toned depends on)
//   curve   <- the curve increments x[NB+NG, NX)
// A central-difference Jacobian column moves one parameter, so 40 of the 112 evaluations per
// LM iteration (the curve) can reuse the anchor's beforeCurve and 48 more (the blender) its
// toned result. The anchor is the Jacobian's base point x; reuse happens only when the
// relevant x entries are exactly equal, so the arithmetic — and the result — is unchanged.

function sameRange(a, b, from, to) {
  for (let i = from; i < to; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An anchor for the staged prediction: the base point and lazily filled per-Pixels caches. */
export function makeStage(x) {
  return { x: Float64Array.from(x), cache: new Map() };
}

/** px.apply(p) through the stage caches when x shares the anchor's toned/blender inputs. */
function predict(px, p, x, stage) {
  if (stage === null || p.curve === null) return px.apply(p);   // a null curve would clamp the cached array in place
  const ax = stage.x;
  if (!sameRange(x, ax, NB, NB + NG) || !sameRange(x, ax, NX, NX + 6)) return px.apply(p);
  let e = stage.cache.get(px);
  if (!e) { e = { toned: null, before: null }; stage.cache.set(px, e); }
  if (e.toned === null) e.toned = px.toned(p);
  if (!sameRange(x, ax, 0, NB)) return px.apply(p, px.beforeCurve(p, e.toned));
  if (e.before === null) e.before = px.beforeCurve(p, e.toned);
  return px.apply(p, e.before);
}

/**
 * The residual as an LM objective with the staged-Jacobian hook: fn(x) = residual(pairs, x)
 * plus fn.anchor(x), called by lm before each Jacobian (later calls reuse the anchor's
 * stages where exact). Used by both the sync fit and the parallel Jacobian helpers.
 */
export function makeResidual(pairs) {
  let stage = null;
  const fn = (x) => residual(pairs, x, stage);
  fn.anchor = (x) => { stage = makeStage(x); };
  return fn;
}

// ---------- the residual (match.Matcher.fit fn, spec/web-schemas.md §3.4) ----------

/** match.robust for one row: the factor that turns its norm e into sqrt(c^2 log(1 + e^2 / c^2)). */
export function robustScale(e) {
  if (!ROBUST) return 1;
  const c = ROBUST;
  return e > 1e-9 ? Math.sqrt(c * c * Math.log1p(e * e / (c * c))) / Math.max(e, 1e-9) : 1;
}

/**
 * The full residual vector for P pairs at x: per pair the weighted Lab residuals
 * (de2000_weights at the target, KC=0.5, FLAT_L, x sqrt(mult); each pixel's row rescaled by the
 * Cauchy loss of match.robust, its norm over q.sm = sqrt(mult)) and the near-white one-sided
 * clip penalty (cmask channels penalized only when darker), both over sqrt(n_q * P); then the
 * shared regularization tail: SMOOTH*100*diff(k,2)*BEND, RIDGE*x[:30], RING*(b - roll(b,1)),
 * WHITE*(k[-1] - 1), RIDGE*(extra - EXTRA_DEFAULT).
 */
export function residual(pairs, x, stage = null) {
  const P = pairs.length;
  const p = unpackParams(x);
  const k = knotsOf(x);
  let total = (NC - 2) + (NB + NG) + NB + 1 + 6;
  for (const q of pairs) {
    total += q.n * 3;
    if (q.cpx) total += q.ct.length;
  }
  const out = new Float64Array(total);
  let o = 0;
  for (const q of pairs) {
    const norm = 1 / Math.sqrt(q.n * P);
    const pred = srgbToLab(predict(q.px, p, x, stage));   // C.srgb_to_lab(q.px(p)): the model output is clipped already
    for (let i = 0; i < q.n; i++) {
      const b3 = i * 3, b9 = i * 9;
      const d0 = pred[b3] - q.tlab[b3], d1 = pred[b3 + 1] - q.tlab[b3 + 1], d2 = pred[b3 + 2] - q.tlab[b3 + 2];
      const r0 = q.W[b9] * d0 + q.W[b9 + 1] * d1 + q.W[b9 + 2] * d2;
      const r1 = q.W[b9 + 3] * d0 + q.W[b9 + 4] * d1 + q.W[b9 + 5] * d2;
      const r2 = q.W[b9 + 6] * d0 + q.W[b9 + 7] * d1 + q.W[b9 + 8] * d2;
      const s = robustScale(Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2) / q.sm[i]) * norm;
      out[o++] = r0 * s;
      out[o++] = r1 * s;
      out[o++] = r2 * s;
    }
    if (q.cpx) {
      const cp = predict(q.cpx, p, x, stage);
      for (let i = 0; i < q.ct.length; i++) {
        const d = cp[i] - q.ct[i];
        out[o++] = 100 * (q.cmask[i] ? Math.min(d, 0) : d) * norm;
      }
    }
  }
  for (let i = 0; i < NC - 2; i++) out[o++] = SMOOTH * 100 * (k[i] - 2 * k[i + 1] + k[i + 2]) * BEND[i];
  for (let i = 0; i < NB + NG; i++) out[o++] = RIDGE * x[i];
  for (let i = 0; i < 8; i++) {
    const prev = ((i + 7) % 8) * 3;              // np.roll(b, 1, 0): row i minus row i-1
    for (let j = 0; j < 3; j++) out[o++] = RING * (x[i * 3 + j] - x[prev + j]);
  }
  out[o++] = WHITE * (k[NC - 1] - 1);
  for (let i = 0; i < 6; i++) out[o++] = RIDGE * (x[NX + i] - EXTRA_DEFAULT[i]);
  return out;
}

// ---------- the LM solver (fit.lm; spec/web-schemas.md §3.2/§6.7) ----------

/** The central-difference step per parameter: 1.0 for #0-29, 2e-3 for #30-49, 1.0 for the tail. */
export function jacobianSteps(nx) {
  const steps = new Float64Array(nx).fill(1);
  for (let i = NB + NG; i < NX && i < nx; i++) steps[i] = 2e-3;
  return steps;
}

/**
 * Gaussian elimination with partial pivoting on an nxn row-major matrix A against b.
 * The port of np.linalg.solve behind fit.lm; on a (numerically) singular row the free
 * component stays 0 instead of raising, which the LM diagonal bound keeps unreachable.
 */
export function solveDense(A, b) {
  const n = b.length;
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r * n + col]) > Math.abs(M[piv * n + col])) piv = r;
    if (piv !== col) {
      for (let c = col; c < n; c++) { const t = M[col * n + c]; M[col * n + c] = M[piv * n + c]; M[piv * n + c] = t; }
      const t = x[col]; x[col] = x[piv]; x[piv] = t;
    }
    const d = M[col * n + col];
    if (Math.abs(d) < 1e-300) { x[col] = 0; continue; }
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r * n + c] -= f * M[col * n + c];
      x[r] -= f * x[col];
    }
  }
  for (let col = n - 1; col >= 0; col--) {
    let s = x[col];
    for (let c = col + 1; c < n; c++) s -= M[col * n + c] * x[c];
    const d = M[col * n + col];
    x[col] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
  return x;
}

const dot = (r) => { let s = 0; for (let i = 0; i < r.length; i++) s += r[i] * r[i]; return s; };

/**
 * One central-difference Jacobian column: (fn(x + h e_i) - fn(x - h e_i)) / 2h, length m.
 * xp/xm are scratch copies of x (restored on return). Shared by the local Jacobian and the
 * parallel helpers (lib/fit-jac-worker.js), so both produce identical columns.
 */
export function jacobianColumn(fn, x, i, step, xp = Float64Array.from(x), xm = Float64Array.from(x)) {
  xp[i] = x[i] + step; xm[i] = x[i] - step;
  const rp = fn(xp), rm = fn(xm);
  xp[i] = x[i]; xm[i] = x[i];
  const inv = 1 / (2 * step);
  const col = new Float64Array(rp.length);
  for (let j = 0; j < col.length; j++) col[j] = (rp[j] - rm[j]) * inv;
  return col;
}

/** The local (single-thread) Jacobian, row-major m x nx; null when shouldCancel fired. */
function jacobianLocal(fn, x, m, shouldCancel) {
  const nx = x.length;
  const steps = jacobianSteps(nx);
  if (fn.anchor) fn.anchor(x);
  const J = new Float64Array(m * nx);
  const xp = Float64Array.from(x), xm = Float64Array.from(x);
  for (let i = 0; i < nx; i++) {
    if (shouldCancel && shouldCancel()) return null;
    const col = jacobianColumn(fn, x, i, steps[i], xp, xm);
    for (let j = 0; j < m; j++) J[j * nx + i] = col[j];
  }
  return J;
}

/**
 * The LM iteration itself (fit.lm) as a generator: it yields {x, m} whenever it needs the
 * Jacobian at x and expects the row-major m x nx Jacobian back (null = cancelled). The sync
 * driver lm() computes it in place, lmAsync() hands it to the parallel helpers — one LM
 * implementation, identical arithmetic either way.
 */
function* lmCore(fn, x, iters, hooks) {
  const shouldCancel = hooks.shouldCancel;
  const onIteration = hooks.onIteration;
  x = Float64Array.from(x);
  const nx = x.length;
  let lam = 1e-2;
  let r = fn(x);
  let cost = dot(r);
  const costs = [cost], lambdas = [lam];
  let run = 0;
  const cancelled = () => ({ x, cost, iterations: { requested: iters, run, costs, lambdas }, cancelled: true });
  for (let it = 0; it < iters; it++) {
    if (shouldCancel && shouldCancel()) return cancelled();
    const m = r.length;
    const J = yield { x, m };
    if (J === null) return cancelled();
    // the normal equations, accumulated row by row (contiguous J rows); every A[i][j] and g[i]
    // still sums its products in increasing row order, so the values match the column-wise sum
    const A = new Float64Array(nx * nx), g = new Float64Array(nx);
    for (let l = 0; l < m; l++) {
      const o = l * nx, rl = r[l];
      for (let i = 0; i < nx; i++) {
        const ji = J[o + i];
        g[i] += ji * rl;
        const ai = i * nx;
        for (let j = i; j < nx; j++) A[ai + j] += ji * J[o + j];
      }
    }
    for (let i = 0; i < nx; i++)
      for (let j = i + 1; j < nx; j++) A[j * nx + i] = A[i * nx + j];
    let accepted = false;
    for (let inner = 0; inner < 12; inner++) {
      let maxDiag = 0;
      for (let i = 0; i < nx; i++) maxDiag = Math.max(maxDiag, A[i * nx + i]);
      const M = Float64Array.from(A);
      for (let i = 0; i < nx; i++)
        M[i * nx + i] += lam * Math.max(A[i * nx + i], 1e-4 * maxDiag);
      const d = solveDense(M, Float64Array.from(g, (v) => -v));
      const y = Float64Array.from(x);
      for (let i = 0; i < nx; i++) y[i] += d[i];
      for (let i = 0; i < NB; i++) y[i] = Math.min(LIMIT, Math.max(-LIMIT, y[i]));
      for (let z = 0; z < 3; z++) {              // grade (u, v) pairs to length <= LIMIT
        const nrm = Math.hypot(y[NB + z * 2], y[NB + z * 2 + 1]);
        const s = Math.min(1, LIMIT / Math.max(nrm, 1e-9));
        y[NB + z * 2] *= s; y[NB + z * 2 + 1] *= s;
      }
      const r2 = fn(y);
      const c2 = dot(r2);
      if (c2 < cost) {
        x = y; r = r2; cost = c2;
        lam = Math.max(lam / 3, 1e-6);
        accepted = true;
        break;
      }
      lam *= 3;
    }
    if (!accepted) break;
    run++;
    costs.push(cost);
    lambdas.push(lam);
    if (onIteration) onIteration(run, iters, cost, lam);
  }
  return { x, cost, iterations: { requested: iters, run, costs, lambdas } };
}

/**
 * Levenberg-Marquardt with a numerical jacobian and bounds on blender/grade (fit.lm).
 * lam0 = 1e-2, success /3 (min 1e-6), failure x3, at most 12 inner tries, stop on an outer
 * iteration without a step. The damped normal system adds lam * diag(max(diag, 1e-4*max(diag)))
 * (fit.lm's lower bound for flat Jacobian columns) and is solved by solveDense.
 * Returns {x, cost, iterations: {requested, run, costs, lambdas}} — the history the Python
 * side does not record, kept for convergence comparison (spec §3.2). With cancelled: true
 * when hooks.shouldCancel() fired (the caller discards the partial result).
 * hooks (optional, the Worker lifecycle): shouldCancel() is checked between outer iterations
 * and between the Jacobian columns; onIteration(run, requested, cost, lambda) fires after
 * every accepted outer iteration (the throttling point for progress messages).
 * fn may carry fn.anchor(x) (makeResidual): called before each Jacobian at its base point.
 */
export function lm(fn, x, iters = 30, hooks = {}) {
  const g = lmCore(fn, x, iters, hooks);
  let s = g.next();
  while (!s.done) s = g.next(jacobianLocal(fn, s.value.x, s.value.m, hooks.shouldCancel));
  return s.value;
}

/**
 * lm with an external (asynchronous) Jacobian: jacobian(x, m) -> Promise<row-major m x nx
 * Float64Array | null>. The same iteration as lm; with columns from jacobianColumn on the same
 * residual the result is bit-identical to the sync path.
 */
export async function lmAsync(fn, x, iters, hooks, jacobian) {
  const g = lmCore(fn, x, iters, hooks);
  let s = g.next();
  while (!s.done) s = g.next(await jacobian(s.value.x, s.value.m));
  return s.value;
}

/**
 * The hooks of one start: onIteration counts on across the starts (start s reports s * iters + run
 * of (s + 1) * iters: a second start extends the bar), shouldCancel as is.
 */
function startHooks(hooks, s, iters) {
  const on = hooks.onIteration;
  return { ...hooks, onIteration: on ? (run, _req, cost, lam) => on(s * iters + run, (s + 1) * iters, cost, lam) : undefined };
}

/** The lowest-cost run of the STARTS (match.Matcher.fit) with init (its name) and starts (name -> cost). */
function bestOf(runs) {
  let best = runs[0];
  for (const r of runs) if (r.cost < best.cost) best = r;
  return { ...best.r, init: best.name, starts: Object.fromEntries(runs.map((r) => [r.name, r.cost])) };
}

/** The full browser fit: match.Matcher.fit — LM from the first STARTS entry, from the others only
 *  while the runs get stuck (STUCK); the lowest cost wins. pairs — the prepareFitPair objects.
 *  A cancelled start returns its partial result as is. */
export function fit(pairs, iters = 30, hooks = {}) {
  const runs = [];
  for (let s = 0; s < STARTS.length; s++) {
    const r = lm(makeResidual(pairs), startInit(STARTS[s][1]), iters, startHooks(hooks, s, iters));
    if (r.cancelled) return r;
    runs.push({ name: STARTS[s][0], cost: r.cost, r });
    if (r.iterations.run >= STUCK) break;
  }
  return bestOf(runs);
}

/** fit with an external parallel Jacobian (lib/fit-pool.js) — same result as fit(). */
export async function fitAsync(pairs, iters, hooks, jacobian) {
  const runs = [];
  for (let s = 0; s < STARTS.length; s++) {
    const r = await lmAsync(makeResidual(pairs), startInit(STARTS[s][1]), iters, startHooks(hooks, s, iters), jacobian);
    if (r.cancelled) return r;
    runs.push({ name: STARTS[s][0], cost: r.cost, r });
    if (r.iterations.run >= STUCK) break;
  }
  return bestOf(runs);
}

// ---------- the control (match.control + fit.control + make_pack.curve_from, spec §3.3/§6.8) ----------

/** Python round(): half-to-even (NOT Math.round — controls would differ by 1 on exact halves). */
export function roundHalfEven(v) {
  const fl = Math.floor(v), fr = v - fl;
  if (fr < 0.5) return fl;
  if (fr > 0.5) return fl + 1;
  return fl % 2 === 0 ? fl : fl + 1;
}

/** A table and 20 points from one function: Nikon recomputes the curve from the points (make_pack.curve_from). */
export function curveFrom(f) {
  const clip01 = (v) => Math.min(1, Math.max(0, v));
  const raw = [];
  for (let i = 0; i < 257; i++) raw.push(roundHalfEven(clip01(f(i / 256)) * 32767));
  const points = [];
  for (let i = 0; i < 20; i++) {
    const x = roundHalfEven(i * 255 / 19);
    points.push([x, roundHalfEven(clip01(f(x / 255)) * 255)]);
  }
  return { raw, points };
}

/**
 * The resulting np3.Control-shaped object at 100% strength (match.control): fixed detail
 * defaults (Sharpening 2.0, Mid-range 1.0, Clarity 0), zero tonal sliders, banker's rounding
 * on every slider, the name "NPF-" + baseName.upper()[-15:] as in match.write.
 */
export function controlOf(x, baseName) {
  const p = unpackParams(x);
  const ir = roundHalfEven;
  const blender = {}, grade = {};
  for (const c of COLORS) blender[c] = p.blender[c].map(ir);
  for (const z of ZONES)
    grade[z] = [((ir(p.grade[z][0]) % 360) + 360) % 360, ir(p.grade[z][1]), ir(p.grade_bright[z])];
  const k = knotsOf(x);
  return {
    name: "NPF-" + baseName.toUpperCase().slice(-15),
    comment: "",
    sharpening: 2.0, mid_sharpening: 1.0, clarity: 0,
    contrast: 0, highlights: 0, shadows: 0, white: 0, black: 0,
    saturation: ir(p.saturation),
    blender, grade,
    blending: ir(p.blending), balance: ir(p.balance),
    curve: curveFrom((t) => interp1(t, XS, k)),
  };
}
