"""Pairs "linear NEF development -> NX render with neutral" for training the development model.

The NX render is rotated and slightly geometry-corrected, so the pairs are aligned.
Result: data/dev/<frame>.npz with shrunk x (linear RGB) and y (sRGB).

    python3 devpairs.py
"""
from __future__ import annotations

import glob
import os

import numpy as np
from PIL import Image

import pairs
import rawdev
import vignette

HERE = os.path.dirname(os.path.abspath(__file__))
SETS = ("dev", "dev_africa")   # renders/<set> folders with NEF and neutral/, pairs in data/<set>
LONG = 768
BOX = 3
MX, MY = 4, 2             # margins of the half-size development around a 3024x2016 frame
Image.MAX_IMAGE_PIXELS = None


def to_view(lin: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(lin, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8))


def crop_float(lin: np.ndarray, x: dict, sign: int) -> np.ndarray:
    """The crop from XMP: each channel separately, because PIL cannot do three float channels."""
    return np.stack([np.asarray(pairs.apply_crop(Image.fromarray(np.ascontiguousarray(lin[..., c])), x, sign))
                     for c in range(3)], -1)


def oriented(candidates: list[np.ndarray], target: Image.Image) -> np.ndarray:
    """The frame from the crop variants with rotation that matches the target in shape and edges."""
    k = 192 / max(target.size)
    size = (round(target.size[0] * k), round(target.size[1] * k))
    gt = pairs.grad(np.asarray(target.resize(size, Image.BILINEAR).convert("L"), dtype=np.float32))
    aspect = target.size[0] / target.size[1]
    best = None
    for lin in candidates:
        for r in range(4):
            a = np.rot90(lin, r)
            if abs(a.shape[1] / a.shape[0] / aspect - 1) > 0.06:
                continue
            g = pairs.grad(np.asarray(to_view(a).resize(size, Image.BILINEAR).convert("L"), dtype=np.float32))
            v = pairs.ncc(g, gt)
            if best is None or v > best[0]:
                best = (v, a)
    if best is None:
        raise ValueError("target shape does not match the frame: cropping without XMP is not supported")
    return best[1]


def radial(a: np.ndarray, s: float, k: float) -> np.ndarray:
    """Scale and distortion around the center: bilinear sampling, same size."""
    h, w = a.shape[:2]
    y, x = np.mgrid[:h, :w].astype(np.float32)
    x, y = x - w / 2, y - h / 2
    d = (1 + k * (x * x + y * y) / (w * w / 4 + h * h / 4)) / s
    u = np.clip(x * d + w / 2, 0, w - 1.001)
    v = np.clip(y * d + h / 2, 0, h - 1.001)
    i, j = u.astype(int), v.astype(int)
    f, g = (u - i)[..., None], (v - j)[..., None]
    return (a[j, i] * (1 - f) * (1 - g) + a[j, i + 1] * f * (1 - g)
            + a[j + 1, i] * (1 - f) * g + a[j + 1, i + 1] * f * g)


def fit_radial(a: np.ndarray, target: Image.Image) -> tuple[float, float, float]:
    """Fits scale and distortion: lens correction in the render is not reducible to scale."""
    gt = pairs.grad(np.asarray(target.convert("L"), dtype=np.float32))
    v = np.clip(a, 0, 1) ** (1 / 2.2)

    def score(s, k):
        g = pairs.grad((radial(v, s, k) @ np.array([.3, .6, .1])).astype(np.float32) * 255)
        return pairs.ncc(g, gt)

    best = max(((score(s, k), s, k) for s in np.arange(.98, 1.1, .01) for k in np.arange(-.08, .081, .02)))
    for step in (.004, .002):
        _, s0, k0 = best
        best = max([best] + [(score(s0 + i * step, k0 + j * step * 2), s0 + i * step, k0 + j * step * 2)
                             for i in (-1, 0, 1) for j in (-1, 0, 1)])
    return best


