// Reference tests of the browser copy of the pipeline against Python. One command:
//
//     node web/test.mjs
//
// The GPU-less parts (RAW decoding, levels 1 and 1a) run in Node, the shaders (levels 2 and 2a) —
// on the real page in headless Firefox via puppeteer-core. The exit code is non-zero on failure.
// Fixtures and tolerances: web/golden/ (web/make_golden.py), levels and rules: spec/web-tests.md.
import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { initRaw } from "./lib/raw.js";
import { deserialize, serialize } from "./lib/np3.js";
import { curveTable } from "./lib/curve.js";
import { scaled } from "./lib/strength.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const ROOT = path.dirname(HERE);                             // the project root
const man = JSON.parse(await readFile(path.join(HERE, "golden/manifest.json"), "utf8"));

let failed = 0;
let skipped = 0;
const report = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed++;
};
const skip = (text) => {
  console.log(`skip ${text}`);
  skipped++;
};
const f32 = async (p) => {
  let b = await readFile(p);
  if (p.endsWith(".br")) b = brotliDecompressSync(b);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
// data files: in the repository root or in _local/ (raw photos are not part of the repository)
const rootFile = (p) => {
  for (const c of [path.join(ROOT, p), path.join(ROOT, "_local", p)]) if (existsSync(c)) return c;
  return null;
};

// ---------- level 1: RAW decoding in Node, linear float vs golden ----------
{
  const raw = await initRaw(await readFile(path.join(HERE, "raw.wasm")));
  for (const c of man.raw) {
    const src = rootFile(c.path);
    if (!src) { skip(`1 raw ${c.key}: no file ${c.path}`); continue; }
    const bytes = await readFile(src);
    const want = await f32(path.join(HERE, "golden", c.file));
    let got, err;
    try { got = raw.develop(bytes, man.long); } catch (e) { err = e; }
    if (err) { report(false, `1 raw ${c.key}: ${err.code || err}`); continue; }
    if (got.w !== c.w || got.h !== c.h) {
      report(false, `1 raw ${c.key}: size ${got.w}x${got.h} vs fixture ${c.w}x${c.h}`);
      continue;
    }
    let sum = 0, max = 0;
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(got.rgb[i] - want[i]) * 65535;      // the fixture and tolerances are in 16-bit units
      sum += d; if (d > max) max = d;
    }
    const mean = sum / want.length;
    const tol = man.tolerances[c.dng ? "raw_dng" : "raw_nef"];
    report(mean <= tol.mean && max <= tol.max,
      `1 raw ${c.key}: mean ${mean.toFixed(2)} max ${max.toFixed(1)} (tolerance ${tol.mean}/${tol.max})`);
  }

  // ---------- level 1a: decoding rejections ----------
  for (const e of man.errors) {
    const src = rootFile(e.path);
    if (!src) { skip(`1a error ${e.path}: no file`); continue; }
    const bytes = await readFile(src);
    let code = null;
    try { raw.develop(bytes, man.long); } catch (err) { code = err.code || String(err); }
    report(code === e.code, `1a error ${e.path}: code ${code}, expected ${e.code}`);
  }
}

// ---------- level 4: NP3 reading and writing in Node, fields vs Python and bytes vs file ----------
{
  const SCALARS = ["name", "comment", "sharpening", "mid_sharpening", "clarity", "contrast",
                   "highlights", "shadows", "white", "black", "saturation", "blending", "balance"];
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fieldDiff = (want, c) => {
    for (const k of SCALARS)
      if (want[k] !== c[k]) return `field ${k}: ${JSON.stringify(c[k])} != ${JSON.stringify(want[k])}`;
    for (const group of ["blender", "grade"])
      for (const k of Object.keys(want[group]))
        if (!deepEq(want[group][k], c[group][k]))
          return `${group}.${k}: ${JSON.stringify(c[group][k])} != ${JSON.stringify(want[group][k])}`;
    if (deepEq(want.curve, c.curve)) return null;
    if (!want.curve || !c.curve) return `curve: ${c.curve ? "present" : "none"} != ${want.curve ? "present" : "none"}`;
    if (!deepEq(want.curve.raw, c.curve.raw)) return "curve.raw differs";
    return "curve.points differ";
  };
  for (const e of man.np3) {
    const src = new Uint8Array(await readFile(path.join(ROOT, e.path)));
    const want = JSON.parse(await readFile(path.join(HERE, "golden/np3", e.file + ".json"), "utf8"));
    let c, again, err;
    try { c = deserialize(src); again = serialize(c); } catch (e2) { err = e2; }
    if (err) { report(false, `4 np3 ${e.file}: exception ${err.message}`); continue; }
    const bad = fieldDiff(want, c);
    if (bad) { report(false, `4 np3 ${e.file}: ${bad}`); continue; }
    const same = again.length === src.length && again.every((v, i) => v === src[i]);
    report(same, `4 np3 ${e.file}: ${src.length} bytes` + (same ? "" : ", bytes differ"));
  }
  // rejections: short, garbage, empty — an exception, not a partial Control
  const good = new Uint8Array(await readFile(path.join(HERE, "golden/np3", man.np3[0].file)));
  const garbage = new Uint8Array(600).fill(0xAB);
  const cases = {
    "empty file": new Uint8Array(0),
    "garbage without signature": garbage,
    "truncated file": good.slice(0, 100),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    let threw = false;
    try { deserialize(bytes); } catch { threw = true; }
    report(threw, `4 np3 rejection (${label}): ${threw ? "exception" : "partial Control"}`);
  }
  // trimming the extension of a file WITHOUT a comment: Python silently reads it as a profile without a curve —
  // the len >= BASE + CURVE_EXT_LEN threshold is not passed, the curve start is not found. The port does the same.
  let lenient = null;
  try { lenient = deserialize(good.slice(0, good.length - 100)); } catch { /* must not throw */ }
  report(lenient !== null && lenient.curve === null,
    `4 np3 trim without comment: read without a curve (${lenient && lenient.curve === null ? "as Python" : "difference"})`);
  // trimming inside the curve with a live comment header: Python throws unpack — and so does the port
  const cc = man.np3.find((e) => e.file === "third_party__samples__comment-a-tonecurve.NP3");
  const full = new Uint8Array(await readFile(path.join(HERE, "golden/np3", cc.file)));
  for (const cut of [50, 300]) {
    let threw = false;
    try { deserialize(full.slice(0, full.length - cut)); } catch { threw = true; }
    report(threw, `4 np3 rejection (trim -${cut} bytes with comment): ${threw ? "exception" : "partial Control"}`);
  }

  // spline points -> table: bit-exact on official Nikon samples (their points are
  // the real editor points). Project profiles are not checked: their points are 20 even
  // curve_from samples, the spline over them does not recover steep tables (up to 852/32767 ≈ 2.6%);
  // the editor therefore keeps the imported table as is until the points are touched.
  let splineBad = null, splineN = 0;
  for (const e of man.np3) {
    if (!e.file.startsWith("third_party__samples__") || !e.file.includes("tonecurve")) continue;
    const want = JSON.parse(await readFile(path.join(HERE, "golden/np3", e.file + ".json"), "utf8"));
    if (!want.curve) continue;
    splineN++;
    const got = curveTable(want.curve.points).raw;
    const i = got.findIndex((v, j) => v !== want.curve.raw[j]);
    if (i >= 0 && !splineBad) splineBad = `${e.file}: raw[${i}] ${got[i]} != ${want.curve.raw[i]}`;
  }
  report(!splineBad, `4 spline points->table: ${splineN} official samples` + (splineBad ? `, ${splineBad}` : " bit-exact"));

  // strength: the resulting NP3 fields vs strength.py; the base Control is not modified
  for (const e of man.strength) {
    const base = deserialize(new Uint8Array(await readFile(
      e.bytes ? path.join(HERE, "golden/strength", e.bytes) : path.join(ROOT, e.path))));
    const before = JSON.stringify(base);
    const got = scaled(base, e.percent);
    const untouched = JSON.stringify(base) === before;
    const want = JSON.parse(await readFile(path.join(HERE, "golden/strength", e.file), "utf8"));
    const bad = fieldDiff(want, got);
    report(untouched && !bad,
      `4 strength ${e.file.replace(".json", "")}: base ${untouched ? "untouched" : "MODIFIED"}`
      + (bad ? `, ${bad}` : ""));
  }
}

