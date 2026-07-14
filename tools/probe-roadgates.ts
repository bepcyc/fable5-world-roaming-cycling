/**
 * Road anomaly gates — integration test over generated road networks.
 *
 * Boots ?scene=world&seed=N per seed, walks EVERY route with a dense
 * (≤10 m) sampling and runs the owner's anomaly gates:
 *   grade        — |Δy|/Δs above the class law (ROAD_CLASSES maxGrade ×1.08,
 *                  probe-roads convention); ford approaches exempt but COUNTED
 *   gap          — (a) consecutive polyline points further apart than the
 *                  resample step allows; (b) a plan route silently split into
 *                  parts (`name`, `name-1`, …) whose parts do NOT touch —
 *                  runPlan flush() fallback (asphalt also via counters)
 *   flooded      — standing water on the tread outside a tagged ford;
 *                  asphalt with ford points is its own anomaly (no bridges
 *                  exist, but a highway fording a river is a planning bug);
 *                  deep-ford — a tagged ford deeper than the A* hard-block
 *                  (0.45 m ×1.5) is a road on a lake/river bed, any class
 *   narrow       — carved bed deviates from the designed profile INSIDE the
 *                  claimed halfWidth (±0.85·halfW) → actual rideable width
 *                  is less than the class claims
 *   wall         — (a) wall-across: centerline terrain above the profile
 *                  (carve failed to push the cut through → riding into a
 *                  wall); (b) float: terrain below profile (hanging road);
 *                  (c) canyon: terrain rises like a wall ≤2 m off BOTH edges
 *   misc         — out-of-world points; self-intersecting routes; unplanned
 *                  crossings where the two designed profiles disagree by >2 m
 *                  (grade-separated cross with no bridge)
 *
 * Junction mask: samples within another route's corridor (halfW_a + halfW_b
 * + 34 m, probe-roads convention) are legally re-carved/re-stamped by that
 * road — excluded from narrow/wall/conformance-style gates, never from
 * flooded/out-of-world.
 *
 * Usage: npx tsx tools/probe-roadgates.ts [--seeds 1,7,23,51]
 * Env:   LAAS_PORT (dev server port, default 5174 via tools/launch)
 * Exit:  0 = every seed clean, 1 = anomalies present / boot failure.
 */

import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { CLASSIFY } from '../src/ride/SurfaceMatrix';
import { WORLD_SIZE } from '../src/world/WorldConst';

// ---------------- thresholds (all tunables live here) ------------------------

/** dense-walk step along the polyline (m) — owner brief: ≤10 m */
const SAMPLE_STEP_M = 10;
/** grade law = class maxGrade × this (probe-roads convention: ×1.08 absorbs
 *  the 14 m-resample quantization of an at-the-limit serpentine profile) */
const GRADE_TOL = 1.08;
/** s-band (m) around a ford / wet sample exempt from the grade gate — the
 *  approach legitimately drops to the river bed (probe-roads nearFord).
 *  Exemptions are counted and reported, not silently masked. */
const FORD_EXEMPT_M = 30;
/** consecutive polyline points further apart than this = torn centerline
 *  (RESAMPLE_M is 14 m — anything > 2× is a hole in the ribbon) */
const GAP_MAX_M = 30;
/** two same-name route parts whose closest endpoints are within this touch —
 *  legal continuation; farther = a real routing gap (probe-roads TOUCH_M) */
const TOUCH_M = 25;
/** standing water deeper than this on a non-ford sample = flooded
 *  (CLASSIFY.WATER_MIN_DEPTH_M + 0.03, probe-roads convention) */
const FLOOD_DEPTH_M = CLASSIFY.WATER_MIN_DEPTH_M + 0.03;
/** |carved − designed| tolerance INSIDE ±0.85·halfWidth: crown (≤0.06 m) +
 *  bank (≤0.17 m at asphalt halfW) + carve/readback quantization */
const NARROW_TOL_M = 0.45;
/** centerline terrain this far ABOVE the designed profile = wall across the
 *  tread (carve failed); this far BELOW = hanging/floating road */
const WALL_ACROSS_M = 1.0;
/** terrain rise at (halfWidth + WALL_SIDE_OUT_M) beyond the edge, on BOTH
 *  sides, above this = slot-canyon walls. Nominal embankment is 1:1.6
 *  (RoadField EMBANK run) → 2 m out ≈ 1.25 m legal; 2.5 m = clearly a wall */
