# Mobile perf killers — the practical, code-grounded autopsy

**Date:** 2026-07-15 · **Branch:** `perf-mobile-fps` · **Supersedes ranking in
[`docs/PERF_FPS_MOBILE.md`](PERF_FPS_MOBILE.md)** (that document is an
*estimate dossier* from three agents that never touched the device; every
estimate in it that could be checked against a live measurement was wrong in
magnitude or direction — see "Where the old dossier was wrong" below. Keep it
for its file:line citations, not its priority order.)

This document exists because the owner correctly called out the previous
pass as theory: *"ты не практик, который знает весь код и понимает, что
просаживает производительность на таблетке... нет ли у нас слонов в
посудной лавке"*. This is the practitioner's answer — read from the actual
engine, checked against a live device, with every number labeled MEASURED,
INFERRED (derived from reading code, not captured), or NOT YET MEASURED.

---

## TL;DR — ranked real killers

| # | Killer | Measured cost | file:line | Fix |
|---|---|---|---|
| **1** | **The non-GPU residual.** Something outside timed GPU passes AND outside the measured `cpu.update`/`cpu.submit` JS spans eats most of the frame. | 35.6 ms / 55% of frame (single snapshot) — **or** 98–176 ms / 65–75% of frame (rigorous 10 s window average, see below). Two measurements, same device, same day, disagree on magnitude but agree it's the largest single thing in the frame. | n/a — not yet isolated to a line of code | **Not diagnosable from these JSON files alone.** Needs an on-device Perfetto trace (`chrome://tracing` over the same adb/CDP session) to see what's actually happening between `requestAnimationFrame` calls. This is the #1 next action, ahead of any code change. |
| **2** | **Shadows** — 2 CSM cascades rendered this frame at a flat 2048² regardless of preset, plus a confirmed periodic 4-cascade collision every 6 frames. | 8.32 ms (c0+c2, single snapshot) · confirmed present across all 4 tablet captures, 3.7–8.3 ms depending which cascades landed in the window | `src/render/ShadowSetup.ts:121-125` (hardcoded `2048,2048`), `src/render/CsmCached.ts:29-30` (`PERIODS=[1,2,3,6]`, `PHASES=[0,1,2,5]`) | Scale shadow-map resolution by preset. Fix the phase collision (verified by hand: `(frameNo+PHASES[i])%PERIODS[i]===0` is simultaneously true for c0,c1,c2,c3 at every `frameNo ≡ 1 (mod 6)` — this is arithmetic, not a guess, see below). |
| **3** | **`c.grassRingCull`** — full 3072² = 9.44M-thread grid classification, every frame, no dirty tracking. | 6.68–11.12 ms across 4 independent captures — the single most expensive named GPU pass in every one of them, 59% of all compute in the original snapshot | `src/vegetation/GroundRing.ts:97` (`GRASS_GRID=3072`), `:1244-1256` (`update()` calls all 5 kernels unconditionally every frame, no camera-delta or dirty gate) | Persist classification + dirty-strip streaming instead of full-grid rescan (see "Dossier confirmed" below — this is the one prediction that held up). |
| **4** | **`r.scene`** — the actual forward scene draw. | 4.19–6.95 ms | n/a (this is the real cost of the visible geometry — not a bug, a baseline) | Lower via draw-call/geometry reduction (see #5), not a target on its own. |
| **5** | **Compute-dispatch fragmentation** — 18 separate `renderer.compute()` calls per normal frame, each opening its own `GPUCommandEncoder` and ending in its own `device.queue.submit()`. | Mechanism confirmed by reading three.js source (see below); **its own contribution to frame time is NOT YET MEASURED** — no A/B has been run | `src/vegetation/Forests.ts:960` (6 kernels, `for (const k of this.kernels) renderer.compute(k)`), `src/vegetation/GroundRing.ts:1255` (5 kernels, same pattern), `src/gpu/passes/ProbeGI.ts:320-321,331-332` (2), `src/gpu/passes/Froxels.ts:247-248` (2), `src/render/Caustics.ts:172` (1), `src/gpu/passes/Particles.ts:361` (1), `src/render/PostStack.ts:705` (1 autoExposure) = 6+5+2+2+1+1+1 = **18, verified by grep, exact match to the report's arithmetic** | Batch same-dependency-tier kernels into one `renderer.compute([k1,k2,...])` call (three.js already supports array input — confirmed in `Renderer.js`). Cheapest, same-day-doable experiment; not yet run. |
| **6** | froxels (scatter+integrate) | 1.97–3.03 ms | `src/gpu/passes/Froxels.ts:243-249` | Old dossier predicted +10–25% here. Measured: 3%. **Not a mobile target.** |
| **7** | probe GI (gather+publish) | 1.57–2.47 ms | `src/gpu/passes/ProbeGI.ts:328-334` | Minor. Event-driven refresh is plausible but low-priority given #1–#3 dwarf it. |
| — | particles | 0.26–0.42 ms | `src/gpu/passes/Particles.ts` | Old dossier predicted +8–25% here. Measured: 0.4%. **Free. Do not touch.** |

---

## THE MEASURED FRAME

Primary source: [`shots/wip/tablet-frame-profile.json`](../shots/wip/tablet-frame-profile.json)
— a live frame off the owner's Galaxy Tab S8 Ultra (Adreno 730 / SD 8 Gen 1,
Android 16), captured over CDP, `preset=min`, `dpr=0.6`, canvas 888×554
(0.49 Mp).

