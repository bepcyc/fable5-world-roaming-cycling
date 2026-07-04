/**
 * RoadNetwork — M1.2 seeded road & trail graph (CPU, boot-time).
 *
 * Runs INSIDE Heightfield.generate, after erosion/hydrology are composed but
 * BEFORE rebuildDerivedMaps: routes are traced on the CPU mirror of the
 * eroded terrain, then the GPU carve (RoadField.ts) flattens the height
 * buffer to the profiles produced here, so normals/slope/biome/surface all
 * pick the roads up automatically in the existing derive order.
 *
 * Realism law (owner directive 2026-07-03 + Pillar B):
 *   - real engineering grades per class (alpine pass ≈ 10%, MTB trail ≈ 22%)
 *   - real widths (two-lane mountain asphalt 5.8 m … singletrack 1.1 m tread)
 *   - grade-limited A* on the flow-carved terrain — switchbacks EMERGE from
 *     the grade limit instead of being stamped (ROADMAP top-risk mitigation)
 *   - superelevation (banking) from curvature, crowned cross-sections
 *   - water crossings v1 = fords: the profile drops to the bed, never a
 *     causeway; deep water is a hard routing block (bridges = backlog)
 *
 * Determinism: all randomness from seed.rng('roads') (owner Q2); terrain
 * inputs are themselves seed-derived. Surface ids come from SurfaceMatrix
 * (Pillar D) — no constants re-declared here.
 */

import type { WorldSeed } from '../core/Seed';
import { runWorkerJobs } from '../core/Threads';
import type { MacroParams } from '../world/MacroMap';
import { WORLD_SIZE } from '../world/WorldConst';
import { computeRoadGridBand, type RoadGridJob } from './RoadGridWorker';
import { CLASSIFY, SurfaceId } from './SurfaceMatrix';

/** engineering spec per road class (SI; grades rise/run) */
export interface RoadClassSpec {
  surfaceId: SurfaceId;
  name: string;
  /** half-width of the finished surface (m) */
  halfWidth: number;
  /** max sustained grade the router accepts (real-world design ceiling) */
  maxGrade: number;
  /** superelevation ceiling (cross slope in curves) */
  bankMax: number;
  /** crown cross-slope (drainage camber; 0 = none) */
  crownSlope: number;
  /** 0..1 how much terrain micro-displacement survives on the surface */
  dispScale: number;
}

export const ROAD_CLASSES: readonly RoadClassSpec[] = [
  {
    surfaceId: SurfaceId.Asphalt,
    name: 'asphalt',
    halfWidth: 2.9, // 5.8 m two-lane mountain road
    maxGrade: 0.12, // alpine-pass ceiling (Stelvio ~12%, Mortirolo peaks 18%)
    bankMax: 0.06,
    crownSlope: 0.02,
    dispScale: 0,
  },
  {
    surfaceId: SurfaceId.GravelFine,
    name: 'gravel-fine',
    halfWidth: 2.2,
    maxGrade: 0.12,
    bankMax: 0.04,
    crownSlope: 0.025,
    dispScale: 0.15,
  },
  {
    surfaceId: SurfaceId.GravelCoarse,
    name: 'gravel-coarse',
    halfWidth: 2.0,
    maxGrade: 0.14,
    bankMax: 0.03,
    crownSlope: 0.02,
    dispScale: 0.5,
  },
  {
    surfaceId: SurfaceId.DirtRoad,
    name: 'dirt-road',
    halfWidth: 1.8, // graded doubletrack
    maxGrade: 0.16,
    bankMax: 0.02,
    crownSlope: 0.015,
    dispScale: 0.4,
  },
  {
    surfaceId: SurfaceId.Singletrack,
    name: 'singletrack',
    halfWidth: 0.55, // 1.1 m worn tread (IMBA bench-cut 0.6–0.9 m + verge)
    maxGrade: 0.2, // IMBA: >18–20% sustained = hike-a-bike; ramps only
    bankMax: 0.03,
    crownSlope: 0,
    dispScale: 0.7,
  },
];

export function roadClassBySurface(id: number): RoadClassSpec | null {
  return ROAD_CLASSES.find((c) => c.surfaceId === id) ?? null;
}

export interface RoadPoint {
  x: number;
  z: number;
  /** finished road surface elevation at the centerline (m) */
  y: number;
  /** signed superelevation cross-slope at this point (rise/run over lateral) */
  bank: number;
  /** true where the route crosses fordable water (profile = river bed) */
  ford: boolean;
  /** arclength from route start (m) */
  s: number;
}

export interface RoadRoute {
  name: string;
  cls: RoadClassSpec;
  pts: RoadPoint[];
  length: number;
}

/** terrain inputs (CPU mirrors read back mid-generate) */
export interface RoadTerrain {
  res: number;
  heights: Float32Array;
  simRes: number;
  waterY: Float32Array;
}

// router constants
const GRID_N = 512; // 8 m cells over the 4096 m world
const RESAMPLE_M = 14; // final polyline step
const MAX_CUT_FILL = 6; // profile may deviate ≤ this from terrain (no viaducts)
const TARGET_KM = 30.5;
// Track C2: asphalt gap-retry ladder. MAX_CUT_FILL only bounds the vertical
// PROFILE (buildRoute), not the A* search — so relaxing it would not help
// the pathfinder. The actual A* knob is the grade hard-block factor (2.2×
// by default, see route()'s gradeMul); the retry ladder relaxes THAT.
const ASPHALT_RETRY_GRADE_MUL = 2.8;
const ASPHALT_RETRY_JITTER_CELLS = 3; // ± grid cells, seeded jitter
const ASPHALT_RETRY_ATTEMPTS = 3;

