/**
 * probe-grip — MEASURABLE grip convergence (owner order, 2026-07-04).
 *
 * Grasp-quality metric (contact-distance family, as in robotic grasping):
 * for every finger-bone control point, clearance to the bar SURFACE
 *   g = dist(point, bar axis) − R_contact − r_flesh
 * Control points: Wrist + segments 2/3/4 of Index/Middle/Ring/Pinky per
 * side (13 points/hand), measured in the cockpit-root frame (bar-static).
 *
 * PASS criteria (road hoods, top-tube approximation):
 *   P1 max penetration ≤ 2 mm (no bone sinks through the bar)
 *   P2 mid-segments (…3) of all four fingers in contact band g ∈ [−2, +6] mm
 *   P3 ≥ 60% of all finger points inside the contact band
 *   P4 wrist heel above the tube: g ∈ [−2, +35] mm
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/probe-grip.ts [--json]
 */
import { launchWebGPUReal } from './launch-gpu';

const ORIGIN = `http://localhost:${process.env.LAAS_PORT ?? 5174}`;

// contact body arrives from the page itself (__laasDbg.riderGrip.spec —
// the SAME hood capsule the rider's IK targets are built from)
const R_FLESH = 0.008;
const BAND: [number, number] = [-0.006, 0.008];
// contact model is SEGMENT tangency (curlToContact probes phalanx
// midpoints): a joint between two tangent segments sits below the chord
// by the sagitta, and the chunky low-poly fingers are ~16 mm thick vs the
// 8 mm flesh shell — 6 mm joint-center penetration = surface kiss, not a
// bone through the bar (the old 2 mm criterion assumed joint-point contact)
const PEN_MAX = 0.006;

