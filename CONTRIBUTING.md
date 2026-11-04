# Contributing

LAAS is a fully procedural open world / indoor-cycling simulator built on three.js
`WebGPURenderer` + TSL/WGSL, TypeScript strict. This file is the contributor
on-ramp: prerequisites, the verified command map, and what runs where.

## Prerequisites

| Requirement | Why |
|---|---|
| Node 22+ (`>=22`, see `.nvmrc` / `engines`) | Build + test toolchain |
| npm (bundled with Node) | Only package manager used here |
| Google Chrome 113+ with WebGPU | Required to *run* the app, probes, and gates. Not needed for `typecheck`/`npm test`. Safari/Firefox unsupported — no WebGL fallback by design. |
| `just` (optional) | Convenience runner (`just --list`). Every recipe wraps an npm command or a shell pipeline documented below. |
| Android SDK at `~/Android/Sdk` + Java 21 + adb | Only for the APK/deploy recipes — the owner's device pipeline, not a contributor prerequisite. |

Setup:

```
nvm use            # picks up .nvmrc (22); or install Node 22+
npm install        # or `npm ci` for a lockfile-exact install
```

## Command map

Every command below is taken verbatim from `package.json` / `Justfile` — no
invented commands.

| Task | Command | Environment |
|---|---|---|
| Typecheck (the base gate) | `npm run typecheck` | anywhere |
| Unit tests (vitest) | `npm test` / `npm run test:watch` | anywhere |
| Dev server | `npm run dev` → http://localhost:5173 | needs Chrome 113+ w/ WebGPU to view |
| Production build | `npm run build` (tsc + vite) | anywhere |
| Preview the build | `npm run preview` → :5174 | needs Chrome to view |
| Screenshot | `npm run shoot` (`tsx tools/shoot.ts`) | GPU + Playwright Chromium |
| Image diff | `npm run compare` (`tsx tools/compare.ts`) | sharp |
| Visual gates | `npm run gates:grass` / `gates:perf` / `gates:visual` / `gates:turnpicker` / `gates:roads` | GPU + Chromium, **not CI-safe** |
| Smoke tier | `npm run smoke` (`tsx tools/smoke.ts`) | **CI-safe** — tier A needs only Chrome; tier B runs when a real GPU exists. Owner-side for now: wiring it into `ci.yml` needs a GitHub token with the `workflow` scope, which the repo's current credentials lack |
| Probes | `npx tsx tools/probe-*.ts` (~80 scripts) | GPU + Chromium, **not CI-safe** |

`just` convenience recipes (all wrap the above plus shell glue):

- `just run` — dev server; open in your own Chrome.
- `just run-nixos` / `just run-rxgpu` — same, but launches a dedicated Chrome
  profile with `--enable-unsafe-webgpu --enable-features=Vulkan` for boxes where
  WebGPU isn't on by default.
- `just run-lan` / `run-samsung` / `run-pixel` — `LAN=1` dev server for
  phones/tablets. WebGPU + Web Bluetooth require a **secure context**, which a
  LAN IP over plain HTTP is not: on each client browser, once, open
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
  `http://<IP>:5173`, relaunch, then open `http://<IP>:5173/?nogate=1`.
- `just stop` — free ports :5173/:5174.

Owner-only pipeline (assumes `~/Android/Sdk`, Java 21, adb-connected devices):

- `just linux-binary` — Electron (bundled Chromium) AppImage into `dist-electron/`.
- `just android-apk` — offline APK: `ANDROID_APK=1` vite build bundled into the
  shell, served from a 127.0.0.1 loopback inside the app.
- `just serve-dist` / `deploy-web` / `deploy-apk` / `shots` / `release` —
  device deployment over adb. See `docs/PACKAGING.md`.

## What runs where

| Surface | Coverage |
|---|---|
| CI (`.github/workflows/ci.yml`, every push/PR) | `npm ci` → `npm run typecheck` → `npm run build` → `npm test` |
| Owner hardware only | All `gates:*`, `probe-*`, `shoot`/`compare` — they need a WebGPU-capable GPU driving Chromium (Playwright). GPU gates intentionally do not run in CI (see `tools/probe-real-crash.ts` for the headed-only crash class). |

## Hard-won environment notes

- **Never pass `--use-angle=vulkan`.** WebGPU runs on Dawn's own Vulkan backend;
  adding ANGLE's GL-on-Vulkan opens a second uncoordinated Vulkan client and
  native-crashes the GPU process (SIGFPE), 100% reproducible, headed Chrome only.
  Documented in `Justfile` (run-rxgpu comment) and `tools/probe-real-crash.ts`.
- The production bundle serves under a `/laas/` base path; the APK build uses a
  root-absolute `/` base — never bundle the plain `build` dist into the APK.
- `vite preview` for device deploy must bind `--host 127.0.0.1` (the default
  `[::1]`-only bind refuses IPv4 clients like `adb reverse`).

## Code style

- TypeScript **strict**; zero `any`, enforced by `tsc --noEmit` (also part of
  `npm run build`). Keep it that way.
- No ESLint/Prettier is configured — do not rely on or add bare
  `eslint-disable` comments (their removal is tracked separately).
- Tests live in `tests/` (vitest, pure-logic suites — no WebGPU). New suites
  must produce zero warnings; a warning counts as a failure.
- The world is seed-reproducible (`?seed=N`) — regression work should pin a seed.

## Docs map

- `README.md` — product overview and controls.
- `STATUS.md` — the working log: current state, known issues, measurements.
- `docs/PACKAGING.md` — why Electron + APK (WebGPU/Web Bluetooth constraints).
- `docs/THREE-NOTES.md` — verified three.js/TSL/WebGPU API notes.
- `tools/README.md` — the verification harness index: all 81 scripts
  classified (gate / probe / perf / debug / one-off / infra) with run
  requirements.
