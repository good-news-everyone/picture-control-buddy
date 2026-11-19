// Level 8 of web/test.mjs verbatim: the end-to-end UI flow of the real page
// web/index.html in headless Firefox. This is one sequential page flow — the
// scenarios keep their order and are NOT split across pages (spec/web-tests.md).
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

export async function runLevel8({ browser, port, report, skip }) {
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
      `window.__np3app && window.__np3app.state.step === "start"`,
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
        // a real but wrong-aspect JPEG synthesised in place (a 2:1 frame vs the 3:2 RAW)
        dropWrongDim: async (name) => {
          const c = document.createElement("canvas");
          c.width = 400; c.height = 200;
          const x = c.getContext("2d");
          x.fillStyle = "#7f7f7f";
          x.fillRect(0, 0, 400, 200);
          const blob = await new Promise((r) => c.toBlob(r, "image/jpeg"));
          const dt = new DataTransfer();
          dt.items.add(new File([blob], name));
          document.getElementById("target-drop").dispatchEvent(
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
    // --- stage 1 of the full flow: the Start screen (spec/ui.md step 1) ---
    {
      const ui = await ev(() => {
        const heads = [...document.querySelectorAll("#start h2")].map((e) => e.textContent);
        const bullets = [...document.querySelectorAll("#start h2")].find((e) => e.textContent === "DISCLAIMER")
          ?.nextElementSibling;
        return {
          step: window.__np3app.state.step,
          startShown: getComputedStyle(document.getElementById("start")).display !== "none",
          editorHidden: getComputedStyle(document.getElementById("files")).display === "none"
            && getComputedStyle(document.getElementById("panel")).display === "none",
          bullets: bullets ? [...bullets.children].map((e) => e.textContent) : [],
          recs: [...document.querySelectorAll("#start h2")].find((e) => e.textContent === "Pair recommendations")
            ?.nextElementSibling?.children.length ?? 0,
          zones: !!document.getElementById("raw-drop") && !!document.getElementById("target-drop"),
          name: document.getElementById("fit-name").value,
          fitDisabled: document.getElementById("fit").disabled,
        };
      });
      report(ui.step === "start" && ui.startShown && ui.editorHidden,
        "8 Start: the Start screen is the first step, the editor is hidden");
      report(ui.bullets.length === 3 && /dE ≈ 1\.85/.test(ui.bullets[0]) && /Z f/.test(ui.bullets[1])
             && /locally/i.test(ui.bullets[2]),
        `8 Start: the DISCLAIMER stub with the three required bullets (dE 1.85 / Z f / local)`);
      report(ui.recs === 6, `8 Start: the pair recommendations (draft, ${ui.recs} items)`);
      report(ui.zones && ui.name === "" && ui.fitDisabled,
        "8 Start: separate RAW/target drop zones, an empty name, Fit disabled");
    }

    // --- pair assembly: a valid pair and the default profile name from the first RAW ---
    await ev(() => window.__t8.dropOn("#raw-drop", "/test1/DSC_5584.NEF", "DSC_5584.NEF"));
    await page.waitForFunction(
      "window.__np3app.state.pairs[0] && window.__np3app.state.pairs[0].raw"
      + " && !!window.__np3app.state.pairs[0].raw.image",
      { timeout: 300000, polling: 500 });
    {
      const p1 = await ev(() => {
        const p = window.__np3app.state.pairs[0];
        return { name: p.rawFile.name, cam: `${p.raw.info.make} ${p.raw.info.model}`, warn: p.raw.warn,
                 w: p.raw.image.w, h: p.raw.image.h,
                 defName: window.__np3app.state.profileName,
                 fitName: document.getElementById("fit-name").value,
                 card: document.querySelector('#pairs .pair[data-pair-id="1"] .pair-meta')?.textContent || "" };
      });
      report(p1.name === "DSC_5584.NEF" && p1.cam.includes("Z f") && !p1.warn
             && p1.defName === "dsc_5584" && p1.fitName === "dsc_5584",
        `8 pairs: the RAW decodes into pair 1 (${p1.cam}), the default name "${p1.defName}" (as in match.py)`);
      report(p1.card.includes(p1.cam) && p1.card.includes(`${p1.w}×${p1.h}`) && p1.card.includes("Active D-Lighting"),
        `8 pairs: the card shows the camera and the frame size (${p1.w}×${p1.h}), ADL is honestly "?"`);
    }

    // --- the stage-1 dimension guard: a wrong-aspect target is rejected atomically ---
    await ev(() => window.__t8.dropWrongDim("DSC_5584.JPG"));
    await page.waitForFunction(`window.__np3app.state.status.includes("dimensions")`,
      { timeout: 15000, polling: 100 });
    {
      const rej = await ev(() => {
        const p = window.__np3app.state.pairs[0];
        return { pairs: window.__np3app.state.pairs.length,
                 target: p.target, targetFile: p.targetFile?.name ?? null, rawOk: !!p.raw.image };
      });
      report(rej.pairs === 1 && rej.target === null && rej.targetFile === null && rej.rawOk,
        "8 pairs: a dimensionally incompatible target is rejected, the pair keeps its RAW");
    }

    // --- a valid target joins the same-name pair; the XMP warnings show as codes ---
    await ev(() => window.__t8.dropOn("#target-drop", "/web/golden/target/jpg_plain.jpg", "DSC_5584.JPG"));
    await page.waitForFunction(
      "window.__np3app.state.pairs[0].target && !!window.__np3app.state.pairs[0].target.width",
      { timeout: 30000, polling: 200 });
    {
      const p1 = await ev(() => {
        const p = window.__np3app.state.pairs[0];
        return { target: p.targetFile.name, w: p.target.width, h: p.target.height,
                 codes: p.warnings.map((w) => w.code),
                 card: document.querySelector('#pairs .pair[data-pair-id="1"]').textContent,
                 fitDisabled: document.getElementById("fit").disabled };
      });
      report(p1.target === "DSC_5584.JPG" && p1.w === 384 && p1.h === 256
             && p1.codes.includes("small_target") && p1.codes.includes("no_lr_settings"),
        `8 pairs: a valid target completes pair 1 (warnings: ${p1.codes.join(", ")})`);
      report(p1.card.includes("384×256") && !p1.fitDisabled,
        "8 pairs: the card shows the target size; Fit is enabled with a complete pair");
    }

    // --- a non-Z f RAW warns (does not block); same-name matching beats in-order ---
    await ev(() => window.__t8.dropOn("#raw-drop", "/test2/SKL_3024.dng", "SKL_3024.dng"));
    await page.waitForFunction(
      "window.__np3app.state.pairs[1] && window.__np3app.state.pairs[1].raw"
      + " && !!window.__np3app.state.pairs[1].raw.image",
      { timeout: 300000, polling: 500 });
    await ev(() => window.__t8.dropOn("#target-drop", "/web/golden/target/jpg_wb.jpg", "SKL_3024.JPG"));
    await page.waitForFunction(
      "window.__np3app.state.pairs[1].target && !!window.__np3app.state.pairs[1].target.width",
      { timeout: 30000, polling: 200 });
    {
      const p2 = await ev(() => {
        const p = window.__np3app.state.pairs[1];
        return { cam: p.raw.info.model, codes: p.warnings.map((w) => w.code),
                 gain: p.warnings.find((w) => w.code === "gain_note")?.note ?? null,
                 p1target: window.__np3app.state.pairs[0].targetFile.name };
      });
      report(p2.cam.includes("Z 8") && p2.codes.includes("camera"),
        `8 pairs: a non-Z f RAW is a warning, not a blocker (${p2.cam})`);
      report(p2.p1target === "DSC_5584.JPG" && p2.gain && p2.gain.includes("6500 K") && p2.gain.includes("exposure +0.50"),
        `8 pairs: same-name matching (the SKL target found the SKL RAW) and the edit-gain note: "${p2.gain}"`);
    }

    // --- in-order matching: an unmatched target forms a new pair ---
    await ev(() => window.__t8.dropOn("#target-drop", "/web/golden/target/jpg_masks.jpg", "nomatch.JPG"));
    await page.waitForFunction(
      "window.__np3app.state.pairs.length === 3 && window.__np3app.state.pairs[2].target"
      + " && !!window.__np3app.state.pairs[2].target.width",
      { timeout: 30000, polling: 200 });
    {
      const p3 = await ev(() => {
        const p = window.__np3app.state.pairs[2];
        return { raw: p.rawFile?.name ?? null, target: p.targetFile.name,
                 codes: p.warnings.map((w) => w.code) };
      });
      report(p3.raw === null && p3.target === "nomatch.JPG" && p3.codes.includes("masks"),
        `8 pairs: an unmatched target joins a new pair in order (warnings: ${p3.codes.join(", ")})`);
    }

    // --- a corrupt target is rejected without losing the session ---
    await ev(() => window.__t8.dropBytes("#target-drop", "corrupt.JPG", 0xAB));
    await page.waitForFunction(`window.__np3app.state.status.includes("could not be read")`,
      { timeout: 15000, polling: 100 });
    {
      const ok = await ev(() => ({ n: window.__np3app.state.pairs.length,
                                   t0: !!window.__np3app.state.pairs[0].target.width }));
      report(ok.n === 3 && ok.t0, "8 pairs: a corrupt target is rejected, the assembled session is preserved");
    }

    // --- an unreadable RAW blocks its pair only ---
    // (joins the target-only pair 3 in order — the pairing rule from the step above)
    await ev(() => window.__t8.dropBytes("#raw-drop", "broken.NEF", 0x55));
    await page.waitForFunction(
      "window.__np3app.state.pairs.length === 3 && window.__np3app.state.pairs[2].blocked === true"
      + " && !!window.__np3app.state.pairs[2].rawFile",
      { timeout: 60000, polling: 200 });
    {
      const b = await ev(() => {
        const p = window.__np3app.state.pairs[2];
        const card = document.querySelector('#pairs .pair[data-pair-id="3"]');
        return { raw: p.rawFile.name, codes: p.warnings.map((w) => w.code),
                 editDisabled: card.querySelector(".pair-edit").disabled,
                 blockedShown: !card.querySelector(".pair-blocked").hidden,
                 fitDisabled: document.getElementById("fit").disabled };
      });
      report(b.raw === "broken.NEF" && b.codes.includes("raw_error") && b.editDisabled
             && b.blockedShown && !b.fitDisabled,
        "8 pairs: an unreadable RAW blocks its pair (Edit disabled), the fit still has the good pairs");
    }

    // --- the name rule validates immediately and the Fit stub is honest ---
    {
      const bad = await ev(() => {
        const inp = document.getElementById("fit-name");
        inp.value = "THIS NAME IS FAR TOO LONG";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return { fitDisabled: document.getElementById("fit").disabled,
                 bad: inp.classList.contains("bad"), err: !document.getElementById("fit-name-err").hidden };
      });
      report(bad.fitDisabled && bad.bad && bad.err,
        "8 name: more than 19 chars is highlighted right away and blocks Fit");
      const nonAscii = await ev(() => {
        const inp = document.getElementById("fit-name");
        inp.value = "ÉTOILE";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return document.getElementById("fit").disabled;
      });
      report(nonAscii, "8 name: non-ASCII blocks Fit (the np3.serialize rule)");
      await ev(() => {
        const inp = document.getElementById("fit-name");
        inp.value = "dsc_5584";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("fit").click();
      });
      // stage 3: Fit runs the pre-fit checks first (the small golden targets are previews);
      // with every included pair blocked, nothing is fitted and no version is created
      await page.waitForFunction(
        `window.__np3app.state.status.startsWith("Nothing to fit")`,
        { timeout: 60000, polling: 200 });
      const fitMsg = await ev(() => window.__np3app.state.status);
      report(fitMsg.startsWith("Nothing to fit"),
        `8 Fit: honestly reports that nothing can fit ("${fitMsg.slice(0, 52)}…")`);
      {
        const small = await ev(() => window.__np3app.state.pairs.slice(0, 2)
          .map((p) => p.fitBlocked?.code ?? null));
        report(small.every((c) => c === "target_too_small"),
          `8 Fit: the small golden targets are pre-fit-blocked (${small.join(", ")})`);
        const noVersion = await ev(() => window.__np3app.state.versions.length);
        report(noVersion === 0, "8 Fit: a blocked run creates no versions");
      }
    }

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

    // --- Start -> the manual editor with the selected pair ---
    await ev(() => document.querySelector('#pairs .pair[data-pair-id="1"] .pair-edit').click());
    await page.waitForFunction(
      `window.__np3app.state.step === "edit" && window.__np3app.state.raw`
      + ` && window.__np3app.state.raw.name === "DSC_5584.NEF"`,
      { timeout: 60000, polling: 200 });
    await page.waitForFunction("!document.getElementById('c').hidden",
      { timeout: 60000, polling: 100 });

    // --- criterion 1: the pair's RAW is developed, move every slider, export with the edits ---
    // (entered from the Start screen above — the drop flow itself is covered by the pair assembly)
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
             && lockedBefore.groupMarks.join(",") === "basic,curve,grading",
        `8 stage 6: standalone editing compares against neutral — marks on the edited fields` +
        ` (groups ${lockedBefore.groupMarks.join(",")})`);
      report(post.marks === 0, `8 stage 6: the standalone Reset (to neutral) clears every mark (${post.marks} left)`);
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

    // --- stage-1 navigation: Start <-> the editor keeps the session and the profile ---
    {
      const before = await ev(() => ({ sat: window.__np3app.state.control.saturation,
                                       name: window.__np3app.state.control.name,
                                       pairs: window.__np3app.state.pairs.length }));
      await ev(() => document.getElementById("to-start").click());
      const st = await ev(() => ({ step: window.__np3app.state.step,
                                   startShown: getComputedStyle(document.getElementById("start")).display !== "none",
                                   editorShown: getComputedStyle(document.getElementById("files")).display !== "none",
                                   pairs: window.__np3app.state.pairs.length,
                                   cards: document.querySelectorAll("#pairs .pair").length,
                                   sat: window.__np3app.state.control.saturation }));
      report(st.step === "start" && st.startShown && !st.editorShown
             && st.pairs === before.pairs && st.cards === before.pairs && st.sat === before.sat,
        "8 navigation: Back to Start keeps the assembled session and the profile");
      await ev(() => document.querySelector('#pairs .pair[data-pair-id="1"] .pair-edit').click());
      const back = await ev(() => ({ step: window.__np3app.state.step,
                                     raw: window.__np3app.state.raw?.name,
                                     sat: window.__np3app.state.control.saturation,
                                     canvasShown: !document.getElementById("c").hidden }));
      report(back.step === "edit" && back.raw === "DSC_5584.NEF" && back.sat === before.sat && back.canvasShown,
        "8 navigation: the editor reopens the selected pair, the profile is kept");
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
      report(shared.link && shared.link.includes(`np3=${b64}`)
          && shared.status.startsWith("Link copied"),
        `8 share: Copy link puts the NP3 into ?np3= ("${shared.status}")`);
      // the link opens the profile on a fresh page
      await page.goto(`http://127.0.0.1:${port}/web/index.html?np3=${b64}`);
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
        `8 share: ?np3= opens the profile, the parameter is consumed (${fromLink.control.name})`);
      // a corrupt parameter does not break the page
      await page.goto(`http://127.0.0.1:${port}/web/index.html?np3=not-base64!!`);
      await page.waitForFunction("window.__np3app", { timeout: 120000, polling: 200 });
      const badLink = await page.evaluate(() =>
        document.getElementById("status").textContent);
      report(badLink.startsWith("Link import failed"),
        `8 share: a corrupt ?np3= is rejected ("${badLink}")`);
      // back to the working page for the remaining checks
      await page.goto(`http://127.0.0.1:${port}/web/index.html`);
      await page.waitForFunction(
        `window.__np3app && window.__np3app.state.step === "start"`,
        { timeout: 120000, polling: 200 });
    }

    // The shared-mapping and the zoom/pan assertion groups, re-runnable at a second window
    // size: the modes must produce the same image-space mapping at any viewport, so the
    // suite runs these at the 800×600 default and at 1280×800 (the wider layout with the
    // report panel beside the canvas) — see spec/web-tests.md.
    const viewAssertions = async (tag) => {
      // all three modes render through the same shared mapping
      {
        const maps = {}, sums = {};
        for (const m of ["side", "curtain", "toggle"]) {
          await ev((mm) =>
            document.querySelector(`#cmp-modes button[data-mode="${mm}"]`).click(), m);
          maps[m] = await ev(() => {
            const d = window.__np3app.compare.debug();
            const c = document.getElementById("cc");
            // the image point's offset from its own viewport's center — comparable across
            // modes (side-by-side shows the same view through two half-viewports)
            const rel = (pt, cx, cy) => ({ x: pt.x - cx, y: pt.y - cy });
            const cw = c.width, ch = c.height;
            const L = d.mapPoint(0.5, 0.5, "L"), R = d.mapPoint(0.25, 0.75, "R");
            if (d.mode === "side") {
              return { base: d.base, view: d.view,
                       L: rel(L, cw / 4, ch / 2), R: rel(R, 3 * cw / 4, ch / 2) };
            }
            return { base: d.base, view: d.view,
                     L: rel(L, cw / 2, ch / 2), R: rel(R, cw / 2, ch / 2) };
          });
          sums[m] = (await ev(() => window.__t8.snapCC())).split(":")[2];
        }
        report(Object.values(sums).every((v) => +v > 0),
          `8 compare modes [${tag}]: all three modes draw the frame (sums ${Object.values(sums).join(", ")})`);
        // the relative offsets are compared with a tolerance: mapPoint carries the large
        // viewport-center offset and back, so the raw floats can differ at the 1e-14
        // (double-rounding) level — the geometry itself must agree exactly
        const near = (a, b) => Math.abs(a - b) <= 1e-9;
        const sameMap = (a, b) =>
          near(a.base, b.base) && near(a.view.x, b.view.x) && near(a.view.y, b.view.y)
          && near(a.view.scale, b.view.scale)
          && near(a.L.x, b.L.x) && near(a.L.y, b.L.y) && near(a.R.x, b.R.x) && near(a.R.y, b.R.y);
        report(sameMap(maps.side, maps.curtain) && sameMap(maps.side, maps.toggle),
          `8 compare modes [${tag}]: side-by-side, curtain and toggle share the same zoom/pan mapping`);
        // key-toggle: hold swaps the images, release restores
        const t0 = await ev(() => window.__t8.snapCC());
        await ev(() => document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true })));
        const t1 = await ev(() => ({ snap: window.__t8.snapCC(),
                                     show: window.__np3app.compare.debug().showTarget }));
        await ev(() => document.body.dispatchEvent(
          new KeyboardEvent("keyup", { key: " ", bubbles: true })));
        const t2 = await ev(() => window.__t8.snapCC());
        report(t1.show === true && t1.snap !== t0 && t2 === t0,
          `8 key toggle [${tag}]: holding Space swaps to the target, releasing restores the render`);
      }

      // shared zoom/pan: wheel zoom to the cursor, drag pan, reset. The zoom anchor is
      // asserted on the image coordinates of the point under the cursor (exact), not
      // on the pixel color — resampling at a different scale legitimately changes the
      // color of a probe landing on a high-contrast edge. The event's clientX/Y are
      // longs (DOM) — a synthetic event's fractional coordinates are truncated, so the
      // probe listens for the coordinates the wheel handler actually received.
      {
        await ev(() => document.querySelector('#cmp-modes button[data-mode="side"]').click());
        const zoom = await ev(() => {
          const c = document.getElementById("cc");
          const r = c.getBoundingClientRect();
          const mx = Math.round(r.width * 0.3), my = Math.round(r.height * 0.4);
          let evPt = null;
          c.addEventListener("wheel", (e) => { evPt = { x: e.clientX - r.left, y: e.clientY - r.top }; },
                             { once: true });
          const state = () => {
            const d = window.__np3app.compare.debug();
            return { mode: d.mode, cw: c.width, ch: c.height, base: d.base,
                     view: { ...d.view }, working: { ...d.working } };
          };
          // the image coordinates of a canvas point under the current view
          const anchor = (v, px, py) => {
            const cx = v.mode === "side" ? (px < v.cw / 2 ? v.cw / 4 : 3 * v.cw / 4) : v.cw / 2;
            const s = v.base * v.view.scale;
            return { u: ((px - cx - v.view.x) / s + v.working.w / 2) / v.working.w,
                     vv: ((py - v.ch / 2 - v.view.y) / s + v.working.h / 2) / v.working.h };
          };
          const before = state();
          c.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, clientX: r.left + mx,
            clientY: r.top + my, bubbles: true, cancelable: true }));
          const after = state();
          const a0 = anchor(before, evPt.x, evPt.y), a1 = anchor(after, evPt.x, evPt.y);
          return { scale0: before.view.scale, scale1: after.view.scale,
                   du: Math.abs(a1.u - a0.u), dv: Math.abs(a1.vv - a0.vv) };
        });
        report(zoom.scale1 > zoom.scale0 && zoom.du < 1e-9 && zoom.dv < 1e-9,
          `8 zoom [${tag}]: the wheel zooms to the cursor (scale ${zoom.scale0} ->` +
          ` ${zoom.scale1.toFixed(3)}, the image point under the cursor stays within` +
          ` ${Math.max(zoom.du, zoom.dv).toExponential(1)})`);
        const pan = await ev(() => {
          const c = document.getElementById("cc");
          const r = c.getBoundingClientRect();
          const before = { ...window.__np3app.compare.debug().view };
          const opts = (x, y) => ({ button: 0, clientX: r.left + x, clientY: r.top + y,
                                    bubbles: true, cancelable: true });
          c.dispatchEvent(new MouseEvent("mousedown", opts(r.width * 0.5, r.height * 0.5)));
          window.dispatchEvent(new MouseEvent("mousemove", opts(r.width * 0.5 + 60, r.height * 0.5 + 30)));
          window.dispatchEvent(new MouseEvent("mouseup", opts(r.width * 0.5 + 60, r.height * 0.5 + 30)));
          return { before, after: { ...window.__np3app.compare.debug().view } };
        });
        report(pan.after.x === pan.before.x + 60 && pan.after.y === pan.before.y + 30,
          `8 pan [${tag}]: dragging pans both halves through the shared view`);
        await ev(() => document.getElementById("cmp-reset").click());
        const rst = await ev(() => window.__np3app.compare.debug().view);
        report(rst.scale === 1 && rst.x === 0 && rst.y === 0,
          `8 reset [${tag}]: the view returns to the fit`);
      }
    };

    // --- stage 2: prepare-on-Fit — pair preparation in the Worker (spec/ui-plan.md stage 2) ---
    {
      // (a fresh page after the share-link section: the drop helper is installed again)
      await ev(() => {
        window.__t8 = window.__t8 ?? {};
        window.__t8.dropOn = async (zone, path, name) => {
          const buf = await (await fetch(path)).arrayBuffer();
          const dt = new DataTransfer();
          dt.items.add(new File([buf], name));
          document.querySelector(zone).dispatchEvent(
            new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        };
      });
      // a real aligned pair (DSC_5584.NEF + its own export) and a cross pair
      // (SKL_3024 RAW against the DSC_5584 target — NCC below 0.6 blocks it)
      await ev(() => window.__t8.dropOn("#raw-drop", "/test1/DSC_5584.NEF", "DSC_5584.NEF"));
      await page.waitForFunction(
        "window.__np3app.state.pairs[0] && window.__np3app.state.pairs[0].raw"
        + " && !!window.__np3app.state.pairs[0].raw.image",
        { timeout: 300000, polling: 500 });
      await ev(() => window.__t8.dropOn("#target-drop", "/test1/DSC_5584.jpg", "DSC_5584.JPG"));
      await page.waitForFunction(
        "window.__np3app.state.pairs[0].target && !!window.__np3app.state.pairs[0].target.width",
        { timeout: 60000, polling: 200 });
      await ev(() => window.__t8.dropOn("#raw-drop", "/test2/SKL_3024.dng", "SKL_3024.dng"));
      await page.waitForFunction(
        "window.__np3app.state.pairs[1] && window.__np3app.state.pairs[1].raw"
        + " && !!window.__np3app.state.pairs[1].raw.image",
        { timeout: 300000, polling: 500 });
      await ev(() => window.__t8.dropOn("#target-drop", "/test1/DSC_5584.jpg", "SKL_3024.JPG"));
      await page.waitForFunction(
        "window.__np3app.state.pairs[1].target && !!window.__np3app.state.pairs[1].target.width",
        { timeout: 60000, polling: 200 });
      {
        const pre = await ev(() => ({ fit: document.getElementById("fit").disabled,
                                      name: document.getElementById("fit-name").value }));
        report(!pre.fit && pre.name === "dsc_5584",
          `8 prepare: two complete pairs, Fit enabled (name "${pre.name}")`);
      }

      // cancel/replace on re-drop: start preparing, then replace the target mid-flight —
      // the running task is cancelled, its result is stale and must not land on the pair
      await ev(() => document.getElementById("fit").click());
      await page.waitForFunction("window.__np3app.state.pairs[0].preparing === true",
        { timeout: 60000, polling: 100 });
      {
        const during = await ev(() => ({
          fitDisabled: document.getElementById("fit").disabled,
          card: document.querySelector('#pairs .pair[data-pair-id="1"] .pair-meta').textContent,
        }));
        report(during.fitDisabled && during.card.includes("Preparing"),
          `8 prepare: the card shows progress, Fit is locked while preparing ("${during.card.slice(0, 60)}…")`);
      }
      await ev(() => window.__t8.dropOn("#target-drop", "/test1/DSC_5584.jpg", "DSC_5584.JPG"));
      await page.waitForFunction(
        "window.__np3app.state.pairs[0].target && !!window.__np3app.state.pairs[0].target.width"
        + " && window.__np3app.state.pairs[0].prepared === null"
        + " && window.__np3app.state.pairs[0].preparing === false",
        { timeout: 60000, polling: 200 });
      {
        const cancelled = await ev(() => ({
          gen: window.__np3app.state.pairs[0].prepGen,
          card: document.querySelector('#pairs .pair[data-pair-id="1"] .pair-meta').textContent,
        }));
        report(cancelled.gen >= 1 && !cancelled.card.includes("NCC"),
          "8 prepare: a mid-flight re-drop cancels the task, no stale NCC lands on the card");
      }
      // the aborted run settles (nothing prepares against the changed input anymore)
      await page.waitForFunction("!window.__np3app.state.pairs.some((p) => p.preparing)",
        { timeout: 60000, polling: 200 });

      // prepare both pairs and fit the aligned one (stage 3): the cross pair is blocked
      // (ncc_low) — only pair 1 goes into the fit
      await ev(() => document.getElementById("fit").click());
      await page.waitForFunction(
        "window.__np3app.state.pairs[0].prepared && window.__np3app.state.pairs[1].prepared"
        + " && window.__np3app.state.fitting === true",
        { timeout: 600000, polling: 500 });
      {
        const done = await ev(() => {
          const s = window.__np3app.state;
          return {
            p1: { ncc: s.pairs[0].prepared.ncc, blocked: s.pairs[0].prepared.blocked?.code ?? null,
                  card: document.querySelector('#pairs .pair[data-pair-id="1"]').textContent,
                  incDisabled: document.querySelector('#pairs .pair[data-pair-id="1"] .pair-inc-box').disabled },
            p2: { ncc: s.pairs[1].prepared.ncc, blocked: s.pairs[1].prepared.blocked?.code ?? null,
                  card: document.querySelector('#pairs .pair[data-pair-id="2"]').textContent,
                  incDisabled: document.querySelector('#pairs .pair[data-pair-id="2"] .pair-inc-box').disabled },
            fitDisabled: document.getElementById("fit").disabled,
            fitLabel: document.getElementById("fit").textContent,
            status: document.getElementById("status").textContent,
            versions: s.versions.length,
          };
        });
        report(done.p1.ncc > 0.7 && !done.p1.blocked && done.p1.card.includes("NCC"),
          `8 prepare: the aligned pair shows NCC ${done.p1.ncc.toFixed(3)}`);
        report(done.p2.blocked === "ncc_low" && /Alignment failed/.test(done.p2.card) && done.p2.incDisabled,
          `8 prepare: the cross pair is blocked (ncc ${done.p2.ncc.toFixed(3)} < 0.60), its card shows the badge`);
        report(done.fitDisabled && done.fitLabel === "Fitting…" && /^(Fitting|Fitting:)/.test(done.status)
               && done.versions === 0,
          `8 fit: the fit runs with progress in the status line, Fit is locked ("${done.status.slice(0, 44)}…")`);
      }
      // cancel on a mid-flight re-drop: the running fit is cancelled, no version is created
      await ev(() => window.__t8.dropOn("#target-drop", "/test1/DSC_5584.jpg", "DSC_5584.JPG"));
      await page.waitForFunction(`window.__np3app.state.status.startsWith("Fit cancelled")`,
        { timeout: 60000, polling: 200 });
      {
        const cancelled = await ev(() => ({
          versions: window.__np3app.state.versions.length,
          p1prepared: window.__np3app.state.pairs[0].prepared === null,
          fitting: window.__np3app.state.fitting,
        }));
        report(cancelled.versions === 0 && cancelled.p1prepared && !cancelled.fitting,
          "8 fit: a mid-flight re-drop cancels the fit, no partial version lands");
      }
      // re-Fit (after the re-dropped target has finished decoding): pair 1 is prepared again,
      // then the free fit creates the immutable draft version
      await page.waitForFunction(
        "window.__np3app.state.pairs[0].target && !!window.__np3app.state.pairs[0].target.width",
        { timeout: 60000, polling: 200 });
      await ev(() => document.getElementById("fit").click());
      await page.waitForFunction("window.__np3app.state.versions.length === 1",
        { timeout: 600000, polling: 500 });
      {
        const draft = await ev(() => {
          const s = window.__np3app.state;
          const v = s.versions[0];
          return {
            id: v.id, kind: v.kind, parentId: v.parentId, name: v.name,
            pairIds: v.pairIds, selected: s.selectedVersionId,
            nParams: v.fitVector.length, strength: s.strength,
            iters: v.iterations.run, cost: Math.round(v.cost * 100) / 100,
            status: document.getElementById("status").textContent,
            p1kept: !!s.pairs[0].prepared, p2blocked: s.pairs[1].prepared.blocked?.code ?? null,
          };
        });
        report(draft.id === "draft" && draft.kind === "fit" && draft.parentId === null
               && draft.pairIds.length === 1 && draft.pairIds[0] === "1" && draft.selected === "draft"
               && draft.nParams === 56 && draft.strength === 100,
          `8 fit: the draft version over the exact included pair id (${draft.pairIds}), strength kept`);
        report(draft.name === "NPF-DSC_5584" && draft.status.startsWith("Fit finished")
               && draft.iters > 0 && draft.cost > 0,
          `8 fit: "${draft.name}" in ${draft.iters} iterations (cost ${draft.cost}) — "${draft.status.slice(0, 52)}…"`);
      }
      // entering the editor from the fitted pair applies the version control (the editor
      // stays the manual editor — reset-to-fitted and version history are stage 4/6)
      await ev(() => document.querySelector('#pairs .pair[data-pair-id="1"] .pair-edit').click());
      await page.waitForFunction(
        `window.__np3app.state.step === "edit" && window.__np3app.state.raw`,
        { timeout: 60000, polling: 200 });
      await page.waitForFunction("!document.getElementById('c').hidden",
        { timeout: 60000, polling: 100 });
      {
        const ed = await ev(() => {
          const A = window.__np3app;
          return {
            controlSame: JSON.stringify(A.state.control) === JSON.stringify(A.state.versions[0].control),
            strength: A.state.strength,
            shown: !document.getElementById("c").hidden,
            name: A.state.control.name,
          };
        });
        report(ed.controlSame && ed.strength === 100 && ed.shown,
          `8 fit: the editor opens the fitted pair with the draft control (${ed.name})`);
      }
      await ev(() => document.getElementById("to-start").click());
      await page.waitForFunction(`window.__np3app.state.step === "start"`,
        { timeout: 60000, polling: 200 });
      // a re-dropped preview blocks its pair (target_too_small); the prepared pair is refit,
      // the blocked one stays out of the version
      await ev(() => window.__t8.dropOn("#target-drop", "/web/golden/target/jpg_plain.jpg", "SKL_3024.JPG"));
      await page.waitForFunction(
        "window.__np3app.state.pairs[1].target && window.__np3app.state.pairs[1].target.width === 384",
        { timeout: 60000, polling: 200 });
      await ev(() => document.getElementById("fit").click());
      await page.waitForFunction(
        `window.__np3app.state.status.startsWith("Fit finished")`,
        { timeout: 600000, polling: 500 });
      {
        const small = await ev(() => ({
          code: window.__np3app.state.pairs[1].fitBlocked?.code ?? null,
          card: document.querySelector('#pairs .pair[data-pair-id="2"]').textContent,
          pairIds: window.__np3app.state.versions[0].pairIds,
        }));
        report(small.code === "target_too_small" && /too small/.test(small.card)
               && small.pairIds.length === 1 && small.pairIds[0] === "1",
          "8 fit: a re-dropped preview is excluded from the refit (target_too_small), the aligned pair stays in");
      }


      // --- stage 4: the Comparison screen and the version history (spec/ui-plan.md stage 4) ---
      {
        // Fit lands on the Comparison screen (spec/ui.md scenario); the button is the explicit path
        await ev(() => {
          if (window.__np3app.state.step !== "compare")
            document.getElementById("to-compare").click();
        });
        await page.waitForFunction(`window.__np3app.state.step === "compare"`,
          { timeout: 60000, polling: 200 });
        const cmpSettle = () => page.waitForFunction(
          "window.__np3app.compare && window.__np3app.compare.pending === false",
          { timeout: 120000, polling: 30 });
        await cmpSettle();
        // the report panel shares the window height at this viewport size — wait until
        // its content has landed (and sync the canvas) so the compare canvas geometry
        // is stable for the assertions below (a mid-test resize changes base())
        await page.waitForFunction("window.__np3app.state.pairs[0].report",
          { timeout: 120000, polling: 200 });
        await ev(() => window.__np3app.compare.draw());
        await ev(() => {
          window.__t8.snapCC = () => {
            const c = document.getElementById("cc");
            const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
            let h = 0, sum = 0;
            for (let i = 0; i < d.length; i += 4097) { h = (h * 31 + d[i]) >>> 0; sum += d[i]; }
            return `${c.width}x${c.height}:${h}:${sum}`;
          };
          window.__t8.px = (x, y) => {
            const c = document.getElementById("cc");
            const d = c.getContext("2d").getImageData(Math.round(x), Math.round(y), 1, 1).data;
            return [d[0], d[1], d[2]];
          };
        });

        // the screen, the strip with the blocked marker, the H3×W3 geometry
        {
          const ui = await ev(() => {
            const s = window.__np3app.state;
            const d = window.__np3app.compare.debug();
            return {
              compareShown: getComputedStyle(document.getElementById("compare")).display !== "none",
              editorHidden: getComputedStyle(document.getElementById("view")).display === "none",
              thumbs: [...document.querySelectorAll("#cmp-strip .cmp-th")]
                .map((t) => ({ id: t.dataset.pairId, blocked: t.classList.contains("blocked") })),
              selected: s.selectedPairId,
              versions: s.versions.length,
              vbtn: document.querySelector("#cmp-versions button")?.textContent ?? "",
              aligned: d.aligned, working: d.working,
            };
          });
          report(ui.compareShown && ui.editorHidden && ui.versions === 1 && /draft/.test(ui.vbtn),
            `8 compare: the screen shows the draft version ("${ui.vbtn.trim()}"), the editor is hidden`);
          report(ui.thumbs.length === 2 && !ui.thumbs[0].blocked && ui.thumbs[1].blocked
                 && ui.selected === 1,
            "8 compare: the pair strip with a blocked marker on the excluded pair");
          report(ui.aligned && ui.working
                 && ui.aligned.w === Math.floor(ui.working.w / 3)
                 && ui.aligned.h === Math.floor(ui.working.h / 3),
            `8 compare geometry: the render side is the H3×W3 aligned grid (${ui.aligned?.w}×${ui.aligned?.h}` +
            ` of the working ${ui.working?.w}×${ui.working?.h}) — the report pixels, upscaled for display`);
        }

        // all three modes render through the same shared mapping; the wheel zooms to the
        // cursor, a drag pans, the reset returns (also re-run at 1280×800 below)
        await viewAssertions("800×600");

        // curtain: the divider drags; its sides show the render and the target
        {
          await ev(() => document.querySelector('#cmp-modes button[data-mode="curtain"]').click());
          await ev(() => {
            const c = document.getElementById("cc");
            const r = c.getBoundingClientRect();
            const cy = r.height / 2;
            const d0 = window.__np3app.compare.debug().curtain;
            const opts = (x, y) => ({ button: 0, clientX: r.left + x, clientY: r.top + y,
                                      bubbles: true, cancelable: true });
            c.dispatchEvent(new MouseEvent("mousedown", opts(r.width * d0, cy)));
            window.dispatchEvent(new MouseEvent("mousemove", opts(r.width * 0.3, cy)));
            window.dispatchEvent(new MouseEvent("mouseup", opts(r.width * 0.3, cy)));
          });
          const cur = await ev(() => window.__np3app.compare.debug().curtain);
          report(Math.abs(cur - 0.3) < 0.02, `8 curtain: dragging the divider moves it (${cur.toFixed(3)})`);
          const sides = await ev(() => {
            const c = document.getElementById("cc");
            const r = c.getBoundingClientRect();
            const left = window.__t8.px(r.width * 0.1, r.height * 0.5);
            const right = window.__t8.px(r.width * 0.5, r.height * 0.5);
            return { left, right, w: r.width, h: r.height };
          });
          // the same screen points in the toggle mode: unheld = the render, held = the target
          await ev(() => document.querySelector('#cmp-modes button[data-mode="toggle"]').click());
          const renderPx = await ev((s) => window.__t8.px(s.w * 0.1, s.h * 0.5), sides);
          await ev(() => document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: " ", bubbles: true })));
          const targetPx = await ev((s) => window.__t8.px(s.w * 0.5, s.h * 0.5), sides);
          await ev(() => document.body.dispatchEvent(
            new KeyboardEvent("keyup", { key: " ", bubbles: true })));
          const same = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          report(same(sides.left, renderPx) <= 3 && same(sides.right, targetPx) <= 3,
            "8 curtain: left of the divider is the render, right is the target");
        }

        // a blocked pair cannot be selected
        {
          const blk = await ev(() => {
            const s = window.__np3app.state;
            const thumb = document.querySelector('#cmp-strip .cmp-th[data-pair-id="2"]');
            thumb.click();
            return { selected: s.selectedPairId, cls: thumb.className };
          });
          report(blk.selected === 1 && blk.cls.includes("blocked"),
            "8 compare: clicking a blocked pair changes nothing");
        }

        // version history: selection re-renders with the version control, the LUT cache is respected
        {
          await ev(() => {
            const s = window.__np3app.state;
            const draft = s.versions[0];
            const ctl = JSON.parse(JSON.stringify(draft.control));
            ctl.saturation = ctl.saturation >= 50 ? 0 : 100;   // unmistakably different
            s.versions.push({ id: "draft_r1", name: ctl.name, control: ctl, parentId: "draft",
                              kind: "refit", pairIds: ["1"], fitVector: draft.fitVector,
                              cost: draft.cost, iterations: draft.iterations, seed: draft.seed,
                              scores: draft.scores });
            window.__np3app.compare.refresh();
          });
          await cmpSettle();
          const draftHash = await ev(() => window.__t8.snapCC());
          const luts0 = await ev(() => window.__np3app.renderer.stats.luts);
          await ev(() =>
            document.querySelector('#cmp-versions button[data-version="draft_r1"]').click());
          await cmpSettle();
          const r1 = await ev(() => {
            const s = window.__np3app.state;
            const btn = document.querySelector('#cmp-versions button[data-version="draft_r1"]');
            return { selected: s.selectedVersionId, sat: s.control.saturation,
                     versions: s.versions.length, luts: window.__np3app.renderer.stats.luts,
                     badge: btn.textContent, active: btn.classList.contains("active") };
          });
          const r1Hash = await ev(() => window.__t8.snapCC());
          report(r1.selected === "draft_r1" && r1.sat === 100 && r1.versions === 2,
            `8 versions: selecting re-renders with the version control (sat ${r1.sat}),` +
            ` the history keeps both (immutable)`);
          report(r1.active && /refit/.test(r1.badge) && /1 pair/.test(r1.badge),
            `8 versions: the badge shows the kind and the pair count ("${r1.badge.trim()}")`);
          report(r1Hash !== draftHash, "8 versions: the canvas pixels change with the version");
          report(r1.luts === luts0 + 1,
            `8 versions: a new LUT only for a new control (${luts0} -> ${r1.luts})`);
          await ev(() =>
            document.querySelector('#cmp-versions button[data-version="draft"]').click());
          await cmpSettle();
          const back = await ev(() => window.__np3app.renderer.stats.luts);
          const draftHash2 = await ev(() => window.__t8.snapCC());
          report(back === luts0 + 1 && draftHash2 === draftHash,
            "8 versions: back to draft hits the LUT cache and reproduces the frame");
        }

        // stale protection during a version switch: only the latest generation applies
        {
          const g = await ev(() => {
            const A = window.__np3app;
            const btnR1 = document.querySelector('#cmp-versions button[data-version="draft_r1"]');
            const btnD = document.querySelector('#cmp-versions button[data-version="draft"]');
            const before = { gen: A.compare.requestedGen, applied: A.compare.appliedGen };
            const hash = window.__t8.snapCC();
            btnR1.click();                       // the request 1...
            const mid = { gen: A.compare.requestedGen, applied: A.compare.appliedGen,
                          pending: A.compare.pending, hash: window.__t8.snapCC() };
            btnD.click();                        // ...is superseded by the request 2
            return { before, mid, hash };
          });
          report(g.mid.gen === g.before.gen + 1 && g.mid.applied === g.before.applied
                 && g.mid.hash === g.hash && g.mid.pending === true,
            "8 stale: a version switch keeps the previous frame while the new one computes");
          await cmpSettle();
          const after = await ev(() => ({ gen: window.__np3app.compare.requestedGen,
                                          applied: window.__np3app.compare.appliedGen }));
          const draftHash3 = await ev(() => window.__t8.snapCC());
          report(after.gen === after.applied && draftHash3 === g.hash,
            `8 stale: only the latest generation applies (gen ${after.gen} == ${after.applied})`);
        }

        // strength: re-renders without a RAW re-decode; the panel slider follows
        {
          const st0 = await ev(() => ({ develops: window.__np3app.renderer.stats.develops,
                                        neutrals: window.__np3app.renderer.stats.neutrals }));
          const hash100 = await ev(() => window.__t8.snapCC());
          await ev(() => {
            const inp = document.getElementById("cmp-strength");
            inp.value = "150";
            inp.dispatchEvent(new Event("input", { bubbles: true }));
          });
          await cmpSettle();
          const st1 = await ev(() => ({ develops: window.__np3app.renderer.stats.develops,
                                        neutrals: window.__np3app.renderer.stats.neutrals,
                                        strength: window.__np3app.state.strength,
                                        panelVal: document.querySelector('#panel [data-group="strength"] input[type=range]').value }));
          const hash150 = await ev(() => window.__t8.snapCC());
          report(st1.strength === 150 && hash150 !== hash100
                 && st1.develops === st0.develops && st1.neutrals === st0.neutrals,
            `8 strength 150%: re-renders with no re-develop (develops ${st0.develops},` +
            ` neutrals ${st0.neutrals}); the panel slider follows (${st1.panelVal})`);
          await ev(() => {
            const inp = document.getElementById("cmp-strength");
            inp.value = "100";
            inp.dispatchEvent(new Event("input", { bubbles: true }));
          });
          await cmpSettle();
        }

        // the exits: the stage-7 stub, then the manual editor, and the session across the steps
        {
          await ev(() => document.getElementById("cmp-more").click());
          const more = await ev(() => ({ step: window.__np3app.state.step,
            shown: getComputedStyle(document.getElementById("more")).display !== "none",
            text: document.getElementById("more").textContent }));
          report(more.step === "more" && more.shown && /stage 7/i.test(more.text),
            "8 exit: Continue fitting goes to the honest stage-7 stub");
          await ev(() => document.getElementById("more-back").click());
          await page.waitForFunction(`window.__np3app.state.step === "compare"`,
            { timeout: 60000, polling: 200 });

          await ev(() => document.getElementById("cmp-manual").click());
          await page.waitForFunction(
            `window.__np3app.state.step === "edit" && !!window.__np3app.state.raw`,
            { timeout: 60000, polling: 200 });
          const ed = await ev(() => {
            const A = window.__np3app;
            const v = A.state.versions.find((x) => x.id === A.state.selectedVersionId);
            return { controlSame: JSON.stringify(A.state.control) === JSON.stringify(v.control),
                     strength: A.state.strength, raw: A.state.raw?.name,
                     shown: !document.getElementById("c").hidden };
          });
          report(ed.controlSame && ed.strength === 100 && ed.raw === "DSC_5584.NEF" && ed.shown,
            "8 exit: Looks good opens the editor with the selected version as the baseline," +
            " the strength kept");

          await ev(() => document.getElementById("to-start").click());
          const st = await ev(() => ({ step: window.__np3app.state.step,
            pairs: window.__np3app.state.pairs.length,
            versions: window.__np3app.state.versions.length,
            cmpEnabled: !document.getElementById("to-compare").disabled }));
          report(st.step === "start" && st.pairs === 2 && st.versions === 2 && st.cmpEnabled,
            "8 navigation: Back to Start keeps the pairs and the versions, Comparison is enabled");
          await ev(() => document.getElementById("to-compare").click());
          await cmpSettle();
          const back2 = await ev(() => ({ step: window.__np3app.state.step,
            selected: window.__np3app.state.selectedVersionId,
            strength: window.__np3app.state.strength,
            vbtns: document.querySelectorAll("#cmp-versions button").length,
            selectedPair: window.__np3app.state.selectedPairId }));
          report(back2.step === "compare" && back2.selected === "draft" && back2.strength === 100
                 && back2.vbtns === 2 && back2.selectedPair === 1,
            "8 navigation: Start -> Compare preserves the version, the strength and the pair");
        }

        // --- stage 6: the fitted baseline in the manual editor (spec/ui-plan.md stage 6,
        // spec/ui.md "Decisions" #2): field/group/tool/profile reset to the selected fit
        // version, the changed marks (incl. after undo), the manual report, the leave
        // warning (keep / discard) and the rebaseline on a version switch ---
        {
          await ev(() => {   // no modal dialog may ever open: record any attempt
            window.__t8.modal = 0;
            window.confirm = () => { window.__t8.modal++; return true; };
            window.alert = () => { window.__t8.modal++; };
          });
          const draftJson0 = await ev(() =>
            JSON.stringify(window.__np3app.state.versions.find((v) => v.id === "draft").control));
          // the draft's own report at 100% has landed: the reference of the manual fittedDelta
          await page.waitForFunction(
            `window.__np3app.state.pairs[0].report && window.__np3app.state.pairs[0].report.id === "draft:1"
             && window.__np3app.state.pairs[0].report.summary.strength === 100`,
            { timeout: 120000, polling: 200 });
          await ev(() => document.getElementById("cmp-manual").click());
          await page.waitForFunction(
            `window.__np3app.state.step === "edit" && !!window.__np3app.state.raw`,
            { timeout: 60000, polling: 200 });
          await settle();
          // helpers: the visible marks and the enabled reset controls in the panel
          await ev(() => {
            const A = window.__np3app;
            window.__t8.s6 = {
              marks: () => [...document.querySelectorAll("#panel .ctl.chg")].length,
              groupMarks: () => [...document.querySelectorAll("#panel details.grp.chg")]
                .map((d) => d.dataset.group),
              enabledResets: () => [...document.querySelectorAll("#panel button.grp-reset")]
                .filter((b) => !b.disabled).length,
              base: () => A.getBaseline().control,
              row: (group, idx) => document.querySelectorAll(`#panel [data-group="${group}"] .ctl`)[idx],
            };
          });
          const b0 = await ev(() => {
            const A = window.__np3app, S = window.__t8.s6;
            const bl = A.getBaseline();
            return { fitted: bl.fitted, vid: bl.versionId,
                     same: JSON.stringify(A.state.control) === JSON.stringify(bl.control),
                     marks: S.marks(), groups: S.groupMarks().length, resets: S.enabledResets(),
                     hist: A.hist.length,
                     backBtn: !document.getElementById("ed-to-compare").hidden };
          });
          report(b0.fitted && b0.vid === "draft" && b0.same && b0.marks === 0 && b0.groups === 0
                 && b0.resets === 0 && b0.hist === 1 && b0.backBtn,
            `8 stage 6: the editor's baseline is the selected version (${b0.vid}), no marks,` +
            ` group resets disabled, history restarts at the baseline`);

          // field: an edit shows the mark (row + group), the double click resets to the FITTED value
          const sat0 = await ev(() => window.__t8.s6.base().saturation);
          const satEdit = sat0 >= 50 ? sat0 - 30 : sat0 + 30;
          await ev((v) => window.__t8.groupSlider("basic", 0, v), satEdit);
          await settle();
          const f1 = await ev(() => {
            const S = window.__t8.s6;
            const row = S.row("basic", 0);
            return { chg: row.classList.contains("chg"),
                     markVisible: getComputedStyle(row.querySelector("button.mark")).visibility === "visible",
                     groups: S.groupMarks(),
                     basicReset: !document.querySelector('#panel [data-group="basic"] summary .grp-reset').disabled };
          });
          report(f1.chg && f1.markVisible && f1.groups.join(",") === "basic" && f1.basicReset,
            `8 stage 6: an edited field shows its mark and its group's (${f1.groups.join(",")})`);
          // the manual report: the edited control, deltas vs the baseline, fittedDelta (1 usable pair)
          await page.waitForFunction(
            `window.__np3app.state.pairs[0].report && window.__np3app.state.pairs[0].report.id === "draft+manual:1"`,
            { timeout: 120000, polling: 200 });
          const mr = await ev(() => {
            const r = window.__np3app.state.pairs[0].report;
            return { sat: r.parameters.base.saturation, delta: r.parameters.deltas?.saturation,
                     fd: r.summary.fittedDelta };
          });
          report(mr.sat === satEdit && mr.delta === satEdit - sat0 && typeof mr.fd === "number",
            `8 stage 6: a finished manual edit re-runs the report (draft+manual, delta ${mr.delta},` +
            ` fittedDelta ${typeof mr.fd === "number" ? mr.fd.toFixed(3) : mr.fd})`);
          const f2 = await ev(() => {
            const S = window.__t8.s6;
            S.row("basic", 0).querySelector("input[type=range]")
              .dispatchEvent(new Event("dblclick", { bubbles: true }));
            return { sat: window.__np3app.state.control.saturation, marks: S.marks(),
                     groups: S.groupMarks().length };
          });
          report(f2.sat === sat0 && f2.marks === 0 && f2.groups === 0,
            `8 stage 6: double click resets the field to the fitted value (${f2.sat}, not neutral), the mark clears`);

          // the mark itself is a keyboard-reachable button that resets its field
          const sh0 = await ev(() => window.__t8.s6.base().sharpening);
          await ev((v) => window.__t8.groupSlider("details", 0, v), sh0 >= 5 ? sh0 - 2 : sh0 + 2);
          const mk = await ev(() => {
            const btn = window.__t8.s6.row("details", 0).querySelector("button.mark");
            const focusable = btn.tabIndex >= 0 && !btn.disabled;
            btn.click();
            return { focusable, sharp: window.__np3app.state.control.sharpening,
                     marks: window.__t8.s6.marks() };
          });
          report(mk.focusable && mk.sharp === sh0 && mk.marks === 0,
            `8 stage 6: the changed mark is a focusable button resetting its field (Sharpening ${mk.sharp})`);

          // undo: an edit, then Ctrl+Z (the history API) — the value and the mark follow
          await ev((v) => window.__t8.groupSlider("basic", 0, v), satEdit);
          const un = await ev(() => {
            const A = window.__np3app, S = window.__t8.s6;
            const before = S.marks();
            A.hist.undo();
            return { before, after: S.marks(), sat: A.state.control.saturation };
          });
          report(un.before === 1 && un.after === 0 && un.sat === sat0,
            `8 stage 6: undo restores the fitted value and clears the mark (${un.before} -> ${un.after})`);

          // group reset: two Details fields at once, to the fitted values
          await ev((v) => {
            window.__t8.groupSlider("details", 0, v[0]);
            window.__t8.groupSlider("details", 2, v[1]);
          }, [sh0 >= 5 ? sh0 - 3 : sh0 + 3, -4]);
          const gr = await ev(() => {
            const A = window.__np3app, S = window.__t8.s6;
            const marked = S.marks();
            document.querySelector('#panel [data-group="details"] summary .grp-reset').click();
            const b = S.base();
            return { marked, sharp: A.state.control.sharpening === b.sharpening,
                     clarity: A.state.control.clarity === b.clarity, marks: S.marks(),
                     open: document.querySelector('#panel [data-group="details"]').open,
                     disabled: document.querySelector('#panel [data-group="details"] summary .grp-reset').disabled };
          });
          await settle();
          report(gr.marked >= 1 && gr.sharp && gr.clarity && gr.marks === 0 && gr.disabled,
            `8 stage 6: the group reset returns the Details fields to the fitted values` +
            ` (${gr.marked} marked -> 0), its control disables`);

          // the specialized tools: a Color Blender color and a Color Grading zone
          const bl = await ev(() => {
            const A = window.__np3app, S = window.__t8.s6;
            const inp = document.querySelector("#blending-slot input[type=range]");   // HSL: Red hue
            const b = S.base().blender.red[0];
            inp.value = b >= 50 ? b - 40 : b + 40;
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
            A.blendingView.selectColor("red");
            const dot = document.querySelector('#blending-slot .bl-dot[aria-label="Red"]').classList.contains("chg");
            const btn = document.querySelector("#blending-slot .bl-chead .grp-reset");
            const enabled = !btn.disabled;
            btn.click();
            return { dot, enabled, back: A.state.control.blender.red[0] === b,
                     dotAfter: document.querySelector('#blending-slot .bl-dot[aria-label="Red"]').classList.contains("chg") };
          });
          report(bl.dot && bl.enabled && bl.back && !bl.dotAfter,
            "8 stage 6: Color Blender — the color dot carries the mark, Reset color returns the color to the fitted values");
          const gz = await ev(() => {
            const A = window.__np3app, S = window.__t8.s6;
            A.gradingView.selectZone("shadows");
            const inp = document.querySelector("#grading-hsl input[type=range]");    // Shadows hue
            const b = S.base().grade.shadows[0];
            inp.value = (b + 90) % 360;
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
            const zoneBtn = document.querySelector("#grading-slot .gr-adjust button.chg");
            const btn = document.querySelector("#grading-slot .gr-zreset .grp-reset");
            const enabled = !btn.disabled;
            btn.click();
            return { zone: zoneBtn?.textContent ?? null, enabled,
                     back: A.state.control.grade.shadows[0] === b,
                     after: document.querySelectorAll("#grading-slot .gr-adjust button.chg").length };
          });
          await settle();
          report(gz.zone === "Shadows" && gz.enabled && gz.back && gz.after === 0,
            "8 stage 6: Color Grading — the zone button carries the mark, Reset zone returns the zone to the fitted values");

          // the curve tool: one mark for the whole curve, the mark resets it to the baseline
          const cv = await ev(() => {
            const A = window.__np3app;
            const cj = (c) => (c ? JSON.stringify([c.points, Array.from(c.raw)]) : "null");
            const baseCurve = cj(A.getBaseline().control.curve);
            if (!A.state.control.curve) {
              const tg = document.querySelector('#panel [data-group="curve"] input[type="checkbox"]');
              tg.checked = true;
              tg.dispatchEvent(new Event("change", { bubbles: true }));
            }
            // move the first point (an endpoint: y only) with the keyboard — works for any
            // point count (a fitted curve may already hold the 20-point maximum)
            const pt = document.querySelector("#curve-slot .ce-pt");
            const y0 = A.state.control.curve.points[0][1];
            const key = y0 < 200 ? "ArrowUp" : "ArrowDown";
            pt.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true }));
            pt.dispatchEvent(new KeyboardEvent("keyup", { key, shiftKey: true, bubbles: true }));
            const head = document.querySelector("#curve-slot .ce-head");
            const marked = head.classList.contains("chg");
            const grp = document.querySelector('#panel [data-group="curve"]').classList.contains("chg");
            head.querySelector("button.mark").click();
            return { marked, grp, back: cj(A.state.control.curve) === baseCurve,
                     after: head.classList.contains("chg") };
          });
          await settle();
          report(cv.marked && cv.grp && cv.back && !cv.after,
            "8 stage 6: the curve tool has one mark; it resets the curve to the fitted curve");

          // the whole profile: Reset returns every field to the version, keeps the session strength
          await ev((v) => {
            window.__t8.groupSlider("basic", 0, v);
            window.__t8.groupSlider("details", 1, -3);
            window.__t8.groupSlider("strength", 0, 80);
          }, satEdit);
          await settle();
          const all = await ev(() => {
            const A = window.__np3app, S = window.__t8.s6;
            const marked = S.marks();
            document.getElementById("p-reset").click();
            const strip = (c) => { const o = JSON.parse(JSON.stringify(c)); delete o.name; delete o.comment; return JSON.stringify(o); };
            return { marked, same: strip(A.state.control) === strip(S.base()),
                     strength: A.state.strength, marks: S.marks(), groups: S.groupMarks().length };
          });
          await settle();
          report(all.marked >= 2 && all.same && all.strength === 80 && all.marks === 0 && all.groups === 0,
            `8 stage 6: Reset returns the whole profile to the fitted version (strength kept at ${all.strength}%)`);
          await ev(() => window.__t8.groupSlider("strength", 0, 100));
          await settle();

          // the leave warning: an edit, then Back to Comparison -> the in-page dialog; Keep stays
          await ev((v) => window.__t8.groupSlider("basic", 0, v), satEdit);
          const lk = await ev(() => {
            const A = window.__np3app;
            document.getElementById("ed-to-compare").click();
            const shown = !document.getElementById("leave-confirm").hidden;
            const role = document.getElementById("leave-confirm").getAttribute("role");
            const stepDuring = A.state.step;
            document.getElementById("leave-keep").click();
            return { shown, role, stepDuring, hidden: document.getElementById("leave-confirm").hidden,
                     step: A.state.step, sat: A.state.control.saturation };
          });
          report(lk.shown && lk.role === "alertdialog" && lk.stepDuring === "edit" && lk.hidden
                 && lk.step === "edit" && lk.sat === satEdit,
            "8 stage 6: leaving with manual edits shows an in-page warning; Keep editing stays with the edits");
          // Discard: back to Start, the control returns to the version, the version is untouched
          const ld = await ev((json0) => {
            const A = window.__np3app;
            document.getElementById("to-start").click();
            const shown = !document.getElementById("leave-confirm").hidden;
            document.getElementById("leave-discard").click();
            const v = A.state.versions.find((x) => x.id === "draft");
            return { shown, step: A.state.step,
                     controlIsVersion: JSON.stringify(A.state.control) === JSON.stringify(v.control),
                     versionSame: JSON.stringify(v.control) === json0,
                     modal: window.__t8.modal };
          }, draftJson0);
          report(ld.shown && ld.step === "start" && ld.controlIsVersion && ld.versionSame && ld.modal === 0,
            "8 stage 6: Discard edits leaves, drops the manual edits, the version stays unchanged" +
            " (no window.confirm/alert)");
          // without edits the editor leaves immediately
          await ev(() => document.getElementById("to-compare").click());
          await cmpSettle();
          await ev(() => document.getElementById("cmp-manual").click());
          await page.waitForFunction(`window.__np3app.state.step === "edit"`,
            { timeout: 60000, polling: 200 });
          const clean = await ev(() => {
            document.getElementById("ed-to-compare").click();
            return { step: window.__np3app.state.step,
                     hidden: document.getElementById("leave-confirm").hidden };
          });
          await cmpSettle();
          report(clean.step === "compare" && clean.hidden,
            "8 stage 6: without manual edits the editor leaves at once (no warning)");

          // a version switch rebaselines: draft_r1 -> its control, its marks, a fresh history
          await ev(() =>
            document.querySelector('#cmp-versions button[data-version="draft_r1"]').click());
          await cmpSettle();
          await ev(() => document.getElementById("cmp-manual").click());
          await page.waitForFunction(`window.__np3app.state.step === "edit"`,
            { timeout: 60000, polling: 200 });
          await settle();
          const rb = await ev(() => {
            const A = window.__np3app, S = window.__t8.s6;
            const r1 = A.state.versions.find((x) => x.id === "draft_r1");
            const bl = A.getBaseline();
            const r1sat = r1.control.saturation;
            window.__t8.groupSlider("basic", 0, r1sat >= 50 ? r1sat - 10 : r1sat + 10);
            const marked = S.marks();
            S.row("basic", 0).querySelector("input[type=range]")
              .dispatchEvent(new Event("dblclick", { bubbles: true }));
            return { vid: bl.versionId,
                     same: JSON.stringify(bl.control) === JSON.stringify(r1.control),
                     marked, sat: A.state.control.saturation, r1sat, marks: S.marks() };
          });
          report(rb.vid === "draft_r1" && rb.same && rb.marked === 1 && rb.sat === rb.r1sat && rb.marks === 0,
            `8 stage 6: a version switch rebaselines the editor (reset to draft_r1's ${rb.r1sat})`);
          // back to Compare on the draft for the report checks below
          await ev(() => document.getElementById("ed-to-compare").click());
          await page.waitForFunction(`window.__np3app.state.step === "compare"`,
            { timeout: 60000, polling: 200 });
          await ev(() =>
            document.querySelector('#cmp-versions button[data-version="draft"]').click());
          await cmpSettle();
        }
      }
    }

    // --- stage 5B: the report panel (spec/ui.md "Report", spec/web-schemas.md §4.3/§4.4) ---
    {
      // the report of the current state (draft, strength 100) lands on the session
      await page.waitForFunction(
        `window.__np3app.state.pairs[0].report && window.__np3app.state.pairs[0].report.id === "draft:1"
         && window.__np3app.state.pairs[0].report.summary.strength === 100`,
        { timeout: 120000, polling: 200 });

      // summary: the numbers of the worker DTO, fittedDelta hidden at the draft
      {
        const s = await ev(() => {
          const rep = window.__np3app.state.pairs[0].report;
          const txt = (id) => document.getElementById(id)?.textContent ?? null;
          return { renderDE: rep.summary.renderDE, neutralDE: rep.summary.neutralDE,
                   binMean: rep.summary.binMean,
                   ui: { strength: txt("rep-strength"), renderDE: txt("rep-render-de"),
                         neutralDE: txt("rep-neutral-de"), binMean: txt("rep-bin-mean"),
                         deltaHidden: document.getElementById("rep-delta")?.hidden ?? null,
                         deltaDtHidden: document.getElementById("rep-delta-dt")?.hidden ?? null } };
        });
        report(s.ui.strength === "100%" && s.ui.renderDE === s.renderDE.toFixed(2)
               && s.ui.neutralDE === s.neutralDE.toFixed(2) && s.ui.binMean === s.binMean.toFixed(2)
               && s.ui.deltaHidden === true && s.ui.deltaDtHidden === true,
          `8 report: the summary shows the worker DTO numbers (dE ${s.ui.renderDE}),` +
          " fittedDelta hidden at the draft");
      }

      // the color-match table: rows, swatches, sorting by every column
      {
        const tb = await ev(() => {
          const rep = window.__np3app.state.pairs[0].report;
          const rows = [...document.querySelectorAll("#rep-table tbody tr")].map((tr) => ({
            group: tr.cells[0].textContent,
            share: tr.cells[1].textContent,
            dE: tr.cells[4].textContent,
            dhCell: tr.cells[7].textContent,
            swatches: tr.querySelectorAll(".rep-sw").length,
          }));
          const top = [...rep.table].sort((a, b) => b.share - a.share)[0];
          const topDh = rep.table.find((r) => r.dh == null);
          return { rows, n: rows.length, want: rep.table.length,
                   topGroup: top.group,
                   topShare: (100 * top.share).toFixed(1) + "%",
                   topDE: top.dE.toFixed(2),
                   dhNullShown: topDh ? "—" : null,
                   headers: [...document.querySelectorAll("#rep-table th")].map((th) => th.dataset.key) };
        });
        report(tb.n === tb.want && tb.rows[0].group === tb.topGroup && tb.rows[0].share === tb.topShare
               && tb.rows[0].dE === tb.topDE && tb.rows.every((r) => r.swatches === 2)
               && tb.rows.every((r) => r.dhCell.length > 0),
          `8 report: the table renders ${tb.n} group rows (default sort: share) with two swatches each`);
        const st = await ev(() => {
          const read = () => [...document.querySelectorAll("#rep-table tbody tr")].map((tr) => tr.cells[4].textContent);
          document.querySelector('#rep-table th[data-key="dE"]').click();   // a new numeric column: desc first
          const first = read();
          document.querySelector('#rep-table th[data-key="dE"]').click();   // the second click reverses
          const second = read();
          document.querySelector('#rep-table th[data-key="group"]').click();
          const byGroup = [...document.querySelectorAll("#rep-table tbody tr")].map((tr) => tr.cells[0].textContent);
          return { first, second, byGroup };
        });
        const nums = (a) => a.map(Number);
        const okNums = JSON.stringify(nums(st.first)) === JSON.stringify([...nums(st.first)].sort((a, b) => b - a))
          && JSON.stringify(nums(st.second)) === JSON.stringify([...nums(st.second)].sort((a, b) => a - b));
        const okStr = JSON.stringify(st.byGroup) === JSON.stringify([...st.byGroup].sort());
        report(okNums && okStr,
          "8 report: clicking a header sorts the table (numbers desc/asc, strings A-Z)");
      }

      // a row click highlights the group's pixels on the compare image; a second click
      // or another row clears it (the stage-4 geometry: one report pixel = a 3×3 block).
      // The overlay is a 0.45-alpha white — the expected blend of the sampled pixel is
      // computed, so the assertion holds whatever the underlying color is.
      {
        await ev(() => document.querySelector('#cmp-modes button[data-mode="side"]').click());
        const hl = await ev(() => {
          const A = window.__np3app;
          const rep = A.state.pairs[0].report;
          const GROUPS = ["greys", "skin", "warm saturated", "warm muted", "yellows", "greens",
                          "teal/water", "sky", "dark blues", "purple"];
          const top = [...rep.table].sort((a, b) => b.share - a.share)[0];
          const g = GROUPS.indexOf(top.group);
          // the group's darkest on-screen pixel (a fixed probe count keeps it quick)
          const W = A.state.pairs[0].prepared.size.w, H = A.state.pairs[0].prepared.size.h;
          let idx = -1, bestSum = Infinity, checked = 0;
          for (let i = 0; i < rep.labels.length && checked < 60; i++) {
            if (rep.labels[i] !== g) continue;
            checked++;
            const pt = A.compare.debug().mapPoint(((i % rep.w3) * 3 + 1.5) / W,
                                                  (Math.floor(i / rep.w3) * 3 + 1.5) / H, "L");
            const c = window.__t8.px(pt.x, pt.y);
            const ssum = c[0] + c[1] + c[2];
            if (ssum < bestSum) { bestSum = ssum; idx = i; }
          }
          const pt = A.compare.debug().mapPoint(((idx % rep.w3) * 3 + 1.5) / W,
                                                (Math.floor(idx / rep.w3) * 3 + 1.5) / H, "L");
          const row = [...document.querySelectorAll("#rep-table tbody tr")]
            .find((tr) => tr.cells[0].textContent === top.group);
          const before = window.__t8.px(pt.x, pt.y);
          row.click();
          const on = window.__t8.px(pt.x, pt.y);
          row.click();
          const off = window.__t8.px(pt.x, pt.y);
          row.click();
          const on2 = window.__t8.px(pt.x, pt.y);
          const other = [...document.querySelectorAll("#rep-table tbody tr")].find((tr) => tr !== row);
          other.click();
          const otherOn = window.__t8.px(pt.x, pt.y);
          return { before, on, off, on2, otherOn,
                   expect: 0.45 * (3 * 230 - bestSum) };
        });
        const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        report(Math.abs(dist(hl.before, hl.on) - hl.expect) <= 4
               && JSON.stringify(hl.off) === JSON.stringify(hl.before)
               && Math.abs(dist(hl.before, hl.on2) - hl.expect) <= 4
               && JSON.stringify(hl.otherOn) === JSON.stringify(hl.before),
          "8 report: a row click highlights the region on the image (a second click or another row clears)");
      }

      // the error map: the H3×W3 grid, the dE legend, the dL/dC/dh diverging switch
      {
        const mp = await ev(() => {
          const rep = window.__np3app.state.pairs[0].report;
          const c = document.getElementById("rep-map");
          return { w: c.width, h: c.height, w3: rep.w3, h3: rep.h3,
                   legend: document.getElementById("rep-legend-ticks").textContent,
                   modes: [...document.querySelectorAll("#rep-map-modes button")].map((b) => b.dataset.mode) };
        });
        report(mp.w === mp.w3 && mp.h === mp.h3
               && /0/.test(mp.legend) && /2/.test(mp.legend) && /5/.test(mp.legend) && /10\+/.test(mp.legend)
               && JSON.stringify(mp.modes) === JSON.stringify(["dE", "dL", "dC", "dh"]),
          `8 report: the error map at H3×W3 (${mp.w}×${mp.h}) with the dE legend 0/2/5/10+ and the dE/dL/dC/dh switch`);
        const dv = await ev(() => {
          const px = () => {
            const c = document.getElementById("rep-map");
            return c.getContext("2d").getImageData(0, 0, Math.min(8, c.width), Math.min(8, c.height)).data.join();
          };
          const before = px();
          document.querySelector('#rep-map-modes button[data-mode="dL"]').click();
          return { changed: before !== px(),
                   legend: document.getElementById("rep-legend-ticks").textContent };
        });
        report(dv.changed && /−20/.test(dv.legend) && /0/.test(dv.legend) && /\+20/.test(dv.legend),
          `8 report: the dL mode switches to the diverging scale (legend "${dv.legend}")`);
        const ov = await ev(() => {
          const before = window.__t8.snapCC();
          const chk = document.getElementById("rep-overlay");
          chk.checked = true;
          chk.dispatchEvent(new Event("change", { bubbles: true }));
          const on = window.__t8.snapCC();
          chk.checked = false;
          chk.dispatchEvent(new Event("change", { bubbles: true }));
          return { before, on, off: window.__t8.snapCC() };
        });
        report(ov.on !== ov.before && ov.off === ov.before,
          "8 report: the map overlays the compare image on demand and restores");
      }

      // the separate neutral colors: overexposed / unaligned / outside-reportMask
      {
        const craft = await ev(() => {
          const A = window.__np3app;
          const p = A.state.pairs[0];
          const rep = p.report;
          document.querySelector('#rep-map-modes button[data-mode="dE"]').click();
          const n = rep.w3 * rep.h3;
          const mk = (v, nan = []) => {
            const a = new Float32Array(n).fill(v);
            for (const i of nan) a[i] = NaN;
            return a;
          };
          const iClip = 1, iInv = 3, iVal = 5, iNaN = 7;
          const masks = p.prepared.masks;
          const saved = { clip: masks.clipMask, valid: masks.validMask, report: masks.reportMask };
          const clip = saved.clip.slice(), valid = saved.valid.slice(), rm = saved.report.slice();
          clip[iClip] = 1; valid[iClip] = 1; clip[iInv] = 0; valid[iInv] = 0;
          valid[iVal] = 1; clip[iVal] = 0; rm[iVal] = 1;
          valid[iNaN] = 1; clip[iNaN] = 0; rm[iNaN] = 0;
          masks.clipMask = clip; masks.validMask = valid; masks.reportMask = rm;
          const orig = p.report;
          p.report = { ...rep, maps: { dE: mk(5, [iNaN]), dL: mk(0), dC: mk(0), dh: mk(0), mode: "dE" } };
          A.report.refresh();
          const ctx = document.getElementById("rep-map").getContext("2d");
          const px = (i) => [...ctx.getImageData(i % rep.w3, Math.floor(i / rep.w3), 1, 1).data];
          const out = { clip: px(iClip).slice(0, 3), inv: px(iInv).slice(0, 3),
                        val: px(iVal), nan: px(iNaN) };
          masks.clipMask = saved.clip; masks.validMask = saved.valid; masks.reportMask = saved.report;
          p.report = orig;
          A.report.refresh();
          return out;
        });
        report(JSON.stringify(craft.clip) === JSON.stringify([154, 154, 154])
               && JSON.stringify(craft.inv) === JSON.stringify([58, 58, 58])
               && JSON.stringify(craft.val.slice(0, 3)) === JSON.stringify([248, 214, 92])
               && craft.val[3] === 255 && craft.nan[3] === 0,
          "8 report: overexposed/unaligned pixels get separate neutral colors, outside-reportMask stays transparent");
      }

      // the NP3 parameters: two columns, zero muting, the curve thumbnail, clipping at 150%
      {
        const pr = await ev(() => {
          const rep = window.__np3app.state.pairs[0].report;
          const rows = [...document.querySelectorAll("#rep-params .rep-prow[data-path]")];
          const byPath = Object.fromEntries(rows.map((r) => [r.dataset.path, r]));
          const row = byPath["saturation"];
          return { baseSat: rep.parameters.base.saturation, resultSat: rep.parameters.result.saturation,
                   satBase: row?.children[1]?.textContent, satResult: row?.children[2]?.textContent,
                   nRows: rows.length, zeroRows: rows.filter((r) => r.classList.contains("zero")).length,
                   curve: !!document.querySelector("#rep-curve svg polyline"),
                   resultHead: document.getElementById("rep-result-h")?.textContent ?? "" };
        });
        report(pr.satBase === String(pr.baseSat) && pr.satResult === String(pr.resultSat)
               && pr.nRows === 6 + 3 + 24 + 11 && pr.zeroRows > 0 && pr.curve
               && pr.resultHead.includes("100"),
          `8 report: the parameters — two columns over ${pr.nRows} fields, zero muting (${pr.zeroRows}),` +
          " the curve thumbnail");
        const cl = await ev(async () => {
          const A = window.__np3app;
          const p = A.state.pairs[0];
          const rep = p.report;
          const { scaled } = await import("./lib/strength.js");
          const base = JSON.parse(JSON.stringify(rep.parameters.base));
          base.saturation = 80;
          const result = scaled(JSON.parse(JSON.stringify(base)), 150);
          result.name = base.name;
          const orig = p.report;
          p.report = { ...rep, strength: 150,
                       summary: { ...rep.summary, strength: 150 },
                       parameters: { base, result, deltas: null } };
          A.report.refresh();
          const row = document.querySelector('#rep-params .rep-prow[data-path="saturation"]');
          const out = { base: row.children[1].textContent, result: row.children[2].textContent,
                        clip: row.classList.contains("clip"),
                        head: document.getElementById("rep-result-h").textContent,
                        summaryStrength: document.getElementById("rep-strength").textContent };
          p.report = orig;
          A.report.refresh();
          return out;
        });
        report(cl.base === "80" && cl.result === "100" && cl.clip && cl.head.includes("150")
               && cl.summaryStrength === "150%",
          `8 report: at strength 150% a clipped field is highlighted (${cl.base} -> ${cl.result})`);
      }

      // the §4.4 JSON download: versioned, file names, summary/table/parameters, no maps
      {
        await page.evaluate(() => {
          window.__exp = [];
          const orig = URL.createObjectURL.bind(URL);
          URL.createObjectURL = (blob) => {
            blob.arrayBuffer().then((b) => window.__exp.push(new Uint8Array(b)));
            return orig(blob);
          };
          document.getElementById("rep-download").click();
        });
        await page.waitForFunction("window.__exp.length > 0", { timeout: 15000 });
        const doc = JSON.parse(Buffer.from(await page.evaluate(() => Array.from(window.__exp.at(-1)))).toString("utf8"));
        const ref = await ev(() => {
          const r = window.__np3app.state.pairs[0].report;
          return { renderDE: r.summary.renderDE, n: r.table.length, name: r.parameters.base.name,
                   strength: r.strength };
        });
        report(doc.schemaVersion === 1 && doc.kind === "report"
               && doc.files.raw === "DSC_5584.NEF" && doc.files.target === "DSC_5584.JPG"
               && doc.version.name === ref.name && doc.version.strength === ref.strength
               && doc.version.id === "draft"
               && Math.abs(doc.summary.renderDE - ref.renderDE) < 1e-9
               && doc.table.length === ref.n && doc.table[0].group
               && doc.parameters.base.name === ref.name && !("maps" in doc)
               && doc.aggregate && typeof doc.aggregate.all === "number",
          "8 report: the download is the §4.4 document (versioned, file names, summary/table/parameters, no maps)");
      }

      // the aggregate switch: hidden with one reported pair; totals over two pairs
      {
        const one = await ev(() => document.getElementById("rep-scope").hidden);
        report(one === true, "8 report: the aggregate switch is hidden with a single reported pair");
        const agg = await ev(() => {
          const A = window.__np3app;
          const s = A.state;
          const p1 = s.pairs[0], p2 = s.pairs[1];
          const rep = p1.report;
          const fake2 = { ...rep, pair: "2", id: "draft:2",
            files: { raw: "SKL_3024.dng", target: "SKL_3024.JPG" },
            labels: rep.labels.slice(),
            maps: { dE: rep.maps.dE.slice(), dL: rep.maps.dL.slice(),
                    dC: rep.maps.dC.slice(), dh: rep.maps.dh.slice(), mode: "dE" },
            summary: { ...rep.summary }, table: rep.table, parameters: rep.parameters };
          const saved = { prepared: p2.prepared, fitBlocked: p2.fitBlocked,
                          report: p2.report, agg: s.reportAggregate };
          // pair 2 has no preparation at this point (its target is the small preview) —
          // borrow pair 1's prepared record so the pair counts as reportable
          p2.prepared = p1.prepared;
          p2.fitBlocked = null;
          p2.report = fake2;
          const rs = rep.regionSums;
          const aggSums = { all: rs.all * 1.5 };
          for (const k of ["n", "de", "dL", "dC", "dh", "nh", "bn", "bde", "tLabSum", "pLabSum"])
            aggSums[k] = Float64Array.from(rs[k], (v) => v * 1.5);
          s.reportAggregate = { regionSums: aggSums, binMean: rep.summary.binMean * 1.5,
                                table: rep.table };
          A.report.refresh();
          const tgl = document.getElementById("rep-scope");
          const out = { shown: !tgl.hidden, buttons: tgl.querySelectorAll("button").length };
          document.querySelector('#rep-scope button[data-scope="aggregate"]').click();
          out.renderDE = document.getElementById("rep-render-de").textContent;
          out.binMean = document.getElementById("rep-bin-mean").textContent;
          out.rows = document.querySelectorAll("#rep-table tbody tr").length;
          out.mapHidden = document.getElementById("rep-map-section").hidden;
          document.querySelector('#rep-scope button[data-scope="pair"]').click();
          out.pairDE = document.getElementById("rep-render-de").textContent;
          p2.prepared = saved.prepared;
          p2.fitBlocked = saved.fitBlocked; p2.report = saved.report;
          s.reportAggregate = saved.agg;
          A.report.refresh();
          return { ...out, wantDE: (rs.all * 1.5).toFixed(2), wantBin: (rep.summary.binMean * 1.5).toFixed(2),
                   wantRows: rep.table.length, pairDE: rs.all.toFixed(2) };
        });
        report(agg.shown && agg.buttons === 2 && agg.renderDE === agg.wantDE
               && agg.binMean === agg.wantBin && agg.rows === agg.wantRows && agg.mapHidden === true,
          "8 report: the aggregate switch — the totals over all reported pairs (the map stays per-pair)");
        // back to the pair scope: the selected pair's numbers again
        const back = await ev(() => document.getElementById("rep-render-de").textContent);
        const want = await ev(() => window.__np3app.state.pairs[0].report.summary.renderDE.toFixed(2));
        report(back === want, "8 report: back to \"This pair\" — the pair's summary returns");
      }

      // the report follows the version; a stale report never overwrites a newer one
      {
        await ev(() => document.querySelector('#cmp-versions button[data-version="draft_r1"]').click());
        await page.waitForFunction(
          `window.__np3app.state.pairs[0].report && window.__np3app.state.pairs[0].report.id === "draft_r1:1"`,
          { timeout: 120000, polling: 200 });
        const v = await ev(() => {
          const rep = window.__np3app.state.pairs[0].report;
          const row = document.querySelector('#rep-params .rep-prow[data-path="saturation"]');
          return { sat: rep.parameters.base.saturation, cell: row?.children[1]?.textContent,
                   renderDE: document.getElementById("rep-render-de").textContent,
                   wantDE: rep.summary.renderDE.toFixed(2) };
        });
        report(v.sat === 100 && v.cell === "100" && v.renderDE === v.wantDE,
          "8 report: switching the version re-renders the parameters and the summary");
        // stale protection: rapid switches end on draft — only the latest report applies
        await ev(() => {
          const bR1 = document.querySelector('#cmp-versions button[data-version="draft_r1"]');
          const bD = document.querySelector('#cmp-versions button[data-version="draft"]');
          bR1.click(); bD.click(); bR1.click(); bD.click();
        });
        await page.waitForFunction(
          `window.__np3app.state.pairs[0].report && window.__np3app.state.pairs[0].report.id === "draft:1"`,
          { timeout: 120000, polling: 200 });
        const st2 = await ev(() => {
          const rep = window.__np3app.state.pairs[0].report;
          const draftSat = window.__np3app.state.versions.find((x) => x.id === "draft").control.saturation;
          return { id: rep.id,
                   sat: document.querySelector('#rep-params .rep-prow[data-path="saturation"]')?.children[1]?.textContent,
                   draftSat: String(draftSat) };
        });
        report(st2.id === "draft:1" && st2.sat === st2.draftSat,
          "8 report: stale protection — after rapid version switches the shown report is the latest one");
      }

      // a strength change recomputes the report; while it computes the previous one
      // stays with a subtle "updating…" state (the reduced-preview lifecycle)
      {
        const mid = await ev(async () => {
          const inp = document.getElementById("cmp-strength");
          inp.value = "75";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 60));   // the request is posted (async model fetch)
          return { badge: document.getElementById("rep-updating").hidden,
                   dimmed: document.getElementById("rep-body").classList.contains("updating"),
                   strengthCell: document.getElementById("rep-strength").textContent };
        });
        report(mid.badge === false && mid.dimmed && mid.strengthCell === "100%",
          "8 report: while a slider drags the previous report stays with an \"updating…\" state");
        await page.waitForFunction(
          `window.__np3app.state.pairs[0].report && window.__np3app.state.pairs[0].report.summary.strength === 75`,
          { timeout: 120000, polling: 200 });
        const s75 = await ev(() => {
          const rep = window.__np3app.state.pairs[0].report;
          return { cell: document.getElementById("rep-strength").textContent,
                   badge: document.getElementById("rep-updating").hidden,
                   resultSat: document.querySelector('#rep-params .rep-prow[data-path="saturation"]')?.children[2]?.textContent,
                   wantSat: String(rep.parameters.result.saturation) };
        });
        report(s75.cell === "75%" && s75.badge === true && s75.resultSat === s75.wantSat,
          "8 report: on release the final report lands (strength 75%, the result column, the badge clears)");
        await ev(() => {
          const inp = document.getElementById("cmp-strength");
          inp.value = "100";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForFunction(
          `window.__np3app.state.pairs[0].report && window.__np3app.state.pairs[0].report.summary.strength === 100`,
          { timeout: 120000, polling: 200 });
      }

      // step 3.1: the same report component shows beside the manual editor
      {
        await ev(() => document.getElementById("cmp-manual").click());
        await page.waitForFunction(`window.__np3app.state.step === "edit"`,
          { timeout: 60000, polling: 200 });
        const ed = await ev(() => ({
          shown: getComputedStyle(document.getElementById("report")).display !== "none",
          renderDE: document.getElementById("rep-render-de")?.textContent ?? "" }));
        report(ed.shown && ed.renderDE.length > 0,
          `8 report: at step 3.1 the report shows beside the editor (dE ${ed.renderDE})`);
        await ev(() => document.getElementById("to-compare").click());
        await page.waitForFunction(`window.__np3app.state.step === "compare"`,
          { timeout: 60000, polling: 200 });
      }
    }

    // the mapping and the zoom/pan assertions at 1280×800 — the wider layout (the report
    // panel beside the canvas, no 980px media query), the size the known anomaly was
    // recorded at. page.setViewport is the BiDi way to size the headless Firefox window
    // (the -width/-height launch args are ignored); the geometry-settle wait (the canvas
    // synced to its box, the sizeCanvas() invariant) keeps the captures off any pending
    // window resize, which is what the recorded divergence reduced to.
    await page.setViewport({ width: 1280, height: 800 });
    await ev(() => window.__np3app.compare.draw());
    await page.waitForFunction(
      "(() => { const c = document.getElementById('cc'); const r = c.getBoundingClientRect();" +
      " return c.width === Math.round(r.width) && c.height === Math.round(r.height); })()",
      { timeout: 15000, polling: 50 });
    await viewAssertions("1280×800");
    await page.setViewport({ width: 800, height: 600 });
    await ev(() => window.__np3app.compare.draw());

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
}
