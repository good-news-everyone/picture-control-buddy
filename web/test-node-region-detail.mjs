// Node test of the region detail path (CPU twin): applyDetailCPU with and without lowRes.
// Stage Z4 of spec/ui-zoom-plan.md (decisions D5/D6). Run: cd web && node test-node-region-detail.mjs
// Uses the real detail model (model/detail.json + detail.bin) and a real frame when a local RAW exists
// (golden/manifest.json, developed with lib/raw.js at half sensor and tone-mapped to a display-like 0..1),
// else a synthetic textured image. Exit 1 on failure. The GPU twin is checked by web/region-check.html.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDetail, applyDetailCPU, lumaOf, regionEntries, regionMarginPx, REGION_LOWRES_MIN_SIGMA } from "./lib/detail.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const dm = JSON.parse(await readFile(path.join(HERE, "model/detail.json"), "utf8"));
const db = await readFile(path.join(HERE, "model", dm.bin || "detail.bin"));
const D = loadDetail(dm, db.buffer.slice(db.byteOffset, db.byteOffset + db.byteLength));

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

// ---------- the frame (display-like 0..1 rgb, Float32Array, row 0 at the top) ----------
const FW = 1800, FH = 1400;
async function realFrame() {
  const man = JSON.parse(await readFile(path.join(HERE, "golden/manifest.json"), "utf8"));
  for (const r of man.raw) {
    if (r.dng) continue;
    const f = [path.join(ROOT, r.path), path.join(ROOT, "_local", r.path)].find((c) => existsSync(c));
    if (!f) continue;
    const { initRaw } = await import("./lib/raw.js");
    const raw = await initRaw(await readFile(path.join(HERE, "raw.wasm")));
    const dev = raw.develop(new Uint8Array(await readFile(f)), 0);
    if (dev.w < FW || dev.h < FH) continue;
    const x0 = (dev.w - FW) >> 1, y0 = (dev.h - FH) >> 1;
    const lin = new Float32Array(FW * FH * 3);
    for (let y = 0; y < FH; y++) lin.set(dev.rgb.subarray(((y0 + y) * dev.w + x0) * 3, ((y0 + y) * dev.w + x0 + FW) * 3), y * FW * 3);
    const sorted = Float32Array.from(lin).sort();
    const med = Math.max(sorted[sorted.length >> 1], 1e-4);
    const k = Math.pow(0.45, 2.2) / med;                       // median -> display 0.45
    for (let i = 0; i < lin.length; i++) lin[i] = Math.pow(Math.min(1, lin[i] * k), 1 / 2.2);
    return { rgb: lin, name: r.key };
  }
  return null;
}
function syntheticFrame() {
  let s = 7;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const gw = 64, gh = 48, grid = Array.from({ length: 4 }, () => Float64Array.from({ length: gw * gh }, rnd));
  const rgb = new Float32Array(FW * FH * 3);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    let v = 0, amp = 0.5, fq = 1 / 300;
    for (let o = 0; o < 4; o++, amp /= 2, fq *= 3) {        // value noise, 4 octaves
      const gx = x * fq, gy = y * fq, ix = Math.floor(gx) % (gw - 1), iy = Math.floor(gy) % (gh - 1);
      const tx = gx - Math.floor(gx), ty = gy - Math.floor(gy), g = grid[o];
      v += amp * ((g[iy * gw + ix] * (1 - tx) + g[iy * gw + ix + 1] * tx) * (1 - ty) + (g[(iy + 1) * gw + ix] * (1 - tx) + g[(iy + 1) * gw + ix + 1] * tx) * ty);
    }
    v = 0.15 + 0.7 * v + ((x >> 7) + (y >> 7) & 1 ? 0.08 : 0);   // plus hard edges
    for (let c = 0; c < 3; c++) rgb[(y * FW + x) * 3 + c] = Math.min(1, Math.max(0, v * (1 - 0.1 * c) + 0.02 * c));
  }
  return { rgb, name: "synthetic" };
}
const frame = (await realFrame()) || syntheticFrame();
console.log(`frame: ${frame.name}, ${FW}x${FH}`);

