"""Full-size check (renders/sweep/detailcheck): which NX Sharpening matches the LR target, model-free.
Per frame: textured crops, subpixel alignment by phase correlation (FFT shift, no blur), DoG bands, IV transfer:
  G_b   = <T_b, X2B_b> / <X2_b, X2B_b>       target relative to NX Sharpening 2 (export noise cancels)
  H_s,b = <Xs_b, X2B_b> / <X2_b, X2B_b>      NX Sharpening s relative to 2
    full.py prep F ...   -> fullstats/F.json ;  full.py report"""
import os, sys, json, numpy as np
from PIL import Image
import bands as B
Image.MAX_IMAGE_PIXELS = None
DC = os.path.join(B.ROOT, "renders/sweep/detailcheck")
OUT = os.path.join(B.HERE, "fullstats"); os.makedirs(OUT, exist_ok=True)
TAGS = ["S0", "S2", "S2B", "S4", "S6", "DET"]
EDGES = [0, .5, 1, 2, 4, 8, 16]
CROP, PAD, NCROP = 768, 32, 8
FRAMES = ["DSC_6015", "DSC_6423", "DSC_6973", "DSC_7026"]


def gauss(a, s):
    return a if s == 0 else B.D.gauss(a, s)


def bands(y, k=1):
    if k > 1:
        h, w = y.shape[0] // k * k, y.shape[1] // k * k
        y = y[:h, :w].reshape(h // k, k, w // k, k).mean((1, 3))
    g = [gauss(y, e) for e in EDGES]
    return [g[i] - g[i + 1] for i in range(len(EDGES) - 1)]


def shift_est(a, b):
    """Subpixel shift d such that b(x) ~ a(x - d): phase correlation, parabolic peak."""
    w = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    A, Bf = np.fft.fft2((a - a.mean()) * w), np.fft.fft2((b - b.mean()) * w)
    r = np.fft.ifft2(Bf * np.conj(A) / (np.abs(Bf * np.conj(A)) + 1e-12)).real
    i, j = np.unravel_index(np.argmax(r), r.shape)
    def sub(m, p, n):
        return 0.5 * (m - n) / (m - 2 * p + n + 1e-12)
    H, W = r.shape
    di = i + sub(r[(i - 1) % H, j], r[i, j], r[(i + 1) % H, j])
    dj = j + sub(r[i, (j - 1) % W], r[i, j], r[i, (j + 1) % W])
    di = di - H if di > H / 2 else di
    dj = dj - W if dj > W / 2 else dj
    return di, dj, float(r.max())


def fshift(a, d):
    fy = np.fft.fftfreq(a.shape[0])[:, None]; fx = np.fft.fftfreq(a.shape[1])[None, :]
    return np.fft.ifft2(np.fft.fft2(a) * np.exp(-2j * np.pi * (fy * d[0] + fx * d[1]))).real.astype(np.float32)


def load(path):
    return B.y_of(Image.open(path))


def prep(f, variants=("done",)):
    X = {t: load(os.path.join(DC, f"{f}-{t}.TIF")) for t in TAGS}
    T = load(os.path.join(B.ROOT, "renders/sa/done", f + ".jpg"))
    rot, flip = False, False
    if T.shape != X["S2"].shape:
        T = np.rot90(T); rot = True
    # orientation 0 / 180 by small ncc
    sm = lambda a: a[::16, ::16]
    if np.corrcoef(sm(T).ravel(), sm(X["S2"]).ravel())[0, 1] < np.corrcoef(sm(T)[::-1, ::-1].ravel(), sm(X["S2"]).ravel())[0, 1]:
        T = T[::-1, ::-1].copy(); flip = True
    # textured crops: mean |grad| of the target at 1/8, away from borders and clipping
    k = 8
    h, w = T.shape[0] // k * k, T.shape[1] // k * k
    t8 = T[:h, :w].reshape(h // k, k, w // k, k)
    tex = np.abs(np.diff(T[:h, :w], axis=1, append=0)).reshape(h // k, k, w // k, k).mean((1, 3))
    clip = ((t8 > .97) | (t8 < .03)).mean((1, 3))
    c = CROP // k
    score = np.full(tex.shape, -1.0)
    m = (256 + PAD) // k
    for i in range(m, tex.shape[0] - m - c):
        for j in range(m, tex.shape[1] - m - c, 2):
            pass
    # box score via cumulative sums
    cs = np.pad(tex, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    cl = np.pad(clip, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    box = lambda s, i, j: s[i + c, j + c] - s[i, j + c] - s[i + c, j] + s[i, j]
    cands = []
    for i in range(m, tex.shape[0] - m - c, 4):
        for j in range(m, tex.shape[1] - m - c, 4):
            if box(cl, i, j) / c / c < 0.02:
                cands.append((box(cs, i, j), i, j))
    cands.sort(reverse=True)
    crops = []
    for s, i, j in cands:
        if all(abs(i - a) >= c or abs(j - b) >= c for a, b in crops):
            crops.append((i, j))
        if len(crops) == NCROP:
            break
    for var in variants:
        if var != "done":
            T = load(os.path.join(B.ROOT, "renders/sa", var, f + ".jpg"))
            if rot: T = np.rot90(T)
            if flip: T = T[::-1, ::-1].copy()
        crop_stats(f, var, X, T, crops, k)


def crop_stats(f, var, X, T, crops, k):
    res = []
    for i, j in crops:
        y0, x0 = i * k - PAD, j * k - PAD
        sl = (slice(y0, y0 + CROP + 2 * PAD), slice(x0, x0 + CROP + 2 * PAD))
        xc = {t: X[t][sl] for t in TAGS}
        tc = T[sl]
        dy, dx, peak = shift_est(xc["S2"], tc)
        tc = fshift(tc, (-dy, -dx))
        inner = (slice(PAD, -PAD), slice(PAD, -PAD))
        entry = {"pos": [int(y0), int(x0)], "shift": [float(dy), float(dx)], "peak": peak}
        for kk in (1, 2, 4):
            bt = bands(tc[inner], kk); bx = {t: bands(xc[t][inner], kk) for t in TAGS}
            cr = {}
            for b in range(len(EDGES) - 1):
                cr[b] = {"TT": float((bt[b] ** 2).mean()), "T_2B": float((bt[b] * bx["S2B"][b]).mean()),
                         "T_2": float((bt[b] * bx["S2"][b]).mean())}
                for t in TAGS:
                    cr[b][t + "_2B"] = float((bx[t][b] * bx["S2B"][b]).mean())
                    cr[b][t + "_2"] = float((bx[t][b] * bx["S2"][b]).mean())
                    cr[b][t + "_" + t] = float((bx[t][b] ** 2).mean())
            entry[f"x{kk}"] = cr
        res.append(entry)
    json.dump(res, open(os.path.join(OUT, f + ("" if var == "done" else "-" + var) + ".json"), "w"))
    print(f, var, "crops", len(res), "shifts", [tuple(round(v, 2) for v in e["shift"]) for e in res], flush=True)


if __name__ == "__main__" and sys.argv[1] == "prep":
    for f in sys.argv[2:]:
        prep(f, ("CLA50", "CLAM40", "TEX50", "SHA100"))
