# ROADMAP — PROJECT RANDO

*2026-07-02. Governing docs: `docs/PROJECT_RIDE_v1.md` (pillars, floors, bans, probes P1–P7), `docs/ARCHITECTURE-ASSESSMENT.md` (attachment points, risks). Session counts are honest estimates for long autonomous sessions, not promises. Owner directives baked in: FPS on the current dev box is the **last** priority; graphics polished-not-primitive; physics natural.*

## Phase 0 — planning + first slice (THIS SESSION, done)

Baseline environment on NixOS (WebGPU recipe, Justfile `run`/`run-nixos`), ride-HUD slice (`src/ride/` — sensor seam + Zwift-style dashboard, verified headless), architecture assessment, this roadmap, brief, open questions, perf snapshot (`docs/PERF-BASELINE.md`), notes + STATUS append.

## Phase 1 — MVP inside the existing 4×4 km world

Order is dependency-driven; each milestone closes only with its named probes green + the screenshot/aesthetic gate (Pillar A) passed.

### M1.1 Surface data layer
- **Scope:** the one matrix file (`src/ride/SurfaceMatrix.ts`, data-only) — surfaces × modes: allowed/degraded/blocked, Crr, max speed, grip, sound id, weather sensitivity, stall risk. CPU mirrors for classification (biomeTex and/or fieldsTex readback alongside `heightAtCpu`, `src/world/Heightfield.ts:190-193`), `surfaceAt(x,z)` query, `groundProbe` extended to `{ground, water, surfaceId, slope}`.
- **Acceptance:** transect probe (pattern: `tools/probe-line.ts`) prints surface classes + slope along known lines matching visual truth at ≥95% of samples; matrix consumed from exactly one import site per system; typecheck.
- **Depends on:** nothing. **Sessions:** 1. **Top risk:** thresholding continuous splat fields (`src/render/TerrainMaterial.ts:216-254`) into discrete classes flickers near boundaries — needs hysteresis/majority sampling.

### M1.2 Road & trail network
- **Scope:** seeded spline graph generator (junctions, loops, ≥30 km distinct rideable), surface tags per segment riding the spline attribute; terrain carve/flatten at the seam after `composeEroded` (`src/world/Heightfield.ts:459`) reusing the `splineField`/carve template (`src/world/MacroMap.ts:141`, `src/gpu/passes/FlowRivers.ts:143`); road SDF into the terrain material composite + micro-displacement gating (`src/world/TerrainTiles.ts:160-181`); **vegetation exclusion in both sites** (`src/gpu/passes/Scatter.ts:201-238` + GroundRing kernels); water crossings v1 = fords (shallow-water tag), no bridge geometry yet.
- **Acceptance:** road-conformance probe — along the whole network, |carved terrain − road profile| ≤ 15 cm, zero segments under water except tagged fords; veg-exclusion probe — 0 tree/stone instances within the road half-width (counter query), grass density on-road ≤ 5% of verge; aesthetic gate — 4 composed road bookmarks (asphalt valley, gravel forest, dirt ridge, singletrack) judged against Pillar A, roads banked/verged, no clipping (banned outcome).
- **Depends on:** M1.1 (tags). **Sessions:** 2–3. **Top risk:** road × river-channel crossings and steep-slope switchbacks reading unnatural — art-direction iterations; mitigation: grade-limited routing on the flow-carved terrain.

### M1.3 Movement modes & physics
- **Scope:** fixed-timestep physics accumulator beside the variable-dt loop (`src/core/Engine.ts:138`); hike mode re-judged against Pillar B (natural gravity 9.81, no FOV kick — retune or record approved deviation for the inherited 22 m/s² feel, `src/core/FlyCamera.ts:31,42`); bike integrator: power→speed solver over matrix Crr + real gradient + aero, route-following steering (Zwift principle, junction picks), mode switching (hike ⇄ bikes, bikes only with a power source — dev flag `?ridedev=1` for keyboard-driven bike in development builds only); driven entirely through the sensor seam (`src/ride/Sensors.ts`) — synthetic source first.
- **Acceptance:** probes **P1 mud-stop, P2 top-speed ±2%, P3 ford, P4 slope-block** green at fixed timestep across 3 dt values; dashboard speed equals solver speed ±1%; walk regression — existing spawn/bob/jump behavior unchanged unless deliberately retuned (diff against pre-milestone captures).
- **Depends on:** M1.1, M1.2 (surfaces to ride on). **Sessions:** 2. **Top risk:** "natural physics" (Pillar B) vs fun on a 4 km map — real gearing/speeds may feel slow on gradients; resolve with real-world parameter sets (bike mass, CdA) and the owner's live ride test, not by bending physics.