const WALL_SIDE_RISE_M = 2.5;
const WALL_SIDE_OUT_M = 2.0;
/** junction-mask extra radius beyond the two halfWidths (probe-roads) */
const JUNCTION_MASK_M = 34;
/** unplanned crossing where the two designed profiles differ by more than
 *  this = grade-separated cross with no bridge (bridges don't exist) */
const CROSS_DY_M = 2.0;
/** crossings of the same route pair closer than this are one defect site */
const CROSS_DEDUPE_M = 60;
/** a ford deeper than this is a road on a river/lake BED, not a ford — the
 *  A* hard-blocks water > FORD_MAX_DEPTH_M (0.45 m), so anything well past
 *  that reached the profile by a later clamp, not by plan (any class) */
const DEEP_FORD_M = CLASSIFY.FORD_MAX_DEPTH_M * 1.5;
/** any centerline point closer than this to the world edge = out-of-world */
const WORLD_MARGIN_M = 8;
/** max violation rows printed per (route × anomaly); the rest summarized */
const MAX_ROWS = 12;

// ---------------- types -------------------------------------------------------

interface Sample {
  s: number;
  x: number;
  z: number;
  y: number; // designed profile
  ford: boolean;
  ground: number; // carved terrain @ centerline
  depth: number; // standing water @ centerline
  inDev: number; // max |ground − y| at ±{0.5, 0.85}·halfW lateral offsets
  sideL: number; // terrain @ left  edge + WALL_SIDE_OUT_M, relative to y
  sideR: number; // terrain @ right edge + WALL_SIDE_OUT_M, relative to y
}

interface RouteDump {
  name: string;
  clsName: string;
  surfaceId: number;
  maxGrade: number;
  halfWidth: number;
  length: number;
  pts: { x: number; z: number; y: number; s: number; ford: boolean }[];
  samples: Sample[];
}

interface SeedDump {
  asphaltGaps: number;
  asphaltCuts: number;
  routes: RouteDump[];
}

interface Violation {
  route: string;
  cls: string;
  kind: string;
  s0: number;
  s1: number;
  x: number;
  z: number;
  detail: string; // "value vs threshold"
}

// ---------------- in-page dense walk -----------------------------------------

async function dumpSeed(page: Page, seed: number): Promise<SeedDump> {
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
    ({ STEP, SIDE_OUT }) => {
      (globalThis as unknown as { __name?: unknown }).__name ??= (t: unknown): unknown => t;
      const hf = (
        window as unknown as { __laasDbg?: { engine?: { heightfield?: unknown } } }
      ).__laasDbg?.engine?.heightfield as {
        heightAtCpu(x: number, z: number): number;
        waterDepthAtCpu(x: number, z: number): number;
        roads: {
          counters: { asphaltGaps: number; asphaltCuts: number };
          routes: {
            name: string;
            cls: { name: string; surfaceId: number; maxGrade: number; halfWidth: number };
            length: number;
            pts: { x: number; z: number; y: number; ford: boolean; s: number }[];
          }[];
        } | null;
      };
      if (!hf.roads) return null;
      const routes = hf.roads.routes.map((r) => {
        const pts = r.pts.map((p) => ({ x: p.x, z: p.z, y: p.y, s: p.s, ford: p.ford }));
        const hw = r.cls.halfWidth;
        const samples: {
          s: number; x: number; z: number; y: number; ford: boolean;
          ground: number; depth: number; inDev: number; sideL: number; sideR: number;
        }[] = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const seg = Math.hypot(dx, dz);
          if (seg < 1e-6) continue;
          const nx = -dz / seg; // lateral normal
          const nz = dx / seg;
          const nSteps = Math.max(1, Math.ceil(seg / STEP));
          const last = i === pts.length - 2;
          for (let k = 0; k <= (last ? nSteps : nSteps - 1); k++) {
            const t = Math.min(k / nSteps, 1);
            const x = a.x + dx * t;
            const z = a.z + dz * t;
            const y = a.y + (b.y - a.y) * t;
            const s = a.s + (b.s - a.s) * t;
            let inDev = 0;
            for (const f of [-0.85, -0.5, 0.5, 0.85]) {
              const d = Math.abs(hf.heightAtCpu(x + nx * hw * f, z + nz * hw * f) - y);
              if (d > inDev) inDev = d;
            }
            samples.push({
              s, x, z, y,
              ford: a.ford || b.ford,
              ground: hf.heightAtCpu(x, z),
              depth: hf.waterDepthAtCpu(x, z),
              inDev,
              sideL: hf.heightAtCpu(x - nx * (hw + SIDE_OUT), z - nz * (hw + SIDE_OUT)) - y,
              sideR: hf.heightAtCpu(x + nx * (hw + SIDE_OUT), z + nz * (hw + SIDE_OUT)) - y,
            });
          }
        }
        return {
          name: r.name,
          clsName: r.cls.name,
          surfaceId: r.cls.surfaceId,
          maxGrade: r.cls.maxGrade,
          halfWidth: hw,
          length: r.length,
          pts,
          samples,
        };
      });
      return {
        asphaltGaps: hf.roads.counters.asphaltGaps,
        asphaltCuts: hf.roads.counters.asphaltCuts,
        routes,
      };
    },
    { STEP: SAMPLE_STEP_M, SIDE_OUT: WALL_SIDE_OUT_M },
  )) as SeedDump | null;
  if (!dump || dump.routes.length === 0) throw new Error(`seed ${seed}: hf.roads null/empty`);
  return dump;
}

