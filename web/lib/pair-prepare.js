// Pair preparation: the pure browser port of devpairs.build(nef, target, devignette=True)
// (spec/web-schemas.md §2, level 1e of spec/web-tests.md). Pure TypedArray code — runs in Node
// and Workers, no DOM. The Python reference is devpairs.py + pairs.py + vignette.py, quirks
// included; every stage names its counterpart.
//
// Dataflow conventions discovered in devpairs.build (see spec/ui-plan.md stage 2):
//  - the target side is resampled in 8 bit (PIL RGB semantics, int32-quantized weights — the
//    resizeU8 path of resample.js); the aligned y is quantized to 1/255 by construction;
//  - the linear (RAW) side is float32: devignette and the radial/affine warps run at the
//    working size (max side LONG=768), the final shrink is a 3x3 box mean;
//  - devpairs.radial is numpy (float64 s/k, r^2 rounded to float32) — warpRadial of resample.js;
//  - the input `linear` is the developed frame WITHOUT the MX/MY margins (the browser decoder
//    crops them, like rawdev.develop()[MY:-MY, MX:-MX] in Python);
//  - orientation: the rot90 count is chosen by edge-correlation NCC against the target, over
//    both XMP angle signs, like devpairs.oriented.
//
// Embedded JPEG: the vignette estimate and the lens correction need the JPEG embedded in the
// RAW. `preparePair` extracts it from rawBytes with extractEmbeddedJpeg() (a pure port of the
// marker scan of pairs.embedded_jpeg) and decodes it through the injected `decodeJpeg` hook
// (the Worker passes a createImageBitmap-based one). For tests the decoded pixels can be given
// directly as `embedded` {data: Uint8Array RGB, w, h} — then rawBytes is not touched.

import { resizeF, resizeU8, rotate, warpAffine, warpRadial, shrink } from "./resample.js";

export const LONG = 768;             // devpairs.LONG
export const BOX = 3;                // devpairs.BOX
export const NCC_BAD = 0.6;          // analyze.NCC_BAD
export const CLIP = 0.98;            // match.CLIP
export const NEAR_WHITE = 0.8;       // match.NEAR_WHITE
const SHRINK = 6;                    // vignette.SHRINK
const MIN_PIXELS = 4000;             // vignette.MIN_PIXELS
const LUMA = [0.25, 0.5, 0.25];      // vignette.LUMA
const Y709 = [0.2126, 0.7152, 0.0722];  // vignette.Y709
const E22 = Math.fround(1 / 2.2);    // numpy casts the python-float exponent to float32

// vignette.KNOTS = np.linspace(-9, 0, 28): arange * step + start, the endpoint fixed to 0.
const KNOTS = Float64Array.from({ length: 28 }, (_, i) => (i === 27 ? 0 : i * (9 / 27) - 9));

const f32 = Math.fround;

// ------------------------------------------------------------------ small numpy/pil ports

// np.arange(start, stop, step) — length ceil((stop-start)/step), values start + i*step.
function arange(start, stop, step) {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  return Float64Array.from({ length: n }, (_, i) => start + i * step);
}

// np.linspace(start, stop, num) with endpoint (the last sample is exactly stop).
function linspace(start, stop, num) {
  const step = (stop - start) / (num - 1);
  return Float64Array.from({ length: num }, (_, i) => (i === num - 1 ? stop : start + i * step));
}

// PIL convert("L") on an 8-bit RGB image: (R*19595 + G*38470 + B*7471 + 0x8000) >> 16.
export function rgbToL(data, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 3, j++) {
    out[j] = (data[i] * 19595 + data[i + 1] * 38470 + data[i + 2] * 7471 + 0x8000) >> 16;
  }
  return out;
}

// pairs.grad: central differences, magnitude, minus the mean (Python computes in float32 from
// a float32 image; float64 here shifts NCC by ~1e-6, far inside the 1e-3 tolerance).
// g: gray values (Uint8Array or Float32Array/Float64Array), w*h. Returns Float64Array.
export function grad(g, w, h) {
  const gx = new Float64Array(w * h);
  const gy = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) gx[row + x] = g[row + x + 1] - g[row + x - 1];
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) gy[y * w + x] = g[(y + 1) * w + x] - g[(y - 1) * w + x];
  }
  const m = new Float64Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    m[i] = Math.hypot(gx[i], gy[i]);
    sum += m[i];
  }
  const mean = sum / (w * h);
  for (let i = 0; i < w * h; i++) m[i] -= mean;
  return m;
}

// pairs.ncc
export function ncc(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / (Math.sqrt(aa * bb) + 1e-9);
}

// devpairs.to_view: (clip(a,0,1) ** (1/2.2) * 255) as uint8 (numpy float32 chain, C truncation).
export function toView(a, w, h) {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < a.length; i++) {
    let v = a[i] < 0 ? 0 : a[i] > 1 ? 1 : a[i];
    v = f32(f32(Math.pow(v, E22)) * 255);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return out;
}

// color.srgb_to_linear (float64).
function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((Math.max(v, 0) + 0.055) / 1.055, 2.4);
}

// vignette.radius: r normalized so the corner is 1, measured from pixel centers (float64).
function radiusMap(w, h) {
  const out = new Float64Array(w * h);
  const den = Math.hypot(w / 2, h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / den;
    }
  }
  return out;
}

// np.gradient, uniform spacing 1, edge_order 1 (vignette.estimate's image gradient).
// Returns [d/dy, d/dx] as Float64Arrays.
function gradient2(m, w, h) {
  const gy = new Float64Array(w * h);
  const gx = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    gy[x] = m[w + x] - m[x];
    gy[(h - 1) * w + x] = m[(h - 1) * w + x] - m[(h - 2) * w + x];
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) gy[y * w + x] = (m[(y + 1) * w + x] - m[(y - 1) * w + x]) / 2;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    gx[row] = m[row + 1] - m[row];
    gx[row + w - 1] = m[row + w - 1] - m[row + w - 2];
    for (let x = 1; x < w - 1; x++) gx[row + x] = (m[row + x + 1] - m[row + x - 1]) / 2;
  }
  return [gy, gx];
}

// np.gradient(w, KNOTS): array spacing — the general (non-uniform) second-order path with
// first-order edges, since np.ndim(np.diff(KNOTS)) == 1.
function gradientKnots(wArr) {
  const n = wArr.length;
  const dx = Float64Array.from({ length: n - 1 }, (_, i) => KNOTS[i + 1] - KNOTS[i]);
  const out = new Float64Array(n);
  out[0] = (wArr[1] - wArr[0]) / dx[0];
  out[n - 1] = (wArr[n - 1] - wArr[n - 2]) / dx[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const dx1 = dx[i - 1], dx2 = dx[i];
    const a = -dx2 / (dx1 * (dx1 + dx2));
    const b = (dx2 - dx1) / (dx1 * dx2);
    const c = dx1 / (dx2 * (dx1 + dx2));
    out[i] = a * wArr[i - 1] + b * wArr[i] + c * wArr[i + 1];
  }
  return out;
}

