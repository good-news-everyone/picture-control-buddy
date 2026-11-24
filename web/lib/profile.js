// Step-based profile model for the browser: a port of profile_model.Model/Pixels and model.apply_curve.
// The operation order is as in Python: zone grading (masks over Y', zone brightness) -> Saturation
// (Cb/Cr in Y'CbCr) -> blender (color shares by Oklab hue, responses in CIELab) -> curve
// (own or the sum of tonal sliders) over Rec.601 Y'. The math repeats Python step by step,
// the numpy interpolation np.interp is ported by hand (npInterp). Hue angles are in radians with wrap.
// Pure functions over Float64Array (n, 3), no DOM. Field names are snake_case as in Python.
//
// Loading the model: loadModel(profile.json, ArrayBuffer profile.bin) — synchronous, from any
// environment; fetchModel(baseUrl) — a convenient wrapper for the browser.
// LUT building: buildLUT(model, control, n) -> Float32Array n^3 x 3, index (r*n + g)*n + b,
// as in render.Renderer.lut. CPU application: applyLUT(lut, n, rgb) and per-pixel applyLUT1 —
// both are suitable as a reference for a future shader preparation.
import { srgbToLab, labToSrgb, linearToOklab, srgbToLinearRows } from "./color.js";

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------- np.interp: as in numpy, xp increasing, the edges are constant ----------
function npInterp(x, xp, fp) {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo]);
  return fp[lo] + (fp[hi] - fp[lo]) * t;
}

// ---------- model loading ----------

/** IEEE half -> double (the zone grid ships as float16, profile_model.save_zone_grid). */
function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/** A table from profile.bin as Float64Array [offset, offset+count). */
function slice64(f32, t) {
  const out = new Float64Array(t.count);
  for (let i = 0; i < t.count; i++) out[i] = f32[t.offset + i];
  return out;
}

/**
 * The profile model from the export_model.py files.
 * blender.stack — flat (NN, 36, 3) in the blender_order; grade — {zone: (8, NN, 3)}.
 */
export function loadModel(meta, buf) {
  const f32 = new Float32Array(buf);
  const m = {
    G: meta.G, NN: meta.NN, MASK_BINS: meta.MASK_BINS, SHARE_K: meta.SHARE_K,
    tone_levels: Float64Array.from(meta.TONE_LEVELS), sat_levels: Float64Array.from(meta.SAT_LEVELS),
    blendings: Float64Array.from(meta.BLENDINGS), balances: Float64Array.from(meta.BALANCES),
    tone_sliders: meta.TONE_SLIDERS, attrs: meta.ATTRS, grade_hues: Float64Array.from(meta.GRADE_HUES),
    zones: meta.ZONES, colors: meta.COLORS, set_of: meta.SET_OF,
    sectors: meta.SECTORS, ycc: meta.YCC, ycc_inv: meta.YCC_INV, luma: Float64Array.from(meta.LUMA),
    blender_order: meta.blender_order,
  };
  const T = meta.tables;
  // in Python Pixels builds stack = concatenate(blender.values(), axis=1) — (NN, 36, 3),
  // node-major; the file stores the table as (36, NN, 3), so we transpose on load
  const bt = T.blender, stack = new Float64Array(meta.blender_order.length * meta.NN * 3);
  {
    const keys = meta.blender_order.length, NN = meta.NN;
    for (let key = 0; key < keys; key++)
      for (let node = 0; node < NN; node++)
        for (let c = 0; c < 3; c++)
          stack[(node * keys + key) * 3 + c] = f32[bt.offset + (key * NN + node) * 3 + c];
  }
  m.blender = { order: meta.blender_order, stack };
  m.key_index = {};
  meta.blender_order.forEach(([s, a, g], i) => { m.key_index[`${s}|${a}|${g}`] = i; });
  m.grade = {};
  for (const z of m.zones) m.grade[z] = slice64(f32, T[`grade_${z}`]);
  m.shares = T.shares ? slice64(f32, T.shares) : null;
  // zone grid (profile_model.train_zone_grid): float16 after the float32 tables, see export_model.py
  m.zgrid = null;
  if (meta.zone_grid) {
    const zg = meta.zone_grid;
    const tabs = {};
    const tm = zg.tables.tm;
    tabs.tm = Float64Array.from(new Uint16Array(buf, zg.byte_offset + tm.byte, tm.count), halfToFloat);
    // LUT tables: int8 with a float32 scale per LUT of NN * 3 (profile_model.quantize_lut)
    for (const k of ["tb", "tc", "ti", "tq"]) {
      const tq = zg.tables[`${k}_q`], ts = zg.tables[`${k}_s`];
      if (!tq) { tabs[k] = null; continue; }
      const q = new Int8Array(buf, zg.byte_offset + tq.byte, tq.count);
      const sc = new Float32Array(buf, zg.byte_offset + ts.byte, ts.count);
      const blk = tq.count / ts.count, t = new Float64Array(tq.count);
      for (let i = 0; i < tq.count; i++) t[i] = q[i] * sc[Math.floor(i / blk)];
      tabs[k] = t;
    }
    m.zgrid = {
      blendings: Float64Array.from(zg.blendings), balances: Float64Array.from(zg.balances),
      pair_balances: Float64Array.from(zg.pair_balances ?? []), zone_pairs: zg.zone_pairs ?? [],
      tc_balances: Float64Array.from(zg.tc_balances), n_hues: zg.n_hues, grid_chroma: zg.grid_chroma,
      tq_balances: Float64Array.from(zg.tq_balances ?? []), tq_hues: zg.tables.tq_q ? zg.tables.tq_q.shape[3] : 0, ...tabs,
    };
  }
  m.tools = T.tone ? {
    tone: slice64(f32, T.tone), sat: slice64(f32, T.sat), mask: slice64(f32, T.mask),
    blend: slice64(f32, T.blend), bal: slice64(f32, T.bal), gbl: slice64(f32, T.gbl),
  } : null;
  return m;
}

