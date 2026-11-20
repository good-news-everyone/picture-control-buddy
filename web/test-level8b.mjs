// Level 8b of web/test.mjs: the full-flow / hardening level of spec/ui-plan.md stage 8 on the
// fitting wizard web/picture-control-jpg-fit.html. One sequential page flow over one fit and two refits:
//   Start -> Fit -> Compare -> Manual (an edit, undo/redo) -> More (leave warning, discard,
//   a second pair) -> Refit (cancel + immediate restart) -> select a version -> Save
//   (single NP3; no strength set — spec/ui.md decision #10),
// with the races (RAW decode, report, refit, version switches during LUT builds), the resource
// bookkeeping (object URLs, page Workers, ImageBitmaps) and the locality rule checked along the
// way. The other real pairs in _local/ (SKL_3024, SKL_3000, DSC_6550 — Python-valid) are
// prepared through the page, one page per pair: they must align and the compare geometry must
// reproduce the prepared frame (missing files skip).
// Level 8 stays as it is; 8b runs on its own page (spec/web-tests.md).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "./lib/np3.js";
import { scaled } from "./lib/strength.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const ROOT = path.dirname(HERE);                             // the project root
// data files: in the repository root or in _local/ (the static server maps both the same way)
const rootFile = (p) => {
  for (const c of [path.join(ROOT, p), path.join(ROOT, "_local", p)]) if (existsSync(c)) return c;
  return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Page helpers shared by the main flow and the probe pages.
function installHelpers() {
  const fileOf = async (url, name) => new File([await (await fetch(url)).arrayBuffer()], name);
  const dropFiles = (target, files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  };
  window.__t8b = window.__t8b || {};
  Object.assign(window.__t8b, {
    fileOf,
    dropOn: async (zone, url, name) => dropFiles(document.querySelector(zone), [await fileOf(url, name)]),
    dropDoc: (file) => dropFiles(document, [file]),
    // RAW first (decision #7): a JPEG goes onto its RAW's card
    dropOnCard: async (id, url, name, list = "pairs") =>
      dropFiles(document.querySelector(`#${list} .pair[data-pair-id="${id}"]`), [await fileOf(url, name)]),
    groupSlider: (group, idx, v) => {
      const inp = document.querySelectorAll(`#panel [data-group="${group}"] input[type=range]`)[idx];
      inp.value = v;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      return inp.value;
    },
    sliderInfo: (group, idx) => {
      const inp = document.querySelectorAll(`#panel [data-group="${group}"] input[type=range]`)[idx];
      return { v: +inp.value, min: +inp.min, max: +inp.max, step: +inp.step || 1 };
    },
    setStrength: (v) => {
      const inp = document.getElementById("cmp-strength");
      inp.value = String(v);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    },
    clickVersion: (id) => document.querySelector(`#cmp-versions button[data-version="${id}"]`).click(),
    snapCC: () => {
      const c = document.getElementById("cc");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let h = 0, sum = 0;
      for (let i = 0; i < d.length; i += 4097) { h = (h * 31 + d[i]) >>> 0; sum += d[i]; }
      return `${c.width}x${c.height}:${h}:${sum}`;
    },
    ctl: () => JSON.stringify(window.__np3app.state.control),
  });
}

// Resource bookkeeping, installed once the page is up (the four page Workers of app.js and the
// loader's RAW Worker exist by then — any page Worker created afterwards is growth). Downloads:
// a blob: anchor click with a download name is recorded instead of performed (the bytes are
// read back from the recorded Blob), everything else clicks as usual.
function installResourceHooks() {
  const T = { urls: new Map(), workers: 0, terminated: 0, bitmaps: 0, bitmapsClosed: 0, downloads: [] };
  window.__t8b.res = T;
  const oc = URL.createObjectURL.bind(URL), orv = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (o) => { const u = oc(o); T.urls.set(u, { revoked: false, blob: o }); return u; };
  URL.revokeObjectURL = (u) => { const e = T.urls.get(u); if (e) e.revoked = true; return orv(u); };
  const OW = window.Worker;
  window.Worker = class extends OW {
    constructor(...a) { super(...a); T.workers++; }
    terminate() { T.terminated++; return super.terminate(); }
  };
  const ocib = window.createImageBitmap.bind(window);
  window.createImageBitmap = async (...a) => {
    const b = await ocib(...a);
    T.bitmaps++;
    const close = b.close.bind(b);
    b.close = () => { T.bitmapsClosed++; close(); };
    return b;
  };
  const aclick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith("blob:")) {
      T.downloads.push({ name: this.download, href: this.href, blob: T.urls.get(this.href)?.blob ?? null });
      return;
    }
    return aclick.call(this);
  };
  window.__t8b.downloadBytes = async (i) => {
    const d = T.downloads[i];
    return { name: d.name, bytes: d.blob ? Array.from(new Uint8Array(await d.blob.arrayBuffer())) : null };
  };
}

