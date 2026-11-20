# AGENTS.md

## Language

Everything in this repository is written in **English**: code, comments,
docstrings, commit messages, specs and UI strings. Write all new code and
comments in English only — no Russian (or other non-English) text, including
printouts and error messages. The one exception is UI translation dictionaries for
`web/lib/i18n.js` (today only `web/lib/i18n-landing-ru.js`, the Russian landing).

## Project

np3-fit infers and emulates Nikon Flexible Color picture control (NP3)
profiles. A Python pipeline fits profile parameters against real NX Studio
renders; `web/` is a browser port of the same pipeline (WASM raw decoder +
WebGL) that applies and exports NP3 profiles.

## Layout

- `np3.py` — NP3 binary format (de)serialization, bit-exact against Nikon samples
- `color.py`, `model.py`, `devmodel.py`, `profile_model.py`, `detail.py`,
  `ceiling.py`, `vignette.py`, `wbmap.py` — color science and response models
- `fit.py` — shared fitting core (parameter packing, LM solver)
- `match.py` — fits an NP3 profile to target renders; `analyze.py` — candidate
  scoring helpers used by `match.py`
- `render.py`, `rawdev.py`, `pairs.py`, `devpairs.py`, `scene.py`,
  `strength.py`, `make_pack.py` — development/rendering and packaging tools
- `sweep.py` — exports/measures NX Studio response sweeps (training data prep)
- `web/` — browser app (`lib/` JS pipeline, `raw/` Rust→WASM decoder,
  `model/` exported weights, `golden/` reference fixtures for `test.mjs`). Pages
  (`spec/ui-pages.md`): `index.html` (landing, English + Russian via `lib/i18n-landing-ru.js`), `picture-control-jpg-fit.html` (fitting
  wizard, `lib/fit-app.js`), `picture-control-editor.html` and
  `picture-control-editor-mobile.html` (profile editor, `lib/editor-app.js`); both entries
  build on `lib/editor-core.js`
- `data/` — committed model weights (`*_model.npz`) and small fixtures
- `spec/` — design docs and test rules

## Local-only data (gitignored)

`_local/` (raw photos, sweep exports, aligned pairs, check renders), `out/`
(fitted profiles and packs), `renders/` (NX Studio renders and target
exports).
Pipeline scripts that fit or validate models (`sweep.py`, `match.py`,
`profile_model.py`, `detail.py`, `render.py` on real files) need this data
present locally; a fresh clone only supports the tests below.

## Tests

- `python3 test_np3.py` — NP3 round-trip against official samples (always runs)
- `cd web && node test.mjs` — full browser pipeline suite (needs Firefox and
  `puppeteer-core` from `web/node_modules`); levels 1/1a/8 additionally need
  the raw files in `_local/` and are skipped otherwise
- `python3 web/export_model.py` — re-export `web/model/` from `data/*.npz`
