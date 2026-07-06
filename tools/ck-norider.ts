/**
 * ck-norider — diagnostic: shoot the road cockpit WITH the rider, then hide
 * the rig and shoot the bare bar, so the geometry the hand is supposed to
 * grip (and is actually clipping through) is visible. Honest pixels, no
 * phantom capsule.
 *
 * LAAS_PORT=5174 npx tsx tools/ck-norider.ts --out shots/wip/m153/norider
 */
import { LAAS_ORIGIN } from './launch';
import { launchWebGPUReal } from './launch-gpu';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : def;
}

async function main(): Promise<void> {
  const out = arg('out', 'shots/wip/m153/norider');
  const { browser } = await launchWebGPUReal();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(
    `${LAAS_ORIGIN}/?scene=world&seed=1&T=11&preset=high&hud=0&dash=0&ridedev=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => (window as any).__laas && ((window as any).__laas.ready || (window as any).__laas.error !== null),
    undefined, { timeout: 600_000, polling: 500 },
  );
  await page.waitForFunction(() => !!(window as any).__laasDbg?.riderGrip?.rig, undefined, {
    timeout: 30_000, polling: 250,
  });
  await page.evaluate(`(() => {
    const dbg = window.__laasDbg;
    dbg.ride.setMode('road');
    dbg.ride.teleport('asphalt', 0.1);
    dbg.ride.setPower(210);
  })()`);
  await page.evaluate(async () => { if ((window as any).__laas.settle) await (window as any).__laas.settle(260); });
  await page.screenshot({ path: `${out}-with.png` as `${string}.png`, type: 'png' });
  console.log(`[ck-norider] wrote ${out}-with.png`);
  // hide the rider rig
  await page.evaluate(`(() => { window.__laasDbg.riderGrip.rig.visible = false; })()`);
  await page.evaluate(async () => { if ((window as any).__laas.settle) await (window as any).__laas.settle(3); });
  await page.screenshot({ path: `${out}-bare.png` as `${string}.png`, type: 'png' });
  console.log(`[ck-norider] wrote ${out}-bare.png`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
