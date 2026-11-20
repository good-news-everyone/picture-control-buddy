"""Golden fixtures for the browser port of the fitting-set advice (web/lib/advice.js, level 1i).

    python3 web/make_advice_golden.py      -> web/golden/advice/

Runs the real analyze.py functions (frame, verdict, coverage, level, value, lift_median,
recommend, suggest, print_coverage) on
  - pixel frames: deterministic synthetic aligned target / developed-neutral sRGB arrays
    (float32 on disk, read as-is by both sides) -> analyze.frame, exercising groups, L,
    dark/light, the white share, lift and the ncc rounding;
  - frame sets: hand-made edge cases plus seeded random sets -> verdicts, coverage, levels,
    value, lift_median, recommend (with and without adl_only), suggest and the
    print_coverage text.
Warnings are written both as the structured codes the browser carries (target.js
editWarningCodes) and as the exact match.edit_warnings strings Python consumes.
Needs numpy only (analyze.py imports color.py and PIL; no scipy).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys

# analyze.value iterates a set: pin the hash order so the fixture is reproducible
if os.environ.get("PYTHONHASHSEED") != "0":
    os.environ["PYTHONHASHSEED"] = "0"
    os.execv(sys.executable, [sys.executable] + sys.argv)

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import analyze as A  # noqa: E402
import color as C  # noqa: E402

OUT = os.path.join(HERE, "golden", "advice")
W, H = 32, 24


def warning_text(w: dict) -> str:
    """match.edit_warnings, from a structured code (the target.js formatWarning strings)."""
    n = w["name"]
    if w["code"] == "small_target":
        return f"{n}: read only the {w['w']}x{w['h']} preview, better give a JPEG or TIFF"
    if w["code"] == "no_lr_settings":
        return f"{n}: no Lightroom settings in XMP: WB, exposure and masks are invisible, they will land in the profile"
    if w["code"] == "masks":
        return f"{n}: has masks, local corrections are not carried into NP3"
    return f"{n}: {w['code']} from the preset has no place in NP3"


def py_frame(f: dict) -> dict:
    """A JSON frame record -> the dict analyze.py functions consume."""
    g = dict(f)
    g["target"] = "/t/" + f["target"]          # analyze.key uses it; unique per frame
    g["warnings"] = [warning_text(w) for w in f["warnings"]]
    return g


def evaluate(frames: list[dict], adl_only: str | None) -> dict:
    py = [py_frame(f) for f in frames]
    med = A.lift_median(py)
    cov = A.coverage(py)
    present = {g for g in A.GROUPS if cov[g] >= A.FEW}
    rec = A.recommend(py, med, adl_only)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        A.print_coverage(rec, "color coverage in the fit", med)
    return {
        "adlOnly": adl_only,
        "liftMedian": med,
        "verdicts": [{"verdict": v, "why": why} for v, why in (A.verdict(f, med) for f in py)],
        "coverage": cov,
        "levels": {g: A.level(cov[g]) for g in A.GROUPS},
        "value": A.value(cov, present),
        "recommend": [f["name"] for f in rec],
        "suggest": A.suggest(rec, py, "add to the fit"),
        "printCoverage": buf.getvalue().rstrip("\n").split("\n"),
    }


def rand_warnings(rng, name: str) -> list[dict]:
    out = []
    if rng.random() < 0.12:
        out.append({"code": "small_target", "name": name, "w": 640, "h": 427})
    if rng.random() < 0.15:
        out.append({"code": "no_lr_settings", "name": name})
    for code, p in (("masks", 0.15), ("vignette", 0.2), ("grain", 0.2)):
        if rng.random() < p:
            out.append({"code": code, "name": name})
    return out


def rand_frame(rng, name: str, lift_none: bool, adls: list[str]) -> dict:
    sh = rng.dirichlet(np.full(len(A.GROUPS), 0.35))
    return {
        "name": name, "target": name + ".jpg", "ncc": round(float(rng.uniform(0.45, 0.99)), 3),
        "adl": str(rng.choice(adls)), "groups": {g: float(v) for g, v in zip(A.GROUPS, sh)},
        "L": float(rng.uniform(30, 70)), "dark": float(rng.uniform(0, .2)), "light": float(rng.uniform(0, .2)),
        "clipped": float(rng.beta(1.2, 6)), "lift": None if lift_none else float(rng.normal(-10, 1.6)),
        "warnings": rand_warnings(rng, name + ".jpg"),
    }


def one_hot(name: str, group: str, share: float, lift: float = -10.0, **kw) -> dict:
    groups = {g: 0.0 for g in A.GROUPS}
    groups[group] = share
    groups["greys"] += 1 - share
    f = {"name": name, "target": name + ".jpg", "ncc": 0.9, "adl": "?", "groups": groups, "L": 50.0,
         "dark": 0.0, "light": 0.0, "clipped": 0.05, "lift": lift, "warnings": []}
    f.update(kw)
    return f


def hand_sets() -> list[dict]:
    others = [g for g in A.GROUPS if g != "greys"]
    sets = []
    sets.append({"id": "empty", "frames": [], "adlOnly": None})
    sets.append({"id": "all_bad", "adlOnly": None, "frames": [
        one_hot("b1", "skin", .2, ncc=0.4), one_hot("b2", "sky", .3, clipped=0.5),
        one_hot("b3", "greens", .2, warnings=[{"code": "small_target", "name": "b3.jpg", "w": 800, "h": 533}])]})
    sets.append({"id": "three_good", "adlOnly": None, "frames": [
        one_hot("g1", "skin", .003), one_hot("g2", "skin", .004), one_hot("g3", "sky", .002)]})
    sets.append({"id": "cap_max_frames", "adlOnly": None,
                 "frames": [one_hot(f"c{i}", g, .06) for i, g in enumerate(others)]})
    sets.append({"id": "tie_identical", "adlOnly": None,
                 "frames": [one_hot("t1", "sky", .2), one_hot("t2", "sky", .2), one_hot("t3", "greens", .1)]})
    sets.append({"id": "lift_outlier_info", "adlOnly": None, "frames": [
        one_hot("l1", "skin", .1, lift=-10), one_hot("l2", "sky", .1, lift=-9.5),
        one_hot("l3", "greens", .1, lift=-14.0, warnings=[{"code": "grain", "name": "l3.jpg"}]),
        one_hot("l4", "purple", .1, lift=-10.4, warnings=[{"code": "masks", "name": "l4.jpg"},
                                                          {"code": "vignette", "name": "l4.jpg"}])]})
    sets.append({"id": "no_lift", "adlOnly": None, "frames": [
        one_hot("n1", "skin", .1, lift=None), one_hot("n2", "sky", .1, lift=None),
        one_hot("n3", "teal/water", .02, lift=None)]})
    sets.append({"id": "adl_mixed", "adlOnly": "off", "frames": [
        one_hot("a1", "skin", .1, adl="Off"), one_hot("a2", "sky", .1, adl="Auto"),
        one_hot("a3", "greens", .1, adl="OFF"), one_hot("a4", "yellows", .03, adl="Off")]})
    sets.append({"id": "adl_mixed_all", "adlOnly": None, "frames": sets[-1]["frames"]})
    return sets


def pixel_frames(rng) -> list[dict]:
    """Synthetic aligned target + developed neutral per frame, float32 on disk."""
    palette = {   # Lab centers per group (inside analyze.labels' regions)
        "greys": (55, 0, 1), "skin": (65, 15, 18), "warm saturated": (50, 45, 35),
        "warm muted": (40, 15, 5), "yellows": (80, 2, 50), "greens": (50, -30, 25),
        "teal/water": (55, -25, -10), "sky": (70, -5, -30), "dark blues": (30, 10, -40),
        "purple": (45, 35, -25),
    }
    specs = [  # name, weights over the palette, white share, lift (L), ncc, warnings
        ("p1", {"greys": 3, "skin": 2, "sky": 2, "greens": 1}, 0.03, -10.0, 0.9123, []),
        ("p2", {"warm saturated": 2, "yellows": 1, "greens": 2, "dark blues": 1}, 0.10, -9.0, 0.8765, [
            {"code": "no_lr_settings"}]),
        ("p3", {"teal/water": 2, "purple": 1, "warm muted": 2}, 0.45, -11.0, 0.7005, []),
        ("p4", {"skin": 3, "greys": 1, "sky": 1}, 0.05, -15.5, 0.5504, [{"code": "grain"}]),
        ("p5", {"greens": 1, "yellows": 1, "sky": 1, "purple": 1, "dark blues": 1}, 0.0, -10.4, 0.9995, [
            {"code": "masks"}, {"code": "vignette"}]),
    ]
    out = []
    n = W * H
    for name, wts, white, lift, ncc, warns in specs:
        keys = list(wts)
        p = np.array([wts[k] for k in keys], float)
        pick = rng.choice(len(keys), size=n, p=p / p.sum())
        lab = np.array([palette[keys[i]] for i in pick], float) + rng.normal(0, [4, 4, 4], (n, 3))
        t = np.clip(C.lab_to_srgb(lab), 0, 0.97)
        clip = rng.random(n) < white
        t[clip] = rng.uniform(0.98, 1.0, (int(clip.sum()), 3))
        nlab = lab.copy()
        nlab[:, 0] -= lift                         # target = neutral + lift (in L)
        neu = np.clip(C.lab_to_srgb(nlab) + rng.normal(0, 0.003, (n, 3)), 0, 1)
        t = t.astype(np.float32)
        neu = neu.astype(np.float32)
        t.tofile(os.path.join(OUT, f"{name}.t.f32"))
        neu.tofile(os.path.join(OUT, f"{name}.n.f32"))
        wl = [dict(w, name=name + ".jpg") for w in warns]
        f = A.frame(name, None, "/t/" + name + ".jpg", neu.astype(np.float64), t.astype(np.float64), ncc,
                    [warning_text(w) for w in wl])
        out.append({"name": name, "target": name + ".jpg", "nccIn": ncc, "warnings": wl,
                    "frame": {k: f[k] for k in ("ncc", "adl", "groups", "L", "dark", "light", "clipped", "lift")}})
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(20261119)
    pix = pixel_frames(rng)
    json.dump({"w": W, "h": H, "frames": pix}, open(os.path.join(OUT, "pixel.json"), "w"), indent=1)

    sets = hand_sets()
    pix_frames = [dict(p["frame"], name=p["name"], target=p["target"], warnings=p["warnings"]) for p in pix]
    sets.append({"id": "pixel", "frames": pix_frames, "adlOnly": None})
    for i in range(40):
        nf = int(rng.integers(1, 13))
        lift_none = i % 9 == 4
        adls = ["Off", "Auto", "High"] if i % 5 == 2 else ["?"]
        frames = [rand_frame(rng, f"s{i}_f{j}", lift_none and j % 2 == 0, adls) for j in range(nf)]
        sets.append({"id": f"rand{i}", "frames": frames, "adlOnly": "off" if i % 5 == 2 and i % 2 == 0 else None})
    for s in sets:
        s["result"] = evaluate(s["frames"], s["adlOnly"])
    json.dump({"sets": sets}, open(os.path.join(OUT, "sets.json"), "w"), indent=1, allow_nan=False)
    print(f"advice golden: {len(pix)} pixel frames, {len(sets)} frame sets -> {os.path.relpath(OUT, ROOT)}")
    for s in sets[:12]:
        print(f"  {s['id']:18s} recommend {s['result']['recommend']}")


if __name__ == "__main__":
    main()
