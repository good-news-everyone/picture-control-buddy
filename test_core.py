"""Golden-value tests for the pure libraries: color, np3.curve_table, strength, fit.

No data files needed; runs in a fresh clone.

Run: python3 test_core.py
"""
import dataclasses

import numpy as np

import color as C
import fit
import make_pack
import np3
import strength

FAILS = 0


def check(cond, label):
    global FAILS
    if not cond:
        FAILS += 1
        print(f"FAIL {label}")


# --- color.py -----------------------------------------------------------------

def test_color_roundtrips():
    rng = np.random.default_rng(1)
    rgb = rng.random((50, 3))
    back = C.lab_to_srgb(C.srgb_to_lab(rgb))
    check(np.max(np.abs(back - rgb)) < 1e-8, "srgb<->lab round-trip")
    lin = C.srgb_to_linear(rgb)
    check(np.max(np.abs(C.linear_to_srgb(lin) - rgb)) < 1e-12, "srgb<->linear round-trip")
    okl = C.linear_to_oklab(lin)
    check(np.max(np.abs(C.oklab_to_linear(okl) - lin)) < 1e-10, "oklab round-trip")


def test_color_reference():
    lab = C.srgb_to_lab([0.5, 0.2, 0.8])
    ref = [40.04429601, 60.25576689, -65.67507313]
    check(np.max(np.abs(lab - ref)) < 1e-6, "srgb_to_lab reference value")
    okl = C.linear_to_oklab(C.srgb_to_linear([0.5, 0.2, 0.8]))
    ref = [0.5103193, 0.11532589, -0.18743142]
    check(np.max(np.abs(okl - ref)) < 1e-6, "linear_to_oklab reference value")


def test_de2000_sharma():
    """Reference pairs from Sharma, Wu & Dalal (2005)."""
    pairs = [
        ((50, 2.6772, -79.7751), (50, 0, -82.7485), 2.0425),
        ((50, 3.1571, -77.2803), (50, 0, -82.7485), 2.8615),
        ((50, 2.8361, -74.0200), (50, 0, -82.7485), 3.4412),
        ((50, -1.3802, -84.2814), (50, 0, -82.7485), 1.0000),
        ((50, -1.1848, -84.8006), (50, 0, -82.7485), 1.0000),
        ((50, -0.9009, -85.5211), (50, 0, -82.7485), 1.0000),
        ((50, 0, 0), (50, -1, 2), 2.3669),
        ((50, 2.4900, -0.0010), (50, 2.4900, -0.0010), 0.0000),
        ((50, 2.4900, -0.0010), (50, -2.4900, 0.0009), 7.1792),
        ((50, 2.4900, -0.0010), (50, -2.4900, 0.0010), 7.1792),
        ((50, -2.4900, 0.0009), (50, 2.4900, -0.0010), 7.1792),
        ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
        ((63.0109, -31.0961, -5.8662), (61.2901, -29.2346, -4.9624), 1.7411),
        ((61.2901, -29.2346, -4.9624), (63.0109, -31.0961, -5.8662), 1.7411),
        ((35.0831, -44.1164, 3.7933), (35.0232, -40.0716, 1.5901), 1.8645),
        ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619), 2.0373),
        ((36.4612, 47.8580, 18.3852), (36.2715, 50.5065, 21.2231), 1.4146),
        ((90.8027, -2.0831, 1.4410), (91.1528, -1.6435, 0.0447), 1.4441),
        ((90.9257, -0.5406, -0.9208), (88.6381, -0.8985, -0.7239), 1.5381),
        ((6.7747, -0.2908, -2.4247), (5.8714, -0.0985, -2.2286), 0.6377),
        ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
    ]
    for l1, l2, ref in pairs:
        d = float(C.de2000(np.array(l1), np.array(l2)))
        check(abs(d - ref) < 1e-4, f"de2000 {l1} vs {l2}: {d:.4f} != {ref}")


