"""Check the fitted detail (renders/sweep/detailcheck2) against the LR variants: NX NEW4 (S2) vs NX fitted profile.
  verify.py cache F   -> vcache/F.npz (x4 Y' of all NX exports and targets + full-size crops)
  verify.py report"""
import os, sys, json, numpy as np
from PIL import Image
import bands as B, full as Fu, lsq
Image.MAX_IMAGE_PIXELS = None
D2 = os.path.join(B.ROOT, "renders/sweep/detailcheck2")
C = os.path.join(B.HERE, "vcache"); os.makedirs(C, exist_ok=True)
VARS = ["done", "CLA50", "CLAM40", "TEX50", "SHA100"]
FIT = {"CLA50": "FCLA50", "CLAM40": "FCLAM40", "TEX50": "FTEX50", "SHA100": "FSHA100"}
NX = {"S2": os.path.join(Fu.DC, "{f}-S2.TIF"), "S2B": os.path.join(Fu.DC, "{f}-S2B.TIF"),
      "DET": os.path.join(Fu.DC, "{f}-DET.TIF"), **{v: os.path.join(D2, "{f}-" + v + ".TIF") for v in FIT.values()}}


def box(y, k):
    h, w = y.shape[0] // k * k, y.shape[1] // k * k
    return y[:h, :w].reshape(h // k, k, w // k, k).mean((1, 3))


def cache(f):
    prev = json.load(open(os.path.join(Fu.OUT, f + ".json")))      # crop positions from the first pass
    pos = [e["pos"] for e in prev]
    S = Fu.CROP + 2 * Fu.PAD
    out = {}
    ref = None
    for name, p in NX.items():
        y = Fu.load(p.format(f=f))
        if ref is None:
            ref = y[::16, ::16].copy()
        out["x4_" + name] = box(y, 4).astype(np.float32)
        out["cr_" + name] = np.stack([y[a:a + S, b:b + S] for a, b in pos]).astype(np.float32)
    for v in VARS:
        t = Fu.load(os.path.join(B.ROOT, "renders/sa", v, f + ".jpg"))
        if t.shape != ref.shape and t.shape[::-1] == (ref.shape[0] * 16, ref.shape[1] * 16)[::-1]:
            pass
        if t.shape[0] // 16 != ref.shape[0]:
            t = np.rot90(t)
        sm = t[::16, ::16][:ref.shape[0], :ref.shape[1]]
        if np.corrcoef(sm.ravel(), ref.ravel())[0, 1] < np.corrcoef(sm[::-1, ::-1].ravel(), ref.ravel())[0, 1]:
            t = t[::-1, ::-1]
        out["x4_T" + v] = box(t, 4).astype(np.float32)
        out["cr_T" + v] = np.stack([t[a:a + S, b:b + S] for a, b in pos]).astype(np.float32)
    np.savez(os.path.join(C, f + ".npz"), **out)
    print(f, "cached", flush=True)


def resid(yx, yt):
    """Band-limited (sigma 1.4-45 x4 px) residual energy of the target after a LUT of the render, LUT fitted."""
    d = lsq.design(yx, yt, {"clarity": 0, "mid_sharpening": 0, "sharpening": 0}, sub=150_000)
    x, *_ = np.linalg.lstsq(d["L"], d["t"], rcond=None)
    r = d["t"] - d["L"] @ x
    return float(r @ r / (d["t"] @ d["t"]))


def gains(z, v, prof, kk):
    """Per band coherent gain target / render over the crops, instrument S2B; |log| is the mismatch."""
    num = np.zeros(6); den = np.zeros(6)
    for i in range(z["cr_S2"].shape[0]):
        x2, xb, xp, t = z["cr_S2"][i], z["cr_S2B"][i], z["cr_" + prof][i], z["cr_T" + v][i]
        dy, dx, _ = Fu.shift_est(x2, t)
        t = Fu.fshift(t, (-dy, -dx))
        inner = (slice(Fu.PAD, -Fu.PAD), slice(Fu.PAD, -Fu.PAD))
        bt, bb, bp = Fu.bands(t[inner], kk), Fu.bands(xb[inner], kk), Fu.bands(xp[inner], kk)
        for b in range(6):
            num[b] += (bt[b] * bb[b]).mean(); den[b] += (bp[b] * bb[b]).mean()
    return num / den


if __name__ == "__main__":
    if sys.argv[1] == "cache":
        for f in sys.argv[2:]:
            cache(f)
    else:
        rows = {}
        for f in sys.argv[2:] or Fu.FRAMES:
            z = np.load(os.path.join(C, f + ".npz"))
            for v in VARS[1:] + ["done"]:
                prof = FIT.get(v, "DET")
                r0, r1 = resid(z["x4_S2"], z["x4_T" + v]), resid(z["x4_" + prof], z["x4_T" + v])
                g = {kk: (gains(z, v, "S2", kk), gains(z, v, prof, kk)) for kk in (1, 2)}
                rows.setdefault(v, []).append((f, r0, r1, g))
                print(f"{f} {v:6s} vs {prof:7s}: x4 band residual NEW4 {r0*100:.2f}% -> fitted {r1*100:.2f}%  ({(r1/r0-1)*100:+.1f}%)", flush=True)
                for kk in (1, 2):
                    a, b = g[kk]
                    print(f"     1/{kk} gain target/render per band  NEW4 " + " ".join(f"{x:.2f}" for x in a) + "   fitted " + " ".join(f"{x:.2f}" for x in b))
