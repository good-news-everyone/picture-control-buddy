"""Color pairs from two different shots of one scene: alignment and homogeneous blocks.

The shots may come from different cameras, so frames are aligned by edges, not color:
first scale, rotation and shift, then a homography from local shifts. The frame is then
divided into blocks, and only even areas go into the comparison: at object boundaries the
color mix depends on the residual shift. The chart in the frame also yields blocks.

    python3 scene.py a.NEF b.jpg      alignment check
"""
from __future__ import annotations

import sys

import numpy as np
from PIL import Image, ImageOps

import color as C
import devpairs
import pairs
import rawdev

LONG = 1024
COARSE = 256
TILES = (10, 7)
BLOCK = 14           # block side in pixels of the LONG frame
SHIFT = 4            # shift for the block stability check
MAX_SPREAD = 0.025
PER_BIN = 12         # blocks per color cell
MIN_NCC = 0.3
Image.MAX_IMAGE_PIXELS = None


def fit_long(im: Image.Image, side: int) -> Image.Image:
    k = side / max(im.size)
    return im.resize((round(im.size[0] * k), round(im.size[1] * k)), Image.BOX)


def load_target(path: str) -> np.ndarray:
    im = pairs.to_srgb(ImageOps.exif_transpose(Image.open(path)))
    return np.asarray(fit_long(im, LONG), dtype=np.float32) / 255


def load_base(nef: str) -> np.ndarray:
    """Linear development, shrunk to the working size, in the sensor frame."""
    lin = rawdev.develop(nef)[devpairs.MY:-devpairs.MY, devpairs.MX:-devpairs.MX]
    k = max(1, round(max(lin.shape) / LONG))
    return devpairs.shrink(lin, k)


def edges(rgb: np.ndarray, gamma: float = 1.0) -> np.ndarray:
    g = (np.clip(rgb, 0, 1) ** gamma) @ np.array([.3, .6, .1])
    return pairs.grad(g.astype(np.float32))


