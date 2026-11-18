"""Flexible Color response model from the probe pack: only what was measured on the chart.

The color stage is a sum of offsets from neutral in encoded sRGB, the response is linear
in the slider value, and the plus and minus tables are separate. The curve is handled
separately: it changes only the Y' lightness (Rec.601), leaving Cb and Cr untouched.

The blender moves sets A and B as a whole, so a color's response is isolated by the
column boundaries of its set: these are the minima of the set's response.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import numpy as np

import np3

HERE = os.path.dirname(os.path.abspath(__file__))
LUMA = np.array([0.299, 0.587, 0.114])
AMP = 60.0
TONE = ("contrast", "highlights", "shadows", "white", "black")
ATTRS = ("hue", "chroma", "brightness")
HUE_DEG = (0, 120, 240)
COLS_OF = {
    "red": range(0, 3), "yellow": range(3, 9), "cyan": range(9, 17), "purple": range(17, 24),
    "orange": range(2, 6), "green": range(6, 11), "blue": range(11, 22), "magenta": (22, 23, 0, 1),
}


@dataclass
class Params:
    saturation: float = 0.0
    blender: dict = field(default_factory=lambda: {c: [0.0, 0.0, 0.0] for c in np3.COLORS})
    grade: dict = field(default_factory=lambda: {z: [0.0, 0.0] for z in np3.ZONES})   # hue, chroma
    curve: np.ndarray | None = None      # 257 values 0..1
    # the remaining NP3 sliders; tonal sliders are incompatible with the curve, NP3 ignores them when a curve is set
    tone: dict = field(default_factory=lambda: {k: 0.0 for k in TONE})
    grade_bright: dict = field(default_factory=lambda: {z: 0.0 for z in np3.ZONES})
    blending: float = 50.0
    balance: float = 0.0


def apply_curve(rgb: np.ndarray, table: np.ndarray | None) -> np.ndarray:
    if table is None:
        return rgb
    y = rgb @ LUMA
    return rgb + (np.interp(y, np.linspace(0, 1, 257), table) - y)[..., None]


class Response:
    def __init__(self, probes: np.ndarray, manifest: list[dict]):
        self.base = probes[0]
        self.d = {}
        for m in manifest:
            i = m["id"] - 1
            delta = probes[i] - self.base
            if m["group"] == "saturation":
                self.d["sat", np.sign(m["value"])] = delta / abs(m["value"])
            elif m["group"] == "blender":
                sign = np.sign(m["value"])
                for c in m["colors"]:
                    mask = np.zeros((1, 24, 1))
                    mask[0, list(COLS_OF[c])] = 1
                    self.d[c, m["attr"], sign] = delta * mask / AMP
            elif m["group"] == "grade":
                self.d[m["zone"], m["hue"]] = delta / AMP
        self.grade_basis = {}
        for z in np3.ZONES:
            d = [self.d[z, h] for h in HUE_DEG]
            ang = np.radians(HUE_DEG)
            self.grade_basis[z] = (sum(d) / 3,
                                   sum(x * np.cos(a) for x, a in zip(d, ang)) * 2 / 3,
                                   sum(x * np.sin(a) for x, a in zip(d, ang)) * 2 / 3)

    def color(self, p: Params) -> np.ndarray:
        out = self.base.copy()
        if p.saturation:
            out = out + self.d["sat", np.sign(p.saturation)] * abs(p.saturation)
        for c, vals in p.blender.items():
            for attr, v in zip(ATTRS, vals):
                if v:
                    out = out + self.d[c, attr, np.sign(v)] * abs(v)
        for z, (hue, chroma) in p.grade.items():
            if chroma:
                m, u, w = self.grade_basis[z]
                a = np.radians(hue)
                out = out + chroma * (m + u * np.cos(a) + w * np.sin(a))
        return out

    def predict(self, p: Params, curve_last: bool = True) -> np.ndarray:
        if curve_last:
            return apply_curve(self.color(p), p.curve)
        return self.color(p) - self.base + apply_curve(self.base, p.curve)


def params_of(c: np3.Control) -> Params:
    return Params(saturation=c.saturation,
                  blender={k: list(c.blender.get(k, (0, 0, 0))) for k in np3.COLORS},
                  grade={k: list(c.grade.get(k, (0, 0, 0)))[:2] for k in np3.ZONES},
                  curve=np.array(c.curve.raw) / 32767 if c.curve else None,
                  tone={k: 0.0 if c.curve else float(getattr(c, k)) for k in TONE},
                  grade_bright={k: float((list(c.grade.get(k, (0, 0, 0))) + [0])[2]) for k in np3.ZONES},
                  blending=float(c.blending), balance=float(c.balance))


def load():
    """Loads the legacy on-screen chart model. The chart data lives in the np3-fit-charts project."""
    d = np.load(os.path.join(HERE, "data", "chart.npz"))
    manifest = json.load(open(os.path.join(HERE, "out", "pack1", "manifest.json")))
    train = [m for m in manifest if m["group"] != "validate"]
    return d, manifest, Response(d["probes"], train)