/** Loads the model from the static assets directory: profile.json + profile.bin. */
export async function fetchModel(base) {
  const meta = await (await fetch(`${base}/profile.json`)).json();
  const buf = await (await fetch(`${base}/profile.bin`)).arrayBuffer();
  return loadModel(meta, buf);
}

// ---------- profile_model helper ports ----------

/** Indices and weights of the 8 trilinear interpolation knots for colors x (n, 3) on the G^3 grid. */
function interp(x, G) {
  const n = x.length / 3;
  const idx = new Int32Array(n * 8), w = new Float64Array(n * 8);
  for (let p = 0; p < n; p++) {
    const i = [0, 0, 0], f = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const u = clamp(x[p * 3 + k], 0, 1) * (G - 1);
      i[k] = clamp(Math.floor(u), 0, G - 2);
      f[k] = u - i[k];
    }
    let s = 0;
    for (let dx = 0; dx <= 1; dx++)
      for (let dy = 0; dy <= 1; dy++)
        for (let dz = 0; dz <= 1; dz++, s++) {
          idx[p * 8 + s] = ((i[0] + dx) * G + i[1] + dy) * G + i[2] + dz;
          w[p * 8 + s] = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
        }
  }
  return [idx, w];
}

/** lookup: interpolation of a table (NN, 3) by interp indices and weights -> (n, 3). */
function lookup(table, idx, w, n) {
  const out = new Float64Array(n * 3);
  for (let p = 0; p < n; p++) {
    let r = 0, g = 0, b = 0;
    for (let s = 0; s < 8; s++) {
      const o = idx[p * 8 + s] * 3, ws = w[p * 8 + s];
      r += ws * table[o]; g += ws * table[o + 1]; b += ws * table[o + 2];
    }
    out[p * 3] = r; out[p * 3 + 1] = g; out[p * 3 + 2] = b;
  }
  return out;
}

/** Oklab hue in fractions of the circle x k for colors x (n, 3). Port of profile_model.hue_position. */
function huePosition(x, k) {
  const n = x.length / 3;
  const clipped = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) clipped[i] = clamp(x[i], 0, 1);
  const ok = linearToOklab(srgbToLinearRows(clipped));
  const out = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const deg = Math.atan2(ok[p * 3 + 2], ok[p * 3 + 1]) * 180 / Math.PI;
    out[p] = ((deg % 360) + 360) % 360 / 360 * k;
  }
  return out;
}