def test_de2000_weights():
    rng = np.random.default_rng(2)
    lab = np.c_[rng.uniform(5, 95, 30), rng.uniform(-60, 60, 30), rng.uniform(-60, 60, 30)]
    d = rng.normal(0, 0.5, (30, 3))
    exact = C.de2000(lab, lab + d)
    approx = np.linalg.norm(C.weighted(C.de2000_weights(lab), d), axis=1)
    err = np.abs(approx - exact) / np.maximum(exact, 1e-6)
    check(np.percentile(err, 90) < 0.02, f"de2000_weights within 2% of de2000 (p90 err {np.percentile(err, 90):.4f})")
    # grey inputs: no NaN, finite weights
    grey = np.tile([50.0, 0.0, 0.0], (5, 1))
    W = C.de2000_weights(grey)
    check(np.all(np.isfinite(W)), "de2000_weights finite on grey")


# --- np3.curve_table -----------------------------------------------------------

def test_curve_table():
    check(np3.curve_table([(0, 0), (255, 255)]).raw == np3.identity_curve().raw,
          "identity points give the identity curve")
    c = np3.curve_table([(10, 20), (200, 220)])
    check(c.raw[0] == round(20 * 32767 / 255) and c.raw[256] == round(220 * 32767 / 255),
          "curve endpoints")
    c = np3.curve_table([(-50, -80), (300, 400)])
    check(min(c.raw) >= 0 and max(c.raw) <= 32767, "curve clamping to 0..255")
    # evenly spaced near-linear monotone data: the natural spline stays monotone
    # (arbitrary unevenly spaced monotone data is NOT monotone-preserving, that is not a bug)
    rng = np.random.default_rng(3)
    for _ in range(50):
        xs = np.linspace(0, 255, 8)
        slope = rng.uniform(0.3, 1.2)
        ys = slope * xs + np.cumsum(rng.normal(0, 1.0, 8))
        if np.diff(ys).min() < 0.2:
            continue
        raw = np3.curve_table([(float(x), float(y)) for x, y in zip(xs, ys)]).raw
        check(all(b >= a for a, b in zip(raw, raw[1:])), "monotonicity on near-linear points")
    # the spline through make_pack.curve_from editor points reproduces its table
    for f in (lambda t: t ** 2.2, lambda t: 0.3 * t + 0.7 * t ** 3, lambda t: 0.5 + 0.4 * np.tanh(4 * t - 2)):
        src = make_pack.curve_from(f)
        rebuilt = np3.curve_table(src.points)
        diff = np.max(np.abs(np.array(rebuilt.raw) - np.array(src.raw)))
        check(diff <= 260, f"curve_table reproduces curve_from samples (max diff {diff})")


def test_xs_anchors():
    xs = [round(i * 255 / 19) for i in range(20)]
    check(list((fit.XS * 255).round().astype(int)) == xs, "fit.XS matches NP3 curve anchor positions")
    c = make_pack.curve_from(lambda t: t)
    check([p[0] for p in c.points] == xs, "make_pack point x positions match fit.XS")


# --- strength.scaled -----------------------------------------------------------

def sample_control():
    return np3.Control(
        name="TEST", sharpening=2.0, mid_sharpening=1.0, clarity=-2,
        contrast=40, highlights=-30, shadows=25, white=10, black=-15, saturation=60,
        blender={c: (10 + i, -20 + i, 30 - i) for i, c in enumerate(np3.COLORS)},
        grade={z: (i * 120, 40 - 10 * i, 20 + 10 * i) for i, z in enumerate(np3.ZONES)},
        curve=make_pack.curve_from(lambda t: t + 0.3 * (t - t ** 2)))


def test_strength():
    c = sample_control()
    same = strength.scaled(c, 100, "X")
    for s in strength.SLIDERS:
        check(getattr(same, s) == getattr(c, s), f"strength 100 keeps {s}")
    check(same.blender == c.blender, "strength 100 keeps blender")
    check(same.grade == c.grade, "strength 100 keeps grade")
    check(list(same.curve.raw) == list(c.curve.raw), "strength 100 keeps the curve table")

    zero = strength.scaled(c, 0, "X")
    for s in strength.SLIDERS:
        check(getattr(zero, s) == 0, f"strength 0 zeroes {s}")
    check(all(v == (0, 0, 0) for v in zero.blender.values()), "strength 0 zeroes blender")
    check(all(ch == 0 and br == 0 for _, ch, br in zero.grade.values()), "strength 0 zeroes grade")
    check(list(zero.curve.raw) == list(np3.identity_curve().raw), "strength 0 gives the identity curve")

    ab = strength.scaled(strength.scaled(c, 30, "X"), 50, "X")
    direct = strength.scaled(c, 15, "X")
    for s in strength.SLIDERS:
        check(getattr(ab, s) == getattr(direct, s), f"strength commutativity of {s}")
    d = np.max(np.abs(np.array(ab.curve.raw) - np.array(direct.curve.raw)))
    check(d <= 260, f"strength commutativity of curve (max diff {d})")

    for f in ("sharpening", "mid_sharpening", "clarity", "blending", "balance"):
        check(getattr(ab, f) == getattr(c, f), f"strength does not touch {f}")
    check(ab.grade.keys() == c.grade.keys() and
          all(ab.grade[z][0] == c.grade[z][0] for z in ab.grade), "strength keeps grading hue")
    check(ab.name == "X", "name set")


