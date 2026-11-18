---
name: lightcraft-fidelity-zf
description: "Measuring LightCraft sliders against Lightroom on the Z f (render_fidelity.py from PR #1181) — where it lives, pitfalls, where it was published"
metadata:
  node_type: memory
  type: project
  originSessionId: ce7d2cfd-c4c4-4092-9235-6439961af382
  modified: 2026-10-13T12:53:32.220Z
---

2026-10-13: ~/expirements/lightcraft-fidelity — the tool from PR #1181 (tool/, .venv), a Lightroom catalog (lr-catalog), presets (plan/), exports exports/s3, a run runs/zf3, drafts comment-*.md. Published from good-news-everyone: #523 issuecomment-6145341651, #1371, #1181; a (secret) gist good-news-everyone/19e5ea492d1fdb1c3cf440aeae88dfa6.

Also spectral-vs-fit/ there: a comparison of "fitting to a JPEG vs a spectral matrix" (workaround: nef-strip-previews.py spoils previews in a NEF copy), published in #1207 issuecomment-6145992789, pictures in gist 276ed24168c6072e76d97f967cabae0a (pushed with a token via git push).

Pitfalls: LightCraft 0.7.1 renders --size 2048 as 2047 (fix in main #1312) -> a 2016 px export; frames on Z lenses do not align (Lightroom always applies the built-in distortion correction, LightCraft does not) -> shoot with a manual non-CPU 50 mm, Picture Control Standard, ADL Off (frames DSC_5621-5629 in ~/Pictures/2026/test_fidelity).

**Why:** maintainers may ask for a rerun (e.g.g on the branch #1383) — everything is ready for a repeat.
**How to apply:** a rerun = a new --run on the same exports/s3 with a different --cli. Gists via the API with a token: the user allowed ~/.config/github-mcp-token, see [[github-via-mcp]].
