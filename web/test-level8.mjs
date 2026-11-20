// Level 8 of web/test.mjs: the end-to-end UI flow of the fitting wizard
// web/picture-control-jpg-fit.html (spec/ui.md, spec/ui-pages.md) in headless Firefox. One
// sequential page flow — the scenarios keep their order (spec/web-tests.md). The profile
// editor page (picture-control-editor.html) has its own level, 8e (web/test-level8e.mjs).
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
    await page.goto(`http://127.0.0.1:${port}/web/picture-control-jpg-fit.html`);
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
    // --- stage 1 of the full flow: the Start screen (spec/ui.md step 1, RAW first — decision #7) ---
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
          zones: !!document.getElementById("raw-drop") && !document.getElementById("target-drop")
            && !document.getElementById("target-file") && document.querySelectorAll("#start .zone").length === 1,
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
        "8 Start: one RAW drop zone (no JPEG zone), an empty name, Fit disabled");
    }

    // --- RAW first: a card per RAW, decoding first, the JPEG slot only after the decode ---
    await ev(() => window.__t8.dropOn("#raw-drop", "/test1/DSC_5584.NEF", "DSC_5584.NEF"));
    {
      const dec = await ev(() => {
        const p = window.__np3app.state.pairs[0];
        const card = window.__t8.card(1);
        return { raw: p?.raw, state: card?.querySelector(".pair-state")?.dataset.state,
                 slot: !!card?.querySelector(".pair-add-jpeg"), remove: !!card?.querySelector(".pair-remove"),
                 inc: !!card?.querySelector("input[type=checkbox]"), edit: !!card?.querySelector(".pair-edit") };
      });
      report(dec.raw === "pending" && dec.state === "decoding" && !dec.slot && dec.remove && !dec.inc && !dec.edit,
        "8 pairs: a dropped RAW gets a card at once in the decoding state — no JPEG slot yet, only Remove from fit" +
        " (no include checkbox, no Edit)");
    }
    await page.waitForFunction(
      "window.__np3app.state.pairs[0] && window.__np3app.state.pairs[0].raw"
      + " && !!window.__np3app.state.pairs[0].raw.image",
      { timeout: 300000, polling: 500 });
    {
      const p1 = await ev(() => {
        const p = window.__np3app.state.pairs[0];
        const card = window.__t8.card(1);
        return { name: p.rawFile.name, cam: `${p.raw.info.make} ${p.raw.info.model}`, warn: p.raw.warn,
                 w: p.raw.image.w, h: p.raw.image.h,
                 defName: window.__np3app.state.profileName,
                 fitName: document.getElementById("fit-name").value,
                 card: card?.querySelector(".pair-meta")?.textContent || "",
                 state: card.querySelector(".pair-state").dataset.state,
                 slot: !!card.querySelector(".pair-add-jpeg"),
                 count: document.getElementById("fit-count").textContent,
                 fitDisabled: document.getElementById("fit").disabled };
      });
      report(p1.name === "DSC_5584.NEF" && p1.cam.includes("Z f") && !p1.warn
             && p1.defName === "dsc_5584" && p1.fitName === "dsc_5584",
        `8 pairs: the RAW decodes into pair 1 (${p1.cam}), the default name "${p1.defName}" (as in match.py)`);
      report(p1.card.includes(p1.cam) && p1.card.includes(`${p1.w}×${p1.h}`) && p1.card.includes("Active D-Lighting"),
        `8 pairs: the card shows the camera and the frame size (${p1.w}×${p1.h}), ADL is honestly "?"`);
      report(p1.state === "no_jpeg" && p1.slot && p1.fitDisabled && /0 pair\(s\) will be fitted/.test(p1.count)
             && /1 without a JPEG/.test(p1.count),
        `8 pairs: after the decode the card offers "Add JPEG"; Fit stays disabled ("${p1.count}")`);
    }

    // --- the dimension guard: a wrong-aspect JPEG is rejected on the card ---
    await ev(() => window.__t8.dropWrongDim(1, "DSC_5584.JPG"));
    await page.waitForFunction(`window.__np3app.state.status.includes("dimensions")`,
      { timeout: 15000, polling: 100 });
    {
      const rej = await ev(() => {
        const p = window.__np3app.state.pairs[0];
        return { pairs: window.__np3app.state.pairs.length,
                 target: p.target, targetFile: p.targetFile?.name ?? null, rawOk: !!p.raw.image,
                 err: window.__t8.card(1).querySelector(".pair-target-err")?.textContent ?? "",
                 slot: !!window.__t8.card(1).querySelector(".pair-add-jpeg") };
      });
      report(rej.pairs === 1 && rej.target === null && rej.targetFile === null && rej.rawOk
             && /dimensions/.test(rej.err) && rej.slot,
        "8 pairs: a dimensionally incompatible JPEG is rejected on its card, the card keeps its RAW and the slot");
    }

    // --- a card takes exactly one JPEG: several files or a non-JPEG are rejected on the card ---
    await ev(() => window.__t8.dropOnCard(1, [["/web/golden/target/jpg_plain.jpg", "a.jpg"],
                                              ["/web/golden/target/jpg_wb.jpg", "b.jpg"]]));
    {
      const two = await ev(() => ({ target: window.__np3app.state.pairs[0].target,
        err: window.__t8.card(1).querySelector(".pair-target-err")?.textContent ?? "" }));
      report(two.target === null && /one JPEG per card/.test(two.err),
        `8 pairs: two files dropped on a card are rejected ("${two.err}")`);
      await ev(() => window.__t8.dropOnCard(1, [[null, "scan.tif", 0x11]]));
      const tif = await ev(() => ({ target: window.__np3app.state.pairs[0].target,
        err: window.__t8.card(1).querySelector(".pair-target-err")?.textContent ?? "" }));
      report(tif.target === null && /not a JPEG/.test(tif.err),
        `8 pairs: a non-JPEG dropped on a card is rejected ("${tif.err}")`);
    }

    // --- a valid JPEG on the card completes the pair; the XMP warnings show as codes; the
    //     small golden target is pre-fit-blocked as soon as the pair is prepared ---
    await ev(() => window.__t8.dropOnCard(1, [["/web/golden/target/jpg_plain.jpg", "DSC_5584.JPG"]]));
    await page.waitForFunction(
      "window.__np3app.state.pairs[0].target && !!window.__np3app.state.pairs[0].target.width"
      + " && !!window.__np3app.state.pairs[0].fitBlocked",
      { timeout: 60000, polling: 200 });
    {
      const p1 = await ev(() => {
        const p = window.__np3app.state.pairs[0];
        const card = window.__t8.card(1);
        return { target: p.targetFile.name, w: p.target.width, h: p.target.height,
                 codes: p.warnings.map((w) => w.code), block: p.fitBlocked?.code ?? null,
                 card: card.textContent, state: card.querySelector(".pair-state").dataset.state,
                 replace: !!card.querySelector(".pair-replace-jpeg"), err: !!card.querySelector(".pair-target-err"),
                 count: document.getElementById("fit-count").textContent,
                 fitDisabled: document.getElementById("fit").disabled };
      });
      report(p1.target === "DSC_5584.JPG" && p1.w === 384 && p1.h === 256
             && p1.codes.includes("small_target") && p1.codes.includes("no_lr_settings"),
        `8 pairs: a JPEG dropped on the card completes pair 1 (warnings: ${p1.codes.join(", ")})`);
      report(p1.card.includes("384×256") && p1.replace && !p1.err && p1.block === "target_too_small"
             && p1.state === "blocked" && p1.fitDisabled && /1 blocked/.test(p1.count),
        `8 pairs: the card shows the target size and "Replace JPEG"; the preview target is blocked right away ("${p1.count}")`);
    }

    // --- a second RAW (a non-Z f camera warns, does not block); its JPEG through the card's
    //     picker, a different base name is accepted ---
    await ev(() => window.__t8.dropOn("#raw-drop", "/test2/SKL_3024.dng", "SKL_3024.dng"));
    await page.waitForFunction(
      "window.__np3app.state.pairs[1] && window.__np3app.state.pairs[1].raw"
      + " && !!window.__np3app.state.pairs[1].raw.image",
      { timeout: 300000, polling: 500 });
    await ev(() => window.__t8.pickOnCard(2, "/web/golden/target/jpg_wb.jpg", "export-of-skl.JPG"));
    await page.waitForFunction(
      "window.__np3app.state.pairs[1].target && !!window.__np3app.state.pairs[1].target.width",
      { timeout: 30000, polling: 200 });
    {
      const p2 = await ev(() => {
        const p = window.__np3app.state.pairs[1];
        return { cam: p.raw.info.model, codes: p.warnings.map((w) => w.code), target: p.targetFile.name,
                 gain: p.warnings.find((w) => w.code === "gain_note")?.note ?? null,
                 p1target: window.__np3app.state.pairs[0].targetFile.name };
      });
      report(p2.cam.includes("Z 8") && p2.codes.includes("camera"),
        `8 pairs: a non-Z f RAW is a warning, not a blocker (${p2.cam})`);
      report(p2.target === "export-of-skl.JPG" && p2.p1target === "DSC_5584.JPG" && p2.gain
             && p2.gain.includes("6500 K") && p2.gain.includes("exposure +0.50"),
        `8 pairs: the card's picker attaches a JPEG of another base name to its own card; edit-gain note: "${p2.gain}"`);
    }

    // --- a JPEG dropped on the page (not on a card) is skipped with a hint ---
    await ev(() => window.__t8.dropFile("/web/golden/target/jpg_masks.jpg", "loose.JPG"));
    {
      const loose = await ev(() => ({ n: window.__np3app.state.pairs.length, status: window.__np3app.state.status }));
      report(loose.n === 2 && /add the JPEG on its RAW's card/.test(loose.status),
        `8 pairs: a JPEG dropped outside the cards is skipped ("${loose.status}")`);
    }

    // --- Replace JPEG: a corrupt replacement is rejected, the card is left without a target;
    //     then a valid one ---
    await ev(() => window.__t8.dropOnCard(2, [[null, "corrupt.JPG", 0xAB]]));
    await page.waitForFunction(`window.__np3app.state.status.includes("could not be read")`,
      { timeout: 15000, polling: 100 });
    {
      const ok = await ev(() => ({ n: window.__np3app.state.pairs.length,
                                   t0: !!window.__np3app.state.pairs[0].target.width,
                                   t1: window.__np3app.state.pairs[1].target,
                                   err: window.__t8.card(2).querySelector(".pair-target-err")?.textContent ?? "",
                                   slot: !!window.__t8.card(2).querySelector(".pair-add-jpeg") }));
      report(ok.n === 2 && ok.t0 && ok.t1 === null && /could not be read/.test(ok.err) && ok.slot,
        "8 pairs: a corrupt replacement JPEG is rejected on its card; the other pair is untouched");
    }
    await ev(() => window.__t8.dropOnCard(2, [["/web/golden/target/jpg_wb.jpg", "SKL_3024.JPG"]]));
    await page.waitForFunction(
      "window.__np3app.state.pairs[1].target && !!window.__np3app.state.pairs[1].target.width"
      + " && !!window.__np3app.state.pairs[1].fitBlocked",
      { timeout: 60000, polling: 200 });

    // --- an unreadable RAW: its card shows the error, only removal; a duplicate RAW is skipped ---
    await ev(() => window.__t8.dropBytes("#raw-drop", "broken.NEF", 0x55));
    await page.waitForFunction(
      "window.__np3app.state.pairs.length === 3 && window.__np3app.state.pairs[2].blocked === true",
      { timeout: 60000, polling: 200 });
    {
      const b = await ev(() => {
        const p = window.__np3app.state.pairs[2];
        const card = window.__t8.card(p.id);
        return { id: p.id, raw: p.rawFile.name, codes: p.warnings.map((w) => w.code),
                 state: card.querySelector(".pair-state").dataset.state,
                 slot: !!card.querySelector(".pair-add-jpeg"), remove: !!card.querySelector(".pair-remove"),
                 count: document.getElementById("fit-count").textContent };
      });
      report(b.raw === "broken.NEF" && b.codes.includes("raw_error") && b.state === "raw_error" && !b.slot
             && b.remove && /3 blocked/.test(b.count),
        `8 pairs: an unreadable RAW blocks its card (no JPEG slot, only Remove from fit) — "${b.count}"`);
      await ev((id) => window.__t8.dropOnCard(id, [["/web/golden/target/jpg_plain.jpg", "x.JPG"]]), b.id);
      const noJpeg = await ev((id) => ({ target: window.__np3app.state.pairs.find((p) => p.id === id).target,
        err: window.__t8.card(id).querySelector(".pair-target-err")?.textContent ?? "" }), b.id);
      report(noJpeg.target === null && /unreadable/.test(noJpeg.err),
        "8 pairs: a JPEG dropped on a RAW-error card is refused");
      await ev(() => window.__t8.dropOn("#raw-drop", "/test1/DSC_5584.NEF", "DSC_5584.NEF"));
      const dup = await ev(() => ({ n: window.__np3app.state.pairs.length, status: window.__np3app.state.status }));
      report(dup.n === 3 && /already in the list/.test(dup.status),
        `8 pairs: a RAW already in the list (decoded) is skipped ("${dup.status}")`);
      // Remove from fit: the card and the pair are gone for good
      await ev((id) => window.__t8.card(id).querySelector(".pair-remove").click(), b.id);
      const rm = await ev(() => ({ ids: window.__np3app.state.pairs.map((p) => p.id),
        cards: document.querySelectorAll("#pairs .pair").length, status: window.__np3app.state.status }));
      report(rm.ids.join(",") === "1,2" && rm.cards === 2 && /Removed broken\.NEF/.test(rm.status),
        `8 pairs: "Remove from fit" deletes the card and the pair (${rm.ids}; "${rm.status}")`);
    }

    // --- the name rule validates immediately; with only blocked pairs Fit stays disabled ---
    {
      const bad = await ev(() => {
        const inp = document.getElementById("fit-name");
        inp.value = "THIS NAME IS FAR TOO LONG";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return { bad: inp.classList.contains("bad"), err: !document.getElementById("fit-name-err").hidden };
      });
      report(bad.bad && bad.err, "8 name: more than 19 chars is highlighted right away");
      const nonAscii = await ev(() => {
        const inp = document.getElementById("fit-name");
        inp.value = "ÉTOILE";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        return inp.classList.contains("bad");
      });
      report(nonAscii, "8 name: non-ASCII is highlighted (the np3.serialize rule)");
      const st = await ev(() => {
        const inp = document.getElementById("fit-name");
        inp.value = "dsc_5584";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("fit").click();      // disabled: nothing happens
        const s = window.__np3app.state;
        return { disabled: document.getElementById("fit").disabled, fitting: s.fitting,
                 codes: s.pairs.map((p) => p.fitBlocked?.code ?? null), versions: s.versions.length,
                 count: document.getElementById("fit-count").textContent };
      });
      report(st.disabled && !st.fitting && st.codes.every((c) => c === "target_too_small") && st.versions === 0
             && /^0 pair\(s\) will be fitted; 0 without a JPEG, 2 blocked/.test(st.count),
        `8 Fit: with only pre-fit-blocked pairs (small golden previews) Fit is disabled, no version ("${st.count}")`);
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

    // --- the wizard page (spec/ui-pages.md): no standalone RAW open, no NP3 import, no editor
    //     without a fitted version; a dropped NP3 gets a hint; the phone note stays hidden here ---
    {
      const pg = await ev(() => ({
        drop: !!document.getElementById("drop"), file: !!document.getElementById("file"),
        imp: !!document.getElementById("import"), exp: !!document.getElementById("export"),
        share: !!document.getElementById("share"),
        banner: document.getElementById("phone-banner")?.hidden,
      }));
      report(!pg.drop && !pg.file && !pg.imp && pg.exp && pg.share && pg.banner === true,
        "8 wizard page: no RAW drop zone and no Import NP3 (the editor page has them); Export and Copy link stay;" +
        " the phone note is hidden on a desktop");
      await ev(() => window.__np3app.enterEditor(window.__np3app.state.pairs[0]));
      const noEd = await ev(() => window.__np3app.state.step);
      report(noEd === "start", "8 wizard page: the manual editor needs a fitted version (no standalone editing here)");
      await ev(async () => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(978)], "profile.NP3"));
        document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      const np3 = await ev(() => ({ status: window.__np3app.state.status, name: window.__np3app.state.control.name }));
      report(/profile editor/.test(np3.status) && np3.name === "NPF-MANUAL",
        `8 wizard page: a dropped NP3 is not imported ("${np3.status}")`);
    }

    // a fresh wizard page for the fit scenarios (the Start checks above leave two blocked pairs)
    await page.goto(`http://127.0.0.1:${port}/web/picture-control-jpg-fit.html`);
    await page.waitForFunction(
      `window.__np3app && window.__np3app.state.step === "start"`,
      { timeout: 120000, polling: 200 });

    // The shared-mapping and the zoom/pan assertion groups, re-runnable at a second window
    // size: the modes must produce the same image-space mapping at any viewport, so the
    // suite runs these at the 800×600 default and at 1280×800 (the wider layout with the
    // report panel beside the canvas) — see spec/web-tests.md.
    const viewAssertions = async (tag) => {
      // both modes render through the same shared mapping (the key-toggle mode is gone,
      // spec/ui.md decision #8)
      {
        const modes = await ev(() => [...document.querySelectorAll("#cmp-modes button")].map((b) => b.dataset.mode));
        report(modes.join(",") === "side,curtain" && !(await ev(() => !!document.getElementById("cmp-reset"))),
          `8 compare modes [${tag}]: exactly side-by-side and curtain (${modes.join(", ")}), no Reset view button`);
        const maps = {}, sums = {};
        for (const m of ["side", "curtain"]) {
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
          `8 compare modes [${tag}]: both modes draw the frame (sums ${Object.values(sums).join(", ")})`);
        // the relative offsets are compared with a tolerance: mapPoint carries the large
        // viewport-center offset and back, so the raw floats can differ at the 1e-14
        // (double-rounding) level — the geometry itself must agree exactly
        const near = (a, b) => Math.abs(a - b) <= 1e-9;
        const sameMap = (a, b) =>
          near(a.base, b.base) && near(a.view.x, b.view.x) && near(a.view.y, b.view.y)
          && near(a.view.scale, b.view.scale)
          && near(a.L.x, b.L.x) && near(a.L.y, b.L.y) && near(a.R.x, b.R.x) && near(a.R.y, b.R.y);
        report(sameMap(maps.side, maps.curtain),
          `8 compare modes [${tag}]: side-by-side and curtain share the same zoom/pan mapping`);
        // Space no longer swaps anything on Compare
        const t0 = await ev(() => window.__t8.snapCC());
        await ev(() => document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true })));
        const t1 = await ev(() => window.__t8.snapCC());
        await ev(() => document.body.dispatchEvent(
          new KeyboardEvent("keyup", { key: " ", bubbles: true })));
        report(t1 === t0, `8 compare [${tag}]: holding Space changes nothing (no key-toggle mode)`);
      }

      // shared zoom/pan: wheel zoom to the cursor, drag pan, double-click reset. The zoom anchor is
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
        await ev(() => {
          const c = document.getElementById("cc");
          const r = c.getBoundingClientRect();
          c.dispatchEvent(new MouseEvent("dblclick", { button: 0, clientX: r.left + r.width * 0.6,
            clientY: r.top + r.height * 0.5, bubbles: true, cancelable: true }));
        });
        const rst = await ev(() => window.__np3app.compare.debug().view);
        report(rst.scale === 1 && rst.x === 0 && rst.y === 0,
          `8 reset [${tag}]: a double click returns the view to the fit`);
      }
    };

    // --- stage 2: pair preparation in the Worker (spec/ui-plan.md stage 2); since stage 9 it
    //     starts as soon as a card has both files (decision #7), Fit then fits the ready pairs ---
    {
      // (a fresh page: the drop helper is installed again)
      await ev(() => {
        window.__t8 = window.__t8 ?? {};
        window.__t8.dropOn = async (zone, path, name) => {
          const buf = await (await fetch(path)).arrayBuffer();
          const dt = new DataTransfer();
          dt.items.add(new File([buf], name));
          document.querySelector(zone).dispatchEvent(
            new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        };
        // the card helpers (RAW first): a JPEG goes onto its card
        window.__t8.card = (id, list = "pairs") => document.querySelector(`#${list} .pair[data-pair-id="${id}"]`);
        window.__t8.dropOnCard = async (id, files, list = "pairs") => {
          const dt = new DataTransfer();
          for (const [path, name] of files) dt.items.add(new File([await (await fetch(path)).arrayBuffer()], name));
          window.__t8.card(id, list).dispatchEvent(
            new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        };
        // the slider helper too: the stage-6 and stage-7 scenarios below edit the panel
        window.__t8.groupSlider = (group, idx, v) => {
          const inp = document.querySelectorAll(`#panel [data-group="${group}"] input[type=range]`)[idx];
          inp.value = v;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
      });
      // a real aligned pair (DSC_5584.NEF + its own export) and a cross pair
      // (SKL_3024 RAW against the DSC_5584 target — NCC below 0.6 blocks it)
      await ev(() => window.__t8.dropOn("#raw-drop", "/test1/DSC_5584.NEF", "DSC_5584.NEF"));
      await ev(() => window.__t8.dropOn("#raw-drop", "/test2/SKL_3024.dng", "SKL_3024.dng"));
      await page.waitForFunction(
        "window.__np3app.state.pairs.length === 2"
        + " && window.__np3app.state.pairs.every((p) => p.raw && !!p.raw.image)",
        { timeout: 600000, polling: 500 });
      // the JPEG of pair 1: its preparation starts by itself (decision #7) — the card shows
      // the progress and Fit is locked meanwhile
      await ev(() => window.__t8.dropOnCard(1, [["/test1/DSC_5584.jpg", "DSC_5584.JPG"]]));
      await page.waitForFunction("window.__np3app.state.pairs[0].preparing === true",
        { timeout: 60000, polling: 100 });
      {
        const during = await ev(() => ({
          fitDisabled: document.getElementById("fit").disabled,
          card: window.__t8.card(1).querySelector(".pair-meta").textContent,
          state: window.__t8.card(1).querySelector(".pair-state").dataset.state,
          name: document.getElementById("fit-name").value,
        }));
        report(during.fitDisabled && during.card.includes("Preparing") && during.state === "preparing"
               && during.name === "dsc_5584",
          `8 prepare: a card with both files prepares by itself — progress on the card, Fit locked ("${during.card.slice(0, 60)}…")`);
      }
      // cancel/replace: the JPEG is replaced mid-preparation — the running task is cancelled,
      // its result is stale and must not land; the pair is prepared again for the new file
      await ev(() => window.__t8.dropOnCard(1, [["/test1/DSC_5584.jpg", "DSC_5584.JPG"]]));
      {
        const cancelled = await ev(() => ({
          gen: window.__np3app.state.pairs[0].prepGen,
          prepared: window.__np3app.state.pairs[0].prepared,
          card: window.__t8.card(1).querySelector(".pair-meta").textContent,
        }));
        report(cancelled.gen >= 2 && cancelled.prepared === null && !cancelled.card.includes("NCC"),
          "8 prepare: replacing the JPEG mid-preparation cancels the task, no stale NCC lands on the card");
      }
      await ev(() => window.__t8.dropOnCard(2, [["/test1/DSC_5584.jpg", "SKL_3024.JPG"]]));
      await page.waitForFunction(
        "window.__np3app.state.pairs.every((p) => p.prepared && !p.preparing)",
        { timeout: 600000, polling: 500 });
      {
        const done = await ev(() => {
          const s = window.__np3app.state;
          return {
            p1: { ncc: s.pairs[0].prepared.ncc, blocked: s.pairs[0].prepared.blocked?.code ?? null,
                  card: window.__t8.card(1).textContent },
            p2: { ncc: s.pairs[1].prepared.ncc, blocked: s.pairs[1].prepared.blocked?.code ?? null,
                  card: window.__t8.card(2).textContent,
                  state: window.__t8.card(2).querySelector(".pair-state").dataset.state },
            fitDisabled: document.getElementById("fit").disabled,
            count: document.getElementById("fit-count").textContent,
          };
        });
        report(done.p1.ncc > 0.7 && !done.p1.blocked && done.p1.card.includes("NCC"),
          `8 prepare: the aligned pair shows NCC ${done.p1.ncc.toFixed(3)}`);
        report(done.p2.blocked === "ncc_low" && /Alignment failed/.test(done.p2.card) && done.p2.state === "blocked",
          `8 prepare: the cross pair is blocked (ncc ${done.p2.ncc.toFixed(3)} < 0.60), its card shows the badge`);
        report(!done.fitDisabled && /^1 pair\(s\) will be fitted; 0 without a JPEG, 1 blocked/.test(done.count),
          `8 prepare: Fit is enabled over the one usable pair ("${done.count}")`);
      }

      // fit the aligned one (stage 3): the cross pair is blocked — only pair 1 goes into the fit
      await ev(() => document.getElementById("fit").click());
      await page.waitForFunction("window.__np3app.state.fitting === true", { timeout: 600000, polling: 200 });
      {
        const done = await ev(() => ({
          fitDisabled: document.getElementById("fit").disabled,
          fitLabel: document.getElementById("fit").textContent,
          status: document.getElementById("status").textContent,
          versions: window.__np3app.state.versions.length,
        }));
        report(done.fitDisabled && done.fitLabel === "Fitting…" && /^(Fitting|Fitting:)/.test(done.status)
               && done.versions === 0,
          `8 fit: the fit runs with progress in the status line, Fit is locked ("${done.status.slice(0, 44)}…")`);
      }
      // cancel on a mid-flight JPEG replacement: the running fit is cancelled, no version is created
      await ev(() => window.__t8.dropOnCard(1, [["/test1/DSC_5584.jpg", "DSC_5584.JPG"]]));
      await page.waitForFunction(`window.__np3app.state.status.startsWith("Fit cancelled")`,
        { timeout: 60000, polling: 200 });
      {
        const cancelled = await ev(() => ({
          versions: window.__np3app.state.versions.length,
          p1prepared: window.__np3app.state.pairs[0].prepared === null,
          fitting: window.__np3app.state.fitting,
        }));
        report(cancelled.versions === 0 && cancelled.p1prepared && !cancelled.fitting,
          "8 fit: a mid-flight JPEG replacement cancels the fit, no partial version lands");
      }
      // re-Fit once pair 1 is prepared again: the free fit creates the immutable draft version
      await page.waitForFunction(
        "window.__np3app.state.pairs[0].prepared && !window.__np3app.state.pairs[0].preparing"
        + " && !document.getElementById('fit').disabled",
        { timeout: 600000, polling: 500 });
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
          `8 fit: the draft version over the exact usable pair id (${draft.pairIds}), strength kept`);
        report(draft.name === "NPF-DSC_5584" && draft.status.startsWith("Fit finished")
               && draft.iters > 0 && draft.cost > 0,
          `8 fit: "${draft.name}" in ${draft.iters} iterations (cost ${draft.cost}) — "${draft.status.slice(0, 52)}…"`);
      }
      // the manual editor is reached from Compare (decision #7) and applies the version control
      await page.waitForFunction(`window.__np3app.state.step === "compare"`, { timeout: 60000, polling: 200 });
      await ev(() => document.getElementById("cmp-manual").click());
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
          `8 fit: Compare -> manual adjustment opens the fitted pair with the draft control (${ed.name})`);
      }
      // Copy link in step 3.1 leads to the profile editor page (spec/ui-pages.md "Share links")
      {
        const link = await page.evaluate(async () => {
          window.__link = null;
          navigator.clipboard.writeText = (s) => { window.__link = s; return Promise.resolve(); };
          document.getElementById("share").click();
          await new Promise((r) => setTimeout(r, 300));
          return window.__link;
        });
        report(typeof link === "string" && new RegExp(`^http://127\\.0\\.0\\.1:${port}/web/picture-control-editor\\.html\\?np3=[A-Za-z0-9_-]+$`).test(link),
          `8 share: Copy link in the manual step builds the editor link (${(link || "").slice(0, 70)}…)`);
      }
      await ev(() => document.getElementById("to-start").click());
      await page.waitForFunction(`window.__np3app.state.step === "start"`,
        { timeout: 60000, polling: 200 });
      // a preview as pair 2's new JPEG blocks it (target_too_small); the prepared pair is refit,
      // the blocked one stays out of the version
      await ev(() => window.__t8.dropOnCard(2, [["/web/golden/target/jpg_plain.jpg", "SKL_3024.JPG"]]));
      await page.waitForFunction(
        "window.__np3app.state.pairs[1].target && window.__np3app.state.pairs[1].target.width === 384"
        + " && !!window.__np3app.state.pairs[1].fitBlocked && !document.getElementById('fit').disabled",
        { timeout: 60000, polling: 200 });
      await ev(() => document.getElementById("fit").click());
      await page.waitForFunction("window.__np3app.state.fitting === true", { timeout: 60000, polling: 100 });
      await page.waitForFunction(
        `window.__np3app.state.status.startsWith("Fit finished") && !window.__np3app.state.fitting`,
        { timeout: 600000, polling: 500 });
      {
        const small = await ev(() => ({
          code: window.__np3app.state.pairs[1].fitBlocked?.code ?? null,
          card: window.__t8.card(2).textContent,
          pairIds: window.__np3app.state.versions[0].pairIds,
        }));
        report(small.code === "target_too_small" && /too small/.test(small.card)
               && small.pairIds.length === 1 && small.pairIds[0] === "1",
          "8 fit: a preview JPEG blocks its pair (target_too_small), the aligned pair stays in the version");
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
          // the render side covers the working rectangle at ≥ the working resolution (not the
          // 256-px H3×W3 report grid), with the working aspect within one pixel
          report(ui.aligned && ui.working
                 && ui.aligned.w >= ui.working.w && ui.aligned.h >= ui.working.h
                 && Math.abs(ui.aligned.w * ui.working.h / ui.working.w - ui.aligned.h) <= 1,
            `8 compare geometry: the render side covers the working rectangle at ${ui.aligned?.w}×${ui.aligned?.h}` +
            ` (working ${ui.working?.w}×${ui.working?.h}, report grid ${Math.floor((ui.working?.w ?? 0) / 3)}×` +
            `${Math.floor((ui.working?.h ?? 0) / 3)})`);
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
          // the same screen points with the divider at the edges: at the right edge the
          // whole canvas is the render, at the left edge the whole canvas is the target
          const dragDivider = (from, to) => ev((ft) => {
            const c = document.getElementById("cc");
            const r = c.getBoundingClientRect();
            const cy = r.height * 0.5;
            const opts = (x) => ({ button: 0, clientX: r.left + x, clientY: r.top + cy,
                                   bubbles: true, cancelable: true });
            c.dispatchEvent(new MouseEvent("mousedown", opts(r.width * ft[0])));
            window.dispatchEvent(new MouseEvent("mousemove", opts(r.width * ft[1])));
            window.dispatchEvent(new MouseEvent("mouseup", opts(r.width * ft[1])));
          }, [from, to]);
          await dragDivider(0.3, 1.0);
          const atRight = await ev(() => window.__np3app.compare.debug().curtain);
          const renderPx = await ev((s) => window.__t8.px(s.w * 0.1, s.h * 0.5), sides);
          await dragDivider(1.0, 0.0);
          const atLeft = await ev(() => window.__np3app.compare.debug().curtain);
          const targetPx = await ev((s) => window.__t8.px(s.w * 0.5, s.h * 0.5), sides);
          const same = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          report(atRight > 0.99 && atLeft < 0.01 && same(sides.left, renderPx) <= 3 && same(sides.right, targetPx) <= 3,
            `8 curtain: left of the divider is the render, right is the target (divider at the edges: ${atRight.toFixed(2)}, ${atLeft.toFixed(2)})`);
          // back to side-by-side with the divider in the middle: the checks below compare the
          // render side's pixels (the removed key-toggle mode used to show it full-canvas)
          await dragDivider(0.0, 0.5);
          await ev(() => document.querySelector('#cmp-modes button[data-mode="side"]').click());
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
          const label150 = await ev(() => document.getElementById("cmp-strength-val").textContent);
          report(label150 === "150%",
            `8 strength label: the value next to the Compare slider follows it live ("${label150}")`);
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
          const moreUi = await ev(() => ({ refit: !!document.getElementById("more-refit"),
            cards: document.querySelectorAll("#more-pairs .pair").length,
            pairs: window.__np3app.state.pairs.length }));
          report(more.step === "more" && more.shown && moreUi.refit && moreUi.cards === moreUi.pairs,
            `8 exit: Continue fitting goes to the More frames step (${moreUi.cards} pair cards, the refit bar)`);
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
        // the thumbnail is square, with the neutral histogram and the identity diagonal under
        // the curve; with the curve off the square, the histogram and the diagonal stay
        const th = await ev(() => {
          const A = window.__np3app;
          const p = A.state.pairs[0];
          const shape = () => {
            const svg = document.querySelector("#rep-curve svg");
            const r = svg?.getBoundingClientRect();
            const hist = svg?.querySelector("path.rep-hist");
            return { w: r?.width ?? 0, h: r?.height ?? 0, hist: hist?.getAttribute("d") ?? "",
                     diag: !!svg?.querySelector("line.rep-curve-diag"),
                     line: !!svg?.querySelector("polyline.rep-curve-line"),
                     off: /off/.test(document.getElementById("rep-curve").textContent) };
          };
          const on = shape();
          const orig = p.report;
          const base = { ...orig.parameters.base, curve: null };
          const result = { ...orig.parameters.result, curve: null };
          p.report = { ...orig, parameters: { ...orig.parameters, base, result } };
          A.report.refresh();
          const offShape = shape();
          p.report = orig;
          A.report.refresh();
          return { on, offShape, histLen: orig.neutralHist?.length ?? 0 };
        });
        report(th.histLen === 256 && th.on.w > 50 && Math.abs(th.on.w - th.on.h) <= 1
               && th.on.hist.length > 100 && th.on.diag && th.on.line
               && th.offShape.hist === th.on.hist && th.offShape.diag && !th.offShape.line && th.offShape.off,
          `8 report: the curve thumbnail is square (${th.on.w.toFixed(0)}×${th.on.h.toFixed(0)}) with the` +
          " neutral histogram and the diagonal; with the curve off the histogram stays and \"off\" shows");
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

      // no JSON download (spec/ui.md decision #8)
      report(!(await ev(() => !!document.getElementById("rep-download")
          || [...document.querySelectorAll("#report button")].some((b) => /download/i.test(b.textContent)))),
        "8 report: no Download report control");

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
                                table: rep.table, neutralHist: Float64Array.from(rep.neutralHist).reverse() };
          A.report.refresh();
          const tgl = document.getElementById("rep-scope");
          const out = { shown: !tgl.hidden, buttons: tgl.querySelectorAll("button").length };
          const histD = () => document.querySelector("#rep-curve path.rep-hist")?.getAttribute("d") ?? "";
          out.histPair = histD();
          document.querySelector('#rep-scope button[data-scope="aggregate"]').click();
          out.histAgg = histD();
          out.renderDE = document.getElementById("rep-render-de").textContent;
          out.binMean = document.getElementById("rep-bin-mean").textContent;
          out.rows = document.querySelectorAll("#rep-table tbody tr").length;
          out.mapHidden = document.getElementById("rep-map-section").hidden;
          document.querySelector('#rep-scope button[data-scope="pair"]').click();
          out.pairDE = document.getElementById("rep-render-de").textContent;
          out.histBack = histD();
          p2.prepared = saved.prepared;
          p2.fitBlocked = saved.fitBlocked; p2.report = saved.report;
          s.reportAggregate = saved.agg;
          A.report.refresh();
          return { ...out, wantDE: (rs.all * 1.5).toFixed(2), wantBin: (rep.summary.binMean * 1.5).toFixed(2),
                   wantRows: rep.table.length, pairDE: rs.all.toFixed(2) };
        });
        report(agg.shown && agg.buttons === 2 && agg.renderDE === agg.wantDE
               && agg.binMean === agg.wantBin && agg.rows === agg.wantRows && agg.mapHidden === true
               && agg.histPair && agg.histAgg && agg.histAgg !== agg.histPair && agg.histBack === agg.histPair,
          "8 report: the aggregate switch — the totals over all reported pairs (the map stays per-pair);" +
          " the curve backdrop switches to the summed histogram and back");
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
        await ev(() => {
          const inp = document.getElementById("cmp-strength");
          inp.value = "75";
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        });
        // The invariant is "the updating state shows at some point while recomputing", not
        // "it shows at t=60 ms": the page runs as one of several concurrent tabs of the shared
        // Firefox, where a background tab's timers clamp to 1 s and a loaded content process
        // stretches an in-page sleep past the report landing. Wait from Node for the state
        // itself (with the previous report's cell still in place), then for the final report.
        const updating = `(() => { const b = document.getElementById("rep-updating");
                         return !b.hidden && document.getElementById("rep-body").classList.contains("updating")
                                && document.getElementById("rep-strength").textContent === "100%"; })()`;
        try {
          await page.waitForFunction(updating, { timeout: 60000, polling: 50 });
          report(true, "8 report: while a slider drags the previous report stays with an \"updating…\" state");
        } catch {
          const mid = await ev(() => ({
            badge: document.getElementById("rep-updating").hidden,
            dimmed: document.getElementById("rep-body").classList.contains("updating"),
            strengthCell: document.getElementById("rep-strength").textContent,
          }));
          report(false, `8 report: while a slider drags the previous report stays with an "updating…" state` +
                        ` (badge hidden: ${mid.badge}, dimmed: ${mid.dimmed}, cell: ${mid.strengthCell})`);
        }
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

    // --- stage 7: More frames — more pairs, advice, the recommended set, refit (spec/ui.md step 3.2) ---
    // the second pair: the DSC_5584 RAW + its own export again under new names (DSC_5584B.*) —
    // a pair known to prepare in every browser (the files of level 8 already); the advice,
    // the selection and the refit only need a second usable pair, not a different scene
    if (!rootFile("test1/DSC_5584.jpg")) {
      skip("8 stage 7: no test1/DSC_5584.jpg — the More-step scenarios are skipped");
    } else {
      const moreSettle = (cond, ms = 300000) => page.waitForFunction(cond, { timeout: ms, polling: 250 });
      // the session strength 80% on Compare: the refit must keep it
      await ev(() => {
        const inp = document.getElementById("cmp-strength");
        inp.value = "80";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const v0 = await ev(() => {
        const s = window.__np3app.state;
        return { n: s.versions.length, sel: s.selectedVersionId,
                 selName: s.versions.find((v) => v.id === s.selectedVersionId).name,
                 names: s.versions.map((v) => v.name),
                 versionsJson: JSON.stringify(s.versions.map((v) => ({ id: v.id, control: v.control }))) };
      });

      // the editor's Continue fitting with manual edits goes through the leave warning
      await ev(() => document.getElementById("cmp-manual").click());
      await moreSettle(`window.__np3app.state.step === "edit"`, 60000);
      await ev(() => window.__t8.groupSlider("basic", 0, 37));
      const lw = await ev(() => {
        document.getElementById("ed-to-more").click();
        return { shown: !document.getElementById("leave-confirm").hidden,
                 step: window.__np3app.state.step,
                 btn: !document.getElementById("ed-to-more").hidden };
      });
      report(lw.btn && lw.shown && lw.step === "edit",
        "8 stage 7: Continue fitting from the editor with manual edits asks first (the leave warning)");
      await ev(() => document.getElementById("leave-discard").click());
      await moreSettle(`window.__np3app.state.step === "more"`, 60000);

      // the screen: the session's pairs as cards with Remove, the advice of the selected pairs
      await moreSettle(`window.__np3app.state.advice && window.__np3app.state.advice.coverage.length === 10
                        && window.__np3app.state.advice.pending === 0`, 120000);
      const m0 = await ev(() => {
        const A = window.__np3app, s = A.state;
        window.__t8.prep1 = s.pairs.find((p) => p.id === 1)?.prepared ?? null;
        return { step: s.step, shown: getComputedStyle(document.getElementById("more")).display !== "none",
                 cards: [...document.querySelectorAll("#more-pairs .pair")].map((c) => c.dataset.pairId),
                 removes: document.querySelectorAll("#more-pairs .pair-remove").length,
                 rows: document.querySelectorAll("#more-advice .more-cov tr").length,
                 advice: s.advice, ids: document.getElementById("more-refit").dataset.pairIds,
                 verdict1: document.querySelector('#more-pairs .pair[data-pair-id="1"] .pair-verdict')?.dataset.verdict ?? null };
      });
      report(m0.shown && m0.cards.length >= 1 && m0.removes === m0.cards.length && m0.rows === 10
             && m0.advice.selected.join(",") === m0.ids && m0.verdict1 !== null,
        `8 stage 7: the More screen — ${m0.cards.length} pair cards with Remove, coverage of ${m0.rows} groups` +
        ` over the selected pairs (${m0.ids}), pair 1 verdict "${m0.verdict1}"`);

      // remove a pair (the blocked preview pair): pair 1 keeps its preparation, the versions stay
      const victim = await ev(() => window.__np3app.state.pairs.find((p) => p.id !== 1)?.id ?? null);
      if (victim !== null) {
        await ev((v) => document.querySelector(`#more-pairs .pair[data-pair-id="${v}"] .pair-remove`).click(), victim);
        const rm = await ev(() => {
          const s = window.__np3app.state;
          return { ids: s.pairs.map((p) => p.id), cards: document.querySelectorAll("#more-pairs .pair").length,
                   kept1: s.pairs.find((p) => p.id === 1)?.prepared === window.__t8.prep1, versions: s.versions.length };
        });
        report(!rm.ids.includes(victim) && rm.cards === rm.ids.length && rm.kept1 && rm.versions === v0.n,
          `8 stage 7: removing pair ${victim} keeps the other prepared pairs and the versions (pairs ${rm.ids})`);
      } else {
        skip("8 stage 7: no second pair to remove");
      }

      // a new pair through the More screen (the same RAW-first loading path and checks)
      await ev(() => window.__t8.dropOn("#more-raw-drop", "/test1/DSC_5584.NEF", "DSC_5584B.NEF"));
      await moreSettle(`(() => { const p = window.__np3app.state.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF");
                         return p && (p.raw === "error" || (p.raw && !!p.raw.image)); })()`, 600000);
      const id3 = await ev(() => window.__np3app.state.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF").id);
      await ev((id) => window.__t8.dropOnCard(id, [["/test1/DSC_5584.jpg", "DSC_5584B.jpg"]], "more-pairs"), id3);
      // wait for a terminal state of the new pair (analyzed, or failed — reported below)
      await moreSettle(`(() => { const s = window.__np3app.state;
                         const p = s.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF");
                         return p && (p.raw === "error" || p.prepError || p.fitBlocked || p.prepared?.blocked
                                      || (p.frame && p.prepared && s.advice.candidates.includes(p.id)
                                          && s.advice.pending === 0)); })()`, 600000);
      const m1 = await ev(() => {
        const s = window.__np3app.state;
        const p3 = s.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF");
        return { id3: p3.id, target: p3.targetFile?.name, ncc: p3.prepared?.ncc ?? 0,
                 err: p3.prepError ?? p3.rawError ?? p3.fitBlocked?.code ?? p3.prepared?.blocked?.code ?? null, versions: s.versions.length,
                 fitting: s.fitting, selected: s.advice.selected, coverage: s.advice.coverage,
                 card: !!document.querySelector(`#more-pairs .pair[data-pair-id="${p3.id}"] .pair-verdict`),
                 status: s.status };
      });
      report(m1.target === "DSC_5584B.jpg" && m1.ncc >= 0.6 && m1.card && !m1.err,
        `8 stage 7: a pair added on the More screen is decoded, prepared and analyzed (NCC ${m1.ncc.toFixed(3)}` +
        `${m1.err ? ", " + m1.err : ""})`);
      report(m1.versions === v0.n && !m1.fitting && m1.selected.includes(m1.id3)
             && JSON.stringify(m1.coverage) !== JSON.stringify(m0.advice.coverage),
        `8 stage 7: the advice follows the new pair without a fit (in the fit: ${m1.selected}, versions ${m1.versions})`);

      // no inclusion state (decision #7): no checkboxes, no "Use the recommended selection";
      // the recommended set is shown and the cards outside it are only marked
      {
        const r = await ev(() => {
          const s = window.__np3app.state;
          const a = s.advice;
          const marked = [...document.querySelectorAll("#more-pairs .pair")]
            .filter((c) => c.querySelector(".pair-not-rec")).map((c) => Number(c.dataset.pairId));
          const want = a.candidates.filter((id) => a.recommended.length && !a.recommended.includes(id));
          return { boxes: document.querySelectorAll("#more-pairs input[type=checkbox]").length,
                   useRec: !!document.getElementById("more-use-rec"),
                   rec: a.recommended, marked, want, selected: a.selected, all: s.pairs.map((p) => p.id),
                   text: document.querySelector("#more-advice .more-rec")?.textContent ?? "",
                   ids: document.getElementById("more-refit").dataset.pairIds };
        });
        report(r.boxes === 0 && !r.useRec && r.marked.join(",") === r.want.join(",")
               && (!r.rec.length || /Recommended set/.test(r.text))
               && r.ids === r.selected.join(","),
          `8 stage 7: no checkboxes and no auto-selection; recommended ${r.rec.length ? r.rec : "—"},` +
          ` "not recommended" marks on [${r.marked}]; the refit takes every usable pair (${r.ids})`);
      }

      // cancel path: a cancelled refit leaves the session unchanged
      await ev(() => document.getElementById("more-refit").click());
      await moreSettle(`/iteration/.test(window.__np3app.state.status)`, 300000);
      await ev(() => document.getElementById("more-cancel").click());
      const cx = await ev(() => {
        const s = window.__np3app.state;
        return { status: s.status, fitting: s.fitting, versions: s.versions.length, sel: s.selectedVersionId,
                 step: s.step, btn: document.getElementById("more-refit").disabled };
      });
      report(cx.status.startsWith("Refit cancelled") && !cx.fitting && cx.versions === v0.n
             && cx.sel === v0.sel && cx.step === "more" && !cx.btn,
        `8 stage 7: a cancelled refit leaves the session unchanged ("${cx.status}")`);

      // refit: exactly the displayed ids, the next _rN version, back to Compare, strength kept
      const shown = await ev(() => document.getElementById("more-refit").dataset.pairIds);
      await ev(() => document.getElementById("more-refit").click());
      await moreSettle(`window.__np3app.state.status.startsWith("Refit finished")
                        && window.__np3app.state.step === "compare"`, 900000);
      const rf = await ev(() => {
        const s = window.__np3app.state;
        const v = s.versions[s.versions.length - 1];
        return { n: s.versions.length, id: v.id, name: v.name, kind: v.kind, parentId: v.parentId,
                 pairIds: v.pairIds, ctlName: v.control.name, sel: s.selectedVersionId, step: s.step,
                 strength: s.strength, nParams: v.fitVector.length,
                 versionsJson: JSON.stringify(s.versions.slice(0, -1).map((x) => ({ id: x.id, control: x.control }))),
                 btn: !!document.querySelector(`#cmp-versions button[data-version="${v.id}"]`) };
      });
      report(rf.n === v0.n + 1 && rf.kind === "refit" && rf.name === `${v0.selName}_r1`
             && rf.ctlName === rf.name && !v0.names.includes(rf.name) && rf.parentId === v0.sel && rf.nParams === 56,
        `8 stage 7: the refit creates "${rf.name}" (id ${rf.id}, kind ${rf.kind}, parent ${rf.parentId})`);
      report(rf.pairIds.join(",") === shown && shown.split(",").length >= 2,
        `8 stage 7: the refit used exactly the displayed pair ids (${rf.pairIds} vs ${shown})`);
      report(rf.sel === rf.id && rf.step === "compare" && rf.strength === 80 && rf.btn
             && rf.versionsJson === v0.versionsJson,
        "8 stage 7: back on Compare with the new version selected, strength 80% kept, earlier versions unchanged");
      // the draft stays selectable and unchanged
      await ev(() => document.querySelector('#cmp-versions button[data-version="draft"]').click());
      const back = await ev(() => ({ sel: window.__np3app.state.selectedVersionId,
        json: JSON.stringify(window.__np3app.state.versions.slice(0, -1).map((x) => ({ id: x.id, control: x.control }))) }));
      report(back.sel === "draft" && back.json === v0.versionsJson,
        "8 stage 7: the draft stays selectable after the refit, unchanged");
      await ev(() => {
        const inp = document.getElementById("cmp-strength");
        inp.value = "100";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
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
}
