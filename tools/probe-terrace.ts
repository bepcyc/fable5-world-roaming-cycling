/**
 * Terrace transect probe (Front B) — sample the CPU ground mirror across the
 * river-gravel ribbon at spot1 to see the stepped walls as a numeric
 * staircase, and report the surface CLASS along the transect so the surfdbg
 * "black" region can be named. Output is JSON to stdout.
 *
 * Usage:
 *   LAAS_PORT=5180 npx tsx tools/probe-terrace.ts --seed 1 --T 14 \
 *     --cx -685 --cz 557 --half 260
 */
import type { Page } from 'playwright';
import { launchWebGPUReal, LAAS_ORIGIN } from './launch-gpu';

interface Args { [k: string]: string | boolean }
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith('--')) { out[k] = n; i++; } else out[k] = true;
  }
  return out;
}
const num = (v: string | boolean | undefined, d: number): number =>
  typeof v === 'string' ? Number(v) : d;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seed = num(args['seed'], 1);
  const T = num(args['T'], 14);
  const cx = num(args['cx'], -685);
  const cz = num(args['cz'], 557);
  const half = num(args['half'], 260);

  const { browser, info } = await launchWebGPUReal();
  const page: Page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  const url = `${LAAS_ORIGIN}/?scene=world&seed=${seed}&preset=high&hud=0&freeze=1&T=${T}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined, { timeout: 600_000, polling: 500 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) { await browser.close(); throw new Error(err); }
  console.error(`[terrace] ready (adapter ${info.vendor}/${info.architecture})`);

  const SCRIPT = `(() => {
    const P = window.__laas.groundProbe;
    if (!P) return JSON.stringify({ err: 'no groundProbe' });
    var CX = ${cx}, CZ = ${cz}, HALF = ${half};
    // 1) class histogram over the visible box (step 3 m)
    var hist = {};
    var step = 3;
    for (var z = CZ - HALF; z <= CZ + HALF; z += step) {
      for (var x = CX - HALF; x <= CX + HALF; x += step) {
        var g = P(x, z);
        hist[g.surfaceId] = (hist[g.surfaceId] || 0) + 1;
      }
    }
    // 2) locate the river-gravel ribbon: cells with surfaceId 5 (GravelRiver)
    //    or shallow/deep water (6/7). Collect their centroid + principal axis.
    var pts = [];
    for (var z = CZ - HALF; z <= CZ + HALF; z += step) {
      for (var x = CX - HALF; x <= CX + HALF; x += step) {
        var g = P(x, z);
        if (g.surfaceId === 5 || g.surfaceId === 6 || g.surfaceId === 7) pts.push([x, z]);
      }
    }
    var ribbon = null;
    if (pts.length > 4) {
      var mx = 0, mz = 0;
      for (var i = 0; i < pts.length; i++) { mx += pts[i][0]; mz += pts[i][1]; }
      mx /= pts.length; mz /= pts.length;
      var sxx = 0, sxz = 0, szz = 0;
      for (var i = 0; i < pts.length; i++) {
        var dx = pts[i][0] - mx, dz = pts[i][1] - mz;
        sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
      }
      // principal eigenvector of [[sxx,sxz],[sxz,szz]]
      var tr = sxx + szz, det = sxx * szz - sxz * sxz;
      var l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
      var ax = sxz, az = l1 - sxx;
      var al = Math.hypot(ax, az) || 1; ax /= al; az /= al; // along-ribbon
      var nx = -az, nz = ax;                                 // across-ribbon
      ribbon = { mx: mx, mz: mz, count: pts.length, along: [ax, az], across: [nx, nz] };
    }
    // 3) fine transect ACROSS the ribbon through its centroid (0.25 m step)
    var transect = [];
    if (ribbon) {
      var nx = ribbon.across[0], nz = ribbon.across[1];
      for (var s = -30; s <= 30; s += 0.25) {
        var x = ribbon.mx + nx * s, z = ribbon.mz + nz * s;
        var g = P(x, z);
        transect.push({ s: +s.toFixed(2), h: +g.ground.toFixed(3), w: +g.water.toFixed(3),
          sid: g.surfaceId, slope: +g.slope.toFixed(3) });
      }
    }
    return JSON.stringify({ hist: hist, ribbon: ribbon, transect: transect });
  })()`;

  const raw = (await page.evaluate(SCRIPT)) as string;
  await browser.close();
  console.log(raw);
}
main().catch((e: unknown) => { console.error('[terrace] FAILED:', e instanceof Error ? e.message : e); process.exit(1); });
