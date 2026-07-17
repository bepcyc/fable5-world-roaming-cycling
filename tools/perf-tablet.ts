/**
 * Perf harness — THE REAL TABLET (Galaxy Tab S8 Ultra / SM-X900, Adreno 730).
 *
 * This is the campaign's PRIMARY harness. tools/perf-mobile.ts measures a
 * *proxy* of the mobile profile on this desktop box; this one measures the
 * actual device the owner uses, over adb + CDP.
 *
 * WHY THIS EXISTS — fps is honest HERE and nowhere else:
 *   On the desktop box the mobile profile is CPU-WALLED (GPU ~2.4 ms of a ~23 ms
 *   frame; dpr 0.2 -> 1.5 == 56x the pixels moved avg fps by 0.1). Desktop fps is
 *   therefore BLIND to GPU wins, which is why perf-mobile.ts has to report
 *   per-pass GPU ms as a proxy (its "Trap 1").
 *   The tablet is genuinely GPU-bound: 0.49 MEGAPIXEL (888x554) at 5-7 fps on an
 *   Adreno 730 cannot be a fill problem — it is per-frame compute + geometry.
 *   **On this device fps IS the metric.** Trap 1 does NOT apply here; do not
 *   reflexively swap to GPU ms and do not lower dpr further, it is not the wall.
 *
 * TRAPS THAT STILL APPLY (from .claude/skills/benchmark-fps/SKILL.md):
 *   - Trap 4 (per-frame counters): drawCalls oscillates 553..995 BY DESIGN
 *     (CsmCached refreshes one cascade/frame; cloud shadow re-bakes ~2.5 s). This
 *     tool samples EVERY frame and reports the window MEAN. Never a single read.
 *   - Trap 5 (stray chromes): not applicable to the device, but the desktop's
 *     vite server must be alive; we assert reachability FROM THE DEVICE.
 *   - Trap 2 (vsync): on Android the display is 60/120 Hz and we CANNOT disable
 *     vsync. At 5-7 fps we are nowhere near the cap, so the meter is live — but
 *     the gate is kept: if fps ever approaches the refresh with near-zero
 *     variance, the run is void. `meterValid` carries that verdict.
 *
 * TABLET-SPECIFIC TRAPS THIS TOOL GATES (neither is in the desktop harness):
 *   1. **rAF only runs in the FOREGROUND.** A backgrounded/screen-off Chrome
 *      throttles rAF to ~0, which reads as a catastrophic "regression" that is
 *      pure measurement error. We wake the device, foreground Chrome via
 *      `am start`, and assert mCurrentFocus is Chrome.
 *   2. **Thermal throttling.** An Adreno 730 under sustained load downclocks; a
 *      later run reads slower for reasons that have nothing to do with the code.
 *      Battery temperature + level are recorded BEFORE and AFTER every run, so a
 *      thermal-poisoned round can be spotted instead of believed.
 *
 * STALE BUNDLE — the trap that cost hours today:
 *   Chrome REUSES the tab and will happily keep running the OLD code. We always
 *   Page.reload({ignoreCache:true}) and PRINT the entry script. Note the dev
 *   server (5176) is `vite dev`, which serves the working tree as unbundled ES
 *   modules — the entry is always `/src/main.ts`, there is NO index-<hash>.js to
 *   compare (that only exists in a built dist/, e.g. the APK's loopback server).
 *   So for dev rounds the honest staleness guard is `srcFingerprint`: a sha256
 *   over every src/**\/*.ts. If that changes between rounds, the code changed; if
 *   it did not, the round measured identical code. Both are reported.
 *
 * Usage:
 *   npx tsx tools/perf-tablet.ts --label baseline
 *   npx tsx tools/perf-tablet.ts --label no-ao --url-extra "ablate=ao"
 *   npx tsx tools/perf-tablet.ts --label grass1536 --warmup 10000 --measure 10000
 *
 * Writes shots/wip/perf-tablet-<label>.json + .png (device screencap, fps
 * readout visible).
 */

