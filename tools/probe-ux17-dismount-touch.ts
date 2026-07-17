/**
 * UX-17 — get off the bike with a finger (mobile).
 *
 * Dismount used to be keyboard-only (X, or cycling M through every bike):
 * a phone had no way to reach it. This proves the touch path on a REAL GPU
 * in a mobile context: mount a DEMO ride, assert the GET OFF button is
 * actually shown next to BRAKE/U-TURN, tap it, and verify the rider is on
 * foot afterwards (mode=hike) with the ride touch cluster hidden.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux17-dismount-touch.ts
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { bootWorld, makeChecks, mobileContext, mountOnClass, PHONE_LANDSCAPE, settle } from './ux-probe-util';

interface RideState {
  mode: string;
  riding: boolean;
  vMs: number;
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux17] adapter ${info.vendor}/${info.architecture}`);
  const ctx = await mobileContext(browser, PHONE_LANDSCAPE);
  const c = makeChecks();
  try {
    const page = await bootWorld(
      ctx,
      `${LAAS_ORIGIN}/?scene=world&seed=1&preset=min&ride=demo&nosplash=1`,
    );

    const readState = (): Promise<RideState | null> =>
      page.evaluate(() => {
        const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg;
        const ride = dbg?.['ride'] as { state(): RideState } | undefined;
        return ride ? ride.state() : null;
      });
    const dismountVisible = (): Promise<boolean> =>
      page.evaluate(() => {
        const wrap = document.getElementById('ride-pedal');
        const d = document.querySelector<HTMLElement>('.rp-btn.dismount');
        if (!wrap || !d) return false;
        return getComputedStyle(wrap).display !== 'none' && getComputedStyle(d).display !== 'none';
      });

    // on foot: the ride cluster (and the dismount button with it) must be hidden
    c.check('GET OFF hidden while on foot', !(await dismountVisible()));

    const mounted = await mountOnClass(page, 'asphalt', 'road');
    c.check('demo ride mounted on asphalt', mounted);
    await settle(page, 200);
    const riding = await readState();
    c.check('demo bike riding', !!riding?.riding, `mode=${riding?.mode}`);
    c.check('GET OFF shown while riding', await dismountVisible());

    // the tap: plain pointerdown+up (no hold-to-confirm — dismounting is
    // safe and instantly reversible through the options menu)
    await page.dispatchEvent('.rp-btn.dismount', 'pointerdown', { pointerId: 3, button: 0 });
    await page.waitForTimeout(80);
    await page.dispatchEvent('.rp-btn.dismount', 'pointerup', { pointerId: 3, button: 0 });
    await settle(page, 40);

    const after = await readState();
    c.check('tap dismounts to hike', after?.mode === 'hike' && !after?.riding, `mode=${after?.mode}`);
    c.check('ride cluster hidden after dismount', !(await dismountVisible()));

    await page.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(c.failed ? '[probe-ux17] FAILURES PRESENT' : '[probe-ux17] ALL PASS');
  if (c.failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux17] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
