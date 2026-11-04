# OSS Audit — fable5-world-roaming-cycling (LAAS)

Audited: 2026-11-04 · HEAD `42815e2` · auditor: Devin CLI (oss-audit skill)
Scope: full working tree (static inspection) + `npm run typecheck`, `npm run build`, `npm audit` executed. Probe/gate scripts were NOT run — they require a WebGPU-capable GPU + Chrome display; their existence and past output are evidenced by `shots/phase-*` and `STATUS.md`.

## Repository summary

**Stack.** TypeScript (strict, verified zero `any` — `grep -rIn "\bany\b" src` for type positions returns 0) over three.js `0.184.0` WebGPURenderer/TSL/WGSL; Kotlin Android shell (4 `.kt` files, Gradle 8.7 wrapper); Electron desktop shell (`electron/main.cjs`); Vite 6 build. Runtime dep surface is exactly one package (`three`); everything else is devDependencies.

**Entry points.** Web: `index.html` → `src/main.ts` (boot with `browserGate()` fail-loud diagnostics). Desktop: `electron/main.cjs` (loopback server + bundled Chromium). Mobile: `android/` debug APK (in-app `AssetHttpServer` on 127.0.0.1:47862 + WebView/BleBridge). Harness: ~80 scripts under `tools/` (probe-*, gate-*, shoot, compare).

**Package/build.** npm (`package-lock.json`, 199 KB, present and in sync — `npm run build` works). `Justfile` is the real task runner (run/build/package/deploy recipes). No `engines`, no `.nvmrc`; Justfile comment mentions Node 22.

**Automation.** `npm run typecheck` (`tsc --noEmit`) — VERIFIED clean. `npm run build` (tsc + vite build) — VERIFIED 3.83 s, 1.57 MB bundle (one mixed static/dynamic import warning). `npm run gates:*` scripts exist (grass/perf/visual/turnpicker/roads) but need owner hardware. No `.github/` — no CI, no issue/PR templates. No unit-test runner, no linter, no formatter.

**Licensing.** MIT `LICENSE` (Remi Sebastian Kits). **Live problem:** `reference/` (21 MB) and `shots/phase-*` contain third-party game screenshots redistributed under the repo's MIT umbrella. The shipped rider `public/rider/adventurer.glb` is the Quaternius "Adventurer" character (**CC0** — verified via GLB JSON chunk: FBX2glTF generator, `Adventurer_*`/`Backpack` meshes, 5 skins), legally clean but with zero provenance recorded in the tree. The CC-BY 4.0 Woodhead cyclist model exists only in gitignored `assets/blender/` — dev material, never shipped.

**Reproducibility.** World is seed-reproducible (`?seed=N`). Build reproducibility rests on `package-lock.json` + `three` exact pin. DevDeps use `^` ranges. No documented Node version.

**Remotes.** `origin` = github.com/bepcyc/fable5-world-roaming-cycling (public; last push 2026-11-04, `2cabd57..42815e2`). `forgejo` = bepcyc/lees (public, orphan snapshot branch). Git history was scrubbed of owner BLE MACs on 2026-11-04 — verified: `git log --all -G '([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}'` → 0 matches.

**Repo size.** `.git` = 189 MB (history carries `shots/phase-*` PNGs up to 9.3 MB and `reference/`). Working tree `shots/` = 3.9 GB (mostly untracked). 400 tracked files.

**Major risks.** Third-party game captures tracked under the MIT umbrella · no CI/tests on a public repo · 28 audit findings in devDeps · README documents the wrong product (world demo, not the cycling sim).

---

## Correctness

### [P2] Mixed static+dynamic import makes a code-split silently dead
- **Evidence:** `vite build` warning — `src/ride/ble/Transport.ts is dynamically imported by src/main.ts but also statically imported by src/main.ts … dynamic import will not move module into another chunk` (`src/main.ts:43` static + `src/main.ts:234` `await import`).
- **Why it matters:** the dynamic-import intent (lazy-load the fake transport) is defeated; future "optimizations" built on this assumption are fiction. Cheap trap for a contributor.
- **Smallest credible fix:** pick one — either drop the static import and thread types via `import type`, or drop the dynamic import; then delete the now-meaningless split.

