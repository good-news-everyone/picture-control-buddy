"""A pack for NX Studio: NEF copies, each with its own profile right in the sidecar.

Profiles are not assigned by hand: the NP3 is written into the nikon::PictureControl filter of the
same copy's .nksc. In NX Studio all that remains is to select everything and export once.

    python3 sweep.py pilot     # 2 frames, 6 profiles: checks that NX accepts such sidecars
    python3 sweep.py full      # 5 frames, 200 profiles: slider pairs, real and similar profiles
    python3 sweep.py extract   # NX exports from full/tif -> data/sweep2.npz
    python3 sweep.py colors    # 10 frames, 97 profiles: each blender color separately and grading every 45 degrees
    python3 sweep.py extract colors   # -> data/sweep3.npz
    python3 sweep.py tools     # 10 frames, 118 profiles: Saturation, tonal sliders, grading brightness, Blending, Balance, Clarity
    python3 sweep.py extract tools    # -> data/sweep4.npz
    python3 sweep.py detail    # 4 frames, 29 profiles: Sharpening, Mid-range sharpening, Clarity, their pairs and order with the curve
                               # export TIFF at FULL size, then python3 detail.py collect detail
    python3 sweep.py colors-sa # 6 South Africa frames (sky, vest, bright warm colors, skin, water), 103 profiles: blender sets
                               # and colors as in training, strong +-100 of blue, cyan, orange, red, two finished profiles
    python3 sweep.py extract colors_sa   # -> data/sweep5.npz
    python3 sweep.py chart     # continuous-tone chart for shooting off the screen -> renders/sweep/chart/hue_chart.png
    python3 sweep.py chart-pack DSC_xxxx   # the same profile set on a chart shot -> renders/sweep/chart_colors

The first pack (10 frames, 120 profiles, full_v1) was deleted; its shrunk exports are in data/sweep.npz.
Of the second (full) only the NEUTRAL and R-* TIFFs remain, the probe TIFFs were deleted: they are
already in data/sweep2.npz, so re-running extract full is impossible.
"""
from __future__ import annotations

import base64
import glob
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageOps

import color as C
import devpairs
import pairs
import make_pack as MP
import np3
import strength

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "renders", "sweep")
LINE = 60
FRAMES_V1 = ("DSC_5118", "DSC_5966", "DSC_6008", "DSC_6203", "DSC_6299",
          "DSC_6456", "DSC_6522", "DSC_6663", "DSC_6969", "DSC_6981")
LEVELS = (20, 40, 60)
GRADE_HUES = (0, 90, 180, 270)
GRADE_CHROMA = (15, 40)
RANDOM = 50
SEED = 20261107
FRAMES = ("DSC_5966", "DSC_6203", "DSC_6522", "DSC_6663", "DSC_6981")
REAL = ("fit2", "fit4", "fuji160", "fuji160_r2", "m1b", "m3b", "nekit", "portra400", "portra400_r2",
        "skl", "test1", "test2_SKL_3027", "test2_SKL_3030", "test_nekit_autumn")
REALISTIC = 150
SEED2 = 20261108
PAIR = 40                 # level in pairs: single probes at this level are in data/sweep.npz
SHRINK = 4                # 1512 px export -> 378 px
DATA = {"full": os.path.join(HERE, "data", "sweep2.npz"), "colors": os.path.join(HERE, "data", "sweep3.npz"),
        "chart_colors": os.path.join(HERE, "data", "sweep_chart.npz"),
        "tools": os.path.join(HERE, "data", "sweep4.npz"), "colors_sa": os.path.join(HERE, "data", "sweep5.npz")}
