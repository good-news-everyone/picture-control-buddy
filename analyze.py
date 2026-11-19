"""Pair analysis for fitting: which colors the frames have, lightness, suitability; error report by regions.

Color groups are computed from the target (what must be reproduced) in CIELab and do not overlap.
The mean dE over pixels hides small objects (a vest, a car, faces take 1-2% of the frame),
so the report goes by groups plus one more number — the mean over color bins.

    python3 match.py --analyze name a.NEF a.jpg [b.NEF b.jpg ...]    candidates -> out/<name>/analysis.json
    python3 analyze.py render.TIF target.jpg [render2.TIF target2.jpg ...] NX render vs target by regions
    python3 analyze.py [--adl Off] [--save name] a.NEF b.NEF folder/ ...  without targets: colors from the Nikon neutral,
                                         lightness, ADL and advice on which frames to take into the fit; --save writes
                                         candidates to out/<name>/analysis.json for the draft and --refine
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

import color as C

HERE = os.path.dirname(os.path.abspath(__file__))
GROUPS = ("greys", "skin", "warm saturated", "warm muted", "yellows", "greens", "teal/water", "sky",
          "dark blues", "purple")
GREY_C = 5            # chroma below this = greys
WARM_C = 35           # saturated warm: orange vest, red car
REPORT_SHARE = 0.01   # groups smaller than this share of the frame are not printed in the line report
# Coverage of a group across the frame set — the sum of per-frame shares ("frame area")
ENOUGH = 0.05         # enough for fitting: about 2000 pixels in the shrunk frames
FEW = 0.01            # less — almost none, the color is fitted blindly
MAX_FRAMES = 6        # more frames do not improve the fit, only slow it down
GAIN_STOP = 0.15      # the next frame is added if it closes at least this many groups
LIFT_OUTLIER = 2.0    # L: target lightness vs neutral differs from the other frames
# The profile curve is shared, so the fitting frames set the lightness of all others: the mean "lift"
# of the set must be close to the median of the candidates. Lightroom preset, 11 frames: fitting by half
# with lift -10.9..-12.5 made the other half (-9.0..-11.7) darker by 1.2 L, and the reverse half
# made the first lighter by 0.4 L. Penalty in "groups" per 1 L of mean deviation:
LIFT_PENALTY = 0.7
CLIPPED_BAD = 0.3     # share of target pixels in white; above — the frame says little about highlights
NCC_BAD = 0.6
INFO_ONLY = ("grain", "vignette")   # what NP3 has no control for, but neither hurts color nor the fit
# Weight of rare colors in the fit: (bin frequency / most frequent frequency)^-POWER, at most CAP.
# Over the 11 frames of the Lightroom preset: warm saturated L -2.1 -> -1.2, skin -0.8 -> -0.5, the
# pixel mean unchanged (2.40 -> 2.39). Full equalization (POWER 1) is no better than 0.5.
POWER = 0.5
CAP = 10.0


def polar(lab: np.ndarray):
    L, a, b = lab[:, 0], lab[:, 1], lab[:, 2]
    return L, np.hypot(a, b), np.degrees(np.arctan2(b, a)) % 360


def labels(lab: np.ndarray) -> np.ndarray:
    """GROUPS index for each pixel."""
    L, c, h = polar(lab)
    warm = (h < 75) | (h >= 340)
    g = np.select([c < GREY_C,
                   warm & (c >= WARM_C),
                   (h >= 30) & (h < 70) & (c >= 12) & (L > 35) & (L < 85),
                   warm,
                   h < 100, h < 170, h < 220,
                   (h < 300) & (L > 45), h < 300],
                  [0, 2, 1, 3, 4, 5, 6, 7, 8], 9)
    return g


def shares(lab: np.ndarray) -> dict:
    return {g: float(v) for g, v in zip(GROUPS, np.bincount(labels(lab), minlength=len(GROUPS)) / len(lab))}


def bins(lab: np.ndarray) -> np.ndarray:
    """Color bins: chroma by 10 x hue by 30 degrees, greys separately by lightness."""
    L, c, h = polar(lab)
    chroma = np.clip((c // 10).astype(int), 0, 5)
    return np.where(c < GREY_C, 72 + np.clip((L // 20).astype(int), 0, 4), chroma * 12 + (h // 30).astype(int) % 12)


NBINS = 77


def frequency(labs: list[np.ndarray]) -> np.ndarray:
    """Bin frequencies over all frames of the set, each frame with equal weight."""
    return np.mean([np.bincount(bins(x), minlength=NBINS) / len(x) for x in labs], 0)


def rarity(freq: np.ndarray, lab: np.ndarray) -> np.ndarray:
    """Desired pixel weight in the fit: rare colors weigh more."""
    f = np.maximum(freq / freq.max(), 1e-9)
    return np.minimum(f ** -POWER, CAP)[bins(lab)]


def weighted_sample(w: np.ndarray, n: int, rng) -> tuple[np.ndarray, np.ndarray]:
    """Poisson sampling with inclusion probability min(1, k*w) and correction multipliers.

    Rare colors get into the sample almost entirely, frequent ones are thinned. The w/pi multiplier
    gives each pixel exactly its weight w, so the fit sees the "area x rarity" distribution with
    less noise from the small number of rare pixels.
    """
    if len(w) <= n:
        return np.arange(len(w)), w / w.mean()
    k = n / w.sum()
    for _ in range(30):                       # k such that n are collected on average
        pi = np.minimum(1, k * w)
        k *= n / pi.sum()
    pi = np.minimum(1, k * w)
    pick = np.flatnonzero(rng.random(len(w)) < pi)
    mult = w[pick] / pi[pick]
    return pick, mult / mult.mean()


def adl(nef: str | None) -> str:
    if not nef:
        return "?"
    try:
        r = subprocess.run(["exiv2", "-q", "-K", "Exif.Nikon3.ActiveDLighting", "-Pt", nef],
                           capture_output=True, text=True, timeout=20)
        return r.stdout.strip() or "?"
    except (OSError, subprocess.SubprocessError):
        return "?"


def frame(name: str, nef: str | None, target: str | None, neutral: np.ndarray, t: np.ndarray | None, ncc: float,
          warnings: list[str]) -> dict:
    """Frame info: target color groups (without target — Nikon neutral colors), lightness, alignment, ADL, warnings."""
    nl = C.srgb_to_lab(neutral)
    tl = C.srgb_to_lab(t) if t is not None else nl
    ok = (t if t is not None else neutral).max(1) < .98
    return {"name": name, "nef": os.path.abspath(nef) if nef else None,
            "target": os.path.abspath(target) if target else None, "ncc": round(ncc, 3),
            "adl": adl(nef), "groups": shares(tl[ok]),
            "L": float(tl[:, 0].mean()), "dark": float((tl[:, 0] < 15).mean()), "light": float((tl[:, 0] > 85).mean()),
            "clipped": float((~ok).mean()), "lift": float((tl[ok, 0] - nl[ok, 0]).mean()) if t is not None else None,
            "warnings": warnings}


def key(f: dict) -> str:
    return f["target"] or f["nef"]


RAW_LONG = 256      # as in the match.py pairs


def raw_frame(nef: str, dev) -> dict:
    """Frame without target: our development to Nikon neutral, shrunk to RAW_LONG on the long side."""
    import devpairs
    import rawdev
    import vignette
    lin = rawdev.develop(nef)
    lin = vignette.correct(lin, vignette.coefficients(nef, lin))
    lin = devpairs.shrink(lin, max(1, max(lin.shape[:2]) // RAW_LONG))
    return frame(os.path.splitext(os.path.basename(nef))[0], nef, None, np.clip(dev(lin.reshape(-1, 3).astype(np.float64)), 0, 1),
                 None, 1.0, [])


def verdict(f: dict, lift_median: float) -> tuple[str, list[str]]:
    """good / caution / bad and why."""
    bad, care = [], []
    if f["ncc"] < NCC_BAD:
        bad.append(f"alignment {f['ncc']:.2f}")
    if f["clipped"] > CLIPPED_BAD:
        bad.append(f"in white {f['clipped']:.0%}")
    for w in f["warnings"]:
        if not any(k in w for k in INFO_ONLY):
            (bad if "preview" in w else care).append(w.split(": ", 1)[-1])
    if f["lift"] is not None and abs(f["lift"] - lift_median) > LIFT_OUTLIER:
        care.append(f"target lightness vs neutral {f['lift'] - lift_median:+.1f} L off the others: "
                    "exposure or a local correction, will not land in a shared profile")
    return ("bad" if bad else "caution" if care else "good"), bad + care


def coverage(frames: list[dict]) -> dict:
    """Sum of each group's shares over the frames."""
    return {g: float(sum(f["groups"][g] for f in frames)) for g in GROUPS}


