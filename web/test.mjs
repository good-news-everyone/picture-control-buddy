// Reference tests of the browser copy of the pipeline against Python. One command:
//
//     node web/test.mjs [--only 1f,9] [--skip 8]
//
// The Node levels (1, 1a, 1b, 1d, 1e, 1f, 1g, 1h, 1i, 1j, 1k, 1l, 9, 4, 5) run in parallel child
// processes — one process per level, each loads its own fixtures. The browser
// levels run as concurrent pages of one headless Firefox: web/test.html runs
// the shader levels (2, 2a, 6, 7 and the browser-side 1a checks, one page per
// level via ?only=), web/target-check.html runs 1c, level 8 keeps its internal
// order on its own page (the scenarios are NOT split), level 8b (the stage-8 full flow,
// races, resources and the stage-2 diagnostics probe; web/test-level8b.mjs) runs on
// another page alongside it. The exit code is
// non-zero on failure; the ok/FAIL lines print in the canonical level order.
// Fixtures and tolerances: web/golden/ (web/make_golden.py), levels and rules: spec/web-tests.md.
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const ROOT = path.dirname(HERE);                             // the project root
const man = JSON.parse(await readFile(path.join(HERE, "golden/manifest.json"), "utf8"));

// ---------- level selection: --only l1,l2 / --skip l1,l2 ----------
const argList = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : null;
};
const only = argList("--only");
const skipSet = new Set(argList("--skip") || []);
const selected = (l) => (!only || only.includes(l)) && !skipSet.has(l);

const NODE_LEVELS = ["1", "1a", "1b", "1d", "1e", "1f", "1g", "1h", "1i", "1j", "1k", "1l", "9", "4", "5"];
const PAGE_LEVELS = ["2", "2a", "1a", "6", "7"];   // web/test.html sections (the 1a entry is the browser-side decoding-rejection check)
// the canonical output order of the level reports (identical to the old sequential runner)
const ORDER = ["1", "1a", "1b", "1d", "1e", "1f", "1g", "1h", "1i", "1j", "1k", "1l", "9", "4", "5",
               "2", "2a", "1ab", "6", "7", "1c", "8", "8b", "8e", "9m"];
const PAGE_KEY = { "1a": "1ab" };                  // the browser-side 1a checks report under their own key

let failed = 0;
let skipped = 0;
const levelSecs = {};

// The levels run concurrently, but their output must stay in the canonical
// order: every line goes to a per-key buffer, a key's buffer prints only when
// all keys before it have finished. The ok/FAIL line format is unchanged.
const buffers = new Map(ORDER.map((k) => [k, []]));
const finished = new Set();
let flushed = 0;
const flushOrdered = () => {
  while (flushed < ORDER.length && finished.has(ORDER[flushed])) {
    for (const line of buffers.get(ORDER[flushed])) console.log(line);
    flushed++;
  }
};
const emit = (key, line) => { buffers.get(key).push(line); flushOrdered(); };
const finish = (key, secs) => {
  if (secs != null) levelSecs[key] = secs;
  finished.add(key);
  flushOrdered();
};
const reporter = (key) => ({
  report: (ok, text) => { emit(key, `${ok ? "ok  " : "FAIL"} ${text}`); if (!ok) failed++; },
  skip: (text) => { emit(key, `skip ${text}`); skipped++; },
});

// a tiny worker pool: `fn` over `items` with at most `n` concurrent calls
async function runPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

// ---------- the Node levels: one child process per level, in parallel ----------
const runNodeLevel = (level) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(HERE, "test-node-run.mjs"), level],
                  { cwd: HERE, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.on("close", (code) => {
    const lines = out.split("\n");
    const si = lines.findIndex((l) => l.startsWith("__LEVEL_SUMMARY__"));
    let summary = { failed: code ? 1 : 0, skipped: 0, secs: null };
    if (si >= 0) summary = { ...summary, ...JSON.parse(lines[si].slice("__LEVEL_SUMMARY__".length)) };
    for (const l of lines.slice(0, si < 0 ? lines.length : si)) if (l.length) emit(level, l);
    failed += summary.failed;
    skipped += summary.skipped;
    finish(level, summary.secs);
    resolve();
  });
});
const nodeSelected = NODE_LEVELS.filter(selected);
// the Node pool and the browser pages overlap: the ordered log keeps the output order
const nodeDone = nodeSelected.length
  ? runPool(nodeSelected, Math.min(nodeSelected.length, 12), runNodeLevel) : Promise.resolve();

