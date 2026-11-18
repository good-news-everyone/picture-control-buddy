"""Reference fixtures for the browser copy of the pipeline from the current Python code -> web/golden/.

Python is the source of truth. After changing a paired module (table in spec/web-tests.md) the
fixtures are rebuilt, then `node web/test.mjs` shows whether the browser has caught up.

    python3 web/make_golden.py

What is written:
  raw/<key>.f32       linear RGB as rawdev.develop + render.linear without vignetting (1600 px)
  synthetic/*.f32     a grid of linear colors and its devmodel.Dev neutral (no RAW)
  frames/<key>.png    render.py neutral with vignetting, 8 bit
  np3/<key>.json      a full breakdown of np3.deserialize of each .NP3 (level 4)
  manifest.json       the case list and tolerances
The web/bench.html rig shows frames from here too.
"""
import glob
import json
import os
import shutil
import sys

import brotli

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import devmodel  # noqa: E402
import devpairs  # noqa: E402
import detail  # noqa: E402
import np3  # noqa: E402
import profile_model  # noqa: E402
import rawdev  # noqa: E402
import render as RD  # noqa: E402
import strength  # noqa: E402
import vignette  # noqa: E402
import analyze  # noqa: E402
import color as C  # noqa: E402

OUT = os.path.join(HERE, "golden")
LONG = 1600


def src(rel: str) -> str:
    """A repo-relative data path: in the root or in _local/ (raws and renders are not committed)."""
    for p in (os.path.join(ROOT, rel), os.path.join(ROOT, "_local", rel)):
        if os.path.exists(p):
            return p
    raise FileNotFoundError(rel)


# Frames: Z f NEF (orientations 1, 6, 8) and a Z 8 DNG, all without people, plates and signs.
# Were test1/DSC_5584 (6), fuji160/DSC_4837.NEF+.dng (1), fuji_x100v/DSC_9991,
# renders/check/DSC_6203 (8), test2/SKL_3024.dng (Z 8, 6), nekit_examples/DSC_9916.dng (Z 8, 1):
# DSC_4837 excluded for a car with a readable plate, DSC_6203 for a x1.040 decode anomaly
# (LibRaw vs rawler, see spec/web-tests.md), DSC_9916 replaced by DSC_6132 for the overexposed sky.
FRAMES = [
    "renders/lr_test/DSC_6550.NEF",      # Z f, 1, greenery
    "renders/dev_sa/DSC_6474.NEF",       # Z f, 8, harbour
    "test1/DSC_5584.NEF",                # Z f, 6, splashes
    "renders/check/DSC_6132.NEF",        # Z f, 1, sunset, blown sun
    "test2/SKL_3024.dng",                # Z 8, 6, dark foliage
]
# Files the browser must reject with this code.
ERRORS = {
    "test2/SKL_3024.NEF": "nef_high_efficiency",
    "nekit_examples/DSC_9253.dng": "not_bayer",
}
# Tolerances (rationale in spec/web-tests.md).
TOL = {
    "raw_dng": {"max": 1.0, "mean": 0.05},          # 16-bit units
    "raw_nef": {"max": 16.0, "mean": 6.0},          # LibRaw subtracts black slightly differently
    "synthetic": {"max": 0.5 / 255, "mean": 0.02 / 255},   # float, 0..1 fractions
    "frames": {"mean": 0.3, "p99": 1, "max": 12},   # 8-bit levels; max — NEF shadows because of raw_nef
    "profile": {"mean": 0.05, "max": 0.5},          # dE2000 of 33^3 LUT knots vs profile_model.Model
    "detail": {"mean": 0.5, "max": 8},              # 8-bit levels; max is a safety net, the criterion is the mean
    "render7": {"mean": 0.3},                       # mean dE2000 over the sky/skin/green regions
}
# Level 7 regions — indices of analyze.GROUPS; one mask shared by all sides is written to golden.
RENDER7_REGIONS = {"skin": 1, "green": 5, "sky": 7}
# Level 7 profiles: project profiles from out/ with their own curve, different strength.scaled values.
RENDER7_PROFILES = [
    ("out/dsc_6366/NIKON/CUSTOMPC/PICCON01.NP3", 100),
    ("out/dsc_6366/NIKON/CUSTOMPC/PICCON01.NP3", 50),
    ("out/portra400/NIKON/CUSTOMPC/PICCON01.NP3", 100),
]
SYNTH = 256
SYNTH_VIGNETTE = (-0.45, 1.2)

