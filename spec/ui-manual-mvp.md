# Manual NP3 adjustment MVP

Draft from 2026-11-16. A separate specification of the first interface iteration. The full scenario with automatic fitting is described in [ui.md](ui.md) and is not implemented here.

## Interface edits 2026-11-17 (UI-2 package)

The second package of look edits following Lightroom (slider references — [sliders/](sliders/): `saturation.png`, `hue.png`, `saturation_by_color_chroma.png`, `luminance.png`). Item statuses are in the log of [ui-manual-mvp-plan.md](ui-manual-mvp-plan.md) (section 5, entry "UI-2 interface edits"); marked as they are completed.

1. The Import/Export buttons move under the frame info (`#info`), not under the drop zone.
2. The "Before/after" button is removed; instead, a caption in the viewer area that switching works by holding space. The space behavior (and the "Before — neutral"/"After — NP3" captions) is kept.
3. The Saturation (Basic), Color Blender and Color Grading sliders get LR-style gradient tracks: the global Saturation is grey -> rainbow, saturation grows along the whole track (the grey section is noticeable); the blender Hue is only the spectrum of the current color (±55 degrees around it, not the whole circle); the blender Saturation is from grey to the row color; Luminance is black -> color -> white; the saturation of all gradients is muted (-30 from full). The implementation is a CSS track gradient (`--track` on `input[type=range].grad`). Refs: [sliders/](sliders/), [color-blending/](color-blending/), [color-grading/](color-grading/).
4. Color Grading switches to the LR style per [color-grading/ref.png](color-grading/ref.png): the **HSL / Color** toggle group first, then the **Shadows / Midtones / Highlights** zone selector and a color preview window; HSL is rows of Hue/Saturation/Luminance of the selected zone (the Saturation/Luminance gradients are tinted with the selected Hue); Color is a single wheel (dragging sets Hue+Saturation) with a "Hue … Sat …" readout and Luminance below it; **Blending and Balance** (shared NP3 fields) — in both modes, one row each, without duplicate labels and zone names. The Point Color tab is not implemented.
5. Color Blender is rearranged as in LR per [color-blending/](color-blending/): the **Adjust: HSL / Color** switch; HSL is **Hue | Saturation | Luminance | All** tabs with 8 rows by colors (name on the left, a gradient track, the value on the right); Color is a row of 8 color dots (color selection) and Hue/Saturation/Luminance of the selected color. The internal fields and NP3 keys do not change.
6. Label renames: Blender Chroma -> Saturation, Brightness -> Luminance; Grading Chroma -> Saturation, Brightness -> Luminance. The internal field names (`np3.py`) are not touched.
7. The **Details** and **Curve** groups swap places: the panel order is Profile, Basic, Curve, Details, Color Blender, Color Grading.
8. By default only the **Profile** and **Basic** groups are open; the rest are collapsed.
9. In the **Profile** group the Result name row is removed; the profile strength **does not affect the profile name** (the `-<percent>` suffix is no longer added either in the display or in the export file name); the **NP3 NAME** field is placed first inside the Profile group (before the Strength slider), no separate caption is shown at the field.
10. At the bottom of the left panel (Files) — a hotkey legend: **space** (hold — view the neutral, before/after) and **Ctrl+Z** (undo the last change).
11. **Double click on a slider** resets it to the default value (the tool's neutral; Strength — 100%).
12. The numeric value to the right of a slider is an **editable input**: input applies on Enter/blur and is clamped to the slider range.

## Goal

The user opens the application in a browser, loads their RAW, opens a finished NP3 or starts from a new profile, changes sliders and the curve, adjusts strength and immediately sees the approximate result. The current profile can be downloaded as an NP3 and imported back.

**All computation runs locally in the browser.** The server only serves the application statics, models and WebAssembly. The application has no upload, render, import or export API: files are not sent to the server, Python and NX Studio are not used while working.

Base: the static application `web/index.html`, the existing `web/lib/raw.js`, `web/lib/neutral.js`, `web/raw.wasm` and loading one's own file from `web/bench.html`. Architecture and reference checks: [web-tests.md](web-tests.md).

## Iteration boundaries

### Included

- picking or dragging one user `.NEF` or `.DNG`;
- a new profile with default `np3.Control` values and the name `NPF-MANUAL`;
- importing a single `.NP3` via the File API;
- editing the name, all scalar fields and the curve;
- profile strength 0..150% on top of the edited values;
- an approximate preview of the current RAW with the resulting profile;
- exporting the current state by creating a Blob and downloading a `.NP3`;
- clear errors for unreadable RAW and NP3;
- a warning about the approximate render and the development calibrated for the Nikon Z f.

### Not included

- automatic fitting from RAW + JPEG, `match.py`, refitting and NX Studio;
- loading a JPEG/TIFF target, alignment, dE, an error map and reports;
- batch export of several strengths;
- version history, a redo chain and session autosave (only Ctrl+Z — see "Edit history");
- reading the active Picture Control from a NEF and substituting it into the editor (research: [nef-picture-control.md](nef-picture-control.md) — the data is in the file, the implementation decision is not made);
- several RAWs or NP3s in one session and profile comparison;
- writing to `out/`, building the SD card structure and any server-side computation;
- mobile layout as an acceptance criterion.

The existing stands `web/bench.html` and `web/test.html` remain internal tools and are not the MVP interface.

## Main scenario

1. The user opens the static application page through a local HTTP server.
2. They pick or drag a RAW. The browser reads the file, decodes it via WebAssembly and shows the image with the current profile.
3. If wanted, they import an NP3. The import replaces the base profile and resets strength to 100%, but does not replace the loaded RAW.
4. They change sliders, the curve and strength. The image updates without re-decoding the RAW.
5. They check the final profile name and press "Export NP3". The browser downloads the file with all edits and strength applied.
6. The downloaded file can be imported back: its resulting values become the new base profile at strength 100%.

Loading another RAW replaces only the image and keeps the profile and strength. A page refresh may reset the session; the user saves unfinished edits by exporting.

## Screen

The workspace consists of three parts:

- **Files:** RAW loading, the selected file name, frame info, NP3 import, NP3 export (buttons under the frame info) and the processing status.
- **Viewer:** a single image of the current RAW with the resulting NP3, fitted into the available area; a caption that comparing with the neutral works by holding space. The last successful frame stays visible during recomputation and on an error of the next RAW.
- **Profile:** collapsible groups: Profile (NP3 name and strength), Basic, Curve, Details, Color Blender, Color Grading and the curve editor; by default only Profile and Basic are open. Every slider shows its numeric value and a label; it is keyboard-accessible.

The profile panel order top to bottom:

1. **Profile** — a collapsible group in the common panel style at the very top: the NP3 NAME field (first in the group and on the panel), then the Strength slider (like all the others — full width, name on the left, percent on the right above the slider) and the clipping warning. There is no Result name row: strength does not affect the profile name.
2. **Basic** — the second group, open by default together with Profile.
3. **Curve** — collapsed by default.
4. **Details** — after Curve, collapsed by default.
5. **Color Blender** — LR style: Hue / Saturation / Luminance sections of 8 colors each (UI-2 package).
6. **Color Grading** — the last group; LR style with the HSL / Color switch (UI-2 package).
7. **Reset** — a button at the very bottom of the panel: resets all editable values to neutral (the `np3.Control` defaults, as in a new profile): sliders, the curve (turned off), strength — to 100%. The name and comment are not edited by sliders and are not subject to reset.

Export is available without a RAW. NP3 import is also available before loading a RAW.

Every slider's track is filled with color from the minimum to the current value (the CSS variable `--fill`, set by `panels.js` on every change); the fill color or gradient is overridden per slider via `--fill-color`. The Saturation (Basic), Color Blender and Color Grading sliders (UI-2 package) use an LR-style gradient of the whole track instead of the fill (`--track` on `input[type=range].grad`, CSS in `index.html`). The fill and gradients are part of the interface style and do not affect behavior.

## Profile fields

| Group | Fields | Range and step |
|---|---|---|
| Profile | Strength — the percentage of the base profile applied | 0..150%, step 5% |
| Basic | Saturation, Contrast, Highlights, Shadows, White level, Black level | -100..100, step 1 |
| Details | Sharpening | -3..9, step 0.25 |
| Details | Mid-range sharpening, Clarity | -5..5, step 0.25 |
| Curve | Up to 20 points x (x, y) | 0..255, step 1 |
| Color Blender | 8 colors x Hue, Saturation, Luminance | -100..100, step 1 |
| Color Grading | Shadows, Midtones, Highlights x Hue | 0..359, step 1 |
| Color Grading | the same zones x Saturation, Luminance | -100..100, step 1 |
| Color Grading | Blending | 0..100, step 1 |
| Color Grading | Balance | -100..100, step 1 |

Blender color order: red, orange, yellow, green, cyan, blue, purple, magenta. Grading zone order: shadows, midtone, highlights. The internal names and byte layout match `np3.py` and [np3-format.md](np3-format.md).

The base NP3 name: 1-19 ASCII characters. The error is shown next to the field, export with an invalid final name is blocked. On import the name is taken from the file.

## Curve

The curve is a mandatory editable tool of the MVP, not just a thumbnail.

### Editor

- The "Custom curve" switch turns the curve on and off. On the first enable an identity curve with points `(0, 0)` and `(255, 255)` is created.
- Points are added by double-clicking the plot, moved with the mouse or through the numeric `x` and `y` fields — inputs in the common numeric-value style (transparent until focused); the "Delete point" button removes the selected interior point (underlined text, no fill and no border, pushed to the right). There is no separate curve reset command: turning "Custom curve" off and on again creates a fresh identity curve.
- Coordinates are integers, 0..255. Up to 20 points, at least the two endpoints. The endpoints' `x` is pinned at 0 and 255; interior points are ordered by `x`, duplicate `x` is forbidden.
- There is a "Reset curve" command to the identity.
- A backdrop is drawn under the plot — the Y' luma histogram of the **source frame** (neutral without NP3 tools; the X axis matches the curve's input tone), **always when a frame is loaded** — regardless of whether the curve is on. The source is the cached CPU copy of the neutral: a lazy readback once per frame, binning ~1-5 ms; it does not affect the GPU render path and the frame budget.
- A smooth monotone curve without loops and excursions beyond 0..255 is built from the points. The same algorithm fills the table of 257 values 0..32767. The algorithm and its agreement with the Nikon curve are verified by reference tests before the editor is wired.
- Points and table are always recomputed from one state, so that the NP3, the preview and the later recompute by the camera/NX do not describe different curves.

