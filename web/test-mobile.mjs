// The mobile levels 9a-9d of web/test.mjs (spec/ui-mobile.md "Tests", spec/ui-mobile-plan.md
// stages M0-M3) on the profile-editor pages (spec/ui-pages.md): the router between
// picture-control-editor.html and picture-control-editor-mobile.html, the status kinds, the
// mobile shell (tool bar, undo, info sheet, toasts, version switch, redirects), touch
// interactions, the soft-disabled export and the share sheet, the curve overlay, the blender /
// grading sizes, the modified dots and the landscape layout. Ported from the mobile branch
// (where they ran on index.html / mobile.html with a Start screen); the mobile page is the
// editor only now. They report under one key, "9m"; the labels keep their 9a-9d stage names.
// Real touch input (puppeteer touchscreen, CDP) is exercised only in Chromium (NP3_BROWSER=chrome).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const ROOT = path.dirname(HERE);                             // the project root
const rootFile = (p) => {
  for (const c of [path.join(ROOT, p), path.join(ROOT, "_local", p)]) if (existsSync(c)) return c;
  return null;
};
const BROWSER = process.env.NP3_BROWSER || "firefox";

export async function runMobileLevels({ browser, port, report, skip }) {
  // ---------- level 9a: mobile work, stage M0 — desktop references, router, status kinds ----------
  // (spec/ui-mobile-plan.md §4). No RAW files are needed.
  // The desktop reference screenshots live in _local/ui-ref/ (per machine, gitignored). They are
  // written only by the operator (NP3_UI_REF=write); a missing reference skips the comparison.
  const UI_REF = path.join(ROOT, "_local", "ui-ref");
  const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want);
  const uiShot = async (pg, name) => {
    // identical procedure for writing and comparing: 1280x800 @1x, Start screen, then the editor
    // shell without a RAW (the step is switched by the same two lines app.js uses)
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await pg.goto(`http://127.0.0.1:${port}/web/picture-control-editor.html?view=desktop`);
    await pg.waitForFunction(`window.__np3app && window.__np3app.state.step === "edit"`,
      { timeout: 120000, polling: 200 });
    const settleUi = async () => {
      await pg.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 200));
        // a full repaint: the pixels must not depend on the paint history (content inserted
        // after the first paint leaves 1-level antialiasing residue on rounded corners)
        document.documentElement.style.display = "none";
        void document.documentElement.offsetHeight;
        document.documentElement.style.display = "";
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
    };
    await settleUi();
    const start = await pg.screenshot({ type: "png" });
    await pg.evaluate(() => {
      window.__np3app.state.step = "edit";
      document.body.classList.toggle("step-start", false);
      document.body.classList.toggle("step-edit", true);
    });
    await settleUi();
    const edit = await pg.screenshot({ type: "png" });
    return { start, edit };
  };
  if (process.env.NP3_UI_REF === "write") {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(UI_REF, { recursive: true });
    const pg = await browser.newPage();
    const shots = await uiShot(pg, "ref");
    await writeFile(path.join(UI_REF, "start.png"), shots.start);
    await writeFile(path.join(UI_REF, "edit.png"), shots.edit);
    await pg.close();
    console.log(`desktop references written to ${UI_REF}`);
    report(true, "9a desktop references written (NP3_UI_REF=write)");
  } else if (!existsSync(path.join(UI_REF, "start.png")) || !existsSync(path.join(UI_REF, "edit.png"))) {
    skip("9a desktop screenshots: no references in _local/ui-ref/ (the operator writes them with NP3_UI_REF=write)");
  } else {
    const pg = await browser.newPage();
    const shots = await uiShot(pg, "cur");
    for (const k of ["start", "edit"]) {
      const ref = await readFile(path.join(UI_REF, k + ".png"));
      const diff = await pg.evaluate(async (a, b) => {
        const load = (u) => new Promise((res, rej) => {
          const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u;
        });
        const px = async (u) => {
          const im = await load(u);
          const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
          const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(im, 0, 0);
          return { w: im.width, h: im.height, d: x.getImageData(0, 0, im.width, im.height).data };
        };
        const A = await px(a), B = await px(b);
        if (A.w !== B.w || A.h !== B.h) return { size: `${A.w}x${A.h} vs ${B.w}x${B.h}` };
        let n = 0;
        for (let i = 0; i < A.d.length; i += 4)
          if (A.d[i] !== B.d[i] || A.d[i + 1] !== B.d[i + 1] || A.d[i + 2] !== B.d[i + 2] || A.d[i + 3] !== B.d[i + 3]) n++;
        return { n };
      }, "data:image/png;base64," + Buffer.from(shots[k]).toString("base64"),
         "data:image/png;base64," + ref.toString("base64"));
      report(diff.n === 0, `9a desktop screenshot ${k}: ${diff.size ? "size " + diff.size : diff.n + " differing pixels"}`);
    }
    await pg.close();
  }

  // --- router: the pure choose() and the load-time step in Node (vm with a stub window) ---
  {
    const { runInNewContext } = await import("node:vm");
    const routeSrc = await readFile(path.join(HERE, "lib/view-route.js"), "utf8");
    const load = (hook, win = {}) => {
      const window = { NP3_ROUTE_TEST: hook, ...win };
      runInNewContext(routeSrc, { window, URL, URLSearchParams });
      return window;
    };
    const R = load({ mobileReady: true }).NP3Route;
    const phone = { coarse: true, screenMin: 390 };
    const pick = (a) => { const r = R.choose(a); return [r.want, r.store, r.search]; };
    report(eq(pick({ page: "desktop", search: "?view=mobile" }), ["mobile", "mobile", ""]),
      "9a router: ?view=mobile wins and is stored, the parameter is stripped");
    report(eq(pick({ page: "mobile", search: "?view=desktop", stored: "mobile", ...phone }), ["desktop", "desktop", ""]),
      "9a router: ?view=desktop beats a stored mobile preference and the phone rule");
    report(eq(pick({ page: "desktop", stored: "mobile" }), ["mobile", null, ""]),
      "9a router: a stored preference is used without storing again");
    report(eq(pick({ page: "mobile", stored: "desktop", ...phone }), ["desktop", null, ""]),
      "9a router: a stored desktop preference beats the phone rule");
    report(eq(pick({ page: "desktop", ...phone }), ["mobile", null, ""]),
      "9a router: auto picks mobile for a coarse pointer with the short screen side < 600");
    report(eq(pick({ page: "desktop", coarse: true, screenMin: 600 }), ["desktop", null, ""])
        && eq(pick({ page: "desktop", coarse: true, screenMin: 599 }), ["mobile", null, ""])
        && eq(pick({ page: "desktop", coarse: true, screenMin: 834 }), ["desktop", null, ""]),
      "9a router: the 600 px boundary and a tablet (834) stay desktop");
    report(eq(pick({ page: "desktop", coarse: false, screenMin: 390 }), ["desktop", null, ""]),
      "9a router: a fine pointer never picks mobile automatically");
    report(eq(pick({ page: "desktop", stored: "bogus", ...phone }), ["mobile", null, ""])
        && eq(pick({ page: "desktop", search: "?view=bogus", ...phone }), ["mobile", null, ""]),
      "9a router: an invalid stored value or ?view= falls through to the auto rule (view= still stripped)");
    report(eq(pick({ page: "desktop", search: "?view=mobile&np3=AbC-_9" }), ["mobile", "mobile", "?np3=AbC-_9"])
        && eq(pick({ page: "desktop", search: "?np3=AbC-_9&view=desktop&x=1" }), ["desktop", "desktop", "?np3=AbC-_9&x=1"])
        && eq(pick({ page: "desktop", search: "?np3=AbC-_9" }), ["desktop", null, "?np3=AbC-_9"]),
      "9a router: other search parameters are preserved when view= is stripped");
    const RN = load({ mobileReady: false }).NP3Route;
    report(eq(RN.choose({ page: "desktop", search: "?view=mobile", stored: "mobile", ...phone }).want, "desktop")
        && RN.choose({ page: "desktop", search: "?view=mobile" }).store === null,
      "9a router: while mobile is not ready (MOBILE_READY false) the answer is always desktop");
    report(load({}).NP3Route.choose({ page: "desktop", ...phone }).want === "mobile"
        && eq(R.PAGES, { desktop: "picture-control-editor.html", mobile: "picture-control-editor-mobile.html" }),
      "9a router: the shipped MOBILE_READY default (true since M1) and PAGES");
    report(R.canonical("http://h/web/picture-control-editor-mobile.html?np3=x#y").href === "http://h/web/picture-control-editor.html"
        && R.canonical("http://h/web/").href === "http://h/web/picture-control-editor.html",
      "9a router: canonical() is the desktop editor page beside the current page, without search/hash");

    // the load-time step: stub window with location, history, storage
    const stub = (o) => {
      const calls = { replace: [], state: [], set: [] };
      const w = {
        location: { pathname: o.pathname, search: o.search ?? "", hash: o.hash ?? "", replace: (u) => calls.replace.push(u) },
        history: { replaceState: (a, b, u) => calls.state.push(u) },
        localStorage: o.storageThrows
          ? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
          : { getItem: () => o.stored ?? null, setItem: (k, v) => calls.set.push([k, v]) },
        matchMedia: () => ({ matches: !!o.coarse }),
        screen: { width: o.screen ?? 1920, height: o.screen2 ?? 1080 },
      };
      return { w, calls };
    };
    {
      const { w, calls } = stub({ pathname: "/web/picture-control-editor.html", search: "?view=mobile&np3=Q", hash: "#h" });
      const win = load({ mobileReady: true, run: true }, w);
      report(calls.replace.length === 1 && calls.replace[0] === "picture-control-editor-mobile.html?np3=Q#h"
          && win.NP3_REDIRECTING === true && eq(calls.set, [["np3view", "mobile"]]),
        `9a router: a redirect keeps ?np3= and the hash, drops view=, stores the choice (${calls.replace[0]})`);
    }
    {
      const { w, calls } = stub({ pathname: "/web/picture-control-editor.html", search: "?view=desktop&np3=Q", hash: "#h" });
      const win = load({ mobileReady: true, run: true }, w);
      report(calls.replace.length === 0 && !win.NP3_REDIRECTING
          && eq(calls.state, ["/web/picture-control-editor.html?np3=Q#h"]) && eq(calls.set, [["np3view", "desktop"]]),
        "9a router: no redirect when the page is the chosen one; view= is dropped with replaceState");
    }
    {
      const { w, calls } = stub({ pathname: "/web/picture-control-editor-mobile.html", search: "?view=mobile" });
      load({ mobileReady: true, run: true }, w);
      report(calls.replace.length === 0 && eq(calls.state, ["/web/picture-control-editor-mobile.html"]),
        "9a router: picture-control-editor-mobile.html with ?view=mobile stays (no redirect loop)");
    }
    {
      const { w, calls } = stub({ pathname: "/web/", search: "?np3=Q", coarse: true, screen: 390, screen2: 844 });
      load({ mobileReady: true, run: true }, w);
      report(eq(calls.replace, ["picture-control-editor-mobile.html?np3=Q"]) && calls.set.length === 0,
        "9a router: the auto rule redirects a phone from the directory URL");
    }
    {
      const { w, calls } = stub({ pathname: "/web/picture-control-editor.html", search: "?view=mobile", storageThrows: true });
      let threw = null;
      try { load({ mobileReady: true, run: true }, w); } catch (e) { threw = e; }
      report(!threw && eq(calls.replace, ["picture-control-editor-mobile.html"]),
        "9a router: a throwing localStorage means no stored preference and does not break the page");
    }
    {
      const { w, calls } = stub({ pathname: "/web/picture-control-editor-mobile.html", search: "?np3=Q", coarse: true, screen: 390 });
      load({ run: true }, w);          // the shipped MOBILE_READY (true): a phone stays on picture-control-editor-mobile.html
      report(calls.replace.length === 0 && calls.set.length === 0,
        "9a router: with the shipped MOBILE_READY (true) a phone stays on picture-control-editor-mobile.html");
    }
  }

  // --- the core on the real desktop page: shell, static texts, status kinds, share link ---
  {
    const pg = await browser.newPage();
    const errs = [];
    pg.on("pageerror", (e) => errs.push(e.message));
    await pg.setViewport({ width: 1280, height: 800 });
    await pg.goto(`http://127.0.0.1:${port}/web/picture-control-editor.html?view=desktop`);
    await pg.waitForFunction(`window.__np3app && window.__np3app.state.step === "edit"`,
      { timeout: 120000, polling: 200 });
    const info = await pg.evaluate(() => ({
      search: location.search,
      shell: window.__np3app.shell,
      css: [...document.styleSheets].some((s) => (s.href || "").endsWith("/css/common.css"))
        && getComputedStyle(document.body).backgroundColor === "rgb(38, 38, 38)",
      route: typeof window.NP3Route?.choose,
      hasOnStatus: "onStatus" in window.__np3app,
    }));
    report(info.search === "" && info.shell.kind === "desktop" && info.css && info.route === "function",
      "9a desktop page: ?view=desktop is consumed, shell kind and common.css are in place");
    const kinds = await pg.evaluate(async () => {
      const app = window.__np3app, seen = [];
      app.onStatus = (text, kind) => seen.push([text, kind]);
      const out = { initial: app.state.statusKind };
      await app.transfer.importFile(new File([new Uint8Array(10)], "bad.NP3"));
      out.afterBad = app.state.statusKind;
      out.badText = app.state.status;
      const good = await (await fetch("/web/golden/np3/out__fit4__NIKON__CUSTOMPC__PICCON01.NP3")).arrayBuffer();
      await app.transfer.importFile(new File([good], "good.NP3"));
      out.afterGood = app.state.statusKind;
      app.routeFile(new File([new Uint8Array(4)], "x.txt"));
      out.afterUnsupported = app.state.statusKind;
      out.seen = seen.map((x) => x[1]);
      out.link = app.transfer.shareLink();
      out.origin = location.origin;
      return out;
    });
    report(kinds.initial === "info" && kinds.afterBad === "error" && kinds.afterGood === "info"
        && kinds.afterUnsupported === "error" && eq(kinds.seen, ["error", "info", "error"]),
      `9a setStatus kinds: import error -> error, import ok -> info, unsupported file -> error; onStatus hook fires ("${kinds.badText}")`);
    report(kinds.link.startsWith(`${kinds.origin}/web/picture-control-editor.html?np3=`)
        && kinds.link.split("?np3=")[1].length > 100,
      `9a shareLink(): the desktop editor page with ?np3= (${kinds.link.slice(0, 70)}…)`);
    await pg.goto(kinds.link.replace("picture-control-editor.html?", "picture-control-editor.html?view=desktop&"));
    await pg.waitForFunction(`window.__np3app && window.__np3app.state.status.startsWith("Imported from link")`,
      { timeout: 60000, polling: 100 });
    report(true, "9a shareLink(): the generated link opens the profile on a fresh page");
    report(errs.length === 0, `9a desktop page without JS errors${errs.length ? " — " + errs.join("; ") : ""}`);
    await pg.close();
  }

  // ---------- level 9b: mobile work, stage M1 — the mobile shell on web/mobile.html ----------
  // (spec/ui-mobile.md "Tests" items 1, 2, 3 (portrait), 5, 6, 7 (no modified dot), 8, 9, 15, 16 and the
  // M1 plan checks). Runs without RAW files: the editor step is entered by the same two body-class
  // lines as the 9a screenshots, history is made with an NP3 import + a slider change. Phones are
  // emulated (isMobile + touch); the router tests use isolated browser contexts (own localStorage).
  {
    const MOBILE = `http://127.0.0.1:${port}/web/picture-control-editor-mobile.html?view=mobile`;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const REQUIRED = ["c", "nogl", "ba-slot", "panel-scroll", "panel-foot", "curve-slot", "blending-slot",
      "grading-slot", "file", "info", "warn", "status", "import", "export", "share", "curve-chart", "empty"];
    const WIZARD = ["start", "compare", "more", "report", "pairs", "raw-drop", "target-drop", "fit", "to-start"];
    const mkPage = async (ctx, w, h, url = MOBILE) => {
      const pg = await ctx.newPage();
      pg.errs = [];
      pg.on("pageerror", (e) => pg.errs.push(e.message));
      pg.on("console", (m) => {
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pg.errs.push("console: " + m.text());
      });
      pg.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) pg.errs.push(`HTTP ${r.status()} ${r.url()}`); });
      await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await pg.goto(url);
      await pg.waitForFunction("window.__np3app && window.__np3app.mobile", { timeout: 120000, polling: 100 });
      return pg;
    };
    const goEdit = (pg) => pg.evaluate(() => {
      window.__np3app.state.step = "edit";
      document.body.classList.toggle("step-start", false);
      document.body.classList.toggle("step-edit", true);
    });
    const rect = (pg, sel) => pg.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right };
    }, sel);
    const small = (pg, sel) => pg.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length > 0).map((e) => {   // elements without a box (hidden) are not tap targets
      const r = e.getBoundingClientRect();
      return { id: e.id || e.className || e.tagName, w: Math.round(r.width), h: Math.round(r.height) };
    }).filter((x) => x.w < 43.5 || x.h < 43.5), sel);
    const count = (pg, sel) => pg.evaluate((sel) => document.querySelectorAll(sel).length, sel);
    const groupsShown = (pg) => pg.evaluate(() => [...document.querySelectorAll("details.grp")]
      .filter((g) => getComputedStyle(g).display !== "none" && g.getBoundingClientRect().height > 0)
      .map((g) => g.dataset.group));
    const loadSample = (pg, name = "tonecurve-noop.NP3") => pg.evaluate(async (name) => {
      const b = await (await fetch("/third_party/samples/" + name)).arrayBuffer();
      await window.__np3app.transfer.importFile(new File([b], name));
      return window.__np3app.state.control.name;
    }, name);
    const setSlider = (pg, key, v) => pg.evaluate((key, v) => {
      const el = document.querySelector(`.ctl[data-key="${key}"] input[type=range]`);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return window.__np3app.state.control[key];
    }, key, v);
    const dlgOpen = (pg, id) => pg.evaluate((id) => document.getElementById(id).hasAttribute("open"), id);
    const noScroll = (pg) => pg.evaluate(() => {
      window.scrollTo(0, 60);
      return { v: document.documentElement.scrollHeight <= innerHeight && window.scrollY === 0,
               h: document.documentElement.scrollWidth <= innerWidth, y: window.scrollY };
    });
    const ctx = await browser.createBrowserContext();

    // ---- 1: the DOM contract, a clean console; the editor only (no Start screen) ----
    {
      const pg = await mkPage(ctx, 390, 844);
      const r = await pg.evaluate((ids, wiz) => ({
        missing: ids.filter((id) => !document.getElementById(id)),
        wizard: wiz.filter((id) => document.getElementById(id)),
        kind: window.__np3app.shell.kind, tool: window.__np3app.mobile.tool,
        step: document.body.className, appStep: window.__np3app.state.step,
        viewport: document.querySelector('meta[name=viewport]').content,
        empty: getComputedStyle(document.getElementById("empty")).display,
      }), REQUIRED, WIZARD);
      report(r.missing.length === 0 && r.wizard.length === 0 && r.kind === "mobile" && r.tool === "basic",
        `9b DOM contract: the mobile editor page has every required id${r.missing.length ? " — missing " + r.missing : ""}` +
        ` and no wizard part${r.wizard.length ? " — found " + r.wizard : ""}; shell kind mobile, default tool basic`);
      report(r.viewport.includes("viewport-fit=cover") && r.step.includes("step-edit") && r.appStep === "edit" && r.empty !== "none",
        "9b mobile editor: viewport-fit=cover, opens straight into the editor with the empty state (no Start screen)");
      await sleep(300);
      report(pg.errs.length === 0, `9b mobile editor: the core starts without errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
    }

    // ---- 2: portrait layout 390 x 844 ----
    {
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const R = {};
      for (const k of ["topbar", "view", "panel", "toolbar"]) R[k] = await rect(pg, "#" + k);
      const ns = await noScroll(pg);
      const want = Math.min(360, Math.max(200, 0.38 * 844));
      report(R.topbar.y === 0 && R.topbar.h === 48 && R.toolbar.h === 60 && Math.abs(R.panel.h - want) < 1
          && R.view.h > 150 && R.topbar.b <= R.view.y + 0.5 && R.view.b <= R.panel.y + 0.5
          && R.panel.b <= R.toolbar.y + 0.5 && Math.abs(R.toolbar.b - 844) < 0.5
          && R.view.w === 390 && R.panel.w === 390,
        `9b portrait 390x844: top bar 48, viewer ${Math.round(R.view.h)}, panel ${Math.round(R.panel.h)} (clamp 38dvh), tool bar 60 — stacked without overlap`);
      report(ns.v && ns.h, "9b portrait 390x844: the page has no scroll (scrollHeight == innerHeight, no horizontal overflow)");
      const bg = await pg.evaluate(() => ({ view: getComputedStyle(document.getElementById("view")).backgroundColor,
        ob: getComputedStyle(document.body).overscrollBehaviorY, sum: getComputedStyle(document.querySelector("details.grp > summary")).display,
        foot: getComputedStyle(document.getElementById("panel-foot")).display, foot_btn: !!document.getElementById("p-reset") }));
      report(bg.view === "rgb(0, 0, 0)" && bg.ob === "none" && bg.sum === "none" && bg.foot === "none" && bg.foot_btn,
        "9b portrait: viewer #000, overscroll none, group summaries and #panel-foot hidden (the panel's own Reset still exists)");
      const sm = await small(pg, "#topbar button, #toolbar button");
      report(sm.length === 0 && await count(pg, "#topbar button") === 6 && await count(pg, "#toolbar button") === 7,
        `9b top bar (6 buttons) and tool bar (7 items): every target >= 44 x 44${sm.length ? " — small: " + JSON.stringify(sm) : ""}`);
      const order = await pg.evaluate(() => ({
        left: [...document.querySelectorAll("#topbar .grp-l button")].map((b) => b.id),
        right: [...document.querySelectorAll("#topbar .grp-r button")].map((b) => b.id),
        labels: [...document.querySelectorAll("#topbar button")].map((b) => b.textContent.trim()),
        tools: [...document.querySelectorAll("#toolbar button")].map((b) => b.textContent.trim()),
        tablist: document.getElementById("tools").getAttribute("role"),
        add: document.getElementById("add").querySelector(".plus").getBoundingClientRect().width,
      }));
      report(eq(order.left, ["add", "info-btn"]) && eq(order.right, ["undo", "import", "export", "share"])
          && eq(order.labels, ["Open RAW", "Info", "Undo", "Import NP3", "Export NP3", "Copy link"])
          && eq(order.tools, ["Profile", "Basic", "Curve", "Details", "Blender", "Grading", "Reset"])
          && order.tablist === "tablist" && order.add === 36,
        `9b top bar order (Add, Info | Undo, Import, Export, Link) and tool bar order, accessible names present`);
      report(pg.errs.length === 0, `9b editor step 390x844: no JS errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
    }

    // ---- 3: 360 x 640 ----
    {
      const pg = await mkPage(ctx, 360, 640);
      await goEdit(pg);
      const ns = await noScroll(pg);
      const tb = await pg.evaluate(() => { const t = document.getElementById("toolbar"); return { sw: t.scrollWidth, cw: t.clientWidth }; });
      const R = {};
      for (const k of ["topbar", "view", "panel", "toolbar"]) R[k] = await rect(pg, "#" + k);
      const inside = await pg.evaluate(() => [...document.querySelectorAll("#topbar button")]
        .every((b) => { const r = b.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth; }));
      report(ns.v && ns.h && tb.sw > tb.cw && R.view.h > 150 && R.toolbar.b <= 640.5 && inside
          && R.topbar.b <= R.view.y + .5 && R.view.b <= R.panel.y + .5 && R.panel.b <= R.toolbar.y + .5,
        `9b portrait 360x640: no page scroll, nothing cut off, the tool bar scrolls horizontally (${tb.sw} > ${tb.cw}), viewer ${Math.round(R.view.h)} px`);
      const sm = await small(pg, "#topbar button, #toolbar button");
      report(sm.length === 0, `9b 360x640: top bar and tool bar targets >= 44 x 44${sm.length ? " — " + JSON.stringify(sm) : ""}`);
      // the active tool is scrolled into view
      await pg.evaluate(() => window.__np3app.mobile.setTool("grading"));
      const vis = await pg.evaluate(() => { const r = document.getElementById("tab-grading").getBoundingClientRect(); return r.x >= -0.5 && r.right <= innerWidth + 0.5; });
      report(vis, "9b 360x640: selecting the last tool scrolls it into view");
      // info sheet targets
      await pg.tap("#info-btn");
      await pg.waitForFunction(() => document.getElementById("sheet").hasAttribute("open"));
      const sm2 = await small(pg, "#sheet button, #sheet a");
      const sh = await pg.evaluate(() => { const r = document.getElementById("sheet").getBoundingClientRect();
        return { h: r.height, max: innerHeight * 0.85, bottom: r.bottom, ih: innerHeight, x: r.x, w: r.width }; });
      report(sm2.length === 0 && sh.h <= sh.max + 1 && Math.abs(sh.bottom - sh.ih) < 1 && sh.w === 360,
        `9b 360x640: the info sheet fits (${Math.round(sh.h)} <= 85dvh), sits at the bottom, targets >= 44${sm2.length ? " — " + JSON.stringify(sm2) : ""}`);
      await pg.close();
    }

    // ---- 7: tool bar ----
    {
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const d0 = await groupsShown(pg);
      const sel0 = await pg.evaluate(() => [...document.querySelectorAll("#tools [role=tab]")].filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.dataset.tool));
      report(eq(d0, ["basic"]) && eq(sel0, ["basic"]), "9b tool bar: the default tool is Basic and only its group is shown");
      let ok = true, bad = "";
      for (const k of ["strength", "curve", "details", "blender", "grading", "basic"]) {
        await pg.tap(`#tab-${k}`);
        const g = await groupsShown(pg);
        const info = await pg.evaluate((k) => ({
          tool: window.__np3app.mobile.tool,
          sel: [...document.querySelectorAll("#tools [role=tab]")].filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.dataset.tool),
          panel: document.getElementById(`tool-${k}`).getAttribute("role"),
          labelled: document.getElementById(`tool-${k}`).getAttribute("aria-labelledby"),
          open: [...document.querySelectorAll("details.grp")].every((x) => x.open),
        }), k);
        if (!(eq(g, [k]) && info.tool === k && eq(info.sel, [k]) && info.panel === "tabpanel" && info.labelled === `tab-${k}` && info.open)) {
          ok = false; bad += ` ${k}:${JSON.stringify([g, info])}`;
        }
      }
      report(ok, `9b tool bar: tapping each of the six tools shows exactly its group (tab/tabpanel roles, aria-selected)${bad}`);
      const act = await pg.evaluate(() => document.getElementById("reset-btn").hasAttribute("aria-selected"));
      report(!act, "9b tool bar: Reset is an action, not a tool (no aria-selected)");
      // changing a tool resets the panel scroll
      await pg.tap("#tab-blender");
      await pg.evaluate(() => { document.getElementById("panel-scroll").scrollTop = 40; });
      await pg.tap("#tab-basic");
      report(await pg.evaluate(() => document.getElementById("panel-scroll").scrollTop === 0), "9b tool bar: switching the tool scrolls the panel to the top");
      await pg.close();
    }

    // ---- empty state, Add ----
    {
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const e = await pg.evaluate(() => ({ canvas: document.getElementById("c").hidden,
        empty: getComputedStyle(document.getElementById("empty")).display,
        ba: getComputedStyle(document.getElementById("ba-slot")).display,
        text: document.getElementById("empty").textContent.trim() }));
      await pg.evaluate(() => {
        window.__fc = 0;
        document.getElementById("file").addEventListener("click", (ev) => { window.__fc++; ev.preventDefault(); });
      });
      await pg.tap("#add");
      await pg.tap("#empty");
      const fc = await pg.evaluate(() => window.__fc);
      report(e.canvas && e.empty !== "none" && e.ba === "none" && e.text === "Open a RAW (.NEF / .DNG)" && fc === 2,
        `9b empty state: no canvas, the "Open a RAW" target is shown, Add and the target both open the RAW picker (${fc} clicks)`);
      await pg.close();
    }

    // ---- 8, 9: undo and reset (an NP3 import + slider changes make the history) ----
    {
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const name = await loadSample(pg);
      const s0 = await pg.evaluate(() => ({ idx: window.__np3app.hist.index, dis: document.getElementById("undo").disabled,
        contrast: window.__np3app.state.control.contrast }));
      report(s0.idx === 0 && s0.dis === true, "9b undo: disabled on a fresh history");
      await pg.tap("#tab-basic");
      await setSlider(pg, "contrast", 30);
      const s1 = await pg.evaluate(() => ({ dis: document.getElementById("undo").disabled, idx: window.__np3app.hist.index }));
      await pg.tap("#undo");
      const s2 = await pg.evaluate(() => ({ dis: document.getElementById("undo").disabled, c: window.__np3app.state.control.contrast,
        slider: document.querySelector('.ctl[data-key="contrast"] input[type=range]').value }));
      report(s1.dis === false && s1.idx === 1 && s2.dis === true && s2.c === s0.contrast && Number(s2.slider) === s0.contrast,
        "9b undo: enabled after a change, restores the previous value (state and slider), disabled again at the base");
      // reset
      await setSlider(pg, "contrast", 30);
      await setSlider(pg, "saturation", -20);
      await pg.tap("#tab-strength");
      await pg.evaluate(() => {
        const el = document.querySelector("#tool-strength .ctl input[type=range]");
        el.value = 120; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const before = await pg.evaluate(() => ({ idx: window.__np3app.hist.index, c: window.__np3app.state.control.contrast,
        s: window.__np3app.state.control.saturation, st: window.__np3app.state.strength, n: window.__np3app.state.control.name }));
      report(before.c === 30 && before.s === -20 && before.st === 120, "9b reset: the setup (contrast 30, saturation -20, strength 120)");
      const state = () => pg.evaluate(() => ({ idx: window.__np3app.hist.index, c: window.__np3app.state.control.contrast,
        s: window.__np3app.state.control.saturation, st: window.__np3app.state.strength, n: window.__np3app.state.control.name }));
      await pg.tap("#reset-btn");
      const o1 = await dlgOpen(pg, "confirm-reset");
      const title = await pg.evaluate(() => [document.getElementById("confirm-title").textContent, document.querySelector("#confirm-reset p").textContent,
        document.getElementById("confirm-ok").textContent, document.getElementById("confirm-cancel").textContent,
        getComputedStyle(document.getElementById("confirm-ok")).color]);
      report(o1 && title[0] === "Reset the whole profile?" && title[1] === "All settings return to neutral. The name is kept. You can undo it."
          && title[2] === "Reset" && title[3] === "Cancel" && title[4] === "rgb(224, 122, 106)",
        "9b reset: the confirmation dialog opens with the specified texts, Reset in the --bad color");
      await pg.tap("#confirm-cancel");
      let a = await state();
      report(!(await dlgOpen(pg, "confirm-reset")) && eq(a, before), "9b reset: Cancel closes the dialog and changes nothing");
      await pg.tap("#reset-btn");
      await pg.keyboard.press("Escape");
      a = await state();
      report(!(await dlgOpen(pg, "confirm-reset")) && eq(a, before), "9b reset: Escape closes the dialog and changes nothing");
      await pg.tap("#reset-btn");
      await pg.mouse.click(8, 8);                       // the scrim
      a = await state();
      report(!(await dlgOpen(pg, "confirm-reset")) && eq(a, before), "9b reset: a tap on the scrim closes the dialog and changes nothing");
      // askReset() promise
      const pr = await pg.evaluate(async () => {
        const p = window.__np3app.mobile.askReset();
        document.getElementById("confirm-cancel").click();
        return await p;
      });
      report(pr === false, "9b reset: askReset() resolves false on Cancel");
      await pg.tap("#reset-btn");
      await pg.tap("#confirm-ok");
      await pg.waitForFunction(() => window.__np3app.state.control.contrast === 0, { timeout: 5000, polling: 20 });   // Reset runs after the dialog's close event
      a = await state();
      report(!(await dlgOpen(pg, "confirm-reset")) && a.c === 0 && a.s === 0 && a.st === 100 && a.n === before.n && a.idx === before.idx + 1,
        `9b reset: confirming neutralizes the profile (strength 100), keeps the name "${a.n}" and is one history step`);
      await pg.tap("#undo");
      a = await state();
      report(a.c === 30 && a.s === -20 && a.st === 120 && a.n === before.n, "9b reset: Undo restores the state before Reset");
      report(typeof name === "string" && name.length > 0, "9b the NP3 sample imported without a RAW file");
      await pg.close();
    }

    // ---- 15: info sheet, Back to Start; 16: toasts; export and copy link ----
    {
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      await loadSample(pg);
      await sleep(100);
      await pg.tap("#info-btn");
      const o1 = await dlgOpen(pg, "sheet");
      const foc1 = await pg.evaluate(() => document.getElementById("sheet").contains(document.activeElement));
      const txt = await pg.evaluate(() => document.getElementById("sheet").textContent);
      const srcLabel = await pg.evaluate(() => document.getElementById("source-link").getAttribute("aria-label"));
      report(o1 && foc1 && !txt.includes("Back to Start") && txt.includes("Gestures") && txt.includes("Known limitations")
          && txt.includes("Photos library") && /Source code/.test(srcLabel) && txt.includes("Desktop version")
          && txt.includes("Approximate calculation"),
        "9b info sheet: opens as a modal dialog, focus moves in; the caption, gestures, limitations (iOS hint), source link and version switch are there");
      await pg.tap("#sheet-close");
      report(!(await dlgOpen(pg, "sheet")) && await pg.evaluate(() => document.activeElement.id === "info-btn"),
        "9b info sheet: the close button closes it and focus returns to Info");
      await pg.tap("#info-btn");
      await pg.mouse.click(195, 40);                    // the scrim above the sheet
      report(!(await dlgOpen(pg, "sheet")), "9b info sheet: a tap on the scrim closes it");
      await pg.tap("#info-btn");
      await pg.keyboard.press("Escape");
      report(!(await dlgOpen(pg, "sheet")), "9b info sheet: Escape closes it");
      await pg.tap("#info-btn");
      await pg.evaluate(() => {
        const h = document.querySelector("#sheet .handle");
        const ev = (type, y) => h.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", clientX: 195, clientY: y, bubbles: true }));
        ev("pointerdown", 400); ev("pointermove", 450); ev("pointermove", 520); ev("pointerup", 520);
      });
      report(!(await dlgOpen(pg, "sheet")), "9b info sheet: a swipe down on the handle closes it");
      await pg.tap("#info-btn");
      await pg.evaluate(() => {
        const h = document.querySelector("#sheet .handle");
        const ev = (type, y) => h.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", clientX: 195, clientY: y, bubbles: true }));
        ev("pointerdown", 400); ev("pointermove", 420); ev("pointerup", 420);
      });
      report(await dlgOpen(pg, "sheet"), "9b info sheet: a short drag on the handle does not close it");
      report(!(await pg.evaluate(() => !!document.getElementById("to-start"))),
        "9b info sheet: no \"Back to Start\" (the mobile page is the editor only)");
      await pg.close();
    }

    {
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      // errors: the toast stays 6 s, sits between the bars, the Info dot appears and clears on open
      const t0 = Date.now();
      await pg.evaluate(() => window.__np3app.transfer.importFile(new File([new Uint8Array(10)], "bad.NP3")));
      const e1 = await pg.evaluate(() => ({ toasts: window.__np3app.mobile.toasts(),
        dot: !document.querySelector("#info-btn .dot").hidden, kind: window.__np3app.state.statusKind }));
      const tr = await pg.evaluate(() => { const r = document.querySelector(".toast.error").getBoundingClientRect(); return { y: r.y, b: r.bottom }; });
      const bars = { top: (await rect(pg, "#topbar")).b, tool: (await rect(pg, "#toolbar")).y };
      const pe = await pg.evaluate(() => getComputedStyle(document.getElementById("toasts")).pointerEvents);
      report(e1.toasts.length === 1 && e1.toasts[0].kind === "error" && e1.toasts[0].text.startsWith("Import failed")
          && e1.dot && tr.y >= bars.top && tr.b <= bars.tool && pe === "none",
        "9b toasts: an import error shows an error toast between the bars (the layer does not block taps) and sets the Info dot");
      await sleep(5200 - (Date.now() - t0));
      const still = await pg.evaluate(() => window.__np3app.mobile.toasts().length);
      await pg.waitForFunction(() => window.__np3app.mobile.toasts().length === 0, { timeout: 5000, polling: 50 });
      const el = Date.now() - t0;
      report(still === 1 && el >= 5900 && el <= 7200, `9b toasts: the error toast stays for ~6 s (still there at 5.2 s, gone after ${el} ms)`);
      // an error toast is dismissed by a tap
      await pg.evaluate(() => window.__np3app.transfer.importFile(new File([new Uint8Array(10)], "bad2.NP3")));
      await pg.tap(".toast.error");
      report(await pg.evaluate(() => window.__np3app.mobile.toasts().length === 0), "9b toasts: a tap dismisses an error toast");
      // the dot clears when the sheet opens
      await pg.tap("#info-btn");
      const dotOpen = await pg.evaluate(() => document.querySelector("#info-btn .dot").hidden);
      await pg.tap("#sheet-close");
      report(dotOpen === true, "9b Info dot: cleared when the sheet is opened");
      // info: 3 s
      const good = await pg.evaluate(async () => {
        const b = await (await fetch("/third_party/samples/tonecurve-noop.NP3")).arrayBuffer();
        await window.__np3app.transfer.importFile(new File([b], "g.NP3"));
        return window.__np3app.mobile.toasts();
      });
      const t1 = Date.now();
      await pg.waitForFunction(() => window.__np3app.mobile.toasts().length === 0, { timeout: 6000, polling: 50 });
      const el1 = Date.now() - t1;
      report(good.length === 1 && good[0].kind === "info" && good[0].text.startsWith("Imported:") && el1 >= 2300 && el1 <= 3600,
        `9b toasts: an info status hides after ~3 s (${el1} ms left)`);
      // progress stays until the next status replaces it
      await pg.evaluate(() => window.__np3app.onStatus("unpacking x.NEF…", "progress"));
      await sleep(3600);
      const prog = await pg.evaluate(() => window.__np3app.mobile.toasts());
      await pg.evaluate(() => window.__np3app.onStatus("Ready", "info"));
      const rep = await pg.evaluate(() => window.__np3app.mobile.toasts());
      report(eq(prog, [{ text: "unpacking x.NEF…", kind: "progress" }]) && eq(rep, [{ text: "Ready", kind: "info" }]),
        "9b toasts: a progress status stays (3.6 s later) until the next status replaces it");
      // the two-line clamp
      await pg.evaluate(() => window.__np3app.onStatus("x ".repeat(300), "info"));
      const lines = await pg.evaluate(() => { const e = document.querySelector(".toast"); return Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)); });
      report(lines <= 3, `9b toasts: a long text is clamped (${lines} lines of height incl. padding)`);
      await pg.close();
    }

    // ---- export, copy link, the version switch (isolated storage) ----
    {
      const ctx2 = await browser.createBrowserContext();
      const pg = await mkPage(ctx2, 390, 844);
      await goEdit(pg);
      const name = await loadSample(pg, "vanilla.NP3");
      await pg.evaluate(() => { navigator.clipboard.writeText = (s) => { window.__link = s; return Promise.resolve(); }; });
      await pg.tap("#export");
      const ex = await pg.evaluate(() => window.__np3app.state.status);
      await pg.tap("#share");
      const link = await pg.evaluate(() => ({ l: window.__link, status: window.__np3app.state.status, origin: location.origin, sl: window.__np3app.transfer.shareLink() }));
      report(ex === `Exported: ${name}.NP3` && link.l === link.sl && link.l.startsWith(`${link.origin}/web/picture-control-editor.html?np3=`)
          && link.status.startsWith("Link copied"),
        `9b export and copy link on the mobile page: "${ex}"; the link is on the desktop editor page (…/picture-control-editor.html?np3=…), the router picks the page`);
      // the manual switch carries the profile
      await setSlider(pg, "contrast", 17);
      const want = await pg.evaluate(() => window.__np3app.state.control.contrast);
      await pg.tap("#info-btn");
      await Promise.all([pg.waitForNavigation(), pg.tap("#to-desktop")]);
      await pg.waitForFunction(() => window.__np3app && window.__np3app.state.status.startsWith("Imported from link"), { timeout: 120000, polling: 100 });
      const dk = await pg.evaluate(() => ({ path: location.pathname, search: location.search, kind: window.__np3app.shell.kind,
        c: window.__np3app.state.control.contrast, n: window.__np3app.state.control.name, pref: localStorage.getItem("np3view") }));
      report(dk.path === "/web/picture-control-editor.html" && dk.kind === "desktop" && dk.c === want && dk.n === name && dk.pref === "desktop",
        `9b version switch: "Desktop version" opens picture-control-editor.html with the current profile (contrast ${dk.c}, name "${dk.n}") and stores the preference`);
      // and back: the desktop page offers "Mobile version" because a preference is stored.
      // The button visibility + click chain runs in Chromium only: headless Firefox
      // (WebDriver BiDi) has no touch emulation — emulation.setTouchOverride is an unknown
      // command there — so (pointer: coarse) never matches and #to-mobile stays hidden no
      // matter what; that is a test-environment limitation, not an app behavior (the rule is
      // unit-checked in 9a). The return switch itself runs in Firefox through the same
      // NP3Route.switchTo() the button handler calls, with the np3 from shareLink() exactly
      // as the handler extracts it.
      let vis = true, back;
      if (BROWSER === "chrome") {
        vis = await pg.evaluate(() => !document.getElementById("to-mobile").hidden);
        back = pg.evaluate(() => document.querySelector("#to-mobile button").click());
      } else {
        back = pg.evaluate(() => window.NP3Route.switchTo("mobile",
          new URL(window.__np3app.transfer.shareLink()).searchParams.get("np3")));
      }
      await Promise.all([pg.waitForNavigation(), back]);
      await pg.waitForFunction(() => window.__np3app && window.__np3app.state.status.startsWith("Imported from link"), { timeout: 120000, polling: 100 });
      const mb = await pg.evaluate(() => ({ path: location.pathname, kind: window.__np3app.shell.kind, c: window.__np3app.state.control.contrast,
        pref: localStorage.getItem("np3view") }));
      report(vis && mb.path === "/web/picture-control-editor-mobile.html" && mb.kind === "mobile" && mb.c === want && mb.pref === "mobile",
        "9b version switch: picture-control-editor.html shows \"Mobile version\" with a stored preference and returns to picture-control-editor-mobile.html with the profile");
      await pg.close();
      await ctx2.close();
    }

    // ---- 5: the redirect on real page loads (isolated storage per case) ----
    {
      const bytes = await readFile(path.join(ROOT, "third_party/samples/tonecurve-noop.NP3"));
      const q = Buffer.from(bytes).toString("base64url");
      const base = `http://127.0.0.1:${port}/web/`;
      const land = async (pre, url, vp = { width: 390, height: 844, isMobile: true, hasTouch: true }) => {
        const c = await browser.createBrowserContext();
        const pg = await c.newPage();
        if (pre) await pg.evaluateOnNewDocument(pre);
        await pg.setViewport({ deviceScaleFactor: 1, ...vp });
        await pg.goto(url);
        await pg.waitForFunction(() => window.__np3app && window.__np3app.state.status.length > 0 &&
          (location.search.indexOf("np3=") < 0), { timeout: 120000, polling: 100 });
        await sleep(400);
        const r = await pg.evaluate(() => ({ path: location.pathname, search: location.search, hash: location.hash,
          kind: window.__np3app.shell.kind, status: window.__np3app.state.status, pref: localStorage.getItem("np3view"),
          name: window.__np3app.state.control.name }));
        await c.close();
        return r;
      };
      const want = await (async () => { const pg = await ctx.newPage(); await pg.goto(`${base}picture-control-editor.html?view=desktop`);
        await pg.waitForFunction(() => window.__np3app, { polling: 100 });
        const n = await pg.evaluate(async (b) => { const { deserialize } = await import("/web/lib/np3.js");
          return deserialize(Uint8Array.from(atob(b.replaceAll("-", "+").replaceAll("_", "/") + "==".slice(0, (4 - b.length % 4) % 4)), (c) => c.charCodeAt(0)).buffer).name; }, q);
        await pg.close(); return n; })();
      let r = await land("localStorage.setItem('np3view','mobile')", `${base}picture-control-editor.html?np3=${q}#frag`);
      report(r.path === "/web/picture-control-editor-mobile.html" && r.hash === "#frag" && r.kind === "mobile" && r.status === `Imported from link: ${want}` && r.name === want,
        `9b redirect: picture-control-editor.html with a stored mobile preference lands on picture-control-editor-mobile.html; ?np3= is imported, the hash is kept (${r.path}${r.hash})`);
      r = await land(null, `${base}picture-control-editor.html?view=mobile&np3=${q}`);
      report(r.path === "/web/picture-control-editor-mobile.html" && r.search === "" && r.pref === "mobile" && r.name === want,
        "9b redirect: ?view=mobile on picture-control-editor.html lands on picture-control-editor-mobile.html, view= is gone, the choice is stored");
      r = await land(null, `${base}picture-control-editor-mobile.html?view=desktop&np3=${q}`);
      report(r.path === "/web/picture-control-editor.html" && r.search === "" && r.pref === "desktop" && r.kind === "desktop" && r.name === want,
        "9b redirect: ?view=desktop on picture-control-editor-mobile.html lands on picture-control-editor.html with the profile, the choice is stored");
      // the auto-rule cases need a full phone emulation (a coarse pointer AND a small emulated
      // screen) — available in Chromium only; headless Firefox BiDi cannot emulate either
      // (see the version-switch note above). The rule itself is unit-checked in 9a.
      if (BROWSER !== "chrome") {
        skip("9b redirect: the phone auto-rule cases need touch/screen emulation (Chromium only; the rule is unit-checked in 9a)");
      } else {
        r = await land(null, `${base}picture-control-editor.html?np3=${q}`);     // an emulated phone: coarse pointer, short side 390
        report(r.path === "/web/picture-control-editor-mobile.html" && r.kind === "mobile" && r.name === want && r.pref === null,
          "9b redirect: the auto rule sends an emulated phone from picture-control-editor.html to picture-control-editor-mobile.html (nothing stored)");
        r = await land(null, `${base}?np3=${q}`);
        report(r.path === "/web/picture-control-editor-mobile.html" && r.name === want,
          "9b redirect: a legacy directory URL (…/web/?np3=) goes landing -> editor -> the mobile page on a phone");
      }
      r = await land(null, `${base}picture-control-editor.html?np3=${q}`, { width: 1280, height: 800 });
      report(r.path === "/web/picture-control-editor.html" && r.kind === "desktop" && r.name === want,
        "9b redirect: a desktop (fine pointer, wide screen) stays on picture-control-editor.html");
      r = await land("localStorage.setItem('np3view','desktop')", `${base}picture-control-editor.html?np3=${q}`);
      report(r.path === "/web/picture-control-editor.html" && r.kind === "desktop", "9b redirect: a stored desktop preference beats the phone rule");
      // the \"Mobile version\" link is offered on the phone-class desktop page and hidden otherwise
      const linkState = async (vp, pre, url) => {
        const c = await browser.createBrowserContext();
        const pg = await c.newPage();
        if (pre) await pg.evaluateOnNewDocument(pre);
        await pg.setViewport({ deviceScaleFactor: 1, ...vp });
        await pg.goto(url);
        await pg.waitForFunction(() => window.__np3app, { timeout: 120000, polling: 100 });
        const hidden = await pg.evaluate(() => document.getElementById("to-mobile").hidden);
        await c.close();
        return hidden;
      };
      const PREF = "localStorage.setItem('np3view','desktop')";
      // without a coarse pointer the "shown" cases cannot run in Firefox (no touch emulation,
      // see the version-switch note); the hidden cases are emulation-independent
      const hDesk = await linkState({ width: 1280, height: 800 }, null, `${base}picture-control-editor.html`);
      const hMouse = await linkState({ width: 1280, height: 800 }, PREF, `${base}picture-control-editor.html`);
      const hTabletNo = await linkState({ width: 834, height: 1112, isMobile: true, hasTouch: true }, null, `${base}picture-control-editor.html`);
      report(hDesk === true && hMouse === true && hTabletNo === true,
        "9b picture-control-editor.html: the \"Mobile version\" link is hidden on a mouse desktop (also with a stored preference) and without a preference on a tablet");
      if (BROWSER !== "chrome") {
        skip("9b picture-control-editor.html: the \"Mobile version\" link shown on an emulated phone/tablet with a preference needs touch emulation (Chromium only)");
      } else {
        const hTablet = await linkState({ width: 834, height: 1112, isMobile: true, hasTouch: true }, PREF, `${base}picture-control-editor.html`);
        const hPhone = await linkState({ width: 390, height: 844, isMobile: true, hasTouch: true }, PREF, `${base}picture-control-editor.html`);
        report(hTablet === false && hPhone === false,
          "9b picture-control-editor.html: the \"Mobile version\" link is shown on a phone and on a touch device with a stored preference");
      }
    }

    // ---- RAW-dependent: the viewer with a real frame ----
    if (!rootFile("test1/DSC_5584.NEF")) {
      skip("9b viewer with a RAW frame: no test1/DSC_5584.NEF");
    } else {
      const pg = await mkPage(ctx, 390, 844);
      await pg.evaluate(async () => {
        const a = window.__np3app;
        const bytes = await (await fetch("/test1/DSC_5584.NEF")).arrayBuffer();
        await a.openRaw(new File([bytes], "DSC_5584.NEF"));
      });
      await pg.waitForFunction(() => window.__np3app.state.raw && !window.__np3app.state.renderPending && !document.getElementById("c").hidden,
        { timeout: 120000, polling: 100 });
      const v = await rect(pg, "#view"), c = await rect(pg, "#c");
      const e = await pg.evaluate(() => ({ empty: getComputedStyle(document.getElementById("empty")).display,
        ba: getComputedStyle(document.getElementById("ba-slot")).display, info: document.getElementById("info").textContent,
        label: document.querySelector(".ba-label").textContent, hint: getComputedStyle(document.querySelector(".ba-hint")).display }));
      report(e.empty === "none" && e.ba !== "none" && c.w <= v.w + 0.5 && c.h <= v.h + 0.5 && c.w > 100 && c.h > 100
          && Math.abs(c.x + c.w / 2 - (v.x + v.w / 2)) < 1 && e.info.includes("DSC_5584.NEF") && e.label === "After — NP3" && e.hint === "none",
        `9b viewer with a RAW: the canvas (${Math.round(c.w)}x${Math.round(c.h)}) is fitted and centered in the viewer, the empty state is gone, caption "After — NP3"`);
      const ns = await noScroll(pg);
      report(ns.v && ns.h, "9b viewer with a RAW: the page still does not scroll");
      await pg.close();
    }
    await ctx.close();
  }

  // ---------- level 9c: mobile work, stage M2 — touch interactions, soft-disabled export, share sheet ----------
  // (spec/ui-mobile.md "Tests" items 10-13 and the M2 plan checks). Gestures are driven by synthetic
  // PointerEvents (pointerType "touch"); in Chromium the slider checks also use real touch input
  // (puppeteer touchscreen = CDP Input.dispatchTouchEvent). The desktop screenshots are compared in 9a
  // (they run on the same code); here the desktop page gets the shared-helper checks.
  {
    const MOBILE = `http://127.0.0.1:${port}/web/picture-control-editor-mobile.html?view=mobile`;
    const DESKTOP = `http://127.0.0.1:${port}/web/picture-control-editor.html?view=desktop`;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mkPage = async (ctx, w, h, url = MOBILE, mobile = true) => {
      const pg = await ctx.newPage();
      pg.errs = [];
      pg.on("pageerror", (e) => pg.errs.push(e.message));
      pg.on("console", (m) => {
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pg.errs.push("console: " + m.text());
      });
      await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
      await pg.goto(url);
      await pg.waitForFunction(mobile ? "window.__np3app && window.__np3app.mobile" : "window.__np3app", { timeout: 120000, polling: 100 });
      // synthetic pointer helpers for the tests
      await pg.evaluate(() => {
        let id = 1;
        window.__T = {
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          ptr(type, el, x, y, o = {}) {
            el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: o.id ?? 1,
              pointerType: o.type ?? "touch", isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
          },
          async tap(el, x, y, o = {}) { this.ptr("pointerdown", el, x, y, o); await this.sleep(o.hold ?? 20); this.ptr("pointerup", el, x, y, o); },
          async dtap(el, x, y, gap = 90, o = {}) { await this.tap(el, x, y, o); await this.sleep(gap); await this.tap(el, x, y, o); },
          center(el) { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; },
        };
      });
      return pg;
    };
    const goEdit = (pg) => pg.evaluate(() => {
      window.__np3app.state.step = "edit";
      document.body.classList.toggle("step-start", false);
      document.body.classList.toggle("step-edit", true);
    });
    const loadSample = (pg, name = "vanilla.NP3") => pg.evaluate(async (name) => {
      const b = await (await fetch("/third_party/samples/" + name)).arrayBuffer();
      await window.__np3app.transfer.importFile(new File([b], name));
      return window.__np3app.state.control.name;
    }, name);
    const setSlider = (pg, key, v) => pg.evaluate((key, v) => {
      const el = document.querySelector(`.ctl[data-key="${key}"] input[type=range]`);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return window.__np3app.state.control[key];
    }, key, v);
    const histIdx = (pg) => pg.evaluate(() => window.__np3app.hist.index);

    // ---- touch.js unit checks: onLongPress, onDoubleTap, horizontalDrag with synthetic PointerEvents ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      const u = await pg.evaluate(async () => {
        const { onLongPress, onDoubleTap, horizontalDrag } = await import("/web/lib/touch.js");
        const T = window.__T, out = {};
        const box = () => { const d = document.createElement("div"); d.style.cssText = "position:fixed;left:0;top:0;width:300px;height:100px"; document.body.append(d); return d; };
        // --- long press ---
        {
          const el = box(), log = [];
          const off = onLongPress(el, { start: () => log.push("s"), end: () => log.push("e") });
          const run = async (fn) => { log.length = 0; await fn(); await T.sleep(20); return log.join(""); };
          out.lpHold = await run(async () => { T.ptr("pointerdown", el, 100, 50); await T.sleep(300); T.ptr("pointerup", el, 100, 50); });
          out.lpEarly = await run(async () => { T.ptr("pointerdown", el, 100, 50); await T.sleep(100); T.ptr("pointerup", el, 100, 50); await T.sleep(250); });
          out.lpSlop5 = await run(async () => { T.ptr("pointerdown", el, 100, 50); T.ptr("pointermove", el, 105, 50); await T.sleep(300); T.ptr("pointerup", el, 105, 50); });
          out.lpMove20 = await run(async () => { T.ptr("pointerdown", el, 100, 50); T.ptr("pointermove", el, 120, 50); await T.sleep(300); T.ptr("pointerup", el, 120, 50); });
          out.lpCancel = await run(async () => { T.ptr("pointerdown", el, 100, 50); await T.sleep(300); T.ptr("pointercancel", el, 100, 50); });
          out.lpLost = await run(async () => { T.ptr("pointerdown", el, 100, 50); await T.sleep(300); el.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, pointerType: "touch" })); });
          out.lpOnce = await run(async () => { T.ptr("pointerdown", el, 100, 50); await T.sleep(300); T.ptr("pointerup", el, 100, 50); el.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, pointerType: "touch" })); });
          out.lpMoveAfter = await run(async () => { T.ptr("pointerdown", el, 100, 50); await T.sleep(300); T.ptr("pointermove", el, 200, 90); T.ptr("pointerup", el, 200, 90); });
          out.lpSecond = await run(async () => { T.ptr("pointerdown", el, 100, 50); T.ptr("pointerdown", el, 150, 50, { id: 2 }); await T.sleep(300); T.ptr("pointerup", el, 150, 50, { id: 2 }); T.ptr("pointerup", el, 100, 50); });
          off();
          out.lpDisposed = await run(async () => { T.ptr("pointerdown", el, 100, 50); await T.sleep(300); T.ptr("pointerup", el, 100, 50); });
          const el2 = box(), log2 = [];
          onLongPress(el2, { start: () => log2.push("s"), end: () => log2.push("e"), types: ["touch", "pen"] });
          T.ptr("pointerdown", el2, 10, 10, { type: "mouse" }); await T.sleep(300); T.ptr("pointerup", el2, 10, 10, { type: "mouse" });
          T.ptr("pointerdown", el2, 10, 10, { type: "pen" }); await T.sleep(300); T.ptr("pointerup", el2, 10, 10, { type: "pen" });
          out.lpTypes = log2.join("");
        }
        // --- double tap ---
        {
          const el = box(), num = document.createElement("input");
          num.type = "number"; el.append(num);
          let n = 0;
          const off = onDoubleTap(el, () => n++);
          const run = async (fn) => { n = 0; await fn(); await T.sleep(380); return n; };   // the previous tap must expire
          out.dtTwo = await run(() => T.dtap(el, 50, 50, 90));
          out.dtOne = await run(() => T.tap(el, 50, 50));
          out.dtSlow = await run(async () => { await T.tap(el, 50, 50); await T.sleep(360); await T.tap(el, 50, 50); });
          out.dtFar = await run(async () => { await T.tap(el, 50, 50); await T.sleep(60); await T.tap(el, 70, 50); });
          out.dtNear = await run(async () => { await T.tap(el, 50, 50); await T.sleep(60); await T.tap(el, 56, 54); });
          out.dtDrag = await run(async () => {
            for (let i = 0; i < 2; i++) { T.ptr("pointerdown", el, 50, 50); await T.sleep(20); T.ptr("pointerup", el, 90, 50); await T.sleep(60); }
          });
          out.dtTapDragTap = await run(async () => {
            await T.tap(el, 50, 50); await T.sleep(40);
            T.ptr("pointerdown", el, 50, 50); T.ptr("pointerup", el, 90, 50); await T.sleep(40);
            await T.tap(el, 50, 50);
          });
          out.dtMouse = await run(() => T.dtap(el, 50, 50, 90, { type: "mouse" }));
          out.dtPen = await run(() => T.dtap(el, 50, 50, 90, { type: "pen" }));
          out.dtExcluded = await run(() => T.dtap(num, 50, 50, 90));
          out.dtTriple = await run(async () => { await T.tap(el, 50, 50); await T.sleep(60); await T.tap(el, 50, 50); await T.sleep(60); await T.tap(el, 50, 50); });
          off();
          out.dtDisposed = await run(() => T.dtap(el, 50, 50, 90));
        }
        // --- horizontal drag ---
        {
          const row = document.createElement("div");
          row.style.cssText = "position:fixed;left:20px;top:200px;width:300px;touch-action:pan-y";
          row.innerHTML = '<div class="top"><span class="lbl">L</span></div><input type="range" min="-100" max="100" step="1" style="width:300px;display:block;margin:0;padding:0;height:32px">';
          document.body.append(row);
          const rng = row.querySelector("input"), top = row.querySelector(".top");
          const r = rng.getBoundingClientRect();
          const ev = { input: 0, change: 0 };
          rng.addEventListener("input", () => ev.input++);
          rng.addEventListener("change", () => ev.change++);
          const off = horizontalDrag(rng, { thumb: 16 });
          const at = (f) => r.left + 8 + f * (r.width - 16);
          const y = r.top + 16;
          const reset = (v = 0) => { rng.value = v; ev.input = 0; ev.change = 0; };
          const drag = async (x0, y0, steps, dx, dy, opts = {}) => {
            T.ptr("pointerdown", opts.target || row, x0, y0);
            for (let i = 1; i <= steps; i++) { T.ptr("pointermove", row, x0 + dx * i / steps, y0 + dy * i / steps); await T.sleep(8); }
            T.ptr(opts.cancel ? "pointercancel" : "pointerup", row, x0 + dx, y0 + dy);
          };
          const snap = () => ({ v: Number(rng.value), input: ev.input, change: ev.change });
          reset(0); await T.tap(row, at(0.8), y);            out.hdTap = snap();
          reset(0); await drag(at(0.8), y, 10, 0, -60);      out.hdVertical = snap();
          reset(0); await drag(at(0.8), y, 10, 3, -60);      out.hdSteep = snap();
          reset(0); await drag(at(0.5), y, 10, 5, 0);        out.hdBelow = snap();
          reset(0); await drag(at(0.5), y, 10, 70, 0);       out.hdThumb = snap();
          reset(-100); await drag(at(0.3), y, 10, 60, 0);    out.hdTrack = snap();
          reset(0); await drag(at(0.5), y, 10, 12, 10);      out.hdDiagH = snap();
          reset(0); await drag(at(0.5), y, 10, 10, 14);      out.hdDiagV = snap();
          reset(0); await drag(at(0.5), y, 10, 400, 0);      out.hdClampMax = snap();
          reset(0); await drag(at(0.5), y, 10, -400, 0);     out.hdClampMin = snap();
          reset(0); await drag(at(0.5), y, 10, 60, 0, { cancel: true }); out.hdCancel = snap();
          reset(0); await drag(at(0.5), r.top - 40, 10, 60, 0, { target: top }); out.hdExcluded = snap();
          rng.disabled = true; reset(0); await drag(at(0.5), y, 10, 60, 0); out.hdDisabled = snap(); rng.disabled = false;
          reset(0); T.ptr("pointerdown", row, at(0.75), y, { type: "mouse" }); out.hdMouseDown = snap(); T.ptr("pointerup", row, at(0.75), y, { type: "mouse" });
          out.hdMouseEnd = snap();
          off();
          reset(0); await drag(at(0.5), y, 10, 60, 0); out.hdDisposed = snap();
        }
        return out;
      });
      const J = JSON.stringify;
      report(u.lpHold === "se" && u.lpEarly === "" && u.lpSlop5 === "se" && u.lpMove20 === "" && u.lpCancel === "se"
          && u.lpLost === "se" && u.lpOnce === "se" && u.lpMoveAfter === "se" && u.lpSecond === "se" && u.lpDisposed === "" && u.lpTypes === "se",
        `9c touch.js onLongPress: start after 250 ms and end on pointerup/pointercancel/lostpointercapture (once); an early release and a 20 px move do not start; a 5 px move stays; moves after the start do not matter; a second finger is ignored; the types filter and dispose work — ${JSON.stringify([u.lpHold, u.lpEarly, u.lpSlop5, u.lpMove20, u.lpCancel, u.lpLost, u.lpOnce, u.lpMoveAfter, u.lpSecond, u.lpDisposed, u.lpTypes])}`);
      report(u.dtTwo === 1 && u.dtOne === 0 && u.dtSlow === 0 && u.dtFar === 0 && u.dtNear === 1 && u.dtDrag === 0 && u.dtTapDragTap === 0
          && u.dtMouse === 0 && u.dtPen === 1 && u.dtExcluded === 0 && u.dtTriple === 1 && u.dtDisposed === 0,
        `9c touch.js onDoubleTap: two taps (touch/pen) fire once; one tap, a slow second tap (360 ms), 20 px apart, drags, the mouse and the excluded number field do not; 6 px apart counts; a third tap starts anew; dispose works — ${J([u.dtTwo, u.dtOne, u.dtSlow, u.dtFar, u.dtNear, u.dtDrag, u.dtTapDragTap, u.dtMouse, u.dtPen, u.dtExcluded, u.dtTriple, u.dtDisposed])}`);
      report(u.hdTap.v === 0 && u.hdTap.input === 0 && u.hdTap.change === 0 && u.hdVertical.v === 0 && u.hdVertical.input === 0 && u.hdSteep.v === 0
          && u.hdBelow.v === 0 && u.hdBelow.input === 0 && u.hdDiagV.v === 0 && u.hdExcluded.v === 0 && u.hdDisabled.v === 0 && u.hdDisposed.v === 0,
        `9c touch.js horizontalDrag: a tap, a vertical swipe, a steep move, a move under 8 px, a mostly vertical diagonal, a drag from the label line, a disabled range and a disposed handler change nothing — ${J({ tap: u.hdTap, vert: u.hdVertical, steep: u.hdSteep, below: u.hdBelow, diagV: u.hdDiagV })}`);
      report(u.hdThumb.v >= 47 && u.hdThumb.v <= 51 && u.hdThumb.input >= 1 && u.hdThumb.change === 1
          && u.hdTrack.v > -100 && u.hdTrack.change === 1 && u.hdDiagH.v !== 0 && u.hdDiagH.change === 1
          && u.hdClampMax.v === 100 && u.hdClampMin.v === -100 && u.hdCancel.v > 0 && u.hdCancel.change === 1,
        `9c touch.js horizontalDrag: a horizontal drag from the thumb moves the value by the finger's distance (+70 px of a 284 px travel -> ${u.hdThumb.v}, expected 49), from the track it follows the finger, clamps at the ends, input events while dragging and one change at the end (also on pointercancel) — ${J({ thumb: u.hdThumb, track: u.hdTrack, max: u.hdClampMax, min: u.hdClampMin, cancel: u.hdCancel })}`);
      report(u.hdMouseDown.v > 40 && u.hdMouseDown.input === 1 && u.hdMouseEnd.change === 1,
        `9c touch.js horizontalDrag: a mouse acts like a native range (pointerdown sets the value, release fires change) — ${J({ down: u.hdMouseDown, end: u.hdMouseEnd })}`);
      report(pg.errs.length === 0, `9c touch.js checks: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }

    // ---- slider rows on picture-control-editor-mobile.html: sizes, rules, number fields (spec "Common slider row") ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const css = await pg.evaluate(() => {
        const row = document.querySelector('.ctl[data-key="contrast"]');
        const rng = row.querySelector("input[type=range]"), val = row.querySelector(".val");
        // the thumb is a pseudo-element: read the rule from the stylesheet
        let thumbRules = 0;
        for (const sh of document.styleSheets) {
          if (!sh.href || !sh.href.endsWith("css/mobile.css")) continue;
          for (const rule of sh.cssRules)
            if (rule.selectorText && /slider-thumb|range-thumb/.test(rule.selectorText) && rule.style.width === "22px" && rule.style.height === "22px") thumbRules++;
        }
        return { rowH: row.getBoundingClientRect().height, rowTA: getComputedStyle(row).touchAction, rngH: rng.getBoundingClientRect().height,
          rngTA: getComputedStyle(rng).touchAction, rngPE: getComputedStyle(rng).pointerEvents, thumbRules,
          valFS: getComputedStyle(val).fontSize, valType: val.type, valInputmode: val.getAttribute("inputmode"), valHint: val.enterKeyHint,
          canvasTA: getComputedStyle(document.getElementById("c")).touchAction, hintHidden: document.querySelector(".ba-hint").hidden,
          allVals: [...document.querySelectorAll(".ctl .val")].every((v) => v.getAttribute("enterkeyhint") === "done" && !v.hasAttribute("inputmode") && v.type === "number"),
          allRanges: [...document.querySelectorAll("#panel-scroll .ctl")].every((c) => c.getBoundingClientRect().height === 0 || c.getBoundingClientRect().height >= 51.5) };
      });
      report(css.rowH >= 52 && css.rngH === 32 && css.rowTA === "pan-y" && css.rngTA === "pan-y" && css.rngPE === "none",
        `9c slider row on mobile: row ${css.rowH} px (>= 52), range ${css.rngH} px high, touch-action pan-y on row and range, the range itself is drawn only (pointer-events none)`);
      report(css.thumbRules >= 1,
        `9c slider thumb: mobile.css sizes the thumb 22 x 22 px (${css.thumbRules} thumb rule(s) found)`);
      await pg.evaluate(() => window.__np3app.mobile.setTool("strength"));
      Object.assign(css, await pg.evaluate(() => {
        const name = document.getElementById("p-name");
        return { nameFS: getComputedStyle(name).fontSize, nameW: name.getBoundingClientRect().width, nameParentW: name.parentElement.getBoundingClientRect().width,
          nameAttrs: ["autocapitalize", "autocomplete", "autocorrect", "spellcheck"].map((a) => name.getAttribute(a)).join(",") };
      }));
      report(css.valFS === "16px" && css.valType === "number" && css.valInputmode === null && css.valHint === "done" && css.allVals,
        "9c number fields: type=number, no inputmode (the iOS keyboard keeps its minus), enterkeyhint=done, 16 px font — in every panel group");
      report(css.nameFS === "16px" && css.nameW > css.nameParentW - 2 && css.nameAttrs === "off,off,off,false",
        `9c Profile name field: id p-name, 16 px, full width (${Math.round(css.nameW)} of ${Math.round(css.nameParentW)}), autocapitalize/autocomplete/autocorrect off, spellcheck false`);
      report(css.canvasTA === "none" && css.hintHidden === true,
        "9c viewer: #c has touch-action none; the Space hint line is hidden by the hint:false option");
      await pg.close();
      await ctx.close();
    }

    // ---- real touch input (Chromium touch emulation): vertical swipe, tap, horizontal drag, double-tap ----
    if (BROWSER !== "chrome") {
      skip("9c real touch input: puppeteer touchscreen is only exercised in Chromium (NP3_BROWSER=chrome)");
    } else {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      await loadSample(pg);
      const state = () => pg.evaluate(() => {
        const rng = document.querySelector('.ctl[data-key="contrast"] input[type=range]').getBoundingClientRect();
        return { c: window.__np3app.state.control.contrast, h: window.__np3app.hist.index,
          scroll: document.getElementById("panel-scroll").scrollTop, r: { x: rng.x, y: rng.y, w: rng.width } };
      });
      const reset = async () => { await pg.evaluate(() => { const a = window.__np3app; a.state.control.contrast = 0; a.panel.refresh(); document.getElementById("panel-scroll").scrollTop = 0; }); await sleep(120); };
      const run = async (fn) => {
        await reset();
        const a = await state();
        await fn(a.r);
        await sleep(450);
        const b = await state();
        return { c0: a.c, c: b.c, scroll: b.scroll, dh: b.h - a.h };
      };
      const swipe = async (x, y, dx, dy, steps = 10) => {
        const h = await pg.touchscreen.touchStart(x, y);
        for (let i = 1; i <= steps; i++) { await h.move(x + dx * i / steps, y + dy * i / steps); await sleep(16); }
        await h.end();
      };
      const Y = 16;
      const vTrack = await run((r) => swipe(r.x + r.w * 0.8, r.y + Y, 0, -80));
      const vThumb = await run((r) => swipe(r.x + r.w * 0.5, r.y + Y, 0, -80));
      const vDiag = await run((r) => swipe(r.x + r.w * 0.8, r.y + Y, 12, -80));
      report(vTrack.c === 0 && vTrack.dh === 0 && vTrack.scroll > 30 && vThumb.c === 0 && vThumb.dh === 0 && vThumb.scroll > 30
          && vDiag.c === 0 && vDiag.dh === 0 && vDiag.scroll > 30,
        `9c real touch: a vertical swipe over a slider row (from the track, from the thumb, slightly diagonal) scrolls the panel (${vTrack.scroll}/${vThumb.scroll}/${vDiag.scroll} px) and changes no value, no history step`);
      const tapT = await run(async (r) => { await pg.touchscreen.tap(r.x + r.w * 0.8, r.y + Y); });
      const tapH = await run(async (r) => { await pg.touchscreen.tap(r.x + r.w * 0.5, r.y + Y); });
      report(tapT.c === 0 && tapT.dh === 0 && tapH.c === 0 && tapH.dh === 0,
        "9c real touch: a tap on the track (and on the thumb) does not move the value and adds no history step");
      const dragT = await run((r) => swipe(r.x + r.w * 0.5, r.y + Y, 100, 0));
      const dragR = await run((r) => swipe(r.x + r.w * 0.7, r.y + Y, 40, 0));
      report(dragT.c > 40 && dragT.c < 70 && dragT.dh === 1 && dragR.c > 40 && dragR.dh === 1 && dragT.scroll === 0,
        `9c real touch: a horizontal drag from the thumb (+100 px -> ${dragT.c}) and from the track changes the value, one history step each, the panel does not scroll`);
      // double-tap: on the track and on the label; the value goes to the default as one finished action
      const dtRun = async (where) => {
        await pg.evaluate(() => { const a = window.__np3app; a.state.control.contrast = 40; a.panel.refresh(); document.getElementById("panel-scroll").scrollTop = 0; });
        await sleep(120);
        const a = await state();
        const lbl = await pg.evaluate(() => { const r = document.querySelector('.ctl[data-key="contrast"] .lbl').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        const [x, y] = where === "track" ? [a.r.x + a.r.w * 0.3, a.r.y + Y] : [lbl.x, lbl.y];
        await pg.touchscreen.tap(x, y); await sleep(90); await pg.touchscreen.tap(x, y);
        await sleep(500);
        const b = await state();
        return { c0: a.c, c: b.c, dh: b.h - a.h };
      };
      const dtTrack = await dtRun("track"), dtLabel = await dtRun("label");
      report(dtTrack.c === 0 && dtTrack.dh === 1 && dtLabel.c === 0 && dtLabel.dh === 1,
        `9c real touch: a double tap on the track or on the label resets the slider to its default (${dtTrack.c0} -> ${dtTrack.c}) as exactly one history step (${dtTrack.dh}/${dtLabel.dh}) although the browser may also fire dblclick`);
      await pg.close();
      await ctx.close();
    }

    // ---- item 11: double-tap on rows of every kind of slider (synthetic touch events) ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      await loadSample(pg);
      const dt = (sel, extra = "") => pg.evaluate(async (sel, extra) => {
        const T = window.__T, row = document.querySelector(sel);
        await T.sleep(400);                       // a second reset within 350 ms is suppressed on purpose
        const lbl = row.querySelector(".lbl"), rng = row.querySelector("input[type=range]"), val = row.querySelector(".val");
        const target = extra === "val" ? val : extra === "label" ? lbl : row;
        const [x, y] = T.center(target);
        await T.dtap(target, x, y, 90);
        if (extra === "dblclick") row.querySelector("input[type=range]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        await T.sleep(60);
        return { hist: window.__np3app.hist.index, v: rng.value };
      }, sel, extra);
      // Basic contrast: single tap does nothing, double tap resets, one history step
      await setSlider(pg, "contrast", 35);
      let h0 = await histIdx(pg);
      let r = await pg.evaluate(async () => { const T = window.__T, row = document.querySelector('.ctl[data-key="contrast"]'); const [x, y] = T.center(row.querySelector(".lbl")); await T.tap(row.querySelector(".lbl"), x, y); await T.sleep(400); return { c: window.__np3app.state.control.contrast, h: window.__np3app.hist.index }; });
      report(r.c === 35 && r.h === h0, "9c item 11: a single tap on a slider row does not change the value or the history");
      r = await dt('.ctl[data-key="contrast"]', "label");
      report(r.v === "0" && r.hist === h0 + 1, `9c item 11: a double tap on the label of Contrast resets it to 0 as one history step (35 -> ${r.v}, history +${r.hist - h0})`);
      await setSlider(pg, "contrast", 35); h0 = await histIdx(pg);
      r = await dt('.ctl[data-key="contrast"]', "dblclick");
      report(r.v === "0" && r.hist === h0 + 1, `9c item 11: a double tap followed by the browser's dblclick (iOS) still pushes exactly one history snapshot (+${r.hist - h0})`);
      await setSlider(pg, "contrast", 35); h0 = await histIdx(pg);
      r = await dt('.ctl[data-key="contrast"]', "val");
      report(r.v === "35" && r.hist === h0, "9c item 11: a double tap on the number field does not reset");
      // mouse dblclick keeps working
      r = await pg.evaluate(() => { const a = window.__np3app; const rng = document.querySelector('.ctl[data-key="contrast"] input[type=range]');
        const h = a.hist.index; rng.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return { v: rng.value, dh: a.hist.index - h }; });
      report(r.v === "0" && r.dh === 1, "9c item 11: the mouse dblclick reset still works (one history step)");
      // Strength -> 100
      await pg.evaluate(() => window.__np3app.mobile.setTool("strength"));
      await pg.evaluate(() => { const rng = document.querySelector(".ctl .val[max='150']").closest(".ctl").querySelector("input[type=range]"); rng.value = 60; rng.dispatchEvent(new Event("input", { bubbles: true })); rng.dispatchEvent(new Event("change", { bubbles: true })); });
      const strengthRow = await pg.evaluate(() => { const c = document.querySelector(".ctl .val[max='150']").closest(".ctl"); c.id = "t-strength"; return window.__np3app.state.strength; });
      h0 = await histIdx(pg);
      r = await dt("#t-strength", "label");
      const st = await pg.evaluate(() => window.__np3app.state.strength);
      report(strengthRow === 60 && st === 100 && r.hist === h0 + 1, `9c item 11: double tap on Strength resets it to 100 (60 -> ${st}), one history step`);
      // Details, Blender (HSL rows), Grading
      await pg.evaluate(() => window.__np3app.mobile.setTool("details"));
      await setSlider(pg, "clarity", 3); h0 = await histIdx(pg);
      r = await dt('.ctl[data-key="clarity"]', "label");
      report(r.v === "0.5" && r.hist === h0 + 1, `9c item 11: double tap on Details > Clarity resets it to its default 0.5 (3 -> ${r.v}), one history step`);
      await pg.evaluate(() => window.__np3app.mobile.setTool("blender"));
      const bl = await pg.evaluate(() => {
        const row = document.querySelector("#blending-slot .ctl"); row.id = "t-blend";
        const rng = row.querySelector("input[type=range]"); rng.value = 40; rng.dispatchEvent(new Event("input", { bubbles: true })); rng.dispatchEvent(new Event("change", { bubbles: true }));
        return { v: rng.value, h: window.__np3app.hist.index };
      });
      r = await dt("#t-blend", "label");
      report(bl.v === "40" && r.v === "0" && r.hist === bl.h + 1, `9c item 11: double tap on a Color Blender slider resets it (40 -> ${r.v}), one history step`);
      await pg.evaluate(() => window.__np3app.mobile.setTool("grading"));
      const gr = await pg.evaluate(() => {
        const row = [...document.querySelectorAll("#grading-slot .ctl")].find((c) => c.getBoundingClientRect().height > 0 && c.querySelector(".val").max === "100" && c.querySelector(".val").min === "-100");
        row.id = "t-grade";
        const rng = row.querySelector("input[type=range]"); rng.value = -30; rng.dispatchEvent(new Event("input", { bubbles: true })); rng.dispatchEvent(new Event("change", { bubbles: true }));
        return { v: rng.value, h: window.__np3app.hist.index, lbl: row.querySelector(".lbl").textContent };
      });
      r = await dt("#t-grade", "label");
      report(gr.v === "-30" && r.v === "0" && r.hist === gr.h + 1, `9c item 11: double tap on a Color Grading slider (${gr.lbl}) resets it (-30 -> ${r.v}), one history step`);
      report(pg.errs.length === 0, `9c double-tap checks: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }

    // ---- item 12: soft-disabled export / copy link, keyboard visibility, the accept switch ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const name = await loadSample(pg);
      await pg.evaluate(() => {
        window.__blobs = []; window.__shares = []; window.__clips = [];
        const orig = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => { window.__blobs.push(b); return orig(b); };
        navigator.clipboard.writeText = (s) => { window.__clips.push(s); return Promise.resolve(); };
        Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: undefined });
        Object.defineProperty(navigator, "canShare", { configurable: true, writable: true, value: undefined });
      });
      const btns = () => pg.evaluate(() => ["export", "share"].map((id) => { const b = document.getElementById(id);
        return { dis: b.disabled, aria: b.getAttribute("aria-disabled"), title: b.title }; }));
      const okBtns = await btns();
      report(okBtns.every((b) => !b.dis && b.aria === null), "9c item 12: with a valid name Export and Copy link are enabled and not aria-disabled");
      await pg.evaluate(() => { const n = document.getElementById("p-name"); n.value = ""; n.dispatchEvent(new Event("input", { bubbles: true })); window.__np3app.mobile.setTool("basic"); });
      const bad = await btns();
      report(bad.every((b) => !b.dis && b.aria === "true" && b.title === ""),
        `9c item 12: with an invalid name both buttons are aria-disabled (not disabled, so a tap is not swallowed): ${JSON.stringify(bad)}`);
      await pg.tap("#export");
      const e1 = await pg.evaluate(() => ({ toasts: window.__np3app.mobile.toasts(), tool: window.__np3app.mobile.tool,
        focus: document.activeElement && document.activeElement.id, blobs: window.__blobs.length, clips: window.__clips.length,
        panelShown: getComputedStyle(document.getElementById("tool-strength")).display }));
      report(e1.toasts.some((x) => x.text === "Set a valid NP3 name (1–19 ASCII) to export") && e1.tool === "strength" && e1.focus === "p-name"
          && e1.blobs === 0 && e1.panelShown === "block",
        `9c item 12: a tap on a blocked Export shows the toast, switches to Profile and focuses the name field; no file is produced — ${JSON.stringify(e1)}`);
      await pg.evaluate(() => { window.__np3app.mobile.setTool("basic"); document.activeElement.blur(); });
      await sleep(50);
      await pg.tap("#share");
      const e2 = await pg.evaluate(() => ({ tool: window.__np3app.mobile.tool, focus: document.activeElement && document.activeElement.id,
        clips: window.__clips.length, toast: window.__np3app.mobile.toasts().map((x) => x.text) }));
      report(e2.tool === "strength" && e2.focus === "p-name" && e2.clips === 0 && e2.toast.includes("Set a valid NP3 name (1–19 ASCII) to export"),
        `9c item 12: the same for Copy link, nothing is copied — ${JSON.stringify(e2)}`);
      await pg.evaluate(() => { const n = document.getElementById("p-name"); n.value = "OK-NAME"; n.dispatchEvent(new Event("input", { bubbles: true })); });
      const good = await btns();
      report(good.every((b) => !b.dis && b.aria === null), "9c item 12: a valid name lifts the aria-disabled state");

      // keyboard visibility: focusing a field scrolls it into view
      const kv = await pg.evaluate(async () => {
        let n = 0, last = null;
        const orig = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (o) { n++; last = [this.id, JSON.stringify(o)]; return orig.call(this, o); };
        document.activeElement.blur();
        document.getElementById("p-name").focus();
        await new Promise((r) => setTimeout(r, 200));
        const afterFocus = n;
        visualViewport.dispatchEvent(new Event("resize"));
        await new Promise((r) => setTimeout(r, 50));
        Element.prototype.scrollIntoView = orig;
        return { afterFocus, afterResize: n, last };
      });
      report(kv.afterFocus >= 1 && kv.afterResize > kv.afterFocus && kv.last[0] === "p-name" && kv.last[1].includes("nearest"),
        `9c keyboard visibility: focusin and a visualViewport resize scroll the focused field into view (${JSON.stringify(kv)})`);

      // the accept switch
      const ac = await pg.evaluate(() => {
        const ins = [...document.querySelectorAll("input[data-accept-fallback]")];
        const before = ins.map((i) => i.getAttribute("accept"));
        window.__np3app.mobile.dropAccept();
        return { n: ins.length, ids: ins.map((i) => i.id || i.type), before, after: ins.map((i) => i.getAttribute("accept")) };
      });
      report(ac.n === 2 && ac.ids.includes("file") && ac.before.every((a) => a) && ac.after.every((a) => a === null),
        `9c file pickers: #file and the NP3 input carry data-accept-fallback and one switch drops their accept (${JSON.stringify(ac.ids)})`);
      await pg.close();
      await ctx.close();
    }

    // ---- item 13: share-sheet export with stubs ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const name = await loadSample(pg, "tonecurve-noop.NP3");
      await pg.evaluate(() => {
        window.__blobs = []; window.__shares = [];
        const orig = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => { window.__blobs.push(b); return orig(b); };
      });
      const stub = (mode) => pg.evaluate((mode) => {
        window.__shares = [];
        const set = (k, v) => Object.defineProperty(navigator, k, { configurable: true, writable: true, value: v });
        if (mode === "missing") { set("share", undefined); set("canShare", undefined); return; }
        set("canShare", (d) => mode !== "cannot" && !!d.files && d.files.length === 1);
        set("share", async (d) => {
          const f = d.files[0];
          window.__shares.push({ n: d.files.length, name: f.name, type: f.type, title: d.title, bytes: [...new Uint8Array(await f.arrayBuffer())] });
          if (mode === "abort") throw new DOMException("cancelled", "AbortError");
          if (mode === "fail") throw new DOMException("not allowed", "NotAllowedError");
        });
      }, mode);
      const exp = async (viaTap) => {
        await pg.evaluate(() => { window.__np3app.state.status = "SENTINEL"; });
        if (viaTap) await pg.tap("#export"); else await pg.evaluate(() => window.__np3app.transfer.exportNow());
        await sleep(150);
        return pg.evaluate(async () => ({ shares: window.__shares, blobs: window.__blobs.length, status: window.__np3app.state.status,
          kind: window.__np3app.state.statusKind, last: window.__blobs.length ? [...new Uint8Array(await window.__blobs[window.__blobs.length - 1].arrayBuffer())] : null }));
      };
      // no Web Share: the download
      await stub("missing");
      const a = await exp(false);
      const bytes = a.last;
      report(a.shares.length === 0 && a.blobs === 1 && bytes && bytes.length > 100 && a.status === `Exported: ${name}.NP3`,
        `9c item 13: without Web Share the export is the download ("${a.status}", ${bytes && bytes.length} bytes)`);
      // success
      await stub("ok");
      const b = await exp(true);
      report(b.shares.length === 1 && b.shares[0].n === 1 && b.shares[0].name === `${name}.NP3` && b.shares[0].title === `${name}.NP3`
          && b.shares[0].type === "application/octet-stream" && JSON.stringify(b.shares[0].bytes) === JSON.stringify(bytes)
          && b.blobs === 1 && b.status === `Shared: ${name}.NP3` && b.kind === "info",
        `9c item 13: with Web Share the tap shares one ${name}.NP3 file with the exact NP3 bytes, no download, status "${b.status}"`);
      // AbortError: silent
      await stub("abort");
      const c = await exp(false);
      report(c.shares.length === 1 && c.blobs === 1 && c.status === "SENTINEL",
        `9c item 13: AbortError (the sheet was closed) is silent — no status change, no download (status "${c.status}")`);
      // another error: the download
      await stub("fail");
      const d = await exp(false);
      report(d.shares.length === 1 && d.blobs === 2 && d.status === `Exported: ${name}.NP3` && JSON.stringify(d.last) === JSON.stringify(bytes),
        `9c item 13: a rejected share falls back to the download with the same bytes ("${d.status}")`);
      // canShare false
      await stub("cannot");
      const e = await exp(false);
      report(e.shares.length === 0 && e.blobs === 3 && e.status === `Exported: ${name}.NP3`,
        "9c item 13: canShare({files}) false falls back to the download without calling share");
      // Export failure still reports an error: an invalid name never reaches here, so check the serialize error path via a broken control
      await pg.evaluate(() => { window.__np3app.state.nameValid = true; window.__oldName = window.__np3app.state.control.name; window.__np3app.state.control.name = "é".repeat(30); });
      await stub("ok");
      const f = await exp(false);
      report(f.shares.length === 0 && f.kind === "error" && f.status.startsWith("Export failed"),
        `9c item 13: a serialization error is still an "Export failed" error and shares nothing ("${f.status}")`);
      report(pg.errs.length === 0, `9c export checks: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }

    // ---- clipboard fallback: the link in the info sheet ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      await loadSample(pg, "vanilla.NP3");
      await pg.evaluate(() => {
        window.__shares = [];
        navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
        Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: undefined });
      });
      await pg.tap("#share");
      await sleep(100);
      const s1 = await pg.evaluate(() => ({ status: window.__np3app.state.status, kind: window.__np3app.state.statusKind,
        toast: window.__np3app.mobile.toasts(), dot: !document.querySelector("#info-btn .dot").hidden, boxHidden: document.getElementById("clip-box").hidden }));
      report(s1.status === "Copy failed — the link is in Info" && s1.kind === "error" && s1.toast.some((x) => x.kind === "error" && x.text === s1.status) && s1.dot,
        `9c clipboard fallback: a failed copy reports "Copy failed — the link is in Info" as an error toast and raises the Info dot`);
      await pg.tap("#info-btn");
      await sleep(100);
      const s2 = await pg.evaluate(() => { const i = document.getElementById("clip-link"); return {
        hidden: document.getElementById("clip-box").hidden, v: i.value, ro: i.readOnly, link: window.__np3app.transfer.shareLink(),
        sel: [i.selectionStart, i.selectionEnd, i.value.length], active: document.activeElement === i,
        share: !document.getElementById("clip-share").hidden, fs: getComputedStyle(i).fontSize, h: i.getBoundingClientRect().height, w: i.getBoundingClientRect().width }; });
      report(!s2.hidden && s2.v === s2.link && s2.v.includes("/web/picture-control-editor.html?np3=") && s2.ro && s2.sel[0] === 0 && s2.sel[1] === s2.sel[2] && s2.active && !s2.share && s2.fs === "16px" && s2.h >= 44,
        `9c clipboard fallback: the info sheet shows the link in a read-only, pre-selected field (16 px, ${Math.round(s2.h)} px high); no "Share…" button without navigator.share`);
      await pg.tap("#sheet-close");
      await sleep(100);
      // with Web Share: the button calls share({ url })
      await pg.evaluate(() => { Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: async (d) => { window.__shares.push(d); } }); });
      await setSlider(pg, "contrast", 21);
      await pg.tap("#share");
      await sleep(100);
      await pg.tap("#info-btn");
      await sleep(100);
      const s3 = await pg.evaluate(() => ({ hidden: document.getElementById("clip-box").hidden, share: !document.getElementById("clip-share").hidden,
        v: document.getElementById("clip-link").value, link: window.__np3app.transfer.shareLink() }));
      await pg.tap("#clip-share");
      await sleep(100);
      const s4 = await pg.evaluate(() => window.__shares);
      report(!s3.hidden && s3.share && s4.length === 1 && s4[0].url === s3.v && s3.v === s3.link,
        "9c clipboard fallback: with Web Share a \"Share…\" button appears and calls navigator.share({ url }) with the current link");
      await pg.tap("#sheet-close");
      await sleep(100);
      await pg.tap("#info-btn");
      await sleep(100);
      const s5 = await pg.evaluate(() => document.getElementById("clip-box").hidden);
      report(s5 === true, "9c clipboard fallback: the link field is gone after the sheet was closed (the link is not kept stale)");
      await pg.close();
      await ctx.close();
    }

    // ---- item 10: long-press on the canvas (needs a real frame) + contextmenu ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      // contextmenu: prevented after a touch pointer, not after a mouse (no RAW needed)
      const cm = await pg.evaluate(() => {
        const c = document.getElementById("c"), T = window.__T;
        const fire = () => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); c.dispatchEvent(e); return e.defaultPrevented; };
        const none = fire();
        T.ptr("pointerdown", c, 5, 5, { type: "touch" }); const touch = fire(); T.ptr("pointerup", c, 5, 5, { type: "touch" });
        T.ptr("pointerdown", c, 5, 5, { type: "mouse" }); const mouse = fire(); T.ptr("pointerup", c, 5, 5, { type: "mouse" });
        return { none, touch, mouse };
      });
      report(cm.touch === true && cm.none === true && cm.mouse === false,
        `9c viewer: contextmenu on the canvas is prevented for touch (and unknown) pointers, a mouse right-click keeps its menu ${JSON.stringify(cm)}`);
      if (!rootFile("test1/DSC_5584.NEF")) {
        skip("9c item 10 long-press before/after: no test1/DSC_5584.NEF");
      } else {
        await pg.evaluate(async () => {
          const a = window.__np3app;
          const bytes = await (await fetch("/test1/DSC_5584.NEF")).arrayBuffer();
          await a.openRaw(new File([bytes], "DSC_5584.NEF"));
        });
        await pg.waitForFunction(() => window.__np3app.state.raw && !window.__np3app.state.renderPending && !document.getElementById("c").hidden,
          { timeout: 120000, polling: 100 });
        const snap = () => pg.evaluate(() => ({ neutral: window.__np3app.state.showNeutral, label: document.querySelector(".ba-label").textContent,
          luts: window.__np3app.renderer.stats.luts, dev: window.__np3app.renderer.stats.develops }));
        const press = (moveTo, hold = 300) => pg.evaluate(async (moveTo, hold) => {
          const c = document.getElementById("c"), T = window.__T, [x, y] = T.center(c);
          const out = {};
          T.ptr("pointerdown", c, x, y);
          if (moveTo) T.ptr("pointermove", c, x + moveTo, y);
          await T.sleep(hold);
          out.during = { neutral: window.__np3app.state.showNeutral, label: document.querySelector(".ba-label").textContent, luts: window.__np3app.renderer.stats.luts };
          T.ptr("pointerup", c, x + (moveTo || 0), y);
          await T.sleep(150);
          out.after = { neutral: window.__np3app.state.showNeutral, label: document.querySelector(".ba-label").textContent };
          return out;
        }, moveTo, hold);
        const s0 = await snap();
        const p1 = await press(0);
        report(s0.neutral === false && p1.during.neutral === true && p1.during.label === "Before — neutral" && p1.after.neutral === false && p1.after.label === "After — NP3" && p1.during.luts === s0.luts,
          `9c item 10: a 300 ms touch on the photo shows "Before — neutral" (no LUT built), the release returns "After — NP3"`);
        const p2 = await press(5);
        const p3 = await press(20);
        const p4 = await press(0, 100);
        report(p2.during.neutral === true && p3.during.neutral === false && p4.during.neutral === false && p2.after.neutral === false,
          `9c item 10: a 5 px move stays a long press, a 20 px move cancels it, a 100 ms touch is not one (${p2.during.neutral}/${p3.during.neutral}/${p4.during.neutral})`);
        const s1 = await snap();
        report(s1.luts === s0.luts && s1.dev === s0.dev, `9c item 10: no LUT and no develop for the before/after presses (luts ${s0.luts} -> ${s1.luts}, develops ${s0.dev} -> ${s1.dev})`);
        // a mouse hold does not trigger (desktop keeps Space only)
        const pm = await pg.evaluate(async () => { const c = document.getElementById("c"), T = window.__T, [x, y] = T.center(c);
          T.ptr("pointerdown", c, x, y, { type: "mouse" }); await T.sleep(320); const n = window.__np3app.state.showNeutral; T.ptr("pointerup", c, x, y, { type: "mouse" }); return n; });
        report(pm === false, "9c item 10: a mouse hold on the photo does not show \"before\" (touch and pen only)");
        // Space still works
        const sp = await pg.evaluate(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); const a = window.__np3app.state.showNeutral;
          window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true })); return [a, window.__np3app.state.showNeutral]; });
        report(sp[0] === true && sp[1] === false, "9c item 10: the Space hold path is untouched");
        // real touch long press through the emulated touchscreen (Chromium)
        if (BROWSER === "chrome") {
          const rc = await pg.evaluate(() => { const r = document.getElementById("c").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
          const h = await pg.touchscreen.touchStart(rc.x, rc.y);
          await sleep(450);
          const during = await pg.evaluate(() => window.__np3app.state.showNeutral);
          await h.end();
          await sleep(200);
          const after = await pg.evaluate(() => window.__np3app.state.showNeutral);
          report(during === true && after === false, "9c item 10: a real (emulated) touch and hold on the photo shows before and the release returns after");
        }
      }
      await pg.close();
      await ctx.close();
    }

    // ---- the desktop page with the shared helpers ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 1280, 800, DESKTOP, false);
      await pg.evaluate(() => { const a = window.__np3app; a.state.step = "edit"; document.body.classList.toggle("step-start", false); document.body.classList.toggle("step-edit", true); });
      await loadSample(pg);
      await setSlider(pg, "contrast", 35);
      const h0 = await histIdx(pg);
      const r = await pg.evaluate(async () => { const T = window.__T, row = document.querySelector('.ctl[data-key="contrast"]'); const [x, y] = T.center(row.querySelector(".lbl"));
        await T.dtap(row.querySelector(".lbl"), x, y, 90); await T.sleep(60); return { v: row.querySelector("input[type=range]").value, h: window.__np3app.hist.index }; });
      report(r.v === "0" && r.h === h0 + 1, "9c desktop picture-control-editor.html: a touch double tap on a slider row resets it too (shared helper), one history step");
      const mouse = await pg.evaluate(() => { const a = window.__np3app; const rng = document.querySelector('.ctl[data-key="saturation"] input[type=range]');
        rng.value = 20; rng.dispatchEvent(new Event("input", { bubbles: true })); rng.dispatchEvent(new Event("change", { bubbles: true }));
        const h = a.hist.index; rng.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return { v: rng.value, dh: a.hist.index - h }; });
      report(mouse.v === "0" && mouse.dh === 1, "9c desktop picture-control-editor.html: the mouse dblclick reset is unchanged");
      const d = await pg.evaluate(() => { const rng = document.querySelector('.ctl[data-key="contrast"] input[type=range]');
        return { pe: getComputedStyle(rng).pointerEvents, h: rng.getBoundingClientRect().height, hint: document.querySelector(".ba-hint").hidden, hintDisp: getComputedStyle(document.querySelector(".ba-hint")).display,
          cTA: getComputedStyle(document.getElementById("c")).touchAction, exp: document.getElementById("export").disabled, expTitle: document.getElementById("export").title }; });
      report(d.pe !== "none" && d.h === 16 && d.hint === false && d.hintDisp !== "none" && d.cTA === "auto",
        `9c desktop picture-control-editor.html: native 16 px ranges, the Space hint is shown, the canvas has no touch-action — ${JSON.stringify(d)}`);
      // soft-disable is mobile-only: the desktop keeps disabled + title
      await pg.evaluate(() => { const n = document.getElementById("p-name"); n.value = ""; n.dispatchEvent(new Event("input", { bubbles: true })); });
      const dd = await pg.evaluate(() => ({ e: document.getElementById("export").disabled, s: document.getElementById("share").disabled,
        t: document.getElementById("export").title, a: document.getElementById("export").getAttribute("aria-disabled") }));
      report(dd.e && dd.s && dd.t === "Set a valid NP3 name (1–19 ASCII) to export" && dd.a === null,
        "9c desktop picture-control-editor.html: an invalid name still disables Export/Copy link with a tooltip (no soft-disable)");
      // clipboard failure on the desktop keeps the old status
      await pg.evaluate(() => { const n = document.getElementById("p-name"); n.value = "DESK"; n.dispatchEvent(new Event("input", { bubbles: true }));
        navigator.clipboard.writeText = () => Promise.reject(new Error("denied")); });
      await pg.evaluate(() => window.__np3app.transfer.shareNow());
      const cs = await pg.evaluate(() => window.__np3app.state.status);
      report(cs === "Share failed: denied", `9c desktop picture-control-editor.html: a refused clipboard keeps the old status ("${cs}")`);
      // the desktop export stays a plain synchronous download even if the browser has Web Share
      const ex = await pg.evaluate(() => {
        let shared = 0, blobs = 0;
        Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: async () => { shared++; } });
        Object.defineProperty(navigator, "canShare", { configurable: true, writable: true, value: () => true });
        const orig = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { blobs++; return orig(b); };
        const ret = window.__np3app.transfer.exportNow();
        return { shared, blobs, sync: ret === undefined, status: window.__np3app.state.status };
      });
      report(ex.shared === 0 && ex.blobs === 1 && ex.sync && ex.status.startsWith("Exported: "), `9c desktop picture-control-editor.html: export is the synchronous download even when Web Share exists (${JSON.stringify(ex)})`);
      report(pg.errs.length === 0, `9c desktop picture-control-editor.html: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }
  }

  // ---------- level 9d: mobile work, stage M3 — curve overlay, blender/grading sizes, modified dots, landscape ----------
  // (spec/ui-mobile.md "Tests" items 3, 4, 7 and 14, plus the M3 plan checks). Touch is driven by synthetic
  // PointerEvents whose target is the element under the point (document.elementFromPoint, so the hit circles
  // are really hit-tested); in Chromium the gestures are repeated with real emulated touch input.
  {
    const MOBILE = `http://127.0.0.1:${port}/web/picture-control-editor-mobile.html?view=mobile`;
    const DESKTOP = `http://127.0.0.1:${port}/web/picture-control-editor.html?view=desktop`;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mkPage = async (ctx, w, h, url = MOBILE, mobile = true) => {
      const pg = await ctx.newPage();
      pg.errs = [];
      pg.on("pageerror", (e) => pg.errs.push(e.message));
      pg.on("console", (m) => {
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pg.errs.push("console: " + m.text());
      });
      await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
      await pg.goto(url);
      await pg.waitForFunction(mobile ? "window.__np3app && window.__np3app.mobile" : "window.__np3app", { timeout: 120000, polling: 100 });
      await pg.evaluate(() => {
        window.__T = {
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          ptr(type, el, x, y, o = {}) {
            el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: o.id ?? 1,
              pointerType: o.type ?? "touch", isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
          },
          // the element under the point, as a real touch would hit it
          at(x, y) { return document.elementFromPoint(x, y); },
          async tap(x, y, o = {}) { const el = this.at(x, y); this.ptr("pointerdown", el, x, y, o); await this.sleep(20); this.ptr("pointerup", this.at(x, y), x, y, o); return el; },
          // client coordinates of a tone (x, y in 0..255) on the chart
          pt(tx, ty) {
            const svg = window.__np3app.curveEditor.chart, m = svg.getScreenCTM();
            const p = new DOMPoint(12 + tx, 12 + 255 - ty).matrixTransform(m);
            return [p.x, p.y];
          },
        };
      });
      return pg;
    };
    const goEdit = (pg) => pg.evaluate(() => {
      window.__np3app.state.step = "edit";
      document.body.classList.toggle("step-start", false);
      document.body.classList.toggle("step-edit", true);
    });
    const loadSample = (pg, name = "vanilla.NP3") => pg.evaluate(async (name) => {
      const b = await (await fetch("/third_party/samples/" + name)).arrayBuffer();
      await window.__np3app.transfer.importFile(new File([b], name));
      return window.__np3app.state.control.name;
    }, name);
    const R = (pg, sel) => pg.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
    const pts = (pg) => pg.evaluate(() => JSON.stringify(window.__np3app.state.control.curve?.points ?? null));
    const histIdx = (pg) => pg.evaluate(() => window.__np3app.hist.index);
    const J = JSON.stringify;
    // visible elements of `sel` smaller than min x min (hidden ones have no layout box and are ignored)
    const small = (pg, sel, min) => pg.evaluate((sel, min) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length)
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width < min - 0.5 || r.height < min - 0.5; })
      .map((e) => `${e.id || e.className || e.tagName}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`), sel, min);
    const tools = ["strength", "basic", "curve", "details", "blender", "grading"];

    // ---- A. the curve over the photo (portrait 390 x 844, no frame needed) ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const own = await pg.evaluate(() => { const a = window.__np3app; const svg = a.curveEditor.chart;
        return { inChart: svg.parentElement.id === "curve-chart", slotHasSvg: !!document.querySelector("#curve-slot .ce-svg"), hidden: document.getElementById("curve-chart").hidden,
          toggleInSlot: !!document.querySelector("#curve-slot .ce-toggle"), cls: svg.getAttribute("class") }; });
      report(own.inChart && !own.slotHasSvg && own.hidden && own.toggleInSlot,
        `9d curve: with a chartSlot the SVG lives in #curve-chart (api.chart) and the controls stay in #curve-slot; the overlay starts hidden — ${J(own)}`);
      await pg.evaluate(() => window.__np3app.mobile.setTool("curve"));
      let hid = await pg.evaluate(() => document.getElementById("curve-chart").hidden);
      report(hid === true, "9d curve overlay: the Curve tool with the custom curve off shows no chart");
      await pg.evaluate(() => document.querySelector('#curve-slot input[type="checkbox"]').click());
      await sleep(100);
      const ov = await pg.evaluate(() => { const c = document.getElementById("curve-chart"), v = document.getElementById("view").getBoundingClientRect(), s = window.__np3app.curveEditor.chart.getBoundingClientRect();
        const cs = getComputedStyle(window.__np3app.curveEditor.chart);
        return { hidden: c.hidden, side: s.width, h: s.height, view: [v.width, v.height], cx: s.x + s.width / 2 - (v.x + v.width / 2), cy: s.y + s.height / 2 - (v.y + v.height / 2),
          bg: cs.backgroundColor, ta: cs.touchAction, inView: s.x >= v.x && s.right <= v.right && s.y >= v.y && s.bottom <= v.bottom }; });
      const want = Math.min(ov.view[0], ov.view[1]) - 16;
      report(ov.hidden === false && Math.abs(ov.side - ov.h) < 1 && Math.abs(ov.side - want) < 1.5 && Math.abs(ov.cx) < 1.5 && Math.abs(ov.cy) < 1.5 && ov.inView,
        `9d curve overlay: with the curve on the chart is a centered square of min(viewer w, h) - 16 px (${Math.round(ov.side)} px, expected ${Math.round(want)}) inside the viewer`);
      report(ov.bg === "rgba(0, 0, 0, 0.35)" && ov.ta === "none", `9d curve overlay: semi-transparent black background and touch-action none (${ov.bg}, ${ov.ta})`);
      const hit = await pg.evaluate(() => { const svg = window.__np3app.curveEditor.chart, k = svg.getScreenCTM().a;
        return [...svg.querySelectorAll(".ce-hit")].map((h) => +h.getAttribute("r") * k); });
      report(hit.length === 2 && hit.every((r) => Math.abs(r - 22) < 0.6), `9d curve: every point has an invisible hit circle of 22 screen px at this scale (${hit.map((r) => r.toFixed(1))})`);
      const done = await R(pg, "#curve-slot .ce-done");
      report(done && done.w >= 44 && done.h >= 44, `9d curve: the Done button is in the panel and finger-sized (${J(done && [Math.round(done.w), Math.round(done.h)])})`);
      // ...and compact: one row with the toggle (a direct child of the slot, icon and label side by
      // side, not the tool-bar look of an icon over a label)
      const dl = await pg.evaluate(() => {
        const b = document.querySelector("#curve-slot .ce-done"), head = document.querySelector("#curve-slot .ce-head");
        const r = b.getBoundingClientRect(), hr = head.getBoundingClientRect();
        const ic = b.querySelector("svg").getBoundingClientRect(), tx = b.querySelector("span").getBoundingClientRect();
        return { direct: b.parentElement.id === "curve-slot", h: Math.round(r.height), icon: Math.round(ic.width),
                 sideBySide: tx.left >= ic.right - 1, row: Math.abs((r.top + r.bottom) / 2 - (hr.top + hr.bottom) / 2) < 6 };
      });
      report(dl.direct && dl.h <= 52 && dl.icon <= 20 && dl.sideBySide && dl.row,
        `9d curve: Done is compact, in the toggle row (${J(dl)})`);
      // leaving the tool hides the overlay, coming back shows it again
      const vis = await pg.evaluate(() => { const m = window.__np3app.mobile, c = document.getElementById("curve-chart"), out = {};
        m.setTool("details"); out.details = c.hidden; m.setTool("curve"); out.back = c.hidden; return out; });
      report(vis.details === true && vis.back === false, "9d curve overlay: leaving the tool hides the chart, returning shows it");
      await pg.click("#curve-slot .ce-done");
      const dn = await pg.evaluate(() => ({ tool: window.__np3app.mobile.tool, hidden: document.getElementById("curve-chart").hidden, on: window.__np3app.state.control.curve !== null }));
      report(dn.tool === "basic" && dn.hidden === true && dn.on === true, `9d curve: Done returns to Basic, hides the chart and keeps the curve (${J(dn)})`);
      await pg.evaluate(() => window.__np3app.mobile.setTool("curve"));

      // taps: an empty spot adds a point (touch); a point is selected, not added; a drag and a mouse tap add nothing
      const p0 = await pts(pg), h0 = await histIdx(pg);
      const [ax, ay] = await pg.evaluate(() => window.__T.pt(100, 160));
      await pg.evaluate(async (x, y) => { await window.__T.tap(x, y); }, ax, ay);
      const p1 = JSON.parse(await pts(pg));
      const added = p1.find((p) => !JSON.parse(p0).some((q) => q[0] === p[0]));
      report(p1.length === 3 && added && Math.abs(added[0] - 100) <= 1 && Math.abs(added[1] - 160) <= 1,
        `9d curve: a touch tap on an empty spot of the chart adds a point there (${J(added)})`);
      report(await pg.evaluate(() => document.querySelector("#curve-slot .ce-ctl input").value) === String(added[0]), "9d curve: the new point is selected (x/y fields show it)");
      report((await histIdx(pg)) === h0 + 1, "9d curve: the tap is one finished action (one history step)");
      // a tap on the identity diagonal (a line over the background) is still an empty spot
      const [dx, dy] = await pg.evaluate(() => window.__T.pt(200, 200));
      const dEl = await pg.evaluate(async (x, y) => (await window.__T.tap(x, y)).getAttribute("class"), dx, dy);
      report(JSON.parse(await pts(pg)).length === 4, `9d curve: a tap on the diagonal / curve line (target ${dEl}) adds a point too`);
      // a tap on a point (also in its 22 px hit zone, 15 px from its center) selects it
      const [px, py] = await pg.evaluate(() => window.__T.pt(100, 160));
      const n0 = JSON.parse(await pts(pg)).length;
      const hz = await pg.evaluate(async (x, y) => { const el = await window.__T.tap(x + 15, y + 2); return { cls: el.getAttribute("class"), sel: document.querySelector("#curve-slot .ce-ctl input").value }; }, px, py);
      report(hz.cls === "ce-hit" && hz.sel === "100" && JSON.parse(await pts(pg)).length === n0,
        `9d curve: a tap 15 px beside a point hits its invisible circle and selects the point, it does not add one (${J(hz)})`);
      const far = await pg.evaluate((x, y) => window.__T.at(x + 40, y + 2).getAttribute("class"), px, py);
      report(far !== "ce-hit" && far !== "ce-pt", `9d curve: 40 px away is not the point's hit zone (${far})`);
      // a drag from empty space (20 px) adds nothing; a mouse click adds nothing; a mouse dblclick adds one
      const n1 = JSON.parse(await pts(pg)).length;
      const [ex, ey] = await pg.evaluate(() => window.__T.pt(40, 100));
      await pg.evaluate(async (x, y) => { const T = window.__T, el = T.at(x, y); T.ptr("pointerdown", el, x, y); T.ptr("pointermove", el, x + 20, y); await T.sleep(20); T.ptr("pointerup", el, x + 20, y); }, ex, ey);
      const n2 = JSON.parse(await pts(pg)).length;
      await pg.evaluate(async (x, y) => { await window.__T.tap(x, y, { type: "mouse" }); }, ex, ey);
      const n3 = JSON.parse(await pts(pg)).length;
      await pg.evaluate((x, y) => { const el = window.__T.at(x, y); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y })); }, ex, ey);
      const n4 = JSON.parse(await pts(pg)).length;
      report(n2 === n1 && n3 === n1 && n4 === n1 + 1, `9d curve: a 20 px drag and a mouse click add nothing, the mouse dblclick still adds a point (${n1} -> ${n2}/${n3}/${n4})`);
      // the mouse is the last pointer: the hit circles stop taking events (desktop behavior)
      const mouseMode = await pg.evaluate((x, y) => { const svg = window.__np3app.curveEditor.chart;
        window.__T.ptr("pointerdown", svg, 5, 5, { type: "touch" }); window.__T.ptr("pointerup", svg, 5, 5, { type: "touch" });
        const was = svg.classList.contains("touch");
        window.__T.ptr("pointerdown", svg, 5, 5, { type: "mouse" }); window.__T.ptr("pointerup", svg, 5, 5, { type: "mouse" });
        const during = window.__T.at(x + 15, y + 2).getAttribute("class"); const cls = svg.classList.contains("touch");
        window.__T.ptr("pointerdown", svg, 5, 5, { type: "touch" }); window.__T.ptr("pointerup", svg, 5, 5, { type: "touch" });
        return { was, cls, during, back: svg.classList.contains("touch") }; }, px, py);
      report(mouseMode.was && !mouseMode.cls && mouseMode.during !== "ce-hit" && mouseMode.back,
        `9d curve: hit circles take events only while the last pointer is a finger or a pen — ${J(mouseMode)}`);
      // drag a point from its hit zone: control.curve changes, the neighbors rule holds, one history step
      const raw0 = await pg.evaluate(() => window.__np3app.state.control.curve.raw.join(","));
      const h1 = await histIdx(pg);
      const [qx, qy] = await pg.evaluate(() => window.__T.pt(100, 160));
      const [tx, ty] = await pg.evaluate(() => window.__T.pt(120, 190));
      await pg.evaluate(async (qx, qy, tx, ty) => { const T = window.__T, el = T.at(qx + 12, qy);
        T.ptr("pointerdown", el, qx + 12, qy);
        for (let i = 1; i <= 8; i++) { T.ptr("pointermove", el, qx + 12 + (tx - qx - 12) * i / 8, qy + (ty - qy) * i / 8); await T.sleep(10); }
        T.ptr("pointerup", el, tx, ty); }, qx, qy, tx, ty);
      const moved = JSON.parse(await pts(pg)).find((p) => Math.abs(p[0] - 120) <= 2 && Math.abs(p[1] - 190) <= 2);
      const raw1 = await pg.evaluate(() => window.__np3app.state.control.curve.raw.join(","));
      report(!!moved && raw1 !== raw0 && (await histIdx(pg)) === h1 + 1,
        `9d curve: dragging a point from its hit circle moves it (${J(moved)}), changes control.curve and is one history step`);
      // the 20-point limit is a toast
      await pg.evaluate(() => { const ed = window.__np3app.curveEditor; for (let x = 10; x < 250; x += 11) ed.addPoint(x, (x * 7) % 255); });
      const cnt = JSON.parse(await pts(pg)).length;
      const [fx, fy] = await pg.evaluate(() => window.__T.pt(7, 30));
      await pg.evaluate(async (x, y) => { await window.__T.tap(x, y); }, fx, fy);
      const lim = await pg.evaluate(() => ({ toasts: window.__np3app.mobile.toasts().map((x) => x.text), noteShown: getComputedStyle(document.querySelector("#curve-slot .ce-limit")).display }));
      report(cnt === 20 && JSON.parse(await pts(pg)).length === 20 && lim.toasts.includes("A curve can have at most 20 points") && lim.noteShown === "none",
        `9d curve: at 20 points a tap adds nothing and the limit shows as a toast, not in the panel (${cnt} points, ${J(lim)})`);
      // Reset / undo: the overlay follows the curve
      await pg.evaluate(() => window.__np3app.mobile.setTool("curve"));
      await pg.click("#reset-btn"); await sleep(100); await pg.click("#confirm-ok"); await sleep(150);
      const rs = await pg.evaluate(() => ({ hidden: document.getElementById("curve-chart").hidden, curve: window.__np3app.state.control.curve, on: document.querySelector('#curve-slot input[type="checkbox"]').checked }));
      report(rs.hidden === true && rs.curve === null && rs.on === false, "9d curve overlay: Reset (curve off) hides the chart in the Curve tool");
      await pg.click("#undo"); await sleep(150);
      const un = await pg.evaluate(() => ({ hidden: document.getElementById("curve-chart").hidden, on: window.__np3app.state.control.curve !== null }));
      report(un.hidden === false && un.on === true, "9d curve overlay: Undo (curve back on) shows the chart again");
      // an imported profile with a curve
      await loadSample(pg, "tonecurve-max-point.NP3");
      const im = await pg.evaluate(() => ({ hidden: document.getElementById("curve-chart").hidden, n: window.__np3app.state.control.curve?.points.length,
        hits: document.querySelectorAll("#curve-chart .ce-hit").length }));
      report(im.hidden === false && im.n > 2 && im.hits === im.n, `9d curve overlay: an imported profile with a curve shows the chart with its ${im.n} points and hit circles`);
      report(pg.errs.length === 0, `9d curve: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();

      // real touch (Chromium): a finger tap adds a point, a finger drag moves it
      if (BROWSER !== "chrome") skip("9d curve real touch: puppeteer touchscreen is only exercised in Chromium");
      else {
        const pg2 = await mkPage(ctx, 390, 844);
        await goEdit(pg2);
        await pg2.evaluate(() => window.__np3app.mobile.setTool("curve"));
        await pg2.evaluate(() => document.querySelector('#curve-slot input[type="checkbox"]').click());
        await sleep(100);
        const b = await pg2.evaluate(() => { const r = window.__np3app.curveEditor.chart.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
        await pg2.touchscreen.tap(b.x + b.w * 0.3, b.y + b.h * 0.65);
        await sleep(150);
        const a1 = JSON.parse(await pts(pg2));
        report(a1.length === 3, `9d curve real touch: a finger tap on the chart adds a point (${J(a1)})`);
        const [sx, sy] = await pg2.evaluate((a, b) => window.__T.pt(a, b), a1[1][0], a1[1][1]);
        const hnd = await pg2.touchscreen.touchStart(sx + 10, sy);
        for (let i = 1; i <= 8; i++) { await hnd.move(sx + 10 + 8 * i, sy - 6 * i); await sleep(16); }
        await hnd.end();
        await sleep(150);
        const a2 = JSON.parse(await pts(pg2));
        report(a2.length === 3 && a2[1][0] > a1[1][0] + 10 && a2[1][1] > a1[1][1] + 10,
          `9d curve real touch: a finger drag that starts 10 px beside the point moves it ${J(a1[1])} -> ${J(a2[1])}`);
        report(await pg2.evaluate(() => document.getElementById("panel-scroll").scrollTop) === 0 && pg2.errs.length === 0, "9d curve real touch: the panel did not scroll, no page errors");
        await pg2.close();
      }
      await ctx.close();
    }

    // ---- B. modified dots (portrait 390 x 844) ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      const state = () => pg.evaluate(() => ({ set: [...window.__np3app.mobile.modified()].sort(),
        dots: [...document.querySelectorAll("#tools .tool")].filter((b) => !b.querySelector(".mdot").hidden).map((b) => b.dataset.tool).sort() }));
      const sliderIn = (sel, v) => pg.evaluate((sel, v) => { const el = document.querySelector(sel); el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }, sel, v);
      let s = await state();
      report(s.set.length === 0 && s.dots.length === 0, "9d modified dots: a fresh profile has none");
      await sliderIn('.ctl[data-key="contrast"] input[type=range]', 30);
      s = await state();
      report(J(s.set) === '["basic"]' && J(s.dots) === '["basic"]', `9d modified dots: a Basic slider change marks Basic only (${J(s)})`);
      const geo = await pg.evaluate(() => { const b = document.getElementById("tab-basic"), d = b.querySelector(".mdot").getBoundingClientRect(), l = b.querySelector(".lbl").getBoundingClientRect();
        return { w: d.width, h: d.height, below: d.top >= l.bottom - 1, color: getComputedStyle(b.querySelector(".mdot")).backgroundColor, cx: Math.abs(d.x + d.width / 2 - (b.getBoundingClientRect().x + b.getBoundingClientRect().width / 2)) }; });
      report(geo.w === 4 && geo.h === 4 && geo.below && geo.cx < 1.5, `9d modified dots: a 4 px dot under the label, centered (${J(geo)})`);
      // name and comment do not mark Profile; strength does
      await pg.evaluate(() => { const n = document.getElementById("p-name"); n.value = "ABCD"; n.dispatchEvent(new Event("input", { bubbles: true })); });
      await sliderIn('.ctl[data-key="contrast"] input[type=range]', 31);
      s = await state();
      report(!s.set.includes("strength"), "9d modified dots: the name does not mark Profile");
      await pg.evaluate(() => { const r = document.querySelector('#tool-strength .ctl input[type=range]'); r.value = 90; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); });
      s = await state();
      report(s.set.includes("strength") && J(s.set) === J(s.dots), `9d modified dots: Strength != 100 marks Profile (${J(s)})`);
      await sliderIn('.ctl[data-key="sharpening"] input[type=range]', 3);
      await sliderIn('#blending-slot .ctl input[type=range]', 25);
      await sliderIn('#grading-slot .gr-shared .ctl input[type=range]', 60);
      await pg.evaluate(() => document.querySelector('#curve-slot input[type="checkbox"]').click());
      s = await state();
      report(J(s.set) === J(["basic", "blender", "curve", "details", "grading", "strength"]) && J(s.dots) === J(s.set), `9d modified dots: Details, Blender, Grading (Blending), Curve each mark their own tool (${J(s)})`);
      // a finished action recomputes (a live drag does not): the dot follows history
      await pg.click("#reset-btn"); await sleep(100); await pg.click("#confirm-ok"); await sleep(150);
      s = await state();
      report(s.set.length === 0 && s.dots.length === 0, `9d modified dots: Reset clears them all (${J(s)})`);
      await pg.click("#undo"); await sleep(150);
      s = await state();
      report(s.set.length === 6 && J(s.dots) === J(s.set), `9d modified dots: Undo of the Reset brings them back (${J(s)})`);
      await pg.evaluate(() => window.__np3app.transfer.importFile && null);
      await loadSample(pg, "vanilla.NP3");
      const im1 = await state();
      report(J(im1.set) === J(im1.dots), `9d modified dots: after an NP3 import the dots follow the imported profile (${J(im1.set)})`);
      await loadSample(pg, "tonecurve-black.NP3");
      const im2 = await state();
      report(im2.set.includes("curve") && J(im2.set) === J(im2.dots), `9d modified dots: an imported curve marks Curve (${J(im2.set)})`);
      const al = await pg.evaluate(() => [...document.querySelectorAll("#tools .tool")].map((b) => b.getAttribute("aria-label")));
      report(J(al) === J(["Profile", "Basic", "Curve", "Details", "Blender", "Grading"]), `9d tool bar: every tool has an aria-label (the label is hidden in landscape) ${J(al)}`);
      report(pg.errs.length === 0, `9d modified dots: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }

    // ---- C. Blender and Grading with a finger (portrait 390 x 844) ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      await pg.evaluate(() => window.__np3app.mobile.setTool("blender"));
      const bl = await pg.evaluate(() => { const dots = [...document.querySelectorAll("#blending-slot .bl-dot")], rs = dots.map((d) => d.getBoundingClientRect());
        const cs = getComputedStyle(dots[0]), cont = document.querySelector("#blending-slot .bl-dots").getBoundingClientRect();
        const gaps = rs.slice(1).map((r, i) => r.x - rs[i].right);
        const visible = rs[0].width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
        const ring = getComputedStyle(dots[0], "::after");
        return { n: dots.length, hit: rs.map((r) => [Math.round(r.width), Math.round(r.height)]), visible, clip: cs.backgroundClip,
          spread: Math.max(...gaps) - Math.min(...gaps), edgeL: rs[0].x - cont.x, edgeR: cont.right - rs[7].right,
          sel: dots.findIndex((d) => d.classList.contains("sel")), ringW: ring.borderTopWidth, ringC: ring.borderTopColor, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() }; });
      report(bl.n === 8 && bl.hit.every(([w, h]) => w >= 40 && h >= 40) && bl.visible === 28 && bl.clip === "content-box",
        `9d blender Color mode: 8 dots, each a >= 40 px hit area with a 28 px visible dot (${bl.visible} px) — ${J(bl.hit[0])}`);
      report(bl.spread < 1.5 && bl.edgeL < 1 && bl.edgeR < 1, `9d blender Color mode: the dots are spread evenly across the panel width (gap spread ${bl.spread.toFixed(2)} px, edges ${bl.edgeL.toFixed(1)}/${bl.edgeR.toFixed(1)})`);
      report(bl.sel === 0 && bl.ringW === "2px", `9d blender Color mode: the selected dot has a 2 px ring (${bl.ringW} ${bl.ringC})`);
      const tgl = await small(pg, "#blending-slot .tgl button, #blending-slot .tabbtn", 40);
      const tglH = await pg.evaluate(() => [...document.querySelectorAll("#blending-slot .tgl button")].map((b) => b.getBoundingClientRect().height));
      report(tgl.length === 0 && tglH.every((h) => h >= 40 && h <= 44), `9d blender: the Adjust toggle is 40 px high (${tglH.map(Math.round)})`);
      await pg.evaluate(() => window.__np3app.blendingView.setMode(false));
      const tabs = await pg.evaluate(() => [...document.querySelectorAll("#blending-slot .tabbtn")].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      report(tabs.length === 4 && tabs.every(([w, h]) => w >= 40 && h >= 40), `9d blender HSL: the Hue | Saturation | Luminance | All tabs are >= 40 px (${J(tabs)})`);
      await pg.evaluate(() => window.__np3app.blendingView.setMode(true));
      // selecting a dot by a tap
      const d3 = await R(pg, "#blending-slot .bl-dot:nth-child(4)");
      if (BROWSER === "chrome") await pg.touchscreen.tap(d3.x + d3.w / 2, d3.y + d3.h / 2);
      else await pg.evaluate((x, y) => document.elementFromPoint(x, y).click(), d3.x + d3.w / 2, d3.y + d3.h / 2);
      await sleep(100);
      const sel3 = await pg.evaluate(() => ({ i: [...document.querySelectorAll("#blending-slot .bl-dot")].findIndex((d) => d.classList.contains("sel")), name: document.querySelector("#blending-slot .bl-cname").textContent }));
      // a tap in the 6 px transparent border (outside the 28 px dot, inside the hit area) selects too
      const d5 = await R(pg, "#blending-slot .bl-dot:nth-child(6)");
      await pg.evaluate((x, y) => { document.elementFromPoint(x, y).click(); }, d5.x + 3, d5.y + d5.h / 2);
      const sel5 = await pg.evaluate(() => [...document.querySelectorAll("#blending-slot .bl-dot")].findIndex((d) => d.classList.contains("sel")));
      report(sel3.i === 3 && sel3.name === "Green" && sel5 === 5, `9d blender Color mode: a tap on a dot selects it (${J(sel3)}), a tap 3 px inside the edge of its 40 px box (outside the 28 px dot) selects too (${sel5})`);
      report(pg.errs.length === 0, `9d blender: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);

      // grading: wheel size, hit areas
      for (const [w, h] of [[390, 844], [360, 640]]) {
        await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
        await sleep(150);
        await pg.evaluate(() => { window.__np3app.mobile.setTool("grading"); window.__np3app.gradingView.setMode(true); });
        const g = await pg.evaluate(() => { const d = document.querySelector("#grading-slot .gr-disc:not([hidden])") ; const discs = [...document.querySelectorAll("#grading-slot .gr-disc")].filter((e) => e.getClientRects().length);
          const disc = discs[0].getBoundingClientRect(), wrap = discs[0].closest(".gr-wheel").parentElement.getBoundingClientRect();
          const tgl = [...document.querySelectorAll("#grading-slot .tgl button, #grading-slot .tabbtn")].map((b) => b.getBoundingClientRect());
          const nums = [...document.querySelectorAll("#grading-slot .gr-nums input")].filter((e) => e.getClientRects().length).map((e) => getComputedStyle(e).fontSize);
          return { w: disc.width, h: disc.height, panelW: wrap.width, ta: getComputedStyle(discs[0]).touchAction, tglMin: Math.min(...tgl.map((r) => r.height)), nums, cx: disc.x + disc.width / 2 - (wrap.x + wrap.width / 2) }; });
        const wantW = Math.min(200, g.panelW * 0.55);
        report(Math.abs(g.w - wantW) < 1.5 && Math.abs(g.w - g.h) < 1 && g.ta === "none" && Math.abs(g.cx) < 1.5,
          `9d grading Color mode at ${w}x${h}: the wheel is min(200 px, 55% of ${Math.round(g.panelW)}) = ${Math.round(wantW)} px (${Math.round(g.w)} x ${Math.round(g.h)}), centered, touch-action none`);
        report(g.tglMin >= 40 && g.nums.every((f) => f === "16px"), `9d grading at ${w}x${h}: toggle and zone tabs >= 40 px (${Math.round(g.tglMin)}), the Hue/Saturation fields are 16 px`);
      }
      await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await sleep(150);

      if (BROWSER !== "chrome") skip("9d blender/grading real touch: puppeteer touchscreen is only exercised in Chromium");
      else {
        // the wheel: a finger drag sets Hue/Saturation and never scrolls the panel
        await pg.evaluate(() => { window.__np3app.mobile.setTool("grading"); window.__np3app.gradingView.setMode(true); window.__np3app.gradingView.selectZone("midtone"); document.getElementById("panel-scroll").scrollTop = 0; });
        await sleep(100);
        const wh = await pg.evaluate(() => { const disc = [...document.querySelectorAll("#grading-slot .gr-disc")].filter((e) => e.getClientRects().length)[0].getBoundingClientRect(); return { x: disc.x, y: disc.y, w: disc.width }; });
        const cx = wh.x + wh.w / 2, cy = wh.y + wh.w / 2;
        const h0 = await histIdx(pg);
        const hd = await pg.touchscreen.touchStart(cx, cy - wh.w * 0.2);
        for (let i = 1; i <= 8; i++) { await hd.move(cx + wh.w * 0.04 * i, cy - wh.w * 0.2 + 12 * i); await sleep(16); }
        await hd.end();
        await sleep(200);
        const g1 = await pg.evaluate(() => ({ z: window.__np3app.state.control.grade.midtone, scroll: document.getElementById("panel-scroll").scrollTop }));
        report(g1.z[1] > 5 && g1.z[0] > 0 && g1.z[0] < 180 && g1.scroll === 0 && (await histIdx(pg)) === h0 + 1,
          `9d grading real touch: dragging on the wheel sets Hue/Saturation (${J(g1.z)}), the panel does not scroll (${g1.scroll} px), one history step`);
        // sliders of Blender and Grading are driven by horizontalDrag: horizontal moves the value, vertical swipes scroll
        await pg.evaluate(() => { window.__np3app.mobile.setTool("blender"); window.__np3app.blendingView.setMode(true); document.getElementById("panel-scroll").scrollTop = 0; });
        await sleep(100);
        const sl = await pg.evaluate(() => { const r = document.querySelector("#blending-slot .bl-dots ~ .ctl input[type=range]").getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width }; });
        const getHue = () => pg.evaluate(() => Number(document.querySelector("#blending-slot .bl-dots ~ .ctl input[type=range]").value));
        const hb = await histIdx(pg);
        const sh = await pg.touchscreen.touchStart(sl.x + sl.w / 2, sl.y);
        for (let i = 1; i <= 8; i++) { await sh.move(sl.x + sl.w / 2 + 10 * i, sl.y); await sleep(16); }
        await sh.end();
        await sleep(150);
        const hue1 = await getHue();
        const sv = await pg.touchscreen.touchStart(sl.x + sl.w * 0.8, sl.y);
        for (let i = 1; i <= 8; i++) { await sv.move(sl.x + sl.w * 0.8 + 1, sl.y - 8 * i); await sleep(16); }
        await sv.end();
        await sleep(200);
        const hue2 = await getHue();
        const sc = await pg.evaluate(() => document.getElementById("panel-scroll").scrollTop);
        report(hue1 > 20 && hue2 === hue1 && (await histIdx(pg)) === hb + 1 && sc > 0,
          `9d blender real touch: a horizontal drag moves a Blender slider (Hue 0 -> ${hue1}), a vertical swipe on its track only scrolls the panel (${sc} px) and changes nothing (${hue2})`);
        await pg.evaluate(() => { window.__np3app.mobile.setTool("grading"); window.__np3app.gradingView.setMode(true); document.getElementById("panel-scroll").scrollTop = 0; });
        await sleep(100);
        const gs = await pg.evaluate(() => { const r = document.querySelector("#grading-slot .gr-shared .ctl input[type=range]"); r.scrollIntoView({ block: "center" }); const b = r.getBoundingClientRect(); return { x: b.x, y: b.y + b.height / 2, w: b.width }; });
        await sleep(100);
        const gs2 = await pg.evaluate(() => { const b = document.querySelector("#grading-slot .gr-shared .ctl input[type=range]").getBoundingClientRect(); return { x: b.x, y: b.y + b.height / 2, w: b.width }; });
        const bl0 = await pg.evaluate(() => window.__np3app.state.control.blending);
        const gh = await pg.touchscreen.touchStart(gs2.x + gs2.w / 2, gs2.y);
        for (let i = 1; i <= 8; i++) { await gh.move(gs2.x + gs2.w / 2 - 12 * i, gs2.y); await sleep(16); }
        await gh.end();
        await sleep(150);
        const bl1 = await pg.evaluate(() => window.__np3app.state.control.blending);
        report(bl1 < bl0 - 10, `9d grading real touch: a horizontal drag moves the Blending slider (${bl0} -> ${bl1})`);
      }
      await pg.close();
      await ctx.close();
    }

    // ---- D. 360 x 640 (the smallest phone): nothing cut off, every control finger-sized, in every tool ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 360, 640);
      await goEdit(pg);
      await pg.evaluate(() => document.querySelector('#curve-slot input[type="checkbox"]').click());   // the curve on, so its panel and chart are complete
      const bad = [], over = [];
      for (const tl of tools) {
        await pg.evaluate((tl) => { window.__np3app.mobile.setTool(tl); }, tl);
        if (tl === "blender") await pg.evaluate(() => window.__np3app.blendingView.setMode(true));
        if (tl === "grading") await pg.evaluate(() => window.__np3app.gradingView.setMode(true));
        await sleep(80);
        for (const mode of tl === "blender" || tl === "grading" ? [true, false] : [null]) {
          if (mode !== null) await pg.evaluate((tl, m) => (tl === "blender" ? window.__np3app.blendingView : window.__np3app.gradingView).setMode(m), tl, mode);
          bad.push(...(await small(pg, `#tool-${tl} button, #tool-${tl} .tabbtn`, 40)).map((x) => `${tl}: ${x}`));
          bad.push(...(await small(pg, `#tool-${tl} .bl-dot`, 40)).map((x) => `${tl}: ${x}`));
          const o = await pg.evaluate(() => { const p = document.getElementById("panel-scroll"); const pr = p.getBoundingClientRect();
            const wide = [...p.querySelectorAll("*")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > pr.right + 0.5 && !e.closest(".grad, input[type=range]")).map((e) => e.className || e.tagName).slice(0, 3);
            return { sw: p.scrollWidth, cw: p.clientWidth, wide }; });
          if (o.sw > o.cw || o.wide.length) over.push(`${tl}${mode === null ? "" : mode ? " color" : " hsl"}: ${J(o)}`);
        }
      }
      const cl = await pg.evaluate(() => { window.__np3app.mobile.setTool("curve"); const r = document.querySelector("#curve-slot .ce-head").getBoundingClientRect(); return r.height; });
      report(bad.length === 0, `9d 360x640: every button, tab, toggle and color dot in all six tools is >= 40 px${bad.length ? " — " + bad.join("; ") : ""}`);
      report(over.length === 0 && cl >= 44, `9d 360x640: no panel content is cut off horizontally in any tool or mode; the curve checkbox row is ${Math.round(cl)} px high${over.length ? " — " + over.join("; ") : ""}`);
      const chart = await pg.evaluate(() => { const v = document.getElementById("view").getBoundingClientRect(), s = window.__np3app.curveEditor.chart.getBoundingClientRect();
        return { inView: s.x >= v.x - 0.5 && s.right <= v.right + 0.5 && s.y >= v.y - 0.5 && s.bottom <= v.bottom + 0.5, side: s.width, view: [v.width, v.height] }; });
      report(chart.inView && Math.abs(chart.side - (Math.min(...chart.view) - 16)) < 1.5, `9d 360x640: the curve chart fits the viewer (${Math.round(chart.side)} px square in ${chart.view.map(Math.round).join(" x ")})`);
      const top = await small(pg, "#topbar button, #toolbar .tool", 44);
      const ns = await pg.evaluate(() => ({ v: document.documentElement.scrollHeight <= innerHeight, h: document.documentElement.scrollWidth <= innerWidth, tb: document.getElementById("toolbar").scrollWidth > document.getElementById("toolbar").clientWidth }));
      report(top.length === 0 && ns.v && ns.h && ns.tb, `9d 360x640: top bar and tool bar targets >= 44 px, the page does not scroll, the tool bar scrolls horizontally (${J(ns)})`);
      report(pg.errs.length === 0, `9d 360x640: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }

    // ---- E. landscape 844 x 390, rotating back and forth keeps profile, history and the tool ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await goEdit(pg);
      await pg.evaluate(() => { window.__rot = 1; });
      await pg.evaluate(() => window.__np3app.mobile.setTool("curve"));
      await pg.evaluate(() => document.querySelector('#curve-slot input[type="checkbox"]').click());
      await pg.evaluate(async () => { await window.__T.tap(...window.__T.pt(100, 160)); });
      await pg.evaluate(() => window.__np3app.mobile.setTool("blender"));
      await pg.evaluate(() => { const r = document.querySelector("#blending-slot .ctl input[type=range]"); r.value = 17; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); });
      await pg.evaluate(() => window.__np3app.mobile.setTool("curve"));
      const before = await pg.evaluate(() => ({ ctl: JSON.stringify(window.__np3app.state.control), strength: window.__np3app.state.strength, hist: window.__np3app.hist.index,
        histLen: window.__np3app.hist.length, tool: window.__np3app.mobile.tool, modified: [...window.__np3app.mobile.modified()].sort(), canUndo: window.__np3app.hist.canUndo }));
      await pg.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await sleep(250);
      const L = await pg.evaluate(() => { const q = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
        const items = [...document.querySelectorAll("#toolbar .tool")].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, lbl: getComputedStyle(e.querySelector(".lbl")).display, al: e.getAttribute("aria-label") }; });
        return { top: q("#topbar"), view: q("#view"), panel: q("#panel"), bar: q("#toolbar"), items, rot: window.__rot, orient: matchMedia("(orientation: landscape)").matches,
          noScroll: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth, iw: innerWidth, ih: innerHeight }; });
      const colW = Math.min(360, 0.42 * L.iw);
      report(L.orient && L.top.h === 44 && L.top.w === 844 && L.noScroll, `9d landscape 844x390: the top bar is 44 px high over the full width, the page does not scroll`);
      report(Math.abs(L.panel.w - colW) < 1 && Math.abs(L.bar.w - colW) < 1 && L.view.r <= L.panel.x + 0.5 && L.view.x === 0 && Math.abs(L.panel.r - 844) < 0.5,
        `9d landscape: two columns — the viewer (${Math.round(L.view.w)} px) and a right column of min(360 px, 42vw) = ${Math.round(colW)} px (panel ${Math.round(L.panel.w)}, tool bar ${Math.round(L.bar.w)})`);
      report(L.view.y >= L.top.b - 0.5 && L.view.b <= 390.5 && L.panel.y >= L.top.b - 0.5 && L.panel.b <= L.bar.y + 0.5 && L.bar.b <= 390.5 && L.panel.h > 120,
        `9d landscape: no overlap — the panel (${Math.round(L.panel.h)} px high) sits above the tool bar (${Math.round(L.bar.h)} px), both under the top bar`);
      const rows = [...new Set(L.items.map((i) => Math.round(i.y)))];
      report(L.items.length === 7 && rows.length === 2 && L.items.every((i) => i.lbl === "none" && i.al && i.w >= 44 && i.h >= 44),
        `9d landscape: the tool bar is icon-only in two rows (${rows.length} rows, ${L.items.length} items, labels hidden, aria-labels kept, every item >= 44 px)`);
      const cc = await pg.evaluate(() => { const s = window.__np3app.curveEditor.chart.getBoundingClientRect(), v = document.getElementById("view").getBoundingClientRect(), c = document.getElementById("curve-chart");
        const [x0, y0] = window.__T.pt(0, 0), [x1, y1] = window.__T.pt(255, 255);
        const el0 = document.elementFromPoint(x0, y0), el1 = document.elementFromPoint(x1, y1);
        return { hidden: c.hidden, side: s.width, view: [v.width, v.height], inView: s.x >= v.x - 0.5 && s.right <= v.right + 0.5 && s.y >= v.y - 0.5 && s.bottom <= v.bottom + 0.5,
          corners: [el0.getAttribute("class"), el1.getAttribute("class")], inside: x0 > 0 && y1 > 0 && x1 < innerWidth && y0 < innerHeight }; });
      report(!cc.hidden && cc.inView && Math.abs(cc.side - (Math.min(...cc.view) - 16)) < 1.5 && cc.corners.every((c) => c === "ce-hit" || c === "ce-pt") && cc.inside,
        `9d landscape: the curve chart (${Math.round(cc.side)} px square in ${cc.view.map(Math.round).join(" x ")}) fits the viewer and the endpoints at its corners are reachable (${J(cc.corners)})`);
      // every tool at 844 x 390: finger-sized, no horizontal overflow
      const bad = [], over = [];
      for (const tl of tools) {
        await pg.evaluate((tl) => window.__np3app.mobile.setTool(tl), tl);
        await sleep(60);
        bad.push(...(await small(pg, `#tool-${tl} button, #tool-${tl} .tabbtn, #tool-${tl} .bl-dot`, 40)).map((x) => `${tl}: ${x}`));
        const o = await pg.evaluate(() => { const p = document.getElementById("panel-scroll"); return p.scrollWidth > p.clientWidth; });
        if (o) over.push(tl);
      }
      report(bad.length === 0 && over.length === 0, `9d landscape: every control in all six tools is >= 40 px and nothing overflows horizontally${bad.concat(over).length ? " — " + bad.concat(over).join("; ") : ""}`);
      const tb = await small(pg, "#topbar button, #toolbar .tool", 44);
      report(tb.length === 0, "9d landscape: top bar and tool bar targets are >= 44 px");
      // the toast stays over the viewer and does not cover the panel or the tool bar; the sheet fits
      await pg.evaluate(() => window.__np3app.mobile.onBlocked("name"));
      await sleep(100);
      const ts = await pg.evaluate(() => { const t = document.querySelector("#toasts .toast").getBoundingClientRect(), p = document.getElementById("panel").getBoundingClientRect(); return { r: t.right, px: p.x, b: t.bottom, ih: innerHeight }; });
      report(ts.r <= ts.px + 0.5 && ts.b <= ts.ih, `9d landscape: a toast stays over the viewer (right edge ${Math.round(ts.r)} <= panel ${Math.round(ts.px)})`);
      await pg.evaluate(() => window.__np3app.mobile.openInfo());
      await sleep(250);
      const sh = await pg.evaluate(() => { const r = document.getElementById("sheet").getBoundingClientRect(); return { x: r.x, r: r.right, w: r.width, y: r.y, b: r.bottom, ih: innerHeight, iw: innerWidth }; });
      report(sh.x >= 0 && sh.r <= sh.iw + 0.5 && sh.y >= 0 && sh.b <= sh.ih + 0.5, `9d landscape: the info sheet fits the screen (${Math.round(sh.w)} x ${Math.round(sh.b - sh.y)})`);
      const sm = await small(pg, "#sheet button, #sheet a", 44);
      report(sm.length === 0, `9d landscape: the info sheet targets are >= 44 px${sm.length ? " — " + sm.join("; ") : ""}`);
      await pg.evaluate(() => window.__np3app.mobile.closeInfo());
      await sleep(100);
      // rotate back: the page was not reloaded, nothing was lost
      await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await sleep(250);
      await pg.evaluate(() => window.__np3app.mobile.setTool("curve"));
      const after = await pg.evaluate(() => ({ ctl: JSON.stringify(window.__np3app.state.control), strength: window.__np3app.state.strength, hist: window.__np3app.hist.index,
        histLen: window.__np3app.hist.length, tool: window.__np3app.mobile.tool, modified: [...window.__np3app.mobile.modified()].sort(), canUndo: window.__np3app.hist.canUndo, rot: window.__rot,
        undoDisabled: document.getElementById("undo").disabled, chartHidden: document.getElementById("curve-chart").hidden,
        portrait: matchMedia("(orientation: portrait)").matches, toolbarH: document.getElementById("toolbar").getBoundingClientRect().height, labels: getComputedStyle(document.querySelector("#tab-basic .lbl")).display }));
      report(L.rot === 1 && after.rot === 1 && after.ctl === before.ctl && after.strength === before.strength && after.hist === before.hist && after.histLen === before.histLen
          && after.tool === "curve" && J(after.modified) === J(before.modified) && after.undoDisabled === !before.canUndo,
        `9d rotation: portrait -> landscape -> portrait without a reload keeps the profile, the history (${before.hist}/${before.histLen}), the Undo state and the active tool`);
      report(after.portrait && !after.chartHidden && after.toolbarH >= 60 && after.labels !== "none", "9d rotation: back in portrait the tool bar has its labels again and the curve chart is shown");
      // and a second round trip, with the Reset confirmation open
      await pg.evaluate(() => { window.__np3app.mobile.askReset(); });
      await pg.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await sleep(250);
      const dlg = await pg.evaluate(() => { const r = document.getElementById("confirm-reset").getBoundingClientRect(); return { open: document.getElementById("confirm-reset").hasAttribute("open"), inside: r.y >= 0 && r.bottom <= innerHeight && r.x >= 0 && r.right <= innerWidth }; });
      report(dlg.open && dlg.inside, "9d landscape: the Reset confirmation stays open through a rotation and fits the screen");
      await pg.click("#confirm-cancel");
      report(pg.errs.length === 0, `9d landscape: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }

    // ---- F. with a RAW frame: the photo under the chart, long-press not on the chart ----
    if (!rootFile("test1/DSC_5584.NEF")) {
      skip("9d curve overlay with a frame: no test1/DSC_5584.NEF");
    } else {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 390, 844);
      await pg.evaluate(async () => {
        const a = window.__np3app;
        const bytes = await (await fetch("/test1/DSC_5584.NEF")).arrayBuffer();
        await a.openRaw(new File([bytes], "DSC_5584.NEF"));
      });
      await pg.waitForFunction(() => window.__np3app.state.raw && !window.__np3app.state.renderPending && !document.getElementById("c").hidden, { timeout: 120000, polling: 100 });
      await pg.evaluate(() => window.__np3app.mobile.setTool("curve"));
      await pg.evaluate(() => document.querySelector('#curve-slot input[type="checkbox"]').click());
      await sleep(400);
      const geo = await pg.evaluate(() => { const c = document.getElementById("c").getBoundingClientRect(), s = window.__np3app.curveEditor.chart.getBoundingClientRect();
        const hist = document.querySelector("#curve-chart .ce-hist").getAttribute("d").length;
        return { c: { x: c.x, y: c.y, w: c.width, h: c.height, b: c.bottom }, s: { x: s.x, y: s.y, w: s.width, b: s.bottom },
          shown: !document.getElementById("c").hidden && getComputedStyle(document.getElementById("c")).visibility !== "hidden", hist,
          overlap: Math.min(c.right, s.right) - Math.max(c.x, s.x) > 100 && Math.min(c.bottom, s.bottom) - Math.max(c.y, s.y) > 100 }; });
      report(geo.shown && geo.overlap && geo.hist > 100, `9d curve overlay with a frame: the photo stays in the viewer under the chart, the histogram backdrop is drawn (${geo.hist} chars)`);
      const room = geo.s.y - geo.c.y;   // photo visible above the chart square
      const press = async (x, y, real) => {
        if (real) {
          const h = await pg.touchscreen.touchStart(x, y);
          await sleep(450);
          const during = await pg.evaluate(() => window.__np3app.state.showNeutral);
          await h.end();
          await sleep(150);
          return { during, after: await pg.evaluate(() => window.__np3app.state.showNeutral) };
        }
        return pg.evaluate(async (x, y) => { const T = window.__T, el = T.at(x, y); T.ptr("pointerdown", el, x, y); await T.sleep(320);
          const during = window.__np3app.state.showNeutral; T.ptr("pointerup", el, x, y); await T.sleep(100); return { during, after: window.__np3app.state.showNeutral }; }, x, y);
      };
      const cx = geo.s.x + geo.s.w / 2, cy = geo.s.y + geo.s.w / 2, real = BROWSER === "chrome";
      if (room >= 6) {
        const off = await press(geo.c.x + geo.c.w / 2, geo.c.y + room / 2, real);
        report(off.during === true && off.after === false, `9d curve overlay: touch and hold on the photo outside the chart square (${Math.round(room)} px strip) still shows before/after`);
      } else skip("9d curve overlay: no photo strip outside the chart square at this size");
      await pg.waitForFunction(() => !window.__np3app.state.renderPending, { timeout: 60000, polling: 100 });
      const onChart = await press(cx, cy + 60, real);
      report(onChart.during === false && onChart.after === false, `9d curve overlay: touch and hold on the chart does not start before/after (${real ? "real touch" : "synthetic"})`);
      report(pg.errs.length === 0, `9d curve overlay with a frame: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }

    // ---- G. the desktop page: the editor change is invisible to the mouse ----
    {
      const ctx = await browser.createBrowserContext();
      const pg = await mkPage(ctx, 1280, 800, DESKTOP, false);
      await pg.evaluate(() => { const a = window.__np3app; a.state.step = "edit"; document.body.classList.toggle("step-start", false); document.body.classList.toggle("step-edit", true); });
      await pg.evaluate(() => { document.querySelector('#panel [data-group="curve"]').open = true; document.querySelector('#curve-slot input[type="checkbox"]').click(); window.__np3app.curveEditor.chart.scrollIntoView({ block: "center" }); });
      await sleep(150);
      const d = await pg.evaluate(() => { const svg = window.__np3app.curveEditor.chart; const hit = svg.querySelector(".ce-hit");
        const [x, y] = window.__T.pt(0, 0);
        return { parent: svg.parentElement.id, touch: svg.classList.contains("touch"), pe: getComputedStyle(hit).pointerEvents, fill: getComputedStyle(hit).fill,
          near: window.__T.at(x + 15, y - 2).getAttribute("class"), bgFill: getComputedStyle(svg.querySelector(".ce-bg")).fill, w: svg.getBoundingClientRect().width }; });
      report(d.parent === "curve-slot" && !d.touch && d.pe === "none" && d.near === "ce-bg" && d.bgFill === "rgb(22, 22, 22)",
        `9d desktop curve: the chart is in #curve-slot, the hit circles are inert for the mouse (pointer-events ${d.pe}, 15 px beside a point is ${d.near}), the background is unchanged`);
      const dbl = await pg.evaluate(() => { const [x, y] = window.__T.pt(100, 160); const el = window.__T.at(x, y);
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y })); return window.__np3app.state.control.curve.points.length; });
      report(dbl === 3, "9d desktop curve: the mouse dblclick still adds a point");
      const tap = await pg.evaluate(async () => { const [x, y] = window.__T.pt(180, 60); await window.__T.tap(x, y); return window.__np3app.state.control.curve.points.length; });
      report(tap === 4, "9d desktop curve: a touch tap adds a point on this page too (shared editor)");
      report(pg.errs.length === 0, `9d desktop curve: no page errors${pg.errs.length ? " — " + pg.errs.join("; ") : ""}`);
      await pg.close();
      await ctx.close();
    }
  }
}
