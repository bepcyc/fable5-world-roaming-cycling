# Architecture assessment — LAAS fork → first-person hike & bike sim

*2026-07-02. Sources: three parallel read-only subsystem sweeps (terrain/hydrology; materials/scatter/rendering/perf; runtime/controls/harness) + direct reads of STATUS.md, PROJECT_LAAS_v2.md, docs/THREE-NOTES.md, docs/DEVIATIONS.md, FlyCamera.ts, HUD.ts, main.ts, tools/launch.ts + live probes on this machine. Every claim carries a file path; anything not personally re-verified by a second pass is marked (agent). Perf numbers: see `docs/PERF-BASELINE.md`.*

## 0. TL;DR

The engine is a **boot-generated, fully resident** 4×4 km world (no streaming exists — `src/main.ts:65` still calls the "streamed open world" aspirational). Everything the fork needs has a clean seam: roads can reuse the existing spline-carve machinery and a post-erosion height-edit slot; surfaces extend an existing per-texel classification texture; physics extends a CPU ground-probe that already feeds walk mode; weather visual states are mostly existing uniforms; cockpit is ordinary layer-0 scene geometry; audio and BLE sensors are pure greenfield. The two structural gaps: **no CPU mirror of surface/slope data** (only height + waterY) and **no fixed-timestep loop** (physics determinism). The two perf realities: this dev box (Vega 7 iGPU) is ~an order of magnitude below the M1 Max the demo was tuned on, and the top speed-scaling cost is **shadow-cascade cache invalidation**.

## 1. Subsystem map

| Subsystem | Key files | Role |
|---|---|---|
| Boot/loop | `src/main.ts`, `src/core/Engine.ts`, `src/core/BrowserGate.ts`, `src/core/Hooks.ts` | gate → params → renderer → FlyCamera (registers FIRST — update-order contract `src/main.ts:52-57`) → scene → HUD; variable-dt rAF loop, `window.__laas` tooling contract |
| Camera/controls | `src/core/FlyCamera.ts` | walk+fly rig; all feel constants at top (`:27-55`); `groundProbe(x,z)→{ground,water}` (`:23`); getPose strips bob/dip (`:245-254`); programmatic pose ⇒ fly (`:225`) |
| Terrain gen | `src/world/Heightfield.ts`, `src/gpu/passes/{HeightSynthesis,Erosion,FlowRivers,BiomeSnow,NoiseBake}.ts`, `src/world/MacroMap.ts` | boot GPU pipeline: 4096² synth → 640-iter pipe erosion @2048² → lake fill → 3M-particle flow accumulation → carve/moisture → biome+snow (`Heightfield.ts:108-194`) |
| Terrain render | `src/world/TerrainTiles.ts`, `src/render/TerrainMaterial.ts`, `src/world/ShadowProxy.ts` | CDLOD instanced quadtree + far shell to 14 km; continuous-field splat material; coarse 512² shadow-caster proxy |
| Water | `src/world/WaterSurface.ts`, `src/render/WaterMaterial.ts`, `src/render/Caustics.ts` | 6-level camera clipmap over hydrology fields; SSR, absorption, foam, caustics |
| Vegetation | `src/gpu/passes/Scatter.ts`, `src/vegetation/{Forests,GroundRing,VegLibrary}.ts`, `src/render/{VegInstance,ImpostorRuntime,VegMaterials}.ts` | boot GPU clustered-Poisson (~1.1M instances, 4 layers), per-frame GPU cull → indirect draws, LOD rings → impostors; grass/debris clipmap carpets |
| Sky/atmosphere | `src/sky/{Atmosphere,SunSky,Clouds}.ts` | Hillaire LUTs, ToD sun/IBL, raymarched 2-layer clouds + cloud shadow map |
| Volumetrics/particles/wind | `src/gpu/passes/{Froxels,Particles}.ts`, `src/render/Wind.ts` | 160×90×64 froxel fog, 131k typed GPU particles (snow/pollen/leaf), global hierarchical wind |
| Lighting/shadows | `src/render/{ShadowSetup,CsmCached,Gtao}.ts`, `src/gpu/passes/ProbeGI.ts` | CSM×4 2048² + PCSS + contact shadows; cascade temporal caching; terrain-relative SH-L1 probe GI |
| Post | `src/render/{PostStack,HalfResMrt}.ts` | half-res MRT (clouds+GTAO+bounce) → froxels → aerial → TRAA (analytic camera-reprojection velocity) → bloom → auto-exposure → grade → AgX |
| Debug/verify | `src/debug/{HUD,Bookmarks,TerrainScene}.ts`, `tools/*` | fps chip + F3 panel, 9 bookmarks + 92 s flythrough, Playwright shot/probe suite |
| **Ride (new, this session)** | `src/ride/{Sensors,RideHud}.ts` | sensor abstraction (demo source) + Zwift-style dashboard (speed/cadence/HR, `?ride=`, key B) |

