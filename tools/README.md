# tools/ — the verification harness

The probes **are** the test suite: vitest covers pure logic (`tests/`), this
directory covers everything that needs pixels or physics. 81 files.

**Classes:** `gate` — pass/fail, exits non-zero on failure · `probe` —
repro/acceptance measurement, prints numbers or shots · `perf` — FPS/profiler
harnesses · `img` — image utilities, no GPU · `debug` — single-bug diagnostic ·
`infra` — shared launchers/scaffolds, not run directly · `one-off` — spot/camera
search helpers · `device` — needs adb/phone.

**Needs:** `gpu` = real WebGPU GPU via Playwright Chromium (`launch.ts`/
`launch-gpu.ts`) · `headed` = refuses headless · `adb` = Android device ·
`node` = runs anywhere.

Run any script as `npx tsx tools/<file>` (or `node` for `.mjs`, `bash` for
`.sh`); the `npm run`/`gates:*` entries below are the wired ones.

## Wired into package.json

| Script | Invocation | Purpose | Needs |
|---|---|---|---|
| `shoot.ts` | `npm run shoot` | Boots LAAS at a scene/seed/T/cam, settles, captures PNG + engine stats JSON | gpu |
| `compare.ts` | `npm run compare` | Side-by-side ours-left/reference-right compositor + pixel sampling | img |
| `gate-grass-blue.ts` | `npm run gates:grass` | Far grass must read green, not blue frost carpet: shoots far+near pitch pair at the baseline repro spot, measures bluish-pixel fraction | gate, gpu |
| `gate-perf.ts` | `npm run gates:perf` | CI-style pass/fail perf on both shipping presets via the perf-mobile harness | gate, gpu |
| `gate-visual.ts` | `npm run gates:visual` | Visual-regression runner (WARPLAN never-again gates); one boot per frame, non-zero on fail | gate, gpu |
| `probe-turnpicker.ts` | `npm run gates:turnpicker` | Turn-picker gate (docs/TURN_PICKER.md): geometry-true layout + Zwift cutoff + no-teleport law, measured | gate, gpu |
| `probe-roadshape.ts` | `npm run gates:roads` (1/4) | Road SHAPE gate: where asphalt bubbles out / thins to a thread | gate, gpu |
| `probe-roadgates.ts` | `npm run gates:roads` (2/4) | Road anomaly gates: walks every route per seed | gate, gpu |
| `probe-deadends.ts` | `npm run gates:roads` (3/4) | Dead-end gate over the runtime RouteGraph | gate, gpu |
| `probe-roadrealism.ts` | `npm run gates:roads` (4/4) | "Would anyone ride this in the Alps?" realism gate | gate, gpu |

All `gates:roads` members take `--seeds 1,2,3` (see the package.json script).

## Perf harnesses

| Script | Purpose | Needs |
|---|---|---|
| `perf-baseline.ts` | avg + 1% low fps per bookmark + moving flythrough sample (docs/PERF-BASELINE.md) | perf, gpu |
| `perf-mobile.ts` | Pixel-10-Pro-proxy mobile profile (`?preset=low`, floor limits) | perf, gpu |
| `perf-tablet.ts` | THE REAL TABLET — Galaxy Tab S8 Ultra primary harness | perf, adb |
| `profile-tablet.ts` | CPU profiler on the real tablet (GPU_CPU_ISSUE_CODEX §5) | perf, adb |
| `gpu-clock-tablet.ts` | Adreno GPU clock + busy sampler (Tab S8) | perf, adb |
| `_converge-probe.ts` | Do drawCalls plateau at the fixed perf spot, and when | perf, gpu |

## World & ride probes (acceptance batteries)