### Compatibility with the tonal sliders

- With the curve on, Contrast, Highlights, Shadows, White level and Black level are disabled. The explanation is shown **always** at the curve editor (next to the "Custom curve" checkbox), rephrased as a format limitation: "When the curve is used, Contrast, Highlights, Shadows, White level and Black level are disabled — you can't use both. This is an NP3 format limitation." It is not duplicated in the Basic group. In the exported NP3 their bytes are written per the `np3.serialize` rules.
- Saturation, the blender, grading and details stay available.
- Turning the curve off removes it from the profile, the five tonal sliders are available again and start from zero values.
- For an unmodified imported profile the original points and table are preserved byte-exactly; after editing the curve or changing strength they are recomputed.

The NP3 comment is not editable but is preserved on import and export.

## Profile strength

Strength is a multiplier on top of the base profile, not a change of the panel values. The behavior matches `strength.scaled` and the "Profile strength" section of [ui.md](ui.md):

- Saturation, the five tonal sliders, the blender, grading Chroma and Brightness are scaled;
- the curve is blended with the identity;
- grading Hue, Blending, Balance, Sharpening, Mid-range sharpening and Clarity do not change;
- the sliders and the editor always show the base profile at 100%, so strength can be changed back and forth without accumulating rounding;
- values that get clipped by the NP3 range at a strength above 100% are highlighted, and a general warning is shown;
- the profile strength **does not affect the profile name**: the `-<percent>` suffix is not added (UI-2 package), the export file name is the base profile name;
- the NP3 gets the result after applying strength. Batch saving of different strengths is not part of the MVP.

