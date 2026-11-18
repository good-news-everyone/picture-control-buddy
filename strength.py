"""Profile strength: new NP3s at a fraction of the way from neutral to the finished profile.

Blender, grading and sliders are multiplied by the fraction, the curve is blended with the
identity line. Sharpening is not changed. Values above 100 strengthen the profile.

    python3 strength.py name 30 50 70
    python3 strength.py path/to/file.NP3 30 50 70
"""
from __future__ import annotations

import dataclasses
import os
import sys

import numpy as np

import make_pack
import np3

HERE = os.path.dirname(os.path.abspath(__file__))
SLIDERS = ("contrast", "highlights", "shadows", "white", "black", "saturation")
LIMIT = 100


def scale(v: float, k: float) -> int:
    return int(np.clip(round(v * k), -LIMIT, LIMIT))


def scaled(c: np3.Control, percent: int, name: str) -> np3.Control:
    k = percent / 100
    out = dataclasses.replace(c, name=name)
    for s in SLIDERS:
        setattr(out, s, scale(getattr(c, s), k))
    out.blender = {n: tuple(scale(v, k) for v in vals) for n, vals in c.blender.items()}
    out.grade = {z: (hue, min(LIMIT, max(0, round(chroma * k))), scale(bright, k))
                 for z, (hue, chroma, bright) in c.grade.items()}
    if c.curve:
        table = np.array(c.curve.raw) / 32767
        grid = np.linspace(0, 1, 257)
        out.curve = make_pack.curve_from(lambda t: float(t + k * (np.interp(t, grid, table) - t)))
    return out


def locate(arg: str) -> tuple[str, str]:
    """Profile file and result folder name: accepts an out/ name, a folder, or a file."""
    inner = os.path.join("NIKON", "CUSTOMPC", "PICCON01.NP3")
    for path in (arg, os.path.join(arg, inner), os.path.join(HERE, "out", arg, inner)):
        if os.path.isfile(path):
            path = os.path.abspath(path)
            parts = path.split(os.sep)
            if len(parts) > 4 and parts[-3:-1] == ["NIKON", "CUSTOMPC"]:
                return path, parts[-4]
            return path, os.path.splitext(parts[-1])[0]
    sys.exit(f"profile not found: {arg}")


def save(base: np3.Control, name: str, percent: int, slot: int) -> tuple[np3.Control, str]:
    folder = os.path.join(HERE, "out", name + "_strength", "NIKON", "CUSTOMPC")
    os.makedirs(folder, exist_ok=True)
    label = f"-{percent}"
    ctrl = scaled(base, percent, base.name[:19 - len(label)] + label)
    data = np3.serialize(ctrl)
    assert np3.serialize(np3.deserialize(data)) == data
    path = os.path.join(folder, f"PICCON{slot:02d}.NP3")
    open(path, "wb").write(data)
    return ctrl, path


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: python3 strength.py name|file.NP3 30 50 70")
    source, name = locate(sys.argv[1])
    try:
        percents = [int(p) for p in sys.argv[2:]]
    except ValueError:
        sys.exit("strength is given in whole percents: 30 50 70")
    base = np3.deserialize(open(source, "rb").read())
    for i, percent in enumerate(percents, 1):
        ctrl, path = save(base, name, percent, i)
        print(f"{ctrl.name}: {path}")


if __name__ == "__main__":
    main()
