// Reading and writing Nikon Flexible Color Picture Control (.NP3).
// Python pair: np3.py (deserialize/serialize, Control/Curve, O_* offsets). Policy: spec/web-tests.md.
// The data structure is as in Python: snake_case fields, blender/grade are objects, curve is {raw, points} or null.

export const O_NAME = 0x18;
export const O_SHARP = 0x52;
export const O_MID = 0xF2;
export const O_CLARITY = 0x5C;
export const O_CONTRAST = 0x110;
export const O_HIGHLIGHTS = 0x11A;
export const O_SHADOWS = 0x124;
export const O_WHITE = 0x12E;
export const O_BLACK = 0x138;
export const O_SATURATION = 0x142;
export const O_BLENDER = 0x14C;
export const O_GRADE_S = 0x170;   // shadows: verified in NX on 2026-11-11, the field used to be mistakenly called highlights
export const O_GRADE_M = 0x174;
export const O_GRADE_H = 0x178;   // highlights
export const O_BLENDING = 0x180;
export const O_BALANCE = 0x182;
export const O_FLAG_A = 0x185;
export const O_FLAG_B = 0x186;
export const O_CURVE_FLAG = 0x187;
export const O_CURVE_POINTS = 0x194;
export const O_CURVE_RAW = 0x1CC;
export const CURVE_EXT_LEN = 586;  // length of baseWithToneCurve minus BASE

export const COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta"];
export const ZONES = ["shadows", "midtone", "highlights"];   // order of the offsets in the file: from dark to light
const ZONE_OFF = { shadows: O_GRADE_S, midtone: O_GRADE_M, highlights: O_GRADE_H };

// BASE: the immutable part of the file before the curve block, as in np3.py
const BASE_HEX =
  "4e435000000001000000000430333130000002000000001400000000000000000000000000000000" +
  "0000000000000300000000020020000004000000000200000000050000000002ff01000006000000" +
  "00028804000007000000000282040000080000000002ff040000090000000002ff0400000a000000" +
  "0002ff0400000b0000000002ff0400000c0000000002ff0000000d0000000002ff0000000e000000" +
  "0002ff0400000f0000000002ff010000100000000002ff010000110000000002ff01000012000000" +
  "0002ff010000130000000002ff01000014000000000280010000150000000002ff0a000016000000" +
  "000284040000170000000002ff040000180000000002ff040000190000000002800100001a000000" +
  "0002800100001b0000000002800100001c0000000002800100001d0000000002800100001e000000" +
  "0002800100001f000000001c80808080808080808080808080808080808080808080808001010100" +
  "000020000000001480008080800080808000808001010100b201800100000000";
const BASE = new Uint8Array(BASE_HEX.match(/.{2}/g).map((h) => parseInt(h, 16)));
console.assert(BASE.length === 0x188, "BASE length");

// Curve block header: from the end of BASE to the table (0x188..0x1cb).
const CURVE_HEAD = new Uint8Array((
  "00000242493000ff00ff0100020000ffff0000000000000000000000000000000000000000000000" +
  "00000000000000000000000000000000000000000000000000000000"
).match(/.{2}/g).map((h) => parseInt(h, 16)));

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Python round(): banker's rounding (halves to even), as np3._i
export function pyRound(v) {
  const fl = Math.floor(v);
  if (v - fl < 0.5) return fl;
  if (v - fl > 0.5) return fl + 1;
  return fl % 2 === 0 ? fl : fl + 1;
}

function _i(v) {
  return pyRound(v);
}

/** The identity curve exactly as in Nikon files: i*128, above the middle i*128-1. */
export function identityCurve() {
  const raw = Array.from({ length: 257 }, (_, i) => (i <= 128 ? i * 128 : i * 128 - 1));
  return { raw, points: [[0, 0], [255, 255]] };
}

// A lossless decoder for byte round-trips in serialize.
const LATIN1 = new TextDecoder("latin1");

function commentPayload(comment) {
  if (comment.includes("\0")) throw new Error("comment must not contain NUL");
  // Python: comment[:256] — by code points, then utf-8 and an even length with NUL padding
  const enc = new TextEncoder().encode(Array.from(comment).slice(0, 256).join(""));
  const n = enc.length + 1 + ((enc.length + 1) % 2);
  const p = new Uint8Array(n);
  p.set(enc);
  return p;
}

