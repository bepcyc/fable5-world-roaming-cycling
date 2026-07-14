/**
 * record-demo — 20s road-bike simulation video demo generator.
 *
 * Spawns a ROAD bike (mode 'road') at a RANDOM point (different every run —
 * Math.random(), tool-only per CLAUDE.md: randomness lives in tools/, never
 * in src/) on a randomly-chosen asphalt OR gravel-fine route, pedals it
 * smoothly through 100-300 W, records real-time video with Playwright, trims
 * to exactly --dur seconds starting once the bike is actually moving
 * (>5 km/h — boot/teleport warm-up frames are not counted), transcodes to
 * mp4 (h264, <45MB), and pulls 3 still frames at +5s/+10s/+15s.
 *
 * Usage:
 *   npx tsx tools/record-demo.ts [--dur 20] [--res 1920x1080] [--seed 1] [--T 11]
 *     [--route <name>] [--edge <id>] [--s <m>] [--dir 1|-1]
 *
 * Spawn overrides (exact-replay support): --edge pins the edge by id (beats
 * --route; a pinned edge is exempt from the MIN_EDGE_LEN filter), --route
 * restricts the random pick to one named route, --s / --dir pin the arc
 * position (clamped to [MARGIN_M, length-MARGIN_M]) and direction. The power
 * ramp phases (phi0/phi1) stay random — overrides fix the spawn POINT, not
 * the power trace.
 *
 * Output: shots/wip/demo-<unix-ts>/{demo.mp4,f05.png,f10.png,f15.png}
 *
 * Known base (verified by the reader-scout pass before writing this file):
 *  - tools/wx-gate.ts        — moving-capture URL pattern (?ridedev=1) +
 *                               __laasDbg.ride.teleport/setPower.
 *  - tools/probe-hudwarn.ts  — __laasDbg.rideGraph edge scan (page-side
 *                               STRING eval — esbuild's dev __name-wrapping
 *                               of nested arrow/map callbacks breaks when
 *                               Playwright re-serializes a passed FUNCTION;
 *                               a template-literal string sidesteps it
 *                               entirely, so all __laasDbg-touching page
 *                               logic below uses string eval, matching
 *                               established tool style) + teleportEdge +
 *                               ride.kmh100 counter.
 *  - src/ride/BikeRig.ts     — teleportEdge(edgeId, s, dir) is the "probe
 *                               API" direct-placement entry point (mounts
 *                               'road' mode from 'hike', no MOUNT_MAX_DIST
 *                               gate); setPower(w) drives KeyboardPowerSource
 *                               (?ridedev=1), which itself eases toward the
 *                               target with a 0.35s tau — smooth pedaling
 *                               falls out of that ramp even at ~200ms ticks.
 *  - src/ride/SurfaceMatrix.ts — SurfaceId.Asphalt=10, GravelFine=11; both
 *                               are 'allowed' in road mode.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';

// ---- CLI -------------------------------------------------------------------

interface Cli {
  dur: number;
  width: number;
  height: number;
  seed: number;
  t: number;
  /** spawn overrides — replay a demo at the exact same place */
  route?: string;
  edge?: number;
  s?: number;
  dir?: 1 | -1;
}

function parseCli(argv: string[]): Cli {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const res = get('--res') ?? '1920x1080';
  const m = /^(\d+)x(\d+)$/.exec(res);
  if (!m) throw new Error(`bad --res "${res}" (expected WIDTHxHEIGHT)`);
  const num = (flag: string): number | undefined => {
    const v = get(flag);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`bad ${flag} "${v}" (expected a number)`);
    return n;
  };
  const dirN = num('--dir');
  if (dirN !== undefined && dirN !== 1 && dirN !== -1) {
    throw new Error(`bad --dir "${dirN}" (expected 1 or -1)`);
  }
  return {
    dur: Number(get('--dur') ?? 20),
    width: Number(m[1]),
    height: Number(m[2]),
    seed: Number(get('--seed') ?? 1),
    t: Number(get('--T') ?? 11),
    route: get('--route'),
    edge: num('--edge'),
    s: num('--s'),
    dir: dirN as 1 | -1 | undefined,
  };
}

