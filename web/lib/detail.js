// Flexible Color detail: Clarity, Sharpening, Mid-range sharpening.
// Port of detail.Detail.__call__ — each tool changes only the Rec.601 Y' luma:
//   dY = value * sum_s table_s(Y) * (Y - Gauss_s(Y)),  table is over the Y tone (NB knots),
// the table is separate for plus and minus, radii sigma are given in full-frame pixels and are
// divided by the working image scale. Tools without a model are skipped, the result is 0..1.
// Gaussian is the fftKernel below: the same as detail.gauss (FFT with numpy reflect edges),
// not the truncated discrete Gaussian (for subpixel sigma, sharpening, they differ).
// Two paths with one math: applyDetailGL (WebGL2, the main one) and applyDetailCPU
// (the same algorithm on CPU — the shader reference and a future Worker). Pure functions, no DOM
// except the WebGL context. Model format: web/export_model.py (docstring), model/detail.*.
import { VERTEX } from "./neutral.js";

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** The detail model from detail.json + detail.bin. parts: {tool: {scale: Part}}. */
export function loadDetail(meta, buf) {
  const f32 = buf ? new Float32Array(buf) : null;
  const take = (t) => {
    const out = new Float64Array(t.count);
    for (let i = 0; i < t.count; i++) out[i] = f32[t.offset + i];
    return out;
  };
  const parts = {};
  for (const [tool, by] of Object.entries(meta.parts)) {
    parts[tool] = {};
    for (const [k, e] of Object.entries(by))
      parts[tool][Number(k)] = { sigmas: Float64Array.from(e.sigmas), plus: take(e.plus), minus: take(e.minus) };
  }
  return {
    tools: meta.tools, NB: meta.NB, SENSOR_LONG: meta.SENSOR_LONG,
    BASE: meta.BASE ?? "base", BASE_RANGE: meta.BASE_RANGE ?? 1.5,
    GRID: Float64Array.from(meta.GRID), YW: Float64Array.from(meta.YW),
    parts,
  };
}

/** Loads the model from the static assets directory. */
export async function fetchDetail(base = "") {
  const meta = await (await fetch(base + "model/detail.json")).json();
  let buf = null;
  if (meta.parts && Object.keys(meta.parts).length)
    buf = await (await fetch(base + "model/" + (meta.bin || "detail.bin"))).arrayBuffer();
  return loadDetail(meta, buf);
}

/** How many full-frame pixels fit in one image pixel. Port of detail.scale_of. */
export function scaleOf(d, w, h) {
  return d.SENSOR_LONG / Math.max(w, h);
}

/** The tool's model at the nearest scale in log space; null if none. Port of Detail.part. */
export function partOf(d, tool, scale) {
  const by = d.parts[tool];
  if (!by) return null;
  let best = null, bestD = Infinity;
  for (const k of Object.keys(by)) {
    const dd = Math.abs(Math.log(Number(k) / scale));
    if (dd < bestD) { bestD = dd; best = Number(k); }
  }
  return by[best];
}

/** The NX base detail part at this scale (detail.Detail.base_part): only within BASE_RANGE of a
 *  measured scale, else null. */
export function basePartOf(d, scale) {
  const by = d.parts[d.BASE];
  if (!by) return null;
  let best = null, bestD = Infinity;
  for (const k of Object.keys(by)) {
    const dd = Math.abs(Math.log(Number(k) / scale));
    if (dd < bestD) { bestD = dd; best = Number(k); }
  }
  return bestD <= Math.log(d.BASE_RANGE) + 1e-12 ? by[best] : null;
}

// Enabled tools: (sigma, table, value) for each sigma of an active tool, plus the NX base detail
// (value 1) when `base` (renders only, spec/ui.md decision #18). Contributions with the same
// sigma are merged into one (table = the value-weighted sum, value 1) — the same dY, since dY is
// linear in the tables — so the base part, which shares the Sharpening x4 radius, takes no
// extra blur in the shader (MAXE = 4).
function entries(d, control, scale, base = false) {
  const raw = [];
  const add = (p, v) => {
    const tab = v > 0 ? p.plus : p.minus;
    p.sigmas.forEach((s, i) => raw.push({ sigma: s / scale, table: tab.subarray(i * d.NB, (i + 1) * d.NB), value: v }));
  };
  for (const tool of d.tools) {
    const v = Number(control[tool]);
    if (!v) continue;
    const p = partOf(d, tool, scale);
    if (p !== null) add(p, v);
  }
  const bp = base ? basePartOf(d, scale) : null;
  if (bp) add(bp, 1);
  const out = [];
  for (const e of raw) {
    const same = out.find((o) => o.sigma === e.sigma);
    if (!same) { out.push(e); continue; }
    const t = new Float64Array(d.NB);
    for (let k = 0; k < d.NB; k++) t[k] = same.value * same.table[k] + e.value * e.table[k];
    same.table = t;
    same.value = 1;
  }
  return out;
}

