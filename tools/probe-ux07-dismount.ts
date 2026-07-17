/**
 * UX-07 — one-press dismount before an obstacle (desktop).
 *
 * "Get off" used to be up to 3× M, and each intermediate press SWAPPED bikes
 * (hike sat in the middle of the mode cycle) — the same key meant "swap" or
 * "dismount" depending on the count. This proves the dedicated X action on a
 * REAL GPU: mount a bike, press X once, land in hike (on foot) in a SINGLE
 * press, from any bike.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux07-dismount.ts
 */

import { mkdirSync } from 'node:fs';
import { LAAS_ORIGIN, launchWebGPUReal } from './launch-gpu';

let pass = true;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

interface RideState {
  mode: string;
  riding: boolean;
}

async function settle(page: import('playwright').Page, frames: number): Promise<void> {
  await page.evaluate(
    `(async () => { if (window.__laas.settle) await window.__laas.settle(${frames}); })()`,
  );
}
async function readMode(page: import('playwright').Page): Promise<RideState> {
  return (await page.evaluate(`window.__laasDbg.ride.state()`)) as RideState;
}

async function mount(page: import('playwright').Page, cls: string, mode: string): Promise<boolean> {
  return (await page.evaluate(`(() => {
    const g = window.__laasDbg.rideGraph;
    const e = g.edges.find((e) => e.cls.name === '${cls}') ?? g.edges[0];
    const r = window.__laasDbg.ride;
    const ok = r.teleportEdge(e.id, e.length * 0.5, 1);
    r.setPower(150);
    return ok && r.setMode('${mode}') && r.state().riding;
  })()`)) as boolean;
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux07] adapter ${info.vendor}/${info.architecture}`);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  try {
    await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&T=11&preset=min&freeze=1&ridedev=1`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(
      () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
      undefined,
      { timeout: 600_000, polling: 500 },
    );
    const err = await page.evaluate(() => window.__laas.error);
    if (err) throw new Error(`App reported fatal error:\n${err}`);
    mkdirSync('shots/wip/ux', { recursive: true });

    // mount MTB (the mode farthest from hike in the M cycle — a worst case
    // for the old "cycle through bikes to get off" path)
    const mounted = await mount(page, 'singletrack', 'mtb');
    check('bike mounted (mtb)', mounted);
    await settle(page, 120);
    const before = await readMode(page);
    check('is riding before dismount', before.riding && before.mode === 'mtb', `mode=${before.mode}`);
    await page.screenshot({ path: 'shots/wip/ux/ux07-bylo.png' });

    // ONE X press → hike
    await page.keyboard.press('KeyX');
    await settle(page, 30);
    const after = await readMode(page);
    check('single X press lands in hike (on foot)', !after.riding && after.mode === 'hike', `mode=${after.mode}`);
    await page.screenshot({ path: 'shots/wip/ux/ux07-stalo.png' });

    // regression: X does nothing on foot (already dismounted)
    await page.keyboard.press('KeyX');
    await settle(page, 10);
    const still = await readMode(page);
    check('X on foot is a no-op', !still.riding && still.mode === 'hike');

    await page.close();
  } finally {
    await browser.close();
  }
  console.log(pass ? '[probe-ux07] ALL PASS' : '[probe-ux07] FAILURES PRESENT');
  if (!pass) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux07] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
