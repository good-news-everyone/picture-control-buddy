"""Golden fixtures for the browser port of the detail fit (web/lib/detail-fit.js, level 1l).

    python3 web/make_detailfit_golden.py      -> web/golden/detailfit/

Inputs are Y' crops (256 x 192, float32 on disk, read as-is by both sides) of NX exports of the
`tools` pack at 1512 px (scale 4): NEUTRAL as the render (detail 0), CLAP5 / CLAM2 as the
targets. The detail model tables are rounded to float32 as in web/model/detail.bin. Expected:
one rgauss output, the Gram matrix (at scale 8, see SCALE) of each pair and the joint solve (detailfit.py).
Needs renders/sweep/tools (local data).
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import detail as D            # noqa: E402
import detailfit as DF        # noqa: E402

OUT = os.path.join(HERE, "golden", "detailfit")
TOOLS = os.path.join(ROOT, "renders", "sweep", "tools")
W, H = 256, 192
SCALE = 8.0               # not the crops' real scale (4): halves the band sigmas so the crops keep usable pixels
CASES = [("DSC_5118", "CLAP5", (560, 380)), ("DSC_6456", "CLAP5", (600, 420)),
         ("DSC_6522", "CLAM2", (500, 400))]


def crop(path, xy):
    a = np.asarray(Image.open(path).convert("RGB"), np.float64) / 255
    x, y = xy
    if a.shape[0] > a.shape[1]:
        a = np.rot90(a)
    return DF.luma(a[y:y + H, x:x + W]).astype(np.float32)


def model32() -> D.Detail:
    m = D.Detail.load()
    for by in m.parts.values():
        for p in by.values():
            p.plus = p.plus.astype(np.float32).astype(np.float64)
            p.minus = p.minus.astype(np.float32).astype(np.float64)
    return m


def main():
    os.makedirs(OUT, exist_ok=True)
    model = model32()
    pairs = []
    for f, probe, xy in CASES:
        yr = crop(os.path.join(TOOLS, f"{f}-NEUTRAL.TIF"), xy)
        yt = crop(os.path.join(TOOLS, f"{f}-{probe}.TIF"), xy)
        name = f"{f}-{probe}"
        yr.tofile(os.path.join(OUT, name + ".yr.f32"))
        yt.tofile(os.path.join(OUT, name + ".yt.f32"))
        valid = np.ones((H, W), bool)
        valid[:, :12] = False                           # an invalid strip: the erosion path
        g = DF.gram(yr.astype(np.float64), yt.astype(np.float64), valid, SCALE, model)
        pairs.append({"name": name, "Q": g["Q"].ravel().tolist(), "n": g["n"], "invalidCols": 12})
    v0 = {"clarity": 0.0, "mid_sharpening": 0.0}
    grams = [{"Q": np.array(p["Q"]).reshape(DF.NZ, DF.NZ), "n": p["n"]} for p in pairs]
    joint = DF.solve(grams[:2], v0, DF.CAL_WEB)
    single = DF.solve(grams[2:], {"clarity": 0.5, "mid_sharpening": 1.0}, {})
    y0 = np.fromfile(os.path.join(OUT, pairs[0]["name"] + ".yr.f32"), np.float32).reshape(H, W).astype(np.float64)
    blur = DF.rgauss(y0, 3.3)
    meta = {"w": W, "h": H, "scale": SCALE, "nz": DF.NZ, "pairs": pairs,
            "rgauss": {"sigma": 3.3, "sum": float(blur.sum()), "samples": [float(blur[i, j]) for i, j in
                       ((0, 0), (5, 17), (100, 200), (H - 1, W - 1), (96, 128))]},
            "joint": {"v0": v0, "cal": DF.CAL_WEB, **joint},
            "single": {"v0": {"clarity": 0.5, "mid_sharpening": 1.0}, "cal": {}, **single}}
    json.dump(meta, open(os.path.join(OUT, "detailfit.json"), "w"), indent=1)
    print("joint", joint)
    print("single", single)


if __name__ == "__main__":
    main()