/** A detail plan for caching: the number of active contributions and their sigmas (≤4). Luma
 *  and blurs depend only on the input frame and sigma — when only tool values/tables change
 *  (the same sigma set), they can be left alone, only the combine pass (renderer.js, plan §5 P2). */
export function detailPlan(d, control, scale, { base = false } = {}) {
  const ents = entries(d, control, scale, base);
  return { count: ents.length, sigmas: ents.slice(0, 4).map((e) => e.sigma) };
}

/** Region rendering with a low-resolution source for the large blurs (spec/ui-zoom-plan.md D6, Z4):
 *  a detail entry whose blur sigma, measured in pixels of the MAIN frame (sigma_fullframe / mainScale),
 *  is at least this many pixels takes its blurred luma from the main frame's blur of the same
 *  full-frame sigma (sampled bilinearly through the affine map); smaller sigmas are blurred on the
 *  region itself. Measured on real frames: web/test-node-region-detail.mjs. */
export const REGION_LOWRES_MIN_SIGMA = 4;

/** Entries of a region render split by blur source: [{sigma (region px), mainSigma (main-frame px) or
 *  null (blurred on the region)}], in the order and with the cap (4) of the combine pass. */
export function regionEntries(d, control, scale, { base = false, lowRes = null } = {}) {
  const ents = entries(d, control, scale, base).slice(0, 4);
  const T = lowRes ? (lowRes.minSigma ?? REGION_LOWRES_MIN_SIGMA) : Infinity;
  return ents.map((e) => {
    const ms = lowRes ? e.sigma * scale / lowRes.mainScale : null;
    return { sigma: e.sigma, mainSigma: ms !== null && ms >= T ? ms : null };
  });
}

/** The margin (region px) a region needs around the visible rectangle so that its region-side blurs
 *  are exact there: the largest fftKernel radius over the entries blurred on the region (0 if none).
 *  lowRes: { mainScale, minSigma? } or null (every blur on the region). */
export function regionMarginPx(d, control, scale, { base = true, lowRes = null } = {}) {
  let m = 0;
  for (const e of regionEntries(d, control, scale, { base, lowRes }))
    if (e.mainSigma === null) m = Math.max(m, Math.max(Math.ceil(3 * e.sigma) + 1, 8));
  return m;
}

/** Bilinear sample of a plane (row-major mw x mh) at continuous coordinates (pixel i has its center at
 *  i + 0.5), edges clamped. The shader's mainBlur does the same on the GPU. */
function bilinear(a, mw, mh, x, y) {
  const u = x - 0.5, v = y - 0.5;
  const fx = Math.floor(u), fy = Math.floor(v);
  const tx = u - fx, ty = v - fy;
  const x0 = clamp(fx, 0, mw - 1), x1 = clamp(fx + 1, 0, mw - 1);
  const y0 = clamp(fy, 0, mh - 1), y1 = clamp(fy + 1, 0, mh - 1);
  const top = a[y0 * mw + x0] * (1 - tx) + a[y0 * mw + x1] * tx;
  const bot = a[y1 * mw + x0] * (1 - tx) + a[y1 * mw + x1] * tx;
  return top * (1 - ty) + bot * ty;
}

/** The Rec.601 Y' luma plane (Float64Array h x w) of an rgb frame, the one the detail step blurs. */
export function lumaOf(d, rgb, w, h) {
  const [yr, yg, yb] = d.YW;
  const y = new Float64Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) y[i] = yr * rgb[p] + yg * rgb[p + 1] + yb * rgb[p + 2];
  return y;
}

/** Interpolation over tone: np.interp(y, GRID, table) — GRID is uniform, NB knots. */
function tableAt(y, d, table) {
  const u = clamp(y, 0, 1) * (d.NB - 1);
  const i = Math.min(Math.floor(u), d.NB - 2);
  const f = u - i;
  return table[i] + (table[i + 1] - table[i]) * f;
}

