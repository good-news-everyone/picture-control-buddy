// Level 1k (spec/web-tests.md): the UI translation dictionaries (lib/i18n.js), Node, no browser.
// Per page family — the landing (index.html, lib/i18n-landing-*.js), the profile editor
// (picture-control-editor*.html + the modules reachable from lib/editor-app.js,
// lib/i18n-editor-*.js) and the fitting wizard (picture-control-jpg-fit.html + the modules
// reachable from lib/fit-app.js; lib/i18n-editor-*.js and lib/i18n-fit-*.js together):
//  - the ru / de / fr dictionaries have one key set, no empty value, and every translation keeps
//    the {placeholders} of its key (each plural form of a { one, few, many, other } value);
//  - the wizard's own dictionary repeats no editor key (one translation per string);
//  - every key the pages use literally (data-i18n* attributes, t("…"), dataset.i18n* = "…",
//    i18nSet(…, "…"), markButton / resetButton / slider / group labels) and the labels the editor
//    modules keep in tables (INDIRECT below, the Color Blender colours from np3.COLORS) is
//    translated (the wizard's tables: INDIRECT_FIT, the report TIPS, the report parameter rows,
//    the colour groups from analyze.GROUPS);
//  - no dictionary key is stale: each one still occurs as a string literal in the family's sources.
// Exports the level in the web/test-node.mjs style ({ report, skip }); also standalone:
//
//     node web/test-node-i18n.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const LANGS = ["ru", "de", "fr"];

// Editor labels that reach t() through a variable: the tables of panels.js (BASIC, DETAIL),
// grading.js (ZLABEL), blending.js (TABS, MODE_*), mobile.js (TOOLS), curve-editor.js (L),
// before-after.js and editor-core.js (ERRORS). "x" / "y" (the curve point fields) stay as is.
const INDIRECT = [
  "Saturation", "Contrast", "Highlights", "Shadows", "White level", "Black level",
  "Sharpening", "Mid-range sharpening", "Clarity", "Midtones",
  "Hue", "Luminance", "All", "HSL", "Color",
  "Profile", "Basic", "Curve", "Details", "Blender", "Grading",
  "Custom curve", "Delete point", "A curve can have at most 20 points", "Point {n}",
  "When the curve is used, Contrast, Highlights, Shadows, White level and Black level are disabled — you can't use both. This is an NP3 format limitation.",
  "Before — neutral", "After — NP3", "Hold Space to compare with neutral",
  "NEF High Efficiency compression is not supported", "Only Bayer-sensor files are supported",
  "Failed to decode the file", "The RAW unpacker (WASM) failed to initialize",
];

// The wizard's labels that reach t() through a variable: start.js (PREP_STEPS, metaRow),
// report-view.js (kv, grp, PARAM_SECTIONS titles, COLS, swatch), the editor labels the report
// reuses come from INDIRECT.
const INDIRECT_FIT = [
  "Waiting for the previous pair", "Reading the RAW", "Lens correction: vignetting", "Geometry: crop",
  "Geometry: orientation", "Lens correction: distortion", "Aligning with the JPEG", "Finishing",
  "RAW", "Target", "Camera", "Frames", "Alignment",
  "Strength", "Render vs target", "Neutral vs target", "Bin mean", "Vs fitted",
  "Error map", "Summary", "Color match", "NP3 parameters",
  "Basic", "Details", "Color Blender", "Color Grading", "Group", "Share", "Color", "Render",
  "Saturation", "Contrast", "Highlights", "Shadows", "White level", "Black level",
  "Sharpening", "Mid-range sharpening", "Clarity", "Blending", "Balance", "Curve",
];

const read = (f) => readFileSync(path.join(HERE, f), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|[\s;{}(),])\/\/.*$/, "$1")).join("\n");
const unq = (q, body) => (q === '"' ? JSON.parse(`"${body}"`) : body.replace(/\\(.)/g, "$1"));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

// modules reachable from an entry through static and dynamic relative imports
function moduleGraph(entry) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = stripComments(read(rel));
    for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.\.?\/[^"']+\.js)["']/g))
      walk(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  };
  walk(entry);
  return [...seen].filter((f) => !/\/i18n-(landing|editor)-\w+\.js$/.test(f));
}

const LIT = String.raw`(["'\x60])((?:\\.|(?!\1)[^\\])*?)\1`;
const JS_PATTERNS = [
  new RegExp(String.raw`\bt\(\s*` + LIT, "g"),
  new RegExp(String.raw`dataset\.i18n(?:Aria|Title|Ph|Alt)?\s*=\s*` + LIT, "g"),
  new RegExp(String.raw`"data-i18n(?:-aria|-title|-ph|-alt)?"\s*:\s*` + LIT, "g"),
  new RegExp(String.raw`\bi18nSet\([^,()]+,\s*"\w+",\s*` + LIT, "g"),
  new RegExp(String.raw`\b(?:markButton|resetButton)\(\s*` + LIT, "g"),
  new RegExp(String.raw`\bslider\([^,()]+,\s*` + LIT, "g"),
  new RegExp(String.raw`\bgroup\(\s*` + LIT, "g"),
];
function usedKeys(htmlFiles, jsFiles) {
  const keys = new Set();
  const add = (k) => { if (!k.includes("${")) keys.add(k); };
  for (const f of htmlFiles) {
    const s = read(f);
    for (const m of s.matchAll(/data-i18n(?:-ph|-aria|-alt|-title)?="([^"]+)"/g)) add(m[1]);
    for (const m of stripComments(s).matchAll(new RegExp(String.raw`\bt\(\s*` + LIT, "g"))) add(unq(m[1], m[2]));
  }
  for (const f of jsFiles) {
    const s = stripComments(read(f));
    for (const re of JS_PATTERNS) for (const m of s.matchAll(re)) add(unq(m[1], m[2]));
    for (const m of s.matchAll(/data-i18n(?:-ph|-aria|-alt|-title)?="([^"$]+)"/g)) add(m[1]);
  }
  return keys;
}