/** Each blender color's share in the pixel: from the trained table (8, k) or from the sectors. */
function sectorWeights(x, m) {
  const n = x.length / 3;
  const out = {};
  if (m.shares !== null) {
    const k = m.SHARE_K, table = m.shares;
    const pos = huePosition(x, k);
    for (let ci = 0; ci < m.colors.length; ci++) {
      const w = new Float64Array(n);
      for (let p = 0; p < n; p++) {
        const fl = Math.floor(pos[p] - 0.5);       // a cell's value is at its center
        const i0 = ((fl % k) + k) % k;
        const f = pos[p] - 0.5 - fl;
        w[p] = table[ci * k + i0] * (1 - f) + table[ci * k + (i0 + 1) % k] * f;
      }
      out[m.colors[ci]] = w;
    }
    return out;
  }
  const col = huePosition(x, 24);
  for (const items of Object.values(m.sectors)) {
    const raw = {};
    for (const [c, lo, hi] of items) {
      const w = new Float64Array(n);
      for (let p = 0; p < n; p++) {
        const pos = ((col[p] - lo) % 24 + 24) % 24;
        w[p] = clamp(Math.min(pos + 0.5, ((hi - lo) % 24) - pos + 0.5), 0, 1);
      }
      raw[c] = w;
    }
    let total = new Float64Array(n).fill(0);
    for (const v of Object.values(raw)) for (let p = 0; p < n; p++) total[p] += v[p];
    for (let p = 0; p < n; p++) total[p] = Math.max(total[p], 1e-9);
    for (const [c, v] of Object.entries(raw)) {
      const w = new Float64Array(n);
      for (let p = 0; p < n; p++) w[p] = v[p] / total[p];
      out[c] = w;
    }
  }
  return out;
}

/** Weights of the GRADE_HUES directions for hue degrees: trigonometric interpolation over 8 points. */
function hueKernel(hue, m) {
  const k = new Float64Array(m.grade_hues.length);
  for (let j = 0; j < k.length; j++) {
    const d = (hue - m.grade_hues[j]) * Math.PI / 180;
    k[j] = (1 + 2 * (Math.cos(d) + Math.cos(2 * d) + Math.cos(3 * d)) + Math.cos(4 * d)) / k.length;
  }
  return k;
}

/** NP3 Saturation: Cb and Cr are multiplied by k, Y' does not change. */
function saturateRows(x, k, m) {
  const out = new Float64Array(x.length);
  const y = [0, 0, 0];
  for (let p = 0; p < x.length; p += 3) {
    for (let i = 0; i < 3; i++) y[i] = m.ycc[i][0] * x[p] + m.ycc[i][1] * x[p + 1] + m.ycc[i][2] * x[p + 2];
    y[1] *= k; y[2] *= k;
    for (let i = 0; i < 3; i++)
      out[p + i] = m.ycc_inv[i][0] * y[0] + m.ycc_inv[i][1] * y[1] + m.ycc_inv[i][2] * y[2];
  }
  return out;
}

/** Curve over Y': table of 257 points on linspace(0, 1, 257), rgb + (table(y) - y). Port of model.apply_curve. */
function applyCurveRows(rgb, table, luma) {
  if (table === null) return rgb;
  const out = new Float64Array(rgb.length);
  const [lr, lg, lb] = luma;
  for (let p = 0; p < rgb.length; p += 3) {
    const y = lr * rgb[p] + lg * rgb[p + 1] + lb * rgb[p + 2];
    const d = npInterp(y, GRID257, table) - y;
    out[p] = rgb[p] + d; out[p + 1] = rgb[p + 1] + d; out[p + 2] = rgb[p + 2] + d;
  }
  return out;
}

const GRID257 = Float64Array.from({ length: 257 }, (_, i) => i / 256);

