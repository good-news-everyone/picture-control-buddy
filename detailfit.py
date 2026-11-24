"""Fitting Clarity and Mid-range sharpening to a target (spec/tools/detail.md "Fitting the detail tools").

The step runs after the color fit. Given the render of the fitted profile (its own detail values
v0 and the NX base detail included) and the target, both as Y' luma on one grid, the target's band
sigma LO..HI (full-frame px) is regressed on

    bp(target) ~ bp(a1*y + a2*y^2 + a3*y^3) + sum_t (total_t(v_t) - total_t(v0_t))

where y is the render's Y', bp a Gaussian band-pass, total_t(v) the detail.py response of tool t at
value v (plus table for v > 0, minus table for v < 0) and the cubic a pointwise tone correction fitted
jointly — a tone LUT fitted first soaks up about half of Clarity (research/detailfit). CAL takes our
render's excess local contrast over NX's out (calibrated on NX exports). The cubic is
per pair, the detail values are shared by all pairs; each pair is normalized by its own band energy,
so every frame counts the same. Sharpening is not fitted: its band is below a pixel at the fit scale.

Blurs are the Young-van Vliet recursive Gaussian (O(1) per pixel for any sigma, edges replicated);
web/lib/detail-fit.js is a port and is checked against this module (web/make_detailfit_golden.py, level 1l).

    python3 detailfit.py render.tif target.jpg [v0_clarity v0_mid]   # one pair, prints the values
"""
from __future__ import annotations

import itertools
import sys

import numpy as np

import detail as D

TOOLS = ("clarity", "mid_sharpening")
LO, HI = 5.6, 179.2       # band-pass sigmas, full-frame px (1.4..44.8 px at scale 4)
CLIP_LO, CLIP_HI = 0.02, 0.97
STEP = 0.25               # NP3 quantization of Clarity / Mid-range
RANGE = (-5.0, 5.0)
MIN_PIXELS = 10_000       # a pair with fewer usable pixels is left out of the detail fit
# Our renders carry more local contrast in the band than NX Studio's render of the same profile.
# Fitted against NX's own 1512 px export of profile NEW4 (Clarity 0, Mid-range 1), the
# uncalibrated fit returns (medians): match.py renders, 7 SA frames — Clarity +0.25, Mid-range
# +0.05; the wizard's 1600 px renders (web/lib/detail-fit.js), 12 SA frames — Clarity +0.23,
# Mid-range -0.20 (spread about +-0.4; night and high-ISO frames lower: noise). That excess, as
# responses on the plus tables, is taken out of the render, so the values are what NX (and the
# camera) need. CAL is match.py's, CAL_WEB the wizard's (detail-fit.js CAL).
CAL = {"clarity": -0.25, "mid_sharpening": 0.95}
CAL_WEB = {"clarity": -0.25, "mid_sharpening": 1.2}
NZ = 3 + 2 * len(TOOLS) + 1   # z basis per pixel: bp(y), bp(y^2), bp(y^3), H_t+ / H_t- per tool, bp(target)


def _yvv_coef(q: float) -> tuple[float, float, float, float]:
    b0 = 1.57825 + 2.44413 * q + 1.4281 * q * q + 0.422205 * q * q * q
    b1 = (2.44413 * q + 2.85619 * q * q + 1.26661 * q * q * q) / b0
    b2 = -(1.4281 * q * q + 1.26661 * q * q * q) / b0
    b3 = 0.422205 * q * q * q / b0
    return 1 - (b1 + b2 + b3), b1, b2, b3


def _yvv(sigma: float) -> tuple[float, float, float, float]:
    """The Young-van Vliet coefficients whose forward + backward pass has exactly variance sigma^2.
    The paper's q(sigma) formula overshoots by 10-25 %; q is found by bisection on the exact
    variance of the cascade, 2 * (sum k(k-1) b_k / B + mu^2 + mu), mu = sum k b_k / B."""
    def var(q):
        B, b1, b2, b3 = _yvv_coef(q)
        mu = (b1 + 2 * b2 + 3 * b3) / B
        return 2 * ((2 * b2 + 6 * b3) / B + mu * mu + mu)
    lo, hi = 1e-3, 2.0 * sigma + 2.0
    target = sigma * sigma
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if var(mid) < target:
            lo = mid
        else:
            hi = mid
    return _yvv_coef(0.5 * (lo + hi))


