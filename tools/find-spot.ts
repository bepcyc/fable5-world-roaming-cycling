/**
 * find-spot: locate camera poses that LOOK AT a described target — flowers,
 * water, asphalt, gravel, dirt road, singletrack, grass, scree, rock, mud,
 * snow — from a requested distance (near / mid / far), scored for an
 * unobstructed view. Prints ready --cam strings for shoot.ts.
 *
 * How it works:
 *   Phase 1 (scan). Boots ONE page with a class-coded debug overlay:
 *     - flowers        -> ?clsdbg=1&clsonly=flowers  (only flower draws,
 *                         flat hues: umbel 204deg / bell 251deg / daisy 298deg)
 *     - everything else-> ?surfdbg=1 (SURF_COL palette on the terrain)
 *   Builds candidate poses in-page from the road network + groundProbe
 *   (meadow side-offsets for vegetation, on-route anchors for road classes,
 *   grid scan for water/rock/scree/mud/snow), then teleports the fly camera
 *   through them (setPose -> settle -> small screenshot) and scores each
 *   frame in Node: fraction of target-palette pixels inside the aim box
 *   minus an occlusion penalty (near-black or foreground-blob pixels).
 *   All scan thumbnails are composited into ONE contact sheet (never sent
 *   as single frames).
 *   Phase 2 (--beauty). Re-shoots the top-K poses at full res with the
 *   normal renderer (fresh page per shot, freeze=1, via tools/shoot.ts).
 *
 * Usage:
 *   LAAS_PORT=5178 npx tsx tools/find-spot.ts --want flowers --dist near \
 *     --seed 1 --T 14 --n 48 --top 3 --out shots/wip/spot-flowers --beauty
 *
 * Output:
 *   <out>-scan.json      all candidates + scores + cam strings
 *   <out>-contact.png    ranked contact sheet of scan thumbnails
 *   <out>-best-<k>.png   beauty shots of the top poses (--beauty)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { laasUrl } from './launch';
import { launchWebGPUReal as launchWebGPU } from './launch-gpu';

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    }
  }
  return out;
}
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

type Dist = 'near' | 'mid' | 'far';
/** look-at distance (m) per band and the aim-box row window (0..1 of height) */
const DIST_SPEC: Record<Dist, { look: number; eyeUp: number; rows: [number, number] }> = {
  near: { look: 7, eyeUp: 1.7, rows: [0.42, 0.88] },
  mid: { look: 45, eyeUp: 1.9, rows: [0.34, 0.68] },
  far: { look: 260, eyeUp: 3.0, rows: [0.3, 0.6] },
};

/** hue windows (deg) + min saturation for palette matching after tonemap.
 *  Surface palette colors are emissive pre-tonemap (DebugSurface.SURF_COL);
 *  AgX shifts/desaturates them, so windows are generous. */
interface Match {
  hue?: [number, number][];
  minS?: number;
  minV?: number;
  maxV?: number;
  maxS?: number;
}
const MATCHERS: Record<string, Match> = {
  // world flowers are GroundRing verge-bloom pools: group 11 road-trefoil
  // (flat gold 0.95,0.78,0.02) and group 12 road-thyme (purple). The scan
  // runs with ?ringdbg=1&ringonly=11 — every other ring draw (grass!) is
  // hidden, so saturated gold pixels are trefoil by construction.
  flowers: { hue: [[30, 64]], minS: 0.45, minV: 0.2 },
  thyme: { hue: [[268, 300]], minS: 0.4, minV: 0.1 },
  water: { hue: [[345, 360], [0, 18]], minS: 0.35, minV: 0.08 },
  asphalt: { hue: [[16, 42]], minS: 0.35, minV: 0.15 },
  gravel: { hue: [[42, 68]], minS: 0.3, minV: 0.15 },
  dirt: { hue: [[18, 40]], minS: 0.25, minV: 0.1, maxV: 0.6 },
  singletrack: { hue: [[300, 340]], minS: 0.3, minV: 0.1 },
  grass: { hue: [[95, 155]], minS: 0.3, minV: 0.1 },
  mud: { hue: [[270, 300]], minS: 0.25, minV: 0.08 },
  scree: { minS: 0.14, minV: 0.45, maxS: 0.0 }, // near-gray bright: special-cased below
  rock: { minS: 0.2, minV: 0.2, maxS: 0.0 },
  snow: { minS: 0.0, minV: 0.85, maxS: 0.12 },
};

const WANT_ALIAS: Record<string, string> = {
  river: 'water', lake: 'water', road: 'asphalt', flower: 'flowers',
  meadow: 'grass', trail: 'singletrack', stone: 'rock', mountain: 'scree',
};

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx === 0 ? 0 : d / mx, mx];
}

