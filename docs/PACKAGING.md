# PACKAGING — Android APK + Linux binary

**Joint decision (Claude Opus 4.8 + Codex GPT-5.5, independent web research,
2026-07-06): ship a full Chromium runtime on every target.** This codebase is
three.js `WebGPURenderer` + TSL **compute** passes (storage buffers /
`StorageTexture`, ~48 files) + **Web Bluetooth** (BLE cycling sensors). Those
three hard-constrain the runtime:

- **WebGPU compute** cannot fall back to WebGL2 — TSL vertex/fragment nodes
  compile to GLSL, but compute shaders + storage buffers are WebGPU-only.
  `forceWebGL` would be a simulation rewrite, not a flag.
- **Web Bluetooth** is absent in Android System WebView (`webview_android:
  false`) and in WebKitGTK.

So any wrapper built on the **system WebView** (Capacitor, Tauri, plain
WebView) loses WebGPU and/or Web Bluetooth. Only wrappers that carry/borrow a
**full Chromium** keep both.

## Targets

| Target | Wrapper | Chromium source | WebGPU | Web Bluetooth | `just` |
|---|---|---|---|---|---|
| Android | **TWA** (Bubblewrap) | user's installed Chrome | ✅ ≥121, Android 12+, Adreno | ✅ | `just android-apk HOST=…` |
| Linux desktop | **Electron** | bundled Chromium | ✅ (with flags) | ✅ (main-process handler) | `just linux-binary` |

Rejected: Capacitor / Tauri v2 / plain WebView — system WebView, no reliable
WebGPU, no Web Bluetooth. Native rewrite (Jetpack WebGPU Kotlin) — months, not
"simplest".

Engine code is **unchanged**. Android reuses the existing `?nogate=1` param
(manifest `start_url`) to skip the mobile `BrowserGate`, so no source edit is
needed to run on a phone.

## Linux binary (Electron) — will it run on THIS machine?

**Yes.** Box = Pop!_OS, **AMD RX 6800 XT (RADV NAVI21)**, Vulkan 1.4.318, radv.
WebGPU already runs here via `just run-rxgpu`. `electron/main.cjs` reproduces
its exact conditions:

- sets `--enable-unsafe-webgpu --enable-features=Vulkan` (WebGPU is **not**
  default-on in Chromium on Linux);
- **does NOT** set `--use-angle=vulkan` — that opens a second, uncoordinated
  Vulkan client via ANGLE and native-crashes the GPU process (SIGFPE, exit 136)
  the instant the cockpit mounts (documented in `Justfile: run-rxgpu`);
- serves `dist/` from a `127.0.0.1` loopback origin (secure context) so WebGPU
  and Web Bluetooth are permitted and absolute asset paths resolve.

Caveat: this box has **radv (Mesa) present, so it works.** A machine with only
`llvmpipe` (software Vulkan) or no Vulkan ICD would boot but render on CPU or
fail the WebGPU adapter request. Also needs a real display/GPU session (an
`xvfb`/software path falls back to llvmpipe).

Build outputs: `dist-electron/linux-unpacked/LAAS` (binary) and
`dist-electron/laas-linux-x64.AppImage` (single file).

## Android APK (TWA) — what it needs

TWA loads the PWA from an **HTTPS origin** (secure context is mandatory for
WebGPU + Web Bluetooth); it does not bundle the content. So `just android-apk`
requires:

1. Deploy the `/laas/` production build (`just build` → `dist/`) to an HTTPS
   host (e.g. GitHub Pages under a `/laas/` path).
2. `just android-apk HOST=https://<origin>` — Bubblewrap auto-installs a JDK +
   Android SDK into `~/.bubblewrap` on first run, fetches
   `HOST/laas/manifest.webmanifest`, and builds the APK/AAB.
3. Publish `HOST/.well-known/assetlinks.json` (Bubblewrap prints it) for Digital
   Asset Links, or the TWA degrades to a Custom Tab with a URL bar.

Device requirements: Chrome for Android ≥121, Android 12+, Qualcomm/Adreno (or
ARM) GPU — WebGPU is default-on there, no user flags. `manifest.webmanifest`
already sets `start_url` to `?nogate=1&preset=low&dpr=1` (skip gate + mobile
quality preset).
