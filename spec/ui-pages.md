# Pages: landing, fitting wizard, profile editor

Decision 2026-11-20 (user). Status: specification, not implemented. Supersedes the single-page layout where `web/index.html` hosted both the fitting flow and the standalone editor, and the page names of [ui-mobile.md](ui-mobile.md) (`index.html` / `mobile.html`).

## Two flows, four pages

Fitting a profile to JPEG targets and editing an NP3 on a RAW are **different flows on different pages**. They share the JS pipeline (`web/lib/`) and the editor modules, never a session.

| Page | Flow | Devices | Router |
|---|---|---|---|
| `web/index.html` | **Landing**: what the tools do, with real samples; leads to the wizard or the editor. EN / RU / DE / FR | any | forwards legacy `?np3=` links (below) |
| `web/picture-control-jpg-fit.html` | **Fitting wizard**: [ui.md](ui.md) steps 1 → 2 → 3.1 → 3.2 (Start, Compare, manual adjustment with the report, More frames), versions, NP3 export | desktop only | none |
| `web/picture-control-editor.html` | **Profile editor, desktop**: open a RAW, import/edit/export/share an NP3 | desktop, laptop, tablet | `view-route.js` → mobile on phones |
| `web/picture-control-editor-mobile.html` | **Profile editor, mobile**: the same editor in the [ui-mobile.md](ui-mobile.md) layout | phones | `view-route.js` → desktop elsewhere |

## Fitting wizard (`picture-control-jpg-fit.html`)