| Script | Purpose | Class |
|---|---|---|
| `probe-roads.ts` | Road-network M1.2 acceptance, one-boot-many-probes | probe |
| `probe-surface.ts` | Surface-layer transect M1.1 acceptance | probe |
| `probe-physics.ts` | M1.3 physics battery; has a PURE node section (no browser, ms-fast) | probe (part node) |
| `probe-ble.ts` | BLE sensor-layer rebuild acceptance (docs/BLE_ZWIFT_PLAN.md) | probe |
| `probe-ridehud.ts` | Ride-HUD/dashboard contract, two boots on real GPU | probe |
| `probe-hudwarn.ts` | P5 HUD impassable-warning M1.5 acceptance | probe |
| `probe-weather.ts` | M1.6 weather determinism + smooth transitions | probe |
| `probe-wetmargin.ts` | Wetland-margin wetness pattern over CPU mirrors | probe |
| `probe-droplets.ts` | Rain droplets: dry≈0, beads fast, fades after rain | probe |
| `probe-terrace.ts` | River-gravel terrace staircase + surface class transect | probe |
| `probe-limitcap.ts` | `?limitcap=mobile` storage-buffer cap repro (Adreno/PowerVR fix) | probe |
| `probe-line.ts` | heightAtCpu/waterYAtCpu along a world-space line — artifact triage | debug |
| `probe-horizon.ts` | Horizon black-band repro sweep (yaw 45° steps) | debug |
| `probe-moving.ts` | Moving-camera shadow loss: static settle vs mid-motion | debug |
| `probe-cloudlag.ts` | Cloud-lag repro (settle-back over frames) | debug |
| `probe-csm.ts` / `probe-csm2.ts` / `probe-csm3.ts` | Live CSMShadowNode internals, frustum extents, full per-cascade state | debug |
| `probe-state.ts` | Live scene lighting state (sun, lights, shadow rig) | debug |
| `probe-sun.ts` | A/B DirectionalLight screenshots (sun off vs on, ablate veg) | debug |
| `probe-sunfx.ts` | A/B DirectionalLight intensity 0 vs ×6 | debug |
| `probe-menu-ride.ts` | Owner DEMO+GRAVEL crash through the REAL OptionsMenu UI | debug |
| `probe-real-crash.ts` | Same crash in the owner's REAL headed Chrome (headed-only crash class) | probe, headed |
| `probe-pointerlock.ts` | Pointer-lock acquisition — headless rejects every request | probe, headed |
| `probe-cktraa.ts` | TRAA-vs-cockpit moving-capture smear check | debug |
| `wx-gate.ts` | M1.6 aesthetic-gate frame GENERATOR (not pass/fail): one boot per weather state | probe |

## UX probes (phone/desktop interaction contract)

| Script | Purpose |
|---|---|
| `probe-ui-touch.ts` | Touch-UI gate: every control works on phone/tablet, no overlaps |
| `probe-ux01-uturn.ts` | 180° U-turn on the open road (desktop) |
| `probe-ux02-uturn-touch.ts` | 180° U-turn with a finger (mobile) |
| `probe-ux04-hike-touch.ts` | Hiking on touch: jump works, no keyboard cheatsheet |
| `probe-ux07-dismount.ts` | One-press dismount before an obstacle (desktop) |
| `probe-ux08-brake.ts` | Touch brake at ANY power source |
| `probe-ux10-pause.ts` | Pause with a finger |
| `probe-ux11-settings.ts` | In-ride graphics settings audit fixes, proven |
| `probe-ux15-ble.ts` | BLE on the move: B-key collision, scan chooser, role rows |
| `probe-ux16-gate.ts` | First launch on a phone is no longer a dead-end |
| `probe-ux17-dismount-touch.ts` | Get off the bike with a finger (mobile) |
| `ux-probe-util.ts` | Shared scaffold for the UX probes — infra, not run directly |

## Cockpit / grip debug cluster (M1.5 hand-on-bars work)

| Script | Purpose |
|---|---|
| `ck-shot.ts` | Judge-frame tool: teleport bike to a road class, force watts, screenshot (used by `sbs-all.sh`) |
| `ck-norider.ts` | Shoot cockpit with rider, then bare bar — exposes grip geometry |
| `ck-pose-sweep.ts` | One-boot visual sweep of a single PoseParams knob |
| `probe-grip.ts` | Measurable grip convergence (contact-distance metric, mm) |
| `optimize-grip.ts` | Numeric grip convergence driver |
| `probe-sweep.ts` | seatAlong × seatLift knob sweep, per-combo worst-penetration |
| `probe-bar.ts` | Hand-vs-bar-tube layering in root space (mm) |
| `probe-horn.ts` | Brake-hood horn position vs posed hand joints |
| `dump-hand-frames.ts` | Numeric dump of the Adventurer hand rig |

