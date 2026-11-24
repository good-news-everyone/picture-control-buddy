// Deterministic sampling for the browser fit: ports of analyze.bins/frequency/rarity/
// weighted_sample, match.sample and the sampled part of match.Matcher.pair (the fit/test/
// near-white index sets, the de2000 weights, the profile Pixels). The numpy PRNG cannot be
// reproduced in JS (spec/web-schemas.md §6.4), so every choice goes through a seeded
// mulberry32 and golden tests inject the shipped indices from web/golden/sample/*.json.
// Development trust is 1 everywhere per spec §6.5 (the density export is not committed).
// Pure TypedArray math, no DOM — runs in Node and Workers.

import { srgbToLab, de2000, de2000Weights } from "./color.js";
import { Pixels, paramsOf } from "./profile.js";
import { develop, fit, fitAsync, controlOf, CLIP, NEAR_WHITE, CLIP_PIXELS, KC, FLAT_L } from "./fit.js";

export const PIXELS = 4000;        // match.PIXELS: the fit sample per pair
export const BRIGHT = 800;         // match.BRIGHT: extra highlights (they are rare)
const BRIGHT_Y = 0.75;             // fit.BRIGHT_Y
const LUMA = [0.299, 0.587, 0.114]; // model.LUMA
const GREY_C = 5;                  // analyze.GREY_C
const NBINS = 77;                  // analyze.NBINS
const POWER = 0.5;                 // analyze.POWER
const CAP = 10.0;                  // analyze.CAP

/** A small seeded PRNG (mulberry32); PCG64-exactness is explicitly not required (spec §6.4). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k distinct indices from [0, n) (lazy partial Fisher-Yates, replace=False). */
function choice(rng, n, k) {
  k = Math.min(k, n);
  const out = new Int32Array(k);
  const swaps = new Map();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const iv = swaps.has(i) ? swaps.get(i) : i;
    const jv = swaps.has(j) ? swaps.get(j) : j;
    out[i] = jv;
    swaps.set(j, iv);
  }
  return out;
}

/** k distinct values from an index array (match's rng.choice over a prefiltered list). */
function choiceOf(rng, idx, k) {
  const c = choice(rng, idx.length, k);
  return Int32Array.from(c, (i) => idx[i]);
}

/** Color bins: chroma/10 (0..5) x hue/30 for chroma >= 5; greys separately 72 + clip(L//20, 0, 4). Port of analyze.bins. */
export function binsOf(lab) {
  const n = lab.length / 3;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
    const c = Math.hypot(a, b);
    const h = (Math.atan2(b, a) * 180 / Math.PI % 360 + 360) % 360;
    if (c < GREY_C) out[i] = 72 + Math.min(Math.max(Math.floor(L / 20), 0), 4);
    else out[i] = Math.min(Math.floor(c / 10), 5) * 12 + Math.floor(h / 30) % 12;
  }
  return out;
}

/** Bin frequencies over the set, each frame with equal weight. Port of analyze.frequency. */
export function targetFrequency(labFrames) {
  const freq = new Float64Array(NBINS);
  for (const lab of labFrames) {
    const b = binsOf(lab);
    for (const v of b) freq[v] += 1 / b.length;
  }
  return Float64Array.from(freq, (v) => v / labFrames.length);
}

/** Desired pixel weight in the fit: rare colors weigh more. Port of analyze.rarity. */
export function rarityOf(freq, lab) {
  const fmax = Math.max(...freq);
  const w = new Float64Array(lab.length / 3);
  const b = binsOf(lab);
  for (let i = 0; i < w.length; i++) {
    const f = Math.max(freq[b[i]] / fmax, 1e-9);
    w[i] = Math.min(f ** -POWER, CAP);
  }
  return w;
}

/**
 * Poisson sampling with inclusion probability min(1, k*w) and correction multipliers.
 * Port of analyze.weighted_sample: the w/pi multiplier gives each picked pixel exactly its
 * weight w, the fit sees the "area x rarity" distribution with less noise.
 */
export function weightedSample(w, n, rng) {
  if (w.length <= n) {
    const idx = Int32Array.from({ length: w.length }, (_, i) => i);
    const mean = w.reduce((s, v) => s + v, 0) / w.length;
    return [idx, Float64Array.from(w, (v) => v / mean)];
  }
  let k = n / w.reduce((s, v) => s + v, 0);
  for (let t = 0; t < 30; t++) {           // k such that n are collected on average
    const pi = Float64Array.from(w, (v) => Math.min(1, k * v));
    const sum = pi.reduce((s, v) => s + v, 0);
    k *= n / sum;
  }
  const pi = Float64Array.from(w, (v) => Math.min(1, k * v));
  const pick = [];
  for (let i = 0; i < w.length; i++) if (rng() < pi[i]) pick.push(i);
  const mult = pick.map((i) => w[i] / pi[i]);
  const mean = mult.reduce((s, v) => s + v, 0) / mult.length;
  return [Int32Array.from(pick), Float64Array.from(mult, (v) => v / mean)];
}

