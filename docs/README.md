# docs/ index

Everything under `docs/`, grouped by what it is for. The working memory the
model reads first is [`log/STATUS.md`](log/STATUS.md); this file is the map
for humans. Some documents are written in Russian — marked *(RU)*.

## Engine / world

| File | What it is |
|---|---|
| [ARCHITECTURE-ASSESSMENT.md](ARCHITECTURE-ASSESSMENT.md) | Subsystem-by-subsystem assessment of the LAAS fork for the hike & bike sim: attachment points, the two structural gaps (no CPU surface mirror, no fixed timestep), perf realities. |
| [DELTA.md](DELTA.md) | Reference-gap log: ranked visual deltas vs the UE5-class golden frames per phase, struck through as fixed. |
| [DEVIATIONS.md](DEVIATIONS.md) | Spec items replaced by nearest-feasible implementations, each in Spec/Implemented/Why form (required by the LAAS brief). |
| [THREE-NOTES.md](THREE-NOTES.md) | Verified three.js 0.184 / TSL / WebGPU API notes — appended as each API is checked against `node_modules`, not memory. |

## Ride layer (Project Rando)

| File | What it is |
|---|---|
| [PROJECT_RIDE_v1.md](PROJECT_RIDE_v1.md) | The durable ride-layer brief: pillars, floors, bans, probes P1–P7. Governs the game layer the way `PROJECT_LAAS_v2.md` governs the world. |
| [BLE_ZWIFT_PLAN.md](BLE_ZWIFT_PLAN.md) | The Zwift-grade BLE rebuild plan with real scanned device facts; status PAUSED (2026-07-15) — superseded in part by the shipped `src/ride/ble/` stack. |
| [STRAVA_RECORDING_UX.md](STRAVA_RECORDING_UX.md) | Research and shipped design for the Strava OAuth upload path and the pause/finish ride-recording menu. |
| [TURN_PICKER.md](TURN_PICKER.md) | Turn-picker design: option layout must match junction geometry, turns pre-commit before the node, the bike never teleports. |
| [UX_AUDIT_20.md](UX_AUDIT_20.md) *(RU)* | 20-case UX audit from a veteran virtual-cyclist persona; desktop + Pixel profiles, every claim backed by file:line or a screenshot, P0–P2 priorities. |

## Performance

| File | What it is |
|---|---|
| [PERF-BASELINE.md](PERF-BASELINE.md) | Session-0 dev-box anchor (Ryzen 4650G / Vega 7): the numbers every later perf claim is measured against. |
| [PERF_CPU_WALL_FINDINGS.md](PERF_CPU_WALL_FINDINGS.md) *(RU)* | Measured CPU-wall findings on Tab S8 Ultra (Adreno 730) — the `cpu-wall-teardown` campaign record, saved out of the live journal. |
| [PERF_CPU_WALL_RESULTS.md](PERF_CPU_WALL_RESULTS.md) | Results closing that campaign: `cpu.submit` dominated the ~64 ms tablet frame, and what was done about it. |
| [PERF_FPS_MOBILE.md](PERF_FPS_MOBILE.md) | Mobile FPS *estimate* dossier (Pixel 10 Pro / TBDR). Superseded for ranking — keep only for its file:line map of vegetation/froxel/post code. |
| [PERF_MOBILE_KILLERS.md](PERF_MOBILE_KILLERS.md) *(RU)* | Code-grounded mobile perf autopsy. Partially refuted by the owner's own study — read together with [`log/GPU_CPU_ISSUE_CODEX.md`](log/GPU_CPU_ISSUE_CODEX.md). |
| [PERF_QUALITY_AXES.md](PERF_QUALITY_AXES.md) | Quality-axes campaign: min-preset switch-offs, ultra spending a 5090 budget, and the methodology traps the measurements were paid for in. |
| [ROAD_REALISM_GATES.md](ROAD_REALISM_GATES.md) | Owner-mandated road-realism gates: no high-frequency wiggle, >18% grade held >10 m is red, sane alpine serpentines must pass. Law module: `src/ride/RoadRealismLaw.ts`. |
| [WARPLAN_BLACK_ROADS_GRASS.md](WARPLAN_BLACK_ROADS_GRASS.md) | War plan for the 2026-07-16 artifact batch: black vegetation chunks, road terracing, blue far grass — every fix proven by before/after SBS and locked in by a gate. |