// ---------------- gate helpers -------------------------------------------------

/** spatial hash of all routes' polyline points → fast junction mask */
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
  /** any point of a DIFFERENT route within radius? returns its route index */
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

/** merge consecutive per-sample violations (≤2-sample holes) into runs */
function mergeRuns(
  route: RouteDump,
  kind: string,
  hits: { i: number; val: number; detail: string }[],
): Violation[] {
  const out: Violation[] = [];
  let run: { i0: number; i1: number; worst: { i: number; val: number; detail: string } } | null =
    null;
  const flush = (): void => {
    if (!run) return;
    const a = route.samples[run.i0];
    const b = route.samples[run.i1];
    const w = route.samples[run.worst.i];
    if (a && b && w) {
      out.push({
        route: route.name,
        cls: route.clsName,
        kind,
        s0: a.s,
        s1: b.s,
        x: w.x,
        z: w.z,
        detail: run.worst.detail,
      });
    }
    run = null;
  };
  for (const h of hits) {
    if (run && h.i - run.i1 <= 3) {
      run.i1 = h.i;
      if (h.val > run.worst.val) run.worst = h;
    } else {
      flush();
      run = { i0: h.i, i1: h.i, worst: h };
    }
  }
  flush();
  return out;
}

/** 2D segment intersection (proper crossings only), returns param t on (a,b) */
function segCross(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number | null {
  const r1x = bx - ax;
  const r1z = bz - az;
  const r2x = dx - cx;
  const r2z = dz - cz;
  const den = r1x * r2z - r1z * r2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * r2z - (cz - az) * r2x) / den;
  const u = ((cx - ax) * r1z - (cz - az) * r1x) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return t;
}

// ---------------- per-seed gate run --------------------------------------------

