"""Detail diagnostic: Y' band energy of the LR targets vs the NX renders of the fitted profile.

renders/sweep/fitcheck/<frame>-NEW4.TIF (NX, 1512 px, Sharpening 2 / Mid-range 1 / Clarity 0) against
renders/sa/done/<frame>.jpg (LR, full size, Lanczos-shrunk to the NX grid).
    bands.py kernel        # NX 1512 export vs Lanczos(NX full export), DSC_6456 NEUTRAL: per-band offset
    bands.py prep F ...    # per-frame tile statistics -> stats/<F>.npz
    bands.py fit           # band ratios, detail values per frame / jointly / leave-one-out
"""
import os, sys, json
import numpy as np
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
HERE = os.path.join(ROOT, "_local", "research", "detailfit")   # outputs and caches (gitignored)
os.makedirs(HERE, exist_ok=True)
sys.path.insert(0, ROOT)
import pairs, devpairs, sweep, detail as D
Image.MAX_IMAGE_PIXELS = None
YW = np.array([0.299, 0.587, 0.114], np.float32)
EDGES = [0, 0.7, 1.4, 2.8, 5.6, 11.2, 22.4, 44.8]     # sigma in x4 pixels; band i = G(e_i) - G(e_i+1)
NBAND = len(EDGES) - 1
TILE = 64
SCALE = 4.0
V0 = {"clarity": 0.0, "mid_sharpening": 1.0, "sharpening": 2.0}
STATS = os.path.join(HERE, "stats")
FRAMES = ["DSC_5932", "DSC_6015", "DSC_6151", "DSC_6397", "DSC_6423", "DSC_6485", "DSC_6587",
          "DSC_6973", "DSC_6975", "DSC_7026", "DSC_7979", "DSC_9044"]


def y_of(im):
    a = np.asarray(pairs.to_srgb(im), dtype=np.float32) / 255
    return a @ YW


def resize(y, size):
    return np.asarray(Image.fromarray(y.astype(np.float32), "F").resize(size, Image.BOX))


def bands(y):
    g = [y if e == 0 else D.gauss(y, e) for e in EDGES]
    return [g[i] - g[i + 1] for i in range(NBAND)]


