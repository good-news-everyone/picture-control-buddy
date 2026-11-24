"""Core NP3 fitting utilities shared by the fitting pipeline.

Parameter packing (blender, grade, monotone curve), the Levenberg–Marquardt
solver with numerical jacobian, and photo-sampling helpers used by match.py
and render.py. The chart-based fitting entry points (fitting a profile from
photos of a printed chart sheet) live in the np3-fit-charts project, which
builds on these utilities.
"""
from __future__ import annotations

import os

import numpy as np

import color as C
import make_pack
import model as M
import np3

HERE = os.path.dirname(os.path.abspath(__file__))
XS = np.array([round(i * 255 / 19) for i in range(20)]) / 255   # curve anchor points in the NP3 file
NB = 24
NG = 6
NC = len(XS)
SMOOTH = 0.3
RIDGE = 0.012
LIMIT = 60.0        # sweeps measured the response up to ±60; beyond that is extrapolation
WHITE = 30.0        # the chart sheet does not reach white: the curve end is pinned to 1

NEIGHBOURS = 4      # photo pixel -> patch weights in nearest()
PIXELS = 1500       # pixels sampled per photo
BRIGHT_PIXELS = 500  # highlights are rare: without an extra sample they are almost absent
BRIGHT_Y = 0.75
BEND = np.r_[np.ones(14), np.full(4, 0.25)]   # the curve shoulder is allowed to bend steeper


def unpack(x: np.ndarray) -> M.Params:
    p = M.Params()
    b = x[:NB].reshape(8, 3)
    p.blender = {c: list(b[i]) for i, c in enumerate(np3.COLORS)}
    g = x[NB:NB + NG].reshape(3, 2)
    p.grade = {z: [float(np.degrees(np.arctan2(g[i, 1], g[i, 0])) % 360), float(np.hypot(*g[i]))]
               for i, z in enumerate(np3.ZONES)}
    p.curve = table(x[NB + NG:])
    return p


def knots(c: np.ndarray) -> np.ndarray:
    """Monotone curve: increments are non-negative."""
    return np.cumsum(np.abs(c))


def table(c: np.ndarray) -> np.ndarray:
    return np.clip(np.interp(np.linspace(0, 1, 257), XS, knots(c)), 0, 1)


def lab(rgb: np.ndarray) -> np.ndarray:
    return C.srgb_to_lab(np.clip(rgb, 0, 1).reshape(-1, 3))


def nearest(lab_px: np.ndarray, lab_patches: np.ndarray) -> np.ndarray:
    """Dense pixel -> patch weight matrix by inverse distance."""
    d = np.linalg.norm(lab_px[:, None] - lab_patches[None], axis=2)
    idx = np.argsort(d, axis=1)[:, :NEIGHBOURS]
    w = 1 / (np.take_along_axis(d, idx, 1) + 2.0)
    W = np.zeros_like(d)
    np.put_along_axis(W, idx, w / w.sum(1, keepdims=True), 1)
    return W


class Corrected:
    """Model plus a constant bias measured against a real render."""

    def __init__(self, R, bias):
        self.R, self.bias = R, bias

    def predict(self, p, curve_last=False):
        return self.R.predict(p, curve_last) + self.bias


def residual(x, R, tlab, mask, curve_last, anchor):
    pred = lab(R.predict(unpack(x), curve_last))
    r = (pred - tlab)[mask].ravel() / np.sqrt(mask.sum())
    k = knots(x[NB + NG:])
    return np.r_[r, SMOOTH * 100 * np.diff(k, 2), RIDGE * (x - anchor)[:NB + NG], WHITE * (k[-1] - 1)]


def lm(fn, x, iters=60, info: dict | None = None):
    """Levenberg–Marquardt with a numerical jacobian and bounds on blender/grade. info, if given,
    receives run: the number of accepted outer iterations."""
    lam = 1e-2
    run = 0
    r = fn(x)
    cost = r @ r
    steps = np.r_[np.full(NB + NG, 1.0), np.full(NC, 2e-3), np.full(len(x) - NB - NG - NC, 1.0)]   # tail: other sliders
    for _ in range(iters):
        J = np.empty((len(r), len(x)))
        for i in range(len(x)):
            e = np.zeros(len(x))
            e[i] = steps[i]
            J[:, i] = (fn(x + e) - fn(x - e)) / (2 * steps[i])
        A, g = J.T @ J, J.T @ r
        for _ in range(12):
            # lower bound on the diagonal: on flat curve segments the jacobian is zero and the step blew up
            d = np.linalg.solve(A + lam * np.diag(np.maximum(np.diag(A), 1e-4 * np.diag(A).max())), -g)
            y = x + d
            y[:NB] = np.clip(y[:NB], -LIMIT, LIMIT)
            n = np.hypot(y[NB:NB + NG:2], y[NB + 1:NB + NG:2])
            s = np.minimum(1, LIMIT / np.maximum(n, 1e-9))
            y[NB:NB + NG:2] *= s
            y[NB + 1:NB + NG:2] *= s
            r2 = fn(y)
            if r2 @ r2 < cost:
                x, r, cost = y, r2, r2 @ r2
                lam = max(lam / 3, 1e-6)
                run += 1
                break
            lam *= 3
        else:
            break
    if info is not None:
        info["run"] = run
    return x, cost


def solve(R, T, mask, curve_last=False, iters=60, seed=0, x0=None):
    rng = np.random.default_rng(seed)
    tlab = lab(T)
    x = np.r_[rng.normal(0, 3, NB + NG), np.r_[0.0, np.diff(XS)]] if x0 is None else x0.copy()
    anchor = np.zeros(len(x)) if x0 is None else x0
    return lm(lambda v: residual(v, R, tlab, mask, curve_last, anchor), x, iters)


def best(R, T, mask, curve_last=False, seeds=3):
    return min((solve(R, T, mask, curve_last, seed=s) for s in range(seeds)), key=lambda v: v[1])[0]


def de(a, b):
    return C.de2000(lab(a), lab(b)).reshape(a.shape[:2])


def control(x: np.ndarray, name: str) -> np3.Control:
    p = unpack(x)
    k = knots(x[NB + NG:])
    return np3.Control(
        name=name, sharpening=2.0, mid_sharpening=1.0, clarity=0,
        blender={c: tuple(int(round(v)) for v in p.blender[c]) for c in np3.COLORS},
        grade={z: (int(round(p.grade[z][0])) % 360, int(round(p.grade[z][1])), 0) for z in np3.ZONES},
        curve=make_pack.curve_from(lambda t: float(np.interp(t, XS, k))))
