"""Approximate NEF or DNG render with an NP3 profile, without NX Studio.

Development produces the Nikon neutral, then the step-based profile model (profile_model.py)
is applied on top. The result depends only on the pixel color, so the profile is baked into
a 3D LUT: a frame of any size is computed in a fraction of a second. The legacy on-screen
chart model is available as Renderer(profile="patches"). The error against a real render is
described in spec/results.md; only NX Studio and the camera render exactly.

    python3 render.py frame.NEF profile|file.NP3 [output.jpg] [--full]

Clarity, Sharpening and Mid-range sharpening are computed by detail.py on top of color. By default
the frame is shrunk to 1600 px, --full gives the full rawdev development (half the sensor, 3024 px):
small-radius sharpening is only visible that way.
"""
from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image

import color as C
import detail
import devmodel
import devpairs
import fit as F
import match as MT
import model as M
import np3
import profile_model
import rawdev
import strength
import vignette
import wbmap

HERE = os.path.dirname(os.path.abspath(__file__))
GRID = 33
ORIENTATION = 0x0112
TURNS = {3: 2, 6: 3, 8: 1}       # tag value -> rot90 count
CHUNK = 4096


def orientation(raw: str) -> int:
    with open(raw, "rb") as f:
        b = f.read()
    e = "<" if b[:2] == b"II" else ">"
    ifd = wbmap.tiff_ifd(b, int.from_bytes(b[4:8], "little" if e == "<" else "big"), e)
    return int.from_bytes(b[ifd[ORIENTATION][1]:][:2], "little" if e == "<" else "big") if ORIENTATION in ifd else 1


def linear(raw: str, long: int = 1600) -> np.ndarray:
    """Camera linear RGB: frame without margins, with rotation from the file and vignette correction, at most long."""
    lin = rawdev.develop(raw)[devpairs.MY:-devpairs.MY, devpairs.MX:-devpairs.MX]
    ab = vignette.coefficients(raw, lin)
    k = -(-max(lin.shape) // long)
    return np.ascontiguousarray(np.rot90(vignette.correct(devpairs.shrink(lin, k), ab), TURNS.get(orientation(raw), 0)))


class Renderer:
    def __init__(self, profile: str = "steps"):
        self.kind = profile
        self.steps = profile_model.Model.load() if profile == "steps" else None
        g = np.linspace(0, 1, GRID)
        self.grid = np.stack(np.meshgrid(g, g, g, indexing="ij"), -1).reshape(-1, 3)
        self.dev = devmodel.Dev.load(devmodel.RENDER)
        self.detail = detail.Detail.load()
        if self.steps:
            self.R = None
            self.patches = None
            self.W = None
        else:
            # legacy pixel model: measured on the printed chart sheet, kept in the np3-fit-charts project
            _, _, self.R = M.load()
            self.patches = self.R.base.reshape(-1, 3)
            plab = C.srgb_to_lab(self.patches)
            self.W = np.vstack([F.nearest(C.srgb_to_lab(self.grid[i:i + CHUNK]), plab)
                                for i in range(0, len(self.grid), CHUNK)])

    def neutral(self, lin: np.ndarray, gain=np.ones(3)) -> np.ndarray:
        h, w = lin.shape[:2]
        return self.dev(lin.reshape(-1, 3).astype(np.float64) * gain).reshape(h, w, 3).astype(np.float32)

    def lut(self, c: np3.Control) -> np.ndarray:
        """Step-based model baked into a GRID^3 LUT: neutral sRGB -> result sRGB."""
        out = np.vstack([self.steps(self.grid[i:i + CHUNK], c) for i in range(0, len(self.grid), CHUNK)])
        return out.reshape(GRID, GRID, GRID, 3).astype(np.float32)

    def apply(self, base: np.ndarray, c: np3.Control, sharp: bool = False) -> np.ndarray:
        """Color and tone per pixel; with sharp=True also Clarity and sharpening plus the NX base
        detail (detail.py), frames (h, w, 3) only.

        No detail by default: fitting and color comparison run on profiles without it.
        """
        if self.steps:
            out = np.clip(trilinear(self.lut(c), base), 0, 1)
        else:
            p = M.params_of(c)               # legacy model: curve on the pixel, offset from a LUT
            d = (self.W @ (self.R.color(p).reshape(-1, 3) - self.patches)).reshape(GRID, GRID, GRID, 3).astype(np.float32)
            out = np.clip(M.apply_curve(base, p.curve) + trilinear(d, base), 0, 1)
        if sharp and out.ndim == 3:
            out = self.detail(out, c, base=True)       # with the NX base detail (decision #18)
        return out

    def unrendered(self, c: np3.Control) -> list[str]:
        """Profile detail tools that have no model yet."""
        return [t for t in detail.TOOLS if getattr(c, t) and not self.detail.has(t)]


def trilinear(lut: np.ndarray, rgb: np.ndarray) -> np.ndarray:
    n = lut.shape[0] - 1
    u = np.clip(rgb, 0, 1) * n
    i = np.minimum(u.astype(np.int32), n - 1)
    f = u - i
    r, g, b = i[..., 0], i[..., 1], i[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]
    out = 0
    for dr, wr in ((0, 1 - fr), (1, fr)):
        for dg, wg in ((0, 1 - fg), (1, fg)):
            for db, wb in ((0, 1 - fb), (1, fb)):
                out = out + lut[r + dr, g + dg, b + db] * (wr * wg * wb)
    return out


def load_control(arg: str) -> np3.Control:
    path, _ = strength.locate(arg)
    return np3.deserialize(open(path, "rb").read())


def to_image(rgb: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(rgb, 0, 1) * 255 + .5).astype(np.uint8))


def main():
    args = [a for a in sys.argv[1:] if a != "--full"]
    if len(args) < 2:
        sys.exit("usage: python3 render.py frame.NEF profile|file.NP3 [output.jpg] [--full]")
    raw, profile = args[:2]
    out = args[2] if len(args) > 2 else os.path.splitext(os.path.basename(raw))[0] + ".jpg"
    r = Renderer()
    c = load_control(profile)
    lin = linear(raw, 10 ** 6) if "--full" in sys.argv else linear(raw)
    to_image(r.apply(r.neutral(lin), c, sharp=True)).save(out, quality=95)
    if r.unrendered(c):
        print("no model, not applied:", ", ".join(r.unrendered(c)))
    print("file:", out)


if __name__ == "__main__":
    main()
