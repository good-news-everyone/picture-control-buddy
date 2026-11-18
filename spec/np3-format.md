# The NP3 format and the files around it

Implementation: `np3.py`. The layout is taken from ssssota/nikon-flexible-color-picture-control (MIT, commit ed0397f). Verification: `test_np3.py`, reading and writing back matched byte for byte on 13 of 13 `third_party/samples` samples.

## Sizes

- Without a curve: 392 bytes (0x188).
- With a curve: 978 bytes (the base plus a 586-byte block).

## Offsets

| Field | Offset |
|---|---|
| Name (up to 19 ASCII) | 0x18 |
| Sharpening | 0x52 |
| Clarity | 0x5C |
| Mid-range sharpening | 0xF2 |
| Contrast | 0x110 |
| Highlights | 0x11A |
| Shadows | 0x124 |
| White | 0x12E |
| Black | 0x138 |
| Saturation | 0x142 |
| Color Blender, 8 colors | 0x14C |
| Grading: highlights, midtones, shadows | 0x170, 0x174, 0x178 |
| Blending | 0x180 |
| Balance | 0x182 |
| Flags | 0x185, 0x186 |
| Curve flag | 0x187 |
| Curve points | 0x194 |
| Curve table | 0x1CC |

## Value encoding

- A regular value: `0x80 + v`.
- Sharpening, mid-range sharpening, clarity: `0x80 + v*4`.
- The zone grading hue takes 2 bytes.
- Defaults: Blending 50, Balance 0.
- Blender colors in order: red, orange, yellow, green, cyan, blue, purple, magenta.
- Zones: highlights, midtone, shadows.

## Curve

- A table of 257 values 0..32767 and up to 20 points.
- Identity table: `i*128` for `i <= 128`, otherwise `i*128-1`, the last value 32767.
- The curve and the contrast, highlights, shadows, white, black sliders are mutually exclusive: with a curve the sliders are `0x01`. Saturation works in that case.
- The camera and NX Studio recompute the curve from the points, so the table and the points must describe one curve. `make_pack.curve_from` builds both from one function, the points sit at `round(i*255/19)`.
- **The points -> table algorithm confirmed on official samples (2026-11-16):** a natural cubic spline (second derivatives zero at the ends) through the points with a 0..255 clamp; `raw[i] = round(spline(i*255/256) * 32767/255)`. Reproduces the tables of all 5 samples with curves bit-exactly, including the stepped black/white. Linear interpolation diverges by up to 119 levels out of 32767, monotone cubic (PCHIP) is worse than the spline. An imported profile without edits is not recomputed: the stored table and points are returned as is (byte-exact round-trip), the spline is needed for editing and strength. Implementation: `np3.curve_table` (verification in `test_np3.py`), the browser port `web/lib/curve.js` (level 4 in `spec/web-tests.md`). Project profiles from `out/` have points that are 20 even `curve_from` samples, the spline over them does not recover steep tables (up to ~2.6%): the editor keeps such a table as is until the user edits the points.

## SD card

`NIKON/CUSTOMPC/PICCONxx.NP3` in the card root. On the camera: shooting menu -> Manage Picture Control -> Load/save -> Copy to camera. On the Z f both files without a curve (`NPF01-NEUTRAL`) and with a curve (`NPF-FIT4`) are accepted.

## What is in a NEF

- An embedded 6048x4032 JPEG with the camera render, with the shooting profile and ADL.
- The MakerNote has only the recipe name and the base (`FLEXIBLE COLOR`), there is no full recipe.
- MakerNote tag 0x0022: ADL (0 Off, 1 Low, 3 Normal, 5 High, 7 Extra High, 65535 Auto).
- Tag 0x0023: the Picture Control name.
- Tag 0x000C: WB_RBLevels, rational R, B, G1, G2. Read in `wbmap.multipliers`.
- Tag 0x0021 (FaceDetect) not found on the Z f.
- Sensor 6064x4040, black 1008, white 16383. The half development of `dcraw_emu` is 3032x2020, margins of 4 and 2 pixels around a 3024x2016 frame.

## NX Studio sidecars

File `NKSC_PARAM/<name>.NEF.nksc`, next to the NEF.

- Edits live in `nine:NineEdits` as escaped XML, not base64.
- Inside there is a list of `<filter id="...">`.
- `nikon::PictureControl`: the profile name sits in base64 blocks inside the filter.
- `ApplyActiveDLightingFilter` and `ActiveDLightingFilter`: with `true` and `1` ADL is turned off manually. On a shot made without ADL they are `false` and `0`.
- The sidecar stores only the last assignment. If one NEF was rendered with different profiles, the past ones cannot be checked.
- The file size reveals the curve: 70633 bytes on the chart with a curve, 68941 without it.

### Writing a profile into a sidecar

NX Studio 1.11 applies a profile written into the sidecar of a NEF copy: verified on 2 frames and 6 profiles on 2026-11-07, then on 1200 copies. This is how `sweep.py` works.

- `ExportData` and `CustomData` in the `nikon::PictureControl` filter contain the NP3 file itself in base64.
- The base64 is split into lines of 60 characters, the separator is `&#xA;`, which is also at the end.
- `ExportDataSize` and `CustomDataSize`: the text length including the newlines.
- Byte 0x3E: 2 in `ExportData` if the profile has a curve, 0 otherwise. In `CustomData` and in the NP3 file it is 0.
- The writing matched the NX sidecars byte for byte on 88 of 89. The mismatch was the probe with the identity curve, `02-CURVE-ID`.
- The rest of the sidecar content is taken from the same frame, so ADL, WB and vignetting stay as they were.
- Exporting PORTRA and FIT4 from the written profile differs from the old exports by 0.53-0.59 dE, two neutrals differ by as much.
- NX may append a suffix of a past export to the export name, e.g. `_portra400`.

## The export's XMP block

JPEG and TIFF targets carry an XMP block with the `crs:` settings: `WhiteBalance`, `Temperature`, `Tint`, `Exposure2012`, crop, masks, grain, vignetting. There is no block if "All metadata" was not chosen in the export, or the shot went through social networks and other editors.

There is no orientation in the export's XMP. The crop is given in the sensor frame. When tilted, `CropLeft/Top` and `CropRight/Bottom` are the diagonal corners of the rotated frame, not its sides:

```
w = |dx*cos a + dy*sin a|
h = |dy*cos a - dx*sin a|
```
