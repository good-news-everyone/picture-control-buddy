"""Tests for pairs.py: XMP parsing, tilted-crop math, alignment — all on synthetic fixtures.

No real NEF/JPEG decodes: the XMP block is written through PIL into an in-memory JPEG,
the crop math is checked against a hand-computed example, the alignment target is a
known warp of the source. Runs in a fresh clone.

Run: python3 test_pairs.py
"""
import io

import numpy as np
from PIL import Image, ImageFilter

import pairs

FAILS = 0


def check(cond, label):
    global FAILS
    if not cond:
        FAILS += 1
        print(f"FAIL {label}")


XMP = """<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF>
  <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    crs:WhiteBalance="Custom" crs:Temperature="6250" crs:Tint="+7"
    crs:Exposure2012="-0.35" crs:HasCrop="True"
    crs:CropLeft="0.125" crs:CropTop="0.0625" crs:CropRight="0.875" crs:CropBottom="0.9375"
    crs:CropAngle="3.50" tiff:Orientation="1"/>
 </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"""


def jpeg_with_xmp(xmp: bytes | None) -> Image.Image:
    im = Image.new("RGB", (64, 48), (10, 120, 30))
    buf = io.BytesIO()
    kw = {"xmp": xmp} if xmp is not None else {}
    im.save(buf, "JPEG", **kw)
    buf.seek(0)
    return Image.open(buf)


def test_xmp_values():
    im = jpeg_with_xmp(XMP.encode())
    x = pairs.xmp_values(im)
    for key, want in (("WhiteBalance", "Custom"), ("Temperature", "6250"), ("Tint", "+7"),
                      ("Exposure2012", "-0.35"), ("CropLeft", "0.125"), ("CropTop", "0.0625"),
                      ("CropRight", "0.875"), ("CropBottom", "0.9375"), ("CropAngle", "3.50"),
                      ("HasCrop", "True"), ("Orientation", "1")):
        check(x.get(key) == want, f"xmp {key}: {x.get(key)!r} != {want!r}")
    check(x["_masks"] is False, "no mask group in the crafted block")

    plain = jpeg_with_xmp(None)
    x = pairs.xmp_values(plain)
    check(x == {"_masks": False}, f"absent XMP gives the empty result, got {x}")


def test_apply_crop():
    W, H = 400, 200
    rng = np.random.default_rng(11)
    im = Image.fromarray((rng.random((H, W, 3)) * 255).astype(np.uint8))
    l, t, r, b = 0.25, 0.25, 0.75, 0.75
    ang = 10.0
    out = pairs.apply_crop(im, {"HasCrop": "True", "CropLeft": str(l), "CropTop": str(t),
                                "CropRight": str(r), "CropBottom": str(b),
                                "CropAngle": str(ang)})

    # hand-computed: diagonal corners of the rotated frame (spec/np3-format.md)
    cx, cy = (l + r) / 2 * W, (t + b) / 2 * H
    a = np.radians(ang)
    dx, dy = (r - l) * W, (b - t) * H
    w = abs(dx * np.cos(a) + dy * np.sin(a))
    h = abs(dy * np.cos(a) - dx * np.sin(a))
    want_size = (int(cx + w / 2) - int(cx - w / 2), int(cy + h / 2) - int(cy - h / 2))
    check(out.size == want_size, f"tilted crop size {out.size} != hand-computed {want_size}")

    manual = im.rotate(ang, resample=Image.BICUBIC, center=(cx, cy))
    manual = manual.crop((int(cx - w / 2), int(cy - h / 2), int(cx + w / 2), int(cy + h / 2)))
    check(np.array_equal(np.asarray(out), np.asarray(manual)), "tilted crop matches the manual sequence")

    # untilted: the crop box is the XMP rectangle itself
    out = pairs.apply_crop(im, {"HasCrop": "True", "CropLeft": str(l), "CropTop": str(t),
                                "CropRight": str(r), "CropBottom": str(b), "CropAngle": "0"})
    check(out.size == (int((r - l) * W), int((b - t) * H)), "untilted crop size")
    check(np.array_equal(np.asarray(out), np.asarray(im)[int(t * H):int(b * H), int(l * W):int(r * W)]),
          "untilted crop content")
    same = pairs.apply_crop(im, {})
    check(same.size == im.size and np.array_equal(np.asarray(same), np.asarray(im)),
          "no crop -> unchanged")


def test_align():
    rng = np.random.default_rng(12)
    size = (384, 256)
    noise = Image.fromarray((rng.random(size) * 255).astype(np.uint8))
    # scale must be observable: blurred noise is nearly scale-invariant, so add
    # structured content (blocks and a gradient ramp) at distinct scales
    yy, xx = np.mgrid[0:size[1], 0:size[0]]
    texture = np.asarray(noise.filter(ImageFilter.GaussianBlur(1.5)), dtype=float) / 255
    texture += (0.5 * ((xx // 48 + yy // 32) % 2) + 0.2 * xx / size[0]).T
    src = Image.fromarray((np.clip(np.stack([texture] * 3, -1), 0, 1) * 255).astype(np.uint8))

    s_true, dx_true, dy_true = 1.01, 3.0, -2.0
    dst = pairs.warp(src, size, s_true, dx_true, dy_true)
    _, s, dx, dy = pairs.align(src.resize((size[0] // 2, size[1] // 2), Image.BILINEAR),
                               dst.resize((size[0] // 2, size[1] // 2), Image.BILINEAR))
    # 0.005: the synthetic dst is itself a bilinear warp, the correlation peak is biased
    # by about one resample; dx/dy are exact to a pixel
    check(abs(s - s_true) <= 0.005, f"align scale {s:.4f} != {s_true}")
    check(abs(dx * 2 - dx_true) <= 1.0, f"align dx {dx * 2:+.2f} != {dx_true:+.2f}")
    check(abs(dy * 2 - dy_true) <= 1.0, f"align dy {dy * 2:+.2f} != {dy_true:+.2f}")


def main():
    for name, fn in sorted({k: v for k, v in globals().items() if k.startswith("test_")}.items()):
        fn()
        print(f"ok   {name}")
    print(f"\n{'ALL PASSED' if FAILS == 0 else f'{FAILS} FAILURES'}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