def rgauss(a: np.ndarray, sigma: float) -> np.ndarray:
    """Young-van Vliet recursive Gaussian over both axes of a 2D float64 array (edges replicated)."""
    if sigma < 0.5:
        return a.astype(np.float64, copy=True)
    B, b1, b2, b3 = _yvv(sigma)

    def along(x: np.ndarray) -> np.ndarray:      # along axis 1, vectorized over rows
        n = x.shape[1]
        w = np.empty_like(x)
        p1 = p2 = p3 = x[:, 0].copy()
        for i in range(n):
            v = B * x[:, i] + b1 * p1 + b2 * p2 + b3 * p3
            w[:, i] = v
            p3, p2, p1 = p2, p1, v
        out = np.empty_like(x)
        p1 = p2 = p3 = w[:, n - 1].copy()
        for i in range(n - 1, -1, -1):
            v = B * w[:, i] + b1 * p1 + b2 * p2 + b3 * p3
            out[:, i] = v
            p3, p2, p1 = p2, p1, v
        return out

    a = np.asarray(a, dtype=np.float64)
    return along(along(a).T).T


def luma(rgb: np.ndarray) -> np.ndarray:
    return np.asarray(rgb, np.float64) @ D.YW


def usable(yr: np.ndarray, yt: np.ndarray, valid: np.ndarray, scale: float) -> np.ndarray:
    """Pixels that enter the regression: valid in both, not clipped, away from the frame edge and
    from invalid areas by the band's large sigma."""
    s = HI / scale
    m = int(np.ceil(s))
    ok = valid & (yr > CLIP_LO) & (yr < CLIP_HI) & (yt > CLIP_LO) & (yt < CLIP_HI)
    ok &= rgauss((~valid).astype(np.float64), s) < 1e-3
    ok[:m] = ok[-m:] = False
    ok[:, :m] = ok[:, -m:] = False
    return ok


def tool_basis(model: D.Detail, y: np.ndarray, scale: float) -> dict:
    """Per tool (plus, minus): the detail.py response at value +1 / -1 on Y' y, with rgauss blurs."""
    hp = {}
    out = {}
    for tool in TOOLS:
        p = model.part(tool, scale)
        pair = []
        for tables, sg in ((p.plus, 1.0), (p.minus, -1.0)):
            h = np.zeros_like(y)
            for s, t in zip(p.sigmas, tables):
                if s not in hp:
                    hp[s] = y - rgauss(y, s / scale)
                h += np.interp(y, D.GRID, t) * hp[s]
            pair.append(sg * h)
        out[tool] = tuple(pair)
    return out


def gram(yr: np.ndarray, yt: np.ndarray, valid: np.ndarray, scale: float, model: D.Detail) -> dict | None:
    """One pair -> the Gram matrix of its z basis over the usable pixels (None: too few)."""
    ok = usable(yr, yt, valid, scale)
    n = int(ok.sum())
    if n < MIN_PIXELS:
        return None
    y = np.where(valid, yr, 0.5).astype(np.float64)
    t = np.where(valid, yt, 0.5).astype(np.float64)

    def bp(a):
        return rgauss(a, LO / scale) - rgauss(a, HI / scale)

    cols = [bp(y), bp(y * y), bp(y * y * y)]
    H = tool_basis(model, y, scale)
    for tool in TOOLS:
        cols += [bp(H[tool][0]), bp(H[tool][1])]
    cols.append(bp(t))
    Z = np.stack([c[ok] for c in cols], 1)
    return {"Q": Z.T @ Z, "n": n}


def _coef(v: float) -> tuple[float, float]:
    """total(v) as coefficients on (H+, H-): the plus response for v > 0, the minus one for v < 0."""
    return (max(v, 0.0), max(-v, 0.0))


