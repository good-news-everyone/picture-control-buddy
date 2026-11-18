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
  return { develop };
}
