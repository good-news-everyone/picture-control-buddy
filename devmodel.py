"""Trains NEF development -> Nikon neutral: matrix, shared curve and a residual 3D LUT.

Validation by frame blocks: the frames of a block do not take part in training.

    python3 devmodel.py            compare variants
    python3 devmodel.py --render   development for render.py: data/devmodel_render.npz
    python3 devmodel.py --density  training density by color: data/devmodel_density.npy
"""
from __future__ import annotations

import glob
import os
import sys

import numpy as np

import ceiling
import color as C
import devpairs
import vignette

HERE = os.path.dirname(os.path.abspath(__file__))
KNOTS = np.linspace(-11, 0.5, 40)
PER_FRAME = 12000
RENDER = os.path.join(HERE, "data", "devmodel_render.npz")
RENDER_LUT = 25
DENSITY = os.path.join(HERE, "data", "devmodel_density.npy")
DENSITY_N = 17
# Share of training pixels in a color cell (after matrix and curve). Where it is below TRUSTED,
# development errs more: on 11 frames of the Lightroom preset vs NX neutral, dE 3.9 at < 1e-6,
# 2.9 at < 1e-5, 1.4-1.7 at >= 3e-5 (saturated orange vest 7155: C +11.7).
TRUSTED = 3e-5
WARM_HUE = (330, 70)     # magenta, red, orange in Lab
WARM_CHROMA = 12
WARM_CAP = 1000          # pixels per cell: warm colors are rare in the frames, the LUT pulls them to identity


def hat(u: np.ndarray) -> np.ndarray:
    return ceiling.hat(np.clip(u, KNOTS[0], KNOTS[-1]), KNOTS)


class Dev:
    def __init__(self, n=17, ridge=2.0):
        self.lut = ceiling.Lut(n=n, ridge=ridge) if n else None

    def base(self, x: np.ndarray) -> np.ndarray:
        z = np.clip(x @ self.M.T, 2 ** -11, None)
        return np.clip(np.interp(np.log2(z), KNOTS, self.w), 0, 1)

    def fit(self, x: np.ndarray, y: np.ndarray):
        self.M = np.eye(3)
        D2 = np.diff(np.eye(len(KNOTS)), 2, axis=0)
        grid = np.linspace(KNOTS[0], KNOTS[-1], 4000)
        for _ in range(6):
            z = np.clip(x @ self.M.T, 2 ** -11, None)
            B = hat(np.log2(z).ravel())
            self.w = np.linalg.solve(B.T @ B / len(B) + 0.02 * D2.T @ D2 + 1e-6 * np.eye(len(KNOTS)),
                                     B.T @ y.ravel() / len(B))
            val = np.maximum.accumulate(np.interp(grid, KNOTS, self.w)) + np.arange(4000) * 1e-8
            want = 2 ** np.interp(y, val, grid)
            good = (y.max(1) < .97) & (y.min(1) > .03)
            self.M = np.linalg.lstsq(x[good], want[good], rcond=None)[0].T
        if self.lut:
            self.lut.fit(self.base(x), y)

    def __call__(self, x: np.ndarray) -> np.ndarray:
        b = self.base(x)
        return np.clip(self.lut(b), 0, 1) if self.lut else b

    def trust(self, x: np.ndarray, density: np.ndarray | None) -> np.ndarray:
        """Trust in the development of a pixel, 0..1, from the training density in its color cell."""
        if density is None:
            return np.ones(len(x))
        return np.clip(density[density_cell(self.base(x))] / TRUSTED, 0, 1)

    def save(self, path: str):
        np.savez(path, M=self.M, w=self.w, d=self.lut.d, n=self.lut.n)

    @classmethod
    def load(cls, path: str) -> "Dev":
        z = np.load(path)
        m = cls(int(z["n"]))
        m.M, m.w, m.lut.d = z["M"], z["w"], z["d"]
        return m


def density_cell(b: np.ndarray) -> np.ndarray:
    u = np.clip(np.round(np.clip(b, 0, 1) * (DENSITY_N - 1)).astype(int), 0, DENSITY_N - 1)
    return (u[:, 0] * DENSITY_N + u[:, 1]) * DENSITY_N + u[:, 2]


