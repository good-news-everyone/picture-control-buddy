# Picture Control in NEF: a readability research

A reconnaissance draft from 2026-11-18. Question: can the active Nikon Picture Control style be read from a loaded RAW and substituted into the editor as the NP3 base. **Status: research finished, the implementation decision is not made.**

## Short answer

Yes for NEF — the data is in the file and sits in a standard place. There is no such block in DNG. The implementation cost is medium: a TIFF parser + a Picture Control binary block decoder, conveniently done in the decoding Worker.

## Where the data lives (the chain in TIFF)

A NEF is a regular TIFF (little-endian, `II*`). The chain to the style block:

1. **IFD0** -> tag `0x8769` (ExifIFD) -> a pointer to the EXIF IFD.
2. **EXIF IFD** -> tag `0x927C` (MakerNote) -> the Nikon MakerNote.
3. **MakerNote**: the signature `Nikon\0`, then 2 version bytes and an **embedded TIFF header** (`II*`), whose first IFD is at offset `10 + u32(mnOff + 14)` from the start of the MakerNote.
4. **Tag `0x2D` "Picture Control Data"** in the MakerNote IFD — a binary block of the active Picture Control parameters.

The block format across version generations `0100` -> `0300` is documented indirectly (exiftool parses it); NP3 stores the same camera parameters, the mapping is close to 1:1.

## Empirics (test1/DSC_5584.NEF, Z f)

A run with a TIFF walk in Node (a reconnaissance script, not kept):

- `rawler` (web/raw.wasm) returns only `make, model, dng, sensor, wb, black, white, orientation, k` in `info` — it does **not** return the Picture Control, it must be parsed from the file bytes by us.
- The block was found at offset ~37300: version `0200`, the custom style name `ktr-100-skinfix`, base `FLEXIBLE COLOR`. That is, the camera writes the full set: sharpening, contrast, highlights/shadows, whites/blacks, saturation; for Flexible Color also the Color Blender (hue/chroma/brightness for 8 colors) and Color Grading by zones.
- The file also contains an **embedded Adobe XMP** (`crd:` — Camera Raw Defaults: SharpenRadius 2.00, Clarity2012, HueAdjustment* and so on, `CameraProfile` = "Camera Flexible Color") — these are Lightroom/ACR metadata, easy to confuse with the camera style; **not a source of truth**.
- The second occurrence of `Nikon\0` (offset ~248824) is probably a copy in the preview/JPEG thumbnail; it is not needed for reading the style.

## Caveats and limitations

- **Quick Adjust**: if it is not 0 in the camera, the individual parameters are offsets from the base style; an exact import requires applying QA to the base or an honest "approximate" mark.
- **NEF only**: DNG has no MakerNote Picture Control block.
- The camera post-processing parameters (Noise Reduction, Sharpening "advanced/detail") do not fit into NP3 — only the base `np3.Control` fields are carried over.
- The binary block structure is versioned (0100/0200/0210/0300...); a layout table is needed at least for the project cameras' versions (Z f — 0200 + the Flexible Color extension).

## Implementation options (if decided)

- **A parser in `raw-worker.js`** (recommended): a TIFF walk + block decoding after `raw.develop`, the result (an `np3.Control`-like object or the raw binary) travels with the frame. No extra memory — the bytes are in the Worker anyway.
- A parser on the main thread: requires keeping a copy of the NEF (~20-40 MB) — worse.
- Order: first NEF + classic parameters (without Blender/Grading), reference checks against the exiftool layout; Flexible Color (blender/grading from the block) as the second step.

## Related documents

- [ui-manual-mvp.md](ui-manual-mvp.md) — the MVP interface (this function is not part of the iteration).
- [np3-format.md](np3-format.md) — the NP3 layout: the target fields for the mapping.
