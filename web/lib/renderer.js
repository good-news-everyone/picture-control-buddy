// Full frame render: linear RAW -> devmodel neutral -> profile LUT -> detail.
// The render.py pipeline assembled in one module for the preview and reference tests.
// The order is as in Python: neutral (matrix, curve, devmodel correction LUT), on top —
// the 33^3 trilinear profile LUT (the same weights as the CPU applyLUT: 8 exact texelFetches,
// hardware interpolation is not used), then detail.Detail over the Y' luma.
//
// Caches and the performance invariant: the neutral depends only on the frame (and vignetting),
// the LUT — only on the Control color fields (lutKeyOf: without name, comment and detail —
// plan §5 P1). setFrame recomputes the neutral once, repeated setProfile + render calls do
// not touch either the decoding or the neutral. The stats counters verify this in tests.
// The LUT is built in a Worker (app.js) and arrives here ready via uploadLut; the synchronous
// buildLUT remains a fallback for tests and a Worker failure. Detail caches the luma and
// blurs between edits of only tool values/tables (same frame, same LUT, same sigmas). The
// final frame is kept in the "final" texture — before/after returns it with a blit.
//
// Vignetting is not part of the application (plan section 3): vigAB = (0, 0) by default.
// Level 7 is compared with render.py, which does apply vignetting — so render accepts an
// optional vigAB (values from golden, like levels 2/2a).
import { neutralGLSL, bindModel, texture } from "./neutral.js";
import { buildLUT } from "./profile.js";
import { applyDetailGL, detailPlan, scaleOf } from "./detail.js";
import { serialize, COLORS, ZONES } from "./np3.js";

const NEUTRAL_FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
uniform sampler2D uLin; uniform ivec2 uSize;
__NEUTRAL_GLSL__
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);   // texture space: row 0 is the top of the frame
  vec3 lin = vignette(texelFetch(uLin, p, 0).rgb, p, uSize);
  o = vec4(neutral(lin), 1.0);
}`;

// Trilinear application of the profile LUT — the CPU applyLUT/profile.js formula and render.trilinear:
// 8 exact samples, weights (1-f), f along the axes. The 3D texture: x — b, y — g, z — r
// (buildLUT yields (r*n+g)*n+b, texImage3D puts the last axis into x — as in devLutDelta).
const PROFILE_FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
uniform sampler2D uBase;
uniform highp sampler3D uProf;
uniform int uProfN;
out vec4 o;
vec3 profLut(vec3 b) {
  vec3 u = clamp(b, 0.0, 1.0) * float(uProfN - 1);
  ivec3 i = min(ivec3(u), ivec3(uProfN - 2));
  vec3 f = u - vec3(i);
  vec3 s = vec3(0.0);
  for (int dr = 0; dr < 2; dr++) for (int dg = 0; dg < 2; dg++) for (int db = 0; db < 2; db++) {
    float wt = (dr == 1 ? f.r : 1.0 - f.r) * (dg == 1 ? f.g : 1.0 - f.g) * (db == 1 ? f.b : 1.0 - f.b);
    s += wt * texelFetch(uProf, ivec3(i.b + db, i.g + dg, i.r + dr), 0).rgb;
  }
  return s;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = vec4(clamp(profLut(texelFetch(uBase, p, 0).rgb), 0.0, 1.0), 1.0);   // np.clip in render.apply
}`;

