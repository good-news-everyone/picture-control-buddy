// The zoom geometry (lib/zoom-plan.js, spec/ui-zoom-plan.md Z3): for the golden pairs' real preparations
// (and synthetic crop / geometry / vignette / decoder-orientation variants, as test-node-viewremap-window.mjs)
// the ROI plan's source positions must agree with the compare map (viewRemap at its default k) at the
// same working point; the unrotated rectangle for the decoder must contain every source px the gather
// reads; the rotation of a returned ROI must equal np.rot90 of the whole frame; the readout factor and the
// lowRes affine must be consistent with both maps. Standalone: node test-node-zoom-plan.mjs (exit 1 on failure).
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePair, viewRemap } from "./lib/pair-prepare.js";
import { frameGeometry, levelFrame, planRegion, sensorPerWorking, toUnrotated, unrotatedRect, rotateRegion,
         pickLevel, visibleRect, rectContains, detailMargin, ROI_MAX_PX } from "./lib/zoom-plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const pdir = path.join(HERE, "golden", "pair");
const K = 2;                       // the decoder's shrink (Z f: 1600 long side)
// Source agreement tolerance (main-frame px). Without an XMP crop the two viewRemap calls (the compare map
// on the decoded frame, the zoom map on the level frame) agree to 0.02 px in the interior; windows touching
// the image edge differ by up to ~0.45 (viewRemap clamps the radial warp's source to the frame at the main
// grid's own resolution). With a crop, viewRemap truncates the crop origin and size to whole frame px: up to
// 1 px per axis at the main scale (the compare map's own error; the level frame truncates 2-4x finer), so
// the two differ by up to ~1.4 px plus the edge effect (median ~0.5-1.0; measured max 1.74, rotated crop at a corner).
const TOL_NOCROP = { max: 0.5, median: 0.1 };
const TOL_CROP = { max: 1.9, median: 1.1 };
const TOL_STEP = 0.10;             // level px per grid px
// relative: readout factor of the main map (the middle row's mean step) vs the local step of the zoom window
// (a window's middle row); the radial / lens warps change the local scale by ~3-4% (synthetic knobs ~3%)
const TOL_SPW = 0.05;

async function pbytes(rel) {
  let b = await readFile(path.join(HERE, "golden", rel));
  if (rel.endsWith(".br")) b = brotliDecompressSync(b);
  return b;
}
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
  return { prep, lw: inj.inputs.linear.w, lh: inj.inputs.linear.h };
}

const SYN_CROP = { hasCrop: true, left: 0.06, top: 0.05, right: 0.94, bottom: 0.92, angleDeg: 3.5, angleSign: 1 };
const SYN_GEOM = { radialK: 0.035, radialScale: 1.02, warpScale: 0.985, shiftX: 4.3, shiftY: -2.6,
                   lensRadial: { scale: 1.01, k: 0.02 } };
const SYN_VIG = { a: 0.3, b: -0.1 };
const withTransform = (prep, tr = {}, vig = null) => ({
  ...prep, transform: { ...prep.transform, ...tr },
  vignette: vig ? { ...prep.vignette, ...vig } : prep.vignette,
});
const ORIENT = [1, 8, 3, 6];        // EXIF orientation of the RAW -> decoder turns 0, 1, 2, 3

const failures = [];
const fail = (m) => { failures.push(m); console.log(`FAIL ${m}`); };
const ok = (m) => console.log(`ok   ${m}`);
let nPlans = 0, nSamples = 0, worstMax = 0, worstMedian = 0, worstStep = 0, worstSpw = 0;

// the compare map's source at a working point (bilinear between its grid px), decoded main-frame indices
function mainSource(mm, W, H, wx, wy) {
  const gx = wx * mm.w / W - 0.5, gy = wy * mm.h / H - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= mm.w || y0 + 1 >= mm.h) return null;
  const fx = gx - x0, fy = gy - y0;
  let sx = 0, sy = 0;
  for (const [dx, dy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
    const i = (y0 + dy) * mm.w + x0 + dx;
    if (mm.sx[i] !== mm.sx[i]) return null;
    sx += wgt * mm.sx[i]; sy += wgt * mm.sy[i];
  }
  return [sx, sy];
}

