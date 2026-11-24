"""Step-based profile model trained on NX Studio exports, not on the on-screen chart.

The order follows slider-pair measurements (spec/results.md):
1. Zone grading: an additive offset in sRGB, linear in chroma. A 3D LUT per each of the 8
   grading directions every 45 degrees, trigonometric interpolation between them. The basis
   (1, cos, sin) did not pass through all directions: at chroma 40 the midtone shift at 45
   degrees equals 12, at 135 degrees it equals 31. Computed from neutral.
2. Blender, by color after grading: rotates hue in CIELab, scales chroma, shifts lightness.
   The response of a color set per slider unit: a 3D LUT, a separate table per (set A/B,
   attribute, sign). Each color's share of the set depends on the Oklab hue, a table over
   96 cells of 3.75 degrees.
3. Curve over Y', as in model.apply_curve.

Grading before the blender, not after: on "blender + grading" pairs 1.12 vs 1.49,
on the face of DSC_5966 with FIT2 the redness is dA +3.1 vs +7.0.

Blender responses are learned from single probes in data/sweep.npz, grading from probes in
data/sweep.npz and data/sweep3.npz, color shares jointly from single color probes in
data/sweep3.npz and set probes in data/sweep.npz. Combinations, pairs and finished profiles
in data/sweep2.npz are not part of training and serve as validation.

    python3 profile_model.py    # training -> data/profile_model.npz and validation on data/sweep2.npz
    python3 profile_model.py zones   # zone grid -> data/zone_grid.npz (sweep6-13.npz from data/ or _local/)

Off Blending 50 / Balance 0, zone grading goes through the zone grid (data/zone_grid.npz, see
train_zone_grid) when the file exists; without it the tools masks are used as before.
"""
from __future__ import annotations

import os
import re
import sys

import numpy as np

import color as C
import model as M
import np3

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "data", "profile_model.npz")
TRAIN = os.path.join(HERE, "data", "sweep.npz")
CHECK = os.path.join(HERE, "data", "sweep2.npz")
COLORS_DATA = os.path.join(HERE, "data", "sweep3.npz")
TOOLS_DATA = os.path.join(HERE, "data", "sweep4.npz")
# South Africa frames with sky, vest, bright warm colors, skin and water (sweep.py colors-sa): blender sets and
# colors as in sweep.npz and sweep3.npz, learned together with them. The +-100 probes and finished profiles from
# this pack are validation.
EXTRA_DATA = os.path.join(HERE, "data", "sweep5.npz")
EXTRA_FRAMES = os.environ.get("NP3_EXTRA_FRAMES")     # comma-separated frame subset, for held-out validation
TONE_LEVELS = (-100, -50, -25, 0, 25, 50, 100)
SAT_LEVELS = (-100, -50, -25, 0, 25, 50, 100)
BLENDINGS = (0, 25, 50, 75, 100)
BALANCES = (-100, -50, 0, 50, 100)
MASK_BINS = 20               # zone mask over neutral Y'
MASK_HUES = {"shadows": 225, "midtone": 45, "highlights": 135}   # hues of the Blending and Balance probes
YCC = np.array([[0.299, 0.587, 0.114], [-0.168736, -0.331264, 0.5], [0.5, -0.418688, -0.081312]])
YCC_INV = np.linalg.inv(YCC)
# The continuous-tone chart shot (data/sweep_chart.npz) is not part of training: in color shares it made
# validation worse (finished 1.07 -> 1.12, combinations 0.86 -> 0.91). The set LUT learns only on real
# frames, on screen colors it extrapolates, and the shares adapt to that error.
SHARE_K = 96              # hue cells in the share table
SHARE_SMOOTH = 0.3
SHARE_NPX = 5000
COLOR_LEVEL = 40          # level of single color probes
G = 9                     # LUT knots per axis: 13 gives the same
NN = G ** 3
LAM = 1e-5                # smoothness; 1e-3 and 1e-2 are worse on validation
NPX = 3000                # pixels per frame when training
LEVELS = (20, 40, 60)
ATTRS = ("hue", "chroma", "brightness")
# color sectors in columns of 15 degrees of neutral Oklab hue; each set partitions the circle without overlaps
SECTORS = {"A": (("red", 23.5, 2.5), ("yellow", 2.5, 8.5), ("cyan", 8.5, 16.5), ("purple", 16.5, 23.5)),
           "B": (("magenta", 21.5, 1.5), ("orange", 1.5, 5.5), ("green", 5.5, 10.5), ("blue", 10.5, 21.5))}
SET_OF = {c: s for s, items in SECTORS.items() for c, _, _ in items}
ZONE_TAG = np3.ZONE_TAG   # zone letters in probe names
GRADE_HUES = tuple(range(0, 360, 45))     # grading directions, each with its own LUT
# Zone grid (2026-11-23, sweep.py zones / zones2 / zones3): zone brightness and zone color off Blending 50 /
# Balance 0 come from tables on a Blending x Balance grid instead of the tools masks, which do not add up
# at hard masks (the fit ran into Blending 0-4 + strong zone brightness, off from NX by 2-3 dE).
ZONE_GRID = os.path.join(HERE, "data", "zone_grid.npz")
ZONE_DATA = {"zones": "sweep6.npz", "zones2": "sweep7.npz", "zones3": "sweep8.npz", "zones4": "sweep9.npz",
             "zones5": "sweep10.npz",
             "zones6": "sweep11.npz", "zones7": "sweep12.npz",
             "zones8": "sweep13.npz"}
GRID_FRAMES = ("DSC_6296", "DSC_6455", "DSC_6975", "DSC_7203")
GRID_BLENDINGS = (0, 10, 25, 50, 100)
GRID_BALANCES = (-100, -95, -85, -75, -50, -35, -20, 0, 20, 35, 50, 75, 85, 95, 100)
PAIR_BALANCES = (-75, -35, 0, 35, 75)    # the two-zone interaction grid (zones4), with GRID_BLENDINGS
ZONE_PAIRS = (("shadows", "midtone"), ("midtone", "highlights"), ("shadows", "highlights"))
GRID_HUES = (0, 90, 180, 270)            # zone color probes of zones3 (plus MASK_HUES of zones2)
TC_BALANCES = (-100, -95, -85, -75, -50, -20, 0, 20, 50, 75, 85, 95, 100)   # Balance columns with multi-hue color probes
TQ_BALANCES = (-75, -50, -20, 0, 20, 50, 75)     # Balance columns of the chroma term (zones8; clamped outside)
GRID_CHROMA = 40


