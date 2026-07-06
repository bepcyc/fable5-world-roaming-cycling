/**
 * ck-pose-sweep — one-boot VISUAL sweep of a single PoseParams knob for the
 * road-hood grip. Applies each value live (rider debug applyPose), teleports
 * to the road cruise spot, screenshots, and crops the right-hand region so
 * the montage reads as a filmstrip of the knob's effect.
 *
 *   LAAS_PORT=5174 npx tsx tools/ck-pose-sweep.ts --param twist \
 *     --vals -0.2,0.15,0.4,0.6 --out shots/wip/m153/sweep-twist
 *
 * Writes <out>-<i>.png per value (full frame) + prints the value order.
 */
import { LAAS_ORIGIN } from './launch';
import { launchWebGPUReal } from './launch-gpu';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : def;
}

const BASE = {
  handAlong: 0.0525, palmPad: 0.004, curl: 0.15, curlTip: 0.85,
  twist: 0.15, pitch: 0.08, seatAlong: -0.005, seatLift: 0, roll: 1.05,
};

async function main(): Promise<void> {
  const param = arg('param', 'twist');
  const vals = arg('vals', '-0.2,0.15,0.4,0.6').split(',').map(Number);
  const out = arg('out', 'shots/wip/m153/sweep');
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
  await page.waitForFunction(() => !!(window as any).__laasDbg?.riderGrip?.applyPose, undefined, {
    timeout: 30_000, polling: 250,
  });
  // road cruise spot (same as ck-shot road)
  await page.evaluate(`(() => {
    const dbg = window.__laasDbg;
    dbg.ride.setMode('road');
    dbg.ride.teleport('asphalt', 0.1);
    dbg.ride.setPower(210);
  })()`);
  await page.evaluate(async () => { if ((window as any).__laas.settle) await (window as any).__laas.settle(260); });

  const written: string[] = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i] as number;
    await page.evaluate(
      `window.__laasDbg.riderGrip.applyPose(Object.assign({}, ${JSON.stringify(BASE)}, { ${param}: ${v} }))`,
    );
    await page.evaluate(async () => { if ((window as any).__laas.settle) await (window as any).__laas.settle(3); });
    const path = `${out}-${i}.png`;
    await page.screenshot({ path: path as `${string}.png`, type: 'png' });
    written.push(`${path} (${param}=${v})`);
  }
  await browser.close();
  console.log(`[ck-pose-sweep] ${param} order: ${vals.join(', ')}`);
  for (const w of written) console.log(`  ${w}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
