# PROJECT RANDO — v1
### First-person hike & bike exploration sim on the LAAS world — the durable brief
*(rando — from* randonnée*: both a long hike and a long ride. File kept as `PROJECT_RIDE_v1.md`.)*

---

## What this is

A personal browser game for the owner and a small circle of friends, built on the LAAS fork: explore a procedural world in first person **on foot** and **on three bikes** (road / gravel / MTB) over a generated road & trail network with tagged surfaces. Bike riding is **Zwift/MyWhoosh-class**: real BLE sensors (trainer/power, cadence, heart rate) drive the in-game bike; dashboards show real data. Chrome + WebGPU + desktop only — inherited and accepted.

The LAAS spec (`PROJECT_LAAS_v2.md`) still governs the *world's* visual quality. This brief governs the *game layer* on top. `STATUS.md` remains the cross-session working memory; `PROGRESS.md` tracks per-session progress; spec deviations go to `docs/DEVIATIONS.md` in the same Spec/Implemented/Why format.

## The pillars

**A. The LAAS bar is the floor.** The world already looks like `docs/readme-hero.jpg`; nothing this project adds may pull it down. Никогда не тяп-ляп: new visible things (roads, cockpit, HUD, weather) ship **выверенными и эстетичными** — polished and composed, not necessarily complex. Primitive/placeholder visuals never survive a closed milestone.

**B. Natural physics.** Никакой противоестественной физики: real gravity (9.81 m/s², not game-feel values), real-scale speeds and accelerations per mode/surface/gradient, natural fields of view, no arcade motion effects. *Known inherited deviation to re-judge in Phase 1 against this pillar: walk mode uses gravity 22 m/s² and a +6° sprint-FOV kick (`src/core/FlyCamera.ts:31,42`) — either retune to natural or record an explicit approved deviation.*

**C. Real-data honesty.** Dashboards show values from real sensors. The demo source exists (development, showcase) but is **always visibly badged DEMO** and never writes ride stats. Performance is reported as **average + 1% low** with resolution/preset/machine context — never a bare EMA number.

**D. One-file surface truth.** The surface × mode matrix lives in exactly one data file. Per surface: allowed/degraded/blocked per mode, rolling resistance, max speed, grip, sound id, weather sensitivity, stall risk. Physics, HUD warnings, audio, and the road generator all read it; no constants scattered through code.

**E. Verification first.** Headless physics probes are first-class citizens next to the screenshot harness. A movement/physics milestone without green probes is not closed, "feels right" is not an acceptance criterion — it is the *last* check, after the numbers pass.

## Hard floors