function curveExtension() {
  // The curve block: header with (0,0)-(255,255) points, identity table, tail.
  const ext = new Uint8Array(CURVE_EXT_LEN);
  ext.set(CURVE_HEAD);
  const dv = new DataView(ext.buffer);
  identityCurve().raw.forEach((v, i) => dv.setUint16(O_CURVE_RAW - BASE.length + i * 2, v));
  return ext;
}

/** Serializes a Control into .NP3 file bytes (byte-exact as np3.serialize). */
export function serialize(c) {
  if (!(c.name.length >= 1 && c.name.length <= 19 && /^[\x00-\x7F]*$/.test(c.name)))
    throw new Error("name: 1..19 ASCII characters");
  const head = new Uint8Array(BASE.length);
  head.set(BASE);
  const b = head; // mutable copy of BASE
  const encName = new TextEncoder().encode(c.name);
  b.set(encName, O_NAME);
  b[O_SHARP] = 0x80 + _i(clamp(c.sharpening, -3, 9) * 4);
  b[O_MID] = 0x80 + _i(clamp(c.mid_sharpening, -5, 5) * 4);
  b[O_CLARITY] = 0x80 + _i(clamp(c.clarity, -5, 5) * 4);
  for (const [off, v] of [[O_CONTRAST, c.contrast], [O_HIGHLIGHTS, c.highlights],
                          [O_SHADOWS, c.shadows], [O_WHITE, c.white], [O_BLACK, c.black],
                          [O_SATURATION, c.saturation]])
    b[off] = 0x80 + _i(clamp(v, -100, 100));
  COLORS.forEach((color, i) => {
    const t = c.blender[color] || [0, 0, 0];
    const o = O_BLENDER + i * 3;
    b[o] = 0x80 + _i(clamp(t[0], -100, 100));
    b[o + 1] = 0x80 + _i(clamp(t[1], -100, 100));
    b[o + 2] = 0x80 + _i(clamp(t[2], -100, 100));
  });
  for (const zone of ZONES) {
    const t = c.grade[zone] || [0, 0, 0];
    const o = ZONE_OFF[zone];
    const h = ((_i(t[0]) % 360) + 360) % 360;
    b[o] = 0x80 + (h >> 8);
    b[o + 1] = h & 0xFF;
    b[o + 2] = 0x80 + _i(clamp(t[1], -100, 100));
    b[o + 3] = 0x80 + _i(clamp(t[2], -100, 100));
  }
  b[O_BLENDING] = 0x80 + _i(clamp(c.blending, -100, 100));
  b[O_BALANCE] = 0x80 + _i(clamp(c.balance, -100, 100));

  const out = [b];
  let start = BASE.length;
  if (c.comment) {
    const p = commentPayload(c.comment);
    b[O_FLAG_A] = 1;
    b[O_FLAG_B] = 1;
    const hdr = new Uint8Array(8 + p.length);
    new DataView(hdr.buffer).setUint32(0, p.length);
    hdr.set(p, 4);
    new DataView(hdr.buffer).setUint32(4 + p.length, c.curve ? 2 : 0);
    out.push(hdr);
    start = BASE.length + hdr.length;
  }
  if (c.curve === null || c.curve === undefined) {
    return concat(out);
  }

  out.push(curveExtension());
  for (const off of [O_CONTRAST, O_HIGHLIGHTS, O_SHADOWS, O_WHITE, O_BLACK])
    b[off] = 0x01; // tonal fields are excluded: the file defines them by the curve
  if (!c.comment) b[O_CURVE_FLAG] = 2;
  const delta = start - BASE.length;
  if (c.curve.raw.length !== 257) throw new Error("curve: 257 values required");
  const all = concat(out); // a single array: the table is written at the delta offset
  const dv = new DataView(all.buffer);
  c.curve.raw.forEach((v, i) =>
    dv.setUint16(O_CURVE_RAW + delta + i * 2, _i(clamp(v, 0, 32767))));
  const pts = c.curve.points.slice(0, 20);
  all[O_CURVE_POINTS + delta] = pts.length;
  pts.forEach(([x, y], i) => {
    const o = O_CURVE_POINTS + delta + 1 + i * 2;
    all[o] = _i(clamp(x, 0, 255));
    all[o + 1] = _i(clamp(y, 0, 255));
  });
  return all;
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const r = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { r.set(p, o); o += p.length; }
  return r;
}

