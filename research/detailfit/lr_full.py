import json, os, numpy as np
import full as F
S = [0, 2, 4, 6]
REF = {1: 4, 2: 3}
out = {}
for kk in (1, 2):
    print(f"\n=== 1/{kk}: matching NX Sharpening per band (bands sigma 0-0.5, 0.5-1, 1-2, 2-4 px at this scale); target/S2 in ()")
    for var in ["done", "CLA50", "CLAM40", "TEX50", "SHA100"]:
        for f in F.FRAMES:
            es = json.load(open(os.path.join(F.OUT, f + ("" if var == "done" else "-" + var) + ".json")))
            sm = lambda key, b: sum(e[f"x{kk}"][str(b)][key] for e in es)
            nb = 4
            r = REF[kk]
            G = np.array([(sm("T_2B", b) + sm("T_2", b)) / 2 / sm("S2_2B", b) for b in range(6)]); G = G / G[r]
            H = {s: np.array([1.0 if s == 2 else (sm(f"S{s}_2B", b) + sm(f"S{s}_2", b)) / 2 / sm("S2_2B", b) for b in range(6)]) for s in S}
            H = {s: h / h[r] for s, h in H.items()}
            ss = []
            for b in range(nb):
                if b == r: ss.append(np.nan); continue
                y = np.array([H[s][b] for s in S]); fine = np.linspace(-3, 12, 1501)
                yi = np.interp(fine, S, y)
                yi = np.where(fine > 6, y[-1] + (fine - 6) * (y[-1] - y[-2]) / 2, np.where(fine < 0, y[0] + fine * (y[1] - y[0]) / 2, yi))
                ss.append(float(fine[np.argmin(np.abs(yi - G[b]))]))
            out.setdefault(str(kk), {}).setdefault(var, {})[f] = ss
            print(f"  {var:7s} {f}: " + "  ".join("  -  " if np.isnan(x) else f"{x:+5.1f} ({g:.2f})" for x, g in zip(ss, G[:nb])))
json.dump(out, open(os.path.join(F.B.HERE, "lr_full.json"), "w"), indent=1)
