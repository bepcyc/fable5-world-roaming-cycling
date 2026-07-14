# LAAS fork — entry points (`just --list` shows all)

# install dependencies if node_modules is missing
deps:
    @[ -d node_modules ] || npm install

# universal: start the dev server, then open http://localhost:5173 in Chrome
run: deps
    npm run dev

# Owner's desktop Chrome has WebGPU working as-is — normally `just run` + your
# own browser is enough; use this only if a profile/machine lacks WebGPU.
# NixOS fallback: dev server + Chrome forced onto WebGPU/Vulkan flags (dedicated profile)
run-nixos: deps
    #!/usr/bin/env bash
    set -euo pipefail
    npm run dev &
    SERVER=$!
    trap 'kill $SERVER 2>/dev/null || true' EXIT
    for _ in $(seq 1 50); do curl -sf http://localhost:5173/ >/dev/null 2>&1 && break; sleep 0.2; done
    google-chrome \
      --user-data-dir="$HOME/.cache/laas-chrome-profile" \
      --enable-unsafe-webgpu --enable-features=Vulkan \
      --new-window http://localhost:5173/

# Verified remotely 2026-07-02: Pop!_OS 24.04, RX 6800 XT (RADV NAVI21), Chrome 149
# at /usr/bin/google-chrome, X11; node/npm NOT installed there — guard below says so.
# NO --use-angle=vulkan (2026-07-04): WebGPU runs on Dawn's own Vulkan backend,
# never through ANGLE — adding it makes ANGLE's GL-on-Vulkan backend open a
# SECOND, uncoordinated Vulkan client against the same GPU. That contention
# native-crashes the GPU process (SIGFPE, exit_code=136) the moment ride mode
# mounts the cockpit, 100% reproducible, headed-Chrome only (never headless —
# see tools/probe-real-crash.ts). Confirmed by dropping the flag: crash gone,
# 2/2 clean runs cycling every bike mode.
# Pop!_OS / AMD RX box: dev server + Chrome with WebGPU/Vulkan flags (dedicated profile)
run-rxgpu:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      echo "node/npm missing on this box — install Node 22 first, e.g.:"
      echo "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
      echo "  nvm install 22"
      exit 1
    fi
    [ -d node_modules ] || npm install
    npm run dev &
    SERVER=$!
    trap 'kill $SERVER 2>/dev/null || true' EXIT
    for _ in $(seq 1 50); do curl -sf http://localhost:5173/ >/dev/null 2>&1 && break; sleep 0.2; done
    BROWSER=""
    for b in google-chrome google-chrome-stable chromium chromium-browser; do
      command -v "$b" >/dev/null 2>&1 && BROWSER="$b" && break
    done
    if [ -z "$BROWSER" ]; then echo "no Chrome/Chromium found — install google-chrome-stable"; exit 1; fi
    "$BROWSER" \
      --user-data-dir="$HOME/.cache/laas-chrome-profile" \
      --enable-unsafe-webgpu --enable-features=Vulkan \
      --new-window http://localhost:5173/

# run on LAN Wi-Fi for a phone/tablet. Plain HTTP (no TLS cert). WebGPU + Web
# Bluetooth need a SECURE CONTEXT, which a LAN IP over http is not — so ONCE per
# client browser, whitelist the origin:
#   chrome://flags/#unsafely-treat-insecure-origin-as-secure
#   → paste http://<IP>:5173 → Enabled → relaunch that browser
# Then open  http://<IP>:5173/?nogate=1  (?nogate=1 skips BrowserGate, which
# blocks tablets). Prints the exact IP/flag/URL on start. Ctrl+C stops.
run-lan: deps
    #!/usr/bin/env bash
    set -euo pipefail
    IP="${LAN_IP:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}"
    echo "── LAN mode ─────────────────────────────────────────────"
    echo "  1) in the tablet's Chrome open:"
    echo "     chrome://flags/#unsafely-treat-insecure-origin-as-secure"
    echo "     add  http://${IP}:5173  → Enabled → relaunch Chrome"
    echo "  2) then open:  http://${IP}:5173/?nogate=1"
    echo "─────────────────────────────────────────────────────────"
    LAN=1 npm run dev

# Mobile profile = ?preset=low (half-res grids: heightRes 2048 / simRes 1024)
# + ?dpr=1. The engine is verified to boot the full world with ZERO WebGPU
# errors under the COMPLETE mobile floor-limit set (`?limitcap=mobile` on real
# Chrome+GPU) — the ≤8 storage-buffer river-carve split (FlowRivers.ts) is what
# unblocks Adreno/PowerVR. What can't be proven off-device: sustained FPS,
# thermal, GPU-memory OOM — confirm those on the actual phone/tablet.

# Galaxy Tab S8 Ultra (Snapdragon 8 Gen 1, Adreno 730). Lowest-risk target:
# WebGPU is default-on in Chrome ≥121 on Android 12+ for Adreno (Qualcomm).
run-samsung: deps
    #!/usr/bin/env bash
    set -euo pipefail
    IP="${LAN_IP:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}"
    echo "── Galaxy Tab S8 Ultra · Adreno 730 ─────────────────────"
    echo "  needs: Chrome for Android ≥121, Android 12+  (WebGPU default-on)"
    echo "  1) tablet Chrome → chrome://flags/#unsafely-treat-insecure-origin-as-secure"
    echo "     add  http://${IP}:5173  → Enabled → relaunch Chrome"
    echo "  2) sanity: chrome://gpu → WebGPU = 'Hardware accelerated'"
    echo "  3) open:  http://${IP}:5173/?nogate=1&preset=low&dpr=1"
    echo "─────────────────────────────────────────────────────────"
    LAN=1 npm run dev