```
frameMs 64.2   fps 4   drawCalls 563

render total  16.646 ms
compute total 11.928 ms
GPU sum       28.574 ms  (45%)
NON-GPU       35.630 ms  (55%)  <- biggest single item in the frame

r.shadow.c0        4.325
r.shadow.c2        3.998   } shadowTotal 8.323  <- #1 GPU pass
c.grassRingCull     7.078  <- 59% of ALL compute
c.debrisRingCull    0.262
c.farTuftCull       0.328
r.scene             4.260
c.probeGather       1.507
c.froxelScatter     1.049
c.froxelIntegrate   0.918
r.half.mrt          1.442
r.rt#16(888x554)    1.114
r.TRAANode.resolve  0.655
c.particles         0.262
c.caustics          0.066
_bloomAllPasses     0.524
```

**Headline: at this single measured frame, 55% of the frame is not GPU at
all.** Zeroing every GPU pass in that list still leaves a 35.6 ms frame ≈
28 fps.

### A second, more rigorous look — and a bigger residual

The snapshot above is a single live frame captured with debug panels open
and the camera off the campaign's fixed measurement spot (per its own
`_caveat`). The same day, the same device also ran the campaign's real
harness, [`tools/perf-tablet.ts`](../tools/perf-tablet.ts) — a 10-second
window average at the fixed spot, sampling every frame (not a snapshot) —
and it captured two counters the snapshot did not:
`cpu.updateMs100`/`cpu.submitMs100` from `Engine.ts:235-236`, which bracket
the **actual synchronous wall-clock JS time** of the update loop and of the
`renderer.render()`/`post.render()` call (which does the full three.js
render-graph traversal, node update, and command encoding for every draw
and compute dispatch, all synchronously on the main thread before the GPU
ever sees it).

[`shots/wip/perf-tablet-r1.json`](../shots/wip/perf-tablet-r1.json) and
[`shots/wip/perf-tablet-r2.json`](../shots/wip/perf-tablet-r2.json):

| | r1 | r2 |
|---|---|---|
| avg fps / frame | 6.62 fps / **151.1 ms** | 4.28 fps / **233.8 ms** |
| GPU total (timed passes) | 23.69 ms (16%) | 38.73 ms (17%) |
| `cpu.updateMs100` | 3.80 ms | 5.37 ms |
| **`cpu.submitMs100`** (measured JS wall time of render/encode) | **49.44 ms** | **52.29 ms** |
| cpu total (update+submit) | 53.24 ms | 57.66 ms |
| **`unexplainedMs`** (`avgMs − max(gpu, cpu)`) | **97.83 ms (65%)** | **176.14 ms (75%)** |
| harness verdict | `bound: "UNEXPLAINED"` | `bound: "UNEXPLAINED"` |