// Texture blit: into another texture (same orientation) or to the screen (sample flipping:
// pass textures are in FBO orientation, row 0 at the top, the default framebuffer requires
// row 0 at the bottom). uFlip=1 — flip (->screen), 0 — as is (texture->texture).
const BLIT_FRAG = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uSrc; uniform ivec2 uSize;
uniform bool uFlip;
out vec4 o;
void main() {
  ivec2 sp = ivec2(gl_FragCoord.xy);
  ivec2 p = uFlip ? ivec2(sp.x, uSize.y - 1 - sp.y) : sp;
  o = texelFetch(uSrc, p, 0);
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
  gl.attachShader(p, sh(gl.VERTEX_SHADER, `#version 300 es
void main() { vec2 q = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0; gl_Position = vec4(q, 0.0, 1.0); }`));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// The LUT key: only what profile.paramsOf reads — grading, Saturation, blender,
// curve (or tonal sliders), Blending, Balance. The name, comment and detail do not
// change pixels: editing them must not build a LUT or start a render (plan §5, P1).
function lutKeyOf(c) {
  const tone = c.curve ? null : [c.contrast, c.highlights, c.shadows, c.white, c.black];
  return JSON.stringify([
    c.saturation, c.curve ? c.curve.raw : null, tone,
    c.blending, c.balance,
    ZONES.map((z) => c.grade[z]), COLORS.map((k) => c.blender[k]),
  ]);
}

export class Renderer {
  /**
   * gl — a WebGL2 context; models — {dev: neutral.js loadModel(), profile: profile.js
   * loadModel(), detail: detail.js loadDetail()}; raw — {develop} from lib/raw.js;
   * onDevelop — a hook for tests (called on every develop).
   */
  constructor(gl, models, raw, { onDevelop = null } = {}) {
    this.gl = gl;
    this.models = models;
    this.raw = raw;
    this.onDevelop = onDevelop;
    // attached RGBA32F/R32F textures are renderable only with the extension enabled:
    // without getExtension here the first neutral pass went into an incomplete framebuffer.
    if (!gl.getExtension("EXT_color_buffer_float"))
      throw new Error("EXT_color_buffer_float is required for rendering");
    this.neutralProg = compile(gl, NEUTRAL_FRAG.replace("__NEUTRAL_GLSL__", neutralGLSL(models.dev)));
    this.profileProg = compile(gl, PROFILE_FRAG);
    this.blitProg = compile(gl, BLIT_FRAG);
    gl.useProgram(this.neutralProg);
    bindModel(gl, this.neutralProg, models.dev, 1);   // dev LUT and uniforms once per program
    this.fbo = gl.createFramebuffer();
    this.tex = {};
    this.frame = null;          // {w, h, rgb} of the last develop
    this.frameTag = 0;          // grows on setFrame: a tag for the detail and final caches
    this.neutralCache = null;   // {key, tex, rgba?} — rgba (CPU copy) only on request
    this.lutCache = new Map();  // key — lutCacheKey(n), up to 4 most recent LUTs
    this.lutN = 33;             // the interactive preview sets less (app.js, see plan §5)
    this._detail = null;        // the detail luma/blur cache
    this.finalKey = null;       // the key of the final frame in the "final" texture (before/after)
    this.stats = { develops: 0, neutrals: 0, luts: 0, reads: 0, lutDrops: 0, detailSkips: 0 };
    gl.bindVertexArray(gl.createVertexArray());
  }

  /** Frame decoding: develop + linear cache. A repeated call for the same file is not needed —
   *  the neutral and LUT live in caches between profile edits. */
  async setFrame(bytes, { long = 1600 } = {}) {
    this.stats.develops++;
    if (this.onDevelop) this.onDevelop();
    this.frame = this.raw.develop(bytes, long);
    this.frameTag++;
    this.neutralCache = null;
    this._detail = null;
    this.finalKey = null;
    return this.frame;
  }

  /** Profile control: stores it and computes the narrow LUT key (color/tone only). */
  setProfile(control) {
    this.control = control;
    this.lutKey = lutKeyOf(control);
    return this.lutKey;
  }

  /** The LUT cache key for resolution n. */
  lutCacheKey(n) { return `${this.lutKey}/${n}`; }
  hasLut(key) { return this.lutCache.has(key); }

  /** Uploads a ready LUT (Float32Array n^3 x 3, from a Worker) into a texture with caching.
   *  Eviction deletes the texture explicitly instead of relying on the browser GC (plan §5, P2). */
  uploadLut(key, n, data) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, k, gl.NEAREST);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, data);
    while (this.lutCache.size >= 4) {
      const old = this.lutCache.keys().next().value;
      gl.deleteTexture(this.lutCache.get(old).tex);
      this.lutCache.delete(old);
      this.stats.lutDrops++;
    }
    this.lutCache.set(key, { n, tex });
    this.stats.luts++;
  }

  _tex(name, unit) {
    let t = this.tex[name];
    if (!t) {
      t = texture(this.gl, unit, this.gl.TEXTURE_2D);
      this.tex[name] = t;
    }
    return t;
  }

  _draw(toTex, w, h, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, toTex, 0);
    setup();
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Texture blit src -> dst (null — the screen). flip — flip the sampling (screen). */
  _blit(src, dst, w, h, flip) {
    const gl = this.gl;
    gl.useProgram(this.blitProg);
    gl.uniform1i(gl.getUniformLocation(this.blitProg, "uSrc"), 7);
    gl.uniform2i(gl.getUniformLocation(this.blitProg, "uSize"), w, h);
    gl.uniform1i(gl.getUniformLocation(this.blitProg, "uFlip"), flip ? 1 : 0);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, src);
    if (dst) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The GPU texture of the frame's neutral (no vignetting by default; vigAB is for tests).
   *  Without CPU readback: the preview path (render/neutralToScreen) only draws. */
  _ensureNeutral({ vignette = [0, 0] } = {}) {
    const gl = this.gl;
    const { w, h, rgb } = this.frame;
    const key = `${w}x${h}:${vignette[0]},${vignette[1]}`;
    if (this.neutralCache && this.neutralCache.key === key) return this.neutralCache;
    this.stats.neutrals++;
    const lin = this._tex("lin", 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, lin);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, w, h, 0, gl.RGB, gl.FLOAT, rgb);
    gl.useProgram(this.neutralProg);
    gl.uniform1i(gl.getUniformLocation(this.neutralProg, "uLin"), 0);
    gl.uniform2i(gl.getUniformLocation(this.neutralProg, "uSize"), w, h);
    gl.uniform2f(gl.getUniformLocation(this.neutralProg, "vigAB"), vignette[0], vignette[1]);
    const out = this._tex("neutral", 7);
    this._draw(out, w, h, () => {
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, out);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    });
    this.neutralCache = { key, tex: out };
    return this.neutralCache;
  }

  /** The frame's neutral as a CPU copy (Float32Array RGBA, row 0 at the top). Lazy: the readback
   *  happens once per key and only here — for tests and the external API (plan §5, P2:
   *  the application path does no readback, the stats.reads counter verifies this). */
  neutralRGBA({ vignette = [0, 0] } = {}) {
    const gl = this.gl;
    const { w, h } = this.frame;
    const c = this._ensureNeutral({ vignette });
    if (!c.rgba) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, c.tex, 0);
      const rgba = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      this.stats.reads++;
      c.rgba = rgba;
    }
    return c.rgba;
  }

  _profileTex() {
    const key = this.lutCacheKey(this.lutN);
    let lut = this.lutCache.get(key);
    if (!lut) {
      // Synchronous fallback (levels 5/7, LUT Worker failure); the application loads ready LUTs.
      this.uploadLut(key, this.lutN, buildLUT(this.models.profile, this.control, this.lutN));
      lut = this.lutCache.get(key);
    }
    return lut;
  }

  _ensureFinal(w, h) {
    const gl = this.gl;
    const t = this._tex("final", 5);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (this._finalSize !== `${w}x${h}`) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this._finalSize = `${w}x${h}`;
    }
    return t;
  }

  _expectedFinalKey() {
    const c = this.control || {};
    return `${this.frameTag}|${this.lutKey}|${this.lutN}|${c.sharpening},${c.mid_sharpening},${c.clarity}`;
  }

  /** Is the final frame (the last toScreen render) still valid for the current state? */
  hasFinal() { return this.finalKey != null && this.finalKey === this._expectedFinalKey(); }

  /** Return the final frame to the screen with a blit — before/after without a full render (plan §5, P2). */
  blitFinal() {
    const { w, h } = this.frame;
    this._blit(this._tex("final", 5), null, w, h, true);
  }

  /** The detail luma/blurs are reusable: the same frame, the same LUT (the same profOut),
   *  the same scale and the same sigma set — only tool values/tables changed. */
  _detailMatch(plan, k, w, h) {
    const t = this._detail;
    return !!t && t.tag === this.frameTag && t.key === `${this.lutKey}/${this.lutN}`
      && t.k === k && t.w === w && t.h === h
      && t.sig.length === plan.sigmas.length && t.sig.every((s, i) => s === plan.sigmas[i]);
  }

  /**
   * Full render: neutral (cache) -> profile LUT (cache) -> detail. Returns Float32Array
   * RGBA, row 0 at the top. Options: vignette [a, b] for the test path, scale for
   * detail (by default as in render.py: SENSOR_LONG / max(w, h)), toScreen — the result goes
   * into the "final" texture and a blit to the screen (preview; returns null, the result is
   * suitable for blitFinal in before/after). The neutral texture after _ensureNeutral is already on the GPU.
   */
  render({ vignette = [0, 0], scale = null, toScreen = false } = {}) {
    const gl = this.gl;
    const { w, h } = this.frame;
    this._ensureNeutral({ vignette });
    const lut = this._profileTex();
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, this._tex("neutral", 7));
    gl.useProgram(this.profileProg);
    gl.uniform1i(gl.getUniformLocation(this.profileProg, "uBase"), 7);
    gl.uniform1i(gl.getUniformLocation(this.profileProg, "uProf"), 3);
    gl.uniform1i(gl.getUniformLocation(this.profileProg, "uProfN"), lut.n);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, lut.tex);
    const profOut = this._tex("prof", 4);
    this._draw(profOut, w, h, () => {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, profOut);
      if (this._profSize !== `${w}x${h}`) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        this._profSize = `${w}x${h}`;
      }
    });
    const d = this.models.detail;
    const k = scale || scaleOf(d, w, h);
    // with the NX base detail (spec/ui.md decision #18): every render, not a profile field
    const plan = detailPlan(d, this.control, k, { base: true });
    const reuse = plan.count > 0 && this._detailMatch(plan, k, w, h);
    if (reuse) this.stats.detailSkips++;
    const fin = toScreen ? this._ensureFinal(w, h) : null;
    let out = null;
    if (plan.count === 0 && fin) {
      // no active tools: the profile frame is the result, we do not touch detail
      this._blit(profOut, fin, w, h, false);
      this._detail = null;
    } else {
      out = applyDetailGL(gl, d, null, w, h, this.control, {
        scale: k, base: true, srcTex: profOut, reuseLuma: reuse, reuseBlurs: reuse, dstTex: fin,
      });
      if (plan.count > 0 && !reuse)
        this._detail = { tag: this.frameTag, key: `${this.lutKey}/${this.lutN}`, k, w, h, sig: plan.sigmas };
      else if (plan.count === 0) this._detail = null;
    }
    if (fin) {
      this._blit(fin, null, w, h, true);
      this.finalKey = this._expectedFinalKey();
      return null;
    }
    return out;
  }

  /** The Y' luma histogram (detail.YW weights) of the neutral frame: 256 bins 0..255, normalized
   *  to the peak = 1. Lazy: the neutral readback is cached, the binning runs once per frame; for
   *  the histogram backdrop under the curve (shown only when the curve is enabled). */
  lumaHistogram() {
    const { w, h } = this.frame;
    const rgba = this.neutralRGBA();
    if (this._histRgba === rgba) return this._hist;
    const [yr, yg, yb] = this.models.detail.YW;
    const bins = new Float32Array(256);
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const y = (yr * rgba[p] + yg * rgba[p + 1] + yb * rgba[p + 2]) * 255;
      bins[Math.min(255, y | 0)]++;
    }
    let max = 0;
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];
    if (max > 0) for (let i = 0; i < 256; i++) bins[i] /= max;
    this._histRgba = rgba;
    this._hist = bins;
    return bins;
  }

  /** The "before" of the preview: the Nikon neutral straight to the screen, without readback and without a LUT. */
  neutralToScreen({ vignette = [0, 0] } = {}) {
    const { w, h } = this.frame;
    this._blit(this._ensureNeutral({ vignette }).tex, null, w, h, true);
  }
}