// ---------- the browser levels: concurrent pages of one Firefox ----------
let browserDone = Promise.resolve();
if (PAGE_LEVELS.some(selected) || ["1c", "8", "8b", "8e", "9m"].some(selected)) {
  const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png",
    ".f32": "application/octet-stream", ".bin": "application/octet-stream",
    ".nef": "application/octet-stream", ".dng": "application/octet-stream",
    ".css": "text/css",
  };
  const server = http.createServer(async (req, res) => {
    try {
      let url = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (url.endsWith("/")) url += "index.html";       // a directory URL is its index page (the landing)
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

  // NP3_BROWSER=chrome runs the browser levels in Chromium (CHROME = its executable) — for
  // environments without Firefox; Firefox stays the reference browser of the suite.
  const BROWSER = process.env.NP3_BROWSER || "firefox";
  const firefox = process.env.FIREFOX || "/usr/bin/firefox";
  // protocolTimeout: level 8 fits in the page (stage 3) legitimately run for minutes — a
  // waitForFunction is one long-lived BiDi call, so the default 180 s cap kills healthy waits
  // Timer throttling of background tabs must stay off: the levels run as concurrent pages of
  // one Firefox, and a non-active page's setTimeout/setTimeout clamp to 1 s there (budget timer
  // throttling) — the level-8/8b assertions observe in-page timers while their page is not the
  // active tab (spec/web-tests.md). The *_without_budget_throttling clamp applies once the
  // budget throttling is off, so both minimums are lowered.
  // The browser language is pinned to English: the editor pages pick a translation from
  // navigator.languages (lib/i18n.js initLang), and the levels assert the English strings.
  const browser = BROWSER === "chrome"
    ? await puppeteer.launch({ browser: "chrome", executablePath: process.env.CHROME, headless: true,
        protocolTimeout: 900000,
        args: ["--no-sandbox", "--lang=en-US", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist",
               "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
               "--disable-backgrounding-occluded-windows"] })
    : await puppeteer.launch({ browser: "firefox", executablePath: firefox,
                                           headless: true, protocolTimeout: 900000,
                                           extraPrefsFirefox: {
                                             "dom.min_background_timeout_value": 4,
                                             "dom.min_background_timeout_value_without_budget_throttling": 4,
                                             "dom.timeout.enable_budget_timer_throttling": false,
                                             "intl.accept_languages": "en-US, en",
                                           } });
  // newPage from parallel tasks serially (BiDi)
  let newPageChain = Promise.resolve();
  const newPage = () => {
    const p = newPageChain.then(() => browser.newPage());
    newPageChain = p.catch(() => {});
    return p;
  };

  // one test.html page per shader level: ?only= runs just that section
  const runTestPage = async (level) => {
    const key = PAGE_KEY[level] || level;
    const t0 = Date.now();
    try {
      const page = await newPage();
      page.on("console", (m) => { if (m.type() === "error") emit(key, `console: ${m.text()}`); });
      page.on("pageerror", (e) => emit(key, `pageerror: ${e.message}`));
      await page.goto(`http://127.0.0.1:${port}/web/test.html?only=${level}`);
      await page.waitForFunction("window.__done === true", { timeout: 600000, polling: 500 });
      const r = await page.evaluate("window.__result");
      const { report, skip } = reporter(key);
      if (r.fatal) report(false, `page: ${r.fatal}`);
      if (level === "2") {
        const t = man.tolerances.synthetic;
        for (const s of r.synthetic || []) {
          report(!s.error && s.mean <= t.mean && s.max <= t.max,
            `2 neutral ${s.name}: mean ${(s.mean * 255).toFixed(4)} max ${(s.max * 255).toFixed(4)} of 255 (tolerance ${(t.mean * 255).toFixed(2)}/${(t.max * 255).toFixed(1)})`);
        }
      }
      if (level === "2a") {
        const t = man.tolerances.frames;
        for (const f of r.frames || []) {
          report(!f.error && f.mean <= t.mean && f.p99 <= t.p99 && f.max <= t.max,
            `2a frame ${f.key}: mean ${f.mean?.toFixed(3)} p99 ${f.p99} max ${f.max} of 255 (tolerance ${t.mean}/${t.p99}/${t.max})`);
        }
      }
      if (level === "1a") {
        for (const e of r.errors || []) {
          if (e.skip) { skip(`1a error (browser) ${e.path}: no file`); continue; }
          report(e.ok, `1a error (browser) ${e.path}: code ${e.got}, expected ${e.want}`);
        }
      }
      if (level === "6") {
        const t = man.tolerances.detail;
        for (const d of r.detail || []) {
          report(d.mean <= t.mean && d.max <= t.max,
            `6 detail ${d.key}: mean ${d.mean.toFixed(3)} max ${d.max} of 255 (tolerance ${t.mean}/${t.max})`);
        }
      }
      if (level === "7") {
        if (r.render7_dbg) emit(key, `render7 dbg: ${JSON.stringify(r.render7_dbg)}`);
        const t = man.tolerances.render7;
        for (const r7 of r.render7 || []) {
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
      }
      await page.close();
    } catch (e) {
      reporter(key).report(false, `${level}: ${e.message}`);
    }
    finish(key, (Date.now() - t0) / 1000);
  };

  // level 1c: decodeTarget in the browser vs the PIL reference grid
  const runTargetCheck = async () => {
    const t0 = Date.now();
    const key = "1c";
    try {
      const tdir = path.join(HERE, "golden", "target");
      const all = (await readdir(tdir)).filter((f) => f.endsWith(".json") && f !== "wb.json");
      const jm = {};
      for (const c of all.map((f) => f.replace(".json", "")))
        jm[c] = JSON.parse(await readFile(path.join(tdir, c + ".json"), "utf8"));
      const cases = Object.keys(jm).filter((c) => jm[c].image.format === "JPEG");
      const page = await newPage();
      page.on("pageerror", (e) => emit(key, `pageerror (target-check): ${e.message}`));
      await page.goto(`http://127.0.0.1:${port}/web/target-check.html?cases=${cases.join(",")}`);
      await page.waitForFunction("window.__done === true", { timeout: 120000, polling: 500 });
      const rows = await page.evaluate("window.__result");
      await page.close();
      const { report } = reporter(key);
      for (const c of cases) {
        const r = rows.find((v) => v.key === c);
        const tol = jm[c].ref.browserMaxLevels;
        const ok = !!r && !r.error && r.w === jm[c].image.w && r.h === jm[c].image.h && r.max <= tol;
        report(ok, `1c decode ${c}: ${!r ? "no result" : r.error || `${r.w}x${r.h},` +
          ` max ${r.max.toFixed(3)} of 255 levels (tolerance ${tol})`}`);
      }
    } catch (e) {
      reporter(key).report(false, `1c: ${e.message}`);
    }
    finish(key, (Date.now() - t0) / 1000);
  };

  // level 8: the end-to-end UI flow of the fitting wizard (picture-control-jpg-fit.html)
  const runLevel8Task = async () => {
    const t0 = Date.now();
    try {
      const { runLevel8 } = await import("./test-level8.mjs");
      const { report, skip } = reporter("8");
      await runLevel8({ browser: { newPage }, port, report, skip });
    } catch (e) {
      reporter("8").report(false, `8: ${e.stack || e.message}`);
    }
    finish("8", (Date.now() - t0) / 1000);
  };

  // level 8b: the stage-8 full flow (one fit, two refits), races, resources, the probe
  const runLevel8bTask = async () => {
    const t0 = Date.now();
    try {
      const { runLevel8b } = await import("./test-level8b.mjs");
      const { report, skip } = reporter("8b");
      await runLevel8b({ browser: { newPage }, port, report, skip });
    } catch (e) {
      reporter("8b").report(false, `8b: ${e.stack || e.message}`);
    }
    finish("8b", (Date.now() - t0) / 1000);
  };

  // level 8e: the profile editor page (picture-control-editor.html) and the landing
  const runLevel8eTask = async () => {
    const t0 = Date.now();
    try {
      const { runLevel8e } = await import("./test-level8e.mjs");
      const { report, skip } = reporter("8e");
      await runLevel8e({ browser: { newPage }, port, report, skip });
    } catch (e) {
      reporter("8e").report(false, `8e: ${e.stack || e.message}`);
    }
    finish("8e", (Date.now() - t0) / 1000);
  };

  // level 9m: the mobile levels 9a-9d on the editor pages (they need the real browser object:
  // isolated contexts, the touchscreen)
  const runMobileTask = async () => {
    const t0 = Date.now();
    try {
      const { runMobileLevels } = await import("./test-mobile.mjs");
      const { report, skip } = reporter("9m");
      await runMobileLevels({ browser, port, report, skip });
    } catch (e) {
      reporter("9m").report(false, `9m: ${e.stack || e.message}`);
    }
    finish("9m", (Date.now() - t0) / 1000);
  };

  // level 8 first: it is the longest, it overlaps the shader pages (its fits are
  // CPU-side page Workers, the shader levels are GPU-bound); the cap of 4 pages
  // bounds the GPU/RAM contention on this 16-core/30 GB machine
  const tasks = [];
  if (selected("8")) tasks.push(runLevel8Task);
  if (selected("8b")) tasks.push(runLevel8bTask);
  if (selected("8e")) tasks.push(runLevel8eTask);
  if (selected("9m")) tasks.push(runMobileTask);
  for (const l of PAGE_LEVELS) if (selected(l)) tasks.push(() => runTestPage(l));
  if (selected("1c")) tasks.push(runTargetCheck);
  browserDone = (async () => {
    try {
      await runPool(tasks, 4, (fn) => fn());
    } finally {
      await browser.close();
      server.close();
    }
  })();
}

await nodeDone;
await browserDone;
for (const key of ORDER) if (!finished.has(key)) finish(key);   // any missed key must not block the flush
flushOrdered();

// per-level timing summary
const parts = ORDER.filter((k) => levelSecs[k] != null).map((k) => `${k} ${levelSecs[k].toFixed(1)}s`);
console.log(`summary: ${parts.join(", ")}`);
console.log((failed ? `\nfailures: ${failed}` : "\nall tests green") + (skipped ? `, skipped: ${skipped}` : ""));
process.exit(failed ? 1 : 0);
