"""Coherent band-limited regression: target Y' ~ LUT(NX Y') + sum v_t H_t(NX Y'), in the band sigma LO..HI (x4 px).
The LUT (16 hat functions over NX Y') is fitted jointly, so it cannot soak up Clarity."""
import os, sys, json, itertools
import numpy as np
from PIL import Image
import bands as B
D = B.D
NK = 16
LO, HI = 1.4, 44.8


def bp(a):
    return D.gauss(a, LO) - D.gauss(a, HI)


def hats(y):
    u = np.clip(y, 0, 1) * (NK - 1)
    i = np.minimum(u.astype(int), NK - 2); f = u - i
    out = np.zeros((NK,) + y.shape, np.float32)
    for k in range(NK):
        out[k] = np.where(i == k, 1 - f, 0) + np.where(i + 1 == k, f, 0)
    return out


def design(yn, yt, v0, sub=250_000, seed=0):
    model = D.Detail.load()
    H = {}
    for tool in D.TOOLS:
        p = model.part(tool, B.SCALE)
        H[tool] = (bp(p.delta(yn, 1.0, B.SCALE)), bp(p.delta(yn, -1.0, B.SCALE)))
    L = np.stack([bp(h) for h in hats(yn)])
    t = bp(yt)
    ok = (yt > .02) & (yt < .97) & (yn > .02) & (yn < .97)
    m = 48
    ok[:m] = ok[-m:] = False; ok[:, :m] = ok[:, -m:] = False
    idx = np.flatnonzero(ok.ravel())
    idx = np.random.default_rng(seed).choice(idx, min(sub, idx.size), replace=False)
    return dict(t=t.ravel()[idx], L=L.reshape(NK, -1)[:, idx].T,
                H={k: (a.ravel()[idx], b.ravel()[idx]) for k, (a, b) in H.items()}, v0=v0)


def solve(ds, tools=D.TOOLS):
    """Joint over frames (one LUT per frame, shared detail values). Sign regions enumerated."""
    best = None
    for signs in itertools.product((1, -1), repeat=len(tools)):
        A_rows, b_rows = [], []
        nl = NK * len(ds)
        for j, d in enumerate(ds):
            n = d["t"].size
            Lb = np.zeros((n, nl)); Lb[:, j * NK:(j + 1) * NK] = d["L"]
            cols, off = [], np.zeros(n)
            for tool, sg in zip(tools, signs):
                hp, hm = d["H"][tool]; v0 = d["v0"][tool]
                # value v in region sg: total(v) - total(v0); unknown u = |v|
                off -= max(v0, 0) * hp + max(-v0, 0) * hm
                cols.append(hp if sg > 0 else hm)
            A_rows.append(np.hstack([Lb, np.stack(cols, 1)])); b_rows.append(d["t"] - off)
        A = np.vstack(A_rows); b = np.concatenate(b_rows)
        x, *_ = np.linalg.lstsq(A, b, rcond=None)
        u = x[-len(tools):]
        if (u < 0).any():
            # outside this sign region: clamp to 0 and refit without those columns
            keep = u >= 0
            A2 = np.hstack([A[:, :-len(tools)], A[:, -len(tools):][:, keep]])
            x2, *_ = np.linalg.lstsq(A2, b, rcond=None)
            u = np.zeros(len(tools)); u[keep] = x2[-keep.sum():] if keep.any() else []
            x = np.concatenate([x2[:-keep.sum()] if keep.any() else x2, u])
        r = b - A @ x
        cost = float(r @ r)
        if best is None or cost < best[0]:
            best = (cost, {tool: float(sg * ui) for tool, sg, ui in zip(tools, signs, u)})
    # R^2 of the detail part against the LUT-only fit
    return best


def r2_gain(ds, vals):
    out = []
    for d in ds:
        off = np.zeros_like(d["t"])
        for tool in D.TOOLS:
            hp, hm = d["H"][tool]; v, v0 = vals.get(tool, d["v0"][tool]), d["v0"][tool]
            off += (max(v, 0) - max(v0, 0)) * hp + (max(-v, 0) - max(-v0, 0)) * hm
        def res(o):
            b = d["t"] - o
            x, *_ = np.linalg.lstsq(d["L"], b, rcond=None)
            r = b - d["L"] @ x
            return float(r @ r)
        out.append(1 - res(off) / res(0 * off))
    return out
