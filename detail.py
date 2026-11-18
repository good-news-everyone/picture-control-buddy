"""Flexible Color detail: Clarity, Sharpening, Mid-range sharpening.

The model is empirical, from NX Studio probes, like the color model. Each tool changes only
the Rec.601 Y' luma in encoded sRGB, leaving chroma untouched:

    dY = value * sum_sigma g_sigma(Y) * (Y - Gauss_sigma(Y))

Radii sigma are given in pixels of the full Z f frame (6048 on the long side) and are divided
by the working image scale. g_sigma is a gain table over the source pixel's tone, separate
for plus and minus. The response is linear in the slider value. The table and radii are trained
per export scale separately: after shrinking, small-radius sharpening looks different from the
same mask with radius/k. The step runs after color and curve.

Measurements, on held-out frames, share of the Y' response net of export noise (details in
spec/camera-response.md):
- Clarity: a sigma pair 56 + 180 px, gain ~0.12*Y per unit, fades at clipping. 84% (x4),
  90% (x2). dE 1.22 -> 1.02 at ±2 and 2.0 -> 1.2 at ±5 with NX noise 1.0.
- Mid-range sharpening: even rise across bands 0.5-16 px, almost zero above 32 px; minus is
  weaker than plus. 78% (x2), 85% (x4).
- Sharpening: a band at sigma 0.5-1 px of the full frame; it does not lift the finest detail:
  pairs give a band-pass filter. The linear model explains 53% (x2), 37% (x4), even less at
  full size. The residual is mostly NX export noise passed through sharpening: minus blurs
  the noise below the level of the two neutrals, plus lifts it but weaker than the linear
  filter (~0.7 of average gain at small edges). A table over edge magnitude and a quadratic
  term over level gave nothing on held-out frames.

    python3 detail.py collect tools     # renders/sweep/tools -> data/detail_tools.npz (Clarity, scale 4)
    python3 detail.py collect detail    # renders/sweep/detail (full size) -> data/detail_full.npz
    python3 detail.py                   # training -> data/detail_model.npz and a dE report
"""
from __future__ import annotations

import dataclasses
import json
import os
import sys

import numpy as np

import color as C
import np3

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "data", "detail_model.npz")
DATA = {"tools": os.path.join(HERE, "data", "detail_tools.npz"),
        "detail": os.path.join(HERE, "data", "detail_full.npz")}
TOOLS = ("clarity", "sharpening", "mid_sharpening")
SENSOR_LONG = 6048        # Z f, full-frame long side
NB = 12                   # gain table knots over Y'
GRID = np.linspace(0, 1, NB)
RIDGE = 1e-4
YW = np.array([0.299, 0.587, 0.114])
# radius candidates, full-frame pixels; singles and pairs
CANDIDATES = {
    "clarity": ((64,), (88,), (112,), (140,), (180,), (32, 112), (56, 180)),
    # Sharpening at full size is a band at sigma 0.5-1 px and does not lift the finest detail: pairs give a band-pass
    "sharpening": ((0.5,), (0.7,), (1.0,), (1.4,), (2.0,), (0.5, 1.0), (0.5, 1.4), (0.7, 1.4), (0.7, 2.0)),
    # Mid-range at full size rises evenly from 0.5 to 16 px and beyond
    "mid_sharpening": ((4.0,), (8.0,), (12.0,), (16.0,), (24.0,), (32.0,), (48.0,), (2.0, 16.0), (4.0, 24.0), (8.0, 32.0)),
}
SAMPLES = {1: 400_000, 2: 300_000, 4: 150_000}   # pixels per frame and profile when collecting
SEED = 20261110
VISIBLE = 0.02           # minimum improvement in Y' error (share of export noise), else the tool at this scale = 0


def gauss(a: np.ndarray, sigma: float) -> np.ndarray:
    """2D Gaussian blur via FFT with mirror edges. sigma in pixels of this image."""
    if sigma <= 0:
        return a
    h, w = a.shape
    p = min(int(3 * sigma) + 2, h - 1, w - 1)
    b = np.pad(a, p, mode="reflect")
    fy = np.fft.fftfreq(b.shape[0])[:, None]
    fx = np.fft.rfftfreq(b.shape[1])[None, :]
    k = np.exp(-2 * (np.pi * sigma) ** 2 * (fy ** 2 + fx ** 2))
    return np.fft.irfft2(np.fft.rfft2(b) * k, b.shape)[p:p + h, p:p + w].astype(a.dtype)


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ YW.astype(rgb.dtype)