def resample(a: np.ndarray, H: np.ndarray, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Samples a by the matrix H (result coordinates -> coordinates of a) and the inside-frame mask."""
    h, w = shape
    y, x = np.mgrid[:h, :w].astype(np.float64)
    d = H[2, 0] * x + H[2, 1] * y + H[2, 2]
    u = (H[0, 0] * x + H[0, 1] * y + H[0, 2]) / d
    v = (H[1, 0] * x + H[1, 1] * y + H[1, 2]) / d
    inside = (u >= 0) & (v >= 0) & (u < a.shape[1] - 1) & (v < a.shape[0] - 1)
    u = np.clip(u, 0, a.shape[1] - 1.001)
    v = np.clip(v, 0, a.shape[0] - 1.001)
    i, j = u.astype(int), v.astype(int)
    f, g = u - i, v - j
    if a.ndim == 3:
        f, g = f[..., None], g[..., None]
    out = a[j, i] * (1 - f) * (1 - g) + a[j, i + 1] * f * (1 - g) + a[j + 1, i] * (1 - f) * g + a[j + 1, i + 1] * f * g
    return out, inside


def similarity(s: float, deg: float, dx: float, dy: float, shape_a, shape_t) -> np.ndarray:
    """Target coordinates -> coordinates of a: rotation and scale around the centers plus shift."""
    c, n = np.cos(np.radians(deg)) / s, np.sin(np.radians(deg)) / s
    A = np.array([[c, -n, 0], [n, c, 0], [0, 0, 1.0]])
    to_t = np.array([[1, 0, -shape_t[1] / 2 - dx], [0, 1, -shape_t[0] / 2 - dy], [0, 0, 1.0]])
    to_a = np.array([[1, 0, shape_a[1] / 2], [0, 1, shape_a[0] / 2], [0, 0, 1.0]])
    return to_a @ A @ to_t


def peak(a: np.ndarray, b: np.ndarray) -> tuple[float, int, int]:
    """The best cyclic shift of b relative to a and the normalized correlation."""
    c = np.fft.irfft2(np.fft.rfft2(a) * np.conj(np.fft.rfft2(b)), s=a.shape)
    j, i = np.unravel_index(np.argmax(c), c.shape)
    v = c[j, i] / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9)
    return float(v), int(j - a.shape[0] if j > a.shape[0] // 2 else j), int(i - a.shape[1] if i > a.shape[1] // 2 else i)


def coarse(base: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, float]:
    """Rotation by a multiple of 90 degrees, scale, small tilt and shift by edge correlation."""
    k = COARSE / LONG
    ts = (round(target.shape[0] * k), round(target.shape[1] * k))
    et = edges(np.asarray(Image.fromarray((target * 255).astype(np.uint8)).resize(ts[::-1], Image.BOX), dtype=np.float32) / 255)
    pad = (2 * COARSE, 2 * COARSE)
    T = np.zeros(pad, dtype=np.float32)
    T[:ts[0], :ts[1]] = et
    best = (-1.0, None)
    small = fit_long(devpairs.to_view(base), COARSE)
    for quarter in range(4):
        b0 = np.rot90(np.asarray(small, dtype=np.float32) / 255, quarter)
        for s in np.exp(np.linspace(np.log(.6), np.log(1.6), 21)):
            for deg in (-4, -2, 0, 2, 4):
                H = similarity(s, deg, 0, 0, b0.shape, ts)
                w, inside = resample(b0, H, ts)
                e = edges(w) * inside
                E = np.zeros(pad, dtype=np.float32)
                E[:ts[0], :ts[1]] = e
                v, dy, dx = peak(T, E)
                if v > best[0]:
                    best = (v, (quarter, s, deg, dx, dy))
    v, (quarter, s, deg, dx, dy) = best
    return np.array([quarter, s, deg, dx / k, dy / k]), v


def homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """The src -> dst matrix from point pairs: a linear system with normalization."""
    n = len(src)
    A = np.zeros((2 * n, 8))
    b = dst.reshape(-1)
    A[0::2, 0:2], A[0::2, 2] = src, 1
    A[1::2, 3:5], A[1::2, 5] = src, 1
    A[0::2, 6:8] = -src * dst[:, :1]
    A[1::2, 6:8] = -src * dst[:, 1:]
    return np.r_[np.linalg.lstsq(A, b, rcond=None)[0], 1].reshape(3, 3)


def refine(view: np.ndarray, target: np.ndarray, H: np.ndarray) -> np.ndarray:
    """Refines H from the local shifts of tiles, discarding the mismatched ones."""
    h, w = target.shape[:2]
    et = edges(target)
    for _ in range(3):
        warped, inside = resample(view, H, (h, w))
        ew = edges(warped) * inside
        src, dst = [], []
        th, tw = h // TILES[1], w // TILES[0]
        for r in range(TILES[1]):
            for c in range(TILES[0]):
                sl = np.s_[r * th:(r + 1) * th, c * tw:(c + 1) * tw]
                if inside[sl].mean() < .9:
                    continue
                v, dy, dx = peak(et[sl] - et[sl].mean(), ew[sl] - ew[sl].mean())
                if v < MIN_NCC or abs(dx) > tw / 3 or abs(dy) > th / 3:
                    continue
                y0, x0 = (r + .5) * th, (c + .5) * tw
                # at the target point (x0, y0) one sees what sits at (x0 - dx, y0 - dy) in the render
                src.append((x0, y0))
                p = H @ np.array([x0 - dx, y0 - dy, 1.0])
                dst.append(p[:2] / p[2])
        if len(src) < 8:
            return H
        src, dst = np.array(src, float), np.array(dst, float)
        keep = np.ones(len(src), bool)
        for _ in range(3):
            M = homography(src[keep], dst[keep])
            q = np.c_[src, np.ones(len(src))] @ M.T
            err = np.hypot(*(q[:, :2] / q[:, 2:] - dst).T)
            keep = err <= max(1.5, np.median(err) * 2.5)
            if keep.sum() < 8:
                return H
        H = M
    return H


def align(base: np.ndarray, target: np.ndarray) -> dict:
    """The sensor frame is brought to the target geometry."""
    p, v0 = coarse(base, target)
    quarter, s, deg, dx, dy = p
    b = np.rot90(base, int(quarter))
    view = np.clip(b, 0, 1) ** (1 / 2.2)
    H = similarity(s, deg, dx, dy, b.shape[:2], target.shape[:2]) * 1.0
    H = refine(view, target, H)
    warped, inside = resample(b, H, target.shape[:2])
    n = pairs.ncc(edges(np.clip(warped, 0, 1) ** (1 / 2.2)) * inside, edges(target) * inside)
    return {"x": warped, "inside": inside, "ncc": n, "coarse": v0, "scale": s, "turn": int(quarter) * 90}


def blocks(x: np.ndarray, t: np.ndarray, inside: np.ndarray, dev) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Mean colors of the stable blocks: neutral, target and the stable mask.

    A block is good if its mean color barely changes under a small shift. This filters out
    object boundaries, while grass and foliage stay: their texture is averaged out.
    """
    b = dev(x.reshape(-1, 3).astype(np.float64)).reshape(x.shape)
    h, w = (t.shape[0] // BLOCK) * BLOCK, (t.shape[1] // BLOCK) * BLOCK

    def means(a):
        return a[:h, :w].reshape(h // BLOCK, BLOCK, w // BLOCK, BLOCK, -1).mean((1, 3)).reshape(-1, a.shape[-1] if a.ndim == 3 else 1)

    def spread(a):
        m = means(a)
        return np.max([np.abs(means(np.roll(a, s, axis)) - m).max(1) for s in (-SHIFT, SHIFT) for axis in (0, 1)], axis=0)

    mb, mt = means(b), means(t)
    stable = (spread(b) < MAX_SPREAD) & (spread(t) < MAX_SPREAD) & (means(inside.astype(np.float32))[:, 0] > .98)
    ok = stable & (mt.max(1) < .98) & (mt.min(1) > .01) & (mb.max(1) < .98)
    return balanced(mb[ok], mt[ok]) + (ok,)


def balanced(b: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Limits the number of blocks of one color, otherwise the sky drowns out everything else."""
    lab = C.srgb_to_lab(b)
    key = np.floor(lab / np.array([8.0, 10.0, 10.0])).astype(int)
    _, inverse = np.unique(key, axis=0, return_inverse=True)
    inverse = inverse.ravel()
    keep = np.zeros(len(b), bool)
    rng = np.random.default_rng(0)
    for k in range(inverse.max() + 1):
        i = np.flatnonzero(inverse == k)
        keep[rng.permutation(i)[:PER_BIN]] = True
    return b[keep], t[keep]


def trimmed(lab_a: np.ndarray, lab_b: np.ndarray, keep: float = 0.85) -> np.ndarray:
    d = C.de2000(lab_a, lab_b)
    return d <= np.quantile(d, keep)


if __name__ == "__main__":
    t = load_target(sys.argv[2])
    a = align(load_base(sys.argv[1]), t)
    print({k: (round(float(v), 3) if np.isscalar(v) else None) for k, v in a.items() if k not in ("x", "inside")})
