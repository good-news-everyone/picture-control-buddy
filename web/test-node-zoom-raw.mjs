// Node test of the zoom decoder wrappers (lib/raw.js hold / roi / release) against web/raw.wasm.
// Stage Z2 of spec/ui-zoom-plan.md. Run: cd web && node test-node-zoom-raw.mjs
// Skips (exit 0) when raw.wasm has no hold/roi exports (run `sh web/build.sh`) or no local RAW exists.
// Checks: (1) level 2 equals develop(long = 0) unrotated bit for bit (whole area, random sub-rects);
// (2) the error codes; (3) a level-1 ROI equals the same crop of a larger level-1 ROI sharing the
// corner or lying well inside it (no border artifacts thanks to the internal margin);
// (4) level 1 vs level 2 stats, (5) timings.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initRaw } from "./lib/raw.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const man = JSON.parse(await readFile(path.join(HERE, "golden/manifest.json"), "utf8"));
const rootFile = (p) => {
  for (const c of [path.join(ROOT, p), path.join(ROOT, "_local", p)]) if (existsSync(c)) return c;
  return null;
};

const raw = await initRaw(await readFile(path.join(HERE, "raw.wasm")));
if (!raw.zoom) {
  console.log("skipped: raw.wasm has no hold/roi — run sh web/build.sh");
  process.exit(0);
}

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
const same = (a, b) => {
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length), y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  if (x.length !== y.length) return -1;
  let bad = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) bad++;
  return bad;
};
const crop = (src, sw, x, y, w, h) => {
  const o = new Float32Array(w * h * 3);
  for (let r = 0; r < h; r++) o.set(src.subarray(((y + r) * sw + x) * 3, ((y + r) * sw + x + w) * 3), r * w * 3);
  return o;
};
let seed = 12345;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };

// the first NEF and the first DNG of the manifest that exist locally
const files = [];
for (const dng of [false, true]) {
  const c = man.raw.find((r) => !!r.dng === dng && rootFile(r.path));
  if (c) files.push(c);
}
if (!files.length) { console.log("skipped: no local RAW files (see golden/manifest.json)"); process.exit(0); }