def scale_of(img: np.ndarray) -> float:
    """How many full-frame pixels fit in one image pixel."""
    return SENSOR_LONG / max(img.shape[:2])


def hat(y: np.ndarray) -> np.ndarray:
    u = np.clip(y, 0, 1) * (NB - 1)
    i = np.minimum(u.astype(int), NB - 2)
    f = u - i
    w = np.zeros((y.size, NB), np.float32)
    w[np.arange(y.size), i] = 1 - f
    w[np.arange(y.size), i + 1] = f
    return w


@dataclasses.dataclass
class Part:
    """One tool's model at one scale."""
    sigmas: tuple[float, ...]
    plus: np.ndarray           # (len(sigmas), NB) gain per slider unit
    minus: np.ndarray

    def delta(self, y: np.ndarray, value: float, scale: float) -> np.ndarray:
        tables = self.plus if value > 0 else self.minus
        out = np.zeros_like(y)
        for s, t in zip(self.sigmas, tables):
            out += np.interp(y, GRID, t).astype(y.dtype) * (y - gauss(y, s / scale))
        return value * out


class Detail:
    def __init__(self, parts: dict[str, dict[int, Part]] | None = None):
        self.parts = parts or {}

    def has(self, tool: str) -> bool:
        return bool(self.parts.get(tool))

    def part(self, tool: str, scale: float) -> Part | None:
        by = self.parts.get(tool)
        if not by:
            return None
        return by[min(by, key=lambda k: abs(np.log(k / scale)))]

    def __call__(self, rgb: np.ndarray, c: np3.Control, scale: float | None = None) -> np.ndarray:
        """rgb (h, w, 3) sRGB 0..1 after color. Tools without a model are skipped."""
        scale = scale or scale_of(rgb)
        y = luma(rgb)
        dy = np.zeros_like(y)
        for tool in TOOLS:
            v = getattr(c, tool)
            p = self.part(tool, scale) if v else None
            if p is not None:
                dy += p.delta(y, v, scale)
        return np.clip(rgb + dy[..., None], 0, 1)

    def save(self, path: str = PATH):
        out = {}
        for tool, by in self.parts.items():
            for k, p in by.items():
                out[f"{tool}/{k}/sigmas"] = np.array(p.sigmas)
                out[f"{tool}/{k}/plus"] = p.plus
                out[f"{tool}/{k}/minus"] = p.minus
        np.savez(path, **out)

    @classmethod
    def load(cls, path: str = PATH) -> "Detail":
        if not os.path.exists(path):
            return cls()
        z = np.load(path)
        parts: dict[str, dict[int, Part]] = {}
        for key in z.files:
            tool, k, what = key.split("/")
            if what == "sigmas":
                parts.setdefault(tool, {})[int(k)] = Part(tuple(float(s) for s in z[key]),
                                                          z[f"{tool}/{k}/plus"], z[f"{tool}/{k}/minus"])
        return cls(parts)


# ---------- probe collection ----------

def without_detail(c: np3.Control) -> bytes:
    """Profile without detail tools, with a fixed name: the probe base lookup key."""
    d = dataclasses.replace(c, name="BASE", comment="", sharpening=0, mid_sharpening=0, clarity=0)
    return np3.serialize(d)


def detail_of(c: np3.Control) -> tuple[float, float, float]:
    return tuple(float(getattr(c, t)) for t in TOOLS)


