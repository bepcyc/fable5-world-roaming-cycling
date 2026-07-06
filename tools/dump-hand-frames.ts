/**
 * dump-hand-frames — one-boot numeric dump of the Adventurer hand rig.
 *
 * Answers, with NUMBERS (owner order: measurability before pixels):
 *   1. REST chirality: is the left hand a true mirror of the right
 *      (det sign of [across, along, thumbward] flips) or a copied right
 *      hand under left names (same sign)?
 *   2. REST finger fan: per-finger yaw spread in the palm plane.
 *   3. POSED palm normal: after DEFAULT_POSE, does the achieved palm
 *      normal match the requested one per side (dot ≈ +1) — or is a side
 *      flipped (dot ≈ −1 → back of hand on the hood)?
 *   4. POSED thumb side: thumb base inboard (correct) or outboard of the
 *      palm center per side?
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/dump-hand-frames.ts
 */
import { launchWebGPUReal } from './launch-gpu';

const ORIGIN = `http://localhost:${process.env.LAAS_PORT ?? 5174}`;

const DUMP = `(() => {
  const rg = window.__laasDbg.riderGrip;
  const { root, rig, spec } = rg;
  const grab = (inv) => {
    const out = {};
    for (const side of ['L', 'R']) {
      for (const nm of ['Wrist', 'Index1', 'Index2', 'Index3', 'Index4',
        'Middle1', 'Middle2', 'Middle3', 'Middle4', 'Ring1', 'Ring2',
        'Ring3', 'Ring4', 'Pinky1', 'Pinky2', 'Pinky3', 'Pinky4',
        'Thumb1', 'Thumb2', 'Thumb3']) {
        const b = rig.getObjectByName(nm + side);
        if (!b) continue;
        const m = b.matrixWorld.elements;
        const e = inv.elements;
        const vx = m[12], vy = m[13], vz = m[14];
        out[nm + side] = [
          e[0]*vx + e[4]*vy + e[8]*vz + e[12],
          e[1]*vx + e[5]*vy + e[9]*vz + e[13],
          e[2]*vx + e[6]*vy + e[10]*vz + e[14],
        ];
      }
    }
    return out;
  };
  root.updateWorldMatrix(true, true);
  const inv = root.matrixWorld.clone().invert();
  rg.reset();
  const rest = grab(inv);
  rg.applyPose({ handAlong: 0.0525, palmPad: 0.004, curl: 0.15,
    curlTip: 0.75, twist: 0.15, pitch: 0.08 });
  const posed = grab(inv);
  return { rest, posed, spec };
})()`;

type P = Record<string, number[]>;
const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]): number[] => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]): number[] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function gapOf(p: number[], side: 'L' | 'R', spec: { hoodR: number[]; hoodDir: number[]; hoodRad: number }): number {
  const sgn = side === 'R' ? 1 : -1;
  const c = [sgn * Math.abs(spec.hoodR[0]), spec.hoodR[1], spec.hoodR[2]];
  const d = norm([sgn * spec.hoodDir[0], spec.hoodDir[1], spec.hoodDir[2]]);
  const v = sub(p, c);
  const tRaw = dot(v, d);
  const t = Math.max(-0.025, Math.min(0.045, tRaw));
  const perp = [v[0] - t * d[0], v[1] - t * d[1], v[2] - t * d[2]];
  return Math.hypot(perp[0], perp[1], perp[2], tRaw - t) - spec.hoodRad - 0.008;
}
function tOf(p: number[], side: 'L' | 'R', spec: { hoodR: number[]; hoodDir: number[] }): number {
  const sgn = side === 'R' ? 1 : -1;
  const c = [sgn * Math.abs(spec.hoodR[0]), spec.hoodR[1], spec.hoodR[2]];
  const d = norm([sgn * spec.hoodDir[0], spec.hoodDir[1], spec.hoodDir[2]]);
  return dot(sub(p, c), d);
}