def level(v: float) -> str:
    return "enough" if v >= ENOUGH else "little" if v >= FEW else "none"


def value(cov: dict, present: set) -> float:
    """How many groups are covered: each up to ENOUGH, only groups present among the candidates count."""
    return sum(min(cov[g], ENOUGH) / ENOUGH for g in present)


def recommend(frames: list[dict], lift_median: float, adl_only: str | None = None) -> list[dict]:
    """Greedily picks frames while each next one closes a noticeable share of groups."""
    usable = [f for f in frames if verdict(f, lift_median)[0] != "bad"
              and (adl_only is None or f["adl"].lower() == adl_only.lower())]
    present = {g for g in GROUPS if coverage(usable)[g] >= FEW}
    chosen: list[dict] = []
    while usable and len(chosen) < MAX_FRAMES:
        def score(c):
            lifts = [g["lift"] for g in c if g["lift"] is not None]
            return value(coverage(c), present) - (LIFT_PENALTY * abs(np.mean(lifts) - lift_median) if lifts else 0)
        now = score(chosen) if chosen else 0.0
        gain = {key(f): score(chosen + [f]) - now
                - (0.3 if verdict(f, lift_median)[0] == "caution" else 0) for f in usable}
        best = max(usable, key=lambda f: gain[key(f)])
        if len(chosen) >= 3 and gain[key(best)] < GAIN_STOP:
            break
        chosen.append(best)
        usable.remove(best)
    return chosen