## Edit history (Ctrl+Z)

- **Ctrl+Z** reverts the last finished action with sliders, wheels, the curve and strength. A state snapshot (`control` + `strength`) is taken on every finished action: a slider `change`, a curve point/wheel release, the Reset button.
- Up to **20 last states** are kept in the tab's sessionStorage (key `np3hist`) — the history survives a page reload within the tab.
- **Changing the RAW or importing an NP3 resets the history** (the new base snapshot is the current profile).
- There is no redo: a new action cuts off the undone steps. Ctrl+Z in the name text field is the native input undo, the profile history is not touched.

## Preview

- Pipeline: File -> WebAssembly/rawler -> linear RGB -> Nikon neutral on WebGL2 without vignette correction -> the resulting NP3 after strength -> screen. Vignetting is not part of the editor: there is no such setting in NP3, the interface is a visual NP3 editor, not an emulator of the camera pipeline.
- The profile model and detail are computed by the browser; their accuracy is verified against Python per [web-tests.md](web-tests.md).
- During continuous slider or point movement a reduced/simplified preview is used; after the action finishes — the regular frame with the long side up to 1600 px. Specifics (verified by measurements on 2026-11-17, a 1008x1512 frame): the final detail pass is drawn straight into the default framebuffer of the visible canvas without a readback; during movement the profile LUT is built reduced 17^3 (~13 ms vs ~88 ms for 33^3), the full 33^3 LUT is built after the `change`. The interactive frame budget is tens of milliseconds; the breakdown and the optimization history are in the section 5 log of [ui-manual-mvp-plan.md](ui-manual-mvp-plan.md).
- Long decoding runs in a Worker to keep the interface responsive. Every operation has a monotonic state number: finishing an old decode or LUT build cannot replace a newer frame.
- The neutral frame and the RAW data stay in the page memory; changing the profile or strength does not start decoding again. The neutral texture after the first build lives on the GPU and is not re-uploaded between edits.
- If the browser model of some tool is missing, this is shown explicitly. Such a tool cannot be considered MVP-ready.
- The result is labeled as an approximate computation, not an exact NX Studio render.