// ---- small helpers -----------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    stdio: 'inherit',
  });
}

function ffprobeDurationSec(path: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]).toString('utf8');
  return parseFloat(out.trim());
}

function sizeMB(path: string): number {
  return statSync(path).size / (1024 * 1024);
}

// ---- route/point selection (page-side data; Node-side RNG) -----------------

interface EdgeInfo {
  id: number;
  route: string;
  length: number;
}

interface RoadData {
  asphalt: EdgeInfo[];
  gravelFine: EdgeInfo[];
}

const MARGIN_M = 30; // owner spec: not closer than ~30m to either end
const MIN_EDGE_LEN = MARGIN_M * 2 + 20; // leaves >=20m of usable spawn range

async function fetchRoadData(page: Page, minLen: number): Promise<RoadData> {
  return page.evaluate(`(() => {
    const graph = window.__laasDbg.rideGraph;
    const out = { asphalt: [], gravelFine: [] };
    for (const e of graph.edges) {
      if (e.length < ${minLen}) continue;
      // SurfaceId.Asphalt=10, SurfaceId.GravelFine=11 (src/ride/SurfaceMatrix.ts)
      if (e.cls.surfaceId === 10) out.asphalt.push({ id: e.id, route: e.route, length: e.length });
      else if (e.cls.surfaceId === 11) out.gravelFine.push({ id: e.id, route: e.route, length: e.length });
    }
    return out;
  })()`) as Promise<RoadData>;
}

interface SpawnChoice {
  clsName: 'asphalt' | 'gravel-fine';
  edge: EdgeInfo;
  s: number;
  dir: 1 | -1;
}

function chooseSpawn(data: RoadData, cli: Cli): SpawnChoice {
  type Pool = { clsName: 'asphalt' | 'gravel-fine'; edges: EdgeInfo[] };
  let pools: Pool[] = [
    { clsName: 'asphalt', edges: data.asphalt },
    { clsName: 'gravel-fine', edges: data.gravelFine },
  ];

  let clsName: 'asphalt' | 'gravel-fine';
  let edge: EdgeInfo;
  if (cli.edge !== undefined) {
    // exact edge id: beats --route and the random pick entirely
    const hit = pools
      .map((p) => ({ clsName: p.clsName, e: p.edges.find((e) => e.id === cli.edge) }))
      .find((h) => h.e !== undefined);
    if (!hit?.e) {
      const ids = pools
        .flatMap((p) => p.edges.map((e) => e.id))
        .sort((a, b) => a - b);
      throw new Error(
        `--edge ${cli.edge} not found among asphalt/gravel-fine edges (available ids: ${ids.join(', ')})`,
      );
    }
    clsName = hit.clsName;
    edge = hit.e;
  } else {
    if (cli.route !== undefined) {
      pools = pools.map((p) => ({
        clsName: p.clsName,
        edges: p.edges.filter((e) => e.route === cli.route),
      }));
    }
    const nonEmpty = pools.filter((p) => p.edges.length > 0);
    if (nonEmpty.length === 0) {
      throw new Error(
        cli.route !== undefined
          ? `--route "${cli.route}" matched no asphalt/gravel-fine edge (seed/T mismatch?)`
          : `no asphalt or gravel-fine edge >= ${MIN_EDGE_LEN}m found on the network (seed/T mismatch?)`,
      );
    }
    const pool = nonEmpty[Math.floor(Math.random() * nonEmpty.length)] as Pool;
    clsName = pool.clsName;
    edge = pool.edges[Math.floor(Math.random() * pool.edges.length)] as EdgeInfo;
  }

  let s: number;
  if (cli.s !== undefined) {
    s = Math.min(Math.max(cli.s, MARGIN_M), edge.length - MARGIN_M);
    if (s !== cli.s) {
      console.warn(
        `[record-demo] --s ${cli.s} clamped to ${s.toFixed(1)} (edge ${edge.id} length ${edge.length.toFixed(1)}m, margin ${MARGIN_M}m)`,
      );
    }
  } else {
    s = MARGIN_M + Math.random() * Math.max(edge.length - 2 * MARGIN_M, 0);
  }
  const dir: 1 | -1 = cli.dir ?? (Math.random() < 0.5 ? 1 : -1);
  return { clsName, edge, s, dir };
}

