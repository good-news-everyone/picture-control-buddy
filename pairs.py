"""Builds "camera render from NEF -> Lightroom export" pairs in a common geometry.

The crop and angle come from the export's XMP, the remainder (Lightroom lens correction)
is recovered by searching over shift and scale. Result: data/pairs/<frame>.npz.

    python3 pairs.py ~/Pictures/2026/georgia/done ~/Pictures/2026/georgia "~/Pictures/2026/georgia/27 trip"
"""
from __future__ import annotations

import io
import json
import os
import re
import sys

import numpy as np
from PIL import Image, ImageCms

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "pairs")
LONG = 768          # long side of the working size
Image.MAX_IMAGE_PIXELS = None


def embedded_jpeg(nef: str) -> Image.Image:
    """The largest JPEG inside the NEF."""
    b = open(nef, "rb").read()
    best = None
    for m in re.finditer(b"\xff\xd8\xff", b):
        try:
            im = Image.open(io.BytesIO(b[m.start():]))
            im.size
        except Exception:
            continue
        if best is None or im.size[0] > best.size[0]:
            best = im
    if best is None:
        raise ValueError("no JPEG in " + nef)
    best.draft("RGB", (best.size[0] // 2, best.size[1] // 2))
    best.load()
    return best.convert("RGB")


def to_srgb(im: Image.Image) -> Image.Image:
    icc = im.info.get("icc_profile")
    if not icc:
        return im.convert("RGB")
    src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
    if "sRGB" in (ImageCms.getProfileDescription(src) or ""):
        return im.convert("RGB")
    return ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"), outputMode="RGB")


def xmp_values(im: Image.Image) -> dict:
    x = im.info.get("xmp") or b""
    t = x.decode("utf-8", "replace") if isinstance(x, bytes) else x
    d = dict(re.findall(r'(?:crs|tiff):(\w+)="([^"]*)"', t))
    d["_masks"] = "MaskGroupBasedCorrections" in t
    return d


def apply_crop(im: Image.Image, x: dict, sign: int = 1) -> Image.Image:
    """The Lightroom crop is given in unrotated frame coordinates, the angle around its center."""
    W, H = im.size
    if x.get("HasCrop") != "True":
        return im
    l, t = float(x.get("CropLeft", 0)), float(x.get("CropTop", 0))
    r, b = float(x.get("CropRight", 1)), float(x.get("CropBottom", 1))
    ang = float(x.get("CropAngle", 0)) * sign
    cx, cy = (l + r) / 2 * W, (t + b) / 2 * H
    # when tilted, the XMP gives the diagonal corners of the rotated frame, not its sides
    a = np.radians(ang)
    dx, dy = (r - l) * W, (b - t) * H
    w = abs(dx * np.cos(a) + dy * np.sin(a))
    h = abs(dy * np.cos(a) - dx * np.sin(a))
    if abs(ang) > 1e-3:
        im = im.rotate(ang, resample=Image.BICUBIC, center=(cx, cy))
    return im.crop((int(cx - w / 2), int(cy - h / 2), int(cx + w / 2), int(cy + h / 2)))


def orient_candidates(portrait: bool):
    return (Image.ROTATE_90, Image.ROTATE_270) if portrait else (None, Image.ROTATE_180)


def pick_geometry(raw: Image.Image, target: Image.Image, x: dict) -> Image.Image:
    """The export's XMP has no orientation: try rotations and angle signs by edge correlation."""
    k = 192 / max(target.size)
    size = (round(target.size[0] * k), round(target.size[1] * k))
    gt = grad(np.asarray(target.resize(size, Image.BILINEAR).convert("L"), dtype=np.float32))
    best, best_v = None, -2.0
    for tr in orient_candidates(target.size[1] > target.size[0]):
        for sign in (1, -1):
            im = apply_crop(raw, x, sign)
            if tr is not None:
                im = im.transpose(tr)
            v = ncc(grad(np.asarray(im.resize(size, Image.BILINEAR).convert("L"), dtype=np.float32)), gt)
            if v > best_v:
                best, best_v = im, v
    return best


def grad(g: np.ndarray) -> np.ndarray:
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1] = g[2:] - g[:-2]
    m = np.hypot(gx, gy)
    return m - m.mean()


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))


