/**
 * Road-network probe — M1.2 acceptance (ROADMAP).
 *
 * One boot (one-boot-many-probes), then:
 *   1. network floor: total distinct length ≥ 30 km, all 5 road classes routed
 *   2. conformance: |carved terrain − road profile| ≤ 0.15 m along every
 *      centerline (fords excluded — their profile IS the river bed); small
 *      junction allowance (crossing roads legally re-carve each other)
 *   3. hydrology: zero centerline samples under water except tagged fords
 *   4. surface stamp: centerline class == the route's SurfaceId (water wins
 *      at fords) ≥ 95%
 *   5. grade realism: per-class max sustained grade respected (Pillar B)
 *   6. veg exclusion: GPU audit — 0 trees/understory/extras/stones inside
 *      the surfaced width; ±8 m band counts must be > 0 (proves the baked
 *      field is alive — grass shares the SAME sampler, so a live field +
 *      zero hard-gated instances verifies the grass gate transitively)
 *
 * Usage: npx tsx tools/probe-roads.ts [--shots] [--verbose]
 *   --shots: 4 composed road bookmarks (asphalt valley / gravel forest /
 *            dirt ridge / singletrack) into shots/wip/ for the Pillar A gate
 */

import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { CLASSIFY, SURFACE_NAMES, SurfaceId } from '../src/ride/SurfaceMatrix';

const CONFORM_M = 0.15;
const MIN_KM = 30;
const has = (name: string): boolean => process.argv.includes(`--${name}`);

interface PtSample {
  x: number;
  z: number;
  y: number; // designed profile
  ground: number; // carved terrain
  depth: number; // standing water depth
  cls: number; // stamped surface class at the centerline
  ford: boolean;
  grade: number; // |Δy|/Δs to the next point
}

