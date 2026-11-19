// Level 1i (stage 7, pure): web/lib/advice.js against analyze.py and the session.js refit
// helpers. Fixtures: web/golden/advice/ (web/make_advice_golden.py). Exports the level
// function in the web/test-node.mjs style ({ report, skip }); also runnable standalone:
//
//     node web/test-node-advice.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));   // web/
const GOLD = path.join(HERE, "golden", "advice");

const TOL = 1e-9;
const close = (a, b, tol = TOL) => (a === null || b === null) ? a === b
  : Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

export async function level1i(ctx) {
  const { report } = ctx;
  const A = await import("./lib/advice.js");
  const S = await import("./lib/session.js");
  const { formatWarning } = await import("./lib/target.js");
  const { pyFixed } = A;

  // ---- python-format helpers (the CLI strings are the reference) ----
  const signed = (x, d) => (x >= 0 ? "+" : "") + pyFixed(x, d);
  const reasonText = (r) => {
    switch (r.code) {
      case "ncc_low": return `alignment ${pyFixed(r.ncc, 2)}`;
      case "clipped": return `in white ${pyFixed(r.share * 100, 0)}%`;
      case "warning": {
        const s = formatWarning(r.warning);
        const i = s.indexOf(": ");
        return i >= 0 ? s.slice(i + 2) : s;
      }
      case "lift_outlier":
        return `target lightness vs neutral ${signed(r.delta, 1)} L off the others: `
          + "exposure or a local correction, will not land in a shared profile";
      default: throw new Error(`unknown reason ${r.code}`);
    }
  };
  const suggestText = (s) => `${s.group} ${pyFixed(s.coverage * 100, 1)}% (${s.level}): add to the fit `
    + s.candidates.map((c) => `${c.name} (${pyFixed(c.share * 100, 0)}%)`).join(", ");
  const coverageText = (frames, median) => {
    const cov = A.coverage(frames);
    const lines = ["color coverage in the fit: "
      + A.GROUPS.map((g) => `${g} ${pyFixed(cov[g] * 100, 0)}% (${A.level(cov[g])})`).join(", ")];
    for (const n of A.coverageNotes(frames, median)) {
      if (n.code === "set_lift")
        lines.push(`  set lightness vs candidate median ${signed(n.delta, 1)} L`
          + (n.significant ? `: the profile will make the other frames ${n.direction} by about as much` : ""));
      else if (n.code === "adl_mixed")
        lines.push(`  in-camera ADL differs (${n.adls.join(", ")}): one profile, but NX and the camera lift `
          + "frames per ADL differently. Better to fit on frames with the ADL you will shoot with");
    }
    return lines;
  };

  // ---- pyFixed: Python's half-even on exact ties ----
  {
    const cases = [[0.125, 2, "0.12"], [0.375, 2, "0.38"], [2.5, 0, "2"], [3.5, 0, "4"], [-0.125, 2, "-0.12"],
                   [0.1, 1, "0.1"], [1.005, 2, "1.00"], [12.345, 1, "12.3"], [-2.25, 1, "-2.2"], [0, 1, "0.0"]];
    const bad = cases.filter(([x, d, want]) => pyFixed(x, d) !== want);
    report(!bad.length, `1i pyFixed half-even ties: ${cases.length} cases`
      + (bad.length ? ` — ${bad.map(([x, d, w]) => `${x}/${d}: ${pyFixed(x, d)} != ${w}`).join("; ")}` : ""));
  }

  // ---- buildFrame vs analyze.frame on the pixel fixtures ----
  const pix = JSON.parse(await readFile(path.join(GOLD, "pixel.json"), "utf8"));
  const f32 = async (f) => { const b = await readFile(path.join(GOLD, f));
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  for (const p of pix.frames) {
    const fr = A.buildFrame({ name: p.name, target: p.target, ncc: p.nccIn,
      warnings: [...p.warnings, { code: "camera" }],        // a browser-only code is dropped
      targetSrgb: await f32(`${p.name}.t.f32`), neutralSrgb: await f32(`${p.name}.n.f32`) });
    const want = p.frame;
    const errs = [];
    if (fr.ncc !== want.ncc) errs.push(`ncc ${fr.ncc} != ${want.ncc}`);
    if (fr.adl !== want.adl) errs.push(`adl ${fr.adl}`);
    for (const k of ["L", "dark", "light", "clipped", "lift"]) if (!close(fr[k], want[k])) errs.push(`${k} ${fr[k]} != ${want[k]}`);
    for (const g of A.GROUPS) if (!close(fr.groups[g], want.groups[g], 1e-12)) errs.push(`${g} ${fr.groups[g]} != ${want.groups[g]}`);
    if (fr.warnings.length !== p.warnings.length) errs.push("warnings not filtered to edit warnings");
    report(!errs.length, `1i buildFrame ${p.name}: ncc ${fr.ncc}, white ${(fr.clipped * 100).toFixed(1)}%, `
      + `lift ${fr.lift.toFixed(3)}${errs.length ? " — " + errs.join("; ") : ""}`);
  }

  // ---- frame sets: verdict / coverage / value / lift_median / recommend / suggest / notes ----
  const { sets } = JSON.parse(await readFile(path.join(GOLD, "sets.json"), "utf8"));
  let randOk = 0, randN = 0;
  const randErr = [];
  for (const s of sets) {
    const r = s.result;
    const fr = s.frames;
    const errs = [];
    const med = A.liftMedian(fr);
    if (!close(med, r.liftMedian)) errs.push(`liftMedian ${med} != ${r.liftMedian}`);
    fr.forEach((f, i) => {
      const v = A.verdict(f, med);
      const why = v.reasons.map(reasonText);
      if (v.verdict !== r.verdicts[i].verdict || JSON.stringify(why) !== JSON.stringify(r.verdicts[i].why))
        errs.push(`verdict ${f.name}: ${v.verdict} ${JSON.stringify(why)} != ${r.verdicts[i].verdict} ${JSON.stringify(r.verdicts[i].why)}`);
    });
    const cov = A.coverage(fr);
    for (const g of A.GROUPS) {
      if (!close(cov[g], r.coverage[g], 1e-12)) errs.push(`coverage ${g}`);
      if (A.level(cov[g]) !== r.levels[g]) errs.push(`level ${g}`);
    }
    const present = new Set(A.GROUPS.filter((g) => cov[g] >= A.FEW));
    if (!close(A.value(cov, present), r.value)) errs.push(`value ${A.value(cov, present)} != ${r.value}`);
    const rec = A.recommend(fr, med, s.adlOnly);
    const names = rec.map((f) => f.name);
    if (JSON.stringify(names) !== JSON.stringify(r.recommend)) errs.push(`recommend ${names} != ${r.recommend}`);
    const sug = A.suggest(rec, fr).map(suggestText);
    if (JSON.stringify(sug) !== JSON.stringify(r.suggest)) errs.push(`suggest ${JSON.stringify(sug)} != ${JSON.stringify(r.suggest)}`);
    const pc = coverageText(rec, med);
    if (JSON.stringify(pc) !== JSON.stringify(r.printCoverage)) errs.push(`printCoverage ${JSON.stringify(pc)} != ${JSON.stringify(r.printCoverage)}`);
    if (s.id.startsWith("rand")) {
      randN++;
      if (!errs.length) randOk++; else randErr.push(`${s.id}: ${errs.join("; ")}`);
    } else {
      report(!errs.length, `1i set ${s.id} (${fr.length} frames${s.adlOnly ? ", adl " + s.adlOnly : ""}): recommend [${names.join(", ")}]`
        + (errs.length ? " — " + errs.join("; ") : ""));
    }
  }
  report(randOk === randN, `1i random sets: ${randOk}/${randN} match analyze.py (verdicts, coverage, value, recommend, suggest, notes)`
    + (randErr.length ? " — " + randErr.slice(0, 3).join(" | ") : ""));

  // ---- exclusionCandidates (browser-only rule) ----
  {
    const ids = (xs) => A.exclusionCandidates(xs.map((d, i) => ({ id: i + 1, renderDE: d }))).map((c) => c.id);
    const cases = [
      [[1.0, 5.0], []],                         // fewer than 3 pairs
      [[1.0, 1.1, 1.2, 5.0], [4]],              // median 1.15
      [[0.3, 0.35, 0.9], []],                   // 2.6x the median, but < 1 dE above it
      [[NaN, 1, 1, 4], [4]],                    // non-finite ignored, still 3 pairs
      [[1, 1, 1, 6, 4.5], [4, 5]],              // highest ratio first
      [[2, 2, 2], []],
    ];
    const bad = cases.filter(([xs, want]) => JSON.stringify(ids(xs)) !== JSON.stringify(want));
    const c = A.exclusionCandidates([{ id: "a", renderDE: 1 }, { id: "b", renderDE: 1.2 }, { id: "c", renderDE: 3.5 }])[0];
    const shapeOk = c && c.code === "high_error" && c.id === "c" && c.median === 1.2 && close(c.ratio, 3.5 / 1.2);
    report(!bad.length && shapeOk, `1i exclusionCandidates: ${cases.length} cases + shape`
      + (bad.length ? ` — ${bad.map(([xs]) => `[${xs}] -> [${ids(xs)}]`).join("; ")}` : "") + (shapeOk ? "" : " — bad shape"));
  }

  // ---- session.js: version naming ----
  {
    const V = (...names) => names.map((name) => ({ name }));
    const cases = [
      [V("foo"), "foo", "foo_r1"],
      [V("foo", "foo_r1"), "foo_r1", "foo_r2"],
      [V("foo", "foo_r1"), "foo", "foo_r2"],                     // _r1 taken: next free
      [V("foo", "foo_r1", "foo_r2"), "foo_r1", "foo_r3"],         // refit from an older version
      [V("foo", "foo_r2"), "foo", "foo_r1"],                      // a gap is reused (next_name)
      [V("abcdefghijklmnopqrs"), "abcdefghijklmnopqrs", "abcdefghijklmnop_r1"],
      [V("abcdefghijklmnop_r9"), "abcdefghijklmnop_r9", "abcdefghijklmno_r10"],
      [V("x_r"), "x_r", "x_r_r1"],
      [V("NPF-DSC_6550"), "NPF-DSC_6550", "NPF-DSC_6550_r1"],
    ];
    const bad = cases.filter(([vs, prev, want]) => {
      const got = S.nextVersionName(vs, prev);
      return got !== want || !S.isValidProfileName(got);
    });
    report(!bad.length, `1i nextVersionName: ${cases.length} cases (match.next_name, 19-char cap on the base)`
      + (bad.length ? ` — ${bad.map(([vs, p, w]) => `${p}: ${S.nextVersionName(vs, p)} != ${w}`).join("; ")}` : ""));
    const idOk = S.nextVersionId([{ id: "draft" }]) === "r1"
      && S.nextVersionId([{ id: "draft" }, { id: "r1" }, { id: "r3" }]) === "r4";
    report(idOk, "1i nextVersionId: draft -> r1, [r1, r3] -> r4");
  }

  // ---- session.js: refit selection ----
  {
    const ready = { name: "x", info: {}, image: {}, warn: null };
    const P = (id, o = {}) => ({ id, raw: ready, target: { width: 1, height: 1 }, included: true, blocked: false,
                                 prepared: { blocked: null }, fitBlocked: null, ...o });
    const session = { pairs: [
      P(5), P(2, { included: false }), P(7, { blocked: true }), P(3, { fitBlocked: { code: "target_too_small" } }),
      P(9, { prepared: { blocked: { code: "ncc_low" } } }), P(4, { raw: "pending" }), P(6, { target: null }),
      P(1, { prepared: null }), P(8),
    ] };
    const got = S.refitPairIds(session);
    report(JSON.stringify(got) === "[5,1,8]",
      `1i refitPairIds: included, decoded, unblocked, display order -> [${got}]`);
  }

  // ---- session.js: the refit version ----
  {
    const draft = { id: "draft", name: "foo", control: { name: "foo", v: 0 }, parentId: null, kind: "fit" };
    const versions = [draft];
    const result = { control: { name: "foo", v: 1 }, pairs: ["1", "3"], fitVector: new Float64Array([1, 2]),
                     cost: 3.5, iterations: 12, seed: 0, scores: [] };
    const v = S.makeRefitVersion(versions, draft, result);
    const ok = v.id === "r1" && v.name === "foo_r1" && v.control.name === "foo_r1" && v.control.v === 1
      && result.control.name === "foo" && v.parentId === "draft" && v.kind === "refit"
      && JSON.stringify(v.pairIds) === '["1","3"]' && Array.isArray(v.fitVector) && v.fitVector[1] === 2
      && v.cost === 3.5 && versions.length === 1 && draft.name === "foo";
    const v2 = S.makeRefitVersion([draft, v], draft, result);
    report(ok && v2.id === "r2" && v2.name === "foo_r2" && v2.parentId === "draft",
      `1i makeRefitVersion: ${v.id}/${v.name} then ${v2.id}/${v2.name}, inputs unmutated`);
  }
}

// standalone: node web/test-node-advice.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let failed = 0;
  const report = (ok, text) => { console.log(`${ok ? "ok  " : "FAIL"} ${text}`); if (!ok) failed++; };
  const skip = (text) => console.log(`skip ${text}`);
  try { await level1i({ report, skip }); } catch (e) { report(false, `1i: exception ${e.stack || e}`); }
  process.exit(failed ? 1 : 0);
}