// np.searchsorted(KNOTS, u, side="left"): first i with KNOTS[i] >= u.
function searchsorted(knots, u) {
  let lo = 0, hi = knots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (knots[mid] < u) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Dense linear solve A x = b (A n*n row-major Float64Array, mutated) — Gaussian elimination
// with partial pivoting; replaces np.linalg.solve for the small normal systems of
// vignette.fit (the +1e-3 / +1e-6 identity keeps them well-conditioned, a direct solve is exact).
function solve(A, b, n) {
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[piv * n + col])) piv = r;
    if (piv !== col) {
      for (let k = col; k < n; k++) {
        const t = A[col * n + k];
        A[col * n + k] = A[piv * n + k];
        A[piv * n + k] = t;
      }
      const t = b[col];
      b[col] = b[piv];
      b[piv] = t;
    }
    const d = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / d;
      if (f === 0) continue;
      for (let k = col; k < n; k++) A[r * n + k] -= f * A[col * n + k];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

// ------------------------------------------------------------------ devpairs.fit_radial
// Score: grad of (radial(v, s, k) @ [.3,.6,.1] -> float32 -> *255) against the target gradient.
function radialScore(vf, w, h, gt, s, k) {
  const r = warpRadial(vf, w, h, s, k, 3).data;
  const t = new Float32Array(w * h);
  for (let i = 0, j = 0; i < r.length; i += 3, j++) {
    const v = f32(r[i] * 0.3 + r[i + 1] * 0.6 + r[i + 2] * 0.1);
    t[j] = f32(v * 255);
  }
  return ncc(grad(t, w, h), gt);
}

// devpairs.fit_radial: the (s, k) grid search, then two 3x3 refinements.
// a: float32 linear RGB, target: its rgbToL. Returns [bestV, s, k].
export function fitRadial(a, w, h, targetL, tw, th) {
  const gt = grad(targetL, tw, th);
  const vf = new Float32Array(w * h * 3);
  for (let i = 0; i < a.length; i++) {
    const v = a[i] < 0 ? 0 : a[i] > 1 ? 1 : a[i];
    vf[i] = f32(Math.pow(v, E22));
  }
  const tryScore = (s, k) => radialScore(vf, w, h, gt, s, k);
  let best = [-2, 0.98, -0.08];
  for (const s of arange(0.98, 1.1, 0.01)) {
    for (const k of arange(-0.08, 0.081, 0.02)) {
      const v = tryScore(s, k);
      if (v > best[0]) best = [v, s, k];
    }
  }
  for (const step of [0.004, 0.002]) {
    const [, s0, k0] = best;
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        const s = s0 + i * step, k = k0 + j * step * 2;
        const v = tryScore(s, k);
        if (v > best[0]) best = [v, s, k];
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ pairs.align
// The scale/shift grid search on edge-correlation NCC at the caller's (half) resolution.
// src, dst: 8-bit RGB. Returns [bestV, s, dx, dy] (dx, dy in these pixels; the caller
// multiplies by 2, like pairs.build/devpairs.matched do).
export function align(src, sw, sh, dst, dw, dh) {
  const gd = grad(rgbToL(dst, dw, dh), dw, dh);
  let gdss = 0;
  for (let i = 0; i < gd.length; i++) gdss += gd[i] * gd[i];
  const gray = new Float64Array(dw * dh);         // scratch: the warped gray image
  const mag = new Float64Array(dw * dh);          // scratch: its gradient magnitude
  const span = Math.max(dw, dh) * 0.03;
  const warped = new Uint8Array(dw * dh * 3);

  const score = (s, dx, dy) => {
    const a = 1 / s;
    const m = [a, 0, dw / 2 - a * (dw / 2 + dx), 0, a, dh / 2 - a * (dh / 2 + dy)];
    const out = warpAffineInto(src, sw, sh, dw, dh, m, warped);
    // rgbToL + grad + ncc over the warped frame (grad first, centering needs the mean)
    for (let i = 0, p = 0; i < gray.length; i++, p += 3) {
      gray[i] = (out[p] * 19595 + out[p + 1] * 38470 + out[p + 2] * 7471 + 0x8000) >> 16;
    }
    let sum = 0;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const i = y * dw + x;
        const gx = x > 0 && x < dw - 1 ? gray[i + 1] - gray[i - 1] : 0;
        const gy = y > 0 && y < dh - 1 ? gray[i + dw] - gray[i - dw] : 0;
        mag[i] = Math.hypot(gx, gy);
        sum += mag[i];
      }
    }
    const mean = sum / (dw * dh);
    let ab = 0, aa = 0;
    for (let i = 0; i < mag.length; i++) {
      const d = mag[i] - mean;
      ab += d * gd[i];
      aa += d * d;
    }
    return ab / (Math.sqrt(aa * gdss) + 1e-9);
  };

  let best = [-2, 1.0, 0, 0];
  const consider = (s, dx, dy) => {
    const v = score(s, dx, dy);
    if (v > best[0]) best = [v, s, dx, dy];
  };
  for (const s of arange(0.97, 1.0301, 0.005)) {
    for (const dx of linspace(-span, span, 9)) {
      for (const dy of linspace(-span, span, 9)) consider(s, dx, dy);
    }
  }
  let [, s0, x0, y0] = best;
  let step = span / 4;
  for (let round = 0; round < 3; round++) {
    step /= 2;
    for (const s of [s0 - 0.002, s0, s0 + 0.002]) {
      for (const dx of [x0 - step, x0, x0 + step]) {
        for (const dy of [y0 - step, y0, y0 + step]) consider(s, dx, dy);
      }
    }
    [, s0, x0, y0] = best;
  }
  return best;
}

// warpAffine writing into a reused output buffer (the align hot loop).
function warpAffineInto(src, sw, sh, dw, dh, m, out) {
  const r = warpAffine(src, sw, sh, dw, dh, m, "bilinear", { dtype: "u8", channels: 3 });
  out.set(r.data);
  return out;
}

