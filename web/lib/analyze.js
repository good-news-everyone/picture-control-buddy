// The report computation engine (stage 5A, spec/web-schemas.md §4): the browser port of
// analyze.py's region report — labels, bins, region sums, bin mean, totals, the summary,
// the report table, the per-pixel maps and the §4.4 download document. Pure TypedArray
// math with float64 accumulations like numpy, no DOM — runs in Node and Workers.
//
// Notes on the port, quirks included (Python is the source of truth):
// - binsOf takes no reportMask: analyze.bins has no mask and the shipped golden cache
//   (report/<key>__bins.u8) is unmasked; regionSums only consumes bins at reportMask
//   pixels anyway.
// - The table/summary/total shapes follow make_fit_golden.py's table_of/summary_of and
//   analyze.total/bin_mean/region_line — the fixtures' producers.
// - A fully clipped frame (reportMask all-zero) must not crash: like Python's
//   de.mean()/bin_mean on empty selections the scalar fields are NaN and the sums are 0.

import { srgbToLab, de2000 } from "./color.js";

export const GROUPS = ["greys", "skin", "warm saturated", "warm muted", "yellows", "greens",
                       "teal/water", "sky", "dark blues", "purple"];   // analyze.GROUPS
export const GREY_C = 5;           // analyze.GREY_C: chroma below this = greys
export const WARM_C = 35;          // analyze.WARM_C: saturated warm (orange vest, red car)
export const REPORT_SHARE = 0.01;  // analyze.REPORT_SHARE: smaller groups are not tabled
export const NBINS = 77;           // analyze.NBINS
const HUE_N_MIN = 20;              // analyze.region_line: the hue column needs nh > 20

const DEG = 180 / Math.PI;

// (chroma, hue deg 0..360) of one Lab row — analyze.polar
function polar1(lab, i) {
  const a = lab[i * 3 + 1], b = lab[i * 3 + 2];
  return [Math.hypot(a, b), (Math.atan2(b, a) * DEG % 360 + 360) % 360];
}

/**
 * GROUPS index per pixel (analyze.labels), first condition wins like np.select;
 * 255 where reportMask = 0. targetLab is (n, 3) L, a, b at the aligned resolution.
 */
export function labelsOf(targetLab, reportMask) {
  const n = targetLab.length / 3;
  const out = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) {
    if (!reportMask[i]) continue;
    const L = targetLab[i * 3];
    const [c, h] = polar1(targetLab, i);
    const warm = h < 75 || h >= 340;
    out[i] = c < GREY_C ? 0
      : warm && c >= WARM_C ? 2
      : h >= 30 && h < 70 && c >= 12 && L > 35 && L < 85 ? 1
      : warm ? 3
      : h < 100 ? 4
      : h < 170 ? 5
      : h < 220 ? 6
      : h < 300 && L > 45 ? 7
      : h < 300 ? 8
      : 9;
  }
  return out;
}

/**
 * 77 color bins per pixel (analyze.bins): chroma/10 (0..5) x hue/30 for chroma >= GREY_C,
 * greys separately 72 + clip(L//20, 0, 4). Computed for every pixel — analyze.bins has
 * no mask (see the module note).
 */
export function binsOf(targetLab) {
  const n = targetLab.length / 3;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const L = targetLab[i * 3];
    const [c, h] = polar1(targetLab, i);
    out[i] = c < GREY_C ? 72 + Math.min(Math.max(Math.floor(L / 20), 0), 4)
      : Math.min(Math.floor(c / 10), 5) * 12 + Math.floor(h / 30) % 12;
  }
  return out;
}

function emptySums() {
  return {
    n: new Float64Array(GROUPS.length), de: new Float64Array(GROUPS.length),
    dL: new Float64Array(GROUPS.length), dC: new Float64Array(GROUPS.length),
    dh: new Float64Array(GROUPS.length), nh: new Float64Array(GROUPS.length),
    bn: new Float64Array(NBINS), bde: new Float64Array(NBINS),
    all: NaN,
    tLabSum: new Float64Array(GROUPS.length * 3), pLabSum: new Float64Array(GROUPS.length * 3),
  };
}

/**
 * Sums for the report (analyze.region_sums, extended with tLabSum/pLabSum per §4.2):
 * per-group dE/dL/dC/dhue sums and per-bin dE sums over the reportMask pixels, in float64.
 * predSrgb is clipped to [0, 1] before the Lab conversion, as in Python; labels/bins are
 * the §4.1 caches (255 outside the mask). With no reportMask pixels the sums are all zero
 * and `all` is NaN — Python's de.mean() of an empty selection, without the warning.
 */
export function regionSums(predSrgb, targetLab, labels, bins, reportMask) {
  const n = targetLab.length / 3;
  const idx = [];
  for (let i = 0; i < n; i++) if (reportMask[i] && labels[i] < GROUPS.length) idx.push(i);
  const s = emptySums();
  const m = idx.length;
  if (!m) return s;
  const pred = new Float64Array(m * 3), targ = new Float64Array(m * 3);
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    for (let c = 0; c < 3; c++) {
      pred[k * 3 + c] = Math.min(1, Math.max(0, predSrgb[i * 3 + c]));
      targ[k * 3 + c] = targetLab[i * 3 + c];
    }
  }
  const lp = srgbToLab(pred);
  const de = de2000(lp, targ);
  let all = 0;
  for (let k = 0; k < m; k++) {
    const i = idx[k], g = labels[i], bin = bins[i];
    const d = de[k];
    all += d;
    s.n[g]++; s.de[g] += d;
    s.bn[bin]++; s.bde[bin] += d;
    const Lt = targ[k * 3];
    const [cp, hp] = polar1(lp, k);
    const [ct, ht] = polar1(targ, k);
    s.dL[g] += lp[k * 3] - Lt;
    s.dC[g] += cp - ct;
    if (ct > 8) {                     // the hue sum only where the target chroma is meaningful
      s.dh[g] += ((hp - ht + 180) % 360 + 360) % 360 - 180;
      s.nh[g]++;
    }
    for (let c = 0; c < 3; c++) {
      s.tLabSum[g * 3 + c] += targ[k * 3 + c];
      s.pLabSum[g * 3 + c] += lp[k * 3 + c];
    }
  }
  s.all = all / m;
  return s;
}

