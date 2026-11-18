"""How much processing can be expressed as one shared transformation.

Models go from least to most freedom; each is trained on some frames and measured
on others (blocks of adjacent frames go wholly into one part):

  gain    — only per-frame WB/exposure
  curve   — + shared lightness curve and shared saturation
  np3     — + 8 colors (hue/chroma/brightness) and 3 grading zones, approximately
  lut     — + shared 17^3 3D LUT: an upper bound for any global profile
  own-lut — a 3D LUT per frame: the ceiling for global color grading at all

The np3 model here is a structural approximation in Oklab, not the camera response.
"""
from __future__ import annotations

import glob
import json
import os
import sys

import numpy as np
from PIL import Image

import color as C

HERE = os.path.dirname(os.path.abspath(__file__))
SIDE = 96           # long side of the sample: suppresses the residual shift and grain
MIN_NCC = 0.6
BLOCK = 6
N_CURVE = 17
N_HUE = 8


def load():
    items = []
    dirs = [os.path.join(HERE, "data/pairs"), os.path.join(HERE, "_local/pairs")]
    for p in sorted(glob.glob(os.path.join(dirs[0], "*.npz")) + glob.glob(os.path.join(dirs[1], "*.npz"))):
        d = np.load(p)
        if float(d["ncc"]) < MIN_NCC:
            continue
        A, T = d["A"], d["T"]
        k = SIDE / max(A.shape[:2])
        size = (round(A.shape[1] * k), round(A.shape[0] * k))
        a = np.asarray(Image.fromarray(A).resize(size, Image.BOX), dtype=np.float64) / 255
        t = np.asarray(Image.fromarray(T).resize(size, Image.BOX), dtype=np.float64) / 255
        keep = ((a.max(-1) < 0.98) & (t.max(-1) < 0.98) & (a.min(-1) > 0.01) & (t.min(-1) > 0.01)).ravel()
        items.append({"name": os.path.basename(p)[:-4], "a": a.reshape(-1, 3)[keep],
                      "t": t.reshape(-1, 3)[keep], "masks": bool(d["masks"])})
    return items


def de(pred, target):
    return C.de2000(C.srgb_to_lab(np.clip(pred, 0, 1)), C.srgb_to_lab(target))


def apply_gain(a, g):
    return C.linear_to_srgb(C.srgb_to_linear(a) * g)


def fit_gain(pred_fn, a, t, g):
    """Adjusts the per-channel linear coefficients so the mean logs match."""
    for _ in range(4):
        p = np.clip(pred_fn(apply_gain(a, g)), 1e-3, 1)
        g = g * np.exp(np.median(np.log(C.srgb_to_linear(t) + 1e-4) - np.log(C.srgb_to_linear(p) + 1e-4), axis=0))
        g = np.clip(g, 0.25, 4)
    return g


def hat(x, knots):
    """Piecewise-linear basis on a segment."""
    n = len(knots)
    i = np.clip(np.searchsorted(knots, x) - 1, 0, n - 2)
    f = (x - knots[i]) / (knots[i + 1] - knots[i])
    B = np.zeros((len(x), n))
    r = np.arange(len(x))
    B[r, i] = 1 - f
    B[r, i + 1] = f
    return B


def hue_hat(h, n=N_HUE):
    """Periodic basis over hue."""
    u = (h % (2 * np.pi)) / (2 * np.pi) * n
    i = np.floor(u).astype(int) % n
    f = u - np.floor(u)
    B = np.zeros((len(h), n))
    r = np.arange(len(h))
    B[r, i] = 1 - f
    B[r, (i + 1) % n] = f
    return B


class Curve:
    """Shared L curve and shared saturation in Oklab."""

    def fit(self, a, t):
        la, lt = self.lab(a), self.lab(t)
        B = hat(la[:, 0], np.linspace(0, 1, N_CURVE))
        self.w = solve(B, lt[:, 0], np.linspace(0, 1, N_CURVE))
        c = la[:, 1:]
        self.k = float((c * lt[:, 1:]).sum() / ((c * c).sum() + 1e-9))

    @staticmethod
    def lab(x):
        return C.linear_to_oklab(C.srgb_to_linear(x))

    def __call__(self, a):
        la = self.lab(a)
        L = hat(la[:, 0], np.linspace(0, 1, N_CURVE)) @ self.w
        return to_srgb(np.column_stack([L, la[:, 1:] * self.k]))


