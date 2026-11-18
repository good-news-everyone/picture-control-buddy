# np3-fit

Infers and emulates Nikon Flexible Color picture control (NP3) profiles.
A Python pipeline fits profile parameters against real renders; `web/` is a
browser port of the same pipeline (WASM raw decoder + WebGL) that applies
and exports NP3 profiles.

Design documents live in [`spec/`](spec/README.md). See
[`AGENTS.md`](AGENTS.md) for the repository layout and how to run the tests.

## Methodology and legal notice

This is an independent, unofficial project. It is not affiliated with,
endorsed by, or supported by Nikon Corporation. "Nikon", "NP3",
"Picture Control", "NEF" and "NX Studio" are trademarks of Nikon
Corporation.

- **NP3 format support.** The binary layout was adapted from the
  MIT-licensed open-source project
  [ssssota/nikon-flexible-color-picture-control](https://github.com/ssssota/nikon-flexible-color-picture-control)
  (see [`third_party/LICENSE`](third_party/LICENSE)) and independently
  verified bit-exact against NP3 files written by Nikon's own software.
- **Empirical response model.** The color and response models are fitted
  from measurements of renders produced by the author from their own
  photographs using their own licensed copy of NX Studio. No decompilation,
  disassembly, or other extraction of code from Nikon software was
  performed, and no Nikon code is included in this repository. Nikon's
  internal lookup tables were not used.
- **Authorship of samples.** Everything committed to this repository was
  produced by the author: photographs were shot by the author, and the NP3
  test fixtures were exported from the author's own licensed copy of
  NX Studio.

## License

MIT, see [LICENSE](LICENSE).