/**
 * Parses a .NP3 file. buf: Uint8Array or ArrayBuffer.
 * On error: an exception with a clear message, no partial Control is returned.
 */
export function deserialize(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (bytes.length < 4 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "NCP\0")
    throw new Error("not a Picture Control file");
  if (bytes.length < BASE.length)
    throw new Error(`file truncated: ${bytes.length} bytes, need at least ${BASE.length}`);
  const u32 = (o) => {
    if (o + 4 > bytes.length) throw new Error("file truncated: missing block length field");
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(o);
  };
  const name = LATIN1.decode(bytes.subarray(O_NAME, O_NAME + 19)).split("\0", 1)[0];
  let comment = "", start = null;
  if (bytes[O_FLAG_A] === 1 && bytes[O_FLAG_B] === 1 && bytes.length >= BASE.length + 8) {
    const n = u32(BASE.length);
    if (n && n % 2 === 0) {
      // Python reads the slice without a length check, but the next field (nxt) must fit
      const end = Math.min(BASE.length + 4 + n, bytes.length);
      comment = new TextDecoder("utf-8").decode(
        bytes.subarray(BASE.length + 4, end)).split("\0", 1)[0];
      const nxt = u32(BASE.length + 4 + n);
      if (nxt === 2) start = BASE.length + 8 + n;
    }
  }
  if (start === null && bytes[O_CURVE_FLAG] === 2 && bytes.length >= BASE.length + CURVE_EXT_LEN)
    start = BASE.length;

  const s8 = (o) => bytes[o] - 0x80;
  const c = {
    name,
    comment,
    sharpening: s8(O_SHARP) / 4,
    mid_sharpening: s8(O_MID) / 4,
    clarity: s8(O_CLARITY) / 4,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    white: 0,
    black: 0,
    saturation: s8(O_SATURATION),
    blender: {},
    grade: {},
    blending: s8(O_BLENDING),
    balance: s8(O_BALANCE),
    curve: null,
  };
  if (start === null) {
    c.contrast = s8(O_CONTRAST);
    c.highlights = s8(O_HIGHLIGHTS);
    c.shadows = s8(O_SHADOWS);
    c.white = s8(O_WHITE);
    c.black = s8(O_BLACK);
  }
  COLORS.forEach((color, i) => {
    const o = O_BLENDER + i * 3;
    c.blender[color] = [s8(o), s8(o + 1), s8(o + 2)];
  });
  for (const zone of ZONES) {
    const o = ZONE_OFF[zone];
    c.grade[zone] = [((bytes[o] & 0x0F) << 8) + bytes[o + 1], s8(o + 2), s8(o + 3)];
  }
  if (start !== null) {
    const d = start - BASE.length;
    if (O_CURVE_RAW + d + 257 * 2 > bytes.length)
      throw new Error("file truncated: missing curve table");
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const raw = Array.from({ length: 257 }, (_, i) => dv.getUint16(O_CURVE_RAW + d + i * 2));
    const n = bytes[O_CURVE_POINTS + d];
    if (O_CURVE_POINTS + d + 1 + n * 2 > bytes.length)
      throw new Error("file truncated: missing curve points");
    const points = Array.from({ length: n }, (_, i) =>
      [bytes[O_CURVE_POINTS + d + 1 + i * 2], bytes[O_CURVE_POINTS + d + 2 + i * 2]]);
    c.curve = { raw, points };
  }
  return c;
}

/** Factory of a new profile: name NPF-MANUAL, defaults as np3.Control() in Python. */
export function newProfile() {
  return {
    name: "NPF-MANUAL",
    comment: "",
    sharpening: 2.0,
    mid_sharpening: 1.0,
    clarity: 0.5,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    white: 0,
    black: 0,
    saturation: 0,
    blender: {},
    grade: {},
    blending: 50,
    balance: 0,
    curve: null,
  };
}