### M1.4 BLE sensor layer
- **Scope (per owner answers Q5/Q6/Q8, 2026-07-02):** `BleSensorSource` implementing the seam: FTMS (indoor bike data + **control point — SIM-gradient resistance IS in scope**, graceful read-only fallback for trainers without it), cycling power (0x1818), CSC (0x1816), HR (0x180D); connect UI (user-gesture requirement), device persistence, dropout/reconnect handling; the no-sensor gate (bike modes locked without a live power source; demo mode stays badged).
- **Acceptance:** probe **P6 sensor-dropout** (synthetic transport faked under the BLE adapter interface) — coast to natural stop, reconnect UI, no crash; **P7 demo-badge**; SIM-resistance path exercised against the fake transport (gradient writes observed). **Real-hardware ride moved OUT of this milestone by owner decision (Q8):** it happens in a dedicated owner-scheduled test session once a USB BT dongle is attached (all sensors active at once); until then M1.4 closes on seam-level verification only.
- **Depends on:** M1.3 (physics consumes power). **Sessions:** 1–2. **Top risk:** code written blind against per-brand FTMS quirks — mitigate with strict spec conformance + defensive parsing, and capture trainer/HR model names at the hardware session.

### M1.4.2 Water surface fix (owner-ordered 2026-07-03) — **DONE session 5 (2026-07-03)**: `src/world/WaterPools.ts` Priority-Flood pooled flatten + `buildWaterY` shoreline clamp; acceptance met (3-angle shots sent, ledger §6 updated, probes green, lake-bookmark parity). See STATUS session-5 entry.
- **Scope:** kill the inherited LAAS water bulge artifact (owner observed convex "bubble" ponds and weird raised edges — e.g. the ford pond in shots/wip/preset-ultra.png; supersedes this item's ledger-§6 "only when blocking" status). Suspected mechanics (STATUS/Heightfield notes; CONFIRM in code first): (a) `waterY` = carved bed + depth → surface follows bed shape instead of a FLAT fill level per waterbody; (b) dry-cell `bed − 2` bilinear shoreline trick → tilted/puffy edges; (c) sim-res coarseness (2–4 m cells) + min-reduced simRes/8 far field. Fix direction: per-waterbody flat fill level (lakes already have a multigrid fill — reuse), separate shoreline mask instead of the −2 trick, keep far-clipmap min behavior for distant sanity.
- **Acceptance:** shots of the same pond/river from ≥3 angles — no convex bulge, shoreline flat and tight (send to owner with explanations); ledger §6 entry updated (artifact leaves the ledger); regressions probe-roads (fords!) + probe-surface green; visual parity at a river stretch + lake bookmark.
- **Depends on:** nothing. **Sessions:** 1. **Top risk:** rivers are legitimately sloped (carved down-valley) — flat-level applies per POOLED waterbody, not flowing reaches; don't terrace the rivers.

### M1.5 Cockpit + dashboard v2 + HUD warnings
- **Scope:** handlebars/hands/bike-computer as layer-0 scene meshes attached to the logical pose (`basePos` contract, `src/core/FlyCamera.ts:73,245`), per-mode cockpit (road drops / gravel flare / MTB riser); TRAA mitigation for view-locked geometry (per-object velocity or post-TRAA composite — `src/render/PostStack.ts:463-509`, assessment §2.6); dashboard v2: power, gradient, distance cards; **P5 HUD impassable warning** (uses M1.1 `surfaceAt` lookahead along heading).
- **Acceptance:** P5 green (warning ≥2 s before zone at current speed); cockpit aesthetic gate at 4 bookmarks incl. golden hour (Pillar A — no primitive geometry ships); no TRAA smear on cockpit in a moving capture (diff vs static).
- **Depends on:** M1.3 (modes exist). **Sessions:** 2. **Top risk:** TRAA vs view-locked cockpit (known, assessment §5.5); fallback is the post-TRAA composite pass.

### M1.6 Weather visual states
- **Scope:** `WeatherState` orchestrator lerping existing levers — froxel `fogK` + noon un-gate (`src/gpu/passes/Froxels.ts:78,140`), aerial FOG_K→uniforms (`src/sky/Atmosphere.ts:386`), cloud coverage/density (`src/sky/Clouds.ts:63`), global wetness into the wet term (`src/render/TerrainMaterial.ts:294`), rain as a 4th particle type (`src/gpu/passes/Particles.ts:57`); states: dry / rain / after-rain / fog; visual-only (physics coupling = Phase 3).
- **Acceptance:** aesthetic gate per state at 3 bookmarks + one moving capture each (Pillar A: rain must not read as cheap streaks — includes surface wetness response); state transitions smooth in a 60 s capture; determinism — states settable by URL param for probes.
- **Depends on:** nothing hard (parallelizable after M1.2). **Sessions:** 1–2. **Top risk:** rain quality bar — particles + wetness may need splash/ripple touches to pass Pillar A.

### M1.7 Audio (last in MVP, by design)
- **Scope:** WebAudio engine registered after the mover (`src/main.ts:52-57` contract); small curated CC0 set (tires per surface, drivetrain, wind, water, footsteps per surface) + cheap procedural (wind shaping by `windU`, water proximity via `waterYAtCpu`); modulation by speed/surface from the matrix `sound id`; volume/mute UI.
- **Acceptance:** audio-matrix probe — sound id switches at surface boundaries within 0.5 s (headless: assert the *selected* id, not audible output); no audible seams/clicks in a 60 s ride capture (manual); mute = zero nodes running.
- **Depends on:** M1.3 (speed/surface), M1.2 (surfaces). **Sessions:** 1–2. **Top risk:** CC0 curation quality (Pillar A's audio analog — no jarring loops).

**Phase 1 total: ~10–14 sessions.**

## Phase 2 — world beyond the 4×4 km

### M2.1 GPX-corridor bake pipeline
- **Scope:** run the existing global generation over a corridor-shaped window along an imported GPX track (synthesis is positional → tileable; erosion/hydrology run per finite window — assessment §3 verdict), blending synthesized height toward the GPX elevation profile inside the corridor; corridor road = the GPX track itself, surface-tagged.
- **Acceptance:** a real GPX (owner-provided alpine route) bakes and rides end-to-end; elevation error vs GPX ≤ 2 m RMS on-track; visual parity with the 4×4 km world at 3 corridor bookmarks.
- **Sessions:** 2–3. **Top risk:** corridor-local hydrology reads wrong (rivers from nowhere) — record as deviation, art-direct water only near the track.

### M2.2 Corridor residency streaming
- **Scope:** stream baked corridor tiles' GPU residency while riding (grass/water clipmaps already camera-following; scatter re-runnable per tile — assessment §3); memory budget + prefetch along heading.
- **Acceptance:** 30+ km corridor ridden continuously, no main-thread stall > 8 ms (LAAS spec §6 rule), no visible pop < 300 m (LAAS draw-in rule).
- **Sessions:** 2–3. **Top risk:** VRAM headroom unmeasured (assessment flags it) — measure first on the target machine.

### M2.3 Open-world tiles (exploratory, after corridor ships)
- **Scope:** seamless infinite tiling — erosion/hydrology across tile borders via overlap-and-blend windows; treat as research; corridor tech is the stepping stone.
- **Sessions:** 3–4 exploratory. **Top risk:** watershed seams; may land as "large pre-baked regions with border blending", recorded in DEVIATIONS.

## Phase 3 — depth

- **M3.1 Weather → physics modifiers:** wet/mud multipliers applied to the matrix (weather sensitivity column already reserved) — probes P1–P4 re-run per weather state. 1 session.
- **M3.2 Treadmill FTMS for hiking**: incline-driven walk speed, treadmill pace → hike pace. (SIM resistance moved into M1.4 by owner answer Q6.) Plus the **real-hardware BLE test session** (owner + dongle + all sensors, deferred from M1.4 per Q8). 1–2 sessions.
- **M3.3 High-speed perf pass:** CSM cache at speed (`src/render/CsmCached.ts:141-147`), CDLOD 20 m refine lag (`src/world/TerrainTiles.ts:447`), ring-crossfade churn — **explicitly last for the current dev box (owner directive: fps is the last priority on this machine); runs when the real target/play machine is known** (OPEN-QUESTIONS a). Quality-preserving fixes only (LAAS ban on detail cuts stands). 2+ sessions on target hardware.
- **Backlog (unscheduled):** bridges as geometry at water crossings; multi-rider/ghosts for friends; ride recording (.fit export); photo mode on bike.

## Standing rules for every milestone

- Close = probes green + aesthetic gate + typecheck + STATUS.md updated + PROGRESS.md entry + (if perf-relevant) PERF-BASELINE append.
- Never ship primitive visuals or unnatural physics to a closed milestone (Pillars A/B); deviations go to `docs/DEVIATIONS.md` with Spec/Implemented/Why.
- Inherited LAAS bugs (assessment §6) get fixed only when they block a milestone; otherwise leave the ledger alone.
