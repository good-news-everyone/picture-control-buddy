// Display-only unsharp mask (spec/ui-zoom-plan.md D9, stage Z1). Pure and DOM-free.
//
// The Compare screen draws the RAW + NP3 render resampled to its on-screen size; at the fitted
// view that looks softer than the target JPEG (which carries the camera/Lightroom output
// sharpening). This function adds a small unsharp mask to that resampled copy. It never touches
// the render bitmap, the report, the fit, the export or the NP3.
//
// Luma only: the mask is computed on the luma (Rec.709 weights on the display-encoded values)
// and the same delta is added to R, G and B. Chroma stays put, so there are no color fringes
// on saturated edges (a per-channel mask over-sharpens one channel at a red/blue edge). Edges
// are clamped. Alpha is copied unchanged. Results are clamped to 0..255.

export const DEFAULT_SIGMA = 0.7;     // device px
export const DEFAULT_AMOUNT = 0.5;    // overridden by the calibrated constants in compare-view.js

function kernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

/** Separable Gaussian blur of a w×h Float32Array plane, clamped edges. Returns a new plane. */
export function gaussPlane(src, w, h, sigma) {
  const { k, r } = kernel(sigma);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * src[o + Math.min(w - 1, Math.max(0, x + i))];
      tmp[o + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = a;
    }
  }
  return out;
}

/** Unsharp mask on the luma of an RGBA image. data — Uint8ClampedArray (or Uint8Array) of
 *  w·h·4; returns a new Uint8ClampedArray. amount 0 (or sigma <= 0) returns an exact copy. */
export function unsharpRGBA(data, w, h, { sigma = DEFAULT_SIGMA, amount = DEFAULT_AMOUNT } = {}) {
  const out = new Uint8ClampedArray(data);
  if (!(amount > 0) || !(sigma > 0) || w < 1 || h < 1) return out;
  const n = w * h;
  const y = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4)
    y[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  const b = gaussPlane(y, w, h, sigma);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const d = amount * (y[i] - b[i]);
    out[p] = data[p] + d;          // Uint8ClampedArray rounds and clamps on assignment
    out[p + 1] = data[p + 1] + d;
    out[p + 2] = data[p + 2] + d;
  }
  return out;
}