### [P2] Dead `eslint-disable` suppressions — no ESLint exists
- **Evidence:** 16 `// eslint-disable-next-line` comments in `src/` + `tools/` (e.g. `src/main.ts:110`, `tools/debug-telemetry-server.ts:42`); `package.json` has no eslint/prettier devDep or config.
- **Why it matters:** the rules they suppress (`no-console`, `no-new-func`, `@typescript-eslint/no-explicit-any`) are enforced nowhere. A contributor reading them assumes a lint pass that cannot run.
- **Smallest credible fix:** either adopt ESLint flat config matching the suppressed rules, or strip the comments and rely on `tsc` (already catches `any` via strict).

No other correctness findings verified at static level.

## Maintainability

### [P1] Verification harness is 80 files of tribal knowledge
- **Evidence:** `tools/` = 80 tracked `.ts/.mjs/.sh` files; only 5 gate/probe entry points are wired into `package.json` scripts; no `tools/README` distinguishes regression gates from one-off debug probes (`probe-real-crash.ts`, `dump-hand-frames.ts`, `ck-pose-sweep.ts`…).
- **Why it matters:** the probes ARE the test suite. A contributor cannot tell which must stay green, which are historical debris, or how to run them (`?limitcap=mobile`, Playwright+WebGPU flags are embedded per-file).
- **Smallest credible fix:** add `tools/README.md` — a table: script → purpose → gate-or-debug → invocation. One hour of work, unlocks the whole harness.

### [P2] Single 1.57 MB JS bundle; chunk warning silenced by config
- **Evidence:** `vite.config.ts:14` `chunkSizeWarningLimit: 4096`; build emits `index-*.js` 1,573.48 kB (470.81 kB gzip) as one chunk.
- **Why it matters:** fine for a WebGPU app, but the raised limit means bundle growth is invisible — nothing will warn again until 4 MB.
- **Smallest credible fix:** vendor-split (`manualChunks: three → vendor`) or accept and note it; lower limit back to ~1.7 MB to re-enable the tripwire.

### [P2] Root directory mixes product docs with model working-memory
- **Evidence:** root has `STATUS.md` (129 KB), `PROGRESS.md` (31 KB), `PLAN_NEXT_STEP.md`, `GPU_CPU_ISSUE_CODEX.md`, `SOUNDS.txt`, `HANDOFF_APK.md`, `CLAUDE.md` (31 KB), `cv.md` (untracked) alongside `README.md`.
- **Why it matters:** a new contributor can't tell canonical docs from the AI's session logs. CLAUDE.md references `.claude/` infra (`telegram/tg-photo.sh`, `hooks/sbs-guard.sh`) that is gitignored — dead instructions for anyone but the owner.
- **Smallest credible fix:** move working logs under `docs/log/` (or `notes/`) and mark CLAUDE.md as owner-agent config, not project doc. Add a one-line pointer in README.

## Testability

### [P1] Zero unit tests, zero test runner — `tsc` is the only automated gate
- **Evidence:** `find . -name '*.test.*' -o -name '*.spec.*'` → 0 files; `package.json` has no test script or framework dep; `Justfile:127` comment: `strict TypeScript check (the repo's only automated gate)`.
- **Why it matters:** nothing protects pure logic (route graph, FTMS parsers, physics) from regression on refactor. Type-checking catches type drift, not behavior.
- **Smallest credible fix:** add vitest + one suite over a pure module (e.g. `src/ride/RouteGraph.ts` or an FTMS/CSC data parser — no WebGPU needed). Wire `npm test` into the future CI job.