import { execFile, execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/* ---- THE FIXED MEASUREMENT URL ------------------------------------------
 * Identical every run or the numbers are not comparable.
 *  - cam=  pins an explicit fly pose (the same spot as the desktop harness) —
 *          no bike, no drift, deterministic.
 *  - nosplash=1 trips GameMenu.shouldBypass (GameMenu.ts:34) so the tap-to-start
 *          gate is skipped and NO human tap is needed.
 *  - hud is deliberately UNSET: Params.ts:53 makes hud=false, and HUD.ts:45
 *          keeps the always-on minimal "N fps" readout visible (the full F3
 *          panel would replace it). That readout is what the owner reads off
 *          the screenshots.
 */
export const SPOT_CAM = '-870,182.7,862,1.69,0.1';
const ORIGIN = process.env['LAAS_TABLET_ORIGIN'] ?? 'http://127.0.0.1:5176';
const BASE_PARAMS = [
  'scene=world',
  'seed=1',
  'preset=min',
  'dpr=0.6',
  'T=14',
  'freeze=0',
  'nosplash=1',
  `cam=${SPOT_CAM}`,
];

const ADB = join(process.env['ANDROID_HOME'] ?? join(homedir(), 'Android/Sdk'), 'platform-tools/adb');
const CDP_PORT = 9223;
const DEV_PORT = 5176;

/* ---- APK mode (--apk) ----------------------------------------------------
 * Measures the SHIPPED offline APK instead of the vite dev server. Three things
 * differ from the dev-server path and each one is load-bearing:
 *
 *  1. ORIGIN is the app's OWN loopback server (AssetHttpServer.kt, port 47862),
 *     serving the bundled dist/. There is no `adb reverse` and no dev server to
 *     reach — asserting the desktop's vite is up would be meaningless here.
 *  2. The CDP socket is `webview_devtools_remote_<pid>`, NOT
 *     `chrome_devtools_remote`. The pid is the app's, so it changes every launch
 *     and the forward has to be re-pointed per run.
 *  3. The URL is not passed with `-d`; MainActivity owns the origin (it knows
 *     the bound port) and takes the query via `--es params`. Both the WebView
 *     and the Custom Tab path honour that extra, which is what makes the A/B
 *     legitimate: identical URL, identical preset, only the host differs.
 */
const APK_PKG = 'com.bepcyc.laas';
const APK_PORT = 47862;

/* ---- adb helpers --------------------------------------------------------- */

function adb(args: string[], timeout = 30_000): string {
  return String(execFileSync(ADB, args, { encoding: 'utf8', timeout })).trim();
}

/** Device-side shell. Kept separate so quoting stays obvious at call sites. */
function adbShell(cmd: string, timeout = 30_000): string {
  return adb(['shell', cmd], timeout);
}

interface DeviceState {
  model: string;
  release: string;
  batteryPct: number;
  tempC: number;
  focus: string;
  chromeForeground: boolean;
  laasForeground: boolean;
}

/** Battery temp is the thermal-throttle tell; focus is the rAF tell. */
function readDevice(): DeviceState {
  const model = adbShell('getprop ro.product.model');
  const release = adbShell('getprop ro.build.version.release');
  const batt = adbShell('dumpsys battery');
  const level = Number(/level:\s*(\d+)/.exec(batt)?.[1] ?? -1);
  const temp = Number(/temperature:\s*(\d+)/.exec(batt)?.[1] ?? -1) / 10;
  let focus = '';
  try {
    const win = adbShell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -2');
    focus = win.replace(/\s+/g, ' ').trim();
  } catch {
    /* focus is a gate, not a hard requirement */
  }
  return {
    model,
    release,
    batteryPct: level,
    tempC: temp,
    focus,
    chromeForeground: /chrome/i.test(focus),
    laasForeground: new RegExp(APK_PKG.replace(/\./g, '\\.'), 'i').test(focus),
  };
}

/** Device shell for reporting fields only — a missing OEM command must annotate
 *  the record, never abort a measured run. */
function safeShell(cmd: string): string | null {
  try {
    return adbShell(cmd).trim();
  } catch {
    return null;
  }
}

/** The app's pid — the WebView CDP socket is named after it, so this must be
 *  re-read on every launch rather than cached. */
function apkPid(): number {
  const out = adbShell(`pidof ${APK_PKG} || true`).trim();
  const pid = Number(out.split(/\s+/)[0] ?? 0);
  if (!pid) throw new Error(`${APK_PKG} is not running (pidof empty) — did am start fail?`);
  return pid;
}

/** Wake + tunnels. NEVER reboots, never touches lock/power settings — the owner
 *  cannot recover a locked tablet remotely, so this stays strictly read-only on
 *  device config (stay_on_while_plugged_in / screen_off_timeout are already set
 *  and are NOT modified here). */
function ensureDevice(apkMode = false): void {
  const devices = adb(['devices']);
  const online = devices.split('\n').slice(1).filter((l) => /\tdevice$/.test(l.trim()));
  if (online.length === 0) {
    throw new Error(
      `no adb device online:\n${devices}\n` +
        `if adb hung: adb kill-server && adb start-server (it fixed this twice today)`,
    );
  }
  adbShell('input keyevent KEYCODE_WAKEUP');
  if (apkMode) return; // socket forward happens post-launch (needs the pid)
  // Tunnels are idempotent; re-adding a live one is a no-op.
  adb(['reverse', `tcp:${DEV_PORT}`, `tcp:${DEV_PORT}`]);
  adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote']);
}

/** Point the CDP tunnel at whichever engine hosts the sim this run.
 *  WebView   -> webview_devtools_remote_<pid>  (in OUR process)
 *  CustomTab -> chrome_devtools_remote         (Chrome's process) */
function forwardCdp(socket: string): void {
  try {
    adb(['forward', '--remove', `tcp:${CDP_PORT}`]);
  } catch {
    /* nothing forwarded yet — that is the normal first-run state */
  }
  adb(['forward', `tcp:${CDP_PORT}`, `localabstract:${socket}`]);
  console.log(`[perf-tablet] CDP tcp:${CDP_PORT} -> ${socket}`);
}

/** Assert the DEVICE can reach the dev server. The vite server binds [::1] only,
 *  so a host-side `curl 127.0.0.1:5176` returns 000 while the device is fine
 *  (adb reverse dials `localhost` -> ::1). Testing from the device is the only
 *  test that means anything. */
function assertServerReachable(): void {
  // Samsung ships a shell curl; Pixel does not. Fall back to toybox wget,
  // and if the device has neither probe tool, warn and continue — the boot
  // gate (waitForReady) still catches a dead server, just later.
  let code = '';
  try {
    code = adbShell(
      `curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://127.0.0.1:${DEV_PORT}/ 2>/dev/null` +
        ` || (wget -qO /dev/null http://127.0.0.1:${DEV_PORT}/ 2>/dev/null && echo 200)` +
        ` || echo NOPROBE`,
      20_000,
    );
  } catch {
    code = 'NOPROBE';
  }
  if (code.includes('NOPROBE')) {
    console.warn('[perf-tablet] no curl/wget on device — skipping reachability pre-check');
    return;
  }
  if (!code.includes('200')) {
    throw new Error(
      `device cannot reach the dev server (http ${code}). Is vite up on ${DEV_PORT}? ` +
        `Start: npx vite --port ${DEV_PORT} --strictPort   (5173 is the OWNER'S — never touch it)`,
    );
  }
}

/* ---- CDP ----------------------------------------------------------------- */

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function cdpTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`http://localhost:${CDP_PORT}/json`, {
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as CdpTarget[];
}

/** Minimal CDP client. node >= 22 has a global WebSocket — no `ws` package. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (m: MessageEvent): void => {
      const d = JSON.parse(String(m.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (d.id === undefined) return; // event, not a response
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error.message));
      else p.resolve(d.result);
    };
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('CDP ws connect timeout')), 20_000);
      ws.onopen = (): void => {
        clearTimeout(to);
        resolve();
      };
      ws.onerror = (): void => {
        clearTimeout(to);
        reject(new Error(`CDP ws failed: ${wsUrl}`));
      };
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(to);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(to);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string, timeoutMs = 30_000, awaitPromise = false): Promise<T> {
    const r = (await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      timeoutMs,
    )) as { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (r.exceptionDetails) {
      throw new Error(
        `in-page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

/* ---- sampling ------------------------------------------------------------
 * Samples EVERY frame in-page (Trap 4: a per-frame counter read once is a lie —
 * drawCalls legitimately swings 553..995 by design). Everything here is a window
 * series that gets averaged, never an end-of-window snapshot.
 * String evaluate on purpose: tsx/esbuild injects a __name helper around named
 * functions in compiled callbacks, which breaks a raw function hand-off. */
const SAMPLER = (ms: number): string => `(() => new Promise((res) => {
  const t = []; const gpuSum = {}; let gpuN = 0;
  const draws = []; const tris = []; const fpsS = []; const cpuU = []; const cpuS = [];
  const rCalls = []; const cCalls = [];
  let last = performance.now(); const t0 = last;
  requestAnimationFrame(function tick(now) {
    t.push(now - last); last = now;
    const s = window.__laas && window.__laas.stats;
    if (s) {
      const g = s.gpuPasses;
      if (g) { let any = false; for (const k in g) { gpuSum[k] = (gpuSum[k] || 0) + g[k]; any = true; } if (any) gpuN++; }
      if (typeof s.drawCalls === 'number') { draws.push(s.drawCalls); tris.push(s.triangles || 0); }
      if (typeof s.fps === 'number') fpsS.push(s.fps);
      const c = s.counters;
      if (c) {
        if (typeof c['cpu.updateMs100'] === 'number') cpuU.push(c['cpu.updateMs100'] / 100);
        if (typeof c['cpu.submitMs100'] === 'number') cpuS.push(c['cpu.submitMs100'] / 100);
        if (typeof c['render.frameCalls'] === 'number') rCalls.push(c['render.frameCalls']);
        if (typeof c['compute.frameCalls'] === 'number') cCalls.push(c['compute.frameCalls']);
      }
    }
    if (now - t0 < ${ms}) requestAnimationFrame(tick);
    else res({ times: t, gpuSum: gpuSum, gpuN: gpuN, draws: draws, tris: tris, fps: fpsS,
               cpuU: cpuU, cpuS: cpuS, rCalls: rCalls, cCalls: cCalls });
  });
}))()`;

interface SampleOut {
  times: number[];
  gpuSum: Record<string, number>;
  gpuN: number;
  draws: number[];
  tris: number[];
  fps: number[];
  /** per-frame cpu.updateMs100 / cpu.submitMs100 (Engine.ts:235-236), already /100 */
  cpuU: number[];
  cpuS: number[];
  /** per-frame renderer.info.render/compute.frameCalls — the real number of
   *  render contexts / compute submissions per frame (each ends in its own
   *  queue.submit()). Averaged like every other per-frame counter (Trap 4). */
  rCalls: number[];
  cCalls: number[];
}

/* ---- Adreno GPU clock + busy, sampled DURING the measure window ------------
 * WHY EVERY RUN NOW CARRIES THIS (measured 2026-07-15): the ablation battery
 * produced physically impossible rows — `ablate=ao` REMOVES a GPU pass and reads
 * gpuTotalMs 26.6 -> 38.2, `ablate=clouds` 26.6 -> 39.2. GPU work cannot grow by
 * deleting it AT A FIXED CLOCK, so the clock is not fixed: msm-adreno-tz is a
 * DVFS governor and it re-picks a frequency per condition. A GPU ms compared
 * across two different clocks is not a comparison at all.
 *
 * KGSL is world-readable, no root:
 *   devfreq/cur_freq  current clock (Hz)
 *   gpubusy           busy/total since the LAST read — DESTRUCTIVE, resets each
 *                     read, so the poll gap IS the window. Reading it in a tight
 *                     loop yields "0 0" (that bug cost a tool revision).
 * Async on purpose: execFileSync would block node's loop and stall the CDP pump. */
const KGSL = '/sys/class/kgsl/kgsl-3d0';

interface ClockWindow {
  samples: number;
  clockMHzAvg: number;
  clockMHzMin: number;
  clockMHzMax: number;
  clockPctOfMax: number;
  busyPctAvg: number;
  maxMHz: number;
  governor: string;
  throttling: string;
  gpussTempC: number | null;
}

/** THE SAMPLER CAN BE THE BUG — read this before turning `busy` on.
 *
 *  Measured 2026-07-15: `abl-base` and `abl-base2` (no clock sampling) ran at
 *  150.7 / 155.1 ms. `clk-base` and `clk-base3` (clock sampling WITH gpubusy) ran
 *  at 237.6 / 236.7 ms at a 60% clock — the same code and URL, 55% slower, twice,
 *  reproducibly. The suspect is mechanical: reading `gpubusy` RESETS its
 *  counters, and msm-adreno-tz is a utilisation governor that reads THOSE SAME
 *  counters to pick a frequency. Polling it 4x/second plausibly starves the
 *  governor of the statistics it decides on.
 *
 *  So `busy` defaults to OFF: cur_freq is a plain read with no reset semantics
 *  and is safe to poll. Turn busy on only for a dedicated experiment, and never
 *  compare a busy-sampled run's fps against a normal one. */
async function sampleClockDuring(ms: number, periodMs = 250, busy = false): Promise<ClockWindow | null> {
  try {
    const gov = (await execFileAsync(ADB, ['shell', `cat ${KGSL}/devfreq/governor`])).stdout.trim();
    const avail = (await execFileAsync(ADB, ['shell', `cat ${KGSL}/devfreq/available_frequencies`])).stdout
      .trim().split(/\s+/).map(Number).filter((n) => isFinite(n) && n > 0);
    const maxHz = Math.max(...avail);
    const thr = (await execFileAsync(ADB, ['shell', `cat ${KGSL}/throttling 2>/dev/null || echo n/a`])).stdout.trim();
    const freqs: number[] = [];
    const busies: number[] = [];
    const t0 = Date.now();
    if (busy) await execFileAsync(ADB, ['shell', `cat ${KGSL}/gpubusy`]); // prime: first window is unknown
    while (Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, periodMs));
      const cmd = busy ? `cat ${KGSL}/devfreq/cur_freq ${KGSL}/gpubusy` : `cat ${KGSL}/devfreq/cur_freq`;
      const out = (await execFileAsync(ADB, ['shell', cmd])).stdout;
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const f = Number(lines[0]);
      if (isFinite(f) && f > 0) freqs.push(f / 1e6);
      if (busy) {
        const parts = (lines[1] ?? '').split(/\s+/).map(Number);
        const bz = parts[0] ?? 0;
        const total = parts[1] ?? 0;
        if (total > 0) busies.push((bz / total) * 100);
      }
    }
    if (freqs.length === 0) return null;
    let temp: number | null = null;
    try {
      const t = (await execFileAsync(ADB, [
        'shell',
        `for i in $(seq 0 40); do z=/sys/class/thermal/thermal_zone$i; ` +
          `[ "$(cat $z/type 2>/dev/null)" = "gpuss-0" ] && cat $z/temp 2>/dev/null; done`,
      ])).stdout.trim().split('\n')[0];
      const v = Number(t);
      if (isFinite(v) && v > 0) temp = v / 1000;
    } catch { /* thermal zone naming varies; it is a diagnostic, not a gate */ }
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      samples: freqs.length,
      clockMHzAvg: avg(freqs),
      clockMHzMin: Math.min(...freqs),
      clockMHzMax: Math.max(...freqs),
      clockPctOfMax: (avg(freqs) / (maxHz / 1e6)) * 100,
      busyPctAvg: busies.length > 0 ? avg(busies) : -1,
      maxMHz: maxHz / 1e6,
      governor: gov,
      throttling: thr,
      gpussTempC: temp,
    };
  } catch {
    return null; // KGSL layout differs on other SoCs — a missing clock is not a failed run
  }
}

