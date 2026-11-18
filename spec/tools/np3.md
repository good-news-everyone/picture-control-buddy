# np3.py + test_np3.py

`np3.py` — the NP3 binary format: (de)serialization of `np3.Control`, bit-exact against the
official Nikon samples. Layout: `spec/np3-format.md`.

`test_np3.py` — the checks for it:

```
python3 test_np3.py
```

No arguments. For every `third_party/samples/*.NP3`:

1. `serialize(deserialize(bytes))` must reproduce the file byte for byte (exit code non-zero on
   failure; prints a byte-diff on mismatch).
2. For samples with a curve, `np3.curve_table(points)` — the natural cubic spline through the
   points — must reproduce the stored 257-value table bit for bit.

Always runs in a fresh clone: the samples are committed in `third_party/`.