/** model.Params from an NP3 Control. Port of model.params_of: tonal sliders are 0 when a curve is set. */
export function paramsOf(c, m) {
  const tone = {};
  for (const k of m.tone_sliders) tone[k] = c.curve ? 0 : Number(c[k]);
  const grade = {}, grade_bright = {}, blender = {};
  for (const z of m.zones) {
    const t = c.grade[z] || [0, 0, 0];
    grade[z] = [Number(t[0]), Number(t[1])];
    grade_bright[z] = Number(t[2] || 0);
  }
  for (const col of m.colors) blender[col] = (c.blender[col] || [0, 0, 0]).map(Number);
  return {
    saturation: Number(c.saturation), blender, grade, grade_bright,
    curve: c.curve ? Float64Array.from(c.curve.raw, (v) => v / 32767) : null,
    tone, blending: Number(c.blending), balance: Number(c.balance),
  };
}

// ---------- zone grid ----------

/**
 * Bilinear interpolation of a zone grid table (nb, nl, size) at (blending, balance), clamped to the
 * grid. Port of profile_model.grid_cell: the cell is the last knot <= the value, at most the second last.
 */
function gridCell(zg, table, size, blending, balance, BA = zg.balances) {
  const BL = zg.blendings, nb = BL.length, nl = BA.length;
  const b = clamp(blending, BL[0], BL[nb - 1]), l = clamp(balance, BA[0], BA[nl - 1]);
  let i = 0; while (i < nb - 2 && BL[i + 1] <= b) i++;
  let j = 0; while (j < nl - 2 && BA[j + 1] <= l) j++;
  const u = (b - BL[i]) / (BL[i + 1] - BL[i]), v = (l - BA[j]) / (BA[j + 1] - BA[j]);
  const out = new Float64Array(size);
  const corners = [[i, j, (1 - u) * (1 - v)], [i + 1, j, u * (1 - v)], [i, j + 1, (1 - u) * v], [i + 1, j + 1, u * v]];
  for (const [a, c, w] of corners) {
    if (w === 0) continue;
    const base = (a * nl + c) * size;
    for (let q = 0; q < size; q++) out[q] += w * table[base + q];
  }
  return out;
}

/** Table over hues evenly spaced from 0 (n of them, size each, at off): linear between the two neighbours.
 * Port of profile_model._hue_table. */
function hueTable(table, off, n, size, hue) {
  const hh = (((hue % 360) + 360) % 360) / (360 / n);
  const h0 = Math.floor(hh) % n, h1 = (h0 + 1) % n, u = hh - Math.floor(hh);
  const out = new Float64Array(size);
  for (let q = 0; q < size; q++) out[q] = (1 - u) * table[off + h0 * size + q] + u * table[off + h1 * size + q];
  return out;
}

/** The chroma term's weight (profile_model._chroma_phi): zero at chroma 0 and grid_chroma. */
function chromaPhi(chroma, c0) {
  return (chroma / c0) ** 2 - chroma / c0;
}

// ---------- Pixels: neutral with precomputed inputs ----------

/**
 * Neutral sRGB (n, 3) -> frame with the profile. Port of profile_model.Pixels without caches
 * (the Python remember/CACHE is an optimization for the fit, not needed when building a LUT).
 * Returns apply(p) -> Float64Array (n, 3).
 */
export class Pixels {
  constructor(m, rgb) {
    this.m = m;
    this.rgb = rgb;
    const n = rgb.length / 3;
    this.n = n;
    const [gi, gw] = interp(rgb, m.G);
    this.gi = gi; this.gw = gw;
    // grade[zone] — (8, n, 3); full is the sum of the three zones along each direction
    this.grade = {};
    this.full = new Float64Array(8 * n * 3);
    for (const z of m.zones) {
      const t = new Float64Array(8 * n * 3);
      for (let j = 0; j < 8; j++) {
        const tab = m.grade[z].subarray(j * m.NN * 3, (j + 1) * m.NN * 3);
        const l = lookup(tab, gi, gw, n);
        t.set(l, j * n * 3);
        for (let i = 0; i < l.length; i++) this.full[j * n * 3 + i] += l[i];
      }
      this.grade[z] = t;
    }
    const [lr, lg, lb] = m.luma;
    this.y = new Float64Array(n);
    for (let p = 0; p < n; p++)
      this.y[p] = lr * rgb[p * 3] + lg * rgb[p * 3 + 1] + lb * rgb[p * 3 + 2];
    // bright — (3 zones, 2 signs, n, 3) from tools.gbl
    this.bright = null;
    if (m.tools) {
      this.bright = [];
      for (let z = 0; z < 3; z++) {
        const signs = [];
        for (let s = 0; s < 2; s++) {
          const tab = m.tools.gbl.subarray((z * 2 + s) * m.NN * 3, (z * 2 + s + 1) * m.NN * 3);
          signs.push(lookup(tab, gi, gw, n));
        }
        this.bright.push(signs);
      }
    }
    this.plain = this.blenderInputs(rgb);
  }