## 2. Attachment points for the fork's systems

### 2.1 Surface data layer (the single-file surface×mode matrix)

- **No surface-class concept exists.** Terrain appearance is a *continuous-field splat* computed at shading time from slope/snow/moisture/rockExposure/zone masks (`src/render/TerrainMaterial.ts:216-254`); the quantized biome id is scatter-only by design (`TerrainMaterial.ts:1-18`).
- Per-texel classification storage exists to extend: `biomeTex` 4096² rgba8 = biomeId/8, snow, vegDensity, rockExposure (layout documented `src/gpu/passes/BiomeSnow.ts:4-5`, written at `:173-178`; ids in `src/world/WorldConst.ts:28-45`); hydrology fields in `fieldsTex` 2048² rgba16f (`src/world/Heightfield.ts:424`).
- The matrix file itself is greenfield (proposed: `src/ride/SurfaceMatrix.ts`, data-only): per surface (asphalt, fine gravel, coarse gravel, dirt, singletrack, grass, rock, mud, shallow/deep water, snow…) × per mode (hike/road/gravel/MTB): allowed/degraded/blocked, rolling resistance, max speed, grip, sound id, weather sensitivity, stall risk. Consumers: physics solver, HUD warning, audio, and the road generator's surface tags.
- **CPU access gap (key unlock):** CPU mirrors exist only for height (4096², `heightAtCpu`, `Heightfield.ts:198`) and waterY (2048², `waterYAtCpu`, `:216`). Slope/moisture/biome/flow have **no CPU mirror** — surface classification for physics/HUD needs one more `getArrayBufferAsync` readback each (pattern at `Heightfield.ts:190-193`), plus the future road/surface map itself. Trap: sim-res (2048²) vs full-res (4096²) comparisons need ≥0.25 m water-depth thresholds (STATUS.md:852 — a tight compare once silently deleted 53k trees).

### 2.2 Road & trail network generation + terrain carving

- **Carve seam:** heights are finalized in this order — macro synth (`src/world/MacroMap.ts:241`) → erosion → river channel enforce/carve (`src/gpu/passes/FlowRivers.ts:143,468`) → `composeEroded` (`src/world/Heightfield.ts:459`) → `rebuildDerivedMaps` (normals/slope, `:488`) → `buildFieldsTex` → `runBiomeSnow`. **Insert road flattening/carving after `composeEroded`, before `rebuildDerivedMaps`** — the 4096² f32 height buffer is the single source of truth there, and normals/slope/biome then pick the road up automatically.
- **Ready-made machinery:** `segDist` (point→segment distance, `MacroMap.ts:121-128`) and `splineField` (min-distance + interpolated attribute along a polyline, `:141-156`) are exactly a road SDF evaluator; `channelEnforce`/`riverCarve` show the carve pattern (`min(height, profile)` with V-profiles and faded strength). The valley/tributary splines are art-directed world-space polylines (`MacroMap.ts:70-87`) — a road network is another such set, with junctions and a per-segment surface tag riding the interpolated attribute.
- **Material integration (ranked in-repo):** analytic road SDF exposed like `zoneMasks` → `roadK = smoothstep(halfWidth, halfWidth−blend, roadDist)` mixed into the splat composite (`TerrainMaterial.ts:~254`), flatten the perturbed normal and lower roughness on-road, and gate the vertex micro-displacement by `roadK.oneMinus()` (`src/world/TerrainTiles.ts:160-181` — geometry and fragment constants share the `DISP` table, `TerrainMaterial.ts:82-97`, and must stay in lockstep). Alternative: baked road-mask StorageTexture (more memory, filterable edges, needs a bake pass). Rejected: biome-id branch (id is quantized/NearestFilter, scatter-reserved).
- **Vegetation exclusion is mandatory and dual-site:** scatter has water-only exclusions today (`src/gpu/passes/Scatter.ts:390-395,505-510,607-612,720-725`) — without a road mask in `sampleSite` (`:201-238`) **and** in the GroundRing grass/debris kernels (`src/vegetation/GroundRing.ts`), trees/grass/stones spawn straight through roads. Density knobs per biome are `byBiome()` tables (`Scatter.ts:156-162`).
- **Hydrology interaction:** the carve seam is *after* rivers, so roads won't reroute water — but the network **will** cross carved channels; crossings need explicit treatment (ford = shallow-water surface tag; bridge = later geometry). Water-adjacent roads must respect `waterYAtCpu` or they'll read as flooded.