// ---------- level 5: the 33^3 profile LUT vs profile_model.Model (dE2000 over knots) ----------
{
  const { loadModel, buildLUT } = await import("./lib/profile.js");
  const { srgbToLab, de2000 } = await import("./lib/color.js");
  const meta = JSON.parse(await readFile(path.join(HERE, "model/profile.json"), "utf8"));
  const bin = await readFile(path.join(HERE, "model/profile.bin"));
  const model = loadModel(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const t = man.tolerances.profile;
  for (const e of man.profile) {
    const c = deserialize(new Uint8Array(await readFile(path.join(HERE, "golden", e.np3))));
    const got = buildLUT(model, c, 33);
    const want = await f32(path.join(HERE, "golden", e.file));
    const a = srgbToLab(Float64Array.from(want)), b = srgbToLab(Float64Array.from(got));
    const d = de2000(a, b);
    let sum = 0, max = 0;
    for (const v of d) { sum += v; if (v > max) max = v; }
    const mean = sum / d.length;
    report(mean <= t.mean && max <= t.max,
      `5 profile ${e.key}: mean ${mean.toFixed(4)} max ${max.toFixed(3)} dE2000 (tolerance ${t.mean}/${t.max})`);
  }
}

// ---------- levels 2, 2a: shaders on the page in Firefox ----------
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png",
  ".f32": "application/octet-stream", ".bin": "application/octet-stream",
  ".nef": "application/octet-stream", ".dng": "application/octet-stream",
};
const server = http.createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const rel = path.normalize(url).replace(/^([/\\])+/, "");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) throw new Error("path");
    let data = null;
    try { data = await readFile(file); }
    catch {
      // local data (_local/ in .gitignore): raw photos for levels 1 and 8
      const loc = path.join(ROOT, "_local", rel);
      if (!loc.startsWith(ROOT)) throw new Error("path");
      data = await readFile(loc);
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const firefox = process.env.FIREFOX || "/usr/bin/firefox";
const browser = await puppeteer.launch({ browser: "firefox", executablePath: firefox, headless: true });
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`http://127.0.0.1:${port}/web/test.html`);
  await page.waitForFunction("window.__done === true", { timeout: 600000, polling: 500 });
  const r = await page.evaluate("window.__result");
  if (r.fatal) report(false, `page: ${r.fatal}`);
  for (const s of r.synthetic || []) {
    const t = man.tolerances.synthetic;
    report(!s.error && s.mean <= t.mean && s.max <= t.max,
      `2 neutral ${s.name}: mean ${(s.mean * 255).toFixed(4)} max ${(s.max * 255).toFixed(4)} of 255 (tolerance ${(t.mean * 255).toFixed(2)}/${(t.max * 255).toFixed(1)})`);
  }
  for (const f of r.frames || []) {
    const t = man.tolerances.frames;
    report(!f.error && f.mean <= t.mean && f.p99 <= t.p99 && f.max <= t.max,
      `2a frame ${f.key}: mean ${f.mean?.toFixed(3)} p99 ${f.p99} max ${f.max} of 255 (tolerance ${t.mean}/${t.p99}/${t.max})`);
  }
  for (const e of r.errors || []) {
    if (e.skip) { skip(`1a error (browser) ${e.path}: no file`); continue; }
    report(e.ok, `1a error (browser) ${e.path}: code ${e.got}, expected ${e.want}`);
  }
  for (const d of r.detail || []) {
    const t = man.tolerances.detail;
    report(d.mean <= t.mean && d.max <= t.max,
      `6 detail ${d.key}: mean ${d.mean.toFixed(3)} max ${d.max} of 255 (tolerance ${t.mean}/${t.max})`);
  }
  if (r.render7_dbg) console.log("render7 dbg:", JSON.stringify(r.render7_dbg));
  for (const r7 of r.render7 || []) {
    const t = man.tolerances.render7;
    const parts = Object.entries(r7.regions).filter(([, v]) => v !== null)
      .map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" ");
    report(r7.worst <= t.mean, `7 render ${r7.key}: ${parts} dE2000 (tolerance ${t.mean})`);
  }
  if (r.render7_invariant) {
    const inv = r.render7_invariant;
    report(inv.develops === inv.cases && inv.neutrals === inv.cases,
      `7 render invariant: develop ${inv.develops}, neutral ${inv.neutrals} over ${inv.cases} cases`
      + (inv.develops === inv.cases && inv.neutrals === inv.cases ? "" : " — recomputation on a profile edit"));
  }

  // ---------- level 8: the end-to-end UI on the real page web/index.html ----------
  const raw8a = rootFile("test1/DSC_5584.NEF"), raw8b = rootFile("test2/SKL_3024.dng");
  // Acceptance criteria 1, 2, 3, 5 (the interface part), 6, 7, 8, 9, 10, 11.
  // Everything runs programmatically: File/Blob from fetch + DataTransfer-drop and transfer.importFile.
  if (!raw8a || !raw8b) {
    skip(`8 UI: no RAW files (${"test1/DSC_5584.NEF" }, ${"test2/SKL_3024.dng"})`);
  } else  {
    const page = await browser.newPage();
    const netBad = [];        // any non-GET or a request with a body = locality failure
    const pageErrors = [];
    page.on("request", (r) => {
      // postData() is not supported in BiDi Firefox; a non-GET means sending data anyway.
      if (r.method() !== "GET") netBad.push(`${r.method()} ${r.url()}`);
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/web/index.html`);
    await page.waitForFunction(
      `window.__np3app && window.__np3app.state.status === "Drop a NEF or DNG"`,
      { timeout: 120000, polling: 200 });
    const ev = (fn, ...args) => page.evaluate(fn, ...args);
    // settle: the LUT is built in a Worker (app.js) — we wait until the request is applied and the frame redrawn
    const settle = () => page.waitForFunction("!window.__np3app.state.renderPending",
      { timeout: 60000, polling: 30 });

    // Shared page helpers: dropping a file, a canvas snapshot, moving a group slider.
    await ev(() => {
      window.__t8 = {
        dropFile: async (path, name) => {
          const buf = await (await fetch(path)).arrayBuffer();
          const dt = new DataTransfer();
          dt.items.add(new File([buf], name));
          document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        },
        // the application canvas is WebGL: read the default framebuffer directly
        snap: () => {
          const c = document.getElementById("c");
          const g = c.getContext("webgl2");
          const d = new Uint8Array(c.width * c.height * 4);
          g.bindFramebuffer(g.FRAMEBUFFER, null);
          g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, d);
          let h = 0;
          for (let i = 0; i < d.length; i += 4097) h = (h * 31 + d[i]) >>> 0;
          return `${c.width}x${c.height}:${h}`;
        },
        groupSlider: (group, idx, v) => {
          const inp = document.querySelectorAll(`#panel [data-group="${group}"] input[type=range]`)[idx];
          inp.value = v;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        },
      };
    });
    // Export through the real exportNow(); the Blob bytes are intercepted from createObjectURL.
    const exportBytes = async () => {
      await page.evaluate(() => {
        window.__exp = [];
        const orig = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
          blob.arrayBuffer().then((b) => window.__exp.push(new Uint8Array(b)));
          return orig(blob);
        };
      });
      await page.evaluate(() => window.__np3app.transfer.exportNow());
      await page.waitForFunction("window.__exp.length > 0", { timeout: 15000 });
      return new Uint8Array(await page.evaluate(() => Array.from(window.__exp.at(-1))));
    };

    // --- criterion 2: panel layout; before/after and export before a RAW development ---
    {
      const groups = await ev(() =>
        [...document.querySelectorAll("#panel [data-group]")].map((e) => e.dataset.group));
      report(JSON.stringify(groups) ===
        JSON.stringify(["strength", "name", "basic", "curve", "details", "blender", "grading"]),
        `8 layout: ${groups.join(" -> ")}`);
      const openState = await ev(() =>
        [...document.querySelectorAll("#panel details.grp")].map((d) => `${d.dataset.group}:${d.open}`));
      report(openState.filter((s) => s.endsWith(":true")).join(",") === "strength:true,basic:true",
        `8 layout (UI-2): only Profile and Basic are open by default (${openState.join(" ")})`);
      const prof = await ev(() => {
        const g = document.querySelector('#panel [data-group="strength"]');
        return { tag: g.tagName, open: g.open,
                 summary: g.querySelector("summary").textContent,
                 presets: g.querySelectorAll("button").length,
                 label: g.querySelector(".ctl .lbl")?.textContent,
                 val: g.querySelector(".ctl .val")?.value,
                 nameBox: g.querySelector('[data-group="name"]') != null,
                 nameLabel: g.querySelector('#panel [data-group="name"] h2') != null,
                 resultName: g.querySelector("b") != null };
      });
      report(prof.tag === "DETAILS" && prof.open && prof.summary === "Profile",
        `8 layout: strength is a collapsible group "${prof.summary}" (${prof.tag}, open=${prof.open})`);
      report(prof.presets === 0 && prof.label === "Strength" && prof.val === "100",
        `8 layout: the Strength slider is like the others (presets: ${prof.presets},` +
        ` label "${prof.label}", value ${prof.val})`);
      report(prof.nameBox && !prof.resultName && !prof.nameLabel,
        "8 layout (UI-2): name is the first field of the Profile group without a label, the result name is gone");
      // UI-2: LR-style blender/grading and gradient tracks
      const lr = await ev(() => {
        const b = document.querySelector('#panel [data-group="blender"]');
        return {
          blenderSliders: b.querySelectorAll("input[type=range]").length,
          tabs: [...b.querySelectorAll(".bl-tabs button")].map((x) => x.textContent),
          dots: b.querySelectorAll(".bl-dot").length,
          satGrad: document.querySelector('#panel [data-group="basic"] input[type=range]').classList.contains("grad"),
          tgl: document.querySelector("#grading-slot .tgl button.active")?.textContent,
          wheels: document.querySelectorAll("#grading-slot .gr-disc").length,
          zones: [...document.querySelectorAll("#grading-slot .gr-adjust button")].map((x) => x.textContent),
          blendMode: document.querySelector("#blending-slot .tgl button.active")?.textContent,
          gradPreview: document.querySelector("#grading-slot .gr-preview") != null,
          gradPreviewParent: document.querySelector("#grading-slot .gr-preview")?.parentElement?.id,
          gradDivider: document.querySelectorAll("#grading-slot .gr-divider").length,
          gradNums: document.querySelectorAll("#grading-slot .gr-nums input").length,
          gradBlendLabels: [...document.querySelectorAll("#grading-slot .lbl")]
            .filter((e) => e.textContent === "Blending").length,
          gradWheelNames: document.querySelectorAll("#grading-slot .gr-name").length,
          gradSubs: document.querySelectorAll("#grading-slot .sub").length,
          gradSharedHidden: document.querySelector("#grading-slot .gr-shared")?.hidden,
        };
      });
      report(lr.blenderSliders === 27 && JSON.stringify(lr.tabs) === JSON.stringify(["Hue", "Saturation", "Luminance", "All"])
             && lr.dots === 8,
        `8 UI-2: blender tabs ${lr.tabs.join("/")}, dots ${lr.dots}, sliders ${lr.blenderSliders}`);
      report(lr.blendMode === "Color", `8 UI-2: blender defaults to the ${lr.blendMode} mode`);
      report(lr.satGrad, "8 UI-2: Saturation has a gradient track");
      report(lr.tgl === "HSL" && lr.wheels === 3
             && JSON.stringify(lr.zones) === JSON.stringify(["Shadows", "Midtones", "Highlights"]),
        `8 UI-2: Color Grading toggle "${lr.tgl}" first, zones ${lr.zones.join("/")}, wheels ${lr.wheels}`);
      report(lr.gradPreview && lr.gradPreviewParent === "grading-hsl"
             && lr.gradDivider === 1 && lr.gradNums === 6
             && lr.gradBlendLabels === 1 && lr.gradWheelNames === 0
             && lr.gradSubs === 0 && lr.gradSharedHidden === false,
        `8 UI-2: Grading — preview ${lr.gradPreview ? "in HSL" : "?"}` +
        ` (parent ${lr.gradPreviewParent}), divider ${lr.gradDivider},` +
        ` Hue/Sat number inputs ${lr.gradNums}, Blending labels ${lr.gradBlendLabels},` +
        ` names over the wheel ${lr.gradWheelNames}, extra headings ${lr.gradSubs},` +
        ` Blending/Balance in both modes ${!lr.gradSharedHidden}`);
      // UI-2: buttons under the frame info; before/after is space only
      const importBtnOrder = await ev(() => {
        const b = document.getElementById("import");
        return b.parentElement.previousElementSibling?.id === "info";
      });
      report(importBtnOrder, "8 UI-2: Import/Export buttons under the frame info");
      const dis0 = await ev(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        const show = window.__np3app.state.showNeutral;
        document.body.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        return show;
      });
      report(dis0 === false, "8 before/after: space before a RAW development does not enable before");
      const hint0 = await ev(() => document.querySelector(".ba-hint")?.textContent || "");
      report(hint0.length > 0, `8 before/after: the space hint ("${hint0}")`);
      const hidden0 = await ev(() => document.getElementById("c").hidden);
      report(hidden0 === true, "8 empty state: canvas hidden until the first frame");
      const expDefault = await exportBytes();
      let c0 = null;
      try { c0 = deserialize(expDefault); } catch { /* reported below */ }
      report(c0 && c0.name === "NPF-MANUAL",
        `8 export without RAW: the default new profile${c0 ? ` (${c0.name})` : " — the file did not parse"}`);
    }

    // --- criterion 1: drop a RAW, move every slider, export with the edits ---
    await ev(() => window.__t8.dropFile("/test1/DSC_5584.NEF", "DSC_5584.NEF"));
    await page.waitForFunction(
      `window.__np3app.state.raw && window.__np3app.state.raw.name === "DSC_5584.NEF"`,
      { timeout: 300000, polling: 500 });
    // the canvas appears with the first drawn frame (the LUT arrives from the Worker)
    await page.waitForFunction("!document.getElementById('c').hidden",
      { timeout: 60000, polling: 100 });
    {
      const got = await ev(() => {
        const A = window.__np3app, c = document.getElementById("c");
        return { name: A.state.raw.name, w: c.width, hidden: c.hidden,
                 label: document.querySelector(".ba-label").textContent };
      });
      report(got.name === "DSC_5584.NEF" && got.w > 100 && !got.hidden && got.label === "After — NP3",
        `8 scenario 1: RAW shown (${got.name}, ${got.w}px, canvas visible), caption "After — NP3"`);

      // regression "black first frame": the render from the ready handler must give the same
      // frame as a repeated renderCurrent (bug: ctxOf overwrote the srcTex binding on unit 0).
      const first = await ev(() => {
        const s0 = window.__t8.snap();
        window.__np3app.renderCurrent();
        return { s0, s1: window.__t8.snap() };
      });
      report(first.s0 === first.s1, "8 first frame is not black: the ready frame matches the repeated render");

      const sliders = await ev(() => {
        const A = window.__np3app;
        const develops0 = A.renderer.stats.develops;
        const inputs = [...document.querySelectorAll("#panel input[type=range]")];
        let moved = 0;
        for (const inp of inputs) {
          const before = JSON.stringify({ c: A.state.control, s: A.state.strength });
          const min = parseFloat(inp.min), max = parseFloat(inp.max), step = parseFloat(inp.step);
          let v = parseFloat(inp.value) + step;
          if (v > max) v = parseFloat(inp.value) - step;
          inp.value = v;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          if (JSON.stringify({ c: A.state.control, s: A.state.strength }) !== before) moved++;
        }
        return { total: inputs.length, moved,
                 develops: A.renderer.stats.develops - develops0 };
      });
      report(sliders.moved === sliders.total && sliders.develops === 0,
        `8 scenario 1: sliders ${sliders.moved}/${sliders.total} change state,`
        + ` develop not restarted (+${sliders.develops})`);

      // export after edits: the bytes in Node equal serialize(scaled()) with the base name
      // (UI-2: strength does not affect the name, the suffix is not written into the NP3)
      const [exp1, stJson] = await Promise.all([exportBytes(),
        ev(() => ({ control: window.__np3app.state.control, strength: window.__np3app.state.strength }))]);
      const scaledCtl = scaled(JSON.parse(JSON.stringify(stJson.control)), stJson.strength);
      const expected = serialize({ ...scaledCtl, name: stJson.control.name });
      const same = exp1.length === expected.length && exp1.every((v, i) => v === expected[i]);
      report(same, `8 scenario 1: export after edits matches serialize(scaled()) (${exp1.length} bytes)`);
    }

    // --- criterion 3: editing Saturation changes the canvas and lands in the NP3; LUT cache ---
    {
      await ev(() => window.__t8.groupSlider("strength", 0, 100));   // the slider sweep left 105%
      await settle();
      const s0 = await ev(() => window.__t8.snap());
      await ev(() => window.__t8.groupSlider("basic", 0, 80));
      await settle();
      const s1 = await ev(() => window.__t8.snap());
      report(s0 !== s1, "8 controls: Saturation=80 changes the canvas");
      const expSat = await exportBytes();
      let cSat = null;
      try { cSat = deserialize(expSat); } catch { /* reported below */ }
      report(cSat && cSat.saturation === 80,
        `8 controls: Saturation=80 in the exported NP3${cSat ? ` (got ${cSat.saturation})` : ""}`);

      const lut = [await ev(() => window.__np3app.renderer.stats.luts)];
      for (const v of [50, 60, 50]) {
        await ev((vv) => window.__t8.groupSlider("basic", 0, vv), v);
        await settle();
        lut.push(await ev(() => window.__np3app.renderer.stats.luts));
      }
      report(lut[1] === lut[0] + 1 && lut[2] === lut[1] + 1 && lut[3] === lut[2],
        `8 LUT cache: a new LUT only for a new control (${lut.join("->")})`);
    }

    // --- criterion 5 (interface): strength 150% changes the frame, does not touch the base, name with suffix ---
    {
      const baseSat = await ev(() => window.__np3app.state.control.saturation);
      const snap0 = await ev(() => window.__t8.snap());
      await ev(() => window.__t8.groupSlider("strength", 0, 150));
      await settle();
      const r5 = await ev((s0, bs) => {
        const A = window.__np3app;
        return { snap0: s0, snap1: window.__t8.snap(), baseSat: bs,
                 baseSame: A.state.control.saturation === bs,
                 strength: A.state.strength };
      }, snap0, baseSat);
      report(r5.strength === 150 && r5.baseSame && r5.snap0 !== r5.snap1,
        `8 strength 150%: the frame changed, the base untouched (sat ${r5.baseSat})`);
      // UI-2: strength does not affect the name — the suffix is not added anywhere
      const nameBase = await ev(() => window.__np3app.state.control.name);
      const exp150 = await exportBytes();
      let c150 = null;
      try { c150 = deserialize(exp150); } catch { /* reported below */ }
      report(c150 && c150.name === nameBase,
        `8 strength 150%: name without a suffix (base "${nameBase}", in the NP3 "${c150 ? c150.name : "?"}")`);
      await ev(() => window.__t8.groupSlider("strength", 0, 100));
      await settle();
    }

    // --- criterion 6: before/after with space; neutral without a LUT and without a profile change ---
    {
      const ba = await ev(() => {
        const A = window.__np3app;
        const out = {};
        A.state.showNeutral = true; A.renderCurrent();
        out.neutral = window.__t8.snap();
        A.state.showNeutral = false; A.renderCurrent();
        out.after = window.__t8.snap();
        const ctl0 = JSON.stringify(A.state.control), s0 = A.state.strength, luts0 = A.renderer.stats.luts;
        // UI-2: there is no button — "before" is enabled by holding space
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        out.hold = { show: A.state.showNeutral,
                     label: document.querySelector(".ba-label").textContent,
                     snap: window.__t8.snap(),
                     luts0, luts: A.renderer.stats.luts,
                     same: JSON.stringify(A.state.control) === ctl0 && A.state.strength === s0 };
        document.body.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        out.released = { show: A.state.showNeutral,
                         label: document.querySelector(".ba-label").textContent,
                         snap: window.__t8.snap() };
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        out.space = { show: A.state.showNeutral, snap: window.__t8.snap() };
        document.body.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        out.spaceOff = { show: A.state.showNeutral, snap: window.__t8.snap() };
        // space in the name input must not enable "before"
        const nameInput = document.querySelector('#panel [data-group="name"] input');
        nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        out.spaceInInput = A.state.showNeutral;
        nameInput.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        // bugfix: after dragging, the focus stays on the slider — space is still "before"
        const range = document.querySelector('#panel [data-group="basic"] input[type=range]');
        range.focus();
        range.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        out.spaceOnRange = A.state.showNeutral;
        range.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        return out;
      });
      report(ba.hold.show === true && ba.hold.snap === ba.neutral && ba.hold.label === "Before — neutral",
        "8 before/after: holding space = neutral, caption \"Before — neutral\"");
      report(ba.hold.luts === ba.hold.luts0,
        `8 before/after: no LUT build while held (${ba.hold.luts0}->${ba.hold.luts})`);
      report(ba.hold.same, "8 before/after: profile and strength unchanged");
      report(ba.released.show === false && ba.released.snap === ba.after
             && ba.released.label === "After — NP3",
        "8 before/after: releasing returned the result, caption \"After — NP3\"");
      report(ba.space.show === true && ba.space.snap === ba.neutral,
        "8 before/after: holding space = neutral");
      // orientation: the top of the image (neutralRGBA row 0) must be at the top of the screen.
      // Regression: flipV in app.js flipped the neutral; comparing it with itself did not catch that.
      const orient = await ev(() => {
        const A = window.__np3app;
        A.state.showNeutral = true; A.renderCurrent();
        const view = document.getElementById("c");
        const g = view.getContext("webgl2");
        const W = view.width, H = view.height;
        const shown = new Uint8Array(W * H * 4);
        g.bindFramebuffer(g.FRAMEBUFFER, null);
        g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, shown);
        const neu = A.renderer.neutralRGBA();
        const row = (screenRow, neuRow) => {
          let s = 0;
          for (let i = 0; i < W * 4; i++) s += Math.abs(shown[screenRow * W * 4 + i] / 255 - neu[neuRow * W * 4 + i]);
          return s / (W * 4);
        };
        const top = row(H - 1, 0);
        // frame asymmetry: with a flipped display top ≈ asym, with a correct one ≈ 0
        let asym = 0;
        for (let i = 0; i < W * 4; i++) asym += Math.abs(neu[i] - neu[(H - 1) * W * 4 + i]);
        asym /= W * 4;
        A.state.showNeutral = false; A.renderCurrent();
        return { top, asym };
      });
      report(orient.top < 0.02 && orient.top < orient.asym * 0.5,
        `8 before/after: neutral orientation is correct (dTop ${orient.top.toFixed(4)}, frame asymmetry ${orient.asym.toFixed(4)})`);
      report(ba.spaceOff.show === false && ba.spaceOff.snap === ba.after,
        "8 before/after: releasing space returned the result");
      report(ba.spaceInInput === false, "8 before/after: space in an input does not enable before");
      report(ba.spaceOnRange === true, "8 before/after: space with focus on a slider enables before");
    }

    // --- small front-end checks: Reset to neutral and the slider track fill ---
    {
      await ev(() => {
        const nameInput = document.querySelector('#panel [data-group="name"] input');
        nameInput.value = "MY-TEST";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        window.__t8.groupSlider("basic", 0, 80);        // Saturation
        window.__t8.groupSlider("strength", 0, 150);
        window.__np3app.state.control.balance = -100;   // Grading: Balance (an NP3 field)
        const toggle = document.querySelector('#panel [data-group="curve"] input[type="checkbox"]');
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();   // enabling the curve starts a render through the Worker
      const lockedBefore = await ev(() => ({
        ranges: document.querySelectorAll('#panel [data-group="basic"] input[type=range][disabled]').length,
        numbers: document.querySelectorAll('#panel [data-group="basic"] input[type=number][disabled]').length,
      }));
      const preSnap = await ev(() => window.__t8.snap());
      await ev(() => document.getElementById("p-reset").click());
      await settle();
      const post = await ev((snapBefore) => {
        const A = window.__np3app;
        const sRange = document.querySelector('#panel [data-group="strength"] input[type=range]');
        return {
          snapChanged: window.__t8.snap() !== snapBefore,
          strength: A.state.strength,
          sat: A.state.control.saturation,
          sharpening: A.state.control.sharpening,
          blending: A.state.control.blending,
          balance: A.state.control.balance,
          curve: A.state.control.curve,
          toggle: document.querySelector('#panel [data-group="curve"] input[type="checkbox"]').checked,
          tonalDisabled: document.querySelectorAll('#panel [data-group="basic"] input[type=range][disabled]').length,
          name: A.state.control.name,
          fill: sRange.style.getPropertyValue("--fill"),
          val: document.querySelector('#panel [data-group="strength"] .val').value,
        };
      }, preSnap);
      report(lockedBefore.ranges === 5 && lockedBefore.numbers === 5,
        `8 Reset: before the reset the curve locks 5 tonal sliders` +
        ` (ranges ${lockedBefore.ranges}, numbers ${lockedBefore.numbers})`);
      report(post.strength === 100 && post.sat === 0 && post.sharpening === 2 && post.blending === 50
             && post.balance === 0 && post.curve === null && post.toggle === false
             && post.tonalDisabled === 0 && post.name === "MY-TEST",
        `8 Reset: neutral (strength ${post.strength}%, sat ${post.sat}, curve ` +
        `${post.curve === null ? "off" : "on"}, name kept "${post.name}")`);
      report(post.snapChanged, "8 Reset: the preview updated after the reset");
      report(post.fill === "66.7%" && post.val === "100",
        `8 fill: --fill of the strength slider ${post.fill}, value ${post.val}`);
      const fillMin = await ev(() => {
        window.__t8.groupSlider("basic", 0, -100);      // Saturation to the minimum
        const inp = document.querySelectorAll('#panel [data-group="basic"] input[type=range]')[0];
        return { fill: inp.style.getPropertyValue("--fill"), sat: window.__np3app.state.control.saturation };
      });
      report(fillMin.fill === "0.0%" && fillMin.sat === -100,
        `8 fill: at min value --fill=${fillMin.fill} (sat ${fillMin.sat})`);
      await ev(() => window.__t8.groupSlider("basic", 0, 0));
      await ev(() => {                    // restore the name so it does not show in the later checks
        const nameInput = document.querySelector('#panel [data-group="name"] input');
        nameInput.value = "NPF-MANUAL";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    // --- P1/P2 (plan §5): LUT in a Worker, narrow key, cache limit, detail reuse, readback ---
    {
      await settle();   // catch up with the LUT from the fill edits
      // the name and detail do not change pixels: editing them builds no LUT and starts no render
      const luts0 = await ev(() => window.__np3app.renderer.stats.luts);
      await ev(() => {
        const nameInput = document.querySelector('#panel [data-group="name"] input');
        nameInput.value = "PERF-TEST";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        window.__t8.groupSlider("details", 0, 4);       // Sharpening — detail, not color
      });
      await settle();
      const luts1 = await ev(() => window.__np3app.renderer.stats.luts);
      report(luts1 === luts0, `8 perf: name and Sharpening build no LUT (${luts0}->${luts1})`);

      // editing only tool values/tables (the same sigmas) reuses the luma and blurs
      const sk0 = await ev(() => window.__np3app.renderer.stats.detailSkips);
      await ev(() => window.__t8.groupSlider("details", 0, 5));
      await settle();
      const sk1 = await ev(() => window.__np3app.renderer.stats.detailSkips);
      report(sk1 > sk0, `8 perf: detail reuses luma/blurs (skips ${sk0}->${sk1})`);

      // unique-LUT stress: at most 4 textures in the cache, the evicted ones deleted explicitly
      const st0 = await ev(() => ({ luts: window.__np3app.renderer.stats.luts,
                                    drops: window.__np3app.renderer.stats.lutDrops }));
      for (let i = 0; i < 8; i++) {
        await ev((v) => window.__t8.groupSlider("basic", 0, v), -100 + i);
        await settle();
      }
      const st1 = await ev(() => ({ luts: window.__np3app.renderer.stats.luts,
                                    drops: window.__np3app.renderer.stats.lutDrops,
                                    size: window.__np3app.renderer.lutCache.size }));
      const dLuts = st1.luts - st0.luts, dDrops = st1.drops - st0.drops;
      report(st1.size <= 4 && dDrops >= Math.max(0, dLuts - 4),
        `8 perf: LUT cache ≤4 textures, eviction deletes explicitly (cache ${st1.size},` +
        ` +${dLuts} LUTs, +${dDrops} deleted)`);

      // the application path (load/before-after/render) does no CPU readback of the neutral
      const reads = await ev(() => {
        const A = window.__np3app;
        const r0 = A.renderer.stats.reads;
        A.state.showNeutral = true; A.renderCurrent();
        A.state.showNeutral = false; A.renderCurrent();
        const appReads = A.renderer.stats.reads - r0;
        A.renderer.neutralRGBA();      // the CPU copy is built lazily and only on request
        return { appReads, total: A.renderer.stats.reads };
      });
      report(reads.appReads === 0 && reads.total > 0,
        `8 perf: no CPU readback of the neutral in the application path (total readbacks ${reads.total})`);

      await ev(() => {   // restore the neutral so it does not interfere with the later checks
        const nameInput = document.querySelector('#panel [data-group="name"] input');
        nameInput.value = "NPF-MANUAL";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        window.__t8.groupSlider("basic", 0, 0);
        window.__t8.groupSlider("details", 0, 2);
      });
      await settle();
    }

    // --- UX: double click — reset to default; the numeric value is an editable input ---
    {
      await ev(() => window.__t8.groupSlider("details", 0, 9));   // Sharpening 9
      await settle();
      const dbl = await ev(() => {
        const A = window.__np3app;
        const inp = document.querySelectorAll('#panel [data-group="details"] input[type=range]')[0];
        inp.dispatchEvent(new Event("dblclick", { bubbles: true }));
        return { sharp: A.state.control.sharpening };
      });
      report(dbl.sharp === 2, `8 UX: double click resets the slider (Sharpening ${dbl.sharp})`);
      const num = await ev(() => {
        const A = window.__np3app;
        const val = document.querySelectorAll('#panel [data-group="details"] .val')[0];
        val.value = "4.5";
        val.dispatchEvent(new Event("change", { bubbles: true }));
        return { sharp: A.state.control.sharpening };
      });
      report(num.sharp === 4.5, `8 UX: typing a number into the value (Sharpening ${num.sharp})`);
      const clamp = await ev(() => {
        const val = document.querySelectorAll('#panel [data-group="details"] .val')[0];
        val.value = "99";
        val.dispatchEvent(new Event("change", { bubbles: true }));
        return { sharp: window.__np3app.state.control.sharpening };
      });
      report(clamp.sharp === 9, `8 UX: input is clamped to the range (${clamp.sharp})`);
      await ev(() => window.__t8.groupSlider("details", 0, 2));   // restore the neutral
      await settle();
    }

    // --- curve: the lock note only at the checkbox; histogram under the curve ---
    {
      await ev(() => {
        const toggle = document.querySelector('#panel [data-group="curve"] input[type="checkbox"]');
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
      const curveUi = await ev(() => {
        const basicHint = [...document.querySelectorAll('#panel [data-group="basic"] .hint')]
          .some((e) => e.textContent.includes("set by the curve"));
        const noteEl = document.querySelector("#curve-slot .ce-note");
        const curveNote = noteEl?.textContent || "";
        const d = document.querySelector("#curve-slot .ce-hist")?.getAttribute("d") || "";
        const ceButtons = document.querySelectorAll("#curve-slot .ce-ctl button").length;
        let bins = 0;
        for (const m of d.matchAll(/L[\d.]+ ([\d.]+)/g)) if (parseFloat(m[1]) < 266) bins++;
        return { basicHint, note: curveNote.includes("NP3 format limitation") && curveNote.includes("can't use both"),
                 noteVisible: !!noteEl && !noteEl.hidden, bins, dLen: d.length, ceButtons };
      });
      report(!curveUi.basicHint && curveUi.note && curveUi.noteVisible,
        "8 curve: the NP3 limitation note only at the curve, always visible");
      report(curveUi.dLen > 0 && curveUi.bins > 50 && curveUi.ceButtons === 1,
        `8 curve: neutral histogram under the curve (${curveUi.bins} nonzero bins),` +
        ` buttons in the row ${curveUi.ceButtons} (Reset Curve is gone)`);
      await ev(() => {   // turn the curve back off — the later blocks wait for unlocked sliders
        const toggle = document.querySelector('#panel [data-group="curve"] input[type="checkbox"]');
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
      const off = await ev(() => {
        const noteEl = document.querySelector("#curve-slot .ce-note");
        const d = document.querySelector("#curve-slot .ce-hist")?.getAttribute("d") || "";
        return { noteVisible: !!noteEl && !noteEl.hidden, dLen: d.length };
      });
      report(off.noteVisible && off.dLen > 0, "8 curve: off — the note and the histogram are in place");
    }

    // --- edit history: Ctrl+Z, sessionStorage, reset on RAW change/import ---
    {
      const histLen = await ev(() => JSON.parse(sessionStorage.getItem("np3hist")).stack.length);
      await ev(() => window.__t8.groupSlider("basic", 0, 70));   // Saturation 70
      await settle();
      await ev(() => window.__t8.groupSlider("basic", 1, 40));   // Contrast 40
      await settle();
      const undo1 = await ev(() => {
        const A = window.__np3app;
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
        return { sat: A.state.control.saturation, con: A.state.control.contrast,
                 len: JSON.parse(sessionStorage.getItem("np3hist")).stack.length };
      });
      report(undo1.sat === 70 && undo1.con === 0,
        `8 Ctrl+Z: Contrast undone (sat ${undo1.sat}, con ${undo1.con})`);
      const undo2 = await ev(() => {
        const A = window.__np3app;
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
        return { sat: A.state.control.saturation, con: A.state.control.contrast };
      });
      report(undo2.sat === 0 && undo2.con === 0,
        `8 Ctrl+Z: Saturation undone (sat ${undo2.sat}, con ${undo2.con})`);
      const undo3 = await ev(() => {
        const A = window.__np3app;
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
        return { sat: A.state.control.saturation,
                 idx: JSON.parse(sessionStorage.getItem("np3hist")).idx };
      });
      report(undo3.sat === 0, "8 Ctrl+Z: at the start of history — no changes");
      report(histLen >= 1 && undo1.len <= 20, `8 Ctrl+Z: history in sessionStorage (≤20, was ${histLen})`);
    }

    // --- criterion 9: two RAWs in a row, the last wins; history resets on a RAW change ---
    await page.evaluate(async () => {
      const mk = async (p, n) => new File([await (await fetch(p)).arrayBuffer()], n);
      const a = await mk("/test1/DSC_5584.NEF", "DSC_5584.NEF");
      const b = await mk("/test2/SKL_3024.dng", "SKL_3024.dng");
      const drop = (f) => {
        const dt = new DataTransfer();
        dt.items.add(f);
        document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      };
      drop(a); drop(b);   // the second is chosen while the first is still in the Worker
    });
    await page.waitForFunction(
      `window.__np3app.state.raw && window.__np3app.state.raw.name === "SKL_3024.dng"`,
      { timeout: 300000, polling: 500 });
    await new Promise((r) => setTimeout(r, 2000));   // the late result of the first must not override
    {
      const race = await ev(() => {
        const A = window.__np3app;
        return { name: A.state.raw.name, model: A.state.raw.info.model,
                 w: document.getElementById("c").width,
                 warn: !document.getElementById("warn").hidden,
                 hist: JSON.parse(sessionStorage.getItem("np3hist")).stack.length };
      });
      report(race.name === "SKL_3024.dng" && race.model.includes("Z 8"),
        `8 RAW change: the last frame won (${race.name}, ${race.model}, ${race.w}px)`);
      report(race.hist === 1, `8 Ctrl+Z: a RAW change resets the history (${race.hist} snapshots)`);
    }

    // --- criteria 7 and 8: NP3 import (fields, RAW kept), byte-exact round-trip ---
    {
      const goldenBytes = new Uint8Array(await readFile(
        path.join(HERE, "golden/np3", "out__fit4__NIKON__CUSTOMPC__PICCON01.NP3")));
      const rawBefore = await ev(() => window.__np3app.state.raw?.name);
      await page.evaluate(async (bytes) => {
        await window.__np3app.transfer.importFile(new File([new Uint8Array(bytes)], "PICCON01.NP3"));
      }, Array.from(goldenBytes));
      const imported = await ev(() => ({ control: window.__np3app.state.control,
                                         strength: window.__np3app.state.strength,
                                         raw: window.__np3app.state.raw?.name }));
      const wantCtl = JSON.parse(JSON.stringify(deserialize(goldenBytes)));
      const ctlSame = JSON.stringify(imported.control) === JSON.stringify(wantCtl);
      report(ctlSame && imported.strength === 100 && imported.raw === rawBefore,
        `8 import: all fields as in deserialize, strength 100%, RAW kept (${imported.raw})`);
      const histAfterImport = await ev(() => JSON.parse(sessionStorage.getItem("np3hist")).stack.length);
      report(histAfterImport === 1, `8 Ctrl+Z: an NP3 import resets the history (${histAfterImport} snapshots)`);
      // regression: an NP3 dropped onto the page (drag-and-drop) must be imported,
      // not sent to the RAW decoder ("Failed to decode")
      await page.evaluate(async (bytes) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(bytes)], "drop.NP3"));
        document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
      }, Array.from(goldenBytes));
      const dropImported = await ev(() => ({ name: window.__np3app.state.control.name,
                                             status: document.getElementById("status").textContent }));
      report(dropImported.name === wantCtl.name && dropImported.status.startsWith("Imported"),
        `8 drag-and-drop import: NP3 dropped onto the page ("${dropImported.status}")`);
      const expRt = await exportBytes();
      const sameBytes = expRt.length === goldenBytes.length
        && expRt.every((v, i) => v === goldenBytes[i]);
      report(sameBytes,
        `8 round-trip: exporting the unmodified import byte-exact (${expRt.length}/${goldenBytes.length} bytes)`);
      // edit -> export -> re-import: the values become the base at strength 100
      await ev(() => window.__t8.groupSlider("basic", 0, 55));
      const expEdit = await exportBytes();
      await page.evaluate(async (bytes) => {
        await window.__np3app.transfer.importFile(new File([new Uint8Array(bytes)], "edited.NP3"));
      }, Array.from(expEdit));
      const re = await ev(() => ({ sat: window.__np3app.state.control.saturation,
                                   strength: window.__np3app.state.strength }));
      report(re.sat === 55 && re.strength === 100,
        `8 re-import of edits: saturation ${re.sat}, strength ${re.strength}%`);
    }

    // --- criterion 10: a corrupt NP3 and a corrupt RAW do not change the state ---
    await settle();   // catch up with the render from the re-import of edits
    {
      const err = await page.evaluate(async () => {
        const A = window.__np3app;
        const out = {};
        const ctl0 = JSON.stringify(A.state.control);
        await A.transfer.importFile(new File([new Uint8Array(600).fill(0xAB)], "bad.NP3"));
        out.ctlSame = JSON.stringify(A.state.control) === ctl0;
        out.importStatus = document.getElementById("status").textContent;
        const snap0 = window.__t8.snap();
        const raw0 = A.state.raw?.name;
        await A.loader.open(new File([new Uint8Array(4096).fill(0x55)], "bad.NEF"));
        out.rawSame = A.state.raw?.name === raw0;
        out.snapSame = window.__t8.snap() === snap0;
        out.rawStatus = document.getElementById("status").textContent;
        return out;
      });
      report(err.ctlSame && /fail/i.test(err.importStatus),
        `8 errors: a corrupt NP3 does not change the profile ("${err.importStatus}")`);
      report(err.rawSame && err.snapSame,
        `8 errors: a corrupt RAW keeps the frame and the profile ("${err.rawStatus}")`);
    }

    // --- criterion 11: statics by GET only, no request bodies ---
    report(netBad.length === 0,
      `8 locality: static resources by GET only${netBad.length ? " — " + netBad.join("; ") : ""}`);
    report(pageErrors.length === 0,
      `8 page without JS errors${pageErrors.length ? " — " + pageErrors.join("; ") : ""}`);
    // regression: the #nogl overlay must not cover the application when WebGL2 is available
    // (display:grid in CSS overrode the hidden attribute — the overlay hung always)
    const noglShown = await page.evaluate(() =>
      getComputedStyle(document.getElementById("nogl")).display !== "none");
    report(!noglShown, "8 the #nogl overlay is hidden with working WebGL2");
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log((failed ? `\nfailures: ${failed}` : "\nall tests green") + (skipped ? `, skipped: ${skipped}` : ""));
process.exit(failed ? 1 : 0);