This is a real, measured finding, not an estimate: **`cpu.submitMs100` alone
(49–52 ms) is bigger than all timed GPU work combined (24–39 ms).** This
directly confirms the mechanism Codex's report proposed (per-object CPU
encode cost, command-encoder/submit fragmentation) — not as an inference
this time, but as a captured wall-clock number, on the actual device.

**But it does not close the case.** Even generously crediting the frame with
the *maximum* of GPU-total and CPU-total (i.e. assuming perfect overlap,
which is optimistic), **65–75% of the frame is still `UNEXPLAINED`** by
anything currently instrumented. That gap is bigger, not smaller, than the
35.6 ms the single snapshot showed — the rigorous window average makes the
non-GPU problem look worse, not better. Best-supported candidates for what
lives in that gap (none of them measured yet): GPU queue backpressure from
an already-saturated Adreno queue (rAF is naturally throttled by the
browser when submitted work outruns the GPU), the per-frame timestamp-query
resolve + `mapAsync` round-trip (`Engine.ts:264-286`, two more submissions
every frame purely for profiling), compositor/present time, and thermal
downclock (the harness's own thermal probe read stable 28.5–28.7°C across
these three runs, so thermal throttling is *not* the explanation here).

**Do not treat this document's ranking of #1 as "solved."** The size of
the problem is measured. The cause is not.

---

## WHERE THE OLD DOSSIER (`docs/PERF_FPS_MOBILE.md`) WAS WRONG

That document ranked 12 optimization targets by three agents' *estimates*,
none of which had run on the device. Measurement against it:

| Dossier item | Dossier's estimate | Measured | Verdict |
|---|---|---|---|
| #3 Particles (131072→32768) | **+8–25%** win | **0.4%** of frame | Estimate was 20–60× too optimistic. Free already — not a target. |
| #2 Froxels (160×90×64→96×54×32) | **+10–25%** win | **3.1%** of frame | Over-rated by ~5–8×. |
| #4 Shadow cascades (4→2, ranked **4th** of 12) | mid-priority | **#1 measured GPU cost**, 13% of the whole frame | Rank was backwards. |
| #1 Grass cull grid (ranked **1st**) | **+15–40%** win | **7.08 ms, 59% of all compute** — the largest single named pass every time it was measured | **The one prediction that held up.** |
| *(nothing)* | — | **55–75% of the frame is not GPU at all** | The dossier's entire framework — 12 GPU-only line items — never addressed the biggest thing in the frame. Zero of its 12 items would have moved the residual. |

Read that document for its file:line anchors on the vegetation/froxel/post
code — those are still accurate map references. **Do not use it for
priority.** Its authors never had a device measurement to check against;
this document exists because that check was finally run and contradicted
it on three of four checkable predictions.

---

## THE PRESETS ARE FAKE

`qualityConfig()` — the entire `min`/`low`/`high`/`ultra` preset system —
is exactly this (verified, `src/world/WorldConst.ts:48-67`):

```ts
export interface QualityConfig {
  heightRes: number;
  simRes: number;
  erosionIters: number;
  tileVerts: number; // vertices per tile edge
}
```

Four fields. All four are **world-generation** parameters — they affect the
one-time terrain bake (height texture resolution, erosion simulation
resolution/iterations, tile mesh density), not anything that runs per
frame. `min` is `{1024, 512, 150, 33}`; `ultra` is `{4096, 2048, 900, 81}`.

None of the measured killers above are touched by this switch:

- `GRASS_GRID = 3072` (`GroundRing.ts:97`) — **same constant on every preset.**
- Shadow map size `2048×2048` (`ShadowSetup.ts:124`) — **hardcoded, no preset input.**
- `CASCADES = 4`, froxel grid `160×90×64`, `PARTICLE_COUNT = 131072`,
  probe count 3072×16 dirs×16 steps — **all hardcoded constants**, confirmed
  present in `Forests.ts`, `Froxels.ts`, `Particles.ts`, `ProbeGI.ts`.