def lift_median(frames: list[dict]) -> float:
    lifts = [f["lift"] for f in frames if f["lift"] is not None]
    return float(np.median(lifts)) if lifts else 0.0


def print_frames(frames: list[dict]):
    med = lift_median(frames)
    short = {"greys": "gry", "skin": "skin", "warm saturated": "warm+", "warm muted": "warm", "yellows": "yel",
             "greens": "grn", "teal/water": "teal", "sky": "sky", "dark blues": "dbl", "purple": "ppl"}
    print("frame       ADL     L  dark light white  lift   | " + " ".join(f"{short[g]:>5s}" for g in GROUPS) + " | verdict")
    for f in frames:
        v, why = verdict(f, med)
        info = [w.split(": ", 1)[-1] for w in f["warnings"] if any(k in w for k in INFO_ONLY)]
        lift = f"{f['lift']:+6.1f}" if f["lift"] is not None else "     -"
        print(f"{f['name']:10s} {f['adl'][:6]:6s} {f['L']:4.0f} {f['dark']:5.0%} {f['light']:5.0%} {f['clipped']:5.0%} {lift} | "
              + " ".join(f"{f['groups'][g] * 100:5.1f}" for g in GROUPS) + f" | {v}" + (": " + "; ".join(why) if why else "")
              + (f" ({'; '.join(info)})" if info else ""))
    if any(f["lift"] is not None for f in frames):
        print("  group shares in %; \"lift\" is target vs Nikon neutral in L (minus = preset is darker);"
              " a frame far from the others has its own lightness correction that will not land in a shared profile")
    else:
        print("  group shares in % over the Nikon neutral (no preset); L is mean lightness, dark L<15, light L>85, white = channel >= 0.98")


def print_coverage(frames: list[dict], title: str, median: float | None = None):
    cov = coverage(frames)
    print(title + ": " + ", ".join(f"{g} {cov[g] * 100:.0f}% ({level(cov[g])})" for g in GROUPS))
    if median is not None and frames and all(f["lift"] is not None for f in frames):
        d = np.mean([f["lift"] for f in frames]) - median
        print(f"  set lightness vs candidate median {d:+.1f} L" + (
            ": the profile will make the other frames " + ("lighter" if d < 0 else "darker") + " by about as much"
            if abs(d) >= 0.5 else ""))
    adls = sorted({f["adl"] for f in frames})
    if len(adls) > 1:
        print(f"  in-camera ADL differs ({', '.join(adls)}): one profile, but NX and the camera lift frames per ADL differently. "
              "Better to fit on frames with the ADL you will shoot with")


