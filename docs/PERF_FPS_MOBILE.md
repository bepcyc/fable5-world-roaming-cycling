# Mobile FPS optimization — findings (Pixel 10 Pro / Imagination TBDR)

**⚠️ SUPERSEDED ON RANKING (2026-07-15) — see
[`docs/PERF_MOBILE_KILLERS.md`](PERF_MOBILE_KILLERS.md).** This document is
an *estimate dossier* — three agents reasoning from code, none of them ran
on a device. A live measurement on the owner's tablet then contradicted
three of its four checkable predictions: particles predicted +8–25%,
measured 0.4%; froxels predicted +10–25%, measured 3.1%; shadows ranked
4th of 12, measured as the #1 GPU cost; only the grass-cull ranking (#1)
held up. It also never addressed the ~55–75% of the frame that measurement
showed is not GPU work at all. Keep this file for its file:line map
references on vegetation/froxel/post code — **do not use it for priority.**

**Date:** 2026-07-14 · **Target:** Google Pixel 10 Pro, GPU = Imagination img-tec
D-series (Tensor G5), a **tile-based deferred renderer (TBDR)**. Currently runs
the offline APK at `preset=min` + `dpr=0.6`, renders but is slow with heavy
motion blur.

This document collects **three independent investigations** commissioned in
parallel (owner request: "что соптимизировать чтобы ускорить fps без сильной
потери в картинке"):

1. **deep-research** — 104-agent web sweep, adversarially verified, cited.
2. **codex `gpt-5.6-sol` (medium)** — read the actual `src/` rendering code.
3. **agy Gemini 3.1 Pro (High)** — independently read the same code.

Nothing here is implemented yet — this is the findings dossier only.

---

## TL;DR — the converged diagnosis (all three agree)

**`dpr=0.6` did not fix FPS because the bottleneck is NOT pixel/fragment
fill — it is per-frame GPU *compute* + memory *bandwidth* on the TBDR.**

- The `min` preset only shrinks **world-gen** cost (`heightRes 1024`,
  `simRes 512`, `erosionIters 150`, `tileVerts 33` — that is the *entire*
  preset, `WorldConst.ts:57`). It leaves **steady-state per-frame** work —
  froxels, grass cull, shadows, clouds, GTAO, particles, GI, post — essentially
  untouched. So lowering DPR (a fragment-cost lever) barely moves a
  compute/bandwidth-bound frame. (codex exec-finding; agy diagnosis;
  deep-research finding #4)
- The single biggest per-frame hog: the **grass cull scans a 3072² grid =
  9.44 M compute threads every frame** (`GroundRing.ts:97`). Plus froxels
  921.6 k×2, particles 131 k, caustics 262 k — **~11.6 M compute threads/frame**
  writing to external DDR, bypassing the tile cache. (codex #2, agy P1)
- TBDR-specific: **transparent/alpha-blended geometry disables the hardware
  Hidden-Surface-Removal**, causing overdraw — confirmed by Imagination's OWN
  PowerVR docs (deep-research #7). Particles (131 k double-sided quads,
  `depthWrite=false`, no frustum cull) are the worst case. (codex #9, agy P2.2)

**First experiment to run on the phone** (merged recommendation):
`dynamic DPR ~0.50 · GRASS_GRID 1536 · froxels 96×54×32 at half cadence ·
2×1024² shadow cascades · clouds 0.375 scale/24 steps · particles ≤32k`,
then measure. Expected: the compute cuts (grass + froxels + particles) deliver
the bulk of the win, DPR is secondary.

---

## Built-in profiling toolkit — USE THIS FIRST (verified present in code)

Before changing anything, attribute the cost on-device with flags **already in
the codebase**. Append to the loopback URL (`127.0.0.1:47862/?preset=min&dpr=0.6&...`):

| Flag | Effect | Tests the hypothesis |
|---|---|---|
| `?ablate=ao` | disables GTAO (`PostStack.ts:75`) | agy: **motion blur = GTAO temporal history** at 0.3× native. If blur vanishes → confirmed. |
| `?ablate=clouds` | disables cloud march | cloud raymarch cost (32 steps) |
| `?ablate=bounce` | disables SS bounce | codex #5 "bounce removal barely visible" |
| `?ablate=taa,bloom` | disables TAA / bloom | post-stack cost |
| `?prepass=0` | disables `depthPrepassTwin` for grass/veg (`GroundRing.ts:986`, `Forests.ts:358`) | agy P2: **depth prepass HURTS on TBDR**. If FPS *rises* with `prepass=0` → agy is right, codex is wrong. |

`?ablate` combines: `?ablate=ao,bounce,clouds`. This is the cheapest possible
first step — no code change, and it settles the two open disagreements below.

---

## Prioritized action list (merged, cross-referenced)

Gains are rough, **not additive**, for a GPU-bound Pixel 10 Pro. "Src" columns
cite where each source landed. All file:line anchors verified against the tree.

| # | Change | file:line | Gain | Quality cost | Difficulty | Sources |
|---|---|---|---|---|---|---|
| **1** | **Grass cull grid 3072²→1536²** (75% fewer threads) + amortize (only re-cull on >0.5 m camera move / round-robin near-mid-far over 3 frames). Keep nearest 20–30 m density, thin outside. | `GroundRing.ts:97,577,1244` | **+15–40%** | Minor (width-compensated clumps) | Moderate (preset) / Hard (persistent tiled lists) | codex #2, agy P1.1 |
| **2** | **Froxel grid 160×90×64→96×54×32** (or 80×45×32; ~82–87% fewer cells) + temporal reproject prev volume + skip scatter/integ entirely when clear-day density≈0. | `Froxels.ts:62,204,239` | **+10–25%** | Minor (trilinear + jitter + temporal hides it) | Moderate | codex #3, agy P1.2 |
| **3** | **Particles 131 072→32 768** on min, simulate every 2nd frame, add frustum/screen compaction, dither-alpha-test instead of blend for pollen/snow. | `Particles.ts:54,214,346` | **+8–25%** (weather/forest) | Minor (bigger motes, clustered) | Moderate | codex #9, agy P1.3 |
| **4** | **Shadow cascades 4→2** (near 0–70 m, mid 70–350 m) + stagger far cascade (every 2–4 frames / on sun-move) + cap map ≤1024² + stop veg shadow-casting at ~500–700 m (was 1100 m) + texel snapping. | `Forests.ts:121` (`CASCADES=4`), `Engine.ts:152` | **+10–30%** | Minor–noticeable (distant moving shadows; contact shadows cover) | Moderate | codex #4, agy P4 |
| **5** | **Decouple cloud res from AO** in the merged half-res MRT: clouds 0.33–0.375 scale + 20–24 march steps + 2 sun taps (was 32+3); keep AO at 0.5; drop/halve SS-bounce taps. | `HalfResMrt.ts:53`, `Clouds.ts:303`, `PostStack.ts:146` | **+10–25%** | Minor (temporal accum hides clouds) | Moderate | codex #5, agy P3.2 |
| **6** | **Motion-blur fix:** on min, bypass GTAO `HistoryNode` temporal reproject + cut spatial steps 4→2 (or `ablate=ao`). Root cause: simRes 0.5 × dpr 0.6 = **0.3× native**; temporal reproject can't lock at low fps → whole-scene smear. | `Gtao.ts`, `HalfResMrt.ts` | clarity++ (+4–8 ms) | **Removes** the blur the owner sees | Moderate | **agy P3.1** (unique) |
| **7** | **Dynamic render-resolution policy** ~0.50 (range 0.42–0.55) driven by P95 frame time, **with hysteresis** (dead-band, else it oscillates), + TAAU + sharpen; keep DOM UI at native. | `Engine.ts:146` | **+15–35%** *iff* fill-bound (partial here) | Minor–noticeable <0.5 (TAAU hides) | Moderate | codex #1, agy P5, dr #3/#4/#5 |
| **8** | **Half-res the remaining full-res multi-tap post**: contact shadows (12→6-8 steps into AO path), motion blur (half-res + depth/vel bilateral upsample); keep TAA-resolve + tonemap at present res. | `PostStack.ts:400,527` | **+8–18%** | Minor | Moderate | codex #6 |
| **9** | **Cheaper mobile terrain shader variant**: bake the two 3×3 Worley gravel layers (18 hashed evals) → one tiled texture; fade sub-cm detail sooner; split road detail into a decal/branch instead of computing it for all terrain pixels. | `TerrainMaterial.ts:113,371,533` | **+8–20%** (terrain views) | Minor at dpr≤0.6 (subpixel detail) | Moderate–hard | codex #7 |
| **10** | **Probe GI event-driven**: 3072→512–1024 probes/frame, update only on sun/weather/canopy change after boot convergence (was every frame: 3072 probes × 16 dirs × 16 march). | `ProbeGI.ts:55,292,328` | **+5–15%** | None–minor (static world) | Trivial–moderate | codex #8 |
| **11** | **Amortize periodic LUTs**: cloud-shadow 768²×20 steps every 2.5 s → 384–512²×10-12 every 8–10 s (or one stripe/frame double-buffered); quantize sky-view LUT to sun-angle threshold. | `Clouds.ts:171`, `Atmosphere.ts:277` | +0–5% avg, big p95/hitch win | Minor | Moderate | codex #10, agy — |
| **12** | **TBDR attachment hygiene**: prefer R8/RG8/RGBA8 over RGBA16F where precision allows; `storeOp:'discard'` on transient attachments; avoid `loadOp:'load'` when a pass overwrites every pixel; minimize per-frame storage-texture writes. | `HalfResMrt.ts:60`, `Froxels.ts:199`, `ProbeGI.ts:295` | +2–8% + less thermal | None (validate banding) | Hard (needs backend load/store control) | codex #11, dr #6 |

**Do NOT** spend the first cycle amortizing erosion/talus/scatter — the compute
scheduling audit confirms those are **load/bake-only**, not per-frame; they hit
startup time & thermal, not steady-state FPS. (codex audit)

---

## Open disagreements — settle with the flags above

### A. Depth prepass on TBDR — codex vs agy (RESOLVE with `?prepass=0`)
- **agy P2 (well-grounded):** `depthPrepassTwin` HELPS immediate-mode desktop
  GPUs (early-Z) but HURTS a TBDR — it double-processes every vertex through
  binning, and the hardware HSR already does deferred visibility. Disable on
  mobile. This matches Arm/Imagination general guidance.
- **codex #9:** called the existing depth prepasses "helpful" (nuance: alpha-
  test foliage disables HSR's benefit, so a *cheap* prepass can still help).
- **Test:** run `&prepass=0` on the phone. If FPS rises → agy wins, wire it to
  the mobile preset. Cheap, decisive, no code change to try.

### B. DPR direction — codex vs agy
- **codex #1:** push DPR *down* to ~0.50 + TAAU to hide it.
- **agy P5:** push DPR back *up* toward 1.0 for a crisp UI, and instead scale
  only the **3D scene render target** (decouple UI from scene), driven by P95.
- **deep-research #4 reconciles both:** DPR is only a *partial* lever here (the
  bottleneck isn't fill), so neither pure-DPR stance wins alone — the compute
  passes (#1–#5) must be cut regardless. Both agree on the real point: **UI /
  post should be decoupled from the 3D-scene scale**, which the code does NOT
  do today (`Engine.ts:146` — scene, TRAA, blur, bloom, grade, half-res MRT all
  derive from one drawing-buffer resolution).

---

## deep-research unique contributions (cited, verified)

- **TAAU is already in the stack — no FSR/DLSS port needed.** three@0.184.0
  ships `taau` at `node_modules/three/examples/jsm/tsl/display/TAAUNode.js`
  (835 lines, `three/webgpu`+`three/tsl` path). Does AA **and** upscaling in one
  pass; JSDoc: "an alternative to FSR2/3." This is the tool #7 assumes for
  hiding the resolution drop. **Cost:** amplifies TAA blur/flicker (maintainer
  Mugen87, three.js #33359); **MSAA must be off** while TAAU is active.
  Sources: threejs.org/docs/pages/TAAUNode.html; three.js #33359.
- **TBDR bandwidth, quantified:** keeping a fat (16 B/px) intermediate on-chip
  measured **~40% faster on iPhone XS** (gpuweb #435, Apple's Myles Maxfield);
  thin (1 B/px) buffers showed no gain → payoff scales with attachment fatness
  (relevant to the RGBA16F half-res MRT). **Limitation:** WebGPU exposes NO
  Vulkan subpasses / render-pass merging, so the classic on-chip G-buffer merge
  is not directly available — the actionable levers are `storeOp:'discard'`,
  resolution scale, and fewer passes. Source: Vulkan tile-based best-practices;
  gpuweb #435.
- **Transparent veg kills HSR — Imagination's own docs:** "enabling alpha
  blending eliminates the benefits of deferred rendering… will likely result in
  overdraw… particularly if the application is already limited by rendering."
  Prefer alpha-test/alpha-to-coverage + aggressive LOD/impostor swaps + front-
  to-back opaque draw. Source: docs.imgtec.com PowerVR architecture.
- **Dynamic-res needs hysteresis:** a single-threshold FPS→DPR switcher
  oscillates (low fps → drop res → fps rises → restore → drop → flip forever);
  use a dead-band / asymmetric up-down thresholds / multi-frame confirmation.
  The memory-aliasing form of DRR is unavailable in WebGPU (no explicit memory
  mgmt; gpuweb #2379). Source: three.js discourse; gpuweb #2379.
- **WebGPURenderer per-draw overhead:** UBO/bind-group system is ~4× slower
  than WebGL for many non-instanced items (20 k cubes: ~60→~15 fps, three.js
  #30560). Secondary here (we're compute-bound) but: keep everything instanced/
  batched; extend batching to any un-instanced per-tile meshes. Source: three.js
  discourse #87939, #30560.

---

## Accuracy caveats (honesty cross-check)

- **agy invented preset fields.** Its `WorldConst.ts` quotes/diff show
  `erosionIters: 6`, `shadowMapRes: 1024`, `lodDistance: [...]`,
  `grassGridRes`, `froxelDims` — **none of these exist**. The real `min` preset
  is *only* `{ heightRes: 1024, simRes: 512, erosionIters: 150, tileVerts: 33 }`
  (`WorldConst.ts:57`). agy's **architectural reasoning is sound and its thread-
  count math is right** (GRASS_GRID 3072, froxels 160×90×64, particles 131072,
  CASCADES 4 all verified), but treat its exact code quotes as approximate.
- **codex was more code-accurate:** it correctly stated `erosionIters 150` and
  was explicit that shadow-map resolution "is not exposed in the user-permitted
  files, so it cannot be reported reliably" rather than guessing.
- deep-research had 2 fetch failures (digitalrune, developer.arm.com) and found
  **no verified external evidence** for the compute-pass-reduction angle — that
  gap is exactly what codex+agy filled by reading our code.

---

## OFFICIAL BASELINE — phase 1 (2026-07-15, branch `perf-mobile-fps`)

Measured with `tools/perf-mobile.ts` at the campaign's ONE fixed spot. Every
later number in this campaign is compared against **this** row.

```
npx tsx tools/perf-mobile.ts --label baseline        # all params are defaults
# preset=min dpr=0.6 seed=1 T=14 cam=-870,182.7,862,1.69,0.1
# viewport 1000x448 CSS -> drawing buffer 600x269 ; 10 s warmup + 10 s measured
# adapter: amd / rdna-2 (headless Chrome, vsync disabled)
```

| metric | run1 | run2 | run3 | **median** | spread |
|---|---|---|---|---|---|
| avg fps | 45.75 | 45.74 | 44.09 | **45.74** | 3.6% |
| 1% low fps | 30.45 | 33.53 | 28.07 | **30.45** | 17.9% |
| p95 ms | 27.30 | 27.30 | 29.80 | **27.30** | 9.2% |
| **GPU total ms** | 2.65 | 2.48 | 2.49 | **2.49** | 6.5% |
| cpu.submit ms | 21.10 | 20.50 | 23.10 | **21.10** | 12.3% |
| drawCalls | 687 | 687 | 727 | — | 5.8% |

Median GPU passes (ms): `c.grassRingCull` **0.805**, `c.probeGather` 0.384,
`c.froxelScatter` 0.210, `r.shadow.c1` 0.157, `r.scene` 0.145, `r.half.mrt`
0.111. **Compute = 70% of all GPU time** — the dossier's compute-first
diagnosis (item #1, grass cull) is confirmed as the #1 pass on this box too.

### Gates (both must be quoted with every future measurement)

- **vsync gate: PASSED.** avg 45.7 fps with std 3.2 ms — the meter is live, not
  pinned to the 60 Hz refresh. The harness passes `--disable-gpu-vsync
  --disable-frame-rate-limit --disable-features=CalculateNativeWinOcclusion`.
- **bound gate: CPU-BOUND — fps is NOT this campaign's metric on this box.**
  GPU is only 2.49 ms of a 21.9 ms frame (11% utilisation); `cpu.submit` is
  21 ms (~97% of the frame). GPU cuts therefore cannot move avg fps here.
  **Judge every optimization by per-pass GPU ms**; treat avg fps as a
  regression guard only. The Pixel's GPU is ~10-20x slower, so the phone IS
  GPU-bound where this box is not.

### Noise floor — how big a win must be to be real

| metric | noise floor (3 runs) |
|---|---|
| avg fps | 3.6% |
| **GPU total ms** | **6.5%** |
| `c.grassRingCull` | 7.9% |
| 1% low fps | 17.9% (noisiest — do not judge on it) |

**Rule: on the primary metric (GPU ms), treat anything under ~8% as noise;
under ~12% for a single pair of runs.** The dossier's item #1 (grass grid
3072->1536) should move `c.grassRingCull` by 50-75% — far above this floor.

**Streaming-convergence confound (important):** the spread is NOT pure jitter.
run3 reached **727 draws / 14966026 tris** (the converged value) while run1/run2
sat at **687 / 14677142** — vegetation streaming had not finished at a 10 s
warmup. run3's extra geometry is exactly why it read 44.09 fps and 23.1 ms
cpu.submit. **Always compare `drawCalls` between runs before believing a
delta**; if they differ, re-run or raise `--warmup`.

---

## Appendix — where the full source reports live (scratchpad, this session)

- codex full report: `scratchpad/codex-report.md` (11 items + cadence audit)
- agy full report: `scratchpad/agy-fps-out2.txt` (5 priorities + diff)
- deep-research findings: `scratchpad/deepresearch-report.md` (8 cited findings)
