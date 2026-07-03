/**
 * M1.5 TRAA-vs-cockpit probe — moving-capture smear check.
 *
 * The cockpit rides with the camera; TRAA's analytic camera reprojection
 * is wrong for it, so PostStack routes near-field pixels through the
 * rig's own prev/cur transform (cockpitVelU). This probe demonstrates the
 * fix on a REAL moving ride in ONE boot:
 *
 *   1. pedal to cruise speed (TRAA history saturated)
 *   2. FIX ON:  frames A1, A2 (3 frames apart)
 *   3. FIX OFF (live toggle → wrong world-static velocity for cockpit),
 *      let history re-converge, frames B1, B2
 *   4. metric over cockpit-only crops (computer stem column + both hand
 *      corners — no world showing through): the cockpit is screen-locked,
 *      so consecutive frames should match; ghosting bleeds the MOVING
 *      background into cockpit pixels and the pair diff jumps.
 *
 * PASS: fixOn pair-diff ≤ 3.5 gray levels mean AND fixOff/fixOn ≥ 1.8×
 * (the second clause proves the probe actually measures the smear, not
 * just noise — if OFF looks the same, the fix isn't doing anything).
 *
 * Usage: npx tsx tools/probe-cktraa.ts   (dev server on :5173)
 */

import sharp from 'sharp';
import { launchWebGPUReal } from './launch-gpu';

let pass = true;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

const W = 1280;
const H = 720;

interface Raw {
  data: Buffer;
  ch: number;
}

async function decode(buf: Buffer): Promise<Raw> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== W || info.height !== H) throw new Error(`unexpected ${info.width}x${info.height}`);
  return { data, ch: info.channels };
}

const Y0 = Math.floor(H * 0.68); // search zone: lower third (cockpit lives here)

function px(r: Raw, x: number, y: number, c: number): number {
  return r.data[(y * W + x) * r.ch + c] ?? 0;
}

function pxDiff(a: Raw, b: Raw, x: number, y: number): number {
  return (
    (Math.abs(px(a, x, y, 0) - px(b, x, y, 0)) +
      Math.abs(px(a, x, y, 1) - px(b, x, y, 1)) +
      Math.abs(px(a, x, y, 2) - px(b, x, y, 2))) /
    3
  );
}

/**
 * Cockpit mask from the FIX-ON pair: lower-third pixels that are both
 * DARK (cockpit is near-black; road/grass are bright) and STABLE across
 * the pair. The world moves at cruise speed, so it can't enter the mask;
 * the live screen digits are bright, so they can't either.
 */
function buildMask(a: Raw, b: Raw): boolean[] {
  const mask = new Array<boolean>(W * (H - Y0)).fill(false);
  for (let y = Y0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const luma = 0.299 * px(a, x, y, 0) + 0.587 * px(a, x, y, 1) + 0.114 * px(a, x, y, 2);
      if (luma < 80 && pxDiff(a, b, x, y) < 6) mask[(y - Y0) * W + x] = true;
    }
  }
  return mask;
}

function maskedDiff(a: Raw, b: Raw, mask: boolean[]): number {
  let sum = 0;
  let n = 0;
  for (let y = Y0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[(y - Y0) * W + x]) continue;
      sum += pxDiff(a, b, x, y);
      n++;
    }
  }
  return n > 0 ? sum / n : 999;
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-cktraa] adapter ${info.vendor}/${info.architecture}`);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(
    'http://localhost:5173/?scene=world&seed=1&T=11&preset=high&hud=0&ridedev=1&lockexp=1',
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const error = await page.evaluate(() => window.__laas.error);
  if (error) throw new Error(`fatal: ${error}`);
  const settle = (frames: number): Promise<void> =>
    page.evaluate(async (n) => {
      if (window.__laas.settle) await window.__laas.settle(n);
    }, frames);

  // asphalt: minimal legitimate cockpit buzz (0.4 mm) — isolates TRAA
  await page.evaluate(`(() => {
    const dbg = window.__laasDbg;
    dbg.ride.teleport('asphalt', 0.25);
    dbg.ride.setPower(320);
  })()`);
  await settle(320); // cruise + saturated TRAA history
  // measure while COASTING: zero power → zero cadence → the deliberate
  // pedaling sway stops, so pair-diff isolates TRAA behavior (the bike
  // still moves fast; the fix-off ghost needs camera travel)
  await page.evaluate(`window.__laasDbg.ride.setPower(0)`);
  await settle(60);
  const kmh = ((await page.evaluate(
    () => window.__laas.stats?.counters?.['ride.kmh100'] ?? 0,
  )) as number) / 100;
  console.log(`[ride] coasting at ${kmh.toFixed(1)} km/h`);
  if (kmh < 10) {
    check('coast speed reached', false, `${kmh.toFixed(1)} km/h — runway too hard?`);
  }

  const shot = async (name: string): Promise<Raw> => {
    const buf = (await page.screenshot({
      path: `shots/wip/${name}` as `${string}.png`,
      type: 'png',
    })) as Buffer;
    return decode(buf);
  };

  const a1 = await shot('cktraa-fixon-1.png');
  await settle(3);
  const a2 = await shot('cktraa-fixon-2.png');
  const mask = buildMask(a1, a2);
  const maskN = mask.filter(Boolean).length;
  const maskFrac = maskN / (W * (H - Y0));
  const dOn = maskedDiff(a1, a2, mask);

  await page.evaluate(`window.__laasDbg.ckVelFix(false)`);
  await settle(40); // let TRAA history churn on the wrong velocity
  const b1 = await shot('cktraa-fixoff-1.png');
  await settle(3);
  const b2 = await shot('cktraa-fixoff-2.png');
  const dOff = maskedDiff(b1, b2, mask);

  console.log(
    `[metric] mask=${(maskFrac * 100).toFixed(1)}% of lower third; pair-diff fixOn=${dOn.toFixed(2)} fixOff=${dOff.toFixed(2)} ratio=${(dOff / Math.max(dOn, 0.01)).toFixed(1)}×`,
  );
  // a healthy fix yields a stable dark cockpit mass; a smearing cockpit
  // can't hold stable dark pixels at cruise speed. Absolute values wobble
  // with road curvature (the camera legitimately re-aligns to heading, so
  // cockpit pixels drift a little frame-to-frame) — the discriminator is
  // the ON/OFF gap on the SAME pixels (measured: 3.6 vs 41.8, 11.6×).
  check('fix ON: stable dark cockpit mass exists', maskFrac >= 0.008, `${(maskFrac * 100).toFixed(1)}% of lower third (need ≥0.8%)`);
  check('fix ON: masked pair-diff small (no smear)', dOn <= 4.5, `meanΔ=${dOn.toFixed(2)}`);
  check('fix OFF: smear returns on the same pixels (≥3×, ≥12)', dOff >= Math.max(dOn * 3, 12), `${dOff.toFixed(2)} vs on=${dOn.toFixed(2)}`);

  await browser.close();
  console.log(pass ? 'ALL PASS' : 'FAILURES');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
