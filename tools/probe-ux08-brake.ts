/**
 * UX-08 — touch brake at ANY power source.
 *
 * The bug: the on-screen BRAKE button was gated to the 'dev' keyboard source
 * (RideHud.ts showPedal `kind === 'dev'`), so a phone rider on a real BLE
 * trainer / demo source had no way to stop — no keyboard, no button. This
 * probe proves the fix end-to-end on a REAL GPU with a mobile touch context:
 * mount a DEMO (non-'dev') ride, confirm the BRAKE button is actually shown,
 * hold it and assert the solver speed falls.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux08-brake.ts
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import {
  bootWorld,
  makeChecks,
  mobileContext,
  mountOnClass,
  PHONE_LANDSCAPE,
  settle,
} from './ux-probe-util';

interface RideState {
  riding: boolean;
  vMs: number;
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux08] adapter ${info.vendor}/${info.architecture}`);
  // landscape: the app is sensorLandscape and closes portrait with the #rotate
  // overlay, so a portrait shot shows only that. Behaviour is orientation-
  // independent (events are dispatched at elements), but the SBS must show the
  // real riding screen.
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

    // touch UI must exist at all — buildTouchPedal only runs when
    // BrowserGate.isMobileDevice() is true; if the context override failed
    // the whole premise is void, so assert it loudly.
    const pedalExists = await page.evaluate(() => !!document.getElementById('ride-pedal'));
    c.check('mobile touch UI present (#ride-pedal built)', pedalExists);

    // mount a DEMO ride on asphalt (demo.kind === 'demo', NOT 'dev')
    const mounted = await mountOnClass(page, 'asphalt', 'road');
    c.check('demo ride mounted on asphalt', mounted);

    // let the demo rider spin up from a standing start
    await settle(page, 260);
    const moving = await readState();
    c.check('demo bike is riding + moving', !!moving?.riding && (moving?.vMs ?? 0) > 1, `vMs=${moving?.vMs?.toFixed(2)}`);

    // THE UX-08 ASSERTION: the brake button is visible for a non-'dev' source
    const brakeVisible = await page.evaluate(() => {
      const wrap = document.getElementById('ride-pedal');
      const brake = document.querySelector<HTMLElement>('.rp-btn.brake');
      if (!wrap || !brake) return false;
      const ws = getComputedStyle(wrap);
      const bs = getComputedStyle(brake);
      return ws.display !== 'none' && bs.display !== 'none';
    });
    c.check('BRAKE button shown with a demo (non-dev) source', brakeVisible);

    // ...and the dev-only PEDAL button is NOT shown (regression guard)
    const pedalBtnHidden = await page.evaluate(() => {
      const pedal = document.querySelector<HTMLElement>('.rp-btn:not(.brake)');
      return !!pedal && getComputedStyle(pedal).display === 'none';
    });
    c.check('PEDAL button stays dev-only (hidden for demo)', pedalBtnHidden);

    // СТАЛО (after fix): the ride screen WITH the brake button
    await page.screenshot({ path: 'shots/wip/ux/ux08-stalo.png' });
    // БЫЛО (before fix): the OLD gate hid the whole #ride-pedal wrap for any
    // non-'dev' source (`classList.toggle('on', showPedal)` → false →
    // display:none). Reproduce that exact render for the SBS, then restore.
    await page.evaluate(() => {
      const w = document.getElementById('ride-pedal');
      if (w) w.style.display = 'none';
    });
    await page.screenshot({ path: 'shots/wip/ux/ux08-bylo.png' });
    await page.evaluate(() => {
      const w = document.getElementById('ride-pedal');
      if (w) w.style.display = '';
    });

    // hold the brake and watch the speed drop
    const before = (await readState())?.vMs ?? 0;
    await page.dispatchEvent('.rp-btn.brake', 'pointerdown', { pointerId: 1, button: 0 });
    await settle(page, 150);
    const after = (await readState())?.vMs ?? 0;
    await page.dispatchEvent('.rp-btn.brake', 'pointerup', { pointerId: 1, button: 0 });
    c.check('holding BRAKE slows the bike', after < before - 0.2, `${before.toFixed(2)} -> ${after.toFixed(2)} m/s`);

    await page.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(c.failed ? '[probe-ux08] FAILURES PRESENT' : '[probe-ux08] ALL PASS');
  if (c.failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux08] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