// ------------------------------------------------------------------ pairs.apply_crop
// The XMP crop: rotate about the crop center (BICUBIC, each channel float), then the integer
// corner box — PIL pads out-of-range with black. Returns float32 RGB.
export function applyCrop(lin, w, h, xmp, sign) {
  if (xmp.HasCrop !== "True") return { data: lin, w, h };
  const l = parseFloat(xmp.CropLeft ?? 0), t = parseFloat(xmp.CropTop ?? 0);
  const r = parseFloat(xmp.CropRight ?? 1), b = parseFloat(xmp.CropBottom ?? 1);
  const ang = parseFloat(xmp.CropAngle ?? 0) * sign;
  const cx = (l + r) / 2 * w, cy = (t + b) / 2 * h;
  const a = ang * Math.PI / 180;
  const dx = (r - l) * w, dy = (b - t) * h;
  const cw = Math.abs(dx * Math.cos(a) + dy * Math.sin(a));
  const ch = Math.abs(dy * Math.cos(a) - dx * Math.sin(a));
  let im = { data: lin, w, h };
  if (Math.abs(ang) > 1e-3) {
    im = rotate(lin, w, h, ang, "bicubic", { center: [cx, cy], dtype: "f32", channels: 3 });
  }
  const x0 = Math.trunc(cx - cw / 2), y0 = Math.trunc(cy - ch / 2);
  const x1 = Math.trunc(cx + cw / 2), y1 = Math.trunc(cy + ch / 2);
  const ow = x1 - x0, oh = y1 - y0;
  const out = new Float32Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= im.h) continue;
    for (let x = 0; x < ow; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= im.w) continue;
      const si = (sy * im.w + sx) * 3, di = (y * ow + x) * 3;
      out[di] = im.data[si];
      out[di + 1] = im.data[si + 1];
      out[di + 2] = im.data[si + 2];
    }
  }
  return { data: out, w: ow, h: oh };
}

// np.rot90(a, r) counter-clockwise, interleaved RGB.
function rot90(data, w, h, r) {
  r = ((r % 4) + 4) % 4;
  if (r === 0) return { data, w, h };
  let cur = { data, w, h };
  for (let i = 0; i < r; i++) {
    const out = new Float32Array(cur.w * cur.h * 3);
    const nw = cur.h, nh = cur.w;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const si = (x * cur.w + (cur.w - 1 - y)) * 3, di = (y * nw + x) * 3;
        out[di] = cur.data[si];
        out[di + 1] = cur.data[si + 1];
        out[di + 2] = cur.data[si + 2];
      }
    }
    cur = { data: out, w: nw, h: nh };
  }
  return cur;
}

// ------------------------------------------------------------------ vignette.estimate
// y = T(x + a r^2 + b r^4) in stops: the shared piecewise-linear curve T and (a, b) are fit by
// three IRLS-style iterations (vignette.fit). lin: float32 margin-cropped development.
export function estimateVignette(lin, lw, lh, emb) {
  if (!emb) return { a: 0, b: 0 };
  const small = shrink(lin, lw, lh, SHRINK, 3);
  const jpeg = resizeU8(emb.data, small.w, small.h, emb.w, emb.h, "box", 3);
  const [, s, k] = fitRadial(small.data, small.w, small.h, rgbToL(jpeg.data, jpeg.w, jpeg.h), jpeg.w, jpeg.h);
  const small2 = warpRadial(small.data, small.w, small.h, s, k, 3).data;
  const n = small.w * small.h;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const mean = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = jpeg.data[j] / 255, g = jpeg.data[j + 1] / 255, b = jpeg.data[j + 2] / 255;
    y[i] = srgbToLinear(r) * Y709[0] + srgbToLinear(g) * Y709[1] + srgbToLinear(b) * Y709[2];
    x[i] = small2[j] * LUMA[0] + small2[j + 1] * LUMA[1] + small2[j + 2] * LUMA[2];
    mean[i] = (r + g + b) / 3;
  }
  const [gy, gx] = gradient2(mean, small.w, small.h);
  const rad = radiusMap(small.w, small.h);
  const xs = [], ys = [], rs = [];
  for (let i = 0; i < n; i++) {
    if (Math.hypot(gx[i], gy[i]) < 0.03 && y[i] > 0.004 && y[i] < 0.85
        && x[i] > 2e-3 && Math.max(small2[i * 3], small2[i * 3 + 1], small2[i * 3 + 2]) < 0.95) {
      xs.push(Math.log2(x[i]));
      ys.push(Math.log2(y[i]));
      rs.push(rad[i]);
    }
  }
  if (xs.length < MIN_PIXELS) return { a: 0, b: 0 };
  return vignetteFit(Float64Array.from(xs), Float64Array.from(ys), Float64Array.from(rs));
}

// vignette.fit — port of the small least-squares (numpy lstsq on the normal system; the
// 28x28 system is SPD with the 1e-3 ridge, a direct solve is what LAPACK does too).
function vignetteFit(x, y, r) {
  let a = 0, b = 0;
  const r2 = Float64Array.from(r, (v) => v * v);
  const r4 = Float64Array.from(r2, (v) => v * v);
  const n = x.length;
  for (let iter = 0; iter < 3; iter++) {
    const u = new Float64Array(n);
    for (let i = 0; i < n; i++) u[i] = x[i] + a * r2[i] + b * r4[i];
    // A in normal form: A[n, i] = 1-f, A[n, i+1] = f — accumulate AtA and At y directly.
    const AtA = new Float64Array(28 * 28);
    const Atb = new Float64Array(28);
    const idx = new Int32Array(n);
    const fr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let ii = searchsorted(KNOTS, u[i]) - 1;
      if (ii < 0) ii = 0; else if (ii > 26) ii = 26;
      const f = (u[i] - KNOTS[ii]) / (KNOTS[ii + 1] - KNOTS[ii]);
      idx[i] = ii;
      fr[i] = f;
      const g0 = 1 - f;
      AtA[ii * 28 + ii] += g0 * g0;
      AtA[ii * 28 + ii + 1] += g0 * f;
      AtA[(ii + 1) * 28 + ii] += f * g0;
      AtA[(ii + 1) * 28 + ii + 1] += f * f;
      Atb[ii] += g0 * y[i];
      Atb[ii + 1] += f * y[i];
    }
    for (let i = 0; i < 28; i++) AtA[i * 28 + i] += 1e-3;
    const w = solve(AtA, Atb, 28);
    const slope = gradientKnots(w);
    // D = [slope * r2, slope * r4]; solve (Dt D + 1e-6 I) d = Dt (y - A w)
    let d00 = 1e-6, d01 = 0, d11 = 1e-6, e0 = 0, e1 = 0;
    for (let i = 0; i < n; i++) {
      const aw = w[idx[i]] * (1 - fr[i]) + w[idx[i] + 1] * fr[i];
      const res = y[i] - aw;
      const c0 = slope[idx[i]] * r2[i];
      const c1 = slope[idx[i]] * r4[i];
      d00 += c0 * c0;
      d01 += c0 * c1;
      d11 += c1 * c1;
      e0 += c0 * res;
      e1 += c1 * res;
    }
    const det = d00 * d11 - d01 * d01;
    a += (d11 * e0 - d01 * e1) / det;
    b += (d00 * e1 - d01 * e0) / det;
  }
  return { a, b };
}

