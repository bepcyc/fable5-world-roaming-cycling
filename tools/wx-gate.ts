/**
 * M1.6 aesthetic-gate frame generator — NOT a pass/fail probe.
 *
 * For each weather state (dry / rain / after-rain / fog): boots once,
 * shoots 3 fixed landscape poses (grounded via groundProbe + alt) and one
 * MOVING capture from the bike (ridedev, 320 W, ~25 km/h). 16 frames into
 * shots/wip/wxgate-<state>-{p1,p2,p3,mov}.png — judged by eye + sent to
 * the owner per the mandatory process.
 *
 * Usage: npx tsx tools/wx-gate.ts   (dev server on :5173)
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';

const POSES = [
  { name: 'p1', x: 620, z: 650, alt: 1.6, yaw: 0.5, pitch: -0.12 }, // gorge stream
  { name: 'p2', x: -870, z: 862, alt: 1.8, yaw: -1.45, pitch: 0.02 }, // morning meadow
  { name: 'p3', x: -1400, z: 1250, alt: 2.5, yaw: 3.14, pitch: -0.12 }, // lakeshore
];

async function main(): Promise<void> {
  for (const state of ['dry', 'rain', 'after-rain', 'fog']) {
    const { browser } = await launchWebGPUReal();
    const page = await browser.newPage({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (err) => console.error('[pageerror]', err.message));
    await page.goto(
      `${LAAS_ORIGIN}/?scene=world&seed=1&T=11&preset=high&hud=0&ridedev=1&weather=${state}`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(
      () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
      undefined,
      { timeout: 600_000, polling: 500 },
    );
    const error = await page.evaluate(() => window.__laas.error);
    if (error) throw new Error(`fatal: ${error}`);
    const settle = (frames: number): Promise<void> =>
      page.evaluate(async (n) => {
        if (window.__laas.settle) await window.__laas.settle(n);
      }, frames);

    for (const p of POSES) {
      await page.evaluate(
        `(() => {
          const g = window.__laas.groundProbe(${p.x}, ${p.z});
          window.__laas.setPose({ p: [${p.x}, g.ground + ${p.alt}, ${p.z}], yaw: ${p.yaw}, pitch: ${p.pitch}, fov: 55 });
        })()`,
      );
      await settle(48);
      await page.screenshot({ path: `shots/wip/wxgate-${state}-${p.name}.png` });
      console.log(`[wx-gate] ${state} ${p.name}`);
    }
    // moving capture from the saddle
    await page.evaluate(`(() => {
      const dbg = window.__laasDbg;
      dbg.ride.teleport('asphalt', 0.25);
      dbg.ride.setPower(320);
    })()`);
    await settle(260);
    await page.screenshot({ path: `shots/wip/wxgate-${state}-mov.png` });
    console.log(`[wx-gate] ${state} mov`);
    await browser.close();
  }
  console.log('[wx-gate] 16 frames done');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