function series(xs: number[]): { avg: number; min: number; max: number; spreadPct: number } {
  if (xs.length === 0) return { avg: 0, min: 0, max: 0, spreadPct: 0 };
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return { avg, min, max, spreadPct: min > 0 ? ((max - min) / min) * 100 : 0 };
}

function gpuAvg(s: SampleOut): Record<string, number> {
  const out: Record<string, number> = {};
  if (s.gpuN === 0) return out;
  for (const [k, v] of Object.entries(s.gpuSum)) out[k] = v / s.gpuN;
  return out;
}

interface Measurement {
  frames: number;
  avgFps: number;
  low1Fps: number;
  p95Ms: number;
  medianMs: number;
  worstMs: number;
  stdMs: number;
}

function reduce(times: number[]): Measurement {
  // drop the first 5: the sampler's own first ticks straddle the settle
  const raw = times.slice(5);
  const xs = [...raw].sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) throw new Error('no frames sampled — is Chrome foregrounded? rAF does not run in the background.');
  const avgMs = xs.reduce((a, b) => a + b, 0) / n;
  const worstSlice = xs.slice(Math.max(0, n - Math.max(1, Math.ceil(n / 100))));
  const worstAvg = worstSlice.reduce((a, b) => a + b, 0) / worstSlice.length;
  const variance = xs.reduce((a, b) => a + (b - avgMs) ** 2, 0) / n;
  return {
    frames: n,
    avgFps: 1000 / avgMs,
    low1Fps: 1000 / worstAvg,
    p95Ms: xs[Math.floor(n * 0.95)] ?? 0,
    medianMs: xs[Math.floor(n * 0.5)] ?? 0,
    worstMs: xs[n - 1] ?? 0,
    stdMs: Math.sqrt(variance),
  };
}