// ---------- Gaussian: the same kernel as detail.gauss (FFT with reflect edges) ----------
//
// numpy builds the filter in the frequency domain: S(k) = exp(-2(pi*sigma*k/N)^2), N = the size
// with the reflect pad p = min(int(3*sigma)+2, h-1, w-1), and convolves the periodized signal. This is a
// separable blur with the kernel g_m = (1/N)*sum_k S(k)*cos(2*pi*m*k/N) — for sigma ≳ 1 it coincides with the
// truncated discrete Gaussian, for subpixel sigma (sharpening) it is substantially wider.
// We compute g_m by a direct sum with the same formula, truncate at R and normalize to sum 1
// (DC gain as in S(0) = 1). One kernel for CPU and the shader, cached by (sigma, n, p).

const kernelCache = new Map();

function fftKernel(sigma, n, other) {
  const p = Math.min(Math.floor(3 * sigma) + 2, n - 1, other - 1);   // pad as in detail.gauss
  const key = `${sigma}/${n}/${p}`;
  let k = kernelCache.get(key);
  if (k) return k;
  const N = n + 2 * p;
  const R = Math.max(Math.ceil(3 * sigma) + 1, 8);
  const even = N % 2 === 0;
  const half = (N - 1) >> 1;                     // bins 1..half are doubled; for even N the bin N/2 is not
  const spec = new Float64Array(half + 2);
  for (let q = 0; q <= half + (even ? 1 : 0); q++) {
    const x = Math.PI * sigma * q / N;
    spec[q] = Math.exp(-2 * x * x);
  }
  const g = new Float64Array(2 * R + 1);
  let norm = 0;
  for (let m = -R; m <= R; m++) {
    let s = spec[0];
    for (let q = 1; q <= half; q++) s += 2 * spec[q] * Math.cos(2 * Math.PI * m * q / N);
    if (even) s += spec[half + 1] * Math.cos(Math.PI * m);      // Nyquist, as in rfft
    g[m + R] = s / N;
    norm += g[m + R];
  }
  for (let i = 0; i < g.length; i++) g[i] /= norm;
  k = { g, R };
  kernelCache.set(key, k);
  return k;
}

/** dY for the luma y (Float64Array, row-major h x w). Port of Part.delta, summed over tools.
 *  lowRes (region mode, see applyDetailCPU): entries with a main sigma take the blur of the main luma. */
function deltaCPU(d, y, w, h, ents, scale, lowRes = null) {
  const dy = new Float64Array(y.length);
  const T = lowRes ? (lowRes.minSigma ?? REGION_LOWRES_MIN_SIGMA) : Infinity;
  for (const e of ents) {
    const ms = lowRes ? e.sigma * scale / lowRes.mainScale : 0;
    let g;
    if (lowRes && ms >= T) {
      lowRes.blurs = lowRes.blurs || new Map();
      let mb = lowRes.blurs.get(ms);
      if (!mb) { mb = gaussCPU(lowRes.mainLuma, lowRes.mainW, lowRes.mainH, ms); lowRes.blurs.set(ms, mb); }
      const [a, b, c, dd, ee, f] = lowRes.affine;
      g = new Float64Array(y.length);
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++) {
          const X = xx + 0.5, Y = yy + 0.5;
          g[yy * w + xx] = bilinear(mb, lowRes.mainW, lowRes.mainH, a * X + b * Y + c, dd * X + ee * Y + f);
        }
    } else g = gaussCPU(y, w, h, e.sigma);
    for (let i = 0; i < y.length; i++)
      dy[i] += e.value * tableAt(y[i], d, e.table) * (y[i] - g[i]);
  }
  return dy;
}

/** Separable blur with reflect edges (a whole mirror, as np.pad 'reflect') and a kernel
 *  from fftKernel — the same result as detail.gauss (FFT), up to float32 precision.
 *  a — Float64Array row-major h x w; sigma in pixels of this image. */
export function gaussCPU(a, w, h, sigma) {
  if (sigma <= 0) return Float64Array.from(a);
  const kx = fftKernel(sigma, w, h), ky = fftKernel(sigma, h, w);
  const mir = (i, n) => {                        // periodic reflection, the edge not repeated
    const per = 2 * n - 2;
    i = ((i % per) + per) % per;
    return i >= n ? per - i : i;
  };
  const tmp = new Float64Array(a.length), out = new Float64Array(a.length);
  for (let y = 0; y < h; y++)                    // rows: n = w, stride w
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x >= kx.R && x + kx.R < w) {           // interior: no reflection (same sums, same order)
        const o = y * w + x;
        for (let i = -kx.R; i <= kx.R; i++) s += kx.g[i + kx.R] * a[o + i];
      } else for (let i = -kx.R; i <= kx.R; i++) s += kx.g[i + kx.R] * a[y * w + mir(x + i, w)];
      tmp[y * w + x] = s;
    }
  for (let y = 0; y < h; y++)                    // columns: row-wise accumulation, the same sum order per pixel
    for (let i = -ky.R; i <= ky.R; i++) {
      const o = y * w, r = mir(y + i, h) * w, gi = ky.g[i + ky.R];
      for (let x = 0; x < w; x++) out[o + x] += gi * tmp[r + x];
    }
  return out;
}