interface Cell {
  x: number;
  z: number;
}

function bilerp(a: Float32Array, res: number, x: number, z: number): number {
  const gx = Math.min(Math.max((x / WORLD_SIZE + 0.5) * res - 0.5, 0), res - 1.001);
  const gz = Math.min(Math.max((z / WORLD_SIZE + 0.5) * res - 0.5, 0), res - 1.001);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;
  const at = (xx: number, zz: number): number =>
    a[Math.min(zz, res - 1) * res + Math.min(xx, res - 1)] ?? 0;
  const t = at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx;
  const b = at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx;
  return t * (1 - fz) + b * fz;
}

/** binary min-heap keyed on f-score (A* open set) */
class Heap {
  private idx: number[] = [];
  private f: number[] = [];
  get size(): number {
    return this.idx.length;
  }
  push(i: number, fi: number): void {
    this.idx.push(i);
    this.f.push(fi);
    let c = this.idx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if ((this.f[p] as number) <= (this.f[c] as number)) break;
      this.swap(p, c);
      c = p;
    }
  }
  pop(): number {
    const top = this.idx[0] as number;
    const li = this.idx.pop() as number;
    const lf = this.f.pop() as number;
    if (this.idx.length > 0) {
      this.idx[0] = li;
      this.f[0] = lf;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < this.f.length && (this.f[l] as number) < (this.f[m] as number)) m = l;
        if (r < this.f.length && (this.f[r] as number) < (this.f[m] as number)) m = r;
        if (m === p) break;
        this.swap(m, p);
        p = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const ti = this.idx[a] as number;
    this.idx[a] = this.idx[b] as number;
    this.idx[b] = ti;
    const tf = this.f[a] as number;
    this.f[a] = this.f[b] as number;
    this.f[b] = tf;
  }
}

export class RoadNetwork {
  readonly routes: RoadRoute[];
  readonly totalLength: number;
  /**
   * diagnostics for probes (Track C2): ASPHALT-only gap/cut counters.
   * probe-roads asserts BOTH stay at 0 — asphalt has the lowest maxGrade
   * (0.12) and is the class the retry ladder in generate()/runPlan exists
   * for; any survivor here means the ladder was exhausted and the route
   * silently split (see runPlan's flush()).
   */
  readonly counters: { asphaltGaps: number; asphaltCuts: number };

  private constructor(
    routes: RoadRoute[],
    counters: { asphaltGaps: number; asphaltCuts: number } = { asphaltGaps: 0, asphaltCuts: 0 },
  ) {
    this.routes = routes;
    this.totalLength = routes.reduce((a, r) => a + r.length, 0);
    this.counters = counters;
  }

