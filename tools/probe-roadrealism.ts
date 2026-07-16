/**
 * Road REALISM gate — "would anyone but a madman ride this in the Alps?"
 *
 * Owner directive (2026-07-16): hard gates on unrealistic generated roads.
 *   1. High-frequency zigzag ("wiggling") roads — banned. Legit alpine
 *      serpentines (low frequency, big heading change per bend, sane radius)
 *      must NOT be flagged.
 *   2. Sustained over-grade: more than 18% held for more than 10 m = red,
 *      no exemptions (a ford approach at 20% is exactly as unridable as any
 *      other 20% ramp). Per-class stricter tiers below.
 *   3. General passability: minimum turn radius per class, rideable
 *      cross-slope on the tread.
 *
 * All metrics come from the FINAL route polylines (RoadRoute.pts — the same
 * profile the carve stamps and the bike rides) plus the carved CPU
 * heightfield for cross-slope. Thresholds are grounded in real-world numbers
 * (alpine pass ramps, road design standards, IMBA trail guidance) —
 * see docs/ROAD_REALISM_GATES.md for sources.
 *
 * Usage:
 *   npx tsx tools/probe-roadrealism.ts --seeds 1,2,3
 *   npx tsx tools/probe-roadrealism.ts --seeds 1,2,3,4,5,6,7,8 --report
 *     (--report = measure & print stats only, always exit 0 — threshold tuning)
 *   npx tsx tools/probe-roadrealism.ts --seeds 1 --out shots/wip/roadrealism.json
 * Env:  LAAS_PORT (dev server port, default 5174)
 * Exit: 0 = all seeds clean, 1 = violations over budget / boot failure.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import {
  CLASS_SUSTAINED_LEN_M,
  CLASS_SUSTAINED_MARGIN,
  OWNER_SUSTAINED_LAW,
  realismLaw,
  WIGGLE_GRADE_EXEMPT_GATE,
  type RealismLaw,
} from '../src/ride/RoadRealismLaw';
import { SurfaceId } from '../src/ride/SurfaceMatrix';

// ---------------- thresholds ---------------------------------------------------
//
// Sustained grade tiers per class: a run of consecutive polyline segments
// whose grade exceeds `gradePct` and whose total arclength exceeds `lenM`
// is a violation. Tier 1 is the owner law (18% / 10 m, universal — every
// class, no ford exemption). Tier 2 catches the generator breaking its own
// class design grade for a sustained stretch: gradePct = class maxGrade
// × 1.08 (quantization margin, probe-roads convention), held over 50 m —
// computed from the route's own class spec at runtime, so it tracks
// ROAD_CLASSES changes automatically.
//
// Real-world anchors (docs/ROAD_REALISM_GATES.md):
//   - paved alpine passes: averages 6–9%, sustained maxima 10–14%
//     (Stelvio max ~11%, Grossglockner ~11%, Mortirolo steepest 500 m =
//     15.8%); >18% never lasts beyond ~500 m even on record freak climbs
//     (Zoncolan steepest 500 m = 18.2%)
//   - Swiss alpine access roads (Bern LANAT 2023): max 12%, short
//     stretches 15%, summer-only exceptional 15–18%
//   - IMBA/BLM: singletrack max sustainable 15–20%; steep pitches >15%
//     only for short distances (~10–15 m) — the owner 18%/10 m law is
//     exactly the hike-a-bike line
interface SustainedTier {
  name: string;
  gradePct: number;
  lenM: number;
}
/** grade epsilon (percent points) absorbing float/resample noise at the limit */
const GRADE_EPS_PCT = 0.3;

const OWNER_TIER: SustainedTier = {
  name: `owner-${OWNER_SUSTAINED_LAW.gradePct}/${OWNER_SUSTAINED_LAW.lenM}`,
  gradePct: OWNER_SUSTAINED_LAW.gradePct,
  lenM: OWNER_SUSTAINED_LAW.lenM,
};