function runGates(seed: number, dump: SeedDump): Violation[] {
  const V: Violation[] = [];
  const routes = dump.routes;

  // junction-mask grid over original polyline points
  const grid = new PtGrid();
  const maxHalf = Math.max(...routes.map((r) => r.halfWidth));
  routes.forEach((r, ri) => {
    for (const p of r.pts) grid.add(p.x, p.z, ri);
  });

  for (const [ri, r] of routes.entries()) {
    const maskRad = r.halfWidth + maxHalf + JUNCTION_MASK_M;
    const junction = (x: number, z: number): boolean => grid.nearOther(x, z, ri, maskRad);
    // ford band: sample s within FORD_EXEMPT_M of any ford/wet sample
    const fordS: number[] = [];
    for (const p of r.samples) if (p.ford || p.depth > 0.03) fordS.push(p.s);
    const nearFord = (s: number): boolean => {
      for (const fs of fordS) if (Math.abs(s - fs) <= FORD_EXEMPT_M) return true;
      return false;
    };

    // ---- grade (owner #1) ----------------------------------------------------
    const gLim = r.maxGrade * GRADE_TOL + 1e-3;
    const gHits: { i: number; val: number; detail: string }[] = [];
    let gradeExempt = 0;
    for (let i = 0; i < r.samples.length - 1; i++) {
      const p = r.samples[i];
      const q = r.samples[i + 1];
      if (!p || !q) continue;
      const ds = Math.max(Math.hypot(q.x - p.x, q.z - p.z), 1e-3);
      const g = Math.abs(q.y - p.y) / ds;
      if (g <= gLim) continue;
      if (nearFord(p.s) || nearFord(q.s)) {
        gradeExempt++;
        continue;
      }
      gHits.push({
        i,
        val: g,
        detail: `grade ${(g * 100).toFixed(1)}% vs class ${(r.maxGrade * 100).toFixed(0)}%×${GRADE_TOL}`,
      });
    }
    V.push(...mergeRuns(r, 'grade', gHits));
    if (gradeExempt > 0) {
      console.log(
        `  [note] ${r.name}: ${gradeExempt} over-grade sample(s) exempted inside ford band (±${FORD_EXEMPT_M} m)`,
      );
    }

    // ---- gap (owner #2a): torn centerline -------------------------------------
    for (let i = 0; i < r.pts.length - 1; i++) {
      const p = r.pts[i];
      const q = r.pts[i + 1];
      if (!p || !q) continue;
      const chord = Math.hypot(q.x - p.x, q.z - p.z);
      if (chord > GAP_MAX_M) {
        V.push({
          route: r.name,
          cls: r.clsName,
          kind: 'gap',
          s0: p.s,
          s1: q.s,
          x: p.x,
          z: p.z,
          detail: `pt chord ${chord.toFixed(1)} m vs max ${GAP_MAX_M} m`,
        });
      }
    }

    // ---- flooded (owner #3) ----------------------------------------------------
    const fHits: { i: number; val: number; detail: string }[] = [];
    r.samples.forEach((p, i) => {
      if (p.ford || nearFord(p.s)) return;
      if (p.depth > FLOOD_DEPTH_M) {
        fHits.push({
          i,
          val: p.depth,
          detail: `depth ${p.depth.toFixed(2)} m vs max ${FLOOD_DEPTH_M.toFixed(2)} m (non-ford)`,
        });
      }
    });
    V.push(...mergeRuns(r, 'flooded', fHits));

    // asphalt fording a river = planning anomaly (highways don't ford)
    if (r.clsName === 'asphalt') {
      const aHits: { i: number; val: number; detail: string }[] = [];
      r.samples.forEach((p, i) => {
        if (p.ford) aHits.push({ i, val: p.depth, detail: `asphalt ford, depth ${p.depth.toFixed(2)} m` });
      });
      V.push(...mergeRuns(r, 'asphalt-ford', aHits));
    }

    // ford deeper than the A* hard-block = road on a lake/river BED (any class)
    const dfHits: { i: number; val: number; detail: string }[] = [];
    r.samples.forEach((p, i) => {
      if (p.ford && p.depth > DEEP_FORD_M) {
        dfHits.push({
          i,
          val: p.depth,
          detail: `ford depth ${p.depth.toFixed(2)} m vs max ${DEEP_FORD_M.toFixed(2)} m (FORD_MAX_DEPTH ${CLASSIFY.FORD_MAX_DEPTH_M} ×1.5)`,
        });
      }
    });
    V.push(...mergeRuns(r, 'deep-ford', dfHits));

    // ---- narrow (owner #4) + wall (owner #5) -----------------------------------
    const nHits: { i: number; val: number; detail: string }[] = [];
    const wHits: { i: number; val: number; detail: string }[] = [];
    const flHits: { i: number; val: number; detail: string }[] = [];
    const cHits: { i: number; val: number; detail: string }[] = [];
    r.samples.forEach((p, i) => {
      if (p.ford || nearFord(p.s) || junction(p.x, p.z)) return;
      if (p.inDev > NARROW_TOL_M) {
        nHits.push({
          i,
          val: p.inDev,
          detail: `bed off by ${p.inDev.toFixed(2)} m inside ±0.85·halfW vs tol ${NARROW_TOL_M} m`,
        });
      }
      const dCore = p.ground - p.y;
      if (dCore > WALL_ACROSS_M) {
        wHits.push({
          i,
          val: dCore,
          detail: `terrain ${dCore.toFixed(2)} m ABOVE profile on centerline vs max ${WALL_ACROSS_M} m`,
        });
      } else if (-dCore > WALL_ACROSS_M) {
        flHits.push({
          i,
          val: -dCore,
          detail: `terrain ${(-dCore).toFixed(2)} m BELOW profile (hanging road) vs max ${WALL_ACROSS_M} m`,
        });
      }
      if (p.sideL > WALL_SIDE_RISE_M && p.sideR > WALL_SIDE_RISE_M) {
        cHits.push({
          i,
          val: Math.min(p.sideL, p.sideR),
          detail: `walls both sides: +${p.sideL.toFixed(1)}/+${p.sideR.toFixed(1)} m @ edge+${WALL_SIDE_OUT_M} m vs max ${WALL_SIDE_RISE_M} m`,
        });
      }
    });
    V.push(...mergeRuns(r, 'narrow', nHits));
    V.push(...mergeRuns(r, 'wall-across', wHits));
    V.push(...mergeRuns(r, 'float', flHits));
    V.push(...mergeRuns(r, 'wall-canyon', cHits));

    // ---- misc: out-of-world -----------------------------------------------------
    const oHits: { i: number; val: number; detail: string }[] = [];
    const lim = WORLD_SIZE / 2 - WORLD_MARGIN_M;
    r.samples.forEach((p, i) => {
      const d = Math.max(Math.abs(p.x), Math.abs(p.z));
      if (d > lim) oHits.push({ i, val: d, detail: `|coord| ${d.toFixed(0)} m vs limit ${lim} m` });
    });
    V.push(...mergeRuns(r, 'out-of-world', oHits));
  }

  // ---- gap (owner #2b): silent plan splits — parts of the same plan name ------
  const families = new Map<string, RouteDump[]>();
  for (const r of routes) {
    const m = /^(.+)-(\d+)$/.exec(r.name);
    const base = m && routes.some((o) => o.name === m[1]) ? (m[1] as string) : r.name;
    let arr = families.get(base);
    if (!arr) families.set(base, (arr = []));
    arr.push(r);
  }
  for (const [base, parts] of families) {
    if (parts.length < 2) continue;
    // parts touching within TOUCH_M = legal continuation; otherwise = gap
    for (let i = 0; i < parts.length - 1; i++) {
      const a = parts[i];
      const b = parts[i + 1];
      if (!a || !b) continue;
      let best = Infinity;
      let bx = 0;
      let bz = 0;
      for (const e of [a.pts[0], a.pts[a.pts.length - 1]]) {
        if (!e) continue;
        for (const q of b.pts) {
          const d = Math.hypot(e.x - q.x, e.z - q.z);
          if (d < best) {
            best = d;
            bx = e.x;
            bz = e.z;
          }
        }
      }
      if (best > TOUCH_M) {
        V.push({
          route: base,
          cls: a.clsName,
          kind: 'gap-split',
          s0: a.length,
          s1: 0,
          x: bx,
          z: bz,
          detail: `plan split into parts ${best.toFixed(0)} m apart (${a.name} ↔ ${b.name}) vs touch ${TOUCH_M} m`,
        });
      }
    }
  }
  if (dump.asphaltGaps > 0 || dump.asphaltCuts > 0) {
    V.push({
      route: '(network)',
      cls: 'asphalt',
      kind: 'gap-split',
      s0: 0,
      s1: 0,
      x: 0,
      z: 0,
      detail: `counters: asphaltGaps=${dump.asphaltGaps} asphaltCuts=${dump.asphaltCuts} vs 0`,
    });
  }

  // ---- misc: self-intersections + unplanned level-mismatched crossings --------
  interface Seg { ri: number; i: number; ax: number; az: number; bx: number; bz: number; ay: number; by: number }
  const segs: Seg[] = [];
  routes.forEach((r, ri) => {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      if (!a || !b) continue;
      segs.push({ ri, i, ax: a.x, az: a.z, bx: b.x, bz: b.z, ay: a.y, by: b.y });
    }
  });
  const cellSz = 32;
  const buckets = new Map<number, number[]>();
  const bkey = (cx: number, cz: number): number => (cx + 512) * 4096 + (cz + 512);
  segs.forEach((sg, si) => {
    const x0 = Math.floor(Math.min(sg.ax, sg.bx) / cellSz);
    const x1 = Math.floor(Math.max(sg.ax, sg.bx) / cellSz);
    const z0 = Math.floor(Math.min(sg.az, sg.bz) / cellSz);
    const z1 = Math.floor(Math.max(sg.az, sg.bz) / cellSz);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = bkey(cx, cz);
        let arr = buckets.get(k);
        if (!arr) buckets.set(k, (arr = []));
        arr.push(si);
      }
    }
  });
  interface CrossEvt { x: number; z: number; sA: number; sB: number; dy: number }
  const crossEvts = new Map<string, CrossEvt[]>(); // per route pair / self-route
  const seenPairs = new Set<number>();
  for (const arr of buckets.values()) {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const ia = Math.min(arr[a] as number, arr[b] as number);
        const ib = Math.max(arr[a] as number, arr[b] as number);
        const pk = ia * segs.length + ib;
        if (seenPairs.has(pk)) continue;
        seenPairs.add(pk);
        const s1 = segs[ia] as Seg;
        const s2 = segs[ib] as Seg;
        if (s1.ri === s2.ri && Math.abs(s1.i - s2.i) <= 2) continue; // adjacent
        const t = segCross(s1.ax, s1.az, s1.bx, s1.bz, s2.ax, s2.az, s2.bx, s2.bz);
        if (t === null) continue;
        const x = s1.ax + (s1.bx - s1.ax) * t;
        const z = s1.az + (s1.bz - s1.az) * t;
        const r1 = routes[s1.ri] as RouteDump;
        const r2 = routes[s2.ri] as RouteDump;
        const sA = (r1.pts[s1.i] as { s: number }).s;
        const sB = (r2.pts[s2.i] as { s: number }).s;
        if (s1.ri === s2.ri) {
          const key = `self|${r1.name}|${r1.clsName}`;
          let evts = crossEvts.get(key);
          if (!evts) crossEvts.set(key, (evts = []));
          evts.push({ x, z, sA, sB, dy: 0 });
        } else {
          const y1 = s1.ay + (s1.by - s1.ay) * t;
          // approx level of the other segment at the crossing (midpoint lerp)
          const y2 = (s2.ay + s2.by) / 2;
          const dy = Math.abs(y1 - y2);
          if (dy > CROSS_DY_M) {
            const key = `cross|${r1.name} × ${r2.name}|${r1.clsName}/${r2.clsName}`;
            let evts = crossEvts.get(key);
            if (!evts) crossEvts.set(key, (evts = []));
            evts.push({ x, z, sA, sB, dy });
          }
        }
      }
    }
  }
  // near-parallel routes cross many times around one defect site — cluster
  // events within CROSS_DEDUPE_M and report the worst of each cluster
  for (const [key, evts] of crossEvts) {
    const [kindTag, route, cls] = key.split('|') as [string, string, string];
    const clusters: CrossEvt[][] = [];
    for (const e of evts) {
      const c = clusters.find((cl) =>
        cl.some((o) => Math.hypot(o.x - e.x, o.z - e.z) < CROSS_DEDUPE_M),
      );
      if (c) c.push(e);
      else clusters.push([e]);
    }
    for (const cl of clusters) {
      const w = cl.reduce((a, e) => (e.dy > a.dy ? e : a), cl[0] as CrossEvt);
      if (kindTag === 'self') {
        V.push({
          route, cls,
          kind: 'self-cross',
          s0: Math.min(w.sA, w.sB),
          s1: Math.max(w.sA, w.sB),
          x: w.x, z: w.z,
          detail: `route crosses itself (${cl.length} crossing(s) at this site)`,
        });
      } else {
        V.push({
          route, cls,
          kind: 'cross-level',
          s0: w.sA,
          s1: w.sB,
          x: w.x, z: w.z,
          detail:
            `crossing with Δy ${w.dy.toFixed(1)} m vs max ${CROSS_DY_M} m ` +
            `(no bridges exist; ${cl.length} crossing(s) at this site; s=A@${w.sA.toFixed(0)}/B@${w.sB.toFixed(0)})`,
        });
      }
    }
  }

  void seed;
  return V;
}