  /** flattened segment view (probes / GPU upload) */
  *segments(): Generator<{
    ax: number;
    az: number;
    bx: number;
    bz: number;
    y0: number;
    y1: number;
    bank0: number;
    bank1: number;
    ford: boolean;
    cls: RoadClassSpec;
  }> {
    for (const r of this.routes) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i] as RoadPoint;
        const b = r.pts[i + 1] as RoadPoint;
        yield {
          ax: a.x,
          az: a.z,
          bx: b.x,
          bz: b.z,
          y0: a.y,
          y1: b.y,
          bank0: a.bank,
          bank1: b.bank,
          ford: a.ford || b.ford,
          cls: r.cls,
        };
      }
    }
  }

  /** nearest network point to (x,z) — probe-grade brute force */
  nearest(x: number, z: number): {
    dist: number;
    y: number;
    surfaceId: SurfaceId;
    ford: boolean;
    route: string;
  } {
    let best = {
      dist: Infinity,
      y: 0,
      surfaceId: SurfaceId.Soil as SurfaceId,
      ford: false,
      route: '',
    };
    for (const r of this.routes) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i] as RoadPoint;
        const b = r.pts[i + 1] as RoadPoint;
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        const t =
          len2 > 0
            ? Math.min(Math.max(((x - a.x) * abx + (z - a.z) * abz) / len2, 0), 1)
            : 0;
        const px = a.x + abx * t;
        const pz = a.z + abz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best.dist) {
          best = {
            dist: d,
            y: a.y + (b.y - a.y) * t,
            surfaceId: r.cls.surfaceId,
            ford: a.ford || b.ford,
            route: r.name,
          };
        }
      }
    }
    return best;
  }

  static async generate(
    seed: WorldSeed,
    mp: MacroParams,
    terr: RoadTerrain,
    threads = 1,
  ): Promise<RoadNetwork> {
    const rng = seed.rng('roads');
    // Track C2 counters (probe-roads asserts both are 0 — see RoadNetwork.counters)
    let asphaltGaps = 0;
    let asphaltCuts = 0;
    const hAt = (x: number, z: number): number => bilerp(terr.heights, terr.res, x, z);
    const wAt = (x: number, z: number): number => bilerp(terr.waterY, terr.simRes, x, z);
    // conservative water level: MIN over the 3×3 nearest waterY texels.
    // Bilinear alone smears a hanging tarn's level onto DRY ground below
    // its rim (dry texels hold bed−2) — phantom "deep water" that cut the
    // serpentine mid-flank. Inside a real lake all nine texels are wet.
    const wAtMin = (x: number, z: number): number => {
      const res = terr.simRes;
      const gx = Math.min(Math.max(Math.round((x / WORLD_SIZE + 0.5) * res - 0.5), 1), res - 2);
      const gz = Math.min(Math.max(Math.round((z / WORLD_SIZE + 0.5) * res - 0.5), 1), res - 2);
      let m = Infinity;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = terr.waterY[(gz + dz) * res + gx + dx] as number;
          if (v < m) m = v;
        }
      }
      return m;
    };

    // ---- router grids (8 m) — banded across the CPU thread budget ----------
    // (owner directive: use every core; result is band-concatenated and thus
    // bit-identical to the single-threaded path)
    const N = GRID_N;
    const cellM = WORLD_SIZE / N;
    const gh = new Float32Array(N * N);
    const gd = new Float32Array(N * N);
    const gs = new Float32Array(N * N); // terrain slope (side-hill cost)
    const cw = (c: number): number => ((c + 0.5) / N - 0.5) * WORLD_SIZE;
    {
      const bands = Math.max(1, Math.min(threads, N));
      const rowsPer = Math.ceil(N / bands);
      const jobs: { payload: RoadGridJob; transfer: Transferable[] }[] = [];
      for (let b = 0; b < bands; b++) {
        const z0 = b * rowsPer;
        const z1 = Math.min(N, z0 + rowsPer);
        if (z0 >= z1) break;
        const rowRange = (res: number): [number, number] => [
          Math.max(0, Math.floor((z0 / N) * res) - 2),
          Math.min(res, Math.ceil((z1 / N) * res) + 3),
        ];
        const [h0, h1] = rowRange(terr.res);
        const [w0, w1] = rowRange(terr.simRes);
        jobs.push({
          payload: {
            z0,
            z1,
            n: N,
            worldSize: WORLD_SIZE,
            heights: terr.heights.slice(h0 * terr.res, h1 * terr.res),
            hRow0: h0,
            hRes: terr.res,
            waterY: terr.waterY.slice(w0 * terr.simRes, w1 * terr.simRes),
            wRow0: w0,
            wRes: terr.simRes,
          },
          transfer: [],
        });
      }
      for (const j of jobs) j.transfer = [j.payload.heights.buffer, j.payload.waterY.buffer];
      const parts = await runWorkerJobs(
        () => new Worker(new URL('./RoadGridWorker.ts', import.meta.url), { type: 'module' }),
        jobs,
        bands,
        computeRoadGridBand,
      );
      for (const part of parts) {
        gh.set(part.gh, part.z0 * N);
        gd.set(part.gd, part.z0 * N);
      }
    }
    // dilate water depth by TWO cells (16 m): narrow trenches (≈15 m) slip
    // BETWEEN 8 m cell centers, and Chaikin smoothing can drift the final
    // polyline up to ~8 m off the A* cells — both ways roads ended in
    // lake-deep water and were cut short
    {
      const src = gd.slice();
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          let m = 0;
          for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
              const xx = Math.min(Math.max(x + dx, 0), N - 1);
              const zz = Math.min(Math.max(z + dz, 0), N - 1);
              const v = src[zz * N + xx] as number;
              if (v > m) m = v;
            }
          }
          gd[z * N + x] = m;
        }
      }
    }
    // routing sees a SMOOTHED height field: 8 m micro-noise is exactly what
    // real road construction grades away (the profile relaxation + carve do
    // it here) — grading on the raw field walls off every corridor with
    // phantom 15% micro-steps and asphalt becomes unroutable
    for (let it = 0; it < 2; it++) {
      const src = gh.slice();
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          let sum = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = Math.min(Math.max(x + dx, 0), N - 1);
              const zz = Math.min(Math.max(z + dz, 0), N - 1);
              sum += src[zz * N + xx] as number;
            }
          }
          gh[z * N + x] = sum / 9;
        }
      }
    }
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const at = (xx: number, zz: number): number =>
          gh[Math.min(Math.max(zz, 0), N - 1) * N + Math.min(Math.max(xx, 0), N - 1)] as number;
        const dx = at(x + 1, z) - at(x - 1, z);
        const dz = at(x, z + 1) - at(x, z - 1);
        gs[z * N + x] = Math.hypot(dx, dz) / (cellM * 2);
      }
    }

    const toCell = (x: number, z: number): Cell => ({
      x: Math.min(Math.max(Math.round((x / WORLD_SIZE + 0.5) * N - 0.5), 4), N - 5),
      z: Math.min(Math.max(Math.round((z / WORLD_SIZE + 0.5) * N - 0.5), 4), N - 5),
    });

    // ---- grade-limited A* ---------------------------------------------------
    const DIRS = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ] as const;
    const gScore = new Float64Array(N * N);
    const came = new Int32Array(N * N);
    // cells within ~16 m of already-built roads: later routes pay to run
    // ALONGSIDE the network (no duplicated corridors — the nearest-segment
    // field flickers between overlapping roads), crossing stays cheap
    const netMask = new Uint8Array(N * N);
    const markCells = (cells: Cell[]): void => {
      for (const c of cells) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = c.x + dx;
            const nz = c.z + dz;
            if (nx >= 0 && nz >= 0 && nx < N && nz < N) netMask[nz * N + nx] = 1;
          }
        }
      }
    };
    const markNetwork = (r: RoadRoute): void => {
      markCells(r.pts.map((p) => toCell(p.x, p.z)));
    };

    // gradeMul: hard-block factor over spec.maxGrade (default 2.2×). The
    // Track C2 asphalt retry ladder (below) calls this again with a relaxed
    // factor before giving up on a leg — see asphaltRetry().
    const route = (from: Cell, to: Cell, spec: RoadClassSpec, gradeMul = 2.2): Cell[] | null => {
      gScore.fill(Infinity);
      came.fill(-1);
      const heap = new Heap();
      const si = from.z * N + from.x;
      const ti = to.z * N + to.x;
      gScore[si] = 0;
      heap.push(si, 0);
      const h = (i: number): number => {
        const x = i % N;
        const z = (i / N) | 0;
        return Math.hypot(x - to.x, z - to.z) * cellM;
      };
      let guard = 0;
      while (heap.size > 0 && guard++ < 2_000_000) {
        const cur = heap.pop();
        if (cur === ti) break;
        const cx = cur % N;
        const cz = (cur / N) | 0;
        const ch = gh[cur] as number;
        for (const [dx, dz, dl] of DIRS) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 3 || nz < 3 || nx >= N - 3 || nz >= N - 3) continue;
          const ni = nz * N + nx;
          const nd = gd[ni] as number;
          if (nd > CLASSIFY.FORD_MAX_DEPTH_M) continue; // deep water: hard block
          const dist = dl * cellM;
          const grade = Math.abs((gh[ni] as number) - ch) / dist;
          // hard block ≈ gradeMul× the class grade (default 2.2×): ragged
          // alpine flanks exceed the design grade on single 8 m steps even
          // where a serpentine is buildable — the quadratic penalty keeps
          // the AVERAGE at the class limit and the profile grade-clamp
          // guarantees the ridden gradient
          if (grade > spec.maxGrade * gradeMul) continue;
          // strong quadratic: pushes the optimum toward LONG shallow
          // contour tacks — wider serpentine sweeps (owner ask), and grades
          // that match real training climbs (avg 6–9%, ramps to the class
          // max — see Climbfinder/AASHTO fact sheet in docs/ROADMAP notes)
          const gk = grade / spec.maxGrade;
          let mult = 1 + 14 * gk * gk;
          // side-hill construction cost (cut/fill volume rises with cross slope)
          mult += 1.2 * Math.max(0, (gs[ni] as number) - grade);
          // fords are possible but expensive → rare, short, perpendicular-ish
          if (nd > CLASSIFY.WATER_MIN_DEPTH_M) mult += 25;
          else if (nd > 0.005) mult += 6; // shoreline margin — don't hug banks
          // running alongside an existing road duplicates the corridor —
          // expensive; crossing it (a few cells) stays affordable
          if (netMask[ni]) mult += 10;
          const tentative = (gScore[cur] as number) + dist * mult;
          if (tentative < (gScore[ni] as number)) {
            gScore[ni] = tentative;
            came[ni] = cur;
            heap.push(ni, tentative + h(ni));
          }
        }
      }
      if (came[ti] < 0 && ti !== si) return null;
      const cells: Cell[] = [];
      for (let i = ti; i >= 0; i = came[i] as number) {
        cells.push({ x: i % N, z: (i / N) | 0 });
        if (i === si) break;
      }
      cells.reverse();
      return cells.length > 1 ? cells : null;
    };

    /**
     * Track C2 retry ladder for ASPHALT legs only (asphalt's maxGrade=0.12
     * is the lowest of all classes, so it's the leg most likely to dead-end
     * on a genuinely hard flank). Rungs, in order — first success wins:
     *   1. same endpoints, hard-block factor relaxed 2.2× → gradeMul
     *      ASPHALT_RETRY_GRADE_MUL (MAX_CUT_FILL only bounds the vertical
     *      profile in buildRoute, not this A* search, so relaxing it would
     *      not help the pathfinder — the grade hard-block IS the A* knob)
     *   2. jittered target cell (± ASPHALT_RETRY_JITTER_CELLS grid cells,
     *      seeded from the 'roads' rng stream — deterministic),
     *      ASPHALT_RETRY_ATTEMPTS attempts at the same relaxed factor
     * Returns null only once every rung has failed; the caller then logs an
     * ASPHALT GAP and falls back to the existing split behaviour.
     */
    const asphaltRetry = (from: Cell, to: Cell, spec: RoadClassSpec): Cell[] | null => {
      const relaxed = route(from, to, spec, ASPHALT_RETRY_GRADE_MUL);
      if (relaxed) return relaxed;
      for (let attempt = 0; attempt < ASPHALT_RETRY_ATTEMPTS; attempt++) {
        const jTo: Cell = {
          x: Math.min(
            Math.max(to.x + (rng.int(ASPHALT_RETRY_JITTER_CELLS * 2 + 1) - ASPHALT_RETRY_JITTER_CELLS), 4),
            N - 5,
          ),
          z: Math.min(
            Math.max(to.z + (rng.int(ASPHALT_RETRY_JITTER_CELLS * 2 + 1) - ASPHALT_RETRY_JITTER_CELLS), 4),
            N - 5,
          ),
        };
        const leg = route(from, jTo, spec, ASPHALT_RETRY_GRADE_MUL);
        if (leg) return leg;
      }
      return null;
    };

    /**
     * Highest terrain reachable from `from` under the class's earthworks
     * limit (BFS on the smoothed grid — same step rule as the A*). This IS
     * where a real mountain road ends: the serpentine climbs until the
     * flank becomes unbuildable. Deterministic; no RNG.
     */
    const highestReachable = (from: Cell, spec: RoadClassSpec): Cell => {
      const lim = spec.maxGrade * 2.2;
      const seen = new Uint8Array(N * N);
      const stack = [from.z * N + from.x];
      seen[stack[0] as number] = 1;
      let best = -Infinity;
      let bi = stack[0] as number;
      const nearWater = (cx: number, cz: number): boolean => {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = Math.min(Math.max(cx + dx, 0), N - 1);
            const nz = Math.min(Math.max(cz + dz, 0), N - 1);
            if ((gd[nz * N + nx] as number) > 0.05) return true;
          }
        }
        return false;
      };
      while (stack.length > 0) {
        const c = stack.pop() as number;
        // the destination must not sit on a tarn shore — smoothing would
        // drag the final bends into the water (found: ridge road tail 30 m
        // deep in the alpine lake)
        if ((gh[c] as number) > best && !nearWater(c % N, (c / N) | 0)) {
          best = gh[c] as number;
          bi = c;
        }
        const cx = c % N;
        const cz = (c / N) | 0;
        for (const [dx, dz, dl] of DIRS) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 3 || nz < 3 || nx >= N - 3 || nz >= N - 3) continue;
          const ni = nz * N + nx;
          if (seen[ni]) continue;
          // no water at all: the serpentine must stay on ITS bank — a
          // "reachable" summit across the river dies at the trench later
          if ((gd[ni] as number) > 0.05) continue;
          if (Math.abs((gh[ni] as number) - (gh[c] as number)) / (dl * cellM) > lim) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      return { x: bi % N, z: (bi / N) | 0 };
    };

    // ---- polyline shaping ---------------------------------------------------
    const chaikin = (pts: number[][], iters: number): number[][] => {
      let p = pts;
      for (let it = 0; it < iters; it++) {
        const q: number[][] = [p[0] as number[]];
        for (let i = 0; i < p.length - 1; i++) {
          const a = p[i] as number[];
          const b = p[i + 1] as number[];
          q.push(
            [(a[0] as number) * 0.75 + (b[0] as number) * 0.25, (a[1] as number) * 0.75 + (b[1] as number) * 0.25],
            [(a[0] as number) * 0.25 + (b[0] as number) * 0.75, (a[1] as number) * 0.25 + (b[1] as number) * 0.75],
          );
        }
        q.push(p[p.length - 1] as number[]);
        p = q;
      }
      return p;
    };

    const resample = (pts: number[][], step: number): number[][] => {
      const out: number[][] = [pts[0] as number[]];
      let carry = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i] as number[];
        const b = pts[i + 1] as number[];
        const seg = Math.hypot((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number));
        let t = step - carry;
        while (t < seg) {
          const k = t / seg;
          out.push([
            (a[0] as number) + ((b[0] as number) - (a[0] as number)) * k,
            (a[1] as number) + ((b[1] as number) - (a[1] as number)) * k,
          ]);
          t += step;
        }
        carry = seg - (t - step);
      }
      out.push(pts[pts.length - 1] as number[]);
      return out;
    };

    const buildRoute = (name: string, spec: RoadClassSpec, cells: Cell[]): RoadRoute => {
      const rawPoly = cells.map((c) => [cw(c.x), cw(c.z)]);
      let poly = chaikin(rawPoly, 3);
      poly = resample(poly, RESAMPLE_M);
      // snap-back: smoothing legally cuts corners, but a cut across a river
      // meander or a tarn bay lands the road in deep water the A* cells
      // never touched — project such points back onto the raw route (real
      // roads break their sweep at a ford, they don't bridge the bend)
      for (const p of poly) {
        const depth = wAtMin(p[0] as number, p[1] as number) - hAt(p[0] as number, p[1] as number);
        if (depth <= CLASSIFY.FORD_MAX_DEPTH_M) continue;
        let bx = p[0] as number;
        let bz = p[1] as number;
        let bd = Infinity;
        for (let i = 0; i < rawPoly.length - 1; i++) {
          const a = rawPoly[i] as number[];
          const b = rawPoly[i + 1] as number[];
          const abx = (b[0] as number) - (a[0] as number);
          const abz = (b[1] as number) - (a[1] as number);
          const len2 = abx * abx + abz * abz || 1;
          const t = Math.min(
            Math.max((((p[0] as number) - (a[0] as number)) * abx + ((p[1] as number) - (a[1] as number)) * abz) / len2, 0),
            1,
          );
          const qx = (a[0] as number) + abx * t;
          const qz = (a[1] as number) + abz * t;
          const d = Math.hypot((p[0] as number) - qx, (p[1] as number) - qz);
          if (d < bd) {
            bd = d;
            bx = qx;
            bz = qz;
          }
        }
        p[0] = bx;
        p[1] = bz;
      }

      const n = poly.length;
      const ys = new Float64Array(n);
      const terrY = new Float64Array(n);
      const ford = new Uint8Array(n);
      const ds = new Float64Array(n); // arclength steps
      for (let i = 0; i < n; i++) {
        const p = poly[i] as number[];
        terrY[i] = hAt(p[0] as number, p[1] as number);
        ys[i] = terrY[i] as number;
        if (i > 0) {
          const q = poly[i - 1] as number[];
          ds[i] = Math.hypot((p[0] as number) - (q[0] as number), (p[1] as number) - (q[1] as number));
        }
      }

      // vertical alignment: iterate {smooth, grade-clamp, soft terrain pull},
      // then a final grade-only clamp — grade wins over cut/fill depth (the
      // carve builds whatever embankment the mismatch needs; Pillar B says
      // the RIDDEN gradient must be real, so it's the invariant here)
      const g = spec.maxGrade;
      const gradeClamp = (): void => {
        for (let i = 1; i < n; i++) {
          const lim = g * (ds[i] as number);
          ys[i] = Math.min(Math.max(ys[i] as number, (ys[i - 1] as number) - lim), (ys[i - 1] as number) + lim);
        }
        for (let i = n - 2; i >= 0; i--) {
          const lim = g * (ds[i + 1] as number);
          ys[i] = Math.min(Math.max(ys[i] as number, (ys[i + 1] as number) - lim), (ys[i + 1] as number) + lim);
        }
      };
      // water floor: on DRY ground a cutting may never sink below the level
      // of adjacent water — the water clipmap would visually flood the road
      // (found: an 8.5 m cut beside the river read as a drowned highway)
      // Active ONLY near actual open water (dry texels hold a bed−2
      // sentinel — treating that as "level" once banned cuttings on ALL dry
      // ground and broke grades everywhere). Window ±6 samples ≈ 84 m:
      // approaches to a crossing may not dip below the water they cross.
      const wetLevel = new Float64Array(n).fill(-Infinity);
      for (let i = 0; i < n; i++) {
        const p = poly[i] as number[];
        const wl = wAt(p[0] as number, p[1] as number);
        if (wl > (terrY[i] as number) - 0.05) {
          for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++) {
            if (wl > (wetLevel[k] as number)) wetLevel[k] = wl;
          }
        }
      }
      const waterFloor = (): void => {
        for (let i = 0; i < n; i++) {
          const wl = wetLevel[i] as number;
          if (wl === -Infinity) continue;
          if ((terrY[i] as number) > wl + 0.05) {
            ys[i] = Math.max(ys[i] as number, Math.min(terrY[i] as number, wl + 0.3));
          }
        }
      };
      for (let pass = 0; pass < 8; pass++) {
        for (let it = 0; it < 4; it++) {
          for (let i = 1; i < n - 1; i++) {
            ys[i] = (ys[i] as number) * 0.5 + ((ys[i - 1] as number) + (ys[i + 1] as number)) * 0.25;
          }
        }
        gradeClamp();
        for (let i = 0; i < n; i++) {
          const t = terrY[i] as number;
          ys[i] = Math.min(Math.max(ys[i] as number, t - MAX_CUT_FILL), t + MAX_CUT_FILL);
        }
        waterFloor();
      }
      for (let k = 0; k < 3; k++) {
        gradeClamp();
        waterFloor();
      }
      // NOTE: no up-only "lift" pass here — it cascaded terrain rises along
      // the route into 20 m walls at water-adjacent barriers. The residual
      // conflict (water floor vs grade near crossings) is confined to the
      // few points around fords; those approaches are legitimately steeper
      // than the class grade (real ford ramps are) and probes exempt them.

      // fords AFTER the final profile: wherever the finished grade line dips
      // under the water table, the crossing is honest — profile drops to the
      // bed there (v1 = fords; bridges are backlog). The check uses waterY
      // directly, so post-carve wet cells can't appear off-ford.
      for (let i = 0; i < n; i++) {
        const p = poly[i] as number[];
        const wy = wAt(p[0] as number, p[1] as number);
        if (wy - (ys[i] as number) > CLASSIFY.WATER_MIN_DEPTH_M * 0.6) {
          ford[i] = 1;
          ys[i] = Math.min(ys[i] as number, terrY[i] as number);
        }
      }

      // superelevation from smoothed curvature (outside of the curve raised)
      const bank = new Float64Array(n);
      for (let i = 1; i < n - 1; i++) {
        const a = poly[i - 1] as number[];
        const b = poly[i] as number[];
        const c = poly[i + 1] as number[];
        const d1x = (b[0] as number) - (a[0] as number);
        const d1z = (b[1] as number) - (a[1] as number);
        const d2x = (c[0] as number) - (b[0] as number);
        const d2z = (c[1] as number) - (b[1] as number);
        const cross = d1x * d2z - d1z * d2x;
        const dth = Math.asin(
          Math.min(Math.max(cross / (Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) + 1e-6), -1), 1),
        );
        const kappa = dth / Math.max(ds[i] as number, 1);
        // κ of a 60 m-radius bend ⇒ full bankMax; straighter scales down
        bank[i] = Math.min(Math.max(-kappa * 60, -1), 1) * spec.bankMax;
      }
      for (let it = 0; it < 6; it++) {
        for (let i = 1; i < n - 1; i++) {
          bank[i] = (bank[i] as number) * 0.5 + ((bank[i - 1] as number) + (bank[i + 1] as number)) * 0.25;
        }
      }

      const pts: RoadPoint[] = [];
      let s = 0;
      for (let i = 0; i < n; i++) {
        s += ds[i] as number;
        const p = poly[i] as number[];
        // LAKE-deep water (> 3 m — river trenches here run 1–2.5 m) for two
        // consecutive samples = a routing artifact (a smoothed bend cutting
        // a tarn), not a crossing — the road honestly ENDS there. River
        // trench touches stay tagged fords; physics punishes bad ones.
        const lakeAt = (k: number): boolean => {
          const q = poly[k] as number[];
          return wAtMin(q[0] as number, q[1] as number) - (ys[k] as number) > 3;
        };
        if (lakeAt(i) && i + 1 < n && lakeAt(i + 1)) {
          const q = poly[i] as number[];
          if (spec.surfaceId === SurfaceId.Asphalt) asphaltCuts++; // Track C2 counter
          console.warn(
            `[roads] ${name} CUT at i=${i}/${n} (${(q[0] as number).toFixed(0)},${(q[1] as number).toFixed(0)}) ` +
              `wMin=${wAtMin(q[0] as number, q[1] as number).toFixed(1)} ys=${(ys[i] as number).toFixed(1)} terr=${(terrY[i] as number).toFixed(1)}`,
          );
          break;
        }
        pts.push({
          x: p[0] as number,
          z: p[1] as number,
          y: ys[i] as number,
          bank: ford[i] ? 0 : (bank[i] as number),
          ford: ford[i] === 1,
          s,
        });
      }
      return { name, cls: spec, pts, length: pts.length > 0 ? (pts[pts.length - 1] as RoadPoint).s : 0 };
    };

    // ---- POIs & route plan --------------------------------------------------
    const jit = (p: [number, number], r: number): [number, number] => [
      p[0] + rng.range(-r, r),
      p[1] + rng.range(-r, r),
    ];
    // valley anchors COME FROM the river polyline — nudge each to the
    // nearest dry, gently-sloped spot so routes never start in the trench
    // (a road head in the river spawned instant "deep ford" tails)
    const dryPoi = (p: [number, number]): [number, number] => {
      let best: [number, number] = p;
      let bestScore = Infinity;
      for (let ri = 0; ri < 4; ri++) {
        const r = 40 + ri * 35;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const c = toCell(p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r);
          const i = c.z * N + c.x;
          const score = (gd[i] as number) > 0.02 ? Infinity : r * 0.01 + (gs[i] as number);
          if (score < bestScore) {
            bestScore = score;
            best = [cw(c.x), cw(c.z)];
          }
        }
        if (bestScore < Infinity) break;
      }
      return best;
    };
    const v = mp.valley;
    const spine0 = dryPoi(v[0] as [number, number]); // NE upper valley (alpine foot)
    const spineHigh = dryPoi(v[1] as [number, number]); // asphalt starts here (≤12% works)
    const spineMid = dryPoi(v[2] as [number, number]);
    const spineLow = dryPoi(v[3] as [number, number]);
    const lakeN = dryPoi([mp.lakeC[0] + mp.lakeR * 0.9, mp.lakeC[1] - mp.lakeR * 0.75]);
    const exitSW: [number, number] = [-1980, 1780];
    const hillA = jit([-820, -760], 90);
    const hillB = jit([-1480, -160], 90);
    const hillC = jit([-360, 1450], 90);
    const karstE = jit([mp.karstC[0] + 380, mp.karstC[1] + 300], 60);
    const spec = (id: SurfaceId): RoadClassSpec =>
      ROAD_CLASSES.find((c) => c.surfaceId === id) as RoadClassSpec;

    // serpentine showcase (owner ask 2026-07-03: good climbs AND descents):
    // start at the massif FOOT (same bank as the climb — crossing the main
    // river trench kills the route), then climb to the HIGHEST flank the
    // class can reach; hairpins emerge from the grade limit on the way up
    // Serpentine start: candidates on BOTH banks (perpendicular ±170 m off
    // the valley axis at v[1]); each candidate BFS-climbs its own bank (the
    // water block keeps it there) — take the pair with the higher summit.
    // Deterministic; the "toward the massif" heuristic failed because the
    // valley axis itself points at the massif (sign was numeric noise).
    const perp = ((): [number, number] => {
      const a = v[0] as [number, number];
      const b = v[2] as [number, number];
      let px = -(b[1] - a[1]);
      let pz = b[0] - a[0];
      const l = Math.hypot(px, pz) || 1;
      return [px / l, pz / l];
    })();
    const p1 = v[1] as [number, number];
    let ridgeStart: [number, number] = p1;
    let ridgeCell: Cell = toCell(p1[0], p1[1]);
    let ridgeTop = -Infinity;
    for (const side of [1, -1]) {
      const cand = dryPoi([p1[0] + perp[0] * 170 * side, p1[1] + perp[1] * 170 * side]);
      const cell = highestReachable(toCell(cand[0], cand[1]), spec(SurfaceId.DirtRoad));
      const top = gh[cell.z * N + cell.x] as number;
      if (top > ridgeTop) {
        ridgeTop = top;
        ridgeStart = cand;
        ridgeCell = cell;
      }
    }
    const ridgeTgt: [number, number] = [cw(ridgeCell.x), cw(ridgeCell.z)];
    console.log(
      `[roads] serpentine: start (${ridgeStart[0].toFixed(0)},${ridgeStart[1].toFixed(0)}) → top (${ridgeTgt[0].toFixed(0)},${ridgeTgt[1].toFixed(0)}) h=${ridgeTop.toFixed(0)}`,
    );

    const plan: { name: string; cls: RoadClassSpec; via: [number, number][] }[] = [
      {
        name: 'valley-highway',
        cls: spec(SurfaceId.Asphalt),
        via: [spineHigh, spineMid, spineLow, lakeN, exitSW],
      },
      {
        // upper valley to the alpine foot — too steep for asphalt (≈12–14%
        // sustained), honest as a coarse mountain road
        name: 'upper-valley-gravel',
        cls: spec(SurfaceId.GravelCoarse),
        via: [spine0, spineHigh],
      },
      {
        name: 'west-hills-gravel',
        cls: spec(SurfaceId.GravelFine),
        via: [spineMid, hillA, hillB, spineLow],
      },
      {
        name: 'south-shore-gravel',
        cls: spec(SurfaceId.GravelCoarse),
        via: [hillA, hillC, lakeN],
      },
      {
        name: 'ridge-dirt',
        cls: spec(SurfaceId.DirtRoad),
        via: [ridgeStart, ridgeTgt],
      },
      {
        name: 'karst-singletrack',
        cls: spec(SurfaceId.Singletrack),
        via: [spineLow, [mp.karstC[0] - 40, mp.karstC[1] - 60], karstE],
      },
      {
        name: 'south-forest-single',
        cls: spec(SurfaceId.Singletrack),
        via: [hillC, jit([340, 1520], 100), jit([700, 1120], 100)],
      },
    ];

    const routes: RoadRoute[] = [];
    const runPlan = (name: string, cls: RoadClassSpec, via: [number, number][]): void => {
      // resilient: an unroutable leg breaks the chain but keeps the rest —
      // contiguous successful legs become their own route part
      let cells: Cell[] = [];
      let part = 0;
      const flush = (): void => {
        if (cells.length > 3) {
          const r = buildRoute(part === 0 ? name : `${name}-${part}`, cls, cells);
          if (r.pts.length > 3) {
            routes.push(r);
            markNetwork(r);
            part++;
          }
        }
        cells = [];
      };
      // Track C2: asphalt is a single fragile route (maxGrade 0.12, lowest of
      // all classes) — a silent split there is a physical gap in THE road,
      // not a side trail, so it gets the retry ladder before falling back
      // to the existing split behaviour that every other class still uses.
      const isAsphalt = cls.surfaceId === SurfaceId.Asphalt;
      for (let i = 0; i < via.length - 1; i++) {
        const fromC = toCell(...(via[i] as [number, number]));
        const toC = toCell(...(via[i + 1] as [number, number]));
        let leg = route(fromC, toC, cls);
        if (!leg && isAsphalt) leg = asphaltRetry(fromC, toC, cls);
        if (!leg) {
          const from = (via[i] as number[]).map((val) => val.toFixed(0)).join(',');
          const to = (via[i + 1] as number[]).map((val) => val.toFixed(0)).join(',');
          if (isAsphalt) {
            asphaltGaps++;
            console.error(
              `[roads] ASPHALT GAP ${name}[${i}]: (${from}) → (${to}) — retry ladder exhausted ` +
                `(relaxed grade ${ASPHALT_RETRY_GRADE_MUL}× + ${ASPHALT_RETRY_ATTEMPTS} jittered targets), falling back to split`,
            );
          } else {
            console.warn(`[roads] unroutable leg ${name}[${i}]: (${from}) → (${to})`);
          }
          flush();
          continue;
        }
        // trim tails that lie ON the existing network (keep one cell for the
        // junction touch) — a leg starting from a shared anchor otherwise
        // re-draws the other road's corridor before diverging
        const onNet = (c: Cell): boolean => netMask[c.z * N + c.x] === 1;
        let a = 0;
        while (a < leg.length - 1 && onNet(leg[a] as Cell) && onNet(leg[a + 1] as Cell)) a++;
        let b = leg.length - 1;
        while (b > a + 1 && onNet(leg[b] as Cell) && onNet(leg[b - 1] as Cell)) b--;
        leg = leg.slice(Math.max(0, a - 1), b + 2);
        if (leg.length < 3) continue;
        // mark IMMEDIATELY: the next leg of this same plan must not ride
        // back along this corridor (self-duplicated centerlines carve two
        // different profiles into one roadbed — found via probe conformance)
        markCells(leg);
        cells.push(...(cells.length > 0 ? leg.slice(1) : leg));
      }
      flush();
    };
    for (const p of plan) runPlan(p.name, p.cls, p.via);

    // top up to the ≥30 km floor with extra hill loops (deterministic order)
    const extraAnchors: [number, number][] = [hillA, hillB, hillC, spineMid, spineLow, lakeN];
    let extra = 0;
    while (routes.reduce((a, r) => a + r.length, 0) < TARGET_KM * 1000 && extra < 8) {
      const a = extraAnchors[extra % extraAnchors.length] as [number, number];
      const b = jit(
        [rng.range(-1500, 800), rng.range(-1100, 1500)],
        60,
      );
      const cls = spec(extra % 2 === 0 ? SurfaceId.GravelCoarse : SurfaceId.DirtRoad);
      runPlan(`link-${extra}`, cls, [a, b]);
      extra++;
    }

    return new RoadNetwork(routes, { asphaltGaps, asphaltCuts });
  }
}