def solve(grams: list[dict], v0: dict, cal: dict | None = None) -> dict:
    """Shared Clarity / Mid-range for all pairs. Returns {values, cost, cost0, pairs}.
    cal: the render's excess response on the plus tables (CAL by default)."""
    cal = CAL if cal is None else cal
    gs = [g for g in grams if g is not None]
    if not gs:
        return {"values": {t: float(v0[t]) for t in TOOLS}, "cost": 0.0, "cost0": 0.0, "pairs": 0}
    P = len(gs)
    T = len(TOOLS)
    it = 3 + 2 * T                                      # index of bp(target) in z
    base = np.zeros(NZ)
    base[it] = 1.0
    for k, tool in enumerate(TOOLS):                    # the response already in the render is v0's
        cp, cm = _coef(v0[tool])                        # residual = bp(t) + total(v0) - total(v) - cubic
        base[3 + 2 * k] += cp + cal.get(tool, 0.0)
        base[3 + 2 * k + 1] += cm
    Qs = []
    for g in gs:
        Q = g["Q"]
        e = float(base @ Q @ base)
        Qs.append(Q / max(e, 1e-30))                    # every pair counts the same

    def fit(signs, free) -> tuple[float, np.ndarray]:
        """Least squares with the shared tools in `free` (sign region `signs`); the others at 0."""
        nf = len(free)
        N = 3 * P + nf
        A = np.zeros((N, N))
        r = np.zeros(N)
        c0 = 0.0
        S_list = []
        for p, Q in enumerate(Qs):
            S = np.zeros((NZ, N))
            S[0:3, 3 * p:3 * p + 3] = np.eye(3)
            for j, k in enumerate(free):
                S[3 + 2 * k + (0 if signs[k] > 0 else 1), 3 * P + j] = 1.0
            S_list.append(S)
            A += S.T @ Q @ S
            r += S.T @ Q @ base
            c0 += float(base @ Q @ base)
        th = np.linalg.lstsq(A, r, rcond=None)[0]
        cost = c0 - 2 * float(th @ r) + float(th @ A @ th)
        return cost, th

    best = None
    for signs in itertools.product((1, -1), repeat=T):
        free = list(range(T))
        while True:
            cost, th = fit(signs, free)
            u = th[3 * P:]
            neg = [k for k, ui in zip(free, u) if ui < 0]
            if not neg:
                break
            free = [k for k in free if k not in neg]   # outside this sign region: that tool -> 0
        vals = {tool: 0.0 for tool in TOOLS}
        for k, ui in zip(free, u):
            vals[TOOLS[k]] = float(signs[k] * ui)
        if best is None or cost < best[0]:
            best = (cost, vals)
    cost, vals = best
    # the render's own values with the cubic still free: the reference cost
    cost0 = _fixed(Qs, base, {t: v0[t] for t in TOOLS})
    out = {}
    for tool in TOOLS:
        v = float(np.clip(vals[tool], *RANGE))
        out[tool] = float(np.round(v / STEP) * STEP) + 0.0
    return {"values": out, "raw": vals, "cost": float(cost) / P, "cost0": float(cost0) / P, "pairs": P}


def _fixed(Qs, base, vals) -> float:
    """The cost with the detail fixed at vals (the cubic per pair free)."""
    e = base.copy()
    for k, tool in enumerate(TOOLS):
        cp, cm = _coef(vals[tool])
        e[3 + 2 * k] -= cp
        e[3 + 2 * k + 1] -= cm
    cost = 0.0
    for Q in Qs:
        A = Q[0:3, 0:3]
        r = Q[0:3] @ e
        th = np.linalg.lstsq(A, r, rcond=None)[0]
        cost += float(e @ Q @ e) - 2 * float(th @ r) + float(th @ A @ th)
    return cost


def fit_detail(pairs: list[tuple[np.ndarray, np.ndarray, np.ndarray, float]], v0: dict,
               model: D.Detail | None = None, cal: dict | None = None) -> dict:
    """pairs: (render Y', target Y', valid mask, scale in full-frame px per pixel)."""
    model = model or D.Detail.load()
    return solve([gram(yr, yt, ok, s, model) for yr, yt, ok, s in pairs], v0, cal)


LONG = 1536               # the CLI grid (match.py): about the 1512-1600 px scale of the web pages


def aligned(nef: str, target: str, ctrl, gain=np.ones(3), renderer=None) -> tuple:
    """match.py: the render of `ctrl` (color, then its own detail and the NX base detail on the
    target grid) and the target, as (render Y', target Y', valid, scale)."""
    from PIL import Image
    import devpairs
    import pairs
    import rawdev
    import render
    raw = Image.open(target)
    x = pairs.xmp_values(raw)
    t = pairs.to_srgb(raw)
    lin = rawdev.develop(nef)[devpairs.MY:-devpairs.MY, devpairs.MX:-devpairs.MX]
    if x.get("HasCrop") == "True":
        lin = devpairs.lens_corrected(lin, nef)
    R = renderer or render.Renderer()
    img = R.apply(R.neutral(lin, gain), ctrl)                 # color only: detail on the grid below
    a = devpairs.oriented([devpairs.crop_float(img, x, s) for s in (1, -1)], t)
    m = devpairs.matched(a, t, long=LONG, box=1, target_filter=Image.BOX)
    scale = D.SENSOR_LONG / max(lin.shape[:2]) * max(a.shape[:2]) / LONG
    valid = m["x"].max(-1) > 0                                # the warp fills outside the frame with 0
    rgb = R.detail(np.clip(m["x"], 0, 1).astype(np.float32), ctrl, scale=scale, base=True)
    return luma(rgb), luma(m["y"]), valid, scale


if __name__ == "__main__":
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    a = luma(np.asarray(Image.open(sys.argv[1]).convert("RGB"), np.float64) / 255)
    t = np.asarray(Image.open(sys.argv[2]).convert("RGB").resize(a.shape[::-1], Image.BOX), np.float64) / 255
    v0 = {"clarity": float(sys.argv[3]) if len(sys.argv) > 3 else 0.0,
          "mid_sharpening": float(sys.argv[4]) if len(sys.argv) > 4 else 1.0}
    r = fit_detail([(a, luma(t), np.ones(a.shape, bool), D.SENSOR_LONG / max(a.shape))], v0)
    print(r)