TONE = ("contrast", "highlights", "shadows", "white", "black")   # incompatible with a curve in NP3
TOOL_LEVELS = (25, 50, 100)
TOOLS_RANDOM = 30
SEED4 = 20261110
COLOR_LEVEL = 40
GRADE_HUES3 = tuple(range(0, 360, 45))
GRADE_CHROMA3 = (15, 25, 40)
CHART = os.path.join(ROOT, "chart")
CHART_L = (0.42, 0.56, 0.70, 0.84)          # Oklab lightness of the bands
CHART_K = (0.3, 0.6, 1.0)                   # fraction of the screen's maximum chroma
# Frames for sharpening were chosen by focus sharpness on the half development, not by the texture of the 1512 px export:
# there DSC_6008 and DSC_5966 looked textured but were in fact the worst of 71 (soft focus, 1/60 s).
# Wall and sky, portrait with fabric at ISO 1250 (noise), small grass, branches against the sky (halos).
# South Africa frames for additional training of the profile model on sky and bright colors: chosen from previews
# of 1284 NEFs, not closer than +-40 to the 11 Lightroom-preset validation frames. Vest against the sky, orange wall,
# deep blue sky over an ochre wall, boats with water and sky, portrait, water.
SA_FRAMES = ("DSC_7203", "DSC_6975", "DSC_6455", "DSC_6474", "DSC_6296", "DSC_6593")
SA_DIR = os.path.join(HERE, "renders", "dev_sa")
STRONG = ("blue", "cyan", "orange", "red")
SA_REAL = ("lr_test_kc0.5_flat", "lr_test_p0.5_off")
DETAIL_FRAMES = ("DSC_6456", "DSC_6000", "DSC_5058", "DSC_5029")
ESCAPED_NL = b"&#xA;"
O_CURVE_MARK = 0x3E       # NX puts 2 into ExportData if there is a curve; in CustomData and in the NP3 file it is 0


def find_nef(stem: str) -> str:
    for folder in [os.path.join(HERE, "renders", name) for name in devpairs.SETS] + [CHART, os.path.join(HERE, "renders", "lr_test"), SA_DIR]:
        p = os.path.join(folder, stem + ".NEF")
        if os.path.exists(p):
            return p
    raise FileNotFoundError(stem)


def encode(data: bytes, newline: bytes) -> tuple[bytes, int]:
    """base64 in lines of 60 characters, as NX writes; size counts the newlines."""
    b = base64.b64encode(data)
    lines = [b[i:i + LINE] for i in range(0, len(b), LINE)]
    return newline.join(lines) + newline, len(b) + len(lines)


def as_custom(sidecar: bytes) -> bytes:
    """Brings a sidecar with a built-in profile to the form with a custom one: as NX writes it after assigning an NP3.

    A built-in profile has no Custom block, and PictureControl equals its number (40 for Flexible Color).
    """
    if b"&lt;CustomData&gt;" in sidecar:
        return sidecar
    block = b"&lt;Custom&gt;&lt;CustomData&gt;" + ESCAPED_NL + b"&lt;/CustomData&gt;&lt;CustomDataSize&gt;0&lt;/CustomDataSize&gt;&lt;/Custom&gt;"
    anchor = b"&lt;/AutoSaturation&gt;"
    assert sidecar.count(anchor) == 1
    sidecar = sidecar.replace(anchor, anchor + block)
    return re.sub(rb"(&lt;PictureControl&gt;)\d+(&lt;/PictureControl&gt;)", rb"\g<1>1\g<2>", sidecar, count=1)


def adl_as_shot(sidecar: bytes) -> bytes:
    """Active D-Lighting in NX as at capture time (value 1): how the development was trained, how the camera does it.

    With ADL off (0), NX brightens frames shot with ADL Normal by about 0.3 stop.
    """
    sidecar = re.sub(rb"(&lt;ApplyActiveDLightingFilter&gt;)\w+(&lt;)", rb"\g<1>true\g<2>", sidecar, count=1)
    return re.sub(rb"(&lt;ActiveDLightingFilter&gt;)\d+(&lt;)", rb"\g<1>1\g<2>", sidecar, count=1)