// vignette.correct: lin * 2^(a r^2 + b r^4) — the gain is computed in float64, cast to float32
// (numpy: gain(...).astype(float32) * float32 lin), stored float32.
export function correctVignette(lin, w, h, a, b) {
  const rad = radiusMap(w, h);
  const out = new Float32Array(lin.length);
  for (let i = 0, j = 0; i < rad.length; i++, j += 3) {
    const r2 = rad[i] * rad[i];
    const g = f32(Math.pow(2, a * r2 + b * r2 * r2));
    out[j] = f32(lin[j] * g);
    out[j + 1] = f32(lin[j + 1] * g);
    out[j + 2] = f32(lin[j + 2] * g);
  }
  return out;
}

// devpairs.lens_corrected: the radial correction from the embedded JPEG, applied before the
// XMP crop (only when the XMP has a crop — the caller decides). Returns
// { data, w, h, scale, k } or null when there is no embedded JPEG.
export function lensCorrected(lin, w, h, emb) {
  if (!emb) return null;
  const size = [384, Math.round(384 * h / w)];
  const small = resizeF(lin, size[0], size[1], w, h, "box", 3);
  const embS = resizeU8(emb.data, size[0], size[1], emb.w, emb.h, "bilinear", 3);
  const [, s, k] = fitRadial(small.data, small.w, small.h, rgbToL(embS.data, embS.w, embS.h), embS.w, embS.h);
  const out = warpRadial(lin, w, h, s, k, 3).data;
  return { data: out, w, h, scale: s, k };
}

// ------------------------------------------------------------------ devpairs.oriented
// The rot90 count (and the XMP angle sign) that best matches the target shape and edges.
function oriented(candidates, tgtU8, tw, th) {
  const k = 192 / Math.max(tw, th);
  const size = [Math.round(tw * k), Math.round(th * k)];
  const gt = grad(rgbToL(resizeU8(tgtU8, size[0], size[1], tw, th, "bilinear", 3).data, size[0], size[1]), size[0], size[1]);
  const aspect = tw / th;
  let best = null, bestA = null;
  let orientation = 0, angleSign = 1;
  for (const sign of [1, -1]) {
    const c = candidates(sign);
    for (let r = 0; r < 4; r++) {
      const a = rot90(c.data, c.w, c.h, r);
      if (Math.abs(a.w / a.h / aspect - 1) > 0.06) continue;
      const view = toView(a.data, a.w, a.h);
      const small = resizeU8(view, size[0], size[1], a.w, a.h, "bilinear", 3);
      const g = grad(rgbToL(small.data, size[0], size[1]), size[0], size[1]);
      const v = ncc(g, gt);
      if (best === null || v > best) {
        best = v;
        bestA = a;
        orientation = r;
        angleSign = sign;
      }
    }
  }
  if (best === null) throw new Error("target shape does not match the frame: cropping without XMP is not supported");
  return { a: bestA, orientation, angleSign };
}

// ------------------------------------------------------------------ preparePair
// The pure half of pairs.embedded_jpeg: the largest JPEG inside the RAW. Python opens every
// \xff\xd8\xff candidate with PIL and keeps the widest one that opens; a pure port cannot run
// a decoder, so jpegDimensions() ports what makes PIL's Image.open accept or reject a candidate
// (JpegImageFile._open's marker walk + Image.open's decompression-bomb error). Accepting a
// candidate PIL rejects is not harmless: RAW sensor data contains \xff\xd8\xff runs that parse
// as a "huge SOF15" frame, which wins the width race and then fails in the browser decoder
// ("The source image could not be decoded"). Returns the JPEG bytes (SOI to EOI) or null.
export function extractEmbeddedJpeg(rawBytes) {
  let best = null;
  for (const c of embeddedJpegCandidates(rawBytes)) if (!best || c.w > best.w) best = c;
  return best ? rawBytes.slice(best.offset, best.end) : null;
}

// Every \xff\xd8\xff offset PIL would open, in file order: [{offset, w, h, end}] (level 1j).
export function embeddedJpegCandidates(rawBytes) {
  const out = [];
  for (let p = 0; p + 4 <= rawBytes.length - 1; p++) {
    if (rawBytes[p] !== 0xFF || rawBytes[p + 1] !== 0xD8 || rawBytes[p + 2] !== 0xFF) continue;
    const dims = jpegDimensions(rawBytes, p);
    if (dims) out.push({ offset: p, w: dims[0], h: dims[1], end: dims[2] });
  }
  return out;
}

// PIL Image.MAX_IMAGE_PIXELS: Image.open raises DecompressionBombError above twice this many
// pixels (pairs.embedded_jpeg skips the candidate).
const PIL_MAX_IMAGE_PIXELS = 89478485;
const isSofMarker = (i) => (i >= 0xFFC0 && i <= 0xFFCF && i !== 0xFFC4 && i !== 0xFFC8 && i !== 0xFFCC)
  || i === 0xFFDE;                                  // DHP uses the SOF handler in PIL
const noHandler = (i) => i === 0xFFC8 || (i >= 0xFFD0 && i <= 0xFFD9) || (i >= 0xFFF0 && i <= 0xFFFD);

