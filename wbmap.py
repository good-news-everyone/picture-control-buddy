"""Mapping between Lightroom Temperature/Tint and the camera white balance coefficients.

An export's XMP carries the Lightroom values, while the NEF carries the camera coefficients.
Frames with As Shot WB show the correspondence, so a custom Lightroom WB can be translated
into coefficients and taken out of the fitting variables.

    python3 wbmap.py
"""
from __future__ import annotations

import glob
import json
import os
import struct

import numpy as np
from PIL import Image

import pairs

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "data", "wbmap.json")
AS_SHOT_NEUTRAL = 0xC628
Image.MAX_IMAGE_PIXELS = None


def tiff_ifd(b: bytes, offset: int, e: str, base: int = 0) -> dict:
    """IFD entries: tag -> (type, value offset)."""
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8}
    out = {}
    for i in range(struct.unpack_from(e + "H", b, offset)[0]):
        p = offset + 2 + 12 * i
        tag, kind, count = struct.unpack_from(e + "HHI", b, p)
        small = sizes.get(kind, 1) * count <= 4
        out[tag] = (kind, p + 8 if small else base + struct.unpack_from(e + "I", b, p + 8)[0])
    return out


def multipliers(raw: str) -> np.ndarray:
    """Camera WB coefficients: log(R/G) and log(B/G).

    In DNG this is AsShotNeutral, in NEF the WB_RBLevels tag from the MakerNote.
    """
    with open(raw, "rb") as f:
        b = f.read()
    e = "<" if b[:2] == b"II" else ">"
    ifd0 = tiff_ifd(b, struct.unpack_from(e + "I", b, 4)[0], e)
    if AS_SHOT_NEUTRAL in ifd0:
        v = struct.unpack_from(e + "6I", b, ifd0[AS_SHOT_NEUTRAL][1])
        r, g, bl = v[0] / v[1], v[2] / v[3], v[4] / v[5]
        return np.log([g / r, g / bl])
    exif = tiff_ifd(b, struct.unpack_from(e + "I", b, ifd0[0x8769][1])[0], e)
    base = exif[0x927C][1] + 10
    e2 = "<" if b[base:base + 2] == b"II" else ">"
    maker = tiff_ifd(b, base + struct.unpack_from(e2 + "I", b, base + 4)[0], e2, base)
    v = struct.unpack_from(e2 + "8I", b, maker[0x0C][1])
    return np.log([v[0] / v[1] / (v[4] / v[5]), v[2] / v[3] / (v[4] / v[5])])


def features(temp: float, tint: float) -> np.ndarray:
    m = 1e6 / temp
    return np.array([1, m, m * m, tint, tint * m])


def predict(w: np.ndarray, temp: float, tint: float) -> np.ndarray:
    return features(temp, tint) @ w


def main():
    rows = []
    for target, nef in samples():
        x = pairs.xmp_values(Image.open(target))
        if x.get("WhiteBalance") != "As Shot" or "Temperature" not in x:
            continue
        rows.append((float(x["Temperature"]), float(x["Tint"]), *multipliers(nef), os.path.basename(nef)))
    F = np.array([features(r[0], r[1]) for r in rows])
    Y = np.array([r[2:4] for r in rows])
    err = []
    for i in range(len(rows)):
        keep = np.arange(len(rows)) != i
        w = np.linalg.lstsq(F[keep], Y[keep], rcond=None)[0]
        err.append(F[i] @ w - Y[i])
    err = np.array(err)
    print(f"frames {len(rows)}; T {min(r[0] for r in rows):.0f}-{max(r[0] for r in rows):.0f}, "
          f"tint {min(r[1] for r in rows):+.0f}..{max(r[1] for r in rows):+.0f}")
    print(f"held-out error, log: R/G {np.abs(err[:, 0]).mean():.4f}, B/G {np.abs(err[:, 1]).mean():.4f}; "
          f"max {np.abs(err).max():.4f}")
    w = np.linalg.lstsq(F, Y, rcond=None)[0]
    json.dump(w.tolist(), open(PATH, "w"))


def samples():
    home = os.path.expanduser("~/Pictures/2026/georgia")
    for f in sorted(glob.glob(home + "/done/*.jpg")):
        s = os.path.basename(f)[:-4]
        nef = next((p for d in (home, home + "/27 trip") for p in [f"{d}/{s}.NEF"] if os.path.exists(p)), None)
        if nef:
            yield f, nef
    for d in ("lightroom", "done"):
        for f in sorted(glob.glob(os.path.join(HERE, "renders/check", d, "*.tif"))):
            yield f, os.path.join(HERE, "renders/check", os.path.basename(f)[:-4] + ".NEF")


if __name__ == "__main__":
    main()
