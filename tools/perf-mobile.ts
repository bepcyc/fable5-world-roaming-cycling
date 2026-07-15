/**
 * Perf harness — MOBILE low-power profile (Pixel 10 Pro proxy).
 *
 * The desktop profile is measured by tools/perf-baseline.ts; this one exists to
 * drive the mobile FPS campaign in docs/PERF_FPS_MOBILE.md. It reproduces the
 * offline APK's real launch config (`/laas/?nogate=1&preset=min&dpr=0.6`, see
 * android/.../manifest.webmanifest) on this box and runs the owner's protocol:
 * ONE fixed spot, 10 s warmup, 10 s measured, averaged.
 *
 * VIEWPORT — why the default is 1000x448 CSS (not a desktop-ish 2410x1080):
 *   Pixel 10 Pro panel = 1280x2856 physical, devicePixelRatio ~2.857, and
 *   index.html declares `width=device-width, initial-scale=1`. Landscape CSS is
 *   therefore ~2856/2.857 x 1280/2.857 = 1000 x 448 (aspect 2.23 == 2856/1280).
 *   With `?dpr=0.6` -> setPixelRatio(0.6) -> drawing buffer 600x269, the SAME
 *   pixel count the phone actually rasterizes. A 2410x1080 viewport would be
 *   5.8x the phone's pixels and would over-weight fragment/fill cost — exactly
 *   the axis the dossier says is NOT the bottleneck. Override with --w/--h.
 *   Caveat this buys us: at 600x269 the frame is cheap, so the desktop GPU may
 *   go CPU-bound; the harness prints cpu.update/cpu.submit vs frame time and
 *   labels the bound so a meaningless delta is never reported as a win.
 *
 * THE VSYNC TRAP: launch-gpu.ts's base flags do NOT disable vsync, so rAF pins
 * at the refresh rate and every optimization reads "60 fps, no change". This
 * tool passes --disable-gpu-vsync --disable-frame-rate-limit via the launcher's
 * extraArgs and asserts the meter is live (see `meterValid` in the JSON).
 * Use --vsync 1 to deliberately re-enable vsync and demonstrate the cap.
 *
 * PRIMARY METRIC IS *GPU MS*, NOT FPS (measured 2026-07-15, phase 0):
 *   At the mobile profile this desktop box is CPU-WALLED — GPU ~2.4 ms of a
 *   ~23 ms frame (11% utilisation), cpu.submit ~22 ms. avg fps therefore does
 *   NOT respond to GPU cuts here (proved: dpr 0.2 -> 1.5 is a 56x pixel change
 *   for a 0.1 fps delta). The Pixel's GPU is ~10-20x slower, so the PHONE is
 *   GPU-bound where this box is not. Judge every optimization by the per-pass
 *   GPU ms this tool prints (three's own timestamp-query), and treat avg fps as
 *   a regression guard only. The tool labels this itself via `bound`.
 *
 * NOISE / HOW BIG A WIN MUST BE TO BE REAL (two identical baseline runs):
 *   gpuTotalMs varied 6.0% run-to-run (2.474 -> 2.624 ms), c.grassRingCull 6.8%,
 *   avgFps 5.7%, low1Fps 12.7%. So treat <~12% as noise on a single pair of
 *   runs; repeat the pair (or lengthen --measure) before believing anything
 *   smaller. The dossier's #1 (grass grid 3072->1536) should move
 *   c.grassRingCull by 50-75% — far above this floor.
 *
 * STREAMING CONVERGENCE CAVEAT: drawCalls/triangles are an end-of-window
 * snapshot and reveal whether vegetation finished streaming. The converged
 * value at this spot is 727 draws / 14966026 nominal tris; one baseline run
 * measured 553/12463398, i.e. the 10 s warmup had NOT fully converged and its
 * GPU numbers ran ~6% low. Compare drawCalls between runs before trusting a
 * delta; if they differ, re-run or raise --warmup.
 *
 * MACHINE CONTENTION: this box is CPU-walled at this profile, so ANY other heavy
 * process (a Blender session, a build) lands directly on the metric — and a
 * RAM-hungry neighbour is worse than a CPU-hungry one, because swapping shreds
 * frame times. The tool therefore REFUSES to measure a contended box (see the
 * gate below) instead of emitting a plausible lie. Every row carries `machine`
 * with the load it was taken under, and `machine.contended` if it was dirty.
 *
 * Usage:
 *   npx tsx tools/perf-mobile.ts --label baseline
 *   npx tsx tools/perf-mobile.ts --label no-ao --extra "ablate=ao"
 *   npx tsx tools/perf-mobile.ts --label prepass-off --extra "prepass=0"
 *   npx tsx tools/perf-mobile.ts --vsync 1 --label vsync-capped-control
 *   npx tsx tools/perf-mobile.ts --wait-idle 7200 --label baseline   # park until quiet
 *   npx tsx tools/perf-mobile.ts --allow-contended --label dirty     # stamped dirty
 *
 * Gotcha (CLAUDE.md): "No REAL WebGPU adapter" == our OWN stray headless
 * Chromes piling up from retries. Fix: pkill -f "chrome.*--headless", pause,
 * then ONE clean run. Do not spam retries.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname } from 'node:path';
import type { Page } from 'playwright';
import { launchWebGPUReal, LAAS_ORIGIN } from './launch-gpu';

/** THE fixed measurement spot: "px,py,pz,yaw,pitch". Every run in this campaign
 *  reuses it verbatim — never let it drift or the numbers stop being comparable. */