### 2.3 Movement modes & physics

- Walk mode is the template: `FlyCamera.updateWalk` (`src/core/FlyCamera.ts:326-433`) — yaw-plane wish velocity, exp-damp accel (`GROUND_ACCEL=10`), game gravity 22, velocity-Verlet jump (framerate-exact apex, `:366-370`), ground clamp + `STEP_DOWN` stick, wade clamp. All constants named at top (`:27-55`). Walk-sprint tops at **9.2 m/s = 33 km/h** — bike speeds (40–50 km/h) exceed every existing tuning.
- Bike mode = new integrator beside `updateWalk`, fed by the **sensor seam** (`src/ride/Sensors.ts`, created this session): Zwift-style solver `P = (Crr·m·g·cosθ + m·g·sinθ + ½ρCdA·v²)·v` with Crr/grip/max-speed from the surface matrix, gradient from finite-differencing `heightAtCpu` (pattern: `findWalkSpawn`, `src/debug/TerrainScene.ts:312-314`), route-following steering (Zwift principles — no free WASD on bike).
- Contracts to respect: FlyCamera owns `camera.position`; effects compose onto `basePos` and `getPose()` strips them (`:245-254`) — the bike computer/cockpit must attach to the *logical* pose. Any programmatic pose forces fly mode (`setPose`, `:225-243`) — bike probes must enter bike mode explicitly, not via setPose.
- **Determinism gap:** the loop is variable-dt with a 0.1 s clamp (`src/core/Engine.ts:138`) — no fixed-step accumulator. Physics probes ("stops within N meters") need one (house precedent for dt-exactness: the velocity-Verlet jump fix, commit `daf8c52`). TSL `time` is wall-clock and NOT frozen by `?freeze=1` (STATUS.md:968) — probe discipline: `--framealign`, `--lockexp`, `--wind 0` (STATUS.md:583-598).
- `groundProbe` returns `{ground, water}` only (`FlyCamera.ts:23`) — extend to `{ground, water, surfaceId, slope}` once CPU mirrors exist (§2.1).

### 2.4 Sensor layer (BLE) — greenfield

- Zero BLE/gamepad code in the repo (grep clean). Chrome-only is already the product gate (`src/core/BrowserGate.ts`), and Web Bluetooth works in Chrome on localhost/https — fits.
- Services: FTMS (0x1826, indoor bike data + control point for SIM-gradient resistance), Cycling Power (0x1818), CSC speed/cadence (0x1816), Heart Rate (0x180D).
- The seam is `SensorSource` (`src/ride/Sensors.ts`) — `DemoSensorSource` exists (deterministic, labeled DEMO); a `BleSensorSource` implements the same interface later. Web Bluetooth `requestDevice` **requires a user gesture** → needs a small connect UI (DOM, next to the dashboard).
- **This dev box has no BT adapter** (`/sys/class/bluetooth` empty) — real-sensor testing needs a USB dongle or the play machine; headless probes always drive the synthetic source.

### 2.5 Dashboards

- Implemented this session: `src/ride/RideHud.ts` — DOM overlay (house pattern: `src/debug/HUD.ts` fps chip/F3 panel), top-center cards SPEED/CADENCE/HR, `?ride=1|demo`, key B, DEMO badge; speed derived from `getPose()` deltas (real rig speed; teleports reset rather than spike). There is **no post-chain UI composite seam** (single `outputNode`, `src/render/PostStack.ts:619-626`) — DOM is the right MVP layer; an in-scene bike-computer screen later can follow the `HalfResMrt` extra-pass pattern (`src/render/HalfResMrt.ts`).

### 2.6 Cockpit rendering (handlebars, hands, bike computer)

