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
      --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan \
      --new-window http://localhost:5173/

# UNVERIFIED remotely (ssh key not authorized yet) — re-check binaries/GPU once access lands.
# Pop!_OS / AMD RX box: dev server + first available Chrome/Chromium with WebGPU/Vulkan flags (dedicated profile)
run-rxgpu: deps
    #!/usr/bin/env bash
    set -euo pipefail
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
      --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan \
      --new-window http://localhost:5173/

# strict TypeScript check (the repo's only automated gate)
typecheck: deps
    npm run typecheck

# production build (tsc + vite build; served under /laas/ base path)
build: deps
    npm run build

# serve the production bundle
preview: build
    npm run preview
