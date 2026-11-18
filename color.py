"""Color conversions and metrics. numpy only."""
from __future__ import annotations

import numpy as np

M_RGB2XYZ = np.array([[0.4124564, 0.3575761, 0.1804375],
                      [0.2126729, 0.7151522, 0.0721750],
                      [0.0193339, 0.1191920, 0.9503041]])
D65 = np.array([0.95047, 1.0, 1.08883])

M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
               [0.2119034982, 0.6806995451, 0.1073969566],
               [0.0883024619, 0.2817188376, 0.6299787005]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
               [1.9779984951, -2.4285922050, 0.4505937099],
               [0.0259040371, 0.7827717662, -0.8086757660]])
M1I = np.linalg.inv(M1)
M2I = np.linalg.inv(M2)


def srgb_to_linear(v):
    v = np.asarray(v, dtype=np.float64)
    return np.where(v <= 0.04045, v / 12.92, ((np.maximum(v, 0) + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    v = np.asarray(v, dtype=np.float64)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.maximum(v, 1e-12) ** (1 / 2.4) - 0.055)


def linear_to_oklab(rgb):
    lms = np.cbrt(rgb @ M1.T)
    return lms @ M2.T


def oklab_to_linear(lab):
    return ((lab @ M2I.T) ** 3) @ M1I.T


def srgb_to_lab(rgb):
    """sRGB 0..1 -> CIELAB D65."""
    xyz = srgb_to_linear(rgb) @ M_RGB2XYZ.T / D65
    f = np.where(xyz > 216 / 24389, np.cbrt(np.maximum(xyz, 1e-12)), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def lab_to_srgb(lab):
    """CIELAB D65 -> sRGB, without clipping."""
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], axis=-1)
    xyz = np.where(f > 6 / 29, f ** 3, (116 * f - 16) * 27 / 24389) * D65
    return linear_to_srgb(xyz @ np.linalg.inv(M_RGB2XYZ).T)


def de2000(lab1, lab2):
    """CIEDE2000 after Sharma et al. (2005)."""
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cm7 = ((C1 + C2) / 2) ** 7
    G = 0.5 * (1 - np.sqrt(Cm7 / (Cm7 + 25.0 ** 7)))
    a1p = (1 + G) * a1
    a2p = (1 + G) * a2
    C1p = np.hypot(a1p, b1)
    C2p = np.hypot(a2p, b2)
    h1 = np.degrees(np.arctan2(b1, a1p)) % 360
    h2 = np.degrees(np.arctan2(b2, a2p)) % 360
    dL = L2 - L1
    dC = C2p - C1p
    zero = (C1p * C2p) == 0
    dh = h2 - h1
    dh = np.where(dh > 180, dh - 360, dh)
    dh = np.where(dh < -180, dh + 360, dh)
    dh = np.where(zero, 0, dh)
    dH = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh) / 2)
    Lm = (L1 + L2) / 2
    Cm = (C1p + C2p) / 2
    s = h1 + h2
    hm = np.where(np.abs(h1 - h2) <= 180, s / 2, np.where(s < 360, (s + 360) / 2, (s - 360) / 2))
    hm = np.where(zero, s, hm)
    T = (1 - 0.17 * np.cos(np.radians(hm - 30)) + 0.24 * np.cos(np.radians(2 * hm))
         + 0.32 * np.cos(np.radians(3 * hm + 6)) - 0.20 * np.cos(np.radians(4 * hm - 63)))
    dTh = 30 * np.exp(-(((hm - 275) / 25) ** 2))
    Cm7 = Cm ** 7
    Rc = 2 * np.sqrt(Cm7 / (Cm7 + 25.0 ** 7))
    Sl = 1 + 0.015 * (Lm - 50) ** 2 / np.sqrt(20 + (Lm - 50) ** 2)
    Sc = 1 + 0.045 * Cm
    Sh = 1 + 0.015 * Cm * T
    Rt = -np.sin(np.radians(2 * dTh)) * Rc
    return np.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2
                   + Rt * (dC / Sc) * (dH / Sh))


def de2000_weights(lab, kc: float = 1.0, flat_l: bool = False):
    """Matrices W (n, 3, 3): |W.(lab_predicted - lab)| ~ dE2000 for a small difference.

    The weights are computed at the target color lab, so the residual is smooth and
    suits least-squares fitting: lightness, chroma and hue components with their own
    SL, SC, SH denominators and the RT rotation for blues. kc < 1 is stricter on chroma;
    flat_l: no SL on lightness, equally strict in shadows, midtones and highlights as in dE76.
    """
    lab = np.asarray(lab, dtype=np.float64)
    L, a, b = lab[:, 0], lab[:, 1], lab[:, 2]
    C0 = np.hypot(a, b)
    G = 0.5 * (1 - np.sqrt(C0 ** 7 / (C0 ** 7 + 25.0 ** 7)))
    ap = (1 + G) * a
    Cp = np.hypot(ap, b)
    h = np.degrees(np.arctan2(b, ap)) % 360
    T = (1 - 0.17 * np.cos(np.radians(h - 30)) + 0.24 * np.cos(np.radians(2 * h))
         + 0.32 * np.cos(np.radians(3 * h + 6)) - 0.20 * np.cos(np.radians(4 * h - 63)))
    Sl = 1 + 0.015 * (L - 50) ** 2 / np.sqrt(20 + (L - 50) ** 2)
    Sc = kc * (1 + 0.045 * Cp)
    Sh = 1 + 0.015 * Cp * T
    Rt = -np.sin(np.radians(60 * np.exp(-(((h - 275) / 25) ** 2)))) * 2 * np.sqrt(Cp ** 7 / (Cp ** 7 + 25.0 ** 7))
    grey = Cp < 1e-3
    u = np.where(grey[:, None], [1.0, 0.0], np.stack([ap, b], 1) / np.where(grey, 1, Cp)[:, None])
    radial = np.stack([u[:, 0] * (1 + G), u[:, 1]], 1) / Sc[:, None]     # (Da, Db) -> dC'/SC
    tang = np.stack([-u[:, 1] * (1 + G), u[:, 0]], 1) / Sh[:, None]      # -> dH'/SH
    W = np.zeros((len(L), 3, 3))
    W[:, 0, 0] = 1 if flat_l else 1 / Sl
    W[:, 1, 1:] = radial + (Rt / 2)[:, None] * tang                       # the square of the sum yields the RT.dC.dH term
    W[:, 2, 1:] = np.sqrt(np.maximum(1 - Rt ** 2 / 4, 0))[:, None] * tang
    return W


def weighted(W, d):
    """W.d for each pixel."""
    return np.einsum("nij,nj->ni", W, d)