### [P1] All behavioral gates require a physical GPU + Chrome — nothing runs in CI
- **Evidence:** `tools/shoot.ts`/probes drive Playwright→Chromium WebGPU; `tools/probe-real-crash.ts` documents a crash that is *headed-only*; `Justfile` LAN/device recipes assume owner hardware (`/home/bepcyc/Android/Sdk`, adb devices).
- **Why it matters:** on a public repo, no outsider can verify a change end-to-end. The harness exists but is single-machine by construction.
- **Smallest credible fix:** document a headless smoke tier: `probe-state.ts` or `shoot.ts` under Xvfb/SwiftShader where possible, and mark which probes CANNOT run headless (the headed-only crash class) in `tools/README.md`.

### [P2] No committed golden outputs or fixtures for the gates
- **Evidence:** `shots/phase-*` are tracked reference shots, but no gate declares expected hashes/baselines in-repo; `tools/compare.ts` diffs against whatever local frames the caller names.
- **Why it matters:** gates are run-and-eyeball, not run-and-assert — the SBS workflow lives in the owner's Telegram loop (per CLAUDE.md), not in the repo.
- **Smallest credible fix:** pick 1–2 canonical gates (e.g. `gates:visual`), commit their baseline frames + thresholds, document the pass/fail command.

## Security

### [P2] Shipped rider GLB has zero provenance — CC0, but undocumented and actively misleading
- **Evidence:** `public/rider/adventurer.glb` (1.9 MB, tracked, loaded at runtime via `src/ride/cockpit/CockpitParts.ts:1074` → `attachRider` → `RiderBody.ts:797`). GLB JSON chunk: FBX2glTF generator, `Adventurer_Feet/Legs/Body/Head` + `Backpack` meshes, 5 skins — the **Quaternius "Adventurer"** character (CC0). Meanwhile the ONLY credits file in the repo area is `assets/blender/cyclist-racing-position.CREDITS.txt` (untracked, gitignored) for a *different* model — Andy Woodhead's CC-BY 4.0 "Cyclist – racing position", which is dev material that never ships and is referenced by no tracked code (`grep cyclist-racing|cyclist-rigged` → 0 hits).
- **Why it matters:** CC0 needs no attribution, so there is no license violation — but a shipped binary asset with no provenance record forced an audit-time misidentification and will do the same to any reviewer or fork. If the Woodhead model (CC-BY, attribution *required*) ever gets swapped in, nothing in the tree would flag the obligation.
- **Smallest credible fix:** `NOTICE`/`CREDITS.md` at root naming Quaternius + the Adventurer pack + source URL + CC0; copy beside the asset (`public/rider/CREDITS.txt`) so it ships into dist; move `assets/blender/*.CREDITS.txt` info for dev-only models into the same file marked "not shipped".

### [P1] Third-party game screenshots tracked under the repo's MIT umbrella
- **Evidence:** `reference/` = 21 MB tracked: `game-image/ref-01..05.jpg`, `game-icons/ref-icon-01..04.jpg`, `02_Silver_Demo_Wallpaper_3840x2160_EN.png`; `shots/phase-2/golden-vs-witcher.png` (8.9 MB) embeds a Witcher 3 frame; `reference/zwift-ux/` (Zwift screenshots) exists untracked but poised to be committed the same way.
- **Why it matters:** MIT LICENSE text covers everything in the repo; redistributing commercial game captures mislabels their rights and invites takedown on a public repo. Provenance is inferred from filenames/docs, not declared anywhere.
- **Smallest credible fix:** two options — (a) move `reference/` + `shots/phase-*` to a gitignored dir + a small fetch script (they are dev-only judging material), also shrinking future clones; or (b) add `NOTICE`/`reference/README.md` listing provenance + "third-party material, not covered by MIT" disclaimer. (a) is cleaner.

### [P1] 28 dependency vulnerabilities (12 high), all in dev tooling
- **Evidence:** `npm audit` (2026-11-04): `28 vulnerabilities (1 low, 15 moderate, 12 high)` — `electron` ≤43.8.0 (6+ high: sandbox escape, permission misattribution), `xmldom` (10, via electron-builder), `brace-expansion` (DoS), `undici` (35 advisories), `sharp`, `vite`, `esbuild`, `tar`. `npm audit fix` resolves the non-breaking subset; vite/electron need version bumps.
- **Why it matters:** runtime surface is clean (one dep), but every contributor installs the vulnerable toolchain; Electron 43 alpha-line itself carries sandbox/permission CVEs that ship in the desktop build.
- **Smallest credible fix:** `npm audit fix` now; bump `vite` → current stable and `electron` ≥43.8.1 (or latest 44/45) in a second pass; re-run `npm run build` + `just linux-binary` smoke.

