/**
 * Alpine-refs helper: boot once, dump camera candidates ON soft trails
 * (singletrack / dirt-road / gravel-coarse) for ref-01/02/03 sbs shots.
 * Prints shoot.ts --cam strings (ground+eye height, yaw along the trail).
 *
 * Usage: npx tsx tools/dump-alp-cams.ts
 */

import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { SurfaceId, SURFACE_NAMES } from '../src/ride/SurfaceMatrix';

async function main(): Promise<void> {
  const { browser } = await launchWebGPUReal();
  const page: Page = await browser.newPage({ viewport: { width: 480, height: 300 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&T=12&hud=0&freeze=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(`boot error: ${err}`);

  const data = (await page.evaluate(() => {
    (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
    const hf = (
      window as unknown as { __laasDbg?: { engine?: { heightfield?: unknown } } }
    ).__laasDbg?.engine?.heightfield as {
      heightAtCpu(x: number, z: number): number;
      waterDepthAtCpu(x: number, z: number): number;
      roads: {
        routes: {
          name: string;
          cls: { surfaceId: number; halfWidth: number };
          length: number;
          pts: { x: number; z: number; y: number; ford: boolean }[];
        }[];
      } | null;
    };
    if (!hf.roads) return null;
    return hf.roads.routes.map((r) => ({
      name: r.name,
      surfaceId: r.cls.surfaceId,
      halfWidth: r.cls.halfWidth,
      length: r.length,
      pts: [0.25, 0.45, 0.65].map((f) => {
        const i = Math.min(Math.floor(r.pts.length * f), r.pts.length - 2);
        const p = r.pts[i];
        const q = r.pts[Math.min(i + 3, r.pts.length - 1)];
        if (!p || !q) return null;
        return {
          x: p.x, z: p.z, y: p.y,
          ground: hf.heightAtCpu(p.x, p.z),
          depth: hf.waterDepthAtCpu(p.x, p.z),
          yaw: Math.atan2(-(q.x - p.x), -(q.z - p.z)),
        };
      }),
    }));
  })) as
    | {
        name: string;
        surfaceId: number;
        halfWidth: number;
        length: number;
        pts: ({ x: number; z: number; y: number; ground: number; depth: number; yaw: number } | null)[];
      }[]
    | null;
  await browser.close();
  if (!data) throw new Error('no roads');

  for (const id of [
    SurfaceId.Singletrack,
    SurfaceId.DirtRoad,
    SurfaceId.GravelCoarse,
    SurfaceId.Asphalt,
    SurfaceId.GravelFine,
  ]) {
    for (const r of data.filter((rt) => rt.surfaceId === id)) {
      console.log(`\n${SURFACE_NAMES[id]}  ${r.name}  len=${(r.length / 1000).toFixed(1)}km halfW=${r.halfWidth}`);
      for (const p of r.pts) {
        if (!p || p.depth > 0.02) continue;
        const eye = (p.ground + 1.65).toFixed(1);
        console.log(
          `  tread-view: --cam "${p.x.toFixed(0)},${eye},${p.z.toFixed(0)},${p.yaw.toFixed(2)},-0.62,50"` +
            `  (ground=${p.ground.toFixed(1)})`,
        );
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error('[dump-alp-cams] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
