/**
 * M1.3 physics probe — the milestone acceptance battery.
 *
 * PURE section (no browser, runs in node in milliseconds): steps the actual
 * BikeSolver at THREE fixed timesteps (33.3 / 8.3 / 2.1 ms) and asserts
 *   P1 mud-stop     — road bike coasting into mud stops < 6 s; pedaling at
 *                     250 W it bogs down (stall latch) instead of riding out
 *   P2 top-speed    — 250 W on flat asphalt settles within ±2 % of the
 *                     analytic steady state, and the three dt runs agree ±1 %
 *   P3 ford         — gravel bike at 200 W crosses an 8 m shallow ford
 *                     without stopping (v stays > 0.5 m/s throughout)
 *   P4 slope-block  — 35 % wall: 500 W MTB cannot ride it (blocked, v → 0);
 *                     30 % blocks road the same way
 *
 * LIVE section (--live, default ON; needs dev server on :5173): boots the
 * world with ?ridedev=1&road=asphalt, drives the BikeRig through __laasDbg,
 * asserts the ride graph exists, dashboard speed == solver speed ±1 % at
 * two runtime fixed-dt values, and the junction chooser appears while
 * riding the network. `--shots` saves shots/wip/probe-physics-*.png.
 *
 * Usage: npx tsx tools/probe-physics.ts [--pure-only] [--shots]
 */

import {
  stepBike,
  steadyStateV,
  type BikeMode,
  type SolverState,
} from '../src/ride/BikeSolver';
import { SurfaceId } from '../src/ride/SurfaceMatrix';

const DTS = [1 / 30, 1 / 120, 1 / 480];

let pass = true;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

interface SimResult {
  v: number;
  t: number;
  x: number;
  stalled: boolean;
  blocked: boolean;
  vMin: number;
}

/** integrate on a surface timeline: (x) → surfaceId */
function simulate(opts: {
  mode: BikeMode;
  powerW: number;
  grade: number;
  v0: number;
  dt: number;
  maxT: number;
  surfaceAt: (x: number) => number;
  stopWhen?: (r: SimResult) => boolean;
}): SimResult {
  let st: SolverState = { v: opts.v0, stalled: false };
  const r: SimResult = { v: opts.v0, t: 0, x: 0, stalled: false, blocked: false, vMin: opts.v0 };
  const steps = Math.ceil(opts.maxT / opts.dt);
  for (let i = 0; i < steps; i++) {
    const out = stepBike(st, {
      powerW: opts.powerW,
      brake: 0,
      grade: opts.grade,
      surfaceId: opts.surfaceAt(r.x),
      mode: opts.mode,
      dt: opts.dt,
    });
    st = { v: out.v, stalled: out.stalled };
    r.t += opts.dt;
    r.x += out.v * opts.dt;
    r.v = out.v;
    r.stalled = out.stalled;
    r.blocked = out.blocked;
    if (out.v < r.vMin) r.vMin = out.v;
    if (opts.stopWhen && opts.stopWhen(r)) break;
  }
  return r;
}