def suggest(fit: list[dict], candidates: list[dict], what: str) -> list[str]:
    """Candidates outside the fit that close the weak groups."""
    cov = coverage(fit)
    weak = [g for g in GROUPS if cov[g] < ENOUGH and g != "greys"]
    med = lift_median(fit + candidates)
    out = []
    names = {f["name"] for f in fit}
    for g in weak:
        best = sorted((f for f in candidates if f["name"] not in names and verdict(f, med)[0] != "bad"
                       and f["groups"][g] >= FEW), key=lambda f: -f["groups"][g])[:3]
        if best:
            out.append(f"{g} {cov[g] * 100:.1f}% ({level(cov[g])}): {what} " + ", ".join(f"{f['name']} ({f['groups'][g] * 100:.0f}%)" for f in best))
    return out


def load(folder: str) -> dict:
    path = os.path.join(HERE, "out", folder, "analysis.json")
    return json.load(open(path)) if os.path.exists(path) else {"frames": {}}


def save(folder: str, data: dict):
    os.makedirs(os.path.join(HERE, "out", folder), exist_ok=True)
    json.dump(data, open(os.path.join(HERE, "out", folder, "analysis.json"), "w"), ensure_ascii=False, indent=1)


# --- error report by regions ---

def region_sums(pred: np.ndarray, target: np.ndarray) -> dict:
    """Sums for the report: by groups (dE, dL, dC, dhue) and by color bins."""
    ok = target.max(1) < .99
    lp, lt = C.srgb_to_lab(np.clip(pred[ok], 0, 1)), C.srgb_to_lab(target[ok])
    de = C.de2000(lp, lt)
    g = labels(lt)
    _, cp, hp = polar(lp)
    _, ct, ht = polar(lt)
    dh = (hp - ht + 180) % 360 - 180
    n = len(GROUPS)
    b = bins(lt)
    # Per-group target/render Lab sums (swatch means = sums / n): the report table shows mean Lab
    # per group, they cannot be derived from the dE/dL/dC sums above.
    t_lab = np.stack([np.bincount(g, lt[:, c], n) for c in range(3)], 1)
    p_lab = np.stack([np.bincount(g, lp[:, c], n) for c in range(3)], 1)
    return {"n": np.bincount(g, minlength=n), "de": np.bincount(g, de, n), "dL": np.bincount(g, lp[:, 0] - lt[:, 0], n),
            "dC": np.bincount(g, cp - ct, n), "dh": np.bincount(g, np.where(ct > 8, dh, 0), n),
            "nh": np.bincount(g, (ct > 8).astype(float), n),
            "bn": np.bincount(b, minlength=NBINS), "bde": np.bincount(b, de, NBINS), "all": float(de.mean()),
            "tLabSum": t_lab, "pLabSum": p_lab}


def region_line(s: dict, min_share: float = REPORT_SHARE) -> str:
    n, total = s["n"], s["n"].sum()
    parts = []
    for i, g in enumerate(GROUPS):
        if n[i] < max(min_share * total, 20):
            continue
        k = n[i]
        hue = f" h{s['dh'][i] / s['nh'][i]:+.0f}deg" if s["nh"][i] > 20 else ""
        parts.append(f"{g} {k / total:.0%}: dE {s['de'][i] / k:.1f} L{s['dL'][i] / k:+.1f} C{s['dC'][i] / k:+.1f}{hue}")
    return " | ".join(parts)


def bin_mean(s: dict, min_n: int = 50) -> float:
    """Mean dE over color bins; min_n — points a bin needs (chart patches get by with 5)."""
    full = s["bn"] >= min_n
    return float((s["bde"][full] / s["bn"][full]).mean()) if full.any() else float("nan")


def total(rows: list[dict]) -> dict:
    out = {k: sum(r[k] for r in rows) for k in ("n", "de", "dL", "dC", "dh", "nh", "bn", "bde", "tLabSum", "pLabSum")}
    out["all"] = float(np.mean([r["all"] for r in rows]))
    return out