/** A full detail pass on CPU: rgb (h x w x 3, row-major, row 0 at the top) -> Float64Array 0..1.
 *  lowRes (region mode, default off): { affine: [a, b, c, d, e, f], mainLuma (Float64Array mainH x mainW,
 *  the luma of the main frame's profile output), mainW, mainH, mainScale, minSigma? }. Region pixel
 *  centers (x + 0.5, y + 0.5) map to main continuous coordinates (a X + b Y + c, d X + e Y + f); entries
 *  whose sigma / mainScale (main px) is >= minSigma (default REGION_LOWRES_MIN_SIGMA) use the bilinearly
 *  sampled blur of mainLuma at the same full-frame sigma, the others blur the region itself. */
export function applyDetailCPU(d, rgb, w, h, control, { scale = null, base = false, lowRes = null } = {}) {
  scale = scale || scaleOf(d, w, h);
  const ents = entries(d, control, scale, base);
  const y = lumaOf(d, rgb, w, h);
  const dy = ents.length ? deltaCPU(d, y, w, h, ents, scale, lowRes) : new Float64Array(w * h);
  const out = new Float64Array(rgb.length);
  for (let i = 0, p = 0; i < w * h; i++, p += 3)
    for (let c = 0; c < 3; c++) out[p + c] = clamp(rgb[p + c] + dy[i], 0, 1);
  return out;
}

// ---------- WebGL2 ----------

const LUMA_FRAG = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uSrc;
uniform vec3 uYW;
out vec4 o;
void main() {
  o = vec4(dot(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb, uYW), 0.0, 0.0, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uSrc;
uniform sampler2D uKern;   // the fftKernel kernel, 1 x (2R+1), R32F
uniform ivec2 uSize;
uniform vec2 uDir;      // (1, 0) — along the row, (0, 1) — along the column
uniform int uRadius;
out vec4 o;
// np.pad 'reflect': a whole mirror without repeating the edge. Without % — in GLSL ES it
// is not portable for negative operands (broke the top/left edge in Firefox).
int mir(int i, int n) {
  int per = 2 * n - 2;
  while (i < 0) i += per;
  while (i >= per) i -= per;
  return i >= n ? per - i : i;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool row = uDir.x > 0.5;
  int n = row ? uSize.x : uSize.y;
  int c = row ? p.x : p.y;
  float acc = 0.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    int j = mir(c + i, n);
    ivec2 q = row ? ivec2(j, p.y) : ivec2(p.x, j);
    acc += texelFetch(uKern, ivec2(i + uRadius, 0), 0).r * texelFetch(uSrc, q, 0).r;
  }
  o = vec4(acc, 0.0, 0.0, 1.0);
}`;

const COMBINE_FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
#define MAXE 4
uniform sampler2D uImg;     // the source rgb
uniform sampler2D uY;       // the source luma
uniform sampler2D uB0, uB1, uB2, uB3;   // blurs by count (tool x sigma), up to MAXE
uniform int uNB;
uniform int uCount;
uniform float uVal[MAXE];
uniform float uTab[MAXE * 12];          // gain table of each contribution, NB ≤ 12 knots
uniform ivec2 uSize;
uniform bool uFlip;         // output to the default framebuffer: clip-bottom = frame bottom
out vec4 o;
float blured(int e, ivec2 p) {
  if (e == 0) return texelFetch(uB0, p, 0).r;
  if (e == 1) return texelFetch(uB1, p, 0).r;
  if (e == 2) return texelFetch(uB2, p, 0).r;
  return texelFetch(uB3, p, 0).r;
}
void main() {
  ivec2 sp = ivec2(gl_FragCoord.xy);
  ivec2 p = uFlip ? ivec2(sp.x, uSize.y - 1 - sp.y) : sp;
  float y = texelFetch(uY, p, 0).r;
  float dy = 0.0;
  for (int e = 0; e < MAXE; e++) {
    if (e >= uCount) break;
    float u = clamp(y, 0.0, 1.0) * float(uNB - 1);
    int i = min(int(u), uNB - 2);
    float f = u - float(i);
    float t = mix(uTab[e * 12 + i], uTab[e * 12 + i + 1], f);
    dy += uVal[e] * t * (y - blured(e, p));
  }
  o = vec4(clamp(texelFetch(uImg, p, 0).rgb + dy, 0.0, 1.0), 1.0);
}`;

function compile(gl, frag) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// Programs and auxiliary textures are cached on the context: detail is applied
// repeatedly (every slider edit), no need to recreate the shaders.
const ctxCache = new WeakMap();

function ctxOf(gl, d) {
  let c = ctxCache.get(gl);
  if (c) return c;
  if (!gl.getExtension("EXT_color_buffer_float"))
    throw new Error("EXT_color_buffer_float is required for detail");
  c = {
    luma: compile(gl, LUMA_FRAG),
    blur: compile(gl, BLUR_FRAG),
    combine: compile(gl, COMBINE_FRAG),
    regionCombine: compile(gl, COMBINE_REGION_FRAG),
    fbo: gl.createFramebuffer(),
    tex: {},
  };
  for (const [name, unit] of [["img", 0], ["y", 1], ["h", 2], ["out", 3],
                              ["b0", 4], ["b1", 5], ["b2", 6], ["b3", 7], ["kern", 8]]) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    c.tex[name] = t;
  }
  gl.bindVertexArray(gl.createVertexArray());
  ctxCache.set(gl, c);
  return c;
}