def embed(sidecar: bytes, data: bytes) -> bytes:
    """Replaces the profile in the sidecar. Everything else, including ADL and WB, stays as it was."""
    sidecar = as_custom(sidecar)
    export, custom = bytearray(data), bytearray(data)
    export[O_CURVE_MARK] = 2 if np3.deserialize(data).curve else 0
    custom[O_CURVE_MARK] = 0
    for tag, data in ((b"Export", bytes(export)), (b"Custom", bytes(custom))):
        pattern = rb"(&lt;%sData&gt;)(.*?)(&lt;/%sData&gt;&lt;%sDataSize&gt;)\d+(&lt;/%sDataSize&gt;)" % (tag, tag, tag, tag)
        m = re.search(pattern, sidecar, re.S)
        newline = ESCAPED_NL if ESCAPED_NL in m.group(2) else b"\n"
        text, size = encode(data, newline)
        sidecar = sidecar[:m.start()] + m.group(1) + text + m.group(3) + str(size).encode() + m.group(4) + sidecar[m.end():]
    return sidecar


def np3_of(sidecar: bytes) -> bytes:
    m = re.search(rb"&lt;ExportData&gt;(.*?)&lt;/ExportData&gt;", sidecar, re.S)
    return base64.b64decode(m.group(1).replace(ESCAPED_NL, b""))


def pack(folder: str, frames: list[str], profiles: list[tuple[str, bytes]]) -> str:
    """NEF copies and sidecars. A copy takes space only if the file system cannot reflink."""
    dest = os.path.join(ROOT, folder)
    side = os.path.join(dest, "NKSC_PARAM")
    os.makedirs(side, exist_ok=True)
    made = []
    for stem in frames:
        nef = find_nef(stem)
        template = open(os.path.join(os.path.dirname(nef), "NKSC_PARAM", stem + ".NEF.nksc"), "rb").read()
        for tag, data in profiles:
            name = f"{stem}-{tag}.NEF"
            subprocess.run(["cp", "--reflink=auto", nef, os.path.join(dest, name)], check=True)
            open(os.path.join(side, name + ".nksc"), "wb").write(embed(adl_as_shot(template), data))
            made.append({"file": name, "frame": stem, "profile": tag})
    json.dump(made, open(os.path.join(dest, "manifest.json"), "w"), ensure_ascii=False, indent=1)
    return dest


def pilot() -> list[tuple[str, bytes]]:
    def file(name: str) -> bytes:
        return open(strength.locate(name)[0], "rb").read()

    def control(tag: str, **kw) -> tuple[str, bytes]:
        return tag, np3.serialize(MP.neutral("NPF-" + tag, **kw))

    portra = np3_of(open(os.path.join(HERE, "renders/dev/NKSC_PARAM/DSC_4860.NEF.nksc"), "rb").read())
    return [control("NEUTRAL"),
            ("PORTRA", portra),
            ("FIT4", file("fit4")),
            control("BLUE-H40", blender={"blue": (-40, 0, 0)}),
            control("BLUE-H20", blender={"blue": (-20, 0, 0)}),
            control("MIX", blender={"blue": (-30, 20, 0), "cyan": (40, -20, 10), "red": (-20, 30, 0)},
                    grade={"shadows": (80, 15, 0)})]


def random_curve(rng: random.Random) -> np3.Curve:
    a, b = rng.uniform(-.08, .08), rng.uniform(.8, 1.25)
    return MP.curve_from(lambda x: x ** b - a * math.sin(2 * math.pi * x))


def random_control(tag: str, rng: random.Random) -> np3.Control:
    """All sliders at once, as in a real profile. Some stay at zero."""
    def value() -> int:
        return rng.randint(-60, 60) if rng.random() < .7 else 0
    return MP.neutral("NPF-" + tag,
                      blender={c: (value(), value(), value()) for c in np3.COLORS},
                      grade={z: (rng.randint(0, 359), rng.randint(0, 40), 0) for z in np3.ZONES},
                      curve=random_curve(rng) if rng.random() < .6 else None)


