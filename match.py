"""Fits an NP3 from "NEF + finished shot with the preset" pairs. NX Studio is not needed.

The trained development turns the NEF into the Nikon neutral (with vignette correction, as in
render.py), then the step-based profile model (profile_model.py, trained on NX exports) fits
the blender, grading and curve.

    python3 match.py --analyze name [--adl Off] a.NEF a.jpg [b.NEF b.jpg ...]
    python3 match.py [name] a.NEF a.jpg [b.DNG b.jpg ...]
    python3 match.py --refine [new] prev render_a.TIF a.jpg [render_b.TIF b.jpg ...]
    python3 match.py --scene name a.NEF a.jpg [b.NEF b.jpg ...]
    python3 match.py --scene-refine [new] prev render_a.TIF a.jpg [render_b.TIF b.jpg ...]
    python3 match.py --chart name folder|patches.npz [--hold sheet=N|series=N|ev=N] [--groups 1.5]

The --scene mode is for different shots of one scene, possibly from another camera: frames are
aligned by edges, only even blocks are compared, XMP is not used.

The --chart mode fits from shots of printed sheets of print_chart.py taken by two cameras
(charts.py finds the sheets and pairs, spec/charts.md in the np3-fit-charts project). --hold
reserves a sheet, a light series or an exposure for validation, --groups sets the weight of
skin, sky, foliage and brights. The charts project must sit next to this repository.

The second mode corrects the previous version against a real render: the prediction is that
render plus the model difference between the new and the previous profile, so development
and model errors hardly enter the fit. The neutral for the difference is taken from the NEF
if it is known from pairs.json, otherwise it is recovered from the render by inverting the
model. "Previous" is the profile the render was made with. Without a new name the result goes
to prev_r1, then _r2.

--analyze inspects candidates: target color group shares, lightness, ADL, suitability, and
recommends a set of frames that covers the colors (out/<name>/analysis.json). The draft adds
its own frames to this file, and --refine advises which frame renders to add to the correction.

Rare colors weigh more in the fit (analyze.rarity); the error report goes by regions.

Custom white balance and exposure from the finished shot's XMP are taken out of the fit:
they are applied to the source, so they do not land in the profile.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys

import numpy as np
from PIL import Image

import analyze as A
import color as C
import devmodel
import devpairs
import fit as F
import model as M
import np3
import pairs as pairs_mod
import profile_model as P
import scene
import wbmap

HERE = F.HERE
CACHE = os.path.join(HERE, "data", "match")
CACHE_VERSION = "v2"     # v2: vignetting removed before the crop
INVERT_STEPS = 8         # model inversion iterations: neutral from a render
PIXELS = 4000
BRIGHT = 800
MIN_TARGET = 1000    # less than this, the target is probably a preview inside a DNG
MIN_CHROMA = 15      # a colorful pixel
MIN_SHARE = 0.01     # less than this share of a color in the frames counts as absent
MIN_SKY = 0.03       # sky share in the fitting frames; below this blues are fitted unreliably
TRUST = 0.03        # the correction does not move far from the validated version
NX = F.NB + F.NG + F.NC      # blender, grading, curve; then the remaining sliders
EXTRA_DEFAULT = np.array([0.0, 0.0, 0.0, 0.0, 50.0, 0.0])   # Saturation, zone brightness H/M/S, Blending, Balance
EXTRA_LOW = np.array([-100, -100, -100, -100, 0, -100.0])
EXTRA_HIGH = np.array([100, 100, 100, 100, 100, 100.0])
CLIP = .98            # a target channel at or above this counts as pinned in white
NEAR_WHITE = .8       # light almost grey: the darkest target channel at or above this
CLIP_PIXELS = 3000    # such pixels per pair: at the curve's white knee they are the majority
RING = 0.02          # neighboring colors of the wheel pull towards each other: a color stays not random outside the frames
# The fit residual is over dE2000 components with weights at the target color, not a Lab difference (dE76):
# in dE76 a hue shift of blues costs almost nothing, and the sky drifted into magenta.
KC = 0.5            # chroma weight of dE2000: below 1 is stricter on chroma; at 1 the sky paled
FLAT_L = True       # lightness without the dE2000 SL: the curve's white knee holds as in dE76
# Cauchy loss on each pixel's weighted dE (the sample multiplier taken out): pixels the profile cannot
# reach (local edits of the target, alignment) pull less. c = 6: -0.05..-0.07 dE on held-out frames.
ROBUST = 6.0
# Starts of the fit. The first always runs; the others only when it got stuck (fewer than STUCK
# accepted iterations: with the old zone model LM stopped after 2 on 17 pairs, and zone brightness
# shadows -50 / midtone +30 took it out: 3.55 -> 3.20 on them, 3.54 -> 3.31 held out). The lower
# final cost wins. With the zone grid model no run of 18 got stuck (10-30 iterations), and a second
# start on every fit only traded held-out quality for train cost (0.5% lower cost, +0.07 dE held out).
STARTS = {"zero": {}, "zones": {"shadows": -50.0, "midtone": 30.0}}
STUCK = 5


def prepared(nef: str, target: str) -> dict:
    """An aligned pair, cached by paths and file sizes."""
    key = hashlib.sha1(f"{nef}|{target}|{os.path.getsize(target)}|{CACHE_VERSION}".encode()).hexdigest()[:16]
    path = os.path.join(CACHE, f"{os.path.basename(nef)[:-4]}-{key}.npz")
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        np.savez_compressed(path, **devpairs.build(nef, target, devignette=True))
    d = np.load(path)
    return {"name": os.path.basename(nef)[:-4], "x": d["x"].astype(np.float64).reshape(-1, 3),
            "t": d["y"].astype(np.float64).reshape(-1, 3), "ncc": float(d["ncc"])}


def edit_gain(nef: str, target: str) -> tuple[np.ndarray, str]:
    """Linear RGB coefficients that reproduce the finished shot's WB and exposure."""
    x = pairs_mod.xmp_values(Image.open(target))
    g, notes = np.ones(3), []
    if x.get("WhiteBalance", "As Shot") != "As Shot" and "Temperature" in x:
        w = np.array(json.load(open(wbmap.PATH)))
        d = wbmap.predict(w, float(x["Temperature"]), float(x["Tint"])) - wbmap.multipliers(nef)
        g[0], g[2] = np.exp(d)
        notes.append(f"WB {x['Temperature']} K, {x['Tint']} (R x{g[0]:.3f}, B x{g[2]:.3f})")
    ev = float(x.get("Exposure2012") or 0)
    if ev:
        g = g * 2 ** ev
        notes.append(f"exposure {ev:+.2f}")
    return g, ", ".join(notes)


