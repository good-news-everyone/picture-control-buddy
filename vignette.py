"""Vignette correction like NX Studio's, but without NX Studio.

NX lifts the frame edges by 0.3-1.3 stops in the corners. The JPEG embedded in the NEF is
corrected the same way, so the correction is computed from the difference between the NEF
and that JPEG: the lens does not need to be known. Gain is 2^(a r^2 + b r^4) in stops,
r measured from the center to the corner. Results are cached in data/vignette/.

    python3 vignette.py        # computes coefficients for all training frames
"""
from __future__ import annotations

import glob
import json
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image

import color as C
import devpairs
import pairs
import rawdev

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data", "vignette")
SHRINK = 6
KNOTS = np.linspace(-9, 0, 28)      # log2 of linear lightness
MIN_PIXELS = 4000                   # fewer even pixels: the estimate cannot be trusted
LUMA = np.array([.25, .5, .25])     # lightness in camera color
Y709 = np.array([.2126, .7152, .0722])


def radius(h: int, w: int) -> np.ndarray:
    v, u = np.mgrid[:h, :w]
    return np.hypot(u + .5 - w / 2, v + .5 - h / 2) / np.hypot(w / 2, h / 2)


def gain(r: np.ndarray, ab: tuple[float, float]) -> np.ndarray:
    r2 = r * r
    return 2 ** (ab[0] * r2 + ab[1] * r2 * r2)


def correct(lin: np.ndarray, ab: tuple[float, float]) -> np.ndarray:
    return (lin * gain(radius(*lin.shape[:2]), ab)[..., None].astype(lin.dtype))


def fit(x: np.ndarray, y: np.ndarray, r: np.ndarray) -> tuple[float, float]:
    """y = T(x + a r^2 + b r^4) in stops: T is the frame's piecewise-linear curve, a and b shared."""
    a = b = 0.0
    r2 = r * r
    r4 = r2 * r2
    n = np.arange(len(x))
    for _ in range(3):
        u = x + a * r2 + b * r4
        i = np.clip(np.searchsorted(KNOTS, u) - 1, 0, len(KNOTS) - 2)
        f = (u - KNOTS[i]) / (KNOTS[i + 1] - KNOTS[i])
        A = np.zeros((len(u), len(KNOTS)))
        A[n, i], A[n, i + 1] = 1 - f, f
        w = np.linalg.solve(A.T @ A + 1e-3 * np.eye(len(KNOTS)), A.T @ y)
        slope = np.gradient(w, KNOTS)[i]
        D = np.stack([slope * r2, slope * r4], 1)
        d = np.linalg.solve(D.T @ D + 1e-6 * np.eye(2), D.T @ (y - A @ w))
        a, b = a + d[0], b + d[1]
    return float(a), float(b)


def estimate(nef: str, lin: np.ndarray) -> tuple[float, float]:
    """lin: development without rotation and field crops. No embedded JPEG - no correction."""
    try:
        emb = pairs.embedded_jpeg(nef)
    except ValueError:
        return 0.0, 0.0
    small = devpairs.shrink(lin, SHRINK)
    jpeg = emb.resize((small.shape[1], small.shape[0]), Image.BOX)
    _, s, k = devpairs.fit_radial(small, jpeg)
    small = devpairs.radial(small.astype(np.float32), s, k).astype(np.float64)
    rgb = np.asarray(jpeg.convert("RGB"), dtype=np.float64) / 255
    y = C.srgb_to_linear(rgb.reshape(-1, 3)) @ Y709
    x = small.reshape(-1, 3) @ LUMA
    gy, gx = np.gradient(rgb.mean(-1))
    keep = ((np.hypot(gx, gy) < .03).ravel() & (y > .004) & (y < .85)
            & (x > 2e-3) & (small.reshape(-1, 3).max(1) < .95))
    if keep.sum() < MIN_PIXELS:
        return 0.0, 0.0
    return fit(np.log2(x[keep]), np.log2(y[keep]), radius(*rgb.shape[:2]).ravel()[keep])


def coefficients(nef: str, lin: np.ndarray | None = None) -> tuple[float, float]:
    """The frame's a and b from the cache. lin saves a development if it is already available."""
    key = f"{os.path.basename(nef)}-{os.path.getsize(nef)}.json"
    path = os.path.join(CACHE, key)
    if os.path.exists(path):
        return tuple(json.load(open(path)))
    if lin is None:
        lin = rawdev.develop(nef)[devpairs.MY:-devpairs.MY, devpairs.MX:-devpairs.MX]
    ab = estimate(nef, lin)
    os.makedirs(CACHE, exist_ok=True)
    tmp = f"{path}.{os.getpid()}"
    json.dump(ab, open(tmp, "w"))
    os.replace(tmp, path)
    return ab


def main():
    nefs = [p for name in devpairs.SETS for p in sorted(glob.glob(os.path.join(HERE, "renders", name, "*.NEF")))]
    with ProcessPoolExecutor(6) as ex:
        for nef, (a, b) in zip(nefs, ex.map(coefficients, nefs)):
            print(f"{os.path.basename(nef)} a={a:+.2f} b={b:+.2f} corner {a + b:+.2f}", flush=True)


if __name__ == "__main__":
    main()