interface SpawnPoint {
  x: number;
  z: number;
  y: number;
}

async function teleportTo(page: Page, choice: SpawnChoice): Promise<SpawnPoint> {
  return page.evaluate(`(() => {
    const dbg = window.__laasDbg;
    dbg.ride.teleportEdge(${choice.edge.id}, ${choice.s}, ${choice.dir});
    const sm = dbg.rideGraph.sample(${choice.edge.id}, ${choice.s});
    return { x: sm.x, z: sm.z, y: sm.y };
  })()`) as Promise<SpawnPoint>;
}

// ---- smooth 100-300W power curve --------------------------------------------
// 200 +/- 80 (9s period) +/- 20 (3.7s period), random phase per run — the sum
// of amplitudes is exactly 100, so the curve is provably within [100,300]
// for any phase, no clamping needed.
function powerAt(tSec: number, phi0: number, phi1: number): number {
  return (
    200 +
    80 * Math.sin((2 * Math.PI * tSec) / 9 + phi0) +
    20 * Math.sin((2 * Math.PI * tSec) / 3.7 + phi1)
  );
}

async function tick(page: Page, w: number): Promise<number> {
  // returns ride.kmh100 (km/h * 100) after applying the new power target
  return page.evaluate(`(() => {
    window.__laasDbg.ride.setPower(${w.toFixed(1)});
    const c = window.__laas.stats && window.__laas.stats.counters;
    return c ? (c['ride.kmh100'] || 0) : 0;
  })()`) as Promise<number>;
}

