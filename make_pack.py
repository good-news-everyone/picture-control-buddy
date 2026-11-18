"""Builds a calibration pack: probe NP3s and a color chart for shooting off the screen.

Each probe changes one group of parameters relative to neutral. Sharpening and
clarity are zeroed so spatial effects do not interfere with color measurement.

Blender colors come in two interleaved sets (A and B): neighboring colors overlap
in hue, while every-other-one colors barely do, so each color's response can be
separated within one probe. The control probes V* do not take part in fitting.

    python3 make_pack.py
"""
from __future__ import annotations

import json
import math
import os
import random

import numpy as np
from PIL import Image

import color as C
import np3

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "pack1")
SET_A = ("red", "yellow", "cyan", "purple")
SET_B = ("orange", "green", "blue", "magenta")
ATTR = ("hue", "chroma", "brightness")
AMP = 60


def curve_from(f) -> np3.Curve:
    """A table and 20 points from one function: Nikon recomputes the curve from the points."""
    raw = [round(min(1, max(0, f(i / 256))) * 32767) for i in range(257)]
    xs = [round(i * 255 / 19) for i in range(20)]
    pts = [(x, round(min(1, max(0, f(x / 255))) * 255)) for x in xs]
    return np3.Curve(raw=raw, points=pts)


def neutral(name: str, **kw) -> np3.Control:
    return np3.Control(name=name, sharpening=0, mid_sharpening=0, clarity=0, **kw)


def blender(colors, attr: str, value: int) -> dict:
    i = ATTR.index(attr)
    return {c: tuple(value if k == i else 0 for k in range(3)) for c in colors}


def probes() -> list[tuple[str, dict, np3.Control]]:
    out = []

    def add(tag: str, meta: dict, **kw):
        n = len(out) + 1
        out.append((tag, {"id": n, **meta}, neutral(f"NPF{n:02d}-{tag}"[:19], **kw)))

    add("NEUTRAL", {"group": "base"})
    add("CURVE-ID", {"group": "curve", "kind": "identity"}, curve=np3.identity_curve())
    add("CURVE-GAMMA", {"group": "curve", "kind": "gamma0.6"}, curve=curve_from(lambda x: x ** 0.6))
    add("CURVE-S", {"group": "curve", "kind": "s"},
        curve=curve_from(lambda x: x - 0.08 * math.sin(2 * math.pi * x)))
    add("SAT-M100", {"group": "saturation", "value": -100}, saturation=-100)
    add("SAT-P60", {"group": "saturation", "value": 60}, saturation=60)
    for attr in ATTR:
        for sign in (1, -1):
            for label, colors in (("A", SET_A), ("B", SET_B)):
                v = sign * AMP
                tag = f"{attr[:2].upper()}{'P' if sign > 0 else 'M'}{AMP}{label}"
                add(tag, {"group": "blender", "attr": attr, "value": v, "colors": colors},
                    blender=blender(colors, attr, v))
    for zone in np3.ZONES:
        for hue in (0, 120, 240):
            add(f"GR{np3.ZONE_TAG[zone]}{hue}", {"group": "grade", "zone": zone, "hue": hue, "chroma": AMP},
                grade={zone: (hue, AMP, 0)})

    rng = random.Random(20261105)
    add("V-RANDOM", {"group": "validate", "kind": "random"},
        saturation=rng.randint(-30, 30),
        blender={c: (rng.randint(-40, 40), rng.randint(-40, 40), rng.randint(-40, 40)) for c in np3.COLORS},
        grade={z: (rng.randint(0, 359), rng.randint(10, 40), 0) for z in np3.ZONES},
        curve=curve_from(lambda x: x - 0.05 * math.sin(2 * math.pi * x)))
    add("V-HALF", {"group": "validate", "kind": "linearity", "colors": SET_A, "value": AMP // 2},
        blender=blender(SET_A, "hue", AMP // 2))
    return out


def max_chroma(L: float, h: float) -> float:
    lo, hi = 0.0, 0.4
    for _ in range(24):
        c = (lo + hi) / 2
        lin = C.oklab_to_linear(np.array([L, c * math.cos(h), c * math.sin(h)]))
        if lin.min() < 0 or lin.max() > 1:
            hi = c
        else:
            lo = c
    return lo


def chart(path: str, width=1920, height=1200, hues=24):
    """A hue circle in lightness x chroma rows with a gray scale at the bottom."""
    rows = [(L, k) for L in (0.35, 0.5, 0.65, 0.8) for k in (0.5, 1.0)]
    img = np.full((height, width, 3), 0.42)
    img = C.linear_to_srgb(C.srgb_to_linear(img))
    margin, gap = 24, 4
    ph = (height - 2 * margin) // (len(rows) + 1)
    pw = (width - 2 * margin) // hues
    for r, (L, k) in enumerate(rows):
        for i in range(hues):
            h = 2 * math.pi * i / hues
            c = max_chroma(L, h) * k
            lin = C.oklab_to_linear(np.array([L, c * math.cos(h), c * math.sin(h)]))
            y, x = margin + r * ph, margin + i * pw
            img[y:y + ph - gap, x:x + pw - gap] = C.linear_to_srgb(np.clip(lin, 0, 1))
    for i in range(hues):
        v = i / (hues - 1)
        y, x = margin + len(rows) * ph, margin + i * pw
        img[y:y + ph - gap, x:x + pw - gap] = v
    Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(path)


def main():
    card = os.path.join(OUT, "NIKON", "CUSTOMPC")
    os.makedirs(card, exist_ok=True)
    manifest = []
    for tag, meta, ctrl in probes():
        data = np3.serialize(ctrl)
        back = np3.deserialize(data)
        assert np3.serialize(back) == data, tag
        assert back.name == ctrl.name and len(ctrl.name) <= 19, tag
        fname = f"PICCON{meta['id']:02d}.NP3"
        open(os.path.join(card, fname), "wb").write(data)
        manifest.append({"file": fname, "name": ctrl.name, **meta})
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), ensure_ascii=False, indent=1)
    chart(os.path.join(OUT, "chart.png"))
    print(f"probes: {len(manifest)}")
    for m in manifest:
        print(f"  {m['file']}  {m['name']}")


if __name__ == "__main__":
    main()
