/**
 * UX-04 — hiking on touch: JUMP works, no keyboard cheatsheet.
 *
 * On a phone the only jump trigger was Space (no keyboard), and the ⚙ menu
 * showed a KEYS cheatsheet ("Ctrl+E .fit", "Shift+D …") to a device with no
 * keyboard. This proves the fix on a REAL GPU in a mobile context:
 *  - the JUMP button (#laas-touch-jump) is shown in walk mode;
 *  - tapping it actually launches the avatar (eye Y rises off the ground);
 *  - the ⚙ options panel shows GESTURES, not the keyboard KEYS block.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux04-hike-touch.ts
 */

import { mkdirSync } from 'node:fs';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { bootWorld, makeChecks, mobileContext, PHONE_LANDSCAPE, settle } from './ux-probe-util';

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux04] adapter ${info.vendor}/${info.architecture}`);
  const ctx = await mobileContext(browser, PHONE_LANDSCAPE);
  const c = makeChecks();
  try {
    // no ride param — boot straight into hike/walk
    const page = await bootWorld(ctx, `${LAAS_ORIGIN}/?scene=world&seed=1&preset=min&nosplash=1`);
    mkdirSync('shots/wip/ux', { recursive: true });

    const eyeY = (): Promise<number> => page.evaluate(() => window.__laas.getPose!().p[1]);

    // the JUMP button exists and is shown in walk mode
    const jumpShown = await page.evaluate(() => {
      const j = document.getElementById('laas-touch-jump');
      return !!j && j.classList.contains('on') && getComputedStyle(j).display !== 'none';
    });
    c.check('JUMP button shown in walk mode', jumpShown);

    // it is ≥48 px (probe-ui-touch's tap-target floor)
    const jumpBox = await page.evaluate(() => {
      const j = document.getElementById('laas-touch-jump');
      const r = j?.getBoundingClientRect();
      return r ? { w: r.width, h: r.height } : null;
    });
    c.check('JUMP button ≥48 px', !!jumpBox && jumpBox.w >= 48 && jumpBox.h >= 48, `${jumpBox?.w}x${jumpBox?.h}`);

    await settle(page, 60); // let the avatar settle onto the ground
    const groundY = await eyeY();
    await page.screenshot({ path: 'shots/wip/ux/ux04-stalo.png' }); // WITH the JUMP button

    // tap JUMP → the avatar should leave the ground
    await page.dispatchEvent('#laas-touch-jump', 'pointerdown', { pointerId: 1, button: 0 });
    let peak = groundY;
    for (let i = 0; i < 30; i++) {
      await settle(page, 2);
      const y = await eyeY();
      if (y > peak) peak = y;
    }
    await page.dispatchEvent('#laas-touch-jump', 'pointerup', { pointerId: 1, button: 0 });
    c.check('tapping JUMP launches the avatar', peak > groundY + 0.2, `Δpeak=${(peak - groundY).toFixed(2)} m`);

    // the ⚙ options panel shows GESTURES, not the keyboard KEYS block
    const panel = await page.evaluate(() => {
      const p = document.getElementById('opt-panel');
      return p ? p.textContent ?? '' : null;
    });
    c.check('options panel exists', panel !== null);
    c.check('touch panel shows gesture hints', !!panel && /stick/i.test(panel), 'has "stick"');
    c.check('touch panel hides keyboard-only cheatsheet (no "Ctrl+E")', !!panel && !panel.includes('Ctrl+E'));

    // BYLO: reproduce the old state (no JUMP button) for the SBS
    await page.evaluate(() => {
      const j = document.getElementById('laas-touch-jump');
      if (j) j.style.display = 'none';
    });
    await page.screenshot({ path: 'shots/wip/ux/ux04-bylo.png' });
    await page.evaluate(() => {
      const j = document.getElementById('laas-touch-jump');
      if (j) j.style.display = '';
    });

    await page.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(c.failed ? '[probe-ux04] FAILURES PRESENT' : '[probe-ux04] ALL PASS');
  if (c.failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux04] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