// The port of PIL JpegImageFile._open (Pillow 12) on b[from:], up to the first SOS. Returns
// [width, height, offsetPastEOI] when PIL would open the candidate, else null:
//   - every marker FFC0..FFFE is known; a handler reads a 2-byte length and the payload
//     (a truncated payload -> reject); FFFF is padding, FF00 escaped data, other FF xx -> reject;
//     non-FF bytes between markers are skipped as junk; EOF before SOS -> reject;
//   - SOF*/DHP: 8-bit precision and 1, 3 or 4 components, else reject; the last SOF wins;
//   - DQT: every table must be complete (1 + 64 * precision bytes);
//   - no SOF before SOS, or a zero width/height -> ImageFile's "not identified" (reject);
//   - width * height > 2 * MAX_IMAGE_PIXELS -> the decompression-bomb error (reject).
// The APPn payload parsing (JFIF density, Adobe) is not ported: its rare short-segment errors
// are not reproduced.
function jpegDimensions(b, from) {
  const n = b.length;
  if (from + 3 > n || b[from] !== 0xFF || b[from + 1] !== 0xD8 || b[from + 2] !== 0xFF) return null;
  let q = from + 3;                                 // the next unread byte
  let cur = 0xFF;                                   // s = b"\xff"
  let w = 0, h = 0, sof = false;
  for (;;) {
    if (cur !== 0xFF) {                             // skip non-0xFF junk
      if (q >= n) return null;
      cur = b[q++];
      continue;
    }
    if (q >= n) return null;
    const i = 0xFF00 | b[q++];
    if (i >= 0xFFC0 && i <= 0xFFFE) {
      if (!noHandler(i)) {
        if (q + 2 > n) return null;
        const len = (b[q] << 8) | b[q + 1];
        q += 2;
        const size = len - 2;
        if (size < 0 || q + size > n) return null;
        if (isSofMarker(i)) {
          if (size < 6) return null;
          if (b[q] !== 8) return null;                                  // "cannot handle N-bit layers"
          const layers = b[q + 5];
          if (layers !== 1 && layers !== 3 && layers !== 4) return null; // "cannot handle N-layer images"
          h = (b[q + 1] << 8) | b[q + 2];
          w = (b[q + 3] << 8) | b[q + 4];
          sof = true;
        } else if (i === 0xFFDB) {
          for (let t = q, end = q + size; t < end;) {
            const qtLength = 1 + (b[t] >> 4 === 0 ? 1 : 2) * 64;
            if (end - t < qtLength) return null;                         // "bad quantization table marker"
            t += qtLength;
          }
        }
        q += size;
      }
      if (i === 0xFFDA) break;                      // SOS: the image data starts
      if (q >= n) return null;
      cur = b[q++];
    } else if (i === 0xFFFF) {
      cur = 0xFF;                                   // padding
    } else if (i === 0xFF00) {
      if (q >= n) return null;
      cur = b[q++];
    } else {
      return null;                                  // "no marker found"
    }
  }
  if (!sof || w <= 0 || h <= 0) return null;     // ImageFile: "not identified by this driver"
  if (w * h > 2 * PIL_MAX_IMAGE_PIXELS) return null;
  // the end: the first FF D9 after the scan header (a stuffed FF 00 cannot form FF D9)
  let e = q;
  while (e + 1 < n && !(b[e] === 0xFF && b[e + 1] === 0xD9)) e++;
  return [w, h, Math.min(e + 2, n)];
}

// ------------------------------------------------------------------ preparePair
/**
 * The browser port of devpairs.build(nef, target, devignette=True) — spec/web-schemas.md §2.
 * input:
 *   linear:    Float32Array RGB 0..1, the developed frame WITHOUT the MX/MY margins
 *   lw, lh:    its geometry
 *   targetRgb: Float32Array RGB 0..1 (the decodeTarget output) — or targetU8, the same
 *              pixels pre-quantized to uint8 (a transfer optimization; both are exact)
 *   tw, th:    the target geometry
 *   xmp:       parseXmp() of the target
 *   rawBytes:  the RAW file bytes (the embedded JPEG source)
 *   unrotate:  optional 0..3 — rot90 steps to APPLY to `linear` at entry, bringing the
 *              decoder-rotated frame (the browser decoder rotates by the EXIF tag, like
 *              render.linear) back to the sensor frame of rawdev.develop, which
 *              devpairs.oriented works on. = (4 - render.TURNS[orientation]) % 4.
 *   gain:      [r, g, b] linear coefficients (match.edit_gain) — passed through
 *   gainNote:  string | null — passed through
 *   embedded:  optional {data: Uint8Array RGB, w, h} — the decoded embedded JPEG (tests);
 *              when absent it is extracted from rawBytes and decoded with decodeJpeg
 *   decodeJpeg: async (bytes) => {data: Uint8Array RGB, w, h} — the codec hook (browser)
 *   onProgress: (stage) => void — decode/vignette/crop/orient/radial/align/shrink
 *   shouldCancel: () => bool — checked between stages and inside the search loops;
 *              when true preparePair returns null without a result
 * Returns the PreparedPair, or null when cancelled. Throws on unrecoverable stage errors
 * (the Worker converts them to an error message; a shape mismatch is one of them, like
 * devpairs.oriented raising ValueError).
 */
