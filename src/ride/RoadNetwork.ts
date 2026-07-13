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
import { LAKE_LEVEL, TREELINE, WORLD_SIZE } from '../world/WorldConst';
import { computeRoadGridBand, type RoadGridJob } from './RoadGridWorker';
import { traceScenicContours, type ScenicPolyline } from './ScenicContours';
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
    // alpine p.1 (ref-01): micro-displacement of the surfaced tread competes
    // with the 3–8 cm road-pebble geometry now scattered on it — halved so
    // the loose grit reads, not the polygonal camber wobble
    dispScale: 0.25,
  },
  {
    surfaceId: SurfaceId.DirtRoad,
    name: 'dirt-road',
    halfWidth: 1.8, // graded doubletrack
    maxGrade: 0.16,
    bankMax: 0.02,
    crownSlope: 0.015,
    dispScale: 0.2, // alpine p.1: yield the tread to the scattered grit (see gravel-coarse)
  },
  {
    surfaceId: SurfaceId.Singletrack,
    name: 'singletrack',
    halfWidth: 0.55, // 1.1 m worn tread (IMBA bench-cut 0.6–0.9 m + verge)
    maxGrade: 0.2, // IMBA: >18–20% sustained = hike-a-bike; ramps only
    bankMax: 0.03,
    crownSlope: 0,
    dispScale: 0.35, // alpine p.1: yield the tread to the scattered grit (see gravel-coarse)
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
  /** hydrology moisture 0..1 at sim res (FlowRivers) — wetland/mud signal */
  moisture: Float32Array;
  /** carved river/pond depth (m) at sim res (FlowRivers) — silt-bed signal */
  riverDepth: Float32Array;
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
  /**
   * P.5 v2 scenic contour polylines (ScenicContours) — DECORATIVE only.
   * Baked by ScenicField into a signed-distance band the terrain material
   * tints at mid/far camera distances; no carve, no stamp, no physics.
   */
  readonly scenic: ScenicPolyline[];

  private constructor(
    routes: RoadRoute[],
    counters: { asphaltGaps: number; asphaltCuts: number } = { asphaltGaps: 0, asphaltCuts: 0 },
    scenic: ScenicPolyline[] = [],
  ) {
    this.routes = routes;
    this.totalLength = routes.reduce((a, r) => a + r.length, 0);
    this.counters = counters;
    this.scenic = scenic;
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

    // MUD/WETLAND avoidance (owner 2026-07-06, дословно: «тоненькие
    // малюсенькие дорожки среди грязи»). A flat wetland reads as the CHEAPEST
    // terrain for the A* (grade≈0 ⇒ mult≈1), so roads were magnetically drawn
    // INTO the bogs and rendered as thin dirt ribbons winding across the mud.
    // A previous attempt penalized water PROXIMITY (ground < 2.5 m over the
    // local water table) — it missed the actual defect because the mud on the
    // repro flats is MOISTURE-driven (Biome.Wetland), not water-adjacent.
    // This mask replicates the classifier's wetland-mud predicate
    // (BiomeSnow.ts isWetland ∧ SurfaceClassify mud override): moisture above
    // MUD_MOISTURE on near-flat ground below the wetland altitude ceiling.
    // Costs: crossing a bog is as expensive as a deep-water ford (+MUD_PEN),
    // the dilated margin ring gets half — routes stay on dry valley sides and
    // only cross a marsh where topology leaves no alternative.
    const gmud = new Float32Array(N * N);
    const MUD_PEN = 34;
    {
      const mAt = (x: number, z: number): number =>
        bilerp(terr.moisture, terr.simRes, x, z);
      const rdAt = (x: number, z: number): number =>
        bilerp(terr.riverDepth, terr.simRes, x, z);
      const core = new Uint8Array(N * N);
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          const i = z * N + x;
          const flat = (gs[i] as number) < CLASSIFY.MUD_MAX_SLOPE + 0.1;
          if (!flat) continue;
          // (a) wetland-biome mud: BiomeSnow isWetland ∧ classify override
          const wetland =
            (gh[i] as number) < LAKE_LEVEL + 75 &&
            mAt(cw(x), cw(z)) > CLASSIFY.MUD_MOISTURE - 0.05;
          // (b) exposed pond-silt beds (classify pondK ⇒ Mud, ANY altitude):
          // smoothstep(1.1, 2.6, riverDepth) on near-flat ground — the repro
          // flats at ~250 m are THIS mud, not wetland (found iteration 1)
          const silt = rdAt(cw(x), cw(z)) > 1.0;
          if (wetland || silt) {
            core[i] = 1;
          }
        }
      }
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          let m = 0;
          for (let dz = -1; dz <= 1 && m < 2; dz++) {
            for (let dx = -1; dx <= 1 && m < 2; dx++) {
              const xx = Math.min(Math.max(x + dx, 0), N - 1);
              const zz = Math.min(Math.max(z + dz, 0), N - 1);
              if (core[zz * N + xx]) m = dx === 0 && dz === 0 ? 2 : Math.max(m, 1);
            }
          }
          gmud[z * N + x] = m === 2 ? MUD_PEN : m === 1 ? MUD_PEN * 0.5 : 0;
        }
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
      // guard sized for penalty-heavy searches: the mud/side-hill cost fields
      // make h() a deep underestimate, so A* legitimately expands most of the
      // 512² grid (with lazy-deletion re-pushes) before proving a detour —
      // 2M was exhausted mid-search and reported healthy legs "unroutable"
      let guard = 0;
      while (heap.size > 0 && guard++ < 12_000_000) {
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
          // side-hill construction cost (cut/fill volume rises with cross
          // slope); quadratic tail = cliff faces are near-prohibitive (owner
          // repro: a dirt thread traversing bare rock walls read as "палка")
          const side = Math.max(0, (gs[ni] as number) - grade);
          mult += 1.2 * side + 10 * side * side;
          // fords are possible but expensive → rare, short, perpendicular-ish
          if (nd > CLASSIFY.WATER_MIN_DEPTH_M) mult += 25;
          else if (nd > 0.005) mult += 6; // shoreline margin — don't hug banks
          mult += gmud[ni] as number; // boggy wetland mud — stay on dry ground
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
      if (came[ti] < 0 && ti !== si) {
        if (guard >= 12_000_000) {
          console.warn(
            `[roads] A* guard exhausted (${guard} pops) — leg reported unroutable while the search was still open`,
          );
        }
        return null;
      }
      const cells: Cell[] = [];
      for (let i = ti; i >= 0; i = came[i] as number) {
        cells.push({ x: i % N, z: (i / N) | 0 });
        if (i === si) break;
      }
      cells.reverse();
      return cells.length > 1 ? cells : null;
    };

    /**
     * Track C2 retry ladder (born for asphalt, now the fallback for EVERY
     * class — a mud-aware anchor can land any leg in a grade-enclosed
     * pocket). Rungs, in order — first success wins:
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

    // ---- alignment shaping (owner 2026-07-06: «минимум 20 м от поворота до
    // поворота ВСЕГДА; на шоссе лучше участки 100–500 м без поворотов»). The
    // A* walks an 8-connected 8 m lattice — its raw polyline is a staircase
    // of 8 m micro-turns that Chaikin only ROUNDS, never removes. Fix at the
    // source: Douglas-Peucker straightens the lattice noise into real
    // tangents (eps per class), then a turn-spacing pass guarantees the
    // minimum straight run between direction changes; Chaikin afterwards
    // rounds only the surviving, honest corners.
    /**
     * chord validity: a straightened segment may not bridge deep water or
     * demand impossible earthworks. The A* wiggled around those obstacles on
     * purpose — DP/turn-spacing must not chord across them (iteration-1
     * lesson: a straightened serpentine bend entered a tarn and CUT the
     * route; a valley chord dived under the water table).
     */
    const chordSafe = (A: number[], B: number[], maxGrade: number): boolean => {
      const ax = A[0] as number;
      const az = A[1] as number;
      const bx = B[0] as number;
      const bz = B[1] as number;
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(2, Math.ceil(len / 6));
      // FULL-RES heights: the smoothed router grid underestimates gullies
      // and spurs by metres — chords vetted on it still dove the profile
      // ~10 m under the real terrain (iteration-3 lesson)
      const hA = hAt(ax, az);
      const hB = hAt(bx, bz);
      // net grade: the A* zigzags EXIST to hold the class grade — a chord
      // that replaces them must be ridable itself, or the vertical profile
      // dives under the terrain and triggers false lake-CUTs (iter 2)
      if (Math.abs(hB - hA) / Math.max(len, 1) > maxGrade) return false;
      let hPrev = hA;
      const stepLen = len / steps;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const c = toCell(px, pz);
        const i = c.z * N + c.x;
        if ((gd[i] as number) > CLASSIFY.FORD_MAX_DEPTH_M) return false;
        const hHere = hAt(px, pz);
        if (Math.abs(hHere - (hA + (hB - hA) * t)) > MAX_CUT_FILL) return false;
        // sampled grade along the chord: reject sustained over-grade runs
        // the profile clamp could only absorb with deep cuts (2× tolerance
        // for full-res micro-noise at 6 m steps)
        if (Math.abs(hHere - hPrev) / Math.max(stepLen, 1) > maxGrade * 2) return false;
        hPrev = hHere;
      }
      return true;
    };

    const simplifyDP = (pts: number[][], eps: number, maxGrade: number): number[][] => {
      if (pts.length <= 2) return pts;
      const keep = new Uint8Array(pts.length);
      keep[0] = 1;
      keep[pts.length - 1] = 1;
      const stack: [number, number][] = [[0, pts.length - 1]];
      while (stack.length > 0) {
        const [a, b] = stack.pop() as [number, number];
        if (b - a < 2) continue;
        const A = pts[a] as number[];
        const B = pts[b] as number[];
        const abx = (B[0] as number) - (A[0] as number);
        const abz = (B[1] as number) - (A[1] as number);
        const len2 = abx * abx + abz * abz || 1;
        let mi = -1;
        let md = -1;
        for (let i = a + 1; i < b; i++) {
          const P = pts[i] as number[];
          const t = Math.min(
            Math.max((((P[0] as number) - (A[0] as number)) * abx + ((P[1] as number) - (A[1] as number)) * abz) / len2, 0),
            1,
          );
          const d = Math.hypot(
            (P[0] as number) - (A[0] as number) - abx * t,
            (P[1] as number) - (A[1] as number) - abz * t,
          );
          if (d > md) {
            md = d;
            mi = i;
          }
        }
        // keep the worst deviator when it exceeds eps — OR when dropping the
        // whole span would chord across water/over-grade/unbuildable ground
        if (mi >= 0 && (md > eps || !chordSafe(A, B, maxGrade))) {
          keep[mi] = 1;
          stack.push([a, mi], [mi, b]);
        }
      }
      return pts.filter((_, i) => keep[i] === 1);
    };

    /** unsigned direction change at interior vertex i (rad) */
    const turnAt = (pts: number[][], i: number): number => {
      const a = pts[i - 1] as number[];
      const b = pts[i] as number[];
      const c = pts[i + 1] as number[];
      const d1x = (b[0] as number) - (a[0] as number);
      const d1z = (b[1] as number) - (a[1] as number);
      const d2x = (c[0] as number) - (b[0] as number);
      const d2z = (c[1] as number) - (b[1] as number);
      const dot = d1x * d2x + d1z * d2z;
      const l = Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) || 1;
      return Math.acos(Math.min(Math.max(dot / l, -1), 1));
    };

    const TURN_MIN_RAD = 0.14; // < ~8° between tangents = not a turn
    const enforceTurnSpacing = (pts: number[][], minGap: number, maxGrade: number): number[][] => {
      /** removal is only legal when the resulting chord is buildable */
      const removable = (p: number[][], i: number): boolean =>
        chordSafe(p[i - 1] as number[], p[i + 1] as number[], maxGrade);
      const p = pts.slice();
      for (let guard = 0; guard < 8000 && p.length > 2; guard++) {
        // 1) drop pseudo-turns (residual lattice noise below the threshold)
        let weakest = -1;
        let weakestA = TURN_MIN_RAD;
        for (let i = 1; i < p.length - 1; i++) {
          const a = turnAt(p, i);
          if (a < weakestA && removable(p, i)) {
            weakestA = a;
            weakest = i;
          }
        }
        if (weakest >= 0) {
          p.splice(weakest, 1);
          continue;
        }
        // 2) closest under-spaced pair of consecutive turns → drop the
        //    weaker of the two (hairpin apexes survive; jitter dies);
        //    obstacle-pinned vertices are exempt — the wiggle is honest
        let progress = false;
        for (let i = 1; i < p.length - 2; i++) {
          const a = p[i] as number[];
          const b = p[i + 1] as number[];
          if (Math.hypot((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number)) >= minGap) continue;
          const weakFirst = turnAt(p, i) < turnAt(p, i + 1);
          const order = weakFirst ? [i, i + 1] : [i + 1, i];
          for (const v of order) {
            if (removable(p, v)) {
              p.splice(v, 1);
              progress = true;
              break;
            }
          }
          // obstacle-locked pair: merge both bends into ONE point when the
          // merged chords are buildable — an S-jitter becomes a single
          // sweep. Try several positions along the pair; near water the
          // midpoint is often blocked while an off-center point is fine.
          if (!progress) {
            for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
              const mid = [
                (a[0] as number) * (1 - t) + (b[0] as number) * t,
                (a[1] as number) * (1 - t) + (b[1] as number) * t,
              ];
              if (
                chordSafe(p[i - 1] as number[], mid, maxGrade) &&
                chordSafe(mid, p[i + 2] as number[], maxGrade)
              ) {
                p.splice(i, 2, mid);
                progress = true;
                break;
              }
            }
          }
          if (progress) break;
        }
        if (!progress) break;
      }
      return p;
    };

    /** per-class shaping: eps = how much lattice noise to straighten (m),
     *  gap = minimum spacing between turn VERTICES (m). Chaikin rounds each
     *  bend into ±25% of the adjacent segments, so the CLEAR straight
     *  between two finished arcs is ≈ gap/2 — sized so that clear run meets
     *  the owner floor of 20 m everywhere (asphalt: 100–500 m straights). */
    const shapeOf = (id: SurfaceId): { eps: number; gap: number } => {
      switch (id) {
        case SurfaceId.Asphalt:
          return { eps: 14, gap: 130 };
        case SurfaceId.GravelFine:
          return { eps: 10, gap: 56 };
        case SurfaceId.GravelCoarse:
          return { eps: 9, gap: 54 };
        case SurfaceId.DirtRoad:
          return { eps: 7, gap: 50 };
        default:
          return { eps: 4, gap: 44 };
      }
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
      // straighten lattice noise, enforce the turn-spacing floor, THEN round:
      // Chaikin on the shaped tangents produces sweeping engineered curves
      // instead of rounding every 8 m stair-step into a wiggle
      const shape = shapeOf(spec.surfaceId);
      let poly = simplifyDP(rawPoly, shape.eps, spec.maxGrade);
      poly = enforceTurnSpacing(poly, shape.gap, spec.maxGrade);
      poly = chaikin(poly, 3);
      poly = resample(poly, RESAMPLE_M);
      // snap-back: smoothing legally cuts corners, but a cut across a river
      // meander or a tarn bay lands the road in deep water the A* cells
      // never touched — project such points back onto the raw route (real
      // roads break their sweep at a ford, they don't bridge the bend)
      const snapped = new Set<number>();
      for (const [pi, p] of poly.entries()) {
        const depth = wAtMin(p[0] as number, p[1] as number) - hAt(p[0] as number, p[1] as number);
        if (depth <= CLASSIFY.FORD_MAX_DEPTH_M) continue;
        snapped.add(pi);
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
      // relax the snap-back kinks: projection makes a sharp S within ~2
      // samples — the under-20 m "double turn" defect. Laplacian-relax the
      // moved points (+1 neighbor each side), accepting a step only while
      // it stays out of deep water (same gate the snap-back enforces).
      if (snapped.size > 0) {
        const zone = new Set<number>();
        for (const k of snapped) {
          zone.add(k);
          if (k > 0) zone.add(k - 1);
          if (k < poly.length - 1) zone.add(k + 1);
        }
        for (let it = 0; it < 4; it++) {
          for (const k of zone) {
            if (k <= 0 || k >= poly.length - 1) continue;
            const a = poly[k - 1] as number[];
            const b = poly[k] as number[];
            const c = poly[k + 1] as number[];
            const rx = (b[0] as number) * 0.5 + ((a[0] as number) + (c[0] as number)) * 0.25;
            const rz = (b[1] as number) * 0.5 + ((a[1] as number) + (c[1] as number)) * 0.25;
            if (wAtMin(rx, rz) - hAt(rx, rz) <= CLASSIFY.FORD_MAX_DEPTH_M) {
              b[0] = rx;
              b[1] = rz;
            }
          }
        }
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
        // REAL water only (wAtMin above the terrain): dry texels hold a
        // bed−2 sentinel, and a deep profile cut under DRY ground once read
        // as "3 m under a lake" — false CUTs truncated healthy routes and
        // collapsed the network to 19 km (found 2026-07-06).
        const lakeAt = (k: number): boolean => {
          const q = poly[k] as number[];
          const wm = wAtMin(q[0] as number, q[1] as number);
          return (
            wm - (ys[k] as number) > 3 &&
            wm > hAt(q[0] as number, q[1] as number) + 0.05
          );
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
          // flat bog margins used to WIN this score (gs≈0) and anchored whole
          // routes inside the mud — exclude them like open water
          const score =
            (gd[i] as number) > 0.02 || (gmud[i] as number) > 0
              ? Infinity
              : r * 0.01 + (gs[i] as number);
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
    // hill anchors go through dryPoi too: a raw jitter point on a trench lip
    // or a bog is a dead target every plan through it inherits
    const hillA = dryPoi(jit([-820, -760], 90));
    const hillB = dryPoi(jit([-1480, -160], 90));
    const hillC = dryPoi(jit([-360, 1450], 90));
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
    // a serpentine that gains no real height is a pointless squiggle on a
    // flat — only build the showcase climb when the flank actually rises
    const ridgeStartCell = toCell(ridgeStart[0], ridgeStart[1]);
    const ridgeClimb = ridgeTop - (gh[ridgeStartCell.z * N + ridgeStartCell.x] as number);
    const SERPENTINE_MIN_CLIMB = 60;
    console.log(
      `[roads] serpentine: start (${ridgeStart[0].toFixed(0)},${ridgeStart[1].toFixed(0)}) → top (${ridgeTgt[0].toFixed(0)},${ridgeTgt[1].toFixed(0)}) h=${ridgeTop.toFixed(0)} climb=${ridgeClimb.toFixed(0)}`,
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
      ...(ridgeClimb >= SERPENTINE_MIN_CLIMB
        ? [
            {
              name: 'ridge-dirt',
              cls: spec(SurfaceId.DirtRoad),
              via: [ridgeStart, ridgeTgt] as [number, number][],
            },
          ]
        : []),
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
      // length floor in METERS (owner: no micro-routes) — split leftovers and
      // link stubs shorter than a real riding leg are dropped, not built
      const minLenM =
        cls.surfaceId === SurfaceId.Asphalt ||
        cls.surfaceId === SurfaceId.GravelFine ||
        cls.surfaceId === SurfaceId.GravelCoarse
          ? 150
          : 80;
      const flush = (): void => {
        if (cells.length > 3) {
          const r = buildRoute(part === 0 ? name : `${name}-${part}`, cls, cells);
          if (r.pts.length > 3 && r.length >= minLenM) {
            routes.push(r);
            markNetwork(r);
            part++;
          } else if (r.pts.length > 0) {
            console.warn(
              `[roads] drop stub ${r.name}: ${r.length.toFixed(0)} m < ${minLenM} m floor`,
            );
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
        // retry ladder for EVERY class (was asphalt-only): mud-aware dryPoi
        // can shift an anchor into a grade-enclosed pocket; the relaxed
        // hard-block + jittered targets escape it (upper-valley leg died
        // this way — found on the 2026-07-06 repro seed)
        if (!leg) leg = asphaltRetry(fromC, toC, cls);
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

    // top up to the ≥30 km floor with extra hill loops (deterministic order).
    // Targets carry a MIN SPAN from their anchor (no 100 m link stubs) and
    // must not land in open water or a bog (a mud target forces the entire
    // tail of the route into the marsh no matter what the A* costs say).
    const extraAnchors: [number, number][] = [hillA, hillB, hillC, spineMid, spineLow, lakeN];
    const LINK_MIN_SPAN = 600;
    let extra = 0;
    // cap 12 (was 8): anchors on hydrology islands legitimately fail their
    // link, and the km floor still has to be met by the surviving ones
    while (routes.reduce((a, r) => a + r.length, 0) < TARGET_KM * 1000 && extra < 12) {
      const a = extraAnchors[extra % extraAnchors.length] as [number, number];
      let b: [number, number] | null = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const cand = jit([rng.range(-1500, 800), rng.range(-1100, 1500)], 60);
        if (Math.hypot(cand[0] - a[0], cand[1] - a[1]) < LINK_MIN_SPAN) continue;
        const c = toCell(cand[0], cand[1]);
        const ci = c.z * N + c.x;
        if ((gd[ci] as number) > 0.02 || (gmud[ci] as number) > 0) continue;
        b = cand;
        break;
      }
      if (b) {
        const cls = spec(extra % 2 === 0 ? SurfaceId.GravelCoarse : SurfaceId.DirtRoad);
        runPlan(`link-${extra}`, cls, [a, b]);
      }
      extra++;
    }

    // ---- P.5 contour traverses (ref-04): green flanks are lined with
    // near-level paths riding the height isolines — several per slope at
    // distinct elevations. No A* here: the path is traced directly by
    // stepping PERPENDICULAR to the height gradient with light direction
    // smoothing and a small per-slope ±2–4% drift, aborting on water, rock
    // (slope > 0.75), mud, the treeline or the world edge. The traced cells
    // then go through buildRoute like every other class, so the profile
    // (smoothed + grade-clamped + terrain-pulled ys) and the carve/bake/
    // stamp pipeline — and with them the conformance law — apply unchanged.
    // Runs AFTER the km top-up so contours ADD to the network instead of
    // eating the link-road budget.
    {
      const single = spec(SurfaceId.Singletrack);
      const gAt = (x: number, z: number): number => bilerp(gh, N, x, z);
      const mAt = (x: number, z: number): number => bilerp(terr.moisture, terr.simRes, x, z);
      const SLOPE_MIN = 0.16; // gentler ground has no reason for a bench
      const SLOPE_MAX = 0.72; // steeper reads as scree/rock, not meadow
      const ROCK_SLOPE = 0.75; // trace hard-stop (cliff band)
      const CONTOUR_MAX_ROUTES = 6;
      const CONTOUR_LEN_CAP_M = 4800; // m, total across all slopes
      const inWorld = (x: number, z: number): boolean =>
        Math.abs(x) < WORLD_SIZE / 2 - 60 && Math.abs(z) < WORLD_SIZE / 2 - 60;

      /** buildable green-hillside cell (anchor scoring predicate) */
      const okCell = (cx: number, cz: number): boolean => {
        if (cx < 4 || cz < 4 || cx >= N - 4 || cz >= N - 4) return false;
        const i = cz * N + cx;
        const s = gs[i] as number;
        const h = gh[i] as number;
        return (
          s >= SLOPE_MIN &&
          s <= SLOPE_MAX &&
          h > LAKE_LEVEL + 15 &&
          h < TREELINE - 20 &&
          (gd[i] as number) <= 0.02 &&
          (gmud[i] as number) === 0
        );
      };
      /** trace-time gate: looser slope band (crossing a local flat/steep
       *  ripple mid-traverse is honest), hard stops per the ref brief.
       *  netMask: never trace ALONG an existing corridor — a genuine
       *  crossing survives because the step is 12-20 m and only the
       *  on-network cell breaks. */
      const traceOkAt = (x: number, z: number): boolean => {
        if (!inWorld(x, z)) return false;
        const c = toCell(x, z);
        const i = c.z * N + c.x;
        return (
          (gd[i] as number) <= 0.02 &&
          (gmud[i] as number) === 0 &&
          (gs[i] as number) <= ROCK_SLOPE &&
          (gh[i] as number) < TREELINE - 5 &&
          (gh[i] as number) > LAKE_LEVEL + 8 &&
          netMask[i] !== 1
        );
      };

      // anchor scan: coarse lattice; score = qualifying fraction of a ±96 m
      // neighbourhood (a broad flank, not a lone bump) gated on moisture —
      // the ref slopes are GREEN meadow, not dry scree
      const cand: { x: number; z: number; score: number }[] = [];
      for (let cz = 16; cz < N - 16; cz += 4) {
        for (let cx = 16; cx < N - 16; cx += 4) {
          if (!okCell(cx, cz) || netMask[cz * N + cx]) continue;
          if (mAt(cw(cx), cw(cz)) < 0.12) continue;
          let ok = 0;
          let tot = 0;
          for (let dz = -12; dz <= 12; dz += 4) {
            for (let dx = -12; dx <= 12; dx += 4) {
              tot++;
              if (okCell(cx + dx, cz + dz)) ok++;
            }
          }
          const score = ok / tot;
          if (score >= 0.42) cand.push({ x: cx, z: cz, score });
        }
      }
      // deterministic order: best coverage first, grid order breaks ties
      cand.sort((a, b) => b.score - a.score || a.z - b.z || a.x - b.x);
      const anchors: { x: number; z: number }[] = [];
      const SEP_CELLS = 700 / cellM; // distinct slopes, not one flank twice
      for (const c of cand) {
        if (anchors.length >= 3) break;
        if (anchors.some((a) => Math.hypot(a.x - c.x, a.z - c.z) < SEP_CELLS)) continue;
        anchors.push(c);
      }

      /** smoothed-field gradient (16 m central differences — the same field
       *  the router grades on, so the isoline is stable, not micro-noise) */
      const gradAt = (x: number, z: number): [number, number] => [
        (gAt(x + 8, z) - gAt(x - 8, z)) / 16,
        (gAt(x, z + 8) - gAt(x, z - 8)) / 16,
      ];

      /** one direction of a traverse: step ⟂ to the gradient, blend 60/40
       *  with the previous heading, pull back onto the (drifting) isoline */
      const traceHalf = (
        sx: number,
        sz: number,
        dirSign: 1 | -1,
        drift: number,
        stepM: number,
        maxLen: number,
      ): number[][] => {
        const out: number[][] = [];
        let x = sx;
        let z = sz;
        let targetH = gAt(sx, sz);
        let px = 0;
        let pz = 0;
        let len = 0;
        while (len < maxLen) {
          const [gx, gz] = gradAt(x, z);
          const gl = Math.hypot(gx, gz);
          if (gl < 0.045 || gl > ROCK_SLOPE) break; // flank faded / cliff band
          const ux = gx / gl; // uphill unit
          const uz = gz / gl;
          let ex = -uz; // isoline direction (⟂ gradient)
          let ez = ux;
          if (out.length === 0) {
            ex *= dirSign;
            ez *= dirSign;
          } else if (ex * px + ez * pz < 0) {
            ex = -ex;
            ez = -ez;
          }
          let dx = px !== 0 || pz !== 0 ? px * 0.6 + ex * 0.4 : ex;
          let dz = px !== 0 || pz !== 0 ? pz * 0.6 + ez * 0.4 : ez;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl;
          dz /= dl;
          // step, then correct along the gradient onto the drifting isoline
          targetH += drift * stepM;
          let nx = x + dx * stepM;
          let nz = z + dz * stepM;
          const corr = Math.min(Math.max((targetH - gAt(nx, nz)) / gl, -6), 6);
          nx += ux * corr;
          nz += uz * corr;
          if (!traceOkAt(nx, nz)) break;
          len += Math.hypot(nx - x, nz - z);
          const hl = Math.hypot(nx - x, nz - z) || 1;
          px = (nx - x) / hl;
          pz = (nz - z) / hl;
          x = nx;
          z = nz;
          out.push([x, z]);
        }
        return out;
      };

      /** walk the gradient from the anchor to the level's target height */
      const seekHeight = (sx: number, sz: number, hTgt: number): [number, number] | null => {
        let x = sx;
        let z = sz;
        for (let it = 0; it < 40; it++) {
          const h = gAt(x, z);
          if (Math.abs(h - hTgt) < 2) return traceOkAt(x, z) ? [x, z] : null;
          const [gx, gz] = gradAt(x, z);
          const gl = Math.hypot(gx, gz);
          if (gl < 0.08) return null; // ran off the flank before the level
          const climb = Math.min(Math.max((hTgt - h) / gl, -14), 14);
          x += (gx / gl) * climb;
          z += (gz / gl) * climb;
          if (!inWorld(x, z)) return null;
        }
        return null;
      };

      let contourLen = 0;
      let contourCount = 0;
      for (const [si, a] of anchors.entries()) {
        if (contourCount >= CONTOUR_MAX_ROUTES || contourLen >= CONTOUR_LEN_CAP_M) break;
        const ax = cw(a.x);
        const az = cw(a.z);
        const h0 = gh[a.z * N + a.x] as number;
        const nLevels = 2 + rng.int(2); // 2–3 elevation bands per slope
        // one drift sign per SLOPE: parallel levels drift together, so the
        // ≥ 48 m vertical spacing (⇒ ≥ 80 m horizontal at slope 0.6) holds
        // along the whole traverse — no converging/JOIN_R-touching pairs
        const vStep = rng.range(48, 78);
        const drift = (rng.range(0, 1) < 0.5 ? -1 : 1) * rng.range(0.02, 0.04);
        const stepM = rng.range(12, 20);
        for (let li = 0; li < nLevels; li++) {
          if (contourCount >= CONTOUR_MAX_ROUTES || contourLen >= CONTOUR_LEN_CAP_M) break;
          const hTgt = h0 + (li - (nLevels - 1) / 2) * vStep;
          const start = seekHeight(ax, az, hTgt);
          if (!start) continue;
          const targetLen = rng.range(300, 900);
          const back = traceHalf(start[0], start[1], -1, -drift, stepM, targetLen / 2);
          const fwd = traceHalf(start[0], start[1], 1, drift, stepM, targetLen / 2);
          const pts = [...back.reverse(), [start[0], start[1]], ...fwd];
          // world points → router cells (dedupe consecutive) for buildRoute
          const ccells: Cell[] = [];
          for (const p of pts) {
            const c = toCell(p[0] as number, p[1] as number);
            const prev = ccells[ccells.length - 1];
            if (!prev || prev.x !== c.x || prev.z !== c.z) ccells.push(c);
          }
          if (ccells.length < 5) continue;
          const r = buildRoute(`contour-${si}-${li}`, single, ccells);
          // stubs (trace hit water/rock early) are dropped, not built
          if (r.pts.length > 3 && r.length >= 140) {
            routes.push(r);
            markNetwork(r);
            contourLen += r.length;
            contourCount++;
          }
        }
      }
      console.log(
        `[roads] contour traverses: ${contourCount} route(s), ${(contourLen / 1000).toFixed(2)} km ` +
          `over ${anchors.length} slope(s) [${anchors.map((a) => `(${cw(a.x).toFixed(0)},${cw(a.z).toFixed(0)})`).join(' ')}]`,
      );
    }

    // ---- P.5 v2 scenic macro-isolines (advisor 2026-07-13, ref-04): long
    // DECORATIVE contour bands extracted from a further-smoothed planning
    // field — marching squares over the FULL grid, obstacle criteria
    // evaluated along the polyline with run-length tolerances, then a
    // best-line + neighbouring-levels family per flank (3–6 lines). Purely
    // visual: ScenicField bakes them for the terrain material; no carve, no
    // stamp, no physics. Runs LAST so netMask covers the whole network
    // (parallel-to-road overlap is penalized in the window score).
    const scenic = traceScenicContours({ n: N, gh, gs, gd, gmud, netMask });
    if (scenic.length > 0) {
      const km = scenic.reduce((a, s) => a + s.length, 0) / 1000;
      console.log(
        `[roads] scenic contours: ${scenic.length} band(s), ${km.toFixed(2)} km, ` +
          `levels [${scenic.map((s) => s.level.toFixed(0)).join(' ')}] m`,
      );
    } else {
      console.log('[roads] scenic contours: none qualified');
    }

    return new RoadNetwork(routes, { asphaltGaps, asphaltCuts }, scenic);
  }
}