function checkPlan(label, prep, T, level, rectFrac, expectEmpty = false) {
  const W = prep.size.w, H = prep.size.h;
  const dw0 = 1512, dh0 = 1008;                      // a Z f decode at long = 1600 (k = 2)
  const dw = T % 2 ? dh0 : dw0, dh = T % 2 ? dw0 : dh0;   // decoded orientation: odd turns swap
  const geom = frameGeometry({ w: dw, h: dh, k: K, orientation: ORIENT[T] });
  const lf1 = levelFrame(geom, 1);
  const unrotate = (4 - T) % 4;
  const mm = viewRemap(prep, dw, dh, unrotate);
  const spw = sensorPerWorking(mm, geom, W);
  const rect = { x: rectFrac[0] * W, y: rectFrac[1] * H, w: rectFrac[2] * W, h: rectFrac[3] * H };
  const hold = [lf1.ufw + 8, lf1.ufh + 6];           // the held area is a little larger than the decoded frame
  const plan = planRegion({ prepared: prep, geom, level, rect, spw, hold, lowRes: true });
  nPlans++;
  const tag = `${label} T${T} L${level} rect ${rectFrac.join("/")}`;
  if (plan.empty || plan.tooLarge) {
    if (expectEmpty) return ok(`${tag}: ${plan.empty ? "empty" : "too large"} as expected`);
    return fail(`${tag}: no plan (${plan.empty ? "empty" : "too large"})`);
  }
  if (expectEmpty) return fail(`${tag}: a plan was expected to be refused`);
  const lf = levelFrame(geom, level);
  const bad = [];
  if (plan.px > ROI_MAX_PX && plan.pad > 0) bad.push(`padded px ${plan.px} > cap`);
  // the working rectangle the output covers contains the visible rect (clipped to the image)
  const clipped = { x: Math.max(0, rect.x), y: Math.max(0, rect.y),
                    w: Math.min(W, rect.x + rect.w) - Math.max(0, rect.x), h: Math.min(H, rect.y + rect.h) - Math.max(0, rect.y) };
  if (!rectContains(plan.rect, clipped, 1e-6)) bad.push("plan.rect does not contain the visible rect");
  // the roi is inside the held area and the level frame
  if (plan.roi.x < 0 || plan.roi.y < 0 || plan.roi.x + plan.roi.w > lf.ufw || plan.roi.y + plan.roi.h > lf.ufh)
    bad.push(`roi ${JSON.stringify(plan.roi)} outside the level frame ${lf.ufw}x${lf.ufh}`);
  if (plan.roi.x + plan.roi.w > hold[0] / lf.sensorPerLevel || plan.roi.y + plan.roi.h > hold[1] / lf.sensorPerLevel)
    bad.push("roi outside the held area");
  const map = plan.map, OW = map.fullW, OH = map.fullH;
  const aff = plan.lowRes.affine;
  const diffs = [];
  let nOutside = 0, nContainedBad = 0, nSrc = 0;
  const stride = Math.max(1, Math.floor(map.w * map.h / 4000));
  for (let i = 0; i < map.w * map.h; i += i % 7 === 0 ? 1 : stride) {   // all of every 7th... plus the stride
    const u = map.sx[i];
    if (u !== u) continue;
    const v = map.sy[i];
    nSrc++;
    // the gather's taps (region indices -> decoded level frame -> unrotated) lie in the roi
    if (i % stride === 0) {
      const fx = Math.floor(u + plan.region.x), fy = Math.floor(v + plan.region.y);
      for (let a = -1; a <= 2; a++) for (let c = -1; c <= 2; c++) {
        const tx = Math.max(0, Math.min(lf.fw - 1, fx + c)), ty = Math.max(0, Math.min(lf.fh - 1, fy + a));
        const [ux, uy] = toUnrotated(T, lf.ufw, lf.ufh, tx, ty);
        if (ux < plan.roi.x || uy < plan.roi.y || ux >= plan.roi.x + plan.roi.w || uy >= plan.roi.y + plan.roi.h) nContainedBad++;
      }
      // the tap is inside the rendered region (the gather reads region indices 0..w-1)
      if (u < 0 || v < 0 || u > plan.region.w - 1 || v > plan.region.h - 1) nOutside++;
    }
    // the position agrees with the compare map at the same working point
    const gx = plan.window.x0 + (i % map.w), gy = plan.window.y0 + Math.floor(i / map.w);
    const wx = (gx + 0.5) * W / OW, wy = (gy + 0.5) * H / OH;
    const ms = mainSource(mm, W, H, wx, wy);
    if (!ms) continue;
    const mxc = aff[0] * (u + 0.5) + aff[1] * (v + 0.5) + aff[2], myc = aff[3] * (u + 0.5) + aff[4] * (v + 0.5) + aff[5];
    diffs.push(Math.hypot(mxc - 0.5 - ms[0], myc - 0.5 - ms[1]));
  }
  if (nContainedBad) bad.push(`${nContainedBad} gather taps outside the unrotated roi`);
  if (nOutside) bad.push(`${nOutside} sources outside the region`);
  diffs.sort((p, q) => p - q);
  const dmax = diffs[diffs.length - 1] ?? 0, dmed = diffs[diffs.length >> 1] ?? 0;
  nSamples += diffs.length;
  worstMax = Math.max(worstMax, dmax); worstMedian = Math.max(worstMedian, dmed);
  if (!diffs.length) bad.push("no samples compared with the compare map");
  const tol = prep.transform.crop?.hasCrop ? TOL_CROP : TOL_NOCROP;
  if (dmax > tol.max) bad.push(`source differs from the compare map by up to ${dmax.toFixed(2)} main px`);
  if (dmed > tol.median) bad.push(`median source difference ${dmed.toFixed(2)} main px`);
  // one grid px = one level px; the readout factor agrees between the two maps
  const r = Math.floor(map.h / 2) * map.w;
  let a = -1, b = -1;
  for (let x = 0; x < map.w; x++) if (map.sx[r + x] === map.sx[r + x]) { if (a < 0) a = x; b = x; }
  if (b > a) {
    const step = Math.hypot(map.sx[r + b] - map.sx[r + a], map.sy[r + b] - map.sy[r + a]) / (b - a);
    worstStep = Math.max(worstStep, Math.abs(step - 1));
    if (Math.abs(step - 1) > TOL_STEP) bad.push(`level px per grid px ${step.toFixed(3)}`);
    const spwZoom = step * (OW / W) * lf.sensorPerLevel;
    const rel = Math.abs(spwZoom / spw - 1);
    worstSpw = Math.max(worstSpw, rel);
    if (rel > TOL_SPW) bad.push(`sensor px per working px ${spwZoom.toFixed(3)} vs ${spw.toFixed(3)}`);
  }
  if (bad.length) fail(`${tag}: ${bad.join("; ")}`);
  else ok(`${tag}: window ${plan.window.w}x${plan.window.h} (${(plan.px / 1e6).toFixed(2)} MP region, pad ${plan.pad}), `
          + `source vs compare map max ${dmax.toFixed(2)} / median ${dmed.toFixed(2)} main px, ${nSrc} px`);
}

