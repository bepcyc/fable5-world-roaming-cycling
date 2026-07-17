/**
 * UX-15 — BLE on the move. Three fixes, one probe (real GPU, mobile context):
 *
 *  (a) key collision: `B` toggled BOTH the ride HUD (RideHud) and the device
 *      manager (DeviceManagerUi) — opening the manager hid the whole dashboard.
 *      The manager now lives on `N`; `B` stays the HUD toggle. Asserted: N
 *      opens the manager with the HUD still up; B toggles only the HUD.
 *  (b) open the BLE manager mid-ride WITHOUT a reload: a session that started
 *      on a non-BLE source calls __laasDbg.ensureBle() (the OptionsMenu BLE
 *      button's new path) and the manager appears — no navigation.
 *  (c) sensor-loss watchdog: an artificial trigger (bleUi.forceSensorLost) shows
 *      the "Sensor lost — tap to reconnect" banner; tapping it invokes the
 *      reconnect gesture (reconnectAttempts increments). A real dropout is not
 *      simulated — Web Bluetooth reconnect needs a real device — but the
 *      banner + click path is exactly the recovery surface.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux15-ble.ts
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { bootWorld, makeChecks, mobileContext, PHONE_LANDSCAPE, settle } from './ux-probe-util';
import type { Page } from 'playwright';

const shown = (page: Page, sel: string): Promise<boolean> =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none';
  }, sel);

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux15] adapter ${info.vendor}/${info.architecture}`);
  const ctx = await mobileContext(browser, PHONE_LANDSCAPE);
  const c = makeChecks();
  try {
    // ---- (a) key collision + (c) watchdog: a blefake session (bleUi + HUD) ---
    const page = await bootWorld(
      ctx,
      `${LAAS_ORIGIN}/?scene=world&seed=1&preset=min&ride=blefake&nosplash=1`,
    );
    await settle(page, 30);

    c.check('HUD visible at start', await shown(page, '#ride-hud'));
    c.check('device manager closed at start', !(await shown(page, '#ble-mgr')));

    // press N → manager opens, HUD stays up
    await page.keyboard.press('KeyN');
    await settle(page, 5);
    const mgrOpenN = await shown(page, '#ble-mgr');
    const hudUpWithMgr = await shown(page, '#ride-hud');
    c.check('N opens the device manager', mgrOpenN);
    c.check('HUD stays visible when the manager opens (UX-15a)', hudUpWithMgr);
    await page.screenshot({ path: 'shots/wip/ux/ux15a-stalo.png' });

    // press B → toggles ONLY the HUD; manager unaffected
    await page.keyboard.press('KeyB');
    await settle(page, 5);
    c.check('B toggles the HUD (now hidden)', !(await shown(page, '#ride-hud')));
    c.check('B does NOT close the manager', await shown(page, '#ble-mgr'));
    // this HUD-hidden + manager-open frame is exactly what the OLD single-key B
    // produced in one press — capture it as the BYLO of the collision
    await page.screenshot({ path: 'shots/wip/ux/ux15a-bylo.png' });
    await page.keyboard.press('KeyB'); // HUD back on
    await page.keyboard.press('KeyN'); // manager closed
    await settle(page, 5);

    // ---- (c) sensor-loss watchdog ----
    c.check('lost banner hidden before trigger', !(await shown(page, '#ble-lost-banner')));
    await page.screenshot({ path: 'shots/wip/ux/ux15c-bylo.png' });
    const before = await page.evaluate(() => {
      const ui = (window as unknown as { __laasDbg?: { bleUi?: { forceSensorLost(v: boolean): void; reconnectAttempts: number } } }).__laasDbg?.bleUi;
      ui?.forceSensorLost(true);
      return ui?.reconnectAttempts ?? -1;
    });
    await settle(page, 5);
    c.check('watchdog trigger shows the lost banner', await shown(page, '#ble-lost-banner'));
    c.check('reconnectAttempts starts at 0', before === 0, `was ${before}`);
    await page.screenshot({ path: 'shots/wip/ux/ux15c-stalo.png' });

    // tap the banner → reconnect gesture fires
    await page.dispatchEvent('#ble-lost-banner', 'click');
    await settle(page, 10);
    const after = await page.evaluate(
      () =>
        (window as unknown as { __laasDbg?: { bleUi?: { reconnectAttempts: number } } }).__laasDbg
          ?.bleUi?.reconnectAttempts ?? -1,
    );
    c.check('tapping the banner invokes reconnect', after >= 1, `attempts=${after}`);
    await page.close();

    // ---- (b) lazy BLE attach without reload: a NON-BLE (demo) session ----
    const page2 = await bootWorld(
      ctx,
      `${LAAS_ORIGIN}/?scene=world&seed=1&preset=min&ride=demo&nosplash=1`,
    );
    await settle(page2, 20);
    c.check('no BLE manager in a demo session', !(await shown(page2, '#ble-mgr')));
    const urlBefore = page2.url();
    await page2.evaluate(() => {
      const fn = (window as unknown as { __laasDbg?: { ensureBle?: () => void } }).__laasDbg
        ?.ensureBle;
      fn?.();
    });
    await settle(page2, 10);
    c.check('ensureBle opens the manager mid-ride', await shown(page2, '#ble-mgr'));
    c.check('no page reload/navigation happened', page2.url() === urlBefore, page2.url());
    await page2.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(c.failed ? '[probe-ux15] FAILURES PRESENT' : '[probe-ux15] ALL PASS');
  if (c.failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux15] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