class NP3Like(Curve):
    """Curve + 8 colors + 3 zones. All parameters enter linearly."""

    def design(self, la):
        L, a, b = la[:, 0], la[:, 1], la[:, 2]
        h = np.arctan2(b, a)
        ch = np.hypot(a, b)
        H = hue_hat(h)
        s = np.clip(ch / 0.06, 0, 1)[:, None]
        Z = hat(L, np.array([0.0, 0.5, 1.0]))
        BL = np.hstack([hat(L, np.linspace(0, 1, N_CURVE)), H * s])
        Ba = np.hstack([H * a[:, None], H * (-b)[:, None], Z, np.zeros_like(Z)])
        Bb = np.hstack([H * b[:, None], H * a[:, None], np.zeros_like(Z), Z])
        return BL, Ba, Bb

    def fit(self, a, t):
        la, lt = self.lab(a), self.lab(t)
        BL, Ba, Bb = self.design(la)
        prior = np.r_[np.linspace(0, 1, N_CURVE), np.zeros(N_HUE)]
        self.wL = solve(BL, lt[:, 0], prior)
        prior = np.r_[np.ones(N_HUE), np.zeros(N_HUE + 6)]
        self.wc = solve(np.vstack([Ba, Bb]), np.r_[lt[:, 1], lt[:, 2]], prior)

    def __call__(self, a):
        la = self.lab(a)
        BL, Ba, Bb = self.design(la)
        return to_srgb(np.column_stack([BL @ self.wL, Ba @ self.wc, Bb @ self.wc]))


class Lut:
    """3D LUT with trilinear interpolation and a pull towards identity in empty cells."""

    def __init__(self, n=17, ridge=3.0):
        self.n, self.ridge = n, ridge

    def corners(self, a):
        n = self.n
        u = np.clip(a, 0, 1) * (n - 1)
        i = np.minimum(u.astype(int), n - 2)
        f = u - i
        out = []
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                    out.append((((i[:, 0] + dx) * n + i[:, 1] + dy) * n + i[:, 2] + dz, w))
        return out

    def fit(self, a, t):
        n = self.n
        num = np.zeros((n ** 3, 3))
        den = np.zeros(n ** 3)
        for idx, w in self.corners(a):
            np.add.at(num, idx, (t - a) * w[:, None])
            np.add.at(den, idx, w)
        self.d = num / (den + self.ridge)[:, None]

    def __call__(self, a):
        out = a.copy()
        for idx, w in self.corners(a):
            out = out + self.d[idx] * w[:, None]
        return out


def to_srgb(lab):
    return C.linear_to_srgb(np.clip(C.oklab_to_linear(lab), 0, None))


def solve(B, y, prior, lam=1e-3):
    """Ridge regression towards prior values."""
    n = len(y)
    AtA = B.T @ B / n + lam * np.eye(B.shape[1])
    return prior + np.linalg.solve(AtA, B.T @ (y - B @ prior) / n)


def run(make, train, test, rounds=3):
    """Alternates the shared model with the training frames' own coefficients."""
    gains = {it["name"]: np.ones(3) for it in train}
    model = make()
    for _ in range(rounds):
        model.fit(np.vstack([apply_gain(it["a"], gains[it["name"]]) for it in train]),
                  np.vstack([it["t"] for it in train]))
        for it in train:
            gains[it["name"]] = fit_gain(model, it["a"], it["t"], gains[it["name"]])
    res = {}
    for it in test:
        g = fit_gain(model, it["a"], it["t"], np.ones(3))
        res[it["name"]] = (float(de(model(it["a"]), it["t"]).mean()),
                           float(de(model(apply_gain(it["a"], g)), it["t"]).mean()))
    return res


def main():
    items = load()
    print(f"frames: {len(items)}, with masks: {sum(i['masks'] for i in items)}, points per frame ~{len(items[0]['a'])}")
    folds = [[], []]
    for i, it in enumerate(items):
        folds[(i // BLOCK) % 2].append(it)

    table = {}
    table["source"] = {it["name"]: (float(de(it["a"], it["t"]).mean()),) * 2 for it in items}
    gain = {}
    for it in items:
        g = fit_gain(lambda x: x, it["a"], it["t"], np.ones(3))
        v = float(de(apply_gain(it["a"], g), it["t"]).mean())
        gain[it["name"]] = (v, v)
    table["gain"] = gain
    for label, make in (("curve", Curve), ("np3", NP3Like), ("lut", Lut)):
        r = {}
        for k in (0, 1):
            r.update(run(make, folds[k], folds[1 - k]))
        table[label] = r
    own = {}
    for it in items:
        m = Lut(n=9, ridge=1.0)
        m.fit(it["a"], it["t"])
        v = float(de(m(it["a"]), it["t"]).mean())
        own[it["name"]] = (v, v)
    table["own-lut"] = own

    masked = {it["name"]: it["masks"] for it in items}
    print(f"\n{'model':10} {'no WB/expo':>12} {'own WB/expo':>11} {'no masks':>10} {'masked':>10}   dE2000, held-out frames")
    for label, r in table.items():
        raw = np.array([v[0] for v in r.values()])
        fit = np.array([v[1] for v in r.values()])
        nm = np.array([v[1] for k, v in r.items() if not masked[k]])
        ym = np.array([v[1] for k, v in r.items() if masked[k]])
        print(f"{label:10} {raw.mean():12.2f} {fit.mean():11.2f} {nm.mean():10.2f} {ym.mean():10.2f}")
    out = os.path.join(HERE, "data", "ceiling.json")
    json.dump({k: {n: v for n, v in r.items()} for k, r in table.items()}, open(out, "w"), indent=0)


if __name__ == "__main__":
    sys.exit(main())