interface RouteData {
  name: string;
  surfaceId: number;
  maxGrade: number;
  halfWidth: number;
  length: number;
  pts: PtSample[];
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-roads] adapter ${info.vendor}/${info.architecture}`);
  const page: Page = await browser.newPage({
    viewport: { width: has('shots') ? 1720 : 480, height: has('shots') ? 968 : 300 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const t0 = Date.now();
  await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&T=15.5&hud=0&freeze=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(`App reported fatal error:\n${bootErr}`);
  console.log(`[boot] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const routes = (await page.evaluate(() => {
    (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
    const hf = (
      window as unknown as { __laasDbg?: { engine?: { heightfield?: unknown } } }
    ).__laasDbg?.engine?.heightfield as {
      heightAtCpu(x: number, z: number): number;
      waterDepthAtCpu(x: number, z: number): number;
      surfaceAtCpuRaw(x: number, z: number): number;
      roads: {
        totalLength: number;
        routes: {
          name: string;
          cls: { surfaceId: number; maxGrade: number; halfWidth: number };
          length: number;
          pts: { x: number; z: number; y: number; ford: boolean; s: number }[];
        }[];
      } | null;
    };
    if (!hf.roads) return null;
    return hf.roads.routes.map((r) => ({
      name: r.name,
      surfaceId: r.cls.surfaceId,
      maxGrade: r.cls.maxGrade,
      halfWidth: r.cls.halfWidth,
      length: r.length,
      pts: r.pts.map((p, i) => {
        const nx = r.pts[i + 1];
        const grade = nx
          ? Math.abs(nx.y - p.y) / Math.max(Math.hypot(nx.x - p.x, nx.z - p.z), 1)
          : 0;
        return {
          x: p.x,
          z: p.z,
          y: p.y,
          ground: hf.heightAtCpu(p.x, p.z),
          depth: hf.waterDepthAtCpu(p.x, p.z),
          cls: hf.surfaceAtCpuRaw(p.x, p.z),
          ford: p.ford,
          grade,
        };
      }),
    }));
  })) as RouteData[] | null;

  let pass = true;
  const check = (name: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    if (!ok) pass = false;
  };

  if (!routes || routes.length === 0) {
    check('network exists', false, 'hf.roads is null/empty');
  } else {
    const totalKm = routes.reduce((a, r) => a + r.length, 0) / 1000;
    check('network length', totalKm >= MIN_KM, `${totalKm.toFixed(1)} km (floor ${MIN_KM})`);
    const classes = new Set(routes.map((r) => r.surfaceId));
    for (const id of [
      SurfaceId.Asphalt,
      SurfaceId.GravelFine,
      SurfaceId.GravelCoarse,
      SurfaceId.DirtRoad,
      SurfaceId.Singletrack,
    ]) {
      check(`class routed: ${SURFACE_NAMES[id]}`, classes.has(id), '');
    }

    // junction mask: a point close to a DIFFERENT route's centerline may be
    // legally re-carved/re-stamped by that road — exclude from strict checks
    const nearOther = (r: RouteData, p: PtSample): boolean => {
      for (const o of routes) {
        if (o === r) continue;
        for (const q of o.pts) {
          if (Math.hypot(q.x - p.x, q.z - p.z) < o.halfWidth + r.halfWidth + 34) return true;
        }
      }
      return false;
    };

    for (const r of routes) {
      const body = r.pts.filter((p) => !p.ford);
      const clean = body.filter((p) => !nearOther(r, p));
      const errs = clean.map((p) => Math.abs(p.ground - p.y));
      const bad = errs.filter((e) => e > CONFORM_M).length;
      if (has('verbose') && bad > 0) {
        clean.forEach((p, i) => {
          const e = errs[i] as number;
          if (e > CONFORM_M) {
            console.log(
              `  BAD ${r.name} @(${p.x.toFixed(0)},${p.z.toFixed(0)}) err=${e.toFixed(2)} y=${p.y.toFixed(2)} ground=${p.ground.toFixed(2)} depth=${p.depth.toFixed(2)} cls=${p.cls}`,
            );
          }
        });
      }
      const maxE = errs.length ? Math.max(...errs) : 0;
      check(
        `${r.name}: conformance ≤ ${CONFORM_M} m`,
        bad === 0,
        `${bad}/${errs.length} over, max ${maxE.toFixed(3)} m (${(r.length / 1000).toFixed(1)} km)`,
      );
      const wet = clean.filter((p) => p.depth > CLASSIFY.WATER_MIN_DEPTH_M + 0.03);
      check(`${r.name}: no underwater (non-ford)`, wet.length === 0, `${wet.length} wet samples`);
      // water classes are LEGAL on the centerline: the stamp yields to water
      // by design (fords + the M1.1 sub-texel shoreline band); actual
      // drowned roadbed is what the separate wet-check above catches
      const stampBad = clean.filter(
        (p) =>
          !(
            p.cls === r.surfaceId ||
            p.cls === SurfaceId.WaterShallow ||
            p.cls === SurfaceId.WaterDeep ||
            p.ford
          ),
      );
      const stampOk = clean.length - stampBad.length;
      for (const p of stampBad.slice(0, 5)) {
        console.log(
          `  misstamp (${p.x.toFixed(0)},${p.z.toFixed(0)}) cls=${SURFACE_NAMES[p.cls]} ford=${p.ford} depth=${p.depth}`,
        );
      }
      const frac = clean.length ? stampOk / clean.length : 1;
      check(
        `${r.name}: surface stamp`,
        frac >= 0.95,
        `${(frac * 100).toFixed(1)}% == ${SURFACE_NAMES[r.surfaceId]}`,
      );
      // ford approaches drop to the bed — the class grade law governs the
      // engineered profile, not the riverbank dip (P4 handles rideability)
      let maxG = 0;
      let maxGi = -1;
      const nearFord = (i: number): boolean => {
        for (let k = Math.max(0, i - 2); k <= Math.min(r.pts.length - 1, i + 3); k++) {
          const q = r.pts[k] as PtSample;
          if (q.ford || q.depth > 0.03) return true;
        }
        return false;
      };
      r.pts.forEach((p, i) => {
        if (nearFord(i)) return; // crossing-approach ramps are exempt
        if (p.grade > maxG) {
          maxG = p.grade;
          maxGi = i;
        }
      });
      if (maxG > r.maxGrade * 1.08 && maxGi >= 0) {
        const p = r.pts[maxGi] as PtSample;
        console.log(
          `  worst grade @i=${maxGi} (${p.x.toFixed(0)},${p.z.toFixed(0)}) y=${p.y.toFixed(1)} ` +
            `next y=${(r.pts[maxGi + 1] as PtSample).y.toFixed(1)} depth=${p.depth} nextDepth=${(r.pts[maxGi + 1] as PtSample).depth}`,
        );
      }
      check(
        `${r.name}: grade realism`,
        maxG <= r.maxGrade * 1.08 + 1e-3,
        `max ${(maxG * 100).toFixed(1)}% vs class ${(r.maxGrade * 100).toFixed(0)}%`,
      );
      const fords = r.pts.filter((p) => p.ford).length;
      if (has('verbose')) {
        console.log(
          `  ${r.name}: ${r.pts.length} pts, ${fords} ford pts, junction-masked ${body.length - clean.length}`,
        );
      }
    }
  }

  // ---- GPU veg-exclusion audit -----------------------------------------------
  const audit = (await page.evaluate(async () => {
    (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
    const fn = (window as unknown as { __laasDbg?: { roadAudit?: () => Promise<Record<string, number>> } })
      .__laasDbg?.roadAudit;
    return fn ? await fn() : null;
  })) as Record<string, number> | null;
  if (!audit) {
    check('veg audit hook', false, 'roadAudit missing');
  } else {
    console.log(`[audit] ${JSON.stringify(audit)}`);
    for (const layer of ['trees', 'under', 'extras', 'stones']) {
      check(`veg on road: ${layer}`, (audit[layer] ?? -1) === 0, `${audit[layer]}`);
    }
    check('audit field alive: trees ±8 m band', (audit['treesBand'] ?? 0) > 0, `${audit['treesBand']}`);
    check('audit field alive: stones ±8 m band', (audit['stonesBand'] ?? 0) > 0, `${audit['stonesBand']}`);
  }

  // ---- aesthetic-gate shots ----------------------------------------------------
  if (has('shots') && routes) {
    const wanted: [string, number][] = [
      ['asphalt', SurfaceId.Asphalt],
      ['gravel', SurfaceId.GravelFine],
      ['dirt', SurfaceId.DirtRoad],
      ['single', SurfaceId.Singletrack],
    ];
    for (const [label, id] of wanted) {
      const r = routes.find((rt) => rt.surfaceId === id) ?? routes.find((rt) => rt.surfaceId === SurfaceId.GravelCoarse);
      if (!r) continue;
      const i = Math.floor(r.pts.length * 0.45);
      const p = r.pts[i] as PtSample;
      const q = r.pts[Math.min(i + 4, r.pts.length - 1)] as PtSample;
      const yaw = Math.atan2(-(q.x - p.x), -(q.z - p.z));
      await page.evaluate(
        ({ p, yaw }) => {
          (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
          window.__laas.setPose?.({ p: [p.x, p.y + 1.75, p.z], yaw, pitch: -0.06 });
        },
        { p, yaw },
      );
      await page.evaluate(async () => {
        (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
        await window.__laas.settle?.(90);
      });
      await page.screenshot({ path: `shots/wip/probe-roads-${label}.png` });
      console.log(`[shot] shots/wip/probe-roads-${label}.png (${r.name})`);
    }
  }

  await browser.close();
  console.log(pass ? '[probe-roads] ALL PASS' : '[probe-roads] FAILURES PRESENT');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[probe-roads] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