/* ---- args ---------------------------------------------------------------- */

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

/** sha256 over every src/**\/*.ts — the honest staleness guard for `vite dev`
 *  rounds, where there is no hashed bundle filename to compare. */
function srcFingerprint(): string {
  try {
    const h = execSync(
      `find src -name '*.ts' -type f -exec sha256sum {} + | sort -k2 | sha256sum`,
      { encoding: 'utf8', timeout: 30_000 },
    );
    return String(h).trim().split(/\s+/)[0]?.slice(0, 12) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ---- main ---------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const label = str(args['label']) ?? 'tablet';
  const urlExtra = str(args['url-extra']) ?? '';
  const warmupMs = Number(str(args['warmup']) ?? 10_000);
  const measureMs = Number(str(args['measure']) ?? 10_000);
  const outPath = str(args['out']) ?? `shots/wip/perf-tablet-${label}.json`;
  const shotPath = str(args['shot']) ?? `shots/wip/perf-tablet-${label}.png`;
  const readyTimeoutMs = Number(str(args['ready-timeout']) ?? 300_000);

  // --apk           : the shipped offline APK, rendered by an in-process WebView
  // --apk --customtab: the same APK, rendered by a Chrome Custom Tab (the old
  //                    variant-B host). The pair is the WebView-vs-Chrome A/B.
  const apkMode = args['apk'] === true;
  const customTab = args['customtab'] === true;
  if (customTab && !apkMode) throw new Error('--customtab is only meaningful with --apk');

  const params = [...BASE_PARAMS];
  if (urlExtra) params.push(...urlExtra.split('&').filter(Boolean));
  const query = params.join('&');
  const origin = apkMode ? `http://127.0.0.1:${APK_PORT}` : ORIGIN;
  const url = `${origin}/?${query}`;
  const matchPort = apkMode ? APK_PORT : DEV_PORT;

  console.log(`[perf-tablet] url ${url}  (host: ${apkMode ? (customTab ? 'APK/CustomTab' : 'APK/WebView') : 'dev-server/Chrome'})`);
  ensureDevice(apkMode);
  if (!apkMode) assertServerReachable();

  const before = readDevice();
  console.log(
    `[perf-tablet] device ${before.model} (Android ${before.release}) — ` +
      `battery ${before.batteryPct}%, ${before.tempC.toFixed(1)}C`,
  );

  // `am start` both foregrounds the host AND loads the URL. Foreground is not
  // cosmetic: rAF is throttled to a stop in the background, which would read as
  // 0 fps and look like a catastrophic regression.
  if (apkMode) {
    // force-stop first: a warm process would keep the OLD WebView (and the old
    // bundle) and silently ignore the new --es params.
    adbShell(`am force-stop ${APK_PKG}`, 20_000);
    await new Promise((r) => setTimeout(r, 1500));
    // -f 0x10008000 = FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK. NOT
    // optional, and this cost a failed round: a Custom Tab from a previous run
    // stays on top of OUR task (that is how Custom Tabs work — Chrome's
    // activity, our task). force-stop kills our process but leaves the task
    // record, so a plain `am start` reports "intent delivered to currently
    // running top-most instance", resumes the stale tab, never starts
    // MainActivity, and pidof then comes back empty.
    // Use the RAW flags: `am` has --activity-clear-task but NO
    // --activity-new-task (IllegalArgumentException: Unknown option), and
    // CLEAR_TASK without NEW_TASK is ignored by the platform.
    // -S force-stops the target too; both are kept deliberately.
    adbShell(
      `am start -S -n ${APK_PKG}/.MainActivity -f 0x10008000 ` +
        `--es params '${query}'` +
        (customTab ? ' --ez customtab true' : ''),
      30_000,
    );
    // boot + bind of the loopback server, then the WebView/tab attaches
    await new Promise((r) => setTimeout(r, 6000));
    forwardCdp(customTab ? 'chrome_devtools_remote' : `webview_devtools_remote_${apkPid()}`);
  } else {
    adbShell(
      `am start -a android.intent.action.VIEW ` +
        `-n com.android.chrome/com.google.android.apps.chrome.Main -d '${url}'`,
      30_000,
    );
  }
  await new Promise((r) => setTimeout(r, 4000));

  // Find our tab. The host may hold several; prefer one already on our origin.
  let target: CdpTarget | undefined;
  const deadlineT = Date.now() + 60_000;
  while (Date.now() < deadlineT) {
    const ts = await cdpTargets();
    const pages = ts.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    target = pages.find((t) => t.url.includes(`:${matchPort}/`)) ?? undefined;
    if (target) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!target?.webSocketDebuggerUrl) {
    const ts = await cdpTargets();
    throw new Error(
      `no CDP page target on :${matchPort}. Targets:\n` +
        ts.map((t) => `  ${t.type} ${t.url}`).join('\n'),
    );
  }

  // Close DUPLICATE tabs of our own URL so repeated runs do not pile up GPU
  // contexts on the device (each live tab keeps its own WebGPU context alive and
  // would contend with the one we are measuring — the device-side form of Trap 3).
  const all = await cdpTargets();
  for (const t of all) {
    if (t.type === 'page' && t.id !== target.id && t.url.includes(`:${matchPort}/`)) {
      await fetch(`http://localhost:${CDP_PORT}/json/close/${t.id}`).catch(() => undefined);
      console.log(`[perf-tablet] closed duplicate tab ${t.id}`);
    }
  }

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // THE STALE-BUNDLE GUARD. Chrome reuses the tab and will happily keep running
  // the OLD code; today that cost hours (the page ran index-DN_hjsdD.js while the
  // build had index-CiNpJmtJ.js). ignoreCache is not optional.
  const t0 = Date.now();
  await cdp.send('Page.reload', { ignoreCache: true });
  console.log('[perf-tablet] Page.reload(ignoreCache) issued — waiting for __laas.ready…');

  // Poll for ready. Boot is ~70 s on this tablet (telemetry measured 70.6 s), so
  // the default budget is 300 s. Evaluate throws while the context is being
  // recreated right after the reload — tolerate that, do not abort the round.
  let ready = false;
  let lastState = '';
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const st = await cdp.evaluate<string>(
        `(() => { const l = window.__laas; if (!l) return 'no-laas';
          if (l.error) return 'ERR:' + l.error; return l.ready ? 'READY' : 'booting'; })()`,
        15_000,
      );
      if (st !== lastState) {
        lastState = st ?? '';
        console.log(`[perf-tablet]   ${((Date.now() - t0) / 1000).toFixed(0)}s state=${st}`);
      }
      if (st === 'READY') {
        ready = true;
        break;
      }
      if (st?.startsWith('ERR:')) throw new Error(`app fatal: ${st.slice(4)}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('app fatal')) throw e;
      // context destroyed mid-reload — keep polling
    }
  }
  if (!ready) throw new Error(`__laas.ready never became true within ${readyTimeoutMs / 1000}s`);
  const bootS = (Date.now() - t0) / 1000;
  console.log(`[perf-tablet] ready in ${bootS.toFixed(1)}s`);

  // Which code are we actually running? On `vite dev` the entry is /src/main.ts
  // (unbundled ES modules — no index-<hash>.js exists to compare), so the entry
  // string alone cannot prove freshness; srcFingerprint is what does.
  const bundle = await cdp.evaluate<{ entry: string | null; all: string[] }>(
    `(() => { const s = Array.from(document.querySelectorAll('script[src]')).map(e => e.src);
      const hashed = s.find(u => /index-[A-Za-z0-9_-]+\\.js/.test(u));
      return { entry: hashed || s.find(u => /main\\.ts/.test(u)) || s[0] || null, all: s }; })()`,
  );
  const fp = srcFingerprint();
  console.log(`[perf-tablet] entry script: ${bundle?.entry ?? 'NONE'}`);
  console.log(`[perf-tablet] srcFingerprint: ${fp}  (sha256 of src/**/*.ts — the dev-mode staleness guard)`);

  // VIEWPORT COMPARABILITY: entering fullscreen changes innerHeight (750 vs 924)
  // and therefore the canvas size and the pixel count. Every run must report the
  // same buffer or the comparison is void.
  const canvas = await cdp.evaluate<{
    w: number; h: number; cssW: number; cssH: number; innerW: number; innerH: number; dpr: number;
  } | null>(
    `(() => { const c = document.querySelector('canvas'); if (!c) return null;
      return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight,
               innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio }; })()`,
  );
  if (!canvas) throw new Error('no canvas on the page');
  const canvasBuffer = `${canvas.w}x${canvas.h}`;
  console.log(
    `[perf-tablet] canvas buffer ${canvasBuffer} = ${((canvas.w * canvas.h) / 1e6).toFixed(2)} Mp ` +
      `(CSS ${canvas.cssW}x${canvas.cssH}, inner ${canvas.innerW}x${canvas.innerH}, dpr ${canvas.dpr})`,
  );

  // rAF is throttled to a stop in the background, so the WRONG host being on
  // screen makes every fps number fiction. Which host must be focused depends on
  // the mode: the WebView run wants OUR package focused (that is the entire
  // point of variant C), the Custom Tab run wants Chrome.
  const focusNow = readDevice();
  const fgOk = apkMode && !customTab ? focusNow.laasForeground : focusNow.chromeForeground;
  if (!fgOk) {
    const want = apkMode && !customTab ? APK_PKG : 'Chrome';
    throw new Error(
      `${want} is NOT foregrounded (focus: ${focusNow.focus}) — rAF is throttled in the ` +
        `background and every fps number would be fiction.`,
    );
  }

  console.log(`[perf-tablet] warmup ${warmupMs} ms…`);
  const warm = reduce(
    (await cdp.evaluate<SampleOut>(SAMPLER(warmupMs), warmupMs + 120_000, true)).times,
  );
  console.log(`[perf-tablet] warmup done: ${warm.avgFps.toFixed(2)} fps (discarded)`);

  console.log(`[perf-tablet] measuring ${measureMs} ms…`);
  // clock sampling runs CONCURRENTLY with the in-page sampler so the frequency
  // reported is the one the measured frames actually ran at
  const [sample, clock] = await Promise.all([
    cdp.evaluate<SampleOut>(SAMPLER(measureMs), measureMs + 120_000, true),
    sampleClockDuring(measureMs, 250, args['clock-busy'] === true),
  ]);
  const m = reduce(sample.times);
  const gpu = gpuAvg(sample);
  const drawsS = series(sample.draws ?? []);
  const trisS = series(sample.tris ?? []);
  const fpsS = series(sample.fps ?? []);
  const cpuUpdateMs = series(sample.cpuU ?? []).avg;
  const cpuSubmitMs = series(sample.cpuS ?? []).avg;
  const cpuTotalMs = cpuUpdateMs + cpuSubmitMs;
  const rCallsS = series(sample.rCalls ?? []);
  const cCallsS = series(sample.cCalls ?? []);
  const after = readDevice();

  // ---- gates --------------------------------------------------------------
  // Trap 2 on Android: vsync cannot be disabled, but at 5-7 fps we are two
  // orders of magnitude from the 60/120 Hz cap. The gate stays anyway — if fps
  // ever sits on the refresh with no variance, the run is void.
  const nearRefresh = [60, 90, 120, 144].some((hz) => Math.abs(m.avgFps - hz) < 1.5);
  const vsyncCapped = nearRefresh && m.stdMs < 1.0;
  const meterValid = !vsyncCapped && m.frames > 10;
  // Adreno + Chrome Android DO expose timestamp-query here (measured — this was
  // not a given; Engine.ts:159 gates the profiler on the adapter feature).
  const gpuTimestampsAvailable = Object.keys(gpu).length > 0;

  // ---- the BOUND question -------------------------------------------------
  // The campaign's premise is "the tablet is GPU-bound, so fps is honest". That
  // premise must be MEASURED, not assumed — if the device is CPU-walled like the
  // desktop, cutting GPU work cannot move fps and the whole plan needs rethinking.
  // Caveat kept explicit: gpuTotalMs is the sum of three's timestamped passes, so
  // it EXCLUDES driver gaps, buffer mapping and present/compositor time; a low
  // gpuFrac therefore means "not explained by timed GPU passes", not necessarily
  // "the CPU is the wall". cpu.update+cpu.submit is the other half of the story.
  const avgMs = 1000 / m.avgFps;
  const gpuRenderMs = gpu['render'] ?? 0;
  const gpuComputeMs = gpu['compute'] ?? 0;
  const gpuTotalMs = gpuRenderMs + gpuComputeMs;
  const gpuFrac = gpuTimestampsAvailable ? gpuTotalMs / avgMs : NaN;
  const cpuFrac = cpuTotalMs / avgMs;
  const unexplainedMs = avgMs - Math.max(gpuTotalMs, cpuTotalMs);
  const bound = !gpuTimestampsAvailable
    ? 'UNKNOWN'
    : gpuFrac > 0.8
      ? 'GPU-BOUND'
      : cpuFrac > 0.8
        ? 'CPU-BOUND'
        : gpuFrac > 0.5
          ? 'MIXED'
          : 'UNEXPLAINED';

  console.log(
    `\n[RESULT ${label}] avg ${m.avgFps.toFixed(2)} fps | 1%low ${m.low1Fps.toFixed(2)} fps | ` +
      `p95 ${m.p95Ms.toFixed(1)} ms | median ${m.medianMs.toFixed(1)} ms | frames ${m.frames} | ` +
      `std ${m.stdMs.toFixed(1)} ms`,
  );
  console.log(
    `[RESULT ${label}] in-app fps (stats.fps, EMA) mean ${fpsS.avg.toFixed(2)} | ` +
      `draws mean ${drawsS.avg.toFixed(0)} (min ${drawsS.min}, max ${drawsS.max}, ` +
      `oscillates ${drawsS.spreadPct.toFixed(0)}% in-window — the MEAN is the comparable number) | ` +
      `tris mean ${(trisS.avg / 1e6).toFixed(2)}M`,
  );
  console.log(
    `[RESULT ${label}] submissions/frame: render.frameCalls mean ${rCallsS.avg.toFixed(1)} ` +
      `(${rCallsS.min}..${rCallsS.max}) | compute.frameCalls mean ${cCallsS.avg.toFixed(1)} ` +
      `(${cCallsS.min}..${cCallsS.max}) — each ends in its own queue.submit()`,
  );
  console.log(
    `[RESULT ${label}] thermal: ${before.tempC.toFixed(1)}C -> ${after.tempC.toFixed(1)}C | ` +
      `battery ${before.batteryPct}% -> ${after.batteryPct}%`,
  );
  if (clock) {
    console.log(
      `[RESULT ${label}] GPU CLOCK ${clock.clockMHzAvg.toFixed(0)} MHz ` +
        `(${clock.clockMHzMin.toFixed(0)}..${clock.clockMHzMax.toFixed(0)}) = ` +
        `${clock.clockPctOfMax.toFixed(0)}% of max ${clock.maxMHz.toFixed(0)} | ` +
        `GPU BUSY ${clock.busyPctAvg < 0 ? 'not sampled (destructive read — see sampleClockDuring)' : clock.busyPctAvg.toFixed(1) + '%'} | gov ${clock.governor} | ` +
        `throttling=${clock.throttling} | gpuss ${clock.gpussTempC?.toFixed(1) ?? '?'}C`,
    );
    if (clock.busyPctAvg > 95 && clock.clockPctOfMax < 90) {
      console.log(
        `[GATE] !! GPU is ${clock.busyPctAvg.toFixed(0)}% BUSY but only at ` +
          `${clock.clockPctOfMax.toFixed(0)}% of its max clock. The governor is leaving ` +
          `headroom on a saturated GPU — and GPU ms measured at THIS clock cannot be ` +
          `compared with GPU ms from a run at a different clock.`,
      );
    }
  }
  console.log(
    `[RESULT ${label}] BOUND=${bound} | frame ${avgMs.toFixed(1)} ms = ` +
      `GPU(timed passes) ${gpuTotalMs.toFixed(1)} ms (${(gpuFrac * 100).toFixed(0)}%) | ` +
      `cpu.update ${cpuUpdateMs.toFixed(1)} + cpu.submit ${cpuSubmitMs.toFixed(1)} = ` +
      `${cpuTotalMs.toFixed(1)} ms (${(cpuFrac * 100).toFixed(0)}%) | ` +
      `unexplained ${unexplainedMs.toFixed(1)} ms`,
  );
  if (bound === 'UNEXPLAINED') {
    console.log(
      `[GATE] !! Neither timed GPU passes nor cpu.update+submit explain the frame.\n` +
        `[GATE]    Likely candidates: driver/queue gaps between passes, buffer mapping stalls,\n` +
        `[GATE]    present/compositor time, or thermal downclock. Do NOT assume a GPU cut will\n` +
        `[GATE]    pay out 1:1 until this gap is attributed.`,
    );
  }
  if (gpuTimestampsAvailable) {
    const top = Object.entries(gpu)
      .filter(([k]) => k !== 'render' && k !== 'compute')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    console.log(`[GPU passes ${label}] render ${gpu['render']?.toFixed(3)} compute ${gpu['compute']?.toFixed(3)}`);
    for (const [k, v] of top) console.log(`    ${k.padEnd(30)} ${v.toFixed(3)} ms`);
  } else {
    console.log(
      `[GPU passes ${label}] NOT AVAILABLE — the device's WebGPU adapter does not expose ` +
        `timestamp-query (Engine.ts:159), so there is no per-pass GPU ms here. ` +
        `That is expected on Adreno/Chrome-Android and is not a failure: on THIS device fps is the metric.`,
    );
  }
  console.log(
    vsyncCapped
      ? `[GATE] !! VSYNC-CAPPED (avg pinned near refresh, std ${m.stdMs.toFixed(2)} ms) -> NUMBERS INVALID`
      : `[GATE] fps meter live: avg ${m.avgFps.toFixed(2)} fps, std ${m.stdMs.toFixed(1)} ms (nowhere near the 60/120 Hz cap)`,
  );

  // Screenshot LAST, while the scene is still the one we measured. The fps
  // readout (HUD.ts:97, top-left) must be legible in it — the owner reads these.
  mkdirSync(dirname(shotPath), { recursive: true });
  execSync(`"${ADB}" exec-out screencap -p > "${shotPath}"`, { timeout: 60_000 });
  console.log(`[perf-tablet] shot -> ${shotPath}`);

  cdp.close();

  const row = {
    label,
    when: new Date().toISOString(),
    device: { model: before.model, android: before.release },
    // WHICH ENGINE DREW THIS, and under which Game Mode. Without these a JSON
    // from a WebView run is indistinguishable from a Custom Tab one, and the
    // whole variant-B-vs-C comparison becomes unfalsifiable a week later.
    host: apkMode ? (customTab ? 'apk-customtab' : 'apk-webview') : 'dev-chrome',
    gameMode: apkMode ? safeShell(`cmd game list-modes ${APK_PKG}`) : null,
    thermal: {
      tempBeforeC: before.tempC,
      tempAfterC: after.tempC,
      batteryBeforePct: before.batteryPct,
      batteryAfterPct: after.batteryPct,
    },
    url,
    urlExtra,
    bundleEntry: bundle?.entry ?? null,
    bundleScripts: bundle?.all ?? [],
    srcFingerprint: fp,
    canvas,
    canvasBuffer,
    megapixels: Number(((canvas.w * canvas.h) / 1e6).toFixed(3)),
    bootS,
    warmupMs,
    measureMs,
    ...m,
    // Per-frame MEANS over the window — Trap 4. Never compare a single read.
    inAppFpsMean: Number(fpsS.avg.toFixed(2)),
    drawCalls: Math.round(drawsS.avg),
    drawCallsMin: drawsS.min,
    drawCallsMax: drawsS.max,
    drawCallsSpreadPct: Number(drawsS.spreadPct.toFixed(1)),
    triangles: Math.round(trisS.avg),
    // real submission boundaries per frame (P0.1), window means — never one read
    renderFrameCalls: Number(rCallsS.avg.toFixed(2)),
    renderFrameCallsMin: rCallsS.min,
    renderFrameCallsMax: rCallsS.max,
    computeFrameCalls: Number(cCallsS.avg.toFixed(2)),
    computeFrameCallsMin: cCallsS.min,
    computeFrameCallsMax: cCallsS.max,
    gpuPasses: gpu,
    gpuSamples: sample.gpuN,
    gpuTimestampsAvailable,
    /** Adreno DVFS state DURING the measure window. Without this, gpuTotalMs
     *  across conditions is not comparable — the governor re-clocks per run. */
    gpuClock: clock,
    // the bound question, measured rather than assumed — see the block above
    gpuTotalMs,
    gpuRenderMs,
    gpuComputeMs,
    gpuFrac,
    cpuUpdateMs,
    cpuSubmitMs,
    cpuTotalMs,
    cpuFrac,
    unexplainedMs,
    bound,
    vsyncCapped,
    meterValid,
    /** On the tablet fps IS the campaign metric — unlike the desktop proxy
     *  (perf-mobile.ts), which is CPU-walled and must fall back to GPU ms. */
    fpsIsCampaignMetric: meterValid,
    shotPath,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(row, null, 2));
  console.log(`[perf-tablet] wrote ${outPath}`);
  if (!meterValid) process.exitCode = 2;
}

main().catch((e: unknown) => {
  console.error('[perf-tablet] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
