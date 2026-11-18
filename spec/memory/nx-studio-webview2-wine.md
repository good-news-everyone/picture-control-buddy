---
name: nx-studio-webview2-wine
description: "NX Studio in Bottles — empty Nikon ID login; WebView2 146 crashes on the dcomp.dll stub in Wine, cured with flags via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
metadata:
  node_type: memory
  type: project
  originSessionId: b0ff08cb-7f4d-40c8-8b15-1248b33205f8
  modified: 2026-11-04T21:56:43.003Z
---

NX Studio 1.11 in the bottle NX-Studio__153 (sys-wine-11.21, win11, WebView2 146.0.3856.62): the "Authentification for OAuth" window is empty. The page itself loads fully; the WebView2 GPU process crashes 6 times (0x80000003) after `DCompositionCreateDevice failed: Not implemented`, then `FATAL: GPU process isn't usable. Goodbye.`

`--disable-gpu` alone is not enough: it crashes the same way, the software output path also requires DComp. What worked (2026-11-05, confirmed by the user):
`--disable-gpu --disable-direct-composition --disable-features=ForceSWDCompWhenDCompFallbackRequired`
Which of the last two flags is necessary was not narrowed down.

**Why:** dcomp.dll in Wine is a stub, it is not the driver and not OpenGL.

**How to apply:** the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS variable in the bottle's Environment_Variables. Chromium log: add `--enable-logging --log-level=0 --log-file=Z:\path`. The same trick works for other WebView2 applications under Wine.