# Level 6: 512^2 cutouts with edges and texture from the set frames' neutral.
# The scale in entries is the Detail.__call__ parameter: the cutout pretends to be a frame of
# that scale, so full-frame sigmas (0.5-180 px) give noticeable kernels even on a small cutout.
# Control defaults are sharpening=2.0/mid=1.0/clarity=0.5: the zero case sets everything explicitly.
DETAIL_SIZE = 512
DETAIL_CONTROLS = [
    ("zero", 2.0, (0.0, 0.0, 0.0)),                           # all zero — identity
    ("sharp9", 2.0, (9.0, 0.0, 0.0)),                         # plus edge
    ("sharpm3", 2.0, (-3.0, 0.0, 0.0)),                       # minus edge
    ("mid5", 3.0, (0.0, 5.0, 0.0)),                           # a x4 part (nearest by log)
    ("clarity2", 2.0, (0.0, 0.0, 2.0)),
    ("claritm2", 4.0, (0.0, 0.0, -2.0)),                      # a x4 part, the minus table
    ("all", 2.0, (2.0, -3.0, 1.5)),
    ("allm", 4.0, (-2.0, 3.0, -1.0)),
]

# Finished profiles of level 5: project profiles with and without a curve, various blender/grading combos.
PROFILE_READY = [
    "out/dsc_6366/NIKON/CUSTOMPC/PICCON01.NP3",        # curve, blender, grading, sat -7
    "out/portra400/NIKON/CUSTOMPC/PICCON01.NP3",       # curve, blender, grading
    "out/fuji_pro_400_v3/NIKON/CUSTOMPC/PICCON01.NP3", # curve, sat -18, blending 7
    "out/test2_SKL_3024/NIKON/CUSTOMPC/PICCON01.NP3",  # curve, part of the blender
    "out/lr_test_sky4/NIKON/CUSTOMPC/PICCON01.NP3",    # curve, sat 3, balance -23
    "out/skl/NIKON/CUSTOMPC/PICCON01.NP3",             # curve, 7 blender colors
    "out/pack1/NIKON/CUSTOMPC/PICCON05.NP3",           # no curve, only sat -100
    "out/pack1/NIKON/CUSTOMPC/PICCON28.NP3",           # curve + sat -22 + blender
]
PROFILE_GRID = 33


def rnd_control(rng, i: int) -> np3.Control:
    """A random combination of all sliders; a curve in half the cases, a spline through points."""
    c = np3.Control(name=f"GOLDEN-R{i:02d}")
    c.saturation = int(rng.integers(-100, 101))
    c.blending = int(rng.integers(0, 101))
    c.balance = int(rng.integers(-100, 101))
    c.blender = {col: [int(rng.integers(-100, 101)) for _ in range(3)] for col in np3.COLORS}
    c.grade = {z: [int(rng.integers(0, 360)), int(rng.integers(-100, 101)), int(rng.integers(-100, 101))]
               for z in np3.ZONES}
    if rng.random() < 0.5:
        pts = sorted({(int(rng.integers(0, 256)), int(rng.integers(0, 256)))
                      for _ in range(int(rng.integers(2, 8)))})
        c.curve = np3.curve_table(pts)
    else:
        for k in ("contrast", "highlights", "shadows", "white", "black"):
            setattr(c, k, int(rng.integers(-100, 101)))
    return c


