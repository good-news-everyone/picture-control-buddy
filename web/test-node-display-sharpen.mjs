// Standalone checks for web/lib/display-sharpen.js (run: node web/test-node-display-sharpen.mjs).
import { unsharpRGBA, gaussPlane } from "./lib/display-sharpen.js";

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log("FAIL", msg); } else console.log("ok  ", msg); };
const mk = (w, h, f) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = f(x, y); const p = (y * w + x) * 4;
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = a;
  }
  return d;
};

// flat field unchanged
{
  const d = mk(17, 11, () => [120, 80, 200, 255]);
  const o = unsharpRGBA(d, 17, 11, { sigma: 1, amount: 1 });
  check(o.length === d.length && o.every((v, i) => v === d[i]), "flat field is unchanged");
}
// amount 0 identity, size, alpha
{
  const d = mk(23, 9, (x, y) => [(x * 11) & 255, (y * 29) & 255, (x * y) & 255, (x * 7 + y) & 255]);
  const o = unsharpRGBA(d, 23, 9, { sigma: 1, amount: 0 });
  check(o.length === d.length && o.every((v, i) => v === d[i]), "amount 0 is the identity");
  const s = unsharpRGBA(d, 23, 9, { sigma: 0.8, amount: 0.7 });
  check(s.length === d.length, "output size equals input size");
  let alphaSame = true, differs = false;
  for (let p = 0; p < d.length; p += 4) { if (s[p + 3] !== d[p + 3]) alphaSame = false; if (s[p] !== d[p]) differs = true; }
  check(alphaSame, "alpha is untouched");
  check(differs, "amount > 0 changes a textured image");
  check(s !== d, "returns a new array");
}
// step edge: overshoot matches the analytic unsharp response and sits on both sides
{
  const w = 40, h = 3, lo = 100, hi = 160, sigma = 1.5, amount = 0.8;
  const d = mk(w, h, (x) => { const v = x < 20 ? lo : hi; return [v, v, v, 255]; });
  const o = unsharpRGBA(d, w, h, { sigma, amount });
  // reference: naive 1-D gaussian, clamped edges
  const r = Math.ceil(sigma * 3), k = []; let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); s += v; }
  const ref = (x) => {
    let b = 0;
    for (let i = -r; i <= r; i++) b += k[i + r] / s * d[(Math.min(w - 1, Math.max(0, x + i))) * 4];
    return Math.round(Math.min(255, Math.max(0, d[x * 4] + amount * (d[x * 4] - b))));
  };
  let maxErr = 0;
  for (let x = 0; x < w; x++) maxErr = Math.max(maxErr, Math.abs(o[x * 4] - ref(x)));
  check(maxErr <= 1, `step edge matches the reference (max err ${maxErr})`);
  const over = o[20 * 4] - hi, under = lo - o[19 * 4];
  const A = hi - lo;
  check(over > 0 && under > 0, `overshoot on both sides (+${over}, -${under})`);
  // far from the edge the peak is about amount * A * (0.5 - tail) — bounded by amount * A / 2
  check(over <= amount * A * 0.5 + 1 && over >= amount * A * 0.1, `overshoot is a fraction of amount*step (${over} of ${(amount * A).toFixed(0)})`);
  check(o[0] === lo && o[(w - 1) * 4] === hi, "flat parts away from the edge are unchanged");
}
// clamping
{
  const w = 30, h = 1;
  const d = mk(w, h, (x) => { const v = x < 15 ? 5 : 250; return [v, v, v, 255]; });
  const o = unsharpRGBA(d, w, h, { sigma: 1, amount: 3 });
  check(o.every((v, i) => (i & 3) === 3 ? v === 255 : v >= 0 && v <= 255), "values stay within 0..255 (amount 3)");
  check(o[14 * 4] === 0 && o[15 * 4] === 255, "strong overshoot clamps at 0 and 255");
}
// luma only: a pure chroma edge (equal luma) is not changed much; hue is kept on a luma edge
{
  const w = 30, h = 1;
  const d = mk(w, h, (x) => x < 15 ? [200, 50, 50, 255] : [50, 120, 50, 255]);
  const o = unsharpRGBA(d, w, h, { sigma: 1, amount: 1 });
  check(o[14 * 4] - d[14 * 4] === o[14 * 4 + 1] - d[14 * 4 + 1] || o[14 * 4] === 255 || o[14 * 4 + 1] === 0 || o[14 * 4 + 1] === 255,
        "the same delta goes to R, G and B (luma-only mask)");
}
// gaussPlane preserves a constant and the mean
{
  const p = new Float32Array(50).fill(3.5);
  const b = gaussPlane(p, 10, 5, 1.2);
  check(b.every((v) => Math.abs(v - 3.5) < 1e-5), "gaussPlane keeps a constant plane");
}
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("all passed");
