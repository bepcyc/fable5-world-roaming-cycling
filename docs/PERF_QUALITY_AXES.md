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

## Ablation table (clean, mutex era, clock-recorded)

Baseline and per-axis rows land here as the batteries complete. Metric:
per-pass GPU ms at matched clock, or gpuWorkUnits; fps is a regression
guard only (CPU-walled box).

| condition | gpuTotalMs | meanMHz | workUnits | draws | key passes moved |
|---|---|---|---|---|---|
| (rows appended as measured) | | | | | |