| Dimension | Floor |
|---|---|
| World | The existing 4×4 km LAAS world (MVP); GPX-corridor streaming in Phase 2 |
| Route network | ≥ 30 km of distinct rideable routes with junctions; surfaces tagged: asphalt, fine gravel, coarse gravel, dirt, singletrack; off-network terrain has its own classes (grass, rock, mud, shallow/deep water, snow…) |
| Modes | Hike: keyboard/mouse roaming, no sensors required. Road / gravel / MTB: exist **only** with a live BLE power source connected (Zwift principle); route-following control, no free WASD on bikes |
| Sensors | Web Bluetooth: FTMS trainer (incl. control point), cycling power, CSC speed/cadence, heart rate; synthetic demo source for development — the same seam the probes drive |
| Dashboard | Zwift-style toggleable cards; basic set NOW: speed / cadence / heart rate (implemented, `src/ride/RideHud.ts`); next: power, gradient, distance, surface warning |
| Cockpit | First person, no full body; on bikes: handlebars, hands, bike computer (Phase 1, after physics) |
| HUD safety | Warning fires **before** terrain impassable for the current mode |
| Weather (MVP) | Visual-only states: dry / rain / after-rain / fog + existing wind; physics coupling is Phase 3, as matrix modifiers |
| Audio (MVP, last) | Small CC0 sample set + cheap procedural synthesis, modulated by speed and surface (approved deviation from LAAS's zero-asset rule) |
| Performance | Visuals-first; FPS measured honestly (avg + 1% low) against `docs/PERF-BASELINE.md`; a dedicated high-speed pass (40–50 km/h stress) is a planned later milestone |

## Movement model (target design)

- **Hike** — goes almost anywhere; mud, water, steepness, rough ground slow it down; deep water blocks.
- **Road bike** — asphalt + fine gravel only; anything worse degrades quickly toward a stop.
- **Gravel bike** — asphalt, fine + coarse gravel, dirt; limited mud; rides through shallow (≤ ~10 cm) streams.
- **MTB** — best off-road capability; blocked by extreme slopes, deep water, large obstacles, deep mud.
- Bike speed comes from a natural power solver: `P = (Crr·m·g·cosθ + m·g·sinθ + ½ρ·Cd·A·v²)·v`, Crr/grip/caps from the matrix, gradient from the real heightfield; the power (or speed-sensor) input comes from the sensor seam.

## Banned outcomes — instant fail

- Any visual downgrade without explicit owner approval — including "temporary" primitive art in a closed milestone, LOD pulls, density cuts, fog-as-cover (LAAS bans inherited wholesale).
- Unnatural physics or camera: wrong gravity, impossible acceleration/braking, distorted FOV, speeds that ignore surface/gradient.
- Surface/mode constants outside the one matrix file.
- Roads clipping through terrain, floating over valleys, or with vegetation growing through them; junctions that dead-end into un-tagged ground.
- Physics tuned only by eye — every movement behavior has a probe with a tolerance.
- Fake dashboard numbers presented as real; demo source without the DEMO badge; bike mode usable without a live power source outside an explicitly hidden dev flag.
- FPS claims without avg + 1% low + resolution + preset + machine + static/moving context.
- SwiftShader/llvmpipe silently standing in for the real GPU in any measurement (assert adapter identity).

## Verification policy

**Screenshot harness** (inherited, stays): bookmarks + reference comparisons + **moving captures at bike speed** added to the suite (the flythrough capture pattern, `tools/probe-moving.ts`, extended to ride paths once bikes exist).

**Headless physics probes** (new, first-class). Fixed-timestep ride physics driven through the synthetic sensor source; adapter identity asserted; `--framealign`/`--lockexp`/`--wind 0` discipline for any pixel comparison (STATUS.md measurement methodology). Named acceptance probes:

- **P1 mud-stop** — road bike entering deep mud at matrix top speed decelerates to a stop within the matrix-derived distance ± 15%.
- **P2 top-speed** — each mode at 200 W on flat asphalt reaches the solver-reference speed ± 2%.
- **P3 ford** — gravel bike crosses a ≤ 10 cm stream; the same crossing at deeper water blocks/stalls it.
- **P4 slope-block** — MTB is blocked above the matrix slope limit; hike passes the same slope, slowed per matrix.
- **P5 HUD-warning** — the impassable warning fires ≥ 2 s (at current speed) before the zone boundary.
- **P6 sensor-dropout** — power source disconnect mid-ride → bike coasts to a natural stop, reconnect UI appears, no crash, no ghost power.
- **P7 demo-badge** — whenever the demo source is active, the DEMO badge is present in the DOM (already covered by the session-0 HUD verify probe).

Probe tolerances live next to the matrix they test. A milestone's acceptance criteria name their probes explicitly (see `docs/ROADMAP.md`).

**Performance tracking**: every perf-relevant milestone re-runs the baseline suite (same bookmarks + a moving sample) and appends to `docs/PERF-BASELINE.md`. Regressions against the previous entry require a written cause.

## Operating instructions

- Build in the LAAS idiom: TypeScript strict, zero `any`, TSL/WebGPU per `docs/THREE-NOTES.md` (authoritative over training memory), constants named at module tops, subsystems registered on `engine.onUpdate` respecting the mover-first contract (`src/main.ts:52-57`).
- The surface matrix, sensor seam (`src/ride/Sensors.ts`), and probe suite are load-bearing interfaces — change them deliberately, version them in STATUS.md.
- Inherited LAAS bugs live in the assessment ledger (`docs/ARCHITECTURE-ASSESSMENT.md` §6); they are not this project's milestones unless they block one.
- Update `STATUS.md` (cross-session memory) after every meaningful step; append to `PROGRESS.md` (per-session 0–100) roughly once per milestone.