def print_report(rows: dict, title: str, min_n: int = 50):
    """rows: name -> region_sums."""
    print(title)
    for name, s in rows.items():
        print(f"  {name}: dE {s['all']:.2f}, by color {bin_mean(s, min_n):.2f} | {region_line(s)}")
    if len(rows) > 1:
        t = total(list(rows.values()))
        print(f"  all: dE {t['all']:.2f}, by color {bin_mean(t, min_n):.2f} | {region_line(t, 0.002)}")
    print("  L, C — lightness and chroma difference (prediction - target); h is hue, + counterclockwise "
          "(sky -> magenta, green -> teal, skin -> yellow), - clockwise")


def render_cached(render: str, target: str) -> dict:
    import devpairs
    key = hashlib.sha1(f"{render}|{os.path.getsize(render)}|{target}|{os.path.getsize(target)}".encode()).hexdigest()[:16]
    path = os.path.join(HERE, "data", "match", f"r-{os.path.basename(render)[:-4]}-{key}.npz")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        d = devpairs.build_render(render, target)
        np.savez_compressed(path, x=d["x"], y=d["y"], ncc=d["ncc"])
    d = np.load(path)
    return {"x": d["x"].astype(np.float64).reshape(-1, 3), "y": d["y"].astype(np.float64).reshape(-1, 3), "ncc": float(d["ncc"])}


RAW_EXT = (".nef", ".dng")


def raw_files(args: list[str]) -> list[str]:
    import glob
    out = []
    for a in args:
        if os.path.isdir(a):
            out += sorted(p for p in glob.glob(os.path.join(a, "*")) if p.lower().endswith(RAW_EXT))
        elif a.lower().endswith(RAW_EXT):
            out.append(a)
        else:
            sys.exit(f"not a NEF/DNG and not a folder: {a}")
    return out


def _raw_job(nef: str):
    try:
        return raw_frame(nef, _DEV)
    except (SystemExit, Exception) as e:     # rawdev exits with a message on an unreadable file
        print(f"{os.path.basename(nef)}: skipped: {e}", flush=True)
        return None


def analyze_raw(args: list[str]):
    global _DEV
    import multiprocessing as mp
    import devmodel
    adl_only = save_as = None
    if "--adl" in args:
        i = args.index("--adl")
        adl_only = args[i + 1]
        del args[i:i + 2]
    if "--save" in args:
        i = args.index("--save")
        save_as = args[i + 1]
        del args[i:i + 2]
    files = raw_files(args)
    if not files:
        sys.exit("no NEF/DNG")
    _DEV = devmodel.Dev.load(devmodel.RENDER)
    if len(files) > 1:
        with mp.get_context("fork").Pool(min(len(files), os.cpu_count() or 4)) as pool:
            frames = [f for f in pool.map(_raw_job, files) if f]
    else:
        frames = [f for f in map(_raw_job, files) if f]
    print_frames(frames)
    if len(frames) > 1:
        print_coverage(frames, "all frames")
        rec = recommend(frames, 0.0, adl_only)
        if rec:
            print_coverage(rec, "recommended set")
            print("fitting needs their finished shots with the preset:", " ".join(os.path.relpath(f["nef"]) for f in rec))
        elif adl_only:
            print(f"no suitable frames with ADL {adl_only}")
    if save_as:
        data = load(save_as)
        data["frames"].update({key(f): f for f in frames})
        save(save_as, data)
        print("analysis:", os.path.join("out", save_as, "analysis.json"))


_DEV = None


def main():
    files = sys.argv[1:]
    if files and all(a.startswith("--") or os.path.isdir(a) or a.lower().endswith(RAW_EXT) or
                     (i > 0 and files[i - 1] in ("--adl", "--save")) for i, a in enumerate(files)):
        analyze_raw(files)
        return
    if not files or len(files) % 2:
        sys.exit("usage: python3 analyze.py render.TIF target.jpg [...]  or  python3 analyze.py [--adl Off] [--save name] a.NEF [b.NEF folder ...]")
    rows = {}
    for render, target in zip(files[::2], files[1::2]):
        d = render_cached(render, target)
        rows[os.path.basename(render)[:-4]] = region_sums(d["x"], d["y"])
    print_report(rows, "render vs target by regions")


if __name__ == "__main__":
    Image.MAX_IMAGE_PIXELS = None
    main()
