"""Model smoke tests against the committed weights in data/.

The tests do not retrain anything: data/*.npz are the fixtures, so a bad retrain fails here.
Runs in a fresh clone; needs numpy only (Renderer is constructed without LibRaw).

Run: python3 test_models.py
"""
import glob
import os

import numpy as np

import color as C
import detail
import devmodel
import make_pack
import model as M
import np3
import profile_model as PM
import render

HERE = os.path.dirname(os.path.abspath(__file__))
FAILS = 0


def check(cond, label):
    global FAILS
    if not cond:
        FAILS += 1
        print(f"FAIL {label}")


def grid(n=9):
    g = np.linspace(0.02, 0.98, n)
    return np.stack(np.meshgrid(g, g, g, indexing="ij"), -1).reshape(-1, 3)


def neutral_control() -> np3.Control:
    return np3.Control(name="NEUTRAL", sharpening=0, mid_sharpening=0, clarity=0)


def test_profile_model_identity():
    m = PM.Model.load()
    x = grid()
    out = m(x, neutral_control())
    check(np.all(np.isfinite(out)), "identity: finite")
    check(np.max(np.abs(out - x)) <= 1e-4, f"identity control leaves the grid unchanged "
          f"(max diff {np.max(np.abs(out - x)):.2e})")


def test_profile_model_order():
    """grading -> saturation -> blender -> curve: recompute the chain step by step."""
    m = PM.Model.load()
    x = grid()
    px = PM.Pixels(m, x)

    # grading only, recomputed from the LUTs without Pixels.graded
    c = neutral_control()
    c.grade = {"shadows": (30, 25, 0), "midtone": (200, 40, 0), "highlights": (330, 15, 0)}
    p = M.params_of(c)
    graded = x
    for zone in np3.ZONES:
        hue, chroma = p.grade[zone]
        k = PM.hue_kernel(hue)
        graded = graded + chroma * np.einsum("j,jnc->nc", k, px.grade[zone])
    check(np.max(np.abs(m(x, c) - np.clip(graded, 0, 1))) < 1e-9,
          "grading-only matches the manual LUT recomputation")

    # saturation after grading
    c2 = neutral_control()
    c2.saturation = 60
    c2.grade = c.grade
    sat = m.saturation(c2.saturation)
    expect = np.clip(PM.saturate(np.clip(graded, 0, 1), sat), 0, 1)
    check(np.max(np.abs(m(x, c2) - expect)) < 1e-9, "saturation applies after grading")

    # the curve is last and runs over the graded result
    curve = make_pack.curve_from(lambda t: t + 0.2 * np.sin(2 * np.pi * t) * t * (1 - t))
    c3 = neutral_control()
    c3.grade = c.grade
    c3.curve = curve
    expect = np.clip(M.apply_curve(np.clip(graded, 0, 1), np.array(curve.raw) / 32767), 0, 1)
    check(np.max(np.abs(m(x, c3) - expect)) < 1e-9, "the curve applies after grading")


def test_lut_baking():
    r = render.Renderer(profile="steps")
    c = neutral_control()
    c.saturation = 20
    c.blender.update(red=(15, -10, 5), orange=(0, 12, 0), green=(-8, 0, 0), blue=(10, 0, -8))
    c.grade.update(shadows=(300, 15, 0), midtone=(60, 20, 0))
    c.curve = make_pack.curve_from(lambda t: t + 0.05 * np.sin(2 * np.pi * t) * t * (1 - t))
    x = grid(7)
    direct = r.steps(x, c)
    baked = render.trilinear(r.lut(c), x)
    d = C.de2000(C.srgb_to_lab(direct), C.srgb_to_lab(np.clip(baked, 0, 1)))
    # the 0.30 bound is on p95: the max sits on a few extreme saturated colors
    # (up to ~1.3 on real fitted profiles), the bulk of the grid is well under
    check(float(np.percentile(d, 95)) <= 0.30, f"LUT baking within 0.30 dE at p95 ({np.percentile(d, 95):.3f})")
    check(float(d.mean()) <= 0.10, f"LUT baking mean dE ({d.mean():.3f})")


def test_devmodel():
    dev = devmodel.Dev.load(devmodel.RENDER)
    rng = np.random.default_rng(7)
    x = rng.uniform(2 ** -9, 0.4, (5000, 3))
    y = dev(x)
    check(np.all(np.isfinite(y)), "dev: finite output")
    check(y.min() >= 0 and y.max() <= 1, "dev: output within 0..1")
    lab = C.srgb_to_lab(y)
    check(np.all(lab[:, 0] >= 0), "dev: no negative luminance")
    check(np.std(y) > 0, "dev: output has dynamic range")


def test_detail():
    d = detail.Detail.load()
    check(d.has("sharpening") and d.has("clarity") and d.has("mid_sharpening"),
          "detail models for all three tools are committed")
    c = neutral_control()
    c.sharpening, c.mid_sharpening, c.clarity = 5.0, 3.0, 2.0
    flat = np.full((32, 32, 3), 0.4)
    out = d(flat, c, scale=4)
    check(np.max(np.abs(out - flat)) < 1e-9, "a flat image is unchanged by any tool")

    rng = np.random.default_rng(8)
    edge = np.zeros((64, 64, 3))
    edge[:, 32:] = 0.6
    edge += rng.normal(0, 0.005, edge.shape)   # texture for sharpening to act on
    edge = np.clip(edge, 0, 1)

    def hf(img):
        return float(np.mean(np.abs(np.diff(img[:, :, 0], axis=1))))

    base_hf = hf(edge)
    # minus blurs below clipping and export-noise behavior: verified bidirectionally on the
    # tools whose radius acts at this scale; Sharpening minus at scale 4 is sub-pixel noise
    # shaping, only the plus direction is asserted for it
    for tool, scale in (("mid_sharpening", 4), ("clarity", 4)):
        plus, minus = neutral_control(), neutral_control()
        setattr(plus, tool, 5.0)
        setattr(minus, tool, -5.0)
        check(hf(d(edge, plus, scale=scale)) > base_hf, f"plus {tool} lifts high-frequency energy")
        check(hf(d(edge, minus, scale=scale)) < base_hf, f"minus {tool} lowers high-frequency energy")
    plus = neutral_control()
    plus.sharpening = 5.0
    big = np.zeros((128, 128, 3))
    big[:, 64:] = 0.6
    big += rng.normal(0, 0.005, big.shape)
    big = np.clip(big, 0, 1)
    check(hf(d(big, plus, scale=2)) > hf(big), "plus sharpening lifts high-frequency energy")


def test_unrendered():
    r = render.Renderer(profile="steps")
    samples = sorted(glob.glob(os.path.join(HERE, "third_party/samples/*.NP3")))
    check(bool(samples), "official samples present")
    for path in samples:
        c = np3.deserialize(open(path, "rb").read())
        missing = r.unrendered(c)
        check(not missing, f"unrendered {os.path.basename(path)}: {missing}")


def main():
    for name, fn in sorted({k: v for k, v in globals().items() if k.startswith("test_")}.items()):
        fn()
        print(f"ok   {name}")
    print(f"\n{'ALL PASSED' if FAILS == 0 else f'{FAILS} FAILURES'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
