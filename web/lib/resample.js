// Resampling kernels: exact ports of the PIL operations used by pairs.py / devpairs.py
// (spec/web-schemas.md §6.2, level 1d of spec/web-tests.md). Pure TypedArray code, runs in
// Node and Workers, no DOM. canvas/createImageBitmap scaling must not be used instead.
//
// Conventions reverse-engineered from Pillow 13.0.0 (src/libImaging/Resample.c, Geometry.c,
// src/PIL/Image.py):
//  - Image.resize: separable convolution, center-aligned samples
//    (center = (xx + 0.5) * scale), kernel widened by max(1, scale) when downsampling
//    (filterscale), window [round(center - support), round(center + support)) clamped to the
//    image, weights normalized by their sum. Pass order: horizontal first, unless the image
//    shrinks vertically more than twice as much as horizontally.
//  - F mode (float32) resamples accumulate in float64 and store float32 unclamped.
//  - 8-bit images quantize each pass's weights to int32 with 22 precision bits
//    ((int)(+-0.5 + w * 2^22)), accumulate with a half-LSB bias (1 << 21) and clip to
//    [0, 255]; the intermediate between the two passes is 8 bit.
//  - Image.transform AFFINE + BILINEAR/BICUBIC (Image.rotate goes through it): point-sampled
//    inverse map, output pixel center (x + 0.5, y + 0.5) mapped to the source, then 0.5 is
//    subtracted to get pixel-index space; 2x2 bilinear / 4x4 Catmull-Rom-style bicubic with
//    clamped columns, edge rows duplicated; a mapped center outside the source is fill (0).
//    There is NO antialiasing (no support widening) on this path.
//  - devpairs.radial is numpy (not PIL): bilinear with u/v clamped to [0, w - 1.001]; with the
//    float64 (s, k) from fit_radial the whole computation promotes to float64, so this port
//    computes in float64 (only r^2 is rounded to float32, matching numpy weak-scalar rules).
//  - devpairs.shrink is a plain k x k box mean (numpy, not PIL).
//
// All arrays are interleaved channels, row-major: index (y * w + x) * channels + c.

const PRECISION_BITS = 22;             // Resample.c: 32 - 8 - 2
const PRECISE = 1 << PRECISION_BITS;

// ---------------------------------------------------------------- kernels (Resample.c)

function box(x) {
  return x > -0.5 && x <= 0.5 ? 1.0 : 0.0;
}

function bilinear(x) {
  if (x < 0) x = -x;
  return x < 1.0 ? 1.0 - x : 0.0;
}

function bicubic(x) {
  const a = -0.5;
  if (x < 0) x = -x;
  if (x < 1.0) return ((a + 2.0) * x - (a + 3.0)) * x * x + 1;
  if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * a;
  return 0.0;
}

function sinc(x) {
  if (x === 0.0) return 1.0;
  x = x * Math.PI;
  return Math.sin(x) / x;
}

function lanczos(x) {
  if (x >= -3.0 && x < 3.0) return sinc(x) * sinc(x / 3);
  return 0.0;
}

export const KERNELS = {
  box: { fn: box, support: 0.5 },
  bilinear: { fn: bilinear, support: 1.0 },
  bicubic: { fn: bicubic, support: 2.0 },
  lanczos: { fn: lanczos, support: 3.0 },
};

function kernelOf(k) {
  const kc = typeof k === "string" ? KERNELS[k] : k;
  if (!kc) throw new Error(`unknown resampling kernel: ${k}`);
  return kc;
}

