# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow tags.
`docs/log/STATUS.md` remains the detailed decision log; this file is the
per-release summary CI cuts release notes from.

## [0.9.0] — 2026-11-04

The open-source readiness and hardening pass, plus the road-realism and
post-processing bug sweep since v0.8.0.

### Added
- GitHub Actions CI (`npm ci` + typecheck + build + vitest) on every push.
- `npm run smoke` — headless/CI-safe smoke tier (`tools/smoke.ts`).
- Leveled logging facade `src/core/Log.ts` — 31 bare `console.*` sites swept.
- Golden baselines for `gates:grass` (`tests/baselines/baselines.json`).
- Tag-driven release CI: Android APK + Linux AppImage + release notes from
  this changelog, on GitHub and Forgejo.
- Docs: `OSS_AUDIT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.env.example`,
  `NOTICE` + `public/rider/CREDITS.txt` (Quaternius Adventurer CC0),
  `docs/README.md` index for the whole docs tree, `tools/README.md` harness
  index, README restructured to document the cycling sim.

### Changed
- Electron permission handlers scoped to a bluetooth allowlist; WebBluetooth
  blink flag enabled (was default-grant for everything).
- Telemetry sink binds loopback by default (`LAN=1` to expose).
- Vite `usePolling` file-watching gated behind `POLL=1`.
- three.js split into a vendor chunk; chunk-size tripwire re-armed.
- Working-memory files moved to `docs/log/`; Node pinned to >=22.

### Fixed
- Post: black vegetation slivers (grade NaN from saturation extrapolation);
  `ablate=bloom` black frame; blue far-grass carpet (silver-wash-cut);
  flower carpets washed out (emissive 0.72→0.35).
- Roads: anti-zigzag chain pass + min-radius floors + chord-straighten
  finisher (`RoadRealismLaw`); singletrack maxGrade 0.20→0.17.
- `npm audit`: 28 findings (12 high) → 15 (0 high).
- Dead dynamic import of `ride/ble/Transport`; dead eslint-disable comments.

### Security
- `SECURITY.md` disclosure policy; permission allowlist; loopback telemetry
  default; third-party reference/dev screenshots untracked (license hygiene).

## [0.8.0] — 2026-07-17

BLE UX redesign wave on top of v0.6.0.

- Role-card pairing hub + modal device choosers (reference-pattern redesign).
- ERG mode, virtual gears, brake resistance feedback on trainers.
- Zombie-READY liveness watchdog, picker refresh, amber in-flight stages.
- Fixed show-all scan degrading to saved-MACs-only (address filters now ride
  alongside service filters, not instead of).
- Touch hint for the manual power source; sensor-lost banner suppressed
  while the hub is open.

## [0.6.0] — 2026-07-17

The connectivity release.

- Complete multi-machine BLE support, session recording formats
  (.fit/.tcx/.csv/.json), file replay.
- Strava activity upload (OAuth + FIT upload + status polling) and the
  pause/finish ride-recording menu with sync.
- Roadmap for treadmill-driven hiking and rowing/kayaking (`docs/ROADMAP_ROWING_TREADMILL.md`).

## [0.5.1] — 2026-07-17

- Seven Android-run blockers in one pass: BLE roles, solver torque, menus,
  touch dismount, Tacx rediscovery.

## [0.5.0] — 2026-07-17

- Fixed rain reading as a frost-like veil on tree crowns (dim streaks over
  canopy); added `?ablate=rain`.

## [0.4.0] — 2026-07-14

- Offline Android APK (variant B): whole `dist/` bundled in the APK, served
  from a 127.0.0.1 loopback in a Chrome Custom Tab; landscape lock; BLE on
  Android via the native bridge.

## [0.3.0] — 2026-07-14

- Mobile launch + on-device debug: `preset=min`, boot diagnostic overlay,
  reverse telemetry channel (`?debug=1` + `tools/debug-telemetry-server.ts`).

## [0.2.0] — 2026-07-14

- Alpine reference pass: sky color/temp match, ridge-first mountains,
  dead-end road gate.

## [0.0.1] — 2026-07-04

- First tagged state of the LAAS fork: procedural 4×4 km WebGPU world,
  hike mode, early ride layer on generated roads.

[0.9.0]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.6.0...v0.8.0
[0.6.0]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bepcyc/fable5-world-roaming-cycling/compare/v0.0.1...v0.2.0
[0.0.1]: https://github.com/bepcyc/fable5-world-roaming-cycling/releases/tag/v0.0.1