/**
 * Indices for the fit (biased towards highlights), their weight multipliers and indices for
 * scoring (uniform). Port of match.sample; trust = 1 per spec §6.5. a is the developed
 * neutral, t the target (both flat (n, 3)); with the set's freq, rare colors are sampled
 * more often and mult gives them the rarity weight.
 */
export function sampleFit(a, t, rng, freq = null) {
  const n = t.length / 3;
  const keep = [];
  for (let i = 0; i < n; i++) {
    const m = Math.max(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
    if (m < CLIP) keep.push(i);
  }
  const keepA = Int32Array.from(keep);
  const bright = [];
  for (const i of keepA) {
    const lum = LUMA[0] * a[i * 3] + LUMA[1] * a[i * 3 + 1] + LUMA[2] * a[i * 3 + 2];
    const m = Math.max(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
    if (lum > BRIGHT_Y || m >= CLIP) bright.push(i);
  }
  let pick, mult;
  if (freq === null) {
    pick = choiceOf(rng, keepA, Math.min(PIXELS, keepA.length));
    mult = new Float64Array(pick.length).fill(1);
  } else {
    const keepLab = srgbToLab(gather(t, keepA));
    const w = rarityOf(freq, keepLab);              // trust = 1
    const wok = [], ok = [];
    for (let i = 0; i < w.length; i++) if (w[i] > 0) { ok.push(i); wok.push(w[i]); }
    const [i, m] = weightedSample(Float64Array.from(wok), PIXELS, rng);
    pick = Int32Array.from(i, (v) => keepA[ok[v]]);
    mult = m;
  }
  if (bright.length) {
    const extra = choiceOf(rng, Int32Array.from(bright), Math.min(BRIGHT, bright.length));
    const pick2 = new Int32Array(pick.length + extra.length);
    pick2.set(pick); pick2.set(extra, pick.length);
    const mult2 = new Float64Array(pick.length + extra.length);
    mult2.set(mult); mult2.fill(1, pick.length);
    pick = pick2; mult = mult2;
  }
  const test = choice(rng, n, Math.min(3000, n));
  return { pick, mult, test };
}

/** The near-white pinned set: target max >= CLIP and min >= NEAR_WHITE, at most CLIP_PIXELS. Port of match.Pair. */
export function nearWhiteSet(t, rng) {
  const idx = [];
  for (let i = 0; i < t.length / 3; i++) {
    const m = Math.max(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
    const mn = Math.min(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
    if (m >= CLIP && mn >= NEAR_WHITE) idx.push(i);
  }
  return idx.length ? choiceOf(rng, Int32Array.from(idx), Math.min(CLIP_PIXELS, idx.length))
                    : new Int32Array(0);
}

function gather(rows, idx) {
  const out = new Float64Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    out[i * 3] = rows[idx[i] * 3]; out[i * 3 + 1] = rows[idx[i] * 3 + 1]; out[i * 3 + 2] = rows[idx[i] * 3 + 2];
  }
  return out;
}

/**
 * The sampled fit pair: port of match.Matcher.pair (match.Pair). Develops the aligned linear
 * frame (x * gain) through the dev model, samples fit/scoring/near-white indices (or takes
 * the injected ones — the golden fixtures ship the exact numpy draws, spec §6.4), precomputes
 * the target Lab, the de2000 weight matrices (KC, FLAT_L) with sqrt(mult) folded in, and the
 * profile Pixels for the prediction. Everything fit.js/fit() consumes.
 */
export function prepareFitPair(o) {
  const xg = new Float64Array(o.x.length);
  for (let i = 0; i < xg.length; i++) xg[i] = o.x[i] * o.gain[i % 3];
  const b = develop(o.dev, xg);
  const t = o.t;
  let pick, mult, test, clip;
  if (o.indices) {
    ({ pick, mult, test, clip } = o.indices);
  } else {
    ({ pick, mult, test } = sampleFit(b, t, o.rng, o.freq ?? null));
    clip = nearWhiteSet(t, o.rng);
  }
  const bs = gather(b, pick), ts = gather(t, pick);
  const tlab = srgbToLab(ts);
  const W = de2000Weights(tlab, KC, FLAT_L);
  const sm = new Float64Array(pick.length);      // sqrt(mult): match.Pair.sm, the robust loss takes it out
  for (let i = 0; i < pick.length; i++) {
    const s = Math.sqrt(mult[i]);
    sm[i] = s;
    for (let j = 0; j < 9; j++) W[i * 9 + j] *= s;
  }
  const tb = gather(b, test), tt = gather(t, test);
  const cb = clip.length ? gather(b, clip) : null;
  const ct = clip.length ? gather(t, clip) : null;
  return {
    name: o.name, ncc: o.ncc ?? 0,
    n: pick.length,
    tlab, W, sm,
    px: new Pixels(o.model, bs),
    tb, tt, ttlab: srgbToLab(tt), tpx: new Pixels(o.model, tb),
    cpx: cb !== null ? new Pixels(o.model, cb) : null,
    ct,
    cmask: ct !== null ? Uint8Array.from(ct, (v) => (v >= CLIP ? 1 : 0)) : null,
    pick, mult, test, clip,
    b, t,                    // the whole developed frame and the target, for reports
  };
}

/** Mean dE2000 of the prediction against the target over the 3000-pixel uniform test sample. Port of Matcher.score. */
export function score(q, p) {
  const d = de2000(srgbToLab(q.tpx.apply(p)), q.ttlab);
  let s = 0;
  for (const v of d) s += v;
  return s / d.length;
}

/**
 * The full FREE browser fit — match.main's Matcher flow with no injected indices
 * (spec/web-schemas.md §6.4: the numpy draws cannot be reproduced, so free sampling is
 * validated only through the level-9 quality bar). The shared rarity freq is computed over
 * the non-clipped target pixels of every pair (match.target_frequency), then one mulberry32
 * stream is consumed pair by pair in the Matcher order (fit/bright/test draws, then the
 * near-white set), the LM fit runs from every STARTS entry (the lowest cost wins) and the result is converted to the
 * control (match.control) with the per-pair scores at the rounded control (Matcher.score).
 * prepared: [{name, ncc, x, y, gain}] — the prepared pair arrays; hooks: the lm lifecycle
 * hooks (Worker progress/cancel). Returns {x, cost, iterations, control, scores, qs, names}.
 */
export function runFreeFit(prepared, { dev, model, seed = 0, iters = 30, baseName = "fit", hooks = {} } = {}) {
  const qs = prepareFreeFit(prepared, { dev, model, seed });
  return finishFreeFit(fit(qs, iters, hooks), qs, prepared, model, baseName);
}

/**
 * runFreeFit with the Jacobian columns computed by a parallel helper pool (lib/fit-pool.js):
 * makePool(qs) -> {jacobian(x, m), terminate()}. Same sampling, same LM, same result.
 */
export async function runFreeFitParallel(prepared, { dev, model, seed = 0, iters = 30, baseName = "fit", hooks = {}, makePool }) {
  const qs = prepareFreeFit(prepared, { dev, model, seed });
  const pool = await makePool(qs);
  try {
    const r = await fitAsync(qs, iters, hooks, pool.jacobian);
    return finishFreeFit(r, qs, prepared, model, baseName);
  } finally {
    pool.terminate();
  }
}

/** The sampling half of runFreeFit: the shared rarity freq and the seeded per-pair samples. */
export function prepareFreeFit(prepared, { dev, model, seed = 0 }) {
  const labs = prepared.map((p) => {
    const keep = [];
    for (let i = 0; i < p.y.length / 3; i++) {
      if (Math.max(p.y[i * 3], p.y[i * 3 + 1], p.y[i * 3 + 2]) < CLIP) keep.push(i);
    }
    return srgbToLab(gather(p.y, Int32Array.from(keep)));
  });
  const freq = targetFrequency(labs);
  const rng = mulberry32(seed);
  return prepared.map((p) => prepareFitPair({
    name: p.name, ncc: p.ncc ?? 0,
    x: p.x, t: p.y, gain: p.gain, dev, model, rng, freq,
  }));
}

/** The result half of runFreeFit: the control and the per-pair scores at the rounded control. */
export function finishFreeFit(r, qs, prepared, model, baseName) {
  if (r.cancelled) return { ...r, qs, names: prepared.map((p2) => p2.name) };
  const control = controlOf(r.x, baseName);
  const p = paramsOf(JSON.parse(JSON.stringify(control)), model);
  const scores = qs.map((q) => {
    const dn = de2000(srgbToLab(q.tb), q.ttlab);
    let neutral = 0;
    for (const v of dn) neutral += v;
    return { pair: q.name, neutral: neutral / dn.length, prediction: score(q, p) };
  });
  return { ...r, control, scores, qs, names: prepared.map((p2) => p2.name) };
}
