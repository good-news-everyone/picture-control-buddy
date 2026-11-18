"""Reading and writing Nikon Flexible Color Picture Control (.NP3).

The byte layout mirrors ssssota/nikon-flexible-color-picture-control (MIT),
commit ed0397f: the same offsets, the same block order. Verified bit-exact
against the samples in third_party/samples (see test_np3.py).
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

BASE_HEX = (
    "4e435000000001000000000430333130000002000000001400000000000000000000000000000000"
    "0000000000000300000000020020000004000000000200000000050000000002ff01000006000000"
    "00028804000007000000000282040000080000000002ff040000090000000002ff0400000a000000"
    "0002ff0400000b0000000002ff0400000c0000000002ff0000000d0000000002ff0000000e000000"
    "0002ff0400000f0000000002ff010000100000000002ff010000110000000002ff01000012000000"
    "0002ff010000130000000002ff01000014000000000280010000150000000002ff0a000016000000"
    "000284040000170000000002ff040000180000000002ff040000190000000002800100001a000000"
    "0002800100001b0000000002800100001c0000000002800100001d0000000002800100001e000000"
    "0002800100001f000000001c80808080808080808080808080808080808080808080808001010100"
    "000020000000001480008080800080808000808001010100b201800100000000"
)
BASE = bytes.fromhex(BASE_HEX)
assert len(BASE) == 0x188, len(BASE)

# Curve block header: from the end of BASE to the table (0x188..0x1cb).
CURVE_HEAD = bytes.fromhex(
    "00000242493000ff00ff0100020000ffff0000000000000000000000000000000000000000000000"
    "00000000000000000000000000000000000000000000000000000000"
)

O_NAME = 0x18
O_SHARP = 0x52
O_MID = 0xF2
O_CLARITY = 0x5C
O_CONTRAST = 0x110
O_HIGHLIGHTS = 0x11A
O_SHADOWS = 0x124
O_WHITE = 0x12E
O_BLACK = 0x138
O_SATURATION = 0x142
O_BLENDER = 0x14C
O_GRADE_S = 0x170   # shadows: verified in NX on 2026-11-11, the field used to be mistakenly called highlights
O_GRADE_M = 0x174
O_GRADE_H = 0x178   # highlights
O_BLENDING = 0x180
O_BALANCE = 0x182
O_FLAG_A = 0x185
O_FLAG_B = 0x186
O_CURVE_FLAG = 0x187
O_CURVE_POINTS = 0x194
O_CURVE_RAW = 0x1CC
CURVE_EXT_LEN = 586  # length of baseWithToneCurve minus BASE

COLORS = ("red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta")
ZONES = ("shadows", "midtone", "highlights")   # order of the offsets in the file: from dark to light
_ZONE_OFF = {"shadows": O_GRADE_S, "midtone": O_GRADE_M, "highlights": O_GRADE_H}
# zone letters in probe names of sweep.py and make_pack.py (GH0-40, GBHP50, BLD0H, GRH0): left over from the old
# swapped names and matching the already exported files, so H is shadows and S is highlights
ZONE_TAG = {"shadows": "H", "midtone": "M", "highlights": "S"}


def _clamp(v, lo, hi):
    return min(hi, max(lo, v))


def _i(v) -> int:
    return int(round(v))


@dataclass
class Curve:
    """raw — 257 values 0..32767; points — up to 20 (x, y) pairs 0..255."""

    raw: list[int]
    points: list[tuple[int, int]]


@dataclass
class Control:
    name: str
    comment: str = ""
    sharpening: float = 2.0
    mid_sharpening: float = 1.0
    clarity: float = 0.5
    contrast: int = 0
    highlights: int = 0
    shadows: int = 0
    white: int = 0
    black: int = 0
    saturation: int = 0
    # blender[color] = (hue, chroma, brightness), each -100..100
    blender: dict[str, tuple[int, int, int]] = field(default_factory=dict)
    # grade[zone] = (hue 0..359, chroma, brightness)
    grade: dict[str, tuple[int, int, int]] = field(default_factory=dict)
    blending: int = 50
    balance: int = 0
    curve: Curve | None = None


def identity_curve() -> Curve:
    """The identity curve exactly as in Nikon files: i*128, above the middle i*128-1."""
    raw = [i * 128 if i <= 128 else i * 128 - 1 for i in range(257)]
    return Curve(raw=raw, points=[(0, 0), (255, 255)])


def _natural_spline(xs: list[float], ys: list[float]) -> list[float]:
    """Second derivatives of the natural cubic spline (zero at the ends)."""
    n = len(xs)
    if n < 3:
        return [0.0] * n
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    # tridiagonal system for the interior knots (indices 1..n-2):
    # h[i-1]*m[i-1] + 2(h[i-1]+h[i])*m[i] + h[i]*m[i+1] = 6*((dy/h)[i] - (dy/h)[i-1])
    cp = [0.0] * n   # Thomas algorithm multipliers
    dp = [0.0] * n
    for i in range(1, n - 1):
        a = h[i - 1]
        b = 2 * (h[i - 1] + h[i]) - a * cp[i - 1]
        r = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1])
        cp[i] = h[i] / b
        dp[i] = (r - a * dp[i - 1]) / b
    m = [0.0] * n
    for i in range(n - 2, 0, -1):
        m[i] = dp[i] - cp[i] * m[i + 1]
    return m


def _spline_value(xs, ys, m, x: float) -> float:
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    lo, hi = 0, len(xs) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if xs[mid] <= x:
            lo = mid
        else:
            hi = mid
    h = xs[lo + 1] - xs[lo]
    t = (x - xs[lo]) / h
    a, b = 1 - t, t
    return (a * ys[lo] + b * ys[lo + 1]
            + ((a ** 3 - a) * m[lo] + (b ** 3 - b) * m[lo + 1]) * h * h / 6.0)


def curve_table(points) -> Curve:
    """Editor points -> Curve: the table via a natural cubic spline.

    Verified bit-exact on 5 official samples with curves (2026-11-16,
    algorithm in spec/np3-format.md): raw[i] = round(clamp(spline(i*255/256), 0, 255) * 32767 / 255).
    Fewer than two points gives the identity curve. Points are stored normalized
    (clamp 0..255, sorted by x, at most 20).
    """
    pts = sorted({(_i(_clamp(float(x), 0, 255)), _i(_clamp(float(y), 0, 255)))
                  for x, y in points}, key=lambda p: p[0])
    if len(pts) < 2:
        return identity_curve()
    xs = [float(x) for x, _ in pts]
    ys = [float(y) for _, y in pts]
    m = _natural_spline(xs, ys)
    raw = [_i(_clamp(_spline_value(xs, ys, m, i * 255 / 256), 0, 255) * 32767 / 255)
           for i in range(257)]
    return Curve(raw=raw, points=pts[:20])


def _comment_payload(comment: str) -> bytes:
    if "\0" in comment:
        raise ValueError("comment must not contain NUL")
    enc = comment[:256].encode("utf-8")
    n = len(enc) + 1
    n += n % 2
    return enc.ljust(n, b"\0")


def serialize(c: Control) -> bytes:
    if not 1 <= len(c.name) <= 19 or not c.name.isascii():
        raise ValueError("name: 1..19 ASCII characters")
    b = bytearray(BASE)
    b[O_NAME:O_NAME + len(c.name)] = c.name.encode("ascii")
    b[O_SHARP] = 0x80 + _i(_clamp(c.sharpening, -3, 9) * 4)
    b[O_MID] = 0x80 + _i(_clamp(c.mid_sharpening, -5, 5) * 4)
    b[O_CLARITY] = 0x80 + _i(_clamp(c.clarity, -5, 5) * 4)
    for off, v in ((O_CONTRAST, c.contrast), (O_HIGHLIGHTS, c.highlights),
                   (O_SHADOWS, c.shadows), (O_WHITE, c.white), (O_BLACK, c.black),
                   (O_SATURATION, c.saturation)):
        b[off] = 0x80 + _i(_clamp(v, -100, 100))
    for i, color in enumerate(COLORS):
        h, ch, br = c.blender.get(color, (0, 0, 0))
        o = O_BLENDER + i * 3
        b[o] = 0x80 + _i(_clamp(h, -100, 100))
        b[o + 1] = 0x80 + _i(_clamp(ch, -100, 100))
        b[o + 2] = 0x80 + _i(_clamp(br, -100, 100))
    for zone in ZONES:
        h, ch, br = c.grade.get(zone, (0, 0, 0))
        o = _ZONE_OFF[zone]
        h = _i(h) % 360
        b[o] = 0x80 + (h >> 8)
        b[o + 1] = h & 0xFF
        b[o + 2] = 0x80 + _i(_clamp(ch, -100, 100))
        b[o + 3] = 0x80 + _i(_clamp(br, -100, 100))
    b[O_BLENDING] = 0x80 + _i(_clamp(c.blending, -100, 100))
    b[O_BALANCE] = 0x80 + _i(_clamp(c.balance, -100, 100))

    start = len(b)
    if c.comment:
        p = _comment_payload(c.comment)
        b[O_FLAG_A] = 1
        b[O_FLAG_B] = 1
        b += struct.pack(">I", len(p)) + p + struct.pack(">I", 2 if c.curve else 0)
        start = len(b)
    if c.curve is None:
        return bytes(b)

    b += _curve_extension()
    for off in (O_CONTRAST, O_HIGHLIGHTS, O_SHADOWS, O_WHITE, O_BLACK):
        b[off] = 0x01
    if not c.comment:
        b[O_CURVE_FLAG] = 2
    delta = start - len(BASE)
    if len(c.curve.raw) != 257:
        raise ValueError("curve: 257 values required")
    for i, v in enumerate(c.curve.raw):
        struct.pack_into(">H", b, O_CURVE_RAW + delta + i * 2, _i(_clamp(v, 0, 32767)))
    pts = c.curve.points[:20]
    b[O_CURVE_POINTS + delta] = len(pts)
    for i, (x, y) in enumerate(pts):
        o = O_CURVE_POINTS + delta + 1 + i * 2
        b[o] = _i(_clamp(x, 0, 255))
        b[o + 1] = _i(_clamp(y, 0, 255))
    return bytes(b)


def _curve_extension() -> bytes:
    """The curve block: header with (0,0)-(255,255) points, identity table, tail."""
    ext = bytearray(CURVE_EXT_LEN)
    ext[:len(CURVE_HEAD)] = CURVE_HEAD
    struct.pack_into(">257H", ext, O_CURVE_RAW - len(BASE), *identity_curve().raw)
    return bytes(ext)


def deserialize(buf: bytes) -> Control:
    if buf[:4] != b"NCP\0":
        raise ValueError("not a Picture Control file")
    name = buf[O_NAME:O_NAME + 19].split(b"\0", 1)[0].decode("latin-1")
    comment, start = "", None
    if buf[O_FLAG_A] == 1 and buf[O_FLAG_B] == 1 and len(buf) >= len(BASE) + 8:
        n = struct.unpack_from(">I", buf, len(BASE))[0]
        if n and n % 2 == 0:
            comment = buf[len(BASE) + 4:len(BASE) + 4 + n].split(b"\0", 1)[0].decode("utf-8", "replace")
            nxt = struct.unpack_from(">I", buf, len(BASE) + 4 + n)[0]
            if nxt == 2:
                start = len(BASE) + 8 + n
    if start is None and buf[O_CURVE_FLAG] == 2 and len(buf) >= len(BASE) + CURVE_EXT_LEN:
        start = len(BASE)

    c = Control(name=name, comment=comment)
    c.sharpening = (buf[O_SHARP] - 0x80) / 4
    c.mid_sharpening = (buf[O_MID] - 0x80) / 4
    c.clarity = (buf[O_CLARITY] - 0x80) / 4
    if start is None:
        c.contrast = buf[O_CONTRAST] - 0x80
        c.highlights = buf[O_HIGHLIGHTS] - 0x80
        c.shadows = buf[O_SHADOWS] - 0x80
        c.white = buf[O_WHITE] - 0x80
        c.black = buf[O_BLACK] - 0x80
    c.saturation = buf[O_SATURATION] - 0x80
    for i, color in enumerate(COLORS):
        o = O_BLENDER + i * 3
        c.blender[color] = (buf[o] - 0x80, buf[o + 1] - 0x80, buf[o + 2] - 0x80)
    for zone in ZONES:
        o = _ZONE_OFF[zone]
        c.grade[zone] = (((buf[o] & 0x0F) << 8) + buf[o + 1], buf[o + 2] - 0x80, buf[o + 3] - 0x80)
    c.blending = buf[O_BLENDING] - 0x80
    c.balance = buf[O_BALANCE] - 0x80
    if start is not None:
        d = start - len(BASE)
        raw = list(struct.unpack_from(">257H", buf, O_CURVE_RAW + d))
        n = buf[O_CURVE_POINTS + d]
        pts = [(buf[O_CURVE_POINTS + d + 1 + i * 2], buf[O_CURVE_POINTS + d + 2 + i * 2]) for i in range(n)]
        c.curve = Curve(raw=raw, points=pts)
    return c
