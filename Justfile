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

# Verified remotely 2026-07-02: Pop!_OS 24.04, RX 6800 XT (RADV NAVI21), Chrome 149
# at /usr/bin/google-chrome, X11; node/npm NOT installed there — guard below says so.
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
