// Level 1j (stage 2 regressions found on real pairs, spec/web-tests.md): Node, no browser.
//  - the embedded-JPEG choice: web/lib/pair-prepare.js embeddedJpegCandidates() /
//    extractEmbeddedJpeg() against PIL's accept/size decision on every \xff\xd8\xff run of a
//    synthetic RAW-like blob (web/golden/stage2/, web/make_stage2_golden.py), plus the Python
//    best offset of real local RAWs (gitignored _local/, skipped when absent). Regression:
//    sensor data parsed as a "48382x15468 SOF15" frame won the width race -> the browser
//    decoder failed ("The source image could not be decoded", DSC_6550 / DSC_6132).
//  - the non-sRGB target ICC path: web/lib/target.js applyIcc(iccToSrgbMatrix()) on the stored
//    pixels of the ICC fixtures against pairs.to_srgb (littleCMS) itself
//    (web/golden/target/<case>.stored.f32 / .ref.f32, web/make_target_golden.py). Regression:
//    the matrix was inverted, the 'para' type 3/4 curves were mis-evaluated and the output was
//    left linear -> every Display P3 target turned white -> NCC 0 (SKL_3024 / SKL_3000).
// Exports the level in the web/test-node.mjs style ({ report, skip }); also standalone:
//
//     node web/test-node-stage2.mjs
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const ROOT = path.dirname(HERE);

const f32 = async (p) => {
  const b = await readFile(p);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

export async function level1j(ctx) {
  const { report, skip } = ctx;
  const P = await import("./lib/pair-prepare.js");
  const T = await import("./lib/target.js");

  // ---- the embedded-JPEG choice on the synthetic blob: every candidate, then the best
  const sdir = path.join(HERE, "golden", "stage2");
  const ej = JSON.parse(await readFile(path.join(sdir, "embedded.json"), "utf8"));
  const blob = new Uint8Array(await readFile(path.join(sdir, ej.file)));
  const js = new Map(P.embeddedJpegCandidates(blob).map((c) => [c.offset, [c.w, c.h]]));
  for (const pl of ej.placed) {
    const py = ej.candidates.find((c) => c.offset === pl.offset);
    const want = py ? py.size : null;
    const got = js.get(pl.offset) ?? null;
    report(JSON.stringify(got) === JSON.stringify(want),
      `1j embedded ${pl.case}: ${got ? got.join("x") : "rejected"} (PIL ${want ? want.join("x") : "rejected"})`);
  }
  const pyOpen = ej.candidates.filter((c) => c.size).map((c) => c.offset);
  const extra = [...js.keys()].filter((o) => !pyOpen.includes(o));
  report(extra.length === 0 && pyOpen.every((o) => js.has(o)),
    `1j embedded: ${js.size} candidates open, PIL ${pyOpen.length}` + (extra.length ? `; extra at ${extra}` : ""));
  const pick = P.extractEmbeddedJpeg(blob);
  const bestLen = blob.indexOf(0xFF, ej.best.offset) === ej.best.offset && pick
    && pick[0] === blob[ej.best.offset] && pick.length > 0;
  const bestJs = P.embeddedJpegCandidates(blob).reduce((b, c) => (!b || c.w > b.w ? c : b), null);
  report(!!bestLen && bestJs && bestJs.offset === ej.best.offset
    && pick.length === bestJs.end - bestJs.offset,
    `1j embedded best: offset ${bestJs?.offset} (Python ${ej.best.offset}, ${ej.best.size.join("x")})`);

  // ---- real RAWs (gitignored; skipped when absent)
  for (const r of ej.real) {
    const p = path.join(ROOT, r.path);
    if (!existsSync(p)) { skip(`1j real ${r.path}: no file`); continue; }
    const b = new Uint8Array(await readFile(p));
    const best = P.embeddedJpegCandidates(b).reduce((x, c) => (!x || c.w > x.w ? c : x), null);
    report(best && best.offset === r.offset && best.w === r.size[0] && best.h === r.size[1],
      `1j real ${path.basename(r.path)}: ${best ? `${best.w}x${best.h} at ${best.offset}` : "none"}`
      + ` (Python ${r.size.join("x")} at ${r.offset})`);
  }

  // ---- the non-sRGB ICC path against pairs.to_srgb
  const tdir = path.join(HERE, "golden", "target");
  let n = 0;
  for (const f of (await readdir(tdir)).filter((x) => x.endsWith(".json") && x !== "wb.json").sort()) {
    const j = JSON.parse(await readFile(path.join(tdir, f), "utf8"));
    if (!j.ref || !j.ref.stored) continue;
    n++;
    const bytes = new Uint8Array(await readFile(path.join(tdir, j.file)));
    const icc = T.extractIcc(bytes, "JPEG");
    const desc = icc && T.iccDescription(icc);
    const m = icc && !T.isSrgbDescription(desc) ? T.iccToSrgbMatrix(icc) : null;
    if (!m) { report(false, `1j icc ${j.file}: no matrix path (${desc})`); continue; }
    const rgb = Float32Array.from(await f32(path.join(tdir, j.ref.stored)));
    const ref = await f32(path.join(tdir, j.ref.file));
    T.applyIcc(rgb, m);
    let max = 0;
    for (let i = 0; i < rgb.length; i++) max = Math.max(max, Math.abs(rgb[i] - ref[i]) * 255);
    report(max <= j.ref.browserMaxLevels,
      `1j icc ${j.file} (${desc.trim()}): max ${max.toFixed(3)} of 255 levels vs pairs.to_srgb`
      + ` (tolerance ${j.ref.browserMaxLevels})`);
  }
  report(n >= 2, `1j icc: ${n} ICC fixtures with a pairs.to_srgb reference`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let fails = 0;
  await level1j({
    report: (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); },
    skip: (msg) => console.log(`skip ${msg}`),
  });
  process.exit(fails ? 1 : 0);
}
