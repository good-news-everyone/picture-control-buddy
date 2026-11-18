"""Linear development of NEF and DNG via dcraw_emu: camera-color image after white balance.

No camera or NX Studio needed: only the sensor data and the WB coefficients from the file.

    python3 rawdev.py file.NEF|file.DNG
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def read_ppm16(path: str) -> np.ndarray:
    with open(path, "rb") as f:
        assert f.readline().strip() == b"P6"
        line = f.readline()
        while line.startswith(b"#"):
            line = f.readline()
        w, h = map(int, line.split())
        assert int(f.readline()) == 65535
        data = np.frombuffer(f.read(), dtype=">u2")
    return data.reshape(h, w, 3).astype(np.float32) / 65535


def develop(raw: str) -> np.ndarray:
    """Camera linear RGB, 0..1, half size, not rotated."""
    with tempfile.TemporaryDirectory() as d:
        link = os.path.join(d, "a" + os.path.splitext(raw)[1])
        os.symlink(os.path.abspath(raw), link)
        r = subprocess.run(["dcraw_emu", "-w", "-o", "0", "-4", "-h", "-t", "0", link],
                           capture_output=True, text=True)
        if r.returncode:
            sys.exit(f"{os.path.basename(raw)}: file unreadable ({(r.stdout + r.stderr).strip().split(': ')[-1]}). "
                     "If this is a NEF High Efficiency, convert it to DNG without JPEG XL.")
        return read_ppm16(link + ".ppm")


if __name__ == "__main__":
    a = develop(sys.argv[1])
    print(a.shape, a.min(), a.max(), a.reshape(-1, 3).mean(0))
