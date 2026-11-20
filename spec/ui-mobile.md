# Mobile layout of the NP3 profile editor

> **2026-11-20: pages renamed and the Start screen dropped** ([ui-pages.md](ui-pages.md), [ui.md](ui.md) decision #9). Read `index.html` in this document as `picture-control-editor.html` and `mobile.html` as `picture-control-editor-mobile.html`. The mobile page is the standalone editor only: no Start screen, no pairs, no fitting (the fitting wizard `picture-control-jpg-fit.html` is desktop only). The router is included only in the two editor pages; `index.html` is a landing. Where this document disagrees, ui-pages.md wins.

Draft from 2026-11-19, revised the same day (separate page + redirect, Reset confirmation, Web Share export). Status: specification, not implemented. Base: the manual editor of [ui-manual-mvp.md](ui-manual-mvp.md) (including the UI-2 package) and the session shell of [ui-plan.md](ui-plan.md) (Start screen, `state.step`).

## Goal

The editor (step `edit`) and the Start screen (step `start`) are usable on a phone held in one hand: the photo takes the upper part of the screen, one tool is edited at a time in a panel under the photo, tools are switched by an icon bar at the bottom, and the file actions are icon buttons in a top bar. The layout follows the widespread mobile photo-editor pattern (photo on top, a short slider panel, an icon tool bar at the bottom, file actions at the top right). No third-party product is copied: no icons, artwork, names or exact visuals; all icons come from the open Lucide set (see "Icons and licensing").

The mobile version is a **separate page** `web/mobile.html` with its own markup and CSS on top of the **same JS core** (`app.js` and every module in `web/lib/`). Phones are redirected to it, desktops to `web/index.html` (see "Two pages and the redirect"). All computation stays local, as on the desktop; the pipeline (`renderer.js`, `profile.js`, `np3.js`, workers) is not touched.

## Scope

### Included

- `web/mobile.html` (now `picture-control-editor-mobile.html`): the editor (top bar, viewer, tool panel, tool bar, info sheet, status toasts). ~~And the Start screen~~ — dropped 2026-11-20.
- The redirect between `index.html` and `mobile.html` and a manual version switch.
- A landscape-phone variant of the same layout.
- Touch equivalents of every desktop-only interaction: Space-hold (before/after), Ctrl+Z (undo), double-click reset, drag-and-drop, hover tooltips.
- Touch-friendly sizes for all controls of the six panel groups, including the curve editor, the Color Blender and the Color Grading wheel.
- Mobile behavior of the file pickers, NP3 export and the share link.
- ~~A touch-friendly Start screen in `mobile.html`.~~ Dropped 2026-11-20 (the fitting wizard is desktop only).
- NP3 export through the system share sheet on phones.
- Tests: a mobile level in `web/test.mjs` and a manual checklist on real devices.

### Not included

- Pinch-zoom and pan of the photo, 1:1 view.
- Redo (the desktop has none either).
- A PWA / offline install, a native app wrapper.
- New editor features that the desktop does not have.
- A language switch (i18n stays as it is; new strings go through `t()` / `data-i18n`).
- Changes to the fitting stages of [ui-plan.md](ui-plan.md).
- Changes to the desktop layout of `index.html` (it keeps its current narrow-window stacking).

## Two pages and the redirect

### Pages

| Page | For | Layout |
|---|---|---|
| `web/index.html` | desktops, laptops, tablets | the current three-column editor; unchanged |
| `web/mobile.html` | phones | this spec: portrait and landscape variants by CSS |

Both pages load the same `lib/app.js` and modules. There is no shared layout CSS between them beyond `web/css/common.css` (see "Implementation notes").

### Which page is the right one

Decided once, at page load, by a tiny synchronous script `web/lib/view-route.js` included first in `<head>` of both pages (before any CSS or module, so there is no flash and no model download on the wrong page). Order:

1. **URL override** `?view=desktop` or `?view=mobile`: the choice is stored in `localStorage` (`np3view`) and the parameter is removed from the URL.
2. **Stored preference** `np3view`, if present.
3. **Auto:** a phone is `matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600`. Screen size, not window size: a narrow desktop window stays on the desktop page, a rotated phone stays on the mobile page. User-Agent sniffing is not used (iPadOS reports a desktop UA).

If the current page is not the chosen one, `location.replace()` goes to the other page with the **same `search` and `hash`** (so `?np3=` share links survive) — `replace`, so Back does not bounce. A redirect happens only at load: rotation and resizing never redirect; `mobile.html` covers portrait and landscape by CSS, `index.html` keeps its own narrow-window rule. If `localStorage` is unavailable, only steps 1 and 3 apply.

### Manual switch

- `mobile.html`: "Desktop version" in the info sheet; `index.html`: "Mobile version" at the bottom of the left column (shown only when the auto rule would pick mobile, or a preference is stored).
- The switch sets the preference and navigates with the **current profile** as `?np3=` (the share-link encoding of `transfer.js`), so the profile survives the switch. The loaded RAW and the Start-screen pairs do not survive (a page load); the switch label says so in its title: "Opens the other version with the current profile; the photo has to be opened again."

### Share links

`Copy link` (and the share sheet) always builds the link on **`picture-control-editor.html`** in the current directory (changed 2026-11-20 from the directory URL; [ui-pages.md](ui-pages.md) "Share links" — the landing forwards old `/web/?np3=` links), not on the current page. A link copied on a phone and opened on a PC opens the desktop editor directly; opened on a phone, the router sends it to `mobile.html` with `?np3=` intact.

### Input

Touch gestures (long-press, double-tap) are implemented with pointer events and work on any page whenever `pointerType` is `touch` or `pen`; keyboard shortcuts (Space, Ctrl+Z) keep working on `mobile.html` when a keyboard is present.

## Portrait layout

Reference size: 390 × 844 CSS px (smallest supported: 360 × 640).

```
┌────────────────────────────────────────┐  ← env(safe-area-inset-top)
│ (+) (i)           [undo][imp][exp][lnk] │  top bar, 48 px
├────────────────────────────────────────┤
│                                        │
│                                        │
│              photo (canvas)            │  viewer, flex: 1
│                                        │
│ After — NP3                            │
├────────────────────────────────────────┤
│ Contrast                          +12  │
│ ───────────────●────────────────       │  tool panel, fixed height,
│ Highlights                         -5  │  scrolls inside
│ ──────────●─────────────────────       │
├────────────────────────────────────────┤
│ Profile Basic Curve Details Blender │R │  tool bar, 60 px, icon over label
└────────────────────────────────────────┘  ← env(safe-area-inset-bottom)
```

The page itself never scrolls: `html, body` are `height: 100dvh; overflow: hidden; overscroll-behavior: none`; only the tool panel, the tool bar (horizontally) and the info sheet scroll. `<meta name="viewport">` gets `viewport-fit=cover`, and the bars pad themselves with `env(safe-area-inset-*)`.

### Top bar

| Position | Button | Icon (Lucide) | Action | i18n label (aria-label / title) |
|---|---|---|---|---|
| left, 1st | Add | `plus` in a 36 px filled round button | opens the RAW picker (`#file`), same as clicking the desktop drop zone | "Open RAW" |
| left, 2nd | Info | `info` | opens the info sheet | "Info" |
| right, 1st | Undo | `undo-2` | `hist.undo()` | "Undo" |
| right, 2nd | Import NP3 | `upload` | the existing `#import` | "Import NP3" |
| right, 3rd | Export NP3 | `download` | the existing `#export` | "Export NP3" |
| right, 4th | Copy link | `link` | the existing `#share` | "Copy link" |

- Icon-only buttons, 22 px glyph, 44 × 44 px hit area, 4 px gap; background `var(--panel)`.
- The import/export/share icons are the ones the desktop buttons already use, so both layouts read the same.
- **Same ids, same handlers:** in `mobile.html` the top-bar buttons are the elements `#import`, `#export`, `#share` (icon only, the name in `aria-label`), so `transfer.js` wires them exactly as on the desktop. Add is `#drop`'s mobile counterpart: it triggers `#file`.
- **Undo** is disabled when there is nothing to undo (`hist.index <= 0`). `history.js` gets an `onChange` callback (called from `push`, `undo`, `clear`) and a `canUndo` getter; the desktop is not affected.
- **Disabled export/share:** a disabled `<button>` swallows taps silently, and the desktop explains the reason only in a hover tooltip. On `mobile.html` `setupTransfer({ softDisable: true })` makes `updateExport()` mark the buttons with `aria-disabled="true"` (dimmed) instead of `disabled`; a tap then shows the toast "Set a valid NP3 name (1–19 ASCII) to export", switches to the Profile tool and focuses the name field. `index.html` keeps `disabled` + `title`.
- **Attention dot:** a 6 px accent dot on the Info button while the camera warning (`#warn`) or an error status is present and the sheet has not been opened since it appeared.

### Viewer

- Background `#000`; the canvas is centered and fitted with `max-width: 100%; max-height: 100%` of the viewer box (replaces `max-height: calc(100vh - 90px)`).
- **Empty state** (no RAW yet): instead of the hidden canvas, a centered tap target "Open a RAW (.NEF / .DNG)" with the `image-plus` icon, which opens the same picker as Add.
- **Before/after** (replaces Space-hold on touch): touch and hold the photo for 250 ms without moving more than 10 px → "before" (the neutral, exactly `before-after.js` `show(true)`); `pointerup`, `pointercancel` or `lostpointercapture` → "after". Implemented in `before-after.js` with pointer events on `#c`; the Space-hold path stays. The canvas gets `touch-action: none; -webkit-touch-callout: none; user-select: none`, and `contextmenu` is prevented on it, so the long-press does not open the system "save image" menu or select text.
- The state caption ("After — NP3" / "Before — neutral") is a small pill in the top-left corner of the viewer. The desktop hint "Hold Space to compare with neutral" is not shown on `mobile.html` (`createBeforeAfter` gets `hint: false`); the gesture is listed in the info sheet.
- The caption "Approximate calculation in the browser — not an exact NX Studio render." moves from under the photo to the info sheet (it costs a line of photo height on a phone).

### Tool panel

- Shows exactly one panel group — the active tool. `panels.js` builds the same `details.grp` groups into `#panel-scroll`; `mobile.html` CSS hides every `summary`, and `mobile.js` forces each group open and displays only the one whose `data-group` matches the active tool.
- **Fixed height**, so the photo does not jump when tools are switched: `clamp(200px, 38dvh, 360px)` in portrait. Content scrolls inside with `overscroll-behavior: contain`. Exception: the Curve tool (see below).
- `#panel-foot` (where `panels.js` puts the Reset button) is hidden by CSS; Reset lives in the tool bar and calls the same action after the confirmation.
- Padding 12 px left/right, 8 px top.

### Tool bar

| Order | Tool (`data-group`) | Icon (Lucide) | Label |
|---|---|---|---|
| 1 | `strength` (Profile) | `layers` | Profile |
| 2 | `basic` | `sun` | Basic |
| 3 | `curve` | `spline` | Curve |
| 4 | `details` | `focus` | Details |
| 5 | `blender` | `blend` | Blender |
| 6 | `grading` | `palette` | Grading |
| — | a 1 px vertical divider | | |
| 7 | Reset (action, not a tool) | `rotate-ccw` | Reset |

- Order equals the desktop panel order (UI-2 item 7). Each item: 22 px icon over an 11 px label, min width 56 px, height 60 px. If the items do not fit (360 px phones), the bar scrolls horizontally with `scroll-snap-type: x proximity`; the active item is scrolled into view.
- Active tool: label and icon in `var(--accent)` with a 2 px underline; inactive: `var(--dim)`.
- **Modified dot:** a 4 px dot under the label of a tool whose fields differ from the neutral (`newProfile()` with zeroed blender/grading; for Profile — strength ≠ 100; for Curve — `control.curve !== null`). Recomputed on every finished action.
- The default tool is **Basic**; the active tool is kept in memory for the session (not persisted).
- **Reset** resets the whole profile (the existing `#p-reset` action: name and comment kept, strength 100). It first asks for confirmation in an in-page dialog (not `window.confirm`, which blocks the page and the test driver): title "Reset the whole profile?", text "All settings return to neutral. The name is kept. You can undo it.", buttons **Cancel** and **Reset** (the latter in `var(--bad)`). Cancel, a tap on the scrim or Escape closes it without changes. After confirming, Reset is a finished action and Undo restores the previous state. The desktop Reset button is not changed.
- The tool bar uses `role="tablist"` / `role="tab"` / `aria-selected`; the panel group is the `tabpanel`.

### Info sheet

The Info button opens a bottom sheet (max height 85dvh, scrolls inside, 12 px top corners, a scrim over the rest). It is `mobile.html`'s own markup carrying the ids `app.js` writes to (`#info`, `#warn`, `#status`, `#to-start`). Content, top to bottom:

1. Title "NP3 profile editor" and a close button (`x`).
2. "Back to Start" (`chevron-left` + label) — the existing `#to-start`.
3. Frame info `#info` (file, camera, frame size) and the camera warning `#warn`.
4. The latest status `#status`.
5. The approximate-render caption (moved from the viewer).
6. A **Gestures** legend instead of the hotkey legend: "Touch and hold the photo — view neutral (before/after)", "Double-tap a slider — reset to default", "Tap the value — type an exact number".
7. Known limitations `#known` with one more line: "On iOS pick RAW files from Files: the Photos library may hand over a converted JPEG."
8. The source link: a text link with the Lucide `external-link` icon instead of the GitHub mark (the mark is a trademark with its own usage rules; this also keeps every mobile icon from one open set).
9. "Desktop version" (see "Manual switch").

There is no drop zone on `mobile.html` (Add and the empty state cover it). The sheet closes by the close button, a tap on the scrim, Escape, or a swipe down on its handle.

### Status toasts

- `#status` stays the single status source; on `mobile.html` every status change is also shown as a toast above the tool bar (max 2 lines, centered, `var(--panel)` with a border).
- `setStatus(text, kind)` gets an optional `kind`: `"info"` (default, hides after 3 s), `"progress"` (stays until replaced: "loading models…", "unpacking {name}…"), `"error"` (stays 6 s or until tapped; the Info dot appears). Existing callers keep working unchanged as `"info"`; the decode/import/export/share/LUT error paths pass `"error"`, the loading paths pass `"progress"`.
- A toast never covers the top bar or the tool bar and does not block taps outside itself.

## Landscape phone layout

Reference size: 844 × 390. Applied by CSS inside `mobile.html` with `@media (orientation: landscape)`; switching orientation does not reload.

```
┌───────────────────────────────────────┬───────────────────────┐
│ (+) (i)                               │ [undo][imp][exp][lnk] │ top bar, 44 px
├───────────────────────────────────────┼───────────────────────┤
│                                       │ tool panel            │
│              photo (canvas)           │ (scrolls)             │
│                                       ├───────────────────────┤
│                                       │ tool bar, 2 rows of   │
│                                       │ 4 icons (no labels)   │
└───────────────────────────────────────┴───────────────────────┘
```

- Two columns: viewer (flex 1) and a right column `min(360px, 42vw)` with the tool panel (flex 1) and the tool bar under it. Tool bar items are icon-only (labels hidden, kept as `aria-label`), wrapping into two rows.
- Safe areas: left/right insets (the notch side) are padded.
- The top bar is 44 px; the left group sits over the viewer, the right group over the right column.

## Tools on mobile

Each tool shows the contents of its desktop group; the differences are listed here.

### Common slider row

- Row: label left, value right, track under them; min row height 52 px.
- Track 4 px (gradient tracks of UI-2 unchanged), thumb 22 px; the `input[type=range]` is 32 px high so the whole strip is the hit area.
- **Vertical swipe ≠ value change.** A vertical swipe over slider rows scrolls the panel and does not change any value; a value changes only by dragging the thumb or by a mostly horizontal drag on the track (≥ 8 px with |dx| > |dy|). A plain tap on the track does not jump the value. Range inputs get `touch-action: pan-y`; if a target browser's native range still violates the rule (checked on devices in M2), the range is driven by a small pointer handler in `web/lib/touch.js`.
- **Double-tap reset** replaces double-click on touch: two taps on the row (label or track, not the number field) within 300 ms and 12 px reset the slider to its default (Strength — 100), as a finished action. `touch.js` exports `onDoubleTap(el, fn)`; `panels.js`, `blending.js` and `grading.js` use it next to their existing `dblclick` handlers. Rows get `touch-action: manipulation` so the browser does not double-tap-zoom.
- **Number field:** tap to edit, font size 16 px (smaller fonts make iOS zoom the page on focus), `enterkeyhint="done"`, applied on Enter/blur and clamped as on the desktop. The keyboard must allow a minus sign: `inputmode="decimal"` is not acceptable (the iOS decimal pad has no minus); keep `type="number"` without `inputmode` and verify on devices.
- While the on-screen keyboard is open, the focused field is kept visible above it (`visualViewport` resize → `scrollIntoView({ block: "nearest" })`).
- Live rendering during a drag keeps the desktop path (`onChange(true)` → rAF → 17³ LUT; release → 33³ LUT + history snapshot).

### Profile

NP3 name field (16 px font, `autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"`, the inline 1–19 ASCII error), Strength, the clipping warning. No other changes.

### Basic, Details

The existing sliders with the common row rules. The tonal-lock state from the curve (disabled sliders) is shown the same way as on the desktop.

### Curve

The curve chart moves over the photo, the way phone editors usually show a tone curve; the panel keeps the controls.

- When the Curve tool is active **and** "Custom curve" is on, the chart SVG is shown as a square overlay centered on the viewer: side = `min(viewer width, viewer height) − 16 px`, background `rgba(0, 0, 0, .35)`, the histogram backdrop and the identity diagonal kept. Leaving the tool or turning the curve off hides the overlay. `createCurveEditor` gets an optional `chartSlot` (an element in the viewer of `mobile.html`); when given, the SVG lives there and the controls stay in `#curve-slot`; `index.html` passes nothing and is unchanged.
- The panel shows: the "Custom curve" checkbox (44 px row), the format note, the x / y fields and "Delete point", plus a **Done** button (`check`) that returns to the Basic tool.
- Touch: every point has an invisible hit circle of 22 px radius (the visible radius stays); a **tap on an empty spot of the chart adds a point** (on touch, instead of the desktop double-click, which stays for the mouse); a tap on a point selects it; dragging moves it with the existing neighbor rules; "Delete point" removes the selected one. The 20-point limit message shows as a toast.
- The chart has `touch-action: none`. Touch-and-hold before/after works on the viewer area outside the chart square.
- `toTone()` must map pointer coordinates through the SVG's screen matrix so it works in both parents (verify, fix if it assumes the panel position).

### Color Blender

- The Adjust HSL / Color toggle and the Hue | Saturation | Luminance | All tabs: 40 px high.
- HSL rows follow the common slider row; "All" (24 rows) scrolls in the panel.
- Color mode: the 8 color dots are 28 px visible, distributed evenly over the panel width, each with a ≥ 40 px hit area; the selected dot has a 2 px accent ring.

### Color Grading

- The HSL / Color toggle and the zone tabs: 40 px high.
- The wheel is `min(200px, 55%)` of the panel width with `touch-action: none` (dragging on it must not scroll the panel); the Hue/Saturation readout fields follow the number-field rules.
- Blending and Balance as common slider rows.

## Files on mobile

- **Pickers.** Add and the empty state open `#file` (NEF/DNG); Import opens the NP3 input of `transfer.js`. On iOS, an `accept` list with an extension that has no system type can grey out such files in the picker. NEF and DNG are known RAW types; `.NP3` is not. Rule: if a device shows the files greyed out, the affected input drops its `accept` attribute on `mobile.html` and the existing extension routing rejects wrong files with the toast "Unsupported file: {name} — …". Verified on devices in M4.
- **Photos library.** The iOS picker can offer the Photos library, which may hand over a converted JPEG instead of the RAW. Then the RAW decode fails with the existing error; the info sheet carries the hint to pick RAW files from Files (see "Info sheet").
- **Export.** On `mobile.html` Export NP3 first tries the system share sheet: build `new File([bytes], "<name>.NP3", { type: "application/octet-stream" })`; if `navigator.canShare?.({ files: [file] })` is true, call `navigator.share({ files: [file], title: "<name>.NP3" })` — the user can save it to Files, send it to a messenger or a camera companion app. `AbortError` (the user closed the sheet) is silent; any other error, or no Web Share support (Firefox Android, some Android browsers), falls back to the existing Blob + `<a download>` path (iOS asks to download, the file lands in Files › Downloads). The status reads "Shared: {name}" or "Exported: {name}". `index.html` keeps the plain download.
- **Copy link.** `navigator.clipboard.writeText` (works on the HTTPS deployment under a user tap). If it throws, the toast says so and the info sheet shows the link in a read-only, pre-selected text field with a "Share…" button that calls `navigator.share({ url })` when the API exists.
- **Drag and drop** does not exist on phones; `app.js`'s document drop handlers stay and are harmless.

## Start screen on mobile

> **Dropped 2026-11-20:** the mobile page is the standalone editor without a Start screen ([ui-pages.md](ui-pages.md)). The text below is kept for history; M0–M1 parts that served it (`#start-info` rendering, mobile Start ids) are not ported.

`mobile.html` has its own Start screen with the ids `start.js` and `app.js` use (`#raw-drop`, `#raw-file`, `#pairs`, `#start-status`, `#fit-name`, `#fit-name-err`, `#fit`).

- One column; the disclaimer and pair recommendations collapsed into a "Before you start" disclosure (open on the first visit).
- One zone, "Tap to choose RAW files" (new i18n string); min height 88 px. The JPEG is added per card ("Add JPEG", a picker — no drag-and-drop on touch). There is no `#target-drop` / `#target-file` (ui.md decision #7).
- Pair-card buttons ("Add JPEG" / "Replace JPEG", "Remove from fit"; the RAW-first cards of [ui.md](ui.md) decision #7) min 44 px; the name field and Fit button follow the mobile font and target rules.
- **One copy of the static texts:** the disclaimer and recommendation lists move from `index.html` markup into `start.js` (rendered into a `#start-info` container on both pages), so the two pages cannot drift apart.
- Safe-area padding and `100dvh` as in the editor. No other changes until the fitting stages of [ui-plan.md](ui-plan.md) land.

## Icons and licensing

- **Source:** only [Lucide](https://lucide.dev) icons, pinned to `lucide-static` 1.76.0. License: ISC; the icons Lucide inherited from Feather (in this spec: `plus`, `info`, `upload`, `download`, `link`, `x`, `check`, `chevron-left`, `external-link`) are additionally MIT (© Cole Bemis). Both notices are in the package `LICENSE`.
- **Used icons:** `plus`, `info`, `undo-2`, `upload`, `download`, `link`, `layers`, `sun`, `spline`, `focus`, `blend`, `palette`, `rotate-ccw`, `image-plus`, `x`, `check`, `chevron-left`, `external-link`. All names verified to exist in 1.76.0.
- **How:** the SVG markup is copied verbatim (24 × 24 viewBox, `stroke="currentColor"`, stroke-width 2) and inlined, as the desktop already does; each icon carries the comment `<!-- <name>, Lucide (ISC) -->`. JS-built buttons take the same markup from one map in `web/lib/icons.js`. No icon font, no CDN, no new npm dependency at runtime.
- **Obligations:** add `third_party/lucide/LICENSE` (the full package `LICENSE`, ISC + the Feather MIT block) and a Lucide row to [external.md](external.md). The desktop buttons already use Lucide icons, so this also covers them.
- **Not allowed:** icons, screenshots or other assets taken from any commercial app; brand marks as icons. Reference screenshots of other apps are not committed to the repository.

## Visual tokens (mobile additions)

| Token | Value |
|---|---|
| Base font | 14 px (desktop 13 px); inputs 16 px |
| Hit area minimum | 44 × 44 px (icon buttons, tabs, checkbox rows); 40 px for color dots |
| Top bar | 48 px portrait, 44 px landscape |
| Tool bar | 60 px portrait; icon-only grid in landscape |
| Tool panel | `clamp(200px, 38dvh, 360px)` portrait |
| Viewer background | `#000` |
| Palette | unchanged (`--bg`, `--panel`, `--line`, `--text`, `--dim`, `--accent`, `--bad`, `--ok`) |

## Implementation notes

- **Two shells, one core.** `index.html` and `mobile.html` are thin shells: markup + CSS. `app.js` and all of `web/lib/` are shared. The contract between a shell and the core is the **DOM id list** below; a shell may omit the optional ids, and the core must not crash on them (null-safe lookups in `app.js`).

  | Required (both pages) | Optional |
  |---|---|
  | `c`, `nogl`, `ba-slot`, `panel-scroll`, `panel-foot`, `curve-slot`, `blending-slot`, `grading-slot`, `file`, `info`, `warn`, `status`, `to-start`, `import`, `export`, `share`, `start-status`, `raw-drop`, `raw-file`, `target-drop`, `target-file`, `pairs`, `fit-name`, `fit-name-err`, `fit`, `start-info` | `drop` (desktop drop zone), `hotkeys`, `known` |

  The list is written down as a comment at the top of `app.js`; level 9 checks that `mobile.html` has every required id.
- **Shell options.** The page passes its differences through one object read by `app.js`: `<script>window.NP3_SHELL = { kind: "mobile" }</script>` before the module. `app.js` forwards it: `setupTransfer({ softDisable, shareExport })`, `createBeforeAfter({ hint: false })`, `createCurveEditor({ chartSlot })`, and imports `lib/mobile.js` only for `kind: "mobile"`.
- **`web/lib/mobile.js`** (mobile only): the tool bar and active tool, modified dots, the info sheet, the Reset confirmation, toasts, the empty state, the curve overlay visibility, keyboard visibility.
- **`web/lib/touch.js`** (shared): `onLongPress(el, { start, end, delay = 250, slop = 10 })`, `onDoubleTap(el, fn, { interval = 300, slop = 12 })`, and the horizontal-drag slider helper if M2 needs it. Pointer events only.
- **`web/lib/view-route.js`** (shared, classic synchronous script): the redirect rule and the manual switch helper.
- **CSS:** the shared rules now inline in `index.html` (palette variables, buttons, inputs, `.ctl`, `.tgl`, `.tabbtn`, range tracks and gradients, start-screen cards) move to `web/css/common.css`; `index.html` keeps its layout rules inline (or `web/css/desktop.css`); `mobile.html` uses `web/css/mobile.css`. The move must not change the desktop rendering (level 8 + a before/after screenshot comparison of the desktop page).
- Other module changes: `history.js` — `onChange` + `canUndo`; `transfer.js` — `softDisable`, `shareExport`, canonical share URL, clipboard fallback hook; `app.js` — `setStatus(text, kind)`, null-safe optional ids, `window.__np3app.mobile` for tests; `before-after.js` — the long-press path and `hint` option; `start.js` — the static texts.
- No new runtime dependencies; no framework. All new strings through `t()` / `data-i18n`, English only (AGENTS.md).
- **Tests and the router:** level 8 opens `index.html?view=desktop` and level 9 `mobile.html?view=mobile`, so the headless screen size never triggers a redirect; level 8 assertions stay unchanged. (Level 8 currently runs at the puppeteer default 800 × 600; the explicit `?view=desktop` keeps it on the desktop page regardless.)

## Performance and device limits

- WebGL2 with `EXT_color_buffer_float` is required as before; a phone without it gets the existing `#nogl` screen (its text must fit 360 px).
- RAW decoding holds the whole file plus the decoded frame in memory; 45 MP files on low-memory phones may crash the tab. The preview long side stays 1600 px; if M4 shows crashes, `mobile.html` lowers it to 1200 px (`loader.open(…, { long })`) — a measured decision, not a default.
- Slider drags must keep the desktop invariant "no repeated develop per frame" (renderer counters) and feel live: target ≥ 20 updates/s on a mid-range phone with the 17³ live LUT.
- The workers (RAW, LUT, pair) are unchanged.

## Accessibility

- Every icon-only button has an `aria-label`; the tool bar is a tablist; the info sheet is a modal dialog (`role="dialog"`, focus moves into it and back to Info on close).
- The page zoom is **not** disabled (`user-scalable` stays); double-tap zoom is suppressed only on controls via `touch-action: manipulation`.
- Contrast of `--dim` labels on `--panel` is unchanged from the desktop.

## Tests

### Automated: level 9 in `web/test.mjs`

Runs on the real `web/mobile.html?view=mobile` in headless Firefox (puppeteer-core), like level 8. Touch is driven by synthetic `PointerEvent`s with `pointerType: "touch"` (the approach the curve-editor tests already use), since touch emulation in the Firefox driver is limited.

1. DOM contract: `mobile.html` has every required id; the core starts without errors (console clean).
2. Viewport 390 × 844: top bar, viewer, tool panel and tool bar are visible and do not overlap; the page has no scroll (`scrollHeight == innerHeight`).
3. Viewport 360 × 640: nothing is cut off; the tool bar scrolls horizontally; every interactive element is ≥ 44 × 44 px (40 for color dots).
4. Viewport 844 × 390: the landscape two-column layout; rotating back keeps the profile, history and active tool.
5. Router (pure function of `view-route.js` in Node + two page loads): the override, the stored preference and the auto rule pick the expected page; the redirect keeps `?np3=` and the hash; `?view=` is removed after storing; no redirect loop.
6. Share link built on `mobile.html` points to the directory URL, not `mobile.html`; the manual switch carries the current profile as `?np3=`.
7. Tool bar: tapping each tool shows only its group; the default is Basic; the modified dot appears after a slider change and disappears after Reset.
8. Undo: disabled on start, enabled after a change, restores the previous value.
9. Reset: the dialog opens; Cancel/scrim/Escape change nothing; Reset neutralizes the profile and keeps the name; Undo restores it.
10. Long-press on the canvas (synthetic pointerdown, wait 300 ms, pointerup): `state.showNeutral` goes true then false; a 5 px move stays a long-press, a 20 px move cancels it; no LUT is built for "before" (`stats.luts` unchanged).
11. Double-tap on a slider row resets it to its default; a single tap does not change the value.
12. Invalid name → Export/Copy link are `aria-disabled`; a tap shows the toast, switches to Profile and focuses the name field; no file is produced.
13. Export with a stubbed `navigator.canShare`/`share`: the share path gets one `.NP3` file with the right bytes; `AbortError` is silent; a rejected share and missing Web Share fall back to the download.
14. Curve: turning the curve on in the Curve tool shows the chart over the viewer; a tap on an empty spot adds a point; dragging a point changes `control.curve`; leaving the tool hides the overlay.
15. Info sheet: opens and closes (button, scrim, Escape); "Back to Start" works.
16. Toasts: an import error stays ≥ 6 s, an info status hides after ~3 s, "unpacking…" stays until replaced.
17. Level 8 on `index.html?view=desktop` with unchanged assertions stays green, and a screenshot of the desktop page matches the one before the CSS move.

### Manual checklist on devices (M4)

Run on: iPhone (iOS 17+, Safari), an Android mid-range phone (Chrome), an iPad (Safari; expected: the desktop page in both orientations). Record the results in the plan log.

- Open a NEF and a DNG from Files / the file manager; pick from the iOS Photos library and confirm the expected error/hint.
- The auto redirect on first open (phone → mobile, iPad → desktop), the manual switch both ways, a share link from the phone opened on a PC and vice versa.
- NP3 import from Files (are `.NP3` files greyed out?); export through the share sheet (Save to Files, a messenger) and the download fallback; the share link opens the profile in another browser.
- Slider drags are live; vertical scrolling over sliders never changes values; double-tap resets; the number keyboard has a minus sign.
- Long-press before/after; no system context menu, no text selection, no page zoom.
- Reset asks for confirmation; Cancel keeps everything.
- Curve: adding, dragging, deleting points with a finger.
- Blender dots and the grading wheel with a finger.
- Rotate the phone during editing; open the keyboard on the name field; check the notch/home-indicator areas.
- A 45 MP RAW on the lowest-memory device available: no tab crash (otherwise apply the 1200 px rule).

## Acceptance criteria

1. A phone opening the app (directly or by a share link) lands on `mobile.html`, a desktop or tablet on `index.html`; the `?np3=` profile survives the redirect; the user can switch versions manually.
2. On `mobile.html` (360–930 px wide, both orientations) the editor shows the top bar, photo, a single-tool panel and the icon tool bar; the page does not scroll and nothing overlaps the safe areas.
3. Add and Info are on the left of the top bar; Undo, Import NP3, Export NP3 and Copy link are icon buttons on the right.
4. Every desktop function is reachable by touch alone: open RAW, import/export NP3 (with the share sheet where supported), copy link, undo, reset with confirmation, before/after, all six tools including curve points, blender colors and the grading wheel, back to Start.
5. All icons are Lucide (ISC/MIT), the license file and the external.md row are added, no other icon sources are used.
6. The desktop page looks and behaves as before; level 8 and level 9 are green.
7. The manual device checklist passes on iOS Safari and Android Chrome, or each failure is recorded with a decision.

## Implementation stages

The detailed plan for agent development (contracts, tasks by file, tests per stage, log): [ui-mobile-plan.md](ui-mobile-plan.md).

| Stage | Content | Done when |
|---|---|---|
| M0. Core prep | null-safe optional ids and the DOM contract in `app.js`; `window.NP3_SHELL` options; `css/common.css` extracted from `index.html`; static start texts into `start.js`; `view-route.js` + canonical share URL; Lucide license files; level 8 on `?view=desktop` | level 8 green, desktop screenshot unchanged, router tests green |
| M1. Shell | `mobile.html` + `mobile.css` + `mobile.js`: top bar, Undo (`history.js`), tool bar + single-group panel, Reset confirmation, info sheet with the version switch, toasts, empty state, Start screen | level 9 items 1–9, 15, 16 green |
| M2. Touch | `touch.js`; long-press before/after; double-tap reset; slider rows (sizes, vertical-scroll rule, number fields, keyboard visibility); `aria-disabled` export; share-sheet export | items 10–13 green; slider behavior checked on one iOS and one Android device |
| M3. Tools | Curve overlay with touch points; Blender dots; Grading wheel; modified dots; landscape layout | item 14 green, item 4 green |
| M4. Devices | the full manual checklist, picker `accept` decision, memory decision (1600 / 1200 px), fixes | checklist recorded, acceptance criteria met |

## Decisions (2026-11-19)

1. **Curve over the photo**, not in the panel: in the panel the chart would need ~60dvh and squeeze the photo into a strip; over the photo the frame stays full size and is visible through the chart.
2. **Web Share export** on phones, with the download as the fallback.
3. **Reset resets the whole profile** and asks for confirmation on `mobile.html`.
4. **A separate page `mobile.html`** with a load-time redirect instead of one adaptive page: the desktop page and its tests stay untouched, the mobile markup is not constrained by the desktop one, and no elements are moved between layouts at runtime. The JS core is shared through the DOM id contract, so logic is not duplicated.

## Open questions

1. **Tablets.** The auto rule sends tablets (short screen side ≥ 600 px) to the desktop page; an iPad in portrait then gets the existing narrow-window stacking of `index.html`. If that is uncomfortable, either move tablets in portrait to `mobile.html` or improve the desktop page's narrow rule — a separate decision after M4.
