// A parallel-Jacobian helper (lib/fit-pool.js): holds the same sampled pairs and residual as
// the fit Worker and computes requested central-difference columns with fit.jacobianColumn.
// The staged-prediction anchor is set once per LM iteration (gen), as the local Jacobian does.

import { loadModel, Pixels } from "./profile.js";
import { makeResidual, jacobianColumn, jacobianSteps } from "./fit.js";

let fn = null, steps = null, anchorGen = -1;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const model = loadModel(m.profileMeta, m.profileBin);
      const qs = m.pairs.map((p) => ({
        n: p.n, tlab: p.tlab, W: p.W, sm: p.sm, ct: p.ct, cmask: p.cmask,
        px: new Pixels(model, p.rgb),
        cpx: p.crgb ? new Pixels(model, p.crgb) : null,
      }));
      fn = makeResidual(qs);
      anchorGen = -1;
      self.postMessage({ type: "ready" });
    } else if (m.type === "col") {
      if (m.gen !== anchorGen) { fn.anchor(m.x); anchorGen = m.gen; }
      if (!steps || steps.length !== m.x.length) steps = jacobianSteps(m.x.length);
      const col = jacobianColumn(fn, m.x, m.i, steps[m.i]);
      self.postMessage({ type: "col", gen: m.gen, i: m.i, col }, [col.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", detail: String((err && err.message) || err) });
  }
};
