"""Golden fixtures for the browser fitting flow (spec/web-schemas.md §5.2) -> web/golden/.

Extends web/make_golden.py (levels 1-8) with the Stage 0 fitting contracts:
prepared pairs (with the full transform breakdown), sampled fit data, real LM
fits, synthetic LM problems and report sums. Regenerate everything after
changing devpairs/match/fit/analyze:

    python3 web/make_fit_golden.py

What is written (existing fixture dirs are left untouched, manifest.json too):
  resample/                       kernel micro-fixtures for web/lib/resample.js (level 1d):
                                  seeded inputs + PIL references for every resampling op of
                                  the pair pipeline (resize/rotate/warp/radial/shrink)
  pair/<key>.x.f32.br, .y.f32.br   aligned linear camera RGB / target sRGB (H3*W3*3)
  pair/<key>.masks.u8              4 planes: clip, report, valid, nearWhite
  pair/<key>.json                  the PreparedPair contract (§2)
  pair/<key>.meta.json             debug dump of the transform components (§2.1)
  pair/<key>.in.json + sidecars    level 1e: the preparePair input set at browser resolutions
                                   (linear = the level-1 raw fixture, embedded JPEG <=768 px,
                                   the working-size target) + build_dbg replayed on them
                                   (pair/<key>.in.{x,y}.f32.br, .in.masks.u8) and the honest
                                   gap vs the full-res build (vsBuild)
  sample/<key>.json + sidecars     match.Matcher(seed=0) sampling internals (§5.2 stage 3)
  fit/single.json, fit/two.json    real Matcher().fit on 1 and 2 pairs (§3)
  lm/synth.json                    small data-defined LM problems for solver tests
  report/<key>__{neutral,fit}.json full regionSums (extended, incl. tLabSum/pLabSum)
  report/<key>__cache.f32.br       targetLab; __labels.u8, __bins.u8 (§4.1)
  report/aggregate.json            analyze.total over the two fit pairs

Needs the local-only data (_local/, renders/), dcraw_emu and exiv2, like
make_golden.py. The fits take minutes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import brotli

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import analyze as A  # noqa: E402
import color as C  # noqa: E402
import devpairs  # noqa: E402
import fit as F  # noqa: E402
import match  # noqa: E402
import model as M  # noqa: E402
import pairs  # noqa: E402
import profile_model as P  # noqa: E402
import rawdev  # noqa: E402
import render as RD  # noqa: E402
import strength  # noqa: E402
import vignette  # noqa: E402
from make_golden import control_json, save_f32, src  # noqa: E402

OUT = os.path.join(HERE, "golden")
SCHEMA_VERSION = 1
GENERATION = {"session": 0, "pair": 0, "task": 0}   # fixtures: no live generations
TRAINED_ON = "NIKON Z F"                            # ui.TRAINED_ON (spec/web-schemas.md §2.4)

# Three real pairs (spec §5.2 stage 2): good / warnings / blocked (ncc < 0.6).
# dsc_6550: NIKON Z f, plain Lightroom export, ncc ~0.98.
# skl_3024: NIKON Z 8 (camera warning), WB Custom + exposure -0.88 (gain, gainNote),
#   XMP crop + angle, grain. The NEF is High Efficiency (dcraw_emu cannot read it, see
#   golden ERRORS) — the DNG converted from it is used, as in match.py.
# skl_3024__dsc_5584: the skl_3024 RAW against another frame's target -> blocked.
PAIRS = [
    ("dsc_6550", "renders/lr_test/DSC_6550.NEF", "renders/lr_test/done/DSC_6550.jpg", "good"),
    ("skl_3024", "_local/test2/SKL_3024.dng", "_local/test2/SKL_3024.jpg", "warning"),
    ("skl_3024__dsc_5584", "_local/test2/SKL_3024.dng", "_local/test1/DSC_5584.jpg", "blocked"),
]
FIT_PAIRS = ("dsc_6550", "skl_3024")       # the two pairs the fits run on
REPORT_PAIR = "dsc_6550"                   # the report fixtures' pair
FIT_NAME = "fit_two"                       # the fixed fit control the report is computed at

DIMS = ("resample", "pair", "sample", "fit", "lm", "report")


def envelope(kind: str, id_: str, files: dict, warnings=None) -> dict:
    """The common envelope of spec/web-schemas.md §1 (no timestamps: not part of the schema)."""
    return {"schemaVersion": SCHEMA_VERSION, "kind": kind, "id": id_,
            "files": files, "generation": dict(GENERATION),
            "cancelled": False, "superseded": False, "warnings": warnings or []}


def save_u8(rel: str, a: np.ndarray, compress: bool = False):
    """uint8 analog of make_golden.save_f32."""
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    b = np.ascontiguousarray(a, dtype=np.uint8).tobytes()
    if compress:
        path += ".br"
        b = brotli.compress(b, quality=11)
    open(path, "wb").write(b)


def save_i32(rel: str, a: np.ndarray):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(np.ascontiguousarray(a, dtype="<i4").tobytes())


def save_json(rel: str, d: dict):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(d, open(path, "w"), ensure_ascii=False, indent=1)


def camera_model(nef: str) -> str:
    """Exif.Image.Model, the raw-identify equivalent for the fixture's check metadata."""
    try:
        r = subprocess.run(["exiv2", "-q", "-K", "Exif.Image.Model", "-Pt", nef],
                           capture_output=True, text=True, timeout=20)
        return r.stdout.strip() or "?"
    except (OSError, subprocess.SubprocessError):
        return "?"


# ---------------------------------------------------------------- prepared pairs

def estimate_injected(emb: Image.Image, lin: np.ndarray) -> tuple[float, float]:
    """vignette.estimate with the embedded JPEG injected (the replay of a shipped input:
    vignette.coefficients must not be consulted — its cache reflects the full-res file)."""
    small = devpairs.shrink(lin, vignette.SHRINK)
    jpeg = emb.resize((small.shape[1], small.shape[0]), Image.BOX)
    _, s, k = devpairs.fit_radial(small, jpeg)
    small = devpairs.radial(small.astype(np.float32), s, k).astype(np.float64)
    rgb = np.asarray(jpeg.convert("RGB"), dtype=np.float64) / 255
    y = C.srgb_to_linear(rgb.reshape(-1, 3)) @ vignette.Y709
    x = small.reshape(-1, 3) @ vignette.LUMA
    gy, gx = np.gradient(rgb.mean(-1))
    keep = ((np.hypot(gx, gy) < .03).ravel() & (y > .004) & (y < .85)
            & (x > 2e-3) & (small.reshape(-1, 3).max(1) < .95))
    if keep.sum() < vignette.MIN_PIXELS:
        return 0.0, 0.0
    return vignette.fit(np.log2(x[keep]), np.log2(y[keep]), vignette.radius(*rgb.shape[:2]).ravel()[keep])