export const SPOT_CAM = '-870,182.7,862,1.69,0.1';

/* ---- MACHINE CONTENTION GATE ---------------------------------------------
 * A benchmark is only worth the machine it ran on. Anything else heavy on this
 * box (a Blender session, a build, someone else's Chrome) steals CPU and — the
 * nastier one — RAM: once MemAvailable collapses the box swaps, frame times
 * jitter, and every delta is quietly poisoned. This profile is CPU-WALLED (see
 * the header), so foreign CPU load lands straight on the metric.
 *
 * Policy: refuse to measure a contended box rather than emit a plausible lie.
 *   --wait-idle <sec>   park until it goes quiet, then measure
 *   --allow-contended   measure anyway, but STAMP the row `contended: true` so
 *                       the number can never later be mistaken for a clean one.
 * Every row carries `machine`, so a suspicious delta can always be re-checked
 * against the load it was taken under.
 */
interface MachineLoad {
  load1: number;
  cores: number;
  loadPerCore: number;
  memAvailPct: number;
  hogs: string[];
  quiet: boolean;
}

/** An idle box sits near 0.02–0.10 load/core; 0.35 leaves room for background
 *  daemons without letting a real workload through. */
const LOAD_PER_CORE_MAX = 0.35;
/** Below this, the box is one allocation away from swapping. */
const MEM_AVAIL_MIN_PCT = 20;

function readMachineLoad(): MachineLoad {
  const load1 = Number((readFileSync('/proc/loadavg', 'utf8').split(/\s+/)[0] ?? '0'));
  const cores = Math.max(1, cpus().length);
  const mi = readFileSync('/proc/meminfo', 'utf8');
  const kb = (k: string): number => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mi)?.[1] ?? 0);
  const memAvailPct = (kb('MemAvailable') / Math.max(1, kb('MemTotal'))) * 100;
  // Foreign hogs only: our own toolchain (the harness's Chrome/node, the agent
  // driving it) is not contention, it IS the measurement.
  let hogs: string[] = [];
  try {
    const opts: ExecSyncOptions = { encoding: 'utf8', timeout: 5000 };
    hogs = String(execSync('ps -eo pcpu,pmem,comm --sort=-pcpu --no-headers', opts))
      .split('\n')
      .slice(0, 12)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        const [pcpu, pmem, comm] = l.split(/\s+/);
        if (/^(chrome|chrome_crashpad|node|npm|npx|ps|claude|tsx)$/.test(comm ?? '')) return false;
        return Number(pcpu ?? 0) > 20 || Number(pmem ?? 0) > 25;
      })
      .map((l) => l.replace(/\s+/g, ' '));
  } catch {
    /* no ps — load/mem still gate */
  }
  const loadPerCore = load1 / cores;
  return {
    load1,
    cores,
    loadPerCore,
    memAvailPct,
    hogs,
    quiet: loadPerCore <= LOAD_PER_CORE_MAX && memAvailPct >= MEM_AVAIL_MIN_PCT && hogs.length === 0,
  };
}

function describeLoad(m: MachineLoad): string {
  return (
    `load ${m.load1.toFixed(2)}/${m.cores}c (${(m.loadPerCore * 100).toFixed(0)}%/core), ` +
    `mem avail ${m.memAvailPct.toFixed(0)}%` +
    (m.hogs.length ? `, hogs: [${m.hogs.join(' | ')}]` : '')
  );
}

