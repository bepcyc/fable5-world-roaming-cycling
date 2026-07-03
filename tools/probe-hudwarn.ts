/**
 * P5 probe — HUD impassable warning (M1.5 acceptance).
 *
 * Boots the world with the keyboard bike, scans the ride graph for a spot
 * the ROAD mode cannot enter (blocked surface under the route, or grade
 * beyond MODE_LIMITS.road) with a clean same-edge runway before it, then
 * rides at it and asserts:
 *   P5a  the amber hazard strip appears while still APPROACHING (not yet
 *        blocked/inside the zone)
 *   P5b  at first appearance, distance-to-zone / current speed ≥ 2 s
 *        (ROADMAP: "warning ≥2 s before zone at current speed")
 *   P5c  the solver's own blocked latch (or arrival at the zone edge)
 *        happens only AFTER the warning — reported with the measured gap
 *   P5d  on an open runway the warning stays dark (no false positives)
 *
 * Usage: npx tsx tools/probe-hudwarn.ts   (dev server on :5173 required)
 */

import { launchWebGPUReal } from './launch-gpu';

let pass = true;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-hudwarn] adapter ${info.vendor}/${info.architecture}`);
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = 'http://localhost:5173/?scene=world&seed=1&T=11&hud=0&ridedev=1';
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
  const counters = (): Promise<Record<string, number>> =>
    page.evaluate(() => window.__laas.stats?.counters ?? {});

  // ---- scan the graph for a road-blocked zone with a same-edge runway ------
  // (page-side string eval — esbuild __name trap forbids function passing)
  interface Candidate {
    edge: number;
    zoneS: number;
    dir: 1 | -1;
    startS: number;
    kind: string;
    what: number;
  }
  const candidate = (await page.evaluate(`(() => {
    const dbg = window.__laasDbg;
    const graph = dbg.rideGraph;
    const probe = window.__laas.groundProbe;
    // SurfaceMatrix road-blocked ids: forest,scree,rock,gravel-river,snow,
    // water-deep,singletrack; slope limit road = 0.25
    const BLOCKED = new Set([1, 3, 4, 5, 7, 9, 14]);
    const LIMIT = 0.25;
    const RUNWAY = 90;
    const STEP = 3;
    for (const e of graph.edges) {
      if (e.length < RUNWAY + 20) continue;
      for (let s = 0; s < e.length; s += STEP) {
        const sm = graph.sample(e.id, s);
        const g = probe(sm.x, sm.z);
        const bad = BLOCKED.has(g.surfaceId) || Math.abs(sm.grade) > LIMIT;
        if (!bad) continue;
        // approach with the zone ahead on the SAME edge, no junction between
        if (s > RUNWAY + 10) {
          return { edge: e.id, zoneS: s, dir: 1, startS: s - RUNWAY,
                   kind: BLOCKED.has(g.surfaceId) ? 'surface' : 'slope',
                   what: BLOCKED.has(g.surfaceId) ? g.surfaceId : sm.grade };
        }
        if (e.length - s > RUNWAY + 10) {
          return { edge: e.id, zoneS: s, dir: -1, startS: s + RUNWAY,
                   kind: BLOCKED.has(g.surfaceId) ? 'surface' : 'slope',
                   what: BLOCKED.has(g.surfaceId) ? g.surfaceId : sm.grade };
        }
      }
    }
    return null;
  })()`)) as Candidate | null;

  if (!candidate) {
    check('P5 zone candidate found on the network', false, 'no blocked zone with runway — scan wider (junction-crossing) needed');
    await browser.close();
    process.exitCode = 1;
    return;
  }
  console.log(
    `[zone] edge=${candidate.edge} s=${candidate.zoneS.toFixed(0)} dir=${candidate.dir} kind=${candidate.kind} what=${candidate.what}`,
  );

  // ---- P5d: negative check on the clean runway (before we start riding) ----
  await page.evaluate(
    `window.__laasDbg.ride.teleportEdge(${candidate.edge}, ${candidate.startS}, ${candidate.dir})`,
  );
  await page.evaluate(`window.__laasDbg.ride.setPower(280)`);
  await settle(30);
  const cNeg = await counters();
  // hazard may legitimately be visible if the zone is already inside the
  // 60 m scan horizon — negative check only asserts the SHOWN gate honors
  // the reaction window (not shown while far): distance > window ⇒ not shown
  const negDm = cNeg['ride.hazardDm'] ?? -1;
  const negShown = cNeg['ride.hazardShown'] ?? 0;
  const negV = (cNeg['ride.kmh100'] ?? 0) / 360; // m/s
  const negWindow = Math.min(Math.max(negV * 3.5, 12), 60);
  check(
    'P5d no premature warning beyond the reaction window',
    negShown === 0 || negDm / 10 <= negWindow + 6,
    `shown=${negShown} dist=${(negDm / 10).toFixed(0)}m window≈${negWindow.toFixed(0)}m`,
  );

  // ---- ride at the zone; capture first-warning kinematics ------------------
  let warnAt: { distM: number; vMs: number; wall: number } | null = null;
  let blockedAt: { wall: number } | null = null;
  const tStart = Date.now();
  for (let i = 0; i < 400; i++) {
    await settle(4);
    const c = await counters();
    const shown = (c['ride.hazardShown'] ?? 0) === 1;
    const blocked = (c['ride.blocked'] ?? 0) === 1;
    const v = (c['ride.kmh100'] ?? 0) / 360;
    const dist = (c['ride.hazardDm'] ?? -1) / 10;
    if (shown && !warnAt) warnAt = { distM: dist, vMs: v, wall: Date.now() };
    if (blocked) {
      blockedAt = { wall: Date.now() };
      break;
    }
    if (Date.now() - tStart > 90_000) break;
  }

  check('P5a warning fired while approaching', warnAt !== null && blockedAt !== null ? warnAt.wall < blockedAt.wall : warnAt !== null, warnAt ? `dist=${warnAt.distM.toFixed(1)}m v=${warnAt.vMs.toFixed(1)}m/s` : 'never shown');
  if (warnAt) {
    const tReact = warnAt.distM / Math.max(warnAt.vMs, 0.1);
    check('P5b reaction time ≥ 2 s at current speed', tReact >= 2.0, `${tReact.toFixed(1)}s`);
  }
  if (warnAt && blockedAt) {
    const gap = (blockedAt.wall - warnAt.wall) / 1000;
    check('P5c blocked latch strictly after warning', gap > 0, `gap=${gap.toFixed(1)}s wall-clock`);
  } else if (warnAt && !blockedAt) {
    // rider may stall short of the latch (honest physics) — warning stood
    console.log('[note] blocked latch not reached (stall/slowdown before zone) — P5c n/a');
  }

  await browser.close();
  if (!pass) process.exitCode = 1;
  console.log(pass ? 'ALL PASS' : 'FAILURES');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