# --- fit.py --------------------------------------------------------------------

def pack_params(p) -> np.ndarray:
    b = np.array([p.blender[c] for c in np3.COLORS]).ravel()
    g = np.array([[p.grade[z][1] * np.cos(np.radians(p.grade[z][0])),
                   p.grade[z][1] * np.sin(np.radians(p.grade[z][0]))] for z in np3.ZONES]).ravel()
    grid = np.linspace(0, 1, 257)
    k = np.interp(fit.XS, grid, p.curve)   # table values at the anchors are the knots
    return np.r_[b, g, np.abs(np.diff(np.r_[0.0, k]))]


def test_unpack_roundtrip():
    rng = np.random.default_rng(4)
    x = np.r_[rng.uniform(-50, 50, fit.NB + fit.NG), rng.uniform(0, 0.08, fit.NC)]
    p = fit.unpack(x)
    x2 = pack_params(p)
    p2 = fit.unpack(x2)
    for c in np3.COLORS:
        check(np.allclose(p.blender[c], p2.blender[c]), f"unpack round-trip blender {c}")
    for z in np3.ZONES:
        h1, c1 = p.grade[z]
        h2, c2 = p2.grade[z]
        check(abs(c1 - c2) < 1e-9 and abs(np.sin(np.radians(h1 - h2))) < 1e-9,
              f"unpack round-trip grade {z}")
    t1, t2 = fit.table(x[fit.NB + fit.NG:]), fit.table(x2[fit.NB + fit.NG:])
    # 2e-3: the 20-anchor double-interpolation round trip loss, not a packing bug
    check(np.max(np.abs(t1 - t2)) < 2e-3, "unpack round-trip curve")


def test_lm_linear():
    rng = np.random.default_rng(5)
    n = fit.NB + fit.NG + fit.NC
    A = rng.normal(0, 1, (n, n))
    x_true = np.r_[rng.uniform(-20, 20, fit.NB + fit.NG), rng.uniform(0, 0.05, fit.NC)]
    x, cost = fit.lm(lambda v: A @ (v - x_true), rng.normal(0, 5, n), iters=60)
    check(np.isfinite(cost) and cost < 1e-6, f"lm recovers a linear model (cost {cost:.2e})")
    check(np.max(np.abs(x - x_true)) < 1e-2, "lm solution close to the true one")


def test_lm_flat_curve():
    """Regression: on a flat curve segment the curve jacobian is zero and the
    unregularized normal equations are singular; the diagonal bound must keep the
    step finite (spec/decisions.md)."""
    rng = np.random.default_rng(6)
    head = fit.NB + fit.NG
    A = rng.normal(0, 1, (head, head))
    target = rng.normal(0, 1, head)

    def fn(v):
        return np.r_[A @ (v[:head] - target), np.full(fit.NC, 0.001)]  # tail: no signal

    x0 = np.zeros(head + fit.NC)
    x, cost = fit.lm(fn, x0, iters=40)
    check(np.all(np.isfinite(x)) and np.isfinite(cost), "lm finite on a flat curve segment")
    floor = fit.NC * 0.001 ** 2   # the unsolvable tail residual sets the cost floor
    check(cost <= floor * 1.05, f"lm converges on a flat curve segment (cost {cost:.2e})")
    check(np.max(np.abs(x[:head] - target)) < 1e-2, "lm head parameters recovered")


def main():
    for name, fn in sorted({k: v for k, v in globals().items() if k.startswith("test_")}.items()):
        fn()
        print(f"ok   {name}")
    print(f"\n{'ALL PASSED' if FAILS == 0 else f'{FAILS} FAILURES'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