This is exactly why `min` cannot get fast (it pays the full steady-state
cost of `ultra`'s shadow/grass/froxel/GI/particle work, just on a smaller,
cheaper-to-bake terrain) **and** why `ultra` cannot get richer (there is no
lever above the current hardcoded constants to push toward the 50 fps on
an RTX 5090 goalpost — turning the preset dial up only makes the world-gen
bake bigger, which nobody will notice at 50 fps on a desktop GPU).

---

## THE GOALPOSTS vs REALITY

Owner's two stated goalposts (2026-07-15, verbatim):
> "наш режим ультра должен давать такую запредельную графику, что rtx 5090
> выдаст с трудом 50 кадров."
> "цель снизу - на телефоне давать около 30 кадров на минималках, но чтобы
> было играбельно."

**Floor (min, phone, 30 fps target):** The measurement device (Galaxy Tab
S8 Ultra, Adreno 730) is described in this campaign as **faster** than the
owner's actual phone target. It measures 4.3–6.6 fps at `preset=min,
dpr=0.6`, 0.4–0.49 Mp — already 5–7× short of 30 fps, on hardware better
than the floor target. The old dossier's own honest arithmetic (using the
single-snapshot numbers): even *deleting every GPU pass* still leaves a
28 fps ceiling, because the residual alone is 35.6 ms. Using the more
rigorous window-average data instead, the ceiling is worse: the residual
there is 98–176 ms, meaning even perfect GPU (0 ms) plus the *measured*
CPU update+submit (53–58 ms) would still land at **106–182 ms/frame ≈
5.5–9.4 fps** — nowhere near 30, because two-thirds to three-quarters of
the frame is currently unattributed to anything.

**Is 30 fps reachable?** Not with the current architecture as measured
today, and not by tuning `qualityConfig` (it cannot touch any of this).
It becomes *plausible* only after, in order:
1. The residual is actually diagnosed (a Perfetto trace, not another
   estimate) — this is the load-bearing unknown; if it turns out to be
   irreducible GPU device execution time rather than CPU/queue overhead,
   the ceiling changes entirely and different fixes are needed.
2. Shadows and grass (the two confirmed, measured GPU elephants) are cut
   structurally — not by lowering a slider that doesn't exist for them,
   but by scaling shadow-map resolution/cascade count by preset and
   replacing the full-grid grass rescan with dirty/persistent streaming.
3. The 18-dispatch/500+-draw command-submission load is reduced (batching,
   as proposed in killer #5), *if* the Perfetto trace confirms that's
   where the residual lives.

**Ceiling (ultra, RTX 5090, 50 fps target):** Out of scope for this
document — no desktop-ultra measurement was taken this session, and the
preset system as it exists today has no per-preset richness knobs to push
in that direction anyway (see "presets are fake" above). Whatever the
ultra path becomes, it needs its own knobs added to the same four-field
`QualityConfig`, which currently cannot express any of it.

---

## WHAT WAS VERIFIED vs INFERRED

Carried forward from the adversarial verification pass on the Codex report
that fed this document, plus independent spot-checks made while writing
this doc (marked *[this session]*).

**Verified this session, matches the report exactly:**
- The 18-`renderer.compute()`-call count. Grepped all call sites
  (`grep -rn "renderer.compute(" src/` → 12 call sites, two of which are
  loops over kernel arrays of length 6 and 5): 6 (Forests) + 5 (GroundRing)
  + 2 (ProbeGI) + 2 (Froxels) + 1 (Caustics) + 1 (Particles) + 1
  (PostStack autoExposure) = **18**, exact match.
- Every `renderer.compute()` and every render-context finish really does
  end in its own `device.queue.submit()`: confirmed directly in
  `node_modules/three/src/renderers/webgpu/WebGPUBackend.js` —
  `finishCompute()` at line 1514 (`this.device.queue.submit([groupData.cmdEncoderGPU.finish()])`)
  and the render-context finish at line 1094. This is three.js's actual
  shipped behavior in the pinned version, not a claim about WebGPU in
  general.
- `GRASS_GRID = 3072` and the unconditional `for (const k of this.kernels)
  renderer.compute(k)` loop with no dirty/camera-delta gate — both read
  directly, `GroundRing.ts:97` and `:1254-1256`.
- Shadow map hardcoded to `2048×2048` regardless of preset —
  `ShadowSetup.ts:124` (`sun.shadow.mapSize.set(2048, 2048)`).
- The CSM cache-cadence collision math. Worked it out by hand from the
  actual formula in `CsmCached.ts:141` (`scheduled = (frameNo +
  PHASES[i]) % PERIODS[i] === 0`) with `PERIODS=[1,2,3,6]`,
  `PHASES=[0,1,2,5]`: at every `frameNo ≡ 1 (mod 6)`, c0 (trivially, period
  1), c1 (frameNo odd), c2 (`frameNo%3==1`), and c3 (`frameNo%6==1` by
  definition) are all simultaneously scheduled. This is arithmetic on code
  that is actually in the tree, not a guess — **confirmed real.**
- `qualityConfig()` is exactly the 4-field struct claimed, nothing more —
  `WorldConst.ts:48-67`.
- The terrain shadow proxy really is a normal scene-graph `Mesh` with
  `colorWrite/depthWrite/depthTest` off but no dedicated shadow-only layer
  — `ShadowProxy.ts:50-65`, `mesh.frustumCulled = false`. Its own comment
  calls the main-pass cost "vertex-only," not zero.

**One claim in the Codex report corrected this session:**
- The report says the half-res MRT's AO attachment is `RGBA16F` "like
  everything else," contradicting an *earlier* verification pass that had
  flagged the opposite claim (that AO uses `R8`) as wrong. Re-checked
  directly: `HalfResEntry` in `HalfResMrt.ts:36` does define a `red?:
  boolean` flag that switches a texture to `RedFormat`/`UnsignedByteType`
  when set (`HalfResMrt.ts:70`, own doc comment: "r8unorm attachment (e.g.
  AO) instead of rgba16f"). Grepped `PostStack.ts` for every `red:` — zero
  hits. The `'ao'` entry (`PostStack.ts:174-183`, `gtaoLayer(...)`) never
  sets it. **So the correction is confirmed: AO is stored as the same
  default `HalfFloatType` RGBA as clouds and bounce, not R8.** This is a
  real, fixable bug (the R8 path exists in the type but was never wired
  up) — separate from anything on the measured critical path today, but
  worth a one-line fix (`red: true` on the ao entry) since it's free
  bandwidth.

**Inferred / hand-derived, NOT measured — do not treat as fact:**
- The "173 near-cascade / 133 far-cascade / 308 total shadow caster draws"
  table. No per-cascade draw-call counter exists anywhere in the codebase
  (`HUD.ts` only reads the aggregate `s.drawCalls`; `GpuProfiler.ts` has no
  cascade-scoped counter). This is Codex's own hand-count from reading the
  nested species×variant×ring×cascade loops in `Forests.ts` — plausible,
  but presented with a precision the code cannot actually provide anywhere
  in the running system.
- "The engine is likely making well over 25 queue submissions per frame" —
  self-hedged with "likely" in the source report; a reasonable extrapolation
  from the pass list, not a literal trace count.
- The specific claim that command-encoder/queue.submit fragmentation *is*
  the dominant cause of the residual. The mechanism is now confirmed real
  (see above) and `cpu.submitMs100` is confirmed large (49–52 ms,
  measured), but **no A/B has been run** — batching the Forests 6-kernel
  and GroundRing 5-kernel loops into single `renderer.compute([...])` calls
  and comparing `cpu.submitMs100` before/after is cheap, three.js already
  supports array input (`Array.isArray(computeNodes)` branch in
  `Renderer.js`), and it is the single most direct, cheapest experiment
  available — it has simply not been done yet.
- Everything under "additional mobile elephants" in the source report
  (attachment format waste beyond the AO case above, mip-regeneration
  cadence on caustics, water clipmap vertex cost away from visible water)
  is architecturally sound reasoning grounded in real code but was not
  independently timed this session.

**The single most important thing this document adds beyond the source
report:** the report's own proposed remedy for the unexplained gap —
"capture `cpu.updateMs100` and `cpu.submitMs100`, those counters were
omitted from the profile" — turns out to already exist in the repo
(`perf-tablet-r1.json`/`r2.json`, same device, same day). Reading them
proves the CPU-not-GPU direction hard, but also proves that reading them is
**not sufficient**: 65–75% of the frame remains `UNEXPLAINED` even with
both counters in hand. The report's proposed fix does not resolve its own
central question.

---

## NEXT ACTIONS, ordered by measured cost

1. **Diagnose the residual.** Capture a Perfetto/`chrome://tracing` trace
   over the same adb+CDP session `tools/perf-tablet.ts` already opens, for
   one measurement window. This is the only way to see what happens in the
   65–75% of the frame that neither GPU timestamps nor the `cpu.update`/
   `cpu.submit` brackets explain. Nothing else in this list can be sized
   correctly until this is known — do not spend a full engineering cycle
   on #4 (dispatch batching) on faith that it will pay into the residual;
   verify first.
