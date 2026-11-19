// Reference tests of the browser copy of the pipeline against Python. One command:
//
//     node web/test.mjs
//
// The GPU-less parts (RAW decoding, levels 1 and 1a) run in Node, the shaders (levels 2 and 2a) —
// on the real page in headless Firefox via puppeteer-core. The exit code is non-zero on failure.
// Fixtures and tolerances: web/golden/ (web/make_golden.py), levels and rules: spec/web-tests.md.
import http from "node:http";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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

// ---------- level 1b: target-side pure modules in Node (spec/web-schemas.md §7.1, JPEG-only) ----------
{
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

// ---------- level 1d: resampling kernels in Node (web/lib/resample.js vs PIL, spec §6.2) ----------
{
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

// ---------- level 1e: preparePair in Node (the devpairs.build port, spec/web-schemas.md §2) ----------
{
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
  }

  // extractEmbeddedJpeg: a pure port of the pairs.embedded_jpeg marker scan (two candidates,
  // the widest wins; a candidate without a SOF segment is skipped)
  const jpg = (w, h) => Uint8Array.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x08, 0x08,
                                         h >> 8, h & 255, w >> 8, w & 255, 0x03, 0xFF, 0xD9]);
  const broken = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x08, 1, 2, 3, 0xFF, 0xD9]);
  const raw = new Uint8Array([9, 9, 9, 9, ...jpg(100, 50), 0, 0, ...broken, 7, ...jpg(640, 480), 1, 2, 3]);
  const got = P.extractEmbeddedJpeg(raw);
  const want = jpg(640, 480);
  const extOk = !!got && got.length === want.length && got.every((v, i) => v === want[i]);
  report(extOk, `1e extractEmbeddedJpeg: the widest candidate of ${raw.length} synthetic bytes`
         + (extOk ? "" : ` (got ${got?.length ?? "null"} bytes)`));
  report(P.extractEmbeddedJpeg(new Uint8Array([1, 2, 3])) === null,
    "1e extractEmbeddedJpeg: no JPEG -> null (the DNG-without-preview path)");
}

// ---------- level 1f: the fitting engine in Node (web/lib/fit.js + sample.js, spec/web-schemas.md §3) ----------
{
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
      cmask: Uint8Array.from([1, 0, 0]),
    };
    const q2 = { n: 1, tlab: new Float64Array(3), W: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), px: fake([0, 0, 0]), cpx: null };
    const r = F.residual([q1, q2], x);
    const expected = [
      -1, 0.5, 0, 1, 0, -1,          // main: (pred - tlab) / sqrt(2 * 2)
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
    const got = F.fit(qs, fdoc.iterations.requested);
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
      (bad.length ? ` — ${bad.join("; ")}` : ""));
  }

  // --- the parallel Jacobian (lib/fit-pool.js + lib/fit-jac-worker.js): bit-identical to the sync fit ---
  // Node has no Web Worker, so the helpers run in worker_threads behind a tiny `self` shim.
  {
    const { Worker } = await import("node:worker_threads");
    const { pathToFileURL } = await import("node:url");
    const { createFitPool, poolSize } = await import("./lib/fit-pool.js");
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
    const { got, qs, iters, secs } = syncFits.single;
    const t0 = Date.now();
    const { availableParallelism } = await import("node:os");
    const size = Math.max(2, poolSize(availableParallelism()));    // this machine's real pool size
    const pool = await createFitPool({ spawn, size, profileMeta: pmeta,
      profileBin: pbin.buffer.slice(pbin.byteOffset, pbin.byteOffset + pbin.byteLength), qs });
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

// ---------- level 1g: the report engine (web/lib/analyze.js + web/lib/report-worker.js, spec/web-schemas.md §4) ----------
{
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

  // --- the §4.4 download document ---
  {
    const result = scaled(JSON.parse(JSON.stringify(control)), 100);
    result.name = control.name;          // strength.scaled(base, 100, base.name) keeps the name
    const dl = A.downloadDoc({
      generator: "np3-fit web <git describe>",
      files: P0.pd.files,
      version: { id: "draft", name: control.name, strength: 100 },
      summary: A.summaryOf(S0, neutralDoc.summary.renderDE, 100, null),
      table: A.tableOf(S0),
      aggregate: aggDoc.aggregate,
      parameters: { base: control, result, deltas: null },
    });
    const want = JSON.parse(await readFile(path.join(HERE, "golden/report/report_download.json"), "utf8"));
    const bad = deepClose({ ...dl, generator: null }, { ...want, generator: null }, 1e-4, 1e-9, "download");
    report(!bad && /^np3-fit web \S+$/.test(want.generator),
      `1g download doc vs golden (§4.4, generator is a git describe: "${want.generator}")${bad ? ` — ${bad}` : ""}`);
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

// ---------- level 9: the full free browser fit vs the Python quality bar ----------
// (spec/web-tests.md level 9: the shipped prepared inputs -> free sampling with the browser's
// own PRNG, no injected indices -> LM fit -> control; per-group mean dE2000 on the reportMask
// pixels vs Python's report/<key>__fit.json regionSums — no group worse than Python by > 0.1 dE)
{
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

  // the single-pair case asserts the quality bar; the two-pair case runs free as the
  // runtime/convergence data point (its per-group table is printed below — see web-tests.md
  // for why the 0.1 dE bar is not asserted there)
  for (const [name, keys, assertBar] of [["single", ["dsc_6550"], true],
                                         ["two", ["dsc_6550", "skl_3024"], false]]) {
    const t0 = Date.now();
    const out = S.runFreeFit(keys.map((k) => prepared[k]),
                             { dev, model, seed: 0, iters: 30, baseName: "level9" });
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
// protocolTimeout: level 8 fits in the page (stage 3) legitimately run for minutes — a
// waitForFunction is one long-lived BiDi call, so the default 180 s cap kills healthy waits
const browser = await puppeteer.launch({ browser: "firefox", executablePath: firefox,
                                         headless: true, protocolTimeout: 900000 });
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

  // ---------- level 1c: decodeTarget in the browser vs the PIL reference grid ----------
  {
    const tdir = path.join(HERE, "golden", "target");
    const all = (await readdir(tdir)).filter((f) => f.endsWith(".json") && f !== "wb.json");
    const jm = {};
    for (const c of all.map((f) => f.replace(".json", "")))
      jm[c] = JSON.parse(await readFile(path.join(tdir, c + ".json"), "utf8"));
    const cases = Object.keys(jm).filter((c) => jm[c].image.format === "JPEG");
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("pageerror (target-check):", e.message));
    await page.goto(`http://127.0.0.1:${port}/web/target-check.html?cases=${cases.join(",")}`);
    await page.waitForFunction("window.__done === true", { timeout: 120000, polling: 500 });
    const rows = await page.evaluate("window.__result");
    await page.close();
    for (const c of cases) {
      const r = rows.find((v) => v.key === c);
      const tol = jm[c].ref.browserMaxLevels;
      const ok = !!r && !r.error && r.w === jm[c].image.w && r.h === jm[c].image.h && r.max <= tol;
      report(ok, `1c decode ${c}: ${!r ? "no result" : r.error || `${r.w}x${r.h},` +
        ` max ${r.max.toFixed(3)} of 255 levels (tolerance ${tol})`}`);
    }
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
} finally {
  await browser.close();
  server.close();
}

console.log((failed ? `\nfailures: ${failed}` : "\nall tests green") + (skipped ? `, skipped: ${skipped}` : ""));
process.exit(failed ? 1 : 0);