for (const c of files) {
  const bytes = new Uint8Array(await readFile(rootFile(c.path)));
  console.log(`--- ${c.key}`);
  const dev = raw.develop(bytes, 0);   // reference: half resolution, rotated by the orientation tag (undone below)
  const orient = dev.info.orientation;
  const turns = { 3: 2, 6: 3, 8: 1 }[orient] || 0;
  const [sw, sh] = turns % 2 ? [dev.h, dev.w] : [dev.w, dev.h];
  const small = new Float32Array(sw * sh * 3);
  for (let y = 0; y < dev.h; y++) for (let x = 0; x < dev.w; x++) {
    const [sy, sx] = turns === 1 ? [x, sw - 1 - y] : turns === 2 ? [sh - 1 - y, sw - 1 - x] : turns === 3 ? [sh - 1 - x, y] : [y, x];
    small.set(dev.rgb.subarray((y * dev.w + x) * 3, (y * dev.w + x) * 3 + 3), (sy * sw + sx) * 3);
  }
  dev.rgb = null;

  let t = performance.now();
  const { info } = raw.hold(bytes);
  const holdMs = performance.now() - t;
  const [W, H] = info.held;
  console.log(`hold ${holdMs.toFixed(0)} ms, held ${W}x${H}, margin ${info.margin}, cfa ${info.cfa}, orientation ${info.orientation}`);
  check(W / 2 === sw && H / 2 === sh && info.orientation === orient, `held area ${W}x${H} = twice develop(0) ${sw}x${sh} (orientation ${orient})`);

  // (1) level 2
  const whole = raw.roi(0, 0, sw, sh, 2);
  let bad = same(whole.rgb, small);
  check(bad === 0, `1 level 2 whole area equals develop(long = 0) unrotated (${bad} differing samples)`);
  bad = 0;
  for (let i = 0; i < 30; i++) {
    const w = 1 + rnd(300), h = 1 + rnd(300), x = rnd(sw - w + 1), y = rnd(sh - h + 1);
    bad += same(raw.roi(x, y, w, h, 2).rgb, crop(small, sw, x, y, w, h));
  }
  check(bad === 0, `1 level 2, 30 random sub-rectangles equal the develop(0) crop (${bad} differing samples)`);

  // (3) level 1: sub-rectangles vs a larger reference ROI
  const RW = 1600, RH = 1200;
  const cases = [["interior", (W - RW) >> 1, (H - RH) >> 1], ["top-left", 0, 0], ["top-right", W - RW, 0], ["bottom-left", 0, H - RH], ["bottom-right", W - RW, H - RH]];
  for (const [name, rx, ry] of cases) {
    t = performance.now();
    const ref = raw.roi(rx, ry, RW, RH, 1);
    const ms = performance.now() - t;
    bad = 0;
    for (let i = 0; i < 12; i++) {
      // inside the reference, 10 px away from its sides that are not held-area edges
      const x0 = rx > 0 ? 10 : 0, y0 = ry > 0 ? 10 : 0;
      const x1 = rx + RW < W ? RW - 10 : RW, y1 = ry + RH < H ? RH - 10 : RH;
      const w = 1 + rnd(Math.min(300, x1 - x0)), h = 1 + rnd(Math.min(300, y1 - y0));
      const x = x0 + rnd(x1 - x0 - w + 1), y = y0 + rnd(y1 - y0 - h + 1);
      bad += same(raw.roi(rx + x, ry + y, w, h, 1).rgb, crop(ref.rgb, RW, x, y, w, h));
    }
    check(bad === 0, `3 level 1 ${name}: 12 sub-ROIs equal the crop of a ${RW}x${RH} ROI (${bad} differing samples; reference ${ms.toFixed(0)} ms)`);
  }
  // corners and a 1x1 ROI at the very edge of the held area
  const ref = raw.roi(W - 40, H - 40, 40, 40, 1);
  bad = same(raw.roi(W - 5, H - 5, 5, 5, 1).rgb, crop(ref.rgb, 40, 35, 35, 5, 5)) + same(raw.roi(W - 1, H - 1, 1, 1, 1).rgb, crop(ref.rgb, 40, 39, 39, 1, 1));
  check(bad === 0, `3 level 1 bottom-right corner and 1x1 ROI equal the crop (${bad} differing samples)`);

  // (4) box mean of level 1 vs level 2 on a region (information only)
  {
    const rw = 1000, rh = 800, hx = (sw - rw / 2) >> 1, hy = (sh - rh / 2) >> 1;
    const l1 = raw.roi(hx * 2, hy * 2, rw, rh, 1).rgb, l2 = raw.roi(hx, hy, rw / 2, rh / 2, 2).rgb;
    let sum = 0, sq = 0, max = 0, n = 0;
    for (let v = 0; v < rh / 2; v++) for (let u = 0; u < rw / 2; u++) for (let k = 0; k < 3; k++) {
      let a = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) a += l1[((2 * v + dy) * rw + 2 * u + dx) * 3 + k];
      const d = Math.abs(a / 4 - l2[(v * (rw / 2) + u) * 3 + k]) * 65535;
      sum += d; sq += d * d; if (d > max) max = d; n++;
    }
    console.log(`info 4 box2(level 1) vs level 2 on ${rw}x${rh}: mean |d| ${(sum / n).toFixed(1)}, rms ${Math.sqrt(sq / n).toFixed(1)}, max ${max.toFixed(0)} (16-bit units)`);
  }

  // (5) timings
  for (const [w, h] of [[2000, 1500], [1200, 800]]) {
    t = performance.now();
    const r = raw.roi((W - w) >> 1, (H - h) >> 1, w, h, 1);
    console.log(`info 5 level 1 ROI ${w}x${h}: ${(performance.now() - t).toFixed(0)} ms (${(r.rgb.byteLength / 1048576).toFixed(0)} MB)`);
  }
  t = performance.now();
  raw.roi(500, 400, 1500, 1000, 2);
  console.log(`info 5 level 2 ROI 1500x1000: ${(performance.now() - t).toFixed(0)} ms`);

  // (2) errors, release
  const codeOf = (f) => { try { f(); return null; } catch (e) { return e.code; } };
  check(codeOf(() => raw.roi(0, 0, 1, 1, 3)) === "bad_level", "2 bad level -> bad_level");
  check(codeOf(() => raw.roi(W, 0, 1, 1, 1)) === "roi_bounds", "2 outside the held area -> roi_bounds");
  check(codeOf(() => raw.roi(0, 0, 0, 5, 2)) === "roi_bounds", "2 empty rectangle -> roi_bounds");
  raw.release();
  check(codeOf(() => raw.roi(0, 0, 1, 1, 1)) === "no_hold", "2 roi after release -> no_hold");
  check(codeOf(() => raw.hold(new Uint8Array(100))) === "decode_failed", "2 hold of a non-RAW -> decode_failed");
  check(codeOf(() => raw.roi(0, 0, 1, 1, 2)) === "no_hold", "2 a failed hold leaves nothing held");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
