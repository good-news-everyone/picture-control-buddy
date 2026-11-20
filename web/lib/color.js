// Color conversions and metrics. Port of color.py (srgb_to_linear, linear_to_srgb,
// linear_to_oklab, oklab_to_linear, srgb_to_lab, lab_to_srgb, de2000). Pure
// Float64Array (n, 3) math, no DOM. The formulas repeat Python step by step.
// The matrices are as in color.py; inv(M_RGB2XYZ) was computed there (numpy.linalg.inv).

const M_RGB2XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];
const RGB2XYZ_INV = [
  [3.2404548360214087, -1.5371388501025751, -0.49853154686848083],
  [-0.9692663898756538, 1.876010928842491, 0.04155608234667353],
  [0.05564341960421366, -0.20402585426769815, 1.0572251624579287],
];
const D65 = [0.95047, 1.0, 1.08883];

const M1 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const M2 = [
  [0.2104542553, 0.7936177850, -0.0040720468],
  [1.9779984951, -2.4285922050, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.8086757660],
];
const M1_INV = [
  [4.076741661347994, -3.3077115904081933, 0.23096992872942795],
  [-1.2684380040921763, 2.6097574006633715, -0.3413193963102196],
  [-0.004196086541837074, -0.7034186144594495, 1.7076147009309446],
];
const M2_INV = [
  [0.9999999984505197, 0.3963377921737678, 0.21580375806075883],
  [1.0000000088817607, -0.10556134232365633, -0.0638541747717059],
  [1.0000000546724106, -0.08948418209496574, -1.2914855378640917],
];

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// vector (3) times matrix (3, 3) stored by rows, as in the numpy product x @ M.T
function matT(v, m, out) {
  for (let i = 0; i < 3; i++)
    out[i] = m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2];
  return out;
}

/** sRGB 0..1 -> linear. Element-wise, v may be a number. */
export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((Math.max(v, 0) + 0.055) / 1.055, 2.4);
}

/** Linear -> sRGB, without clipping. Element-wise. */
export function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 1e-12), 1 / 2.4) - 0.055;
}

/** Linear RGB (n, 3) -> Oklab (n, 3): lms = cbrt(rgb @ M1.T), ok = lms @ M2.T. */
export function linearToOklab(rgb, out) {
  out = out || new Float64Array(rgb.length);
  const v = [0, 0, 0], lms = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    matT([rgb[i], rgb[i + 1], rgb[i + 2]], M1, lms);
    v[0] = Math.cbrt(lms[0]); v[1] = Math.cbrt(lms[1]); v[2] = Math.cbrt(lms[2]);
    matT(v, M2, lms);
    out[i] = lms[0]; out[i + 1] = lms[1]; out[i + 2] = lms[2];
  }
  return out;
}

/** Oklab (n, 3) -> linear RGB: ((lab @ M2_INV.T) ** 3) @ M1_INV.T. */
export function oklabToLinear(lab, out) {
  out = out || new Float64Array(lab.length);
  const v = [0, 0, 0], lms = [0, 0, 0];
  for (let i = 0; i < lab.length; i += 3) {
    matT([lab[i], lab[i + 1], lab[i + 2]], M2_INV, v);
    lms[0] = v[0] ** 3; lms[1] = v[1] ** 3; lms[2] = v[2] ** 3;
    matT(lms, M1_INV, v);
    out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2];
  }
  return out;
}

/** sRGB (n, 3) -> linear RGB (n, 3). */
export function srgbToLinearRows(rgb, out) {
  out = out || new Float64Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = srgbToLinear(rgb[i]);
  return out;
}

/** sRGB 0..1 (n, 3) -> CIELAB D65 (n, 3). Port of color.srgb_to_lab. */
export function srgbToLab(rgb, out) {
  out = out || new Float64Array(rgb.length);
  const lin = [0, 0, 0], xyz = [0, 0, 0], f = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    lin[0] = srgbToLinear(rgb[i]); lin[1] = srgbToLinear(rgb[i + 1]); lin[2] = srgbToLinear(rgb[i + 2]);
    matT(lin, M_RGB2XYZ, xyz);
    for (let k = 0; k < 3; k++) {
      xyz[k] /= D65[k];
      f[k] = xyz[k] > 216 / 24389 ? Math.cbrt(Math.max(xyz[k], 1e-12)) : (24389 / 27 * xyz[k] + 16) / 116;
    }
    out[i] = 116 * f[1] - 16;
    out[i + 1] = 500 * (f[0] - f[1]);
    out[i + 2] = 200 * (f[1] - f[2]);
  }
  return out;
}

/** CIELAB D65 (n, 3) -> sRGB (n, 3), without clipping. Port of color.lab_to_srgb. */
export function labToSrgb(lab, out) {
  out = out || new Float64Array(lab.length);
  const f = [0, 0, 0], xyz = [0, 0, 0], lin = [0, 0, 0];
  for (let i = 0; i < lab.length; i += 3) {
    const fy = (lab[i] + 16) / 116;
    f[0] = fy + lab[i + 1] / 500; f[1] = fy; f[2] = fy - lab[i + 2] / 200;
    for (let k = 0; k < 3; k++) {
      xyz[k] = (f[k] > 6 / 29 ? f[k] ** 3 : (116 * f[k] - 16) * 27 / 24389) * D65[k];
    }
    matT(xyz, RGB2XYZ_INV, lin);
    out[i] = linearToSrgb(lin[0]); out[i + 1] = linearToSrgb(lin[1]); out[i + 2] = linearToSrgb(lin[2]);
  }
  return out;
}