// ---------- helpers ----------
const crop = (src, sw, x, y, w, h) => {
  const o = new Float32Array(w * h * 3);
  for (let r = 0; r < h; r++) o.set(src.subarray(((y + r) * sw + x) * 3, ((y + r) * sw + x + w) * 3), r * w * 3);
  return o;
};
const boxDown = (src, w, h, f) => {                            // f x f box mean, w and h divisible by f
  const mw = w / f, mh = h / f, o = new Float32Array(mw * mh * 3);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) for (let c = 0; c < 3; c++) {
    let a = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) a += src[((y * f + dy) * w + x * f + dx) * 3 + c];
    o[(y * mw + x) * 3 + c] = a / (f * f);
  }
  return o;
};
// max / rms of |a - b| * 255 over the interior [m, w - m) x [m, h - m) of an h x w x 3 pair
const diff = (a, b, w, h, mx, my = mx) => {
  let max = 0, sq = 0, n = 0;
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) for (let c = 0; c < 3; c++) {
    const d = Math.abs(a[(y * w + x) * 3 + c] - b[(y * w + x) * 3 + c]) * 255;
    if (d > max) max = d;
    sq += d * d; n++;
  }
  return { max, rms: Math.sqrt(sq / n) };
};
const ctl = (clarity = 0, mid = 0, sharp = 0) => ({ clarity, mid_sharpening: mid, sharpening: sharp });
const f2 = (v) => v.toFixed(2), f4 = (v) => v.toFixed(4);
const T0 = performance.now();

// ---------- 1. no lowRes: an interior crop with a margin reproduces the full-frame detail ----------
console.log("\n1. region (margin = regionMarginPx) vs the same crop of the full-frame CPU detail, no lowRes");
for (const [scale, control, label] of [
  [2, ctl(5, 5, 5), "scale 2, Clarity 5 / Mid 5 / Sharp 5"],
  [2, ctl(-5, -5, -3), "scale 2, Clarity -5 / Mid -5 / Sharp -3"],
  [1, ctl(5, 0, 0), "scale 1, Clarity 5"],
  [1, ctl(0, -5, 5), "scale 1, Mid -5 / Sharp 5"],
]) {
  const R = regionMarginPx(D, control, scale, { base: true });
  const full = applyDetailCPU(D, frame.rgb, FW, FH, control, { scale, base: true });
  // region: the frame minus 100 px at each side, so its own edges are at least R away from the interior we compare
  const m = 100, rw = FW - 2 * m, rh = FH - 2 * m;
  const reg = applyDetailCPU(D, crop(frame.rgb, FW, m, m, rw, rh), rw, rh, control, { scale, base: true });
  const fc = new Float64Array(rw * rh * 3);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw * 3; x++) fc[y * rw * 3 + x] = full[((y + m) * FW) * 3 + m * 3 + x];
  const e = diff(reg, fc, rw, rh, R, R);
  const ok = rw - 2 * R > 0 && rh - 2 * R > 0 && e.max < 1e-4;
  check(ok, `${label}: margin ${R}, interior ${rw - 2 * R}x${rh - 2 * R}, max |d| ${e.max.toExponential(2)} (of 255), rms ${e.rms.toExponential(2)}`);
}

