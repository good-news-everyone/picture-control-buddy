// Fitting Clarity and Mid-range sharpening to the targets (port of detailfit.py; spec/tools/detail.md
// "Fitting the detail tools", spec/ui.md decision #19). After the color fit, the render of the fitted
// profile (its own detail values v0 and the NX base detail included) and the target, both as Y' on
// one grid, are compared in the band sigma LO..HI (full-frame px):
//   bp(target) ~ bp(a1*y + a2*y^2 + a3*y^3) + sum_t (total_t(v_t) - total_t(v0_t))
// a cubic tone term per pair, the detail values shared by all pairs, each pair normalized by its
// own band energy; CAL takes our render's excess local contrast over NX Studio's out. Blurs are the Young-van Vliet recursive Gaussian (edges replicated), Float64,
// so the result matches detailfit.py to float precision (level 1l). Pure functions, no DOM.
import { partOf, applyDetailCPU } from "./detail.js";
import { develop } from "./fit.js";
import { buildLUT, applyLUT } from "./profile.js";

export const TOOLS = ["clarity", "mid_sharpening"];
export const LO = 5.6, HI = 179.2;          // detailfit.LO / HI
export const CLIP_LO = 0.02, CLIP_HI = 0.97;
export const STEP = 0.25;
export const RANGE = [-5, 5];
export const MIN_PIXELS = 10000;
// detailfit.CAL_WEB: the wizard render's excess local contrast over NX Studio's, as plus-table
// responses (measured on 12 SA frames against NX's export of the same profile)
export const CAL = { clarity: -0.25, mid_sharpening: 1.2 };
const NZ = 3 + 2 * TOOLS.length + 1;

/** Young-van Vliet recursive Gaussian over a row-major h x w Float64Array (rows first, then
 *  columns, as detailfit.rgauss). Returns a new array. */
function yvvCoef(q) {
  const b0 = 1.57825 + 2.44413 * q + 1.4281 * q * q + 0.422205 * q * q * q;
  const b1 = (2.44413 * q + 2.85619 * q * q + 1.26661 * q * q * q) / b0;
  const b2 = -(1.4281 * q * q + 1.26661 * q * q * q) / b0;
  const b3 = 0.422205 * q * q * q / b0;
  return [1 - (b1 + b2 + b3), b1, b2, b3];
}

/** detailfit._yvv: q by bisection on the cascade's exact variance (the paper's q(sigma) overshoots). */
function yvv(sigma) {
  const vr = (q) => {
    const [B, b1, b2, b3] = yvvCoef(q);
    const mu = (b1 + 2 * b2 + 3 * b3) / B;
    return 2 * ((2 * b2 + 6 * b3) / B + mu * mu + mu);
  };
  let lo = 1e-3, hi = 2.0 * sigma + 2.0;
  const target = sigma * sigma;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (vr(mid) < target) lo = mid; else hi = mid;
  }
  return yvvCoef(0.5 * (lo + hi));
}

export function rgauss(a, w, h, sigma) {
  if (sigma < 0.5) return Float64Array.from(a);
  const [B, b1, b2, b3] = yvv(sigma);
  const tmp = new Float64Array(a.length);
  const out = new Float64Array(a.length);
  // along each row
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let p1 = a[o], p2 = p1, p3 = p1;
    for (let x = 0; x < w; x++) {
      const v = B * a[o + x] + b1 * p1 + b2 * p2 + b3 * p3;
      tmp[o + x] = v; p3 = p2; p2 = p1; p1 = v;
    }
    p1 = tmp[o + w - 1]; p2 = p1; p3 = p1;
    for (let x = w - 1; x >= 0; x--) {
      const v = B * tmp[o + x] + b1 * p1 + b2 * p2 + b3 * p3;
      out[o + x] = v; p3 = p2; p2 = p1; p1 = v;
    }
  }
  // along each column, all columns at once row by row (cache friendly)
  const P1 = new Float64Array(w), P2 = new Float64Array(w), P3 = new Float64Array(w);
  for (let x = 0; x < w; x++) { P1[x] = P2[x] = P3[x] = out[x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const v = B * out[o + x] + b1 * P1[x] + b2 * P2[x] + b3 * P3[x];
      tmp[o + x] = v; P3[x] = P2[x]; P2[x] = P1[x]; P1[x] = v;
    }
  }
  const last = (h - 1) * w;
  for (let x = 0; x < w; x++) { P1[x] = P2[x] = P3[x] = tmp[last + x]; }
  for (let y = h - 1; y >= 0; y--) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const v = B * tmp[o + x] + b1 * P1[x] + b2 * P2[x] + b3 * P3[x];
      out[o + x] = v; P3[x] = P2[x]; P2[x] = P1[x]; P1[x] = v;
    }
  }
  return out;
}

