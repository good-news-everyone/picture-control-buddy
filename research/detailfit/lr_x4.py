"""LR variants (renders/sa/<VAR>/<F>.jpg) at x4: Clarity / Mid-range by coherent band regression against NX NEW4."""
import os, sys, json, numpy as np
from PIL import Image
import bands as B, lsq, sa_lsq
VARS = ["done", "CLA50", "CLAM40", "TEX50", "SHA100"]
FR = ["DSC_6015", "DSC_6423", "DSC_6973", "DSC_7026"]
TOOLS = ("clarity", "mid_sharpening")
res = {}
for f in FR:
    yn, _ = sa_lsq.pair(f)
    for v in VARS:
        yt = B.resize(B.y_of(Image.open(os.path.join(B.ROOT, "renders/sa", v, f + ".jpg"))), yn.shape[::-1])
        d = lsq.design(yn, yt, sa_lsq.V0, sub=100_000)
        r = lsq.solve([d], TOOLS)[1]
        res.setdefault(v, {})[f] = r
        print(f, f"{v:7s} clarity {r['clarity']:+.2f}  mid {r['mid_sharpening']:+.2f}", flush=True)
json.dump(res, open(os.path.join(B.HERE, "lr_x4.json"), "w"), indent=1)
