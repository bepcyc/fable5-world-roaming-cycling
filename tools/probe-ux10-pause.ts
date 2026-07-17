/**
 * UX-10 — pause with a finger.
 *
 * The bug: the ONLY trigger into the PAUSE card was a keydown on Escape
 * (GameMenu), and a phone has no Escape — no touch element led to pause at
 * all. This probe drives the real GameMenu on a REAL GPU in a mobile touch
 * context: START → PLAYING makes the new #pause-fab appear; tapping it opens
 * the PAUSE card; RESUME closes it and the fab returns.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux10-pause.ts
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { bootWorld, makeChecks, mobileContext, PHONE_LANDSCAPE } from './ux-probe-util';

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux10] adapter ${info.vendor}/${info.architecture}`);
  const ctx = await mobileContext(browser, PHONE_LANDSCAPE);
  const c = makeChecks();
  try {
    // menu ACTIVE: no nosplash/freeze — this case is about the menu flow
    const page = await bootWorld(ctx, `${LAAS_ORIGIN}/?scene=world&seed=1&preset=min`);

    const shown = (id: string): Promise<boolean> =>
      page.evaluate((sel) => {
        const e = document.getElementById(sel);
        if (!e) return false;
        return getComputedStyle(e).display !== 'none' && !e.hidden;
      }, id);

    // world is ready (bootWorld waited for it) → START enters PLAYING
    await page.waitForSelector('#btn-start', { state: 'visible', timeout: 45000 });
    await page.click('#btn-start', { force: true });
    await page.waitForSelector('#pause-fab.on', { state: 'visible', timeout: 8000 }).catch(() => null);

    c.check('touch ⏸ appears once PLAYING', await shown('pause-fab'));
    // СТАЛО (with the new affordance): playing screen, ⏸ top-left
    await page.screenshot({ path: 'shots/wip/ux/ux10-stalo-button.png' });

    // БЫЛО: the old build had no touch pause path at all — reproduce that
    // render (fab absent) for the SBS, then restore
    await page.evaluate(() => {
      const f = document.getElementById('pause-fab');
      if (f) f.style.display = 'none';
    });
    await page.screenshot({ path: 'shots/wip/ux/ux10-bylo.png' });
    await page.evaluate(() => {
      const f = document.getElementById('pause-fab');
      if (f) f.style.display = '';
    });

    // TAP the fab → PAUSE card opens
    await page.click('#pause-fab', { force: true });
    const paused = await page.waitForSelector('#pause.on', { state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    c.check('tapping ⏸ opens the PAUSE card', paused);
    c.check('⏸ hides while paused (RESUME is on the card)', !(await shown('pause-fab')));
    await page.screenshot({ path: 'shots/wip/ux/ux10-stalo-open.png' });

    // RESUME closes it and the fab comes back
    await page.click('#btn-resume', { force: true });
    const resumed = await page.waitForSelector('#pause', { state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false);
    c.check('RESUME closes the PAUSE card', resumed);
    await page.waitForSelector('#pause-fab.on', { state: 'visible', timeout: 5000 }).catch(() => null);
    c.check('⏸ returns after resume', await shown('pause-fab'));

    await page.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(c.failed ? '[probe-ux10] FAILURES PRESENT' : '[probe-ux10] ALL PASS');
  if (c.failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux10] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