export async function preparePair(input) {
  const { tw, th, xmp, gain, gainNote } = input;
  let { lw, lh } = input;
  let linear = input.linear;
  if (!linear || !lw || !lh || !tw || !th || Math.min(lw, lh, tw, th) < 8) {
    throw Object.assign(new Error("invalid pair input"), { code: "raw_unreadable" });
  }
  const onProgress = input.onProgress ?? (() => {});
  const cancelled = () => input.shouldCancel && input.shouldCancel();

  // the decoder convention (render.linear / rawler) back to the sensor frame of rawdev.develop
  const unr = ((input.unrotate ?? 0) % 4 + 4) % 4;
  if (unr) {
    const r = rot90(linear, lw, lh, unr);
    linear = r.data;
    lw = r.w;
    lh = r.h;
  }

  // the target side works in 8 bit, like pairs.py (decodeTarget gives exactly u8/255 floats)
  let tgtU8;
  if (input.targetU8) {
    tgtU8 = input.targetU8;
  } else {
    if (!input.targetRgb) throw Object.assign(new Error("invalid pair input"), { code: "target_unreadable" });
    tgtU8 = new Uint8Array(tw * th * 3);
    for (let i = 0; i < tgtU8.length; i++) {
      const v = Math.round(Math.max(0, Math.min(1, input.targetRgb[i])) * 255);
      tgtU8[i] = v;
    }
  }

  // ---- decode: the embedded JPEG (vignette + lens correction source)
  onProgress("decode");
  let emb = input.embedded ?? null;
  if (!emb && input.rawBytes) {
    const jpegBytes = extractEmbeddedJpeg(input.rawBytes);
    if (jpegBytes && input.decodeJpeg) emb = await input.decodeJpeg(jpegBytes);
  }
  if (cancelled()) return null;

  // ---- devignette (vignette.coefficients + vignette.correct, before the crop)
  onProgress("vignette");
  const ab = estimateVignette(linear, lw, lh, emb);
  let lin = correctVignette(linear, lw, lh, ab.a, ab.b);
  if (cancelled()) return null;

  // ---- the lens correction from the embedded JPEG (devpairs.lens_corrected; only with a crop)
  onProgress("crop");
  let lens = null;
  if (xmp.HasCrop === "True" && emb) {
    const lc = lensCorrected(lin, lw, lh, emb);
    if (lc) {
      lens = { scale: lc.scale, k: lc.k };
      lin = lc.data;
    }
  }
  const crop1 = applyCrop(lin, lw, lh, xmp, 1);
  if (cancelled()) return null;

  // ---- orientation + angle sign (devpairs.oriented over both crop variants)
  onProgress("orient");
  const ori = oriented((sign) => (sign === 1 ? crop1 : applyCrop(lin, lw, lh, xmp, -1)), tgtU8, tw, th);
  if (cancelled()) return null;

  // ---- working size, radial fit, align, warps, shrink (devpairs.matched)
  let mt = null;
  {
    const k = LONG / Math.max(tw, th);
    const W = Math.round(tw * k), H = Math.round(th * k);
    const tS = resizeU8(tgtU8, W, H, tw, th, "lanczos", 3);
    const small = [W >> 1, H >> 1];
    const aS = resizeF(ori.a.data, W, H, ori.a.w, ori.a.h, "box", 3);
    const half = resizeF(aS.data, small[0], small[1], W, H, "box", 3);
    const tHalfL = rgbToL(resizeU8(tS.data, small[0], small[1], W, H, "bilinear", 3).data, small[0], small[1]);
    onProgress("radial");
    const [, s, kr] = fitRadial(half.data, half.w, half.h, tHalfL, small[0], small[1]);
    const aR = { data: warpRadial(aS.data, W, H, s, kr, 3).data, w: W, h: H };
    const view = toView(aR.data, W, H);
    const vHalf = resizeU8(view, small[0], small[1], W, H, "bilinear", 3);
    const tHalf = resizeU8(tS.data, small[0], small[1], W, H, "bilinear", 3);
    if (cancelled()) return null;
    onProgress("align");
    const [v, s2, dx, dy] = align(vHalf.data, small[0], small[1], tHalf.data, small[0], small[1]);
    if (cancelled()) return null;
    onProgress("shrink");
    const sc = 1 / s2;
    const m = [sc, 0, W / 2 - sc * (W / 2 + dx * 2), 0, sc, H / 2 - sc * (H / 2 + dy * 2)];
    const aW = warpAffine(aR.data, W, H, W, H, m, "bilinear", { dtype: "f32", channels: 3 }).data;
    const y = new Float32Array(W * H * 3);
    for (let i = 0; i < y.length; i++) y[i] = f32(tS.data[i] / 255);
    const x3 = shrink(aW, W, H, BOX, 3);
    const y3 = shrink(y, W, H, BOX, 3);
    mt = { x: x3.data, y: y3.data, ncc: v, s: s * s2, k: kr, radialScale: s, warpScale: s2,
           shiftX: dx * 2, shiftY: dy * 2, size: { w: W, h: H } };
  }
  if (!mt || cancelled()) return null;

  // ---- masks (spec §2.2; validMask is all-ones per §6.11)
  const h3 = Math.floor(mt.size.h / BOX), w3 = Math.floor(mt.size.w / BOX);
  const clipMask = new Uint8Array(h3 * w3);
  const reportMask = new Uint8Array(h3 * w3);
  const nearWhiteMask = new Uint8Array(h3 * w3);
  for (let i = 0, j = 0; i < h3 * w3; i++, j += 3) {
    const mx = Math.max(mt.y[j], mt.y[j + 1], mt.y[j + 2]);
    const mn = Math.min(mt.y[j], mt.y[j + 1], mt.y[j + 2]);
    clipMask[i] = mx >= CLIP ? 1 : 0;
    reportMask[i] = mx < 0.99 ? 1 : 0;
    nearWhiteMask[i] = (mx >= CLIP && mn >= NEAR_WHITE) ? 1 : 0;
  }
  const hasCrop = xmp.HasCrop === "True";
  const crop = (!hasCrop && !("CropAngle" in xmp)) ? null : {
    hasCrop,
    left: parseFloat(xmp.CropLeft ?? 0), top: parseFloat(xmp.CropTop ?? 0),
    right: parseFloat(xmp.CropRight ?? 1), bottom: parseFloat(xmp.CropBottom ?? 1),
    angleDeg: parseFloat(xmp.CropAngle ?? 0), angleSign: ori.angleSign,
  };
  const blocked = mt.ncc < NCC_BAD
    ? { code: "ncc_low", detail: `ncc=${mt.ncc.toFixed(3)} < ${NCC_BAD}` }
    : null;

  return {
    schemaVersion: 1,
    kind: "preparedPair",
    id: input.id ?? null,
    files: input.files ?? null,
    generation: input.generation ?? null,
    cancelled: false,
    superseded: false,
    size: mt.size,
    x: mt.x, y: mt.y,
    ncc: mt.ncc,
    transform: {
      crop,
      orientation: ori.orientation,
      lensRadial: lens,
      radialScale: mt.radialScale,
      radialK: mt.k,
      scale: mt.s,
      warpScale: mt.warpScale,
      shiftX: mt.shiftX,
      shiftY: mt.shiftY,
    },
    vignette: ab,
    masks: { clipMask, reportMask, validMask: new Uint8Array(h3 * w3).fill(1), nearWhiteMask },
    gain: Float64Array.from(gain ?? [1, 1, 1]),
    gainNote: gainNote ?? null,
    blocked,
    warnings: [],
  };
}


// ------------------------------------------------------------------ warpToWorking
// The compare/report geometry (spec/ui-plan.md §4 stage 4, the "Preview/report geometry"
// risk of §6): apply the fitted transform chain to an already-developed frame (the renderer's
// output, in the decoder's orientation, margins cropped) so the result shares geometry with
// the H3×W3 aligned arrays. The chain mirrors preparePair's tail stage by stage, with the
// stored transform components: unrotate (decoder convention, like preparePair's input) ->
// devignette (the prepared x is devignetted, the renderer's frame is not) -> the embedded-JPEG
// lensRadial (only when recorded — it runs before the crop in preparePair) -> the XMP crop ->
// the chosen orientation -> the box resize to the working size -> the radialScale/radialK warp
// -> the align affine warp (warpScale + the applied shift) -> the 3×3 box shrink.
// The result is H3×W3 and pixel (y, x) of it == pixel (y, x) of the prepared x/y arrays — the
// future report (stage 5) and its error map overlay these exact pixels. frame:
// { data: Float32Array RGB, w, h }.
export function warpToWorking(frame, prepared, unrotate) {
  const W = prepared.size.w, H = prepared.size.h;
  const o = orientedFrame(frame, prepared, unrotate);
  const aW = alignedAt(o, prepared, W, H);
  const out = shrink(aW, W, H, BOX, 3);
  return { data: out.data, w: out.w, h: out.h };
}