def collect(folder: str):
    """NX exports of a pack -> npz: bases whole, probes at random pixels.

    A probe's base is the profile of the same pack with the same settings and zero detail.
    Model features are computed from the base only, so a probe has values at the points.
    The tools pack was exported at 1512 px (scale 4), the detail pack at full size:
    scales 2 (as the full renderer development) and 4 (as the ui.py preview) are collected from it.
    """
    import sweep
    from PIL import Image, ImageOps
    import pairs
    Image.MAX_IMAGE_PIXELS = None

    made = json.load(open(os.path.join(sweep.ROOT, folder, "manifest.json")))
    frames = list(dict.fromkeys(m["frame"] for m in made))
    profiles = list(dict.fromkeys(m["profile"] for m in made))
    controls = {p: np3.deserialize(sweep.sweep_control(folder, f"{frames[0]}-{p}.NEF")) for p in profiles}
    plain: dict[bytes, str] = {}
    for p, c in controls.items():
        if not any(detail_of(c)):
            plain.setdefault(without_detail(c), p)          # first: NEUTRAL, not NEUTRAL-B
    base_of = {}
    for p, c in controls.items():
        if any(detail_of(c)):
            b = plain.get(without_detail(c))
            if b:
                base_of[p] = b
            else:
                print("no base, skipped:", p)
    bases = sorted(set(base_of.values()))
    if "NEUTRAL" in bases and "NEUTRAL-B" in profiles:
        bases.append("NEUTRAL-B")                           # second neutral: export noise and fitting without bias
    used = [p for p in profiles if p in base_of or p in bases or p.startswith("NEUTRAL")]
    rng = np.random.default_rng(SEED)
    out = {"frames": np.array(frames), "profiles": np.array(used),
           "controls": np.array([np3.serialize(controls[p]).hex() for p in used]),
           "base_of": np.array([base_of.get(p, p) for p in used])}
    probes: dict[str, list] = {}

    def read(f, p) -> np.ndarray:
        im = pairs.to_srgb(ImageOps.exif_transpose(Image.open(sweep.export_path(folder, f"{f}-{p}.NEF"))))
        return np.asarray(im)

    for f in frames:
        for j, p in enumerate(used):
            im = read(f, p)
            native = max(1, int(round(SENSOR_LONG / max(im.shape[:2]))))
            for k in ((2, 4) if native == 1 else (native,)):
                a = shrink_u8(im, k // native)
                key = f"{f}/{k}"
                if j == 0:
                    n = a.shape[0] * a.shape[1]
                    out[key + "/idx"] = np.sort(rng.choice(n, min(SAMPLES[k], n), replace=False)).astype(np.int32)
                    probes[key] = []
                if p in bases:
                    out[f"{key}/base/{p}"] = a
                probes[key].append(a.reshape(-1, 3)[out[key + "/idx"]])
            print(f, p, flush=True)
    for key, v in probes.items():
        out[key + "/probe"] = np.stack(v)
    np.savez_compressed(DATA[folder], **out)
    print("file:", DATA[folder])


def shrink_u8(a: np.ndarray, k: int) -> np.ndarray:
    """k x k block averaging in linear light, as an NX export at a smaller size, back to uint8."""
    if k == 1:
        return a
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    lin = C.srgb_to_linear(a[:h, :w].astype(np.float32) / 255).astype(np.float32)
    lin = lin.reshape(h // k, k, w // k, k, 3).mean((1, 3))
    return (np.clip(C.linear_to_srgb(lin), 0, 1) * 255 + .5).astype(np.uint8)


# ---------- training ----------

CLEAN = "~clean"           # mean of NEUTRAL and NEUTRAL-B: export noise halved
WEAK = 0.25                # report: a response weaker than this share of export noise is not assessed


class Set:
    """Probes of one scale: features from the base, targets at the points.

    NX adds its own noise to every export: two identical full-size neutrals differ by
    rms 0.019 in Y', independent of tone and edges. The noise enters before sharpening
    (minus Sharpening blurs it), so on sharpening probes the residual is above this estimate.
    Features taken from a noisy base underestimate the gain at small radii, so when
    NEUTRAL-B is available the fit uses instrumental variables: features from one neutral,
    instruments from the other. Prediction and validation are computed from their mean.
    """

    def __init__(self, z, k: int):
        self.k = k
        self.profiles = list(z["profiles"])
        self.controls = [np3.deserialize(bytes.fromhex(h)) for h in z["controls"]]
        self.base_of = list(z["base_of"])
        self.frames = [f for f in z["frames"] if f"{f}/{k}/idx" in z.files]
        self.paired = bool(self.frames) and all(f"{f}/{k}/base/NEUTRAL-B" in z.files for f in self.frames)
        self.z = z
        self.cache: dict = {}

    def remember(self, key, make):
        if key not in self.cache:
            self.cache[key] = make()
        return self.cache[key]

    def base(self, f: str, b: str) -> np.ndarray:
        if b == CLEAN:
            return (self.base(f, "NEUTRAL") + self.base(f, "NEUTRAL-B")) / 2
        return self.z[f"{f}/{self.k}/base/{b}"].astype(np.float32) / 255

    def idx(self, f: str) -> np.ndarray:
        return self.remember(("idx", f), lambda: self.z[f"{f}/{self.k}/idx"])

    def points(self, f: str, b: str) -> np.ndarray:
        return self.remember(("pts", f, b), lambda: self.base(f, b).reshape(-1, 3)[self.idx(f)])

    def hp(self, f: str, b: str, sigma: float) -> np.ndarray:
        """Y - Gauss(Y) of the base at the probe points, sigma in full-frame pixels."""
        def make():
            y = self.remember(("y", f, b), lambda: luma(self.base(f, b)))
            return (y - gauss(y, sigma / self.k)).ravel()[self.idx(f)]
        return self.remember(("hp", f, b, sigma), make)

    def target(self, f: str, i: int) -> np.ndarray:
        return self.remember(("t", f, i), lambda: self.z[f"{f}/{self.k}/probe"][i].astype(np.float32) / 255)

    def ref(self, i: int) -> str:
        """Base for prediction: the mean of the two neutrals, when available."""
        return CLEAN if self.paired and self.base_of[i] == "NEUTRAL" else self.base_of[i]

    def noise(self, f: str) -> float | None:
        """Variance of a single export's Y' noise at the points, from the difference of two neutrals."""
        if not self.paired:
            return None
        return float(np.var(luma(self.points(f, "NEUTRAL")) - luma(self.points(f, "NEUTRAL-B"))) / 2)

    def single(self, tool: str) -> list[int]:
        j = TOOLS.index(tool)
        return [i for i, c in enumerate(self.controls)
                if detail_of(c)[j] and sum(1 for v in detail_of(c) if v) == 1 and self.base_of[i] == "NEUTRAL"]


def design(s: Set, f: str, i: int, tool: str, sigmas, both: bool, src: str) -> np.ndarray:
    """Features from the src base, tone weights from the prediction base."""
    v = getattr(s.controls[i], tool)
    w = hat(luma(s.points(f, s.ref(i))))
    x = np.hstack([w * s.hp(f, src, sg)[:, None] * v for sg in sigmas])
    if not both:
        return x
    z = np.zeros_like(x)
    return np.hstack([x, z] if v > 0 else [z, x])


def solve(s: Set, tool: str, sigmas, frames, probes, both: bool) -> np.ndarray:
    zx, zy = 0, 0
    for f in frames:
        for i in probes:
            b = s.base_of[i]
            pairs = (("NEUTRAL", "NEUTRAL-B"), ("NEUTRAL-B", "NEUTRAL")) if s.ref(i) == CLEAN else ((b, b),)
            t = luma(s.target(f, i))
            for xs, zs in pairs:
                x = design(s, f, i, tool, sigmas, both, xs)
                z = x if zs == xs else design(s, f, i, tool, sigmas, both, zs)
                zx = zx + z.T @ x
                zy = zy + z.T @ (t - luma(s.points(f, xs)))
    n = zx.shape[1]
    d = np.kron(np.eye(n // NB), np.diff(np.eye(NB), 2, axis=0))     # smoothness of each table over tone
    a = zx + RIDGE * np.trace(zx) / n * (d.T @ d) + 1e-9 * np.eye(n)
    return np.linalg.solve(a, zy)


def to_part(coef: np.ndarray, sigmas, both: bool) -> Part:
    m = len(sigmas)
    t = coef.reshape(-1, m, NB) if both else coef.reshape(1, m, NB)
    return Part(tuple(sigmas), t[0], t[-1])


def de(a: np.ndarray, b: np.ndarray) -> float:
    return float(C.de2000(C.srgb_to_lab(a.astype(np.float64)), C.srgb_to_lab(b.astype(np.float64))).mean())


def predict(s: Set, f: str, i: int, model: Detail) -> np.ndarray:
    """Model at the probe points: sum of tool contributions from a single base."""
    r = s.ref(i)
    b = s.points(f, r)
    y = luma(b)
    dy = np.zeros_like(y)
    for tool in TOOLS:
        v = getattr(s.controls[i], tool)
        p = model.part(tool, s.k) if v else None
        if p is None:
            continue
        tables = p.plus if v > 0 else p.minus
        for sg, t in zip(p.sigmas, tables):
            dy += v * np.interp(y, GRID, t).astype(np.float32) * s.hp(f, r, sg)
    return np.clip(b + dy[:, None], 0, 1)


def mse(s: Set, f: str, i: int, model: Detail | None) -> float:
    out = predict(s, f, i, model) if model else s.points(f, s.ref(i))
    return float(np.mean((luma(out) - luma(s.target(f, i))) ** 2))


def train_tool(s: Set, tool: str) -> tuple[Part, str] | None:
    """Radii by Y' error on held-out frames; dE at export noise is too coarse for the choice."""
    probes = s.single(tool)
    if not probes or len(s.frames) < 2:
        return None
    signs = {np.sign(getattr(s.controls[i], tool)) for i in probes}
    both = len(signs) == 2
    folds = [s.frames[j::2] for j in range(2)] if len(s.frames) >= 6 else [[f] for f in s.frames]
    best = None
    for sigmas in CANDIDATES[tool]:
        err = []
        for held in folds:
            fit = [f for f in s.frames if f not in held]
            m = Detail({tool: {s.k: to_part(solve(s, tool, sigmas, fit, probes, both), sigmas, both)}})
            err += [mse(s, f, i, m) for f in held for i in probes]
        e = float(np.mean(err))
        if best is None or e < best[0] * (1 - 0.01):    # next candidate only if noticeably better
            best = (e, sigmas)
    e, sigmas = best
    zero = float(np.mean([mse(s, f, i, None) for f in s.frames for i in probes]))
    noise = 1.5 * np.mean([s.noise(f) for f in s.frames]) if s.paired else 0.0
    share = 1 - (e - noise) / max(zero - noise, 1e-12)
    if zero - e < VISIBLE * max(noise, zero):
        # the effect at this scale drowns in export noise: the fit would be noise, store zero
        z = np.zeros((1, NB))
        return Part((1.0,), z, z), f"{tool} x{s.k}: invisible at this scale, zero"
    part = to_part(solve(s, tool, sigmas, s.frames, probes, both), sigmas, both)
    return part, (f"{tool} x{s.k}: sigma {', '.join(f'{v:g}' for v in sigmas)} px, held-out frames explain "
                  f"{share:.0%} of the response" + (" (net of export noise)" if s.paired else ""))


def report(s: Set, model: Detail):
    """By probe groups: model dE and without it, share of Y' response net of noise, noise of two neutrals."""
    print(f"  {'probe':<16} dE model  no model  explained")
    for i, c in enumerate(s.controls):
        if not any(detail_of(c)):
            continue
        rows = []
        for f in s.frames:
            t = s.target(f, i)
            noise = 1.5 * s.noise(f) if s.paired and s.ref(i) == CLEAN else 0.0
            rows.append((de(predict(s, f, i, model), t), de(s.points(f, s.ref(i)), t),
                         mse(s, f, i, model), mse(s, f, i, None), noise))
        a = np.array(rows)
        m, z, noise = a[:, 2].sum(), a[:, 3].sum(), a[:, 4].sum()
        # response below a quarter of export noise: the share means nothing
        share = "in noise" if z - noise < WEAK * noise else f"{1 - (m - noise) / (z - noise):.0%}"
        print(f"  {s.profiles[i]:<16} {a[:, 0].mean():6.2f}   {a[:, 1].mean():8.2f}   {share:>8}")
    if s.paired:
        print("  export noise: dE NEUTRAL vs NEUTRAL-B %.2f, rms Y' of one export %.4f" % (
            np.mean([de(s.points(f, "NEUTRAL"), s.points(f, "NEUTRAL-B")) for f in s.frames]),
            np.sqrt(np.mean([s.noise(f) for f in s.frames]))))
    else:
        print("  (no second neutral: \"explained\" is without a noise correction)")


def train() -> Detail:
    parts: dict[str, dict[int, Part]] = {}
    sets = []
    for name in ("tools", "detail"):
        if not os.path.exists(DATA[name]):
            print(f"missing {os.path.relpath(DATA[name], HERE)}: python3 detail.py collect {name}")
            continue
        z = np.load(DATA[name])
        ks = sorted({int(key.split("/")[1]) for key in z.files if key.endswith("/idx")})
        for k in ks:
            s = Set(z, k)
            sets.append((name, s))
            for tool in TOOLS:
                if k in parts.get(tool, {}):    # Clarity x4: the real 1512 px export is in tools, detail validates it
                    continue
                r = train_tool(s, tool)
                if r:
                    parts.setdefault(tool, {})[k] = r[0]
                    print(f"[{name}] {r[1]}")
    model = Detail(parts)
    for name, s in sets:
        print(f"[{name}] scale {s.k}, dE on all frames (the model was trained on them):")
        report(s, model)
    return model


def main():
    if sys.argv[1:2] == ["collect"] and len(sys.argv) == 3 and sys.argv[2] in DATA:
        collect(sys.argv[2])
    elif len(sys.argv) == 1:
        m = train()
        m.save()
        print("file:", PATH)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