async function gateOnIdle(waitSec: number, allowContended: boolean): Promise<MachineLoad> {
  let m = readMachineLoad();
  if (m.quiet) return m;
  if (allowContended) {
    console.warn(`[perf-mobile] CONTENDED, but --allow-contended given — ${describeLoad(m)}`);
    console.warn('[perf-mobile] the row will be stamped contended:true — do NOT compare it to clean runs.');
    return m;
  }
  if (waitSec <= 0) {
    console.error(`[perf-mobile] REFUSING to measure a contended box — ${describeLoad(m)}`);
    console.error('[perf-mobile] --wait-idle <sec> to park until quiet, or --allow-contended to accept dirt.');
    throw new Error('machine contended');
  }
  const deadline = Date.now() + waitSec * 1000;
  console.log(`[perf-mobile] waiting up to ${waitSec}s for an idle box — ${describeLoad(m)}`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    m = readMachineLoad();
    if (m.quiet) {
      console.log(`[perf-mobile] box went quiet — ${describeLoad(m)}`);
      return m;
    }
    console.log(`[perf-mobile] still busy — ${describeLoad(m)}`);
  }
  throw new Error(`machine still contended after ${waitSec}s — ${describeLoad(m)}`);
}

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** rAF frame deltas (ms) + per-frame GPU pass timings, captured in-page.
 *  String evaluate on purpose: tsx/esbuild injects a __name helper around
 *  named fns in compiled evaluate callbacks.
 *
 *  gpuPasses is sampled EVERY frame and averaged over the window: Engine
 *  rewrites it per frame from resolveTimestampsAsync, so a single read at the
 *  end is one arbitrary frame. `render`/`compute` are three's authoritative
 *  renderer.info.{render,compute}.timestamp per-frame GPU sums (Engine.ts:277). */
const SAMPLER = (ms: number): string => `(() => new Promise((res) => {
  const t = [];
  const gpuSum = {}; let gpuN = 0;
  const draws = []; const tris = [];
  let last = performance.now(); const t0 = last;
  requestAnimationFrame(function tick(now) {
    t.push(now - last); last = now;
    const s = window.__laas.stats;
    const g = s && s.gpuPasses;
    if (g) {
      gpuN++;
      for (const k in g) gpuSum[k] = (gpuSum[k] || 0) + g[k];
    }
    if (s && typeof s.drawCalls === 'number') { draws.push(s.drawCalls); tris.push(s.triangles || 0); }
    if (now - t0 < ${ms}) requestAnimationFrame(tick);
    else res({ times: t, gpuSum: gpuSum, gpuN: gpuN, draws: draws, tris: tris });
  });
}))()`;

interface SampleOut {
  times: number[];
  gpuSum: Record<string, number>;
  gpuN: number;
  draws: number[];
  tris: number[];
}

/** Mean + spread of a per-frame series.
 *
 *  WHY THIS EXISTS (measured 2026-07-15): drawCalls was read ONCE at the end of
 *  the window, and consecutive identical runs reported 553 / 687 / 712 / 727 /
 *  995 draws. That looked like "vegetation is still streaming" and sent a whole
 *  session chasing a convergence bug that does not exist. It is not streaming —
 *  the draw count legitimately OSCILLATES frame to frame, because per-frame work
 *  is staggered (CsmCached refreshes one shadow cascade per frame; the cloud
 *  shadow re-bakes every ~2.5 s). A single end-of-window read lands on a random
 *  phase of that cycle. The window MEAN is stable and comparable; the snapshot
 *  never was. Same reason gpuPasses is already averaged above. */
function series(xs: number[]): { avg: number; min: number; max: number; spreadPct: number } {
  if (xs.length === 0) return { avg: 0, min: 0, max: 0, spreadPct: 0 };
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return { avg, min, max, spreadPct: min > 0 ? ((max - min) / min) * 100 : 0 };
}

/** mean GPU ms per label over the sampled window */
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
  /** population stddev of frame deltas (ms) — the vsync tell */
  stdMs: number;
}