# Pixel 10 Pro (Tensor G5, Imagination PowerVR DXT-48-1536). Higher-risk:
# WebGPU on PowerVR only shipped in Chrome ≥139 and needs Android 16, and those
# drivers are newer/less proven. If WebGPU is missing/unstable there it is the
# device's browser+GPU support (verify chrome://gpu), not this build — limits
# are respected. NB: Android 16 "Advanced Protection Mode" disables WebGPU.
run-pixel: deps
    #!/usr/bin/env bash
    set -euo pipefail
    IP="${LAN_IP:-$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}"
    echo "── Pixel 10 Pro · Tensor G5 / PowerVR ───────────────────"
    echo "  needs: Chrome for Android ≥139, Android 16  (PowerVR WebGPU is newer)"
    echo "  1) phone Chrome → chrome://flags/#unsafely-treat-insecure-origin-as-secure"
    echo "     add  http://${IP}:5173  → Enabled → relaunch Chrome"
    echo "  2) sanity: chrome://gpu → WebGPU = 'Hardware accelerated'"
    echo "     (if not: update Chrome; ensure Advanced Protection Mode is OFF)"
    echo "  3) open:  http://${IP}:5173/?nogate=1&preset=low&dpr=1"
    echo "─────────────────────────────────────────────────────────"
    LAN=1 npm run dev

# stop a dev/preview server holding :5173 or :5174 (orphaned or backgrounded).
# `just run`/`just run-lan` are foreground — normally just Ctrl+C them.
stop:
    #!/usr/bin/env bash
    pids="$( { lsof -ti tcp:5173 -sTCP:LISTEN 2>/dev/null; lsof -ti tcp:5174 -sTCP:LISTEN 2>/dev/null; } | sort -u )"
    if [ -n "$pids" ]; then kill $pids && echo "stopped: $pids"; else echo "nothing listening on :5173/:5174"; fi

# strict TypeScript check (the repo's only automated gate)
typecheck: deps
    npm run typecheck

# production build (tsc + vite build; served under /laas/ base path)
build: deps
    npm run build

# serve the production bundle
preview: build
    npm run preview

# ── PACKAGING (joint Claude+Codex decision: ship a full Chromium everywhere) ──
# WebGPU + TSL compute + Web Bluetooth force a Chromium runtime. Desktop =
# Electron (bundled Chromium). Android = TWA over the user's Chrome. WebKitGTK
# (Tauri) / System-WebView (Capacitor) were rejected: no reliable WebGPU, no
# Web Bluetooth. Full write-up: docs/PACKAGING.md.

# Linux desktop binary (Electron = bundled Chromium). WebGPU flags and the
# "NO --use-angle=vulkan" rule live in electron/main.cjs; the app is served from
# a 127.0.0.1 loopback origin (secure context) so WebGPU + Web Bluetooth work.
# Uses `vite build` (not the strict `build`) so packaging is not gated on the
# typecheck — run `just typecheck` separately. Outputs:
#   dist-electron/linux-unpacked/LAAS      (runnable binary)
#   dist-electron/laas-linux-x64.AppImage  (single-file distributable)
linux-binary: deps
    #!/usr/bin/env bash
    set -euo pipefail
    ELECTRON=1 npx vite build
    npx electron-builder --linux --config electron-builder.yml
    echo "── linux-binary built ──"
    ls -la dist-electron/*.AppImage dist-electron/linux-unpacked/laas 2>/dev/null || true

# Android APK via TWA (Bubblewrap) — the app runs in the user's Chrome, the ONLY
# wrapper keeping BOTH WebGPU and Web Bluetooth (Chrome ≥121 on Android 12+,
# Adreno/Qualcomm = default-on WebGPU). The PWA must be served over HTTPS.
# HOST = the https origin serving the `/laas/` production build.
#   just android-apk HOST=https://your-domain.example
# Bubblewrap auto-installs a JDK + Android SDK into ~/.bubblewrap on first run.
# After building, publish  HOST/.well-known/assetlinks.json  (bubblewrap prints
# it) or the TWA falls back to a Custom Tab with a visible URL bar.
android-apk HOST='': build
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "{{HOST}}" ]; then
      echo "android-apk needs a hosted HTTPS origin serving the /laas/ build."
      echo "  1) deploy dist/ to  https://<origin>/laas/"
      echo "  2) just android-apk HOST=https://<origin>"
      echo "TWA requires HTTPS: WebGPU + Web Bluetooth are secure-context-only."
      exit 2
    fi
    MANIFEST="{{HOST}}/laas/manifest.webmanifest"
    echo "TWA manifest → $MANIFEST"
    mkdir -p android && cd android
    [ -f twa-manifest.json ] || npx -y @bubblewrap/cli init --manifest="$MANIFEST"
    npx -y @bubblewrap/cli build
    echo "── android-apk built ──"
    ls -la app-release-signed.apk ./*.apk 2>/dev/null || true