## Packaging & running

| File | What it is |
|---|---|
| [PACKAGING.md](PACKAGING.md) | Android APK + Linux binary decision: ship a full Chromium runtime on every target, and the WebGPU-compute/Web-Bluetooth reasons nothing smaller works. |
| [LAUNCH_AND_DEBUG.md](LAUNCH_AND_DEBUG.md) *(RU)* | Launch & debug runbook: port split (5173 owner / 5174 tooling), desktop and mobile WebGPU recipes, `?debug=1` overlay. |

## Planning

| File | What it is |
|---|---|
| [ROADMAP.md](ROADMAP.md) | PROJECT RANDO roadmap: Phase 0 done, Phase 1 MVP milestone order inside the existing 4×4 km world. |
| [ROADMAP_ROWING_TREADMILL.md](ROADMAP_ROWING_TREADMILL.md) | Unscheduled map for treadmill-driven hiking and rowing/kayaking modes, written post-v0.6.0 — a map, not a commitment. |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | Decision record: every RANDO design question answered by the owner 2026-07-02; answers are binding. |

## Working log (`log/`)

| File | What it is |
|---|---|
| [log/STATUS.md](log/STATUS.md) | Source of truth between sessions: current state, open issues, diagnosis logs, measurements, decision history, rehydration protocol. *(RU/EN mixed)* |
| [log/PROGRESS.md](log/PROGRESS.md) *(RU)* | Per-session progress log with 0–100 plan-completion scoring. |
| [log/HANDOFF_APK.md](log/HANDOFF_APK.md) *(RU)* | Android APK (offline variant B) + Linux binary handoff for the next session. |
| [log/PLAN_NEXT_STEP.md](log/PLAN_NEXT_STEP.md) *(RU)* | War plan for the same packaging push — the paired document to HANDOFF_APK. |
| [log/GPU_CPU_ISSUE_CODEX.md](log/GPU_CPU_ISSUE_CODEX.md) *(RU)* | Owner-commissioned CPU/GPU pipeline diagnosis on Android; refutes PERF_MOBILE_KILLERS item 5. |
| [log/SOUNDS.txt](log/SOUNDS.txt) *(RU)* | Sound-design spec: ~20 base sounds, 6–7 Web Audio synths, licensing-safe source list (CC0 first). |

## Research notes (`notes/`)

| File | What it is |
|---|---|
| [notes/ble-ftms-research.md](notes/ble-ftms-research.md) | M1.4 BLE research: FTMS 0x2AD2 exact layout, per-brand trainer quirks, gear/steering reverse-engineering — spec-conformance first, no hardware needed. |
| [notes/climb-grade-facts.md](notes/climb-grade-facts.md) *(RU)* | Web-sourced climb grades and dimensions used to calibrate `ROAD_CLASSES` (Climbfinder, PJAMM, AASHTO, real Alpine cols). |
| [notes/flythrough-is-not-bike-speed.md](notes/flythrough-is-not-bike-speed.md) | The flythrough moves ~65 m/s (≈227 km/h) = 4–5× bike speed — fine for stress capture, invalid as a bike-speed proxy. |
| [notes/nixos-webgpu-launch-recipe.md](notes/nixos-webgpu-launch-recipe.md) | NixOS headless WebGPU recipe: system Chrome + the exact flag set; always assert adapter identity or SwiftShader silently poisons perf data. |
| [notes/one-boot-many-probes.md](notes/one-boot-many-probes.md) | World gen costs ~47–63 s per boot: probe suites must boot once and jump bookmarks, never boot per shot. |
| [notes/pop-os-target-machine.md](notes/pop-os-target-machine.md) | Remote inspection of the RX 6800 XT play/perf-target box, incl. the gcr-ssh-agent socket needed to reach it. |
