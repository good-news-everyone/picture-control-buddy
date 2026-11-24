// viewRemap's window option (level 1n, proposed for the zoom plan, spec/ui-zoom-plan.md Z3):
// a window map must equal the full map's values at the same output pixels, bit for bit, and an
// invalid window must throw. Standalone: node test-node-viewremap-window.mjs (exit 1 on failure).
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePair, viewRemap } from "./lib/pair-prepare.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const pdir = path.join(HERE, "golden", "pair");

async function pbytes(rel) {
  let b = await readFile(path.join(HERE, "golden", rel));
  if (rel.endsWith(".br")) b = brotliDecompressSync(b);
  return b;
}

// the same preparePair inputs as level 1e (test-node.mjs)
async function loadPrepared(key) {
  const inj = JSON.parse(await readFile(path.join(pdir, `${key}.in.json`), "utf8"));
  const linB = await pbytes(inj.inputs.linear.file);
  const embB = await pbytes(inj.inputs.embedded.file);
  const tgtB = await pbytes(inj.inputs.target.file);
  const prep = await preparePair({
    linear: new Float32Array(linB.buffer, linB.byteOffset, linB.byteLength / 4),
    lw: inj.inputs.linear.w, lh: inj.inputs.linear.h,
    unrotate: inj.inputs.linear.unrotate,
    targetU8: new Uint8Array(tgtB.buffer, tgtB.byteOffset, tgtB.byteLength),
    tw: inj.inputs.target.w, th: inj.inputs.target.h,
    xmp: { ...inj.inputs.xmp, _masks: inj.inputs.xmpMasks }, rawBytes: new Uint8Array(0),
    gain: inj.inputs.gain, gainNote: inj.inputs.gainNote,
    embedded: { data: new Uint8Array(embB.buffer, embB.byteOffset, embB.byteLength),
                w: inj.inputs.embedded.w, h: inj.inputs.embedded.h },
    onProgress: () => {},
  });
  if (!prep) throw new Error(`${key}: preparePair returned null`);
  return { prep, lw: inj.inputs.linear.w, lh: inj.inputs.linear.h, unrotate: inj.inputs.linear.unrotate };
}

// synthetic variants of a real preparation: only the transform / vignette fields change
const SYN_CROP = { hasCrop: true, left: 0.06, top: 0.05, right: 0.94, bottom: 0.92, angleDeg: 3.5, angleSign: 1 };
const SYN_GEOM = { radialK: 0.035, radialScale: 1.02, warpScale: 0.985, shiftX: 4.3, shiftY: -2.6,
                   lensRadial: { scale: 1.01, k: 0.02 } };
const SYN_VIG = { a: 0.3, b: -0.1 };
const withTransform = (prep, tr = {}, vig = null) => ({
  ...prep,
  transform: { ...prep.transform, ...tr },
  vignette: vig ? { ...prep.vignette, ...vig } : prep.vignette,
});
// the raw frame size for an unrotate value: odd turns swap the frame's width and height
const frameSize = (lw, lh, unr) => (unr % 2 ? [lh, lw] : [lw, lh]);

const failures = [];
let nCases = 0, nWindows = 0, nPixels = 0;

function checkCase(label, prep, fw, fh, unr, opts) {
  nCases++;
  const full = viewRemap(prep, fw, fh, unr, opts);
  const OW = full.w, OH = full.h;
  const bad = [];
  if (full.fullW !== OW || full.fullH !== OH || full.x0 !== 0 || full.y0 !== 0)
    bad.push(`no-window fields fullW/fullH/x0/y0 ${full.fullW}/${full.fullH}/${full.x0}/${full.y0}`);
  if (full.sx.length !== OW * OH || full.sy.length !== OW * OH || full.g.length !== OW * OH)
    bad.push("no-window array length");
  const ix = Math.floor(OW / 3), iy = Math.floor(OH / 3);
  const windows = [
    ["top-left corner", { x0: 0, y0: 0, w: 1, h: 1 }],
    ["top-right corner", { x0: OW - 1, y0: 0, w: 1, h: 1 }],
    ["bottom-left corner", { x0: 0, y0: OH - 1, w: 1, h: 1 }],
    ["bottom-right corner", { x0: OW - 1, y0: OH - 1, w: 1, h: 1 }],
    ["interior block", { x0: ix, y0: iy, w: Math.min(37, OW - ix), h: Math.min(23, OH - iy) }],
    ["interior 1x1", { x0: OW >> 1, y0: OH >> 1, w: 1, h: 1 }],
    ["full-width strip", { x0: 0, y0: Math.floor(OH / 2), w: OW, h: Math.min(5, OH - Math.floor(OH / 2)) }],
    ["whole grid", { x0: 0, y0: 0, w: OW, h: OH }],
  ];
  const U = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length);
  const F = { sx: U(full.sx), sy: U(full.sy), g: U(full.g) };
  const notes = [];
  for (const [name, win] of windows) {
    nWindows++;
    const r = viewRemap(prep, fw, fh, unr, { ...opts, window: win });
    const { x0, y0, w, h } = win;
    if (r.w !== w || r.h !== h || r.x0 !== x0 || r.y0 !== y0 || r.fullW !== OW || r.fullH !== OH || r.k !== full.k)
      bad.push(`${name}: fields`);
    if (r.sx.length !== w * h || r.sy.length !== w * h || r.g.length !== w * h) {
      bad.push(`${name}: length`);
      continue;
    }
    const R = { sx: U(r.sx), sy: U(r.sy), g: U(r.g) };
    let mism = 0;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const li = yy * w + xx, fi = (y0 + yy) * OW + (x0 + xx);
        for (const c of ["sx", "sy", "g"]) if (R[c][li] !== F[c][fi]) mism++;
        nPixels++;
      }
    }
    if (mism) bad.push(`${name}: ${mism} values differ from the full map`);
    if (name === "whole grid" && bad.length === 0) notes.push("whole grid identical");
  }
  const ok = bad.length === 0;
  if (!ok) failures.push(`${label}: ${bad.join("; ")}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label} (${OW}x${OH} grid, k ${full.k.toFixed(3)})`
              + (bad.length ? ` - ${bad.join("; ")}` : ""));
}

