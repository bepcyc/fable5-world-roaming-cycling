/**
 * Dead-end gate — integration test over the runtime RIDE GRAPH (RouteGraph).
 *
 * Owner directive (2026-07-14, дословно по смыслу): «сделай гейт по количеству
 * ТУПИКОВ дорог — их сейчас невероятное количество; доведи на 3 рандомных
 * сидах до НЕ БОЛЕЕ 1 тупика на большой квадрант. Дороги, по которым нельзя
 * ездить — заебали.»
 *
 * Boots ?scene=world&seed=N per seed and reads `window.__laasDbg.rideGraph`
 * (the boot-time RouteGraph built from RoadNetwork) plus the heightfield CPU
 * mirror (`__laasDbg.engine.heightfield`, same access as probe-roadgates).
 *
 * DEAD-END DEFINITION -----------------------------------------------------
 * A ride-graph node of DEGREE 1 (arms.length === 1 — a route endpoint that
 * did not cluster into a junction) that is NOT a legitimate terminus:
 *   - world-edge   : |x| or |z| within EDGE_M of ±WORLD_HALF — a road that
 *                    exits the map is a real destination, not a stub.
 *   - water-end    : the endpoint sits on / just ahead of water it cannot
 *                    cross (node fords, standing water at or ahead of the
 *                    tip) — the road honestly stops at the river/lake bank.
 *   - slope-end    : the road's OWN forward continuation runs into terrain
 *                    too steep for its class (grade ahead > maxGrade·SLOPE_MUL
 *                    across the whole forward fan) — a mountain road that
 *                    climbed/ran as far as the flank allows (serpentine
 *                    summit, contour hitting a cliff band). «Упирается в
 *                    склон намеренно.»
 * Everything else — a road ending in open, rideable ground for no physical
 * reason — is an ILLEGITIMATE dead-end (a stub in the middle of a quadrant).
 *
 * GATE: split the world into 4 big quadrants by sign(x)×sign(z). PASS iff
 * EVERY quadrant holds ≤ MAX_DEADENDS_PER_QUADRANT illegitimate dead-ends.
 *
 * Usage: npx tsx tools/probe-deadends.ts [--seeds 1,7,23]
 * Env:   LAAS_PORT (dev server port, default 5174 via tools/launch)
 * Exit:  0 = every seed within the per-quadrant budget, 1 = over budget /
 *            boot failure.
 */

import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { WORLD_HALF } from '../src/world/WorldConst';

// ---------------- thresholds (all tunables live here) ------------------------

/** ≤ this many illegitimate dead-ends per big quadrant is a PASS */
const MAX_DEADENDS_PER_QUADRANT = 1;
/** endpoint within this of a world edge (±WORLD_HALF) = legit map exit
 *  (matches RoadNetwork DEADEND_EDGE_M so the gate agrees with the stitcher) */
const EDGE_M = 45;
/** standing water this deep at / ahead of the tip = the road stops at water */
const WATER_DEPTH_M = 0.3;
/** forward-fan reach used for the water + slope look-ahead (m) */
const AHEAD_M = 16;
/** the road cannot continue if EVERY direction in its forward fan needs a
 *  grade above maxGrade·this — a wall/flank the class can't climb. 1.6 sits
 *  between the class design grade and the A* hard-block (×2.2). */
const SLOPE_MUL = 1.6;

interface DeadEnd {
  nodeId: number;
  x: number;
  z: number;
  y: number;
  route: string;
  cls: string;
  edgeLen: number;
  /** min terrain grade over the forward fan (rise/run) */
  fwdGrade: number;
  maxGrade: number;
  nodeDepth: number;
  fwdWater: boolean;
  nearEdgeDist: number; // nearest point of ANOTHER edge (m)
  excuse: string; // '' = illegitimate dead-end
  quadrant: string;
}

interface SeedDump {
  nodeCount: number;
  edgeCount: number;
  degree1: number;
  deadEnds: DeadEnd[];
}

// ---------------- in-page graph walk -----------------------------------------

