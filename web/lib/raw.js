// RAW decoding through web/raw.wasm (Rust, rawler). Works in the browser and in Node.
// Python pair: rawdev.develop + render.linear without vignetting. Policy: spec/web-tests.md.

/** source: a Response, ArrayBuffer or Uint8Array with raw.wasm. */
export async function initRaw(source) {
  const bytes = source instanceof Response ? await source.arrayBuffer() : source;
  const mod = await WebAssembly.compile(bytes);
  const imports = {};
  // wasm-bindgen imports from uuid inside rawler: not called during decoding
  for (const i of WebAssembly.Module.imports(mod))
    (imports[i.module] ??= {})[i.name] = () => { throw new Error("unexpected wasm import " + i.name); };
  const ex = (await WebAssembly.instantiate(mod, imports)).exports;

  /**
   * Camera linear RGB 0..1 after white balance, with margins, shrinking and rotation.
   * long: the largest side (integer shrinking), 0 — half the sensor.
   * On error: an exception with the fields code (nef_high_efficiency, not_bayer, decode_failed) and detail.
   */
  function develop(bytes, long = 1600) {
    const p = ex.alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
    const ok = ex.develop(p, bytes.length, long);
    const info = JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.info_ptr(), ex.info_len())));
    if (!ok) throw Object.assign(new Error(info.error), { code: info.error, detail: info.detail });
    const w = ex.width(), h = ex.height();
    const rgb = new Float32Array(ex.memory.buffer, ex.data(), w * h * 3).slice();
    return { w, h, rgb, info };
  }

  // Zoom support (stage Z2 of spec/ui-zoom-plan.md): hold the mosaic of one RAW, develop rectangles of it.
  // raw.wasm built before Z2 has no such exports: hold/roi then throw code "zoom_unsupported".
  const zoom = typeof ex.hold === "function" && typeof ex.roi === "function" && typeof ex.release === "function";
  const readInfo = () => JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.info_ptr(), ex.info_len())));
  const needZoom = () => {
    if (!zoom) throw Object.assign(new Error("zoom_unsupported"),
      { code: "zoom_unsupported", detail: "raw.wasm has no hold/roi exports; rebuild it with sh web/build.sh" });
  };

  /**
   * Decodes the RAW like develop and keeps its margin-cropped mosaic inside the wasm (about 2 bytes per
   * sensor pixel), replacing any previous hold. Returns { info } with the develop info plus
   * held:[W,H] (sensor px), margin:[mx,my] (sensor px), cfa:"RGGB", orientation.
   * Errors: as develop (nef_high_efficiency, not_bayer, decode_failed), or zoom_unsupported.
   */
  function hold(bytes) {
    needZoom();
    const p = ex.alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
    const ok = ex.hold(p, bytes.length);
    const info = readInfo();
    if (!ok) throw Object.assign(new Error(info.error), { code: info.error, detail: info.detail });
    return { info };
  }

  /**
   * Float RGB (0..1, interleaved, rows top-down, NOT rotated: sensor orientation) of a rectangle of the
   * held area. level 2: half resolution, coordinates in half px (the superpixel arithmetic of develop;
   * the whole area equals develop(long = 0) before its rotation). level 1: full sensor resolution (PPG
   * demosaic), coordinates in full px; full px (X, Y) is centred at sensor (2*MX + X + 0.5, 2*MY + Y + 0.5),
   * half px (u, v) covers full px [2u, 2u+2) x [2v, 2v+2) (edge-aligned), MX = margin[0] / 2.
   * Errors: no_hold, bad_level, roi_bounds, zoom_unsupported (code + detail).
   */
  function roi(x, y, w, h, level) {
    needZoom();
    const ok = ex.roi(x, y, w, h, level);
    const info = readInfo();
    if (!ok) throw Object.assign(new Error(info.error), { code: info.error, detail: info.detail });
    const ow = ex.width(), oh = ex.height();
    const rgb = new Float32Array(ex.memory.buffer, ex.data(), ow * oh * 3).slice();
    return { w: ow, h: oh, rgb, info };
  }

  /** Drops the held mosaic (a no-op when nothing is held or the wasm has no zoom exports). */
  function release() {
    if (zoom) ex.release();
  }
  return { develop, hold, roi, release, zoom };
}