- Everything of [ui.md](ui.md): the RAW-first pair cards (decision #7), Compare (decision #8), the manual adjustment step 3.1 with the fitted baseline, the report beside it and the leave warning, More frames, refit, versions, strength, Save NP3 (no strength set — [ui.md](ui.md) decision #10).
- Step 3.1 stays inside the wizard. It is not the profile editor page: it edits a fitted version against its targets (report, reset to the fitted version, back to refitting). There is no "Open in the editor" hand-off; a user who wants the standalone editor saves the NP3 and imports it there.
- **No NP3 import** in the wizard: profiles enter it only through a fit. The page-level drop router accepts only RAW files (cards) and JPEGs dropped on a card.
- **Share link** stays in step 3.1 (decided 2026-11-20): it copies the editor link `picture-control-editor.html?np3=…` with the current profile (see "Share links"), never a wizard link — the wizard has no URL state. The link opens the profile in the standalone editor; the pairs, versions and report are not part of it.
- **Languages** (decided 2026-11-20): EN / RU / DE / FR, the rules of "Profile editor" → "Languages".
  `lib/fit-app.js` registers the editor dictionaries (the shared modules, the quick editor) and
  `lib/i18n-fit-{ru,de,fr}.js` (the wizard's own strings, no editor key repeated). Two globes, each right
  of a GitHub icon (the bottom one after (i)): at the top of the Start screen (the menu opens downwards) and at the bottom of
  the wizard panel on Compare and in the quick editor (it opens upwards, as in the profile editor;
  decided 2026-11-24, superseding "Start only"). A switch re-translates the static texts,
  re-renders the Start cards, the Compare strip, the coverage, the Refit button, the canvas labels
  and the report; the session, a running fit and the quick editor are untouched. The colour groups
  of the coverage and the report table are translated (keys = `analyze.GROUPS`; the narrow tables
  show a `"<group>|short"` name kept on one line, e.g. RU «тёпл. насыщ.», the full one as the
  tooltip; a context key without a translation falls back to its plain key's), so are the report
  parameter rows ("Red Hue" …). Plural strings ("{n} pairs will be fitted", the Refit sub-label)
  use `{ one, few, many, other }` translations.
- **Layout** (decided 2026-11-24): Compare and the quick editor use the profile editor's three
  columns — 260 px left, the viewer, 380 px right; both side columns are `--panel` with a
  `--line` border. The left column is the wizard panel `#cmp-sidepanel` at full height, ordered
  like the editor's `#files`: the project name (see "Project name"), the title "Fitting wizard"
  with a one-line explanation, the status, the colour coverage; at the bottom the actions
  stacked as the editor's file buttons (an icon before the label: Manual adjustments, Revert to
  fit, Download NP3 — still the primary button — and Copy link to the profile editor), then the
  icon row (i) / GitHub / language. The hotkeys are not shown in the column: (i) opens them in a
  small panel above it (`lib/info-pop.js`; Escape or a click outside closes it). The middle
  column keeps the pair strip with Refit, the mode / strength bar, the canvas and under it the
  editor's caption "Approximate calculation in the browser — not an exact NX Studio render."; the
  right column is the report (Compare) or the parameter panel (quick editor). The Start screen keeps its centred column, with the project
  name above the title.
- **Desktop only.** No mobile layout, no router. On a phone (the router's auto rule: `pointer: coarse` and the short screen side < 600 px) the page opens as is with a non-blocking banner: "Fitting is designed for a desktop: it takes minutes of CPU and several hundred MB of memory." The banner can be closed; nothing is stored.

## Profile editor (`picture-control-editor.html` / `-mobile.html`)

- The editor of [ui-manual-mvp.md](ui-manual-mvp.md) (+ UI-2): open one RAW (picker or drop), all NP3 tools, strength, before/after, undo, NP3 import / export / share link (no strength set, ui.md decision #10). Reset goes to the **neutral defaults** (the standalone semantics of [ui.md](ui.md) decision #2, now living on this page only).
- **No pairs, no JPEG targets, no fit, no report, no versions.** The page has no Start screen: it opens straight into the editor with the empty state ("Open a RAW to see the profile"); an NP3 can be imported and edited before any RAW is opened, as today.
- A dropped JPEG gets the status "JPEG targets are used by the fitting wizard" with a link to `picture-control-jpg-fit.html`.
- The mobile page is the M0–M3 implementation of [ui-mobile-plan.md](ui-mobile-plan.md) (branch `mobile`, `_local/_cloud_transfer/mobile.bundle`) **without its Start screen**: the "Start screen on mobile" section of ui-mobile.md and the Start parts of level 9b are dropped.

- **Columns** (desktop): 260 px left (`#files`), the viewer, 380 px right (`#panel`) — the wizard's
  widths (decided 2026-11-24; the right panel was 330 px).
- **Left column** (desktop, decided 2026-11-24): the project name, the title, Files (drop zone,
  frame info), the status; at the bottom the known limitations, the file buttons (Import /
  Export NP3, Copy link) and the icon row (i) / GitHub / language. The hotkeys sit behind (i), as
  in the wizard.

### Project name

Decided 2026-11-24. The desktop editor and the wizard show the project name at the top of the
left column (on the wizard's Start screen: at the top of the page, left of GitHub and the
globe): the landing's logo (its dark-theme colours) and "Picture Control Buddy", one link to the
landing `index.html` (tooltip "Picture Control Buddy — home page"). The name is not translated.
Styles: `css/brand.css`, linked by both pages. The mobile editor has none yet.

### Languages

Decided 2026-11-20. The editor pages speak the landing's languages: English, Russian, German, French.

- **Dictionaries:** `lib/i18n-editor-{ru,de,fr}.js` (one key set), registered by `lib/editor-app.js`
  before the editor core builds the panel. They cover both pages and every editor module they load
  (the panel, curve, Color Blender, Color Grading, before/after, transfer, marks, the mobile shell).
  The wizard registers them too, with its own `lib/i18n-fit-*` (see "Fitting wizard").
- **Choice:** the landing's rule — the stored `lang` (shared with the landing), otherwise the
  browser's first known preference (`navigator.languages`), otherwise English (`i18n.js initLang`;
  an automatic pick is not stored). `lib/i18n-boot.js` hides the page until it is applied.
- **Picker:** a globe icon button right of the GitHub icon (both icons only, no captions; their
  names are the tooltip and the aria-label) — desktop at the bottom of the left column, mobile in the
  Info sheet above "Desktop version". It opens a menu of the endonyms, the current one checked, as
  on the landing (`lib/lang-select.js`; arrows, Escape, a click outside closes). A switch is stored
  and applied at once, without a reload (the opened RAW and the history stay): every text carries
  `data-i18n*` (with `data-i18n-title` and `data-i18n-vars` for titles and `{var}` strings) and is
  re-translated in place; the status line is re-translated too when it is one t() output (i18n.js
  remembers the key and vars of its recent outputs); a status glued from several parts (a file
  name + a decoder error) keeps its language until the next one. The language styles (the hidden
  page, the icons, the menu) are `css/i18n.css`, linked by all three app pages.
- **Wording:** RU «ты», DE «du», FR «vous», as on the landing. The NX Studio panel names Basic,
  Curve, Color Blender, Color Grading (and the mobile tool bar's Blender, Grading) stay English;
  the slider labels inside them are translated. A label that needs a shorter word in one place uses
  a context key (`"Reset|toolbar"`: the mobile tool bar's Reset; English shows "Reset").
- **Tests:** level 1k (`web/test-node-i18n.mjs`) checks the key sets and that every key the pages
  use is translated; the browser levels pin the browser language to English.

### Redirect between the two editor pages

`web/lib/view-route.js` as specified in [ui-mobile.md](ui-mobile.md) "Two pages and the redirect", with the page names changed:

- `PAGES = { desktop: "picture-control-editor.html", mobile: "picture-control-editor-mobile.html" }`;
- included first in `<head>` of **these two pages only** (not in the landing, not in the wizard);
- the same rule order (`?view=` override → stored `np3view` → auto by screen), `location.replace()` with the same `search` and `hash`, redirect only at load;
- the manual switch ("Desktop version" / "Mobile version") navigates between these two pages with the current profile as `?np3=`.

### Share links

`shareLink()` builds `picture-control-editor.html?np3=…` on the directory of the current page (`new URL("picture-control-editor.html", location.href)`), from either editor page and from the wizard. Opened on a phone, the router moves it to the mobile page with `?np3=` intact.

**Legacy links:** links already shared as `…/web/?np3=…` or `…/web/index.html?np3=…` keep working: the landing, when its URL has `np3=`, does `location.replace("picture-control-editor.html" + search + hash)` before rendering anything (the editor page's router then picks desktop or mobile). This is the only logic the landing needs before its own design is settled.

## Landing (`index.html`)

Decided 2026-11-20 (supersedes the "title and two links" stage of the same day). A one-page landing
for photographers, not engineers: plain words, few of them.

- **Sections:** hero (headline, the two entry CTAs, a neutral / profile before-after curtain);
  "From your edits" (three steps and a frame picker: the source NEF, then a curtain NEF + NP3 vs the
  target JPEG with the frame's dE2000 from the wizard report); "By hand" (a carousel of real editor
  screenshots, desktop and phone, and the four tool groups); "Into the camera" (save, copy to
  `NIKON/CUSTOMPC/`, load via Manage Picture Control); FAQ; the author block (GitHub, Ko-fi); the
  trademark notice.
- **Entry links:** `#to-fit` → `picture-control-jpg-fit.html`, `#to-editor` → `picture-control-editor.html`.
- **Wording:** "NEF", not "RAW"; "any NEF" carries a footnote that High Efficiency NEFs (HE / HE★)
  must be converted to DNG without JPEG XL first.
- **Samples:** `web/landing/` (600×900 frames, editor screenshots). They come from one wizard fit
  ("SA") over 8 NEF + Lightroom JPEG pairs; the per-frame dE2000 is a constant in the page.
- **Languages:** English, Russian, German and French. The strings go through
  `lib/i18n.js` (`data-i18n`, `data-i18n-aria`, `data-i18n-alt`, `t()`); the dictionaries
  `lib/i18n-landing-{ru,de,fr}.js` (one key set) are registered by the landing alone (the editor
  pages have their own, see "Profile editor" → "Languages" and "Fitting wizard" → "Languages"). A globe button next to the GitHub icon opens the language menu (endonyms,
  the current one checked); the choice is stored as `lang`. With no stored choice the browser's
  first known preference (`navigator.languages`) wins. The page is hidden until the language is
  applied (no English flash). Numbers follow the language (2.1 / 2,1).
- **Weight:** no model download, no WASM, no workers, no third-party requests (system fonts only).
- The invisible legacy `?np3=` forward above runs first, before anything renders.

## Code structure

`web/lib/app.js` today orchestrates both flows (`state.step`: start | compare | edit | more, plus the standalone editor). It is split by entry point; modules below the orchestration are not changed by the split itself.

| Module | Role | Used by |
|---|---|---|
| `lib/editor-core.js` (new, extracted from `app.js`) | renderer + LUT worker, loader, panels, curve editor, blender, grading, history, before/after, transfer, `renderCurrent`, `setStatus(text, kind)`, the `NP3_SHELL` options | both entries |
| `lib/editor-app.js` (new) | the editor pages: one RAW, NP3 import/export/share, neutral reset, the page drop router (RAW / NP3; JPEG → hint) | `picture-control-editor*.html` |
| `lib/editor-zoom.js` (new) | the desktop editor's 100% zoom: overlay canvas over `#c`, the detailed ROI layer, Fit / 100% overlay, Z / 0 keys ([ui-zoom-plan.md](ui-zoom-plan.md) "Profile editor"); plugs in through the optional `hooks.onDrawn` / `hooks.onFrame` of the core | `picture-control-editor.html` only |
| `lib/fit-app.js` (new, the rest of today's `app.js`) | the wizard: session, `start.js`, `compare-view.js`, `report-view.js`, `more-view.js`, fit/pair/report workers, versions, baseline, leave warning; step 3.1 mounts the editor core | `picture-control-jpg-fit.html` |
| `lib/view-route.js` | router (new page names) | editor pages |
| `css/common.css`, `css/mobile.css` | from M0/M1 of the mobile branch; the wizard and the desktop editor link `common.css` and keep their own layout inline | all but the landing |

Each page has its own DOM id contract (the M0 table of ui-mobile-plan.md split by page). `window.__np3app` stays the test entry on every page and exposes only what that page has.

## Tests

- Level 8 / 8b (the full flow) open `picture-control-jpg-fit.html`; their standalone-editor checks move to a new level on `picture-control-editor.html`.
- Levels 9a–9d open the editor pages (`?view=` as before); the router tests use the new `PAGES`; 9b loses the mobile Start-screen checks.
- New checks: the landing forwards `index.html?np3=…` and `/web/?np3=…` to `picture-control-editor.html` with search and hash intact (and on to the mobile page under a stored `mobile` preference); the landing loads no WASM/model/worker; the wizard on an emulated phone shows the banner and does not redirect; `shareLink()` from all three app pages ends with `/web/picture-control-editor.html?np3=…`; a JPEG dropped on an editor page does not start a decode and shows the hint.
- The static test server's `/` → `index.html` mapping stays (for the legacy-link test).

## Order of work

See [ui-plan.md](ui-plan.md) stage 11. In short: split `app.js` into the editor core and two entries on the current branch first (desktop editor page + wizard page, level 8/8b green); then port the mobile branch (M0–M3) onto the split with the new page names and without its Start screen; the landing last, once its content is agreed.

## Open questions

1. ~~Landing content~~ Resolved 2026-11-20: see "Landing" above.
2. ~~Whether the wizard's step 3.1 keeps "Share link"~~ Resolved 2026-11-20: it stays and leads to the editor.
