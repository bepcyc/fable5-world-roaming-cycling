/**
 * UX-01 — 180° U-turn on the open road (desktop).
 *
 * Before: there was no U-turn off a fork — reversing meant dismounting (up to
 * 3× M), spinning the camera, remounting. This proves the fix end-to-end on a
 * REAL GPU: mount a bike on a long straight edge, ride, then HOLD the brake
 * (S/↓/Space) at low speed for ~1 s — the Zwift hold-down-arrow. Asserts the
 * travel heading reverses ~180°, the position stays CONTINUOUS across the
 * flip (a teleport to another edge would jump tens of metres), and the ride
 * banner shows the U-turn note.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux01-uturn.ts
 */

import { mkdirSync } from 'node:fs';
import { LAAS_ORIGIN, launchWebGPUReal } from './launch-gpu';

let pass = true;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

interface Pose {
  heading: number;
  x: number;
  z: number;
  v: number;
  note: string | null;
}

function degDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs((d * 180) / Math.PI);
}

const READ_JS = `(() => {
  const r = window.__laasDbg.ride;
  const st = r.state();
  const p = window.__laas.getPose().p;
  return { heading: st.heading, x: p[0], z: p[2], v: st.vMs, note: st.note };
})()`;

async function settle(page: import('playwright').Page, frames: number): Promise<void> {
  await page.evaluate(
    `(async () => { if (window.__laas.settle) await window.__laas.settle(${frames}); })()`,
  );
}

async function read(page: import('playwright').Page): Promise<Pose> {
  return (await page.evaluate(READ_JS)) as Pose;
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux01] adapter ${info.vendor}/${info.architecture}`);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  try {
    await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&T=11&preset=min&freeze=1&ridedev=1`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(
      () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
      undefined,
      { timeout: 600_000, polling: 500 },
    );
    const err = await page.evaluate(() => window.__laas.error);
    if (err) throw new Error(`App reported fatal error:\n${err}`);
    mkdirSync('shots/wip/ux', { recursive: true });

    // mount on the LONGEST edge so a low-speed ~2 s manoeuvre never reaches a
    // node (which would confuse the heading measurement)
    const mounted = await page.evaluate(`(() => {
      const g = window.__laasDbg.rideGraph;
      let best = g.edges[0];
      for (const e of g.edges) if (e.length > best.length) best = e;
      const r = window.__laasDbg.ride;
      const ok = r.teleportEdge(best.id, best.length * 0.5, 1);
      r.setMode('road');
      r.setPower(150);
      return ok && r.state().riding;
    })()`);
    check('bike mounted on the longest edge', !!mounted);

    await settle(page, 200); // spin up to a steady speed
    const start = await read(page);
    check('bike is riding + moving before U-turn', start.v > 1, `v=${start.v.toFixed(2)} m/s`);
    await page.screenshot({ path: 'shots/wip/ux/ux01-bylo.png' });

    // HOLD the brake — the desktop U-turn trigger. Poll in fine increments so
    // the flip is caught inside a small window (a teleport would show a huge
    // position delta in exactly that window).
    await page.keyboard.down('KeyS');
    let prev = start;
    let uturnSeen = false;
    let flipStep = 0;
    let flipBanner: string | null = null;
    for (let i = 0; i < 90 && !uturnSeen; i++) {
      await settle(page, 4);
      const now = await read(page);
      const dh = degDiff(now.heading, start.heading);
      if (dh > 150) {
        uturnSeen = true;
        flipStep = Math.hypot(now.x - prev.x, now.z - prev.z);
        flipBanner = now.note;
      }
      prev = now;
    }
    await settle(page, 20); // let the swing finish + banner paint
    const end = await read(page);
    await page.keyboard.up('KeyS');

    const dhDeg = degDiff(end.heading, start.heading);
    check('hold-brake engaged the U-turn', uturnSeen);
    check('travel heading reversed ~180°', dhDeg >= 150 && dhDeg <= 210, `${dhDeg.toFixed(0)}°`);
    // continuity: the flip window's position delta is what a rider actually
    // rode in those 4 frames at low speed (< ~1 m); a teleport to another
    // edge would be a JOIN_R-scale jump (15 m+).
    check('position continuous across the flip (no teleport)', flipStep < 3, `flipStep=${flipStep.toFixed(2)} m`);
    check(
      'U-turn banner note raised',
      flipBanner !== null || end.note !== null,
      `note=${JSON.stringify(flipBanner ?? end.note)}`,
    );

    await page.screenshot({ path: 'shots/wip/ux/ux01-stalo.png' });
    await page.close();
  } finally {
    await browser.close();
  }
  console.log(pass ? '[probe-ux01] ALL PASS' : '[probe-ux01] FAILURES PRESENT');
  if (!pass) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux01] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