function matches(want: string, h: number, s: number, v: number): boolean {
  const m = MATCHERS[want];
  if (!m) return false;
  if (want === 'scree') return s < 0.14 && v > 0.45 && v < 0.85;
  if (want === 'rock') return s < 0.2 && v > 0.2 && v <= 0.5;
  if (want === 'snow') return s < (m.maxS ?? 0.12) && v >= (m.minV ?? 0.85);
  if (m.minS !== undefined && s < m.minS) return false;
  if (m.minV !== undefined && v < m.minV) return false;
  if (m.maxV !== undefined && v > m.maxV) return false;
  return (m.hue ?? []).some(([a, b]) => h >= a && h <= b);
}

/** in-page candidate pose builder — passed as a STRING (esbuild __name trap). */
function buildScript(want: string, dist: Dist, maxN: number): string {
  const spec = DIST_SPEC[dist];
  // Surface targets a candidate must aim at (SurfaceMatrix SurfaceId values).
  const surfIds: Record<string, number[]> = {
    grass: [0], flowers: [0], thyme: [0], scree: [3], rock: [4], mud: [6], snow: [7],
    water: [8, 9], asphalt: [10], gravel: [11, 12], dirt: [13], singletrack: [14],
  };
  const ids = JSON.stringify(surfIds[want] ?? [0]);
  const onRoad = ['asphalt', 'gravel', 'dirt', 'singletrack'].includes(want);
  return `(function(){
    var L = window.__laas;
    if (!L.roads || !L.groundProbe) return JSON.stringify({err:'no roads/groundProbe'});
    var IDS = ${ids}, LOOK = ${spec.look}, UP = ${spec.eyeUp}, MAXN = ${maxN};
    var ON_ROAD = ${onRoad ? 'true' : 'false'}, WANT = ${JSON.stringify(want)};
    var probe = function(x, z){ return L.groundProbe(x, z); };
    var isTarget = function(x, z){
      var g = probe(x, z);
      if (!g) return null;
      var wet = g.water > g.ground + 0.04;
      if (WANT === 'water') return wet ? g : null;
      if (wet) return null;
      return IDS.indexOf(g.surfaceId) >= 0 ? g : null;
    };
    var poses = [];
    var push = function(ex, ez, tx, tz, note){
      var eg = probe(ex, ez);
      if (!eg) return;
      var ey = Math.max(eg.ground, eg.water) + UP;
      var tg = probe(tx, tz);
      if (!tg) return;
      var ty = (WANT === 'water' ? tg.water : tg.ground) + (WANT === 'flowers' ? 0.35 : 0);
      var dx = tx - ex, dy = ty - ey, dz = tz - ez;
      var len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      var yaw = Math.atan2(-dx/len, -dz/len);
      var pitch = Math.asin(Math.max(-1, Math.min(1, dy/len)));
      // ground targets must be looked DOWN at: an uphill aim point drags the
      // camera into the sky and the aim box scores clouds instead of target
      if (WANT !== 'water') pitch = Math.min(pitch, -0.06);
      poses.push({ p: [ex, ey, ez], yaw: yaw, pitch: pitch,
        tx: tx, tz: tz, note: note });
    };
    var routes = (L.roads.routes || []).slice();
    // widest sampling: walk every route by arclength
    for (var ri = 0; ri < routes.length && poses.length < MAXN * 3; ri++) {
      var r = routes[ri], pts = r.pts || [];
      if (pts.length < 6) continue;
      var clsName = r.cls ? r.cls.name : '?';
      var STEP = 90;
      for (var idx = 2; idx < pts.length - 2; idx++) {
        var a = pts[idx - 1], b = pts[idx];
        if (b.s - (pts[2].s || 0) < 10) continue;
        if ((b.s % STEP) > (a.s % STEP)) continue; // crossed a station
        var dx = b.x - a.x, dz = b.z - a.z, ln = Math.hypot(dx, dz) || 1;
        dx /= ln; dz /= ln;
        var nx = -dz, nz = dx;
        if (ON_ROAD) {
          if (IDS.indexOf(probe(b.x, b.z) ? probe(b.x, b.z).surfaceId : -1) < 0) continue;
          // stand on the route, look along it
          push(b.x - dx * LOOK, b.z - dz * LOOK, b.x, b.z, clsName + '@s' + Math.round(b.s));
        } else {
          // verge blooms hug soft-track shoulders — sample tight offsets and
          // skip asphalt routes for them; meadow targets sweep wider
          var isBloom = WANT === 'flowers' || WANT === 'thyme';
          if (isBloom && clsName === 'asphalt') continue;
          var offs = isBloom ? [3.5, 5, 7, -3.5, -5, -7] : [8, 14, 22, -8, -14, -22];
          for (var oi = 0; oi < offs.length; oi++) {
            var o = offs[oi];
            var sx = b.x + nx * o, sz = b.z + nz * o;
            var g = isTarget(sx, sz);
            if (!g || g.slope > 0.45) continue;
            // eye stays near the road edge, aim into the target patch
            var ex = b.x + nx * (o > 0 ? 2 : -2), ez = b.z + nz * (o > 0 ? 2 : -2);
            var fx = sx + nx * (o > 0 ? 1 : -1) * (LOOK - Math.abs(o - 2));
            var fz = sz + nz * (o > 0 ? 1 : -1) * (LOOK - Math.abs(o - 2));
            var t2 = isTarget(fx, fz);
            var ax = t2 ? fx : sx, az = t2 ? fz : sz;
            push(ex, ez, ax, az, clsName + '/side' + o + '@s' + Math.round(b.s));
            break;
          }
        }
        if (poses.length >= MAXN * 3) break;
      }
    }
    // grid fallback for off-road targets (water pools away from roads, rock...)
    if (!ON_ROAD && poses.length < MAXN) {
      for (var gx = -1500; gx <= 1500 && poses.length < MAXN * 3; gx += 48) {
        for (var gz = -1500; gz <= 1500; gz += 48) {
          var t = isTarget(gx, gz);
          if (!t) continue;
          var back = LOOK;
          var cand = [[gx - back, gz], [gx + back, gz], [gx, gz - back], [gx, gz + back]];
          for (var ci = 0; ci < cand.length; ci++) {
            var e = probe(cand[ci][0], cand[ci][1]);
            if (!e || e.water > e.ground + 0.04 || e.slope > 0.5) continue;
            push(cand[ci][0], cand[ci][1], gx, gz, 'grid@' + gx + ',' + gz);
            break;
          }
        }
      }
    }
    // spread: shuffle deterministically, cap at MAXN
    var seed = 1234567;
    for (var i = poses.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      var j = seed % (i + 1);
      var tmp = poses[i]; poses[i] = poses[j]; poses[j] = tmp;
    }
    return JSON.stringify(poses.slice(0, MAXN));
  })()`;
}