const loadDicts = async (prefix) => Object.fromEntries(await Promise.all(LANGS.map(async (l) =>
  [l, (await import(pathToFileURL(path.join(HERE, `lib/${prefix}-${l}.js`)).href)).default])));

// extra — keys used through a variable; derived — those of them built in code (no literal);
// basePrefix — a dictionary the page registers too (the wizard reuses the editor's)
async function family(ctx, name, { htmlFiles, jsFiles, dictPrefix, basePrefix = null, extra = [], derived = [] }) {
  const { report } = ctx;
  const dicts = await loadDicts(dictPrefix);
  const base = basePrefix ? await loadDicts(basePrefix) : null;
  if (base) {
    const dup = Object.keys(dicts.ru).filter((k) => k in base.ru);
    report(!dup.length, `1k ${name}: no key of ${basePrefix} repeated${dup.length ? ` — ${JSON.stringify(dup)}` : ""}`);
  }
  const ref = Object.keys(dicts.ru).sort();

  for (const l of LANGS) {
    const keys = Object.keys(dicts[l]).sort();
    const missing = ref.filter((k) => !(k in dicts[l])), extraKeys = keys.filter((k) => !(k in dicts.ru));
    report(!missing.length && !extraKeys.length,
      `1k ${name}: ${l} has the key set of ru (${keys.length} keys)` +
      `${missing.length ? `; missing ${JSON.stringify(missing)}` : ""}${extraKeys.length ? `; extra ${JSON.stringify(extraKeys)}` : ""}`);
    const forms = (v) => (v && typeof v === "object" ? Object.values(v) : [v]);
    const bad = Object.entries(dicts[l]).filter(([k, v]) => forms(v).some((f) =>
      typeof f !== "string" || !f.trim() || placeholders(k) !== placeholders(f)));
    report(!bad.length, `1k ${name}: ${l} values are non-empty and keep the {placeholders} of their keys` +
      `${bad.length ? ` — ${JSON.stringify(bad.map(([k]) => k))}` : ""}`);
  }

  const used = usedKeys(htmlFiles, jsFiles);
  for (const k of extra) used.add(k);
  for (const l of LANGS) {
    const untranslated = [...used].filter((k) => !(k in dicts[l]) && !(base && k in base[l])).sort();
    report(!untranslated.length, `1k ${name}: every used key is in ${l} (${used.size} keys)` +
      `${untranslated.length ? ` — missing ${JSON.stringify(untranslated)}` : ""}`);
  }

  const sources = [...htmlFiles, ...jsFiles].map(read).join("\n");
  const stale = ref.filter((k) => !derived.includes(k) && ![`"${k}"`, `'${k}'`, `\`${k}\``, JSON.stringify(k)].some((q) => sources.includes(q)));
  report(!stale.length, `1k ${name}: no stale dictionary key${stale.length ? ` — ${JSON.stringify(stale)}` : ""}`);
}

export async function level1k(ctx) {
  await family(ctx, "landing", { htmlFiles: ["index.html"], jsFiles: [], dictPrefix: "i18n-landing" });
  const { COLORS } = await import("./lib/np3.js");
  const colorNames = COLORS.map((c) => c[0].toUpperCase() + c.slice(1));   // blending.js cap()
  await family(ctx, "editor", {
    htmlFiles: ["picture-control-editor.html", "picture-control-editor-mobile.html"],
    jsFiles: moduleGraph("lib/editor-app.js"),
    dictPrefix: "i18n-editor",
    extra: [...INDIRECT, ...colorNames],
    derived: colorNames,
  });

  const { GROUPS } = await import("./lib/analyze.js");
  const tips = [...read("lib/report-view.js").match(/const TIPS = \{([\s\S]*?)\n  \};/)[1]
    .matchAll(/:\s*"((?:\\.|[^"\\])*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const zoneNames = ["Shadows", "Midtones", "Highlights"];
  const paramRows = [...colorNames, ...zoneNames].flatMap((n) => ["Hue", "Chroma", "Brightness"].map((a) => `${n} ${a}`));
  await family(ctx, "wizard", {
    htmlFiles: ["picture-control-jpg-fit.html"],
    jsFiles: moduleGraph("lib/fit-app.js"),
    dictPrefix: "i18n-fit",
    basePrefix: "i18n-editor",
    extra: [...INDIRECT, ...INDIRECT_FIT, ...colorNames, ...tips, ...paramRows, ...GROUPS],
    derived: [...paramRows, ...GROUPS, ...GROUPS.map((g) => `${g}|short`)],   // the short table names
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let fails = 0;
  await level1k({
    report: (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); },
    skip: (msg) => console.log(`skip ${msg}`),
  });
  process.exit(fails ? 1 : 0);
}
