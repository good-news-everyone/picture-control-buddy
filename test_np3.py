"""Bit-exact check of np3.py against samples saved by the official Nikon program.

Run: python3 test_np3.py
"""
import glob
import os
import sys

import np3

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = sorted(glob.glob(os.path.join(HERE, "third_party/samples/*.NP3")))


def diff(a: bytes, b: bytes) -> str:
    if len(a) != len(b):
        return f"length {len(a)} != {len(b)}"
    bad = [i for i in range(len(a)) if a[i] != b[i]]
    return f"{len(bad)} bytes differ, first: " + ", ".join(
        f"0x{i:x}: {a[i]:02x}!={b[i]:02x}" for i in bad[:6])


def main() -> int:
    if not SAMPLES:
        print("no samples")
        return 1
    fails = 0
    for path in SAMPLES:
        src = open(path, "rb").read()
        again = np3.serialize(np3.deserialize(src))
        ok = again == src
        fails += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {os.path.basename(path):32} {len(src):5}"
              + ("" if ok else "  " + diff(again, src)))
    print(f"\n{len(SAMPLES) - fails}/{len(SAMPLES)} matched byte for byte")

    # spline points -> table reproduces the sample tables bit for bit
    spline_fails = 0
    for path in SAMPLES:
        c = np3.deserialize(open(path, "rb").read())
        if not c.curve:
            continue
        ok = np3.curve_table(c.curve.points).raw == c.curve.raw
        spline_fails += not ok
        print(f"{'ok  ' if ok else 'FAIL'} spline {os.path.basename(path):32}")
    print(f"spline: {spline_fails} failures")
    fails += spline_fails
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
