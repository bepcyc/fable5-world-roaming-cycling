# PERF BASELINE — dev box, session 0 (2026-07-02)

Anchor for every future performance claim on this machine. Owner directive of the same day: **fps on this box is the LAST priority** — this file exists for honest tracking, not as a target.

## Machine

| | |
|---|---|
| CPU / GPU | AMD Ryzen 5 PRO 4650G, iGPU Radeon **Vega 7** (Renoir, PCI 1002:1636) |
| Driver / OS | RADV (Mesa Vulkan), NixOS 26.05, kernel 6.12.92, Wayland |
| RAM / display | 64 GB / 3440×1440 |
| Browser | System Google Chrome 149.0.7827.53 via Playwright `executablePath` |
| WebGPU adapter | `amd / gcn-5` with `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan` (see `docs/notes/nixos-webgpu-launch-recipe.md`; without `--use-angle=vulkan` you silently get SwiftShader) |
| Upstream reference | M1 Max 32-core @2592×1676: 23–40 fps at the same bookmarks (STATUS.md Phase-7 cooled baseline) — roughly an order of magnitude faster |

## Method

Headless Chrome (recipe above), **one boot**, viewport 3440×1440 @deviceScaleFactor 1, `?scene=world&seed=1&freeze=0` (live world motion), `?shot=1` boot then bookmark jumps by key; `__laas.settle(120)` after each jump; then an **in-page rAF sampler** (string-evaluate — see `docs/notes/one-boot-many-probes.md`) collecting raw frame-to-frame times for 30 s (45 s moving). avg fps = 1000/mean; **1% low = 1000/mean(slowest 1% of frames)**. Engine's own stats (`__laas.stats`) provide triangles for context; its fps field is EMA-only and was not used.

Caveats, recorded honestly:
- Headless rAF pacing ≠ interactive windowed session (STATUS.md gotcha) — treat as comparable-between-sessions, not as user experience.
- Adapter identity was verified for these exact flags in a separate probe the same hour, but this run did not re-assert it in-process; throughput (≈50–85 M tris/s at 4 fps) is consistent with real Vega 7, impossible for SwiftShader. Future suites: assert `adapter.info` in-run.
- 1080p and `?preset=low` passes were **deliberately dropped** after the owner demoted fps priority mid-session; add them only if a perf question actually arises.
- ~100–170 frames per 30 s sample at these frame times — the 1% low averages 1–2 frames; direction-of-truth, not statistics.

## Results — native 3440×1440, high preset, seed 1

| Sample | avg fps | 1% low | p95 frame | triangles |
|---|---|---|---|---|
| bm1 (alpine wall) | **4.7** | 4.0 | 233 ms | 20.95 M |
| bm2 (dawn lake) | **4.1** | 3.5 | 267 ms | 12.74 M |
| bm3 | **3.3** | 2.9 | 333 ms | 13.65 M |
| bm4 (meadow) | **4.1** | 3.6 | 267 ms | 12.59 M |
| bm7 (forest interior) | **4.5** | 4.0 | 250 ms | 12.56 M |
| flythrough, moving (~65 m/s — NOT bike speed, see `docs/notes/flythrough-is-not-bike-speed.md`) | **3.9** | 3.2 | 283 ms | 14.85 M |

Boot-to-ready (world generation): **46–63 s** across four boots this session (M1 budget was ≤15 s).

Secondary datapoint: fps chip read ~8 fps at 1600×900 during flythrough (HUD-verify run) — scaling with resolution behaves as expected.

## Reading

The world renders correctly and looks right on RADV (screenshot-verified), at ~4 fps native. This is the honest floor of this machine against the untouched LAAS bar; per the owner directive, no session time goes into raising it. Perf work, when it ever happens, targets the real play machine (OPEN-QUESTIONS Q1) in the Phase-3 high-speed pass (`docs/ROADMAP.md` M3.3). Raw data: session-0 scratchpad `baseline.json` (numbers reproduced above in full).

**Reproduce:** dev server on :5173, then `npx tsx tools/perf-baseline.ts` (defaults = this exact suite: native 3440×1440, bookmarks 1,2,3,4,7, 30 s each + 45 s flythrough; adapter asserted in-run and written to the JSON output).
