// RAW loading through a Worker with a monotonic generation.
// Plan section 4 (spec/ui-manual-mvp-plan.md): File.arrayBuffer without upload, develop in the Worker,
// WASM and bytes are not duplicated (transfers), stale results are discarded.
//
// Model: every open() bumps the generation; onUpdate arrives only for the current generation,
// interrupted operations finish silently. An error of a new file does not touch the previous
// frame — the caller handles it (the UI keeps the old state).
//
// onUpdate events (every event carries the caller's `tag` from open(), null by default):
//   { type: "busy",  gen, name, tag }                                  — decoding started
//   { type: "ready", gen, name, image: {w, h, rgb}, info, warn, tag }  — warn: the camera is not a Z f
//   { type: "error", gen, name, code, detail, tag }                    — code: raw.js / wasm_failed

/** A warning for a camera other than the Nikon Z f (the neutral model was trained on it). */
export function cameraWarn(info) {
  const s = `${info.make || ""} ${info.model || ""}`.toLowerCase();
  return !/\bnikon\b/.test(s) || !/\bz f\b/.test(s);
}

/**
 * worker: the path to raw-worker.js relative to the page (import.meta does not work: the Worker
 * is created from the document base). One Worker per loader, one wasm instance inside.
 */
export function createRawLoader({ worker: workerUrl = "lib/raw-worker.js", onUpdate = null } = {}) {
  const worker = new Worker(workerUrl, { type: "module" });
  let gen = 0;
  let seq = 0;
  const pending = new Map();

  worker.onmessage = (e) => {
    const { id, w, h, info, rgb, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) {
      if (p.gen === gen) {
        onUpdate && onUpdate({ type: "error", gen: p.gen, name: p.name, code: error.code, detail: error.detail, tag: p.tag });
        p.resolve(null);
      } else p.resolve(null);
      return;
    }
    if (p.gen !== gen) { p.resolve(null); return; }   // stale: it finished, we do not update the UI
    const image = { w, h, rgb };
    onUpdate && onUpdate({ type: "ready", gen: p.gen, name: p.name, image, info, warn: cameraWarn(info), tag: p.tag });
    p.resolve(image);
  };
  worker.onerror = (e) => {
    // the Worker itself failed: reject everything pending
    for (const [, p] of pending) {
      if (p.gen === gen) onUpdate && onUpdate({ type: "error", gen: p.gen, name: p.name, code: "decode_failed", detail: e.message || "worker", tag: p.tag });
      p.resolve(null);
    }
    pending.clear();
  };

  /**
   * source: File/Blob or Uint8Array; name — for Uint8Array.
   * Every call makes the previous results stale. Size — long, 0 — half the sensor.
   * tag — an arbitrary caller token, echoed back in every onUpdate event for this open()
   * (app.js routes pair-assembly decodes apart from editor loads by it).
   */
  async function open(source, { name = null, long = 1600, tag = null } = {}) {
    gen++;
    const g = gen;
    name = name ?? (source instanceof Blob ? source.name : "buffer");
    onUpdate && onUpdate({ type: "busy", gen: g, name, tag });
    const bytes = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source;
    if (g !== gen) return null;   // stale by the time the read finished: do not send to the Worker (plan §5, P3)
    const id = ++seq;
    return await new Promise((resolve) => {
      pending.set(id, { gen: g, name, resolve, tag });
      worker.postMessage({ id, bytes, long }, [bytes.buffer]);
    });
  }

  return {
    open,
    /** The current generation: an open() result stays valid until the generation grows. */
    get generation() { return gen; },
    terminate() { worker.terminate(); pending.clear(); },
  };
}
