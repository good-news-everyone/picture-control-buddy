"""Structural tests for sweep.py (sidecar writing, extract) and pick_frame.coverage.

All fixtures are synthetic: a minimal NX-style .nksc template, a fake export folder.
The pack generators that need fitted profiles from out/ (full, colors_sa) are not
called here; colors(), tools() and detail() are self-contained.

Run: python3 test_sweep.py
"""
import base64
import contextlib
import io
import json
import os
import re
import sys
import tempfile

import numpy as np
from PIL import Image

import color as C
import make_pack as MP
import np3
import sweep

FAILS = 0


def check(cond, label):
    global FAILS
    if not cond:
        FAILS += 1
        print(f"FAIL {label}")


def test_pack_sets_contain_neutral():
    for gen in (sweep.colors, sweep.tools, sweep.detail):
        names = [tag for tag, _ in gen()]
        check("NEUTRAL" in names, f"{gen.__name__} contains NEUTRAL")
        check(len(set(names)) == len(names), f"{gen.__name__} profile tags are unique")
        for tag, data in gen():
            check(np3.serialize(np3.deserialize(data)) == data, f"{gen.__name__}:{tag} round-trips")


TEMPLATE = (b'<nksc>&lt;PictureControl&gt;40&lt;/PictureControl&gt;'
            b'&lt;/AutoSaturation&gt;'
            b'&lt;ExportData&gt;QUJD&lt;/ExportData&gt;&lt;ExportDataSize&gt;3&lt;/ExportDataSize&gt;'
            b'</nksc>')


def test_sidecar():
    ctrl = MP.neutral("NPF-TEST", blender={"red": (30, 0, 0)})
    data = np3.serialize(ctrl)
    side = sweep.embed(TEMPLATE, data)

    m = re.search(rb"&lt;PictureControl&gt;(\d+)&lt;/PictureControl&gt;", side)
    check(m and m.group(1) == b"1", "PictureControl = 1 after embedding")
    check(sweep.np3_of(side) == data, "the embedded profile reads back byte-exact")
    check(b"&lt;Custom&gt;&lt;CustomData&gt;" in side and b"&lt;/CustomData&gt;&lt;CustomDataSize&gt;" in side,
          "the Custom block was added")

    # ExportDataSize counts the base64 characters and the newlines, as NX writes it
    m = re.search(rb"&lt;ExportData&gt;(.*?)&lt;/ExportData&gt;&lt;ExportDataSize&gt;(\d+)&lt;/ExportDataSize&gt;", side, re.S)
    body, size = m.group(1), int(m.group(2))
    b64 = base64.b64encode(data)
    raw = body.replace(sweep.ESCAPED_NL, b"").replace(b"\n", b"")
    nl = body.count(b"\n") + body.count(sweep.ESCAPED_NL)
    check(raw == b64, "ExportData is the base64 of the NP3")
    check(size == len(b64) + nl, "ExportDataSize counts the newlines")
    # with a \n sidecar the same, without escaping
    plain = side.replace(sweep.ESCAPED_NL, b"\n")
    check(sweep.np3_of(plain) == data, "unescaped-newline sidecar reads back too")

    # already-custom sidecar is not re-wrapped
    again = sweep.as_custom(side)
    check(again == side, "as_custom is idempotent on a custom sidecar")


def test_extract():
    with tempfile.TemporaryDirectory() as tmp:
        sweep.ROOT = os.path.join(tmp, "renders", "sweep")
        sweep.DATA = {"full": os.path.join(tmp, "out.npz")}
        folder = os.path.join(sweep.ROOT, "full")
        os.makedirs(os.path.join(folder, "tif"))
        os.makedirs(os.path.join(folder, "NKSC_PARAM"))
        profiles = [("NEUTRAL", MP.neutral("NPF-NEUTRAL")),
                    ("REDP40", MP.neutral("NPF-REDP40", blender={"red": (40, 0, 0)}))]
        made = []
        for p, ctrl in profiles:
            Image.new("RGB", (64, 40), (250, 10, 10) if p != "NEUTRAL" else (120, 120, 120)).save(
                os.path.join(folder, "tif", f"DSC_FAKE-{p}.TIF"))
            open(os.path.join(folder, "NKSC_PARAM", f"DSC_FAKE-{p}.NEF.nksc"), "wb").write(
                sweep.embed(TEMPLATE, np3.serialize(ctrl)))
            made.append({"file": f"DSC_FAKE-{p}.NEF", "frame": "DSC_FAKE", "profile": p})
        json.dump(made, open(os.path.join(folder, "manifest.json"), "w"))

        sweep.extract("full")
        z = np.load(sweep.DATA["full"])
        check(list(z["frames"]) == ["DSC_FAKE"], "extract: frames")
        check(list(z["profiles"]) == ["NEUTRAL", "REDP40"], "extract: profiles")
        check(z["DSC_FAKE"].shape == (2, 40 // sweep.SHRINK, 64 // sweep.SHRINK, 3),
              f"extract: shrunk stack shape {z['DSC_FAKE'].shape}")
        controls = [np3.deserialize(bytes.fromhex(h)) for h in z["controls"]]
        check([c.name for c in controls] == ["NPF-NEUTRAL", "NPF-REDP40"], "extract: controls round-trip")


def test_pick_frame():
    with contextlib.redirect_stdout(io.StringIO()):
        import pick_frame
    # a hue wheel covers many hue x lightness cells; grey keeps nothing
    yy, xx = np.mgrid[0:240, 0:360]
    h = np.arctan2(yy - 120, xx - 180)
    r = np.hypot((yy - 120) / 120, (xx - 180) / 180)
    wheel = C.linear_to_srgb(C.oklab_to_linear(np.stack([(0.3 + 0.5 * np.clip(1 - r, 0, 1)).ravel(),
                                                         (0.15 * np.cos(h) * np.clip(r, 0, 1)).ravel(),
                                                         (0.15 * np.sin(h) * np.clip(r, 0, 1)).ravel()], 1)))
    wheel = (np.clip(wheel, 0, 1).reshape(240, 360, 3) * 255).astype(np.uint8)
    grey = np.full((240, 360, 3), 128, np.uint8)
    cw = pick_frame.coverage(Image.fromarray(wheel))
    cg = pick_frame.coverage(Image.fromarray(grey))
    check(cg == (0, 0, 0.0), f"grey image has zero coverage, got {cg}")
    check(cw[0] > 24 and cw[1] > 8, f"the hue wheel covers the cells broadly, got {cw}")


def main():
    for name, fn in sorted({k: v for k, v in globals().items() if k.startswith("test_")}.items()):
        fn()
        print(f"ok   {name}")
    print(f"\n{'ALL PASSED' if FAILS == 0 else f'{FAILS} FAILURES'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