def density(dev: Dev, fr: list[dict]) -> np.ndarray:
    """Mean over frames of the pixel share in each color cell."""
    d = np.zeros(DENSITY_N ** 3)
    for f in fr:
        d += np.bincount(density_cell(dev.base(f["x"])), minlength=DENSITY_N ** 3) / len(f["x"])
    return d / len(fr)


def load_density() -> np.ndarray | None:
    return np.load(DENSITY) if os.path.exists(DENSITY) else None


def frames() -> list[dict]:
    out = []
    for p in sorted(p for name in devpairs.SETS for p in glob.glob(os.path.join(HERE, "data", name, "*.npz"))):
        d = np.load(p)
        x, y = d["x"].astype(np.float64), d["y"].astype(np.float64)
        nef = os.path.join(HERE, "renders", os.path.basename(os.path.dirname(p)), os.path.basename(p)[:-4] + ".NEF")
        x = vignette.correct(x, vignette.coefficients(nef))
        gy, gx = np.gradient(y.mean(-1))
        flat = (np.hypot(gx, gy) < .03).ravel()
        out.append({"name": os.path.basename(p)[:-4], "x": x.reshape(-1, 3)[flat], "y": y.reshape(-1, 3)[flat]})
    return out


def sample(fr: list[dict], rng) -> tuple[np.ndarray, np.ndarray]:
    xs, ys = [], []
    for f in fr:
        i = rng.choice(len(f["x"]), min(PER_FRAME, len(f["x"])), replace=False)
        xs.append(f["x"][i])
        ys.append(f["y"][i])
    return np.vstack(xs), np.vstack(ys)


def warm_sample(fr: list[dict], rng) -> tuple[np.ndarray, np.ndarray]:
    """Warm pixels, equal numbers across hue, chroma and lightness cells."""
    x, y = np.vstack([f["x"] for f in fr]), np.vstack([f["y"] for f in fr])
    lab = C.srgb_to_lab(y)
    c = np.hypot(lab[:, 1], lab[:, 2])
    h = np.degrees(np.arctan2(lab[:, 2], lab[:, 1])) % 360
    warm = np.flatnonzero(((h >= WARM_HUE[0]) | (h < WARM_HUE[1])) & (c > WARM_CHROMA))
    cell = ((h[warm] // 15) * 7 + np.minimum(c[warm] // 12, 6)) * 6 + lab[warm, 0] // 20
    pick = np.concatenate([rng.choice(warm[cell == v], WARM_CAP) for v in np.unique(cell)])
    return x[pick], y[pick]


def train_render(fr: list[dict], rng) -> Dev:
    """Matrix and curve as in the working development, warm colors added to the LUT.

    The whole sample must not be rebalanced: reds get better, but green and magenta get worse.
    """
    x, y = sample(fr, rng)
    m = Dev(0)
    m.fit(x, y)
    a, b = warm_sample(fr, rng)
    m.lut = ceiling.Lut(n=RENDER_LUT, ridge=2.0)
    m.lut.fit(m.base(np.vstack([x, a])), np.vstack([y, b]))
    return m


def de(a, b):
    return C.de2000(C.srgb_to_lab(a), C.srgb_to_lab(b))


def main():
    fr = frames()
    rng = np.random.default_rng(0)
    print(f"frames {len(fr)}")
    if "--render" in sys.argv:
        dev = train_render(fr, rng)
        dev.save(RENDER)
        np.save(DENSITY, density(dev, fr))
        print("files:", RENDER, DENSITY)
        return
    if "--density" in sys.argv:
        np.save(DENSITY, density(Dev.load(RENDER), fr))
        print("file:", DENSITY)
        return
    for label, n, ridge in (("matrix+curve", 0, 0), ("LUT 17", 17, 2.0), ("LUT 25", 25, 2.0), ("LUT 33", 33, 3.0)):
        errs = {}
        for k in range(5):
            test = [f for i, f in enumerate(fr) if (i // 2) % 5 == k]
            train = [f for f in fr if f not in test]
            m = Dev(n, ridge)
            m.fit(*sample(train, rng))
            for f in test:
                errs[f["name"]] = de(m(f["x"]), f["y"]).mean()
        v = np.array(list(errs.values()))
        print(f"{label}: held-out frames dE {v.mean():.2f}, median {np.median(v):.2f}, "
              f"worst {v.max():.2f} ({max(errs, key=errs.get)})")
    print({k: round(float(x), 2) for k, x in errs.items()})


if __name__ == "__main__":
    main()
