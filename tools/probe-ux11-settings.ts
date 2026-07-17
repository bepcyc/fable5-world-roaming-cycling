/**
 * UX-11 — in-ride graphics settings: the two audit bugs, proven fixed.
 *
 * Bug 1: opened from the menu, the graphics sheet (#qset z 1401) rendered
 *        BEHIND the splash (z 2000) — invisible, dead. Now z 2401.
 * Bug 2: SettingsMenu's own Escape=close and GameMenu's Escape=pause BOTH
 *        fired on one press — the sheet closed AND pause opened. The top open
 *        layer now owns Escape.
 *
 * Real GPU, real GameMenu (no freeze/nosplash — the menu must be live):
 *  A) from the main menu → SETTINGS → GRAPHICS, the sheet hit-tests ON TOP
 *     of the splash (elementFromPoint at its centre lands inside #qset).
 *  B) in PLAYING with the sheet open, one Escape closes the sheet and does
 *     NOT open pause; a second Escape then opens pause normally.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux11-settings.ts
 */

import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { LAAS_ORIGIN, launchWebGPUReal } from './launch-gpu';

let pass = true;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

async function hasOn(page: Page, id: string): Promise<boolean> {
  return page.evaluate((i) => !!document.getElementById(i)?.classList.contains('on'), id);
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux11] adapter ${info.vendor}/${info.architecture}`);
  // GameMenu.shouldBypass() hides the whole splash when navigator.webdriver is
  // true (every Playwright page). This probe NEEDS the live menu, so opt back
  // in the same way tools/ux-probe-util.ts does — else #btn-settings is hidden.
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript({
    content: "Object.defineProperty(navigator, 'webdriver', { get: () => false });",
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  try {
    // NO freeze / NO nosplash — the GameMenu must be live for this test
    await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&T=11&preset=min`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
      undefined,
      { timeout: 600_000, polling: 500 },
    );
    const err = await page.evaluate(() => window.__laas.error);
    if (err) throw new Error(`App reported fatal error:\n${err}`);
    mkdirSync('shots/wip/ux', { recursive: true });

    // ---- A) z-index: open the sheet from the main menu, over the splash ----
    await page.waitForSelector('#btn-settings', { state: 'visible', timeout: 45000 });
    await page.click('#btn-settings', { force: true });
    await page.waitForSelector('#msettings.on', { timeout: 8000 });
    // the GRAPHICS item is the last card in the preset row (buildMachineSettings)
    await page.evaluate(`document.querySelector('#msettings-preset').lastElementChild.click()`);
    await page.waitForSelector('#qset.on', { timeout: 8000 });

    const splashZ = await page.evaluate(
      () => Number(getComputedStyle(document.getElementById('splash')!).zIndex) || 0,
    );
    const qsetZ = await page.evaluate(
      () => Number(getComputedStyle(document.getElementById('qset')!).zIndex) || 0,
    );
    check('qset z-index is above the splash', qsetZ > splashZ, `qset=${qsetZ} splash=${splashZ}`);

    // the real proof: a click at the sheet's centre reaches the sheet, not
    // whatever is stacked behind it
    const onTop = await page.evaluate(() => {
      const q = document.getElementById('qset')!;
      const r = q.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === q || q.contains(hit));
    });
    check('graphics sheet hit-tests ON TOP of the splash', onTop);
    await page.screenshot({ path: 'shots/wip/ux/ux11-stalo.png' });

    // BYLO: reproduce the old z-order (sheet behind the splash) for the SBS
    await page.evaluate(() => {
      document.getElementById('qset')!.style.zIndex = '1401';
      document.getElementById('qset-veil')!.style.zIndex = '1400';
    });
    await page.screenshot({ path: 'shots/wip/ux/ux11-bylo.png' });
    await page.evaluate(() => {
      document.getElementById('qset')!.style.zIndex = '';
      document.getElementById('qset-veil')!.style.zIndex = '';
    });

    // ---- B) Escape stack. Get into PLAYING, open the sheet in-game --------
    await page.keyboard.press('Escape'); // close the sheet (top layer owns Esc)
    await page.waitForFunction(`!document.getElementById('qset').classList.contains('on')`, { timeout: 5000 });
    // direct JS clicks — the menu buttons fire their handlers regardless of
    // Playwright's visibility heuristic (the splash art animates continuously)
    await page.evaluate(`document.getElementById('msettings-close').click()`);
    await page.evaluate(`document.getElementById('btn-start').click()`);
    await page.waitForFunction(`document.getElementById('splash').hidden === true`, { timeout: 8000 });
    check('game is PLAYING (splash hidden)', !(await hasOn(page, 'pause')));

    // open the sheet in-game via the OptionsMenu GRAPHICS button
    await page.evaluate(`document.querySelector('#opt-panel .opt-grid2').firstElementChild.click()`);
    await page.waitForSelector('#qset.on', { timeout: 8000 });

    // ONE Escape: closes the sheet, must NOT open pause (bug 2)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const qsetAfter1 = await hasOn(page, 'qset');
    const pauseAfter1 = await hasOn(page, 'pause');
    check('Escape #1 closes the graphics sheet', !qsetAfter1);
    check('Escape #1 did NOT also open pause (stack fixed)', !pauseAfter1);

    // SECOND Escape: now the sheet is gone, pause opens normally
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('Escape #2 opens pause (stack intact)', await hasOn(page, 'pause'));

    await page.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(pass ? '[probe-ux11] ALL PASS' : '[probe-ux11] FAILURES PRESENT');
  if (!pass) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux11] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