async function dumpSeed(page: Page, seed: number): Promise<SeedDump> {
  const t0 = Date.now();
  await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=${seed}&T=12&hud=0&freeze=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(`seed ${seed}: app reported fatal error:\n${bootErr}`);
  console.log(`[boot] seed ${seed} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dump = (await page.evaluate(
    ({ EDGE_M, WATER_DEPTH_M, AHEAD_M, SLOPE_MUL, WORLD_HALF }) => {
      (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
      const w = window as unknown as {
        __laasDbg?: {
          engine?: { heightfield?: unknown };
          rideGraph?: unknown;
        };
      };
      const hf = w.__laasDbg?.engine?.heightfield as {
        heightAtCpu(x: number, z: number): number;
        waterDepthAtCpu(x: number, z: number): number;
      };
      interface RP { x: number; z: number; y: number; ford: boolean; s: number }
      interface Edge {
        id: number;
        route: string;
        cls: { name: string; maxGrade: number };
        pts: RP[];
        length: number;
        a: number;
        b: number;
      }
      interface Node { id: number; x: number; z: number; y: number; arms: { edge: number; end: 0 | 1 }[] }
      const g = w.__laasDbg?.rideGraph as { nodes: Node[]; edges: Edge[] } | undefined;
      if (!g) return null;
      const { nodes, edges } = g;

      // point on `edge` roughly `dist` metres from the endpoint at `end`
      const inwardPoint = (e: Edge, end: 0 | 1, dist: number): RP => {
        const pts = e.pts;
        if (end === 1) {
          const tip = pts[pts.length - 1] as RP;
          for (let i = pts.length - 2; i >= 0; i--) {
            const p = pts[i] as RP;
            if (Math.hypot(p.x - tip.x, p.z - tip.z) >= dist) return p;
          }
          return pts[0] as RP;
        }
        const tip = pts[0] as RP;
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i] as RP;
          if (Math.hypot(p.x - tip.x, p.z - tip.z) >= dist) return p;
        }
        return pts[pts.length - 1] as RP;
      };

      const deadEnds: {
        nodeId: number; x: number; z: number; y: number; route: string; cls: string;
        edgeLen: number; fwdGrade: number; maxGrade: number; nodeDepth: number;
        fwdWater: boolean; nearEdgeDist: number; excuse: string; quadrant: string;
      }[] = [];
      let degree1 = 0;

      for (const node of nodes) {
        if (node.arms.length !== 1) continue;
        degree1++;
        const arm = node.arms[0] as { edge: number; end: 0 | 1 };
        const e = edges[arm.edge] as Edge;
        // forward continuation direction: from an inward reference point
        // THROUGH the tip and beyond
        const ref = inwardPoint(e, arm.end, 15);
        let fx = node.x - ref.x;
        let fz = node.z - ref.z;
        const fl = Math.hypot(fx, fz) || 1;
        fx /= fl;
        fz /= fl;

        const h0 = hf.heightAtCpu(node.x, node.z);
        // continuation corridor (forward cone ±22°, the road's travel
        // direction): excuse only when it is blocked by steep terrain or
        // water. MIN grade over the cone (boxed only if the whole forward
        // corridor is unrideable); sideways ground / water 45° aside is
        // dodgeable, not a terminus.
        let fwdGrade = Infinity;
        let fwdWater = false;
        for (const deg of [-22, 0, 22]) {
          const a = (deg * Math.PI) / 180;
          const dx = fx * Math.cos(a) - fz * Math.sin(a);
          const dz = fx * Math.sin(a) + fz * Math.cos(a);
          for (const D of [AHEAD_M * 0.6, AHEAD_M]) {
            const px = node.x + dx * D;
            const pz = node.z + dz * D;
            const g2 = Math.abs(hf.heightAtCpu(px, pz) - h0) / D;
            if (g2 < fwdGrade) fwdGrade = g2;
            if (hf.waterDepthAtCpu(px, pz) > WATER_DEPTH_M) fwdWater = true;
          }
        }

        // ford flag near the tip (last/first two edge points)
        const tipFord =
          arm.end === 1
            ? (e.pts[e.pts.length - 1] as RP).ford || (e.pts[e.pts.length - 2] as RP)?.ford
            : (e.pts[0] as RP).ford || (e.pts[1] as RP)?.ford;
        const nodeDepth = hf.waterDepthAtCpu(node.x, node.z);

        // distance to the nearest point of a DIFFERENT-ROUTE edge (a true
        // near-miss junction — excludes this route's own split edges so a
        // floating stub reads honestly, not "0 m" from its own neighbour)
        let nearEdgeDist = Infinity;
        for (const oe of edges) {
          if (oe.route === e.route) continue;
          for (const p of oe.pts) {
            const d = Math.hypot(p.x - node.x, p.z - node.z);
            if (d < nearEdgeDist) nearEdgeDist = d;
          }
        }

        // ---- excuse classification ----
        let excuse = '';
        if (Math.max(Math.abs(node.x), Math.abs(node.z)) >= WORLD_HALF - EDGE_M) {
          excuse = 'world-edge';
        } else if (nodeDepth > WATER_DEPTH_M || tipFord || fwdWater) {
          excuse = 'water-end';
        } else if (fwdGrade > (e.cls.maxGrade as number) * SLOPE_MUL) {
          excuse = 'slope-end';
        }

        const quadrant = `${node.z < 0 ? 'N' : 'S'}${node.x < 0 ? 'W' : 'E'}`;
        deadEnds.push({
          nodeId: node.id,
          x: node.x,
          z: node.z,
          y: node.y,
          route: e.route,
          cls: e.cls.name,
          edgeLen: e.length,
          fwdGrade: fwdGrade === Infinity ? -1 : fwdGrade,
          maxGrade: e.cls.maxGrade,
          nodeDepth,
          fwdWater,
          nearEdgeDist,
          excuse,
          quadrant,
        });
      }
      return { nodeCount: nodes.length, edgeCount: edges.length, degree1, deadEnds };
    },
    { EDGE_M, WATER_DEPTH_M, AHEAD_M, SLOPE_MUL, WORLD_HALF },
  )) as SeedDump | null;
  if (!dump) throw new Error(`seed ${seed}: __laasDbg.rideGraph unavailable`);
  return dump;
}

// ---------------- reporting ----------------------------------------------------

const QUADRANTS = ['NE', 'NW', 'SE', 'SW'] as const;

function report(seed: number, dump: SeedDump): boolean {
  const illegit = dump.deadEnds.filter((d) => d.excuse === '');
  const excused = dump.deadEnds.filter((d) => d.excuse !== '');
  console.log(
    `\n=== seed ${seed}: ${dump.nodeCount} nodes, ${dump.edgeCount} edges, ` +
      `${dump.degree1} degree-1 (${excused.length} excused, ${illegit.length} dead-ends) ===`,
  );

  // per-node diagnostic table (all degree-1 nodes)
  console.log('node | route | class | quad | excuse | fwdGrade/max | nodeDepth | nearEdge | (x,z)');
  for (const d of [...dump.deadEnds].sort((a, b) => a.quadrant.localeCompare(b.quadrant))) {
    console.log(
      `#${d.nodeId} | ${d.route} | ${d.cls} | ${d.quadrant} | ${d.excuse || 'DEAD-END'} | ` +
        `${(d.fwdGrade * 100).toFixed(0)}%/${(d.maxGrade * 100).toFixed(0)}% | ` +
        `${d.nodeDepth.toFixed(2)}m | ${d.nearEdgeDist.toFixed(0)}m | ` +
        `(${d.x.toFixed(0)},${d.z.toFixed(0)})`,
    );
  }

  const perQuad = new Map<string, DeadEnd[]>();
  for (const q of QUADRANTS) perQuad.set(q, []);
  for (const d of illegit) perQuad.get(d.quadrant)?.push(d);

  console.log('quadrant dead-end counts:');
  let over = false;
  for (const q of QUADRANTS) {
    const arr = perQuad.get(q) ?? [];
    const bad = arr.length > MAX_DEADENDS_PER_QUADRANT;
    if (bad) over = true;
    console.log(
      `  ${q}: ${arr.length}${bad ? ` OVER (>${MAX_DEADENDS_PER_QUADRANT})` : ''}` +
        (arr.length ? ` — ${arr.map((d) => `${d.route}@(${d.x.toFixed(0)},${d.z.toFixed(0)})`).join(', ')}` : ''),
    );
  }
  console.log(`[seed ${seed}] ${over ? 'FAIL' : 'PASS'}`);
  return !over;
}

