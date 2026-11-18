---
name: lightcraft-lr-profiles
description: "Porting Lightroom profiles to LightCraft — xmp2cube works, DCP->JSON changes almost nothing because of the fit-to-JPEG"
metadata:
  node_type: memory
  type: project
  originSessionId: 99e85187-a6e0-4428-b9c1-8b7e8db49149
  modified: 2026-10-13T08:49:53.114Z
---

2026-10-13: scripts in ~/expirements/lightcraft-profiles: `xmp2cube.py` (an Adobe creative profile with crs:RGBTable -> .cube; the big-table format: base85 with its own alphabet, LE uint32 length + zlib; the table ordered r->g->b, b fastest, uint16 deltas from identity; the tail: primaries, gamma, gamut, min/max amount) and `dcp2lightcraft.py` (DCP -> `<model>.json` for camera-profiles). The user's camera is a Nikon Z f, the model in LightCraft is "NIKON Z f" -> NIKON_Z_f.json.

Result: Astia.cube via `profile.import` gives a noticeable look (~10/255). The JSON from Adobe Standard and Camera Rich Tone Portrait is accepted, but the render differs by 1-2/255: LightCraft 0.7.1 fits the tone and chroma of every NEF to the embedded JPEG, and this eats the character of the profile, and there is no place for the DCP tone curve in JSON.

**Why:** so as not to waste time again on the JSON path for the profile "look".
**How to apply:** for real Adobe Standard / Camera profiles use PR #1063 (.dcp import, applied at decoding, bypasses the fit-to-JPEG) or a DNG with an embedded profile. Building LightCraft from sources — a workaround [[rustc-znver4-llvm-crash]].
