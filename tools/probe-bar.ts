/**
 * probe-bar — dump the vertical/fore-aft LAYERING of hand vs bar tube, root
 * space (mm). Answers: is the palm ABOVE / AT / BELOW the bar it clips, and
 * do the fingers penetrate the drop tube. Drives the anti-clip fix by
 * geometry, not by the phantom hood capsule.
 *
 * LAAS_PORT=5174 npx tsx tools/probe-bar.ts
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
    return [e[0]*vx+e[4]*vy+e[8]*vz+e[12], e[1]*vx+e[5]*vy+e[9]*vz+e[13], e[2]*vx+e[6]*vy+e[10]*vz+e[14]];
  };
  rg.reset();
  rg.applyPose({ handAlong: 0.0525, palmPad: 0.004, curl: 0.5, curlTip: 0.85, twist: 0.15, pitch: 0.08 });
  const names = ['Wrist','Index2','Index4','Middle2','Middle3','Middle4','Ring2','Pinky2','Thumb2','Thumb3'];
  const out = {};
  for (const side of ['L','R']) for (const nm of names) out[nm+side] = grab(nm+side);
  return { out, spec };
})()`;

type V = number[];
const sub = (a: V, b: V): V => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot = (a: V, b: V): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const R_FLESH = 0.008;
function segGap(p: V, a: V, b: V, rad: number): number {
  const ab = sub(b, a); const len2 = dot(ab, ab) || 1;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  const q = [a[0]+t*ab[0], a[1]+t*ab[1], a[2]+t*ab[2]];
  return Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]) - rad - R_FLESH;
}

async function main(): Promise<void> {
  const { browser } = await launchWebGPUReal();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(`${ORIGIN}/?scene=world&seed=1&T=11&preset=high&hud=0&dash=0&ridedev=1&road=asphalt,0.1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__laas && ((window as any).__laas.ready || (window as any).__laas.error !== null), undefined, { timeout: 600_000, polling: 500 });
  await page.waitForFunction(() => !!(window as any).__laasDbg?.riderGrip?.reset, undefined, { timeout: 30_000, polling: 250 });
  const r = (await page.evaluate(DUMP)) as { out: Record<string, V | null>; spec: any };
  await browser.close();
  const { spec } = r;
  for (const side of ['L', 'R'] as const) {
    const sgn = side === 'R' ? 1 : -1;
    const mir = (p: V): V => [sgn * p[0], p[1], p[2]];
    const drop: V[] = (spec.dropPts as V[]).map(mir);
    const hoodC: V = [sgn * Math.abs(spec.hoodR[0]), spec.hoodR[1], spec.hoodR[2]];
    console.log(`\n===== ${side} (y=height, z=fore/aft, mm; barR=${(spec.barR*1000).toFixed(0)} +flesh8) =====`);
    console.log('bar drop pts (bend→drop):');
    drop.forEach((p, i) => console.log(`  d${i}: y=${(p[1]*1000).toFixed(0)} z=${(p[2]*1000).toFixed(0)}`));
    console.log(`hood: y=${(hoodC[1]*1000).toFixed(0)} z=${(hoodC[2]*1000).toFixed(0)}`);
    const g = (nm: string): V | null => r.out[nm + side] ?? null;
    for (const nm of ['Wrist', 'Middle2', 'Middle3', 'Middle4', 'Index4', 'Pinky2', 'Thumb3']) {
      const p = g(nm); if (!p) continue;
      let md = Infinity;
      for (let i = 0; i + 1 < drop.length; i++) md = Math.min(md, segGap(p, drop[i] as V, drop[i+1] as V, spec.barR));
      const flag = md < -0.002 ? '  <<< INSIDE BAR' : '';
      console.log(`${nm.padEnd(8)} y=${(p[1]*1000).toFixed(0)} z=${(p[2]*1000).toFixed(0)}  gapToDrop=${(md*1000).toFixed(0)}mm${flag}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