def lens_corrected(lin: np.ndarray, nef: str) -> np.ndarray:
    """The crop is given after lens correction, and after the crop the distortion center is no longer centered.

    The embedded JPEG is corrected by the camera and uncropped, so the distortion is taken from it.
    """
    try:
        emb = pairs.embedded_jpeg(nef)
    except ValueError:          # a DNG may have no preview: alignment will fit the distortion
        return lin
    size = (384, round(384 * lin.shape[0] / lin.shape[1]))
    small = np.stack([np.asarray(Image.fromarray(lin[..., c]).resize(size, Image.BOX)) for c in range(3)], -1)
    _, s, k = fit_radial(small, emb.resize(size, Image.BILINEAR))
    return radial(lin, s, k).astype(np.float32)


def warp_float(a: np.ndarray, size, s, dx, dy) -> np.ndarray:
    return np.stack([np.asarray(pairs.warp(Image.fromarray(a[..., c]), size, s, dx, dy)) for c in range(3)], -1)


def shrink(a: np.ndarray, k: int) -> np.ndarray:
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:h, :w].reshape(h // k, k, w // k, k, -1).mean((1, 3))


def matched(a: np.ndarray, t: Image.Image) -> dict:
    """Brings the frame to the target geometry: scale, distortion, shift, shrinking."""
    k = LONG / max(t.size)
    size = (round(t.size[0] * k), round(t.size[1] * k))
    t_s = t.resize(size, Image.LANCZOS)
    small = (size[0] // 2, size[1] // 2)
    a_s = np.stack([np.asarray(Image.fromarray(np.ascontiguousarray(a[..., c])).resize(size, Image.BOX)) for c in range(3)], -1)
    half = np.stack([np.asarray(Image.fromarray(a_s[..., c]).resize(small, Image.BOX)) for c in range(3)], -1)
    _, s, kr = fit_radial(half, t_s.resize(small, Image.BILINEAR))
    a_s = radial(a_s, s, kr)
    v, s2, dx, dy = pairs.align(to_view(a_s).resize(small, Image.BILINEAR), t_s.resize(small, Image.BILINEAR))
    a_w = warp_float(a_s, size, s2, dx * 2, dy * 2)
    y = np.asarray(t_s, dtype=np.float32) / 255
    return {"x": shrink(a_w, BOX), "y": shrink(y, BOX), "ncc": v, "s": s * s2, "k": kr}


def build(nef: str, tif: str, devignette: bool = False) -> dict:
    """devignette removes the NEF vignetting before the crop: the radius is computed over the whole frame."""
    raw = Image.open(tif)
    x = pairs.xmp_values(raw)
    t = pairs.to_srgb(raw)
    lin = rawdev.develop(nef)[MY:-MY, MX:-MX]
    if devignette:
        lin = vignette.correct(lin, vignette.coefficients(nef, lin))
    if x.get("HasCrop") == "True":
        lin = lens_corrected(lin, nef)
    return matched(oriented([crop_float(lin, x, s) for s in (1, -1)], t), t)


def build_render(render: str, tif: str) -> dict:
    """The same for an NX render: it is already rotated, and the XMP crop is in sensor-frame coordinates."""
    raw = Image.open(tif)
    x = pairs.xmp_values(raw)
    t = pairs.to_srgb(raw)
    a = np.asarray(pairs.to_srgb(Image.open(render)), dtype=np.float32) / 255
    frames = [np.rot90(a, r) for r in range(4) if np.rot90(a, r).shape[1] > np.rot90(a, r).shape[0]]
    return matched(oriented([crop_float(f, x, s) for f in frames for s in (1, -1)], t), t)


def main():
    for name in SETS:
        src, dst = os.path.join(HERE, "renders", name), os.path.join(HERE, "data", name)
        os.makedirs(dst, exist_ok=True)
        for nef in sorted(glob.glob(os.path.join(src, "*.NEF"))):
            stem = os.path.basename(nef)[:-4]
            out = os.path.join(dst, stem + ".npz")
            if os.path.exists(out):
                continue
            r = build(nef, os.path.join(src, "neutral", stem + ".TIF"))
            np.savez_compressed(out, **r)
            print(f"{stem} ncc={r['ncc']:.3f} s={r['s']:.3f} k={r['k']:+.3f}", flush=True)


if __name__ == "__main__":
    main()
