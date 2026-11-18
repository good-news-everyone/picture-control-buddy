"""Exports the Python models for the web page into web/model/.

devmodel (data/devmodel_render.npz):
  dev.json — the M matrix, curve knots and values, LUT size n.
  dev_lut.bin — the LUT correction, float32, n^3*3, index (r*n + g)*n + b — as in ceiling.Lut.

profile_model (data/profile_model.npz, reference-test level 5):
  profile.json — constants and table offsets into profile.bin (in float32 elements, little-endian).
  profile.bin — all flat model tables one after another, each in C order of its numpy shape:
    blender  (36, NN, 3)  — the order of the 36 keys is given by the blender_order field: (set, attribute, sign);
    grade_<zone> (8, NN, 3) for each of the three zones (grading, GRADE_HUES directions);
    shares (8, SHARE_K) — blender color shares over hue; may be absent, then sectors are used;
    tone (5, 7, 257) — Y' curves of the tonal sliders at TONE_LEVELS;
    sat (7,) — Cb/Cr multipliers at SAT_LEVELS;
    mask (3, MASK_BINS), blend (5, 3, MASK_BINS), bal (5, 3, MASK_BINS) — zone masks;
    gbl (3, 2, NN, 3) — zone brightness offsets by neutral color, per zone and sign.
  If the model has no tools (data/sweep4.npz), the file has no tone..gbl tables and the json has no
  such keys either — the port then works as a Model with tools=None.

detail (data/detail_model.npz, reference-test level 6):
  detail.json — constants and table offsets into detail.bin (in float32 elements, little-endian).
  detail.bin — for each tool and scale: plus and minus, flat (len(sigmas), NB).
  detail.json: {
    tools, NB, SENSOR_LONG, GRID (linspace(0, 1, NB)), YW (Rec.601 luma),
    parts: {tool: {str(scale): {sigmas, plus: {offset, count}, minus: {offset, count}}}}
  }
  Scales are strings because they are json keys: "2", "4". An empty parts dict means the model
  is not trained (detail.Detail.load without a file), tools are skipped as in Python.

    python3 web/export_model.py
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import devmodel  # noqa: E402
import detail  # noqa: E402
import profile_model  # noqa: E402


def export_dev(out: str):
    dev = devmodel.Dev.load(devmodel.RENDER)
    json.dump({"M": dev.M.tolist(), "knots": [float(devmodel.KNOTS[0]), float(devmodel.KNOTS[-1])],
               "w": dev.w.tolist(), "n": int(dev.lut.n), "floor": 2 ** -11},
              open(os.path.join(out, "dev.json"), "w"))
    dev.lut.d.astype("<f4").tofile(os.path.join(out, "dev_lut.bin"))
    print("model/dev.json, model/dev_lut.bin:", dev.lut.d.shape)


def export_profile(out: str):
    """Model.load(PATH) -> profile.json + profile.bin (offsets in float32 elements)."""
    model = profile_model.Model.load(profile_model.PATH)
    parts, tables, off = [], {}, 0

    def add(name: str, a: np.ndarray) -> int:
        nonlocal off
        a = np.ascontiguousarray(a, dtype="<f4")
        tables[name] = {"offset": off, "count": int(a.size)}
        parts.append(a)
        off += a.size
        return tables[name]["offset"]

    blender_order = [[s, a, g] for (s, a, g) in model.blender]
    add("blender", np.stack([model.blender[k] for k in model.blender]))
    for zone, t in model.grade.items():
        add(f"grade_{zone}", t)
    if model.shares is not None:
        add("shares", model.shares)
    if model.tools:
        for k in ("tone", "sat", "mask", "blend", "bal", "gbl"):
            add(k, model.tools[k])
    np.concatenate([p.ravel() for p in parts]).tofile(os.path.join(out, "profile.bin"))

    meta = {
        "version": 1,
        "G": profile_model.G, "NN": profile_model.NN, "SHARE_K": profile_model.SHARE_K,
        "MASK_BINS": profile_model.MASK_BINS,
        "TONE_LEVELS": list(profile_model.TONE_LEVELS), "SAT_LEVELS": list(profile_model.SAT_LEVELS),
        "BLENDINGS": list(profile_model.BLENDINGS), "BALANCES": list(profile_model.BALANCES),
        "TONE_SLIDERS": ["contrast", "highlights", "shadows", "white", "black"],
        "ATTRS": list(profile_model.ATTRS), "GRADE_HUES": list(profile_model.GRADE_HUES),
        "ZONES": list(profile_model.np3.ZONES),
        "COLORS": list(profile_model.np3.COLORS),
        "SET_OF": profile_model.SET_OF,
        "SECTORS": {s: [[c, lo, hi] for c, lo, hi in items] for s, items in profile_model.SECTORS.items()},
        "YCC": np.asarray(profile_model.YCC).tolist(),
        "YCC_INV": np.linalg.inv(profile_model.YCC).tolist(),
        "LUMA": profile_model.M.LUMA.tolist(),
        "blender_order": blender_order,
        "tables": tables,
    }
    json.dump(meta, open(os.path.join(out, "profile.json"), "w"))
    print("model/profile.json, model/profile.bin:", {k: v["count"] for k, v in tables.items()})


def export_detail(out: str):
    """Detail.load(PATH) -> detail.json + detail.bin (offsets in float32 elements)."""
    d = detail.Detail.load()
    parts, bins, off = {}, [], 0
    for tool, by in sorted(d.parts.items()):
        parts[tool] = {}
        for k in sorted(by):
            p = by[k]
            entry = {"sigmas": [float(s) for s in p.sigmas]}
            for name in ("plus", "minus"):
                a = np.ascontiguousarray(getattr(p, name), dtype="<f4")
                entry[name] = {"offset": off, "count": int(a.size)}
                bins.append(a.ravel())
                off += a.size
            parts[tool][str(k)] = entry
    if bins:
        np.concatenate(bins).tofile(os.path.join(out, "detail.bin"))
    meta = {"version": 1, "tools": list(detail.TOOLS), "NB": detail.NB,
            "SENSOR_LONG": detail.SENSOR_LONG, "GRID": detail.GRID.tolist(),
            "YW": detail.YW.tolist(), "parts": parts, "bin": "detail.bin"}
    json.dump(meta, open(os.path.join(out, "detail.json"), "w"))
    print("model/detail.json, model/detail.bin:", {t: list(v) for t, v in parts.items()})


def main():
    out = os.path.join(HERE, "model")
    os.makedirs(out, exist_ok=True)
    export_dev(out)
    export_profile(out)
    export_detail(out)


if __name__ == "__main__":
    main()
