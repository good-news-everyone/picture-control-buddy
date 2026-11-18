"""Finds the NEF with the widest hue x lightness coverage: the camera response is measured on it."""
import glob
import io
import os
import re
import sys

import numpy as np
from PIL import Image

import color as C

HB, LB = 16, 3


def preview(path):
    b = open(path, "rb").read(2_500_000)
    best = None
    for m in re.finditer(b"\xff\xd8\xff", b):
        try:
            im = Image.open(io.BytesIO(b[m.start():]))
            if 800 < im.size[0] < 3000 and (best is None or im.size[0] > best.size[0]):
                best = im
                best.load()
        except Exception:
            pass
    return best


def coverage(im):
    a = np.asarray(im.convert("RGB").resize((360, 240), Image.BOX), dtype=np.float64) / 255
    lab = C.linear_to_oklab(C.srgb_to_linear(a.reshape(-1, 3)))
    ch = np.hypot(lab[:, 1], lab[:, 2])
    keep = (ch > 0.05) & (a.reshape(-1, 3).max(1) < 0.97)
    h = ((np.arctan2(lab[keep, 2], lab[keep, 1]) % (2 * np.pi)) / (2 * np.pi) * HB).astype(int) % HB
    l = np.clip((lab[keep, 0] - 0.3) / 0.6 * LB, 0, LB - 1).astype(int)
    cnt = np.zeros((HB, LB))
    np.add.at(cnt, (h, l), 1)
    return int((cnt >= 40).sum()), int((cnt.sum(1) >= 120).sum()), float(ch[keep].mean() if keep.any() else 0)


rows = []
for d in sys.argv[1:]:
    for p in sorted(glob.glob(os.path.join(os.path.expanduser(d), "*.NEF"))):
        im = preview(p)
        if im is None:
            continue
        rows.append((*coverage(im), p))
rows.sort(reverse=True)
print(f"frames: {len(rows)}, cells total {HB * LB}, hues total {HB}")
for r in rows[:6]:
    print(r[0], r[1], round(r[2], 3), r[3])
