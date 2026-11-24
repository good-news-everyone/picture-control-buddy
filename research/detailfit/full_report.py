import json, os, numpy as np
import full as F
S = [0, 2, 4, 6]
REF = {1: 4, 2: 3, 4: 2}      # reference band (4-8 px full-frame scale) per downscale
out = {}
for kk in (1, 2, 4):
    print(f"\n=== scale 1/{kk}: band sigma in its own px:", " ".join(f"{F.EDGES[b]}-{F.EDGES[b+1]}" for b in range(len(F.EDGES) - 1)))
    allG, allH = [], []
    for f in F.FRAMES:
        es = json.load(open(os.path.join(F.OUT, f + ".json")))
        nb = len(F.EDGES) - 1
        sm = lambda key, b: sum(e[f"x{kk}"][str(b)][key] for e in es)
        coh = [sm("T_2B", b) / np.sqrt(sm("TT", b) * sm("S2B_S2B", b)) for b in range(nb)]
        nx = [sm("S2_2B", b) / np.sqrt(sm("S2_S2", b) * sm("S2B_S2B", b)) for b in range(nb)]
        G = np.array([(sm("T_2B", b) + sm("T_2", b)) / 2 / sm("S2_2B", b) for b in range(nb)])
        H = {s: np.array([1.0 if s == 2 else (sm(f"S{s}_2B", b) + sm(f"S{s}_2", b)) / 2 / sm("S2_2B", b) for b in range(nb)]) for s in S}
        H["DET"] = np.array([(sm("DET_2B", b) + sm("DET_2", b)) / 2 / sm("S2_2B", b) for b in range(nb)])
        r = REF[kk]
        Gn = G / G[r]; Hn = {s: h / h[r] for s, h in H.items()}
        # Sharpening that matches per band: piecewise-linear in s over 0..6, extrapolate linearly
        ss = []
        for b in range(nb):
            y = np.array([Hn[s][b] for s in S])
            if abs(y[-1] - y[0]) < 0.02:
                ss.append(np.nan); continue
            fine = np.linspace(-3, 9, 1201)
            yi = np.interp(fine, S, y, left=None, right=None)
            # linear extrapolation outside 0..6
            yi = np.where(fine < 0, y[0] + (fine - 0) * (y[1] - y[0]) / 2, yi)
            yi = np.where(fine > 6, y[-1] + (fine - 6) * (y[-1] - y[-2]) / 2, yi)
            ss.append(float(fine[np.argmin(np.abs(yi - Gn[b]))]))
        print(f"{f}: coh T~NX " + " ".join(f"{c:.2f}" for c in coh) + " | NX repeat coh " + " ".join(f"{c:.2f}" for c in nx))
        print(f"   target/S2 (norm) " + " ".join(f"{g:.3f}" for g in Gn))
        for s in S + ["DET"]:
            print(f"   NX {str(s):>3}/S2      " + " ".join(f"{h:.3f}" for h in Hn[s]))
        print(f"   matching Sharpening per band: " + " ".join("  -  " if np.isnan(x) else f"{x:+.1f}" for x in ss))
        out.setdefault(str(kk), {})[f] = {"coh": coh, "G": Gn.tolist(), "H": {str(k): v.tolist() for k, v in Hn.items()}, "s": ss}
json.dump(out, open(os.path.join(F.B.HERE, "full_report.json"), "w"), indent=1)