### Before/after

- Holding **space** (with focus outside input fields) shows the **Nikon neutral** instead of the resulting NP3; releasing returns the resulting render. There is no separate button (UI-2 package): a caption in the viewer area says switching works by holding space.
- "Before" is the developed RAW with WB and rotation, but **without any NP3 tools**: the basic sliders, detail, curve, blender, grading and strength. Vignetting is not applied, there is no setting for it in NP3. It is not the linear mosaiced RAW data.
- The switch uses the already-ready neutral frame and starts no decoding or profile recompute. Zoom, position and image size do not change.
- Space works only after a successful RAW development; before that a press is ignored.
- Releasing space always returns "after". While the neutral is shown, the caption is "Before — neutral", normally — "After — NP3".
- The comparison changes only the screen: the current profile, strength and export stay unchanged.

### Color Blender (UI-2 package)

Shown as in Lightroom ([color-blending/](color-blending/)): the **Adjust: HSL / Color** switch. In the HSL mode — **Hue**, **Saturation**, **Luminance**, **All** tabs: for the selected attribute (or all at once in All) 8 rows by color (red, orange, yellow, green, cyan, blue, purple, magenta) — color name on the left, an LR-style gradient track, the numeric value on the right. Gradients: Hue is the spectrum ±55 degrees around the row color; Saturation is grey -> row color; Luminance is black -> row color -> white; the saturation is muted. In the Color mode — a row of 8 color dots (color selection) and Hue/Saturation/Luminance sliders of the selected color. Field labels are Hue/Saturation/Luminance (the internal NP3 names are unchanged).

### Color Grading (UI-2 package)

Shown as in Lightroom ([color-grading/ref.png](color-grading/ref.png)):