// Resample.c precompute_coeffs: full-image box (in0 = 0, in1 = inSize).
function precomputeCoeffs(inSize, outSize, kc) {
  const scale = inSize / outSize;
  let filterscale = scale;
  if (filterscale < 1.0) filterscale = 1.0;
  const support = kc.support * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const coeffs = new Float64Array(outSize * ksize);
  const inv = 1.0 / filterscale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0.0;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    for (let x = 0; x < xmax; x++) {
      const w = kc.fn((x + xmin - center + 0.5) * inv);
      coeffs[xx * ksize + x] = w;
      ww += w;
    }
    if (ww !== 0.0) {
      for (let x = 0; x < xmax; x++) coeffs[xx * ksize + x] /= ww;
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { bounds, coeffs, ksize };
}

// One horizontal pass, float64 accumulation, float32 storage (PIL F mode).
function hpassF(src, sw, sh, dw, kc, channels) {
  const { bounds, coeffs, ksize } = precomputeCoeffs(sw, dw, kc);
  const out = new Float32Array(dw * sh * channels);
  for (let y = 0; y < sh; y++) {
    const rowIn = y * sw * channels;
    const rowOut = y * dw * channels;
    for (let xx = 0; xx < dw; xx++) {
      const xmin = bounds[xx * 2], xmax = bounds[xx * 2 + 1];
      for (let c = 0; c < channels; c++) {
        let ss = 0.0;
        for (let x = 0; x < xmax; x++) {
          ss += src[(rowIn + (x + xmin) * channels) + c] * coeffs[xx * ksize + x];
        }
        out[rowOut + xx * channels + c] = Math.fround(ss);
      }
    }
  }
  return { data: out, w: dw, h: sh };
}

// One vertical pass, float64 accumulation, float32 storage (PIL F mode).
function vpassF(src, sw, sh, dh, kc, channels) {
  const { bounds, coeffs, ksize } = precomputeCoeffs(sh, dh, kc);
  const out = new Float32Array(dh * sw * channels);
  for (let yy = 0; yy < dh; yy++) {
    const ymin = bounds[yy * 2], ymax = bounds[yy * 2 + 1];
    for (let x = 0; x < sw; x++) {
      for (let c = 0; c < channels; c++) {
        let ss = 0.0;
        for (let y = 0; y < ymax; y++) {
          ss += src[((y + ymin) * sw + x) * channels + c] * coeffs[yy * ksize + y];
        }
        out[(yy * sw + x) * channels + c] = Math.fround(ss);
      }
    }
  }
  return { data: out, w: sw, h: dh };
}

// normalize_coeffs_8bpc: quantize one pass's weights to int32.
function quantize(coeffs) {
  const kq = new Int32Array(coeffs.length);
  for (let i = 0; i < coeffs.length; i++) {
    kq[i] = Math.trunc((coeffs[i] < 0 ? -0.5 : 0.5) + coeffs[i] * PRECISE);
  }
  return kq;
}

function clip8(ss) {
  const v = ss >> PRECISION_BITS;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// One horizontal pass, 8-bit quantized path (PIL RGB/L: int32 weights, clip8).
function hpassU8(src, sw, sh, dw, kc, channels) {
  const { bounds, coeffs, ksize } = precomputeCoeffs(sw, dw, kc);
  const kq = quantize(coeffs);
  const out = new Uint8Array(dw * sh * channels);
  for (let y = 0; y < sh; y++) {
    const rowIn = y * sw * channels;
    const rowOut = y * dw * channels;
    for (let xx = 0; xx < dw; xx++) {
      const xmin = bounds[xx * 2], xmax = bounds[xx * 2 + 1];
      for (let c = 0; c < channels; c++) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let x = 0; x < xmax; x++) {
          ss += src[rowIn + (x + xmin) * channels + c] * kq[xx * ksize + x];
        }
        out[rowOut + xx * channels + c] = clip8(ss);
      }
    }
  }
  return { data: out, w: dw, h: sh };
}

// One vertical pass, 8-bit quantized path.
function vpassU8(src, sw, sh, dh, kc, channels) {
  const { bounds, coeffs, ksize } = precomputeCoeffs(sh, dh, kc);
  const kq = quantize(coeffs);
  const out = new Uint8Array(dh * sw * channels);
  for (let yy = 0; yy < dh; yy++) {
    const ymin = bounds[yy * 2], ymax = bounds[yy * 2 + 1];
    for (let x = 0; x < sw; x++) {
      for (let c = 0; c < channels; c++) {
        let ss = 1 << (PRECISION_BITS - 1);
        for (let y = 0; y < ymax; y++) {
          ss += src[((y + ymin) * sw + x) * channels + c] * kq[yy * ksize + y];
        }
        out[(yy * sw + x) * channels + c] = clip8(ss);
      }
    }
  }
  return { data: out, w: sw, h: dh };
}

// Exact port of PIL Image.resize (full-image box). src: Float32Array interleaved
// `channels` planes of a w*h image; returns {data, w, h} Float32Array.
export function resizeF(src, w, h, sw, sh, kernel, channels = 1) {
  const kc = kernelOf(kernel);
  const needH = sw !== w;
  const needV = sh !== h;
  if (!needH && !needV) return { data: Float32Array.from(src), w, h };
  // ImagingResampleInner: vertical first only when shrinking vertically > 2x horizontally
  const horizontalFirst = !((sh - h) > 0 && (sh - h) > (sw - w) * 2);
  let cur = { data: src, w: sw, h: sh };
  if (horizontalFirst) {
    if (needH) cur = hpassF(cur.data, cur.w, cur.h, w, kc, channels);
    if (needV) cur = vpassF(cur.data, cur.w, cur.h, h, kc, channels);
  } else {
    if (needV) cur = vpassF(cur.data, cur.w, cur.h, h, kc, channels);
    if (needH) cur = hpassF(cur.data, cur.w, cur.h, w, kc, channels);
  }
  return cur;
}

