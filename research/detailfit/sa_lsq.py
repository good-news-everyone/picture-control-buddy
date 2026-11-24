"""Clarity / Mid-range for the SA targets by coherent band regression (lsq.py). Sharpening fixed (not visible at x4)."""
import os, sys, json, numpy as np
from PIL import Image
import bands as B, lsq, pairs, devpairs
Y = os.path.join(B.HERE, "ypairs"); os.makedirs(Y, exist_ok=True)
V0 = dict(B.V0)
TOOLS = ("clarity", "mid_sharpening")


def pair(f, tag="NEW4"):
    p = os.path.join(Y, f"{f}-{tag}.npz")
    if os.path.exists(p):
        z = np.load(p); return z["yn"], z["yt"]
    tgt = Image.open(os.path.join(B.ROOT, "renders/sa/done", f + ".jpg"))
    a = np.asarray(pairs.to_srgb(Image.open(os.path.join(B.ROOT, "renders/sweep/fitcheck", f"{f}-{tag}.TIF"))), np.float32) / 255
    N = devpairs.oriented([np.rot90(a, r) for r in range(4)], pairs.to_srgb(tgt.resize((tgt.size[0] // 4, tgt.size[1] // 4))))
    yn = np.ascontiguousarray(N @ B.YW)
    yt = B.resize(B.y_of(tgt), yn.shape[::-1])
    np.savez(p, yn=yn, yt=yt)
    return yn, yt


def design(f):
    p = os.path.join(Y, f + ".design.npz")
    if os.path.exists(p):
        z = np.load(p, allow_pickle=True); return z["d"].item()
    yn, yt = pair(f)
    d = lsq.design(yn, yt, V0, sub=150_000)
    np.savez(p, d=np.array(d, dtype=object))
    return d


if __name__ != "__main__":
    pass
elif sys.argv[1] == "prep":
    for f in sys.argv[2:]:
        design(f); print(f, flush=True)
else:
    ds = {f: design(f) for f in B.FRAMES}
    per = {}
    for f, d in (ds.items() if "per" in sys.argv else []):
        v = lsq.solve([d], TOOLS)[1]
        per[f] = v
        g = lsq.r2_gain([d], v)[0]
        print(f"{f}: clarity {v['clarity']:+.2f}  mid {v['mid_sharpening']:+.2f}   band R2 gain vs NEW4 {g*100:+.2f}%", flush=True)
    def small(d, n=25_000):
        return dict(t=d["t"][:n], L=d["L"][:n], H={k: (a[:n], b[:n]) for k, (a, b) in d["H"].items()}, v0=d["v0"])
    ds = {f: small(d) for f, d in ds.items()}
    normal = [f for f in B.FRAMES if f not in ("DSC_6151", "DSC_6485")]
    for name, fs in (("joint all 12", B.FRAMES), ("joint 10 (no night 6151, no 6485)", normal)):
        v = lsq.solve([ds[f] for f in fs], TOOLS)[1]
        print(name, {k: round(x, 2) for k, x in v.items()})
    print("leave-one-out on 10:")
    for f in normal:
        v = lsq.solve([ds[g] for g in normal if g != f], TOOLS)[1]
        print("  without", f, {k: round(x, 2) for k, x in v.items()}, flush=True)
    json.dump(per, open(os.path.join(B.HERE, "sa_lsq.json"), "w"), indent=1)