def full_v1() -> list[tuple[str, bytes]]:
    def control(tag: str, **kw) -> tuple[str, bytes]:
        return tag, np3.serialize(MP.neutral("NPF-" + tag, **kw))

    out = pilot()[:3]
    out.append(("FUJI", open(strength.locate("fuji160")[0], "rb").read()))
    for attr in MP.ATTR:
        for v in LEVELS:
            for sign, s in ((1, "P"), (-1, "M")):
                for label, colors in (("A", MP.SET_A), ("B", MP.SET_B)):
                    out.append(control(f"{attr[:2].upper()}{s}{v}{label}", blender=MP.blender(colors, attr, sign * v)))
    for zone in np3.ZONES:
        for hue in GRADE_HUES:
            for chroma in GRADE_CHROMA:
                out.append(control(f"G{np3.ZONE_TAG[zone]}{hue}-{chroma}", grade={zone: (hue, chroma, 0)}))
    curves = {"G80": lambda x: x ** .8, "G125": lambda x: x ** 1.25,
              "S5": lambda x: x - .05 * math.sin(2 * math.pi * x), "S10": lambda x: x - .1 * math.sin(2 * math.pi * x),
              "R5": lambda x: x + .05 * math.sin(2 * math.pi * x), "LIFT": lambda x: .06 + .94 * x}
    for tag, f in curves.items():
        out.append(control("C" + tag, curve=MP.curve_from(f)))
    rng = random.Random(SEED)
    for i in range(RANDOM):
        tag = f"RND{i:02d}"
        out.append((tag, np3.serialize(random_control(tag, rng))))
    return out


def export_path(folder: str, file: str) -> str:
    """Export of a copy in tif/ or in the folder itself. NX may append a suffix to the name, e.g. _portra400."""
    stem = file[:-4]
    found = []
    for d in (os.path.join(ROOT, folder, "tif"), os.path.join(ROOT, folder)):
        exact = glob.glob(os.path.join(d, stem + ".TIF")) + glob.glob(os.path.join(d, stem + ".tif"))
        found += exact or glob.glob(os.path.join(d, stem + "_*.TIF"))
    if len(found) != 1:
        raise FileNotFoundError(f"{stem}: found {len(found)}")
    return found[0]


