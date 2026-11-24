// Calibrates the Compare fit-view display sharpening (spec/ui-zoom-plan.md D9 / Z1).
// For real SA pairs: the fitted profile's compare-grid render (the wizard's path, as
// research/detailfit/web_e2e.mjs: develop at 1600, pair-prepare, viewRemap, lib/detail-fit.js
// renderLuma) and the LR target are both brought to a fit-view device size (long side D) and
// the top-octave band energy of the render is compared with the target's. Luma (Y') only.
//   node research/zoom/dsharp_calib.mjs out/sa_landing/SA.NP3 F1 F2 ...   (frames: DSC_xxxx)
// Env: LONGS=900,1800  (device long sides)   OUT=path.json (per-frame band stats)
// Metrics per frame and D (all on Y' x255, valid interior only):
//   top  = RMS of DoG(0.6, 1.2) device px  (the top octave)
//   mid  = RMS of DoG(1.5, 3.0)            (the next octave, tone/contrast reference)
//   rel  = (top/mid) of target / (top/mid) of render — the top-octave ratio with the local
//          contrast cancelled (the render's tone curve is fitted, not identical).
// Then the same for the render after unsharp(sigma, amount) over a grid of constants.
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
const ROOT = path.resolve(import.meta.dirname, "../..");
const W = path.join(ROOT, "web");
const imp = (p) => import(path.join(W, p));
const { initRaw } = await imp("lib/raw.js");
const P = await imp("lib/pair-prepare.js");
const T = await imp("lib/target.js");
const { resizeF } = await imp("lib/resample.js");
const { loadDev } = await imp("lib/fit.js");
const { loadModel } = await imp("lib/profile.js");
const { loadDetail } = await imp("lib/detail.js");
const { deserialize } = await imp("lib/np3.js");
const DF = await imp("lib/detail-fit.js");
const { gaussPlane } = await imp("lib/display-sharpen.js");
const rd = (p) => readFile(path.join(W, p));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
T.setWbMapWeights(JSON.parse(await rd("model/wbmap.json")).weights);
const raw = await initRaw(await rd("raw.wasm"));
const dev = loadDev(JSON.parse(await rd("model/dev.json")), ab(await rd("model/dev_lut.bin")));
const model = loadModel(JSON.parse(await rd("model/profile.json")), ab(await rd("model/profile.bin")));
const dmeta = JSON.parse(await rd("model/detail.json"));
const detail = loadDetail(dmeta, ab(await rd("model/detail.bin")));
const TURNS = { 3: 2, 6: 3, 8: 1 };
const tmp = await mkdtemp(path.join(os.tmpdir(), "np3z-"));
function pil(file) {
  const b = execFileSync("python3", [path.join(ROOT, "_local/research/jpegdec.py"), file], { maxBuffer: 1 << 30 });
  const w = b.readUInt32LE(0), h = b.readUInt32LE(4);
  return { data: new Uint8Array(b.buffer, b.byteOffset + 8, w * h * 3), w, h };
}
const [np3file, ...frames] = process.argv.slice(2);
const control = deserialize(new Uint8Array(await readFile(np3file)));
const LONGS = (process.env.LONGS ?? "900,1800").split(",").map(Number);
const dog = (y, w, h, s1, s2) => {
  const a = gaussPlane(y, w, h, s1), b = gaussPlane(y, w, h, s2);
  for (let i = 0; i < a.length; i++) a[i] -= b[i];
  return a;
};
const erode = (m, w, h, r) => {
  let cur = m;
  for (let pass = 0; pass < 2; pass++) {
    const nxt = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) {
        if (pass === 0) { const xx = x + k; if (xx < 0 || xx >= w || !cur[y * w + xx]) ok = 0; }
        else { const yy = y + k; if (yy < 0 || yy >= h || !cur[yy * w + x]) ok = 0; }
      }
      nxt[y * w + x] = ok;
    }
    cur = nxt;
  }
  return cur;
};
const rms = (b, m) => { let s = 0, n = 0; for (let i = 0; i < b.length; i++) if (m[i]) { s += b[i] * b[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
// per-tile (48x48) relative ratio over tiles whose target mid-band energy is in the upper half
const tileRel = (tT, tM, rT, rM, m, w, h, ts = 48) => {
  const out = [];
  for (let ty = 0; ty + ts <= h; ty += ts) for (let tx = 0; tx + ts <= w; tx += ts) {
    let a = 0, b = 0, c = 0, d = 0, n = 0;
    for (let y = ty; y < ty + ts; y++) for (let x = tx; x < tx + ts; x++) {
      const i = y * w + x; if (!m[i]) continue;
      a += tT[i] ** 2; b += tM[i] ** 2; c += rT[i] ** 2; d += rM[i] ** 2; n++;
    }
    if (n < ts * ts * 0.95 || b < 1e-6 || d < 1e-6 || c < 1e-9) continue;
    out.push({ rel: Math.sqrt((a / b) / (c / d)), mid: b / n });
  }
  return out;
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const CONSTS = [];
for (const sg of [0.5, 0.7, 1.0]) for (const am of [0, 0.25, 0.5, 0.75, 1.0]) CONSTS.push([sg, am]);
const results = [];
for (const fr of frames) {
  const rawBytes = new Uint8Array(await readFile(path.join(ROOT, "renders/sa", fr + ".NEF")));
  const tfile = path.join(ROOT, "renders/sa/done", fr + ".jpg");
  const xmp = T.parseXmp(T.extractXmp(new Uint8Array(await readFile(tfile)), "JPEG"));
  const tgt = pil(tfile);
  const img = raw.develop(rawBytes, 1600);
  const g = T.editGain(xmp, T.wbMultipliers(rawBytes));
  const unrotate = (4 - (TURNS[img.info.orientation] ?? 0)) % 4;
  const prep = await P.preparePair({ linear: img.rgb, lw: img.w, lh: img.h, unrotate,
    targetU8: tgt.data, tw: tgt.w, th: tgt.h, xmp, rawBytes, gain: g.gain, gainNote: g.note,
    decodeJpeg: async (bytes) => { const f = path.join(tmp, "e.jpg"); await writeFile(f, bytes); return pil(f); } });
  const rgb = new Float32Array(img.rgb.length);
  for (let i = 0; i < rgb.length; i += 3) for (let c = 0; c < 3; c++) rgb[i + c] = img.rgb[i + c] * prep.gain[c];
  const map = P.viewRemap(prep, img.w, img.h, unrotate);
  const r = Math.floor(map.h / 2) * map.w;
  let a = -1, b = -1;
  for (let x = 0; x < map.w; x++) if (map.sx[r + x] === map.sx[r + x]) { if (a < 0) a = x; b = x; }
  const step = Math.hypot(map.sx[r + b] - map.sx[r + a], map.sy[r + b] - map.sy[r + a]) / (b - a);
  const scale = dmeta.SENSOR_LONG / Math.max(img.w, img.h) * step;
  const lin = P.applyRemap({ data: rgb, w: img.w, h: img.h }, map).data;
  const { y: ry, valid } = DF.renderLuma({ dev, model, detail, control, lin, w: map.w, h: map.h, scale });
  // target luma at full size (Y' weights), once
  const tl = new Float32Array(tgt.w * tgt.h);
  for (let i = 0, p = 0; i < tl.length; i++, p += 3)
    tl[i] = (dmeta.YW[0] * tgt.data[p] + dmeta.YW[1] * tgt.data[p + 1] + dmeta.YW[2] * tgt.data[p + 2]) / 255;
  const rg = Float32Array.from(ry);
  const vm = Float32Array.from(valid);
  for (const D of LONGS) {
    const k = D / Math.max(map.w, map.h);
    const dw = Math.round(map.w * k), dh = Math.round(map.h * k);
    // the render: the 1600-class grid resampled to the device size (the browser's "high" ~ bilinear/box)
    const kern = k < 1 ? "box" : "bilinear";
    const R = resizeF(rg, dw, dh, map.w, map.h, kern, 1).data;
    const Vm = resizeF(vm, dw, dh, map.w, map.h, "box", 1).data;
    // the target: the full-size JPEG straight to the device size (what the display canvas does)
    const Tt = resizeF(tl, dw, dh, tgt.w, tgt.h, "lanczos", 1).data;
    for (let i = 0; i < R.length; i++) { R[i] *= 255; Tt[i] *= 255; }
    const mask = erode(Uint8Array.from(Vm, (v) => v > 0.999 ? 1 : 0), dw, dh, 10);
    const tTop = dog(Tt, dw, dh, 0.6, 1.2), tMid = dog(Tt, dw, dh, 1.5, 3.0);
    const row = { frame: fr, D, w: dw, h: dh, grid: `${map.w}x${map.h}`, valid: mask.reduce((s, v) => s + v, 0) / mask.length, scale: +scale.toFixed(2) };
    const measure = (Y) => {
      const rTop = dog(Y, dw, dh, 0.6, 1.2), rMid = dog(Y, dw, dh, 1.5, 3.0);
      const tiles = tileRel(tTop, tMid, rTop, rMid, mask, dw, dh);
      const top = [rms(tTop, mask), rms(rTop, mask)], mid = [rms(tMid, mask), rms(rMid, mask)];
      return { abs: top[0] / top[1], rel: Math.sqrt((top[0] / mid[0]) ** 2 / (top[1] / mid[1]) ** 2),
               tileRel: median(tiles.map((t) => t.rel)), tiles: tiles.length };
    };
    row.plain = measure(R);
    row.usm = {};
    for (const [sg, am] of CONSTS) {
      if (am === 0) continue;
      const bl = gaussPlane(R, dw, dh, sg);
      const Y = new Float32Array(R.length);
      for (let i = 0; i < Y.length; i++) Y[i] = R[i] + am * (R[i] - bl[i]);
      row.usm[`${sg}/${am}`] = measure(Y);
    }
    results.push(row);
    console.log(fr, D, `${dw}x${dh}`, "plain abs", row.plain.abs.toFixed(3), "rel", row.plain.rel.toFixed(3), "tile", row.plain.tileRel.toFixed(3), `(${row.plain.tiles} tiles)`);
  }
}
if (process.env.OUT) await writeFile(process.env.OUT, JSON.stringify(results, null, 1));
// summary: median over frames per D and constant
for (const D of LONGS) {
  const rows = results.filter((r) => r.D === D);
  console.log(`\nD=${D}: median over ${rows.length} frames (rel = target/render top-octave with mid contrast cancelled; abs = raw band RMS ratio)`);
  const line = (name, f) => console.log(name.padEnd(10), "abs", median(rows.map((r) => f(r).abs)).toFixed(3), "rel", median(rows.map((r) => f(r).rel)).toFixed(3), "tileRel", median(rows.map((r) => f(r).tileRel)).toFixed(3));
  line("plain", (r) => r.plain);
  for (const [sg, am] of CONSTS) if (am) line(`${sg}/${am}`, (r) => r.usm[`${sg}/${am}`]);
}
process.exit(0);