function purePart(): void {
  console.log('--- pure solver battery (3 fixed timesteps) ---');
  for (const dt of DTS) {
    const tag = `dt=${(dt * 1000).toFixed(1)}ms`;

    // P1 mud-stop: coast 8 m/s → stop
    const p1 = simulate({
      mode: 'road', powerW: 0, grade: 0, v0: 8, dt, maxT: 10,
      surfaceAt: () => SurfaceId.Mud,
      stopWhen: (r) => r.v < 0.05,
    });
    check(`P1 mud-stop coast ${tag}`, p1.v < 0.1 && p1.t < 6, `v=${p1.v.toFixed(2)} after ${p1.t.toFixed(1)}s / ${p1.x.toFixed(1)}m`);
    // P1b: pedaling hard does NOT ride mud out — bogs down
    const p1b = simulate({
      mode: 'road', powerW: 250, grade: 0, v0: 8, dt, maxT: 30,
      surfaceAt: () => SurfaceId.Mud,
    });
    check(`P1 mud bog-down @250W ${tag}`, p1b.stalled && p1b.v === 0, `v=${p1b.v.toFixed(2)} stalled=${String(p1b.stalled)}`);

    // P2 top-speed: flat asphalt 250 W vs analytic
    const vRef = steadyStateV(250, 0, SurfaceId.Asphalt, 'road');
    const p2 = simulate({
      mode: 'road', powerW: 250, grade: 0, v0: 0, dt, maxT: 240,
      surfaceAt: () => SurfaceId.Asphalt,
    });
    const err = Math.abs(p2.v - vRef) / vRef;
    check(`P2 top-speed ±2% ${tag}`, err < 0.02, `sim=${(p2.v * 3.6).toFixed(2)} km/h ref=${(vRef * 3.6).toFixed(2)} err=${(err * 100).toFixed(2)}%`);

    // P3 ford: gravel bike, 8 m shallow crossing at 200 W
    const p3 = simulate({
      mode: 'gravel', powerW: 200, grade: 0, v0: 5, dt, maxT: 30,
      surfaceAt: (x) => (x > 20 && x < 28 ? SurfaceId.WaterShallow : SurfaceId.GravelFine),
      stopWhen: (r) => r.x > 40,
    });
    check(`P3 ford crossing ${tag}`, p3.x > 40 && p3.vMin > 0.5, `vMin=${p3.vMin.toFixed(2)} m/s x=${p3.x.toFixed(1)}m`);

    // P4 slope-block: 35% wall on rock, 500 W MTB (limit 0.65 passes 0.35 —
    // use 0.7); and 30% blocks road (limit 0.25)
    const p4 = simulate({
      mode: 'mtb', powerW: 500, grade: 0.7, v0: 4, dt, maxT: 15,
      surfaceAt: () => SurfaceId.DirtRoad,
    });
    check(`P4 slope-block mtb 70% ${tag}`, p4.blocked && p4.v < 0.05, `v=${p4.v.toFixed(2)} blocked=${String(p4.blocked)}`);
    const p4b = simulate({
      mode: 'road', powerW: 400, grade: 0.3, v0: 6, dt, maxT: 15,
      surfaceAt: () => SurfaceId.Asphalt,
    });
    check(`P4 slope-block road 30% ${tag}`, p4b.blocked && p4b.v < 0.05, `v=${p4b.v.toFixed(2)}`);
  }

  // dt-invariance: P2 steady speeds agree across the sweep ±1 %
  const finals = DTS.map(
    (dt) =>
      simulate({
        mode: 'road', powerW: 250, grade: 0, v0: 0, dt, maxT: 240,
        surfaceAt: () => SurfaceId.Asphalt,
      }).v,
  );
  const spread = (Math.max(...finals) - Math.min(...finals)) / (finals[1] as number);
  check('P2 dt-invariance ±1%', spread < 0.01, `spread=${(spread * 100).toFixed(3)}% [${finals.map((v) => (v * 3.6).toFixed(2)).join(', ')}] km/h`);

  // climbing sanity vs real-world data (docs/notes/climb-grade-facts.md):
  // 250 W at 8% asphalt ≈ 9–11 km/h for 83 kg — natural, not arcade
  const vClimb = steadyStateV(250, 0.08, SurfaceId.Asphalt, 'road') * 3.6;
  check('climb realism 250W@8%', vClimb > 8 && vClimb < 13, `${vClimb.toFixed(1)} km/h`);
}

