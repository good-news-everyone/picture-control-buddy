import os, numpy as np
from PIL import Image
import bands as B, lsq, sa_lsq
FR = ["DSC_6015", "DSC_6423", "DSC_6973", "DSC_7026"]
for v in ["done", "CLA50", "CLAM40", "TEX50"]:
    ds = []
    for f in FR:
        yn, _ = sa_lsq.pair(f)
        yt = B.resize(B.y_of(Image.open(os.path.join(B.ROOT, "renders/sa", v, f + ".jpg"))), yn.shape[::-1])
        ds.append(lsq.design(yn, yt, sa_lsq.V0, sub=30_000))
    r = lsq.solve(ds, ("clarity", "mid_sharpening"))[1]
    g = lsq.r2_gain(ds, r)
    print(v, {k: round(x, 2) for k, x in r.items()}, "band R2 gain per frame %", [round(100 * x, 1) for x in g], flush=True)
