// The Node-side levels of web/test.mjs, one function per level. Each level runs
// in its own child process (web/test-node-run.mjs) so the levels run in parallel;
// every child loads its own fixtures, there is no shared mutable state.
// Level bodies are verbatim from test.mjs; levels and rules: spec/web-tests.md.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initRaw } from "./lib/raw.js";
import { deserialize, serialize } from "./lib/np3.js";
import { curveTable } from "./lib/curve.js";
import { scaled } from "./lib/strength.js";
import { level1i } from "./test-node-advice.mjs";
import { level1j } from "./test-node-stage2.mjs";
import { level1k } from "./test-node-i18n.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const ROOT = path.dirname(HERE);                             // the project root
const man = JSON.parse(await readFile(path.join(HERE, "golden/manifest.json"), "utf8"));

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

// The parallel Jacobian (lib/fit-pool.js) for the Node fit levels 1f and 9. Node has no Web
// Worker, so the lib/fit-jac-worker.js helpers run in worker_threads behind a tiny `self` shim.
// The orchestrator runs 1f and 9 concurrently, so each takes half of the spare cores (>= 2).
async function nodeFitPool() {
  const { Worker } = await import("node:worker_threads");
  const { pathToFileURL } = await import("node:url");
  const { availableParallelism } = await import("node:os");
  const { createFitPool } = await import("./lib/fit-pool.js");
  const helperUrl = pathToFileURL(path.join(HERE, "lib/fit-jac-worker.js")).href;
  const shim = `const { parentPort, workerData } = require("node:worker_threads");
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), onmessage: null };
    parentPort.on("message", (d) => self.onmessage && self.onmessage({ data: d }));
    import(workerData.url);`;
  const spawn = () => {
    const w = new Worker(shim, { eval: true, workerData: { url: helperUrl } });
    const o = { postMessage: (m, t) => w.postMessage(m, t), terminate: () => w.terminate(), onmessage: null, onerror: null };
    w.on("message", (d) => o.onmessage && o.onmessage({ data: d }));
    w.on("error", (e) => o.onerror && o.onerror(e));
    return o;
  };
  const size = Math.max(2, Math.min(8, Math.floor((availableParallelism() - 1) / 2)));
  const profileMeta = JSON.parse(await readFile(path.join(HERE, "model/profile.json"), "utf8"));
  const pb = await readFile(path.join(HERE, "model/profile.bin"));
  const profileBin = pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength);
  return { size, makePool: (qs) => createFitPool({ spawn, size, profileMeta, profileBin, qs }) };
}

export const LEVELS = {
  "1": level1,
  "1a": level1A,
  "1b": level1b,
  "1d": level1d,
  "1e": level1e,
  "1f": level1f,
  "1g": level1g,
  "1h": level1h,
  "1i": level1i,
  "1j": level1j,
  "1k": level1k,
  "9": level9,
  "4": level4,
  "5": level5,
};

async function level1(ctx) {
  const { report, skip } = ctx;
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
}

async function level1A(ctx) {
  const { report, skip } = ctx;
  const raw = await initRaw(await readFile(path.join(HERE, "raw.wasm")));
  for (const e of man.errors) {
    const src = rootFile(e.path);
    if (!src) { skip(`1a error ${e.path}: no file`); continue; }
    const bytes = await readFile(src);
    let code = null;
    try { raw.develop(bytes, man.long); } catch (err) { code = err.code || String(err); }
    report(code === e.code, `1a error ${e.path}: code ${code}, expected ${e.code}`);
  }
}

async function level1b(ctx) {
  const { report, skip } = ctx;
  const T = await import("./lib/target.js");
  T.setWbMapWeights(JSON.parse(await readFile(path.join(HERE, "model/wbmap.json"), "utf8")).weights);
  const tdir = path.join(HERE, "golden", "target");
  const wbj = JSON.parse(await readFile(path.join(tdir, "wb.json"), "utf8"));
  const multipliers = T.wbMultipliers(new Uint8Array(await readFile(path.join(tdir, wbj.file))));
  report(Math.abs(multipliers[0] - wbj.multipliers[0]) < 1e-12
         && Math.abs(multipliers[1] - wbj.multipliers[1]) < 1e-12,
    `1b wbMultipliers ${wbj.file}: ${multipliers.map((v) => v.toFixed(6)).join(", ")}`);

  // the browser consumes JPEG targets only; the tif_* fixtures stay as Python-side reference
  const caseFiles = (await readdir(tdir)).filter((f) => f.endsWith(".json") && f !== "wb.json");
  for (const cf of caseFiles) {
    const j = JSON.parse(await readFile(path.join(tdir, cf), "utf8"));
    if (j.image.format !== "JPEG") continue;
    const name = j.file;
    const bytes = new Uint8Array(await readFile(path.join(tdir, name)));
    const format = j.image.format;
    const bad = [];
    const x = T.parseXmp(T.extractXmp(bytes, format));
    if (JSON.stringify(x) !== JSON.stringify(j.xmp)) bad.push("parseXmp/extractXmp");
    const g = T.editGain(x, multipliers);
    if (g.note !== j.gainNote) bad.push(`editGain note "${g.note}" != "${j.gainNote}"`);
    for (let i = 0; i < 3; i++)
      if (Math.abs(g.gain[i] - j.gain[i]) > 1e-9) bad.push(`editGain gain[${i}]`);
    const warns = T.editWarningCodes(name, [j.image.w, j.image.h], x).map(T.formatWarning);
    if (JSON.stringify(warns) !== JSON.stringify(j.warnings)) bad.push("editWarningCodes/formatWarning");
    const icc = T.extractIcc(bytes, format);
    const desc = icc ? T.iccDescription(icc) : null;
    if ((desc ?? null) !== j.image.icc.profile) bad.push(`iccDescription "${desc}"`);
    if ((T.isSrgbDescription(desc) || !icc) !== j.image.icc.treatedAsSrgb) bad.push("isSrgbDescription");
    if (T.exifOrientation(bytes, format) !== j.image.exifOrientation) bad.push("exifOrientation");
    if (j.iccMatrix) {
      const m = T.iccToSrgbMatrix(icc);
      if (!m) bad.push("iccToSrgbMatrix null");
      else {
        let mmax = 0;
        for (let i = 0; i < 9; i++) mmax = Math.max(mmax, Math.abs(m.m[i] - j.iccMatrix.m[i]));
        if (mmax > 1e-9) bad.push(`iccToSrgbMatrix m max ${mmax}`);
        let tmax = 0;
        for (const s of j.iccMatrix.trc) {
          tmax = Math.max(tmax, Math.abs(T.evalTrc(m.trc.r, s.x) - s.r),
                                 Math.abs(T.evalTrc(m.trc.g, s.x) - s.g),
                                 Math.abs(T.evalTrc(m.trc.b, s.x) - s.b));
        }
        if (tmax > 1e-12) bad.push(`iccToSrgbMatrix trc max ${tmax}`);
      }
    }
    report(!bad.length, `1b target ${name}${bad.length ? ": " + bad.join("; ") : ""}`);
  }

  // decodeTarget rejects anything that is not a JPEG (TIFF stays in the Python CLI)
  const tifBytes = new Uint8Array(await readFile(path.join(tdir, "tif_plain.tif")));
  let msg = null;
  try { await T.decodeTarget(new Blob([tifBytes], { type: "image/tiff" })); }
  catch (e) { msg = e.message; }
  report(msg === "unsupported target format: the browser accepts JPEG targets only",
    `1b decodeTarget rejection (TIFF): ${msg}`);
}

