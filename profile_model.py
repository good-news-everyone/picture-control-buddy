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
"""
from __future__ import annotations

import os
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


class Model:
    def __init__(self, blender: dict, grade: dict, shares: np.ndarray | None = None, tools: dict | None = None):
        self.blender = blender      # (set, attribute, sign) -> (NN, 3): dL, dhue (rad), dln(C+1) per unit
        self.grade = grade          # zone -> (8, NN, 3): sRGB offset per chroma unit along GRADE_HUES
        self.shares = shares        # (8, SHARE_K): blender color share over hue; None = SECTORS sectors
        self.tools = tools          # train_tools: Saturation, tonal sliders, zone masks and brightness; None = without them

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
                   z["shares"] if "shares" in z.files else None, tools)

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
        tools = self.model.tools
        for zi, zone in enumerate(np3.ZONES):
            hue, chroma = p.grade[zone][0], p.grade[zone][1]
            if chroma:
                k = hue_kernel(hue)
                out = out + chroma * np.einsum("j,jnc->nc", k, self.grade[zone])
                d = self.mask_delta(zi, p)
                if d is not None:
                    out = out + chroma * d[:, None] * np.einsum("j,jnc->nc", k, self.full)
            v = p.grade_bright.get(zone, 0) if self.bright is not None else 0
            if v:
                si = 0 if v > 0 else 1
                out = out + abs(v) / 100 * self.bright[zi, si]
                d = self.mask_delta(zi, p)
                if d is not None:
                    out = out + abs(v) / 100 * d[:, None] * self.bright[:, si].sum(0)
        return out

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
    model = Model.train()
    model.save()
    print("file:", PATH)
    if os.path.exists(CHECK):
        check(model)


if __name__ == "__main__":
    main()
