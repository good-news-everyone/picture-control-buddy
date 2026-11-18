"""End-to-end regression for match.py on one committed aligned-pair fixture.

The fixture (data/test/pair_dsc6366.npz) is a real aligned pair shrunk to 256 px on the
long side: x — the linear NEF data with the target's WB/exposure gain applied
(match.prepared + edit_gain on renders/lr_test/DSC_6366.NEF and its finished Lightroom
export, the fit2 pair), y — the finished target in sRGB, xmp — the WB/exposure summary.
_produced once from local data; _local and the raw files are not needed to run this test.

The test fits a profile, checks the result bounds, the NP3 round-trip and that the
prediction beats the neutral by a solid margin; then it exercises analyze.recommend
and the report.

Run: python3 test_match.py
"""
import contextlib
import io
import json
import os
import tempfile

import numpy as np

import analyze as A
import color as C
import match
import model as M
import np3

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "data", "test", "pair_dsc6366.npz")
FAILS = 0


def check(cond, label):
    global FAILS
    if not cond:
        FAILS += 1
        print(f"FAIL {label}")


def load_pair() -> dict:
    d = np.load(FIXTURE)
    return {"name": "DSC_6366",
            "x": d["x"].astype(np.float64).reshape(-1, 3),
            "t": d["t"].astype(np.float64).reshape(-1, 3),
            "ncc": float(d["ncc"])}


def test_fit():
    match.PIXELS = 2000
    match.BRIGHT = 500
    m = match.Matcher(seed=0)
    raw = load_pair()
    freq = match.target_frequency([raw["t"]])
    q = m.pair(raw, freq=freq)
    x = m.fit([q], iters=15)
    check(np.all(np.isfinite(x)), "the fit completes with a finite vector")

    p = match.unpack(x)
    ctrl = match.control(x, "NPF-TESTFIX")
    data = np3.serialize(ctrl)
    check(np3.serialize(np3.deserialize(data)) == data, "the fitted NP3 round-trips")

    blender = np.abs(np.array([v for vals in ctrl.blender.values() for v in vals]))
    grade = np.array([v for h, ch, b in ctrl.grade.values() for v in (ch, b)])
    check(blender.max() <= match.F.LIMIT + 5, f"blender within LIMIT+slack (max {blender.max():.1f})")
    check(grade.max() <= 100 + 5, f"grade within NP3 bounds (max {grade.max():.1f})")

    neutral_de = float(C.de2000(C.srgb_to_lab(q.tb), q.ttlab).mean())
    pred_de = m.score(q, p)
    check(pred_de < neutral_de - 0.5, f"prediction dE {pred_de:.2f} beats neutral {neutral_de:.2f} by a margin")

    # the fitted parameters actually move the color
    check(np.max(np.abs(x[:match.F.NB])) > 0.1 or np.max(np.abs(x[match.F.NB:match.NX - match.F.NC])) > 0.1
          or np.max(np.abs(np.diff(match.knots(x)))) > 0.01, "the fit moved the parameters")

    with tempfile.TemporaryDirectory() as tmp:
        old = match.HERE
        match.HERE = tmp
        try:
            _, path = match.write("testfix", x)
            written = open(path, "rb").read()
            check(np3.serialize(np3.deserialize(written)) == written, "match.write output round-trips")
        finally:
            match.HERE = old


def test_analyze():
    m = match.Matcher(seed=0)
    raw = load_pair()
    b = np.clip(m.dev(raw["x"]), 0, 1)
    t = raw["t"]
    frame = A.frame("DSC_6366", None, os.path.join(HERE, "data", "test", "target.jpg"),
                    b, t, raw["ncc"], [])
    rec = A.recommend([frame], A.lift_median([frame]))
    check(bool(rec), "analyze.recommend returns a non-empty set")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        A.print_frames([frame])
        A.print_coverage(rec, "recommended set")
        A.print_report({"DSC_4837": A.region_sums(b, t)}, "neutral vs target by regions:")
    check("dE" in out.getvalue(), "the report prints")


def main():
    for name, fn in sorted({k: v for k, v in globals().items() if k.startswith("test_")}.items()):
        fn()
        print(f"ok   {name}")
    print(f"\n{'ALL PASSED' if FAILS == 0 else f'{FAILS} FAILURES'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