interface Cand {
  p: [number, number, number];
  yaw: number;
  pitch: number;
  tx: number;
  tz: number;
  note: string;
  score?: number;
  targetFrac?: number;
  darkFrac?: number;
  cam?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let want = (str(args['want']) ?? 'flowers').toLowerCase();
  want = WANT_ALIAS[want] ?? want;
  if (!MATCHERS[want]) throw new Error(`unknown --want '${want}'`);
  const dist = (str(args['dist']) ?? 'near') as Dist;
  if (!DIST_SPEC[dist]) throw new Error(`unknown --dist '${dist}'`);
  const seed = Number(str(args['seed']) ?? 1);
  const T = Number(str(args['T']) ?? 14);
  const n = Number(str(args['n']) ?? 48);
  const top = Number(str(args['top']) ?? 3);
  const outBase = str(args['out']) ?? `shots/wip/spot-${want}-${dist}`;
  const beauty = args['beauty'] === true || args['beauty'] === '1';
  const fov = Number(str(args['fov']) ?? 55);
  mkdirSync(dirname(outBase), { recursive: true });

  const SCAN_W = 800, SCAN_H = 450;
  const extra: Record<string, string> =
    want === 'flowers' ? { ringdbg: '1', ringonly: '11' }
    : want === 'thyme' ? { ringdbg: '1', ringonly: '12' }
    : { surfdbg: '1' };

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: SCAN_W, height: SCAN_H }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  // freeze=0: the fly camera must keep streaming vegetation/rings after teleports
  const url = laasUrl({ scene: 'world', seed, T, width: SCAN_W, height: SCAN_H, hud: false, freeze: false, extra });
  console.log(`[find-spot] scan ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined, { timeout: 240000, polling: 250 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(`app error: ${bootErr}`);

  const candJson = (await page.evaluate(buildScript(want, dist, n))) as string;
  const cands = JSON.parse(candJson) as Cand[] | { err: string };
  if (!Array.isArray(cands)) throw new Error(`candidate builder: ${(cands as { err: string }).err}`);
  console.log(`[find-spot] ${cands.length} candidate poses`);
  if (cands.length === 0) throw new Error('no candidates — try another seed/--want');

  const spec = DIST_SPEC[dist];
  const thumbs: Buffer[] = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i] as Cand;
    const poseJs = `(function(){
      var L = window.__laas;
      L.setPose && L.setPose({ p: [${c.p[0]}, ${c.p[1]}, ${c.p[2]}], yaw: ${c.yaw}, pitch: ${c.pitch}, fov: ${fov} });
      return L.settle ? L.settle(16).then(function(){ return 1; }) : 1;
    })()`;
    await page.evaluate(poseJs);
    const shot = (await page.screenshot({ type: 'png' })) as Buffer;
    thumbs.push(shot);
    // score: palette pixels inside the aim box, darkness penalty
    const raw = await sharp(shot).resize(320, 180).raw().toBuffer();
    const W = 320, H = 180;
    const r0 = Math.floor((spec.rows[0]) * H), r1 = Math.floor(spec.rows[1] * H);
    const c0 = Math.floor(0.22 * W), c1 = Math.floor(0.78 * W);
    let hit = 0, dark = 0, tot = 0;
    for (let y = r0; y < r1; y++) {
      for (let x = c0; x < c1; x++) {
        const o = (y * W + x) * 3;
        const [h, s, v] = rgbToHsv(raw[o]! / 255, raw[o + 1]! / 255, raw[o + 2]! / 255);
        tot++;
        if (matches(want, h, s, v)) hit++;
        else if (v < 0.07) dark++;
      }
    }
    c.targetFrac = hit / tot;
    c.darkFrac = dark / tot;
    c.score = c.targetFrac - 0.5 * c.darkFrac;
    const f = (x: number): string => x.toFixed(2);
    c.cam = `${f(c.p[0])},${f(c.p[1])},${f(c.p[2])},${c.yaw.toFixed(4)},${c.pitch.toFixed(4)},${fov}`;
    console.log(`[scan ${String(i).padStart(3)}] score=${c.score.toFixed(3)} target=${c.targetFrac.toFixed(3)} dark=${c.darkFrac.toFixed(3)} ${c.note}`);
  }
  await browser.close();

  const ranked = [...(cands as Cand[])].map((c, i) => ({ c, i })).sort((a, b) => (b.c.score ?? 0) - (a.c.score ?? 0));

  // contact sheet: ranked thumbnails, ONE composite image (never single frames)
  const COLS = 6, TW = 320, TH = 180, PAD = 4;
  const rows = Math.ceil(ranked.length / COLS);
  const sheetW = COLS * (TW + PAD) + PAD, sheetH = rows * (TH + PAD + 18) + PAD;
  const overlays: OverlayOptions[] = [];
  for (let k = 0; k < ranked.length; k++) {
    const { c, i } = ranked[k]!;
    const img = await sharp(thumbs[i]!).resize(TW, TH).toBuffer();
    const x = PAD + (k % COLS) * (TW + PAD);
    const y = PAD + Math.floor(k / COLS) * (TH + PAD + 18);
    overlays.push({ input: img, left: x, top: y });
    const label = Buffer.from(
      `<svg width="${TW}" height="16"><rect width="${TW}" height="16" fill="black"/>` +
      `<text x="4" y="12" font-family="monospace" font-size="11" fill="#ffe14d">#${k} s=${(c.score ?? 0).toFixed(2)} ${c.note?.slice(0, 34) ?? ''}</text></svg>`,
    );
    overlays.push({ input: label, left: x, top: y + TH + 1 });
  }
  const sheetPath = `${outBase}-contact.png`;
  await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: { r: 24, g: 24, b: 24 } } })
    .composite(overlays).png().toFile(sheetPath);
  console.log(`[find-spot] wrote ${sheetPath}`);

  const scanJson = `${outBase}-scan.json`;
  writeFileSync(scanJson, JSON.stringify({ want, dist, seed, T, ranked: ranked.map(({ c }) => c) }, null, 2));
  console.log(`[find-spot] wrote ${scanJson}`);

  console.log('[find-spot] top poses:');
  for (let k = 0; k < Math.min(top, ranked.length); k++) {
    const { c } = ranked[k]!;
    console.log(`  #${k} score=${(c.score ?? 0).toFixed(3)} --cam "${c.cam}"   (${c.note})`);
  }

  if (beauty) {
    for (let k = 0; k < Math.min(top, ranked.length); k++) {
      const { c } = ranked[k]!;
      const out = `${outBase}-best-${k}.png`;
      console.log(`[find-spot] beauty #${k} -> ${out}`);
      execFileSync('npx', [
        'tsx', 'tools/shoot.ts', '--scene', 'world', '--seed', String(seed), '--T', String(T),
        '--cam', c.cam!, '--out', out,
      ], { stdio: 'inherit', env: process.env });
    }
  }
}

main().catch((e: unknown) => {
  console.error('[find-spot] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