// The display variant of the same chain (the compare screen): identical up to the box resize,
// which goes to k× the working size instead of the working size, then the radial warp (its
// parameters are size-normalized) and the align affine warp with the shift scaled by k; no
// 3×3 shrink. The result is the same image-space rectangle as the H3×W3 grid (0..W, 0..H of the
// working size), only sampled finer, so the report overlays still land on the same pixels.
// k = min(maxLong / max(W, H), the oriented source extent / the working size) — never upsamples
// the developed frame, at least the H3×W3 resolution. With k = 1, shrink(warpToView) is
// bit-identical to warpToWorking (level 1e checks it).
export function warpToView(frame, prepared, unrotate, { maxLong = 2048, k = null } = {}) {
  const W = prepared.size.w, H = prepared.size.h;
  const o = orientedFrame(frame, prepared, unrotate);
  const kk = k ?? Math.max(1 / BOX, Math.min(maxLong / Math.max(W, H), o.w / W, o.h / H));
  const OW = Math.max(1, Math.round(W * kk)), OH = Math.max(1, Math.round(H * kk));
  return { data: alignedAt(o, prepared, OW, OH), w: OW, h: OH, k: kk };
}

// unrotate -> devignette -> lensRadial -> XMP crop -> orientation (warpToWorking's head)
function orientedFrame(frame, prepared, unrotate) {
  const tr = prepared.transform;
  let { data, w, h } = frame;
  const unr = ((unrotate ?? 0) % 4 + 4) % 4;
  if (unr) {
    const r = rot90(data, w, h, unr);
    data = r.data; w = r.w; h = r.h;
  }
  data = correctVignette(data, w, h, prepared.vignette.a, prepared.vignette.b);
  if (tr.lensRadial) {
    data = warpRadial(data, w, h, tr.lensRadial.scale, tr.lensRadial.k, 3).data;
  }
  if (tr.crop && tr.crop.hasCrop) {
    const c = tr.crop;
    const im = applyCrop(data, w, h, {
      HasCrop: "True",
      CropLeft: String(c.left), CropTop: String(c.top),
      CropRight: String(c.right), CropBottom: String(c.bottom),
      CropAngle: String(c.angleDeg),
    }, c.angleSign);
    data = im.data; w = im.w; h = im.h;
  }
  const r = rot90(data, w, h, tr.orientation);
  return { data: r.data, w: r.w, h: r.h };
}

// the box resize to OW×OH -> the radialScale/radialK warp -> the align affine warp (the
// stored shift is in working pixels, scaled to OW×OH) — warpToWorking's tail before the shrink
function alignedAt(o, prepared, OW, OH) {
  const tr = prepared.transform;
  const W = prepared.size.w, H = prepared.size.h;
  const aS = resizeF(o.data, OW, OH, o.w, o.h, "box", 3).data;
  const aR = warpRadial(aS, OW, OH, tr.radialScale, tr.radialK, 3).data;
  const sc = 1 / tr.warpScale;
  const sx = tr.shiftX * (OW / W), sy = tr.shiftY * (OH / H);
  const m = [sc, 0, OW / 2 - sc * (OW / 2 + sx), 0, sc, OH / 2 - sc * (OH / 2 + sy)];
  return warpAffine(aR, OW, OH, OW, OH, m, "bilinear", { dtype: "f32", channels: 3 }).data;
}