def full(x: np.ndarray) -> np.ndarray:
    """Parameter vector with the remaining-sliders tail: old x.npy files do not have it."""
    return x if len(x) > NX else np.r_[x, EXTRA_DEFAULT]


def unpack(x: np.ndarray) -> M.Params:
    p = F.unpack(x[:NX])
    e = np.clip(full(x)[NX:], EXTRA_LOW, EXTRA_HIGH)
    p.saturation = float(e[0])
    p.grade_bright = {z: float(v) for z, v in zip(np3.ZONES, e[1:4])}
    p.blending, p.balance = float(e[4]), float(e[5])
    return p


def knots(x: np.ndarray) -> np.ndarray:
    return F.knots(x[F.NB + F.NG:NX])


def extra_penalty(x: np.ndarray, anchor: np.ndarray | None = None) -> np.ndarray:
    """Pull of the remaining sliders towards the defaults or towards the previous version."""
    return F.RIDGE * (full(x)[NX:] - (EXTRA_DEFAULT if anchor is None else full(anchor)[NX:]))


def control(x: np.ndarray, name: str) -> np3.Control:
    c = F.control(x[:NX], name)
    p = unpack(x)
    c.saturation = int(round(p.saturation))
    c.grade = {z: (h, ch, int(round(p.grade_bright[z]))) for z, (h, ch, _) in c.grade.items()}
    c.blending, c.balance = int(round(p.blending)), int(round(p.balance))
    return c


def robust(r: np.ndarray, sm: np.ndarray) -> np.ndarray:
    """Cauchy rescaling of weighted residual rows r (n, 3) whose sample multipliers are sm (n,):
    the row norm e = |r| / sm becomes sqrt(c^2 log(1 + e^2 / c^2)), the direction is kept."""
    if not ROBUST:
        return r
    e = np.sqrt((r * r).sum(1)) / sm
    c = ROBUST
    s = np.where(e > 1e-9, np.sqrt(c * c * np.log1p(e * e / (c * c))) / np.maximum(e, 1e-9), 1.0)
    return r * s[:, None]


def start(name: str) -> np.ndarray:
    """The initial vector of a STARTS entry: zero blender/grade, linear curve, default sliders."""
    x = np.r_[np.zeros(F.NB + F.NG), np.r_[0.0, np.diff(F.XS)], EXTRA_DEFAULT]
    for z, v in STARTS[name].items():
        x[NX + 1 + np3.ZONES.index(z)] = v
    return x