def profile_controls() -> list[tuple[str, np3.Control]]:
    """Key and control of each level-5 fixture: finished, random (seed), extreme values."""
    out = []
    for rel in PROFILE_READY:
        c = np3.deserialize(open(os.path.join(ROOT, rel), "rb").read())
        out.append((f"ready-{rel.replace('out/', '').replace('.NP3', '').replace('/', '-')}", c))
    rng = np.random.default_rng(5)
    for i in range(12):
        out.append((f"rnd-{i:02d}", rnd_control(rng, i)))
    for val, tag in ((100, "p100"), (-100, "m100")):
        c = np3.Control(name=f"GOLDEN-{tag}")
        c.saturation = val
        out.append((f"sat-{tag}", c))
    for val, tag in ((0, "0"), (100, "100")):                      # Blending moves the zone masks
        c = np3.Control(name=f"GOLDEN-b{tag}", blending=val)
        c.grade = {z: [45, 40, 0] for z in np3.ZONES}
        out.append((f"blending-{tag}", c))
    for val, tag in ((-100, "m100"), (100, "p100")):                # Balance moves the zone masks
        c = np3.Control(name=f"GOLDEN-bal{tag}", balance=val)
        c.grade = {z: [200, 60, 0] for z in np3.ZONES}
        out.append((f"balance-{tag}", c))
    for col in np3.COLORS:                                          # single blender color, all attributes
        for sign, tag in ((1, "p"), (-1, "m")):
            c = np3.Control(name=f"GOLDEN-{col[:3]}{tag}")
            c.blender = {k: ([100 * sign] * 3 if k == col else [0, 0, 0]) for k in np3.COLORS}
            out.append((f"blender-{col}-{tag}100", c))
    for z in np3.ZONES:                                             # grading: hue 0..359, chroma +-100
        for hue in profile_model.GRADE_HUES:
            c = np3.Control(name=f"GOLDEN-{z[:3]}{hue:03d}")
            c.grade = {k: ([hue, 100, 0] if k == z else [0, 0, 0]) for k in np3.ZONES}
            out.append((f"grade-{z}-{hue:03d}", c))
        c = np3.Control(name=f"GOLDEN-{z[:3]}cm")
        c.grade = {k: ([30, -100, 0] if k == z else [0, 0, 0]) for k in np3.ZONES}
        out.append((f"grade-{z}-m100", c))
        for sign, tag in ((1, "p"), (-1, "m")):                     # zone brightness
            c = np3.Control(name=f"GOLDEN-{z[:3]}b{tag}")
            c.grade = {k: ([0, 0, 100 * sign] if k == z else [0, 0, 0]) for k in np3.ZONES}
            out.append((f"gradebright-{z}-{tag}100", c))
    return out


def control_json(c):
    return {
        "name": c.name, "comment": c.comment,
        "sharpening": c.sharpening, "mid_sharpening": c.mid_sharpening,
        "clarity": c.clarity, "contrast": c.contrast, "highlights": c.highlights,
        "shadows": c.shadows, "white": c.white, "black": c.black,
        "saturation": c.saturation, "blender": c.blender, "grade": c.grade,
        "blending": c.blending, "balance": c.balance,
        "curve": None if c.curve is None else {"raw": c.curve.raw, "points": c.curve.points},
    }


# Bases for the strength fixtures: curve + comment, curve without comment, no curve,
# long name (suffix truncation), a project profile with a curve.
STRENGTH_BASES = [
    "third_party/samples/comment-a-tonecurve.NP3",
    "third_party/samples/tonecurve-black.NP3",
    "third_party/samples/vanilla.NP3",
    "third_party/samples/longest-comment.NP3",
    "out/dsc_6366/NIKON/CUSTOMPC/PICCON01.NP3",
]
STRENGTH_PERCENTS = [0, 30, 50, 70, 100, 150]


def key_of(path: str) -> str:
    return path.replace("/", "__")