/**
 * Detail on GPU. rgba — pixels (row-major, row 0 at the top): Uint8Array RGBA
 * (w*h*4, an RGBA8 texture) or Float32Array RGBA (w*h*4, RGBA32F). Instead of rgba one can
 * pass srcTex — a WebGLTexture source: the input is taken from it (the renderer.render GPU path,
 * without CPU readback/upload between passes). The texture is bound to unit 0 inside —
 * the context cache's first initialization (ctxOf) rebinds units 0-8 to its own textures,
 * and an early binding made by the caller was overwritten (the first render went black).
 * reuseLuma/reuseBlurs — the luma/blurs are already in textures with the same sigmas at the caller
 * (detail of the same frame with the same sigmas, only values/tables changed).
 * dstTex — draw the combine pass into this texture (FBO orientation) instead of a readback; returns null.
 * By default returns a Float32Array RGBA readback (row 0 at the top); with no tools
 * in the control — a copy of the input, the passes are not needed anyway.
 */
export function applyDetailGL(gl, d, rgba, w, h, control, { scale = null, srcTex = null,
  reuseLuma = false, reuseBlurs = false, dstTex = null, base = false } = {}) {
  const c = ctxOf(gl, d);
  scale = scale || scaleOf(d, w, h);
  const ents = entries(d, control, scale, base);
  const float = rgba instanceof Float32Array;

  // input image: bound after ctxOf — its first initialization rebinds
  // units 0-8 to its own textures and would drop the binding made by the caller earlier.
  if (srcTex) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
  } else {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, c.tex.img);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA32F : gl.RGBA8, w, h, 0, gl.RGBA,
      float ? gl.FLOAT : gl.UNSIGNED_BYTE, rgba);
  }

  const U = (p, n) => gl.getUniformLocation(p, n);
  // a pass into the texture name: storage is allocated once per size, then texSubImage is not
  // needed (the shader rewrites everything) — reallocating an RGBA32F of 6-24 MB per render is expensive.
  // reuse*: the sizes match by the key construction in renderer._detailMatch.
  if (!c.dims) c.dims = {};
  const drawTo = (name, unit, internal, format, type, prog, setup) => {
    gl.useProgram(prog);
    setup(prog);
    const t = c.tex[name];
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    const dim = `${w}x${h}x${internal}`;
    if (c.dims[name] !== dim) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      c.dims[name] = dim;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // source luma -> texY
  if (!reuseLuma)
    drawTo("y", 1, gl.R32F, gl.RED, gl.FLOAT, c.luma, (p) => {
      gl.uniform1i(U(p, "uSrc"), 0);
      gl.uniform3f(U(p, "uYW"), d.YW[0], d.YW[1], d.YW[2]);
    });

  // blurs: horizontally into a temporary texture, vertically into its own;
  // the kernel is fftKernel, shared with CPU, uploaded into the uKern texture (1 x (2R+1), R32F)
  const maxE = Math.min(ents.length, 4);
  if (!reuseBlurs && ents.length) {
    const kerns = ents.slice(0, maxE).map((e) => ({ e, kx: fftKernel(e.sigma, w, h), ky: fftKernel(e.sigma, h, w) }));
    const kern32 = new Float32Array(2 * Math.max(1, ...kerns.map(({ kx, ky }) => Math.max(kx.R, ky.R))) + 1);
    const uploadKern = (k) => {
      kern32.fill(0);
      kern32.set(k.g);
      gl.activeTexture(gl.TEXTURE8);
      gl.bindTexture(gl.TEXTURE_2D, c.tex.kern);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, k.g.length, 1, 0, gl.RED, gl.FLOAT, kern32.subarray(0, k.g.length));
    };
    kerns.forEach(({ kx, ky }, i) => {
      const setup = (R, src, dirX) => (p) => {
        gl.uniform1i(U(p, "uSrc"), src);
        gl.uniform1i(U(p, "uKern"), 8);
        gl.uniform2i(U(p, "uSize"), w, h);
        gl.uniform1i(U(p, "uRadius"), R);
        gl.uniform2f(U(p, "uDir"), dirX, 1 - dirX);
      };
      uploadKern(kx);
      drawTo("h", 2, gl.R32F, gl.RED, gl.FLOAT, c.blur, setup(kx.R, 1, 1));
      uploadKern(ky);
      drawTo("b" + i, 4 + i, gl.R32F, gl.RED, gl.FLOAT, c.blur, setup(ky.R, 2, 0));
    });
  }

  // combine: rgb + sum value*table(Y)*(Y - blur)
  // The renderer rebinds units 0/4/5/7 between renders (its profile output, the final frame,
  // the neutral) — the passes above rebind the blur units as they write them, but the reuse
  // path (the same LUT/detail plan, reuseLuma/reuseBlurs) skips them, so rebind the combine
  // inputs explicitly: without this the reuse path read the renderer's textures as blurs.
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, c.tex.y);
  for (let i = 0; i < 4; i++) {
    gl.activeTexture(gl.TEXTURE4 + i);
    gl.bindTexture(gl.TEXTURE_2D, c.tex["b" + i]);
  }
  gl.useProgram(c.combine);
  gl.uniform1i(U(c.combine, "uImg"), 0);
  gl.uniform1i(U(c.combine, "uY"), 1);
  gl.uniform1i(U(c.combine, "uB0"), 4);
  gl.uniform1i(U(c.combine, "uB1"), 5);
  gl.uniform1i(U(c.combine, "uB2"), 6);
  gl.uniform1i(U(c.combine, "uB3"), 7);
  gl.uniform1i(U(c.combine, "uNB"), d.NB);
  gl.uniform1i(U(c.combine, "uCount"), maxE);
  const vals = new Float32Array(4), tabs = new Float32Array(48);
  ents.slice(0, maxE).forEach((e, i) => {
    vals[i] = e.value;
    for (let k = 0; k < d.NB; k++) tabs[i * 12 + k] = e.table[k];
  });
  gl.uniform1fv(U(c.combine, "uVal"), vals);
  gl.uniform1fv(U(c.combine, "uTab"), tabs);
  gl.uniform2i(U(c.combine, "uSize"), w, h);
  gl.uniform1i(U(c.combine, "uFlip"), 0);
  if (dstTex) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return null;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, c.tex.out, 0);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, c.tex.out);
  if (c.dims.out !== `${w}x${h}xout`) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    c.dims.out = `${w}x${h}xout`;
  }
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // a float attachment is only readable as RGBA/FLOAT (UNSIGNED_BYTE — INVALID_OPERATION)
  const out = new Float32Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
  return out;
}

