/**
 * Vegetation micro-droplets probe (owner order):
 *   D1  dry noon boots with droplets ≈ 0
 *   D2  rain beads up FAST (≥0.6 after ~8 s of world time)
 *   D3  drying is SLOW ("потом обсыхают": still ≥0.4 ten seconds after
 *       the rain stops, clearly below the wet peak after ~40 s)
 *   D4  fog condenses FEWER droplets than rain (≈0.28 target)
 *   D5  early morning (T=6, dry) has dew (≈0.42..0.45)
 * Frames for the bot land in shots/wip/drop-*.png (frozen deterministic
 * boots per state; the dynamics leg runs unfrozen).
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/probe-droplets.ts
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';

let pass = true;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

type Browser = Awaited<ReturnType<typeof launchWebGPUReal>>['browser'];
type Page = Awaited<ReturnType<Browser['newPage']>>;

async function boot(browser: Browser, params: string): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&preset=high&hud=0&${params}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(`fatal: ${err}`);
  return page;
}

const settle = (page: Page, n: number): Promise<void> =>
  page.evaluate(async (k) => {
    if (window.__laas.settle) await window.__laas.settle(k);
  }, n);

const drops = (page: Page): Promise<number> =>
  page.evaluate(`window.__laasDbg.weatherDroplets()`) as Promise<number>;

async function main(): Promise<void> {
  const { browser } = await launchWebGPUReal();

  // ---- dynamics leg (unfrozen, T=12 dry boot) -------------------------------
  const dyn = await boot(browser, 'T=12&weather=dry&lockexp=1');
  await settle(dyn, 30);
  const d0 = await drops(dyn);
  check('D1 dry noon ≈ 0', d0 < 0.02, `droplets=${d0.toFixed(3)}`);

  await dyn.evaluate(`window.__laasDbg.weather('rain')`);
  await settle(dyn, 8 * 60); // ~8 s of world time
  const dWet = await drops(dyn);
  check('D2 rain beads up fast', dWet > 0.6, `after ~8 s droplets=${dWet.toFixed(2)}`);

  await dyn.evaluate(`window.__laasDbg.weather('dry')`);
  await settle(dyn, 10 * 60);
  const dDry10 = await drops(dyn);
  await settle(dyn, 30 * 60);
  const dDry40 = await drops(dyn);
  check(
    'D3 drying is slow then progresses',
    dDry10 > 0.4 && dDry40 < dDry10 - 0.15,
    `10 s=${dDry10.toFixed(2)} 40 s=${dDry40.toFixed(2)}`,
  );
  await dyn.close();

  // ---- frozen state frames + level checks -----------------------------------
  const states: [string, string, (v: number) => boolean, string][] = [
    ['drop-rain', 'T=11&weather=rain&freeze=1&lockexp=1&framealign=8', (v) => v > 0.95, '≈1'],
    ['drop-after-rain', 'T=11&weather=after-rain&freeze=1&lockexp=1&framealign=8', (v) => v > 0.5 && v < 0.6, '≈0.55'],
    ['drop-fog', 'T=11&weather=fog&freeze=1&lockexp=1&framealign=8', (v) => v > 0.23 && v < 0.33, '≈0.28'],
    // dew frame: T=7 (sun above the treeline) and NO lockexp — a T=6 boot
    // under the canopy metered pitch black with the exposure pinned
    ['drop-dew-morning', 'T=7&weather=dry&freeze=1&framealign=8', (v) => v > 0.35 && v < 0.5, '≈0.45'],
    ['drop-dry-noon', 'T=12&weather=dry&freeze=1&lockexp=1&framealign=8', (v) => v < 0.02, '≈0'],
  ];
  for (const [name, params, ok, want] of states) {
    const page = await boot(browser, params);
    await settle(page, 48);
    const v = await drops(page);
    check(`${name} level ${want}`, ok(v), `droplets=${v.toFixed(3)}`);
    await page.screenshot({ path: `shots/wip/${name}.png` });
    await page.close();
  }

  await browser.close();
  console.log(pass ? 'ALL PASS' : 'FAILURES');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
