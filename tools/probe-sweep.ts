/**
 * probe-sweep — one-boot live sweep of the seat knobs (seatAlong × seatLift)
 * for the road-hood grip, measuring per combo (worst of L/R):
 *   pen      max finger penetration into the solid (hood∪lever∪horn), mm
 *   seat     knuckle-row (MCP) mean clearance to the hood − 4mm palm, mm
 *   proud    horn TOP y − highest hand-joint y (mm; ≤0 = covered)
 *   near     closest hand joint to the horn sphere surface (mm; small = touches)
 *   idx4H    index fingertip clearance to the horn (mm)
 * Goal: pick the combo that COVERS/EMBRACES the horn (proud ≤ ~2, near ≤ ~6)
 * while keeping pen ≤ 6 and seat ∈ [−4,12] (probe-grip P1/P4 stay green).
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/probe-sweep.ts
 */
import { launchWebGPUReal } from './launch-gpu';

const ORIGIN = `http://localhost:${process.env.LAAS_PORT ?? 5174}`;

const ALONGS = [-0.005, 0.005, 0.015, 0.025, 0.035];
const LIFTS = [0, 0.008, 0.016, 0.024];

const SWEEP = `((alongs, lifts) => {
  const rg = window.__laasDbg.riderGrip;
  const { root, rig, spec } = rg;
  const base = { handAlong: 0.0525, palmPad: 0.004, curl: 0.15,
    curlTip: 0.85, twist: 0.15, pitch: 0.08 };
  const R_FLESH = 0.008;
  const grab = (nm, inv) => {
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
  const nrm = (a) => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; };
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const hoodGap = (p,c,ax,rad) => {
    const v = sub(p,c); const tRaw = dot(v,ax);
    const t = Math.max(-0.025, Math.min(0.045, tRaw));
    const perp = [v[0]-t*ax[0], v[1]-t*ax[1], v[2]-t*ax[2]];
    return Math.hypot(perp[0],perp[1],perp[2], tRaw-t) - rad - R_FLESH;
  };
  const segGap = (p,a,b,rad) => {
    const ab = sub(b,a); const len2 = dot(ab,ab)||1;
    const t = Math.max(0, Math.min(1, dot(sub(p,a),ab)/len2));
    const q = [a[0]+t*ab[0], a[1]+t*ab[1], a[2]+t*ab[2]];
    return Math.hypot(p[0]-q[0],p[1]-q[1],p[2]-q[2]) - rad - R_FLESH;
  };
  const rows = [];
  for (const along of alongs) for (const lift of lifts) {
    rg.applyPose(Object.assign({}, base, { seatAlong: along, seatLift: lift }));
    root.updateWorldMatrix(true, true);
    const inv = root.matrixWorld.clone().invert();
    let pen = 0, seatSum = 0, seatN = 0, proud = -1e9, near = 1e9, idx4H = 1e9;
    for (const side of ['L','R']) {
      const sgn = side === 'R' ? 1 : -1;
      const hoodC = [sgn*Math.abs(spec.hoodR[0]), spec.hoodR[1], spec.hoodR[2]];
      const ax = nrm([sgn*spec.hoodDir[0], spec.hoodDir[1], spec.hoodDir[2]]);
      const lA = [sgn*spec.leverA[0], spec.leverA[1], spec.leverA[2]];
      const lB = [sgn*spec.leverB[0], spec.leverB[1], spec.leverB[2]];
      const hC = [sgn*spec.hornC[0], spec.hornC[1], spec.hornC[2]];
      const gh = (p) => segGap(p, hC, hC, spec.hornRad);
      const gsolid = (p) => Math.min(hoodGap(p,hoodC,ax,spec.hoodRad), segGap(p,lA,lB,spec.leverRad), gh(p));
      // penetration over finger seg 2/3/4
      for (const f of ['Index','Middle','Ring','Pinky']) for (const i of [2,3,4]) {
        const p = grab(f+i+side, inv); if (!p) continue;
        pen = Math.max(pen, -gsolid(p));
      }
      // knuckle seat (MCP row) to hood
      for (const f of ['Index','Middle','Ring','Pinky']) {
        const p = grab(f+'2'+side, inv); if (!p) continue;
        seatSum += hoodGap(p,hoodC,ax,spec.hoodRad); seatN++;
      }
      // horn proud vs highest hand joint; nearest hand joint to horn
      const joints = ['Wrist','Index1','Index2','Index3','Index4','Middle2','Middle3','Ring2','Pinky2','Thumb1','Thumb2','Thumb3'];
      let maxY = -1e9;
      for (const nm of joints) { const p = grab(nm+side, inv); if (!p) continue; if (p[1]>maxY) maxY=p[1]; near = Math.min(near, gh(p)); }
      proud = Math.max(proud, (hC[1]+spec.hornRad) - maxY);
      const it = grab('Index4'+side, inv); if (it) idx4H = Math.min(idx4H, gh(it));
    }
    rows.push({ along, lift, pen: pen*1000, seat: (seatSum/seatN-0.004)*1000, proud: proud*1000, near: near*1000, idx4H: idx4H*1000 });
  }
  return rows;
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
  await page.waitForFunction(() => !!(window as any).__laasDbg?.riderGrip?.reset, undefined, {
    timeout: 30_000, polling: 250,
  });
  const rows = (await page.evaluate(`(${SWEEP})(${JSON.stringify(ALONGS)}, ${JSON.stringify(LIFTS)})`)) as {
    along: number; lift: number; pen: number; seat: number; proud: number; near: number; idx4H: number;
  }[];
  await browser.close();
  console.log('along  lift  | pen  seat proud near idx4H  | verdict');
  console.log('-------------|------------------------------|--------');
  for (const r of rows) {
    const ok = r.pen <= 6 && r.seat >= -4 && r.seat <= 12;
    const covers = r.proud <= 2 || r.near <= 6;
    const tag = !ok ? 'BREAKS P1/P4' : covers ? '<< COVERS + PASS' : 'ok, horn proud';
    console.log(
      `${r.along.toFixed(3)} ${r.lift.toFixed(3)} | ` +
      `${r.pen.toFixed(1).padStart(4)} ${r.seat.toFixed(0).padStart(4)} ${r.proud.toFixed(0).padStart(5)} ${r.near.toFixed(0).padStart(4)} ${r.idx4H.toFixed(0).padStart(5)}  | ${tag}`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