  /** (color shares, (L0, C0, h0) from CIELab, 36 LUT responses) for colors after grading. */
  blenderInputs(rgb) {
    const m = this.m, n = this.n;
    const [idx, w] = interp(rgb, m.G);
    const keys = m.blender_order.length;
    const flat = new Float64Array(n * keys * 3);
    const stack = m.blender.stack;
    for (let p = 0; p < n; p++) {
      for (let s = 0; s < 8; s++) {
        const node = idx[p * 8 + s], ws = w[p * 8 + s], base = node * keys * 3, ob = p * keys * 3;
        for (let t = 0; t < keys * 3; t++) flat[ob + t] += ws * stack[base + t];
      }
    }
    const lab = srgbToLab(rgb);
    const L0 = new Float64Array(n), C0 = new Float64Array(n), h0 = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      L0[p] = lab[p * 3];
      C0[p] = Math.hypot(lab[p * 3 + 1], lab[p * 3 + 2]);
      h0[p] = Math.atan2(lab[p * 3 + 2], lab[p * 3 + 1]);
    }
    return { share: sectorWeights(rgb, m), polar: [L0, C0, h0], flat };
  }

  /** Zone mask minus the default mask; null at Blending 50 and Balance 0 or without tools. */
  maskDelta(zi, p) {
    const m = this.m;
    if (!m.tools || (p.blending === 50 && p.balance === 0)) return null;
    const full = this.maskOf(zi, p.blending, p.balance);
    const base = this.maskOf(zi, 50, 0);
    const d = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) d[i] = full[i] - base[i];
    return d;
  }

  /** Zone mask over Y': default plus Blending and Balance shifts. Port of Model.mask. */
  maskOf(zi, blending, balance) {
    const m = this.m, B = m.MASK_BINS, t = m.tools;
    const w = new Float64Array(B);
    for (let b = 0; b < B; b++) w[b] = t.mask[zi * B + b];
    const levels = (table, x, xp) => {
      for (let b = 0; b < B; b++) {
        const col = new Float64Array(xp.length);
        for (let j = 0; j < xp.length; j++) col[j] = table[(j * 3 + zi) * B + b];
        w[b] += npInterp(x, xp, col) - t.mask[zi * B + b];
      }
    };
    if (blending !== 50) levels(t.blend, blending, m.blendings);
    if (balance !== 0) levels(t.bal, balance, m.balances);
    for (let b = 0; b < B; b++) w[b] = Math.max(w[b], 0);
    const mid = Float64Array.from({ length: B }, (_, b) => (b + 0.5) / B);
    const out = new Float64Array(this.n);
    for (let p = 0; p < this.n; p++) out[p] = npInterp(this.y[p], mid, w);
    return out;
  }

  /** Zone grading: color through masks and brightness, the shared offset of all zones outside masks. */
  graded(p) {
    if (this.m.zgrid && (p.blending !== 50 || p.balance !== 0)) return this.gradedGrid(p);
    const m = this.m, n = this.n;
    const out = Float64Array.from(this.rgb);
    for (let zi = 0; zi < 3; zi++) {
      const zone = m.zones[zi];
      const [hue, chroma] = p.grade[zone];
      if (chroma) {
        const k = hueKernel(hue, m);
        const g = this.grade[zone];
        const dc = new Float64Array(n * 3);
        for (let j = 0; j < 8; j++) {
          const kj = chroma * k[j];
          for (let i = 0; i < n * 3; i++) dc[i] += kj * g[j * n * 3 + i];
        }
        const d = this.maskDelta(zi, p);
        if (d !== null)
          for (let j = 0; j < 8; j++) {
            const kj = chroma * k[j];
            for (let i = 0; i < n; i++) {
              const kd = kj * d[i];
              dc[i * 3] += kd * this.full[j * n * 3 + i * 3];
              dc[i * 3 + 1] += kd * this.full[j * n * 3 + i * 3 + 1];
              dc[i * 3 + 2] += kd * this.full[j * n * 3 + i * 3 + 2];
            }
          }
        this.chromaTerm(dc, zi, hue, chroma, p);
        for (let i = 0; i < n * 3; i++) out[i] += dc[i];
      }
      const v = this.bright !== null ? p.grade_bright[zone] : 0;
      if (v) {
        const si = v > 0 ? 0 : 1, kv = Math.abs(v) / 100;
        const br = this.bright[zi][si];
        for (let i = 0; i < n * 3; i++) out[i] += kv * br[i];
        const d = this.maskDelta(zi, p);
        if (d !== null) {
          for (let i = 0; i < n; i++) {
            const kd = kv * d[i];
            for (let z = 0; z < 3; z++) {
              const bz = this.bright[z][si];
              out[i * 3] += kd * bz[i * 3];
              out[i * 3 + 1] += kd * bz[i * 3 + 1];
              out[i * 3 + 2] += kd * bz[i * 3 + 2];
            }
          }
        }
      }
    }
    return out;
  }

  /** The chroma term table at the (Blending, Balance) cell: (3 zones, tq_hues, NN, 3), cached per cell. */
  tqCell(p, size) {
    const zg = this.m.zgrid;
    if (!this._tq || this._tq.b !== p.blending || this._tq.l !== p.balance)
      this._tq = { b: p.blending, l: p.balance, t: gridCell(zg, zg.tq, size, p.blending, p.balance, zg.tq_balances) };
    return this._tq.t;
  }

  /** A zone's color push dc with the chroma correction (zone grid tq at the cell), in place. Port of Pixels.chroma_term. */
  chromaTerm(dc, zi, hue, chroma, p) {
    const zg = this.m.zgrid;
    if (!zg || !zg.tq || chroma === zg.grid_chroma) return;
    const NN = this.m.NN, nq = zg.tq_hues, size = 3 * nq * NN * 3;
    const cell = this.tqCell(p, size);
    const Q = lookup(hueTable(cell, zi * nq * NN * 3, nq, NN * 3, hue), this.gi, this.gw, this.n);
    const phi = chromaPhi(chroma, zg.grid_chroma);
    for (let i = 0; i < dc.length; i++) dc[i] *= 1 + phi * Q[i];
  }

  /** Zone grading off Blending 50 / Balance 0 through the zone grid. Port of Pixels.graded_grid. */
  gradedGrid(p) {
    const m = this.m, n = this.n, zg = m.zgrid, NN = m.NN, B = m.MASK_BINS;
    const out = Float64Array.from(this.rgb);
    const tm = gridCell(zg, zg.tm, 3 * B, p.blending, p.balance);
    let tc = null, tb = null;
    const mid = Float64Array.from({ length: B }, (_, b) => (b + 0.5) / B);
    for (let zi = 0; zi < 3; zi++) {
      const zone = m.zones[zi];
      const [hue, chroma] = p.grade[zone];
      if (chroma) {
        const k = hueKernel(hue, m);
        const nh = zg.n_hues;
        if (tc === null) tc = gridCell(zg, zg.tc, 3 * nh * NN * 3, p.blending, p.balance, zg.tc_balances);
        const W = lookup(hueTable(tc, zi * nh * NN * 3, nh, NN * 3, hue), this.gi, this.gw, n);
        const wm = tm.subarray(zi * B, (zi + 1) * B);
        const g = this.grade[zone];
        const dc = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
          const wy = npInterp(this.y[i], mid, wm);
          for (let c = 0; c < 3; c++) {
            let kg = 0, kf = 0;
            for (let j = 0; j < 8; j++) {
              kg += k[j] * g[j * n * 3 + i * 3 + c];
              kf += k[j] * this.full[j * n * 3 + i * 3 + c];
            }
            dc[i * 3 + c] = chroma * kg + chroma * (wy + W[i * 3 + c]) * kf;
          }
        }
        this.chromaTerm(dc, zi, hue, chroma, p);
        for (let i = 0; i < n * 3; i++) out[i] += dc[i];
      }
      const v = this.bright !== null ? p.grade_bright[zone] : 0;
      if (v) {
        const si = v > 0 ? 0 : 1, kv = Math.abs(v) / 100;
        if (tb === null) {
          tb = gridCell(zg, zg.tb, 3 * 2 * NN * 3, p.blending, p.balance);
          const i50 = zg.blendings.indexOf(50), j0 = zg.balances.indexOf(0);
          const base = (i50 * zg.balances.length + j0) * 3 * 2 * NN * 3;
          for (let q = 0; q < tb.length; q++) tb[q] -= zg.tb[base + q];
        }
        const off = (zi * 2 + si) * NN * 3;
        const d = lookup(tb.subarray(off, off + NN * 3), this.gi, this.gw, n);
        const br = this.bright[zi][si];
        for (let i = 0; i < n * 3; i++) out[i] += kv * (br[i] + d[i]);
      }
    }
    // two zones at once: what a pair adds beyond the two single zones (profile_model ZONE_PAIRS)
    if (zg.ti && this.bright !== null) {
      let ti = null;
      const size = zg.zone_pairs.length * 4 * NN * 3;
      zg.zone_pairs.forEach(([za, zc], pi) => {
        const va = p.grade_bright[za] || 0, vc = p.grade_bright[zc] || 0;
        if (!va || !vc) return;
        if (ti === null) ti = gridCell(zg, zg.ti, size, p.blending, p.balance, zg.pair_balances);
        const si = (va > 0 ? 0 : 2) + (vc > 0 ? 0 : 1);
        const off = (pi * 4 + si) * NN * 3;
        const d = lookup(ti.subarray(off, off + NN * 3), this.gi, this.gw, n);
        const k = Math.abs(va) / 100 * Math.abs(vc) / 100;
        for (let i = 0; i < n * 3; i++) out[i] += k * d[i];
      });
    }
    return out;
  }

  /** Grading + Saturation; returns [rgb, blender inputs] (port of Pixels.toned). */
  toned(p) {
    const m = this.m;
    const sat = p.saturation ? this.saturationOf(p.saturation) : 1.0;
    const plain = !m.zones.some((z) => p.grade[z][1])
      && !Object.values(p.grade_bright).some(Boolean) && sat === 1.0;
    if (plain) return [this.rgb, this.plain];
    let rgb = this.graded(p);
    for (let i = 0; i < rgb.length; i++) rgb[i] = clamp(rgb[i], 0, 1);
    if (sat !== 1.0) {
      rgb = saturateRows(rgb, sat, m);
      for (let i = 0; i < rgb.length; i++) rgb[i] = clamp(rgb[i], 0, 1);
    }
    return [rgb, this.blenderInputs(rgb)];
  }

  /** np.interp(s, SAT_LEVELS, tools.sat); without tools — 1. Port of Model.saturation. */
  saturationOf(s) {
    return this.m.tools ? npInterp(s, this.m.sat_levels, this.m.tools.sat) : 1.0;
  }

  /**
   * The result before the curve: the blender in CIELab (hue, chroma, lightness). Port of before_curve.
   * toned — an optional precomputed this.toned(p) (the fit's staged Jacobian reuses it when only
   * the blender/curve parameters move; the arrays are read, never written).
   */
  beforeCurve(p, toned = this.toned(p)) {
    const m = this.m, n = this.n;
    const [rgb, inputs] = toned;
    const { share, polar: [L0, C0, h0], flat } = inputs;
    const d = new Float64Array(n * 3);
    let any = false;
    for (const color of m.colors) {
      const set = m.set_of[color];
      const w = share[color];
      for (let k = 0; k < 3; k++) {
        const v = p.blender[color][k];
        if (!v) continue;
        any = true;
        const key = m.key_index[`${set}|${m.attrs[k]}|${v > 0 ? 1 : -1}`];
        const av = Math.abs(v);
        for (let i = 0; i < n; i++) {
          const base = i * m.blender_order.length * 3 + key * 3;
          const wi = av * w[i];
          d[i * 3] += wi * flat[base];
          d[i * 3 + 1] += wi * flat[base + 1];
          d[i * 3 + 2] += wi * flat[base + 2];
        }
      }
    }
    if (!any) return rgb;
    const lab = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const C1 = Math.max((C0[i] + 1) * Math.exp(d[i * 3 + 2]) - 1, 0);
      const h1 = h0[i] + d[i * 3 + 1];
      lab[i * 3] = L0[i] + d[i * 3];
      lab[i * 3 + 1] = C1 * Math.cos(h1);
      lab[i * 3 + 2] = C1 * Math.sin(h1);
    }
    const out = labToSrgb(lab);
    for (let i = 0; i < out.length; i++) out[i] = clamp(out[i], 0, 1);
    return out;
  }

  /** The NP3 curve: its own if set, otherwise the sum of the tonal slider shifts. */
  toneCurveOf(p) {
    const m = this.m;
    if (p.curve !== null) return p.curve;
    if (!m.tools || !m.tone_sliders.some((k) => p.tone[k])) return null;
    const out = Float64Array.from(GRID257);
    for (let i = 0; i < m.tone_sliders.length; i++) {
      const v = p.tone[m.tone_sliders[i]];
      if (!v) continue;
      for (let k = 0; k < 257; k++) {
        const col = new Float64Array(7);
        for (let j = 0; j < 7; j++) col[j] = m.tools.tone[(i * 7 + j) * 257 + k];
        out[k] += npInterp(v, m.tone_levels, col) - GRID257[k];
      }
    }
    for (let k = 0; k < 257; k++) out[k] = clamp(out[k], 0, 1);
    return out;
  }

  /**
   * The full pass: grading -> Saturation -> blender -> curve, clipped to 0..1.
   * before — an optional precomputed this.beforeCurve(p) (the staged Jacobian, see beforeCurve).
   */
  apply(p, before = this.beforeCurve(p)) {
    const out = applyCurveRows(before, this.toneCurveOf(p), this.m.luma);
    for (let i = 0; i < out.length; i++) out[i] = clamp(out[i], 0, 1);
    return out;
  }
}

