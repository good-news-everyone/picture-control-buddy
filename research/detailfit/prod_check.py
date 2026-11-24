"""The production detail fit (detailfit.py: recursive Gaussian, cubic tone term, joint solve) on the
research data: NX probes (tools pack), the SA fitcheck frames and the LR variants."""
import os, sys, time, numpy as np
from PIL import Image
import bands as B
sys.path.insert(0, B.ROOT)
import detailfit as DF
Image.MAX_IMAGE_PIXELS = None
T = os.path.join(B.ROOT, "renders/sweep/tools")
FC = os.path.join(B.ROOT, "renders/sweep/fitcheck")


def y(path):
    return DF.luma(np.asarray(Image.open(path).convert("RGB"), np.float64) / 255)


def ty(path, shape):
    im = Image.open(path).convert("RGB")
    if (im.size[1] > im.size[0]) != (shape[0] > shape[1]):
        im = im.transpose(Image.Transpose.ROTATE_90)
    return DF.luma(np.asarray(im.resize(shape[::-1], Image.BOX), np.float64) / 255)


def run(pairs, v0):
    return DF.fit_detail([(a, b, np.ones(a.shape, bool), 4.0) for a, b in pairs], v0)


what = sys.argv[1]
t0 = time.time()
if what == "probes":
    FR = ["DSC_5118", "DSC_5966", "DSC_6008", "DSC_6203", "DSC_6299"]
    v0 = {"clarity": 0.0, "mid_sharpening": 0.0}
    for p in sys.argv[2:]:
        prs = [(y(f"{T}/{f}-NEUTRAL.TIF"), y(f"{T}/{f}-{p}.TIF")) for f in FR]
        per = [run([q], v0)["raw"] for q in prs]
        j = run(prs, v0)
        print(p, "joint", j["values"], "raw", {k: round(v, 2) for k, v in j["raw"].items()},
              "| per frame", [(round(r["clarity"], 2), round(r["mid_sharpening"], 2)) for r in per],
              f"{time.time() - t0:.0f}s", flush=True)
else:
    frames = sys.argv[2:]
    v0 = {"clarity": 0.0, "mid_sharpening": 1.0}
    prs = []
    for f in frames:
        a = y(f"{FC}/{f}-NEW4.TIF")
        if a.shape[0] > a.shape[1]:
            pass
        b = ty(os.path.join(B.ROOT, "renders/sa", what, f + ".jpg"), a.shape)
        prs.append((a, b))
        r = run([(a, b)], v0)
        print(f, what, {k: round(v, 2) for k, v in r["raw"].items()}, f"cost {r['cost0']:.4f} -> {r['cost']:.4f}",
              f"{time.time() - t0:.0f}s", flush=True)
    if len(prs) > 1:
        j = run(prs, v0)
        print("joint", what, j["values"], {k: round(v, 2) for k, v in j["raw"].items()}, f"cost {j['cost0']:.4f} -> {j['cost']:.4f}")
