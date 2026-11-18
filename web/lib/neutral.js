// Nikon neutral on GPU (WebGL2): vignetting and devmodel development over the camera linear RGB.
// Python pair: vignette.radius/gain/correct, devmodel.Dev.base/__call__, ceiling.Lut.__call__,
// the model format is web/export_model.py. Change policy: spec/web-tests.md.

export const VERTEX = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0; gl_Position = vec4(p, 0, 1); }`;

/** GLSL declarations and functions: vec3 vignette(vec3 lin, ivec2 p, ivec2 size), vec3 neutral(vec3 lin). */
export function neutralGLSL(model) {
  const NK = model.dev.w.length;
  return `
uniform mat3 devM; uniform float devW[${NK}]; uniform float devK0, devK1, devFloor;
uniform int devN, devUseLut; uniform highp sampler3D devLut; uniform vec2 vigAB;
const int DEV_NK = ${NK};
// devmodel.Dev.base: np.interp(log2 z, KNOTS, w) over uniform knots, edge values outside the range
float devCurve(float z) {
  float t = clamp((log2(max(z, devFloor)) - devK0) / (devK1 - devK0) * float(DEV_NK - 1), 0.0, float(DEV_NK - 1));
  int i = min(int(t), DEV_NK - 2);
  return mix(devW[i], devW[i + 1], t - float(i));
}
// ceiling.Lut.__call__: trilinear via texelFetch (hardware interpolation has 8-bit weights)
vec3 devLutDelta(vec3 b) {
  vec3 u = clamp(b, 0.0, 1.0) * float(devN - 1);
  ivec3 i = min(ivec3(u), ivec3(devN - 2));
  vec3 f = u - vec3(i);
  vec3 s = vec3(0);
  for (int dr = 0; dr < 2; dr++) for (int dg = 0; dg < 2; dg++) for (int db = 0; db < 2; db++) {
    float wt = (dr == 1 ? f.r : 1.0 - f.r) * (dg == 1 ? f.g : 1.0 - f.g) * (db == 1 ? f.b : 1.0 - f.b);
    s += wt * texelFetch(devLut, ivec3(i.b + db, i.g + dg, i.r + dr), 0).rgb;
  }
  return s;
}
// vignette.correct: gain 2^(a r^2 + b r^4), r from the center to the corner; p is the pixel, row 0 at the top
vec3 vignette(vec3 lin, ivec2 p, ivec2 size) {
  vec2 c = vec2(p) + 0.5 - vec2(size) * 0.5;
  float r2 = dot(c, c) / dot(vec2(size) * 0.5, vec2(size) * 0.5);
  return lin * exp2(vigAB.x * r2 + vigAB.y * r2 * r2);
}
// devmodel.Dev.__call__: matrix, curve, residual LUT; the result is neutral sRGB 0..1
vec3 neutral(vec3 lin) {
  vec3 z = devM * lin;
  vec3 b = clamp(vec3(devCurve(z.r), devCurve(z.g), devCurve(z.b)), 0.0, 1.0);
  return devUseLut == 1 ? clamp(b + devLutDelta(b), 0.0, 1.0) : b;
}`;
}

/** The model from web/model (export_model.py). base — the URL of the web/ folder. */
export async function loadModel(base = "") {
  const dev = await (await fetch(base + "model/dev.json")).json();
  const lut = new Float32Array(await (await fetch(base + "model/dev_lut.bin")).arrayBuffer());
  return { dev, lut };
}

export function program(gl, fragment) {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);
  gl.bindVertexArray(gl.createVertexArray());
  return p;
}

export function texture(gl, unit, target) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t);
  for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(target, k, gl.NEAREST);
  for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(target, k, gl.CLAMP_TO_EDGE);
  return t;
}

/** Loads the model into the program: LUT into the texture unit lutUnit, the rest into uniforms. */
export function bindModel(gl, prog, model, lutUnit) {
  const U = (n) => gl.getUniformLocation(prog, n);
  texture(gl, lutUnit, gl.TEXTURE_3D);
  const n = model.dev.n;
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, model.lut);
  gl.uniform1i(U("devLut"), lutUnit);
  // numpy: x @ M.T, i.e. z = M x; GLSL stores mat3 by columns, so transpose
  gl.uniformMatrix3fv(U("devM"), true, model.dev.M.flat());
  gl.uniform1fv(U("devW"), model.dev.w);
  gl.uniform1f(U("devK0"), model.dev.knots[0]); gl.uniform1f(U("devK1"), model.dev.knots[1]);
  gl.uniform1f(U("devFloor"), model.dev.floor);
  gl.uniform1i(U("devN"), n);
  gl.uniform1i(U("devUseLut"), 1);
  gl.uniform2f(U("vigAB"), 0, 0);
}

/** Linear RGB float32 (row 0 at the top) into an RGB32F texture. */
export function uploadLinear(gl, unit, tex, w, h, rgb) {
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, w, h, 0, gl.RGB, gl.FLOAT, rgb);
}