/** Y' (detail.YW) of an RGB array (any typed array, n x 3) -> Float64Array n. */
export function luma(d, rgb) {
  const [r, g, b] = d.YW;
  const n = rgb.length / 3;
  const y = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 3) y[i] = r * rgb[p] + g * rgb[p + 1] + b * rgb[p + 2];
  return y;
}

/** detailfit.usable: valid in both, not clipped, away from the edge and invalid areas. */
export function usable(yr, yt, valid, w, h, scale) {
  const s = HI / scale, m = Math.ceil(s);
  const inv = new Float64Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = valid[i] ? 0 : 1;
  const near = rgauss(inv, w, h, s);
  const ok = new Uint8Array(w * h);
  for (let y = m; y < h - m; y++)
    for (let x = m; x < w - m; x++) {
      const i = y * w + x;
      ok[i] = valid[i] && yr[i] > CLIP_LO && yr[i] < CLIP_HI && yt[i] > CLIP_LO && yt[i] < CLIP_HI
        && near[i] < 1e-3 ? 1 : 0;
    }
  return ok;
}

function tableAt(y, d, t, off) {             // np.interp(y, GRID, table): uniform GRID, NB knots
  const u = Math.min(1, Math.max(0, y)) * (d.NB - 1);
  const i = Math.min(Math.floor(u), d.NB - 2);
  const f = u - i;
  return t[off + i] + (t[off + i + 1] - t[off + i]) * f;
}

/** Per tool [plus, minus]: the detail response at value +1 / -1 on Y' (detailfit.tool_basis). */
export function toolBasis(d, y, w, h, scale) {
  const hp = new Map();
  const out = {};
  for (const tool of TOOLS) {
    const p = partOf(d, tool, scale);
    const pair = [];
    for (const [tables, sg] of [[p.plus, 1], [p.minus, -1]]) {
      const r = new Float64Array(y.length);
      p.sigmas.forEach((s, k) => {
        if (!hp.has(s)) {
          const g = rgauss(y, w, h, s / scale);
          const v = new Float64Array(y.length);
          for (let i = 0; i < y.length; i++) v[i] = y[i] - g[i];
          hp.set(s, v);
        }
        const v = hp.get(s), off = k * d.NB;
        for (let i = 0; i < y.length; i++) r[i] += tableAt(y[i], d, tables, off) * v[i];
      });
      if (sg < 0) for (let i = 0; i < r.length; i++) r[i] = -r[i];
      pair.push(r);
    }
    out[tool] = pair;
  }
  return out;
}

/** One pair -> { Q (NZ x NZ, row-major Float64Array), n } over its usable pixels, or null.
 *  yr, yt — Y' (Float64Array), valid — Uint8Array, scale — full-frame px per pixel. */
export function gram(d, yr, yt, valid, w, h, scale) {
  const ok = usable(yr, yt, valid, w, h, scale);
  let n = 0;
  for (let i = 0; i < ok.length; i++) n += ok[i];
  if (n < MIN_PIXELS) return null;
  const y = new Float64Array(yr.length), t = new Float64Array(yr.length);
  for (let i = 0; i < y.length; i++) { y[i] = valid[i] ? yr[i] : 0.5; t[i] = valid[i] ? yt[i] : 0.5; }
  const bp = (a) => {
    const lo = rgauss(a, w, h, LO / scale), hi = rgauss(a, w, h, HI / scale);
    for (let i = 0; i < lo.length; i++) lo[i] -= hi[i];
    return lo;
  };
  const sq = new Float64Array(y.length), cu = new Float64Array(y.length);
  for (let i = 0; i < y.length; i++) { sq[i] = y[i] * y[i]; cu[i] = sq[i] * y[i]; }
  const cols = [bp(y), bp(sq), bp(cu)];
  const H = toolBasis(d, y, w, h, scale);
  for (const tool of TOOLS) cols.push(bp(H[tool][0]), bp(H[tool][1]));
  cols.push(bp(t));
  const Q = new Float64Array(NZ * NZ);
  for (let i = 0; i < ok.length; i++) {
    if (!ok[i]) continue;
    for (let a = 0; a < NZ; a++) {
      const za = cols[a][i];
      for (let b = a; b < NZ; b++) Q[a * NZ + b] += za * cols[b][i];
    }
  }
  for (let a = 0; a < NZ; a++) for (let b = 0; b < a; b++) Q[a * NZ + b] = Q[b * NZ + a];
  return { Q, n };
}