- Scene renders via one `pass(scene, camera)` (`PostStack.ts:116`); cockpit meshes on layer 0 get CSM/GI/AO/aerial/TRAA/bloom automatically; near plane 0.3 m accommodates 0.5–1 m geometry (`src/core/Engine.ts:51-56`); shadow-caster siblings use layers 2–5 (`src/vegetation/Forests.ts:405,591`) if cockpit shadows are wanted.
- **TRAA risk:** the TRAA velocity input is analytic **camera reprojection from depth** — exact for the *static world*, wrong for anything that moves *with* the camera (`PostStack.ts:463-509`, THREE-NOTES.md:91-101). A view-locked cockpit will get incorrect velocity every camera rotation → history rejection (shimmer) or smear. Mitigations when built: per-object velocity for cockpit, or draw the cockpit in a small post-TRAA pass. Budget a session for this.
- Attach cockpit to the **logical pose + explicit bob transfer** (walk bob composes on `basePos`, `FlyCamera.ts:397-432`); on bike, cadence-linked sway is its own animation, not head-bob.

### 2.7 Audio — greenfield

- No audio code or assets anywhere (README.md:7, grep clean). WebAudio engine registers via `engine.onUpdate` **after** the mover (update-order contract, `src/main.ts:52-57`). Inputs: mode, speed, surface id (from the matrix), wind strength (`src/render/Wind.ts` `windU`), water proximity (`waterYAtCpu`). Fork brief allows a small CC0 sample set — a deviation from upstream's zero-asset rule, recorded here deliberately.

### 2.8 Weather visual states (dry / rain / after-rain / fog) — mostly existing levers

| State ingredient | Lever | Where |
|---|---|---|
| Fog density | `fogK` uniform (`?fog=N`) + un-gate the noon ToD suppression | `src/gpu/passes/Froxels.ts:78,140` |
| Haze/aerial | promote hard-coded `FOG_K/FOG_H0/FOG_HF` to uniforms | `src/sky/Atmosphere.ts:386-397` |
| Overcast | `coverage`/`density` uniforms (`?cov`, `?cdens`) | `src/sky/Clouds.ts:63-64` |
| Rain | 4th particle type (streak quad, fast fall) in the typed 131k GPU system | `src/gpu/passes/Particles.ts:57-88` |
| After-rain wetness | global `wetness` uniform folded into the existing wet term (albedo+roughness) | `src/render/TerrainMaterial.ts:294-301` |
| Wind | already global + hierarchical | `src/render/Wind.ts:44-49` |
| Cloud shadows follow | rebake ~2.5 s cadence already world-time driven | `src/sky/Clouds.ts:210-221` |

A `WeatherState` orchestrator that lerps these uniforms is a small module; **no new render systems needed for the MVP's visual-only weather**.

## 3. Boot-global vs tileable (Phase-2 streaming feasibility)

Everything is generated once at boot on GPU (`Heightfield.generate`, `src/world/Heightfield.ts:108-194`; scatter at `src/debug/TerrainScene.ts:69`). Inventory (agent, spot-verified):

| Artifact | Res/size | Tileable as-is? |
|---|---|---|
| Height synthesis (+hardness) | 4096² f32 (64 MB) | **Yes** — pure positional fn of (worldPos, seed), no global normalization (`src/gpu/passes/HeightSynthesis.ts`, `MacroMap.ts:241`) |
| Baked noise (materials) | 2×1024² rgba16f | **Yes** — world-independent, tiling (`src/gpu/passes/NoiseBake.ts:76`) |
| Erosion | 2048² ×~5 buffers | **No** — global sim, border drain-to-zero sink (`src/gpu/passes/Erosion.ts:108`) |
| Lake fill (priority-flood multigrid) | 2048² + pyramid | **No** — whole-map basin logic (`FlowRivers.ts:182-323`) |
| Flow accumulation → rivers | 3M particles, 2048² | **No** — inherently whole-watershed (`FlowRivers.ts:327-389`) |
| Moisture/riverDepth/flowDir/waterY | 2048² each | Derived from the global hydrology |
| Biome/snow classify | 4096² rgba8 | **Yes** — per-texel decision tree over local inputs (`BiomeSnow.ts:132-163`) |
| Scatter placement | ~1.1M instances, 4 layers | **Mostly** — deterministic per-cell hash (pcg2d) + 26 m parent-clump cells (`Scatter.ts:101-186`); re-runnable per tile with a small halo |
| Grass/debris carpets | camera clipmaps | **Already streaming-shaped** — content re-derives per world cell, no uploads (`GroundRing.ts:4-11`) |
| Probe GI | 256×256×6, terrain-relative, world-uniform grid | Re-anchorable; time-sliced already (`src/gpu/passes/ProbeGI.ts:328-342`) |
| Water render | camera-following clipmap | Follows camera already; needs waterY source (`WaterSurface.ts:27-28`) |
| Far shell | analytic to 14 km | **Yes** — analytic macro terrain (`TerrainTiles.ts:330-382`) |
| CPU mirrors / LOD range pyramid | 4096²+2048² f32 | Rebuild per resident region |