function analyze(tag: string, pts: P, spec: { hoodR: number[]; hoodDir: number[]; hoodRad: number }): void {
  console.log(`\n===== ${tag} =====`);
  for (const side of ['L', 'R'] as const) {
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb']) {
      const row: string[] = [];
      for (const i of [1, 2, 3, 4]) {
        const p = pts[`${f}${i}${side}`];
        if (!p) continue;
        row.push(`${i}: g=${(gapOf(p, side, spec) * 1000).toFixed(0)}mm t=${(tOf(p, side, spec) * 1000).toFixed(0)}mm y=${(p[1] * 1000).toFixed(0)}`);
      }
      if (row.length) console.log(`${side} ${f.padEnd(6)} ${row.join('  ')}`);
    }
    const w = pts[`Wrist${side}`];
    if (w) console.log(`${side} Wrist  g=${(gapOf(w, side, spec) * 1000).toFixed(0)}mm t=${(tOf(w, side, spec) * 1000).toFixed(0)}mm`);
  }
  for (const side of ['L', 'R'] as const) {
    const g = (nm: string): number[] | null => pts[nm + side] ?? null;
    const wrist = g('Wrist'); const mid3 = g('Middle3');
    const i2 = g('Index2'); const p2 = g('Pinky2'); const t1 = g('Thumb1');
    if (!wrist || !mid3 || !i2 || !p2 || !t1) { console.log(`${side}: bones missing`); continue; }
    const along = norm(sub(mid3, wrist));
    const across = norm(sub(i2, p2));
    const thumbward = norm(sub(t1, wrist));
    const det = dot(cross(across, along), thumbward);
    const nCode = norm(cross(across, along)); // formula orientWrist uses
    console.log(`${side}: det[across,along,thumbward]=${det.toFixed(3)}  ` +
      `codePalmN=(${nCode.map((v) => v.toFixed(2)).join(',')})  ` +
      `thumbward=(${thumbward.map((v) => v.toFixed(2)).join(',')})`);
    // finger fan: yaw of each finger (seg2→seg4) vs middle, in palm plane
    const mfd = norm(sub(g('Middle4') ?? mid3, g('Middle2') ?? wrist));
    const fan: string[] = [];
    for (const f of ['Index', 'Ring', 'Pinky']) {
      const a = g(`${f}2`); const b = g(`${f}4`);
      if (!a || !b) continue;
      const d = norm(sub(b, a));
      const lat = dot(d, across);
      const fwd = dot(d, mfd);
      fan.push(`${f}:${((Math.atan2(lat, fwd) * 180) / Math.PI).toFixed(0)}°`);
    }
    console.log(`${side}: fan vs middle ${fan.join(' ')}`);
    // posed-only checks vs the grip frame
    const sgn = side === 'R' ? 1 : -1;
    const f0 = norm([sgn * spec.hoodDir[0], spec.hoodDir[1], spec.hoodDir[2]]);
    const down = [0, -1, 0];
    const nT = norm([down[0] - f0[0] * dot(down, f0), down[1] - f0[1] * dot(down, f0),
      down[2] - f0[2] * dot(down, f0)]);
    console.log(`${side}: palmN·target=${dot(nCode, nT).toFixed(2)}  ` +
      `fingers·hoodDir=${dot(along, f0).toFixed(2)}`);
    // thumb inboard? (inboard = toward bike center = −sgn·X)
    const palmC = [0, 1, 2].map((k) =>
      (['Index1', 'Middle1', 'Ring1', 'Pinky1'] as const)
        .reduce((s, nm) => s + (g(nm)?.[k] ?? 0), 0) / 4);
    const thumbLat = (t1[0] - palmC[0]) * -sgn;
    console.log(`${side}: thumb inboard offset=${(thumbLat * 1000).toFixed(0)}mm ` +
      `(positive = correct side)`);
  }
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
    rest: P; posed: P; spec: { hoodR: number[]; hoodDir: number[]; hoodRad: number };
  };
  await browser.close();
  analyze('REST (bind pose, arms reset)', r.rest, r.spec);
  analyze('POSED (DEFAULT_POSE)', r.posed, r.spec);
}
main().catch((e) => { console.error(e); process.exit(1); });