// np.rot90(a, turns) counter-clockwise reference, interleaved RGB
function rot90(data, w, h, turns) {
  let cur = { data, w, h };
  for (let t = 0; t < turns; t++) {
    const o = new Float32Array(cur.w * cur.h * 3);
    for (let y = 0; y < cur.w; y++) for (let x = 0; x < cur.h; x++) {   // out is (w rows, h cols)
      const sx = cur.w - 1 - y, sy = x;
      for (let c = 0; c < 3; c++) o[(y * cur.h + x) * 3 + c] = cur.data[(sy * cur.w + sx) * 3 + c];
    }
    cur = { data: o, w: cur.h, h: cur.w };
  }
  return cur;
}
function checkRotate() {
  let n = 0;
  for (let T = 0; T < 4; T++) {
    const ufw = 37, ufh = 23;
    const un = new Float32Array(ufw * ufh * 3);
    for (let y = 0; y < ufh; y++) for (let x = 0; x < ufw; x++) { un[(y * ufw + x) * 3] = x; un[(y * ufw + x) * 3 + 1] = y; un[(y * ufw + x) * 3 + 2] = 5; }
    const dec = rot90(un, ufw, ufh, T);
    for (const reg of [{ x: 0, y: 0, w: dec.w, h: dec.h }, { x: 3, y: 2, w: 11, h: 7 }, { x: dec.w - 5, y: dec.h - 4, w: 5, h: 4 }, { x: 6, y: 6, w: 1, h: 1 }]) {
      const roi = unrotatedRect(T, ufw, ufh, reg);
      const roiRgb = new Float32Array(roi.w * roi.h * 3);
      for (let y = 0; y < roi.h; y++) for (let x = 0; x < roi.w; x++) for (let c = 0; c < 3; c++)
        roiRgb[(y * roi.w + x) * 3 + c] = un[((roi.y + y) * ufw + roi.x + x) * 3 + c];
      const got = rotateRegion(roiRgb, roi, reg, T, ufw, ufh, [2, 3, 0.5]);
      let bad = 0;
      for (let y = 0; y < reg.h; y++) for (let x = 0; x < reg.w; x++) for (let c = 0; c < 3; c++) {
        const want = dec.data[((reg.y + y) * dec.w + reg.x + x) * 3 + c] * [2, 3, 0.5][c];
        if (got[(y * reg.w + x) * 3 + c] !== want) bad++;
      }
      n++;
      if (bad) fail(`rotateRegion T${T} ${JSON.stringify(reg)}: ${bad} values differ from np.rot90`);
    }
  }
  if (!failures.length) ok(`rotateRegion + unrotatedRect equal np.rot90 of the whole frame (${n} regions, turns 0..3, gain applied)`);
}

