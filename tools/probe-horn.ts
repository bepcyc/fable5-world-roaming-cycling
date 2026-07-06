/**
 * probe-horn — one-boot numeric dump of WHERE the brake-hood HORN sits
 * relative to the posed hand joints (root space). The horn is a separate
 * sphere at hoodPoint+(0,0.032,-0.07); the GripSpec hood center is
 * hoodPoint+(0,0.014,-0.016), so hornC = hoodR + (0,+0.018,-0.054).
 *
 * Answers, with NUMBERS: how far does the horn poke ABOVE the back-of-hand
 * (y_horn − y_maxHandTop) and FORWARD of the knuckle row, and what is each
 * key joint's clearance to hood / lever / horn — i.e. does any part of the
 * hand currently touch the horn, or is it standing proud in mid-air.
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/probe-horn.ts
 */
import { launchWebGPUReal } from './launch-gpu';

const ORIGIN = `http://localhost:${process.env.LAAS_PORT ?? 5174}`;

const DUMP = `(() => {
  const rg = window.__laasDbg.riderGrip;
  const { root, rig, spec } = rg;
  root.updateWorldMatrix(true, true);
  const inv = root.matrixWorld.clone().invert();
  const grab = (nm) => {
    const b = rig.getObjectByName(nm);
    if (!b) return null;
    const m = b.matrixWorld.elements, e = inv.elements;
    const vx = m[12], vy = m[13], vz = m[14];
    return [
      e[0]*vx + e[4]*vy + e[8]*vz + e[12],
      e[1]*vx + e[5]*vy + e[9]*vz + e[13],
      e[2]*vx + e[6]*vy + e[10]*vz + e[14],
    ];
  };
  rg.reset();
  rg.applyPose({ handAlong: 0.0525, palmPad: 0.004, curl: 0.15,
    curlTip: 0.85, twist: 0.15, pitch: 0.08 });
  const names = ['Wrist','Index1','Index2','Index3','Index4','Middle2',
    'Middle3','Ring2','Pinky2','Thumb1','Thumb2','Thumb3'];
  const out = {};
  for (const side of ['L','R']) for (const nm of names) out[nm+side] = grab(nm+side);
  return { out, spec };
})()`;

type V = number[];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const R_FLESH = 0.008;

function hoodGap(p: V, c: V, ax: V, rad: number): number {
  const v = sub(p, c);
  const tRaw = dot(v, ax);
  const t = Math.max(-0.025, Math.min(0.045, tRaw));
  const perp = [v[0] - t * ax[0], v[1] - t * ax[1], v[2] - t * ax[2]];
  return Math.hypot(perp[0], perp[1], perp[2], tRaw - t) - rad - R_FLESH;
}
function segGap(p: V, a: V, b: V, rad: number): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab) || 1;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  const q = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) - rad - R_FLESH;
}

async function main(): Promise<void> {
  const { browser } = await launchWebGPUReal();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(
    `${ORIGIN}/?scene=world&seed=1&T=11&preset=high&hud=0&dash=0&ridedev=1&road=asphalt,0.1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => (window as any).__laas && ((window as any).__laas.ready || (window as any).__laas.error !== null),
    undefined, { timeout: 600_000, polling: 500 },
  );
  await page.waitForFunction(() => !!(window as any).__laasDbg?.riderGrip?.reset, undefined, {
    timeout: 30_000, polling: 250,
  });
  const r = (await page.evaluate(DUMP)) as {
    out: Record<string, V | null>;
    spec: { hoodR: V; hoodDir: V; hoodRad: number; leverA: V; leverB: V; leverRad: number;
      hornC: V; hornRad: number };
  };
  await browser.close();
  const { spec } = r;
  for (const side of ['L', 'R'] as const) {
    const sgn = side === 'R' ? 1 : -1;
    const hoodC: V = [sgn * Math.abs(spec.hoodR[0]), spec.hoodR[1], spec.hoodR[2]];
    const ax = nrm([sgn * spec.hoodDir[0], spec.hoodDir[1], spec.hoodDir[2]]);
    // real horn from the page spec (source of truth), mirrored per side
    const hornC: V = [sgn * spec.hornC[0], spec.hornC[1], spec.hornC[2]];
    const hornRad = spec.hornRad;
    const leverA: V = [sgn * spec.leverA[0], spec.leverA[1], spec.leverA[2]];
    const leverB: V = [sgn * spec.leverB[0], spec.leverB[1], spec.leverB[2]];
    const g = (nm: string): V | null => r.out[nm + side] ?? null;
    console.log(`\n===== ${side} =====`);
    console.log(`hornC=(${hornC.map((v) => (v * 1000).toFixed(0)).join(',')}) y=${(hornC[1] * 1000).toFixed(0)}mm`);
    // how far the horn TOP pokes above the highest hand joint
    let maxY = -Infinity;
    let maxYname = '';
    for (const nm of ['Wrist', 'Index1', 'Index2', 'Index3', 'Index4', 'Middle2', 'Thumb1', 'Thumb2', 'Thumb3']) {
      const p = g(nm);
      if (p && p[1] > maxY) { maxY = p[1]; maxYname = nm; }
    }
    const hornTopY = hornC[1] + hornRad;
    console.log(`horn TOP y=${(hornTopY * 1000).toFixed(0)}mm  vs highest hand joint ${maxYname} y=${(maxY * 1000).toFixed(0)}mm  → horn proud by ${((hornTopY - maxY) * 1000).toFixed(0)}mm`);
    // per-joint clearances to hood / lever / horn; flag the closest to horn
    let clipName = '';
    let clipG = Infinity;
    for (const nm of ['Wrist', 'Index2', 'Index3', 'Index4', 'Middle2', 'Middle3', 'Middle4',
      'Ring2', 'Pinky2', 'Thumb1', 'Thumb2', 'Thumb3']) {
      const p = g(nm);
      if (!p) continue;
      const gh = hoodGap(p, hoodC, ax, spec.hoodRad);
      const gl = segGap(p, leverA, leverB, spec.leverRad);
      const gn = segGap(p, hornC, hornC, hornRad);
      if (gn < clipG) { clipG = gn; clipName = nm; }
      console.log(`${nm.padEnd(7)} hood=${(gh * 1000).toFixed(0)}mm lever=${(gl * 1000).toFixed(0)}mm HORN=${(gn * 1000).toFixed(0)}mm  min=${(Math.min(gh, gl, gn) * 1000).toFixed(0)}`);
    }
    console.log(`→ closest to HORN: ${clipName} at ${(clipG * 1000).toFixed(0)}mm (negative = clips into horn)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