function checkInvalid(prep, fw, fh, unr, OW, OH) {
  const bad = [
    { x0: -1, y0: 0, w: 1, h: 1 },
    { x0: 0, y0: -1, w: 1, h: 1 },
    { x0: 0, y0: 0, w: 0, h: 1 },
    { x0: 0, y0: 0, w: 1, h: -2 },
    { x0: OW, y0: 0, w: 1, h: 1 },
    { x0: 0, y0: OH, w: 1, h: 1 },
    { x0: 0, y0: 0, w: OW + 1, h: 1 },
    { x0: 0, y0: OH - 1, w: 1, h: 2 },
    { x0: 0.5, y0: 0, w: 1, h: 1 },
    { x0: 0, y0: 0, w: NaN, h: 1 },
    { x0: 0, y0: 0, w: Infinity, h: 1 },
    { x0: 0, y0: 0, w: "2", h: 1 },
    {},
  ];
  let thrown = 0;
  for (const win of bad) {
    try {
      viewRemap(prep, fw, fh, unr, { window: win });
      failures.push(`invalid window ${JSON.stringify(win)} did not throw`);
    } catch (e) {
      if (e instanceof Error) thrown++;
      else failures.push(`invalid window ${JSON.stringify(win)} threw a non-Error`);
    }
  }
  const ok = thrown === bad.length;
  console.log(`${ok ? "ok  " : "FAIL"} invalid windows throw: ${thrown}/${bad.length}`);
}

// --- cases ---------------------------------------------------------------------------------
for (const key of ["dsc_6550", "skl_3024"]) {
  const { prep: base, lw, lh, unrotate } = await loadPrepared(key);
  const [fw, fh] = frameSize(lw, lh, unrotate);
  const fitted = base.transform.crop ?? {};
  const variants = [
    ["as fitted", base, {}],
    ["no crop", withTransform(base, { crop: { ...fitted, hasCrop: false } }), {}],
    ["crop 3.5 deg", withTransform(base, { crop: SYN_CROP }), {}],
    ["crop -4 deg, sign -1", withTransform(base, { crop: { ...SYN_CROP, angleDeg: 4, angleSign: -1 } }), {}],
    ["all knobs", withTransform(base, { ...SYN_GEOM, crop: SYN_CROP }, SYN_VIG), {}],
  ];
  for (let o = 0; o < 4; o++) {
    variants.push([`orientation ${o} + crop`, withTransform(base, { orientation: o, crop: SYN_CROP }), {}]);
  }
  for (const [label, prep, opts] of variants) {
    checkCase(`${key} ${label}, unrotate ${unrotate}`, prep, fw, fh, unrotate, opts);
  }
  // every unrotate value with swapped frame sizes, on the all-knobs variant
  const knobs = withTransform(base, { ...SYN_GEOM, crop: SYN_CROP }, SYN_VIG);
  for (let unr = 0; unr < 4; unr++) {
    const [uw, uh] = frameSize(lw, lh, unr);
    for (const [kl, k] of [["default k", null], ["k 1", 1], ["k 3", 3]]) {
      checkCase(`${key} all knobs, unrotate ${unr}, ${kl}`, knobs, uw, uh, unr, { k });
    }
  }
  // invalid windows, on the fitted geometry (grid size from its default k)
  const probe = viewRemap(base, fw, fh, unrotate);
  checkInvalid(base, fw, fh, unrotate, probe.w, probe.h);
}

console.log(`\n${nCases} cases, ${nWindows} windows, ${nPixels} window pixels compared against the full map`);
if (failures.length) {
  console.log(`FAILED: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("all viewRemap window checks passed");
}