async function level1d(ctx) {
  const { report, skip } = ctx;
  const R = await import("./lib/resample.js");
  const rdir = path.join(HERE, "golden", "resample");
  const rm = JSON.parse(await readFile(path.join(rdir, "manifest.json"), "utf8"));
  const rbytes = async (rel) => {
    let b = await readFile(path.join(HERE, "golden", rel));
    if (rel.endsWith(".br")) b = brotliDecompressSync(b);
    return b;
  };
  const inputs = {};
  for (const [k, v] of Object.entries(rm.inputs)) {
    const b = await rbytes(v.file);
    inputs[k] = v.dtype === "u8" ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
                                 : new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  }
  for (const c of rm.cases) {
    const src = inputs[c.in];
    const iw = rm.inputs[c.in].w, ih = rm.inputs[c.in].h;
    let got;
    if (c.op === "resize") {
      got = c.dtype === "f32" ? R.resizeF(src, c.outW, c.outH, iw, ih, c.kernel, 3)
                              : R.resizeU8(src, c.outW, c.outH, iw, ih, c.kernel, 3);
    } else if (c.op === "rotate") {
      got = R.rotate(src, iw, ih, c.angle, c.kernel, { center: c.center, dtype: c.dtype, channels: 3 });
    } else if (c.op === "warpAffine") {
      got = R.warpAffine(src, iw, ih, c.outW, c.outH, c.m, c.kernel, { dtype: c.dtype, channels: 3 });
    } else if (c.op === "warpRadial") {
      got = R.warpRadial(src, iw, ih, c.s, c.k, 3);
    } else if (c.op === "shrink") {
      got = R.shrink(src, iw, ih, c.k, 3);
    }
    const b = await rbytes(c.out);
    const want = c.dtype === "u8" ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
                                  : new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    const tol = rm.tolerances[c.dtype];
    let max = 0;
    const n = Math.min(want.length, got.data.length);
    for (let i = 0; i < n; i++) {
      const d = Math.abs(got.data[i] - want[i]);
      if (d > max) max = d;
    }
    const ok = want.length === got.data.length && got.w === c.outW && got.h === c.outH && max <= tol.max;
    report(ok, `1d ${c.name}: max ${c.dtype === "f32" ? max.toExponential(2) : max}`
             + ` (tolerance ${tol.max})`);
  }
}

async function level1e(ctx) {
  const { report, skip } = ctx;
  const P = await import("./lib/pair-prepare.js");
  const pdir = path.join(HERE, "golden", "pair");
  const pbytes = async (rel) => {
    let b = await readFile(path.join(HERE, "golden", rel));
    if (rel.endsWith(".br")) b = brotliDecompressSync(b);
    return b;
  };
  // the measured gap of the shipped inputs vs the full-resolution devpairs.build
  // (recorded by make_fit_golden.py into in.json vsBuild — the honest equivalence budget)
  const vsBuildTol = { x: 0.05, ncc: 0.05 };
  for (const key of ["dsc_6550", "skl_3024", "skl_3024__dsc_5584"]) {
    const inj = JSON.parse(await readFile(path.join(pdir, `${key}.in.json`), "utf8"));
    const ref = inj.reference;
    const linB = await pbytes(inj.inputs.linear.file);
    const embB = await pbytes(inj.inputs.embedded.file);
    const tgtB = await pbytes(inj.inputs.target.file);
    const xmp = { ...inj.inputs.xmp, _masks: inj.inputs.xmpMasks };
    const stages = [];
    const prep = await P.preparePair({
      linear: new Float32Array(linB.buffer, linB.byteOffset, linB.byteLength / 4),
      lw: inj.inputs.linear.w, lh: inj.inputs.linear.h,
      unrotate: inj.inputs.linear.unrotate,
      targetU8: new Uint8Array(tgtB.buffer, tgtB.byteOffset, tgtB.byteLength),
      tw: inj.inputs.target.w, th: inj.inputs.target.h,
      xmp, rawBytes: new Uint8Array(0),
      gain: inj.inputs.gain, gainNote: inj.inputs.gainNote,
      embedded: { data: new Uint8Array(embB.buffer, embB.byteOffset, embB.byteLength),
                  w: inj.inputs.embedded.w, h: inj.inputs.embedded.h },
      onProgress: (s) => stages.push(s),
    });
    const bad = [];
    if (!prep) { report(false, `1e ${key}: preparePair returned null`); continue; }
    const rx = new Float32Array((await pbytes(ref.arrays.x)).buffer);
    const ry = new Float32Array((await pbytes(ref.arrays.y)).buffer);
    let xm = 0, ym = 0;
    for (let i = 0; i < rx.length; i++) xm = Math.max(xm, Math.abs(prep.x[i] - rx[i]));
    for (let i = 0; i < ry.length; i++) ym = Math.max(ym, Math.abs(prep.y[i] - ry[i]));
    if (xm > 1e-5) bad.push(`x max ${xm.toExponential(2)} vs replay (tol 1e-5)`);
    if (ym > 1e-5) bad.push(`y max ${ym.toExponential(2)} vs replay (tol 1e-5)`);
    if (Math.abs(prep.ncc - ref.ncc) > 1e-6) bad.push(`ncc ${prep.ncc} vs replay ${ref.ncc}`);
    // transform components (the discrete search results must reproduce exactly)
    const tt = ref.transform;
    const eq = (a, b, tol, name) => { if (Math.abs(a - b) > tol) bad.push(`${name} ${a} vs ${b}`); };
    eq(prep.transform.orientation, tt.orientation, 0, "orientation");
    eq(prep.transform.scale, tt.scale, 1e-9, "scale");
    eq(prep.transform.radialScale, tt.radialScale, 1e-9, "radialScale");
    eq(prep.transform.radialK, tt.radialK, 1e-9, "radialK");
    eq(prep.transform.warpScale, tt.warpScale, 1e-9, "warpScale");
    eq(prep.transform.shiftX, tt.shiftX, 1e-6, "shiftX");
    eq(prep.transform.shiftY, tt.shiftY, 1e-6, "shiftY");
    eq(prep.vignette.a, ref.vignette.a, 1e-6, "vignette.a");
    eq(prep.vignette.b, ref.vignette.b, 1e-6, "vignette.b");
    if (JSON.stringify(prep.size) !== JSON.stringify(ref.size)) bad.push("size");
    if ((prep.transform.lensRadial === null) !== (tt.lensRadial === null))
      bad.push("lensRadial presence");
    else if (tt.lensRadial) {
      eq(prep.transform.lensRadial.scale, tt.lensRadial.scale, 1e-9, "lensRadial.scale");
      eq(prep.transform.lensRadial.k, tt.lensRadial.k, 1e-9, "lensRadial.k");
    }
    if (JSON.stringify(prep.transform.crop) !== JSON.stringify(tt.crop)) bad.push("crop");
    // masks vs the replay reference (packed 4 planes in the fixture)
    const mm = new Uint8Array((await pbytes(ref.arrays.masks)).buffer);
    const planes = [prep.masks.clipMask, prep.masks.reportMask, prep.masks.validMask, prep.masks.nearWhiteMask];
    for (let pl = 0; pl < 4 && !bad.some((b) => b.startsWith("mask")); pl++) {
      let diff = 0;
      for (let i = 0; i < planes[pl].length; i++) if (planes[pl][i] !== mm[pl * planes[pl].length + i]) diff++;
      if (diff) bad.push(`mask ${ref.maskPlanes[pl]}: ${diff} mismatches`);
    }
    if (prep.masks.validMask.some((v) => v !== 1)) bad.push("validMask not all-ones");
    // blocked state
    const wantBlocked = ref.blocked?.code ?? null;
    if ((prep.blocked?.code ?? null) !== wantBlocked) bad.push(`blocked ${prep.blocked?.code} vs ${wantBlocked}`);
    if (wantBlocked === "ncc_low" && !/ncc=\d+\.\d{3} < 0\.6/.test(prep.blocked.detail)) bad.push("blocked detail");
    // the stage sequence (decode -> … -> shrink)
    const wantStages = ["decode", "vignette", "crop", "orient", "radial", "align", "shrink"];
    if (JSON.stringify(stages) !== JSON.stringify(wantStages)) bad.push(`stages ${stages.join(",")}`);
    // gain pass-through
    if (Math.abs(prep.gain[0] - inj.inputs.gain[0]) > 1e-12 || prep.gainNote !== inj.inputs.gainNote)
      bad.push("gain/gainNote pass-through");
    // the honest gap vs the full-resolution devpairs.build (pair/<key>.json)
    const bdoc = JSON.parse(await readFile(path.join(pdir, `${key}.json`), "utf8"));
    let bx = 0;
    const bxRef = new Float32Array((await pbytes(bdoc.arrays.x)).buffer);
    for (let i = 0; i < bxRef.length; i++) bx = Math.max(bx, Math.abs(prep.x[i] - bxRef[i]));
    const dncc = Math.abs(prep.ncc - bdoc.ncc);
    if (bx > vsBuildTol.x) bad.push(`vs build x max ${bx.toFixed(4)} (tol ${vsBuildTol.x})`);
    if (dncc > vsBuildTol.ncc) bad.push(`vs build ncc delta ${dncc.toFixed(4)} (tol ${vsBuildTol.ncc})`);
    report(!bad.length, `1e ${key}: x ${xm.toExponential(1)}/y ${ym.toExponential(1)} vs replay,`
           + ` ncc ${prep.ncc.toFixed(4)} (Δbuild ${dncc.toFixed(4)}), blocked ${prep.blocked?.code ?? "no"}`
           + (bad.length ? ` — ${bad.join("; ")}` : ""));

    // the compare render side (warpToView, 2026-11-20): with k = 1 its 3×3 shrink is
    // bit-identical to the report grid (warpToWorking); at k = 2 (the stored shift scaled to the
    // finer grid) a 6×6 shrink lands within VIEW_TOL mean |Δ| of it — a wrong shift scaling
    // misaligns by k pixels and fails
    {
      const { shrink } = await import("./lib/resample.js");
      const frame = { data: new Float32Array(linB.buffer, linB.byteOffset, linB.byteLength / 4),
                      w: inj.inputs.linear.w, h: inj.inputs.linear.h };
      const unr = inj.inputs.linear.unrotate;
      const grid = P.warpToWorking(frame, prep, unr);
      const v1 = P.warpToView(frame, prep, unr, { k: 1 });
      const s1 = shrink(v1.data, v1.w, v1.h, 3, 3).data;
      let same = s1.length === grid.data.length;
      for (let i = 0; same && i < s1.length; i++) same = s1[i] === grid.data[i];
      const v2 = P.warpToView(frame, prep, unr, { k: 2 });
      const s2 = shrink(v2.data, v2.w, v2.h, 6, 3).data;
      let mad = 0, n = 0;
      for (let i = 0; i < Math.min(s2.length, grid.data.length); i++) {
        const d = Math.abs(s2[i] - grid.data[i]);
        if (Number.isFinite(d)) { mad += d; n++; }
      }
      mad /= Math.max(1, n);
      const def = P.warpToView(frame, prep, unr);
      const VIEW_TOL = 5e-4;     // measured: 1.2–1.7e-4; an unscaled shift (skl_3024__dsc_5584, shift 9.4 px) gives 1.67e-3
      report(same && s2.length === grid.data.length && mad <= VIEW_TOL
             && def.w === Math.round(prep.size.w * def.k) && def.k >= 1 / 3,
        `1e ${key} view: shrink(warpToView k=1) ${same ? "==" : "!="} warpToWorking bit-exact,`
        + ` k=2 6×6-shrunk mean |Δ| ${mad.toExponential(2)} (tol ${VIEW_TOL}), default k ${def.k.toFixed(3)}`
        + ` -> ${def.w}×${def.h}`);
    }
    // the fast compare path (viewRemap + applyRemap, what app.js draws): one bilinear gather
    // through the composed inverse map vs the seven-pass warpToView — same size, the same
    // fill, mean |Δ| ≤ 2 % of the mean level (measured ≤ 1.1 %; bilinear vs the box/bicubic
    // kernels). A wrong turn, crop offset or shift misplaces the content and fails.
    {
      const frame = { data: new Float32Array(linB.buffer, linB.byteOffset, linB.byteLength / 4),
                      w: inj.inputs.linear.w, h: inj.inputs.linear.h };
      const unr = inj.inputs.linear.unrotate;
      const ref = P.warpToView(frame, prep, unr);
      const fast = P.applyRemap(frame, P.viewRemap(prep, frame.w, frame.h, unr));
      let s = 0, lv = 0, n = 0, fill = 0;
      for (let i = 0; i < ref.data.length; i += 3) {
        const rz = ref.data[i] + ref.data[i + 1] + ref.data[i + 2] === 0;
        const fz = fast.data[i] + fast.data[i + 1] + fast.data[i + 2] === 0;
        if (rz !== fz) { fill++; continue; }
        for (let c = 0; c < 3; c++) { s += Math.abs(ref.data[i + c] - fast.data[i + c]); lv += ref.data[i + c]; n++; }
      }
      const rel = s / Math.max(1e-12, lv);
      const fillPct = 100 * fill / (ref.data.length / 3);
      report(fast.w === ref.w && fast.h === ref.h && rel <= 0.02 && fillPct <= 0.5,
        `1e ${key} view remap: ${fast.w}×${fast.h}, mean |Δ| ${(100 * rel).toFixed(2)} % of the level`
        + ` (tol 2 %), fill mismatch ${fillPct.toFixed(2)} % (tol 0.5 %) vs warpToView`);
    }
  }

  // extractEmbeddedJpeg: a pure port of the pairs.embedded_jpeg PIL scan (two candidates,
  // the widest wins; a candidate without a SOF segment is skipped). The candidates are
  // complete SOF + SOS streams — PIL rejects a SOF without a following SOS (verified with
  // Pillow 12.3: offsets 4 -> 100x50, 45 -> rejected, 57 -> 640x480). The PIL-faithfulness of
  // the scan on adversarial runs is level 1j.
  const jpg = (w, h) => Uint8Array.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
                                         h >> 8, h & 255, w >> 8, w & 255, 0x03,
                                         1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
                                         0xFF, 0xDA, 0x00, 0x0C, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0,
                                         0x12, 0x34, 0xFF, 0xD9]);
  const broken = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x05, 1, 2, 3, 0xFF, 0xD9]);
  const raw = new Uint8Array([9, 9, 9, 9, ...jpg(100, 50), 0, 0, ...broken, 7, ...jpg(640, 480), 1, 2, 3]);
  const got = P.extractEmbeddedJpeg(raw);
  const want = jpg(640, 480);
  const extOk = !!got && got.length === want.length && got.every((v, i) => v === want[i]);
  report(extOk, `1e extractEmbeddedJpeg: the widest candidate of ${raw.length} synthetic bytes`
         + (extOk ? "" : ` (got ${got?.length ?? "null"} bytes)`));
  report(P.extractEmbeddedJpeg(new Uint8Array([1, 2, 3])) === null,
    "1e extractEmbeddedJpeg: no JPEG -> null (the DNG-without-preview path)");
}