// ---------- the joint solve (detailfit.solve) ----------

const coef = (v) => [Math.max(v, 0), Math.max(-v, 0)];

function quad(Q, u, v) {                       // u^T Q v, Q NZ x NZ
  let s = 0;
  for (let a = 0; a < NZ; a++) {
    let r = 0;
    for (let b = 0; b < NZ; b++) r += Q[a * NZ + b] * v[b];
    s += u[a] * r;
  }
  return s;
}

/** Symmetric positive (semi)definite solve by Gaussian elimination with partial pivoting. */
function solveLinear(A, r, N) {
  const M = Float64Array.from(A), x = Float64Array.from(r);
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let i = c + 1; i < N; i++) if (Math.abs(M[i * N + c]) > Math.abs(M[p * N + c])) p = i;
    if (p !== c) {
      for (let j = 0; j < N; j++) { const t = M[c * N + j]; M[c * N + j] = M[p * N + j]; M[p * N + j] = t; }
      const t = x[c]; x[c] = x[p]; x[p] = t;
    }
    const piv = M[c * N + c];
    if (Math.abs(piv) < 1e-300) continue;
    for (let i = c + 1; i < N; i++) {
      const f = M[i * N + c] / piv;
      if (!f) continue;
      for (let j = c; j < N; j++) M[i * N + j] -= f * M[c * N + j];
      x[i] -= f * x[c];
    }
  }
  for (let c = N - 1; c >= 0; c--) {
    let s = x[c];
    for (let j = c + 1; j < N; j++) s -= M[c * N + j] * x[j];
    const piv = M[c * N + c];
    x[c] = Math.abs(piv) < 1e-300 ? 0 : s / piv;
  }
  return x;
}

/** Shared Clarity / Mid-range over the pairs' Gram matrices. v0 — the render's values, cal — its
 *  excess response on the plus tables (detailfit.CAL_WEB). Returns { values, raw, cost, cost0, pairs } as detailfit.solve. */
export function solve(grams, v0, cal = CAL) {
  const gs = grams.filter((g) => g);
  const T = TOOLS.length;
  if (!gs.length) {
    const values = {};
    for (const t of TOOLS) values[t] = Number(v0[t]);
    return { values, raw: { ...values }, cost: 0, cost0: 0, pairs: 0 };
  }
  const P = gs.length;
  const base = new Float64Array(NZ);
  base[3 + 2 * T] = 1;
  TOOLS.forEach((tool, k) => {
    const [cp, cm] = coef(Number(v0[tool]));
    base[3 + 2 * k] += cp + (cal[tool] ?? 0); base[3 + 2 * k + 1] += cm;
  });
  const Qs = gs.map((g) => {
    const e = Math.max(quad(g.Q, base, base), 1e-30);
    return g.Q.map((v) => v / e);
  });

  // columns of the per-pair selector: global unknown index for each z basis element (or -1)
  const fit = (signs, free) => {
    const N = 3 * P + free.length;
    const A = new Float64Array(N * N), r = new Float64Array(N);
    let c0 = 0;
    Qs.forEach((Q, p) => {
      const map = new Int32Array(NZ).fill(-1);       // z index -> unknown
      for (let j = 0; j < 3; j++) map[j] = 3 * p + j;
      free.forEach((k, j) => { map[3 + 2 * k + (signs[k] > 0 ? 0 : 1)] = 3 * P + j; });
      for (let a = 0; a < NZ; a++) {
        if (map[a] < 0) continue;
        let qr = 0;
        for (let b = 0; b < NZ; b++) qr += Q[a * NZ + b] * base[b];
        r[map[a]] += qr;
        for (let b = 0; b < NZ; b++) if (map[b] >= 0) A[map[a] * N + map[b]] += Q[a * NZ + b];
      }
      c0 += quad(Q, base, base);
    });
    const th = solveLinear(A, r, N);
    let tr = 0, tat = 0;
    for (let i = 0; i < N; i++) {
      tr += th[i] * r[i];
      let s = 0;
      for (let j = 0; j < N; j++) s += A[i * N + j] * th[j];
      tat += th[i] * s;
    }
    return { cost: c0 - 2 * tr + tat, th };
  };

  let best = null;
  for (let s = 0; s < 1 << T; s++) {
    const signs = TOOLS.map((_, k) => ((s >> (T - 1 - k)) & 1 ? -1 : 1));   // itertools.product order
    let free = TOOLS.map((_, k) => k);
    let res;
    for (;;) {
      res = fit(signs, free);
      const u = res.th.slice(3 * P);
      const neg = free.filter((k, j) => u[j] < 0);
      if (!neg.length) break;
      free = free.filter((k) => !neg.includes(k));
    }
    const vals = {};
    for (const t of TOOLS) vals[t] = 0;
    free.forEach((k, j) => { vals[TOOLS[k]] = signs[k] * res.th[3 * P + j]; });
    if (!best || res.cost < best.cost) best = { cost: res.cost, vals };
  }
  // the reference: the render's own values, the cubic free
  const e = Float64Array.from(base);
  TOOLS.forEach((tool, k) => {
    const [cp, cm] = coef(Number(v0[tool]));
    e[3 + 2 * k] -= cp; e[3 + 2 * k + 1] -= cm;
  });
  let cost0 = 0;
  for (const Q of Qs) {
    const A = new Float64Array(9), r = new Float64Array(3);
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < NZ; b++) r[a] += Q[a * NZ + b] * e[b];
      for (let b = 0; b < 3; b++) A[a * 3 + b] = Q[a * NZ + b];
    }
    const th = solveLinear(A, r, 3);
    let tat = 0, tr = 0;
    for (let a = 0; a < 3; a++) { tr += th[a] * r[a]; for (let b = 0; b < 3; b++) tat += th[a] * A[a * 3 + b] * th[b]; }
    cost0 += quad(Q, e, e) - 2 * tr + tat;
  }
  const values = {};
  for (const t of TOOLS) {
    const v = Math.min(RANGE[1], Math.max(RANGE[0], best.vals[t]));
    values[t] = roundHalfEven(v / STEP) * STEP + 0;
  }
  return { values, raw: best.vals, cost: best.cost / P, cost0: cost0 / P, pairs: P };
}

