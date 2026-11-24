// The wizard's detail step in Node on real pairs: the RAW decoded at 1600 px and prepared by
// pair-prepare (as prep.mjs), the compare-grid input built as fit-app.detailInput, then
// lib/detail-fit.js fitDetailPairs with a given profile. Usage:
//   node research/detailfit/web_e2e.mjs profile.NP3 VAR[,VAR] F1 F2 ...   (VAR: done, CLA50, ...)
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
const rd = (p) => readFile(path.join(W, p));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
T.setWbMapWeights(JSON.parse(await rd("model/wbmap.json")).weights);
const raw = await initRaw(await rd("raw.wasm"));
const dev = loadDev(JSON.parse(await rd("model/dev.json")), ab(await rd("model/dev_lut.bin")));
const model = loadModel(JSON.parse(await rd("model/profile.json")), ab(await rd("model/profile.bin")));
const dmeta = JSON.parse(await rd("model/detail.json"));
const detail = loadDetail(dmeta, ab(await rd("model/detail.bin")));
const TURNS = { 3: 2, 6: 3, 8: 1 };
const tmp = await mkdtemp(path.join(os.tmpdir(), "np3d-"));
function pil(file) {
  const b = execFileSync("python3", [path.join(ROOT, "_local/research/jpegdec.py"), file], { maxBuffer: 1 << 30 });
  const w = b.readUInt32LE(0), h = b.readUInt32LE(4);
  return { data: new Uint8Array(b.buffer, b.byteOffset + 8, w * h * 3), w, h };
}
const [np3file, varsArg, ...frames] = process.argv.slice(2);
const preps = [];
const control = deserialize(new Uint8Array(await readFile(np3file)));
const vars = varsArg.split(",");
const inputs = Object.fromEntries(vars.map((v) => [v, []]));
const t0 = Date.now();
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
  preps.push(prep);
  const rgb = new Float32Array(img.rgb.length);
  for (let i = 0; i < rgb.length; i += 3) for (let c = 0; c < 3; c++) rgb[i + c] = img.rgb[i + c] * prep.gain[c];
  const map = P.viewRemap(prep, img.w, img.h, unrotate);
  const r = Math.floor(map.h / 2) * map.w;
  let a = -1, b = -1;
  for (let x = 0; x < map.w; x++) if (map.sx[r + x] === map.sx[r + x]) { if (a < 0) a = x; b = x; }
  const step = Math.hypot(map.sx[r + b] - map.sx[r + a], map.sy[r + b] - map.sy[r + a]) / (b - a);
  const scale = dmeta.SENSOR_LONG / Math.max(img.w, img.h) * step;
  for (const v of vars) {
    const lin = P.applyRemap({ data: rgb, w: img.w, h: img.h }, map).data;
    for (let i = 0; i < map.sx.length; i++) if (map.sx[i] !== map.sx[i]) lin[3 * i] = lin[3 * i + 1] = lin[3 * i + 2] = NaN;
    const tv = v === "done" || v === "WORKER" ? tgt : v === "NX" ? pil(path.join(ROOT, "renders/sweep/fitcheck", fr + "-NEW4.TIF"))
      : pil(path.join(ROOT, "renders/sa", v, fr + ".jpg"));   // NX: NX's own render of NEW4 as the target
    const tf = new Float32Array(tv.data.length);
    for (let i = 0; i < tf.length; i++) tf[i] = tv.data[i] / 255;
    const tr = resizeF(tf, map.w, map.h, tv.w, tv.h, "box", 3).data;
    const ty = new Float32Array(map.w * map.h);
    for (let i = 0, p = 0; i < ty.length; i++, p += 3) ty[i] = dmeta.YW[0] * tr[p] + dmeta.YW[1] * tr[p + 1] + dmeta.YW[2] * tr[p + 2];
    inputs[v].push({ name: fr, lin, ty, w: map.w, h: map.h, scale });
  }
  console.log(fr, `grid ${map.w}x${map.h} scale ${scale.toFixed(2)} ncc ${prep.ncc.toFixed(3)}`, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
if (vars[0] === "WORKER") {
  // the fit worker end to end: color fit, then the detail step, as the wizard posts it
  const msgs = [];
  globalThis.self = { postMessage: (m) => msgs.push(m) };
  await import(path.join(W, "lib/fit-worker.js"));
  const payload = {
    type: "fit", id: 1, generation: { session: 0, pair: 0, task: 1 }, seed: 0, iters: 30, baseName: "e2e",
    devMeta: JSON.parse(await rd("model/dev.json")), devLut: ab(await rd("model/dev_lut.bin")),
    profileMeta: JSON.parse(await rd("model/profile.json")), profileBin: ab(await rd("model/profile.bin")),
    files: { raw: "a", target: "b" }, poolSize: 0,
    pairs: preps.map((p, i) => ({ name: String(i), ncc: p.ncc, x: p.x, y: p.y, masks: p.masks, gain: p.gain })),
    detail: { meta: dmeta, bin: ab(await rd("model/detail.bin")), pairs: inputs.WORKER },
  };
  const t1 = Date.now();
  await self.onmessage({ data: payload });
  const ready = msgs.find((m) => m.type === "ready"), err = msgs.find((m) => m.type === "error");
  const det = msgs.filter((m) => m.stage === "detail").map((m) => `${m.done}/${m.total}`);
  console.log(err ? `error ${err.detail}` : `ready in ${((Date.now() - t1) / 1000).toFixed(0)}s: control detail ` +
    JSON.stringify({ s: ready.result.control.sharpening, m: ready.result.control.mid_sharpening, c: ready.result.control.clarity }) +
    ` detail ${JSON.stringify(ready.result.detail)} progress ${det.join(" ")}`);
  process.exit(0);
}
for (const v of vars) {
  for (const q of inputs[v]) {
    const t1 = Date.now();
    const r = await DF.fitDetailPairs({ dev, model, detail, control, pairs: [q], cal: process.env.CAL0 ? {} : DF.CAL });
    console.log(" ", v, q.name, JSON.stringify(r.raw, (k, x) => typeof x === "number" ? +x.toFixed(2) : x), `${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }
  const t1 = Date.now();
  const r = await DF.fitDetailPairs({ dev, model, detail, control, pairs: inputs[v], cal: process.env.CAL0 ? {} : DF.CAL });
  console.log(v, "joint", JSON.stringify(r.values), JSON.stringify(r.raw, (k, x) => typeof x === "number" ? +x.toFixed(2) : x),
              `cost ${r.cost0.toFixed(4)} -> ${r.cost.toFixed(4)}`, `${((Date.now() - t1) / 1000).toFixed(1)}s`);
}