def warp(im: Image.Image, size, s: float, dx: float, dy: float) -> Image.Image:
    """Scale s around the center and shift (dx, dy) in result pixels."""
    W, H = size
    a = 1 / s
    c = W / 2 - a * (W / 2 + dx)
    f = H / 2 - a * (H / 2 + dy)
    return im.transform(size, Image.AFFINE, (a, 0, c, 0, a, f), resample=Image.BILINEAR)


def align(src: Image.Image, dst: Image.Image):
    """Fits the scale and shift of src to dst by edge correlation."""
    size = dst.size
    gd = grad(np.asarray(dst.convert("L"), dtype=np.float32))
    best = (-2.0, 1.0, 0.0, 0.0)
    span = max(size) * 0.03
    for s in np.arange(0.97, 1.0301, 0.005):
        for dx in np.linspace(-span, span, 9):
            for dy in np.linspace(-span, span, 9):
                g = grad(np.asarray(warp(src, size, s, dx, dy).convert("L"), dtype=np.float32))
                v = ncc(g, gd)
                if v > best[0]:
                    best = (v, s, dx, dy)
    _, s0, x0, y0 = best
    step = span / 4
    for _ in range(3):
        step /= 2
        for s in (s0 - 0.002, s0, s0 + 0.002):
            for dx in (x0 - step, x0, x0 + step):
                for dy in (y0 - step, y0, y0 + step):
                    g = grad(np.asarray(warp(src, size, s, dx, dy).convert("L"), dtype=np.float32))
                    v = ncc(g, gd)
                    if v > best[0]:
                        best = (v, s, dx, dy)
        _, s0, x0, y0 = best
    return best


def build(jpg: str, nef: str) -> dict:
    t_im = Image.open(jpg)
    x = xmp_values(t_im)
    t_im = to_srgb(t_im)
    a_im = pick_geometry(embedded_jpeg(nef), t_im, x)
    k = LONG / max(t_im.size)
    size = (round(t_im.size[0] * k), round(t_im.size[1] * k))
    t_s = t_im.resize(size, Image.LANCZOS)
    a_s = a_im.resize(size, Image.LANCZOS)
    small = (size[0] // 2, size[1] // 2)
    v, s, dx, dy = align(a_s.resize(small, Image.BILINEAR), t_s.resize(small, Image.BILINEAR))
    a_w = warp(a_s, size, s, dx * 2, dy * 2)
    return {"A": np.asarray(a_w), "T": np.asarray(t_s), "ncc": v, "scale": s,
            "dx": dx * 2, "dy": dy * 2, "masks": x["_masks"], "xmp": x}


def main(argv):
    done, *nef_dirs = [os.path.expanduser(p) for p in argv]
    os.makedirs(OUT, exist_ok=True)
    rows = []
    for name in sorted(os.listdir(done)):
        if not name.lower().endswith(".jpg"):
            continue
        stem = name[:-4]
        out = os.path.join(OUT, stem + ".npz")
        nef = next((p for d in nef_dirs for p in [os.path.join(d, stem + ".NEF")] if os.path.exists(p)), None)
        if nef is None:
            print("no NEF:", stem)
            continue
        if not os.path.exists(out):
            try:
                r = build(os.path.join(done, name), nef)
            except Exception as e:
                print("error", stem, repr(e))
                continue
            np.savez_compressed(out, A=r["A"], T=r["T"], ncc=r["ncc"], masks=r["masks"],
                                xmp=json.dumps(r["xmp"]))
            print(f"{stem} ncc={r['ncc']:.3f} s={r['scale']:.3f} dx={r['dx']:+.1f} dy={r['dy']:+.1f}"
                  f" masks={r['masks']}", flush=True)
        rows.append(stem)
    print("done:", len(rows))


if __name__ == "__main__":
    main(sys.argv[1:])