function reduce(times: number[]): Measurement {
  // drop the first 5: the sampler's own first ticks straddle the settle
  const raw = times.slice(5);
  const xs = [...raw].sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) throw new Error('no frames sampled');
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number(str(args['seed']) ?? 1);
  const preset = str(args['preset']) ?? 'min';
  const dpr = Number(str(args['dpr']) ?? 0.6);
  const width = Number(str(args['w']) ?? 1000); // Pixel 10 Pro landscape CSS
  const height = Number(str(args['h']) ?? 448);
  const warmupMs = Number(str(args['warmup']) ?? 10_000);
  const measureMs = Number(str(args['measure']) ?? 10_000);
  // THE ONE FIXED SPOT — an explicit pose, not a bookmark, so it is byte-
  // identical across runs and independent of any later BOOKMARKS edit.
  // Eye level (1.8 m) in the meadow at (-870, 862) looking ACROSS the valley:
  // near grass + terrain + sky/clouds + distant ranges + water. Bookmark 4's
  // own yaw (-1.45) faces INTO the hillside and shows no sky at all, which is
  // why we do not use ?shot=4 here. T=14 (midday) is fixed and explicit.
  const cam = str(args['cam']) ?? SPOT_CAM;
  const tod = str(args['T']) ?? '14';
  const extra = str(args['extra']) ?? '';
  const label = str(args['label']) ?? 'mobile';
  const vsyncOn = str(args['vsync']) === '1';
  const outPath = str(args['out']) ?? `shots/wip/perf-mobile-${label}.json`;
  const shotPath = str(args['shot']) ?? `shots/wip/perf-mobile-${label}.png`;
  const waitIdleSec = Number(str(args['wait-idle']) ?? 0);
  const allowContended = args['allow-contended'] === true || str(args['allow-contended']) === '1';

  // Gate BEFORE booting Chrome: world-gen alone costs ~50 s, so discovering the
  // box is busy after the boot wastes a minute and tempts you to keep the dirty
  // number anyway.
  const machine = await gateOnIdle(waitIdleSec, allowContended);
  console.log(`[perf-mobile] machine: ${describeLoad(machine)}`);

  // The whole point of this harness: an UNCAPPED rAF meter. Without these,
  // rAF pins at the refresh rate and every optimization reads "no change".
  const vsyncArgs = vsyncOn
    ? []
    : [
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--disable-features=CalculateNativeWinOcclusion',
      ];

  const { browser, info, recipe } = await launchWebGPUReal({ extraArgs: vsyncArgs });
  console.log(
    `[perf-mobile] adapter ${info.vendor}/${info.architecture} (${info.description || info.device})`,
  );
  console.log(
    `[perf-mobile] vsync=${vsyncOn ? 'ON (control run)' : 'DISABLED'} ` +
      `args=[${[...recipe.args, ...vsyncArgs].join(' ')}]`,
  );

  const params = [
    'scene=world',
    `seed=${seed}`,
    'hud=0',
    'freeze=0', // world moves like gameplay (same as perf-baseline)
    `preset=${preset}`,
    `dpr=${dpr}`,
    `T=${tod}`,
    `cam=${cam}`,
  ];
  if (extra) params.push(...extra.split('&').filter(Boolean));
  const url = `${LAAS_ORIGIN}/?${params.join('&')}`;
  console.log(`[perf-mobile] url ${url}`);
  console.log(`[perf-mobile] viewport ${width}x${height} CSS @dpr ${dpr} ` +
    `-> drawing buffer ${Math.round(width * dpr)}x${Math.round(height * dpr)}`);

  const page: Page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1, // dpr is applied in-app via setPixelRatio(?dpr)
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 900_000, polling: 500 },
  );
  const error = await page.evaluate(() => window.__laas.error);
  if (error) throw new Error(`App reported fatal error:\n${error}`);
  const bootS = (Date.now() - t0) / 1000;
  console.log(`[perf-mobile] ready in ${bootS.toFixed(1)}s`);

  // ONE fixed spot: ?cam= already placed us there at boot. Re-assert it anyway
  // so nothing the boot path did (spawn snapping, walk-mode clamp) can drift it.
  const [cx, cy, cz, cyaw, cpitch] = cam.split(',').map(Number) as number[];
  await page.evaluate(
    (pose) => window.__laas.setPose?.(pose as never),
    { p: [cx, cy, cz], yaw: cyaw, pitch: cpitch },
  );
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(120)));

  // read the pose back and ASSERT it matches — a silently clamped camera would
  // measure a different spot while the label still claims this one.
  const pose = await page.evaluate(() => window.__laas.getPose?.() ?? null);
  const camStr = pose
    ? `${pose.p.map((v) => v.toFixed(3)).join(',')},${pose.yaw.toFixed(4)},${pose.pitch.toFixed(4)}`
    : null;
  const drift = pose
    ? Math.max(
        Math.abs(pose.p[0] - (cx as number)),
        Math.abs(pose.p[1] - (cy as number)),
        Math.abs(pose.p[2] - (cz as number)),
      )
    : Infinity;
  console.log(`[perf-mobile] SPOT requested cam=${cam} -> actual cam=${camStr ?? 'n/a'}`);
  if (drift > 0.05) {
    throw new Error(
      `spot drifted ${drift.toFixed(3)} m from the requested pose (actual ${camStr}) — ` +
        `runs would not be comparable. Fix the spot before measuring.`,
    );
  }

  console.log(`[perf-mobile] warmup ${warmupMs} ms…`);
  const warm = reduce(((await page.evaluate(SAMPLER(warmupMs))) as SampleOut).times);
  console.log(
    `[perf-mobile] warmup done: avg ${warm.avgFps.toFixed(1)} fps (discarded)`,
  );

  console.log(`[perf-mobile] measuring ${measureMs} ms…`);
  const sample = (await page.evaluate(SAMPLER(measureMs))) as SampleOut;
  const m = reduce(sample.times);
  const gpu = gpuAvg(sample);
  const drawsS = series(sample.draws ?? []);
  const trisS = series(sample.tris ?? []);
  console.log(
    `[perf-mobile] draws/frame avg ${drawsS.avg.toFixed(0)} (min ${drawsS.min}, max ${drawsS.max}, ` +
      `oscillates ${drawsS.spreadPct.toFixed(0)}% within the window — the AVG is the comparable number)`,
  );

  const stats = await page.evaluate(() => ({
    triangles: window.__laas.stats?.triangles ?? 0,
    drawCalls: window.__laas.stats?.drawCalls ?? 0,
    counters: window.__laas.stats?.counters ?? {},
  }));
  const cpuUpdateMs = (stats.counters['cpu.updateMs100'] ?? 0) / 100;
  const cpuSubmitMs = (stats.counters['cpu.submitMs100'] ?? 0) / 100;
  const cpuTotalMs = cpuUpdateMs + cpuSubmitMs;
  const avgMs = 1000 / m.avgFps;

  // GPU truth: three's own per-frame timestamp sums (Engine.ts:277-278).
  // NOTE: stats.triangles is a NOMINAL upper bound, not what the GPU drew —
  // grass/veg/debris go through GPU-culled INDIRECT draws (c.grassRingCull,
  // c.vegIndirect, c.ringIndirect) and three counts the CPU-side declared
  // instance count. Do not compute tris/sec from it and conclude anything.
  const gpuRenderMs = gpu['render'] ?? 0;
  const gpuComputeMs = gpu['compute'] ?? 0;
  const gpuTotalMs = gpuRenderMs + gpuComputeMs;
  const gpuOk = gpuTotalMs > 0;

  // ---- validity gates -----------------------------------------------------
  // 1) vsync: a capped meter sits on the refresh rate with ~no variance.
  const nearRefresh = [60, 75, 90, 120, 144, 165, 240].some(
    (hz) => Math.abs(m.avgFps - hz) < 1.5,
  );
  const vsyncCapped = nearRefresh && m.stdMs < 1.0;
  // 2) bound: GPU-vs-frame is the honest test. The CPU counters alone cannot
  //    tell "busy encoding" from "blocked on a GPU fence inside render()", but
  //    the GPU timestamps can: idle GPU + full frame == the wall is CPU-side.
  const gpuFrac = gpuOk ? gpuTotalMs / avgMs : NaN;
  const cpuFrac = cpuTotalMs / avgMs;
  const bound = !gpuOk ? 'UNKNOWN' : gpuFrac > 0.8 ? 'GPU-BOUND' : gpuFrac > 0.5 ? 'MIXED' : 'CPU-BOUND';
  // The fps meter is valid iff it is not vsync-pinned. Whether fps is the RIGHT
  // metric is a separate question — see fpsIsCampaignMetric.
  const meterValid = !vsyncCapped;
  const fpsIsCampaignMetric = meterValid && bound === 'GPU-BOUND';

  console.log(
    `\n[RESULT ${label}] avg ${m.avgFps.toFixed(1)} fps | 1%low ${m.low1Fps.toFixed(1)} fps | ` +
      `p95 ${m.p95Ms.toFixed(2)} ms | median ${m.medianMs.toFixed(2)} ms | ` +
      `frames ${m.frames} | std ${m.stdMs.toFixed(2)} ms`,
  );
  console.log(
    `[RESULT ${label}] GPU ${gpuTotalMs.toFixed(3)} ms (render ${gpuRenderMs.toFixed(3)} + ` +
      `compute ${gpuComputeMs.toFixed(3)}) of ${avgMs.toFixed(2)} ms frame = ` +
      `${(gpuFrac * 100).toFixed(0)}% GPU utilisation -> ${bound}`,
  );
  console.log(
    `[RESULT ${label}] cpu.update ${cpuUpdateMs.toFixed(2)} + cpu.submit ${cpuSubmitMs.toFixed(2)} = ` +
      `${cpuTotalMs.toFixed(2)} ms (${(cpuFrac * 100).toFixed(0)}% of frame) | ` +
      `draws ${stats.drawCalls} | tris(nominal) ${stats.triangles}`,
  );
  const top = Object.entries(gpu)
    .filter(([k]) => k !== 'render' && k !== 'compute')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (top.length > 0) {
    console.log(`[GPU passes ${label}] top ${top.length} of ${Object.keys(gpu).length - 2}:`);
    for (const [k, v] of top) console.log(`    ${k.padEnd(30)} ${v.toFixed(3)} ms`);
  }
  console.log(
    vsyncCapped
      ? `[GATE] !! VSYNC-CAPPED (avg pinned near refresh, std ${m.stdMs.toFixed(2)} ms) -> NUMBERS INVALID`
      : `[GATE] fps meter live: avg ${m.avgFps.toFixed(1)} fps, std ${m.stdMs.toFixed(2)} ms (not pinned to refresh)`,
  );
  if (bound === 'CPU-BOUND') {
    console.log(
      `[GATE] !! CPU-WALLED on this box: GPU only ${gpuTotalMs.toFixed(2)} ms of a ${avgMs.toFixed(2)} ms frame ` +
        `(${(gpuFrac * 100).toFixed(0)}%). avg fps CANNOT measure this campaign's GPU cuts here.\n` +
        `[GATE]    -> USE THE PRIMARY METRIC: GPU ms per pass above. The phone's GPU is ~10-20x slower,\n` +
        `[GATE]       so the phone IS GPU-bound where this box is not. Never report an fps delta as a win.`,
    );
  }

  mkdirSync(dirname(shotPath), { recursive: true });
  await page.screenshot({ path: shotPath });
  console.log(`[perf-mobile] shot -> ${shotPath}`);

  await browser.close();

  const row = {
    label,
    when: new Date().toISOString(),
    adapter: info,
    // the box this number is worth exactly as much as
    machine: { ...machine, contended: !machine.quiet },
    chromeArgs: [...recipe.args, ...vsyncArgs],
    url,
    spot: { cam, camActual: camStr, tod },
    viewport: { width, height, dpr, bufferW: Math.round(width * dpr), bufferH: Math.round(height * dpr) },
    seed,
    preset,
    extra,
    bootS,
    warmupMs,
    measureMs,
    ...m,
    // Per-frame MEAN over the measure window — this is the comparable number.
    // drawCallsEnd/trianglesEnd are the old end-of-window snapshots, kept only
    // to show how badly a single read scatters (see `series` above).
    drawCalls: Math.round(drawsS.avg),
    drawCallsMin: drawsS.min,
    drawCallsMax: drawsS.max,
    drawCallsSpreadPct: Number(drawsS.spreadPct.toFixed(1)),
    triangles: Math.round(trisS.avg),
    drawCallsEnd: stats.drawCalls,
    trianglesEnd: stats.triangles,
    cpuUpdateMs,
    cpuSubmitMs,
    cpuFrac,
    // primary campaign metric — see the CPU-WALLED gate
    gpuTotalMs,
    gpuRenderMs,
    gpuComputeMs,
    gpuFrac,
    bound,
    vsyncCapped,
    meterValid,
    fpsIsCampaignMetric,
    gpuPasses: gpu,
    gpuSamples: sample.gpuN,
    shotPath,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(row, null, 2));
  console.log(`[perf-mobile] wrote ${outPath}`);
  if (!meterValid) process.exitCode = 2;
}

main().catch((e: unknown) => {
  console.error('[perf-mobile] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
