// RAW decoding worker: a single raw.wasm instance, a queue until it is ready.
// The file bytes are transferred here (no copy), the result goes back as an rgb transfer.
// Python pair: rawdev.develop. Change policy: spec/web-tests.md.
//
// Two kinds of messages:
//  - untyped { id, bytes, long }: develop. While the wasm initializes only the latest one is kept.
//  - typed { type: "hold" | "roi" | "release", id, ... } (zoom, spec/ui-zoom-plan.md Z2/D4): never dropped,
//    answered in arrival order (also relative to develop messages that were not superseded).
//      hold    { id, bytes }                    -> { id, info }
//      roi     { id, x, y, w, h, level }        -> { id, w, h, info, rgb } (rgb transferred)
//      release { id }                           -> { id }
//    errors: { id, error: { code, detail } } (zoom_unsupported when raw.wasm has no zoom exports).
import { initRaw } from "./raw.js";

let raw = null;
let failed = null;
const queue = [];

initRaw(await fetch(new URL("../raw.wasm", import.meta.url)))
  .then((r) => {
    raw = r;
    for (const m of queue.splice(0)) run(m);
  })
  .catch((e) => {
    failed = String(e && e.message || e);
    for (const m of queue.splice(0)) fail(m, "wasm_failed", failed);
  });

self.onmessage = (e) => {
  const m = e.data;
  if (raw) run(m);
  else if (failed) fail(m, "wasm_failed", failed);
  else {
    // only the latest develop: the earlier waiting develops are no longer needed (plan §5, P3);
    // typed zoom messages stay queued in order
    if (!m.type) for (let i = queue.length - 1; i >= 0; i--) if (!queue[i].type) queue.splice(i, 1);
    queue.push(m);
  }
};

function fail(m, code, detail) {
  self.postMessage({ id: m.id, error: { code, detail } });
}

function run(m) {
  try {
    if (m.type === "hold") {
      const { info } = raw.hold(m.bytes);
      self.postMessage({ id: m.id, info });
    } else if (m.type === "roi") {
      const { w, h, rgb, info } = raw.roi(m.x, m.y, m.w, m.h, m.level);
      self.postMessage({ id: m.id, w, h, info, rgb }, [rgb.buffer]);
    } else if (m.type === "release") {
      raw.release();
      self.postMessage({ id: m.id });
    } else {
      const { w, h, rgb, info } = raw.develop(m.bytes, m.long);
      self.postMessage({ id: m.id, w, h, info, rgb }, [rgb.buffer]);
    }
  } catch (err) {
    fail(m, err.code || "decode_failed", err.detail || String(err.message || err));
  }
}