async function level1f(ctx) {
  const { report, skip } = ctx;
  const F = await import("./lib/fit.js");
  const S = await import("./lib/sample.js");
  const PR = await import("./lib/profile.js");
  const { srgbToLab, de2000 } = await import("./lib/color.js");
  const gbytes = async (rel) => {
    let b = await readFile(path.join(HERE, "golden", rel));
    if (rel.endsWith(".br")) b = brotliDecompressSync(b);
    return b;
  };
  const gi32 = async (rel) => { const b = await gbytes(rel); return new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  const gf32 = async (rel) => { const b = await gbytes(rel); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

  // --- 1f lm: the LM solver on the synthetic problems (lm/synth.json, spec §6.7) ---
  const lmFix = JSON.parse(await readFile(path.join(HERE, "golden/lm/synth.json"), "utf8"));
  const lmXTol = { exp: 1e-6, singular: 1e-6, flat: 1e-6 };   // measured 2026-11-19: <= 4.9e-15
  for (const pr of lmFix.problems) {
    const xv = Float64Array.from(pr.x), yv = Float64Array.from(pr.y);
    let fn;
    if (pr.name === "exp") fn = (v) => { const out = new Float64Array(xv.length); for (let i = 0; i < xv.length; i++) out[i] = Math.exp(v[0] + v[1] * xv[i]) - yv[i]; return out; };
    else if (pr.name === "singular") fn = (v) => { const out = new Float64Array(xv.length); for (let i = 0; i < xv.length; i++) out[i] = (v[0] + v[1]) * xv[i] - yv[i]; return out; };
    else fn = (v) => { const out = new Float64Array(xv.length); for (let i = 0; i < xv.length; i++) out[i] = v[1] * xv[i] - yv[i]; return out; };
    const t0 = Date.now();
    const got = F.lm(fn, Float64Array.from(pr.x0), 60);
    const rel = Math.abs(got.cost - pr.expected.cost) / pr.expected.cost;
    let maxX = 0;
    for (let i = 0; i < got.x.length; i++) maxX = Math.max(maxX, Math.abs(got.x[i] - pr.expected.x[i]));
    // the run count may differ by one at the float-noise floor: the acceptance is a strict
    // cost comparison there, so only x*/cost are asserted (both recorded tolerances)
    report(rel <= 1e-6 && maxX <= lmXTol[pr.name],
      `1f lm ${pr.name}: cost rel ${rel.toExponential(1)}, max |dx| ${maxX.toExponential(1)},` +
      ` run ${got.iterations.run}/${pr.expected.iterations.run}` +
      (got.iterations.run === pr.expected.iterations.run ? "" : " (acceptance at the noise floor)") +
      ` (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  // --- 1f residual: the exact assembly of §3.4 by hand (incl. the near-white clip branch,
  //     absent from the golden pairs, and the 1/sqrt(n_q * P) normalization) ---
  {
    const { labToSrgb } = await import("./lib/color.js");
    const x = F.zeroInit();
    x[50] = 2;                                   // Saturation 2: the last-but ridge term is RIDGE * 2
    const neutral50 = labToSrgb(Float64Array.from([50, 10, 20]));
    const fake = (rgb) => ({ apply: () => Float64Array.from(rgb) });
    const q1 = {
      n: 2, tlab: Float64Array.from([52, 9, 20, 48, 10, 22]),   // pred is Lab 50 everywhere
      W: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      px: fake([...neutral50, ...neutral50]),
      cpx: fake([0.995, 0.9, 0.4]), ct: Float64Array.from([0.99, 0.85, 0.5]),
      cmask: Uint8Array.from([1, 0, 0]), sm: Float64Array.from([1, 1]),
    };
    const q2 = { n: 1, tlab: new Float64Array(3), W: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), sm: Float64Array.from([1]), px: fake([0, 0, 0]), cpx: null };
    const r = F.residual([q1, q2], x);
    // the Cauchy loss of each main row (match.robust, c = ROBUST): |d| = sqrt(5) and sqrt(8)
    const cauchy = (e2) => Math.sqrt(F.ROBUST ** 2 * Math.log1p(e2 / F.ROBUST ** 2) / e2);
    const s1 = cauchy(5), s2 = cauchy(8);
    const expected = [
      -1 * s1, 0.5 * s1, 0, 1 * s2, 0, -1 * s2,   // main: (pred - tlab) / sqrt(2 * 2), rows rescaled
      0, 2.5, -5,                    // clip: 100 * where(cmask, min(d, 0), d) / sqrt(2 * 2)
      0, 0, 0,                       // second pair: zero residuals / sqrt(1 * 2)
    ];
    for (let i = 0; i < 18; i++)     // SMOOTH*100*diff(k, 2)*BEND at the identity knots
      expected.push(F.SMOOTH * 100 * (F.XS[i] - 2 * F.XS[i + 1] + F.XS[i + 2]) * F.BEND[i]);
    expected.push(...new Array(30 + 24 + 1).fill(0),   // zero blender/grade: no ridge/ring/white terms
      0.024, 0, 0, 0, 0, 0);         // RIDGE * (extra - EXTRA_DEFAULT)
    const same = r.length === expected.length
      && r.every((v, i) => Math.abs(v - expected[i]) <= 1e-9);   // the Lab round-trip is not bit-exact
    report(same, `1f residual assembly: ${r.length} terms, hand-computed §3.4 vector${same ? "" : " — MISMATCH"}`);
  }

  // --- the models: the CPU dev model + the profile model (the renderer's own inputs) ---
  const dev = F.loadDev(JSON.parse(await readFile(path.join(HERE, "model/dev.json"), "utf8")),
                        (await readFile(path.join(HERE, "model/dev_lut.bin"))).buffer);
  const pmeta = JSON.parse(await readFile(path.join(HERE, "model/profile.json"), "utf8"));
  const pbin = await readFile(path.join(HERE, "model/profile.bin"));
  const model = PR.loadModel(pmeta, pbin.buffer.slice(pbin.byteOffset, pbin.byteOffset + pbin.byteLength));

  // --- the sampled pairs: prepared fixtures developed on the CPU dev model, shipped indices injected ---
  const pairs = {};
  for (const key of ["dsc_6550", "skl_3024"]) {
    const pdoc = JSON.parse(await readFile(path.join(HERE, "golden/pair", `${key}.json`), "utf8"));
    const sdoc = JSON.parse(await readFile(path.join(HERE, "golden/sample", `${key}.json`), "utf8"));
    const indices = {
      pick: await gi32(sdoc.arrays.pick), mult: await gf32(sdoc.arrays.mult),
      test: await gi32(sdoc.arrays.test), clip: await gi32(sdoc.arrays.clip),
    };
    const q = S.prepareFitPair({
      name: key, ncc: pdoc.ncc,
      x: Float64Array.from(await gf32(pdoc.arrays.x)), t: Float64Array.from(await gf32(pdoc.arrays.y)),
      gain: pdoc.gain, dev, model, indices,
    });
    pairs[key] = q;
    // dev-port cross-check: the developed fit sample vs the shipped sidecar
    const bShip = await gf32(sdoc.arrays.b);
    let bMax = 0;
    for (let i = 0; i < bShip.length; i++) bMax = Math.max(bMax, Math.abs(q.px.rgb[i] - bShip[i]));
    // weights cross-check: the recomputed de2000 weights (sqrt(mult) folded) vs the shipped W
    const wShip = await gf32(sdoc.arrays.W);
    let wMax = 0;
    for (let i = 0; i < wShip.length; i++) wMax = Math.max(wMax, Math.abs(q.W[i] - wShip[i]));
    report(bMax <= 1e-5 && wMax <= 1e-4,
      `1f dev/sample ${key}: |develop-shipped b| max ${bMax.toExponential(1)}, |W-shipped| max ${wMax.toExponential(1)}`);
  }

  // --- prediction check + the full browser fit vs the golden fits (fit/single.json, fit/two.json) ---
  const meanDe = (q) => {
    const d = de2000(srgbToLab(q.tb), q.ttlab);
    let s = 0;
    for (const v of d) s += v;
    return s / d.length;
  };
  const FIT_X_NORM_TOL = 1e-3;    // measured 2026-11-19: |dx|_2 <= 1.4e-5 (LAPACK-vs-JS divergence)
  const FIT_COST_SEQ_TOL = 1e-4;  // measured 2026-11-19: max rel diff over iterations.costs <= 1.1e-8
  const SCORE_TOL = 0.05;
  // the single fit runs the sync lm (the reference of the parallel check below); the two-pair
  // fit — the long one — runs through the parallel Jacobian, bit-identical to sync by that check
  const fitPool = await nodeFitPool();
  const syncFits = {};
  for (const [name, keys] of [["single", ["dsc_6550"]], ["two", ["dsc_6550", "skl_3024"]]]) {
    const fdoc = JSON.parse(await readFile(path.join(HERE, "golden/fit", `${name}.json`), "utf8"));
    const qs = keys.map((k) => pairs[k]);
    // the residual at the golden fitVector reproduces the golden cost (prediction/packing only)
    const xStar = Float64Array.from(fdoc.fitVector);
    const r0 = F.residual(qs, xStar);
    let cost0 = 0;
    for (const v of r0) cost0 += v * v;
    const rel0 = Math.abs(cost0 - fdoc.cost) / fdoc.cost;
    report(rel0 <= 1e-6,
      `1f predict ${name}: cost ${cost0.toFixed(6)} vs golden ${fdoc.cost.toFixed(6)} (rel ${rel0.toExponential(1)})`);
    // the full fit from the zero init
    const t0 = Date.now();
    const parallel = name === "two";
    let got;
    if (parallel) {
      const pool = await fitPool.makePool(qs);
      try { got = await F.fitAsync(qs, fdoc.iterations.requested, {}, pool.jacobian); } finally { pool.terminate(); }
    } else {
      got = F.fit(qs, fdoc.iterations.requested);
    }
    const secs = (Date.now() - t0) / 1000;
    syncFits[name] = { got, qs, iters: fdoc.iterations.requested, secs };
    const relF = Math.abs(got.cost - fdoc.cost) / fdoc.cost;
    let maxX = 0, normX = 0;
    for (let i = 0; i < fdoc.fitVector.length; i++) {
      const d = got.x[i] - fdoc.fitVector[i];
      maxX = Math.max(maxX, Math.abs(d));
      normX += d * d;
    }
    normX = Math.sqrt(normX);
    let maxC = 0;
    const seqOk = got.iterations.costs.length === fdoc.iterations.costs.length;
    for (let i = 0; i < Math.min(got.iterations.costs.length, fdoc.iterations.costs.length); i++)
      maxC = Math.max(maxC, Math.abs(got.iterations.costs[i] - fdoc.iterations.costs[i]) / fdoc.iterations.costs[i]);
    // the control: banker's rounding makes this a strong field-for-field check
    const ctrl = F.controlOf(got.x, name);
    const ctrlSame = JSON.stringify(ctrl) === JSON.stringify(fdoc.control);
    const pCtrl = PR.paramsOf(JSON.parse(JSON.stringify(ctrl)), model);
    const scores = qs.map((q, i) => ({ pair: keys[i], neutral: meanDe(q), prediction: S.score(q, pCtrl) }));
    const scoresOk = scores.every((s, i) =>
      Math.abs(s.neutral - fdoc.scores[i].neutral) <= SCORE_TOL
      && Math.abs(s.prediction - fdoc.scores[i].prediction) <= SCORE_TOL);
    const bad = [];
    if (relF > 1e-6) bad.push(`cost rel ${relF.toExponential(1)}`);
    if (normX > FIT_X_NORM_TOL) bad.push(`|dx|_2 ${normX.toExponential(1)} (max ${maxX.toExponential(1)})`);
    if (!seqOk) bad.push(`cost history length ${got.iterations.costs.length} vs ${fdoc.iterations.costs.length}`);
    else if (maxC > FIT_COST_SEQ_TOL) bad.push(`cost history rel ${maxC.toExponential(1)}`);
    if (!ctrlSame) bad.push("control differs");
    if (!scoresOk) bad.push(`scores ${JSON.stringify(scores.map((s) => s.prediction.toFixed(3)))}`);
    report(!bad.length,
      `1f fit ${name}: cost rel ${relF.toExponential(1)}, |dx|_2 ${normX.toExponential(1)},` +
      ` history ${seqOk ? "same length" : "DIFFERS"} (rel ${maxC.toExponential(1)}),` +
      ` control ${ctrlSame ? "exact" : "DIFFERS"}, ${secs.toFixed(1)}s` +
      (parallel ? ` (parallel, ${fitPool.size} helpers)` : " (sync)") +
      (bad.length ? ` — ${bad.join("; ")}` : ""));
  }

  // --- the parallel Jacobian (lib/fit-pool.js + lib/fit-jac-worker.js): bit-identical to the sync fit ---
  {
    const { got, qs, iters, secs } = syncFits.single;
    const size = fitPool.size;
    const t0 = Date.now();
    const pool = await fitPool.makePool(qs);
    let par;
    try { par = await F.fitAsync(qs, iters, {}, pool.jacobian); } finally { pool.terminate(); }
    const psecs = (Date.now() - t0) / 1000;
    let diff = 0;
    for (let i = 0; i < got.x.length; i++) if (par.x[i] !== got.x[i]) diff++;
    const histSame = par.iterations.costs.length === got.iterations.costs.length
      && par.iterations.costs.every((c, i) => c === got.iterations.costs[i]);
    report(diff === 0 && par.cost === got.cost && histSame,
      `1f parallel fit single (${size} helpers): x ${diff ? `${diff} entries DIFFER` : "bit-identical"},` +
      ` cost ${par.cost === got.cost ? "identical" : "DIFFERS"}, history ${histSame ? "identical" : "DIFFERS"},` +
      ` ${psecs.toFixed(1)}s vs sync ${secs.toFixed(1)}s`);
  }
}

async function level1g(ctx) {
  const { report, skip } = ctx;
  const A = await import("./lib/analyze.js");
  const F = await import("./lib/fit.js");
  const PR = await import("./lib/profile.js");
  const C = await import("./lib/color.js");
  const { scaled } = await import("./lib/strength.js");
  const g1g = async (rel) => {
    let b = await readFile(path.join(HERE, "golden", rel));
    if (rel.endsWith(".br")) b = brotliDecompressSync(b);
    return b;
  };
  const g1gF32 = async (rel) => { const b = await g1g(rel); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  const g1gU8 = async (rel) => new Uint8Array((await g1g(rel)).buffer);

  // tolerant numeric compare; NaN matches NaN (Python's empty-mean behavior, §6 of the task)
  const close = (g, w, rel = 1e-4, abs = 1e-9) =>
    (Number.isNaN(g) && Number.isNaN(w)) || Math.abs(g - w) <= abs || Math.abs(g - w) <= rel * Math.abs(w);
  // a deep comparator: numbers with `close`, arrays element-wise (a TypedArray on either
  // side), strings/bools/structure exact
  const deepClose = (g, w, rel, abs, path = "") => {
    if (typeof w === "number")
      return typeof g === "number" && close(g, w, rel, abs) ? null : `${path}: ${g} vs ${w}`;
    if (Array.isArray(w)) {
      if (!g || typeof g.length !== "number" || g.length !== w.length)
        return `${path}: length ${g?.length} vs ${w.length}`;
      for (let i = 0; i < w.length; i++) {
        const r = deepClose(g[i], w[i], rel, abs, `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    if (w && typeof w === "object") {
      if (!g || typeof g !== "object") return `${path}: ${JSON.stringify(g)}`;
      for (const k of Object.keys(w)) {
        const r = deepClose(g[k], w[k], rel, abs, `${path}.${k}`);
        if (r) return r;
      }
      return null;
    }
    return g === w ? null : `${path}: ${JSON.stringify(g)} vs ${JSON.stringify(w)}`;
  };
  // a regionSums -> plain JSON shape (golden tLabSum/pLabSum are nested per group)
  const sumsJson = (s) => {
    const out = {};
    for (const k of ["n", "de", "dL", "dC", "dh", "nh", "bn", "bde"]) out[k] = [...s[k]];
    for (const k of ["tLabSum", "pLabSum"])
      out[k] = Array.from({ length: A.GROUPS.length },
        (_, g) => [s[k][g * 3], s[k][g * 3 + 1], s[k][g * 3 + 2]]);
    out.all = s.all;
    return out;
  };
  // the max relative error over a regionSums-shaped pair (for the measured printout)
  const sumsErr = (got, want) => {
    let max = 0;
    for (const k of ["n", "de", "dL", "dC", "dh", "nh", "bn", "bde", "tLabSum", "pLabSum"]) {
      const w = Array.isArray(want[k]) ? want[k].flat() : want[k];
      for (let i = 0; i < got[k].length; i++)
        max = Math.max(max, Math.abs(got[k][i] - w[i]) / Math.max(1, Math.abs(w[i])));
    }
    return Math.max(max, Math.abs(got.all - want.all) / Math.abs(want.all));
  };

  // the models and the golden fit control (the fixed version the report fixtures are at)
  const dev = F.loadDev(JSON.parse(await readFile(path.join(HERE, "model/dev.json"), "utf8")),
                        (await readFile(path.join(HERE, "model/dev_lut.bin"))).buffer);
  const pmeta = JSON.parse(await readFile(path.join(HERE, "model/profile.json"), "utf8"));
  const pbin = await readFile(path.join(HERE, "model/profile.bin"));
  const model = PR.loadModel(pmeta, pbin.buffer.slice(pbin.byteOffset, pbin.byteOffset + pbin.byteLength));
  const fdoc = JSON.parse(await readFile(path.join(HERE, "golden/fit/two.json"), "utf8"));
  const control = fdoc.control;
  const params = PR.paramsOf(JSON.parse(JSON.stringify(control)), model);
  // the pair at report resolution + the prediction, shared by the checks below
  const prepared = {}, sumsOf = {};
  for (const key of ["dsc_6550", "skl_3024"]) {
    const pd = JSON.parse(await readFile(path.join(HERE, "golden/pair", `${key}.json`), "utf8"));
    const x = await g1gF32(pd.arrays.x), y = await g1gF32(pd.arrays.y);
    const mb = await g1g(pd.arrays.masks);
    const reportMask = new Uint8Array(mb.buffer, mb.byteOffset + pd.h3 * pd.w3, pd.h3 * pd.w3);
    const targetLab = C.srgbToLab(Float64Array.from(y));
    const labels = A.labelsOf(targetLab, reportMask);
    const bins = A.binsOf(targetLab);
    const gain = Float64Array.from(pd.gain);
    const xg = new Float64Array(x.length);
    for (let i = 0; i < xg.length; i++) xg[i] = x[i] * gain[i % 3];
    const fb = F.develop(dev, xg);
    const pred = new PR.Pixels(model, fb).apply(params);
    prepared[key] = { pd, x, y, reportMask, targetLab, labels, bins, fb, pred };
    sumsOf[key] = A.regionSums(pred, targetLab, labels, bins, reportMask);
  }
  const P0 = prepared.dsc_6550, S0 = sumsOf.dsc_6550;

  // --- labels/bins vs the shipped §4.1 caches (exact) + targetLab vs the float32 cache ---
  {
    const labelsCache = await g1gU8("report/dsc_6550__labels.u8");
    const binsCache = await g1gU8("report/dsc_6550__bins.u8");
    let dl = 0, db = 0;
    for (let i = 0; i < labelsCache.length; i++) {
      if (P0.labels[i] !== labelsCache[i]) dl++;
      if (P0.bins[i] !== binsCache[i]) db++;
    }
    report(dl === 0 && db === 0,
      `1g labels/bins caches: ${dl}/${labelsCache.length} label, ${db} bin mismatches (exact)`);
    const cacheF32 = await g1gF32("report/dsc_6550__cache.f32.br");
    let labMax = 0;
    for (let i = 0; i < cacheF32.length; i++) labMax = Math.max(labMax, Math.abs(cacheF32[i] - P0.targetLab[i]));
    report(labMax <= 1e-4,
      `1g targetLab vs __cache.f32: max abs ${labMax.toExponential(2)} (the fixture is float32; tolerance 1e-4)`);
  }

  // --- regionSums vs report/dsc_6550__{neutral,fit}.json (all fields incl. tLabSum/pLabSum) ---
  const neutralDoc = JSON.parse(await readFile(path.join(HERE, "golden/report/dsc_6550__neutral.json"), "utf8"));
  const fitDoc = JSON.parse(await readFile(path.join(HERE, "golden/report/dsc_6550__fit.json"), "utf8"));
  {
    const neutral = A.regionSums(P0.fb, P0.targetLab, P0.labels, P0.bins, P0.reportMask);
    const eN = sumsErr(neutral, neutralDoc.regionSums);
    const okN = !deepClose(sumsJson(neutral), neutralDoc.regionSums, 1e-4, 1e-9, "neutral");
    const eF = sumsErr(S0, fitDoc.regionSums);
    const okF = !deepClose(sumsJson(S0), fitDoc.regionSums, 1e-4, 1e-9, "fit");
    report(okN && okF,
      `1g regionSums vs golden (neutral + fit): max rel ${Math.max(eN, eF).toExponential(1)}` +
      ` (neutral ${eN.toExponential(1)}, fit ${eF.toExponential(1)}; tolerance 1e-4)`);
  }

  // --- summary: renderDE/neutralDE/binMean, fittedDelta null at the draft ---
  {
    const summary = A.summaryOf(S0, A.regionSums(P0.fb, P0.targetLab, P0.labels, P0.bins, P0.reportMask).all, 100, null);
    const bad = deepClose(summary, fitDoc.summary, 1e-5, 1e-9, "summary");
    report(!bad, `1g summary vs golden: ${bad ?? "renderDE/neutralDE/binMean within 1e-5"}`);
  }

  // --- the table rows (REPORT_SHARE rule, means = sums/n, hue only when nh > 20) ---
  {
    const table = A.tableOf(S0);
    let bad = null;
    if (table.length !== fitDoc.table.length) bad = `${table.length} rows vs ${fitDoc.table.length}`;
    else {
      for (let i = 0; i < table.length; i++) {
        if (table[i].group !== fitDoc.table[i].group || table[i].n !== fitDoc.table[i].n)
          bad = `row ${i}: group/n`;
        else bad = deepClose(table[i], fitDoc.table[i], 1e-4, 1e-9, `table[${i}]`);
        if (bad) break;
      }
    }
    const dropped = A.GROUPS.length - table.length;
    report(!bad,
      `1g table vs golden: ${table.length} rows (${dropped} groups under REPORT_SHARE dropped),` +
      ` means/sums rule, dh nulls as Python${bad ? ` — ${bad}` : ""}`);
  }

  // --- aggregate: analyze.total over the two fit pairs + binMean + table ---
  const aggDoc = JSON.parse(await readFile(path.join(HERE, "golden/report/aggregate.json"), "utf8"));
  {
    const agg = A.totalSums([sumsOf.dsc_6550, sumsOf.skl_3024]);
    const eA = sumsErr(agg, aggDoc.aggregate);
    const bad = deepClose(sumsJson(agg), aggDoc.aggregate, 1e-4, 1e-9, "aggregate");
    const binMean = A.binMean(agg);
    const badT = deepClose(A.tableOf(agg), aggDoc.table, 1e-4, 1e-9, "aggregateTable");
    report(!bad && close(binMean, aggDoc.aggregateBinMean, 1e-5),
      `1g aggregate vs golden: max rel ${eA.toExponential(1)} (tolerance 1e-4),` +
      ` binMean ${binMean.toFixed(4)} vs ${aggDoc.aggregateBinMean.toFixed(4)}${bad ?? badT ?? ""}`);
  }

  // --- edge cases: a fully clipped frame (Python's NaN behavior, no crash) ---
  {
    const zeroMask = new Uint8Array(P0.pd.h3 * P0.pd.w3);
    const labels = A.labelsOf(P0.targetLab, zeroMask);
    const sums = A.regionSums(P0.pred, P0.targetLab, labels, P0.bins, zeroMask);
    const ok = labels.every((v) => v === 255) && sums.n.every((v) => v === 0)
      && sums.bn.every((v) => v === 0) && Number.isNaN(sums.all) && Number.isNaN(A.binMean(sums))
      && A.tableOf(sums).length === 0 && Number.isNaN(A.totalSums([sums]).all);
    report(ok, "1g edge: a fully clipped frame -> zero sums, NaN all/binMean, an empty table, no crash");
  }
  // --- edge cases: small groups drop out of the table; hue needs nh > 20 ---
  {
    const s = {
      n: Float64Array.from([2000, 15, 100, 30, 0, 0, 0, 0, 0, 0]),
      de: Float64Array.from([200, 30, 50, 40, 0, 0, 0, 0, 0, 0]),
      dL: Float64Array.from([20, 3, 5, 4, 0, 0, 0, 0, 0, 0]),
      dC: Float64Array.from([10, 1.5, 2.5, 2, 0, 0, 0, 0, 0, 0]),
      dh: Float64Array.from([5, 0.4, 0, 1.2, 0, 0, 0, 0, 0, 0]),
      nh: Float64Array.from([500, 10, 0, 25, 0, 0, 0, 0, 0, 0]),
      bn: new Float64Array(77), bde: new Float64Array(77), all: 0.11,
      tLabSum: new Float64Array(30).fill(50), pLabSum: new Float64Array(30).fill(60),
    };
    const rows = A.tableOf(s);
    const ok = rows.length === 3 && rows[0].group === "greys" && rows[1].group === "warm saturated"
      && rows[2].group === "warm muted"
      && rows[0].dh !== null && rows[1].dh === null && rows[2].dh !== null
      && Math.abs(rows[0].dE - 0.1) < 1e-12 && Math.abs(rows[0].targetLab[0] - 0.025) < 1e-12;
    report(ok, "1g edge: groups under max(REPORT_SHARE*total, 20) drop out; hue is null at nh <= 20");
  }
  // --- edge cases: unaligned/masked pixels are excluded (a one-pixel reportMask) ---
  {
    const i0 = 1234, i1 = 4321;
    const m0 = new Uint8Array(P0.pd.h3 * P0.pd.w3); m0[i0] = 1;
    const s0 = A.regionSums(P0.pred, P0.targetLab, P0.labels, P0.bins, m0);
    const a = Float64Array.from([P0.pred[i0 * 3], P0.pred[i0 * 3 + 1], P0.pred[i0 * 3 + 2]])
      .map((v) => Math.min(1, Math.max(0, v)));
    const want = C.de2000(C.srgbToLab(a), P0.targetLab.subarray(i0 * 3, i0 * 3 + 3))[0];
    const m1 = new Uint8Array(P0.pd.h3 * P0.pd.w3); m1[i1] = 1;
    const s1 = A.regionSums(P0.pred, P0.targetLab, P0.labels, P0.bins, m1);
    const ok = s0.n.reduce((s, v) => s + v, 0) === 1 && s0.bn.reduce((s, v) => s + v, 0) === 1
      && Math.abs(s0.all - want) < 1e-9 && s0.n[P0.labels[i0]] === 1
      && s1.all !== s0.all;
    report(ok, "1g edge: only the reportMask pixels count (single-pixel sums match a direct dE)");
  }
  // --- the per-pixel maps: NaN outside the reportMask (dsc_6550's mask is all-ones —
  //     doctor a copy to exercise the masked-out path) ---
  {
    const mask = P0.reportMask.slice();
    for (let i = 0; i < mask.length; i += 3) mask[i] = 0;
    const maps = await A.mapsOf(P0.pred, P0.targetLab, mask);
    const n = P0.pd.h3 * P0.pd.w3;
    let inOk = true, outOk = true;
    for (let i = 0; i < n; i++) {
      if (mask[i]) inOk = inOk && Number.isFinite(maps.dE[i]) && Number.isFinite(maps.dL[i])
        && Number.isFinite(maps.dC[i]) && Number.isFinite(maps.dh[i]);
      else outOk = outOk && Number.isNaN(maps.dE[i]) && Number.isNaN(maps.dL[i])
        && Number.isNaN(maps.dC[i]) && Number.isNaN(maps.dh[i]);
    }
    report(maps.dE.length === n && inOk && outOk,
      "1g maps: dE/dL/dC/dh at H3*W3, finite inside / NaN outside the reportMask");
  }

  // --- the Worker end to end (node:worker_threads; the same module the page runs) ---
  {
    const { Worker } = await import("node:worker_threads");
    const w = new Worker(new URL("./lib/report-worker.js", import.meta.url), { type: "module" });
    const msgs = [];
    w.on("message", (m) => msgs.push(m));
    const waitFor = (pred, ms) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => {
        const hit = msgs.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error("timeout waiting for the report worker"));
        setTimeout(poll, 20);
      };
      poll();
    });
    const modelBytes = {
      devMeta: JSON.parse(await readFile(path.join(HERE, "model/dev.json"), "utf8")),
      devLut: (await readFile(path.join(HERE, "model/dev_lut.bin"))).buffer,
      profileMeta: JSON.parse(await readFile(path.join(HERE, "model/profile.json"), "utf8")),
      profileBin: (await readFile(path.join(HERE, "model/profile.bin"))).buffer,
    };
    const pairPayload = (key) => {
      const P = prepared[key];
      const entry = { name: key, generation: 7, files: P.pd.files,
                      w3: P.pd.w3, h3: P.pd.h3,
                      x: P.x.slice(), y: P.y.slice(),
                      masks: { reportMask: P.reportMask.slice() },
                      gain: Float64Array.from(P.pd.gain) };
      return [entry, [entry.x.buffer, entry.y.buffer, entry.masks.reportMask.buffer, entry.gain.buffer]];
    };
    let bad = null;
    try {
      // task 1: full pair data, the golden control at strength 100
      const [entry, transfer] = pairPayload("dsc_6550");
      w.postMessage({ type: "report", id: 1, generation: { session: 0, pair: 0, task: 1 },
        versionId: "draft", control, strength: 100, fittedRenderDE: null,
        pairs: [entry], ...modelBytes }, transfer);
      const r1 = await waitFor((m) => m.id === 1 && (m.type === "ready" || m.type === "error"), 120000);
      const rep = r1.type === "ready" ? r1.reports[0] : null;
      let eS = NaN;
      if (!rep) bad = r1.detail ?? "error";
      else {
        eS = sumsErr(rep.regionSums, fitDoc.regionSums);
        if (eS > 1e-4) bad = `worker regionSums rel ${eS.toExponential(1)}`;
        else if (!close(rep.summary.renderDE, fitDoc.summary.renderDE, 1e-5)) bad = "worker summary.renderDE";
        else if (!rep.maps || rep.maps.dE.length !== P0.pd.h3 * P0.pd.w3 || rep.maps.mode !== "dE") bad = "worker maps shape";
        else if (!close(r1.aggregate.regionSums.all, fitDoc.regionSums.all, 1e-5)) bad = "worker aggregate.all";
        else if (!msgs.some((m) => m.type === "progress" && m.id === 1)) bad = "no progress messages";
      }
      report(!bad,
        `1g worker: ready at strength 100 (regionSums rel ${eS.toExponential(1)},` +
        ` ${((r1.ms || 0) / 1000).toFixed(1)}s, progress posts, maps transferred)` +
        (bad ? ` — ${bad}` : ""));
      // the curve-thumbnail backdrop (spec/ui.md decision #8): the neutral's Y' luma histogram,
      // raw counts over the working grid, binned with detail.YW exactly like
      // renderer.lumaHistogram (re-derived here independently from model/detail.json)
      if (rep) {
        const { loadDev, develop } = await import("./lib/fit.js");
        const dev = loadDev(modelBytes.devMeta, modelBytes.devLut);
        const P = prepared.dsc_6550;
        const xg = new Float64Array(P.x.length);
        for (let i = 0; i < xg.length; i++) xg[i] = P.x[i] * P.pd.gain[i % 3];
        const fb = develop(dev, xg);
        const yw = JSON.parse(await readFile(path.join(HERE, "model/detail.json"), "utf8")).YW;
        const want = new Float64Array(256);
        for (let i = 0; i < fb.length; i += 3)
          want[Math.min(255, Math.floor((yw[0] * fb[i] + yw[1] * fb[i + 1] + yw[2] * fb[i + 2]) * 255))]++;
        const got = rep.neutralHist, agg = r1.aggregate.neutralHist;
        const ok = got && got.length === 256 && want.every((v, i) => v === got[i])
          && got.reduce((a, b) => a + b, 0) === fb.length / 3
          && agg && agg.every((v, i) => v === got[i]);
        report(ok, `1g worker: neutralHist = the Y' (detail.YW) histogram of the developed neutral,` +
          ` ${fb.length / 3} pixels; the one-pair aggregate equals it`);
      }
      // task 1b: a doctored generation (pixel 0 masked out) — the cache invalidates by the
      // pair generation and the maps are NaN at the excluded pixel (dsc_6550's own mask
      // is all-ones, so the plain run cannot show an outside-mask NaN)
      {
        msgs.length = 0;
        const [e1b, t1b] = pairPayload("dsc_6550");
        e1b.generation = 8;
        e1b.masks.reportMask[0] = 0;
        w.postMessage({ type: "report", id: 11, generation: { session: 0, pair: 0, task: 11 },
          versionId: "draft", control, strength: 100, fittedRenderDE: null,
          pairs: [e1b], ...modelBytes }, t1b);
        const r1b = await waitFor((m) => m.id === 11 && (m.type === "ready" || m.type === "error"), 120000);
        const ok = r1b.type === "ready" && Number.isNaN(r1b.reports[0].maps.dE[0])
          && Number.isFinite(r1b.reports[0].maps.dE[1]);
        report(ok, "1g worker: a generation change rebuilds the caches; masked-out pixels are NaN in the maps");
      }
      // task 2: the same pair by reference (the §4.1 caches) at strength 50
      msgs.length = 0;
      w.postMessage({ type: "report", id: 2, generation: { session: 0, pair: 0, task: 2 },
        versionId: "draft", control, strength: 50, fittedRenderDE: null,
        pairs: [{ name: "dsc_6550", generation: 8, files: P0.pd.files,
                  w3: P0.pd.w3, h3: P0.pd.h3 }], ...modelBytes });
      const r2 = await waitFor((m) => m.id === 2 && (m.type === "ready" || m.type === "error"), 120000);
      const want50 = scaled(JSON.parse(JSON.stringify(control)), 50);
      want50.name = control.name;
      bad = null;
      if (r2.type !== "ready") bad = r2.detail ?? "error";
      else if (r2.reports[0].summary.strength !== 50) bad = "strength";
      else if (JSON.stringify(r2.reports[0].parameters.result) !== JSON.stringify(want50)) bad = "scaled result";
      else if (r2.reports[0].summary.fittedDelta !== null) bad = "fittedDelta";
      report(!bad,
        `1g worker: the per-pair caches reuse (no arrays resent), strength applied` +
        ` (result = scaled(base, 50), name kept)${bad ? ` — ${bad}` : ""}`);
      // task 3: cancel between map chunks — the flag is observed at the chunk yields
      const nx = 512 * 512;
      const sx = new Float32Array(nx * 3).map(() => Math.random());
      const sy = new Float32Array(nx * 3).map(() => Math.random());
      const entry3 = { name: "synthetic", generation: 1, files: { raw: "s.NEF", target: "s.jpg" },
                       w3: 512, h3: 512, x: sx, y: sy,
                       masks: { reportMask: new Uint8Array(nx).fill(1) }, gain: [1, 1, 1] };
      w.postMessage({ type: "report", id: 3, generation: { session: 0, pair: 0, task: 3 },
        versionId: "draft", control, strength: 100, fittedRenderDE: null,
        pairs: [entry3], ...modelBytes },
        [sx.buffer, sy.buffer, entry3.masks.reportMask.buffer]);
      await waitFor((m) => m.type === "progress" && m.id === 3, 120000);
      w.postMessage({ type: "cancel", id: 3 });
      await new Promise((r) => setTimeout(r, 800));
      const leaked = msgs.some((m) => m.id === 3 && m.type !== "progress");
      report(!leaked, "1g worker: cancel between map chunks — no ready/error leaks for the cancelled task");
    } catch (err) {
      report(false, `1g worker: ${err.message}`);
    } finally {
      await w.terminate();
    }
  }
}

