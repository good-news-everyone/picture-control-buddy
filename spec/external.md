# Third-party projects

## Used by the project

| What | License | Where |
|---|---|---|
| [ssssota/nikon-flexible-color-picture-control](https://github.com/ssssota/nikon-flexible-color-picture-control), commit ed0397f | MIT | `third_party/` and the layout in `np3.py` |
| LibRaw: `dcraw_emu`, `unprocessed_raw`, `raw-identify` | system package | `rawdev.py` |

## Not taken into the project

Firmware-derived sources of jolchmo/Z30 (`blender.c`, `grade.c`, `tone.c`, `saturation.c`, `contrast.c`): rights not confirmed. Only the idea of the structure was taken.

## NEF + NP3 rendering

No open exact renderer was found. The search was not exhaustive: GitHub and the web. NP3 support in darktable and RawTherapee could not be confirmed.

| Project | What it does | Limitation |
|---|---|---|
| [b-z/Nikon-Recipes-to-LR-Profiles](https://github.com/b-z/Nikon-Recipes-to-LR-Profiles) (MIT) | NP3 -> Lightroom profile, a synthetic NEF with 24 720 patches, inserting NP3 into `.nksc`, packs for Z 8, Z 9, Z f, Z6III, Z5II, Z50II, ZR | Rendering via NX Studio; the table generator is for Z 8; the photo samples and the table are not under MIT |
| [tvgenious89/nikon-pc](https://github.com/tvgenious89/nikon-pc) | An NCP and NP3 editor with a preview | Embedded JPEG, only the curve is exact |
| [city0928/nikon-z50-picture-lab](https://github.com/city0928/nikon-z50-picture-lab) | NP3 preview and export for Z50 | The preview is approximate |
| [mini-film](https://docs.rs/crate/mini-film/3.2.1/source/src/nikon.rs) | Fitting `.NCP` by a LUT | NCP only, does not render |
| [Pinksert/Nikon-Picture-Control-NCP-Analysis](https://github.com/Pinksert/Nikon-Picture-Control-NCP-Analysis) | Format parsing, downconverting NP2/NP3 to NCP | Not a renderer |
| [fistulareffigy/Nikon-NP3-NCP-TOOL](https://github.com/fistulareffigy/Nikon-NP3-NCP-TOOL) | NP3 repair | Not a renderer |

The NRLR authors write that an exact decomposition of the blender and grading is not solved yet, and they fit profiles against the NX Studio output.

## Recipe libraries

- [shouryan01/Nikon-Recipes](https://github.com/shouryan01/Nikon-Recipes)
- [Bear-Essentials/NikonNP3s](https://github.com/Bear-Essentials/NikonNP3s)
- [popshia/nikon-recipes-android](https://github.com/popshia/nikon-recipes-android)
- nikonpicturecontrol.com, nikonpc.com, Flexible Color Creator and Recipe by krafta-visio

No ready "photo -> NP3" tool and no `.cube` -> NP3 converter were found in the first search.