// ---------------- reporting ------------------------------------------------------

function report(seed: number, dump: SeedDump, viols: Violation[]): boolean {
  const totalKm = dump.routes.reduce((a, r) => a + r.length, 0) / 1000;
  const nSamples = dump.routes.reduce((a, r) => a + r.samples.length, 0);
  console.log(
    `\n=== seed ${seed}: ${dump.routes.length} routes, ${totalKm.toFixed(1)} km, ${nSamples} samples @ ≤${SAMPLE_STEP_M} m ===`,
  );
  if (viols.length === 0) {
    console.log(`seed ${seed}: no anomalies`);
    console.log(`[seed ${seed}] PASS`);
    return true;
  }
  // group rows per (route, kind) and cap output
  const byKey = new Map<string, Violation[]>();
  for (const v of viols) {
    const k = `${v.kind}|${v.route}`;
    let arr = byKey.get(k);
    if (!arr) byKey.set(k, (arr = []));
    arr.push(v);
  }
  console.log('route | class | anomaly | s-range (m) | x,z (worst) | value vs threshold');
  for (const [, arr] of [...byKey.entries()].sort()) {
    for (const v of arr.slice(0, MAX_ROWS)) {
      const sr = v.s1 > v.s0 ? `${v.s0.toFixed(0)}..${v.s1.toFixed(0)}` : `${v.s0.toFixed(0)}`;
      console.log(
        `${v.route} | ${v.cls} | ${v.kind} | s=${sr} | (${v.x.toFixed(0)},${v.z.toFixed(0)}) | ${v.detail}`,
      );
    }
    if (arr.length > MAX_ROWS) {
      const v0 = arr[0] as Violation;
      console.log(`${v0.route} | ${v0.cls} | ${v0.kind} | … and ${arr.length - MAX_ROWS} more run(s)`);
    }
  }
  const counts = new Map<string, number>();
  for (const v of viols) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
  const summary = [...counts.entries()]
    .sort()
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  console.log(`[seed ${seed}] FAIL: ${viols.length} violation run(s): ${summary}`);
  return false;
}

