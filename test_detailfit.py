"""Unit tests for detailfit.py (the Clarity / Mid-range fit) on synthetic frames.

A random texture is the render's Y'; the target is that render plus the detail.py responses of
known values (and a tone curve that the cubic must absorb). The fit must recover the values; the
recursive Gaussian must behave like a Gaussian. No local data needed.

Run: python3 test_detailfit.py
"""
import numpy as np

import detail as D
import detailfit as DF

FAILS = 0


def check(ok, text):
    global FAILS
    if not ok:
        FAILS += 1
        print("FAIL", text)


def texture(h=420, w=560, seed=1):
    rng = np.random.default_rng(seed)
    y = np.zeros((h, w))
    for s in (1.5, 4, 12, 40):                       # detail at several scales
        y += DF.rgauss(rng.normal(size=(h, w)), s) * s ** 0.5
    y = (y - y.min()) / (y.max() - y.min())
    return 0.1 + 0.8 * y


def test_rgauss():
    a = np.zeros((101, 101))
    a[50, 50] = 1
    for s in (1.0, 3.0, 8.0):
        b = DF.rgauss(a, s)
        yy, xx = np.mgrid[:101, :101] - 50
        var = float((b * xx ** 2).sum() / b.sum())
        check(abs(b.sum() - 1) < 1e-3, f"rgauss {s}: unit gain ({b.sum():.4f})")
        check(abs(np.sqrt(var) / s - 1) < 0.06, f"rgauss {s}: sigma {np.sqrt(var):.3f}")
    c = np.full((40, 30), 0.3)
    check(np.allclose(DF.rgauss(c, 5.0), 0.3), "rgauss keeps a constant")


def target_of(y, model, scale, vals):
    t = y.copy()
    for tool, v in vals.items():
        if v:
            t += model.part(tool, scale).delta(y, v, scale)
    return np.clip(t ** 0.95, 0, 1)                   # a mild tone change for the cubic


def test_recovers_values():
    model = D.Detail.load()
    y = texture()
    scale = 4.0
    for vals in ({"clarity": 2.0, "mid_sharpening": 0.0}, {"clarity": -3.0, "mid_sharpening": 1.5},
                 {"clarity": 0.0, "mid_sharpening": 2.5}):
        t = target_of(y, model, scale, vals)
        r = DF.fit_detail([(y, t, np.ones(y.shape, bool), scale)], {"clarity": 0.0, "mid_sharpening": 0.0},
                          model, cal={})
        err = max(abs(r["raw"][k] - vals[k]) for k in vals)
        check(err < 0.35, f"recovers {vals}: got {r['raw']}")
        check(r["cost"] < r["cost0"], f"{vals}: the fit lowers the band residual")


def test_v0_and_cal():
    model = D.Detail.load()
    y = texture(seed=2)
    scale = 4.0
    # the render already has Mid-range 1: a target with Mid-range 1 must give 1
    rend = y + model.part("mid_sharpening", scale).delta(y, 1.0, scale)
    t = target_of(y, model, scale, {"mid_sharpening": 1.0, "clarity": 0.0})
    r = DF.fit_detail([(rend, t, np.ones(y.shape, bool), scale)], {"clarity": 0.0, "mid_sharpening": 1.0},
                      model, cal={})
    check(abs(r["raw"]["mid_sharpening"] - 1.0) < 0.35 and abs(r["raw"]["clarity"]) < 0.35,
          f"v0 is honored: {r['raw']}")
    # values are quantized to 0.25 and kept in range
    check(all(abs(v / DF.STEP - round(v / DF.STEP)) < 1e-9 and DF.RANGE[0] <= v <= DF.RANGE[1]
              for v in r["values"].values()), f"quantized values {r['values']}")
    # too few pixels: the pair is left out, the render's values come back
    small = DF.fit_detail([(y[:60, :60], t[:60, :60], np.ones((60, 60), bool), scale)],
                          {"clarity": 0.0, "mid_sharpening": 1.0}, model)
    check(small["pairs"] == 0 and small["values"] == {"clarity": 0.0, "mid_sharpening": 1.0},
          f"tiny pair skipped: {small}")


def main():
    for name, fn in sorted({k: v for k, v in globals().items() if k.startswith("test_")}.items()):
        fn()
        print(f"ok   {name}")
    print(f"\n{'ALL PASSED' if FAILS == 0 else f'{FAILS} FAILURES'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
