NixOS/Linux headless WebGPU: system Chrome + `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan`, and ALWAYS assert adapter identity — without `--use-angle=vulkan` you silently get SwiftShader.

Facts established 2026-07-02 on this box (Ryzen 4650G / Vega 7 / RADV / NixOS 26.05, Chrome 149):

- **Playwright's bundled Chromium does not run on NixOS at all** (FHS dynamic linking) — `chromium.launch({channel:'chromium'})` dies with "Target page, context or browser has been closed". `npx playwright install chromium` succeeds but the binary is unusable.
- `channel:'chrome'` fails too (Playwright looks at `/opt/google/chrome/chrome`; NixOS puts a bash wrapper at `/etc/profiles/per-user/<user>/bin/google-chrome`). **Fix: pass the wrapper as `executablePath`** — it forwards args fine.
- Flag matrix results (headless, secure-context probe on http://localhost:5173):
  - default → null adapter
  - `--enable-unsafe-webgpu --enable-features=Vulkan` → **SwiftShader** (CPU!) — looks alive, poisons perf data
  - `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan` → **amd / gcn-5 (RADV)** ✓ (same with `--use-gl=angle` added)
  - adding `VulkanFromANGLE,DefaultANGLEVulkan` features → null adapter (breaks it)
  - `--disable-vulkan-surface` → SwiftShader; `--enable-gpu` → null
  - headed under Wayland (`--ozone-platform=wayland`) + unsafe+Vulkan → amd/gcn-5 (works without the angle flag when headed)
- **Every probe must assert `adapter.info.architecture !== 'swiftshader'`** before trusting any measurement.
- `tools/launch.ts` knows none of this (Mac-era recipes, no `executablePath` support) and `.cache/webgpu-flags.json` may hold a stale Mac recipe. **Addressed same session: `tools/launch-gpu.ts`** — probes system-browser executablePath recipes (CHROME_BIN override), asserts the adapter is a real GPU, caches to `.cache/webgpu-gpu-recipe.json`, returns adapter info for printing next to measurements. New tools (`probe-ridehud.ts`, `perf-baseline.ts`) use it; shoot.ts/compare.ts still ride old launch.ts — migrate them when next touched. Interactive equivalent: `Justfile` `run-nixos`.