// ---------------- main -------------------------------------------------------------

async function main(): Promise<void> {
  const argIdx = process.argv.indexOf('--seeds');
  const seedsArg = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
  const seeds = (seedsArg ?? '1,7,23,51')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (seeds.length === 0) throw new Error('no valid seeds in --seeds');

  console.log(
    `[probe-roadgates] seeds [${seeds.join(', ')}] — thresholds: step≤${SAMPLE_STEP_M}m, ` +
      `grade=class×${GRADE_TOL} (asphalt 12% / gravel-fine 12% / gravel-coarse 14% / dirt 16% / singletrack 20%), ` +
      `fordExempt=±${FORD_EXEMPT_M}m, gap>${GAP_MAX_M}m, touch=${TOUCH_M}m, flood>${FLOOD_DEPTH_M.toFixed(2)}m, ` +
      `narrow>${NARROW_TOL_M}m@±0.85halfW, wallAcross>±${WALL_ACROSS_M}m, canyon>+${WALL_SIDE_RISE_M}m@edge+${WALL_SIDE_OUT_M}m both sides, ` +
      `crossΔy>${CROSS_DY_M}m (dedupe ${CROSS_DEDUPE_M}m), deepFord>${DEEP_FORD_M.toFixed(2)}m, worldMargin=${WORLD_MARGIN_M}m`,
  );
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-roadgates] adapter ${info.vendor}/${info.architecture}`);
  const page: Page = await browser.newPage({
    viewport: { width: 480, height: 300 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  const results: { seed: number; ok: boolean }[] = [];
  for (const seed of seeds) {
    try {
      const dump = await dumpSeed(page, seed);
      const viols = runGates(seed, dump);
      results.push({ seed, ok: report(seed, dump, viols) });
    } catch (e) {
      console.error(`[seed ${seed}] BOOT/PROBE ERROR:`, e instanceof Error ? e.message : e);
      results.push({ seed, ok: false });
    }
  }
  await browser.close();

  console.log('\n=== summary ===');
  for (const r of results) console.log(`seed ${r.seed}: ${r.ok ? 'PASS' : 'FAIL'}`);
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? '[probe-roadgates] ALL SEEDS CLEAN' : '[probe-roadgates] ANOMALIES PRESENT');
  if (!allOk) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[probe-roadgates] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