// ---------- 2. lowRes: large blurs from a downsampled "main" frame ----------
console.log(`\n2. lowRes (minSigma ${REGION_LOWRES_MIN_SIGMA} main px): region vs the same crop of the full-frame CPU detail, 8-bit levels`);
const results = [];
const TOL = 0.5;
for (const scale of [1, 2]) {
  for (const f of [2, 4]) {
    const mainScale = f * scale;
    const main = boxDown(frame.rgb, FW, FH, f), mw = FW / f, mh = FH / f;
    const mainLuma = lumaOf(D, main, mw, mh);
    const rx = 400, ry = 300, rw0 = 800, rh0 = 600;           // the crop (region incl. its margin)
    for (const [control, label] of [
      [ctl(5, 0, 0), "Clarity +5"], [ctl(-5, 0, 0), "Clarity -5"],
      [ctl(0, 5, 0), "Mid-range +5"], [ctl(0, -5, 0), "Mid-range -5"],
      [ctl(5, 5, 5), "Clarity 5 / Mid 5 / Sharp 5"],
    ]) {
      const fullKey = `${scale}|${JSON.stringify(control)}`;
      const full = applyDetailCPU(D, frame.rgb, FW, FH, control, { scale, base: true });
      const lowRes = { affine: [1 / f, 0, rx / f, 0, 1 / f, ry / f], mainLuma, mainW: mw, mainH: mh, mainScale };
      const R = regionMarginPx(D, control, scale, { base: true, lowRes });
      const reg = applyDetailCPU(D, crop(frame.rgb, FW, rx, ry, rw0, rh0), rw0, rh0, control, { scale, base: true, lowRes });
      const fc = new Float64Array(rw0 * rh0 * 3);
      for (let y = 0; y < rh0; y++) for (let x = 0; x < rw0 * 3; x++) fc[y * rw0 * 3 + x] = full[((y + ry) * FW) * 3 + rx * 3 + x];
      const e = diff(reg, fc, rw0, rh0, R, R);
      const split = regionEntries(D, control, scale, { base: true, lowRes }).map((s) => s.mainSigma === null ? "r" : "M").join("");
      results.push({ scale, f, label, ...e, R, split });
      console.log(`  scale ${scale}, main x${f} (mainScale ${mainScale}), ${label.padEnd(28)} entries [${split}] margin ${String(R).padStart(3)}: max ${f2(e.max)}, rms ${f4(e.rms)}`);
    }
  }
}
const worst = results.reduce((a, r) => (r.max > a.max ? r : a), results[0]);
check(worst.max < TOL, `lowRes max error ${f2(worst.max)} / 255 < ${TOL} (worst: scale ${worst.scale}, main x${worst.f}, ${worst.label})`);

// threshold sweep (information): Clarity +5 / Mid +5 together at the largest errors
console.log("\n   threshold sweep, Mid-range +5 (sigma 12 full-frame px at region scale 1-2), max error / 255:");
for (const scale of [1, 2]) for (const f of [2, 4]) {
  const control = ctl(0, 5, 0), mainScale = f * scale;
  const main = boxDown(frame.rgb, FW, FH, f), mainLuma = lumaOf(D, main, FW / f, FH / f);
  const rx = 400, ry = 300, rw0 = 800, rh0 = 600;
  const full = applyDetailCPU(D, frame.rgb, FW, FH, control, { scale, base: true });
  const row = [];
  for (const minSigma of [1, 2, 3, 4, 6, 8, Infinity]) {
    const lowRes = { affine: [1 / f, 0, rx / f, 0, 1 / f, ry / f], mainLuma, mainW: FW / f, mainH: FH / f, mainScale, minSigma };
    const R = regionMarginPx(D, control, scale, { base: true, lowRes });
    const reg = applyDetailCPU(D, crop(frame.rgb, FW, rx, ry, rw0, rh0), rw0, rh0, control, { scale, base: true, lowRes });
    const fc = new Float64Array(rw0 * rh0 * 3);
    for (let y = 0; y < rh0; y++) for (let x = 0; x < rw0 * 3; x++) fc[y * rw0 * 3 + x] = full[((y + ry) * FW) * 3 + rx * 3 + x];
    row.push(`T=${minSigma}: ${f2(diff(reg, fc, rw0, rh0, R, R).max)}`);
  }
  console.log(`   scale ${scale}, main x${f}: ${row.join("  ")}`);
}

