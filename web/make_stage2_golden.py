"""Level-1j fixtures (spec/web-tests.md): the stage-2 preparation regressions found on real pairs.

1. The embedded-JPEG choice (pairs.embedded_jpeg): a synthetic RAW-like blob with real small
   JPEGs and adversarial \\xff\\xd8\\xff runs (16-bit / lossless SOFs, a decompression-bomb
   frame, bad component counts, a broken DQT, unknown markers, padding, junk, truncation).
   PIL decides every candidate; web/lib/pair-prepare.js embeddedJpegCandidates() must agree
   candidate by candidate, and extractEmbeddedJpeg() must pick the same offset.
   Regression: RAW sensor data contains a "48382 x 15468 SOF15" run that the old marker parser
   accepted -> the widest candidate -> "The source image could not be decoded".
2. Real local RAWs (gitignored _local/, skipped when absent): the Python best offset per file.

Writes web/golden/stage2/embedded.bin + embedded.json. Python is the source of truth.

    python3 web/make_stage2_golden.py
"""
from __future__ import annotations

import io
import json
import os
import re
import struct
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "golden", "stage2")
sys.path.insert(0, ROOT)

# the real RAWs whose pairs failed or should keep working (skipped when absent)
REAL = ["_local/_cloud_transfer/r_lr_test_DSC_6550.NEF",   # the SOF15 false positive (the bug)
        "_local/_cloud_transfer/r_check_DSC_6132.NEF",      # the same failure mode
        "_local/test1/DSC_5584.NEF",
        "_local/test2/SKL_3024.dng",
        "_local/test2/SKL_3000.dng",
        "_local/test2/SKL_3024.NEF"]


def jpeg(w: int, h: int, seed: int) -> bytes:
    rng = np.random.default_rng(seed)
    a = (rng.random((h, w, 3)) * 255).astype(np.uint8)
    b = io.BytesIO()
    Image.fromarray(a).save(b, "JPEG", quality=70)
    return b.getvalue()


def seg(marker: int, payload: bytes) -> bytes:
    return struct.pack(">HH", marker, len(payload) + 2) + payload


def sof(marker: int, bits: int, w: int, h: int, layers: int) -> bytes:
    comps = b"".join(bytes([i + 1, 0x11, 0]) for i in range(max(layers, 0)))
    return seg(marker, bytes([bits]) + struct.pack(">HH", h, w) + bytes([layers]) + comps)


DQT_OK = seg(0xFFDB, bytes([0]) + bytes(range(1, 65)))
SOS = seg(0xFFDA, bytes([1, 1, 0, 0, 63, 0])) + b"\x12\x34\x56\xff\x00\x78" + b"\xff\xd9"
SOI = b"\xff\xd8"


def cases() -> list[tuple[str, bytes]]:
    return [
        ("real JPEG 160x120", jpeg(160, 120, 1)),
        ("real JPEG 320x240 (the expected best)", jpeg(320, 240, 2)),
        ("SOF15 16-bit huge frame (the sensor-data false positive)",
         SOI + sof(0xFFCF, 16, 48382, 15468, 2) + SOS),
        ("SOF0 8-bit 3 layers 30000x30000 (decompression bomb)",
         SOI + DQT_OK + sof(0xFFC0, 8, 30000, 30000, 3) + SOS),
        ("SOF3 16-bit lossless tile (a DNG tile)", SOI + sof(0xFFC3, 16, 256, 128, 2) + SOS),
        ("SOF0 8-bit 2 layers wide", SOI + sof(0xFFC0, 8, 5000, 10, 2) + SOS),
        ("broken DQT before a wide SOF", SOI + seg(0xFFDB, bytes([0]) + bytes(20))
         + sof(0xFFC0, 8, 6000, 10, 3) + SOS),
        ("unknown marker FF01 right after SOI", SOI + b"\xff\x01" + sof(0xFFC0, 8, 7000, 10, 3) + SOS),
        ("padding FFFF and junk bytes, 8-bit 1 layer 300x2 (opens)",
         SOI + b"\xff\xff" + sof(0xFFC0, 8, 300, 2, 1) + b"\x00\x11" + SOS),
        ("SOS before any SOF (no mode: 'not identified')", SOI + DQT_OK + SOS),
        ("SOF0 8-bit 3 layers 8000x0 (zero height: 'not identified')",
         SOI + sof(0xFFC0, 8, 8000, 0, 3) + SOS),
        ("SOF0 8-bit 3 layers wide, then EOF-truncated DQT",
         SOI + sof(0xFFC0, 8, 9000, 10, 3) + struct.pack(">HH", 0xFFDB, 300) + b"\x00" * 10),
    ]


def pil_decision(b: bytes, off: int):
    try:
        im = Image.open(io.BytesIO(b[off:]))
        return list(im.size)
    except Exception:
        return None


def python_best(b: bytes):
    best = None
    for m in re.finditer(b"\xff\xd8\xff", b):
        size = pil_decision(b, m.start())
        if size is None:
            continue
        if best is None or size[0] > best[1][0]:
            best = (m.start(), size)
    return best


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(0)
    blob, placed = bytearray(), []
    # the truncated case must be last (its DQT runs past the end of the blob)
    for name, data in cases():
        blob += bytes(rng.integers(0, 256, 257, dtype=np.uint8))   # filler between candidates
        placed.append({"case": name, "offset": len(blob)})
        blob += data
    blob = bytes(blob)
    cands = [{"offset": m.start(), "size": pil_decision(blob, m.start())}
             for m in re.finditer(b"\xff\xd8\xff", blob)]
    best = python_best(blob)
    open(os.path.join(OUT, "embedded.bin"), "wb").write(blob)

    real = []
    for rel in REAL:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print(f"skip (absent): {rel}")
            continue
        b = open(path, "rb").read()
        off, size = python_best(b)
        real.append({"path": rel, "bytes": len(b), "offset": off, "size": size})
        print(f"{rel}: best {size[0]}x{size[1]} at {off}")

    meta = {"schemaVersion": 1, "kind": "embeddedJpeg", "file": "embedded.bin",
            "generator": "web/make_stage2_golden.py", "placed": placed,
            "candidates": cands, "best": {"offset": best[0], "size": best[1]}, "real": real}
    json.dump(meta, open(os.path.join(OUT, "embedded.json"), "w"), indent=1)

    # self-checks: the expected decisions of the hand-made cases
    by_off = {c["offset"]: c["size"] for c in cands}
    want = {0: [160, 120], 1: [320, 240], 2: None, 3: None, 4: None, 5: None, 6: None, 7: None,
            8: [300, 2], 9: None, 10: None, 11: None}
    for i, p in enumerate(placed):
        got = by_off.get(p["offset"], "missing")
        assert got == want[i], f"case {i} {p['case']}: PIL says {got}, expected {want[i]}"
    assert best[0] == placed[1]["offset"], "the 320x240 JPEG must be the best candidate"
    print(f"{len(cands)} candidates ({sum(c['size'] is not None for c in cands)} open), "
          f"best at {best[0]}, {len(blob)} bytes, {len(real)} real RAWs")


if __name__ == "__main__":
    main()
