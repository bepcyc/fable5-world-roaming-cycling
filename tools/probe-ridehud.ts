/**
 * Ride-HUD probe (brief P7 + dashboard contract) — reproducible version of
 * the session-0 ad-hoc verification. Boots the world twice on a real-GPU
 * adapter and asserts:
 *   A) ?ride=demo&fly=1 → HUD visible, DEMO badge present, digits tick
 *      between settles, speed nonzero while the flythrough moves the camera;
 *   B) key B toggles visibility both ways;
 *   C) without ?ride the HUD exists but stays hidden (zero footprint).
 * PASS/FAIL per check; exit code 1 on any failure.
 *
 * Usage: npx tsx tools/probe-ridehud.ts [--w 1600] [--h 900] [--timeout 600000]
 */

import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';

interface HudState {
  exists: boolean;
  display: string;
  text: string;
}

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

async function main(): Promise<void> {
  const width = arg('w', 1600);
  const height = arg('h', 900);
  const timeout = arg('timeout', 600_000);
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ridehud] adapter ${info.vendor}/${info.architecture}`);

  async function boot(url: string): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => console.error('[pageerror]', err.message));
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
      undefined,
      { timeout, polling: 500 },
    );
    const error = await page.evaluate(() => window.__laas.error);
    if (error) throw new Error(`App reported fatal error:\n${error}`);
    console.log(`[boot] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${url}`);
    return page;
  }

  const settle = async (page: Page, frames: number): Promise<void> => {
    await page.evaluate(
      async (n) => window.__laas.settle && (await window.__laas.settle(n)),
      frames,
    );
  };

  const hudState = (page: Page): Promise<HudState> =>
    page.evaluate(() => {
      const el = document.getElementById('ride-hud');
      if (!el) return { exists: false, display: 'none', text: '' };
      return {
        exists: true,
        display: getComputedStyle(el).display,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    });

  let pass = true;
  const check = (name: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) pass = false;
  };
  const speedOf = (s: HudState): number =>
    parseFloat(/SPEED\s*([\d.]+)\s*km\/h/.exec(s.text)?.[1] ?? '0');

  const base = `http://localhost:5173/?scene=world&seed=1&T=11&hud=0&freeze=1`;

  // A: demo ride during the flythrough
  const pa = await boot(`${base}&ride=demo&fly=1`);
  await settle(pa, 90);
  const s1 = await hudState(pa);
  await settle(pa, 300);
  const s2 = await hudState(pa);
  await pa.screenshot({ path: 'shots/wip/probe-ridehud.png' });
  check('hud visible', s1.exists && s1.display === 'flex', s1.display);
  check('demo badge', s1.text.includes('DEMO'), '');
  check('digits tick', s1.text !== s2.text, `"${s1.text}" vs "${s2.text}"`);
  check('speed nonzero in motion', speedOf(s1) > 1 || speedOf(s2) > 1, `${speedOf(s1)} / ${speedOf(s2)} km/h`);

  // B: key toggle
  await pa.keyboard.press('KeyB');
  check('B hides', (await hudState(pa)).display === 'none', '');
  await pa.keyboard.press('KeyB');
  check('B shows again', (await hudState(pa)).display === 'flex', '');
  await pa.close();

  // C: absent without ?ride
  const pc = await boot(`${base}&cam=0,300,0,0,-0.4`);
  const sC = await hudState(pc);
  check('hidden by default', sC.exists && sC.display === 'none', sC.display);
  await pc.close();

  await browser.close();
  console.log(pass ? '[probe-ridehud] ALL PASS' : '[probe-ridehud] FAILURES PRESENT');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[probe-ridehud] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
