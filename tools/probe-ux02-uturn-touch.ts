/**
 * UX-02 — 180° U-turn with a finger (mobile).
 *
 * The desktop U-turn (UX-01) is a hold on the S key, which a phone has no way
 * to press. This proves the touch path on a REAL GPU in a mobile context:
 * mount a DEMO ride, assert the U-TURN button is actually shown, then verify
 * the hold-to-confirm guard — a short tap does NOTHING, a ~0.6 s hold reverses
 * the travel heading ~180° with a continuous position (no teleport).
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux02-uturn-touch.ts
 */

import { mkdirSync } from 'node:fs';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { bootWorld, makeChecks, mobileContext, mountOnClass, PHONE_LANDSCAPE, settle } from './ux-probe-util';

interface RideState {
  riding: boolean;
  vMs: number;
  heading: number;
}

function degDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs((d * 180) / Math.PI);
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux02] adapter ${info.vendor}/${info.architecture}`);
  const ctx = await mobileContext(browser, PHONE_LANDSCAPE);
  const c = makeChecks();
  try {
    const page = await bootWorld(
      ctx,
      `${LAAS_ORIGIN}/?scene=world&seed=1&preset=min&ride=demo&nosplash=1`,
    );
    mkdirSync('shots/wip/ux', { recursive: true });

    const readState = (): Promise<RideState | null> =>
      page.evaluate(() => {
        const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg;
        const ride = dbg?.['ride'] as { state(): RideState } | undefined;
        return ride ? ride.state() : null;
      });
    const readXZ = (): Promise<{ x: number; z: number }> =>
      page.evaluate(() => {
        const p = window.__laas.getPose!().p;
        return { x: p[0], z: p[2] };
      });

    const mounted = await mountOnClass(page, 'asphalt', 'road');
    c.check('demo ride mounted on asphalt', mounted);
    await settle(page, 260);
    const moving = await readState();
    c.check('demo bike riding + moving', !!moving?.riding && (moving?.vMs ?? 0) > 1, `v=${moving?.vMs?.toFixed(2)}`);

    // the U-TURN button must be visible for a demo (non-dev) source while riding
    const uturnVisible = await page.evaluate(() => {
      const wrap = document.getElementById('ride-pedal');
      const u = document.querySelector<HTMLElement>('.rp-btn.uturn');
      if (!wrap || !u) return false;
      return getComputedStyle(wrap).display !== 'none' && getComputedStyle(u).display !== 'none';
    });
    c.check('U-TURN button shown for a demo source while riding', uturnVisible);
    await page.screenshot({ path: 'shots/wip/ux/ux02-bylo.png' });

    // GUARD: a SHORT tap must NOT flip (hold-to-confirm is 500 ms)
    const h0 = (await readState())?.heading ?? 0;
    await page.dispatchEvent('.rp-btn.uturn', 'pointerdown', { pointerId: 1, button: 0 });
    await page.waitForTimeout(200);
    await page.dispatchEvent('.rp-btn.uturn', 'pointerup', { pointerId: 1, button: 0 });
    await settle(page, 30);
    const hShort = (await readState())?.heading ?? 0;
    c.check('short tap does NOT U-turn (confirm guard)', degDiff(hShort, h0) < 45, `Δ=${degDiff(hShort, h0).toFixed(0)}°`);

    // HOLD until the confirm fires. Poll in FINE increments so the flip is
    // caught inside one short window — the position delta THERE is the
    // teleport test (a jump to another edge would be 15 m+). Measuring across
    // the whole hold would just count the normal forward travel that happens
    // before the 0.5 s confirm even fires, which is not a teleport.
    const before = await readState();
    const hStart = before?.heading ?? 0;
    await page.dispatchEvent('.rp-btn.uturn', 'pointerdown', { pointerId: 2, button: 0 });
    let prev = await readXZ();
    let uturnSeen = false;
    let flipStep = 0;
    for (let i = 0; i < 80 && !uturnSeen; i++) {
      await settle(page, 3);
      const now = await readXZ();
      const hnow = (await readState())?.heading ?? hStart;
      if (degDiff(hnow, hStart) > 150) {
        uturnSeen = true;
        flipStep = Math.hypot(now.x - prev.x, now.z - prev.z);
      }
      prev = now;
    }
    await page.dispatchEvent('.rp-btn.uturn', 'pointerup', { pointerId: 2, button: 0 });
    await settle(page, 40);
    const after = await readState();

    const dh = degDiff(after?.heading ?? 0, hStart);
    c.check('hold-to-confirm engaged the U-turn', uturnSeen);
    c.check('hold-to-confirm reversed heading ~180°', dh >= 150 && dh <= 210, `${dh.toFixed(0)}°`);
    c.check('position continuous across the flip (no teleport)', flipStep < 2, `flipStep=${flipStep.toFixed(2)} m`);
    await page.screenshot({ path: 'shots/wip/ux/ux02-stalo.png' });

    await page.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(c.failed ? '[probe-ux02] FAILURES PRESENT' : '[probe-ux02] ALL PASS');
  if (c.failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux02] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
