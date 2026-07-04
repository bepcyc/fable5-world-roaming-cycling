/**
 * ck-shot — M1.5.2 judge-frame tool: boots the world, teleports the bike
 * to a chosen fraction of a road class, forces watts, lets it reach
 * cruise, screenshots. Unlike ?road=<cls> spawning (nearest-road, uphill
 * luck), this gives exact spot + speed control — the reference photos
 * are downhill-at-speed frames.
 *
 *   LAAS_PORT=5174 npx tsx tools/ck-shot.ts --cls singletrack --frac 0.8 \
 *     --power 260 --settle 300 --w 1600 --h 900 --out shots/wip/m152/x.png
 *
 * Prints ride.kmh100/grade1000 so downhill spots can be picked by sweep.
 *
 * --burst N (default 1): after the normal shot, capture N-1 more frames in
 * the same boot, advancing --burstGap (default 3) frames between each, and
 * write them alongside --out with -b0, -b1, ... suffixes before the
 * extension. Omit --burst (or pass 1) for identical single-shot behavior.
 */

import { LAAS_ORIGIN } from './launch';
import { launchWebGPUReal } from './launch-gpu';

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = true;
    }
  }
  return out;
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

// insert -bN before the extension: shots/x.png, 2 -> shots/x-b2.png
function burstPath(out: string, i: number): string {
  const dot = out.lastIndexOf('.');
  return dot === -1 ? `${out}-b${i}` : `${out.slice(0, dot)}-b${i}${out.slice(dot)}`;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const cls = str(a['cls']) ?? 'gravel-fine';
  const frac = Number(str(a['frac']) ?? 0.25);
  const power = Number(str(a['power']) ?? 200);
  const settleN = Number(str(a['settle']) ?? 280);
  const w = Number(str(a['w']) ?? 1600);
  const h = Number(str(a['h']) ?? 900);
  const out = str(a['out']) ?? 'shots/wip/m152/ck-shot.png';
  const extra = str(a['extra']) ?? '';
  const burstN = Number(str(a['burst']) ?? 1);
  const burstGap = Number(str(a['burstGap']) ?? 3);

  const { browser } = await launchWebGPUReal();
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(
    `${LAAS_ORIGIN}/?scene=world&seed=1&T=11&preset=high&hud=0&dash=0&ridedev=1${extra}`,
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

  // mode must match the surface BEFORE teleport (teleport defaults hike →
  // road, and a road bike on singletrack is blocked → 0 km/h forever)
  const mode = cls === 'asphalt' ? 'road' : cls.startsWith('gravel') ? 'gravel' : 'mtb';
  await page.evaluate(`(() => {
    const dbg = window.__laasDbg;
    dbg.ride.setMode('${mode}');
    dbg.ride.teleport('${cls}', ${frac});
    dbg.ride.setPower(${power});
  })()`);
  await settle(settleN);
  const kmh =
    ((await page.evaluate(
      () => window.__laas.stats?.counters?.['ride.kmh100'] ?? 0,
    )) as number) / 100;
  const grade =
    ((await page.evaluate(
      () => window.__laas.stats?.counters?.['ride.grade1000'] ?? 0,
    )) as number) / 10;
  console.log(`[ck-shot] ${cls}@${frac} ${power}W → ${kmh.toFixed(1)} km/h, grade ${grade.toFixed(1)}%`);
  await page.screenshot({ path: out as `${string}.png`, type: 'png' });
  console.log(`[ck-shot] wrote ${out}`);

  if (burstN > 1) {
    const written: string[] = [];
    for (let i = 0; i < burstN; i++) {
      if (i > 0) await settle(burstGap);
      const path = burstPath(out, i);
      await page.screenshot({ path: path as `${string}.png`, type: 'png' });
      written.push(path);
    }
    console.log(`[ck-shot] burst wrote: ${written.join(', ')}`);
  }

  await browser.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
