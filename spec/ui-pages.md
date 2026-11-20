# Pages: landing, fitting wizard, profile editor

Decision 2026-11-20 (user). Status: specification, not implemented. Supersedes the single-page layout where `web/index.html` hosted both the fitting flow and the standalone editor, and the page names of [ui-mobile.md](ui-mobile.md) (`index.html` / `mobile.html`).

## Two flows, four pages

Fitting a profile to JPEG targets and editing an NP3 on a RAW are **different flows on different pages**. They share the JS pipeline (`web/lib/`) and the editor modules, never a session.

| Page | Flow | Devices | Router |
|---|---|---|---|
| `web/index.html` | **Landing**: leads to the wizard or the editor. Content and design: to be discussed later | any | forwards legacy `?np3=` links (below) |
| `web/picture-control-jpg-fit.html` | **Fitting wizard**: [ui.md](ui.md) steps 1 → 2 → 3.1 → 3.2 (Start, Compare, manual adjustment with the report, More frames), versions, NP3 export | desktop only | none |
| `web/picture-control-editor.html` | **Profile editor, desktop**: open a RAW, import/edit/export/share an NP3 | desktop, laptop, tablet | `view-route.js` → mobile on phones |
| `web/picture-control-editor-mobile.html` | **Profile editor, mobile**: the same editor in the [ui-mobile.md](ui-mobile.md) layout | phones | `view-route.js` → desktop elsewhere |

## Fitting wizard (`picture-control-jpg-fit.html`)

- Everything of [ui.md](ui.md): the RAW-first pair cards (decision #7), Compare (decision #8), the manual adjustment step 3.1 with the fitted baseline, the report beside it and the leave warning, More frames, refit, versions, strength, Save NP3 (no strength set — [ui.md](ui.md) decision #10).
- Step 3.1 stays inside the wizard. It is not the profile editor page: it edits a fitted version against its targets (report, reset to the fitted version, back to refitting). There is no "Open in the editor" hand-off; a user who wants the standalone editor saves the NP3 and imports it there.
- **No NP3 import** in the wizard: profiles enter it only through a fit. The page-level drop router accepts only RAW files (cards) and JPEGs dropped on a card.
- **Share link** in step 3.1 is optional; if present it builds the editor link (`picture-control-editor.html?np3=…`, see "Share links"), never a wizard link — the wizard has no URL state.
- **Desktop only.** No mobile layout, no router. On a phone (the router's auto rule: `pointer: coarse` and the short screen side < 600 px) the page opens as is with a non-blocking banner: "Fitting is designed for a desktop: it takes minutes of CPU and several hundred MB of memory." The banner can be closed; nothing is stored.

## Profile editor (`picture-control-editor.html` / `-mobile.html`)

- The editor of [ui-manual-mvp.md](ui-manual-mvp.md) (+ UI-2): open one RAW (picker or drop), all NP3 tools, strength, before/after, undo, NP3 import / export / share link (no strength set, ui.md decision #10). Reset goes to the **neutral defaults** (the standalone semantics of [ui.md](ui.md) decision #2, now living on this page only).
- **No pairs, no JPEG targets, no fit, no report, no versions.** The page has no Start screen: it opens straight into the editor with the empty state ("Open a RAW to see the profile"); an NP3 can be imported and edited before any RAW is opened, as today.
- A dropped JPEG gets the status "JPEG targets are used by the fitting wizard" with a link to `picture-control-jpg-fit.html`.
- The mobile page is the M0–M3 implementation of [ui-mobile-plan.md](ui-mobile-plan.md) (branch `mobile`, `_local/_cloud_transfer/mobile.bundle`) **without its Start screen**: the "Start screen on mobile" section of ui-mobile.md and the Start parts of level 9b are dropped.

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

To be discussed. Until then: a minimal page with the title, two links ("Fit a profile to JPEGs" → the wizard, "Edit an NP3 profile" → the editor) and the legacy `?np3=` forward. No model download, no WASM, no workers on this page.

## Code structure

`web/lib/app.js` today orchestrates both flows (`state.step`: start | compare | edit | more, plus the standalone editor). It is split by entry point; modules below the orchestration are not changed by the split itself.

| Module | Role | Used by |
|---|---|---|
| `lib/editor-core.js` (new, extracted from `app.js`) | renderer + LUT worker, loader, panels, curve editor, blender, grading, history, before/after, transfer, `renderCurrent`, `setStatus(text, kind)`, the `NP3_SHELL` options | both entries |
| `lib/editor-app.js` (new) | the editor pages: one RAW, NP3 import/export/share, neutral reset, the page drop router (RAW / NP3; JPEG → hint) | `picture-control-editor*.html` |
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

1. Landing content and design (to be discussed).
2. Whether the wizard's step 3.1 keeps "Share link" at all, or only Save NP3.