## Image utilities (no GPU)

| Script | Invocation | Purpose |
|---|---|---|
| `diff.ts` | `npx tsx tools/diff.ts a.png b.png` | Amplified |a−b| + fraction over threshold + mean delta |
| `detect-black.mjs` | `node tools/detect-black.mjs in.png outPrefix [vMax] [minPx]` | Near-black cluster detector, paints overlay + crops |
| `measure-grass-blue.mjs` | `node tools/measure-grass-blue.mjs ...` | Bluish-pixel fraction in a band ROI (gate metric) |
| `montage-grid.mjs` | `node tools/montage-grid.mjs ...` | Labeled N-image grid montage (ASCII labels) |

## Spot / camera search helpers (one-off)

| Script | Purpose |
|---|---|
| `find-spot.ts` | Locate camera poses looking at a target (flowers/water/asphalt/…) at a distance, scored |
| `find-water.ts` | CPU-hydrology scan for good water framings; prints shot args |
| `find-peak-water-spawn.ts` | Road spawns where peak AND water are visible (occlusion-checked) |
| `dump-alp-cams.ts` | Alpine-refs helper: camera candidates on soft trails for sbs shots |
| `owner-cams.sh` | The three mandatory water-change repro cams (session-6 disaster poses) |
| `herotris.ts` | Hero lod-0 build time + tri split per species (CPU) |
| `vegtris.ts` | Per-species per-LOD triangle counts for the veg pools (CPU-only) |

## Device / media / infra

| Script | Invocation | Purpose | Needs |
|---|---|---|---|
| `tacx-cap.ts` | `npx tsx tools/tacx-cap.ts status\|probe\|mark\|dump\|count\|ui\|shot` | Tacx vendor-service capture CLI over CDP to the live APK WebView | adb + `adb forward tcp:9333` |
| `record-demo.ts` | `npx tsx tools/record-demo.ts` | 20 s road-bike demo video generator (random spawn) | gpu |
| `shot-settings.ts` | `npx tsx tools/shot-settings.ts` | Screenshot every graphics-settings tab | gpu |
| `debug-telemetry-server.ts` | `npx tsx tools/debug-telemetry-server.ts` | CORS telemetry sink; `?debug=1` devices POST boot/crash info here | node |
| `launch.ts` | import only | Shared LAAS URL builder + original launcher | infra |
| `launch-gpu.ts` | import only | GPU-asserting Playwright launcher (Linux/NixOS + Mac fallback) | infra |
| `sbs-all.sh` | `bash tools/sbs-all.sh <tag> [port]` | Three judge frames (road/gravel/mtb) + sbs montages vs references | gpu, ImageMagick |

## Prune candidates (owner review — not deleted unilaterally)

Single-bug diagnostics whose bugs are closed; confirm the bug stayed closed
before removing:

- `probe-csm.ts`, `probe-csm2.ts`, `probe-csm3.ts`, `probe-state.ts`,
  `probe-sun.ts`, `probe-sunfx.ts`, `probe-moving.ts` — CSM/shadow-loss debug.
- `probe-cloudlag.ts`, `probe-horizon.ts` — closed artifact repros.
- `probe-line.ts`, `probe-terrace.ts`, `probe-wetmargin.ts` — terrain/water
  transect triage for closed fronts.
- `probe-menu-ride.ts` — superseded by `probe-real-crash.ts` for the same bug.
- `dump-hand-frames.ts`, `probe-bar.ts`, `probe-horn.ts` — hand-rig numerics
  for the closed M1.5 grip work (keep `probe-grip.ts`/`ck-shot.ts` — the
  metric and the judge frame).
