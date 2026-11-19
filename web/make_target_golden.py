"""Synthetic Stage-0 target-input fixtures -> web/golden/target/ (spec/web-schemas.md §5.2).

Small JPEG/TIFF targets plus <case>.json with the golden expectations for the future
browser port of target decoding (web/lib/target.js): what pairs.xmp_values parses,
what match.edit_warnings / match.edit_gain report and the pre-fit check metadata of
spec/web-schemas.md §2.4. Every expectation is produced by running the real Python
functions on the generated file, never hand-written.

Self-contained: no _local/ or renders/ data is needed. The only inputs are the
committed wbmap weights (data/wbmap.json) and a minimal synthetic DNG written to a
temp file so wbmap.multipliers (the camera side of edit_gain) runs without a real NEF.

    python3 web/make_target_golden.py
"""
import io
import json
import os
import shutil
import struct
import sys
import tempfile

import numpy as np
from PIL import Image, ImageCms, TiffImagePlugin

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import analyze  # noqa: E402
import match  # noqa: E402
import pairs  # noqa: E402
import wbmap  # noqa: E402

OUT = os.path.join(HERE, "golden", "target")
JP = (384, 256)     # JPEG geometry (long side <= 512)
TP = (208, 160)     # TIFF geometry (uncompressed 8-bit RGB must stay small)
MIN_TARGET = match.MIN_TARGET
CLIPPED_BAD = analyze.CLIPPED_BAD
REF_GW = 32         # reference pixel grid: at most 32 x 24 sampled pixels per JPEG case
REF_GH = 24
# Browser decode tolerance vs the PIL reference grid, in 8-bit levels (recorded per fixture).
# Measured 2026-11-19 in headless Firefox: max 0.000 (Firefox and PIL agree bit-exactly on
# these fixtures) — 0.5 is a robustness margin for IDCT differences across browser versions.
JPEG_BROWSER_MAX = 0.5


# --------------------------------------------------------------------------- content