- On top — the **HSL / Color** toggle group (first), then the **Shadows / Midtones / Highlights** zone selector (LR-style text, without "Adjust:"). The resulting-color preview window (Hue + Saturation at the zone's lightness; slider width, about two rows high) is only in the HSL mode, above the sliders.
- **HSL** — rows of Hue/Saturation/Luminance of the selected zone with LR-style gradients (Hue is the full but muted spectrum at the zone's lightness; Saturation is grey -> the selected Hue color; Luminance is black -> the Hue color -> white; the Saturation/Luminance gradients are repainted on a Hue change).
- **Color** — a single color wheel of the selected zone (centered): dragging the dot sets Hue (angle from the top) and Saturation (radius, 0..100); below the wheel — numeric Hue (0..359) and Saturation (0..100) inputs synced with the dot; the Luminance slider is full width.
- **Blending and Balance** — global NP3 fields (`blending`, `balance`, written to the file in either mode and independent of the zone), shown in both modes below the mode bodies, separated by a divider; each is one row with a label (no duplicate headings). No zone names are repeated above the wheel and under the buttons. The key `grade[zone] = [hue, chroma, brightness]` and the NP3 ranges do not change (Chroma is shown as Saturation; negative values are available in the HSL mode).
- The Point Color tab is not implemented and not offered.

## Import and export

**Import** is performed entirely by the JavaScript NP3 port. After parsing, the panel is filled with all fields, including details, Blending, Balance, the comment and the full curve. A corrupt or unsupported file does not change the current profile.

**Export** is performed entirely by JavaScript: the current base profile -> strength applied -> NP3 serialization -> Blob -> download. The file name comes from the resulting profile name; it does not determine the camera slot. For the camera the user follows [np3-format.md](np3-format.md).

Import without edits at 100% strength followed by an export must give the original file byte for byte for all samples that pass the byte-exact `test_np3.py`. No extra automatic corrections are applied.

## Errors and limitations

- The supported formats are those the existing `web/raw.wasm` reads; known NEF High Efficiency and non-Bayer DNGs are rejected with a clear error.
- An unsupported RAW does not replace the last working frame and does not reset the profile.
- A camera that is not a Z f does not block the work but raises a warning about the development accuracy.
- WebGL2 and support for the used float textures are required; without them a separate message about an unsupported browser is shown.
- WB, geometry and the differences from NX remain the project limitations; the MVP does not solve them.
- The selected files and the profile exist only in the tab memory. The application makes no network requests with their content and writes nothing to the file system except the explicitly downloaded NP3.

## Acceptance criteria

1. **New profile:** without an import one can load `test1/DSC_5584.NEF` (locally in `_local/`), get an image, change every slider and export an NP3 with these values.
2. **Layout:** Profile (with the name and strength) is at the very top of the panel and open by default; Basic is also open; then Curve, Details, Color Blender and Color Grading last; the other groups are collapsed by default.
3. **Import:** a finished NP3 fills all groups with values matching `np3.deserialize`; edits are reflected in the preview and the export.
4. **Curve:** the curve can be enabled, points added/moved/removed, reset and disabled. The points and the 257 table values in the export are consistent; the five tonal sliders are correctly locked and unlocked.
5. **Strength:** 0..150% (step 5%) via the Strength slider changes the preview and the export per the `strength.scaled` rules, does not change the base panel values and the profile name, gives a clipping warning.
6. **Before/after:** holding space shows the neutral without any NP3 tools and strength; releasing returns the result without a zoom jump and without changing the profile; before a RAW development space is ignored.
7. **Re-import:** a file exported after edits imports back without field divergence; its values become the base at 100% strength.
8. **File independence:** changing the RAW does not reset the NP3 and strength, importing an NP3 does not reset the RAW, export works without a RAW.
9. **Last state:** a fast series of edits and a RAW change during decoding end with the image of the last state; the old work does not override it.
10. **Errors:** an invalid NP3, an unreadable RAW and missing WebGL2 give a clear message without losing the current state when a working session already exists.
11. **Locality:** during RAW/NP3 loading, edits, rendering and export there are no requests with user data; the application works from a static server without any `/api`.
12. **Reference match:** `python3 test_np3.py` and `node web/test.mjs` pass, including the NP3, profile LUT, detail and full-render levels from [web-tests.md](web-tests.md).
13. **Edit history:** Ctrl+Z successively reverts finished edits to the start of the session, keeps up to 20 states in sessionStorage; changing the RAW and importing an NP3 reset the history.
