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

// Enabled tools: (part, sigma, table, value) for each sigma of an active tool.
function entries(d, control, scale) {
  const out = [];
  for (const tool of d.tools) {
    const v = Number(control[tool]);
    if (!v) continue;
    const p = partOf(d, tool, scale);
    if (p === null) continue;
    const tab = v > 0 ? p.plus : p.minus;
    p.sigmas.forEach((s, i) => out.push({ sigma: s / scale, table: tab.subarray(i * d.NB, (i + 1) * d.NB), value: v }));
  }
  return out;
}

/** A detail plan for caching: the number of active contributions and their sigmas (≤4). Luma
 *  and blurs depend only on the input frame and sigma — when only tool values/tables change
 *  (the same sigma set), they can be left alone, only the combine pass (renderer.js, plan §5 P2). */
export function detailPlan(d, control, scale) {
  const ents = entries(d, control, scale);
  return { count: ents.length, sigmas: ents.slice(0, 4).map((e) => e.sigma) };
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

/** dY for the luma y (Float64Array, row-major h x w). Port of Part.delta, summed over tools. */
function deltaCPU(d, y, w, h, ents, scale) {
  const dy = new Float64Array(y.length);
  for (const e of ents) {
    const g = gaussCPU(y, w, h, e.sigma);
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
      for (let i = -kx.R; i <= kx.R; i++) s += kx.g[i + kx.R] * a[y * w + mir(x + i, w)];
      tmp[y * w + x] = s;
    }
  for (let y = 0; y < h; y++)                    // columns
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -ky.R; i <= ky.R; i++) s += ky.g[i + ky.R] * tmp[mir(y + i, h) * w + x];
      out[y * w + x] = s;
    }
  return out;
}

/** A full detail pass on CPU: rgb (h x w x 3, row-major, row 0 at the top) -> Float64Array 0..1. */
export function applyDetailCPU(d, rgb, w, h, control, { scale = null } = {}) {
  scale = scale || scaleOf(d, w, h);
  const ents = entries(d, control, scale);
  const [yr, yg, yb] = d.YW;
  const y = new Float64Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 3) y[i] = yr * rgb[p] + yg * rgb[p + 1] + yb * rgb[p + 2];
  const dy = ents.length ? deltaCPU(d, y, w, h, ents, scale) : new Float64Array(w * h);
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
  reuseLuma = false, reuseBlurs = false, dstTex = null } = {}) {
  const c = ctxOf(gl, d);
  scale = scale || scaleOf(d, w, h);
  const ents = entries(d, control, scale);
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
