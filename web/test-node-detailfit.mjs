// Level 1l (spec/web-tests.md): the detail fit port (lib/detail-fit.js) against detailfit.py on
// the web/golden/detailfit fixtures (web/make_detailfit_golden.py): the recursive Gaussian, each
// pair's Gram matrix (with an invalid strip: the erosion path) and the joint solve. Node only.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDetail } from "./lib/detail.js";
import { rgauss, gram, solve, CAL } from "./lib/detail-fit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = path.join(HERE, "golden/detailfit");

async function f32(name) {
  const b = await readFile(path.join(G, name));
  return Float64Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
}

export async function level1l({ report }) {
  const meta = JSON.parse(await readFile(path.join(G, "detailfit.json"), "utf8"));
  const dm = JSON.parse(await readFile(path.join(HERE, "model/detail.json"), "utf8"));
  const db = await readFile(path.join(HERE, "model", dm.bin || "detail.bin"));
  const d = loadDetail(dm, db.buffer.slice(db.byteOffset, db.byteOffset + db.byteLength));
  const { w, h, scale } = meta;

  const y0 = await f32(meta.pairs[0].name + ".yr.f32");
  const b = rgauss(y0, w, h, meta.rgauss.sigma);
  const pts = [[0, 0], [5, 17], [100, 200], [h - 1, w - 1], [96, 128]];
  const errB = Math.max(...pts.map(([i, j], k) => Math.abs(b[i * w + j] - meta.rgauss.samples[k])));
  const sum = b.reduce((s, v) => s + v, 0);
  report(errB < 1e-12 && Math.abs(sum - meta.rgauss.sum) < 1e-8 * Math.abs(meta.rgauss.sum),
         `1l rgauss sigma ${meta.rgauss.sigma}: max |diff| ${errB.toExponential(2)}, sum diff ${(sum - meta.rgauss.sum).toExponential(2)}`);

  const grams = [];
  for (const p of meta.pairs) {
    const yr = await f32(p.name + ".yr.f32"), yt = await f32(p.name + ".yt.f32");
    const valid = new Uint8Array(w * h).fill(1);
    for (let y = 0; y < h; y++) for (let x = 0; x < p.invalidCols; x++) valid[y * w + x] = 0;
    const g = gram(d, yr, yt, valid, w, h, scale);
    const mx = Math.max(...p.Q.map(Math.abs));
    const err = g ? Math.max(...p.Q.map((v, i) => Math.abs(v - g.Q[i]))) / mx : Infinity;
    report(g && g.n === p.n && err < 1e-9,
           `1l gram ${p.name}: ${g ? g.n : 0} usable pixels (python ${p.n}), max rel diff ${err.toExponential(2)}`);
    grams.push(g);
  }
  report(JSON.stringify(CAL) === JSON.stringify(meta.joint.cal),
         `1l CAL ${JSON.stringify(CAL)} is detailfit.CAL_WEB ${JSON.stringify(meta.joint.cal)}`);
  for (const [key, gs] of [["joint", grams.slice(0, 2)], ["single", grams.slice(2)]]) {
    const e = meta[key];
    const r = solve(gs, e.v0, e.cal);
    const dr = Math.max(...Object.keys(e.raw).map((t) => Math.abs(r.raw[t] - e.raw[t])));
    const same = Object.keys(e.values).every((t) => r.values[t] === e.values[t]);
    report(same && dr < 1e-5 && Math.abs(r.cost - e.cost) < 1e-6 * e.cost && Math.abs(r.cost0 - e.cost0) < 1e-6 * e.cost0,
           `1l solve ${key}: ${JSON.stringify(r.values)} (python ${JSON.stringify(e.values)}), raw diff ${dr.toExponential(2)}`);
  }
}
