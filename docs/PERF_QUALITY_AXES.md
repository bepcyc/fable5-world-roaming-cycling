# Quality axes campaign — measurements (Front P, 2026-07-16)

Branch: `perf-mobile-fps` (worktree `perf` front). Goal: min preset that
SWITCHES OFF (target ~x5-6 of the tablet's 6.4 fps), ultra that spends a
5090's budget, every heavy knob in Settings. All desktop numbers below are
the MOBILE profile of `tools/perf-mobile.ts` (preset=min dpr=0.6, 1000x448
CSS, fixed spot `-870,183.904,862,1.69,0.1`, seed 1, T 14) unless stated.

## Session methodology findings (paid for in blood, read first)

1. **The fixed spot moved.** The alpine terrain rework (65a1a68) raised the
   ground at the campaign spot; the walk clamp snaps eye y 182.7 -> 183.904.
   SPOT_CAM updated; numbers across that terrain change were never
   comparable anyway.
2. **Desktop GPU clock lottery (the tablet's twin).** amdgpu bounces sclk
   500..2575 MHz at this profile's ~11% GPU utilisation: three clean
   same-code runs read gpuTotal **3.57 / 3.45 / 1.07 ms** with IDENTICAL
   window-mean draws (608). A raw GPU-ms delta across runs is void unless
   the clock matched; `perf-mobile` now records `gpuClock` (4 Hz sysfs
   sampling, non-destructive) and `gpuWorkUnits = gpuTotalMs x meanMHz`.
3. **Foreign-agent contention inflates per-pass timestamps.** Pre-mutex
   runs (before ~13:20) ran against other agents' headless Chromes on the
   same GPU: `r.shadow.c0` swung 0.22..0.90 ms across conditions that do
   not touch shadows. The GPU mutex (owner order, ~13:20) serializes all
   GPU tools; **every pre-mutex number is stamped noisy** — the clean
   re-baseline is `cbase*`/`cbase2*`.
4. **Console draws are the end-of-window snapshot (Trap 4 lives).** The
   JSON `drawCalls` (window mean) is the comparable number; the console
   `draws N` line scatters 454..762 by cascade-refresh phase. Two false
   alarms in one session from reading the console line.

## DPR sweep (this box, pre-mutex — magnitudes noisy, structure held)

dpr 0.3 / 0.6 / 1.2 = 16x pixel range: gpuTotal 3.99 / 3.96 / 3.14 ms —
**pixel-proportional passes are pennies on this box** (rt#16 0.12->0.22,
half.mrt, TRAA.resolve); the dominant costs (shadow raster, probeGather
3072x16x16, froxelScatter 160x90x64, grassRingCull) are
resolution-independent. DPR is a real lever only for the phone's
fill/bandwidth floor (untested there — tablet unavailable this session),
not for this desktop's GPU ms.

## Wiring neutrality (proof the Quality config changed nothing by default)

`quality()` presets reproduce shipped values; wired build at preset=min:
draws mean 608 (454..762) and tris 14.19M IDENTICAL to base; per-pass
uniformly ~10-25% lower = contention departure, not a win (untouched passes
fell equally). tsc clean, boot-smoke min+high.

## White mid-band grass/flower carpet at preset=high — PRE-EXISTING

Same camera, three builds: my HEAD (with r8 AO), my HEAD minus r8, and
b556738 (before every commit of this front) — **identical white bands** in
the 30..155 m belt near the lake. Not this front's regression; suspects are
the understory flower carpets (veg.under 546k; flowerMaterial emissive 0.72
wash — war plan Front A item 5, open) or mid-grass silver wash at grazing
angles. Handed to the coordinator.

## Fixes landed alongside the wiring

- `ablate=bloom` black frame: the mblur center tap sampled TRAA's RT as a
  raw texture; bloom was the only node reference keeping TRAANode's
  updateBefore in the graph, so bloom-off killed TRAA. Center tap now
  references the TRAA node. (war plan Front A item 4)
- AO half-res attachment r8unorm (`red: true`) instead of rgba16f — the
  path existed, never wired; visually identical (A/B'd), free bandwidth.

## Ablation table (clean, mutex era, clock-recorded, single runs)

Metric notes: gpuWorkUnits = ms x mean-window-MHz is only comparable when
the busy% is similar — conditions that REMOVE a lot of load let the clock
idle-boost and inflate W (noclouds@999MHz is the poster child). Judge by
per-pass structure at matched clocks + the tablet's measured ranking.

| condition | gpuMs | MHz | busy% | W | draws | verdict |
|---|---|---|---|---|---|---|
| cbase2-r1 (shipped min) | 3.652 | 593 | 59.5 | 2165 | 608 | reference |
| cbase2-r2 | 3.577 | 556 | 56.3 | 1989 | 608 | reference |
| casc2 (2 cascades) | 2.832 | 739 | 62.5 | 2093 | 541 | shadow passes 546->412 Wu; cpu.submit 33->20ms. TAKEN |
| casc1 | 2.101 | 967 | 64.7 | 2032 | 454 | ->349 Wu; visual floor risk. not taken |
| nocasters | 2.191 | 765 | 64.7 | 1676 | 282 | draws -54%! biggest single axis; kills tree shadows. not taken (cascades=2 already halves caster draws) |
| grass4 (S=4) | 3.456 | 534 | 55.9 | 1846 | 608 | -11% W; tablet said S>2 saturates. not taken |
| bladeslow 3x2/2x1 | 3.461 | 709 | 55.5 | 2454 | 608 | noise here; vertex win on tablet. TAKEN |
| nofar | 3.606 | 758 | 56.0 | 2733 | 608 | farTuftCull ~0.05ms only; silhouette cheap. TAKEN anyway (fill on tablet) |
| ring06 (trees x0.6) | 3.359 | 535 | 54.2 | 1797 | 608 | -14% W. TAKEN |
| nofroxels | 3.680 | 527 | 46.7 | 1939 | 608 | froxel passes -0.46ms (=12% of GPU) gone clean. TAKEN |
| noclouds | 3.101 | 999 | 63.8 | 3098* | 608 | sky EMPTY; clouds ~0.1ms in half.mrt here. NOT taken; march 16 + LUT 384 instead |
| gi1024 | 3.929 | 560 | 48.6 | 2200 | 608 | probeGather IDENTICAL at matched clock (latency-bound on 40 CU); will pay on 4-6 CU phone. TAKEN |
| nodebris | 2.970 | 671 | 60.2 | 1993 | 608 | debris pools cheap; keep the richness. not taken |
| noao | 2.740 | 814 | 62.5 | 2231 | 608 | grounding loss; kept ON at min |
| nobloom | 2.893 | 704 | 65.1 | 2037 | 596 | frame renders fine now (fix validated). kept ON |
| notaa | 3.290 | 621 | 63.4 | 2043 | 606 | dither fades shred visibly. kept ON |
| minoroff (particles+caustics+bounce) | 2.963 | 603 | 57.9 | 1787 | 606 | caustics+bounce off TAKEN; particles 16k kept |

## Assembled min preset — result (same code, control via q-params)

| | old min | new min | delta |
|---|---|---|---|
| gpuTotalMs (median of 3) | 3.58-3.65 | **1.544 / 1.600 / 1.553** | **-57%** |
| workUnits | 1989-2165 | 1238 / 1533 / 1148 | ~-40% |
| draws (window mean) | 608 | 454 | -25% |
| cpu.submit ms | 24-34 | 12.4-18.7 | ~-45% |
| picture (codex-terra, T=9 SBS) | — | **9/10** "essentially matched" | |

Tablet extrapolation (NOT measured on device — tablet unavailable): the
axes taken are exactly the tablet's measured heavy hitters (shadows #1-2,
veg fill 53%, froxels 3%, GI 2.4%): the desktop -57% GPU / -45% cpu.submit
should compound with the phone's GPU-bound regime, but the 41.9 ms
clock-independent floor from PERF_CPU_WALL_RESULTS.md is untouched by any
of this and still caps the tablet below ~24 fps until attributed on-device.
