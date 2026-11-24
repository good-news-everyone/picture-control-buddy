# Detail fit research (Clarity, Mid-range sharpening, Sharpening), 2026-11-24

Can the fit choose the NP3 detail tools from a Lightroom target? Measured against real NX Studio
exports, not the `detail.py` model. Results are in `spec/tools/detail.md` ("Fitting the detail
tools"); the fit engine does not use any of this yet.

Inputs (local only): LR targets `renders/sa/done/<F>.jpg` and the LR variants
`renders/sa/{CLA50,CLAM40,TEX50,SHA100}/<F>.jpg`; NX exports `renders/sweep/fitcheck`
(1512 px), `renders/sweep/detailcheck` and `detailcheck2` (full size; the TIFFs were deleted after
the run, `make_pack.py [detailcheck2]` rebuilds the packs for a new NX export). Outputs and caches
go to `_local/research/detailfit/`.

| Script | What |
|---|---|
| `bands.py` | Shared helpers (Y', DoG bands, tiles). `kernel`: NX 1512 export vs BOX / Lanczos of the full export. `prep` / `fit`: the band-energy method (rejected: the tone LUT fitted first soaks up Clarity). |
| `lsq.py` | Coherent band-limited regression (sigma 1.4-45 px at x4): target Y' ~ LUT(NX Y') + sum v·H_tool(NX Y'), the 16-knot LUT fitted jointly, sign regions enumerated. |
| `ident2.py` | Identifiability on NX probes (tools pack): CLAP2 -> Clarity 2.0-2.3, CLAM5 -> -4.5..-5.2. |
| `sa_lsq.py` | Clarity / Mid-range for the 12 SA fitcheck frames, per frame, joint, leave-one-out. |
| `full.py`, `full_report.py` | Full size: textured crops, subpixel alignment (phase correlation + FFT shift), band gains with the S2B repeat as the instrument; the NX Sharpening that matches the target per band. |
| `lr_x4.py`, `lr_joint.py`, `lr_full.py` | The same for the LR variants with strong detail. |
| `make_pack.py` | Builds `renders/sweep/detailcheck` (NEW4 x Sharpening 0/2/2B/4/6 + DET) or `detailcheck2` (NEW4 with the detail fitted to the LR variants). |
| `verify.py` | NX NEW4 vs NX with the fitted detail against each LR variant (x4 band residual, full-size band gains). |