// ---------------- main --------------------------------------------------------

async function main(): Promise<void> {
  const argIdx = process.argv.indexOf('--seeds');
  const seedsArg = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
  const seeds = (seedsArg ?? '1,7,23')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (seeds.length === 0) throw new Error('no valid seeds in --seeds');

  console.log(
    `[probe-deadends] seeds [${seeds.join(', ')}] — dead-end = degree-1 node not excused by ` +
      `world-edge(±${WORLD_HALF - EDGE_M}m) / water(≥${WATER_DEPTH_M}m) / slope(fwd>maxGrade×${SLOPE_MUL}); ` +
      `budget ≤${MAX_DEADENDS_PER_QUADRANT}/quadrant`,
  );
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-deadends] adapter ${info.vendor}/${info.architecture}`);
  const page: Page = await browser.newPage({
    viewport: { width: 480, height: 300 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  const results: { seed: number; ok: boolean }[] = [];
  for (const seed of seeds) {
    try {
      const dump = await dumpSeed(page, seed);
      results.push({ seed, ok: report(seed, dump) });
    } catch (e) {
      console.error(`[seed ${seed}] BOOT/PROBE ERROR:`, e instanceof Error ? e.message : e);
      results.push({ seed, ok: false });
    }
  }
  await browser.close();

  console.log('\n=== summary ===');
  for (const r of results) console.log(`seed ${r.seed}: ${r.ok ? 'PASS' : 'FAIL'}`);
  const allOk = results.every((r) => r.ok);
  console.log(
    allOk ? '[probe-deadends] ALL SEEDS WITHIN BUDGET' : '[probe-deadends] DEAD-ENDS OVER BUDGET',
  );
  if (!allOk) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[probe-deadends] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