// the affine map is used generally: a transposed region (a = e = 0, b = d = 1/f) equals the transposed result
{
  const scale = 2, f = 4, control = ctl(5, 5, 0);
  const mw = FW / f, mh = FH / f, main = boxDown(frame.rgb, FW, FH, f);
  const mainLuma = lumaOf(D, main, mw, mh);
  const mainT = new Float64Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) mainT[x * mh + y] = mainLuma[y * mw + x];
  const rx = 300, ry = 200, rw0 = 500, rh0 = 400;
  const cr = crop(frame.rgb, FW, rx, ry, rw0, rh0);
  const crT = new Float32Array(rw0 * rh0 * 3);                // region transposed: X runs along the old rows
  for (let y = 0; y < rh0; y++) for (let x = 0; x < rw0; x++) for (let c = 0; c < 3; c++) crT[(x * rh0 + y) * 3 + c] = cr[(y * rw0 + x) * 3 + c];
  const a = applyDetailCPU(D, cr, rw0, rh0, control, { scale, base: true, lowRes: { affine: [1 / f, 0, rx / f, 0, 1 / f, ry / f], mainLuma, mainW: mw, mainH: mh, mainScale: f * scale } });
  // transposed region pixel (X, Y) = original (Y, X): main x = Y/f + ry/f... i.e. mainX = (0*X + 1*Y)/f + ry/f?
  // original (x, y) -> main (x/f + rx/f, y/f + ry/f); region (X, Y) is original (x = Y, y = X) -> mainX = Y/f + rx/f, mainY = X/f + ry/f
  const b = applyDetailCPU(D, crT, rh0, rw0, control, { scale, base: true, lowRes: { affine: [0, 1 / f, rx / f, 1 / f, 0, ry / f], mainLuma, mainW: mw, mainH: mh, mainScale: f * scale } });
  let max = 0;
  for (let y = 0; y < rh0; y++) for (let x = 0; x < rw0; x++) for (let c = 0; c < 3; c++)
    max = Math.max(max, Math.abs(a[(y * rw0 + x) * 3 + c] - b[(x * rh0 + y) * 3 + c]) * 255);
  check(max < 1e-6, `affine with b, d (transposed region) equals the transposed result: max ${max.toExponential(2)}`);
}

// ---------- 3. no tools -> identity; base detail is off at scales 1 and 2 ----------
console.log("\n3. controls");
{
  const w = 300, h = 200, rgb = crop(frame.rgb, FW, 500, 500, w, h);
  for (const scale of [1, 2]) {
    const out = applyDetailCPU(D, rgb, w, h, ctl(0, 0, 0), { scale, base: true });
    let max = 0;
    for (let i = 0; i < rgb.length; i++) max = Math.max(max, Math.abs(out[i] - rgb[i]));
    check(max === 0, `scale ${scale}: all tools 0 with base requested -> output = input (max |d| ${max})`);
    const n = regionEntries(D, ctl(0, 0, 0), scale, { base: true }).length;
    check(n === 0, `scale ${scale}: no entries (base detail off outside BASE_RANGE)`);
  }
  check(regionEntries(D, ctl(0, 0, 0), 4, { base: true }).length === 1, "scale 4: the base detail is the only entry (control)");
  // lowRes with all tools 0 stays the identity as well
  const lowRes = { affine: [0.5, 0, 0, 0, 0.5, 0], mainLuma: lumaOf(D, boxDown(frame.rgb, FW, FH, 2), FW / 2, FH / 2), mainW: FW / 2, mainH: FH / 2, mainScale: 4 };
  const out = applyDetailCPU(D, rgb, w, h, ctl(0, 0, 0), { scale: 2, base: true, lowRes });
  let max = 0;
  for (let i = 0; i < rgb.length; i++) max = Math.max(max, Math.abs(out[i] - rgb[i]));
  check(max === 0, `lowRes with all tools 0 -> output = input (max |d| ${max})`);
}

// default behavior of the existing API is untouched: no lowRes -> the same as before (a region of the
// frame equals the plain call), and the margin helper agrees with the kernel radius
{
  const R = regionMarginPx(D, ctl(5, 5, 5), 2, { base: true });
  check(R === Math.ceil(3 * 90) + 1, `margin helper: scale 2 without lowRes -> kernel radius of sigma 90 (${R})`);
  const R2 = regionMarginPx(D, ctl(5, 5, 5), 2, { base: true, lowRes: { mainScale: 4 } });
  console.log(`   margin at scale 2 with lowRes (main x4): ${R2} px (without: ${R})`);
}

console.log(`\n${failures ? "FAILED: " + failures : "all ok"} (${((performance.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(failures ? 1 : 0);