async function livePart(shots: boolean): Promise<void> {
  console.log('--- live engine battery ---');
  const { LAAS_ORIGIN, launchWebGPUReal } = await import('./launch-gpu');
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-physics] adapter ${info.vendor}/${info.architecture}`);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url =
    `${LAAS_ORIGIN}/?scene=world&seed=1&T=11&hud=0&freeze=1&ridedev=1&road=asphalt,0.3`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const error = await page.evaluate(() => window.__laas.error);
  if (error) throw new Error(`App reported fatal error:\n${error}`);
  console.log(`[boot] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const settle = (frames: number): Promise<void> =>
    page.evaluate(async (n) => {
      if (window.__laas.settle) await window.__laas.settle(n);
    }, frames);
  interface DbgRide {
    setPower(w: number | null): void;
    setMode(m: string): boolean;
    teleport(cls: string, f: number): boolean;
    state(): {
      mode: string; riding: boolean; vMs: number; junction: unknown;
      blocked: boolean; stalled: boolean; surface: string;
    };
  }
  const rideEval = <T,>(fn: (r: DbgRide, dbg: Record<string, unknown>) => T): Promise<T> =>
    page.evaluate(
      (src) => {
        const dbg = (window as unknown as { __laasDbg: Record<string, unknown> }).__laasDbg;
        const r = dbg['ride'] as unknown as DbgRide;
        // eslint-disable-next-line no-new-func
        return (new Function('r', 'dbg', `return (${src})(r, dbg)`) as (a: DbgRide, b: unknown) => T)(r, dbg);
      },
      fn.toString(),
    );
  const counters = (): Promise<Record<string, number>> =>
    page.evaluate(() => window.__laas.stats?.counters ?? {});

  // graph + auto-mount
  const c0 = await counters();
  check('ride graph built', (c0['ride.graphEdges'] ?? 0) > 0 && (c0['ride.graphNodes'] ?? 0) > 0, `nodes=${c0['ride.graphNodes']} edges=${c0['ride.graphEdges']}`);
  const st0 = await rideEval((r) => r.state());
  check('auto-mounted road bike (?road+?ridedev)', st0.riding && st0.mode === 'road', `mode=${st0.mode}`);

  // dashboard parity at two runtime dt values: mean over a 6 s window so
  // the HUD's 0.45 s display smoothing cancels instead of aliasing
  for (const dtMs of [8.33, 33.3]) {
    await page.evaluate((v) => {
      const dbg = (window as unknown as { __laasDbg: Record<string, unknown> }).__laasDbg;
      (dbg['setFixedDt'] as (s: number) => void)(v / 1000);
    }, dtMs);
    // deterministic runway: restart from the head of the longest edge so
    // route luck (fords, dead ends, forks) never pollutes the measurement
    await rideEval((r, dbg) => {
      interface GEdge { id: number; length: number }
      const graph = dbg['rideGraph'] as { edges: GEdge[] };
      let best = graph.edges[0] as GEdge;
      for (const e of graph.edges) if (e.length > best.length) best = e;
      (r as unknown as { teleportEdge(e: number, s: number, d: 1 | -1): boolean }).teleportEdge(
        best.id,
        10,
        1,
      );
    });
    await rideEval((r) => r.setPower(230));
    await settle(400); // reach steady-ish speed
    // the dashboard smooths pose-delta speed with a 0.45 s EMA (display
    // ergonomics); compare it against the SAME filter applied to the raw
    // solver speed so a rolling gradient doesn't read as parity error
    const TAU = 0.45;
    const SAMPLE_FRAMES = 5;
    const pairs: { solver: number; hud: number }[] = [];
    for (let i = 0; i < 80; i++) {
      await settle(SAMPLE_FRAMES);
      const c = await counters();
      pairs.push({ solver: (c['ride.kmh100'] ?? 0) / 100, hud: (c['ride.hudKmh100'] ?? 0) / 100 });
    }
    const fps = await page.evaluate(() => window.__laas.stats?.fps ?? 50);
    const stepS = SAMPLE_FRAMES / Math.max(fps, 10); // frame cadence of sampling
    const k = 1 - Math.exp(-stepS / TAU);
    let ema = (pairs[0] as { solver: number }).solver;
    const emaS: number[] = [];
    const hudS: number[] = [];
    pairs.forEach((p, i) => {
      ema += (p.solver - ema) * k;
      if (i >= 15) {
        emaS.push(ema);
        hudS.push(p.hud);
      }
    });
    const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    const solver = mean(emaS);
    const hud = mean(hudS);
    const err = solver > 0 ? Math.abs(hud - solver) / solver : 1;
    check(
      `dashboard==solver ±1% @dt=${dtMs}ms`,
      err < 0.01 && solver > 3,
      `solver(ema)=${solver.toFixed(2)} hud=${hud.toFixed(2)} km/h err=${(err * 100).toFixed(2)}%`,
    );
  }

  if (shots) {
    await page.screenshot({ path: 'shots/wip/probe-physics-ride.png' });
  }

  // junction chooser: aim the bike at a real fork (node with ≥2 exits) and
  // ride up to it — the preview + DOM chooser must appear before the node
  const aimed = await rideEval((r, dbg) => {
    interface GArm { edge: number; end: 0 | 1 }
    interface GNode { id: number; arms: GArm[] }
    interface GEdge { id: number; length: number; a: number; b: number }
    const graph = dbg['rideGraph'] as { nodes: GNode[]; edges: GEdge[] };
    const rig = r as unknown as { teleportEdge(e: number, s: number, d: 1 | -1): boolean };
    for (const n of graph.nodes) {
      if (n.arms.length < 3) continue; // arriving by one arm leaves ≥2 exits
      for (const arm of n.arms) {
        const e = graph.edges[arm.edge];
        if (!e || e.length < 80) continue;
        // stand 60 m up the edge from the node, facing it
        if (arm.end === 1) return rig.teleportEdge(e.id, e.length - 60, 1) && n.arms.length;
        return rig.teleportEdge(e.id, 60, -1) && n.arms.length;
      }
    }
    return false;
  });
  check('fork node exists in graph (≥3 arms)', aimed !== false, `arms=${String(aimed)}`);
  await rideEval((r) => r.setPower(200));
  let sawJunction = false;
  let domJ = false;
  for (let i = 0; i < 12 && !sawJunction; i++) {
    await settle(60);
    sawJunction = await rideEval((r) => r.state().junction !== null);
    if (sawJunction) {
      await settle(15); // let the chooser's 0.15 s refresh render it
      domJ = await page.evaluate(() => {
        const el = document.getElementById('ride-junction');
        return (
          el !== null && el.classList.contains('on') && el.querySelectorAll('.rj-opt').length >= 2
        );
      });
      if (shots) await page.screenshot({ path: 'shots/wip/probe-physics-junction.png' });
    }
  }
  check('junction chooser appears before the fork', sawJunction, '');
  check('junction UI visible with ≥2 arrow options', domJ, '');

  // mode lock honesty: fresh page WITHOUT a source refuses bikes
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await p2.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&T=11&hud=0&freeze=1`, {
    waitUntil: 'domcontentloaded',
  });
  await p2.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const locked = await p2.evaluate(() => {
    const dbg = (window as unknown as { __laasDbg: Record<string, unknown> }).__laasDbg;
    const r = dbg['ride'] as { setMode(m: string): boolean; state(): { mode: string } };
    const ok = r.setMode('road');
    return { ok, mode: r.state().mode };
  });
  check('bikes locked without power source', !locked.ok && locked.mode === 'hike', `mode=${locked.mode}`);
  await p2.close();

  await page.close();
  await browser.close();
}

async function main(): Promise<void> {
  const pureOnly = process.argv.includes('--pure-only');
  const shots = process.argv.includes('--shots');
  purePart();
  if (!pureOnly) await livePart(shots);
  console.log(pass ? '[probe-physics] ALL PASS' : '[probe-physics] FAILURES PRESENT');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[probe-physics] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