/** Mean dE over the color bins with at least minN pixels (analyze.bin_mean); NaN when none qualify. */
export function binMean(s, minN = 50) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < NBINS; i++) {
    if (s.bn[i] >= minN) { sum += s.bde[i] / s.bn[i]; cnt++; }
  }
  return cnt ? sum / cnt : NaN;
}

const SUM_KEYS = ["n", "de", "dL", "dC", "dh", "nh", "bn", "bde", "tLabSum", "pLabSum"];

/** Element-wise sums over per-frame regionSums (analyze.total); `all` is the mean of per-frame all. */
export function totalSums(rows) {
  const out = emptySums();
  for (const k of SUM_KEYS) {
    for (const r of rows) {
      for (let i = 0; i < out[k].length; i++) out[k][i] += r[k][i];
    }
  }
  if (rows.length) {
    let all = 0;
    for (const r of rows) all += r.all;
    out.all = all / rows.length;
  }
  return out;
}

/**
 * The §4.3 summary. neutralAll is the neutral-vs-target mean dE — cached per pair,
 * independent of profile edits (§4.1). fittedDelta is null at the step-2 draft.
 */
export function summaryOf(s, neutralAll, strength = 100, fittedDelta = null) {
  return { strength, renderDE: s.all, neutralDE: neutralAll, binMean: binMean(s), fittedDelta };
}

/**
 * The report table: one row per group with n >= max(minShare * total, 20)
 * (analyze.REPORT_SHARE / region_line); the means are the sums over n, the hue mean only
 * when nh > 20, else null.
 */
export function tableOf(s, minShare = REPORT_SHARE) {
  let total = 0;
  for (const v of s.n) total += v;
  const rows = [];
  for (let g = 0; g < GROUPS.length; g++) {
    const k = s.n[g];
    if (k < Math.max(minShare * total, HUE_N_MIN)) continue;
    rows.push({
      group: GROUPS[g], share: k / total, n: k,
      targetLab: [0, 1, 2].map((c) => s.tLabSum[g * 3 + c] / k),
      renderLab: [0, 1, 2].map((c) => s.pLabSum[g * 3 + c] / k),
      dE: s.de[g] / k, dL: s.dL[g] / k, dC: s.dC[g] / k,
      dh: s.nh[g] > HUE_N_MIN ? s.dh[g] / s.nh[g] : null,
    });
  }
  return rows;
}

const MAP_CHUNK = 4096;   // pixels per progress/cancel chunk in the Worker

/**
 * Per-pixel report maps (§4.3): dE/dL/dC/dh Float32Arrays, NaN outside the reportMask.
 * dh is the wrapped hue difference where the target chroma is meaningful, 0 on greys
 * (the same quantity that feeds regionSums.dh). onChunk (optional, may be async) is
 * called as onChunk(done, total) between chunks — the Worker posts progress and pumps
 * its message queue there, so cancellation is observed mid-computation; returning false
 * aborts the rest of the maps.
 */
export async function mapsOf(predSrgb, targetLab, reportMask, onChunk) {
  const n = targetLab.length / 3;
  const pred = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) pred[i] = Math.min(1, Math.max(0, predSrgb[i]));
  const lp = srgbToLab(pred);
  const dE = new Float32Array(n).fill(NaN), dL = new Float32Array(n).fill(NaN);
  const dC = new Float32Array(n).fill(NaN), dh = new Float32Array(n).fill(NaN);
  for (let c0 = 0; c0 < n; c0 += MAP_CHUNK) {
    const c1 = Math.min(c0 + MAP_CHUNK, n);
    const idx = [];
    for (let i = c0; i < c1; i++) if (reportMask[i]) idx.push(i);
    if (idx.length) {
      const a = new Float64Array(idx.length * 3), b = new Float64Array(idx.length * 3);
      for (let k = 0; k < idx.length; k++) {
        for (let c = 0; c < 3; c++) {
          a[k * 3 + c] = lp[idx[k] * 3 + c];
          b[k * 3 + c] = targetLab[idx[k] * 3 + c];
        }
      }
      const de = de2000(a, b);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const [cp, hp] = polar1(lp, i);
        const [ct, ht] = polar1(targetLab, i);
        dL[i] = lp[i * 3] - targetLab[i * 3];
        dC[i] = cp - ct;
        dh[i] = ct > 8 ? ((hp - ht + 180) % 360 + 360) % 360 - 180 : 0;
        dE[i] = de[k];
      }
    }
    if (onChunk && (await onChunk(c1, n)) === false) break;
  }
  return { dE, dL, dC, dh };
}

/**
 * The §4.4 JSON download document — versioned, self-contained, file names only
 * (summary, table, aggregate and parameters; no pixel maps). `generator` is supplied by
 * the caller ("np3-fit web <git describe>"); everything else is report data.
 */
export function downloadDoc({ generator, files, version, summary, table, aggregate, parameters }) {
  return { schemaVersion: 1, kind: "report", generator, files, version, summary, table,
           aggregate, parameters };
}