async function level9(ctx) {
  const { report, skip } = ctx;
  const F = await import("./lib/fit.js");
  const S = await import("./lib/sample.js");
  const PR = await import("./lib/profile.js");
  const { srgbToLab, de2000 } = await import("./lib/color.js");
  const g9 = async (rel) => {
    let b = await readFile(path.join(HERE, "golden", rel));
    if (rel.endsWith(".br")) b = brotliDecompressSync(b);
    return b;
  };
  const GROUPS = ["greys", "skin", "warm saturated", "warm muted", "yellows", "greens",
                  "teal/water", "sky", "dark blues", "purple"];   // analyze.GROUPS order (spec §4.1)

  const dev = F.loadDev(JSON.parse(await readFile(path.join(HERE, "model/dev.json"), "utf8")),
                        (await readFile(path.join(HERE, "model/dev_lut.bin"))).buffer);
  const pmeta = JSON.parse(await readFile(path.join(HERE, "model/profile.json"), "utf8"));
  const pbin = await readFile(path.join(HERE, "model/profile.bin"));
  const model = PR.loadModel(pmeta, pbin.buffer.slice(pbin.byteOffset, pbin.byteOffset + pbin.byteLength));

  // the prepared pairs: the shipped level-1e input sets' reference arrays — the exact
  // preparePair outputs (level 1e verifies the free preparation step separately at 1e-5)
  const prepared = {};
  for (const key of ["dsc_6550", "skl_3024"]) {
    const inj = JSON.parse(await readFile(path.join(HERE, "golden/pair", `${key}.in.json`), "utf8"));
    prepared[key] = {
      name: key, ncc: inj.reference.ncc,
      x: new Float32Array((await g9(inj.reference.arrays.x)).buffer),
      y: new Float32Array((await g9(inj.reference.arrays.y)).buffer),
      gain: Float64Array.from(inj.inputs.gain),
    };
  }

  // the quality-bar reference: Python's per-group mean dE at the fit control
  const refDoc = JSON.parse(await readFile(path.join(HERE, "golden/report/dsc_6550__fit.json"), "utf8"));
  const labelsB = await g9("report/dsc_6550__labels.u8");
  const labels = new Uint8Array(labelsB.buffer, labelsB.byteOffset, labelsB.byteLength);
  const sums = refDoc.regionSums;
  const pythonMean = sums.de.map((v, i) => (sums.n[i] > 0 ? v / sums.n[i] : null));
  const TOL = 0.1;    // the level-9 tolerance: no group worse than Python by more than 0.1 dE

  // the fits run as in the page: free sampling + the parallel Jacobian (lib/fit-pool.js)
  const fitPool = await nodeFitPool();
  // the single-pair case asserts the quality bar; the two-pair case runs free as the
  // runtime/convergence data point (its per-group table is printed below — see web-tests.md
  // for why the 0.1 dE bar is not asserted there)
  for (const [name, keys, assertBar] of [["single", ["dsc_6550"], true],
                                         ["two", ["dsc_6550", "skl_3024"], false]]) {
    const t0 = Date.now();
    const out = await S.runFreeFitParallel(keys.map((k) => prepared[k]),
                                           { dev, model, seed: 0, iters: 30, baseName: "level9",
                                             makePool: fitPool.makePool });
    const secs = (Date.now() - t0) / 1000;
    // the browser control applied to the prepared x through the CPU prediction path
    const p = PR.paramsOf(JSON.parse(JSON.stringify(out.control)), model);
    const q = out.qs[0];                    // dsc_6550 is the report pair (first in both cases)
    const pred = new PR.Pixels(model, q.b).apply(p);
    const d = de2000(srgbToLab(pred), srgbToLab(q.t));
    const bad = [];
    if (labels.length !== d.length) bad.push(`labels ${labels.length} px vs ${d.length}`);
    if (out.iterations.run < 1 || !(out.cost > 0)) bad.push("no convergence");
    const browser = GROUPS.map((_, g) => {
      let n = 0, s = 0;
      for (let i = 0; i < labels.length; i++) if (labels[i] === g) { n++; s += d[i]; }
      return n ? s / n : null;
    });
    let allN = 0, all = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] !== 255) { allN++; all += d[i]; }
    all /= allN;
    let worst = -Infinity;
    const rows = [];
    for (let g = 0; g < 10; g++) {
      if (browser[g] === null || pythonMean[g] === null) continue;
      const margin = browser[g] - pythonMean[g];
      worst = Math.max(worst, margin);
      rows.push(`${GROUPS[g]} ${browser[g].toFixed(3)}/${pythonMean[g].toFixed(3)}`);
      if (assertBar && margin > TOL) bad.push(`${GROUPS[g]} +${margin.toFixed(3)}`);
    }
    report(!bad.length,
      `9 fit ${name}: cost ${out.cost.toFixed(2)}, ${out.iterations.run}/${out.iterations.requested}` +
      ` iterations, ${secs.toFixed(1)}s, all ${all.toFixed(3)} (Python ${sums.all.toFixed(3)}) dE` +
      (bad.length ? ` — WORSE: ${bad.join(", ")}`
                  : `, worst group margin ${worst >= -1e9 ? (worst >= 0 ? "+" : "") + worst.toFixed(3) : "n/a"} dE`));
    console.log(`9 ${name} per-group browser/Python dE: ${rows.join("  ")}`);
    console.log(`9 ${name} scores: ${out.scores.map((s2) =>
      `${s2.pair} neutral ${s2.neutral.toFixed(3)} prediction ${s2.prediction.toFixed(3)}`).join(", ")}`);
  }
}