def interp(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Indices and weights of the 8 trilinear interpolation knots for colors x (n, 3)."""
    u = np.clip(x, 0, 1) * (G - 1)
    i = np.clip(u.astype(int), 0, G - 2)
    f = u - i
    idx, w = [], []
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                idx.append(((i[:, 0] + dx) * G + i[:, 1] + dy) * G + i[:, 2] + dz)
                w.append(np.where(dx, f[:, 0], 1 - f[:, 0]) * np.where(dy, f[:, 1], 1 - f[:, 1])
                         * np.where(dz, f[:, 2], 1 - f[:, 2]))
    return np.stack(idx, 1), np.stack(w, 1)


def lookup(table: np.ndarray, idx: np.ndarray, w: np.ndarray) -> np.ndarray:
    return np.einsum("pj,pjc->pc", w, table[idx])


def hue_position(x: np.ndarray, k: int) -> np.ndarray:
    """Oklab hue in fractions of the circle x k."""
    ok = C.linear_to_oklab(C.srgb_to_linear(np.clip(x, 0, 1)))
    return (np.degrees(np.arctan2(ok[:, 2], ok[:, 1])) % 360) / 360 * k


def sector_weights(x: np.ndarray, table: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """Each blender color's share in the pixel: from the trained table (8, K) or from the SECTORS sectors."""
    if table is not None:
        k = table.shape[1]
        pos = hue_position(x, k) - 0.5                 # a cell's value is defined at its center
        i0 = np.floor(pos).astype(int) % k
        f = pos - np.floor(pos)
        return {c: table[i, i0] * (1 - f) + table[i, (i0 + 1) % k] * f for i, c in enumerate(np3.COLORS)}
    col = hue_position(x, 24)
    out = {}
    for items in SECTORS.values():
        raw = {}
        for c, lo, hi in items:
            pos = (col - lo) % 24
            raw[c] = np.clip(np.minimum(pos + .5, (hi - lo) % 24 - pos + .5), 0, 1)
        total = np.maximum(sum(raw.values()), 1e-9)
        out.update({c: v / total for c, v in raw.items()})
    return out


def smoothness() -> np.ndarray:
    """The squared graph Laplacian on the G^3 grid."""
    lap = np.zeros((NN, NN))
    grid = np.stack(np.meshgrid(*[np.arange(G)] * 3, indexing="ij"), -1).reshape(-1, 3)
    for k in range(3):
        for i, node in enumerate(grid):
            for d in (-1, 1):
                j = node.copy()
                j[k] += d
                if 0 <= j[k] < G:
                    lap[i, i] += 1
                    lap[i, (j[0] * G + j[1]) * G + j[2]] -= 1
    return lap.T @ lap


def regress(x: np.ndarray, coef: np.ndarray, y: np.ndarray, reg: np.ndarray) -> np.ndarray:
    """Ridge regression onto a LUT without a dense feature matrix.

    x (n, 3) colors, coef (n, B, m) basis multipliers with weights, y (n, m) targets. Returns (B, NN, m).
    """
    idx, w = interp(x)
    n, B, m_count = coef.shape
    out = []
    for m in range(m_count):
        H = np.zeros((B * NN, B * NN))
        r = np.zeros(B * NN)
        for i in range(B):
            for j in range(i, B):
                cij = coef[:, i, m] * coef[:, j, m]
                block = sum(np.bincount(idx[:, u] * NN + idx[:, v], cij * w[:, u] * w[:, v], minlength=NN * NN)
                            for u in range(8) for v in range(8)).reshape(NN, NN)
                H[i * NN:(i + 1) * NN, j * NN:(j + 1) * NN] = block
                H[j * NN:(j + 1) * NN, i * NN:(i + 1) * NN] = block.T
            r[i * NN:(i + 1) * NN] = sum(np.bincount(idx[:, u], coef[:, i, m] * w[:, u] * y[:, m], minlength=NN)
                                         for u in range(8))
        A = H / n + LAM * np.kron(np.eye(B), reg) + 1e-6 * np.eye(B * NN)
        out.append(np.linalg.solve(A, r / n).reshape(B, NN))
    return np.stack(out, -1)


def polar(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lab = C.srgb_to_lab(np.clip(x, 0, 1))
    return lab[:, 0], np.hypot(lab[:, 1], lab[:, 2]), np.arctan2(lab[:, 2], lab[:, 1])


def periodic_smoothness(k: int) -> np.ndarray:
    d2 = np.zeros((k, k))
    for i in range(k):
        d2[i, i], d2[i, (i - 1) % k], d2[i, (i + 1) % k] = -2, 1, 1
    return d2.T @ d2


def polar_delta(t: np.ndarray, L0, C0, h0) -> np.ndarray:
    L1, C1, h1 = polar(t)
    return np.stack([L1 - L0, (h1 - h0 + np.pi) % (2 * np.pi) - np.pi, np.log(C1 + 1) - np.log(C0 + 1)], 1)


def extra_frames(z) -> list[str]:
    frames = [str(f) for f in z["frames"]]
    return [f for f in frames if f in EXTRA_FRAMES.split(",")] if EXTRA_FRAMES else frames


def train_shares(blender: dict, seed: int = 0) -> np.ndarray:
    """Share table (8, SHARE_K): color response = share(hue) x set response from the LUT.

    Single color probes give the share shape, set probes at three levels keep the sum.
    The regressor comes from the model, not from the measured set probe: NX noise in the
    regressor would underestimate the shares where the response is small.
    """
    k, cols = SHARE_K, list(np3.COLORS)
    n_par = 8 * k
    H, r = np.zeros((n_par, n_par)), np.zeros(n_par)
    rng = np.random.default_rng(seed)
    tag = {"hue": "HU", "chroma": "CH", "brightness": "BR"}
    sources = [(np.load(COLORS_DATA), np.load(TRAIN), list(np.load(COLORS_DATA)["frames"]))]
    if os.path.exists(EXTRA_DATA):
        z5 = np.load(EXTRA_DATA)
        sources.append((z5, z5, extra_frames(z5)))

    def add(n, t, colors, level, attr, sign, look, base, weight):
        L0, C0, h0 = base
        y = polar_delta(t, L0, C0, h0) / level
        wc = np.minimum(C0, 60) ** 2 / 100
        W = np.stack([np.ones(len(n)), wc, wc], 1) * weight * ((t.max(1) < .99) & (t.min(1) > .004))[:, None]
        g = look[SET_OF[colors[0]], attr, sign]
        gg, gy = (g * g * W).sum(1), (g * y * W).sum(1)
        pos = hue_position(n, k) - 0.5
        i0 = np.floor(pos).astype(int) % k
        f = pos - np.floor(pos)
        terms = [(cols.index(c) * k + i0, 1 - f) for c in colors] + [(cols.index(c) * k + (i0 + 1) % k, f) for c in colors]
        for a, wa in terms:
            r[:] += np.bincount(a, wa * gy, minlength=n_par)
            for b, wb in terms:
                H[:] += np.bincount(a * n_par + b, wa * wb * gg, minlength=n_par * n_par).reshape(n_par, n_par)

    for single, sets, frames in sources:
        p_single, p_sets = list(single["profiles"]), list(sets["profiles"])
        for f in frames:
            for z, pr, kind in ((single, p_single, "single"), (sets, p_sets, "set")):
                stack = z[f].reshape(len(pr), -1, 3).astype(np.float64) / 255
                n = stack[pr.index("NEUTRAL")]
                ok = np.flatnonzero((n.max(1) < .98) & (n.min(1) > .005))
                pick = rng.choice(ok, min(SHARE_NPX, len(ok)), replace=False)
                n = n[pick]
                idx, w = interp(n)
                look = {key: lookup(v, idx, w) for key, v in blender.items()}
                base = polar(n)
                for attr in ATTRS:
                    for sg, sign in (("P", 1), ("M", -1)):
                        if kind == "single":
                            for c in cols:
                                add(n, stack[pr.index(f"C{c[:3].upper()}{tag[attr]}{sg}")][pick], [c], COLOR_LEVEL, attr, sign, look, base, 1.0)
                        else:
                            for st, items in SECTORS.items():
                                for level in LEVELS:
                                    add(n, stack[pr.index(f"{tag[attr]}{sg}{level}{st}")][pick], [c for c, _, _ in items],
                                        level, attr, sign, look, base, 1 / len(LEVELS))
    scale = np.trace(H) / n_par
    A = H / scale + SHARE_SMOOTH * np.kron(np.eye(8), periodic_smoothness(k)) + 1e-4 * np.eye(n_par)
    return np.linalg.solve(A, r / scale).reshape(8, k)


def grade_probes(paths: list[str], rng) -> dict:
    """(zone, hue) -> [(neutral, probe, chroma)] over NPX pixels of the frame."""
    out = {}
    zones = {tag: zone for zone, tag in ZONE_TAG.items()}
    for path in paths:
        z = np.load(path)
        pr = list(z["profiles"])
        for f in z["frames"]:
            stack = z[f].reshape(len(pr), -1, 3)
            pick = rng.choice(stack.shape[1], NPX, replace=False)
            n = stack[pr.index("NEUTRAL"), pick].astype(np.float64) / 255
            for i, t in enumerate(pr):
                if t[0] == "G" and "-" in t:
                    hue, chroma = t[2:].split("-")
                    out.setdefault((zones[t[1]], int(hue)), []).append((n, stack[i, pick].astype(np.float64) / 255, float(chroma)))
    return out


def hue_kernel(hue: float) -> np.ndarray:
    """Weights of the GRADE_HUES directions for hue degrees: trigonometric interpolation over 8 points."""
    d = np.radians(hue - np.array(GRADE_HUES))
    return (1 + 2 * (np.cos(d) + np.cos(2 * d) + np.cos(3 * d)) + np.cos(4 * d)) / len(GRADE_HUES)


def stacks(path: str) -> tuple[list, dict]:
    z = np.load(path)
    pr = list(z["profiles"])
    return pr, {f: z[f].reshape(len(pr), -1, 3).astype(np.float64) / 255 for f in z["frames"]}


def luma_table(pairs: list) -> np.ndarray:
    """A Y' -> Y' curve (257 points) from medians: probes that change only lightness."""
    x = np.concatenate([n @ M.LUMA for n, t in pairs])
    y = np.concatenate([t @ M.LUMA for n, t in pairs])
    edges = np.linspace(0, 1, 97)
    cx, cy = [0.0], [0.0]
    for a, b in zip(edges[:-1], edges[1:]):
        s = (x >= a) & (x < b)
        if s.sum() > 40:
            cx.append(float(np.median(x[s])))
            cy.append(float(np.median(y[s])))
    return np.interp(np.linspace(0, 1, 257), cx[1:], cy[1:])


def saturate(rgb: np.ndarray, k: float) -> np.ndarray:
    """NP3 Saturation: Cb and Cr are multiplied by k, Y' unchanged."""
    y = rgb @ YCC.T
    y[:, 1:] *= k
    return y @ YCC_INV.T


def mask_fit(d: np.ndarray, push: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Zone mask numerator and denominator over Y' bins: d ~ w(Y') * push."""
    b = np.clip((y * MASK_BINS).astype(int), 0, MASK_BINS - 1)
    return (np.bincount(b, (d * push).sum(1), MASK_BINS), np.bincount(b, (push * push).sum(1), MASK_BINS))


def train_tools(path: str = TOOLS_DATA) -> dict:
    """Saturation, tonal sliders, zone grading masks, grading brightness.

    Tonal sliders: a Y' curve at each measured level, residual 0.41-0.71 (NX noise).
    Saturation: a Cb/Cr multiplier in Y'CbCr, fitted at each level.
    Grading: each zone has a mask over neutral Y', the color offset is shared; the three zone
    masks sum to 1. Blending and Balance change only the masks. Zone brightness: a 3D table
    over neutral color per zone and sign, linear in value (trained on +-50 and +-100, residual
    0.44-0.52). A Y' shift by pixel lightness alone gave 1.4: the response depends on color.
    """
    pr, st = stacks(path)
    pr3, st3 = stacks(COLORS_DATA)
    out = {}
    tone = np.zeros((len(M.TONE), len(TONE_LEVELS), 257))
    for i, name in enumerate(M.TONE):
        for j, level in enumerate(TONE_LEVELS):
            if level == 0:
                tone[i, j] = np.linspace(0, 1, 257)
                continue
            tag = f"{name[:3].upper()}{'P' if level > 0 else 'M'}{abs(level)}"
            pairs = []
            for f, s in st.items():
                n, t = s[pr.index("NEUTRAL")], s[pr.index(tag)]
                ok = (n.max(1) < .995) & (t.max(1) < .995) & (t.min(1) > .002)
                pairs.append((n[ok], t[ok]))
            tone[i, j] = luma_table(pairs)
    out["tone"] = tone
    ks = []
    for level in SAT_LEVELS:
        if level == 0:
            ks.append(1.0)
            continue
        tag = f"SAT{'P' if level > 0 else 'M'}{abs(level)}"
        n = np.vstack([s[pr.index("NEUTRAL")][::7] for s in st.values()])
        t = np.vstack([s[pr.index(tag)][::7] for s in st.values()])
        ok = (n.max(1) < .98) & (t.max(1) < .98) & (t.min(1) > .01)
        lt = C.srgb_to_lab(t[ok])
        grid = np.linspace(0, 2.6, 261)
        err = [C.de2000(C.srgb_to_lab(np.clip(saturate(n[ok], k), 0, 1)), lt).mean() for k in grid]
        ks.append(float(grid[int(np.argmin(err))]))
    out["sat"] = np.array(ks)
    # masks: a zone's offset against the sum of the three zones with the same hue
    def push(f, hue):
        s = st3[f]
        n = s[pr3.index("NEUTRAL")]
        return n, {z: s[pr3.index(f"G{t}{hue}-40")] - n for z, t in ZONE_TAG.items()}
    def masks(probe: str | None, zone: str) -> np.ndarray:
        num, den = np.zeros(MASK_BINS), np.zeros(MASK_BINS)
        for f in st:
            n3, d3 = push(f, MASK_HUES[zone])
            total = sum(d3.values())
            if probe is None:
                d = d3[zone]
                y = n3 @ M.LUMA
            else:
                n4 = st[f][pr.index("NEUTRAL")]
                d = st[f][pr.index(probe)] - n4
                y = n4 @ M.LUMA
            a, b = mask_fit(d, total, y)
            num, den = num + a, den + b
        return num / np.maximum(den, 1e-9)
    tags = ZONE_TAG
    default = np.stack([masks(None, z) for z in np3.ZONES])
    out["mask"] = default
    blend = np.zeros((len(BLENDINGS), 3, MASK_BINS))
    bal = np.zeros((len(BALANCES), 3, MASK_BINS))
    for zi, z in enumerate(np3.ZONES):
        for j, v in enumerate(BLENDINGS):
            blend[j, zi] = default[zi] if v == 50 else masks(f"BLD{v}{tags[z]}", z)
        for j, v in enumerate(BALANCES):
            bal[j, zi] = default[zi] if v == 0 else masks(f"BAL{'P' if v > 0 else 'M'}{abs(v)}{tags[z]}", z)
    out["blend"], out["bal"] = blend, bal
    # zone brightness: a table over color per zone and sign, per unit of value / 100
    reg = smoothness()
    rng = np.random.default_rng(0)
    gbl = np.zeros((3, 2, NN, 3))
    for zi, z in enumerate(np3.ZONES):
        for si, sg in enumerate("PM"):
            xs, cs, ys = [], [], []
            for s in st.values():
                n = s[pr.index("NEUTRAL")]
                pick = rng.choice(len(n), NPX, replace=False)
                for level in (50, 100):
                    t = s[pr.index(f"GB{tags[z]}{sg}{level}")][pick]
                    ok = ((t.max(1) < .99) & (n[pick].max(1) < .99)).astype(float)
                    xs.append(n[pick])
                    ys.append((t - n[pick]) * ok[:, None])
                    cs.append(np.broadcast_to((ok * level / 100)[:, None, None], (NPX, 1, 3)))
            gbl[zi, si] = regress(np.vstack(xs), np.vstack(cs), np.vstack(ys), reg)[0]
    out["gbl"] = gbl
    return out


def data_file(name: str) -> str:
    """A training data file: data/ first, then _local/ (large sweep exports are kept out of git)."""
    p = os.path.join(HERE, "data", name)
    return p if os.path.exists(p) else os.path.join(HERE, "_local", name)


def grid_cell(t: np.ndarray, blending: float, balance: float, balances=GRID_BALANCES) -> np.ndarray:
    """Bilinear interpolation of a zone grid table t (len(GRID_BLENDINGS), len(balances), ...) at a point."""
    b = min(max(blending, GRID_BLENDINGS[0]), GRID_BLENDINGS[-1])
    l = min(max(balance, balances[0]), balances[-1])
    i = min(max(int(np.searchsorted(GRID_BLENDINGS, b, "right")) - 1, 0), len(GRID_BLENDINGS) - 2)
    j = min(max(int(np.searchsorted(balances, l, "right")) - 1, 0), len(balances) - 2)
    u = (b - GRID_BLENDINGS[i]) / (GRID_BLENDINGS[i + 1] - GRID_BLENDINGS[i])
    v = (l - balances[j]) / (balances[j + 1] - balances[j])
    return ((1 - u) * (1 - v) * t[i, j] + u * (1 - v) * t[i + 1, j]
            + (1 - u) * v * t[i, j + 1] + u * v * t[i + 1, j + 1])


def _fill_balance(t: np.ndarray, have: np.ndarray, balances=GRID_BALANCES):
    """Unmeasured cells of each Blending row: linear between measured Balance cells, nearest at the ends;
    rows with nothing measured: between the neighbour rows. t (nb, nl, ...), have (nb, nl) is updated."""
    for i in range(t.shape[0]):
        js = [j for j in range(t.shape[1]) if have[i, j]]
        if not js:
            continue
        for j in range(t.shape[1]):
            if have[i, j]:
                continue
            lo = [q for q in js if balances[q] < balances[j]]
            hi = [q for q in js if balances[q] > balances[j]]
            if lo and hi:
                a, c = lo[-1], hi[0]
                u = (balances[j] - balances[a]) / (balances[c] - balances[a])
                t[i, j] = (1 - u) * t[i, a] + u * t[i, c]
            else:
                t[i, j] = t[i, lo[-1] if lo else hi[0]]
        have[i, :] = True
    for i in range(t.shape[0]):
        if not have[i].any():
            a, c = i - 1, i + 1
            u = (GRID_BLENDINGS[i] - GRID_BLENDINGS[a]) / (GRID_BLENDINGS[c] - GRID_BLENDINGS[a])
            t[i] = (1 - u) * t[a] + u * t[c]


def _sg(v: int) -> str:
    return ("P" if v > 0 else "M") + str(abs(v))


def train_zone_grid(model: "Model", frames=GRID_FRAMES, seed: int = 0) -> dict:
    """Zone grading off Blending 50 / Balance 0 (sweep.py zones .. zones8).

    Brightness (zone z, sign s): tb[b, l, z, s] — a LUT over neutral color per unit of |value| / 100 on
    the GRID_BLENDINGS x GRID_BALANCES grid, trained like gbl on single-zone probes; the model adds
    tb(b, l) - tb(50, 0) to gbl. Cells without probes (Balance +-85/+-95 at Blending 50/100) are
    interpolated along Balance. Color (zone z): tm[b, l, z] — a shift of the zone mask over neutral Y'
    against the default model, pooled over every measured hue; tc[b, l', z, h] — a per-channel LUT
    multiplier on top of it for each of the GRADE_HUES (linear between neighbouring hues), from the
    four- and eight-hue cells (a hue without a probe at a cell takes the table of all hues there), on
    the TC_BALANCES columns (the others were only interpolated). In the hard-mask corner without pure
    color probes (Blending 10, Balance +-95) color comes from zones5 color + brightness probes against
    the brightness-only grid. Chroma: tq[b, l'', z, h] — a per-channel LUT multiplier on the color push
    times (c/40)^2 - c/40 (zero at 0 and 40) on GRID_BLENDINGS x TQ_BALANCES, from zones5 chroma 15/80
    and zones8 chroma 80 probes on four hues (linear between); it applies at Blending 50 / Balance 0
    too. NX adds the color of several zones up (zones6), so there is no color pair table.
    Two zones at once: ti[b, l', pair, signs] — a LUT of what the pair adds beyond the two single
    zones, per unit of (|va| / 100) * (|vb| / 100), on GRID_BLENDINGS x PAIR_BALANCES (zero at
    Blending 50 and 100, where single zones already add up). Cross-validated by frame (3 + 1).
    """
    packs, picks = {}, None
    rng = np.random.default_rng(seed)
    for name, f in ZONE_DATA.items():       # only the training pixels are kept: the packs are large
        z = np.load(data_file(f))
        n = len(z["profiles"])
        d = {fr: z[fr].reshape(n, -1, 3) for fr in frames}
        if picks is None:
            picks = {fr: rng.choice(d[fr].shape[1], NPX, replace=False) for fr in frames}
        packs[name] = (list(z["profiles"]), {fr: d[fr][:, picks[fr]] for fr in frames},
                       {t: np3.deserialize(bytes.fromhex(h)) for t, h in zip(z["profiles"], z["controls"])})
        del d, z
    def get(name, fr, tag):
        pr, d, _ = packs[name]
        return d[fr][pr.index(tag)].astype(np.float64) / 255
    def has(name, tag):
        return name in packs and tag in packs[name][0]
    nb, nl, npl, nh = len(GRID_BLENDINGS), len(GRID_BALANCES), len(PAIR_BALANCES), len(GRADE_HUES)
    reg = smoothness()

    def bright_probes(zt, s, b, l):
        if l == 0:
            return ([("zones", f"ZB{zt}{s}100B50", 1.0)] if b == 50 else
                    [("zones", f"ZB{zt}{s}{v}B{b}", v / 100) for v in (50, 100)])
        if abs(l) in (35, 75):
            return [("zones3", f"R{zt}{s}B{b}L{_sg(l)}", 1.0)]
        if abs(l) in (85, 95):
            out = [("zones4", f"X{zt}{s}B{b}L{_sg(l)}", 1.0)] if has("zones4", f"X{zt}{s}B{b}L{_sg(l)}") else []
            if b == 0 and abs(l) == 85:
                out.append(("zones4", f"X{zt}{s}50B0L{_sg(l)}", 0.5))
            return out
        return [("zones2", f"Q{zt}{s}B{b}L{_sg(l)}", 1.0)]

    tb = np.zeros((nb, nl, 3, 2, NN, 3))
    for zi, zone in enumerate(np3.ZONES):
        zt = ZONE_TAG[zone]
        for si, s in enumerate("PM"):
            have = np.zeros((nb, nl), bool)
            for i, b in enumerate(GRID_BLENDINGS):
                for j, l in enumerate(GRID_BALANCES):
                    probes = bright_probes(zt, s, b, l)
                    if not probes:
                        continue
                    xs, cs, ys = [], [], []
                    for fr in frames:
                        for name, tag, a in probes:
                            n = get(name, fr, "NEUTRAL")
                            t = get(name, fr, tag)
                            ok = ((t.max(1) < .99) & (n.max(1) < .99)).astype(float)
                            xs.append(n)
                            ys.append((t - n) * ok[:, None])
                            cs.append(np.broadcast_to((ok * a)[:, None, None], (len(n), 1, 3)))
                    tb[i, j, zi, si] = regress(np.vstack(xs), np.vstack(cs), np.vstack(ys), reg)[0]
                    have[i, j] = True
            _fill_balance(tb[:, :, zi, si], have)
    pix = {fr: Pixels(model, get("zones", fr, "NEUTRAL")) for fr in frames}
    tm = np.zeros((nb, nl, 3, MASK_BINS))
    tc = np.zeros((nb, nl, 3, nh, NN, 3))
    mid = (np.arange(MASK_BINS) + .5) / MASK_BINS
    # color probes that also carry zone brightness (zones5 YB) are compared against the brightness-only grid
    bonly = Model(model.blender, model.grade, model.shares, model.tools,
                  {"tb": tb, "tm": np.zeros((nb, nl, 3, MASK_BINS)),
                   "tc": np.zeros((nb, len(TC_BALANCES), 3, nh, NN, 3)), "ti": None})
    bpx = {fr: Pixels(bonly, get("zones", fr, "NEUTRAL")) for fr in frames}
    for zi, zone in enumerate(np3.ZONES):
        zt = ZONE_TAG[zone]
        have_m = np.zeros((nb, nl), bool)
        have_c = np.zeros((nb, nl), bool)
        for i, b in enumerate(GRID_BLENDINGS):
            for j, l in enumerate(GRID_BALANCES):
                if b == 50 and l == 0:
                    have_m[i, j] = have_c[i, j] = True
                    continue
                lt = _sg(l) if l else "0"
                one = [("zones2", f"QC{zt}B{b}L{lt}", MASK_HUES[zone])] if has("zones2", f"QC{zt}B{b}L{lt}") else []
                four = [(pk, f"{pre}{zt}{h}B{b}L{lt}", h) for pk, pre in (("zones3", "RC"), ("zones4", "XC"), ("zones5", "YC"), ("zones7", "VC"))
                        for h in GRADE_HUES if has(pk, f"{pre}{zt}{h}B{b}L{lt}")]
                if not four:        # the hard-mask corner has color only together with brightness
                    four = [("zones5", f"YB{zt}{h}{s}B{b}L{lt}", h) for h in GRID_HUES for s in "PM"
                            if has("zones5", f"YB{zt}{h}{s}B{b}L{lt}")]
                if not one + four:
                    continue
                items = []
                for name, tag, hue in one + four:
                    k = hue_kernel(hue)
                    for fr in frames:
                        px = pix[fr]
                        t = get(name, fr, tag)
                        ok = ((t.max(1) < .99) & (px.rgb.max(1) < .99))[:, None]
                        if tag.startswith("YB"):
                            d = (t - bpx[fr].graded(M.params_of(packs[name][2][tag]))) * ok
                        else:
                            d = (t - px.rgb - GRID_CHROMA * np.einsum("j,jnc->nc", k, px.grade[zone])) * ok
                        push = GRID_CHROMA * np.einsum("j,jnc->nc", k, px.full) * ok
                        items.append((hue if name != "zones2" else None, px, d, push))
                num, den = np.zeros(MASK_BINS), np.zeros(MASK_BINS)
                for _, px, d, push in items:
                    a, c = mask_fit(d, push, px.y)
                    num, den = num + a, den + c
                tm[i, j, zi] = num / np.maximum(den, 1e-9)
                have_m[i, j] = True
                if four:
                    def fit_tc(hues):
                        xs, cs, ys = [], [], []
                        for hue, px, d, push in items:
                            if hue in hues:
                                xs.append(px.rgb)
                                ys.append(d - np.interp(px.y, mid, tm[i, j, zi])[:, None] * push)
                                cs.append(push[:, None, :])
                        return regress(np.vstack(xs), np.vstack(cs), np.vstack(ys), reg)[0]
                    shared = fit_tc(GRADE_HUES)
                    tc[i, j, zi] = [fit_tc((h,)) if any(it[0] == h for it in items) else shared for h in GRADE_HUES]
                    have_c[i, j] = True
        _fill_balance(tm[:, :, zi], have_m)
        _fill_balance(tc[:, :, zi], have_c)
    tc = tc[:, [GRID_BALANCES.index(l) for l in TC_BALANCES]]
    # two zones at once: what a pair adds beyond the two single zones of the grid model above
    single = Model(model.blender, model.grade, model.shares, model.tools,
                   {"tb": tb, "tm": tm, "tc": tc, "ti": None})
    spx = {fr: Pixels(single, get("zones", fr, "NEUTRAL")) for fr in frames}
    ti = np.zeros((nb, npl, len(ZONE_PAIRS), 4, NN, 3))
    if "zones4" in packs:
        ctl = packs["zones4"][2]
        for pi, (za, zc) in enumerate(ZONE_PAIRS):
            for si, st in enumerate(("PP", "PM", "MP", "MM")):
                for i, b in enumerate(GRID_BLENDINGS):
                    if b >= 50:
                        continue
                    for j, l in enumerate(PAIR_BALANCES):
                        tag = f"XP{ZONE_TAG[za]}{ZONE_TAG[zc]}{st}B{b}L{_sg(l) if l else 0}"
                        if not has("zones4", tag):
                            continue
                        c = ctl[tag]
                        coef = abs(c.grade[za][2]) / 100 * abs(c.grade[zc][2]) / 100
                        xs, cs, ys = [], [], []
                        for fr in frames:
                            px = spx[fr]
                            t = get("zones4", fr, tag)
                            pred = px.graded(M.params_of(c))
                            ok = ((t.max(1) < .99) & (px.rgb.max(1) < .99)).astype(float)
                            xs.append(px.rgb)
                            ys.append((t - pred) * ok[:, None])
                            cs.append(np.broadcast_to((ok * coef)[:, None, None], (len(t), 1, 3)))
                        ti[i, j, pi, si] = regress(np.vstack(xs), np.vstack(cs), np.vstack(ys), reg)[0]
    # chroma: what is left at chroma 15 and 80 against the full grid model, per cell, zone and hue
    full = Model(model.blender, model.grade, model.shares, model.tools, {"tb": tb, "tm": tm, "tc": tc, "ti": ti})
    fpx = {fr: Pixels(full, get("zones", fr, "NEUTRAL")) for fr in frames}
    nq = len(TQ_BALANCES)
    tq = np.zeros((nb, nq, 3, len(GRID_HUES), NN, 3))
    for zi, zone in enumerate(np3.ZONES):
        have = np.zeros((nb, nq), bool)
        for i, b in enumerate(GRID_BLENDINGS):
            for j, l in enumerate(TQ_BALANCES):
                lt = _sg(l) if l else "0"
                for hi, h in enumerate(GRID_HUES):
                    probes = [(pk, f"{pre}{ZONE_TAG[zone]}{h}B{b}L{lt}") for pk, pre in
                              (("zones5", "YL"), ("zones5", "YU"), ("zones8", "UU"))]
                    probes = [(pk, tag) for pk, tag in probes if has(pk, tag)]
                    if not probes:
                        continue
                    xs, cs, ys = [], [], []
                    for pk, tag in probes:
                        c = packs[pk][2][tag]
                        for fr in frames:
                            px = fpx[fr]
                            t = get(pk, fr, tag)
                            y = px.graded(M.params_of(c))
                            ok = ((t.max(1) < .99) & (px.rgb.max(1) < .99))[:, None]
                            xs.append(px.rgb)
                            ys.append((t - y) * ok)
                            cs.append(((y - px.rgb) * _chroma_phi(c.grade[zone][1]) * ok)[:, None, :])
                    tq[i, j, zi, hi] = regress(np.vstack(xs), np.vstack(cs), np.vstack(ys), reg)[0]
                    have[i, j] = True
        _fill_balance(tq[:, :, zi], have, TQ_BALANCES)
    print("zone grid trained on", ", ".join(frames), flush=True)
    return {"tb": tb, "tm": tm, "tc": tc, "ti": ti, "tq": tq}


def _chroma_phi(chroma: float) -> float:
    """The chroma term's weight: zero at chroma 0 and GRID_CHROMA, where the linear tables are exact."""
    return (chroma / GRID_CHROMA) ** 2 - chroma / GRID_CHROMA


def _hue_table(t: np.ndarray, hue: float) -> np.ndarray:
    """t (n_hues, ...) over hues evenly spaced from 0: linear between the neighbouring two."""
    n = len(t)
    hh = (hue % 360) / (360 / n)
    h0, u = int(hh) % n, hh - int(hh)
    return (1 - u) * t[h0] + u * t[(h0 + 1) % n]


ZONE_LUTS = ("tb", "tc", "ti", "tq")     # zone grid tables of (..., NN, 3) LUTs, stored as int8


def quantize_lut(t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A stack of (NN, 3) LUTs as int8 with a float32 scale per LUT (error under 1/254 of its largest
    value: below 0.3/255 in sRGB for the zone grid)."""
    s = (np.abs(t).max(axis=(-2, -1)) / 127).astype(np.float32)
    q = np.round(t / np.where(s > 0, s, 1)[..., None, None]).astype(np.int8)
    return q, s


def save_zone_grid(g: dict, path: str = ZONE_GRID):
    """tm as float16, the LUT tables as int8 + scales (quantize_lut): the web export ships the same
    rounded values, so Python and the browser agree."""
    luts = {}
    for k in ZONE_LUTS:
        if g.get(k) is not None:
            luts[k + "_q"], luts[k + "_s"] = quantize_lut(g[k])
    np.savez(path, tm=g["tm"].astype(np.float16), **luts,
             blendings=np.array(GRID_BLENDINGS), balances=np.array(GRID_BALANCES),
             pair_balances=np.array(PAIR_BALANCES), tc_balances=np.array(TC_BALANCES),
             tq_balances=np.array(TQ_BALANCES))


def load_zone_grid(path: str = ZONE_GRID) -> dict | None:
    if not os.path.exists(path):
        return None
    z = np.load(path)
    if (tuple(z["blendings"]) != GRID_BLENDINGS or tuple(z["balances"]) != GRID_BALANCES
            or ("ti_q" in z.files and tuple(z["pair_balances"]) != PAIR_BALANCES)
            or "tc_balances" not in z.files or tuple(z["tc_balances"]) != TC_BALANCES or "tb_q" not in z.files or "tc_q" not in z.files
            or "tq_balances" not in z.files or tuple(z["tq_balances"]) != TQ_BALANCES):
        print(f"{path}: grid axes differ from the code, retrain with `python3 profile_model.py zones`", file=sys.stderr)
        return None
    g = {"tm": z["tm"].astype(np.float64)}
    for k in ZONE_LUTS:
        g[k] = (z[k + "_q"].astype(np.float64) * z[k + "_s"].astype(np.float64)[..., None, None]
                if k + "_q" in z.files else None)
    return g


class Model:
    def __init__(self, blender: dict, grade: dict, shares: np.ndarray | None = None, tools: dict | None = None,
                 zgrid: dict | None = None):
        self.blender = blender      # (set, attribute, sign) -> (NN, 3): dL, dhue (rad), dln(C+1) per unit
        self.grade = grade          # zone -> (8, NN, 3): sRGB offset per chroma unit along GRADE_HUES
        self.shares = shares        # (8, SHARE_K): blender color share over hue; None = SECTORS sectors
        self.tools = tools          # train_tools: Saturation, tonal sliders, zone masks and brightness; None = without them
        self.zgrid = zgrid          # train_zone_grid: tb, tm, tc; None = the tools masks off Blending 50 / Balance 0

    def weights(self, x: np.ndarray) -> dict[str, np.ndarray]:
        return sector_weights(x, self.shares)

    @classmethod
    def train(cls, path: str = TRAIN, seed: int = 0) -> "Model":
        z = np.load(path)
        profiles = list(z["profiles"])
        rng = np.random.default_rng(seed)
        reg = smoothness()
        data = {}
        for f in z["frames"]:
            stack = z[f].reshape(len(profiles), -1, 3)
            pick = rng.choice(stack.shape[1], NPX, replace=False)
            data[f] = {t: stack[i, pick].astype(np.float64) / 255 for i, t in enumerate(profiles)}
        if os.path.exists(EXTRA_DATA):
            z5 = np.load(EXTRA_DATA)
            p5 = list(z5["profiles"])
            for f in extra_frames(z5):
                stack = z5[f].reshape(len(p5), -1, 3)
                pick = rng.choice(stack.shape[1], NPX, replace=False)
                data["sa_" + f] = {t: stack[i, pick].astype(np.float64) / 255 for i, t in enumerate(p5)}

        def usable(t, n):
            return (t.max(1) < .99) & (n.max(1) < .99) & (t.min(1) > .004)

        blender = {}
        for st in SECTORS:
            for attr in ATTRS:
                for sign in (1, -1):
                    xs, ys, ws = [], [], []
                    for d in data.values():
                        n = d["NEUTRAL"]
                        L0, C0, h0 = polar(n)
                        weight = np.minimum(C0, 60) ** 2 / 100     # hue and chroma weigh like a shift in a, b
                        for level in LEVELS:
                            t = d[f"{attr[:2].upper()}{'P' if sign > 0 else 'M'}{level}{st}"]
                            L1, C1, h1 = polar(t)
                            ok = usable(t, n)
                            ys.append(np.stack([L1 - L0, (h1 - h0 + np.pi) % (2 * np.pi) - np.pi,
                                                np.log(C1 + 1) - np.log(C0 + 1)], 1)[ok] / level)
                            ws.append(np.stack([np.ones(len(n)), weight, weight], 1)[ok])
                            xs.append(n[ok])
                    sw = np.sqrt(np.vstack(ws))
                    blender[st, attr, sign] = regress(np.vstack(xs), sw[:, None, :], np.vstack(ys) * sw, reg)[0]
        probes = grade_probes([path] + ([COLORS_DATA] if os.path.exists(COLORS_DATA) else []), rng)
        grade = {}
        for zone in ZONE_TAG:
            tables = []
            for hue in GRADE_HUES:
                xs, cs, ys = [], [], []
                for n, t, chroma in probes[zone, hue]:
                    ok = usable(t, n).astype(float)
                    xs.append(n)
                    ys.append((t - n) * ok[:, None])
                    cs.append(np.broadcast_to((ok * chroma / 40)[:, None, None], (len(n), 1, 3)))
                tables.append(regress(np.vstack(xs), np.vstack(cs), np.vstack(ys), reg)[0] / 40)
            grade[zone] = np.stack(tables)
        shares = train_shares(blender, seed) if os.path.exists(COLORS_DATA) else None
        tools = train_tools() if os.path.exists(TOOLS_DATA) else None
        return cls(blender, grade, shares, tools)

    def save(self, path: str = PATH):
        np.savez(path, **{f"b_{s}_{a}_{g}": v for (s, a, g), v in self.blender.items()},
                 **{f"g_{z}": v for z, v in self.grade.items()},
                 **({"shares": self.shares} if self.shares is not None else {}),
                 **({f"t_{k}": v for k, v in self.tools.items()} if self.tools else {}))

    @classmethod
    def load(cls, path: str = PATH) -> "Model":
        z = np.load(path)
        blender = {(k.split("_")[1], k.split("_")[2], int(k.split("_")[3])): z[k] for k in z.files if k.startswith("b_")}
        tools = {k[2:]: z[k] for k in z.files if k.startswith("t_")} or None
        return cls(blender, {k[2:]: z[k] for k in z.files if k.startswith("g_")},
                   z["shares"] if "shares" in z.files else None, tools, load_zone_grid())

    def mask(self, y: np.ndarray, zone: int, blending: float, balance: float) -> np.ndarray:
        """Zone mask over Y': default plus Blending and Balance shifts, interpolation by level."""
        t = self.tools
        mid = (np.arange(MASK_BINS) + .5) / MASK_BINS
        w = t["mask"][zone].copy()
        if blending != 50:
            w += np.array([np.interp(blending, BLENDINGS, t["blend"][:, zone, b]) for b in range(MASK_BINS)]) - t["mask"][zone]
        if balance != 0:
            w += np.array([np.interp(balance, BALANCES, t["bal"][:, zone, b]) for b in range(MASK_BINS)]) - t["mask"][zone]
        return np.interp(y, mid, np.maximum(w, 0))

    def tone_curve(self, p: M.Params) -> np.ndarray | None:
        """The NP3 curve: its own if set, otherwise from the tonal sliders (sum of shifts)."""
        if p.curve is not None:
            return p.curve
        if not self.tools or not any(p.tone.values()):
            return None
        g = np.linspace(0, 1, 257)
        out = g.copy()
        for i, name in enumerate(M.TONE):
            v = p.tone.get(name, 0)
            if v:
                tab = np.array([np.interp(v, TONE_LEVELS, self.tools["tone"][i, :, k]) for k in range(257)])
                out += tab - g
        return np.clip(out, 0, 1)

    def saturation(self, s: float) -> float:
        return float(np.interp(s, SAT_LEVELS, self.tools["sat"])) if self.tools else 1.0

    def __call__(self, rgb: np.ndarray, c: np3.Control) -> np.ndarray:
        """Neutral sRGB (n, 3) -> frame with profile c."""
        return Pixels(self, rgb)(M.params_of(c))


class Pixels:
    """Neutral with everything that does not depend on the sliders precomputed.

    Order: grading (zone color by masks and zone brightness) -> Saturation -> blender -> curve
    (own or from tonal sliders). The fit calls the model hundreds of times on the same pixels:
    blender inputs are cached on everything before it, the pre-curve result also on the blender.
    The numerical jacobian moves one parameter at a time; the heavy part comes from memory.
    """
    CACHE = 8

    def __init__(self, model: Model, rgb: np.ndarray):
        self.model, self.rgb = model, rgb
        gi, gw = interp(rgb)
        self.gi, self.gw = gi, gw
        self.grade = {zone: np.stack([lookup(t, gi, gw) for t in model.grade[zone]]) for zone in np3.ZONES}
        self.full = sum(self.grade.values())          # offset of all three zones: shared, without masks
        self.y = rgb @ M.LUMA
        self.keys = list(model.blender)
        self.stack = np.concatenate([model.blender[k] for k in self.keys], 1)
        self.inputs, self.before, self.masks = {}, {}, {}
        tools = model.tools or {}
        self.bright = np.stack([[lookup(tools["gbl"][z, s], gi, gw) for s in range(2)] for z in range(3)]) if "gbl" in tools else None
        self.plain = self.blender_inputs(rgb)

    def blender_inputs(self, rgb: np.ndarray) -> tuple:
        idx, w = interp(rgb)
        flat = np.einsum("pj,pjc->pc", w, self.stack[idx])
        look = {k: flat[:, 3 * i:3 * i + 3] for i, k in enumerate(self.keys)}
        return self.model.weights(rgb), polar(rgb), look

    def mask_delta(self, zone: int, p: M.Params) -> np.ndarray | None:
        """Zone mask minus the default mask, per pixel; None at Blending 50 and Balance 0."""
        if not self.model.tools or (p.blending == 50 and p.balance == 0):
            return None
        key = (zone, float(p.blending), float(p.balance))
        if key not in self.masks:
            d = self.model.mask(self.y, zone, p.blending, p.balance) - self.model.mask(self.y, zone, 50, 0)
            self.masks[key] = d
        return self.masks[key]

    def graded(self, p: M.Params) -> np.ndarray:
        out = self.rgb
        zg = self.model.zgrid
        if zg is not None and (p.blending != 50 or p.balance != 0):
            return self.graded_grid(p, zg)
        for zi, zone in enumerate(np3.ZONES):
            hue, chroma = p.grade[zone][0], p.grade[zone][1]
            if chroma:
                k = hue_kernel(hue)
                dc = chroma * np.einsum("j,jnc->nc", k, self.grade[zone])
                d = self.mask_delta(zi, p)
                if d is not None:
                    dc = dc + chroma * d[:, None] * np.einsum("j,jnc->nc", k, self.full)
                out = out + self.chroma_term(dc, zi, hue, chroma, zg, p)
            v = p.grade_bright.get(zone, 0) if self.bright is not None else 0
            if v:
                si = 0 if v > 0 else 1
                out = out + abs(v) / 100 * self.bright[zi, si]
                d = self.mask_delta(zi, p)
                if d is not None:
                    out = out + abs(v) / 100 * d[:, None] * self.bright[:, si].sum(0)
        return out

    def graded_grid(self, p: M.Params, zg: dict) -> np.ndarray:
        """Zone grading off Blending 50 / Balance 0 through the zone grid (train_zone_grid)."""
        out = self.rgb
        i50, j0 = GRID_BLENDINGS.index(50), GRID_BALANCES.index(0)
        mid = (np.arange(MASK_BINS) + .5) / MASK_BINS
        tm = grid_cell(zg["tm"], p.blending, p.balance)
        tc = tb = None
        for zi, zone in enumerate(np3.ZONES):
            hue, chroma = p.grade[zone][0], p.grade[zone][1]
            if chroma:
                k = hue_kernel(hue)
                if tc is None:
                    tc = grid_cell(zg["tc"], p.blending, p.balance, TC_BALANCES)
                w = np.interp(self.y, mid, tm[zi])[:, None] + lookup(_hue_table(tc[zi], hue), self.gi, self.gw)
                dc = chroma * np.einsum("j,jnc->nc", k, self.grade[zone]) + chroma * w * np.einsum("j,jnc->nc", k, self.full)
                out = out + self.chroma_term(dc, zi, hue, chroma, zg, p)
            v = p.grade_bright.get(zone, 0) if self.bright is not None else 0
            if v:
                si = 0 if v > 0 else 1
                if tb is None:
                    tb = grid_cell(zg["tb"], p.blending, p.balance) - zg["tb"][i50, j0]
                out = out + abs(v) / 100 * (self.bright[zi, si] + lookup(tb[zi, si], self.gi, self.gw))
        if zg.get("ti") is not None:
            ti = None
            for pi, (za, zc) in enumerate(ZONE_PAIRS):
                va, vc = p.grade_bright.get(za, 0), p.grade_bright.get(zc, 0)
                if va and vc and self.bright is not None:
                    if ti is None:
                        ti = grid_cell(zg["ti"], p.blending, p.balance, PAIR_BALANCES)
                    si = (0 if va > 0 else 2) + (0 if vc > 0 else 1)
                    out = out + abs(va) / 100 * abs(vc) / 100 * lookup(ti[pi, si], self.gi, self.gw)
        return out

    def chroma_term(self, dc: np.ndarray, zi: int, hue: float, chroma: float, zg: dict | None,
                    p: M.Params) -> np.ndarray:
        """A zone's color push dc with the chroma correction (zone grid tq at the cell), if there is one."""
        if zg is None or zg.get("tq") is None or chroma == GRID_CHROMA:
            return dc
        tq = grid_cell(zg["tq"][:, :, zi], p.blending, p.balance, TQ_BALANCES)
        return dc * (1 + _chroma_phi(chroma) * lookup(_hue_table(tq, hue), self.gi, self.gw))

    @staticmethod
    def remember(cache: dict, key, make):
        if key not in cache:
            if len(cache) >= Pixels.CACHE:
                cache.pop(next(iter(cache)))
            cache[key] = make()
        return cache[key]

    def front_key(self, p: M.Params) -> tuple:
        return (tuple(float(v) for z in np3.ZONES for v in p.grade[z][:2]),
                tuple(float(p.grade_bright.get(z, 0)) for z in np3.ZONES),
                float(p.blending), float(p.balance), float(p.saturation))

    def toned(self, p: M.Params) -> tuple:
        sat = self.model.saturation(p.saturation) if p.saturation else 1.0
        plain = (not any(p.grade[z][1] for z in np3.ZONES) and not any(p.grade_bright.values()) and sat == 1.0)
        if plain:
            return self.rgb, self.plain
        def make():
            rgb = np.clip(self.graded(p), 0, 1)
            if sat != 1.0:
                rgb = np.clip(saturate(rgb, sat), 0, 1)
            return rgb, self.blender_inputs(rgb)
        return self.remember(self.inputs, self.front_key(p), make)

    def before_curve(self, p: M.Params) -> np.ndarray:
        key = (self.front_key(p), tuple(float(v) for c in np3.COLORS for v in p.blender[c]))
        def make():
            rgb, (share, (L0, C0, h0), look) = self.toned(p)
            d = np.zeros((len(rgb), 3))
            for color in np3.COLORS:
                for k, attr in enumerate(ATTRS):
                    v = p.blender[color][k]
                    if v:
                        d += abs(v) * share[color][:, None] * look[SET_OF[color], attr, int(np.sign(v))]
            if not d.any():
                return rgb
            C1 = np.maximum((C0 + 1) * np.exp(d[:, 2]) - 1, 0)
            h1 = h0 + d[:, 1]
            return np.clip(C.lab_to_srgb(np.stack([L0 + d[:, 0], C1 * np.cos(h1), C1 * np.sin(h1)], 1)), 0, 1)
        return self.remember(self.before, key, make)

    def __call__(self, p: M.Params) -> np.ndarray:
        return np.clip(M.apply_curve(self.before_curve(p), self.model.tone_curve(p)), 0, 1)


def check(model: Model, path: str = CHECK):
    """dE against NX exports by groups; real NX neutral goes in."""
    import render
    old = render.Renderer(profile="patches")
    z = np.load(path)
    profiles = list(z["profiles"])
    controls = [np3.deserialize(bytes.fromhex(h)) for h in z["controls"]]
    groups = {}
    for f in z["frames"]:
        stack = z[f][:, ::2, ::2].reshape(len(profiles), -1, 3).astype(np.float64) / 255
        n = stack[profiles.index("NEUTRAL")]
        for i, t in enumerate(profiles):
            if t == "NEUTRAL":
                continue
            lab = C.srgb_to_lab(stack[i])
            g = "finished" if t.startswith("R-") else "combinations" if t.startswith("RND") else "pairs"
            groups.setdefault(g, []).append([C.de2000(C.srgb_to_lab(x), lab).mean() for x in
                                             (old.apply(n.astype(np.float32), controls[i]).astype(np.float64), model(n, controls[i]), n)])
    print("group          probes  old    new    no model")
    for g, v in sorted(groups.items()):
        m = np.mean(v, 0)
        print(f"{g:14s} {len(v):4d}   {m[0]:5.2f}  {m[1]:5.2f}  {m[2]:5.2f}")


def main():
    if sys.argv[1:] == ["zones"]:
        g = train_zone_grid(Model.load(PATH))
        save_zone_grid(g)
        print("file:", ZONE_GRID)
        return
    model = Model.train()
    model.save()
    print("file:", PATH)
    if os.path.exists(CHECK):
        check(model)


if __name__ == "__main__":
    main()