// Wiggle / radius / cross-slope thresholds are SHARED with the generator's
// anti-zigzag pass via src/ride/RoadRealismLaw.ts — the law cannot drift
// from what RoadNetwork enforces.
const NAME_TO_ID: Readonly<Record<string, SurfaceId>> = {
  asphalt: SurfaceId.Asphalt,
  'gravel-fine': SurfaceId.GravelFine,
  'gravel-coarse': SurfaceId.GravelCoarse,
  'dirt-road': SurfaceId.DirtRoad,
  singletrack: SurfaceId.Singletrack,
};
function lawOf(clsName: string): RealismLaw | null {
  const id = NAME_TO_ID[clsName];
  return id === undefined ? null : realismLaw(id);
}

/** violations allowed per seed per kind before the gate goes red */
const BUDGET: Readonly<Record<string, number>> = {
  'sustained-grade': 0,
  wiggle: 0,
  'min-radius': 0,
  'cross-slope': 0,
};

/** junction-mask extra radius beyond the two halfWidths (probe-roads family) */
const JUNCTION_MASK_M = 34;
/** cross-slope samples this close (m, along s) to a ford are the ford ramp */
const CROSS_FORD_EXEMPT_M = 30;
/** lateral fraction of halfWidth where cross-slope is measured (inside tread) */
const CROSS_AT_FRAC = 0.6;

// ---------------- CLI ----------------------------------------------------------

interface Args {
  [k: string]: string | boolean;
}
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith('--')) {
      out[k] = n;
      i++;
    } else out[k] = true;
  }
  return out;
}
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

// ---------------- dump ----------------------------------------------------------

interface DumpPt {
  x: number;
  z: number;
  y: number;
  s: number;
  ford: boolean;
  /** carved ground at ±CROSS_AT_FRAC·halfW lateral offsets */
  hL: number;
  hR: number;
}
interface DumpRoute {
  name: string;
  clsName: string;
  maxGrade: number;
  halfWidth: number;
  length: number;
  pts: DumpPt[];
}