**Verdict:** *GPX-corridor streaming is feasible without redesigning the world pipeline* — treat the corridor as a **finite pre-baked domain**: run the existing global pipeline once over a corridor-shaped window (or several chained windows) at load, blending synthesis toward real GPX elevation inside the corridor; stream only *residency* (which baked tiles are on GPU), not *generation*. The hard blockers (erosion/hydrology globality) are avoided because the corridor is finite and baked at load exactly like today's 4×4 km — just shaped differently. Simplified corridor hydrology (streams from local flow accumulation inside the window; no cross-window watersheds) is a visible but acceptable deviation — record it when built. **Effort estimate: 3–5 sessions** for GPX-corridor v1 (window generation + residency + GPX elevation blend + spawn/route plumbing), **+3–4 sessions** for true open-world tiling (seamless erosion/hydrology across tile borders is research-grade; likely needs overlap-and-blend compromises). Unverified beyond code reading: actual VRAM headroom for multi-window residency on 8–16 GB GPUs — measure in Phase 2.

## 4. Performance-risk map at bike speed (11–14 m/s)

Context: walk-sprint today is 9.2 m/s; bikes push 1.2–1.5×. What actually scales with camera speed (agent + STATUS evidence):

1. **CSM cascade cache invalidation — top risk.** `CachedCsmShadowNode` re-renders cascade *i* every [1,2,3,6] frames, but any cascade refits early when its fit-center drifts >4% of span (periods `src/render/CsmCached.ts:29`, drift refit `:141-147`; the header comment `:13-15` names fast camera motion explicitly). Sustained 14 m/s pushes mid/far cascades toward every-frame re-render *including per-cascade veg caster re-raster* (`Forests.ts:544-635`) — eroding a cache upstream measured at −3.9 ms avg (STATUS.md:441-444, M1). Mitigations to evaluate in the high-speed pass (not now): velocity-aware cascade phasing, motion-directional fit margin.
2. **CDLOD refine lag.** The quadtree rebuilds only after ≥20 m of camera travel (`src/world/TerrainTiles.ts:447`) — every ~1.5 s at bike speed; tiles refine *after* you enter them. At 50 km/h expect visible late-refine on rough ground; road corridors mitigate (roads flatten + smooth the near field).
3. **LOD ring churn/overdraw.** Cull cost is ~fixed per frame (`Forests.ts:915-967`), but faster travel keeps more instances inside dithered crossfade bands (`src/render/VegInstance.ts:127-151`) — more double-drawn instances.
4. **Not speed-scaled** (for the record): grass clipmap re-derives content with zero uploads (`GroundRing.ts:4-11`); particles live in a ±36 m box ≫ per-frame travel (`Particles.ts:135-142`); probe GI is world-anchored + time-sliced (`ProbeGI.ts:328-342`); froxels/auto-exposure are fixed cost; TRAA velocity is analytic camera reprojection — exact under translation for the static world (`PostStack.ts:463-509`).
5. **CPU submit dominance.** Upstream's binding constraint at speed-independent framing was cpu.submit ≈ 12–15 ms on an M1 (STATUS.md:544). This box's Zen-2 desktop cores are unlikely to beat that; at Vega-7 GPU frame times (see PERF-BASELINE) the GPU dominates anyway. Re-attribute after Phase-1 systems land.
6. Upstream's "120 fps, no quality loss" directive (STATUS.md:368-424) is **not** this fork's bar — ours: visuals first, honest avg + 1% low tracking, dedicated high-speed pass later (ROADMAP).

## 5. Top integration risks, ranked