def linear_plain(raw: str) -> np.ndarray:
    """render.linear without vignetting: margins, integer shrinking, rotation."""
    lin = rawdev.develop(raw)[devpairs.MY:-devpairs.MY, devpairs.MX:-devpairs.MX]
    k = -(-max(lin.shape) // LONG)
    return np.ascontiguousarray(np.rot90(devpairs.shrink(lin, k), RD.TURNS.get(RD.orientation(raw), 0)))


def synthetic() -> np.ndarray:
    """SYNTH x SYNTH camera linear RGB: random colors over the whole curve range, near-greys, special points."""
    rng = np.random.default_rng(0)
    n = SYNTH * SYNTH
    lo, hi = devmodel.KNOTS[0] - 3, devmodel.KNOTS[-1] + 1.5
    x = 2 ** rng.uniform(lo, hi, (n, 3))
    gray = 2 ** rng.uniform(lo, hi, n // 4)
    x[: n // 4] = gray[:, None] * (1 + rng.normal(0, .03, (n // 4, 3)))
    special = np.array([[0, 0, 0], [1, 1, 1], [4, 4, 4], [1, 0, 0], [0, 1, 0], [0, 0, 1], [2 ** -11] * 3, [.18] * 3])
    x[-len(special):] = special
    return x.reshape(SYNTH, SYNTH, 3)


def save_f32(rel: str, a: np.ndarray, compress: bool = False):
    """Writes a float32 array; compress=True writes a brotli copy .br instead (read by Node only)."""
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    b = np.ascontiguousarray(a, dtype="<f4").tobytes()
    if compress:
        path += ".br"
        b = brotli.compress(b, quality=9 if len(b) > 2_000_000 else 11)
    open(path, "wb").write(b)


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    dev = devmodel.Dev.load(devmodel.RENDER)
    r = RD.Renderer()
    man = {"tolerances": TOL, "long": LONG, "raw": [], "errors": [], "synthetic": [], "frames": []}

    x = synthetic()
    save_f32("synthetic/in.f32", x)
    for name, ab in (("plain", (0.0, 0.0)), ("vignette", SYNTH_VIGNETTE)):
        y = dev(vignette.correct(x, ab).reshape(-1, 3)).reshape(x.shape)
        save_f32(f"synthetic/{name}.f32", y)
        man["synthetic"].append({"name": name, "in": "synthetic/in.f32", "out": f"synthetic/{name}.f32",
                                 "w": SYNTH, "h": SYNTH, "vignette": list(ab)})

    for rel in FRAMES:
        path = src(rel)
        k = key_of(rel)
        lin = linear_plain(path)
        save_f32(f"raw/{k}.f32", lin, compress=True)
        dng = rel.lower().endswith(".dng")
        man["raw"].append({"key": k, "path": rel, "w": lin.shape[1], "h": lin.shape[0], "dng": dng,
                           "file": f"raw/{k}.f32.br"})
        ab = list(vignette.coefficients(path))
        os.makedirs(os.path.join(OUT, "frames"), exist_ok=True)
        RD.to_image(r.neutral(RD.linear(path))).save(os.path.join(OUT, "frames", k + ".png"))
        man["frames"].append({"key": k, "path": rel, "w": lin.shape[1], "h": lin.shape[0], "vignette": ab,
                              "png": f"frames/{k}.png"})
        print(f"{rel:32s} {lin.shape[1]}x{lin.shape[0]}  vignetting {ab[0]:+.3f} {ab[1]:+.3f}")

    for path, code in ERRORS.items():
        man["errors"].append({"path": path, "code": code})

    # ---------- level 4: NP3 ----------
    man["np3"] = []
    np3_paths = sorted(glob.glob(os.path.join(ROOT, "third_party/samples/*.NP3")) +
                       glob.glob(os.path.join(ROOT, "out/**/*.NP3"), recursive=True))
    for path in np3_paths:
        rel = os.path.relpath(path, ROOT)
        key = key_of(rel)
        data = open(path, "rb").read()
        c = np3.deserialize(data)
        d = control_json(c)
        os.makedirs(os.path.join(OUT, "np3"), exist_ok=True)
        # the profile bytes go next to the json: tests must not depend on out/
        open(os.path.join(OUT, "np3", key), "wb").write(data)
        json.dump(d, open(os.path.join(OUT, "np3", key + ".json"), "w"), ensure_ascii=False)
        man["np3"].append({"path": rel, "file": key})
    print(f"np3: {len(np3_paths)} profiles")

    # ---------- strength: scaled fields vs strength.py ----------
    man["strength"] = []
    for rel in STRENGTH_BASES:
        key = key_of(rel)
        base_bytes = open(os.path.join(ROOT, rel), "rb").read()
        base = np3.deserialize(base_bytes)
        os.makedirs(os.path.join(OUT, "strength"), exist_ok=True)
        open(os.path.join(OUT, "strength", key + ".NP3"), "wb").write(base_bytes)
        for pct in STRENGTH_PERCENTS:
            label = f"-{pct}"
            s = strength.scaled(base, pct, base.name[:19 - len(label)] + label)
            d = control_json(s)
            os.makedirs(os.path.join(OUT, "strength"), exist_ok=True)
            name = f"{key}__{pct}.json"
            json.dump(d, open(os.path.join(OUT, "strength", name), "w"), ensure_ascii=False)
            man["strength"].append({"path": rel, "percent": pct, "file": name, "bytes": key + ".NP3"})
    print(f"strength: {len(man['strength'])} fixtures")

    # ---------- level 5: a 33^3 profile LUT vs profile_model.Model ----------
    man["profile"] = []
    pmodel = profile_model.Model.load(profile_model.PATH)
    g5 = np.linspace(0, 1, PROFILE_GRID)
    grid5 = np.stack(np.meshgrid(g5, g5, g5, indexing="ij"), -1).reshape(-1, 3)
    for key, c in profile_controls():
        ref = pmodel(grid5, c)
        os.makedirs(os.path.join(OUT, "profile"), exist_ok=True)
        save_f32(f"profile/{key}.bin", ref, compress=True)
        # the fixture is read from the same .NP3 bytes the browser sees: serialize -> deserialize
        data = np3.serialize(np3.deserialize(np3.serialize(c)))
        open(os.path.join(OUT, "profile", key + ".NP3"), "wb").write(data)
        man["profile"].append({"key": key, "file": f"profile/{key}.bin.br", "np3": f"profile/{key}.NP3"})
    print(f"profile: {len(man['profile'])} fixtures of 33^3 LUTs")

    # ---------- level 6: detail on neutral cutouts ----
    man["detail"] = []
    det = detail.Detail.load()
    for rel in FRAMES:
        path = src(rel)
        base = r.neutral(RD.linear(path))
        k = key_of(rel)
        h, w = base.shape[:2]
        for ci, (oy, ox) in enumerate(((h // 2 - DETAIL_SIZE // 2, w // 2 - DETAIL_SIZE // 2),
                                       (h // 4, w // 4))):
            crop = base[oy:oy + DETAIL_SIZE, ox:ox + DETAIL_SIZE]
            os.makedirs(os.path.join(OUT, "detail"), exist_ok=True)
            in_png = f"detail/{k}__{ci}.png"
            RD.to_image(crop).save(os.path.join(OUT, in_png))
            # detail is computed from the same PNG the browser decodes: the input is identical
            x = np.asarray(Image.open(os.path.join(OUT, in_png))).astype(np.float64) / 255
            for ckey, scale, (sharp, mid, clar) in DETAIL_CONTROLS:
                c = np3.Control(name=f"GOLDEN-{ckey}", sharpening=sharp, mid_sharpening=mid, clarity=clar)
                out = det(x, c, scale=scale)
                out_png = f"detail/{k}__{ci}__{ckey}.png"
                RD.to_image(out).save(os.path.join(OUT, out_png))
                np3_path = f"detail/{k}__{ci}__{ckey}.NP3"
                open(os.path.join(OUT, np3_path), "wb").write(
                    np3.serialize(np3.deserialize(np3.serialize(c))))
                man["detail"].append({"key": f"{k}__{ci}__{ckey}", "in": in_png, "out": out_png,
                                      "np3": np3_path, "w": DETAIL_SIZE, "h": DETAIL_SIZE, "scale": scale})
    print(f"detail: {len(man['detail'])} fixtures on {DETAIL_SIZE}^2 cutouts")

    # ---------- level 7: the whole render (neutral + profile + detail) ----------
    man["render7"] = []
    man["render7_regions"] = RENDER7_REGIONS
    for rel in FRAMES:
        path = src(rel)
        k = key_of(rel)
        base = r.neutral(RD.linear(path))
        ab = list(vignette.coefficients(path))
        h, w = base.shape[:2]
        os.makedirs(os.path.join(OUT, "render7"), exist_ok=True)
        # region mask from neutral: analyze.GROUPS indices x20 in a grayscale PNG
        lab = C.srgb_to_lab(base.reshape(-1, 3).astype(np.float64))
        mask = analyze.labels(lab).reshape(h, w).astype(np.uint8) * 20
        mask_png = f"render7/{k}__mask.png"
        Image.fromarray(mask, mode="L").save(os.path.join(OUT, mask_png))
        for rel2, pct in RENDER7_PROFILES:
            c0 = np3.deserialize(open(os.path.join(ROOT, rel2), "rb").read())
            label = f"-{pct}"
            c = strength.scaled(c0, pct, c0.name[:19 - len(label)] + label)
            out = r.apply(base, c, sharp=True)
            pk = f"{key_of(rel2)}__{pct}"
            out_png = f"render7/{k}__{pk}.png"
            RD.to_image(out).save(os.path.join(OUT, out_png))
            np3f = f"render7/{k}__{pk}.NP3"
            open(os.path.join(OUT, np3f), "wb").write(np3.serialize(np3.deserialize(np3.serialize(c))))
            man["render7"].append({"key": f"{k}__{pct}", "path": rel, "np3": np3f, "out": out_png,
                                   "mask": mask_png, "w": w, "h": h, "vignette": ab})
    print(f"render: {len(man['render7'])} full-pipeline fixtures")

    json.dump(man, open(os.path.join(OUT, "manifest.json"), "w"), indent=1, ensure_ascii=False)
    print("fixtures:", OUT)


if __name__ == "__main__":
    main()
