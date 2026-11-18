#!/bin/sh
# Builds the RAW decoding WebAssembly: web/raw.wasm. Requires rustup (stable, wasm32-unknown-unknown);
# wasm-opt (npm binaryen) is optional: shrinks the file by ~12%.
set -e
cd "$(dirname "$0")/raw"
cargo +stable build --release --target wasm32-unknown-unknown
W=target/wasm32-unknown-unknown/release/np3raw.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals "$W" -o ../raw.wasm
else
  cp "$W" ../raw.wasm
fi
ls -la ../raw.wasm