// ---------- LUT ----------

/** The step-based model baked into an n^3 LUT on the sRGB grid (i/(n-1))^3. Index (r*n + g)*n + b. */
export function buildLUT(model, control, n = 33) {
  const nodes = new Float64Array(n * n * n * 3);
  let q = 0;
  for (let r = 0; r < n; r++)
    for (let g = 0; g < n; g++)
      for (let b = 0; b < n; b++) {
        nodes[q++] = r / (n - 1); nodes[q++] = g / (n - 1); nodes[q++] = b / (n - 1);
      }
  const px = new Pixels(model, nodes);
  return Float32Array.from(px.apply(paramsOf(control, model)));
}

/** Trilinear LUT application to a single pixel, as render.trilinear. */
export function applyLUT1(lut, n, r, g, b) {
  const m = n - 1;
  const u = [clamp(r, 0, 1) * m, clamp(g, 0, 1) * m, clamp(b, 0, 1) * m];
  const i = [Math.min(Math.floor(u[0]), m - 1), Math.min(Math.floor(u[1]), m - 1), Math.min(Math.floor(u[2]), m - 1)];
  const f = [u[0] - i[0], u[1] - i[1], u[2] - i[2]];
  const out = [0, 0, 0];
  for (let dr = 0; dr <= 1; dr++)
    for (let dg = 0; dg <= 1; dg++)
      for (let db = 0; db <= 1; db++) {
        const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2]);
        const o = ((i[0] + dr) * n + i[1] + dg) * n + i[2] + db;
        out[0] += w * lut[o * 3]; out[1] += w * lut[o * 3 + 1]; out[2] += w * lut[o * 3 + 2];
      }
  return out;
}

/** Trilinear LUT application to an rgb array (n, 3) -> (n, 3). */
export function applyLUT(lut, n, rgb) {
  const out = new Float64Array(rgb.length);
  for (let p = 0; p < rgb.length; p += 3) {
    const v = applyLUT1(lut, n, rgb[p], rgb[p + 1], rgb[p + 2]);
    out[p] = v[0]; out[p + 1] = v[1]; out[p + 2] = v[2];
  }
  return out;
}