// ---------- the wizard's input: the fitted profile's render on the compare grid ----------

/** Y' of the fitted profile's render of an aligned linear frame (the compare geometry): develop
 *  -> profile LUT (33) -> its own detail values + the NX base detail, as the Renderer draws it.
 *  lin — Float32Array RGB with NaN outside the source. Returns { y, valid }. */
export function renderLuma({ dev, model, detail, control, lin, w, h, scale, lut = null }) {
  const n = w * h;
  const valid = new Uint8Array(n);
  const clean = new Float64Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const ok = lin[p] === lin[p] && lin[p + 1] === lin[p + 1] && lin[p + 2] === lin[p + 2];
    valid[i] = ok ? 1 : 0;
    if (ok) { clean[p] = lin[p]; clean[p + 1] = lin[p + 1]; clean[p + 2] = lin[p + 2]; }
  }
  const base = develop(dev, clean);
  const L = lut ?? buildLUT(model, control, 33);
  const prof = applyLUT(L, 33, base);
  const out = applyDetailCPU(detail, prof, w, h, control, { scale, base: true });
  return { y: luma(detail, out), valid };
}

/** The whole step for the fit worker. pairs: [{ name, lin, ty, w, h, scale }] (ty — the target's
 *  Y' on the same grid). onPair(i, n) after each pair; shouldCancel() between pairs, after a
 *  macrotask yield so a Worker's "cancel" message can land. cal — detailfit.CAL. Returns
 *  detailfit.solve's result, or null when cancelled. */
export async function fitDetailPairs({ dev, model, detail, control, pairs, onPair = () => {},
                                      shouldCancel = () => false, cal = CAL }) {
  const v0 = {};
  for (const t of TOOLS) v0[t] = Number(control[t]);
  const lut = buildLUT(model, control, 33);
  const grams = [];
  for (let i = 0; i < pairs.length; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (shouldCancel()) return null;
    const q = pairs[i];
    const r = renderLuma({ dev, model, detail, control, lin: q.lin, w: q.w, h: q.h, scale: q.scale, lut });
    const yt = Float64Array.from(q.ty);
    for (let k = 0; k < yt.length; k++) if (yt[k] !== yt[k]) { yt[k] = 0.5; r.valid[k] = 0; }
    grams.push(gram(detail, r.y, yt, r.valid, q.w, q.h, q.scale));
    onPair(i + 1, pairs.length);
  }
  if (shouldCancel()) return null;
  return solve(grams, v0, cal);
}

function roundHalfEven(x) {                    // np.round
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}
