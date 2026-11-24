import os, sys, numpy as np
from PIL import Image
import bands as B, lsq
T = os.path.join(B.ROOT, "renders/sweep/tools")
FR = ["DSC_5118", "DSC_5966", "DSC_6008", "DSC_6203", "DSC_6299", "DSC_6456", "DSC_6522", "DSC_6663", "DSC_6969", "DSC_6981"]
V0 = {"clarity": 0.0, "mid_sharpening": 0.0, "sharpening": 0.0}
P = sys.argv[1:] or ["CLAP2", "CLAP5", "CLAM2", "CLAM5"]
for p in P:
    per = []
    for f in FR[:5]:
        yn = B.y_of(Image.open(f"{T}/{f}-NEUTRAL.TIF")); yt = B.y_of(Image.open(f"{T}/{f}-{p}.TIF"))
        d = lsq.design(yn, yt, V0, sub=120_000)
        per.append(lsq.solve([d])[1])
    print(p, [(round(v['clarity'], 2), round(v['mid_sharpening'], 2), round(v['sharpening'], 2)) for v in per], flush=True)