// Exact port of PIL Image.resize for 8-bit data (PIL RGB/L semantics: quantized int32
// weights per pass, 8-bit intermediate). src: Uint8Array; returns {data, w, h} Uint8Array.
export function resizeU8(src, w, h, sw, sh, kernel, channels = 3) {
  const kc = kernelOf(kernel);
  const needH = sw !== w;
  const needV = sh !== h;
  if (!needH && !needV) return { data: Uint8Array.from(src), w, h };
  const horizontalFirst = !((sh - h) > 0 && (sh - h) > (sw - w) * 2);
  let cur = { data: src, w: sw, h: sh };
  if (horizontalFirst) {
    if (needH) cur = hpassU8(cur.data, cur.w, cur.h, w, kc, channels);
    if (needV) cur = vpassU8(cur.data, cur.w, cur.h, h, kc, channels);
  } else {
    if (needV) cur = vpassU8(cur.data, cur.w, cur.h, h, kc, channels);
    if (needH) cur = hpassU8(cur.data, cur.w, cur.h, w, kc, channels);
  }
  return cur;
}

// ------------------------------------------------------------- point-sampled transforms
// (Geometry.c ImagingGenericTransform: no antialiasing, 0.5-center convention).

const xclip = (x, size) => (x < 0 ? 0 : x < size ? x : size - 1);
const yclip = xclip;

function bicubic1(v1, v2, v3, v4, d) {
  const p1 = v2;
  const p2 = -v1 + v3;
  const p3 = 2 * (v1 - v2) + v3 - v4;
  const p4 = -v1 + v2 - v3 + v4;
  return p1 + d * (p2 + d * (p3 + d * p4));
}

// Sample one channel at a mapped center (xin, yin) — Geometry.c bilinear/bicubic filters.
function sample(src, sw, sh, xin, yin, c, channels, kernel) {
  const sx = xin - 0.5;
  const sy = yin - 0.5;
  const fx = Math.floor(sx);
  const fy = Math.floor(sy);
  const dx = sx - fx;
  const dy = sy - fy;
  const at = (x, y) => src[(y * sw + x) * channels + c];
  if (kernel === "bilinear") {
    const x0 = xclip(fx, sw), x1 = xclip(fx + 1, sw);
    const r0 = yclip(fy, sh);
    let v1 = at(x0, r0) + (at(x1, r0) - at(x0, r0)) * dx;
    let v2;
    if (fy + 1 >= 0 && fy + 1 < sh) {
      const r1 = fy + 1;
      v2 = at(x0, r1) + (at(x1, r1) - at(x0, r1)) * dx;
    } else {
      v2 = v1;
    }
    return v1 + (v2 - v1) * dy;
  }
  // bicubic: taps fx-1..fx+2, rows fy-1..fy+2 with edge-row duplication
  const xs = [fx - 1, fx, fx + 1, fx + 2].map((x) => xclip(x, sw));
  const rows = [];
  for (let t = 0; t < 4; t++) {
    const y = fy - 1 + t;
    if (t === 0) {
      rows.push(bicubic1(at(xs[0], yclip(y, sh)), at(xs[1], yclip(y, sh)),
                         at(xs[2], yclip(y, sh)), at(xs[3], yclip(y, sh)), dx));
    } else if (y >= 0 && y < sh) {
      rows.push(bicubic1(at(xs[0], y), at(xs[1], y), at(xs[2], y), at(xs[3], y), dx));
    } else {
      rows.push(rows[t - 1]);
    }
  }
  return bicubic1(rows[0], rows[1], rows[2], rows[3], dy);
}

// Generic inverse-map transform over the whole output (Image.transform AFFINE semantics).
// m = [a0, a1, a2, a3, a4, a5]: src = m * (x + 0.5, y + 0.5). Mapped centers outside the
// source are 0 (fill). dtype: "f32" (Float32Array out, unclamped) or "u8"
// (Uint8Array out; bicubic clamps to [0, 255], both truncate like the C cast).
function transform(src, sw, sh, dw, dh, m, kernel, dtype, channels) {
  const out = dtype === "u8" ? new Uint8Array(dw * dh * channels)
                             : new Float32Array(dw * dh * channels);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const xin = m[0] * (x + 0.5) + m[1] * (y + 0.5) + m[2];
      const yin = m[3] * (x + 0.5) + m[4] * (y + 0.5) + m[5];
      if (xin < 0.0 || xin >= sw || yin < 0.0 || yin >= sh) continue;   // fill 0
      for (let c = 0; c < channels; c++) {
        let v = sample(src, sw, sh, xin, yin, c, channels, kernel);
        if (dtype === "u8") {
          if (kernel === "bicubic") v = v <= 0.0 ? 0 : v >= 255.0 ? 255 : v;
          out[(y * dw + x) * channels + c] = Math.trunc(v);
        } else {
          out[(y * dw + x) * channels + c] = Math.fround(v);
        }
      }
    }
  }
  return { data: out, w: dw, h: dh };
}

