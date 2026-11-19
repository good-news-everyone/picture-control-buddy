// Pair preparation worker (spec/ui-plan.md §3, stage 2): a thin lifecycle wrapper around the
// pure web/lib/pair-prepare.js. One preparation at a time — a new prepare message supersedes
// the running one (the cancel flag, checked between stages and inside the search loops).
// The main thread owns the generations; results carry the caller's generation back and stale
// ones are discarded there (same rule as lib/raw-worker.js / lib/loader.js).
//
// Messages in:
//   { type: "prepare", id, generation, linear, lw, lh, targetRgb, tw, th, xmp, rawBytes, gain, gainNote }
//       — linear/targetRgb are transferred; rawBytes is the RAW file (the embedded JPEG source)
//   { type: "cancel", id }
// Messages out:
//   { type: "progress", id, stage }                       — decode/vignette/crop/orient/radial/align/shrink
//   { type: "ready", id, generation, prepared }           — x/y/masks transferred (detached)
//   { type: "error", id, generation, code, detail }
// A cancelled task posts nothing at all.

import { preparePair } from "./pair-prepare.js";

// The codec hook: decode the embedded JPEG bytes through the browser (Worker-safe: no document).
async function decodeJpeg(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }),
                                         { imageOrientation: "none", colorSpaceConversion: "none" });
  const w = bitmap.width, h = bitmap.height;
  const ctx = new OffscreenCanvas(w, h).getContext("2d", { colorSpace: "srgb" });
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  bitmap.close();
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return { data: rgb, w, h };
}

let task = null;   // { id, cancelled }

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "cancel") {
    if (task && task.id === m.id) task.cancelled = true;
    return;
  }
  if (m.type !== "prepare") return;
  if (task) task.cancelled = true;          // one at a time: the running preparation is stale
  const cur = { id: m.id, cancelled: false };
  task = cur;
  const stale = () => cur.cancelled || task !== cur;

  (async () => {
    const transfer = [];
    if (m.linear) transfer.push(m.linear.buffer);
    if (m.targetRgb) transfer.push(m.targetRgb.buffer);
    if (m.targetU8) transfer.push(m.targetU8.buffer);
    if (m.rawBytes) transfer.push(m.rawBytes.buffer);
    try {
      const prepared = await preparePair({
        linear: m.linear, lw: m.lw, lh: m.lh,
        targetRgb: m.targetRgb, targetU8: m.targetU8, tw: m.tw, th: m.th,
        xmp: m.xmp, rawBytes: m.rawBytes,
        gain: m.gain, gainNote: m.gainNote,
        id: m.pairId ?? null, files: m.files ?? null, generation: m.generation ?? null,
        decodeJpeg,
        onProgress: (stage) => { if (!stale()) self.postMessage({ type: "progress", id: m.id, stage }); },
        shouldCancel: stale,
      });
      if (stale() || !prepared) return;     // cancelled: exit without a result
      const out = [
        prepared.x.buffer, prepared.y.buffer,
        prepared.masks.clipMask.buffer, prepared.masks.reportMask.buffer,
        prepared.masks.validMask.buffer, prepared.masks.nearWhiteMask.buffer,
        prepared.gain.buffer,
      ];
      self.postMessage({ type: "ready", id: m.id, generation: m.generation, prepared }, out);
    } catch (err) {
      if (stale()) return;
      self.postMessage({ type: "error", id: m.id, generation: m.generation,
                         code: err.code || "prepare_failed", detail: String(err.message || err) });
    }
  })();
};