// ---------- WebGL2: region mode (spec/ui-zoom-plan.md Z4) ----------
//
// The region path never touches the textures of applyDetailGL (ctxOf's c.tex / c.dims, the renderer's
// detail reuse cache): it takes the compiled programs from the shared context cache and keeps all
// textures in a caller-owned store (createDetailStore / disposeDetailStore).

/** A bag of textures for the region path; the renderer owns it and deletes it with disposeDetailStore. */
export function createDetailStore() {
  return { tex: {}, dims: {} };
}

export function disposeDetailStore(gl, st) {
  for (const t of Object.values(st.tex)) gl.deleteTexture(t);
  st.tex = {};
  st.dims = {};
}

/** The shared (main path) blur texture b0..b3 / luma y of applyDetailGL's context, read-only use by the
 *  renderer when the main detail cache already holds the wanted blur. null if the context is unset. */
export function mainDetailTexture(gl, name) {
  const c = ctxCache.get(gl);
  return c ? c.tex[name] : null;
}

function stTex(gl, st, name) {
  let t = st.tex[name];
  if (!t) {
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    st.tex[name] = t;
  }
  return t;
}

/** Allocates (once per size/format) and returns store texture `name`, bound to `unit`. */
export function storeTexture(gl, st, name, unit, internal, format, type, w, h) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  const known = !!st.tex[name];
  const t = stTex(gl, st, name);
  if (known) gl.bindTexture(gl.TEXTURE_2D, t);
  const dim = `${w}x${h}x${internal}`;
  if (st.dims[name] !== dim) {
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    st.dims[name] = dim;
  }
  return t;
}