def base_scene(w: int, h: int, rng) -> np.ndarray:
    """A photo-plausible gradient landscape with asymmetric markers and color patches."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = np.zeros((h, w, 3), np.float32)
    horizon = int(h * 0.62)
    t = (yy / horizon).clip(0, 1)[..., None]
    a[:horizon] = np.array([146, 178, 222]) * (1 - t[:horizon]) + np.array([214, 212, 205]) * t[:horizon]
    g = ((yy - horizon) / max(1, h - horizon)).clip(0, 1)[..., None]
    a[horizon:] = np.array([104, 118, 62]) * (1 - g[horizon:]) + np.array([46, 56, 30]) * g[horizon:]
    d2 = ((xx - w * 0.78) ** 2 + (yy - h * 0.16) ** 2) / (0.09 * w * h)
    a += np.exp(-d2)[..., None] * np.array([60, 42, 8], np.float32)   # sun glow, upper right
    a += rng.normal(0, 2.5, (h, w, 3)).astype(np.float32) * np.array([0.7, 0.9, 0.6])
    tri = (xx < w * 0.30) & (yy < h * 0.30) & (xx / (w * 0.30) + yy / (h * 0.30) < 1)
    a[tri] = [196, 84, 40]                                            # warm marker, top-left
    a[(xx > w * 0.80) & (yy > h * 0.82)] = [44, 66, 138]              # blue marker, bottom-right
    return a


def add_patches(a: np.ndarray) -> np.ndarray:
    """A strip of color patches along the bottom: greys, skin, greenery, sky, warm saturated."""
    h, w = a.shape[:2]
    cols = [(228, 228, 228), (168, 168, 168), (108, 108, 108), (58, 58, 58),
            (206, 152, 122), (158, 108, 76), (86, 112, 54), (108, 156, 204),
            (214, 84, 32), (186, 40, 36)]
    pw, ph, gap = max(14, w // 13), max(14, h // 6), 6
    x0 = (w - len(cols) * (pw + gap) + gap) // 2
    y0 = h - ph - 6
    for i, c in enumerate(cols):
        x = x0 + i * (pw + gap)
        a[y0:y0 + ph, x:x + pw] = c
        a[y0:y0 + ph, x:x + pw] += np.linspace(-6, 6, ph)[:, None, None]   # a little gradient
    return a


def clipped_scene(w: int, h: int, rng) -> np.ndarray:
    """Over a third of the frame pinned at white: analyze.CLIPPED_BAD territory."""
    a = base_scene(w, h, rng)
    a[: int(h * 0.45)] = [255, 255, 255]
    d2 = ((np.mgrid[0:h, 0:w][1] - w * 0.78) ** 2 + (np.mgrid[0:h, 0:w][0] - h * 0.55) ** 2) / (0.02 * w * h)
    a += np.exp(-d2)[..., None] * np.array([0, 20, 60], np.float32)
    return a.clip(0, 255)


def grain_scene(w: int, h: int, rng) -> np.ndarray:
    """Real heavy grain in the pixels (GrainAmount stays 0: metadata is not the exercise)."""
    a = base_scene(w, h, rng)
    lum = rng.normal(0, 13, (h, w, 1)).astype(np.float32)
    return (a + lum * np.array([1.0, 1.0, 1.0])).clip(0, 255)


def vignetted_scene(w: int, h: int, rng) -> np.ndarray:
    """Strong optical vignetting, corners at ~40% of the center."""
    a = base_scene(w, h, rng)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r2 = ((xx / w - 0.5) ** 2 + (yy / h - 0.5) ** 2) / (0.5 ** 2 + 0.5 ** 2)
    return (a * (1 - 0.6 * r2[..., None])).clip(0, 255)


# --------------------------------------------------------------------------- metadata writers

def xmp_packet(attrs: list[tuple[str, str]]) -> bytes:
    """A Lightroom-style XMP packet: the edit attributes as rdf:Description attributes."""
    body = "\n".join(f'   {k}="{v}"' for k, v in attrs)
    s = ('<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
         '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00        ">\n'
         ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
         '  <rdf:Description rdf:about=""\n'
         '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"\n'
         '    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"\n'
         f'{body}\n'
         '  </rdf:Description>\n'
         ' </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>')
    return s.encode("utf-8")


COMMON = [("crs:Version", "18.5"), ("crs:ProcessVersion", "15.4"),
          ("tiff:Make", "NIKON CORPORATION"), ("tiff:Model", "NIKON Z f")]

XMP_WB = COMMON + [("crs:WhiteBalance", "Custom"), ("crs:Temperature", "6500"),
                   ("crs:Tint", "+12"), ("crs:Exposure2012", "+0.50")]
XMP_CROP = COMMON + [("crs:WhiteBalance", "As Shot"), ("crs:HasCrop", "True"),
                     ("crs:CropLeft", "0.10"), ("crs:CropTop", "0.08"), ("crs:CropRight", "0.90"),
                     ("crs:CropBottom", "0.86"), ("crs:CropAngle", "2.50"), ("crs:CropConstrainToWarp", "0")]
XMP_MASKS = COMMON + [("crs:WhiteBalance", "As Shot"),
                      ("crs:MaskGroupBasedCorrections",
                       "&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?&gt;"
                       "&lt;MaskGroupBasedCorrections version=&quot;1.0&quot;&gt;&lt;/MaskGroupBasedCorrections&gt;"),
                      ("crs:MaskGroupBasedCorrections_1",
                       "{&quot;name&quot;:&quot;Mask 1&quot;,&quot;classification&quot;:&quot;linear&quot;,"
                       "&quot;maskGrads&quot;:[],&quot;maskBrushes&quot;:[{&quot;value&quot;:20}],"
                       "&quot;maskCircles&quot;:[],&quot;maskPolygons&quot;:[]}")]
XMP_VIG_GRAIN = COMMON + [("crs:WhiteBalance", "As Shot"), ("crs:PostCropVignetteAmount", "25"),
                          ("crs:GrainAmount", "40")]


def adobe_icc() -> bytes:
    """A minimal self-contained ICC v2 matrix profile: Adobe RGB (1998) primaries, D50,
    sRGB TRC — a genuine non-sRGB space (pairs.to_srgb must convert, not pass through)."""
    def xyz(X, Y, Z):
        return b"XYZ " + b"\x00" * 4 + struct.pack(">iii", *[int(round(v * 65536)) for v in (X, Y, Z)])

    desc = b"np3-target-adobe v1.0"
    tags = [(b"desc", b"desc" + b"\x00" * 4 + struct.pack(">I", len(desc) + 1) + desc + b"\x00"),
            (b"cprt", b"text" + b"\x00" * 4 + b"np3-fit synthetic test profile\x00"),
            (b"wtpt", xyz(0.9642, 1.0, 0.82491)),
            (b"rXYZ", xyz(0.60974, 0.31111, 0.01947)),
            (b"gXYZ", xyz(0.20528, 0.62567, 0.06087)),
            (b"bXYZ", xyz(0.14919, 0.06322, 0.74484))]
    x = np.linspace(0, 1, 256)
    lin = np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)
    curv = b"curv" + b"\x00" * 4 + struct.pack(">I", 256) + b"".join(struct.pack(">H", int(round(v * 65535))) for v in lin)
    tags += [(b"rTRC", curv), (b"gTRC", curv), (b"bTRC", curv)]
    offset = 128 + 4 + 12 * len(tags)
    table, data = struct.pack(">I", len(tags)), b""
    for sig, blob in tags:
        table += sig + struct.pack(">II", offset, len(blob))
        data += blob
        offset += len(blob)
    hdr = (struct.pack(">I", offset) + b"ascp" + struct.pack(">I", 0x02100000) + b"mntr" + b"RGB " + b"XYZ "
           + struct.pack(">6H", 2026, 11, 19, 0, 0, 0) + b"acsp" + b"APPL" + struct.pack(">I", 0))
    hdr += b"\x00" * (128 - len(hdr))
    return hdr + table + data


def write_minimal_dng(path: str):
    """A tiny TIFF-structured file with DNG AsShotNeutral, enough for wbmap.multipliers."""
    data = struct.pack("<6I", 1, 2, 1, 1, 3, 5)     # neutral R=1/2, G=1/1, B=3/5
    ifd = struct.pack("<H", 1) + struct.pack("<HHII", wbmap.AS_SHOT_NEUTRAL, 5, 6, 8 + 2 + 12 + 4) + struct.pack("<I", 0)
    open(path, "wb").write(b"II*\x00\x08\x00\x00\x00" + ifd + data)


def save_jpg(name, arr, xmp=None, icc=None, orient=None):
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    kw = {"quality": 85}
    if xmp:
        kw["xmp"] = xmp
    if icc:
        kw["icc_profile"] = icc
    if orient:
        ex = Image.Exif()
        ex[274] = orient
        kw["exif"] = ex
    im.save(os.path.join(OUT, name + ".jpg"), **kw)
    return name + ".jpg"


def save_tif(name, arr, xmp=None, icc=None, orient=None):
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    ifd = TiffImagePlugin.ImageFileDirectory_v2()
    if xmp:
        ifd[700] = xmp                      # PIL 13 does not write tag 700 from the xmp= kwarg
    if orient:
        ifd[274] = orient
    kw = {}
    if icc:
        kw["icc_profile"] = icc
    if len(ifd):
        kw["tiffinfo"] = ifd
    im.save(os.path.join(OUT, name + ".tif"), **kw)   # uncompressed 8-bit RGB, as the real exports
    return name + ".tif"


# --------------------------------------------------------------------------- verification + json

def tiff_orientation(path) -> int | None:
    """Tag 274 straight from the TIFF IFD: Pillow 13 auto-applies it on open and then
    deletes it from tag_v2, so the stored value is not readable back via PIL."""
    with open(path, "rb") as f:
        b = f.read(8192)
    e = "<" if b[:2] == b"II" else ">"
    off = struct.unpack_from(e + "I", b, 4)[0]
    for i in range(struct.unpack_from(e + "H", b, off)[0]):
        p = off + 2 + 12 * i
        if struct.unpack_from(e + "H", b, p)[0] == 274:
            return struct.unpack_from(e + "H", b, p + 8)[0]
    return None


def clipped_share(path) -> float:
    im = pairs.to_srgb(Image.open(path))
    return float((np.asarray(im, dtype=np.float64).max(-1) / 255 >= 0.98).mean())


# --------------------------------------------------------------------------- ICC matrix mirror
# A Python mirror of web/lib/target.js iccToSrgbMatrix/evalTrc: same constants, same operation
# order (plain float64 lists, no numpy reassociation), so the golden matrix matches the JS
# port to ~1e-12 and the browser test can use a tight tolerance. littleCMS itself is NOT the
# reference here — the browser applies its own matrix, the Python pipeline (pairs.to_srgb)
# applies littleCMS; those two agree only approximately.

BRADFORD = ((0.8951, 0.2664, -0.1614), (-0.7502, 1.7135, 0.0367), (0.0389, -0.0685, 1.0296))
BRADFORD_INV = ((0.986993, -0.147054, 0.159963), (0.432305, 0.518360, 0.049291),
                (-0.008529, 0.040043, 0.968487))
XYZ2SRGB = ((3.2404542, -1.5371385, -0.4985314), (-0.9692660, 1.8760108, 0.0415560),
            (0.0556434, -0.2040259, 1.0572252))
D65 = (0.95047, 1.0, 1.08883)


def _mul3(a, b):
    return [[a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] for j in range(3)]
            for i in range(3)]


def _mulv(a, v):
    return [a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2] for i in range(3)]


def _inv3(m):
    a, b, c = m[0]
    d, e, f = m[1]
    g, h, i = m[2]
    A, B, C = e * i - f * h, c * h - b * i, b * f - c * e
    det = a * A + d * B + g * C
    return [[A / det, B / det, C / det],
            [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
            [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]]


def icc_matrix_reference(icc: bytes):
    """Mirror of iccToSrgbMatrix: (m row-major 9, per-channel TRCs) or (None, None) for LUT."""
    def u32(p):
        return struct.unpack_from(">I", icc, p)[0]

    def sfix(p):
        return struct.unpack_from(">i", icc, p)[0] / 65536

    n = u32(128)
    tags = {icc[p:p + 4].decode("latin1"): (u32(p + 4), u32(p + 8)) for p in
            (132 + 12 * i for i in range(n))}
    if "A2B0" in tags:
        return None, None

    def xyz(name):
        off, _ = tags[name]
        return [sfix(off + 8), sfix(off + 12), sfix(off + 16)]

    def trc(name):
        off, _ = tags[name]
        typ = icc[off:off + 4]
        if typ == b"curv":
            cnt = u32(off + 8)
            if cnt == 0:
                return ("table", None)
            if cnt == 1:
                return ("gamma", struct.unpack_from(">H", icc, off + 12)[0] / 256)
            return ("table", [struct.unpack_from(">H", icc, off + 12 + 2 * i)[0] / 65535
                              for i in range(cnt)])
        if typ == b"para":
            k = (1, 3, 4, 5, 7)[struct.unpack_from(">H", icc, off + 8)[0]]
            return ("param", [sfix(off + 12 + 4 * i) for i in range(k)])
        raise AssertionError(f"unsupported TRC type {typ!r}")

    wtpt, r, g, b = xyz("wtpt"), xyz("rXYZ"), xyz("gXYZ"), xyz("bXYZ")
    trcs = [trc("rTRC"), trc("gTRC"), trc("bTRC")]
    s, d = _mulv(BRADFORD, wtpt), _mulv(BRADFORD, D65)
    scale = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]]
    adapt = _mul3(BRADFORD_INV, _mul3(scale, BRADFORD))
    m = _inv3(_mul3(XYZ2SRGB, _mul3(adapt, [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]])))
    return [v for row in m for v in row], trcs


def eval_trc_reference(trc, x: float) -> float:
    """Mirror of evalTrc."""
    kind, v = trc
    if kind == "gamma":
        return x ** v if x >= 0 else 0
    if kind == "table":
        if v is None:
            return x
        f = x * (len(v) - 1)
        i = min(int(f), len(v) - 2)
        return v[i] + (v[i + 1] - v[i]) * (f - i)
    p = v
    g, a, bb = p[0], p[1] if len(p) > 1 else 1, p[2] if len(p) > 2 else 0
    if x < -bb / a:
        return p[6] if len(p) >= 7 else (p[3] if len(p) == 4 else 0)
    y = (a * x + bb) / (p[3] * x + p[4]) if len(p) >= 5 else a * x + bb
    out = max(y, 0) ** g
    if len(p) == 4:
        return out + p[3]
    if len(p) == 7:
        return out + p[5]
    return out


# --------------------------------------------------------------------------- pixel reference grid

def reference_grid(name: str, path: str, icc: bytes | None, profile_desc: str | None) -> dict:
    """The pixel reference for the browser decodeTarget (JPEG targets only — TIFF stays in the
    Python CLI): PIL decode, ICC-normalized with the JS matrix mirror when the profile is not
    sRGB by description. Stored as a float32 grid sidecar <case>.ref.f32 plus its grid
    coordinates."""
    im = Image.open(path)
    im.load()
    raw = np.asarray(im, dtype=np.uint8)
    rgb = raw.astype(np.float64) / 255
    used_matrix = False
    if icc and "sRGB" not in (profile_desc or ""):
        m, trcs = icc_matrix_reference(icc)
        assert m, "LUT-based ICC in a fixture — the browser matrix path cannot be tested"
        flat = rgb.reshape(-1, 3)
        for ch in range(3):
            flat[:, ch] = [eval_trc_reference(trcs[ch], float(v)) for v in flat[:, ch]]
        rgb = (flat.reshape(-1, 3) @ np.array(m, dtype=np.float64).reshape(3, 3).T).reshape(rgb.shape)
        used_matrix = True
    h, w = rgb.shape[:2]
    xs = np.unique(np.linspace(0, w - 1, min(REF_GW, w)).astype(int))
    ys = np.unique(np.linspace(0, h - 1, min(REF_GH, h)).astype(int))
    grid = rgb[np.ix_(ys, xs)].astype("<f4")
    grid.tofile(os.path.join(OUT, name + ".ref.f32"))
    return {"file": name + ".ref.f32", "gridW": [int(v) for v in xs], "gridH": [int(v) for v in ys],
            "source": "icc-matrix" if used_matrix else "raw",
            "browserMaxLevels": JPEG_BROWSER_MAX}


def icc_matrix_json(icc: bytes) -> dict:
    """The expected iccToSrgbMatrix() output: the 9 matrix entries and TRC samples."""
    m, trcs = icc_matrix_reference(icc)
    xs = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]
    return {"m": m,
            "trc": [{"x": x, "r": eval_trc_reference(trcs[0], x),
                     "g": eval_trc_reference(trcs[1], x),
                     "b": eval_trc_reference(trcs[2], x)} for x in xs]}


def build_case(name: str, fname: str, case: str, nef: str, extras: dict | None = None) -> dict:
    """Run the real parsers on the written file and record their actual outputs."""
    path = os.path.join(OUT, fname)
    im = Image.open(path)
    im.load()
    x = pairs.xmp_values(im)
    gain, note = match.edit_gain(nef, path)
    warnings = match.edit_warnings([path])
    icc = im.info.get("icc_profile")
    profile = None
    if icc:
        profile = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc)))
    orient = im.getexif().get(274)
    pil_auto_orients = False
    if im.format == "TIFF":
        stored = tiff_orientation(path)
        # Pillow 13 applies the TIFF orientation in Image.open (and drops tag 274),
        # so size/pixels are already rotated while JPEG is left untouched.
        pil_auto_orients = stored is not None and orient != stored
        orient = stored
    meta = {
        "schemaVersion": 1,
        "kind": "targetInput",
        "file": fname,
        "case": case,
        "image": {
            "format": im.format,
            "w": im.size[0],
            "h": im.size[1],
            "mode": im.mode,
            "storedSize": [im.size[1], im.size[0]] if pil_auto_orients else list(im.size),
            "exifOrientation": orient,
            "pilAutoAppliesOrientation": pil_auto_orients,
            "icc": {
                "embedded": bool(icc),
                "profile": profile,
                "treatedAsSrgb": not icc or "sRGB" in profile,
                "normalizedTo": "sRGB (assumed)" if not icc or "sRGB" in profile
                else "sRGB (converted via the embedded profile)",
            },
        },
        "xmp": x,
        "gain": [float(v) for v in gain],
        "gainNote": note or None,
        "check": {
            "camera": None,
            "adl": "?",
            "targetSize": list(im.size),
            "xmpHasLightroom": "Temperature" in x,
            "xmpMasks": x["_masks"],
            "xmpVignetteAmount": float(x.get("PostCropVignetteAmount") or 0),
            "xmpGrainAmount": float(x.get("GrainAmount") or 0),
            "blocked": None,
        },
        "warnings": warnings,
        "content": {"clippedShare": round(clipped_share(path), 4)},
    }
    if im.format == "JPEG":   # the browser consumes JPEG targets only; TIFF stays Python-side
        meta["ref"] = reference_grid(name, path, icc, profile)
    if icc and "sRGB" not in (profile or ""):
        meta["iccMatrix"] = icc_matrix_json(icc)
    if extras:
        meta["exercises"] = extras
    json.dump(meta, open(os.path.join(OUT, name + ".json"), "w"), ensure_ascii=False, indent=1)
    return meta


def expect(cond, msg):
    if not cond:
        raise AssertionError(msg)


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    rng = np.random.default_rng(0)
    icc = adobe_icc()
    tmp = tempfile.mkdtemp()
    nef = os.path.join(tmp, "synthetic.DNG")
    write_minimal_dng(nef)
    multipliers = wbmap.multipliers(nef)
    print(f"synthetic DNG camera multipliers log(R/G), log(B/G): {multipliers[0]:.4f} {multipliers[1]:.4f}")
    # the committed WB fixture for the browser port of wbmap.multipliers (web/lib/target.js)
    shutil.copy(nef, os.path.join(OUT, "wb.DNG"))
    json.dump({"schemaVersion": 1, "kind": "wbReference", "file": "wb.DNG",
               "multipliers": [float(multipliers[0]), float(multipliers[1])]},
              open(os.path.join(OUT, "wb.json"), "w"), indent=1)

    rows = []

    def reg(name, meta):
        rows.append((name, meta))
        print(f"{meta['file']:24s} xmp={len(meta['xmp']) - 1:2d} keys "
              f"gain=({meta['gain'][0]:.3f},{meta['gain'][1]:.3f},{meta['gain'][2]:.3f}) "
              f"warn={len(meta['warnings'])} clipped={meta['content']['clippedShare']:.2f}")

    # ---- JPEG ----
    reg("jpg_plain", build_case("jpg_plain",
        save_jpg("jpg_plain", add_patches(base_scene(*JP, rng))),
        "JPEG, no XMP, no ICC", nef,
        "the no-Lightroom-settings warning; the assumed-sRGB path"))
    reg("jpg_wb", build_case("jpg_wb",
        save_jpg("jpg_wb", add_patches(base_scene(*JP, rng)), xmp=xmp_packet(XMP_WB)),
        "JPEG, WB Temperature/Tint + Exposure2012 (WhiteBalance Custom)", nef,
        "the match.edit_gain path: expected gain is computable via wbmap.predict minus the "
        "camera multipliers of the synthetic DNG"))
    reg("jpg_crop", build_case("jpg_crop",
        save_jpg("jpg_crop", base_scene(*JP, rng), xmp=xmp_packet(XMP_CROP)),
        "JPEG, XMP crop rectangle + angle (HasCrop, CropConstrainToWarp)", nef,
        "pairs.apply_crop / the transform.crop contract"))
    reg("jpg_masks", build_case("jpg_masks",
        save_jpg("jpg_masks", base_scene(*JP, rng), xmp=xmp_packet(XMP_MASKS)),
        "JPEG, MaskGroupBasedCorrections / MaskGroupBasedCorrections_ (local masks)", nef,
        "the xmpMasks check and the masks warning"))
    reg("jpg_vignette_grain", build_case("jpg_vignette_grain",
        save_jpg("jpg_vignette_grain", base_scene(*JP, rng), xmp=xmp_packet(XMP_VIG_GRAIN)),
        "JPEG, PostCropVignetteAmount + GrainAmount non-zero (preset, not pixels)", nef,
        "the xmpVignetteAmount / xmpGrainAmount checks (info-only warnings)"))
    reg("jpg_orient6", build_case("jpg_orient6",
        save_jpg("jpg_orient6", base_scene(*JP, rng), orient=6),
        "JPEG, EXIF Orientation 6, asymmetric content", nef,
        "orientation is observable (triangle top-left, square bottom-right) and must NOT be "
        "auto-applied by the decoder"))
    reg("jpg_orient8", build_case("jpg_orient8",
        save_jpg("jpg_orient8", base_scene(*JP, rng), orient=8),
        "JPEG, EXIF Orientation 8, asymmetric content", nef,
        "the mirrored rotation case of jpg_orient6"))
    reg("jpg_icc", build_case("jpg_icc",
        save_jpg("jpg_icc", add_patches(base_scene(*JP, rng)), icc=icc),
        "JPEG, embedded non-sRGB ICC (np3-target-adobe v1.0)", nef,
        "ICC normalization to sRGB must run; the profile description must not contain 'sRGB'"))
    reg("jpg_clipped", build_case("jpg_clipped",
        save_jpg("jpg_clipped", clipped_scene(*JP, rng)),
        "JPEG, >30% of pixels pinned at white", nef,
        f"analyze.CLIPPED_BAD = {CLIPPED_BAD}: verdict 'bad' territory, near-white masks populated"))
    reg("jpg_grain", build_case("jpg_grain",
        save_jpg("jpg_grain", grain_scene(*JP, rng)),
        "JPEG, heavy grain in the pixels (GrainAmount stays 0)", nef,
        "grain as content: no warning, but alignment/NCC must survive it"))
    reg("jpg_colors", build_case("jpg_colors",
        save_jpg("jpg_colors", add_patches(base_scene(*JP, rng))),
        "JPEG, varied colors: greys / skin / greenery / sky / saturated warm patches", nef,
        "analyze group shares over a known palette"))

    # ---- TIFF (8-bit uncompressed RGB, the project export flavor) ----
    reg("tif_plain", build_case("tif_plain",
        save_tif("tif_plain", add_patches(base_scene(*TP, rng))),
        "TIFF, no XMP, no ICC", nef,
        "TIFF decoding without metadata; the no-Lightroom-settings warning"))
    reg("tif_wb", build_case("tif_wb",
        save_tif("tif_wb", add_patches(base_scene(*TP, rng)), xmp=xmp_packet(XMP_WB)),
        "TIFF, XMP tag 700 with WB + exposure edits", nef,
        "the edit_gain path on TIFF: XMP lives in TIFF tag 700, not a JPEG APP1 segment"))
    reg("tif_icc", build_case("tif_icc",
        save_tif("tif_icc", add_patches(base_scene(*TP, rng)), icc=icc),
        "TIFF, embedded non-sRGB ICC", nef,
        "ICC normalization on TIFF"))
    reg("tif_orient8", build_case("tif_orient8",
        save_tif("tif_orient8", base_scene(*TP, rng), orient=8),
        "TIFF, EXIF Orientation 8 (TIFF tag 274)", nef,
        "orientation read from the TIFF IFD, not a JPEG EXIF segment"))
    reg("tif_vignetted", build_case("tif_vignetted",
        save_tif("tif_vignetted", vignetted_scene(*TP, rng)),
        "TIFF, strong optical vignetting as content", nef,
        "devignette coefficients estimation input"))

    # ------------------------------------------------------------------ self-checks
    m = {r[0]: r[1] for r in rows}
    x = m["jpg_wb"]
    expect(x["xmp"].get("WhiteBalance") == "Custom" and x["xmp"].get("Temperature") == "6500"
           and x["xmp"].get("Tint") == "+12" and x["xmp"].get("Exposure2012") == "+0.50",
           "jpg_wb: WB XMP values did not survive JPEG APP1 round-trip")
    w = np.array(json.load(open(wbmap.PATH)))
    d = wbmap.predict(w, 6500.0, 12.0) - multipliers
    expect(np.allclose(np.exp([d[0], 0.0, d[1]]) * 2 ** 0.5, x["gain"], atol=1e-9),
           "jpg_wb: gain != wbmap prediction")
    expect(x["gain"] != [1.0, 1.0, 1.0] and x["gainNote"], "jpg_wb: expected a non-trivial gain note")
    expect(m["tif_wb"]["gain"] == x["gain"], "tif_wb: TIFF gain differs from JPEG gain")

    x = m["jpg_crop"]
    expect(x["xmp"].get("HasCrop") == "True" and float(x["xmp"]["CropAngle"]) == 2.5
           and float(x["xmp"]["CropLeft"]) == 0.1, "jpg_crop: crop XMP did not round-trip")
    x = m["jpg_masks"]
    expect(x["xmp"]["_masks"] and "MaskGroupBasedCorrections" in x["xmp"]
           and "MaskGroupBasedCorrections_1" in x["xmp"], "jpg_masks: mask keys missing")
    x = m["jpg_vignette_grain"]
    expect(x["check"]["xmpVignetteAmount"] == 25 and x["check"]["xmpGrainAmount"] == 40,
           "jpg_vignette_grain: amounts not parsed")
    expect(any("vignette" in s for s in x["warnings"]) and any("grain" in s for s in x["warnings"]),
           "jpg_vignette_grain: expected vignette+grain warnings")
    for k in ("jpg_plain", "tif_plain"):
        expect(not m[k]["check"]["xmpHasLightroom"] and not m[k]["xmp"]["_masks"]
               and m[k]["gain"] == [1.0, 1.0, 1.0] and m[k]["gainNote"] is None,
               f"{k}: expected empty XMP, unit gain")
        expect(any("no Lightroom settings" in s for s in m[k]["warnings"]),
               f"{k}: expected the no-XMP warning")
    for k, o in (("jpg_orient6", 6), ("jpg_orient8", 8), ("tif_orient8", 8)):
        expect(m[k]["image"]["exifOrientation"] == o, f"{k}: orientation tag lost")
    for k in ("jpg_icc", "tif_icc"):
        expect(m[k]["image"]["icc"]["embedded"] and "sRGB" not in m[k]["image"]["icc"]["profile"],
               f"{k}: ICC missing or misdetected")
        a = np.asarray(Image.open(os.path.join(OUT, m[k]["file"])), dtype=np.float64)
        b = np.asarray(pairs.to_srgb(Image.open(os.path.join(OUT, m[k]["file"]))), dtype=np.float64)
        expect(np.abs(a - b).mean() > 1, f"{k}: ICC normalization did not change the pixels")
    expect(m["jpg_clipped"]["content"]["clippedShare"] > CLIPPED_BAD,
           "jpg_clipped: clipped share below CLIPPED_BAD")
    expect(m["tif_vignetted"]["content"]["clippedShare"] < 0.01, "tif_vignetted: unexpectedly clipped")
    for k, meta in rows:
        expect(max(meta["check"]["targetSize"]) < MIN_TARGET, f"{k}: target unexpectedly large")

    # ------------------------------------------------------------------ reference sidecar checks
    wb = json.load(open(os.path.join(OUT, "wb.json")))
    expect(np.allclose(wb["multipliers"], multipliers, atol=1e-12), "wb.json: multipliers mismatch")
    meta = m["jpg_icc"]
    expect("iccMatrix" in meta and len(meta["iccMatrix"]["m"]) == 9, "jpg_icc: iccMatrix missing")
    expect(meta["ref"]["source"] == "icc-matrix", "jpg_icc: reference grid not ICC-normalized")
    grid = np.fromfile(os.path.join(OUT, meta["ref"]["file"]), dtype="<f4")
    expect(grid.size == len(meta["ref"]["gridW"]) * len(meta["ref"]["gridH"]) * 3,
           "jpg_icc: reference grid size")
    for k, imeta in rows:
        if imeta["image"]["format"] == "JPEG":
            expect("ref" in imeta, f"{k}: browser reference grid missing")

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"\n{len(rows)} cases, {total / 1024:.0f} KiB total in {os.path.relpath(OUT, ROOT)}/")
    expect(total < 1024 * 1024, "fixtures exceed 1 MiB")
    shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