def sample(a: np.ndarray, t: np.ndarray, rng, freq: np.ndarray | None = None,
           trust: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Indices for the fit (biased towards highlights), their weight multipliers and indices for scoring (uniform).

    With the set's color bin frequencies freq, rare colors are sampled more often, and the
    multiplier gives them the analyze.rarity weight: 4000 random pixels gave about 16 samples
    of skin on 7155. trust (0..1 per pixel) is confidence in the development: rare colors are
    known worse by the development, and without it the fit would learn its error (vest 7155 is
    C +11.7 more saturated than NX for us, the profile was damping it).
    """
    keep = np.flatnonzero(t.max(1) < .98)
    bright = keep[(a[keep] @ M.LUMA > F.BRIGHT_Y) | (a[keep].max(1) >= .98)]
    if freq is None:
        pick = rng.choice(keep, min(PIXELS, len(keep)), replace=False)
        mult = np.ones(len(pick))
    else:
        w = A.rarity(freq, C.srgb_to_lab(t[keep])) * (1 if trust is None else trust[keep])
        ok = np.flatnonzero(w > 0)
        i, mult = A.weighted_sample(w[ok], PIXELS, rng)
        pick = keep[ok[i]]
    if len(bright):
        extra = rng.choice(bright, min(BRIGHT, len(bright)), replace=False)
        pick, mult = np.r_[pick, extra], np.r_[mult, np.ones(len(extra))]
    return pick, mult, rng.choice(len(t), min(3000, len(t)), replace=False)


def target_frequency(targets: list[np.ndarray]) -> np.ndarray:
    return A.frequency([C.srgb_to_lab(t[t.max(1) < .98]) for t in targets])


class Pair:
    def __init__(self, raw: dict, dev: devmodel.Dev, model: P.Model, rng, gain=np.ones(3), freq=None, density=None):
        self.name, self.ncc = raw["name"], raw["ncc"]
        b, t = dev(raw["x"] * gain), raw["t"]
        self.fb, self.ft = b, t                     # whole frame: region analysis and report
        trust = dev.trust(raw["x"] * gain, density) if freq is not None else None
        pick, mult, test = sample(b, t, rng, freq, trust)
        self.b, self.t = b[pick], t[pick]
        self.tlab = C.srgb_to_lab(self.t)
        self.sm = np.sqrt(mult)
        self.W = C.de2000_weights(self.tlab, KC, FLAT_L) * self.sm[:, None, None]
        self.px = P.Pixels(model, self.b)
        self.tb, self.tt = b[test], t[test]
        self.ttlab = C.srgb_to_lab(self.tt)
        self.tpx = P.Pixels(model, self.tb)
        # Light almost-grey pixels with a target channel pinned at the ceiling. The main sample
        # throws them out, and at the curve's white knee only pixels with a lower output remain:
        # the curve ended up 0.05 below the original. A pinned channel is penalized one way
        # (prediction not darker), the rest as usual. Saturated colors are not here: they have
        # one channel at the ceiling, and the penalty pulled the FIT4 curve up because of a
        # color error of the model.
        clip = np.flatnonzero((t.max(1) >= CLIP) & (t.min(1) >= NEAR_WHITE))
        clip = rng.choice(clip, min(CLIP_PIXELS, len(clip)), replace=False) if len(clip) else clip
        self.cpx = P.Pixels(model, b[clip]) if len(clip) else None
        self.ct = t[clip]
        self.cmask = self.ct >= CLIP


class Points(Pair):
    """Color pairs without a frame: scene blocks or chart patches."""

    def __init__(self, name: str, b: np.ndarray, t: np.ndarray, model: P.Model, ncc: float):
        self.name, self.ncc = name, ncc
        self.set(b, t, model)

    def set(self, b, t, model):
        self.b, self.t = b, t
        self.tlab = C.srgb_to_lab(t)
        self.W = C.de2000_weights(self.tlab, KC, FLAT_L)
        self.sm = np.ones(len(b))
        self.px = P.Pixels(model, b)
        self.tb, self.tt, self.tpx, self.ttlab = b, t, self.px, self.tlab
        self.cpx = None


class Matcher:
    def __init__(self, seed=0):
        self.model = P.Model.load()
        self.dev = devmodel.Dev.load(devmodel.RENDER)
        self.density = devmodel.load_density()
        self.rng = np.random.default_rng(seed)

    def pair(self, raw: dict, gain=np.ones(3), freq=None) -> Pair:
        return Pair(raw, self.dev, self.model, self.rng, gain, freq, self.density)

    def predict(self, q: Pair, p: M.Params, test=False) -> np.ndarray:
        return (q.tpx if test else q.px)(p)

    def score(self, q: Pair, p: M.Params) -> float:
        return float(C.de2000(C.srgb_to_lab(self.predict(q, p, True)), q.ttlab).mean())

    def fit(self, pairs: list[Pair], iters=30) -> np.ndarray:
        """LM from the first STARTS entry, from the others only if it got stuck (STUCK); the lowest
        cost wins (its name lands in self.init, the costs of the starts run in self.starts)."""
        def fn(x):
            p = unpack(x)
            r = [robust(C.weighted(q.W, C.srgb_to_lab(q.px(p)) - q.tlab), q.sm).ravel()
                 / np.sqrt(len(q.b) * len(pairs)) for q in pairs]
            r += [(100 * np.where(q.cmask, np.minimum(q.cpx(p) - q.ct, 0), q.cpx(p) - q.ct)).ravel()
                  / np.sqrt(len(q.b) * len(pairs)) for q in pairs if q.cpx is not None]
            k = knots(x)
            b = x[:F.NB].reshape(8, 3)
            return np.r_[np.concatenate(r), F.SMOOTH * 100 * np.diff(k, 2) * F.BEND,
                         F.RIDGE * x[:F.NB + F.NG], RING * (b - np.roll(b, 1, 0)).ravel(), F.WHITE * (k[-1] - 1),
                         extra_penalty(x)]

        runs = {}
        for name in STARTS:
            info = {}
            runs[name] = F.lm(fn, start(name), iters, info)
            if info["run"] >= STUCK:
                break
        self.starts = {name: float(cost) for name, (_, cost) in runs.items()}
        self.init = min(runs, key=lambda k: runs[k][1])
        return runs[self.init][0]


def write(name: str, x: np.ndarray) -> tuple[np3.Control, str]:
    ctrl = control(x, "NPF-" + name.upper()[-15:])   # end of the name: the frame and the correction number live there
    out = os.path.join(HERE, "out", name, "NIKON", "CUSTOMPC")
    os.makedirs(out, exist_ok=True)
    data = np3.serialize(ctrl)
    assert np3.serialize(np3.deserialize(data)) == data
    open(os.path.join(out, "PICCON01.NP3"), "wb").write(data)
    np.save(os.path.join(HERE, "out", name, "x.npy"), x)
    return ctrl, os.path.join(out, "PICCON01.NP3")


def invert(model: P.Model, a: np.ndarray, p: M.Params) -> np.ndarray:
    """The neutral that the model with profile p turns into the render a."""
    n = a.copy()
    for _ in range(INVERT_STEPS):
        n = np.clip(n + a - P.Pixels(model, n)(p), 0, 1)
    return n


class Rendered:
    """Pixels of the real render of the previous version and of the target.

    Prediction for profile p: render + model(n1, p) - model(n0, p0). n0 is the render's
    neutral, n1 is the same with the target's WB and exposure corrections.
    """

    def __init__(self, name, a, t, n0, n1, model, p0, mult=None):
        self.name, self.a, self.t = name, a, t
        self.tlab = C.srgb_to_lab(t)
        self.W = C.de2000_weights(self.tlab, KC, FLAT_L)
        if mult is not None:
            self.W = self.W * np.sqrt(mult)[:, None, None]
        self.px = P.Pixels(model, n1)
        self.base = P.Pixels(model, n0)(p0)

    def predict(self, p: M.Params) -> np.ndarray:
        return np.clip(self.a + self.px(p) - self.base, 0, 1)


class Refiner:
    """A fit starting from the real render of the previous version."""

    def __init__(self, m: Matcher, prev: str):
        self.m = m
        self.x0 = full(np.load(os.path.join(HERE, "out", prev, "x.npy")))
        self.p0 = M.params_of(np3.deserialize(open(os.path.join(HERE, "out", prev, "NIKON/CUSTOMPC/PICCON01.NP3"), "rb").read()))

    def neutral(self, a: np.ndarray, nef: str | None, target: str) -> tuple[np.ndarray, np.ndarray]:
        """n0 and n1 for the whole frame: from the NEF if it aligns with the same target, otherwise by inversion."""
        if nef:
            x = prepared(nef, target)["x"]
            if len(x) == len(a):
                g, _ = edit_gain(nef, target)
                return self.m.dev(x), self.m.dev(x * g)
        n = invert(self.m.model, a, self.p0)
        return n, n

    def rendered(self, name, f: dict, freq=None) -> tuple[Rendered, Rendered, Rendered]:
        """Sample for the fit, for scoring, and the whole frame for the region report."""
        a, t, n0, n1 = f["a"], f["t"], f["n0"], f["n1"]
        pick, mult, test = sample(a, t, self.m.rng, freq, f["trust"])
        fit = Rendered(name, a[pick], t[pick], n0[pick], n1[pick], self.m.model, self.p0, mult)
        test, whole = (Rendered(name, a[i], t[i], n0[i], n1[i], self.m.model, self.p0) for i in (test, slice(None)))
        whole.neutral = n0
        return fit, test, whole

    def load(self, first: str, target: str, known: dict) -> dict:
        """The previous version's render, the target and the n0/n1 neutrals.

        The first file of a pair is a NEF/DNG or an NX render with the previous version. RAW we
        develop ourselves: the neutral is our development with the target's WB and exposure, the
        previous version's render is the model with p0 on it. Then the correction learns on the
        same pixels as the normal fit but stays near the previous version (TRUST).
        """
        if first.lower().endswith(A.RAW_EXT):
            raw = prepared(first, target)
            g, _ = edit_gain(first, target)
            n = self.m.dev(raw["x"] * g)
            return {"a": P.Pixels(self.m.model, n)(self.p0), "t": raw["t"], "n0": n, "n1": n, "nef": first,
                    "ncc": raw["ncc"], "trust": self.m.dev.trust(raw["x"] * g, self.m.density)}
        d = A.render_cached(first, target)
        nef = known.get(os.path.abspath(target))
        n0, n1 = self.neutral(d["x"], nef, target)
        return {"a": d["x"], "t": d["y"], "n0": n0, "n1": n1, "nef": nef, "ncc": 1.0, "trust": None}

    def fit(self, photos: list[Rendered], iters=25) -> np.ndarray:
        def fn(x):
            p = unpack(x)
            r = [C.weighted(q.W, C.srgb_to_lab(q.predict(p)) - q.tlab).ravel() / np.sqrt(len(q.a) * len(photos)) for q in photos]
            k = knots(x)
            return np.r_[np.concatenate(r), F.SMOOTH * 100 * np.diff(k, 2) * F.BEND,
                         TRUST * (x - self.x0)[:F.NB + F.NG], TRUST * (x - self.x0)[NX:], F.WHITE * (k[-1] - 1)]
        return F.lm(fn, self.x0.copy(), iters)[0]

    def score(self, x: np.ndarray, test: Rendered) -> float:
        return float(C.de2000(C.srgb_to_lab(test.predict(unpack(x))), test.tlab).mean())


def refine(name: str, prev: str, files: list[str]):
    r = Refiner(Matcher(), prev)
    known = json.load(open(os.path.join(HERE, "out", prev, "pairs.json"))) if os.path.exists(os.path.join(HERE, "out", prev, "pairs.json")) else {}
    loaded = [(a, b, r.load(a, b, known)) for a, b in zip(files[::2], files[1::2])]
    freq = target_frequency([f["t"] for *_, f in loaded])
    samples = [r.rendered(os.path.basename(a)[:-4], f, freq) for a, b, f in loaded]
    analysis = A.load(prev)
    frames = [A.frame(whole.name, f["nef"], b, whole.neutral, f["t"], f["ncc"], edit_warnings([b]) if f["nef"] == a else [])
              for (a, b, f), (_, _, whole) in zip(loaded, samples)]
    refine_coverage(analysis, frames, prev)
    x = r.fit([s[0] for s in samples])
    ctrl, path = write(name, x)
    known.update({os.path.abspath(b): os.path.abspath(a) for a, b, f in loaded if f["nef"] == a})
    if known:
        json.dump(known, open(os.path.join(HERE, "out", name, "pairs.json"), "w"), ensure_ascii=False, indent=1)
    for _, test, _ in samples:
        print(f"{test.name}: now {r.score(r.x0, test):.2f} -> prediction {r.score(x, test):.2f}")
    p = unpack(x)
    A.print_report({w.name: A.region_sums(w.a, w.t) for _, _, w in samples},
                   "previous version render (NX, ours for NEF) vs target:")
    A.print_report({w.name: A.region_sums(w.predict(p), w.t) for _, _, w in samples}, "correction prediction vs target:")
    analysis["refine"] = [f["target"] for f in frames]
    analysis["prev"] = prev
    A.save(name, analysis)
    print("blender", ctrl.blender)
    print("grade", ctrl.grade)
    print("file:", path)


def refine_coverage(analysis: dict, frames: list[dict], prev: str):
    """Color coverage of the correction frames and whose renders to add from the draft analysis."""
    fit = [analysis["frames"][t] for t in analysis.get("fit", []) if t in analysis["frames"]]
    if fit:
        A.print_coverage(fit, f"fit frames {prev}")
    A.print_coverage(frames, "correction frames")
    candidates = list(analysis["frames"].values())
    tips = A.suggest(frames, candidates, f"add to the correction (NEF or NX render with {prev}):")
    for tip in tips:
        print("  advice:", tip)
    if not candidates:
        print(f"  no candidate analysis: python3 match.py --analyze {prev} NEF and target pairs — then there will be advice on which frames to add")


def scene_points(m: Matcher, nef: str, target: str) -> Points:
    t = scene.load_target(target)
    a = scene.align(scene.load_base(nef), t)
    b, c, flat = scene.blocks(a["x"], t, a["inside"], m.dev)
    print(f"{os.path.basename(nef)[:-4]}: alignment {a['ncc']:.2f}, scale {a['scale']:.2f}, stable blocks {int(flat.sum())} of {len(flat)}, fitting {len(b)}")
    return Points(os.path.basename(nef)[:-4], b, c, m.model, a["ncc"])


def fit_scene(m: Matcher, points: list[Points]) -> np.ndarray:
    """Second pass without the worst blocks: motion in the frame and alignment errors."""
    p = unpack(m.fit(points, 20))
    for q in points:
        keep = scene.trimmed(C.srgb_to_lab(q.px(p)), q.tlab)
        q.set(q.b[keep], q.t[keep], m.model)
    return m.fit(points, 20)


def run_scene(name: str, files: list[str]):
    m = Matcher()
    points = [scene_points(m, a, b) for a, b in zip(files[::2], files[1::2])]
    for q in points:
        if q.ncc < 0.3 or len(q.b) < 60:
            print(f"warning: {q.name}: frames aligned poorly, the data cannot be trusted")
    x = fit_scene(m, points)
    ctrl, path = write(name, x)
    p = M.params_of(ctrl)
    for q in points:
        print(f"{q.name}: neutral {C.de2000(C.srgb_to_lab(q.tb), q.ttlab).mean():.2f} -> prediction {m.score(q, p):.2f}")
    warn_coverage(points)
    print("blender", ctrl.blender)
    print("grade", ctrl.grade)
    print("curve", ctrl.curve.points)
    print("file:", path)


def refine_scene(name: str, prev: str, files: list[str]):
    """Correction against a real render when the target was shot by another frame or camera."""
    r = Refiner(Matcher(), prev)
    photos = []
    for render_path, target in zip(files[::2], files[1::2]):
        t = scene.load_target(target)
        a = np.asarray(scene.fit_long(pairs_mod.to_srgb(Image.open(render_path)), scene.LONG), dtype=np.float32) / 255
        g = scene.align(a ** 2.2, t)                 # align expects a linear frame
        b, c, stable = scene.blocks(g["x"] ** (1 / 2.2), t, g["inside"], lambda v: v)
        print(f"{os.path.basename(render_path)}: alignment {g['ncc']:.2f}, fitting {len(b)} blocks")
        n = invert(r.m.model, b.astype(np.float64), r.p0)
        photos.append(Rendered(os.path.basename(render_path)[:-4], b, c, n, n, r.m.model, r.p0))
    x = r.fit(photos)
    ctrl, path = write(name, x)
    for q in photos:
        print(f"{q.name}: now {r.score(r.x0, q):.2f} -> prediction {r.score(x, q):.2f}")
    print("blender", ctrl.blender)
    print("grade", ctrl.grade)
    print("file:", path)


def edit_warnings(targets: list[str]) -> list[str]:
    """What NP3 will not carry over, from the finished shots' XMP."""
    out = []
    for path in targets:
        x = pairs_mod.xmp_values(Image.open(path))
        name = os.path.basename(path)
        size = Image.open(path).size
        if max(size) < MIN_TARGET:
            out.append(f"{name}: read only the {size[0]}x{size[1]} preview, better give a JPEG or TIFF")
        if "Temperature" not in x:
            out.append(f"{name}: no Lightroom settings in XMP: WB, exposure and masks are invisible, they will land in the profile")
        if x["_masks"]:
            out.append(f"{name}: has masks, local corrections are not carried into NP3")
        for key, label in (("PostCropVignetteAmount", "vignette"), ("GrainAmount", "grain")):
            if float(x.get(key) or 0):
                out.append(f"{name}: {label} from the preset has no place in NP3")
    return out


def coverage(pairs: list[Pair]) -> dict:
    """Share of colorful pixels in each blender color's sector across all pairs."""
    v = {c: [] for c in np3.COLORS}
    for q in pairs:
        lab = C.srgb_to_lab(q.tb)
        colourful = np.hypot(lab[:, 1], lab[:, 2]) > MIN_CHROMA
        w = q.px.model.weights(q.tb)
        for c in np3.COLORS:
            v[c].append((w[c] * colourful).mean())
    return {c: float(np.mean(x)) for c, x in v.items()}


def sky_share(pairs: list[Pair]) -> float:
    """Share of sky pixels in the targets: light blues and cyans."""
    lab = np.vstack([q.ttlab for q in pairs])
    hue = np.degrees(np.arctan2(lab[:, 2], lab[:, 1])) % 360
    return float(((hue > 200) & (hue < 300) & (np.hypot(lab[:, 1], lab[:, 2]) > 8) & (lab[:, 0] > 40)).mean())


def warn_coverage(pairs: list[Pair]):
    missing = [c for c, v in coverage(pairs).items() if v < MIN_SHARE]
    if missing:
        print("warning: almost absent in the frames, the fit is unreliable here:", ", ".join(missing))
    sky = sky_share(pairs)
    if sky < MIN_SKY:
        print(f"warning: sky is {sky:.0%} of the frames: its color is fitted almost blindly and may drift into magenta; "
              "if the sky matters, add a frame with it")


def next_name(prev: str) -> str:
    """Next free version: name -> name_r1, name_r1 -> name_r2."""
    m = re.fullmatch(r"(.+)_r(\d+)", prev)
    base, n = (m[1], int(m[2])) if m else (prev, 0)
    while True:
        n += 1
        name = f"{base}_r{n}"
        if not os.path.exists(os.path.join(HERE, "out", name)):
            return name


def refine_args(args: list[str], raw_ok=True) -> tuple[str, str, list[str]]:
    """[new] prev and file pairs: parity distinguishes the form with a new name."""
    if len(args) < 3:
        sys.exit("usage: --refine [new] prev a.NEF|render_a.TIF a.jpg [b.NEF|render_b.TIF b.jpg ...]")
    name, prev, *files = args if len(args) % 2 == 0 else [None, *args]
    if not os.path.exists(os.path.join(HERE, "out", prev, "x.npy")):
        sys.exit(f"no profile out/{prev}: give the name of the profile the render was made with")
    for f in files:
        if not os.path.exists(f):
            sys.exit(f"no file: {f}")
    for f in files[::2] if not raw_ok else []:
        if f.lower().endswith(A.RAW_EXT):
            sys.exit(f"{f}: --scene-refine expects an NX Studio render with profile {prev} (TIF/JPG), not RAW")
    return name or next_name(prev), prev, files


# ---------------------------------------------------------------- fitting from printed chart sheets

# NOTE: these group names come from charts.py of the np3-fit-charts project (kept in Russian there)
# and must match its patch group labels exactly.
CHART_BOOST = {"кожа", "небо", "листва", "красно-оранжевые", "яркие", "своя бумага", "насыщенные"}
CHART_GROUP_W = 1.5     # weight of the CHART_BOOST groups: initial, tune on held-out sheets (spec/charts.md)


def chart_rows(d, hold: str | None) -> tuple[np.ndarray, np.ndarray]:
    """Fit and held-out row masks of the patch set."""
    import charts as CH
    bad = (d["flags"] & (CH.F_SENSOR | CH.F_GLARE | CH.F_BLANK | CH.F_TFLOOR)) > 0
    held = np.zeros(len(bad), bool)
    if hold:
        key, _, val = hold.partition("=")
        v = float(val)
        if key == "sheet":
            held = d["sheet"] == int(v)
        elif key == "series":
            held = d["series"] == int(v) - 1
        elif key == "ev":
            held = np.abs(np.abs(d["ev"]) - abs(v)) < 0.25
        else:
            sys.exit("--hold: sheet=N, series=N or ev=N")
    return ~bad & ~held, ~bad & held


def chart_points(m: Matcher, d, mask: np.ndarray, weights: np.ndarray | None) -> list[Points]:
    """One frame pair — one Points. Frame gray references as one point, target clip one-sided."""
    import charts as CH
    out = []
    for i in np.unique(d["pair"][mask]):
        sel = mask & (d["pair"] == i)
        ref = sel & (d["group"] == CH.REF)
        plain = sel & ~ref & ((d["flags"] & CH.F_TCLIP) == 0)
        b, t = d["neutral"][plain], d["target"][plain]
        w = weights[plain] if weights is not None else np.ones(len(b))
        refok = ref & ((d["flags"] & CH.F_TCLIP) == 0)
        if refok.any():
            b = np.r_[b, d["neutral"][refok].mean(0, keepdims=True)]
            t = np.r_[t, d["target"][refok].mean(0, keepdims=True)]
            w = np.r_[w, 1.0]
        if not len(b):
            continue
        name = f"sheet {d['sheet'][sel][0]}, series {d['series'][sel][0] + 1}, {d['ev'][sel][0]:+.1f} EV"
        q = Points(name, np.clip(b, 0, 1), t, m.model, 1.0)
        q.sheet, q.ev = int(d["sheet"][sel][0]), float(d["ev"][sel][0])
        q.W = q.W * np.sqrt(w)[:, None, None]
        q.sm = np.sqrt(w)
        clip = sel & ((d["flags"] & CH.F_TCLIP) > 0) & (d["target"].min(1) >= NEAR_WHITE)
        if clip.any():
            q.cpx = P.Pixels(m.model, np.clip(d["neutral"][clip], 0, 1))
            q.ct = d["target"][clip]
            q.cmask = q.ct >= CLIP
        out.append(q)
    return out


def chart_report(m: Matcher, pts: list[Points], p: M.Params, title: str):
    by = {}
    for q in pts:
        by.setdefault(f"sheet {q.sheet}", []).append(q)
    A.print_report({k: A.region_sums(np.vstack([q.px(p) for q in v]), np.vstack([q.t for q in v])) for k, v in sorted(by.items())},
                   title, min_n=5)
    neutral = np.mean([C.de2000(C.srgb_to_lab(q.b), q.tlab).mean() for q in pts])
    calc = np.mean([m.score(q, p) for q in pts])
    evs = sorted({round(q.ev) for q in pts})
    line = ", ".join(f"{e:+d} EV {np.mean([m.score(q, p) for q in pts if round(q.ev) == e]):.2f}" for e in evs)
    print(f"  neutral {neutral:.2f} -> prediction {calc:.2f}; by exposure: {line}")


def run_chart(name: str, source: str, hold: str | None, group_w: float):
    import charts as CH
    if os.path.isdir(source):
        paths = CH.files_in(source)
        if not paths:
            sys.exit(f"no NEF/DNG and JPEG in {source}")
        source = CH.collect(paths, name)
    d = dict(np.load(source))
    fit_mask, held_mask = chart_rows(d, hold)
    if fit_mask.sum() < 50:
        sys.exit(f"fit has {int(fit_mask.sum())} patches: too few, see the charts.py report")
    lab = C.srgb_to_lab(np.clip(d["target"], 0, 1))
    freq = A.frequency([lab[fit_mask]])
    w = A.rarity(freq, lab) * np.where(np.isin(d["group"], list(CHART_BOOST)), group_w, 1.0)
    m = Matcher()
    fit_pts = chart_points(m, d, fit_mask, w)
    held_pts = chart_points(m, d, held_mask, None) if held_mask.any() else []
    print(f"pairs in fit {len(fit_pts)}, patches {int(fit_mask.sum())}; held out {hold or 'nothing'}: pairs {len(held_pts)}")
    x = m.fit(fit_pts)
    ctrl, path = write(name, x)
    p = M.params_of(ctrl)
    chart_report(m, fit_pts, p, "fit (own points, for reference only):")
    if held_pts:
        chart_report(m, held_pts, p, f"held out ({hold}):")
    json.dump({"patches": os.path.abspath(source), "hold": hold, "group_w": group_w},
              open(os.path.join(HERE, "out", name, "chart.json"), "w"), ensure_ascii=False, indent=1)
    print("blender", ctrl.blender)
    print("grade", ctrl.grade)
    print("curve", ctrl.curve.points)
    print("file:", path)


def main():
    if sys.argv[1] in ("--refine", "--scene-refine"):
        run = refine if sys.argv[1] == "--refine" else refine_scene
        run(*refine_args(sys.argv[2:], sys.argv[1] == "--refine"))
        return
    if sys.argv[1] == "--analyze":
        args = sys.argv[2:]
        adl_only = None
        if "--adl" in args:            # recommend only frames with this in-camera ADL: Off, Low, Normal...
            i = args.index("--adl")
            adl_only = args[i + 1]
            del args[i:i + 2]
        if len(args) < 3 or (len(args) - 1) % 2:
            sys.exit("usage: python3 match.py --analyze name [--adl Off] a.NEF a.jpg [b.NEF b.jpg ...]")
        for f in args[1:]:
            if not os.path.exists(f):
                sys.exit(f"no file: {f}")
        analyze(args[0], args[1:], adl_only)
        return
    if sys.argv[1] == "--chart":
        args = sys.argv[2:]
        opts = {"--hold": None, "--groups": str(CHART_GROUP_W)}
        for k in list(opts):
            if k in args:
                i = args.index(k)
                opts[k] = args[i + 1]
                del args[i:i + 2]
        if len(args) != 2 or not os.path.exists(args[1]):
            sys.exit("usage: python3 match.py --chart name folder|patches.npz [--hold sheet=N|series=N|ev=N] [--groups 1.5]")
        run_chart(args[0], args[1], opts["--hold"], float(opts["--groups"]))
        return
    if sys.argv[1] == "--scene":
        if len(sys.argv) <= 3 or (len(sys.argv) - 3) % 2:
            sys.exit("files must come in pairs: a Nikon shot and a target")
        run_scene(sys.argv[2], sys.argv[3:])
        return
    args = sys.argv[1:]
    if args and args[0].lower().endswith((".nef", ".dng")):   # the name may be omitted: it is taken from the first shot
        args.insert(0, os.path.splitext(os.path.basename(args[0]))[0].lower())
    name, *files = args or [""]
    if not files or len(files) % 2:
        sys.exit("usage: python3 match.py [name] a.NEF|a.DNG a.jpg [b.NEF b.jpg ...]")
    for f in files:
        if not os.path.exists(f):
            sys.exit(f"no file: {f}")
    m = Matcher()
    raws = [prepared(a, b) for a, b in zip(files[::2], files[1::2])]
    gains = [edit_gain(a, b) for a, b in zip(files[::2], files[1::2])]
    freq = target_frequency([r["t"] for r in raws])
    pairs = [m.pair(r, g, freq) for r, (g, _) in zip(raws, gains)]
    for r, (_, note) in zip(raws, gains):
        if note:
            print(f"{r['name']}: taken out of the profile: {note}")
    analysis = A.load(name)
    frames = [A.frame(q.name, a, b, q.fb, q.ft, q.ncc, edit_warnings([b]))
              for q, a, b in zip(pairs, files[::2], files[1::2])]
    analysis["frames"].update({f["target"]: f for f in frames})
    analysis["fit"] = [f["target"] for f in frames]
    A.print_frames(frames)
    known = list(analysis["frames"].values())
    A.print_coverage(frames, "color coverage in the fit", A.lift_median(known) if len(known) > len(frames) else None)
    for tip in A.suggest(frames, list(analysis["frames"].values()), "add to the fit"):
        print("  advice:", tip)
    x = m.fit(pairs)
    print("starts:", ", ".join(f"{k} {v:.4f}" for k, v in m.starts.items()), "->", m.init)
    ctrl, path = write(name, x)
    A.save(name, analysis)
    json.dump({os.path.abspath(b): os.path.abspath(a) for a, b in zip(files[::2], files[1::2])},
              open(os.path.join(HERE, "out", name, "pairs.json"), "w"), ensure_ascii=False, indent=1)
    p = M.params_of(ctrl)
    for q in pairs:
        print(f"{q.name}: neutral {C.de2000(C.srgb_to_lab(q.tb), q.ttlab).mean():.2f} -> prediction {m.score(q, p):.2f}")
    A.print_report({q.name: A.region_sums(P.Pixels(m.model, q.fb)(p), q.ft) for q in pairs}, "prediction vs target by regions:")
    for w in edit_warnings(files[1::2]):
        print("warning:", w)
    warn_coverage(pairs)
    print("blender", ctrl.blender)
    print("grade", ctrl.grade)
    print("curve", ctrl.curve.points)
    print("file:", path)


def analyze(name: str, files: list[str], adl_only: str | None = None):
    """Candidates for the fit: colors, lightness, suitability and the recommended frame set."""
    m = Matcher()
    frames = []
    for a, b in zip(files[::2], files[1::2]):
        raw = prepared(a, b)
        g, _ = edit_gain(a, b)
        frames.append(A.frame(raw["name"], a, b, m.dev(raw["x"] * g), raw["t"], raw["ncc"], edit_warnings([b])))
    data = A.load(name)
    data["frames"].update({f["target"]: f for f in frames})
    A.save(name, data)
    A.print_frames(frames)
    A.print_coverage(frames, "all candidates")
    rec = A.recommend(frames, A.lift_median(frames), adl_only)
    if not rec:
        sys.exit(f"no suitable frames with ADL {adl_only}")
    A.print_coverage(rec, "recommended set", A.lift_median(frames))
    print("fit:\n  python3 match.py", name, " ".join(f"{os.path.relpath(f['nef'])} {os.path.relpath(f['target'])}" for f in rec))
    print("analysis:", os.path.join("out", name, "analysis.json"))


if __name__ == "__main__":
    main()