// ---- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const outDir = join('shots/wip', `demo-${Date.now()}`);
  const rawDir = join(outDir, '.rawtmp');
  mkdirSync(rawDir, { recursive: true });

  console.log(
    `[record-demo] dur=${cli.dur}s res=${cli.width}x${cli.height} seed=${cli.seed} T=${cli.t} -> ${outDir}`,
  );

  const { browser, info } = await launchWebGPUReal();
  console.log(`[record-demo] adapter ${info.vendor}/${info.architecture}`);

  const context = await browser.newContext({
    viewport: { width: cli.width, height: cli.height },
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: { width: cli.width, height: cli.height } },
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const video = page.video();
  const t0 = Date.now(); // video-clock zero point (page creation)

  const url =
    `${LAAS_ORIGIN}/?scene=world&seed=${cli.seed}&T=${cli.t}&preset=high&hud=0&ridedev=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const bootError = await page.evaluate(() => window.__laas.error);
  if (bootError) throw new Error(`fatal boot error: ${bootError}`);
  console.log(`[record-demo] world ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // an explicitly requested edge/route must not be dropped by the length filter
  const roadData = await fetchRoadData(
    page,
    cli.edge !== undefined || cli.route !== undefined ? 0 : MIN_EDGE_LEN,
  );
  console.log(
    `[record-demo] candidates: asphalt=${roadData.asphalt.length} gravel-fine=${roadData.gravelFine.length}`,
  );
  const choice = chooseSpawn(roadData, cli);
  const point = await teleportTo(page, choice);
  console.log(
    `[record-demo] spawn: class=${choice.clsName} route="${choice.edge.route}" edge=${choice.edge.id} ` +
      `s=${choice.s.toFixed(1)}/${choice.edge.length.toFixed(1)}m dir=${choice.dir} ` +
      `x=${point.x.toFixed(1)} z=${point.z.toFixed(1)}`,
  );

  // ---- pedal smoothly through 100-300W; find the moment speed > 5 km/h -----
  const phi0 = Math.random() * 2 * Math.PI;
  const phi1 = Math.random() * 2 * Math.PI;
  const rampStart = Date.now();
  const TICK_MS = 200;
  const MAX_WAIT_MOTION_MS = 30_000;
  let motionAt: number | null = null;
  let lastKmh = 0;
  for (;;) {
    const tSec = (Date.now() - rampStart) / 1000;
    const w = powerAt(tSec, phi0, phi1);
    const kmh100 = await tick(page, w);
    lastKmh = kmh100 / 100;
    if (motionAt === null && lastKmh > 5) {
      motionAt = Date.now();
      console.log(
        `[record-demo] motion: ${lastKmh.toFixed(1)} km/h at t=${((motionAt - t0) / 1000).toFixed(1)}s (video clock)`,
      );
    }
    if (motionAt === null && Date.now() - rampStart > MAX_WAIT_MOTION_MS) {
      throw new Error(
        `bike never exceeded 5 km/h within ${MAX_WAIT_MOTION_MS}ms (stalled? last=${lastKmh.toFixed(1)} km/h, ` +
          `class=${choice.clsName} route=${choice.edge.route})`,
      );
    }
    if (motionAt !== null && Date.now() - motionAt >= cli.dur * 1000 + 1500) break;
    await sleep(TICK_MS);
  }
  const offsetSec = Math.max(0, (motionAt as number - t0) / 1000);

  await context.close(); // finalizes the webm
  if (!video) throw new Error('no video recorded (recordVideo context option missing?)');
  const rawWebm = join(outDir, 'raw.webm');
  await video.saveAs(rawWebm); // must run before browser.close() (needs a live connection)
  await browser.close();
  rmSync(rawDir, { recursive: true, force: true });
  if (!existsSync(rawWebm)) throw new Error(`raw video not written: ${rawWebm}`);
  console.log(
    `[record-demo] raw video ${(sizeMB(rawWebm)).toFixed(1)}MB, trim offset=${offsetSec.toFixed(2)}s dur=${cli.dur}s`,
  );

  // ---- trim to exactly [offset, offset+dur) and transcode to mp4 -----------
  const mp4Path = join(outDir, 'demo.mp4');
  let crf = 20;
  for (;;) {
    ffmpeg([
      '-ss', offsetSec.toFixed(3),
      '-i', rawWebm,
      '-t', String(cli.dur),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-an',
      mp4Path,
    ]);
    const mb = sizeMB(mp4Path);
    if (mb <= 45 || crf >= 32) {
      if (mb > 45) {
        console.warn(
          `[record-demo] WARNING: ${mp4Path} is ${mb.toFixed(1)}MB (>45MB) even at crf=${crf} — Telegram sendVideo (50MB) may reject it`,
        );
      } else if (crf > 20) {
        console.log(`[record-demo] raised crf to ${crf} to fit under 45MB`);
      }
      break;
    }
    crf += 4;
  }
  const finalMB = sizeMB(mp4Path);
  const durSec = ffprobeDurationSec(mp4Path);
  console.log(
    `[record-demo] demo.mp4: ${finalMB.toFixed(1)}MB, ffprobe duration=${durSec.toFixed(2)}s, crf=${crf}`,
  );

  // ---- 3 still frames at +5s / +10s / +15s of the trimmed clip -------------
  for (const [name, at] of [
    ['f05.png', 5],
    ['f10.png', 10],
    ['f15.png', 15],
  ] as const) {
    ffmpeg(['-ss', String(at), '-i', mp4Path, '-frames:v', '1', join(outDir, name)]);
  }

  // rawWebm was intermediate only — drop it, the trimmed mp4 is the deliverable
  rmSync(rawWebm, { force: true });

  console.log('[record-demo] done');
  console.log(JSON.stringify({
    outDir,
    mp4: mp4Path,
    frames: [join(outDir, 'f05.png'), join(outDir, 'f10.png'), join(outDir, 'f15.png')],
    surfaceClass: choice.clsName,
    route: choice.edge.route,
    edge: choice.edge.id,
    spawn: { x: point.x, z: point.z },
    durationRequestedSec: cli.dur,
    durationActualSec: durSec,
    sizeMB: finalMB,
    resolution: `${cli.width}x${cli.height}`,
  }, null, 2));
}

main().catch((e: unknown) => {
  console.error('[record-demo] FAILED:', e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