def build_dbg(nef: str, target: str, devignette: bool = True, inject: dict | None = None) -> dict:
    """devpairs.build(nef, target, devignette=True) replayed with the transform components
    recorded (spec §2.1). Mirrors build()/oriented()/lens_corrected()/matched() stage by
    stage, calling the same devpairs/pairs helpers on the same inputs, so every component
    is the exact value build() computes; build_verify() asserts the products are identical.
    inject (level 1e input fixtures): optional {"lin", "emb", "t"} — the shipped input arrays
    the browser preparePair consumes; the replay is then the reference for the browser port.
    """
    inject = inject or {}
    raw = Image.open(target)
    xmp = pairs.xmp_values(raw)
    t = inject.get("t") or pairs.to_srgb(raw)
    lin = inject["lin"] if inject.get("lin") is not None else \
        rawdev.develop(nef)[devpairs.MY:-devpairs.MY, devpairs.MX:-devpairs.MX]
    emb_arr = inject.get("emb")          # None -> take the embedded JPEG from the file
    if devignette:
        if emb_arr is not None:
            ab = estimate_injected(Image.fromarray(emb_arr, "RGB"), lin)
        else:
            ab = vignette.coefficients(nef, lin)
        lin = vignette.correct(lin, ab)
    else:
        ab = (0.0, 0.0)

    # lens_corrected() (devpairs.py): only inside the XMP-crop branch, before the crop.
    lens = None
    if xmp.get("HasCrop") == "True":
        try:
            emb = Image.fromarray(emb_arr, "RGB") if emb_arr is not None else pairs.embedded_jpeg(nef)
        except ValueError:
            emb = None
        if emb is not None:
            size = (384, round(384 * lin.shape[0] / lin.shape[1]))
            small = np.stack([np.asarray(Image.fromarray(lin[..., c]).resize(size, Image.BOX))
                              for c in range(3)], -1)
            _, ls, lk = devpairs.fit_radial(small, emb.resize(size, Image.BILINEAR))
            lens = {"scale": float(ls), "k": float(lk)}
            lin = devpairs.radial(lin, ls, lk).astype(np.float32)

    # oriented() (devpairs.py): the crop with both angle signs, the best rot90 count wins.
    k = 192 / max(t.size)
    size = (round(t.size[0] * k), round(t.size[1] * k))
    gt = pairs.grad(np.asarray(t.resize(size, Image.BILINEAR).convert("L"), dtype=np.float32))
    aspect = t.size[0] / t.size[1]
    best = None
    orientation, angle_sign = 0, 1
    for sign in (1, -1):
        c = devpairs.crop_float(lin, xmp, sign)
        for r in range(4):
            a = np.rot90(c, r)
            if abs(a.shape[1] / a.shape[0] / aspect - 1) > 0.06:
                continue
            g = pairs.grad(np.asarray(devpairs.to_view(a).resize(size, Image.BILINEAR).convert("L"),
                                      dtype=np.float32))
            v = pairs.ncc(g, gt)
            if best is None or v > best[0]:
                best, orientation, angle_sign = (v, a), r, sign
    if best is None:
        raise ValueError("target shape does not match the frame: cropping without XMP is not supported")
    a = best[1]

    # matched() (devpairs.py): working size, radial scale/k at half resolution, align search.
    k = devpairs.LONG / max(t.size)
    wsize = (round(t.size[0] * k), round(t.size[1] * k))
    t_s = t.resize(wsize, Image.LANCZOS)
    small = (wsize[0] // 2, wsize[1] // 2)
    a_s = np.stack([np.asarray(Image.fromarray(np.ascontiguousarray(a[..., c])).resize(wsize, Image.BOX))
                    for c in range(3)], -1)
    half = np.stack([np.asarray(Image.fromarray(a_s[..., c]).resize(small, Image.BOX)) for c in range(3)], -1)
    _, s, kr = devpairs.fit_radial(half, t_s.resize(small, Image.BILINEAR))
    a_s = devpairs.radial(a_s, s, kr)
    v, s2, dx, dy = pairs.align(devpairs.to_view(a_s).resize(small, Image.BILINEAR),
                                t_s.resize(small, Image.BILINEAR))
    a_w = devpairs.warp_float(a_s, wsize, s2, dx * 2, dy * 2)
    y = np.asarray(t_s, dtype=np.float32) / 255
    x3 = devpairs.shrink(a_w, devpairs.BOX)
    y3 = devpairs.shrink(y, devpairs.BOX)

    has_crop = xmp.get("HasCrop") == "True"
    crop = None
    if has_crop or "CropAngle" in xmp:
        crop = {"hasCrop": has_crop,
                "left": float(xmp.get("CropLeft", 0)), "top": float(xmp.get("CropTop", 0)),
                "right": float(xmp.get("CropRight", 1)), "bottom": float(xmp.get("CropBottom", 1)),
                "angleDeg": float(xmp.get("CropAngle", 0)), "angleSign": angle_sign}
    return {"x": x3, "y": y3, "ncc": float(v), "s": float(s * s2), "k": float(kr),
            "size": {"w": wsize[0], "h": wsize[1]},
            "transform": {"crop": crop, "orientation": orientation, "lensRadial": lens,
                          "radialScale": float(s), "radialK": float(kr), "scale": float(s * s2),
                          "warpScale": float(s2), "shiftX": float(dx * 2), "shiftY": float(dy * 2)},
            "vignette": {"a": float(ab[0]), "b": float(ab[1])}}


def build_verify(nef: str, target: str, r: dict):
    """The replayed build must reproduce devpairs.build exactly."""
    b = devpairs.build(nef, target, devignette=True)
    assert np.array_equal(b["x"], r["x"]) and np.array_equal(b["y"], r["y"]), "x/y mismatch vs devpairs.build"
    assert b["ncc"] == r["ncc"] and b["s"] == r["s"] and b["k"] == r["k"], "ncc/s/k mismatch vs devpairs.build"


def pair_fixture(key: str, nef: str, target: str, role: str, m: match.Matcher):
    print(f"pair {key}: building {os.path.basename(nef)} + {os.path.basename(target)}", flush=True)
    r = build_dbg(nef, target)
    build_verify(nef, target, r)
    h3, w3 = r["x"].shape[:2]
    t = r["y"].reshape(-1, 3).astype(np.float64)
    tmax, tmin = t.max(1), t.min(1)
    masks = np.stack([(tmax >= match.CLIP).reshape(h3, w3),
                      (tmax < .99).reshape(h3, w3),
                      np.ones((h3, w3), bool),                      # validMask: all-ones, spec §6.11
                      ((tmax >= match.CLIP) & (tmin >= match.NEAR_WHITE)).reshape(h3, w3)])
    save_u8(f"pair/{key}.masks.u8", masks)
    save_f32(f"pair/{key}.x.f32", r["x"], compress=True)
    save_f32(f"pair/{key}.y.f32", r["y"], compress=True)

    gain, gain_note = match.edit_gain(nef, target)
    x_full = r["x"].reshape(-1, 3).astype(np.float64)
    neutral = m.dev(x_full * gain)
    warns = match.edit_warnings([target])
    f = A.frame(os.path.basename(nef)[:-4], nef, target, neutral, t, r["ncc"], warns)
    state, reasons = A.verdict(f, A.lift_median([f]))
    target_size = list(Image.open(target).size)
    tx = pairs.xmp_values(Image.open(target))
    blocked = None
    if r["ncc"] < A.NCC_BAD:
        blocked = {"code": "ncc_low", "detail": f"ncc={r['ncc']:.3f} < {A.NCC_BAD}"}
    if max(target_size) < match.MIN_TARGET:
        blocked = {"code": "target_too_small", "detail": f"{target_size[0]}x{target_size[1]}"}
    checks = {"camera": camera_model(nef), "adl": f["adl"], "targetSize": target_size,
              "xmpHasLightroom": "Temperature" in tx, "xmpMasks": bool(tx["_masks"]),
              "xmpVignetteAmount": float(tx.get("PostCropVignetteAmount") or 0),
              "xmpGrainAmount": float(tx.get("GrainAmount") or 0),
              "blocked": blocked}
    files = {"raw": os.path.basename(nef), "target": os.path.basename(target)}
    doc = envelope("preparedPair", key, files)
    doc.update({"role": role, "h3": h3, "w3": w3, "size": r["size"], "ncc": r["ncc"],
                "transform": r["transform"], "vignette": r["vignette"],
                "gain": gain.tolist(), "gainNote": gain_note or None,
                "checks": checks,
                "analysis": {"name": f["name"], "ncc": f["ncc"], "adl": f["adl"], "groups": f["groups"],
                             "L": f["L"], "dark": f["dark"], "light": f["light"], "clipped": f["clipped"],
                             "lift": f["lift"], "verdict": {"state": state, "reasons": reasons},
                             "warnings": f["warnings"]},
                "arrays": {"x": f"pair/{key}.x.f32.br", "y": f"pair/{key}.y.f32.br",
                           "masks": f"pair/{key}.masks.u8",
                           "maskPlanes": ["clip", "report", "valid", "nearWhite"]}})
    save_json(f"pair/{key}.json", doc)
    meta = {"key": key, "debug": "transform component dump (spec/web-schemas.md §2.1): "
                                 "the browser port must reproduce each stage, a mismatch is attributable to one line",
            "orientation": r["transform"]["orientation"], "crop": r["transform"]["crop"],
            "lensRadial": r["transform"]["lensRadial"], "radialScale": r["transform"]["radialScale"],
            "radialK": r["transform"]["radialK"], "scale": r["transform"]["scale"],
            "warpScale": r["transform"]["warpScale"], "shiftX": r["transform"]["shiftX"],
            "shiftY": r["transform"]["shiftY"], "vignette": r["vignette"],
            "workingSize": r["size"], "ncc": r["ncc"],
            "validMask": "all-ones (spec/web-schemas.md §6.11): the generator does not track "
                         "warp source bounds; excluded from equality assertions",
            "xmp": {k: v for k, v in pairs.xmp_values(Image.open(target)).items() if not k.startswith("_")}}
    save_json(f"pair/{key}.meta.json", meta)
    return {"key": key, "nef": nef, "target": target, "role": role, "raw": {"name": f["name"], "x": x_full,
            "t": t, "ncc": r["ncc"]}, "neutral": neutral, "gain": gain, "masks": masks,
            "h3": h3, "w3": w3, "y2d": r["y"], "r": r}


# ---------------------------------------------------------------- preparePair inputs (level 1e)

def raw_fixture_entry(nef: str) -> dict:
    """The level-1 golden linear fixture for the RAW (the browser decoder's output shape and
    semantics: margins cropped, integer shrink, rotated) — reused as the preparePair linear
    input, so no full-res dump is needed (spec/web-schemas.md §5.2)."""
    man = json.load(open(os.path.join(OUT, "manifest.json")))
    base = os.path.basename(nef)
    for e in man["raw"]:
        if os.path.basename(e["path"]) == base:
            return e
    raise ValueError(f"{nef}: no level-1 raw fixture in golden/manifest.json — run make_golden.py first")


def input_fixture(key: str, nef: str, target: str, role: str, inf: dict):
    """The shipped preparePair input set (spec §5.2 stage 2): the linear fixture (shared with
    level 1), the decoded embedded JPEG at <=768 px, the working-size target (the exact array
    matched() consumes — the target path is 8-bit, so u8 keeps it exact and small) and the
    parsed XMP. The reference is build_dbg replayed on these exact inputs; vsBuild records the
    honest equivalence gap of the shipped inputs vs the full-resolution devpairs.build.
    """
    raw_base = os.path.basename(nef).rsplit(".", 1)[0].lower()
    e = raw_fixture_entry(nef)
    lin_file = e["file"]                       # relative to golden/, shared with level 1
    # the fixture is rotated by the EXIF tag (render.linear convention, like the browser
    # decoder); preparePair works on the sensor frame of rawdev.develop, so the replay (and
    # the browser) un-rotate it first.
    turns = RD.TURNS.get(RD.orientation(nef), 0)
    unrotate = (4 - turns) % 4
    lin = np.frombuffer(brotli.decompress(open(os.path.join(OUT, lin_file), "rb").read()),
                        dtype="<f4").reshape(e["h"], e["w"], 3)
    lin = np.ascontiguousarray(np.rot90(lin, unrotate))
    lw, lh = lin.shape[1], lin.shape[0]

    emb = pairs.embedded_jpeg(nef)
    if max(emb.size) > 768:
        k = 768 / max(emb.size)
        emb = emb.resize((round(emb.size[0] * k), round(emb.size[1] * k)), Image.BILINEAR)
    emb_arr = np.asarray(emb, dtype=np.uint8)
    save_u8(f"pair/{raw_base}.emb.u8", emb_arr, compress=True)

    raw = Image.open(target)
    xmp = pairs.xmp_values(raw)
    t = pairs.to_srgb(raw)
    wsize = (round(t.size[0] * devpairs.LONG / max(t.size)), round(t.size[1] * devpairs.LONG / max(t.size)))
    t_s = t.resize(wsize, Image.LANCZOS)
    save_u8(f"pair/{key}.tgt.u8", np.asarray(t_s, dtype=np.uint8), compress=True)

    r2 = build_dbg(nef, target, inject={"lin": lin, "emb": emb_arr, "t": t_s})
    r = inf["r"]
    h3, w3 = r2["x"].shape[:2]
    t2 = r2["y"].reshape(-1, 3).astype(np.float64)
    tmax, tmin = t2.max(1), t2.min(1)
    masks = np.stack([(tmax >= match.CLIP).reshape(h3, w3),
                      (tmax < .99).reshape(h3, w3),
                      np.ones((h3, w3), bool),
                      ((tmax >= match.CLIP) & (tmin >= match.NEAR_WHITE)).reshape(h3, w3)])
    save_u8(f"pair/{key}.in.masks.u8", masks)
    save_f32(f"pair/{key}.in.x.f32", r2["x"], compress=True)
    save_f32(f"pair/{key}.in.y.f32", r2["y"], compress=True)
    blocked = None
    if r2["ncc"] < A.NCC_BAD:
        blocked = {"code": "ncc_low", "detail": f"ncc={r2['ncc']:.3f} < {A.NCC_BAD}"}

    gain = inf["gain"]
    gain_note = None
    doc_ref = json.load(open(os.path.join(OUT, f"pair/{key}.json")))
    gain_note = doc_ref["gainNote"]
    tr, tr2 = r["transform"], r2["transform"]
    vs_build = {
        "xMax": float(np.abs(r2["x"] - r["x"]).max()), "xMean": float(np.abs(r2["x"] - r["x"]).mean()),
        "yMax": float(np.abs(r2["y"] - r["y"]).max()),
        "nccDelta": float(r2["ncc"] - r["ncc"]),
        "orientationSame": tr2["orientation"] == tr["orientation"],
        "scaleDelta": float(tr2["scale"] - tr["scale"]),
        "shiftAbs": max(abs(tr2["shiftX"] - tr["shiftX"]), abs(tr2["shiftY"] - tr["shiftY"])),
        "vignetteA": float(r2["vignette"]["a"] - r["vignette"]["a"]),
        "vignetteB": float(r2["vignette"]["b"] - r["vignette"]["b"]),
    }
    doc = {"schemaVersion": SCHEMA_VERSION, "kind": "pairInputs", "id": key,
           "files": {"raw": os.path.basename(nef), "target": os.path.basename(target)},
           "note": "Level 1e input fixtures: the exact arrays web/lib/pair-prepare.js consumes, "
                   "at the resolutions the browser pipeline works with (<=1600 px linear — the "
                   "level-1 decoder fixture; embedded JPEG <=768 px; the working-size target, the "
                   "target path being 8-bit). The reference is build_dbg replayed on these inputs; "
                   "vsBuild is the honest gap of the shipped inputs vs the full-res devpairs.build.",
           "inputs": {"linear": {"file": lin_file, "w": e["w"], "h": e["h"], "unrotate": unrotate},
                      "note": "linear is the level-1 raw fixture (decoder-rotated by the EXIF tag); "
                              "preparePair applies `unrotate` CCW rot90 steps at entry to reach the "
                              "sensor frame, then works at the unrotated geometry below",
                      "embedded": {"file": f"pair/{raw_base}.emb.u8.br", "w": emb_arr.shape[1],
                                   "h": emb_arr.shape[0]},
                      "target": {"file": f"pair/{key}.tgt.u8.br", "w": wsize[0], "h": wsize[1]},
                      "targetSize": list(Image.open(target).size),
                      "xmp": {k: v for k, v in xmp.items() if not k.startswith("_")},
                      "xmpMasks": bool(xmp["_masks"]),
                      "gain": [float(v) for v in gain], "gainNote": gain_note},
           "reference": {"h3": h3, "w3": w3, "size": r2["size"], "ncc": r2["ncc"],
                         "transform": r2["transform"], "vignette": r2["vignette"],
                         "blocked": blocked,
                         "arrays": {"x": f"pair/{key}.in.x.f32.br", "y": f"pair/{key}.in.y.f32.br",
                                    "masks": f"pair/{key}.in.masks.u8"},
                         "maskPlanes": ["clip", "report", "valid", "nearWhite"]},
           "vsBuild": vs_build}
    save_json(f"pair/{key}.in.json", doc)
    print(f"pair {key}: input fixtures (vsBuild xMax {vs_build['xMax']:.4f}, "
          f"nccDelta {vs_build['nccDelta']:+.4f}, orientationSame {vs_build['orientationSame']})",
          flush=True)



# ---------------------------------------------------------------- sampling

class SampledPair(match.Pair):
    """match.Pair with the sampled indices recorded (spec §5.2 stage 3)."""

    def __init__(self, raw, dev, model, rng, gain=np.ones(3), freq=None, density=None):
        self.rec = {}
        self.name, self.ncc = raw["name"], raw["ncc"]
        b = dev(raw["x"] * gain)
        t = raw["t"]
        self.fb, self.ft = b, t
        trust = dev.trust(raw["x"] * gain, density) if freq is not None else None
        pick, mult, test = match.sample(b, t, rng, freq, trust)
        self.rec["pick"], self.rec["mult"], self.rec["test"] = pick.copy(), mult.copy(), test.copy()
        self.b, self.t = b[pick], t[pick]
        self.tlab = C.srgb_to_lab(self.t)
        self.W = C.de2000_weights(self.tlab, match.KC, match.FLAT_L) * np.sqrt(mult)[:, None, None]
        self.px = P.Pixels(model, self.b)
        self.tb, self.tt = b[test], t[test]
        self.ttlab = C.srgb_to_lab(self.tt)
        self.tpx = P.Pixels(model, self.tb)
        clip = np.flatnonzero((t.max(1) >= match.CLIP) & (t.min(1) >= match.NEAR_WHITE))
        clip = rng.choice(clip, min(match.CLIP_PIXELS, len(clip)), replace=False) if len(clip) else clip
        self.rec["clip"] = clip.copy()
        self.cpx = P.Pixels(model, b[clip]) if len(clip) else None
        self.ct = t[clip]
        self.cmask = self.ct >= match.CLIP


def sample_fixture(key: str, q: SampledPair, freq: np.ndarray, files: dict):
    n = len(q.b)
    save_i32(f"sample/{key}.pick.i32", q.rec["pick"])
    save_i32(f"sample/{key}.test.i32", q.rec["test"])
    save_i32(f"sample/{key}.clip.i32", q.rec["clip"])
    save_f32(f"sample/{key}.mult.f32", q.rec["mult"])
    save_f32(f"sample/{key}.b.f32", q.b)
    save_f32(f"sample/{key}.t.f32", q.t)
    save_f32(f"sample/{key}.tlab.f32", q.tlab)
    save_f32(f"sample/{key}.W.f32", q.W.reshape(n, 9))
    save_f32(f"sample/{key}.ct.f32", q.ct)
    save_u8(f"sample/{key}.cmask.u8", q.cmask.astype(np.uint8))
    doc = envelope("sample", key, files)
    doc.update({"note": "match.Matcher(seed=0) sampling internals (match.sample + Matcher.pair), "
                        "indices are into the flattened H3*W3 prepared pair; trust = 1 per "
                        "spec/web-schemas.md §6.5 (devmodel density is not committed)",
                "n": n, "ncc": q.ncc,
                "arrays": {"pick": f"sample/{key}.pick.i32", "mult": f"sample/{key}.mult.f32",
                           "test": f"sample/{key}.test.i32",
                           "b": f"sample/{key}.b.f32", "t": f"sample/{key}.t.f32",
                           "tlab": f"sample/{key}.tlab.f32", "W": f"sample/{key}.W.f32",
                           "clip": f"sample/{key}.clip.i32", "ct": f"sample/{key}.ct.f32",
                           "cmask": f"sample/{key}.cmask.u8"},
                "WLayout": "W[i] is the 3x3 de2000_weights(tlab[i], KC=0.5, FLAT_L=true) * sqrt(mult[i]), row-major",
                "freq": freq.tolist(), "trust": 1.0})
    save_json(f"sample/{key}.json", doc)


# ---------------------------------------------------------------- LM fits

def lm_history(evals: list, nx: int):
    """Accept/lambda history of one fit.lm run from the recorded (x, cost) evaluations.

    Each outer iteration evaluates the numerical jacobian first (2*nx central-difference
    calls at x +- steps), then up to 12 inner tries; lm accepts a try only if its cost
    decreases, divides lambda by 3 (min 1e-6) and stops after an iteration without a step.
    """
    cur = evals[0][1]
    lam, costs, lambdas = 1e-2, [cur], [1e-2]
    pos, run = 1, 0
    while pos + 2 * nx <= len(evals):
        pos += 2 * nx                                  # the jacobian block
        accepted = False
        for _ in range(12):
            if pos >= len(evals):
                break
            c = evals[pos][1]
            pos += 1
            if c < cur:
                cur, accepted, run = c, True, run + 1
                lam = max(lam / 3, 1e-6)
                costs.append(cur)
                lambdas.append(lam)
                break
            lam *= 3
        if not accepted:
            break
    return {"requested": None, "run": run, "costs": costs, "lambdas": lambdas}


def run_lm(fn, x0, iters, nx):
    """F.lm with every residual evaluation recorded, for lm_history."""
    evals = []

    def fn_rec(x):
        r = fn(x)
        evals.append((None, float(r @ r)))
        return r

    x, cost = F.lm(fn_rec, x0, iters)
    hist = lm_history(evals, nx)
    hist["requested"] = iters
    assert abs(hist["costs"][-1] - cost) < 1e-9 * max(1.0, cost), "history reconstruction mismatch"
    return x, cost, hist


def run_matcher_fit(m: match.Matcher, qs: list[SampledPair], iters: int = 30):
    """The real Matcher.fit with F.lm instrumented to record the cost history."""
    evals = []
    orig_lm = F.lm

    def lm_rec(fn, x, iters_):
        def fn_rec(xv):
            r = fn(xv)
            evals.append((None, float(r @ r)))
            return r
        return orig_lm(fn_rec, x, iters_)

    F.lm = lm_rec
    try:
        x = m.fit(qs, iters)
    finally:
        F.lm = orig_lm
    hist = lm_history(evals, len(x))
    hist["requested"] = iters
    return x, hist["costs"][-1], hist


def fit_fixture(name: str, qs: list[SampledPair], keys: list[str], m: match.Matcher, all_files: list[dict]):
    print(f"fit {name}: {len(qs)} pair(s), zero init, seed 0", flush=True)
    x, cost, hist = run_matcher_fit(m, qs)
    ctrl = match.control(x, "NPF-" + name.upper()[-15:])
    p = M.params_of(ctrl)
    scores = [{"pair": k, "neutral": float(C.de2000(C.srgb_to_lab(q.tb), q.ttlab).mean()),
               "prediction": m.score(q, p)} for k, q in zip(keys, qs)]
    doc = envelope("fitResult", name, all_files[0])
    doc.update({"fitVector": x.tolist(), "cost": cost, "iterations": hist,
                "jacobianSteps": np.r_[np.full(F.NB + F.NG, 1.0), np.full(F.NC, 2e-3),
                                       np.full(len(x) - F.NB - F.NG - F.NC, 1.0)].tolist(),
                "seed": 0, "control": control_json(ctrl), "scores": scores,
                "pairs": keys, "init": "zero"})
    save_json(f"fit/{name}.json", doc)
    return x, ctrl


# ---------------------------------------------------------------- synthetic LM problems

def synth_problems() -> list[dict]:
    """Small data-defined residual functions for testing a JS fit.lm port without photo data
    (spec §5.2 stage 3). Each problem is data plus a documented formula; x*/cost are the
    exact F.lm results a correct port must reproduce (within solver tolerance).

    F.lm is hard-coded to the 56-parameter fit layout (its step sizes and the clip/grade
    bounds slice x at fixed indices), so x0 is always a 56-vector and only the named
    components enter the residual — the remaining columns are inert zeros, which also
    stresses the diagonal lower bound. A JS port must use the same jacobianSteps
    (1.0 for #0-29, 2e-3 for #30-49, 1.0 for #50-55).
    """
    xi = np.linspace(0, 3, 40)
    nx = 56

    def x0(*used: tuple[int, float]) -> list[float]:
        v = np.zeros(nx)
        for i, val in used:
            v[i] = val
        return v.tolist()

    problems = [
        {"name": "exp", "kind": "well-conditioned",
         "formula": "r_i = exp(p[0] + p[1] * x_i) - y_i",
         "usedParameters": [0, 1],
         "x": xi.tolist(), "y": (np.exp(0.9 - 0.8 * xi) + 0.01 * np.sin(7 * xi)).tolist(),
         "x0": x0((0, 0.0), (1, 0.0))},
        {"name": "singular", "kind": "singular-jacobian",
         "formula": "r_i = (p[0] + p[1]) * x_i - y_i    # d r / d p[0] == d r / d p[1]: the normal "
                    "matrix is singular and the LM diagonal lower bound (1e-4 * max(diag)) decides the step",
         "usedParameters": [0, 1],
         "x": xi.tolist(), "y": (3.0 * xi + 0.02 * np.cos(5 * xi)).tolist(),
         "x0": x0((0, 0.5), (1, 2.0))},
        {"name": "flat", "kind": "diagonal-bound",
         "formula": "r_i = p[1] * x_i - y_i    # p[0] does not enter the residual: its jacobian column "
                    "is zero and the diagonal lower bound (1e-4 * max(diag)) must keep the step finite",
         "usedParameters": [1],
         "x": xi.tolist(), "y": (1.7 * xi - 0.3 + 0.02 * np.sin(11 * xi)).tolist(),
         "x0": x0((0, 5.0), (1, 1.0))},
    ]
    for pr in problems:
        x = np.array(pr["x"])
        y = np.array(pr["y"])
        x0v = np.array(pr["x0"])
        if pr["name"] == "exp":
            fn = lambda v: np.exp(v[0] + v[1] * x) - y
        elif pr["name"] == "singular":
            fn = lambda v: (v[0] + v[1]) * x - y
        else:
            fn = lambda v: v[1] * x - y
        xs, cost, hist = run_lm(fn, x0v, 60, len(x0v))
        pr["expected"] = {"x": xs.tolist(), "cost": cost, "iterations": hist}
    return problems


# ---------------------------------------------------------------- report

def json_sums(s: dict) -> dict:
    return {k: (np.asarray(v).tolist() if isinstance(v, np.ndarray) else v) for k, v in s.items()}


def table_of(s: dict) -> list[dict]:
    """The report table rows: one per group above REPORT_SHARE (spec §4.3)."""
    total = s["n"].sum()
    rows = []
    for i, g in enumerate(A.GROUPS):
        n = int(s["n"][i])
        if n < max(A.REPORT_SHARE * total, 20):
            continue
        rows.append({"group": g, "share": n / total, "n": n,
                     "targetLab": (np.asarray(s["tLabSum"])[i] / n).tolist(),
                     "renderLab": (np.asarray(s["pLabSum"])[i] / n).tolist(),
                     "dE": float(s["de"][i]) / n, "dL": float(s["dL"][i]) / n, "dC": float(s["dC"][i]) / n,
                     "dh": float(s["dh"][i]) / s["nh"][i] if s["nh"][i] > 20 else None})
    return rows


def summary_of(s: dict, neutral_all: float) -> dict:
    return {"strength": 100, "renderDE": s["all"], "neutralDE": neutral_all,
            "binMean": A.bin_mean(s), "fittedDelta": None}


def git_describe() -> str:
    try:
        return subprocess.run(["git", "describe", "--always", "--dirty"], capture_output=True, text=True,
                              cwd=ROOT, timeout=20).stdout.strip() or "?"
    except (OSError, subprocess.SubprocessError):
        return "?"


def report_fixtures(info: dict, qs: dict, p_fit: M.Params, ctrl_fit):
    key = REPORT_PAIR
    q = qs[key]
    tlab_full = C.srgb_to_lab(info[key]["y2d"].reshape(-1, 3).astype(np.float64))
    h3, w3 = info[key]["h3"], info[key]["w3"]
    labels = A.labels(tlab_full).reshape(h3, w3).astype(np.uint8)
    labels[~info[key]["masks"][1]] = 255
    bins = A.bins(tlab_full).reshape(h3, w3).astype(np.uint8)
    save_f32(f"report/{key}__cache.f32", tlab_full.reshape(h3, w3, 3), compress=True)
    save_u8(f"report/{key}__labels.u8", labels)
    save_u8(f"report/{key}__bins.u8", bins)

    pred = np.clip(P.Pixels(m_global.model, q.fb)(p_fit), 0, 1)
    versions = {"neutral": A.region_sums(np.clip(q.fb, 0, 1), q.ft),
                "fit": A.region_sums(pred, q.ft)}
    neutral_all = versions["neutral"]["all"]
    files = {"raw": os.path.basename(info[key]["nef"]), "target": os.path.basename(info[key]["target"])}
    for name, s in versions.items():
        doc = envelope("report", f"{FIT_NAME}:{key}:{name}", files)
        doc.update({"strength": 100, "source": f"fit/{FIT_NAME}.json" if name == "fit" else None,
                    "regionSums": json_sums(s), "summary": summary_of(s, neutral_all),
                    "table": table_of(s)})
        save_json(f"report/{key}__{name}.json", doc)

    # aggregate over the fit pairs at the fixed fit control
    rows = []
    for k in FIT_PAIRS:
        pred_k = np.clip(P.Pixels(m_global.model, qs[k].fb)(p_fit), 0, 1)
        rows.append(A.region_sums(pred_k, qs[k].ft))
    agg = A.total(rows)
    doc = envelope("report", "aggregate", {"raw": "", "target": ""})
    doc.update({"strength": 100, "source": f"fit/{FIT_NAME}.json",
                "aggregate": json_sums(agg), "aggregateBinMean": A.bin_mean(agg),
                "table": table_of(agg)})
    save_json("report/aggregate.json", doc)



# ---------------------------------------------------------------- resample kernels (level 1d)
#
# Kernel micro-fixtures for the browser port of every resampling op in the pair pipeline
# (spec/web-schemas.md §6.2). The references are produced with the exact PIL calls
# pairs.py/devpairs.py make, per dtype:
#  - float arrays: devpairs convention — each channel as an F-mode image
#    (Image.fromarray(ch).resize/rotate/transform), stacked back to RGB;
#  - uint8 arrays: the RGB image itself (this is the target path: pairs.py resamples the
#    decoded JPEG in 8 bit, see the level-1d row of spec/web-tests.md).
# devpairs.radial / devpairs.shrink are numpy, not PIL; the references call them directly.

RESAMPLE_NOTE = (
    "Kernel micro-fixtures for web/lib/resample.js (spec/web-tests.md level 1d). "
    "Conventions: PIL resize = separable convolution, center-aligned samples, kernel widened "
    "by max(1, scale) on downsampling, PIL F mode accumulates in float64, 8-bit images use "
    "int32-quantized weights (22 precision bits) per pass with an 8-bit intermediate; "
    "transform/rotate = point-sampled inverse map (0.5-center convention, no antialiasing, "
    "out-of-source centers filled with 0); devpairs.radial/shrink are numpy ports (radial "
    "runs in float64 with the pipeline's float64 s,k).")


def resample_inputs() -> dict:
    """Seeded deterministic float/u8 RGB arrays, odd sizes (level-1d fixtures)."""
    rng = np.random.default_rng(20261119)

    def blur(a, passes):
        for _ in range(passes):
            s = a.shape
            p = np.pad(a, ((1, 1), (1, 1), (0, 0)), mode="reflect")
            out = np.empty_like(a)
            for c in range(3):
                acc = np.zeros(s[:2], np.float32)
                for dy in range(3):
                    for dx in range(3):
                        acc += p[dy:dy + s[0], dx:dx + s[1], c]
                out[..., c] = acc / 9
            a = out
        return a

    smooth = blur(rng.random((53, 37, 3), dtype=np.float32), 3)
    big = blur(rng.random((301, 400, 3), dtype=np.float32), 1)
    edgy = rng.random((171, 256, 3), dtype=np.float32)
    yy, xx = np.mgrid[:171, :256]
    edgy = np.where(((xx // 17 + yy // 13) % 2)[..., None], edgy, 1.0 - edgy).astype(np.float32)
    photo = (np.clip(blur(rng.random((171, 256, 3), dtype=np.float32), 1) * 0.7
                     + rng.random((171, 256, 3), dtype=np.float32) * 0.3, 0, 1) * 255)
    photo = np.where(((xx // 23 + yy // 19) % 2)[..., None], photo, 255.0 - photo)
    return {"in_smooth": smooth.astype(np.float32), "in_big": big.astype(np.float32),
            "in_edgy": edgy, "in_photo": photo.astype(np.uint8)}


def f_channels(a: np.ndarray, fn) -> np.ndarray:
    """devpairs convention: the PIL op on each channel as an F-mode image, stacked to RGB."""
    return np.stack([np.asarray(fn(Image.fromarray(np.ascontiguousarray(a[..., c]))))
                     for c in range(a.shape[2])], -1)


def warp_coeffs(size, s: float, dx: float, dy: float) -> tuple:
    """pairs.warp affine data (a, 0, c, 0, a, f)."""
    W, H = size
    a = 1 / s
    return (a, 0.0, W / 2 - a * (W / 2 + dx), 0.0, a, H / 2 - a * (H / 2 + dy))


def resample_fixtures():
    """Inputs + PIL references for every resampling op of the pair pipeline -> resample/."""
    inputs = resample_inputs()
    shapes = {k: (v.shape[1], v.shape[0]) for k, v in inputs.items()}   # (w, h)

    def working_size(w, h):
        k = devpairs.LONG / max(w, h)
        return (round(w * k), round(h * k))

    sw, sh = shapes["in_smooth"]
    up = working_size(sw, sh)
    bw, bh = shapes["in_big"]
    down = working_size(bw, bh)
    ew, eh = shapes["in_edgy"]
    half = (ew // 2, eh // 2)
    pw, ph = shapes["in_photo"]
    photo_up = working_size(pw, ph)
    rot_center = (23.4, 31.7)          # fractional, like pairs.apply_crop crop centers
    rot_center_u8 = (100.25, 60.75)
    cases = [
        {"name": "lanczos_up_f", "op": "resize", "in": "in_smooth", "kernel": "lanczos",
         "dtype": "f32", "outW": up[0], "outH": up[1],
         "ref": f"PIL F-mode LANCZOS resize to the working size {up} (k = 768/max, round)"},
        {"name": "lanczos_down_f", "op": "resize", "in": "in_big", "kernel": "lanczos",
         "dtype": "f32", "outW": down[0], "outH": down[1],
         "ref": f"PIL F-mode LANCZOS resize to the working size {down} (downscale)"},
        {"name": "box_work_f", "op": "resize", "in": "in_big", "kernel": "box",
         "dtype": "f32", "outW": down[0], "outH": down[1],
         "ref": f"PIL F-mode BOX resize to the working size {down} (devpairs.matched a_s)"},
        {"name": "box_half_f", "op": "resize", "in": "in_edgy", "kernel": "box",
         "dtype": "f32", "outW": half[0], "outH": half[1],
         "ref": f"PIL F-mode BOX resize to (w//2, h//2) {half} (devpairs.matched half)"},
        {"name": "shrink3_f", "op": "shrink", "in": "in_edgy", "k": 3, "dtype": "f32",
         "outW": ew // 3, "outH": eh // 3,
         "ref": "devpairs.shrink 3x3 box mean (numpy, not PIL) -> (w//3, h//3)"},
        {"name": "lanczos_up_u8", "op": "resize", "in": "in_photo", "kernel": "lanczos",
         "dtype": "u8", "outW": photo_up[0], "outH": photo_up[1],
         "ref": f"PIL RGB LANCZOS resize to the working size {photo_up} (pairs.py target path,"
                " 8-bit quantized weights)"},
        {"name": "bilinear_down_u8", "op": "resize", "in": "in_photo", "kernel": "bilinear",
         "dtype": "u8", "outW": half[0], "outH": half[1],
         "ref": f"PIL RGB BILINEAR resize to {half} (pairs.align half-size target)"},
        {"name": "rotate_p25_f", "op": "rotate", "in": "in_smooth", "angle": 2.5,
         "center": list(rot_center), "kernel": "bicubic", "dtype": "f32",
         "outW": sw, "outH": sh,
         "ref": "PIL F-mode rotate(2.5, BICUBIC, center) (devpairs.crop_float)"},
        {"name": "rotate_m25_f", "op": "rotate", "in": "in_smooth", "angle": -2.5,
         "center": list(rot_center), "kernel": "bicubic", "dtype": "f32",
         "outW": sw, "outH": sh,
         "ref": "PIL F-mode rotate(-2.5, BICUBIC, center) (the other angle sign)"},
        {"name": "rotate_p25_u8", "op": "rotate", "in": "in_photo", "angle": 2.5,
         "center": list(rot_center_u8), "kernel": "bicubic", "dtype": "u8",
         "outW": pw, "outH": ph,
         "ref": "PIL RGB rotate(2.5, BICUBIC, center) (pairs.pick_geometry crop search)"},
        {"name": "warp_affine_f", "op": "warpAffine", "in": "in_edgy", "kernel": "bilinear",
         "dtype": "f32", "outW": ew, "outH": eh,
         "m": list(warp_coeffs((ew, eh), 1.023, 1.7, -0.9)),
         "ref": "PIL F-mode transform AFFINE BILINEAR, pairs.warp(s=1.023, dx=1.7, dy=-0.9)"},
        {"name": "warp_affine_u8", "op": "warpAffine", "in": "in_photo", "kernel": "bilinear",
         "dtype": "u8", "outW": pw, "outH": ph,
         "m": list(warp_coeffs((pw, ph), 0.987, -2.3, 1.2)),
         "ref": "PIL RGB transform AFFINE BILINEAR, pairs.warp(s=0.987, dx=-2.3, dy=1.2)"},
        {"name": "warp_radial_f", "op": "warpRadial", "in": "in_edgy",
         "s": float(np.float64(1.031)), "k": float(np.float64(-0.024)), "dtype": "f32",
         "outW": ew, "outH": eh,
         "ref": "devpairs.radial (numpy bilinear, float64 s/k as fit_radial returns)"},
    ]

    def reference(case):
        a = inputs[case["in"]]
        if case["op"] == "resize":
            filt = {"lanczos": Image.LANCZOS, "box": Image.BOX, "bilinear": Image.BILINEAR,
                    "bicubic": Image.BICUBIC}[case["kernel"]]
            size = (case["outW"], case["outH"])
            if case["dtype"] == "f32":
                return f_channels(a, lambda im: im.resize(size, filt))
            return np.asarray(Image.fromarray(a, "RGB").resize(size, filt))
        if case["op"] == "rotate":
            if case["dtype"] == "f32":
                return f_channels(a, lambda im: im.rotate(case["angle"], resample=Image.BICUBIC,
                                                          center=tuple(case["center"])))
            return np.asarray(Image.fromarray(a, "RGB").rotate(
                case["angle"], resample=Image.BICUBIC, center=tuple(case["center"])))
        if case["op"] == "warpAffine":
            m = tuple(case["m"])
            if case["dtype"] == "f32":
                return f_channels(a, lambda im: im.transform(
                    (case["outW"], case["outH"]), Image.AFFINE, m, resample=Image.BILINEAR))
            return np.asarray(Image.fromarray(a, "RGB").transform(
                (case["outW"], case["outH"]), Image.AFFINE, m, resample=Image.BILINEAR))
        if case["op"] == "warpRadial":
            return devpairs.radial(a, np.float64(case["s"]), np.float64(case["k"]))
        if case["op"] == "shrink":
            return devpairs.shrink(a, case["k"])
        raise ValueError(case["op"])

    def run():
        outs = {}
        for case in cases:
            out = np.ascontiguousarray(
                reference(case), dtype=np.float32 if case["dtype"] == "f32" else np.uint8)
            outs[case["name"]] = out
        return outs

    outs = run()
    for case in cases:
        a = outs[case["name"]]
        rel = f"resample/{case['name']}.out.f32" if case["dtype"] == "f32" \
            else f"resample/{case['name']}.out.u8"
        if case["dtype"] == "f32":
            save_f32(rel, a, compress=True)
            case["out"] = rel + ".br"
        else:
            save_u8(rel, a)
            case["out"] = rel
    for key, a in inputs.items():
        if a.dtype == np.uint8:
            save_u8(f"resample/{key}.u8", a)
        else:
            save_f32(f"resample/{key}.f32", a, compress=True)

    man = {"schemaVersion": SCHEMA_VERSION, "note": RESAMPLE_NOTE,
           "tolerances": {"f32": {"max": 1e-5}, "u8": {"max": 0}},
           "inputs": {}, "cases": cases}
    for key, a in inputs.items():
        man["inputs"][key] = {"w": a.shape[1], "h": a.shape[0], "channels": 3,
                              "dtype": "u8" if a.dtype == np.uint8 else "f32",
                              "file": f"resample/{key}.u8" if a.dtype == np.uint8
                                      else f"resample/{key}.f32.br"}
    save_json("resample/manifest.json", man)

    # self-check: a regeneration is byte-identical and the written files match the arrays
    again = run()
    for case in cases:
        name, a = case["name"], outs[case["name"]]
        assert (a.shape[1], a.shape[0]) == (case["outW"], case["outH"]), name
        assert again[name].shape == a.shape and again[name].dtype == a.dtype, name
        assert np.array_equal(again[name], a), f"resample/{name}: regeneration differs"
        raw = open(os.path.join(OUT, case["out"]), "rb").read()
        if case["out"].endswith(".br"):
            raw = brotli.decompress(raw)
        assert raw == a.tobytes(), f"resample/{name}: file mismatch"
    print(f"resample: {len(cases)} kernel fixtures, {len(inputs)} inputs")


m_global = None   # the Matcher of this run, for report_fixtures


def main():
    global m_global
    for d in DIMS:
        shutil.rmtree(os.path.join(OUT, d), ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)

    # ---------- level 1d: kernel micro-fixtures (no local data needed) ----------
    resample_fixtures()

    for rel in [p[1] for p in PAIRS] + [p[2] for p in PAIRS]:
        src(rel)                                   # fail early on missing local data

    m_global = match.Matcher(seed=0)
    m_global.density = None                        # spec §6.5: reference runs with trust = 1
    info = {key: pair_fixture(key, nef, target, role, m_global)
            for key, nef, target, role in PAIRS}

    # ---------- level 1e: preparePair input fixtures + the replay references ----------
    for key, nef, target, role in PAIRS:
        input_fixture(key, nef, target, role, info[key])

    # ---------- stage 3: sampling (the exact Matcher(seed=0) sequence of match.main) ----------
    raws = [info[k]["raw"] for k in FIT_PAIRS]
    gains = [info[k]["gain"] for k in FIT_PAIRS]
    freq = match.target_frequency([r["t"] for r in raws])
    m = match.Matcher(seed=0)
    m.density = None
    qs = {}
    for k, (r, g) in zip(FIT_PAIRS, zip(raws, gains)):
        q = SampledPair(r, m.dev, m.model, m.rng, g, freq, m.density)
        qs[k] = q
        sample_fixture(k, q, freq, {"raw": os.path.basename(info[k]["nef"]),
                                    "target": os.path.basename(info[k]["target"])})
        print(f"sample {k}: pick={len(q.b)} test={len(q.tb)} clip={len(q.ct)}", flush=True)

    # ---------- stage 3: real fits ----------
    all_files = [{"raw": os.path.basename(info[k]["nef"]), "target": os.path.basename(info[k]["target"])}
                 for k in FIT_PAIRS]
    fit_fixture("single", [qs[FIT_PAIRS[0]]], [FIT_PAIRS[0]], m, all_files)
    x_two, ctrl_two = fit_fixture("two", [qs[k] for k in FIT_PAIRS], list(FIT_PAIRS), m, all_files)

    # ---------- lm/synth ----------
    problems = synth_problems()
    save_json("lm/synth.json", {"schemaVersion": SCHEMA_VERSION,
                                "note": "data-defined synthetic residual functions for the JS fit.lm port; "
                                        "each expected result is the exact F.lm output (solver tolerance applies)",
                                "solver": {"lam0": 1e-2, "successDiv": 3, "failMul": 3, "lamMin": 1e-6,
                                           "innerTries": 12, "diagLowerBound": "1e-4 * max(diag)"},
                                "problems": problems})
    for pr in problems:
        print(f"lm/synth {pr['name']}: cost={pr['expected']['cost']:.6g} run={pr['expected']['iterations']['run']}",
              flush=True)

    # ---------- stage 5: report ----------
    p_fit = M.params_of(ctrl_two)
    report_fixtures(info, qs, p_fit, ctrl_two)

    # ---------- sizes ----------
    total = 0
    for d in DIMS:
        for f in sorted(os.listdir(os.path.join(OUT, d))):
            n = os.path.getsize(os.path.join(OUT, d, f))
            total += n
            print(f"  {d}/{f:36s} {n / 1024:9.1f} KB")
    print(f"fit fixtures: {total / 1024 / 1024:.2f} MB in {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