function storeDraw(gl, c, st, name, unit, internal, format, type, w, h, prog, setup) {
  gl.useProgram(prog);
  setup(prog);
  const t = storeTexture(gl, st, name, unit, internal, format, type, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return t;
}

/** Luma (R32F) of an RGBA32F source texture into store texture `name`. */
export function lumaPassGL(gl, d, st, name, srcTex, w, h) {
  const c = ctxOf(gl, d);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  return storeDraw(gl, c, st, name, 1, gl.R32F, gl.RED, gl.FLOAT, w, h, c.luma, (p) => {
    gl.uniform1i(gl.getUniformLocation(p, "uSrc"), 0);
    gl.uniform3f(gl.getUniformLocation(p, "uYW"), d.YW[0], d.YW[1], d.YW[2]);
  });
}

/** Gaussian blur (fftKernel, reflect edges) of a luma texture (w x h, R32F) into store texture
 *  `outName`, through the temporary `tmpName`. */
export function blurPassGL(gl, d, st, lumaTex, w, h, sigma, outName, tmpName) {
  const c = ctxOf(gl, d);
  const kx = fftKernel(sigma, w, h), ky = fftKernel(sigma, h, w);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lumaTex);
  const upload = (k) => {
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, stTex(gl, st, "kern"));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, k.g.length, 1, 0, gl.RED, gl.FLOAT, Float32Array.from(k.g));
  };
  const setup = (R, src, dirX) => (p) => {
    gl.uniform1i(gl.getUniformLocation(p, "uSrc"), src);
    gl.uniform1i(gl.getUniformLocation(p, "uKern"), 8);
    gl.uniform2i(gl.getUniformLocation(p, "uSize"), w, h);
    gl.uniform1i(gl.getUniformLocation(p, "uRadius"), R);
    gl.uniform2f(gl.getUniformLocation(p, "uDir"), dirX, 1 - dirX);
  };
  upload(kx);
  storeDraw(gl, c, st, tmpName, 2, gl.R32F, gl.RED, gl.FLOAT, w, h, c.blur, setup(kx.R, 1, 1));
  upload(ky);
  return storeDraw(gl, c, st, outName, 4, gl.R32F, gl.RED, gl.FLOAT, w, h, c.blur, setup(ky.R, 2, 0));
}