def tiles(a):
    h, w = a.shape[0] // TILE * TILE, a.shape[1] // TILE * TILE
    return a[:h, :w].reshape(h // TILE, TILE, w // TILE, TILE).mean((1, 3)).ravel()


def kernel():
    full = y_of(Image.open(os.path.join(ROOT, "renders/sweep/detail/DSC_6456-NEUTRAL.TIF")))
    x4 = y_of(Image.open(os.path.join(ROOT, "renders/sweep/tools/DSC_6456-NEUTRAL.TIF")))
    if (full.shape[0] > full.shape[1]) != (x4.shape[0] > x4.shape[1]):
        full = np.rot90(full)
    out = {}
    for name, kind in (("lanczos", Image.LANCZOS), ("box", Image.BOX), ("bicubic", Image.BICUBIC)):
        s = np.asarray(Image.fromarray(full, "F").resize(x4.shape[::-1], kind))
        bs, bx = bands(s), bands(x4)
        r = []
        for i in range(NBAND):
            es, ex = tiles(bs[i] ** 2), tiles(bx[i] ** 2)
            coh = tiles(bs[i] * bx[i]) / np.sqrt(es * ex + 1e-20)
            r.append((float(np.median(np.log(ex / es))), float(np.median(coh))))
        out[name] = r
        print(name, " ".join(f"b{i}:{np.exp(k):.2f}x(coh {c:.2f})" for i, (k, c) in enumerate(r)))
    json.dump(out, open(os.path.join(HERE, "kernel.json"), "w"), indent=1)


def prep(f):
    tgt = Image.open(os.path.join(ROOT, "renders/sa/done", f + ".jpg"))
    t_small = tgt.resize((tgt.size[0] // 4, tgt.size[1] // 4), Image.LANCZOS)
    a = np.asarray(pairs.to_srgb(Image.open(os.path.join(ROOT, "renders/sweep/fitcheck", f + "-NEW4.TIF"))),
                   dtype=np.float32) / 255
    N = devpairs.oriented([np.rot90(a, r) for r in range(4)], pairs.to_srgb(t_small))
    yn = np.ascontiguousarray(N @ YW)
    hn, wn = yn.shape
    yt_full = y_of(tgt)
    # scale + shift of the target onto the NX grid: edge correlation at 1/3
    sm = (wn // 3, hn // 3)
    ts = Image.fromarray((np.clip(resize(yt_full, (wn, hn)), 0, 1) * 255).astype(np.uint8)).resize(sm, Image.BILINEAR)
    ns = Image.fromarray((np.clip(yn, 0, 1) * 255).astype(np.uint8)).resize(sm, Image.BILINEAR)
    v, s, dx, dy = pairs.align(ts, ns)
    r = wn / sm[0]
    W, H = round(wn * s), round(hn * s)
    yt = resize(yt_full, (W, H))
    del yt_full
    ox, oy = round(wn / 2 - W / 2 + dx * r), round(hn / 2 - H / 2 + dy * r)
    # target pixel u <-> NX pixel u + o
    x0, y0 = max(0, ox), max(0, oy)
    x1, y1 = min(wn, W + ox), min(hn, H + oy)
    m = 8
    yn = yn[y0 + m:y1 - m, x0 + m:x1 - m]
    yt = yt[y0 - oy + m:y1 - oy - m, x0 - ox + m:x1 - ox - m]
    stats(f, yn, yt, np.array([v, s, dx, dy]))


def stats(f, yn, yt, align):
    # pointwise tone match NX -> target (on a light blur, robust to misalignment)
    gn, gt = D.gauss(yn, 1.5), D.gauss(yt, 1.5)
    edges = np.linspace(0, 1, 33)
    idx = np.clip(np.digitize(gn.ravel(), edges) - 1, 0, 31)
    cnt = np.bincount(idx, minlength=32)
    med = np.array([np.median(gt.ravel()[idx == i]) if cnt[i] > 200 else np.nan for i in range(32)])
    ctr = (edges[:-1] + edges[1:]) / 2
    ok = ~np.isnan(med)
    lut = np.maximum.accumulate(np.interp(ctr, ctr[ok], med[ok]))
    slope = np.gradient(lut, ctr)
    slope = np.clip(np.convolve(np.pad(slope, 2, mode="edge"), np.ones(5) / 5, "valid"), 0.2, 3)
    ynp = np.interp(yn, ctr, lut).astype(np.float32)
    gp = np.interp(yn, ctr, slope).astype(np.float32)
    model = D.Detail.load()
    basis = [ynp]
    names = ["N"]
    for tool in D.TOOLS:
        p = model.part(tool, SCALE)
        for sg in (1, -1):
            basis.append(gp * p.delta(yn, float(sg), SCALE))
            names.append(f"{tool}{'+' if sg > 0 else '-'}")
    bt = bands(yt)
    bb = [bands(b) for b in basis]
    K = len(basis)
    nt = tiles(yt).size
    ET = np.zeros((NBAND, nt), np.float64)
    G = np.zeros((NBAND, nt, K, K), np.float64)
    C = np.zeros((NBAND, nt, K), np.float64)     # target x basis cross terms (coherence)
    for i in range(NBAND):
        ET[i] = tiles(bt[i] ** 2)
        for a_ in range(K):
            C[i, :, a_] = tiles(bt[i] * bb[a_][i])
            for b_ in range(a_, K):
                G[i, :, a_, b_] = G[i, :, b_, a_] = tiles(bb[a_][i] * bb[b_][i])
    tone = tiles(yt)
    clip = np.maximum(tiles(((yt > .97) | (yt < .02)).astype(np.float32)), tiles(((yn > .97) | (yn < .02)).astype(np.float32)))
    os.makedirs(STATS, exist_ok=True)
    np.savez(os.path.join(STATS, f + ".npz"), ET=ET, G=G, C=C, tone=tone, clip=clip, names=names,
             align=align)
    coh = C[3, :, 0] / np.sqrt(ET[3] * G[3, :, 0, 0] + 1e-20)
    print(f, "align", np.round(align, 3), "size", yn.shape,
          f"coh b3 {np.median(coh):.2f}", "ratio", " ".join(f"{np.exp(np.median(np.log(ET[i] / G[i, :, 0, 0]))):.2f}" for i in range(NBAND)), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "kernel":
        kernel()
    elif sys.argv[1] == "prep":
        for f in sys.argv[2:] or FRAMES:
            prep(f)


GRID = {"clarity": np.arange(-5, 5.01, .5), "mid_sharpening": np.arange(-5, 5.01, .5),
        "sharpening": np.arange(-3, 9.01, .5)}
NMAX = 150
COH = 0.7


def load(f):
    z = np.load(os.path.join(STATS, f + ".npz"))
    ET, G, C = z["ET"], z["G"], z["C"]
    coh = C[..., 0] / np.sqrt(ET * G[..., 0, 0] + 1e-20)
    sel = (coh >= COH) & (z["clip"][None] < 0.01) & (ET > 0)
    rng = np.random.default_rng(1)
    for b in range(NBAND):
        i = np.flatnonzero(sel[b])
        if len(i) > NMAX:
            sel[b] = False; sel[b, rng.choice(i, NMAX, replace=False)] = True
    return dict(ET=ET, G=G, C=C, sel=sel, coh=coh, tone=z["tone"])


def wvec(vc, vm, vs):
    w = [1.0]
    for tool, v in (("clarity", vc), ("mid_sharpening", vm), ("sharpening", vs)):
        v0 = V0[tool]
        w += [max(v, 0) - max(v0, 0), max(-v, 0) - max(-v0, 0)]
    return np.array(w)


def loss_grid(ds, bands_used=range(NBAND)):
    """Sum over frames of the mean squared log energy ratio per band (selected tiles), on the full grid."""
    gc, gm, gs = GRID["clarity"], GRID["mid_sharpening"], GRID["sharpening"]
    L = np.zeros((len(gc), len(gm), len(gs)))
    for d in ds:
        for b in bands_used:
            s = d["sel"][b]
            if s.sum() < 10:
                continue
            lt = np.log(d["ET"][b, s])
            G = d["G"][b, s]                                   # (n, 7, 7)
            for k, vs in enumerate(gs):
                W = np.array([[wvec(vc, vm, vs) for vm in gm] for vc in gc])   # (c, m, 7)
                E = np.einsum("cmi,nij,cmj->cmn", W, G, W)
                r = np.clip(lt[None, None] - np.log(np.maximum(E, 1e-20)), -1.5, 1.5)
                L[:, :, k] += (r ** 2).mean(-1)
    return L


def best(L):
    i = np.unravel_index(np.argmin(L), L.shape)
    return tuple(float(GRID[t][j]) for t, j in zip(("clarity", "mid_sharpening", "sharpening"), i)), float(L[i])


def ratios(d, w):
    out = []
    for b in range(NBAND):
        s = d["sel"][b]
        if s.sum() < 10:
            out.append(np.nan); continue
        E = np.einsum("i,nij,j->n", w, d["G"][b, s], w)
        out.append(float(np.exp(np.median(np.log(d["ET"][b, s] / E)))))
    return out


def grid_of(f, d):
    p = os.path.join(STATS, f + ".L.npy")
    if os.path.exists(p):
        return np.load(p)
    L = loss_grid([d]); np.save(p, L); return L


def fit(frames):
    ds = {f: load(f) for f in frames}
    Ls = {f: grid_of(f, d) for f, d in ds.items()}
    w0 = wvec(V0["clarity"], V0["mid_sharpening"], V0["sharpening"])
    print("selected tiles per band (coh>=%.1f):" % COH)
    for f, d in ds.items():
        print(f"  {f}", " ".join(f"{int(d['sel'][b].sum()):4d}" for b in range(NBAND)),
              "| median coh", " ".join(f"{np.median(d['coh'][b]):.2f}" for b in range(NBAND)))
    print("\ntarget / NX(NEW4: Sha 2, Mid 1, Cla 0) energy ratio per band, selected tiles")
    print("  band sigma(x4 px):", " ".join(f"{EDGES[b]:.1f}-{EDGES[b+1]:.1f}" for b in range(NBAND)))
    for f, d in ds.items():
        print(f"  {f}", " ".join(f"{r:9.2f}" for r in ratios(d, w0)))
    res = {}
    print("\nper-frame best (clarity, mid, sharpening) and ratios after")
    for f, d in ds.items():
        v, l = best(Ls[f])
        l0 = Ls[f][np.searchsorted(GRID["clarity"], 0), np.searchsorted(GRID["mid_sharpening"], 1), np.searchsorted(GRID["sharpening"], 2)]
        res[f] = v
        print(f"  {f} {v}  loss {l0:.3f} -> {l:.3f}  ", " ".join(f"{r:.2f}" for r in ratios(d, wvec(*v))))
    Lall = sum(Ls.values())
    vall, _ = best(Lall)
    print("\njoint:", vall)
    for f, d in ds.items():
        print(f"  {f}", " ".join(f"{r:.2f}" for r in ratios(d, wvec(*vall))))
    print("\nleave-one-out (joint on the others):")
    for f in ds:
        print(f"  without {f}:", best(sum(L for g, L in Ls.items() if g != f))[0])
    json.dump({"per_frame": res, "joint": vall}, open(os.path.join(HERE, "fit.json"), "w"), indent=1)


if __name__ == "__main__" and sys.argv[1] == "fit":
    fit(sys.argv[2:] or FRAMES)