// Port of Image.rotate(angle, resample, expand=false, center): the inverse affine matrix of
// Pillow's Image.py (angle negated, entries rounded to 15 decimals, default center (w/2, h/2)).
export function rotate(src, w, h, angleDeg, kernel = "bicubic", opts = {}) {
  const angle = ((angleDeg % 360) + 360) % 360;
  if (angle === 0) {
    return { data: src.slice(), w, h };
  }
  const a = -angle * Math.PI / 180;
  const r15 = (v) => Number(v.toFixed(15));        // Python round(v, 15)
  const cx = opts.center ? opts.center[0] : w / 2;
  const cy = opts.center ? opts.center[1] : h / 2;
  const a0 = r15(Math.cos(a)), a1 = r15(Math.sin(a));
  const a3 = r15(-Math.sin(a)), a4 = r15(Math.cos(a));
  const m = [a0, a1, a0 * -cx + a1 * -cy + cx, a3, a4, a3 * -cx + a4 * -cy + cy];
  return transform(src, w, h, w, h, m, kernel, opts.dtype || "f32", opts.channels || 1);
}

// Port of Image.transform(size, AFFINE, coeffs, resample) — pairs.warp conventions
// (coeffs (a, 0, c, 0, a, f) scale around the center + shift in result pixels).
export function warpAffine(src, sw, sh, dw, dh, m, kernel = "bilinear", opts = {}) {
  return transform(src, sw, sh, dw, dh, m, kernel, opts.dtype || "f32", opts.channels || 1);
}

// Port of devpairs.radial (numpy bilinear, NOT PIL): scale s and distortion k around the
// center, same size. With the float64 (s, k) the pipeline passes, numpy promotes everything
// to float64 except r^2 (float32 weak-scalar rule) — mirrored here.
export function warpRadial(src, w, h, s, k, channels = 3) {
  const out = new Float32Array(w * h * channels);
  const den = w * w / 4 + h * h / 4;
  for (let y = 0; y < h; y++) {
    const yy = Math.fround(y - h / 2);
    for (let x = 0; x < w; x++) {
      const xx = Math.fround(x - w / 2);
      const r2 = Math.fround(Math.fround(xx * xx) + Math.fround(yy * yy));
      const d = (1 + (k * r2) / den) / s;
      let u = xx * d + w / 2;
      u = u < 0 ? 0 : u > w - 1.001 ? w - 1.001 : u;
      let v = yy * d + h / 2;
      v = v < 0 ? 0 : v > h - 1.001 ? h - 1.001 : v;
      const i = Math.trunc(u), j = Math.trunc(v);
      const f = u - i, g = v - j;
      const p = (yy2, xx2, c) => src[(yy2 * w + xx2) * channels + c];
      for (let c = 0; c < channels; c++) {
        const t1 = p(j, i, c) * (1 - f) * (1 - g);
        const t2 = p(j, i + 1, c) * f * (1 - g);
        const t3 = p(j + 1, i, c) * (1 - f) * g;
        const t4 = p(j + 1, i + 1, c) * f * g;
        out[(y * w + x) * channels + c] = Math.fround(t1 + t2 + t3 + t4);
      }
    }
  }
  return { data: out, w, h };
}

// Port of devpairs.shrink: k x k box mean over non-overlapping blocks (numpy, not PIL),
// truncating the size to a multiple of k. Float32 in/out (sum accumulated in float64,
// which matches numpy's float32 mean within 1 ulp — see spec/web-tests.md level 1d).
export function shrink(src, w, h, k, channels = 3) {
  const w3 = Math.floor(w / k), h3 = Math.floor(h / k);
  const out = new Float32Array(w3 * h3 * channels);
  for (let y = 0; y < h3; y++) {
    for (let x = 0; x < w3; x++) {
      for (let c = 0; c < channels; c++) {
        let ss = 0.0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            ss += src[((y * k + dy) * w + x * k + dx) * channels + c];
          }
        }
        out[(y * w3 + x) * channels + c] = Math.fround(ss / (k * k));
      }
    }
  }
  return { data: out, w: w3, h: h3 };
}