/**
 * Matrices W (n, 9, row-major 3x3): |W.(lab_predicted - lab)| ~ dE2000 for a small difference,
 * computed at the target color lab. Port of color.de2000_weights: lightness/chroma/hue rows
 * with the SL/SC/SH denominators and the RT rotation for blues. kc < 1 is stricter on chroma;
 * flatL drops SL (strict in shadows as in dE76).
 */
export function de2000Weights(lab, kc = 1.0, flatL = false) {
  const n = lab.length / 3;
  const out = new Float64Array(n * 9);
  const P25_7 = 25 ** 7;
  for (let i = 0; i < n; i++) {
    const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
    const C0 = Math.hypot(a, b);
    const C07 = C0 ** 7;
    const G = 0.5 * (1 - Math.sqrt(C07 / (C07 + P25_7)));
    const ap = (1 + G) * a;
    const Cp = Math.hypot(ap, b);
    const h = (Math.atan2(b, ap) * 180 / Math.PI % 360 + 360) % 360;
    const T = 1 - 0.17 * Math.cos((h - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * h * Math.PI / 180)
      + 0.32 * Math.cos((3 * h + 6) * Math.PI / 180) - 0.20 * Math.cos((4 * h - 63) * Math.PI / 180);
    const Sl = 1 + 0.015 * (L - 50) ** 2 / Math.sqrt(20 + (L - 50) ** 2);
    const Sc = kc * (1 + 0.045 * Cp);
    const Sh = 1 + 0.015 * Cp * T;
    const Rt = -Math.sin((60 * Math.exp(-(((h - 275) / 25) ** 2))) * Math.PI / 180)
      * 2 * Math.sqrt(Cp ** 7 / (Cp ** 7 + P25_7));
    const grey = Cp < 1e-3;
    const u0 = grey ? 1.0 : ap / Cp, u1 = grey ? 0.0 : b / Cp;
    const r0 = u0 * (1 + G) / Sc, r1 = u1 / Sc;          // radial: (Da, Db) -> dC'/SC
    const t0 = -u1 * (1 + G) / Sh, t1 = u0 / Sh;         // tangential: -> dH'/SH
    const b9 = i * 9;
    out[b9] = flatL ? 1 : 1 / Sl;
    out[b9 + 4] = r0 + (Rt / 2) * t0;                    // the square of the sum yields the RT.dC.dH term
    out[b9 + 5] = r1 + (Rt / 2) * t1;
    const s = Math.sqrt(Math.max(1 - Rt ** 2 / 4, 0));
    out[b9 + 7] = s * t0;
    out[b9 + 8] = s * t1;
  }
  return out;
}

/** W.d per pixel for W (n, 9) row-major and d (n, 3). Port of color.weighted. */
export function weightedRows(W, d) {
  const n = d.length / 3;
  const out = new Float64Array(d.length);
  for (let i = 0; i < n; i++) {
    const b9 = i * 9, b3 = i * 3;
    const d0 = d[b3], d1 = d[b3 + 1], d2 = d[b3 + 2];
    out[b3] = W[b9] * d0 + W[b9 + 1] * d1 + W[b9 + 2] * d2;
    out[b3 + 1] = W[b9 + 3] * d0 + W[b9 + 4] * d1 + W[b9 + 5] * d2;
    out[b3 + 2] = W[b9 + 6] * d0 + W[b9 + 7] * d1 + W[b9 + 8] * d2;
  }
  return out;
}

/** CIEDE2000 between LAB sets (n, 3). Port of color.de2000 (Sharma et al., 2005). */
export function de2000(lab1, lab2, out) {
  const n = lab1.length / 3;
  out = out || new Float64Array(n);
  const P25_7 = 25 ** 7;
  for (let i = 0; i < n; i++) {
    const L1 = lab1[i * 3], a1 = lab1[i * 3 + 1], b1 = lab1[i * 3 + 2];
    const L2 = lab2[i * 3], a2 = lab2[i * 3 + 1], b2 = lab2[i * 3 + 2];
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cm7 = ((C1 + C2) / 2) ** 7;
    const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + P25_7)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const h1 = (Math.atan2(b1, a1p) * 180 / Math.PI % 360 + 360) % 360;
    const h2 = (Math.atan2(b2, a2p) * 180 / Math.PI % 360 + 360) % 360;
    const dL = L2 - L1, dC = C2p - C1p;
    const zero = C1p * C2p === 0;
    let dh = h2 - h1;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    if (zero) dh = 0;
    const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh * Math.PI / 180 / 2);
    const Lm = (L1 + L2) / 2, Cm = (C1p + C2p) / 2;
    const s = h1 + h2;
    const hm = zero ? s
      : Math.abs(h1 - h2) <= 180 ? s / 2 : (s < 360 ? (s + 360) / 2 : (s - 360) / 2);
    const T = 1 - 0.17 * Math.cos((hm - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hm * Math.PI / 180)
      + 0.32 * Math.cos((3 * hm + 6) * Math.PI / 180) - 0.20 * Math.cos((4 * hm - 63) * Math.PI / 180);
    const dTh = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
    const Cm7b = Cm ** 7;
    const Rc = 2 * Math.sqrt(Cm7b / (Cm7b + P25_7));
    const Sl = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2);
    const Sc = 1 + 0.045 * Cm;
    const Sh = 1 + 0.015 * Cm * T;
    const Rt = -Math.sin(2 * dTh * Math.PI / 180) * Rc;
    out[i] = Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2
      + Rt * (dC / Sc) * (dH / Sh));
  }
  return out;
}
