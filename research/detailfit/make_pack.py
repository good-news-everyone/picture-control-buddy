"""Builds renders/sweep/detailcheck: 4 SA frames x NEW4 with Sharpening 0/2/4/6 (+ a repeat of 2 for export noise)
and NEW4 with the detail found at x4 (Clarity 0.25, Mid-range 0.5). Export: full-size 8-bit TIFF."""
import os, re, sys, json, subprocess, dataclasses
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))
sys.path.insert(0, ROOT)
import sweep, np3
FRAMES = ["DSC_6015", "DSC_6423", "DSC_6973", "DSC_7026"]
SRC = os.path.join(ROOT, "renders", "sa")
base = np3.deserialize(open(os.path.join(ROOT, "_local/research/fitcheck/NEW4.NP3"), "rb").read())


def variant(tag, **kw):
    return tag, np3.serialize(dataclasses.replace(base, name="NPF-" + tag, **kw))


PACK = sys.argv[1] if len(sys.argv) > 1 else "detailcheck"
if PACK == "detailcheck":
    profiles = [variant("S0", sharpening=0), variant("S2", sharpening=2), variant("S2B", sharpening=2),
                variant("S4", sharpening=4), variant("S6", sharpening=6),
                variant("DET", sharpening=2, clarity=0.25, mid_sharpening=0.5)]
else:   # detailcheck2: the detail fitted to the LR variants (renders/sa/<VAR>)
    profiles = [variant("FCLA50", sharpening=2, clarity=1.0, mid_sharpening=1.5),
                variant("FCLAM40", sharpening=2, clarity=-2.75, mid_sharpening=0.25),
                variant("FTEX50", sharpening=2, clarity=-0.25, mid_sharpening=2.0),
                variant("FSHA100", sharpening=7, clarity=0, mid_sharpening=1.0)]
for _, d in profiles:
    np3.deserialize(d)


def no_brightness(sidecar: bytes) -> bytes:
    out, n = re.subn(rb'(nikon::Brightness"&gt;&lt;active&gt;)true(&lt;/active&gt;&lt;parameters&gt;&lt;brightness&gt;)[-0-9.e]+',
                     rb"\g<1>false\g<2>0", sidecar, count=1)
    assert n == 1 or b'nikon::Brightness"&gt;&lt;active&gt;false' in sidecar
    return out


dest = os.path.join(sweep.ROOT, PACK); side = os.path.join(dest, "NKSC_PARAM"); os.makedirs(side, exist_ok=True)
made = []
for stem in FRAMES:
    nef = os.path.join(SRC, stem + ".NEF")
    template = open(os.path.join(SRC, "NKSC_PARAM", stem + ".NEF.nksc"), "rb").read()
    for tag, data in profiles:
        name = f"{stem}-{tag}.NEF"
        if not os.path.exists(os.path.join(dest, name)):
            subprocess.run(["cp", nef, os.path.join(dest, name)], check=True)
        open(os.path.join(side, name + ".nksc"), "wb").write(sweep.embed(sweep.adl_as_shot(no_brightness(template)), data))
        made.append({"file": name, "frame": stem, "profile": tag})
json.dump(made, open(os.path.join(dest, "manifest.json"), "w"), ensure_ascii=False, indent=1)
print(dest, len(made))