def extract(folder: str = "full"):
    """Shrunk exports by frame: uint8, profiles in manifest order."""
    made = json.load(open(os.path.join(ROOT, folder, "manifest.json")))
    frames = list(dict.fromkeys(m["frame"] for m in made))
    profiles = list(dict.fromkeys(m["profile"] for m in made))
    out = {"frames": np.array(frames), "profiles": np.array(profiles)}
    for f in frames:
        stack = []
        for p in profiles:
            im = pairs.to_srgb(ImageOps.exif_transpose(Image.open(export_path(folder, f"{f}-{p}.NEF"))))
            stack.append(np.asarray(im.resize((im.size[0] // SHRINK, im.size[1] // SHRINK), Image.BOX)))
        out[f] = np.stack(stack)
        print(f, out[f].shape, flush=True)
    out["controls"] = np.array([sweep_control(folder, f"{frames[0]}-{p}.NEF").hex() for p in profiles])
    np.savez_compressed(DATA[folder], **out)


def sweep_control(folder: str, file: str) -> bytes:
    return np3_of(open(os.path.join(ROOT, folder, "NKSC_PARAM", file + ".nksc"), "rb").read())


def realistic_control(tag: str, rng: random.Random) -> np3.Control:
    """Like a real recipe: half of the sliders at zero, the rest mostly within +-30."""
    def value() -> int:
        return max(-60, min(60, round(rng.gauss(0, 20)))) if rng.random() < .5 else 0
    grade = {z: (rng.randint(0, 359), rng.randint(3, 30), 0) for z in np3.ZONES if rng.random() < .6}
    curve = None
    if rng.random() < .7:
        a, b = rng.uniform(-.06, .06), rng.uniform(.85, 1.15)
        curve = MP.curve_from(lambda x: x ** b - a * math.sin(2 * math.pi * x))
    return MP.neutral("NPF-" + tag, blender={c: (value(), value(), value()) for c in np3.COLORS},
                      grade=grade, curve=curve)


def real(name: str) -> bytes:
    """A finished profile without sharpening and clarity: the render does not compute them and they interfere with color models."""
    c = np3.deserialize(open(strength.locate(name)[0], "rb").read())
    c.sharpening = c.mid_sharpening = c.clarity = 0
    return np3.serialize(c)


def full() -> list[tuple[str, bytes]]:
    """Slider pairs at level PAIR to see how NX combines them, plus profiles for validation."""
    def control(tag: str, blender=None, grade=None, curve=None) -> tuple[str, bytes]:
        return tag, np3.serialize(MP.neutral("NPF-" + tag, blender=blender or {}, grade=grade or {}, curve=curve))

    def bl(*parts) -> dict:
        """parts: (set, attribute, sign). A color's values add up across attributes."""
        out = {}
        for colors, attr, sign in parts:
            for c in colors:
                v = list(out.get(c, (0, 0, 0)))
                v[MP.ATTR.index(attr)] = sign * PAIR
                out[c] = tuple(v)
        return out

    curves = {"S10": lambda x: x - .1 * math.sin(2 * math.pi * x), "G125": lambda x: x ** 1.25,
              "LIFT": lambda x: .06 + .94 * x}
    out = [control("NEUTRAL")] + [("R-" + n.upper()[:15], real(n)) for n in REAL]
    sets = (("A", MP.SET_A), ("B", MP.SET_B))
    for label, colors in sets:
        for (a1, s1), (a2, s2) in ((("hue", 1), ("chroma", 1)), (("hue", 1), ("chroma", -1)), (("hue", -1), ("chroma", 1)),
                                   (("hue", 1), ("brightness", 1)), (("hue", 1), ("brightness", -1)),
                                   (("chroma", 1), ("brightness", 1)), (("chroma", -1), ("brightness", 1))):
            tag = f"P{a1[:2].upper()}{'P' if s1 > 0 else 'M'}{a2[:2].upper()}{'P' if s2 > 0 else 'M'}{label}"
            out.append(control(tag, bl((colors, a1, s1), (colors, a2, s2))))
        for s in (1, -1):
            out.append(control(f"PALL{'P' if s > 0 else 'M'}{label}", bl(*((colors, a, s) for a in MP.ATTR))))
    for attr in MP.ATTR:
        for s in (1, -1):
            out.append(control(f"PAB{attr[:2].upper()}{'P' if s > 0 else 'M'}", bl((MP.SET_A, attr, s), (MP.SET_B, attr, s))))
    for tag, part, grade in (("PHUPA-GM90", (MP.SET_A, "hue", 1), {"midtone": (90, 40, 0)}),
                             ("PCHPB-GH0", (MP.SET_B, "chroma", 1), {"shadows": (0, 40, 0)}),
                             ("PBRPA-GS180", (MP.SET_A, "brightness", 1), {"highlights": (180, 40, 0)}),
                             ("PHUPB-GM270", (MP.SET_B, "hue", 1), {"midtone": (270, 15, 0)})):
        out.append(control(tag, bl(part), grade))
    for tag, part, curve in (("PHUPA-CS10", (MP.SET_A, "hue", 1), "S10"), ("PCHPB-CG125", (MP.SET_B, "chroma", 1), "G125"),
                             ("PCHMA-CLIFT", (MP.SET_A, "chroma", -1), "LIFT")):
        out.append(control(tag, bl(part), curve=MP.curve_from(curves[curve])))
    out.append(control("PGH0-GS180", grade={"shadows": (0, 40, 0), "highlights": (180, 40, 0)}))
    out.append(control("PGM90-GH270", grade={"midtone": (90, 40, 0), "shadows": (270, 40, 0)}))
    out.append(control("PG3-15", grade={"shadows": (0, 15, 0), "midtone": (90, 15, 0), "highlights": (180, 15, 0)}))
    out.append(control("PCS10-GM90", grade={"midtone": (90, 40, 0)}, curve=MP.curve_from(curves["S10"])))
    rng = random.Random(SEED2)
    for i in range(REALISTIC):
        tag = f"RND{i:03d}"
        out.append((tag, np3.serialize(realistic_control(tag, rng))))
    return out


def colors() -> list[tuple[str, bytes]]:
    """Each blender color separately and grading along 8 directions.

    In the first pack the sliders moved set A or B as a whole, so the boundary between the
    colors of a set was not measured. Grading there was only along 0/90/180/270 degrees:
    the double angle is invisible. Grading probes already shot in the first pack on these
    frames are not repeated.
    """
    def control(tag: str, blender=None, grade=None) -> tuple[str, bytes]:
        return tag, np3.serialize(MP.neutral("NPF-" + tag, blender=blender or {}, grade=grade or {}))

    out = [control("NEUTRAL")]
    for c in np3.COLORS:
        for attr in MP.ATTR:
            for sign in (1, -1):
                v = [0, 0, 0]
                v[MP.ATTR.index(attr)] = sign * COLOR_LEVEL
                out.append(control(f"C{c[:3].upper()}{attr[:2].upper()}{'P' if sign > 0 else 'M'}", {c: tuple(v)}))
    for zone, z in np3.ZONE_TAG.items():
        for hue in GRADE_HUES3:
            for chroma in GRADE_CHROMA3:
                if hue in GRADE_HUES and chroma in GRADE_CHROMA:
                    continue
                out.append(control(f"G{z}{hue}-{chroma}", grade={zone: (hue, chroma, 0)}))
    return out


def colors_sa() -> list[tuple[str, bytes]]:
    """Probes for additional blender training on sky and bright colors.

    Sets A/B at 20/40/60 (as data/sweep.npz) and single colors at 40 (as data/sweep3.npz):
    the model learns on new frames with the same functions. Strong +-100 values and finished
    profiles are not part of training, they are a check: the model learned up to +-60, and the
    fit runs into the sky at blue brightness -20..-50.
    """
    def control(tag: str, blender=None) -> tuple[str, bytes]:
        return tag, np3.serialize(MP.neutral("NPF-" + tag, blender=blender or {}))

    out = [control("NEUTRAL")]
    for attr in MP.ATTR:
        for v in LEVELS:
            for sign, s in ((1, "P"), (-1, "M")):
                for label, members in (("A", MP.SET_A), ("B", MP.SET_B)):
                    out.append(control(f"{attr[:2].upper()}{s}{v}{label}", MP.blender(members, attr, sign * v)))
    out += [p for p in colors() if p[0].startswith("C")]
    for c in STRONG:
        for attr in ("chroma", "brightness"):
            for sign in (1, -1):
                v = [0, 0, 0]
                v[MP.ATTR.index(attr)] = sign * 100
                out.append(control(f"S{c[:3].upper()}{attr[:2].upper()}{'P' if sign > 0 else 'M'}", {c: tuple(v)}))
    for i, name in enumerate(SA_REAL):
        out.append((f"R-{i}", open(strength.locate(name)[0], "rb").read()))
    return out


def chart(width=1920, height=1200) -> str:
    """Oklab hue varies continuously along the horizontal, bands of lightness and chroma along the vertical.

    The blender color boundary is visible to fractions of a degree: each pixel column is its own
    hue, not a patch of 15 degrees. A gray scale at the bottom.
    """
    margin, gap = 40, 8
    rows = [(L, k) for L in CHART_L for k in CHART_K]
    band = (height - 2 * margin) // (len(rows) + 1)
    img = np.full((height, width, 3), 0.18)
    xs = np.arange(width - 2 * margin)
    hues = 2 * math.pi * xs / len(xs) * 375 / 360           # slightly more than a full turn: the seam is visible on both sides
    for r, (L, k) in enumerate(rows):
        lin = np.stack([C.oklab_to_linear(np.array([L, c * math.cos(h), c * math.sin(h)]))
                        for h in hues for c in [MP.max_chroma(L, h) * k]])
        y = margin + r * band
        img[y:y + band - gap, margin:width - margin] = C.linear_to_srgb(np.clip(lin, 0, 1))[None]
    y = margin + len(rows) * band
    img[y:y + band - gap, margin:width - margin] = (xs / (len(xs) - 1))[None, :, None]
    os.makedirs(CHART, exist_ok=True)
    path = os.path.join(CHART, "hue_chart.png")
    Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(path)
    return path


def tools() -> list[tuple[str, bytes]]:
    """The remaining Flexible Color tools: singly, in pairs and in random recipes for validation."""
    def control(tag: str, **kw) -> tuple[str, bytes]:
        c = MP.neutral("NPF-" + tag, **{k: v for k, v in kw.items() if k != "clarity"})
        c.clarity = kw.get("clarity", 0)
        return tag, np3.serialize(c)

    def sign(v: int) -> str:
        return ("P" if v > 0 else "M") + str(abs(v))

    s10 = MP.curve_from(lambda x: x - .1 * math.sin(2 * math.pi * x))
    out = [control("NEUTRAL")]
    for name in TONE + ("saturation",):
        for level in TOOL_LEVELS:
            for v in (level, -level):
                out.append(control(f"{name[:3].upper()}{sign(v)}", **{name: v}))
    for zone, z in np3.ZONE_TAG.items():
        for v in (50, -50, 100, -100):
            out.append(control(f"GB{z}{sign(v)}", grade={zone: (0, 0, v)}))
        out.append(control(f"GB{z}P50-C25", grade={zone: (45, 25, 50)}))
    toned = {"shadows": (225, 40, 0), "midtone": (45, 40, 0), "highlights": (135, 40, 0)}
    for zone, z in np3.ZONE_TAG.items():
        for v in (0, 25, 75, 100):
            out.append(control(f"BLD{v}{z}", grade={zone: toned[zone]}, blending=v))
        for v in (-100, -50, 50, 100):
            out.append(control(f"BAL{sign(v)}{z}", grade={zone: toned[zone]}, balance=v))
    for v in (2, -2, 5, -5):
        out.append(control(f"CLA{sign(v)}", clarity=v))
    set_a = {c: (0, 40, 0) for c in MP.SET_A}
    set_b = {c: (0, 0, 40) for c in MP.SET_B}
    out += [control("X-CONP50-SATP50", contrast=50, saturation=50),
            control("X-SATP50-CHPA", saturation=50, blender=set_a),
            control("X-SATM50-GM45", saturation=-50, grade={"midtone": (45, 40, 0)}),
            control("X-CONP50-GM225", contrast=50, grade={"midtone": (225, 40, 0)}),
            control("X-HIGM50-SHAP50", highlights=-50, shadows=50),
            control("X-WHIM50-BLAP50", white=-50, black=50),
            control("X-SATP50-CS10", saturation=50, curve=s10),
            control("X-CONM50-BRPB", contrast=-50, blender=set_b)]
    rng = random.Random(SEED4)
    def v(scale=25, p=.5) -> int:
        return max(-100, min(100, round(rng.gauss(0, scale)))) if rng.random() < p else 0
    for i in range(TOOLS_RANDOM):
        kw = {"blender": {c: (v(20), v(20), v(20)) for c in np3.COLORS},
              "grade": {z: (rng.randint(0, 359), rng.randint(0, 30), v(25, .4)) for z in np3.ZONES if rng.random() < .6},
              "saturation": v(25, .6), "blending": rng.choice((50, 50, rng.randint(0, 100))), "balance": v(30, .3)}
        if i % 2:
            a, b = rng.uniform(-.06, .06), rng.uniform(.85, 1.15)
            kw["curve"] = MP.curve_from(lambda x, a=a, b=b: x ** b - a * math.sin(2 * math.pi * x))
        else:
            kw.update({name: v(30, .6) for name in TONE})
        out.append(control(f"RT{i:02d}", **kw))
    return out


def detail() -> list[tuple[str, bytes]]:
    """Detail tools singly, in pairs, at default values and on top of the curve and contrast.

    NEUTRAL-B repeats NEUTRAL: the difference of two exports gives NX noise at full size.
    Each probe's base is the pack profile with the same settings without detail (detail.collect).
    """
    def control(tag: str, sharpening=0, mid_sharpening=0, clarity=0, **kw) -> tuple[str, bytes]:
        c = MP.neutral("NPF-" + tag, **kw)
        c.sharpening, c.mid_sharpening, c.clarity = sharpening, mid_sharpening, clarity
        return tag, np3.serialize(c)

    def sign(v: int) -> str:
        return ("P" if v > 0 else "M") + str(abs(v))

    s10 = MP.curve_from(lambda x: x - .1 * math.sin(2 * math.pi * x))
    out = [control("NEUTRAL"), control("NEUTRAL-B")]
    out += [control(f"SHA{sign(v)}", sharpening=v) for v in (1, 3, 6, 9, -2, -3)]
    out += [control(f"MID{sign(v)}", mid_sharpening=v) for v in (1, 2, 5, -2, -5)]
    out += [control(f"CLA{sign(v)}", clarity=v) for v in (1, 2, 5, -2, -5)]
    out += [control("X-S3-M2", sharpening=3, mid_sharpening=2),
            control("X-S3-C2", sharpening=3, clarity=2),
            control("X-M2-C2", mid_sharpening=2, clarity=2),
            control("X-S3-M2-C2", sharpening=3, mid_sharpening=2, clarity=2),
            control("X-DEFAULT", sharpening=2, mid_sharpening=1, clarity=.5)]
    out += [control("CS10", curve=s10),
            control("X-CLA5-CS10", clarity=5, curve=s10),
            control("X-SHA6-CS10", sharpening=6, curve=s10),
            control("X-MID5-CS10", mid_sharpening=5, curve=s10),
            control("CONP50", contrast=50),
            control("X-CLA5-CONP50", clarity=5, contrast=50)]
    return out


def main():
    if sys.argv[1:] == ["pilot"]:
        print(pack("pilot", ["DSC_4860", "DSC_6203"], pilot()))
    elif sys.argv[1:] == ["full"]:
        print(pack("full", list(FRAMES), full()))
    elif sys.argv[1:] == ["colors"]:
        print(pack("colors", list(FRAMES_V1), colors()))
    elif sys.argv[1:] == ["tools"]:
        print(pack("tools", list(FRAMES_V1), tools()))
    elif sys.argv[1:] == ["colors-sa"]:
        print(pack("colors_sa", list(SA_FRAMES), colors_sa()))
    elif sys.argv[1:] == ["detail"]:
        print(pack("detail", list(DETAIL_FRAMES), detail()))
    elif sys.argv[1:] == ["chart"]:
        print(chart())
    elif sys.argv[1:2] == ["chart-pack"] and len(sys.argv) == 3:
        print(pack("chart_colors", [sys.argv[2]], colors()))
    elif sys.argv[1:2] == ["extract"]:
        extract(*sys.argv[2:3])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