1. **Hardware floor vs untouchable visual bar.** Vega 7 iGPU vs a world tuned on M1 Max: see PERF-BASELINE (boot ~63 s; single-digit-to-low-teens fps expected at native). If this box is the play machine, "LAAS bar + playable bike speeds" may be unreachable without decisions the owner reserved (resolution, preset). → OPEN-QUESTIONS (a)/(b).
2. **Roads × water crossings.** Carve-after-hydrology keeps rivers stable, but ≥30 km of network in this terrain *will* cross channels; fords/bridges need explicit surface tags + carve exceptions or roads read flooded/clip through banks (`FlowRivers` carve fields vs road SDF).
3. **Dual-site vegetation exclusion drift.** Road mask must gate both boot scatter (`Scatter.ts:201-238`) and GroundRing carpets — two GPU kernels in different files; a mismatch means grass on asphalt or bald verges. Single shared road-SDF module is the guard.
4. **Physics determinism.** Variable dt (`Engine.ts:138`) + wall-clock TSL time (STATUS.md:968) vs probes that assert meters-to-stop. Fixed-step accumulator for ride physics + existing `--framealign/--lockexp/--wind` discipline; otherwise probe flake will erode trust in the whole verification policy.
5. **TRAA vs cockpit** (§2.6): view-locked geometry gets wrong analytic velocity → smear/shimmer; needs per-object velocity or post-TRAA compositing. Known, budgeted, not a surprise.
6. **CSM cache at speed** (§4.1) — quality-preserving fix unknown until measured; the high-speed pass owns it.
7. **BLE testability.** No BT adapter on the dev box; Web Bluetooth needs user-gesture connect UI; FTMS control-point quirks vary by trainer. Demo source de-risks development; real-device test is a hard Phase-1 exit criterion (OPEN-QUESTIONS j).
8. **Tooling drift on Linux/NixOS.** `tools/launch.ts` recipes are Mac-specific and playwright-bundled Chromium doesn't run on NixOS; working recipe (this session): system Chrome + `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan`, headless, adapter `amd/gcn-5` (llvmpipe/SwiftShader silently substitutes without the last flag — **always assert adapter identity in probes**). launch.ts needs a Linux recipe + executablePath support next session. `npm run battery` points at a nonexistent `tools/battery.ts` (package.json:14).

## 6. Inherited-bugs ledger (report-only; do not rediscover)

| Issue | Evidence | Status |
|---|---|---|
| bm2 lake: white water shards + see-through swells | STATUS.md:645-719; RESOLVED session 5 (M1.4.2): pooled-water Priority-Flood flatten (src/world/WaterPools.ts) + dry-cell shoreline clamp min(bed−2, wetMin−0.15) in buildWaterY | **fixed session 5** |
| Blob rocks (smooth gray cobbles ≤120 m on meadows) | STATUS.md:299-311 (StoneL/M 'cobble' preset lacks detail) | open, fix sketched |
| Lake far-rim reflection fallback (planar pass queued) | STATUS.md:291-298 | open, priority raised upstream |
| Stale sun uniforms after ToD change in world scene | `updateSunUniforms` called once at `src/debug/TerrainScene.ts:172`, not in the ToD handlers (`:242-255`); GalleryScene does it right (`src/debug/GalleryScene.ts:608`) | **found this session** (agent), unfixed by policy |
| `npm run battery` broken | `package.json:14` → `tools/battery.ts` absent | inherited Phase-7 TODO |
| `?view=hydro` documented but unimplemented | `TerrainScene.ts:6` header vs grep | doc rot |
| STATUS "Current focus" section stale (says Phase 2/5) | STATUS.md:125-196 vs Phase-7 reality | conventions drift |
| 8 inert `eslint-disable` comments, no eslint installed | e.g. `main.ts:46,104`, `FlyCamera.ts:162`; not in package-lock | cosmetic |
| `terrain.maxH` strided max hack (`i+=7`) | `TerrainScene.ts:44-46` | cosmetic |
| Playwright-chromium unusable on NixOS; launch.ts recipes Mac-only | this session's probes (§5.8) | **new, blocks repo harness on this box until launch.ts learns Linux** |

## 7. Added this session (the one implementation slice)

`src/ride/Sensors.ts` (RideSample/SensorCtx/SensorSource + deterministic DemoSensorSource) and `src/ride/RideHud.ts` (dashboard; real speed from pose deltas; DEMO badge honesty rule), wired in `src/main.ts` after the camera mover. Zero changes to existing systems; `?ride` absent ⇒ zero footprint. This is the seam Phase-1 bike physics consumes.