// ------------------------------------------------------------------ the fast compare remap
// warpToView runs seven full-frame resampling passes (unrotate, devignette, lens radial, the
// bicubic XMP-crop rotation, orientation, the box resize, radial, affine) — ~1–1.4 s per pair
// switch in the browser, most of it the crop rotation. For the screen the same geometry is one
// inverse map: every output pixel is traced back through the chain to a frame coordinate (and
// the devignette gain at the intermediate position), then one bicubic gather. The map depends
// only on the preparation, the frame size and the output size, so it is built once per pair and
// every strength/version change is a gather (~20 ms). Not bit-identical to warpToView (point
// Catmull-Rom instead of the box/bicubic kernels): display only — the report keeps warpToWorking.
// Level 1e checks it against warpToView. Outside the source (the align/crop fill) -> sx = NaN.
// window = { x0, y0, w, h } (integers, inside the OW×OH grid, w, h >= 1) restricts the map to that
// rectangle of the output grid: sx/sy/g then have w*h entries, row-major over the window, and every
// value equals the full map's value at the same output pixel (same arithmetic; level 1n checks it).
// The result carries k, fullW = OW, fullH = OH and the window origin x0, y0 (0, 0 without a window);
// w/h are the map's own size (the window's size with a window, OW×OH without).
export function viewRemap(prepared, fw, fh, unrotate, { maxLong = 2048, k = null, window = null } = {}) {
  const tr = prepared.transform;
  const W = prepared.size.w, H = prepared.size.h;
  const unr = ((unrotate ?? 0) % 4 + 4) % 4;
  // sizes along the chain
  const w1 = unr % 2 ? fh : fw, h1 = unr % 2 ? fw : fh;          // A: unrotated frame (= B)
  let cw = w1, ch = h1, x0 = 0, y0 = 0, rot = null;               // C: the crop
  if (tr.crop && tr.crop.hasCrop) {
    const c = tr.crop;
    const ang = c.angleDeg * c.angleSign;
    const cx = (c.left + c.right) / 2 * w1, cy = (c.top + c.bottom) / 2 * h1;
    const a = ang * Math.PI / 180;
    const dx = (c.right - c.left) * w1, dy = (c.bottom - c.top) * h1;
    const cwf = Math.abs(dx * Math.cos(a) + dy * Math.sin(a));
    const chf = Math.abs(dy * Math.cos(a) - dx * Math.sin(a));
    x0 = Math.trunc(cx - cwf / 2); y0 = Math.trunc(cy - chf / 2);
    cw = Math.trunc(cx + cwf / 2) - x0; ch = Math.trunc(cy + chf / 2) - y0;
    if (Math.abs(ang) > 1e-3) {
      const angle = ((ang % 360) + 360) % 360;
      const ra = -angle * Math.PI / 180;
      const r15 = (v) => Number(v.toFixed(15));
      const a0 = r15(Math.cos(ra)), a1 = r15(Math.sin(ra)), a3 = r15(-Math.sin(ra)), a4 = r15(Math.cos(ra));
      rot = [a0, a1, a0 * -cx + a1 * -cy + cx, a3, a4, a3 * -cx + a4 * -cy + cy];
    }
  }
  const r2 = ((tr.orientation % 4) + 4) % 4;
  const wd = r2 % 2 ? ch : cw, hd = r2 % 2 ? cw : ch;              // D: oriented
  const kk = k ?? Math.max(1 / BOX, Math.min(maxLong / Math.max(W, H), wd / W, hd / H));
  const OW = Math.max(1, Math.round(W * kk)), OH = Math.max(1, Math.round(H * kk));
  let wx0 = 0, wy0 = 0, ww = OW, wh = OH;
  if (window != null) {
    const { x0: qx, y0: qy, w: qw, h: qh } = window;
    if (![qx, qy, qw, qh].every(Number.isInteger))
      throw new Error("viewRemap: window { x0, y0, w, h } must be integers");
    if (qw < 1 || qh < 1)
      throw new Error("viewRemap: window w and h must be >= 1");
    if (qx < 0 || qy < 0 || qx + qw > OW || qy + qh > OH)
      throw new Error(`viewRemap: window ${qx},${qy} ${qw}x${qh} is outside the ${OW}x${OH} grid`);
    wx0 = qx; wy0 = qy; ww = qw; wh = qh;
  }
  // the align affine (transform semantics) and the radial at OW×OH
  const sc = 1 / tr.warpScale;
  const shx = tr.shiftX * (OW / W), shy = tr.shiftY * (OH / H);
  const m0 = sc, m2 = OW / 2 - sc * (OW / 2 + shx), m4 = sc, m5 = OH / 2 - sc * (OH / 2 + shy);
  const denE = OW * OW / 4 + OH * OH / 4;
  const lens = tr.lensRadial;
  const denB = w1 * w1 / 4 + h1 * h1 / 4;
  const denV = Math.hypot(w1 / 2, h1 / 2);
  const va = prepared.vignette.a, vb = prepared.vignette.b;
  const n = ww * wh;
  const sx = new Float32Array(n), sy = new Float32Array(n), g = new Float32Array(n);
  for (let y = wy0; y < wy0 + wh; y++) {
    for (let x = wx0; x < wx0 + ww; x++) {
      const i = (y - wy0) * ww + (x - wx0);
      // G -> F (affine, center coords -> index coords)
      const xin = m0 * (x + 0.5) + m2, yin = m4 * (y + 0.5) + m5;
      if (xin < 0 || xin >= OW || yin < 0 || yin >= OH) { sx[i] = NaN; continue; }
      let px = xin - 0.5, py = yin - 0.5;
      // F -> E (devpairs.radial, clamped)
      {
        const xx = px - OW / 2, yy = py - OH / 2;
        const d = (1 + (tr.radialK * (xx * xx + yy * yy)) / denE) / tr.radialScale;
        px = Math.min(OW - 1.001, Math.max(0, xx * d + OW / 2));
        py = Math.min(OH - 1.001, Math.max(0, yy * d + OH / 2));
      }
      // E -> D (the box resize: pixel centers)
      px = (px + 0.5) * (wd / OW) - 0.5;
      py = (py + 0.5) * (hd / OH) - 0.5;
      // D -> C (undo r2 counter-clockwise turns: one turn maps C(col = Cw-1-y, row = x))
      {
        let cwi = wd, chi = hd;
        for (let t = 0; t < r2; t++) {
          // the image before this turn has width chi, height cwi
          const nx = chi - 1 - py, ny = px;
          px = nx; py = ny;
          const tmp = cwi; cwi = chi; chi = tmp;
        }
      }
      // C -> rotated (crop offset) -> B (the PIL rotation inverse map)
      px += x0; py += y0;
      if (rot) {
        if (px < -0.5 || px >= w1 - 0.5 || py < -0.5 || py >= h1 - 0.5) { sx[i] = NaN; continue; }
        const xr = rot[0] * (px + 0.5) + rot[1] * (py + 0.5) + rot[2];
        const yr = rot[3] * (px + 0.5) + rot[4] * (py + 0.5) + rot[5];
        if (xr < 0 || xr >= w1 || yr < 0 || yr >= h1) { sx[i] = NaN; continue; }
        px = xr - 0.5; py = yr - 0.5;
      }
      if (px < -0.5 || px > w1 - 0.5 || py < -0.5 || py > h1 - 0.5) { sx[i] = NaN; continue; }
      // B -> A (the embedded-JPEG lens radial, clamped)
      if (lens) {
        const xx = px - w1 / 2, yy = py - h1 / 2;
        const d = (1 + (lens.k * (xx * xx + yy * yy)) / denB) / lens.scale;
        px = Math.min(w1 - 1.001, Math.max(0, xx * d + w1 / 2));
        py = Math.min(h1 - 1.001, Math.max(0, yy * d + h1 / 2));
      }
      // the devignette gain at A
      {
        const rr = Math.hypot(px + 0.5 - w1 / 2, py + 0.5 - h1 / 2) / denV;
        const q = rr * rr;
        g[i] = Math.pow(2, va * q + vb * q * q);
      }
      // A -> frame (undo the unrotate turns)
      {
        let aw = w1, ah = h1;
        for (let t = 0; t < unr; t++) {
          const nx = ah - 1 - py, ny = px;
          px = nx; py = ny;
          const tmp = aw; aw = ah; ah = tmp;
        }
      }
      sx[i] = px; sy[i] = py;
    }
  }
  return { sx, sy, g, w: ww, h: wh, fw, fh, k: kk, fullW: OW, fullH: OH, x0: wx0, y0: wy0 };
}

// Catmull-Rom weights of the four taps around a sample at fraction t (a = -0.5).
function cubicWeights(t, w) {
  const t2 = t * t, t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

/** One gather of an RGB frame through a viewRemap map (edges clamped, NaN -> 0): bicubic
 *  (Catmull-Rom, 4×4 taps; it may overshoot slightly at edges — the canvas clamps). The map is near 1:1, where a bilinear gather at
 *  random fractional offsets blurs the finest detail (about a quarter of the top band on the
 *  compare render, spec/ui.md decision #18); Catmull-Rom keeps it. */
export function applyRemap(frame, map) {
  const { data, w: fw, h: fh } = frame;
  const { sx, sy, g } = map;
  const out = new Float32Array(map.w * map.h * 3);
  const wx = new Float64Array(4), wy = new Float64Array(4);
  const xs = new Int32Array(4), ys = new Int32Array(4);
  for (let i = 0, j = 0; i < sx.length; i++, j += 3) {
    const u = sx[i];
    if (u !== u) continue;                         // NaN: outside the source
    const v = sy[i];
    const x0 = Math.floor(u), y0 = Math.floor(v);
    cubicWeights(u - x0, wx);
    cubicWeights(v - y0, wy);
    for (let k = 0; k < 4; k++) {
      xs[k] = Math.max(0, Math.min(fw - 1, x0 - 1 + k));
      ys[k] = Math.max(0, Math.min(fh - 1, y0 - 1 + k));
    }
    let r = 0, gr = 0, b = 0;
    for (let a = 0; a < 4; a++) {
      const row = ys[a] * fw, wa = wy[a];
      for (let c = 0; c < 4; c++) {
        const q = (row + xs[c]) * 3, ww = wa * wx[c];
        r += data[q] * ww; gr += data[q + 1] * ww; b += data[q + 2] * ww;
      }
    }
    const gg = g[i];
    out[j] = r * gg;
    out[j + 1] = gr * gg;
    out[j + 2] = b * gg;
  }
  return { data: out, w: map.w, h: map.h };
}
