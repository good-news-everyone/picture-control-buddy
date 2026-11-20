// Target file decoding for the browser fitting flow (spec/web-schemas.md §7.1; JPEG-only per
// the §8 supersession — TIFF stays in the Python CLI and is not ported to the browser).
// Python pairs: pairs.xmp_values / pairs.to_srgb (decodeTarget), wbmap.multipliers,
// match.edit_gain / match.edit_warnings, PIL im.info["xmp"] / im.info["icc_profile"] /
// ImageCms.getProfileDescription. Policy: spec/web-tests.md.
// The pure half (everything except decodeTarget) takes Uint8Array/plain data and runs in Node
// and Workers. Quirks are reproduced literally: the sRGB-by-description decision (§6.12),
// the exact warning strings of match.edit_warnings, the wbmap endianness.
// No UI strings live here — the main thread localizes warning codes via t().

export const MIN_TARGET = 1000;    // match.MIN_TARGET

// --------------------------------------------------------------------------- XMP

// Port of pairs.xmp_values: the (crs|tiff):name="value" attributes plus the _masks substring test.
// Accepts null/empty (Python: `im.info.get("xmp") or b""`).
export function parseXmp(xmpBytes) {
  const t = xmpBytes && xmpBytes.length ? new TextDecoder("utf-8").decode(xmpBytes) : "";
  const out = {};
  for (const m of t.matchAll(/(?:crs|tiff):(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  out._masks = t.includes("MaskGroupBasedCorrections");
  return out;
}

// Walks the JPEG marker segments. cb(marker, payloadOffset, payloadLength) — returning a value
// stops the walk and returns it.
function jpegScan(bytes, cb) {
  let p = 2;                                   // after FF D8
  for (;;) {
    if (p + 4 > bytes.length) return null;
    if (bytes[p] !== 0xFF) return null;
    const marker = bytes[p + 1];
    p += 2;
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) continue;
    const len = (bytes[p] << 8) | bytes[p + 1];
    if (len < 2 || p + len > bytes.length) return null;
    const hit = cb(marker, p + 2, len - 2);
    if (hit !== undefined && hit !== null) return hit;
    if (marker === 0xDA) return null;          // SOS: the image data starts, metadata ends
    p += len;
  }
}

const ASCII = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

// Port of PIL im.info["xmp"]: the JPEG APP1 xap/1.0 segment. Pure.
export function extractXmp(bytes, format) {
  if (format !== "JPEG") throw new Error(`extractXmp: unsupported format ${format} (JPEG only)`);
  return jpegScan(bytes, (marker, off, len) => {
    if (marker !== 0xE1 || len < 29 || ASCII(bytes, off, off + 29) !== "http://ns.adobe.com/xap/1.0/\0")
      return null;
    return bytes.slice(off + 29, off + len);
  });
}

// Port of PIL im.info["icc_profile"]: the JPEG APP2 ICC_PROFILE segments (concatenated in
// sequence order). Pure.
export function extractIcc(bytes, format) {
  if (format !== "JPEG") throw new Error(`extractIcc: unsupported format ${format} (JPEG only)`);
  const parts = new Map();
  jpegScan(bytes, (marker, off, len) => {
    if (marker !== 0xE2 || len < 14 || ASCII(bytes, off, off + 12) !== "ICC_PROFILE\0") return null;
    parts.set(bytes[off + 12], bytes.slice(off + 14, off + len));
    return null;
  });
  if (!parts.size) return null;
  const out = new Uint8Array([...parts].sort((a, b) => a[0] - b[0])
    .reduce((n, [, v]) => n + v.length, 0));
  let at = 0;
  for (const [, v] of [...parts].sort((a, b) => a[0] - b[0])) { out.set(v, at); at += v.length; }
  return out;
}

// Raw EXIF orientation (tag 274) from the JPEG APP1 Exif segment, without applying it (§6.3:
// PIL leaves JPEG alone). null when the tag is absent.
export function exifOrientation(bytes, format) {
  if (format !== "JPEG") throw new Error(`exifOrientation: unsupported format ${format} (JPEG only)`);
  return jpegScan(bytes, (marker, off, len) => {
    if (marker !== 0xE1 || len < 8 || ASCII(bytes, off, off + 6) !== "Exif\0\0") return null;
    const t = bytes.subarray(off + 6, off + len);
    const le = t[0] === 0x49 && t[1] === 0x49;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const ifd0 = dv.getUint32(4, le);
    for (let i = 0; i < dv.getUint16(ifd0, le); i++) {
      const p = ifd0 + 2 + 12 * i;
      if (dv.getUint16(p, le) === 274) return dv.getUint16(p + 8, le);
    }
    return null;
  });
}

// --------------------------------------------------------------------------- ICC

const beU32 = (b, p) => (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
const beU16 = (b, p) => (b[p] << 8) | b[p + 1];
const sig = (b, p) => ASCII(b, p, p + 4);

function iccTags(icc) {
  if (icc.length < 132 || sig(icc, 36) !== "acsp") return null;
  const n = beU32(icc, 128);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const p = 132 + 12 * i;
    if (p + 12 > icc.length) return null;
    out.set(sig(icc, p), { offset: beU32(icc, p + 4), size: beU32(icc, p + 8) });
  }
  return out;
}

// Port of ImageCms.getProfileDescription: the v2 'desc' / v4 'mluc' tag. PIL goes through
// cmsGetProfileInfoASCII, which terminates the string with "\n" — the golden fixture stores
// "np3-target-adobe v1.0\n". Returns null when there is no usable description.
export function iccDescription(icc) {
  const tags = iccTags(icc);
  if (!tags) return null;
  const d = tags.get("desc");
  if (d && d.offset + 12 <= icc.length && sig(icc, d.offset) === "desc") {
    const count = beU32(icc, d.offset + 8);
    const from = d.offset + 12, to = Math.min(from + Math.max(0, count - 1), icc.length);
    return new TextDecoder("utf-8").decode(icc.subarray(from, to)) + "\n";
  }
  const m = tags.get("mluc");
  if (m && m.offset + 16 <= icc.length && sig(icc, m.offset) === "mluc") {
    const recSize = beU32(icc, m.offset + 12);
    const from = m.offset + beU32(icc, m.offset + 20);
    const len = beU32(icc, m.offset + 16);
    let s = "";
    for (let p = from; p + 1 < Math.min(from + len, icc.length); p += 2)
      s += String.fromCharCode(beU16(icc, p));
    return s + "\n";
  }
  return null;
}

// The §6.12 quirk, literal: pairs.to_srgb decides by the description string, not the gamut.
export function isSrgbDescription(desc) {
  return desc != null && desc.includes("sRGB");
}

// s15Fixed16 values of an XYZType tag ('wtpt', 'rXYZ', ...).
function xyzTag(icc, tags, name) {
  const t = tags.get(name);
  if (!t || t.offset + 20 > icc.length || sig(icc, t.offset) !== "XYZ ") return null;
  const f = (p) => new DataView(icc.buffer, icc.byteOffset + t.offset + p, 4).getInt32(0, false) / 65536;
  return [f(8), f(12), f(16)];
}

// A tone response curve: 'curv' (table, linear interpolation) or 'para' (parametric 0-4).
// Returns {kind:"table", v:Float64Array} | {kind:"gamma", g} | {kind:"param", p:Float64Array}.
function trcTag(icc, tags, name) {
  const t = tags.get(name);
  if (!t) return null;
  const type = sig(icc, t.offset);
  if (type === "curv") {
    const count = beU32(icc, t.offset + 8);
    if (count === 0) return { kind: "table", v: null };                    // identity
    if (count === 1) return { kind: "gamma", g: beU16(icc, t.offset + 12) / 256 };
    const v = new Float64Array(count);
    for (let i = 0; i < count; i++) v[i] = beU16(icc, t.offset + 12 + 2 * i) / 65535;
    return { kind: "table", v };
  }
  if (type === "para") {
    const n = [1, 3, 4, 5, 7][beU16(icc, t.offset + 8)];
    if (!n || t.offset + 12 + 4 * n > icc.length) return null;
    const p = new Float64Array(n);
    for (let i = 0; i < n; i++)
      p[i] = new DataView(icc.buffer, icc.byteOffset + t.offset + 12 + 4 * i, 4).getInt32(0, false) / 65536;
    return { kind: "param", p };
  }
  return null;
}

// Evaluates a trcTag value at x (the matrix-shaper forward TRC, profile RGB -> linear).
// 'para' follows ICC.1 10.18 (the parametricCurveType functions 0-4, p = [g, a, b, c, d, e, f]):
//   0: X^g   1: (aX+b)^g, X >= -b/a, else 0   2: (aX+b)^g + c, X >= -b/a, else c
//   3: (aX+b)^g, X >= d, else cX             4: (aX+b)^g + e, X >= d, else cX + f
export function evalTrc(trc, x) {
  if (!trc) return x;
  if (trc.kind === "gamma") return x >= 0 ? Math.pow(x, trc.g) : 0;
  if (trc.kind === "table") {
    if (!trc.v) return x;
    const f = x * (trc.v.length - 1), i = Math.min(Math.floor(f), trc.v.length - 2);
    return trc.v[i] + (trc.v[i + 1] - trc.v[i]) * (f - i);
  }
  const p = trc.p;
  const g = p[0];
  if (p.length === 1) return x >= 0 ? Math.pow(x, g) : 0;
  const a = p[1], b = p[2];
  const pw = (v) => Math.pow(Math.max(v, 0), g);
  if (p.length === 3) return x >= -b / a ? pw(a * x + b) : 0;
  if (p.length === 4) return x >= -b / a ? pw(a * x + b) + p[3] : p[3];
  if (p.length === 5) return x >= p[4] ? pw(a * x + b) : p[3] * x;
  return x >= p[4] ? pw(a * x + b) + p[5] : p[3] * x + p[6];
}

// The sRGB transfer function (linear -> encoded), clamped to [0, 1] like an 8-bit CMS output.
export function srgbEncode(v) {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// Bradford chromatic adaptation matrices and the sRGB primaries (as in littleCMS).
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_INV = [[0.986993, -0.147054, 0.159963], [0.432305, 0.518360, 0.049291], [-0.008529, 0.040043, 0.968487]];
const XYZ2SRGB = [[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]];
const D65 = [0.95047, 1.0, 1.08883];
const D50 = [0.9642, 1.0, 0.8249];      // the ICC PCS illuminant (littleCMS cmsD50_XYZ)

const mul3 = (a, b) => a.map((row, i) => row.map((_, j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const mulV = (a, v) => a.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

// littleCMS profileToProfile(profile -> sRGB) for a v2/v4 matrix-shaper profile: the forward
// TRCs, the colorant matrix (profile linear RGB -> PCS XYZ, D50 — the colorants are
// PCS-relative by the ICC spec, so the media white point is NOT the adaptation source), the
// Bradford D50 -> D65 adaptation and XYZ -> linear sRGB; applyIcc then encodes with the sRGB
// curve. Returns null for LUT-based (A2B0/mft1) profiles so the caller falls back to the
// browser CMS (§7.1).
export function iccToSrgbMatrix(icc) {
  const tags = iccTags(icc);
  if (!tags || sig(icc, 16) !== "RGB ") return null;
  if (tags.has("A2B0") || sig(icc, 12) === "mft1" || sig(icc, 12) === "mft2"
      || sig(icc, 12) === "mAB " || sig(icc, 12) === "mBA ") return null;
  const r = xyzTag(icc, tags, "rXYZ"), g = xyzTag(icc, tags, "gXYZ"), b = xyzTag(icc, tags, "bXYZ");
  const trcR = trcTag(icc, tags, "rTRC"), trcG = trcTag(icc, tags, "gTRC"), trcB = trcTag(icc, tags, "bTRC");
  if (!r || !g || !b || !trcR || !trcG || !trcB) return null;
  const adapt = (() => {
    const s = mulV(BRADFORD, D50), d = mulV(BRADFORD, D65);
    const scale = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
    return mul3(BRADFORD_INV, mul3(scale, BRADFORD));
  })();
  const rgb2xyz = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
  const m = mul3(XYZ2SRGB, mul3(adapt, rgb2xyz));
  return { m: m.flat(), trc: { r: trcR, g: trcG, b: trcB } };
}

// Applies the iccToSrgbMatrix() result to encoded profile RGB in [0,1] (row-major, in place):
// forward TRC -> matrix -> the sRGB curve, so the output is encoded sRGB like pairs.to_srgb.
export function applyIcc(rgb, icc) {
  const { m, trc } = icc;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = evalTrc(trc.r, rgb[i]), g = evalTrc(trc.g, rgb[i + 1]), b = evalTrc(trc.b, rgb[i + 2]);
    rgb[i]     = srgbEncode(m[0] * r + m[1] * g + m[2] * b);
    rgb[i + 1] = srgbEncode(m[3] * r + m[4] * g + m[5] * b);
    rgb[i + 2] = srgbEncode(m[6] * r + m[7] * g + m[8] * b);
  }
  return rgb;
}

// --------------------------------------------------------------------------- WB and edit metadata

let wbWeights = null;   // the 5x2 wbmap weights (web/model/wbmap.json), set by the caller

export function setWbMapWeights(w) {
  wbWeights = w.map((row) => [row[0], row[1]]);
}

// Port of wbmap.features/predict: [1, m, m^2, tint, tint*m] @ w, m = 1e6/temp.
export function wbPredict(w, temp, tint) {
  const m = 1e6 / temp;
  const f = [1, m, m * m, tint, tint * m];
  return [f[0] * w[0][0] + f[1] * w[1][0] + f[2] * w[2][0] + f[3] * w[3][0] + f[4] * w[4][0],
          f[0] * w[0][1] + f[1] * w[1][1] + f[2] * w[2][1] + f[3] * w[3][1] + f[4] * w[4][1]];
}

// Port of wbmap.multipliers, endianness included: DNG AsShotNeutral (0xC628) or the NEF
// MakerNote WB_RBLevels (0x0C, EXIF 0x927C + 10). Returns [log(R/G), log(B/G)].
export function wbMultipliers(rawBytes) {
  const le = rawBytes[0] === 0x49 && rawBytes[1] === 0x49;
  const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const u32 = (p) => dv.getUint32(p, le);
  const ifd0 = ifd(rawBytes, u32(4), le);
  const neutral = ifd0.get(0xC628);
  if (neutral) {
    const v = [0, 1, 2, 3, 4, 5].map((i) => dv.getUint32(neutral.offset + 4 * i, le));
    const r = v[0] / v[1], g = v[2] / v[3], bl = v[4] / v[5];
    return [Math.log(g / r), Math.log(g / bl)];
  }
  const exif = ifd(rawBytes, u32(ifd0.get(0x8769).offset), le);
  const base = exif.get(0x927C).offset + 10;
  const le2 = rawBytes[base] === 0x49 && rawBytes[base + 1] === 0x49;
  const dv2 = new DataView(rawBytes.buffer, rawBytes.byteOffset + base, rawBytes.byteLength - base);
  const maker = ifd(rawBytes, base + dv2.getUint32(4, le2), le2, base);
  const v = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => dv2.getUint32(maker.get(0x0C).offset - base + 4 * i, le2));
  return [Math.log(v[0] / v[1] / (v[4] / v[5])), Math.log(v[2] / v[3] / (v[4] / v[5]))];
}

// The wbmap.tiff_ifd walking (a local copy: wbmap passes `base` for the MakerNote sub-IFD,
// which the JPEG-side TIFF helpers do not need).
function ifd(bytes, offset, le, base = 0) {
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  for (let i = 0; i < dv.getUint16(offset, le); i++) {
    const p = offset + 2 + 12 * i;
    const tag = dv.getUint16(p, le);
    const kind = dv.getUint16(p + 2, le);
    const count = dv.getUint32(p + 4, le);
    const small = (sizes[kind] ?? 1) * count <= 4;
    out.set(tag, { kind, count,
                   offset: small ? p + 8 : base + dv.getUint32(p + 8, le) });
  }
  return out;
}

// Port of match.edit_gain: exp(wbmap.predict(T, Tint) - camera multipliers) on R,B times
// 2^Exposure2012, with the exact note string. `xmp` is a parseXmp() result, `multipliers` the
// wbMultipliers() output (or null when there is no RAW — the WB part is then skipped, the
// exposure part still applies). `weights` defaults to the setWbMapWeights() value.
export function editGain(xmp, multipliers, weights = wbWeights) {
  let g = [1, 1, 1];
  const notes = [];
  if ((xmp.WhiteBalance ?? "As Shot") !== "As Shot" && "Temperature" in xmp && multipliers) {
    if (!weights) throw new Error("editGain: wbmap weights not set (setWbMapWeights)");
    const d = wbPredict(weights, parseFloat(xmp.Temperature), parseFloat(xmp.Tint));
    g = [Math.exp(d[0] - multipliers[0]), 1, Math.exp(d[1] - multipliers[1])];
    notes.push(`WB ${xmp.Temperature} K, ${xmp.Tint} (R x${g[0].toFixed(3)}, B x${g[2].toFixed(3)})`);
  }
  const ev = xmp.Exposure2012 ? parseFloat(xmp.Exposure2012) : 0;
  if (ev) {
    g = g.map((v) => v * 2 ** ev);
    notes.push(`exposure ${(ev >= 0 ? "+" : "-") + Math.abs(ev).toFixed(2)}`);
  }
  return { gain: g, note: notes.length ? notes.join(", ") : null };
}

// Port of match.edit_warnings as structured codes (the main thread localizes; formatWarning
// reproduces the exact Python strings for the golden tests). `size` is [w, h].
export function editWarningCodes(name, size, xmp) {
  const out = [];
  if (Math.max(size[0], size[1]) < MIN_TARGET)
    out.push({ code: "small_target", name, w: size[0], h: size[1] });
  if (!("Temperature" in xmp)) out.push({ code: "no_lr_settings", name });
  if (xmp._masks) out.push({ code: "masks", name });
  if (xmp.PostCropVignetteAmount && parseFloat(xmp.PostCropVignetteAmount))
    out.push({ code: "vignette", name });
  if (xmp.GrainAmount && parseFloat(xmp.GrainAmount))
    out.push({ code: "grain", name });
  return out;
}

// The exact match.edit_warnings English string for a code from editWarningCodes().
export function formatWarning(c) {
  switch (c.code) {
    case "small_target":
      return `${c.name}: read only the ${c.w}x${c.h} preview, better give a JPEG or TIFF`;
    case "no_lr_settings":
      return `${c.name}: no Lightroom settings in XMP: WB, exposure and masks are invisible, they will land in the profile`;
    case "masks":
      return `${c.name}: has masks, local corrections are not carried into NP3`;
    case "vignette":
    case "grain":
      return `${c.name}: ${c.code} from the preset has no place in NP3`;
    default:
      throw new Error(`formatWarning: unknown code ${c.code}`);
  }
}

// --------------------------------------------------------------------------- decodeTarget (DOM/codec wrapper)

function sniffFormat(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return "JPEG";
  throw new Error("unsupported target format: the browser accepts JPEG targets only");
}

// ImageBitmap -> Float32Array RGB 0..1 (alpha dropped) via an OffscreenCanvas (Worker-safe) or
// a plain canvas.
async function bitmapToFloat(bitmap) {
  let ctx;
  if (typeof OffscreenCanvas !== "undefined") {
    ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { colorSpace: "srgb" });
  } else {
    const c = document.createElement("canvas");
    c.width = bitmap.width; c.height = bitmap.height;
    ctx = c.getContext("2d", { colorSpace: "srgb" });
  }
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const rgb = new Float32Array(bitmap.width * bitmap.height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i] / 255; rgb[j + 1] = data[i + 1] / 255; rgb[j + 2] = data[i + 2] / 255;
  }
  return rgb;
}

// Firefox applies the EXIF orientation even with imageOrientation:"none" (Chrome honors it),
// so for an oriented JPEG the tag is rewritten to 1 in a copy of the bytes — the decode then
// yields the stored raster, which is what the Python reference sees (§6.3).
function neutralizeJpegOrientation(bytes) {
  const out = bytes.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const hit = jpegScan(out, (marker, off, len) => {
    if (marker !== 0xE1 || len < 14 || ASCII(out, off, off + 6) !== "Exif\0\0") return null;
    const tiff = off + 6;
    const le = out[tiff] === 0x49 && out[tiff + 1] === 0x49;
    const ifd0 = tiff + dv.getUint32(tiff + 4, le);   // the offset is relative to the TIFF header
    for (let i = 0; i < dv.getUint16(ifd0, le); i++) {
      const p = ifd0 + 2 + 12 * i;
      if (dv.getUint16(p, le) === 274) { dv.setUint16(p + 8, 1, le); return true; }
    }
    return null;
  });
  return hit ? out : bytes;
}

// The pairs.to_srgb ICC decision (§6.12), applied to the raw pixels of a decoded target:
// no ICC or an sRGB description -> as-is; a matrix-shaper ICC -> the JS matrix (float);
// a LUT ICC -> the caller falls back to the browser CMS.
function iccNormalization(icc) {
  if (!icc) return { description: null, matrix: null };
  const description = iccDescription(icc);
  if (isSrgbDescription(description)) return { description, matrix: null };
  return { description, matrix: iccToSrgbMatrix(icc) };
}

// Full target decode (spec/web-schemas.md §7.1): JPEG via createImageBitmap with
// imageOrientation:"none" (§6.3), then the ICC normalization of pairs.to_srgb (a matrix-shaper
// ICC is applied in JS floats; a LUT-based ICC goes through the browser CMS). Anything that is
// not a JPEG is rejected — TIFF stays in the Python CLI. Runs in a Worker (no document access —
// OffscreenCanvas).
export async function decodeTarget(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffFormat(bytes);
  const xmpBytes = extractXmp(bytes, format);
  const xmp = parseXmp(xmpBytes);
  const orientation = exifOrientation(bytes, "JPEG");
  const icc = extractIcc(bytes, "JPEG");
  const { description, matrix } = iccNormalization(icc);
  const source = orientation && orientation !== 1 ? neutralizeJpegOrientation(bytes) : bytes;
  const bitmap = matrix
    ? await createImageBitmap(new Blob([source], { type: "image/jpeg" }),
                              { imageOrientation: "none", colorSpaceConversion: "none" })
    : await createImageBitmap(new Blob([source], { type: "image/jpeg" }), { imageOrientation: "none" });
  const width = bitmap.width, height = bitmap.height;
  let rgb = await bitmapToFloat(bitmap);
  bitmap.close();
  if (matrix) applyIcc(rgb, matrix);
  return { width, height, rgb, format, orientation,
           xmp, iccPresent: !!icc, iccDescription: description };
}