// The region combine pass: rgb + sum value*table(Y)*(Y - blur), with the blur of each entry either the
// region's own (texelFetch at the pixel) or the main frame's (uMode 1: bilinear at the affine-mapped
// main coordinate, edges clamped; manual bilinear since linear filtering of R32F needs an extension).
const COMBINE_REGION_FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
#define MAXE 4
uniform sampler2D uImg;
uniform sampler2D uY;
uniform sampler2D uB0, uB1, uB2, uB3;
uniform int uNB;
uniform int uCount;
uniform int uMode[MAXE];
uniform float uVal[MAXE];
uniform float uTab[MAXE * 12];
uniform ivec2 uMainSize;
uniform vec3 uAx;           // mainX = a X + b Y + c
uniform vec3 uAy;           // mainY = d X + e Y + f
out vec4 o;
float bil(sampler2D s, vec2 q) {
  vec2 u = q - 0.5;
  vec2 f0 = floor(u);
  vec2 t = u - f0;
  ivec2 hi = uMainSize - 1;
  ivec2 a = clamp(ivec2(f0), ivec2(0), hi);
  ivec2 b = clamp(ivec2(f0) + 1, ivec2(0), hi);
  float top = texelFetch(s, ivec2(a.x, a.y), 0).r * (1.0 - t.x) + texelFetch(s, ivec2(b.x, a.y), 0).r * t.x;
  float bot = texelFetch(s, ivec2(a.x, b.y), 0).r * (1.0 - t.x) + texelFetch(s, ivec2(b.x, b.y), 0).r * t.x;
  return top * (1.0 - t.y) + bot * t.y;
}
float blured(int e, ivec2 p, vec2 q) {
  bool m = uMode[e] == 1;
  if (e == 0) return m ? bil(uB0, q) : texelFetch(uB0, p, 0).r;
  if (e == 1) return m ? bil(uB1, q) : texelFetch(uB1, p, 0).r;
  if (e == 2) return m ? bil(uB2, q) : texelFetch(uB2, p, 0).r;
  return m ? bil(uB3, q) : texelFetch(uB3, p, 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 X = gl_FragCoord.xy;   // (x + 0.5, y + 0.5)
  vec2 q = vec2(dot(uAx, vec3(X, 1.0)), dot(uAy, vec3(X, 1.0)));
  float y = texelFetch(uY, p, 0).r;
  float dy = 0.0;
  for (int e = 0; e < MAXE; e++) {
    if (e >= uCount) break;
    float u = clamp(y, 0.0, 1.0) * float(uNB - 1);
    int i = min(int(u), uNB - 2);
    float f = u - float(i);
    float t = mix(uTab[e * 12 + i], uTab[e * 12 + i + 1], f);
    dy += uVal[e] * t * (y - blured(e, p, q));
  }
  o = vec4(clamp(texelFetch(uImg, p, 0).rgb + dy, 0.0, 1.0), 1.0);
}`;

/**
 * Detail of a region on GPU (the shader twin of applyDetailCPU with lowRes). srcTex — the region's
 * RGBA32F frame (w x h, row 0 at the top), dstTex — an RGBA32F texture of the same size to draw into.
 * store — createDetailStore() (luma, blurs of the region live there). Without lowRes every blur runs
 * on the region. lowRes: { affine, mainW, mainH, mainScale, minSigma?, mainBlur(mainSigma, slot) ->
 * WebGLTexture } — mainBlur returns the R32F blur (mainW x mainH) of the main frame's luma with the
 * fftKernel of that sigma; the texture must stay valid until this call returns. Returns the number of
 * entries (0 means no active tool: dstTex is not written, the caller uses the input).
 */
export function applyDetailRegionGL(gl, d, srcTex, w, h, control, { scale, base = false, lowRes = null,
  store, dstTex } = {}) {
  const c = ctxOf(gl, d);
  const ents = entries(d, control, scale, base).slice(0, 4);
  if (!ents.length) return 0;
  const split = regionEntries(d, control, scale, { base, lowRes });
  const yTex = lumaPassGL(gl, d, store, "y", srcTex, w, h);
  const blurTex = ents.map((e, i) => {
    if (split[i].mainSigma !== null) return lowRes.mainBlur(split[i].mainSigma, i);
    return blurPassGL(gl, d, store, yTex, w, h, e.sigma, "b" + i, "h");
  });
  const U = (n) => gl.getUniformLocation(c.regionCombine, n);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, yTex);
  for (let i = 0; i < 4; i++) {
    gl.activeTexture(gl.TEXTURE4 + i);
    gl.bindTexture(gl.TEXTURE_2D, blurTex[i] || yTex);     // unused slots: any valid texture
  }
  gl.useProgram(c.regionCombine);
  gl.uniform1i(U("uImg"), 0);
  gl.uniform1i(U("uY"), 1);
  for (let i = 0; i < 4; i++) gl.uniform1i(U("uB" + i), 4 + i);
  gl.uniform1i(U("uNB"), d.NB);
  gl.uniform1i(U("uCount"), ents.length);
  const vals = new Float32Array(4), tabs = new Float32Array(48), modes = new Int32Array(4);
  ents.forEach((e, i) => {
    vals[i] = e.value;
    modes[i] = split[i].mainSigma !== null ? 1 : 0;
    for (let k = 0; k < d.NB; k++) tabs[i * 12 + k] = e.table[k];
  });
  gl.uniform1iv(U("uMode"), modes);
  gl.uniform1fv(U("uVal"), vals);
  gl.uniform1fv(U("uTab"), tabs);
  const A = lowRes ? lowRes.affine : [1, 0, 0, 0, 1, 0];
  gl.uniform2i(U("uMainSize"), lowRes ? lowRes.mainW : 1, lowRes ? lowRes.mainH : 1);
  gl.uniform3f(U("uAx"), A[0], A[1], A[2]);
  gl.uniform3f(U("uAy"), A[3], A[4], A[5]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return ents.length;
}