export async function runLevel8b({ browser, port, report, skip }) {
  const need = ["test1/DSC_5584.NEF", "test1/DSC_5584.jpg"];
  if (need.some((p) => !rootFile(p))) {
    skip(`8b full flow: no RAW/JPEG pair (${need.join(", ")})`);
  } else {
    await mainFlow({ browser, port, report, skip });
  }
  await probe({ browser, port, report, skip });
}

async function mainFlow({ browser, port, report, skip }) {
  const page = await browser.newPage();
  const netBad = [];
  const pageErrors = [];
  const localHost = `127.0.0.1:${port}`;
  page.on("request", (r) => {
    // postData() is not supported in BiDi Firefox (it throws or returns undefined there)
    let body = null;
    try { body = r.postData?.() ?? null; } catch { body = null; }
    if (r.method() !== "GET") netBad.push(`${r.method()} ${r.url()}`);
    else if (body) netBad.push(`body ${r.url()}`);
    let u = null;
    try { u = new URL(r.url()); } catch { /* opaque */ }
    if (u && (u.protocol === "http:" || u.protocol === "https:") && u.host !== localHost)
      netBad.push(`host ${r.url()}`);
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`http://${localHost}/web/picture-control-jpg-fit.html`);
  await page.waitForFunction(`window.__np3app && window.__np3app.state.step === "start"`,
    { timeout: 120000, polling: 200 });
  const ev = (fn, ...args) => page.evaluate(fn, ...args);
  const wf = (cond, ms = 120000, polling = 200) => page.waitForFunction(cond, { timeout: ms, polling });
  await ev(installHelpers);
  await ev(installResourceHooks);
  const cmpSettle = async () => {
    await wf(`(() => { const c = window.__np3app.compare; const d = c.debug();
              return !c.pending && d.appliedGen === d.requestedGen; })()`, 300000, 50);
    await ev(() => window.__np3app.compare.draw());
  };
  // waits for pair 1's report at (version, strength) with the updating badge cleared;
  // resolves to null when it lands, to a diagnostic string when it does not (the caller FAILs)
  const reportAt = async (id, strength) => {
    try {
      await wf(`(() => { const r = window.__np3app.state.pairs[0].report;
                return r && r.id === ${JSON.stringify(id)} && r.summary.strength === ${strength}
                       && document.getElementById("rep-updating").hidden; })()`, 300000);
      return null;
    } catch {
      return ev(() => {
        const s = window.__np3app.state, r = s.pairs[0].report;
        return `report ${r ? `${r.id}@${r.summary.strength}` : "none"}, updating ${!document.getElementById("rep-updating").hidden},` +
               ` selected ${s.selectedVersionId}, strength ${s.strength}, status "${s.status}"`;
      });
    }
  };
  // a report that must land before the flow can go on
  const mustReport = async (id, strength, what) => {
    const diag = await reportAt(id, strength);
    if (diag) report(false, `8b ${what}: the report ${id}@${strength} did not land — ${diag}`);
    return !diag;
  };

  // ---------- 1. Start -> Fit -> Compare ----------
  await ev(() => window.__t8b.dropOn("#raw-drop", "/test1/DSC_5584.NEF", "DSC_5584.NEF"));
  await wf("window.__np3app.state.pairs[0] && window.__np3app.state.pairs[0].raw && !!window.__np3app.state.pairs[0].raw.image", 300000, 500);
  await ev(() => window.__t8b.dropOnCard(window.__np3app.state.pairs[0].id, "/test1/DSC_5584.jpg", "DSC_5584.jpg"));
  await wf("window.__np3app.state.pairs[0].target && !!window.__np3app.state.pairs[0].target.width", 120000);
  // the pair prepares by itself once both files are in (decision #7); Fit unlocks after it
  await wf("window.__np3app.state.pairs[0].prepared && !document.getElementById('fit').disabled", 600000, 500);
  await ev(() => document.getElementById("fit").click());
  await wf(`window.__np3app.state.versions.length === 1 && window.__np3app.state.step === "compare"`, 900000, 500);
  {
    const s = await ev(() => {
      const st = window.__np3app.state;
      return { id: st.versions[0].id, kind: st.versions[0].kind, pairIds: st.versions[0].pairIds,
               sel: st.selectedVersionId, ncc: st.pairs[0].prepared?.ncc ?? 0 };
    });
    report(s.id === "draft" && s.kind === "fit" && s.sel === "draft" && s.pairIds.join(",") === "1" && s.ncc > 0.7,
      `8b flow: Start -> Fit -> Compare, the draft over pair 1 (NCC ${s.ncc.toFixed(3)})`);
  }
  await cmpSettle();
  await mustReport("draft:1", 100, "flow");

  // ---------- 2. race (b): only the latest report applies ----------
  {
    await ev(() => {
      const T = window.__t8b;
      T.landed = [];
      let last = null;
      T.reportPoll = setInterval(() => {
        const r = window.__np3app.state.pairs[0].report;
        const k = r ? `${r.id}@${r.summary.strength}` : null;
        if (k !== last) { T.landed.push(k); last = k; }
      }, 10);
      for (const v of [40, 60, 85]) T.setStrength(v);
    });
    const miss1 = await reportAt("draft:1", 85);
    await sleep(1500);                         // a stale result would land after the latest one
    const landed = await ev(() => { clearInterval(window.__t8b.reportPoll); return window.__t8b.landed; });
    // the guarantee the code gives (app.js requestReport / reportWorker.onmessage): a
    // superseded request never posts to the worker and a stale result is discarded on
    // arrival, so after the burst only the latest key ("draft:1@85") can land at all.
    // Intermediates may be observed or not depending on where the supersession happens —
    // assert the strict invariant: the final key is observed and no different key lands
    // after it (not "exactly what a 10 ms poll happens to see").
    const from85 = landed.slice(Math.max(0, landed.indexOf("draft:1@85")));
    report(!miss1 && landed.includes("draft:1@85") && from85.every((k) => k === "draft:1@85"),
      `8b race: rapid strength changes — only the latest report lands (${landed.slice(1).join(" -> ")})${miss1 ? " — " + miss1 : ""}`);
    // a mixed version + strength burst ends on draft at 90%
    await ev(() => {
      const T = window.__t8b, s = window.__np3app.state;
      T.landed = [];
      let last = null;
      T.reportPoll = setInterval(() => {
        const r = s.pairs[0].report;
        const k = r ? `${r.id}@${r.summary.strength}` : null;
        if (k !== last) { T.landed.push(k); last = k; }
      }, 10);
      T.setStrength(55);
      T.setStrength(90);
    });
    const miss2 = await reportAt("draft:1", 90);
    await sleep(1500);
    const landed2 = await ev(() => { clearInterval(window.__t8b.reportPoll); return window.__t8b.landed; });
    // the same invariant as the first burst: the final key lands, nothing different after it
    const from90 = landed2.slice(Math.max(0, landed2.indexOf("draft:1@90")));
    report(!miss2 && landed2.includes("draft:1@90") && from90.every((k) => k === "draft:1@90"),
      `8b race: a second burst (55 -> 90) — only the latest report lands (${landed2.slice(1).join(" -> ")})${miss2 ? " — " + miss2 : ""}`);
    await ev(() => window.__t8b.setStrength(100));
    await mustReport("draft:1", 100, "race");
    await cmpSettle();
  }

  // ---------- 3. Manual: an edit, undo / redo in the real page ----------
  await ev(() => document.getElementById("cmp-manual").click());
  await wf(`window.__np3app.state.step === "edit" && !window.__np3app.state.renderPending`, 120000, 50);
  const key = async (mods, k) => {
    await ev(() => document.activeElement?.blur?.());
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(k);
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
    await sleep(50);
  };
  {
    const pick = async (idx) => {
      const s = await ev((i) => window.__t8b.sliderInfo("basic", i), idx);
      return s.v + 5 * s.step <= s.max ? s.v + 5 * s.step : s.v - 5 * s.step;
    };
    const c0 = await ev(() => window.__t8b.ctl());
    await ev((v) => window.__t8b.groupSlider("basic", 0, v), await pick(0));
    const c1 = await ev(() => window.__t8b.ctl());
    await key(["Control"], "KeyZ");
    const u1 = await ev(() => window.__t8b.ctl());
    await key(["Control", "Shift"], "KeyZ");
    const r1 = await ev(() => window.__t8b.ctl());
    await key(["Control"], "KeyZ");
    await key(["Control"], "KeyY");
    const r2 = await ev(() => window.__t8b.ctl());
    report(c1 !== c0 && u1 === c0 && r1 === c1 && r2 === c1,
      "8b redo: an edit, Ctrl+Z undoes it, Ctrl+Shift+Z and Ctrl+Y redo it");
    await key(["Control"], "KeyZ");
    await ev((v) => window.__t8b.groupSlider("basic", 1, v), await pick(1));
    const c2 = await ev(() => window.__t8b.ctl());
    const canRedo = await ev(() => window.__np3app.hist.canRedo);
    await key(["Control", "Shift"], "KeyZ");
    const c2b = await ev(() => window.__t8b.ctl());
    report(c2 !== c0 && c2 !== c1 && canRedo === false && c2b === c2,
      "8b redo: a new edit cuts off the redo future (Ctrl+Shift+Z changes nothing)");
    // Ctrl+Z inside the name field is the native input undo — the profile history is untouched
    const before = await ev(() => ({ ctl: window.__t8b.ctl(), idx: window.__np3app.hist.index }));
    await ev(() => document.querySelector('#panel [data-group="name"] input[type=text]').focus());
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyZ");
    await page.keyboard.up("Control");
    await sleep(50);
    const afterName = await ev(() => ({ ctl: window.__t8b.ctl(), idx: window.__np3app.hist.index,
                                         focus: document.activeElement?.type ?? null }));
    report(afterName.focus === "text" && afterName.ctl === before.ctl && afterName.idx === before.idx,
      "8b redo: Ctrl+Z in the name field is not taken by the profile history");
    await ev(() => document.activeElement?.blur?.());
  }

  // ---------- 4. Manual -> More: the leave warning, Discard ----------
  {
    const lw = await ev(() => {
      document.getElementById("ed-to-more").click();
      return { shown: !document.getElementById("leave-confirm").hidden, step: window.__np3app.state.step };
    });
    await ev(() => document.getElementById("leave-discard").click());
    await wf(`window.__np3app.state.step === "more"`, 60000);
    const d = await ev(() => {
      const s = window.__np3app.state;
      return { same: JSON.stringify(s.control) === JSON.stringify(s.versions[0].control),
               versions: s.versions.length };
    });
    report(lw.shown && lw.step === "edit" && d.same && d.versions === 1,
      "8b flow: Manual -> More asks first; Discard drops the edits, the version stays");
  }

  // ---------- 5. More: a second pair (a renamed copy — a pair known to prepare everywhere) ----------
  await ev(() => window.__t8b.dropOn("#more-raw-drop", "/test1/DSC_5584.NEF", "DSC_5584B.NEF"));
  await wf(`(() => { const p = window.__np3app.state.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF");
             return p && (p.raw === "error" || !!p.raw?.image); })()`, 600000, 500);
  await ev(() => window.__t8b.dropOnCard(
    window.__np3app.state.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF").id,
    "/test1/DSC_5584.jpg", "DSC_5584B.jpg", "more-pairs"));
  await wf(`(() => { const s = window.__np3app.state;
             const p = s.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF");
             return p && (p.raw === "error" || p.prepError || p.prepared?.blocked
                          || (p.prepared && s.advice && s.advice.candidates.includes(p.id) && s.advice.pending === 0)); })()`,
    900000, 250);
  const more = await ev(() => {
    const s = window.__np3app.state;
    const p = s.pairs.find((q) => q.rawFile?.name === "DSC_5584B.NEF");
    return { id: p.id, ncc: p.prepared?.ncc ?? 0, err: p.prepError ?? p.prepared?.blocked?.code ?? null,
             ids: document.getElementById("more-refit").dataset.pairIds };
  });
  report(more.ncc >= 0.6 && !more.err && more.ids.split(",").length === 2,
    `8b flow: More adds a second pair (NCC ${more.ncc.toFixed(3)}), the refit selection is ${more.ids}`);

  // ---------- 5b. Remove from fit (decision #7): while decoding, a RAW-only card, during a refit ----------
  {
    const v0 = await ev(() => JSON.stringify(window.__np3app.state.versions));
    // a RAW removed while it decodes: the card goes at once, the late decode lands nowhere
    await ev(() => window.__t8b.dropOn("#more-raw-drop", "/test1/DSC_5584.NEF", "DSC_5584E.NEF"));
    const e = await ev(() => {
      const s = window.__np3app.state;
      const p = s.pairs.find((q) => q.rawFile?.name === "DSC_5584E.NEF");
      const pending = p?.raw === "pending";
      document.querySelector(`#more-pairs .pair[data-pair-id="${p.id}"] .pair-remove`).click();
      return { pending, gone: !s.pairs.includes(p) && !document.querySelector(`#more-pairs .pair[data-pair-id="${p.id}"]`) };
    });
    await wf(`!window.__np3app.state.pairs.some((p) => p.raw === "pending")`, 600000, 300);
    await sleep(1000);
    const e2 = await ev(() => ({ names: window.__np3app.state.pairs.map((p) => p.rawFile.name),
                                 raw: window.__np3app.state.raw?.name ?? null }));
    report(e.pending && e.gone && !e2.names.includes("DSC_5584E.NEF") && e2.raw !== "DSC_5584E.NEF",
      `8b remove: a RAW removed while it decodes is gone for good (pairs ${e2.names.join(", ")})`);
    // a RAW-only card is not fitted and is counted as skipped
    await ev(() => window.__t8b.dropOn("#more-raw-drop", "/test1/DSC_5584.NEF", "DSC_5584D.NEF"));
    await wf(`(() => { const p = window.__np3app.state.pairs.find((q) => q.rawFile?.name === "DSC_5584D.NEF");
               return p && !!p.raw?.image; })()`, 600000, 300);
    const d = await ev(() => ({ ids: document.getElementById("more-refit").dataset.pairIds,
                                txt: document.getElementById("more-refit-ids").textContent }));
    report(d.ids.split(",").length === 2 && /1 without a JPEG, 0 blocked — skipped/.test(d.txt),
      `8b remove: a RAW-only card stays out of the refit ("${d.txt}")`);
    // removing a card during a refit cancels the refit; the versions stay
    await ev(() => document.getElementById("more-refit").click());
    await wf(`/iteration/.test(window.__np3app.state.status)`, 600000, 100);
    const r = await ev(() => {
      const s = window.__np3app.state;
      const p = s.pairs.find((q) => q.rawFile?.name === "DSC_5584D.NEF");
      document.querySelector(`#more-pairs .pair[data-pair-id="${p.id}"] .pair-remove`).click();
      return { status: s.status, fitting: s.fitting, n: s.pairs.length };
    });
    await sleep(2000);                         // a late result of the cancelled refit would land here
    const after = await ev(() => JSON.stringify(window.__np3app.state.versions));
    report(r.status.startsWith("Refit cancelled") && !r.fitting && r.n === 2 && after === v0,
      `8b remove: removing a card during a refit cancels it, the versions are unchanged ("${r.status}")`);
  }

  // ---------- 6. race (c): cancel a refit mid-LM, start another at once ----------
  {
    const v0 = await ev(() => {
      const s = window.__np3app.state;
      return { n: s.versions.length, sel: s.selectedVersionId,
               selName: s.versions.find((v) => v.id === s.selectedVersionId).name,
               json: JSON.stringify(s.versions) };
    });
    await ev(() => document.getElementById("more-refit").click());
    await wf(`/iteration/.test(window.__np3app.state.status)`, 600000, 100);
    const mid = await ev(() => {
      document.getElementById("more-cancel").click();
      const cancelled = window.__np3app.state.status;
      document.getElementById("more-refit").click();
      return { cancelled, fitting: window.__np3app.state.fitting };
    });
    await wf(`window.__np3app.state.status.startsWith("Refit finished") && window.__np3app.state.step === "compare"`,
      1200000, 500);
    await sleep(2000);                         // a late result of the cancelled run would land here
    const rf = await ev(() => {
      const s = window.__np3app.state;
      const v = s.versions[s.versions.length - 1];
      return { n: s.versions.length, id: v.id, name: v.name, kind: v.kind, parentId: v.parentId,
               pairIds: v.pairIds, sel: s.selectedVersionId, step: s.step,
               firstJson: JSON.stringify(s.versions.slice(0, -1)) };
    });
    report(mid.cancelled.startsWith("Refit cancelled") && mid.fitting === true,
      `8b race: cancel mid-LM then refit at once — the second refit starts ("${mid.cancelled}")`);
    report(rf.n === v0.n + 1 && rf.name === `${v0.selName}_r1` && rf.kind === "refit" && rf.parentId === v0.sel
           && rf.pairIds.length === 2 && rf.sel === rf.id && rf.firstJson === v0.json,
      `8b race: exactly one new version "${rf.name}" (id ${rf.id}) over ${rf.pairIds}, no orphan, earlier versions unchanged`);
  }

  // ---------- 7. race (d): version switches while the LUTs build ----------
  {
    await cmpSettle();
    const ids = await ev(() => window.__np3app.state.versions.map((v) => v.id));
    const [d, r] = [ids[0], ids[ids.length - 1]];
    // a new strength: every version needs a fresh LUT, so the switches race the builds
    await ev((args) => {
      const T = window.__t8b;
      T.setStrength(65);   // a multiple of the slider step (5)
      for (const id of [args.r, args.d, args.r, args.d, args.r]) T.clickVersion(id);
    }, { d, r });
    await cmpSettle();
    const race = await ev(() => ({ snap: window.__t8b.snapCC(), sel: window.__np3app.state.selectedVersionId }));
    const miss = await reportAt(`${r}:1`, 65);
    report(!miss, `8b race: rapid version switches — the report of the last selected version lands (${r}@65)${miss ? " — " + miss : ""}`);
    await ev((id) => window.__t8b.clickVersion(id), d);
    await cmpSettle();
    const snapD = await ev(() => window.__t8b.snapCC());
    await ev((id) => window.__t8b.clickVersion(id), r);
    await cmpSettle();
    const snapR = await ev(() => window.__t8b.snapCC());
    if (snapD === snapR) {
      skip(`8b race: version switches during LUT builds — ${d} and ${r} render identically, nothing to tell apart`);
    } else {
      report(race.sel === r && race.snap === snapR,
        `8b race: rapid version switches during LUT builds — the screen shows the last selected version (${r})`);
    }
  }

  // ---------- 8. select a version -> Save (single NP3; no strength-set control) ----------
  {
    await ev(() => window.__t8b.clickVersion("draft"));
    await ev(() => window.__t8b.setStrength(70));
    await cmpSettle();
    await ev(() => document.getElementById("cmp-manual").click());
    await wf(`window.__np3app.state.step === "edit" && !window.__np3app.state.renderPending`, 120000, 50);
    const st = await ev(() => {
      const s = window.__np3app.state;
      return { strength: s.strength, sel: s.selectedVersionId,
               vctl: s.versions.find((v) => v.id === s.selectedVersionId).control,
               same: JSON.stringify(s.control) === JSON.stringify(s.versions.find((v) => v.id === s.selectedVersionId).control),
               n0: window.__t8b.res.downloads.length };
    });
    await ev(() => document.getElementById("export").click());
    await wf(`window.__t8b.res.downloads.length >= ${st.n0 + 1}`, 15000, 50);
    const single = await ev((i) => window.__t8b.downloadBytes(i), st.n0);
    const want = serialize({ ...scaled(st.vctl, 70), name: st.vctl.name });
    report(st.sel === "draft" && st.strength === 70 && st.same && single.name === `${st.vctl.name}.NP3`
           && single.bytes && eqBytes(Uint8Array.from(single.bytes), want),
      `8b save: #export writes "${single.name}" = serialize(scaled(draft, 70%)) byte for byte`);

    const noSet = await ev(() => !document.getElementById("export-set")
      && ![...document.querySelectorAll("button")].some((b) => /strength set/i.test(b.textContent)));
    report(noSet, "8b save: no strength-set export control on the page (spec/ui.md decision #10)");
  }

  // ---------- 9. race (a) moved: two RAWs dropped in a row in the editor is the profile editor
  //     page's behavior now (spec/ui-pages.md) — level 8e, criterion 9. In the wizard a RAW
  //     becomes a card (stage 9). ----------

  // ---------- 10. resources ----------
  {
    await sleep(5500);                        // transfer.js revokes a download URL after 5 s
    const r = await ev(() => {
      const T = window.__t8b.res;
      const urls = [...T.urls.entries()];
      return { created: urls.length, open: urls.filter(([, e]) => !e.revoked).map(([u]) => u),
               workers: T.workers, terminated: T.terminated, bitmaps: T.bitmaps, closed: T.bitmapsClosed,
               downloads: T.downloads.length };
    });
    report(r.created >= 1 && r.open.length === 0,
      `8b resources: every object URL is revoked (${r.created} created, ${r.open.length} open)`);
    report(r.workers === 0,
      `8b resources: no page Worker is created across the fit, two refits, reports and decodes (${r.workers} new, ${r.terminated} terminated)`);
    report(r.bitmaps === r.closed,
      `8b resources: every main-thread ImageBitmap is closed (${r.closed} of ${r.bitmaps})`);
  }

  // ---------- 11. locality and errors ----------
  report(netBad.length === 0,
    `8b locality: static GET only, no request bodies, no other hosts${netBad.length ? " — " + netBad.join("; ") : ""}`);
  report(pageErrors.length === 0,
    `8b page without JS errors${pageErrors.length ? " — " + pageErrors.join("; ") : ""}`);
  await page.close();
}

// ---------- stage-2 preparation on the other real pairs (Python-valid, so they must align) ----------
// Each pair present in _local/ is prepared through the real page path (the pair Worker). Python
// (devpairs.build) aligns all three, so the NCC must reach the block threshold (0.6). The second
// check is the orientation contract between the Worker and the compare render side: the page's
// RAW frame put through warpToWorking with the app's unrotate (render.TURNS undone, as
// renderCompareSide does) must reproduce the prepared x — a Worker that drops `unrotate`
// (2026-11-20: portrait NEF/DNG compared rotated by 90°, SKL_3024 NCC 0.05) fails both checks.
// Missing files skip.
async function probe({ browser, port, report, skip }) {
  const cases = [
    { stem: "SKL_3024", raw: "test2/SKL_3024.dng", target: "test2/SKL_3024.jpg" },
    { stem: "SKL_3000", raw: "test2/SKL_3000.dng", target: "test2/SKL_3000.jpg" },
    { stem: "DSC_6550", raw: "_cloud_transfer/r_lr_test_DSC_6550.NEF", target: "_cloud_transfer/j_lr_DSC_6550.jpg" },
  ];
  for (const c of cases) {
    if (!rootFile(c.raw) || !rootFile(c.target)) {
      skip(`8b pairs ${c.stem}: no files (${c.raw}, ${c.target})`);
      continue;
    }
    const t0 = Date.now();
    let page = null;
    try {
      page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/web/picture-control-jpg-fit.html`);
      await page.waitForFunction(`window.__np3app && window.__np3app.state.step === "start"`,
        { timeout: 120000, polling: 200 });
      await page.evaluate(installHelpers);
      const ext = path.extname(c.raw);
      await page.evaluate((a) => window.__t8b.dropOn("#raw-drop", `/${a.raw}`, `${a.stem}${a.ext}`),
        { raw: c.raw, stem: c.stem, ext });
      await page.waitForFunction(`(() => { const p = window.__np3app.state.pairs[0];
          return p && (p.raw === "error" || !!p.raw?.image); })()`, { timeout: 600000, polling: 500 });
      await page.evaluate((a) => window.__t8b.dropOnCard(window.__np3app.state.pairs[0].id, `/${a.target}`, `${a.stem}.jpg`), c);
      await page.waitForFunction(`(() => { const s = window.__np3app.state, p = s.pairs[0];
          return p && p.target !== "pending"; })()`, { timeout: 300000, polling: 300 });
      const pre = await page.evaluate(() => {
        const s = window.__np3app.state, p = s.pairs[0];
        return { raw: p.raw === "error" ? `error ${p.rawError ?? ""}` : `${p.raw.image.w}x${p.raw.image.h}`,
                 target: p.target?.width ? `${p.target.width}x${p.target.height}` : `none ("${s.status}")`,
                 ready: !!p.raw?.image && !!p.target?.width };
      });
      if (!pre.ready) {
        report(false, `8b pairs ${c.stem}: RAW ${pre.raw}, target ${pre.target} — the pair did not decode`);
        continue;
      }
      const r = await page.evaluate(async () => {
        const A = window.__np3app, p = A.state.pairs[0];
        // the card prepares by itself (decision #7): wait for its terminal state
        while (p.preparing || (!p.prepared && !p.prepError && !p.fitBlocked)) await new Promise((r) => setTimeout(r, 300));
        if (p.prepError) return { err: `prepError "${p.prepError}"` };
        if (!p.prepared) return { err: "no result" };
        const P = await import("./lib/pair-prepare.js");
        const TURNS = { 3: 2, 6: 3, 8: 1 };               // render.TURNS (app.js DECODER_TURNS)
        const unr = (4 - (TURNS[p.raw.info.orientation] ?? 0)) % 4;
        const img = p.raw.image;
        const g = P.warpToWorking({ data: img.rgb, w: img.w, h: img.h }, p.prepared, unr).data;
        const x = p.prepared.x;
        if (g.length !== x.length) return { ncc: p.prepared.ncc, blocked: p.prepared.blocked?.code, corr: null,
                                            orient: p.raw.info.orientation };
        // luminance correlation (gain-free)
        let sa = 0, sb = 0, n = g.length / 3;
        const la = new Float64Array(n), lb = new Float64Array(n);
        for (let i = 0, j = 0; i < n; i++, j += 3) {
          la[i] = g[j] + g[j + 1] + g[j + 2]; lb[i] = x[j] + x[j + 1] + x[j + 2]; sa += la[i]; sb += lb[i];
        }
        sa /= n; sb /= n;
        let ab = 0, aa = 0, bb = 0;
        for (let i = 0; i < n; i++) { const a = la[i] - sa, b = lb[i] - sb; ab += a * b; aa += a * a; bb += b * b; }
        return { ncc: p.prepared.ncc, blocked: p.prepared.blocked?.code, corr: ab / Math.sqrt(aa * bb),
                 orient: p.raw.info.orientation };
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (r.err) { report(false, `8b pairs ${c.stem}: ${r.err} — ${secs}s`); continue; }
      report(r.ncc >= 0.6 && !r.blocked,
        `8b pairs ${c.stem}: RAW ${pre.raw} (EXIF orientation ${r.orient}), target ${pre.target} aligns, NCC ${r.ncc.toFixed(3)}` +
        `${r.blocked ? `, blocked ${r.blocked}` : ""} — ${secs}s`);
      report(r.corr !== null && r.corr > 0.98,
        `8b pairs ${c.stem}: the compare geometry reproduces the prepared frame (luminance correlation ` +
        `${r.corr === null ? "n/a — size mismatch" : r.corr.toFixed(4)})`);
    } catch (e) {
      report(false, `8b pairs ${c.stem}: error ${e.message}`);
    } finally {
      await page?.close().catch(() => {});
    }
  }
}