async function dumpSeed(page: Page, seed: number): Promise<DumpRoute[]> {
  const t0 = Date.now();
  await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=${seed}&T=12&hud=0&freeze=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(`seed ${seed}: app reported fatal error:\n${bootErr}`);
  console.log(`[boot] seed ${seed} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dump = (await page.evaluate(
    ({ FRAC }) => {
      (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
      const hf = (
        window as unknown as { __laasDbg?: { engine?: { heightfield?: unknown } } }
      ).__laasDbg?.engine?.heightfield as {
        heightAtCpu(x: number, z: number): number;
        roads: {
          routes: {
            name: string;
            cls: { name: string; maxGrade: number; halfWidth: number };
            length: number;
            pts: { x: number; z: number; y: number; ford: boolean; s: number }[];
          }[];
        } | null;
      };
      if (!hf.roads) return null;
      return hf.roads.routes.map((r) => {
        const hw = r.cls.halfWidth;
        const pts = r.pts.map((p, i) => {
          const a = r.pts[Math.max(0, i - 1)];
          const b = r.pts[Math.min(r.pts.length - 1, i + 1)];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const L = Math.hypot(dx, dz) || 1;
          const nx = -dz / L;
          const nz = dx / L;
          return {
            x: p.x,
            z: p.z,
            y: p.y,
            s: p.s,
            ford: p.ford,
            hL: hf.heightAtCpu(p.x - nx * hw * FRAC, p.z - nz * hw * FRAC),
            hR: hf.heightAtCpu(p.x + nx * hw * FRAC, p.z + nz * hw * FRAC),
          };
        });
        return {
          name: r.name,
          clsName: r.cls.name,
          maxGrade: r.cls.maxGrade,
          halfWidth: hw,
          length: r.length,
          pts,
        };
      });
    },
    { FRAC: CROSS_AT_FRAC },
  )) as DumpRoute[] | null;
  if (!dump || dump.length === 0) throw new Error(`seed ${seed}: hf.roads null/empty`);
  return dump;
}

// ---------------- metrics --------------------------------------------------------

interface Violation {
  route: string;
  cls: string;
  kind: string;
  s0: number;
  s1: number;
  x: number;
  z: number;
  /** road profile elevation at the worst point (m) */
  y: number;
  /** ready-made shoot.ts --cam string aimed at the defect */
  cam: string;
  detail: string;
}

/** shoot.ts camera aimed at (tx,ty,tz) from an oblique NE offset sized to
 *  frame `span` m of road (find-spot pose convention) */
function mkCam(tx: number, ty: number, tz: number, span: number): string {
  const dH = Math.max(60, span * 0.75) * 0.707;
  const ex = tx + dH;
  const ez = tz + dH;
  const ey = ty + Math.max(40, span * 0.45);
  const dx = tx - ex;
  const dy = ty - ey;
  const dz = tz - ez;
  const len = Math.hypot(dx, dy, dz) || 1;
  const yaw = Math.atan2(-dx / len, -dz / len);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
  return `${ex.toFixed(1)},${ey.toFixed(1)},${ez.toFixed(1)},${yaw.toFixed(4)},${pitch.toFixed(4)},55`;
}

interface Bend {
  sign: number;
  totalDeg: number;
  apexS: number;
  apexX: number;
  apexZ: number;
  apexY: number;
  i0: number;
  i1: number;
}

/** signed turn at interior vertex i (deg; + = left) */
function signedTurnDeg(pts: DumpPt[], i: number): number {
  const a = pts[i - 1] as DumpPt;
  const b = pts[i] as DumpPt;
  const c = pts[i + 1] as DumpPt;
  const d1x = b.x - a.x;
  const d1z = b.z - a.z;
  const d2x = c.x - b.x;
  const d2z = c.z - b.z;
  const dot = d1x * d2x + d1z * d2z;
  const cross = d1x * d2z - d1z * d2x;
  const l = Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) || 1;
  const ang = (Math.acos(Math.min(Math.max(dot / l, -1), 1)) * 180) / Math.PI;
  return cross >= 0 ? ang : -ang;
}

/** group consecutive same-sign significant turns into bend events */
function collectBends(pts: DumpPt[], noiseDeg: number): Bend[] {
  const bends: Bend[] = [];
  let cur: Bend | null = null;
  let apexAbs = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const t = signedTurnDeg(pts, i);
    const sign = t >= 0 ? 1 : -1;
    if (Math.abs(t) < noiseDeg) continue;
    const p = pts[i] as DumpPt;
    if (cur && cur.sign === sign && i - cur.i1 <= 2) {
      cur.totalDeg += Math.abs(t);
      cur.i1 = i;
      if (Math.abs(t) > apexAbs) {
        apexAbs = Math.abs(t);
        cur.apexS = p.s;
        cur.apexX = p.x;
        cur.apexZ = p.z;
        cur.apexY = p.y;
      }
    } else {
      if (cur) bends.push(cur);
      cur = { sign, totalDeg: Math.abs(t), apexS: p.s, apexX: p.x, apexZ: p.z, apexY: p.y, i0: i, i1: i };
      apexAbs = Math.abs(t);
    }
  }
  if (cur) bends.push(cur);
  return bends;
}

/** max perpendicular deviation of the polyline from the chord [i0..i1] */
function chordAmplitude(pts: DumpPt[], i0: number, i1: number): number {
  const A = pts[i0] as DumpPt;
  const B = pts[i1] as DumpPt;
  const abx = B.x - A.x;
  const abz = B.z - A.z;
  const len = Math.hypot(abx, abz) || 1;
  let amp = 0;
  for (let i = i0 + 1; i < i1; i++) {
    const p = pts[i] as DumpPt;
    const d = Math.abs(((p.x - A.x) * abz - (p.z - A.z) * abx) / len);
    if (d > amp) amp = d;
  }
  return amp;
}

interface RouteStats {
  cls: string;
  km: number;
  maxGradePct: number;
  maxSustained18M: number;
  bendCount: number;
  minRadiusM: number;
  maxCrossPct: number;
}

function analyzeRoute(
  r: DumpRoute,
  junction: (x: number, z: number) => boolean,
): { viols: Violation[]; stats: RouteStats } {
  const spec = lawOf(r.clsName);
  const viols: Violation[] = [];
  const pts = r.pts;
  const stats: RouteStats = {
    cls: r.clsName,
    km: r.length / 1000,
    maxGradePct: 0,
    maxSustained18M: 0,
    bendCount: 0,
    minRadiusM: Infinity,
    maxCrossPct: 0,
  };
  if (!spec || pts.length < 3) return { viols, stats };

  // ---- sustained grade (owner #2) — NO exemptions, ford runs annotated ------
  const segGrade: number[] = [];
  const segLen: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i] as DumpPt;
    const q = pts[i + 1] as DumpPt;
    const ds = Math.max(Math.hypot(q.x - p.x, q.z - p.z), 1e-3);
    const g = (Math.abs(q.y - p.y) / ds) * 100;
    segGrade.push(g);
    segLen.push(ds);
    if (g > stats.maxGradePct) stats.maxGradePct = g;
  }
  const tiers: SustainedTier[] = [
    OWNER_TIER,
    {
      name: `class-limit/${CLASS_SUSTAINED_LEN_M}m`,
      gradePct: r.maxGrade * 100 * CLASS_SUSTAINED_MARGIN,
      lenM: CLASS_SUSTAINED_LEN_M,
    },
  ];
  for (const tier of tiers) {
    const lim = tier.gradePct + GRADE_EPS_PCT;
    let i = 0;
    while (i < segGrade.length) {
      if ((segGrade[i] as number) <= lim) {
        i++;
        continue;
      }
      let j = i;
      let runLen = 0;
      let worst = 0;
      let fords = 0;
      while (j < segGrade.length && (segGrade[j] as number) > lim) {
        runLen += segLen[j] as number;
        worst = Math.max(worst, segGrade[j] as number);
        if ((pts[j] as DumpPt).ford || (pts[j + 1] as DumpPt).ford) fords++;
        j++;
      }
      if (tier.name === OWNER_TIER.name) {
        stats.maxSustained18M = Math.max(stats.maxSustained18M, runLen);
      }
      if (runLen > tier.lenM) {
        const a = pts[i] as DumpPt;
        const b = pts[Math.min(j, pts.length - 1)] as DumpPt;
        const m = pts[Math.min(Math.floor((i + j) / 2), pts.length - 1)] as DumpPt;
        viols.push({
          route: r.name,
          cls: r.clsName,
          kind: 'sustained-grade',
          s0: a.s,
          s1: b.s,
          x: a.x,
          z: a.z,
          y: a.y,
          cam: mkCam(m.x, m.y, m.z, runLen),
          detail:
            `${tier.name}: ${runLen.toFixed(0)} m over ${tier.gradePct}% ` +
            `(worst ${worst.toFixed(1)}%)${fords > 0 ? ` [${fords} ford seg(s)]` : ''}`,
        });
      }
      i = j;
    }
  }

  // ---- wiggle (owner #1) ------------------------------------------------------
  const w = spec.wiggle;
  const bends = collectBends(pts, w.noiseDeg).filter((b) => b.totalDeg >= w.minBendDeg);
  stats.bendCount = bends.length;
  let chain: Bend[] = [];
  let gradeExemptChains = 0;
  const flushChain = (): void => {
    const meanDeg = chain.length
      ? chain.reduce((a, b) => a + b.totalDeg, 0) / chain.length
      : 0;
    if (chain.length >= w.minBends && meanDeg >= w.minChainMeanDeg) {
      // serpentine-tacking exemption (RoadRealismLaw): grade-forced chains
      const cFirst = chain[0] as Bend;
      const cLast = chain[chain.length - 1] as Bend;
      const spanArc = Math.max(
        (pts[cLast.i1] as DumpPt).s - (pts[cFirst.i0] as DumpPt).s,
        1,
      );
      const chainGrade =
        Math.abs((pts[cLast.i1] as DumpPt).y - (pts[cFirst.i0] as DumpPt).y) / spanArc;
      if (chainGrade >= (r.maxGrade * WIGGLE_GRADE_EXEMPT_GATE)) {
        gradeExemptChains++;
        chain = [];
        return;
      }
    }
    if (chain.length >= w.minBends && meanDeg >= w.minChainMeanDeg) {
      const first = chain[0] as Bend;
      const last = chain[chain.length - 1] as Bend;
      const spanM = Math.max(last.apexS - first.apexS, 1);
      const amp = chordAmplitude(pts, first.i0, last.i1);
      const freq = ((chain.length - 1) / spanM) * 100;
      const mid = chain[Math.floor(chain.length / 2)] as Bend;
      viols.push({
        route: r.name,
        cls: r.clsName,
        kind: 'wiggle',
        s0: first.apexS,
        s1: last.apexS,
        x: first.apexX,
        z: first.apexZ,
        y: first.apexY,
        cam: mkCam(mid.apexX, mid.apexY, mid.apexZ, spanM),
        detail:
          `${chain.length} alternating bends over ${spanM.toFixed(0)} m ` +
          `(${freq.toFixed(1)} reversals/100m, mean ${meanDeg.toFixed(0)}deg, amp ${amp.toFixed(1)} m, ` +
          `bends ${chain.map((b) => (b.sign > 0 ? '+' : '-') + b.totalDeg.toFixed(0)).join('/')}deg)`,
      });
    }
    chain = [];
  };
  for (const b of bends) {
    if (b.totalDeg > w.maxBendDeg) {
      flushChain();
      continue; // honest corner/hairpin — never part of a zigzag chain
    }
    const prev = chain[chain.length - 1];
    if (prev && prev.sign !== b.sign && b.apexS - prev.apexS <= w.maxApexSpacingM) {
      chain.push(b);
    } else {
      flushChain();
      chain.push(b);
    }
  }
  flushChain();
  if (gradeExemptChains > 0) {
    console.log(
      `  [note] ${r.name}: ${gradeExemptChains} wiggle chain(s) grade-exempt (serpentine tacking near class limit)`,
    );
  }

  // ---- minimum turn radius (owner #3) ------------------------------------------
  for (let i = 1; i < pts.length - 1; i++) {
    const tDeg = Math.abs(signedTurnDeg(pts, i));
    if (tDeg < spec.radiusMinTurnDeg) continue;
    const a = pts[i - 1] as DumpPt;
    const b = pts[i] as DumpPt;
    const c = pts[i + 1] as DumpPt;
    const ds = (Math.hypot(b.x - a.x, b.z - a.z) + Math.hypot(c.x - b.x, c.z - b.z)) / 2;
    const radius = ds / ((tDeg * Math.PI) / 180);
    if (radius < stats.minRadiusM) stats.minRadiusM = radius;
    if (radius < spec.minRadiusM) {
      viols.push({
        route: r.name,
        cls: r.clsName,
        kind: 'min-radius',
        s0: b.s,
        s1: b.s,
        x: b.x,
        z: b.z,
        y: b.y,
        cam: mkCam(b.x, b.y, b.z, 40),
        detail: `turn ${tDeg.toFixed(0)}deg over ${ds.toFixed(0)} m = R ${radius.toFixed(1)} m vs min ${spec.minRadiusM} m`,
      });
    }
  }

  // ---- cross-slope (owner #3) ----------------------------------------------------
  const fordS: number[] = [];
  for (const p of pts) if (p.ford) fordS.push(p.s);
  const nearFord = (s: number): boolean =>
    fordS.some((fs) => Math.abs(s - fs) <= CROSS_FORD_EXEMPT_M);
  const lat = 2 * CROSS_AT_FRAC * r.halfWidth;
  let run: { i0: number; lenM: number; worst: number } | null = null;
  const flushCross = (iEnd: number): void => {
    if (run && run.lenM > spec.crossLenM) {
      const a = pts[run.i0] as DumpPt;
      const b = pts[Math.min(iEnd, pts.length - 1)] as DumpPt;
      viols.push({
        route: r.name,
        cls: r.clsName,
        kind: 'cross-slope',
        s0: a.s,
        s1: b.s,
        x: a.x,
        z: a.z,
        y: a.y,
        cam: mkCam(a.x, a.y, a.z, run.lenM),
        detail: `tread cross-slope ${(run.worst * 100).toFixed(1)}% over ${run.lenM.toFixed(0)} m vs max ${(spec.crossMax * 100).toFixed(0)}%`,
      });
    }
    run = null;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as DumpPt;
    const cs = Math.abs(p.hR - p.hL) / lat;
    if (cs > stats.maxCrossPct && !junction(p.x, p.z) && !nearFord(p.s)) stats.maxCrossPct = cs;
    const bad = cs > spec.crossMax && !p.ford && !nearFord(p.s) && !junction(p.x, p.z);
    if (bad) {
      const dsPrev = i > 0 ? p.s - (pts[i - 1] as DumpPt).s : 0;
      if (run) {
        run.lenM += dsPrev;
        run.worst = Math.max(run.worst, cs);
      } else run = { i0: i, lenM: 0, worst: cs };
    } else flushCross(i);
  }
  flushCross(pts.length - 1);
  stats.maxCrossPct *= 100;

  return { viols, stats };
}

// ---------------- junction mask ---------------------------------------------------

class PtGrid {
  private readonly cell = 64;
  private readonly map = new Map<number, { x: number; z: number; ri: number }[]>();
  private key(cx: number, cz: number): number {
    return (cx + 512) * 4096 + (cz + 512);
  }
  add(x: number, z: number, ri: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let arr = this.map.get(k);
    if (!arr) this.map.set(k, (arr = []));
    arr.push({ x, z, ri });
  }
  nearOther(x: number, z: number, ri: number, rad: number): boolean {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let ax = cx - 1; ax <= cx + 1; ax++) {
      for (let az = cz - 1; az <= cz + 1; az++) {
        const arr = this.map.get(this.key(ax, az));
        if (!arr) continue;
        for (const p of arr) {
          if (p.ri !== ri && Math.hypot(p.x - x, p.z - z) < rad) return true;
        }
      }
    }
    return false;
  }
}

// ---------------- per-seed run ------------------------------------------------------

interface SeedResult {
  seed: number;
  routes: number;
  km: number;
  viols: Violation[];
  statsByCls: Record<string, RouteStats[]>;
}

function runSeed(seed: number, dump: DumpRoute[]): SeedResult {
  const grid = new PtGrid();
  const maxHalf = Math.max(...dump.map((r) => r.halfWidth));
  dump.forEach((r, ri) => {
    for (const p of r.pts) grid.add(p.x, p.z, ri);
  });
  const viols: Violation[] = [];
  const statsByCls: Record<string, RouteStats[]> = {};
  dump.forEach((r, ri) => {
    const maskRad = r.halfWidth + maxHalf + JUNCTION_MASK_M;
    const { viols: v, stats } = analyzeRoute(r, (x, z) => grid.nearOther(x, z, ri, maskRad));
    viols.push(...v);
    (statsByCls[r.clsName] ??= []).push(stats);
  });
  return {
    seed,
    routes: dump.length,
    km: dump.reduce((a, r) => a + r.length, 0) / 1000,
    viols,
    statsByCls,
  };
}

// ---------------- report --------------------------------------------------------------

function printSeed(res: SeedResult, reportOnly: boolean): boolean {
  console.log(
    `\n=== seed ${res.seed}: ${res.routes} routes, ${res.km.toFixed(1)} km ===`,
  );
  for (const [cls, arr] of Object.entries(res.statsByCls).sort()) {
    const km = arr.reduce((a, s) => a + s.km, 0);
    const maxG = Math.max(...arr.map((s) => s.maxGradePct));
    const sus18 = Math.max(...arr.map((s) => s.maxSustained18M));
    const minR = Math.min(...arr.map((s) => s.minRadiusM));
    const maxCs = Math.max(...arr.map((s) => s.maxCrossPct));
    console.log(
      `  ${cls.padEnd(14)} ${km.toFixed(1).padStart(6)} km | maxGrade ${maxG.toFixed(1)}% | ` +
        `longest>18% ${sus18.toFixed(0)} m | minR ${Number.isFinite(minR) ? minR.toFixed(1) : '—'} m | ` +
        `maxCross ${maxCs.toFixed(1)}%`,
    );
  }
  if (res.viols.length === 0) {
    console.log(`[seed ${res.seed}] PASS — no realism violations`);
    return true;
  }
  console.log('route | class | metric | s-range (m) | x,z | value vs threshold');
  const byKind = new Map<string, number>();
  for (const v of res.viols.slice().sort((a, b) => a.kind.localeCompare(b.kind))) {
    byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
    const sr = v.s1 > v.s0 ? `${v.s0.toFixed(0)}..${v.s1.toFixed(0)}` : `${v.s0.toFixed(0)}`;
    console.log(
      `${v.route} | ${v.cls} | ${v.kind} | s=${sr} | (${v.x.toFixed(0)},${v.z.toFixed(0)}) | ${v.detail}`,
    );
  }
  const overBudget = [...byKind.entries()].filter(([k, n]) => n > (BUDGET[k] ?? 0));
  const summary = [...byKind.entries()].map(([k, n]) => `${k}=${n}`).join(' ');
  if (overBudget.length === 0) {
    console.log(`[seed ${res.seed}] PASS (within budget): ${summary}`);
    return true;
  }
  console.log(`[seed ${res.seed}] ${reportOnly ? 'MEASURED' : 'FAIL'}: ${summary}`);
  return false;
}

// ---------------- main -----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seeds = (str(args['seeds']) ?? '1,2,3')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  const reportOnly = args['report'] === true;
  const outPath = str(args['out']) ?? 'shots/wip/roadrealism.json';

  console.log(
    `[probe-roadrealism] seeds [${seeds.join(', ')}] — owner law: >${OWNER_SUSTAINED_LAW.gradePct}% for >${OWNER_SUSTAINED_LAW.lenM} m = red (all classes, no exemptions); ` +
      `class-limit x${CLASS_SUSTAINED_MARGIN}/${CLASS_SUSTAINED_LEN_M}m; wiggle/radius/cross per class (RoadRealismLaw)`,
  );
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-roadrealism] adapter ${info.vendor}/${info.architecture}`);
  const page: Page = await browser.newPage({
    viewport: { width: 480, height: 300 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  const results: SeedResult[] = [];
  const okBySeed: boolean[] = [];
  for (const seed of seeds) {
    try {
      const dump = await dumpSeed(page, seed);
      const res = runSeed(seed, dump);
      results.push(res);
      okBySeed.push(printSeed(res, reportOnly));
    } catch (e) {
      console.error(`[seed ${seed}] BOOT/PROBE ERROR:`, e instanceof Error ? e.message : e);
      okBySeed.push(false);
    }
  }
  await browser.close();

  mkdirSync(dirname(outPath), { recursive: true });
  const laws = Object.fromEntries(
    Object.keys(NAME_TO_ID).map((k) => [k, lawOf(k)]),
  );
  writeFileSync(
    outPath,
    JSON.stringify({ OWNER_SUSTAINED_LAW, CLASS_SUSTAINED_LEN_M, CLASS_SUSTAINED_MARGIN, laws, BUDGET, results }, null, 2),
  );
  console.log(`\n[probe-roadrealism] wrote ${outPath}`);

  console.log('\n=== summary ===');
  seeds.forEach((s, i) => console.log(`seed ${s}: ${okBySeed[i] ? 'PASS' : 'FAIL'}`));
  const allOk = okBySeed.every(Boolean);
  console.log(
    allOk ? '[probe-roadrealism] ALL SEEDS CLEAN' : '[probe-roadrealism] VIOLATIONS PRESENT',
  );
  if (!allOk && !reportOnly) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[probe-roadrealism] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