function checkSmall() {
  // pickLevel thresholds (D2)
  const cases = [[0.2, 2, 0], [0.5, 1, 0], [0.29, 3, 0], [0.3, 1.5, 2], [0.74, 4, 2], [0.75, 4, 1], [2, 8, 1]];
  const badp = cases.filter(([percent, scale, want]) => pickLevel({ percent, scale }) !== want);
  if (pickLevel({ percent: 1, scale: 5, level1: false }) !== 2) badp.push("level1 off");
  badp.length ? fail(`pickLevel: ${JSON.stringify(badp)}`) : ok("pickLevel thresholds (none below 30% or at the fitted view, half sensor to 75%, full above)");
  // visibleRect: fitted view of a 1000x600 image in a 500x400 viewport -> everything; zoomed 4x at the centre -> a quarter
  const s0 = Math.min(500 / 1000, 400 / 600);
  const v0 = visibleRect({ x: 0, y: 0, w: 500, h: 400 }, { x: 0, y: 0 }, s0, 1000, 600);
  const v4 = visibleRect({ x: 0, y: 0, w: 500, h: 400 }, { x: 0, y: 0 }, s0 * 4, 1000, 600);
  const v4p = visibleRect({ x: 250, y: 0, w: 250, h: 400 }, { x: -100, y: 0 }, s0 * 4, 1000, 600);
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  const g1 = v0 && eq(v0.x, 0) && eq(v0.w, 1000) && eq(v0.y, 0) && eq(v0.h, 600);
  const g2 = v4 && eq(v4.w, 250) && eq(v4.x, 375) && eq(v4.h, 200) && eq(v4.y, 200);
  // a half viewport (x 250..500, centre 375) panned by -100: image x at the left edge = (250 - 375 + 100) / 2 + 500 = 487.5
  const g3 = v4p && eq(v4p.x, 487.5) && eq(v4p.w, 125);
  g1 && g2 && g3 ? ok("visibleRect: fitted, 4x at the centre, a panned half viewport") : fail(`visibleRect ${JSON.stringify([v0, v4, v4p])}`);
  const offscreen = visibleRect({ x: 0, y: 0, w: 100, h: 100 }, { x: 5000, y: 0 }, 1, 1000, 600);
  offscreen === null ? ok("visibleRect: null when the view is off the image") : fail("visibleRect off-image not null");
  // margins: the lowRes margin covers 3 sigma of the largest small blur, no lowRes is capped
  const m = [detailMargin(1, true), detailMargin(2, true), detailMargin(1, false), detailMargin(2, false)];
  m[0] >= 48 && m[1] >= 24 && m[2] === 160 && m[3] === 160 ? ok(`detailMargin ${m.join("/")} region px (L1 / L2, lowRes / none capped)`)
    : fail(`detailMargin ${m}`);
}

// ------------------------------------------------------------------------------------------------
checkRotate();
checkSmall();
for (const key of ["dsc_6550", "skl_3024"]) {
  const { prep: base } = await loadPrepared(key);
  const fitted = base.transform.crop ?? {};
  const knobs = withTransform(base, { ...SYN_GEOM, crop: SYN_CROP }, SYN_VIG);
  const variants = [
    ["as fitted", base],
    ["crop 3.5 deg", withTransform(base, { crop: SYN_CROP })],
    ["no crop", withTransform(base, { crop: { ...fitted, hasCrop: false } })],
    ["all knobs", knobs],
  ];
  const rects = [[0.40, 0.40, 0.12, 0.12], [0.02, 0.03, 0.10, 0.10], [0.85, 0.86, 0.15, 0.14], [0.45, 0.20, 0.08, 0.30]];
  for (const [label, prep] of variants) {
    for (let T = 0; T < 4; T++) {
      for (const level of [1, 2]) {
        // every orientation on the all-knobs variant; the others at T 0 and 1 to keep the run short
        if (label !== "all knobs" && T > 1) continue;
        const rs = label === "all knobs" || T === 0 ? rects : rects.slice(0, 2);
        for (const r of rs) checkPlan(`${key} ${label}`, prep, T, level, r);
      }
    }
  }
  // the whole image: too large at level 1 (24 MP of grid), fits the hard cap at level 2
  checkPlan(`${key} as fitted`, base, 0, 1, [0, 0, 1, 1], true);
  checkPlan(`${key} as fitted`, base, 0, 2, [0, 0, 1, 1]);
  // a rectangle entirely outside the image
  checkPlan(`${key} as fitted`, base, 0, 2, [0.5, 0.5, 0.0001, 0.0001]);
}

console.log(`\n${nPlans} plans, ${nSamples} source positions compared with the compare map: worst max ${worstMax.toFixed(3)} main px, `
  + `worst median ${worstMedian.toFixed(3)}; worst |level px per grid px - 1| ${worstStep.toFixed(4)}; worst readout factor difference (local vs middle) ${(100 * worstSpw).toFixed(3)}%`);
if (failures.length) {
  console.log(`FAILED: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("all zoom plan checks passed");
}
