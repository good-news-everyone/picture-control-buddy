// Level 8e of web/test.mjs: the profile editor page web/picture-control-editor.html
// (spec/ui-pages.md; the editor of spec/ui-manual-mvp.md) in headless Firefox — the
// acceptance criteria of the manual editor, NP3 import/export, the share link and the
// landing's legacy ?np3= forward. One sequential page flow (spec/web-tests.md). These checks
// ran inside level 8 until the page split (stage 11).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "./lib/np3.js";
import { scaled } from "./lib/strength.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const ROOT = path.dirname(HERE);                             // the project root
// data files: in the repository root or in _local/ (raw photos are not part of the repository)
const rootFile = (p) => {
  for (const c of [path.join(ROOT, p), path.join(ROOT, "_local", p)]) if (existsSync(c)) return c;
  return null;
};

export async function runLevel8e({ browser, port, report, skip }) {
  const raw8a = rootFile("test1/DSC_5584.NEF"), raw8b = rootFile("test2/SKL_3024.dng");
  // Acceptance criteria 1, 2, 3, 5 (the interface part), 6, 7, 8, 9, 10, 11.
  // Everything runs programmatically: File/Blob from fetch + DataTransfer-drop and transfer.importFile.
  if (!raw8a || !raw8b) {
    skip(`8e UI: no RAW files (${"test1/DSC_5584.NEF" }, ${"test2/SKL_3024.dng"})`);
  } else  {
    const page = await browser.newPage();
    const netBad = [];        // any non-GET or a request with a body = locality failure
    const pageErrors = [];
    page.on("request", (r) => {
      // postData() is not supported in BiDi Firefox; a non-GET means sending data anyway.
      if (r.method() !== "GET") netBad.push(`${r.method()} ${r.url()}`);
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/web/picture-control-editor.html`);
    await page.waitForFunction(
      `window.__np3app && window.__np3app.state.step === "edit"`,
      { timeout: 120000, polling: 200 });
    const ev = (fn, ...args) => page.evaluate(fn, ...args);
    // settle: the LUT is built in a Worker (app.js) — we wait until the request is applied and the frame redrawn
    const settle = () => page.waitForFunction("!window.__np3app.state.renderPending",
      { timeout: 60000, polling: 30 });

    // Shared page helpers: dropping a file on the page or on a Start-screen zone,
    // a canvas snapshot, moving a group slider.
    await ev(() => {
      window.__t8 = {
        dropFile: async (path, name) => {
          const buf = await (await fetch(path)).arrayBuffer();
          const dt = new DataTransfer();
          dt.items.add(new File([buf], name));
          document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        },
        dropOn: async (zone, path, name) => {
          const buf = await (await fetch(path)).arrayBuffer();
          const dt = new DataTransfer();
          dt.items.add(new File([buf], name));
          document.querySelector(zone).dispatchEvent(
            new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        },
        dropBytes: (zone, name, byte) => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(4096).fill(byte)], name));
          document.querySelector(zone).dispatchEvent(
            new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        },
        // RAW first (decision #7): the JPEG goes onto its card — a drop on the card, or the
        // card's own picker (files set through a DataTransfer, then "change")
        card: (id, list = "pairs") => document.querySelector(`#${list} .pair[data-pair-id="${id}"]`),
        dropOnCard: async (id, files, list = "pairs") => {
          const dt = new DataTransfer();
          for (const [path, name, byte] of files) {
            const buf = path ? await (await fetch(path)).arrayBuffer() : new Uint8Array(4096).fill(byte);
            dt.items.add(new File([buf], name));
          }
          window.__t8.card(id, list).dispatchEvent(
            new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        },
        pickOnCard: async (id, path, name, list = "pairs") => {
          const dt = new DataTransfer();
          dt.items.add(new File([await (await fetch(path)).arrayBuffer()], name));
          const inp = window.__t8.card(id, list).querySelector(".pair-jpeg-file");
          inp.files = dt.files;
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        },
        // a real but wrong-aspect JPEG synthesised in place (a 2:1 frame vs the 3:2 RAW)
        dropWrongDim: async (id, name) => {
          const c = document.createElement("canvas");
          c.width = 400; c.height = 200;
          const x = c.getContext("2d");
          x.fillStyle = "#7f7f7f";
          x.fillRect(0, 0, 400, 200);
          const blob = await new Promise((r) => c.toBlob(r, "image/jpeg"));
          const dt = new DataTransfer();
          dt.items.add(new File([blob], name));
          window.__t8.card(id).dispatchEvent(
            new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
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
        `8e layout: ${groups.join(" -> ")}`);
      const openState = await ev(() =>
        [...document.querySelectorAll("#panel details.grp")].map((d) => `${d.dataset.group}:${d.open}`));
      report(openState.filter((s) => s.endsWith(":true")).join(",") === "strength:true,basic:true",
        `8e layout (UI-2): only Profile and Basic are open by default (${openState.join(" ")})`);
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
        `8e layout: strength is a collapsible group "${prof.summary}" (${prof.tag}, open=${prof.open})`);
      report(prof.presets === 0 && prof.label === "Strength" && prof.val === "100",
        `8e layout: the Strength slider is like the others (presets: ${prof.presets},` +
        ` label "${prof.label}", value ${prof.val})`);
      report(prof.nameBox && !prof.resultName && !prof.nameLabel,
        "8e layout (UI-2): name is the first field of the Profile group without a label, the result name is gone");
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
        `8e UI-2: blender tabs ${lr.tabs.join("/")}, dots ${lr.dots}, sliders ${lr.blenderSliders}`);
      report(lr.blendMode === "Color", `8e UI-2: blender defaults to the ${lr.blendMode} mode`);
      report(lr.satGrad, "8e UI-2: Saturation has a gradient track");
      report(lr.tgl === "HSL" && lr.wheels === 3
             && JSON.stringify(lr.zones) === JSON.stringify(["Shadows", "Midtones", "Highlights"]),
        `8e UI-2: Color Grading toggle "${lr.tgl}" first, zones ${lr.zones.join("/")}, wheels ${lr.wheels}`);
      report(lr.gradPreview && lr.gradPreviewParent === "grading-hsl"
             && lr.gradDivider === 1 && lr.gradNums === 6
             && lr.gradBlendLabels === 1 && lr.gradWheelNames === 0
             && lr.gradSubs === 0 && lr.gradSharedHidden === false,
        `8e UI-2: Grading — preview ${lr.gradPreview ? "in HSL" : "?"}` +
        ` (parent ${lr.gradPreviewParent}), divider ${lr.gradDivider},` +
        ` Hue/Sat number inputs ${lr.gradNums}, Blending labels ${lr.gradBlendLabels},` +
        ` names over the wheel ${lr.gradWheelNames}, extra headings ${lr.gradSubs},` +
        ` Blending/Balance in both modes ${!lr.gradSharedHidden}`);
      // UI-2: buttons under the frame info; before/after is space only
      const importBtnOrder = await ev(() => {
        const b = document.getElementById("import");
        return b.parentElement.previousElementSibling?.id === "info";
      });
      report(importBtnOrder, "8e UI-2: Import/Export buttons under the frame info");
      const dis0 = await ev(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        const show = window.__np3app.state.showNeutral;
        document.body.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        return show;
      });
      report(dis0 === false, "8e before/after: space before a RAW development does not enable before");
      const hint0 = await ev(() => document.querySelector(".ba-hint")?.textContent || "");
      report(hint0.length > 0, `8e before/after: the space hint ("${hint0}")`);
      const hidden0 = await ev(() => document.getElementById("c").hidden);
      report(hidden0 === true, "8e empty state: canvas hidden until the first frame");
      const expDefault = await exportBytes();
      let c0 = null;
      try { c0 = deserialize(expDefault); } catch { /* reported below */ }
      report(c0 && c0.name === "NPF-MANUAL",
        `8e export without RAW: the default new profile${c0 ? ` (${c0.name})` : " — the file did not parse"}`);
    }

    // --- a RAW opened on the editor page (a drop anywhere on the page) ---
    await ev(() => window.__t8.dropFile("/test1/DSC_5584.NEF", "DSC_5584.NEF"));
    await page.waitForFunction(
      `window.__np3app.state.step === "edit" && window.__np3app.state.raw`
      + ` && window.__np3app.state.raw.name === "DSC_5584.NEF"`,
      { timeout: 300000, polling: 200 });
    await page.waitForFunction("!document.getElementById('c').hidden",
      { timeout: 60000, polling: 100 });

    // --- criterion 1: the pair's RAW is developed, move every slider, export with the edits ---
    // (the RAW opened by the drop above)
    {
      const got = await ev(() => {
        const A = window.__np3app, c = document.getElementById("c");
        return { name: A.state.raw.name, w: c.width, hidden: c.hidden,
                 label: document.querySelector(".ba-label").textContent };
      });
      report(got.name === "DSC_5584.NEF" && got.w > 100 && !got.hidden && got.label === "After — NP3",
        `8e scenario 1: RAW shown (${got.name}, ${got.w}px, canvas visible), caption "After — NP3"`);

      // regression "black first frame": the render from the ready handler must give the same
      // frame as a repeated renderCurrent (bug: ctxOf overwrote the srcTex binding on unit 0).
      const first = await ev(() => {
        const s0 = window.__t8.snap();
        window.__np3app.renderCurrent();
        return { s0, s1: window.__t8.snap() };
      });
      report(first.s0 === first.s1, "8e first frame is not black: the ready frame matches the repeated render");

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
        `8e scenario 1: sliders ${sliders.moved}/${sliders.total} change state,`
        + ` develop not restarted (+${sliders.develops})`);

      // export after edits: the bytes in Node equal serialize(scaled()) with the base name
      // (UI-2: strength does not affect the name, the suffix is not written into the NP3)
      const [exp1, stJson] = await Promise.all([exportBytes(),
        ev(() => ({ control: window.__np3app.state.control, strength: window.__np3app.state.strength }))]);
      const scaledCtl = scaled(JSON.parse(JSON.stringify(stJson.control)), stJson.strength);
      const expected = serialize({ ...scaledCtl, name: stJson.control.name });
      const same = exp1.length === expected.length && exp1.every((v, i) => v === expected[i]);
      report(same, `8e scenario 1: export after edits matches serialize(scaled()) (${exp1.length} bytes)`);
    }

    // --- criterion 3: editing Saturation changes the canvas and lands in the NP3; LUT cache ---
    {
      await ev(() => window.__t8.groupSlider("strength", 0, 100));   // the slider sweep left 105%
      await settle();
      const s0 = await ev(() => window.__t8.snap());
      await ev(() => window.__t8.groupSlider("basic", 0, 80));
      await settle();
      const s1 = await ev(() => window.__t8.snap());
      report(s0 !== s1, "8e controls: Saturation=80 changes the canvas");
      const expSat = await exportBytes();
      let cSat = null;
      try { cSat = deserialize(expSat); } catch { /* reported below */ }
      report(cSat && cSat.saturation === 80,
        `8e controls: Saturation=80 in the exported NP3${cSat ? ` (got ${cSat.saturation})` : ""}`);

      const lut = [await ev(() => window.__np3app.renderer.stats.luts)];
      for (const v of [50, 60, 50]) {
        await ev((vv) => window.__t8.groupSlider("basic", 0, vv), v);
        await settle();
        lut.push(await ev(() => window.__np3app.renderer.stats.luts));
      }
      report(lut[1] === lut[0] + 1 && lut[2] === lut[1] + 1 && lut[3] === lut[2],
        `8e LUT cache: a new LUT only for a new control (${lut.join("->")})`);
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
        `8e strength 150%: the frame changed, the base untouched (sat ${r5.baseSat})`);
      // UI-2: strength does not affect the name — the suffix is not added anywhere
      const nameBase = await ev(() => window.__np3app.state.control.name);
      const exp150 = await exportBytes();
      let c150 = null;
      try { c150 = deserialize(exp150); } catch { /* reported below */ }
      report(c150 && c150.name === nameBase,
        `8e strength 150%: name without a suffix (base "${nameBase}", in the NP3 "${c150 ? c150.name : "?"}")`);
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
        "8e before/after: holding space = neutral, caption \"Before — neutral\"");
      report(ba.hold.luts === ba.hold.luts0,
        `8e before/after: no LUT build while held (${ba.hold.luts0}->${ba.hold.luts})`);
      report(ba.hold.same, "8e before/after: profile and strength unchanged");
      report(ba.released.show === false && ba.released.snap === ba.after
             && ba.released.label === "After — NP3",
        "8e before/after: releasing returned the result, caption \"After — NP3\"");
      report(ba.space.show === true && ba.space.snap === ba.neutral,
        "8e before/after: holding space = neutral");
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
        `8e before/after: neutral orientation is correct (dTop ${orient.top.toFixed(4)}, frame asymmetry ${orient.asym.toFixed(4)})`);
      report(ba.spaceOff.show === false && ba.spaceOff.snap === ba.after,
        "8e before/after: releasing space returned the result");
      report(ba.spaceInInput === false, "8e before/after: space in an input does not enable before");
      report(ba.spaceOnRange === true, "8e before/after: space with focus on a slider enables before");
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
        fitted: window.__np3app.getBaseline().fitted,
        satMark: document.querySelectorAll('#panel [data-group="basic"] .ctl')[0].classList.contains("chg"),
        groupMarks: [...document.querySelectorAll("#panel details.grp.chg")].map((d) => d.dataset.group).sort(),
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
          marks: document.querySelectorAll("#panel .ctl.chg, #panel details.grp.chg, #curve-slot .ce-head.chg").length,
        };
      }, preSnap);
      report(lockedBefore.fitted === false && lockedBefore.satMark
             // the edited groups are marked; earlier scenarios (every slider moved in
             // scenario 1) may leave other groups off neutral too, so a superset is fine
             && ["basic", "curve", "grading"].every((g) => lockedBefore.groupMarks.includes(g)),
        `8e stage 6: standalone editing compares against neutral — marks on the edited fields` +
        ` (groups ${lockedBefore.groupMarks.join(",")})`);
      report(post.marks === 0, `8e stage 6: the standalone Reset (to neutral) clears every mark (${post.marks} left)`);
      report(lockedBefore.ranges === 5 && lockedBefore.numbers === 5,
        `8e Reset: before the reset the curve locks 5 tonal sliders` +
        ` (ranges ${lockedBefore.ranges}, numbers ${lockedBefore.numbers})`);
      report(post.strength === 100 && post.sat === 0 && post.sharpening === 2 && post.blending === 50
             && post.balance === 0 && post.curve === null && post.toggle === false
             && post.tonalDisabled === 0 && post.name === "MY-TEST",
        `8e Reset: neutral (strength ${post.strength}%, sat ${post.sat}, curve ` +
        `${post.curve === null ? "off" : "on"}, name kept "${post.name}")`);
      report(post.snapChanged, "8e Reset: the preview updated after the reset");
      report(post.fill === "66.7%" && post.val === "100",
        `8e fill: --fill of the strength slider ${post.fill}, value ${post.val}`);
      const fillMin = await ev(() => {
        window.__t8.groupSlider("basic", 0, -100);      // Saturation to the minimum
        const inp = document.querySelectorAll('#panel [data-group="basic"] input[type=range]')[0];
        return { fill: inp.style.getPropertyValue("--fill"), sat: window.__np3app.state.control.saturation };
      });
      report(fillMin.fill === "0.0%" && fillMin.sat === -100,
        `8e fill: at min value --fill=${fillMin.fill} (sat ${fillMin.sat})`);
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
      report(luts1 === luts0, `8e perf: name and Sharpening build no LUT (${luts0}->${luts1})`);

      // editing only tool values/tables (the same sigmas) reuses the luma and blurs
      const sk0 = await ev(() => window.__np3app.renderer.stats.detailSkips);
      await ev(() => window.__t8.groupSlider("details", 0, 5));
      await settle();
      const sk1 = await ev(() => window.__np3app.renderer.stats.detailSkips);
      report(sk1 > sk0, `8e perf: detail reuses luma/blurs (skips ${sk0}->${sk1})`);

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
        `8e perf: LUT cache ≤4 textures, eviction deletes explicitly (cache ${st1.size},` +
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
        `8e perf: no CPU readback of the neutral in the application path (total readbacks ${reads.total})`);

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
      report(dbl.sharp === 2, `8e UX: double click resets the slider (Sharpening ${dbl.sharp})`);
      const num = await ev(() => {
        const A = window.__np3app;
        const val = document.querySelectorAll('#panel [data-group="details"] .val')[0];
        val.value = "4.5";
        val.dispatchEvent(new Event("change", { bubbles: true }));
        return { sharp: A.state.control.sharpening };
      });
      report(num.sharp === 4.5, `8e UX: typing a number into the value (Sharpening ${num.sharp})`);
      const clamp = await ev(() => {
        const val = document.querySelectorAll('#panel [data-group="details"] .val')[0];
        val.value = "99";
        val.dispatchEvent(new Event("change", { bubbles: true }));
        return { sharp: window.__np3app.state.control.sharpening };
      });
      report(clamp.sharp === 9, `8e UX: input is clamped to the range (${clamp.sharp})`);
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
        "8e curve: the NP3 limitation note only at the curve, always visible");
      report(curveUi.dLen > 0 && curveUi.bins > 50 && curveUi.ceButtons === 1,
        `8e curve: neutral histogram under the curve (${curveUi.bins} nonzero bins),` +
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
      report(off.noteVisible && off.dLen > 0, "8e curve: off — the note and the histogram are in place");
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
        `8e Ctrl+Z: Contrast undone (sat ${undo1.sat}, con ${undo1.con})`);
      const undo2 = await ev(() => {
        const A = window.__np3app;
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
        return { sat: A.state.control.saturation, con: A.state.control.contrast };
      });
      report(undo2.sat === 0 && undo2.con === 0,
        `8e Ctrl+Z: Saturation undone (sat ${undo2.sat}, con ${undo2.con})`);
      const undo3 = await ev(() => {
        const A = window.__np3app;
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
        return { sat: A.state.control.saturation,
                 idx: JSON.parse(sessionStorage.getItem("np3hist")).idx };
      });
      report(undo3.sat === 0, "8e Ctrl+Z: at the start of history — no changes");
      report(histLen >= 1 && undo1.len <= 20, `8e Ctrl+Z: history in sessionStorage (≤20, was ${histLen})`);
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
        `8e RAW change: the last frame won (${race.name}, ${race.model}, ${race.w}px)`);
      report(race.hist === 1, `8e Ctrl+Z: a RAW change resets the history (${race.hist} snapshots)`);
    }

    // --- 100% zoom of the editor (spec/ui-zoom-plan.md "Profile editor"): the stretched zoom, the keys, the
    // double click, Space; the detailed layer needs a rebuilt raw.wasm and is not asserted here ---
    {
      await settle();
      const z0 = await ev(() => {
        const A = window.__np3app, c = document.getElementById("c");
        return { has: !!A.zoom, d: A.zoom?.debug(), w: c.width, h: c.height, hidden: c.hidden,
                 tip: !document.getElementById("zoomtip").hidden, zv: !document.getElementById("zv").hidden,
                 develops: A.renderer.stats.develops };
      });
      report(z0.has && z0.d.percent > 0 && z0.d.percent < 100 && z0.d.view.scale === 1 && !z0.hidden && z0.tip && !z0.zv,
        `8e zoom: fitted view at ${z0.d?.percent?.toFixed(1)}%, the readout overlay is shown, the overlay canvas is not`);
      const z1 = await ev(async () => {
        const A = window.__np3app, c = document.getElementById("c"), main = document.getElementById("view");
        const out = {};
        // Z outside the image area (not hovered, nothing focused inside it): ignored
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
        out.zIgnored = A.zoom.debug().view.scale === 1;
        // hovered: Z = 100%
        main.dispatchEvent(new MouseEvent("mouseenter"));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
        const d = A.zoom.debug();
        out.z = { scale: d.view.scale, percent: d.percent, zv: !document.getElementById("zv").hidden,
                  val: document.getElementById("zoom-val").textContent, w: c.width, h: c.height, hidden: c.hidden };
        // Z in a text field is ignored, Ctrl+Z and a Space hold still work
        const inp = document.querySelector('#panel [data-group="name"] input');
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));   // back to the fit first
        out.fitByKey = A.zoom.debug().view.scale === 1;
        inp.focus();
        inp.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
        out.zInInput = A.zoom.debug().view.scale === 1;
        inp.blur();
        main.dispatchEvent(new MouseEvent("mouseleave"));
        return out;
      });
      report(z1.zIgnored && z1.z.scale > 1 && Math.abs(z1.z.percent - 100) < 1 && z1.z.zv && z1.z.val === "100%"
             && z1.z.w === z0.w && z1.z.h === z0.h && !z1.z.hidden,
        `8e zoom: Z (hovered) zooms to 100% (${z1.z.percent?.toFixed(1)}%, readout ${z1.z.val}), ignored when not hovered; #c keeps its size`);
      report(z1.fitByKey && z1.zInInput, "8e zoom: 0 returns to the fit; Z typed into a text field is ignored");
      const z2 = await ev(() => {
        const A = window.__np3app, c = document.getElementById("c");
        const r = c.getBoundingClientRect();
        const dbl = () => c.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true,
          clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.4 }));
        dbl();
        const a = A.zoom.debug();
        // Space (before) while zoomed: the overlay stays, the neutral is shown, releasing returns the result
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        const before = { neutral: A.state.showNeutral, zv: !document.getElementById("zv").hidden };
        document.body.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
        const afterSpace = { neutral: A.state.showNeutral, zv: !document.getElementById("zv").hidden };
        dbl();
        const b = A.zoom.debug();
        return { a: { scale: a.view.scale, percent: a.percent }, before, afterSpace, b: { scale: b.view.scale }, develops: A.renderer.stats.develops };
      });
      report(z2.a.scale > 1 && Math.abs(z2.a.percent - 100) < 1 && z2.b.scale === 1,
        `8e zoom: a double click below 100% zooms to 100% at the cursor (${z2.a.percent?.toFixed(1)}%), at 100% it returns to the fit`);
      report(z2.before.neutral && z2.before.zv && !z2.afterSpace.neutral && z2.afterSpace.zv,
        "8e zoom: Space (before / after) works while zoomed and keeps the zoomed view");
      report(z2.develops === z0.develops, "8e zoom: the stretched zoom does not decode or develop again");
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
        `8e import: all fields as in deserialize, strength 100%, RAW kept (${imported.raw})`);
      const histAfterImport = await ev(() => JSON.parse(sessionStorage.getItem("np3hist")).stack.length);
      report(histAfterImport === 1, `8e Ctrl+Z: an NP3 import resets the history (${histAfterImport} snapshots)`);
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
        `8e drag-and-drop import: NP3 dropped onto the page ("${dropImported.status}")`);
      const expRt = await exportBytes();
      const sameBytes = expRt.length === goldenBytes.length
        && expRt.every((v, i) => v === goldenBytes[i]);
      report(sameBytes,
        `8e round-trip: exporting the unmodified import byte-exact (${expRt.length}/${goldenBytes.length} bytes)`);
      // edit -> export -> re-import: the values become the base at strength 100
      await ev(() => window.__t8.groupSlider("basic", 0, 55));
      const expEdit = await exportBytes();
      await page.evaluate(async (bytes) => {
        await window.__np3app.transfer.importFile(new File([new Uint8Array(bytes)], "edited.NP3"));
      }, Array.from(expEdit));
      const re = await ev(() => ({ sat: window.__np3app.state.control.saturation,
                                   strength: window.__np3app.state.strength }));
      report(re.sat === 55 && re.strength === 100,
        `8e re-import of edits: saturation ${re.sat}, strength ${re.strength}%`);
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
        `8e errors: a corrupt NP3 does not change the profile ("${err.importStatus}")`);
      report(err.rawSame && err.snapSame,
        `8e errors: a corrupt RAW keeps the frame and the profile ("${err.rawStatus}")`);
    }

    // --- the editor page (spec/ui-pages.md): no wizard parts; a JPEG gets a hint, no decode ---
    {
      const pg = await ev(() => ({
        wizard: ["start", "compare", "more", "report", "leave-confirm", "to-start", "ed-to-compare", "ed-to-more"]
          .filter((id) => document.getElementById(id)),
        imp: !!document.getElementById("import"), drop: !!document.getElementById("drop"),
        step: window.__np3app.state.step, baseline: window.__np3app.state.baseline,
      }));
      report(pg.wizard.length === 0 && pg.imp && pg.drop && pg.step === "edit" && pg.baseline === null,
        `8e page: the editor only — no Start/Compare/More/report/leave dialog (${pg.wizard.join(", ") || "none"}),` +
        " RAW drop zone and Import NP3 present, the neutral baseline");
      const raw0 = await ev(() => window.__np3app.state.raw?.name);
      await ev(() => window.__t8.dropFile("/test1/DSC_5584.jpg", "DSC_5584.JPG"));
      const j = await ev(() => ({ status: window.__np3app.state.status, raw: window.__np3app.state.raw?.name }));
      report(/fitting wizard/.test(j.status) && j.raw === raw0,
        `8e page: a dropped JPEG is not decoded, the hint points to the wizard ("${j.status}")`);
    }

    // --- share link: a profile travels in the ?np3= URL parameter ---
    {
      // the Copy link button: the clipboard is stubbed, only the URL is captured
      const shared = await page.evaluate(async () => {
        window.__link = null;
        navigator.clipboard.writeText = (s) => { window.__link = s; return Promise.resolve(); };
        document.getElementById("share").click();
        await new Promise((r) => setTimeout(r, 300));
        return { link: window.__link, status: document.getElementById("status").textContent };
      });
      const sharedBytes = new Uint8Array(await readFile(
        path.join(HERE, "golden/np3", "out__fit4__NIKON__CUSTOMPC__PICCON01.NP3")));
      const expNow = await exportBytes();
      const b64 = Buffer.from(expNow).toString("base64url");
      report(shared.link === `http://127.0.0.1:${port}/web/picture-control-editor.html?np3=${b64}`
          && shared.status.startsWith("Link copied"),
        `8e share: Copy link puts the NP3 into ?np3= ("${shared.status}")`);
      // the link opens the profile on a fresh page
      await page.goto(`http://127.0.0.1:${port}/web/picture-control-editor.html?np3=${b64}`);
      await page.waitForFunction("window.__np3app", { timeout: 120000, polling: 200 });
      await page.waitForFunction(
        `window.__np3app.state.status.startsWith("Imported from link")`,
        { timeout: 15000, polling: 100 });
      const fromLink = await page.evaluate(() => ({
        control: window.__np3app.state.control,
        search: location.search,
      }));
      report(JSON.stringify(fromLink.control) === JSON.stringify(deserialize(expNow))
          && !fromLink.search.includes("np3"),
        `8e share: ?np3= opens the profile, the parameter is consumed (${fromLink.control.name})`);
      // a corrupt parameter does not break the page
      await page.goto(`http://127.0.0.1:${port}/web/picture-control-editor.html?np3=not-base64!!`);
      await page.waitForFunction("window.__np3app", { timeout: 120000, polling: 200 });
      const badLink = await page.evaluate(() =>
        document.getElementById("status").textContent);
      report(badLink.startsWith("Link import failed"),
        `8e share: a corrupt ?np3= is rejected ("${badLink}")`);
      // the landing forwards legacy links (…/web/?np3= and index.html?np3=) to the editor page
      for (const legacy of [`/web/?np3=${b64}`, `/web/index.html?np3=${b64}#x`]) {
        await page.goto(`http://127.0.0.1:${port}${legacy}`);
        await page.waitForFunction("window.__np3app && window.__np3app.state.status.startsWith('Imported from link')",
          { timeout: 120000, polling: 200 });
        const f = await page.evaluate(() => ({ path: location.pathname, hash: location.hash,
                                               name: window.__np3app.state.control.name }));
        report(f.path === "/web/picture-control-editor.html" && f.name === deserialize(expNow).name
               && (legacy.endsWith("#x") ? f.hash === "#x" : true),
          `8e landing: ${legacy.split("?")[0]}?np3= is forwarded to the editor page (${f.path}${f.hash})`);
      }
      // the landing itself: both entry links, no models / WASM / Workers, nothing from other hosts
      {
        const lp = await browser.newPage();
        const reqs = [];
        lp.on("request", (r) => reqs.push(new URL(r.url())));
        await lp.goto(`http://127.0.0.1:${port}/web/index.html`);
        await new Promise((r) => setTimeout(r, 800));
        const links = await lp.evaluate(() => ({
          fit: document.getElementById("to-fit")?.getAttribute("href"),
          editor: document.getElementById("to-editor")?.getAttribute("href"),
        }));
        await lp.close();
        const heavy = reqs.map((u) => u.pathname)
          .filter((p) => /\/model\/|\.wasm$|worker|fit-app|editor-app|editor-core/.test(p));
        const foreign = reqs.filter((u) => u.host !== `127.0.0.1:${port}`).map((u) => u.host);
        report(links.fit === "picture-control-jpg-fit.html" && links.editor === "picture-control-editor.html"
               && heavy.length === 0 && foreign.length === 0,
          `8e landing: links to the wizard and the editor (${links.fit}, ${links.editor}), no heavy assets`
          + `, no other hosts${heavy.length || foreign.length ? " — " + [...heavy, ...foreign].join(", ") : ""}`);
      }
    }

    report(netBad.length === 0,
      `8e locality: static resources by GET only${netBad.length ? " — " + netBad.join("; ") : ""}`);
    report(pageErrors.length === 0,
      `8e page without JS errors${pageErrors.length ? " — " + pageErrors.join("; ") : ""}`);
    await page.close();
  }
}