async function level4(ctx) {
  const { report, skip } = ctx;
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

async function level5(ctx) {
  const { report, skip } = ctx;
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

// ---------- level 1h: the undo/redo history (stage 6) ----------
// The history (lib/history.js) runs behind a tiny window/sessionStorage shim. (The strength-set
// part of this level is gone with the export itself — spec/ui.md decision #10.)
async function level1h(ctx) {
  const { report } = ctx;
  // ---- history: undo/redo over a counter state, in a shim ----
  const store = new Map();
  const listeners = [];
  const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage };
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  globalThis.window = { addEventListener: (type, fn) => { if (type === "keydown") listeners.push(fn); } };
  try {
    const { createHistory, HIST_KEY } = await import("./lib/history.js");
    let value = 0, changes = 0;
    const h = createHistory({ snapshot: () => ({ value }), apply: (s) => { value = s.value; },
                              onChange: () => changes++ });
    const key = (k, mods = {}, target = null) => {
      let prevented = false;
      const ev = { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods,
                   target: target || { closest: () => null }, preventDefault: () => { prevented = true; } };
      for (const fn of listeners) fn(ev);
      return prevented;
    };
    const fails = [];
    let nChecks = 0;
    const check = (cond, msg) => { nChecks++; if (!cond) fails.push(msg); };
    h.push(); value = 1; h.push(); value = 2; h.push();              // states 0, 1, 2
    check(h.canUndo && !h.canRedo && h.length === 3 && h.index === 2, "after 3 pushes");
    h.undo(); h.undo();
    check(value === 0 && !h.canUndo && h.canRedo, `undo x2 -> ${value}`);
    check(h.undo() === false && value === 0, "undo at the start is a no-op");
    h.redo();
    check(value === 1 && h.canUndo && h.canRedo, `redo -> ${value}`);
    value = 5; h.push();                                             // cuts off the redo chain
    check(!h.canRedo && h.length === 3 && h.redo() === false, "a new action cuts off the redo future");
    h.undo();
    check(value === 1, `undo after the cut -> ${value}`);
    check(key("z", { ctrlKey: true, shiftKey: true }) && value === 5, "Ctrl+Shift+Z redoes");
    check(key("z", { metaKey: true }) && value === 1, "Cmd+Z undoes");
    check(key("y", { ctrlKey: true }) && value === 5, "Ctrl+Y redoes");
    check(key("Z", { ctrlKey: true, shiftKey: true }) === true && value === 5, "Shift+Z at the end is a no-op");
    const textField = { closest: () => ({}) };
    check(!key("z", { ctrlKey: true }, textField) && value === 5, "Ctrl+Z in a text field is native");
    check(!key("y", { ctrlKey: true }, textField) && value === 5, "Ctrl+Y in a text field is native");
    check(!key("z", {}) && value === 5, "plain z is ignored");
    const st = JSON.parse(store.get(HIST_KEY));
    check(Array.isArray(st.stack) && st.idx === st.stack.length - 1, "stored format {stack, idx}");
    check(changes > 0, "onChange fires");
    // backward compatibility: an undo-only stored history loads, with a redo future if idx < end
    store.set(HIST_KEY, JSON.stringify({ stack: [{ value: 7 }, { value: 8 }, { value: 9 }], idx: 1 }));
    let v2 = 8;
    const h2 = createHistory({ snapshot: () => ({ value: v2 }), apply: (s) => { v2 = s.value; } });
    check(h2.length === 3 && h2.index === 1 && h2.canRedo && h2.redo() && v2 === 9, "an old stored history loads");
    h2.clear();
    check(h2.length === 0 && !h2.canUndo && !h2.canRedo, "clear");
    report(fails.length === 0, `1h history undo/redo: ${fails.length ? fails.join("; ") : `${nChecks} checks`}`);
  } finally {
    globalThis.window = saved.window;
    globalThis.sessionStorage = saved.sessionStorage;
  }
}