### [P2] Electron grants every permission and auto-picks the first BLE device
- **Evidence:** `electron/main.cjs:92-100` — `setPermissionCheckHandler(() => true)`, `setDevicePermissionHandler(() => true)`, `select-bluetooth-device → callback(devices[0].deviceId)`. Comment marks it "v1 policy".
- **Why it matters:** contained today (only loopback `dist/` loads, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` — all correct), but the wildcard handlers mean *any* future remote content or a fork gets bluetooth/HID/etc. silently. Footgun architecture.
- **Smallest credible fix:** scope the handlers — allow only `'bluetooth'`/`'hid'`, return false otherwise; keep the first-device shortcut but log it.

### [P2] Telemetry sink binds all interfaces and accepts arbitrary writes
- **Evidence:** `tools/debug-telemetry-server.ts:51` listens `0.0.0.0:5199` with `Access-Control-Allow-Origin: *`, appending POST bodies to `telemetry.jsonl` (2 MB cap). Dev-only, documented.
- **Why it matters:** on a LAN anyone can append garbage to the log; harmless locally, bad pattern to copy.
- **Smallest credible fix:** default bind `127.0.0.1`, `LAN=1` opt-in for `0.0.0.0` (mirrors `vite.config.ts` convention).

### [P2] Personal CV data sits untracked in the public-repo working dir
- **Evidence:** `cv.md` (4.9 KB, untracked — `git status` shows `?? cv.md`), one `git add .` from being pushed to a public repo.
- **Smallest credible fix:** move out of the repo dir or add to `.gitignore`.

**Positive evidence:** tracked-tree + full-history MAC scan clean; `.env` (Sketchfab key) gitignored and untracked; Strava OAuth credentials are user-supplied via `localStorage`, none shipped (`src/ride/strava/StravaConfig.ts:4`); `AssetHttpServer.kt` binds 127.0.0.1-only with a `..` traversal guard; Android BLE permissions are minimal (`neverForLocation`, no FINE_LOCATION).

## Performance

### [P2] Dev server forces `usePolling` file-watching
- **Evidence:** `vite.config.ts:22` `watch: { usePolling: true, interval: 200 }` — deliberate (fsevents misses tool-driven writes, comment says so).
- **Why it matters:** constant dev-time CPU cost; contributors on other setups may not need it.
- **Smallest credible fix:** gate behind env (`POLL=1`) or document the tradeoff in CONTRIBUTING.

No other performance findings confirmed statically — perf work is an active, well-instrumented track (`docs/PERF_*`, F3 HUD GPU timings, `tools/perf-*.ts`, `tools/gate-perf.ts`). The 1.57 MB bundle is covered under Maintainability.

## Observability

### [P1] No logging discipline — 31 bare `console.*` sites, no levels, no crash reporting
- **Evidence:** `grep -rn "console\." src` → 31 hits; no logger abstraction in `src/`; production crash path = `installGlobalErrorHooks` + fail-loud boot UI (good) but no persistent/forwarded error channel.
- **Why it matters:** when a user hits a device-loss crash (documented: `tools/probe-real-crash.ts`, SIGFPE class), nothing reaches the author — the only telemetry is the dev-mode `?debug=1` sink.
- **Smallest credible fix:** tiny `src/core/Log.ts` (level + tag prefix), sweep the 31 sites to it in one pass, keep `console` only in `tools/`.

### [P2] Strong boot diagnostics exist but aren't discoverable
- **Evidence:** `BrowserGate`/`Diagnostics.ts` fail-loud WebGPU probing (README documents the gate); `?debug=1` telemetry → `tools/debug-telemetry-server.ts`; F3 HUD per-pass GPU timings; `docs/LAUNCH_AND_DEBUG.md` exists.
- **Why it matters:** the pieces are good — they're just not linked from README, so users won't find the debug path.
- **Smallest credible fix:** a "Troubleshooting" section in README linking `docs/LAUNCH_AND_DEBUG.md` + `?debug=1` + `chrome://gpu`.

## Documentation

### [P1] README documents the world-generation phase — the cycling sim is invisible
- **Evidence:** README has 1 line matching ride/bike/android/strava (the walk-mode bullet). Yet `src/ride/` = 71 files (largest `src/` subtree, ~43% of tracked source), plus `android/` APK, `electron/` shell, `docs/PROJECT_RIDE_v1.md`, `docs/BLE_ZWIFT_PLAN.md`, `HANDOFF_APK.md`, `SOUNDS.txt`. Repo name is literally "world-roaming-cycling". README also claims "about 21,000 lines … across 90+ commits" — actual `src/` is 52,457 lines across 164 files, 1200+ commits.
- **Why it matters:** the entry document describes a different product than what the repo primarily is now. Every OSS reader lands on a forest demo doc and misses BLE/Strava/APK entirely.
- **Smallest credible fix:** restructure README: LAAS engine (as-is, condensed) + ride mode (sensors, routes, Strava, HUD) + surfaces (web/Electron/APK) + `just` commands + license/credits links.

### [P1] No contributor surface at all: no CI, no CONTRIBUTING, no templates
- **Evidence:** no `.github/` directory; no `CONTRIBUTING.md`; `npm run` + `just` commands split across two manifests; Node version documented nowhere (no `engines`, no `.nvmrc`; Justfile:40 mentions "Node 22" in an error message).
- **Why it matters:** public repo + zero on-ramp = drive-by contributions bounce; nothing verifies a PR.
- **Smallest credible fix:** `.github/workflows/ci.yml` running `npm ci && npm run typecheck && npm run build` (all verified working today); `CONTRIBUTING.md` with Node 22 + `just`/`npm` map + GPU note; `.nvmrc` = `22`.

### [P2] Missing standard community files
- **Evidence:** no `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CITATION.cff`, `.env.example`; LICENSE not mentioned in README body; local tags `v0.4.0+` unpushed (remote has only v0.2.0/v0.3.0).
- **Smallest credible fix:** `SECURITY.md` (one paragraph — personal project scope + disclosure route); `.env.example` with `BLENDERMCP_SKETCHFAB_API_KEY=`; push or prune tags; CHANGELOG optional — `STATUS.md` already acts as decision log, so generate it from tags later if wanted.

### [P2] docs/ is deep but unindexed
- **Evidence:** 24 files in `docs/` (ARCHITECTURE-ASSESSMENT, PACKAGING, PERF_×5, ROAD_REALISM_GATES, TURN_PICKER, UX_AUDIT_20…) + `docs/notes/` (6 research notes) — high-quality, but no index; README links only 3 of them.
- **Smallest credible fix:** `docs/README.md` index grouped by topic (engine / ride / perf / packaging / research).

---

## File-level change list

| Priority | Path | Action | Reason |
|----------|------|--------|--------|
| P2 | `NOTICE` (or `CREDITS.md`) | add | provenance for `public/rider/adventurer.glb` (Quaternius Adventurer, CC0) + mark Woodhead cyclist files as dev-only/not shipped |
| P1 | `reference/` + `shots/phase-*` | remove or document | third-party game captures redistributed under MIT; move to gitignored+fetch or add provenance NOTICE |
| P1 | `README.md` | modify | document ride mode, BLE/Strava, APK, Electron, `just`, license+credits; fix 21k→52k LOC staleness |
| P1 | `.github/workflows/ci.yml` | add | `npm ci && npm run typecheck && npm run build` — all verified green today; zero current CI on a public repo |
| P1 | `CONTRIBUTING.md` | add | Node 22, npm/just command map, GPU-gate caveat, link tools/README |
| P1 | `tools/README.md` | add | index of 80 harness scripts; mark gates vs one-off debug and which need headed Chrome |
| P1 | `package.json` + `package-lock.json` | modify | `npm audit fix` (28 vulns / 12 high in devDeps); add `engines.node>=22`, `license`, `repository`, `test` script |
| P1 | `tests/` (e.g. `tests/route-graph.test.ts`) | add | zero unit tests; start with a pure-logic module under vitest |
| P2 | `src/main.ts` | modify | resolve static+dynamic import of `./ride/ble/Transport` (dead code-split) |
| P2 | `electron/main.cjs` | modify | scope `setPermissionCheckHandler`/`setDevicePermissionHandler` to bluetooth instead of wildcard-true |
| P2 | `tools/debug-telemetry-server.ts` | modify | bind 127.0.0.1 by default; `LAN=1` opt-in like vite config |
| P2 | `src/core/Log.ts` | add | log-level wrapper; sweep the 31 `console.*` sites in `src/` |
| P2 | `SECURITY.md` | add | disclosure + support-scope policy for a public repo |
| P2 | `.env.example` | add | documents `BLENDERMCP_SKETCHFAB_API_KEY` (only consumer: blender-mcp) |
| P2 | `.nvmrc` | add | pin Node 22 (currently only in a Justfile error string) |
| P2 | `vite.config.ts` | modify | env-gate `usePolling`; lower `chunkSizeWarningLimit` or add `manualChunks` vendor split |
| P2 | `docs/README.md` | add | index for 24-file docs/ + docs/notes/ |
| P2 | `cv.md` | remove/move | untracked personal CV one `git add .` from a public push |
| P2 | `docs/log/` or `notes/` | move | STATUS/PROGRESS/PLAN_NEXT_STEP/GPU_CPU_ISSUE/SOUNDS/HANDOFF_* out of root |

## Do first / do later

**Do first (this iteration):**
1. Decide `reference/`/`shots/phase-*` fate (move-out vs provenance NOTICE) — the only real license exposure + biggest chunk of the 189 MB history.
2. `npm audit fix` + bump vite/electron; re-run `npm run build`.
3. `.github/workflows/ci.yml` — the repo's two green commands become a PR gate; near-zero cost.
4. README restructure — product truth (cycling sim) in the entry doc.

**Do later (hardening):**
- `NOTICE`/`CREDITS.md` — Quaternius Adventurer provenance (CC0, not legally required but prevents re-identification churn); vitest + first pure-logic suite; tools/README harness index; headless-smoke tier for probes.
- Electron permission scoping; telemetry bind; `src/core/Log.ts` sweep.
- SECURITY.md, .env.example, .nvmrc, docs index, root-doc cleanup, tag push/prune.

## Verification log (commands actually run)

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | PASS, clean |
| `npm run build` | PASS 3.83 s; dist = 1,573 kB (470 kB gz); 1 dynamic-import warning |
| `npm audit` | 28 findings (1 low / 15 mod / 12 high); `audit fix` available |
| `git grep` MAC pattern (tree) | 0 matches |
| `git log --all -G` MAC pattern (history) | 0 matches |
| `git branch --no-merged main` | 1 (`lees-snapshot` — intentional orphan, not a leak) |
| `git ls-files` secret/tracked check | `.env`, `telemetry.jsonl`, `android/local.properties` all untracked |
| `find` test files | 0 `*.test.*`/`*.spec.*` |
| Probe/gate scripts | NOT RUN — require WebGPU GPU + headed/headless Chrome on owner hardware; recorded as environment blocker, not guessed |

**Assumptions recorded:** `reference/` image provenance inferred from filenames + docs (Witcher/Zwift/game-image naming) — treated as third-party commercial captures; if any are self-rendered, the P1 row narrows to the genuinely external ones. npm audit counts are a 2026-11-04 snapshot. The Forgejo `lees` snapshot contains the same shipped files, so the attribution/reference findings apply there too.