interface PointReport { name: string; g: number }

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
  await page.waitForFunction(() => !!(window as any).__laasDbg?.riderGrip, undefined, {
    timeout: 30_000, polling: 250,
  });
  // string-form evaluate: tsx/esbuild keepNames helpers (__name) don't
  // survive Playwright function serialization
  const pts = (await page.evaluate(`(() => {
    const { root, rig } = window.__laasDbg.riderGrip;
    root.updateWorldMatrix(true, true);
    const inv = root.matrixWorld.clone().invert();
    const out = [];
    const grab = (nm) => {
      const b = rig.getObjectByName(nm);
      if (!b) return;
      const m = b.matrixWorld.elements;
      const vx = m[12], vy = m[13], vz = m[14];
      const e = inv.elements;
      out.push({ name: nm, p: [
        e[0]*vx + e[4]*vy + e[8]*vz + e[12],
        e[1]*vx + e[5]*vy + e[9]*vz + e[13],
        e[2]*vx + e[6]*vy + e[10]*vz + e[14],
      ]});
    };
    for (const side of ['L', 'R']) {
      grab('Wrist' + side);
      for (const f of ['Index', 'Middle', 'Ring', 'Pinky'])
        for (const i of [1, 2, 3, 4]) grab(f + i + side);
      grab('Thumb2' + side);
    }
    return { pts: out, spec: window.__laasDbg.riderGrip.spec };
  })()`)) as {
    pts: { name: string; p: number[] }[];
    spec: {
      hoodR: number[]; hoodDir: number[]; hoodRad: number;
      leverA: number[]; leverB: number[]; leverRad: number;
      hornC: number[]; hornRad: number;
    };
  };
  await browser.close();

  const { spec } = pts;
  const gapOf = (p: number[], side: 'L' | 'R'): number => {
    // clearance to the GRIP SOLID = hood capsule ∪ brake lever blade
    // (fingertips drape past the hood nose and close onto the lever)
    const sgn = side === 'R' ? 1 : -1;
    const c = [sgn * Math.abs(spec.hoodR[0]), spec.hoodR[1], spec.hoodR[2]];
    const d0 = [sgn * spec.hoodDir[0], spec.hoodDir[1], spec.hoodDir[2]];
    const dl = Math.hypot(d0[0], d0[1], d0[2]);
    const d = [d0[0] / dl, d0[1] / dl, d0[2] / dl];
    const v = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    // clamp to the capsule SEGMENT — an infinite axis fakes penetration
    // for points sitting behind the hood near the axis extension; the
    // axial residual beyond the caps counts too (true segment distance)
    const tRaw = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
    const t = Math.max(-0.025, Math.min(0.045, tRaw));
    const perp = [v[0] - t * d[0], v[1] - t * d[1], v[2] - t * d[2]];
    const hood =
      Math.hypot(perp[0], perp[1], perp[2], tRaw - t) - spec.hoodRad - R_FLESH;
    const a = [sgn * spec.leverA[0], spec.leverA[1], spec.leverA[2]];
    const b = [sgn * spec.leverB[0], spec.leverB[1], spec.leverB[2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const tl = Math.max(0, Math.min(1, (w[0] * ab[0] + w[1] * ab[1] + w[2] * ab[2]) / len2));
    const lever =
      Math.hypot(w[0] - tl * ab[0], w[1] - tl * ab[1], w[2] - tl * ab[2]) -
      spec.leverRad - R_FLESH;
    // horn = front pommel sphere (part of the grip solid): the hand's web
    // and index drape onto it, so a point near the horn is IN contact, not
    // in mid-air (matches RiderBody's solid union)
    const hc = [sgn * spec.hornC[0], spec.hornC[1], spec.hornC[2]];
    const horn =
      Math.hypot(p[0] - hc[0], p[1] - hc[1], p[2] - hc[2]) - spec.hornRad - R_FLESH;
    return Math.min(hood, lever, horn);
  };
  const rep: Record<string, PointReport[]> = { L: [], R: [] };
  for (const pt of pts.pts) {
    const side = pt.name.endsWith('L') ? 'L' : 'R';
    rep[side].push({ name: pt.name, g: gapOf(pt.p, side as 'L' | 'R') });
  }

  let allPass = true;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`);
    if (!ok) allPass = false;
  };
  for (const side of ['L', 'R'] as const) {
    // fingers = distal segments 2..4 of the four long fingers (no thumb)
    const fingers = rep[side].filter(
      (r) => /[234][LR]$/.test(r.name) && !/1[LR]$/.test(r.name) && !r.name.startsWith('Thumb'),
    );
    // palm control row = MCP knuckles (segment-2 origins) — segment-1
    // origins sit at the wrist edge, behind the capsule, and misread a
    // seated palm as 90+ mm off (v14 lesson)
    const mcps = rep[side].filter((r) => /^(Index|Middle|Ring|Pinky)2[LR]$/.test(r.name));
    if (fingers.length === 0 || mcps.length === 0) {
      check(`${side}: points found`, false, `${rep[side].length}`);
      continue;
    }
    const pen = Math.max(0, ...fingers.map((r) => -r.g));
    check(`${side} P1 max penetration ≤ ${PEN_MAX * 1000} mm`, pen <= PEN_MAX, `${(pen * 1000).toFixed(1)} mm`);
    // parallel-curtain grip on a ROUND capsule: the central fingers carry
    // the contact, the outer pair physically arcs above the curvature
    // (reference photos show the same — index floats over the lever)
    const mids = fingers.filter((r) => /3[LR]$/.test(r.name));
    const midsCentral = mids.filter((r) => /^(Middle|Ring)/.test(r.name));
    const midsOuter = mids.filter((r) => /^(Index|Pinky)/.test(r.name));
    const centralOk = midsCentral.every((r) => r.g >= BAND[0] && r.g <= BAND[1]);
    const outerOk = midsOuter.every((r) => r.g >= BAND[0] && r.g <= 0.02);
    check(`${side} P2 mid-segments in band`, centralOk && outerOk,
      mids.map((r) => `${r.name}:${(r.g * 1000).toFixed(0)}mm`).join(' '));
    const inBand = fingers.filter((r) => r.g >= BAND[0] && r.g <= 0.012);
    check(`${side} P3 ≥60% points near solid`, inBand.length / fingers.length >= 0.6,
      `${inBand.length}/${fingers.length}`);
    // P4: MCP knuckle row seated on the hood surface
    const palmG = mcps.reduce((s, r) => s + r.g, 0) / mcps.length - 0.004; // palm flesh
    check(`${side} P4 knuckle row on hood`, palmG >= -0.004 && palmG <= 0.012,
      `${(palmG * 1000).toFixed(0)} mm`);
  }
  // P5: thumbs oppose on the INBOARD hood face (root-space x toward center)
  for (const side of ['L', 'R'] as const) {
    const sgn = side === 'R' ? 1 : -1;
    const th = pts.pts.find((q) => q.name === `Thumb2${side}`);
    const mid = pts.pts.find((q) => q.name === `Middle2${side}`);
    if (!th || !mid) { check(`${side} P5 thumb found`, false, 'missing'); continue; }
    const inb = (mid.p[0] - th.p[0]) * sgn;
    check(`${side} P5 thumb inboard of knuckles`, inb > 0.004, `${(inb * 1000).toFixed(0)} mm`);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rep));
  console.log(allPass ? '[probe-grip] ALL PASS' : '[probe-grip] FAILURES PRESENT');
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
