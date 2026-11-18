// RAW decoding worker: a single raw.wasm instance, a queue until it is ready.
// The file bytes are transferred here (no copy), the result goes back as an rgb transfer.
// Python pair: rawdev.develop. Change policy: spec/web-tests.md.
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
    for (const m of queue.splice(0))
      self.postMessage({ id: m.id, error: { code: "wasm_failed", detail: failed } });
  });

self.onmessage = (e) => {
  if (raw) run(e.data);
  else if (failed) self.postMessage({ id: e.data.id, error: { code: "wasm_failed", detail: failed } });
  else { queue.length = 0; queue.push(e.data); }   // only the latest: the earlier waiters are no longer needed (plan §5, P3)
};

function run({ id, bytes, long }) {
  try {
    const { w, h, rgb, info } = raw.develop(bytes, long);
    self.postMessage({ id, w, h, info, rgb }, [rgb.buffer]);
  } catch (err) {
    self.postMessage({ id, error: { code: err.code || "decode_failed", detail: err.detail || String(err.message || err) } });
  }
}
