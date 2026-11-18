// The NP3 curve as a pure operation: point normalization, natural cubic spline
// points -> table. A port of np3.curve_table / _natural_spline / _spline_value,
// the algorithm verified bit-exact against official samples (spec/np3-format.md).
import { pyRound, identityCurve } from "./np3.js";

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Editor point normalization: clamp 0..255, integers, sorted by x, no duplicates, at most 20. */
export function normalizePoints(points) {
  const seen = new Map();
  for (const [x, y] of points) {
    const nx = pyRound(clamp(Number(x), 0, 255));
    const ny = pyRound(clamp(Number(y), 0, 255));
    if (!seen.has(nx)) seen.set(nx, ny);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => [x, y]).slice(0, 20);
}

function naturalSpline(xs, ys) {
  const n = xs.length;
  if (n < 3) return new Array(n).fill(0);
  const h = Array.from({ length: n - 1 }, (_, i) => xs[i + 1] - xs[i]);
  const cp = new Array(n).fill(0);
  const dp = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = h[i - 1];
    const b = 2 * (h[i - 1] + h[i]) - a * cp[i - 1];
    const r = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1]);
    cp[i] = h[i] / b;
    dp[i] = (r - a * dp[i - 1]) / b;
  }
  const m = new Array(n).fill(0);
  for (let i = n - 2; i > 0; i--) m[i] = dp[i] - cp[i] * m[i + 1];
  return m;
}

function splineValue(xs, ys, m, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const h = xs[lo + 1] - xs[lo];
  const t = (x - xs[lo]) / h;
  const a = 1 - t, b = t;
  return a * ys[lo] + b * ys[lo + 1]
    + ((a ** 3 - a) * m[lo] + (b ** 3 - b) * m[lo + 1]) * h * h / 6;
}

/** Editor points -> {raw, points}: a 257-value table via a natural spline.
 *  Fewer than two points give the identity curve. */
export function curveTable(points) {
  const pts = normalizePoints(points);
  if (pts.length < 2) return identityCurve();
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  const m = naturalSpline(xs, ys);
  const raw = Array.from({ length: 257 }, (_, i) =>
    pyRound(clamp(splineValue(xs, ys, m, i * 255 / 256), 0, 255) * 32767 / 255));
  return { raw, points: pts };
}
