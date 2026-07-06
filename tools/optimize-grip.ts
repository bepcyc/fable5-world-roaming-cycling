/**
 * optimize-grip — numeric grip convergence (owner order: measurable grip,
 * iterate on NUMBERS, confirm by frame afterwards).
 *
 * One page load; coordinate descent over PoseParams via the live
 * __laasDbg.riderGrip.applyPose API. Loss per hand:
 *   Σ penetration² (hard, weight 30)
 * + Σ (mid-segment gap − 2 mm)²      — fingers hug the capsule
 * + (palm-center gap − 4 mm)² · 4    — palm seated on the hood
 * + (tip gap − 3 mm)² · 0.5          — fingertips close the wrap
 * Prints the best params to paste into RiderBody.DEFAULT_POSE.
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/optimize-grip.ts
 */
import { launchWebGPUReal } from './launch-gpu';

const ORIGIN = `http://localhost:${process.env.LAAS_PORT ?? 5174}`;

const START = { handAlong: 0.075, palmPad: 0.018, curl: 0.68, curlTip: 0.37, twist: 0, pitch: 0 };
const STEPS0 = { handAlong: 0.012, palmPad: 0.008, curl: 0.2, curlTip: 0.15, twist: 0.25, pitch: 0.2 };
const LIMITS: Record<string, [number, number]> = {
  handAlong: [0.045, 0.11], palmPad: [0.004, 0.035],
  curl: [0.2, 1.3], curlTip: [0.1, 1.0], twist: [-0.7, 0.7], pitch: [-0.5, 0.5],
};

// evaluated in-page: apply pose, measure gaps, return loss components
const MEASURE = `((p) => {
  const rg = window.__laasDbg.riderGrip;
  rg.applyPose(p);
  const { root, rig, spec } = rg;
  root.updateWorldMatrix(true, true);
  const inv = root.matrixWorld.clone().invert();
  const R_FLESH = 0.008;
  const gapOf = (b, side) => {
    const m = b.matrixWorld.elements;
    const e = inv.elements;
    const vx = m[12], vy = m[13], vz = m[14];
    const px = e[0]*vx + e[4]*vy + e[8]*vz + e[12];
    const py = e[1]*vx + e[5]*vy + e[9]*vz + e[13];
    const pz = e[2]*vx + e[6]*vy + e[10]*vz + e[14];
    const sgn = side === 'R' ? 1 : -1;
    const c = [sgn * Math.abs(spec.hoodR[0]), spec.hoodR[1], spec.hoodR[2]];
    const d0 = [sgn * spec.hoodDir[0], spec.hoodDir[1], spec.hoodDir[2]];
    const dl = Math.hypot(d0[0], d0[1], d0[2]);
    const d = [d0[0]/dl, d0[1]/dl, d0[2]/dl];
    const v = [px - c[0], py - c[1], pz - c[2]];
    const t = Math.max(-0.025, Math.min(0.045, v[0]*d[0] + v[1]*d[1] + v[2]*d[2]));
    const perp = [v[0] - t*d[0], v[1] - t*d[1], v[2] - t*d[2]];
    return Math.hypot(perp[0], perp[1], perp[2]) - spec.hoodRad - R_FLESH;
  };
  let loss = 0;
  const detail = {};
  for (const side of ['L', 'R']) {
    const g = (nm) => { const b = rig.getObjectByName(nm + side); return b ? gapOf(b, side) : null; };
    let mids = [], tips = [], metas = [], pens = [];
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
      for (const i of [2, 3, 4]) {
        const gg = g(f + i);
        if (gg === null) continue;
        if (gg < 0) pens.push(-gg);
        if (i === 3) mids.push(gg);
        if (i === 4) tips.push(gg);
      }
      const g1 = g(f + '1');
      if (g1 !== null) metas.push(g1);
    }
    const palm = metas.reduce((s, x) => s + x, 0) / Math.max(1, metas.length) - 0.004;
    for (const pen of pens) loss += 30 * pen * pen * 1e6;
    for (const m of mids) loss += (m - 0.002) * (m - 0.002) * 1e6;
    for (const t of tips) loss += 0.5 * (t - 0.003) * (t - 0.003) * 1e6;
    loss += 4 * (palm - 0.004) * (palm - 0.004) * 1e6;
    detail[side] = {
      pen: Math.max(0, ...pens, 0),
      mids: mids.map((x) => Math.round(x * 1000)),
      tips: tips.map((x) => Math.round(x * 1000)),
      palm: Math.round(palm * 1000),
    };
  }
  return { loss, detail };
})`;

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
  await page.waitForFunction(() => !!(window as any).__laasDbg?.riderGrip?.applyPose, undefined, {
    timeout: 30_000, polling: 250,
  });

  const evalLoss = async (p: Record<string, number>): Promise<{ loss: number; detail: unknown }> =>
    (await page.evaluate(`${MEASURE}(${JSON.stringify(p)})`)) as { loss: number; detail: unknown };

  let cur = { ...START };
  let best = await evalLoss(cur);
  console.log(`[opt] start loss=${best.loss.toFixed(0)} ${JSON.stringify(best.detail)}`);
  const keys = Object.keys(STEPS0) as (keyof typeof STEPS0)[];
  let steps = { ...STEPS0 };
  for (let round = 0; round < 4; round++) {
    for (const k of keys) {
      for (const dir of [1, -1]) {
        const trial = { ...cur, [k]: Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], cur[k] + dir * steps[k])) };
        if (trial[k] === cur[k]) continue;
        const r = await evalLoss(trial);
        if (r.loss < best.loss) { cur = trial; best = r; }
      }
    }
    console.log(`[opt] round ${round}: loss=${best.loss.toFixed(0)} params=${JSON.stringify(cur)}`);
    for (const k of keys) steps[k] /= 2;
  }
  console.log(`[opt] BEST loss=${best.loss.toFixed(0)}`);
  console.log(`[opt] detail=${JSON.stringify(best.detail)}`);
  console.log(`[opt] PASTE INTO DEFAULT_POSE: ${JSON.stringify(cur)}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
