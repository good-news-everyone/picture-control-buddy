---
name: adl-as-shot
description: "NX exports used with np3-fit must keep Active D-Lighting \"as shot\" (sidecar value 1), never off"
metadata:
  node_type: memory
  type: project
  originSessionId: 6394d91c-9232-42d3-a575-39f6aff12e6c
  modified: 2026-11-09T23:18:22.176Z
---

The development model was trained on NX exports with Active D-Lighting "as shot" (ActiveDLightingFilter = 1 in the sidecar). That matches what the camera itself does.

**Why:** turning ADL off in NX makes frames shot with ADL Normal about 0.3 stop brighter than our neutral, which showed up as ΔE errors of 3–6 L on the Lightroom test (2026-11-10). One round of NX exports was wasted on this.

**How to apply:** never tell the user to turn ADL off in NX. `sweep.py` packs set ADL as shot through `adl_as_shot`. When a frame's neutral is uniformly brighter or darker than NX, check camera ADL (`exiv2 -K Exif.Nikon3.ActiveDLighting`) and the sidecar ADL value first.

Related: [[goal-ui-manual-tuning]]