2. **Run the cheap dispatch-batching A/B** (Forests' 6 kernels → 1 call,
   GroundRing's 5 kernels → 1 call) and record `cpu.submitMs100` and
   `frameMs` before/after with `tools/perf-tablet.ts`. Same-day-doable,
   directly tests killer #5, and is a precondition for trusting any theory
   about the residual's cause.
3. **Fix the shadow elephant** (measured #1 or #2 GPU pass in every
   capture): make shadow-map resolution and cascade count preset-driven
   (currently hardcoded `2048²`/4 cascades regardless of preset — wire
   into `QualityConfig`), and fix the confirmed 4-cascade collision
   (`PERIODS`/`PHASES` math above) so far cascades don't pile onto the
   same frame as the near one.
4. **Fix the grass elephant** (measured largest single compute kernel in
   every capture, and the one dossier prediction that held up): replace
   the unconditional full `3072²` rescan (`GroundRing.ts:1244-1256`) with
   persistent classification + dirty-strip updates gated on camera
   movement, as the source report's structural fix describes. Do not just
   shrink `GRASS_GRID` — that trades quality for the same architectural
   problem.
5. **Wire `QualityConfig` to touch steady-state cost, not just world-gen.**
   Add fields for shadow resolution/cascade count, grass grid/radius,
   froxel dimensions, probe count, particle count, and post-stack toggles
   — the presets cannot honestly claim to be "min"/"ultra" while none of
   these move.
6. **One-line fix, unrelated to the critical path but free:** set
   `red: true` on the `'ao'` `HalfResEntry` in `PostStack.ts` so AO
   actually gets the R8 storage path that already exists in `HalfResMrt.ts`
   but was never wired up.
7. **Do not spend a cycle on froxels, probe GI, or particles on mobile.**
   Measured at 3%, 2.4%, and 0.4% of the frame respectively — the old
   dossier's highest-confidence-sounding predictions for these (+10-25%,
   +8-25%) were the ones measurement disproved hardest.

---

## Sources

- [`shots/wip/tablet-frame-profile.json`](../shots/wip/tablet-frame-profile.json) — primary single-frame snapshot, ground truth for the TL;DR ranking.
- [`shots/wip/perf-tablet-r1.json`](../shots/wip/perf-tablet-r1.json), [`perf-tablet-r2.json`](../shots/wip/perf-tablet-r2.json), [`perf-tablet-val-r1.json`](../shots/wip/perf-tablet-val-r1.json) — rigorous 10 s window-average campaign runs, same device/day, source of the CPU-submit and unexplained-residual numbers.
- [`tools/perf-tablet.ts`](../tools/perf-tablet.ts) — the harness; read in full for what `cpu.updateMs100`/`cpu.submitMs100`/`unexplainedMs`/`bound` actually mean before trusting them.
- [`docs/PERF_FPS_MOBILE.md`](PERF_FPS_MOBILE.md) — superseded on ranking (see above); still useful for file:line map references on vegetation/froxel/post code.
- `src/core/Engine.ts:197-288` — the frame loop and the `cpu.update`/`cpu.submit` measurement points.
