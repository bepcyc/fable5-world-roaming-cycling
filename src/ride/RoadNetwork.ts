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
/**
 * Deepest water a route may cross (m). Crossings are LOW CAUSEWAYS now
 * (profile ≥ level + 0.3, built by waterFloor + carve): the hydrology digs
 * ≥1.2 m under every wet cell, so the old bed-level "ford" was always a
 * drowned road. The old hard block at FORD_MAX_DEPTH (0.45 m) therefore
 * walled off EVERY honest river and the SW-exit asphalt leg died with a
 * network GAP (seed 23) — narrow trenches up to this depth are legal to
 * causeway over; lakes stay a hard wall.
 */
const CAUSEWAY_MAX_DEPTH_M = 2.5;
/**
 * Crossing an existing road is only buildable where the two grade lines can
 * actually MEET: junction leveling pins ≤ ~6 m (the pin grade cone) and the
 * approaches absorb ≤ MAX_CUT_FILL. A plan-crossing with a bigger level
 * mismatch is a grade-separated step no leveling can repair (bridges don't
 * exist) — the A* hard-blocks those cells instead of merely pricing them.
 * Found: link-6 plunging over a canyon rim across the valley highway
 * (Δ≈45 m in plan-crossing; seed 23 after the talus relax re-route).
 */
const NET_CROSS_MAX_DY_M = 10;
const TARGET_KM = 30.5;
// Track C2: asphalt gap-retry ladder. MAX_CUT_FILL only bounds the vertical
// PROFILE (buildRoute), not the A* search — so relaxing it would not help
// the pathfinder. The actual A* knob is the grade hard-block factor (2.2×
// by default, see route()'s gradeMul); the retry ladder relaxes THAT.
const ASPHALT_RETRY_GRADE_MUL = 2.8;
const ASPHALT_RETRY_JITTER_CELLS = 3; // ± grid cells, seeded jitter
const ASPHALT_RETRY_ATTEMPTS = 3;

// ---- dead-end stitching (owner 2026-07-14: «дороги, по которым нельзя
// ездить — заебали»; гейт ≤1 тупик на большой квадрант). A ride-graph
// terminus (degree-1 node) is LEGIT only at the world edge, at a water bank
// it can't cross, or against an unbuildable slope — everything else is a
// stub connected below or dropped. See probe-deadends.ts (same thresholds).
/** endpoint within this of ±WORLD_HALF = legit map exit, not a stub */
const DEADEND_EDGE_M = 45;
/** standing water this deep at / ahead of a tip = the road stops at water */
const DEADEND_WATER_M = 0.3;
/** forward look-ahead for the water + slope terminus test (m) */
const DEADEND_AHEAD_M = 16;
/** a tip is slope-terminated when its WHOLE forward fan needs a grade over
 *  class maxGrade × this (between the design grade and the A* ×2.2 block) */
const DEADEND_SLOPE_MUL = 1.6;
/** another route's vertex within this of a tip ⇒ already a junction (kept
 *  < RouteGraph JOIN_R so the runtime graph agrees on what "touches") */
const DEADEND_TOUCH_M = 14;
/** longest connector the stitcher will build to reach the nearest route */
const CONNECT_MAX_M = 340;

interface Cell {
  x: number;
  z: number;
}

/** proper 2D crossing of segments (a,b)×(c,d) → intersection point, else null */
function segIntersect(
  a: number[],
  b: number[],
  c: number[],
  d: number[],
): [number, number] | null {
  const r1x = (b[0] as number) - (a[0] as number);
  const r1z = (b[1] as number) - (a[1] as number);
  const r2x = (d[0] as number) - (c[0] as number);
  const r2z = (d[1] as number) - (c[1] as number);
  const den = r1x * r2z - r1z * r2x;
  if (Math.abs(den) < 1e-9) return null;
  const acx = (c[0] as number) - (a[0] as number);
  const acz = (c[1] as number) - (a[1] as number);
  const t = (acx * r2z - acz * r2x) / den;
  const u = (acx * r1z - acz * r1x) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return [(a[0] as number) + r1x * t, (a[1] as number) + r1z * t];
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
    // REAL standing-water level at (x,z), or −Infinity on dry ground.
    // History of this measure: bilinear alone smears a hanging tarn's level
    // onto DRY ground below its rim (dry texels hold bed−2) — phantom "deep
    // water" that cut the serpentine mid-flank. The old fix (MIN over the
    // 3×3 nearest texels) over-corrected: any dry sentinel in the window
    // reads "dry", so NARROW deep rivers (2–4 sim texels) became invisible
    // — link-4 planned 120 m of tread through a 13 m-deep gorge river
    // (seed 7). Now: gate by the NEAREST texel being wet (its waterY above
    // the local ground), then return the bilinear level. A tarn's dry
    // downhill rim has a dry nearest texel → still no phantom; a mid-river
    // point has a wet nearest texel → real depth.
    const wAtReal = (x: number, z: number): number => {
      const res = terr.simRes;
      const gx = Math.min(Math.max(Math.round((x / WORLD_SIZE + 0.5) * res - 0.5), 0), res - 1);
      const gz = Math.min(Math.max(Math.round((z / WORLD_SIZE + 0.5) * res - 0.5), 0), res - 1);
      const wy = terr.waterY[gz * res + gx] as number;
      const tx = ((gx + 0.5) / res - 0.5) * WORLD_SIZE;
      const tz = ((gz + 0.5) / res - 0.5) * WORLD_SIZE;
      // dry sentinel sits ≥2 m under the local bed — 0.25 splits cleanly
      if (wy - hAt(tx, tz) < 0.25) return -Infinity;
      return wAt(x, z);
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
    // RAW copy for the crossing level check: the box smoothing below
    // flattens a 19 m terrace edge to ~9 m — measured on the smoothed
    // field, an unlevelable crossing sneaks under NET_CROSS_MAX_DY_M
    // (seed 51: link-5 × south-shore-gravel, Δy 18.4 m)
    const ghRaw = gh.slice();
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
    // built-road surface height per masked cell: crossing an existing road
    // at ITS level is a junction; crossing where the built road rides an
    // embankment/cutting is a level-conflicted "crossing without a node"
    // (owner anomaly list) — the A* cost below reads this to steer new
    // routes toward level-compatible crossing spots
    const netY = new Float32Array(N * N);
    const markCells = (cells: Cell[], ys?: number[]): void => {
      for (const [idx, c] of cells.entries()) {
        const y = ys ? (ys[idx] as number) : (gh[c.z * N + c.x] as number);
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = c.x + dx;
            const nz = c.z + dz;
            if (nx >= 0 && nz >= 0 && nx < N && nz < N) {
              netMask[nz * N + nx] = 1;
              netY[nz * N + nx] = y;
            }
          }
        }
      }
    };
    const markNetwork = (r: RoadRoute): void => {
      markCells(
        r.pts.map((p) => toCell(p.x, p.z)),
        r.pts.map((p) => p.y),
      );
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
          if (nd > CAUSEWAY_MAX_DEPTH_M) continue; // lakes/deep water: hard block
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
          // crossings are possible but expensive → rare, short, ⟂-ish;
          // a causeway over a real trench (> old ford depth) costs most
          if (nd > CLASSIFY.FORD_MAX_DEPTH_M) mult += 90;
          else if (nd > CLASSIFY.WATER_MIN_DEPTH_M) mult += 25;
          else if (nd > 0.005) mult += 6; // shoreline margin — don't hug banks
          mult += gmud[ni] as number; // boggy wetland mud — stay on dry ground
          // running alongside an existing road duplicates the corridor —
          // expensive; crossing it stays possible but is a real junction
          // now, not free: at +10 a serpentine wove through the valley
          // road 13× (each weave = an unplanned level-conflicted crossing,
          // owner anomaly list «пересечения без узла»). The level-mismatch
          // term makes crossing a built road ON ITS GRADE LINE affordable
          // and crossing its embankment/cutting prohibitive — junctions
          // happen where the two roads can actually meet.
          if (netMask[ni]) {
            // level-incompatible crossing (canyon rim vs floor): unbuildable,
            // hard block — see NET_CROSS_MAX_DY_M. Measured on the RAW grid:
            // the smoothed gh halves terrace edges and lets 18 m steps pass.
            if (Math.abs((ghRaw[ni] as number) - (netY[ni] as number)) > NET_CROSS_MAX_DY_M) {
              continue;
            }
            mult += 24 + 3 * Math.abs((gh[ni] as number) - (netY[ni] as number));
          }
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
      // last-resort rungs (NO rng — determinism: draws stay identical on
      // every path that reaches here): a grade-enclosed pocket that even
      // the 2.8× hard-block can't leave means a single-step spike between
      // the pocket and open ground; the quadratic penalty still steers the
      // rest of the leg to sane grades, and the profile clamp + carve turn
      // the one spike into a short engineered ramp — a connected road with
      // a bold cut beats a GAP in the network (probe-roadgates law: 0 gaps)
      for (const mul of [3.6, 4.8]) {
        const leg = route(from, to, spec, mul);
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
        if ((gd[i] as number) > CAUSEWAY_MAX_DEPTH_M) return false;
        const hHere = hAt(px, pz);
        if (Math.abs(hHere - (hA + (hB - hA) * t)) > MAX_CUT_FILL) return false;
        // sampled grade along the chord: reject sustained over-grade runs
        // the profile clamp could only absorb with deep cuts (1.6× tolerance
        // for full-res micro-noise at 6 m steps; was 2× — chords at a
        // sustained 2×maxGrade walked the profile ~MAX_CUT_FILL off the
        // terrain per 100 m and fed the slot-canyon carves)
        if (Math.abs(hHere - hPrev) / Math.max(stepLen, 1) > maxGrade * 1.6) return false;
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
      // roads break their sweep at a ford, they don't bridge the bend).
      // The SAME net also catches LEVEL-CONFLICTED corridor entries: the A*
      // hard-blocks crossing a built road where |gh − netY| > NET_CROSS_
      // MAX_DY_M, but Chaikin drift (and the 8 m grid's smoothing error at
      // gully rims) can still swing the final polyline across a partner
      // whose grade line runs ~10+ m above/below ours — an unlevelable
      // crossing (probe cross-level: Δy 18.4 m, seed 51). Full-res check.
      const levelConflict = (px: number, pz: number): boolean => {
        const hHere = hAt(px, pz);
        for (const r of routes) {
          const rad = Math.max(spec.halfWidth + r.cls.halfWidth + 4, 8);
          const reach = rad + 20; // segment endpoints are ≤14 m apart
          for (let k = 0; k < r.pts.length - 1; k++) {
            const A = r.pts[k] as RoadPoint;
            if (Math.abs(A.x - px) > reach || Math.abs(A.z - pz) > reach) continue;
            const B = r.pts[k + 1] as RoadPoint;
            const abx = B.x - A.x;
            const abz = B.z - A.z;
            const len2 = abx * abx + abz * abz || 1;
            const t = Math.min(Math.max(((px - A.x) * abx + (pz - A.z) * abz) / len2, 0), 1);
            const d = Math.hypot(px - (A.x + abx * t), pz - (A.z + abz * t));
            if (d <= rad && Math.abs(hHere - (A.y + (B.y - A.y) * t)) > NET_CROSS_MAX_DY_M) {
              return true;
            }
          }
        }
        return false;
      };
      const snapped = new Set<number>();
      for (const [pi, p] of poly.entries()) {
        const px = p[0] as number;
        const pz = p[1] as number;
        const depth = wAtReal(px, pz) - hAt(px, pz);
        if (depth <= CAUSEWAY_MAX_DEPTH_M && !levelConflict(px, pz)) continue;
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
            if (wAtReal(rx, rz) - hAt(rx, rz) <= CAUSEWAY_MAX_DEPTH_M && !levelConflict(rx, rz)) {
              b[0] = rx;
              b[1] = rz;
            }
          }
        }
      }

      // ---- self-intersection repair (owner «прочее»: петли-самопересечения;
      // root cause of the blend-conflict walls/narrow tread at fold sites) —
      // leg stitching, Chaikin rounding and ford snap-backs can fold the
      // polyline over itself; the carve then blends the two conflicting
      // profiles into one roadbed (a stepped cliff mid-tread). Splice out
      // every enclosed loop at its crossing point: the route continues
      // straight through instead of weaving over itself. The spliced chord
      // is shorter than the two crossing segments (≤ 2×RESAMPLE_M), so no
      // centerline gap can appear. Deterministic, no RNG.
      for (let guard = 0; guard < 32; guard++) {
        let spliced = false;
        for (let i = 0; i + 1 < poly.length - 1 && !spliced; i++) {
          const a = poly[i] as number[];
          const b = poly[i + 1] as number[];
          for (let j = i + 2; j + 1 < poly.length; j++) {
            const X = segIntersect(a, b, poly[j] as number[], poly[j + 1] as number[]);
            if (!X) continue;
            console.warn(
              `[roads] ${name}: self-cross spliced at (${X[0].toFixed(0)},${X[1].toFixed(0)}) ` +
                `— dropped ${j - i} pt(s) loop`,
            );
            poly = [...poly.slice(0, i + 1), [X[0], X[1]], ...poly.slice(j + 1)];
            // relax the splice kink (same gate as the ford snap-back): a
            // hard direction fold makes the carve's nearest-segment normal
            // flip inside the corridor — read as a narrowed tread
            for (let it = 0; it < 4; it++) {
              for (let m = Math.max(1, i); m <= Math.min(poly.length - 2, i + 2); m++) {
                const p0 = poly[m - 1] as number[];
                const p1 = poly[m] as number[];
                const p2 = poly[m + 1] as number[];
                const rx = (p1[0] as number) * 0.5 + ((p0[0] as number) + (p2[0] as number)) * 0.25;
                const rz = (p1[1] as number) * 0.5 + ((p0[1] as number) + (p2[1] as number)) * 0.25;
                if (wAtReal(rx, rz) - hAt(rx, rz) <= CAUSEWAY_MAX_DEPTH_M && !levelConflict(rx, rz)) {
                  p1[0] = rx;
                  p1[1] = rz;
                }
              }
            }
            spliced = true;
            break;
          }
        }
        if (!spliced) break;
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

      // ---- junction leveling (owner list: пересечения дорог без узла) ----
      // Where this route crosses or hugs an ALREADY BUILT route, the two
      // carved surfaces must meet at one height — otherwise the crossing is
      // a grade-separated step with no bridge (the carve blends the two
      // profiles into a mid-air ramp). Pin the profile to the existing
      // road's centerline height inside the shared corridor; plan order
      // builds asphalt first, so later/lighter roads adapt to it. The
      // vertical solver below treats pins as immovable boundary conditions.
      const pinY = new Float64Array(n).fill(Number.NaN);
      const pinned = (i: number): boolean => !Number.isNaN(pinY[i] as number);
      {
        // (a) TRUE CROSSINGS: pin the two samples bracketing each geometric
        // intersection to the other road's height AT the crossing — a level
        // ~14 m junction plateau; the approaches grade-clamp onto it.
        // Deliberately NOT a corridor rule: pinning every sample near an
        // obliquely-shared corridor projects the OTHER road's climb onto a
        // much shorter stretch of ours (found: 70% pin-to-pin steps where a
        // serpentine interleaves the valley gravel road).
        for (const r of routes) {
          for (let i = 0; i < n - 1; i++) {
            if (pinned(i) && pinned(i + 1)) continue;
            const a = poly[i] as number[];
            const b = poly[i + 1] as number[];
            const minX = Math.min(a[0] as number, b[0] as number) - 1;
            const maxX = Math.max(a[0] as number, b[0] as number) + 1;
            const minZ = Math.min(a[1] as number, b[1] as number) - 1;
            const maxZ = Math.max(a[1] as number, b[1] as number) + 1;
            for (let k = 0; k < r.pts.length - 1; k++) {
              const A = r.pts[k] as RoadPoint;
              const B = r.pts[k + 1] as RoadPoint;
              if (Math.min(A.x, B.x) > maxX || Math.max(A.x, B.x) < minX) continue;
              if (Math.min(A.z, B.z) > maxZ || Math.max(A.z, B.z) < minZ) continue;
              const X = segIntersect(a, b, [A.x, A.z], [B.x, B.z]);
              if (!X) continue;
              const abx = B.x - A.x;
              const abz = B.z - A.z;
              const len2 = abx * abx + abz * abz || 1;
              const u = Math.min(
                Math.max(((X[0] - A.x) * abx + (X[1] - A.z) * abz) / len2, 0),
                1,
              );
              const yX = A.y + (B.y - A.y) * u;
              // pin ±2 samples around the crossing to the partner's LOCAL
              // height (projection onto its nearby segments): a tangential
              // graze crosses twice within one segment — a single-point pin
              // leaves the second touch level-conflicted. Each pin is
              // clamped into OUR grade cone around the crossing height: an
              // oblique partner's line climbs faster along our arc than we
              // legally can, and unclamped pins forced 30%+ pin-to-pin
              // ramps (the feasibility law then dismantled the whole block
              // and re-exposed the crossing).
              for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 3); j++) {
                if (pinned(j)) continue;
                const q = poly[j] as number[];
                let bd = Infinity;
                let by = yX;
                for (
                  let m = Math.max(0, k - 5);
                  m < Math.min(r.pts.length - 1, k + 6);
                  m++
                ) {
                  const P = r.pts[m] as RoadPoint;
                  const Q = r.pts[m + 1] as RoadPoint;
                  const px = Q.x - P.x;
                  const pz = Q.z - P.z;
                  const l2 = px * px + pz * pz || 1;
                  const t = Math.min(
                    Math.max(
                      (((q[0] as number) - P.x) * px + ((q[1] as number) - P.z) * pz) / l2,
                      0,
                    ),
                    1,
                  );
                  const d = Math.hypot(
                    (q[0] as number) - (P.x + px * t),
                    (q[1] as number) - (P.z + pz * t),
                  );
                  if (d < bd) {
                    bd = d;
                    by = P.y + (Q.y - P.y) * t;
                  }
                }
                const arc = (Math.abs(j - i - 0.5) + 0.5) * RESAMPLE_M;
                const cone = spec.maxGrade * 0.9 * arc;
                pinY[j] = Math.min(Math.max(by, yX - cone), yX + cone);
              }
              break;
            }
          }
        }
        // (b) ENDPOINT JUNCTIONS: a route budding off the network starts ON
        // an existing road (shared anchor, no proper crossing) — pin only
        // the touching end sample to that road's height.
        for (const i of [0, n - 1]) {
          if (pinned(i)) continue;
          const p = poly[i] as number[];
          const px = p[0] as number;
          const pz = p[1] as number;
          let bestD = Infinity;
          let bestY = 0;
          for (const r of routes) {
            const rad = spec.halfWidth + r.cls.halfWidth + 2;
            const reach2 = (rad + 20) * (rad + 20);
            for (let k = 0; k < r.pts.length - 1; k++) {
              const A = r.pts[k] as RoadPoint;
              const dax = A.x - px;
              const daz = A.z - pz;
              if (dax * dax + daz * daz > reach2) continue;
              const B = r.pts[k + 1] as RoadPoint;
              const abx = B.x - A.x;
              const abz = B.z - A.z;
              const len2 = abx * abx + abz * abz || 1;
              const t = Math.min(Math.max(((px - A.x) * abx + (pz - A.z) * abz) / len2, 0), 1);
              const d = Math.hypot(px - (A.x + abx * t), pz - (A.z + abz * t));
              if (d <= rad && d < bestD) {
                bestD = d;
                bestY = A.y + (B.y - A.y) * t;
              }
            }
          }
          if (bestD < Infinity) pinY[i] = bestY;
        }
        // (b2) contiguous pin runs must be internally grade-feasible: block
        // pins are cones around DIFFERENT crossing anchors, and where two
        // blocks abut the joint step can exceed the class grade — a step
        // the solver's skip-pinned grade clamp can never repair. Lipschitz-
        // clamp every pinned run (fwd + bwd at 0.95·grade).
        for (let i = 1; i < n; i++) {
          if (!pinned(i) || !pinned(i - 1)) continue;
          const lim = spec.maxGrade * 0.95 * (ds[i] as number);
          pinY[i] = Math.min(
            Math.max(pinY[i] as number, (pinY[i - 1] as number) - lim),
            (pinY[i - 1] as number) + lim,
          );
        }
        for (let i = n - 2; i >= 0; i--) {
          if (!pinned(i) || !pinned(i + 1)) continue;
          const lim = spec.maxGrade * 0.95 * (ds[i + 1] as number);
          pinY[i] = Math.min(
            Math.max(pinY[i] as number, (pinY[i + 1] as number) - lim),
            (pinY[i + 1] as number) + lim,
          );
        }
        // (c) pin feasibility law: consecutive SURVIVING pins must be
        // reachable from each other within the class grade along OUR
        // arclength — crossings of an obliquely interleaved partner project
        // ITS climb onto a much shorter stretch of ours (found: 70%
        // pin-to-pin ramps where the serpentine weaves the valley gravel
        // road). Walk pins with a survivor stack and release the farther-
        // from-terrain side of every infeasible pair; releasing a survivor
        // RE-CHECKS the pair it leaves behind. (The old single-`last` walk
        // skipped that re-check: a crossing block pinned 45 m above our own
        // terrain — a canyon-rim road crossed in plan — survived next to a
        // floor-level block, leaving a 300% step at the block boundary the
        // grade clamp can never repair; seed 23 link-6.)
        {
          const sArr = new Float64Array(n);
          for (let i = 1; i < n; i++) sArr[i] = (sArr[i - 1] as number) + (ds[i] as number);
          const stack: number[] = [];
          for (let i = 0; i < n; i++) {
            if (!pinned(i)) continue;
            let ok = true;
            while (stack.length > 0) {
              const last = stack[stack.length - 1] as number;
              const span = Math.max((sArr[i] as number) - (sArr[last] as number), ds[i] as number);
              const lim = spec.maxGrade * span * 0.95 + 0.02;
              if (Math.abs((pinY[i] as number) - (pinY[last] as number)) <= lim) break;
              const dLast = Math.abs((pinY[last] as number) - (terrY[last] as number));
              const dHere = Math.abs((pinY[i] as number) - (terrY[i] as number));
              if (dHere >= dLast) {
                pinY[i] = Number.NaN;
                ok = false;
                break;
              }
              pinY[last] = Number.NaN;
              stack.pop();
            }
            if (ok) stack.push(i);
          }
        }
        for (let i = 0; i < n; i++) {
          if (pinned(i)) ys[i] = pinY[i] as number;
        }
      }

      // vertical alignment: iterate {smooth, grade-clamp, soft terrain pull},
      // then a final grade-only clamp — grade wins over cut/fill depth (the
      // carve builds whatever embankment the mismatch needs; Pillar B says
      // the RIDDEN gradient must be real, so it's the invariant here)
      const g = spec.maxGrade;
      // per-step grade law: tight switchback apexes (lattice-scale folds
      // the shaping passes could not widen without breaking the grade) get
      // a near-flat LANDING — real serpentines flatten through the apex; a
      // full-grade profile through a ~140° fold leaves the two carve
      // branches ~0.5 m apart INSIDE one tread (read as a narrowed bed)
      const gStep = new Float64Array(n).fill(g);
      for (let i = 1; i < n - 1; i++) {
        const a = poly[i - 1] as number[];
        const b = poly[i] as number[];
        const c = poly[i + 1] as number[];
        const d1x = (b[0] as number) - (a[0] as number);
        const d1z = (b[1] as number) - (a[1] as number);
        const d2x = (c[0] as number) - (b[0] as number);
        const d2z = (c[1] as number) - (b[1] as number);
        const dot = d1x * d2x + d1z * d2z;
        const l = Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z) || 1;
        const turn = Math.acos(Math.min(Math.max(dot / l, -1), 1));
        if (turn > 1.4) {
          gStep[i] = Math.min(gStep[i] as number, g * 0.25);
          gStep[i + 1] = Math.min(gStep[i + 1] as number, g * 0.25);
        }
      }
      const gradeClamp = (): void => {
        for (let i = 1; i < n; i++) {
          if (pinned(i)) continue;
          const lim = (gStep[i] as number) * (ds[i] as number);
          ys[i] = Math.min(Math.max(ys[i] as number, (ys[i - 1] as number) - lim), (ys[i - 1] as number) + lim);
        }
        for (let i = n - 2; i >= 0; i--) {
          if (pinned(i)) continue;
          const lim = (gStep[i + 1] as number) * (ds[i + 1] as number);
          ys[i] = Math.min(Math.max(ys[i] as number, (ys[i + 1] as number) - lim), (ys[i + 1] as number) + lim);
        }
      };
      // cut/fill law as its own pass: the final profile must also respect
      // it (it used to run only INSIDE the loop; the closing grade clamp
      // then walked the profile 20–50 m off the terrain on sustained
      // over-grade ground — the carve turned that into slot canyons and
      // rampart embankments, the owner's «дорога въезжает в стену»)
      const cutFillClamp = (): void => {
        for (let i = 0; i < n; i++) {
          if (pinned(i)) continue;
          const t = terrY[i] as number;
          ys[i] = Math.min(Math.max(ys[i] as number, t - MAX_CUT_FILL), t + MAX_CUT_FILL);
        }
      };
      // water floor: the tread may never sit below the level of adjacent
      // REAL water — a cutting beside a river reads as a drowned highway,
      // and a crossing dives under the surface. REAL water means the bilerp
      // level clears the local terrain: dry sim texels hold a bed−2
      // sentinel, and a profile cut >2 m under terrain used to read that
      // sentinel as "water" — forging fords/floods on bone-dry ground (the
      // 8–23 m "deep fords" of the anomaly report were ALL this). Window
      // ±6 samples ≈ 84 m gives the approaches room to ramp over it.
      // Ground BELOW the level gets a low causeway (ys ≥ level + 0.3): the
      // hydrology digs ≥1.2 m under every wet cell, so an honest bed-level
      // ford is always a drowned road — v1 crossings are causeways now
      // (bridges stay backlog); fill is bounded by the admission gate.
      const wetLevel = new Float64Array(n).fill(-Infinity);
      for (let i = 0; i < n; i++) {
        const p = poly[i] as number[];
        const wl = wAt(p[0] as number, p[1] as number);
        const hh = terrY[i] as number;
        if (wl > hh + 0.05 && wl - hh <= MAX_CUT_FILL - 0.5) {
          for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++) {
            if (wl > (wetLevel[k] as number)) wetLevel[k] = wl;
          }
        }
      }
      const waterFloor = (): void => {
        for (let i = 0; i < n; i++) {
          if (pinned(i)) continue;
          const wl = wetLevel[i] as number;
          if (wl === -Infinity) continue;
          ys[i] = Math.max(ys[i] as number, wl + 0.3);
        }
      };
      for (let pass = 0; pass < 8; pass++) {
        for (let it = 0; it < 4; it++) {
          for (let i = 1; i < n - 1; i++) {
            if (pinned(i)) continue;
            ys[i] = (ys[i] as number) * 0.5 + ((ys[i - 1] as number) + (ys[i + 1] as number)) * 0.25;
          }
        }
        gradeClamp();
        cutFillClamp();
        waterFloor();
      }
      // closing reconciliation: alternate the three laws so the FINAL
      // profile honors all of them together instead of only the last one
      // applied (the old tail was gradeClamp→waterFloor, which both let the
      // water floor break the ridden grade — the report's over-grade
      // samples — and let the grade clamp run 20–50 m off the terrain).
      // Grade stays the closing word (Pillar B: the ridden gradient is the
      // invariant); the earlier passes bring cut/fill and the water floor
      // to convergence so that closing clamp only nudges.
      for (let k = 0; k < 6; k++) {
        cutFillClamp();
        waterFloor();
        gradeClamp();
      }

      // pinned-approach grade repair: a junction pin block is immovable, and
      // its approach must CLIMB to it — but a switchback-apex LANDING
      // (gStep = 0.25·g) just below the block caps the grade chain at a
      // fraction of the class grade, so the closing clamp leaves an
      // over-grade step at the block boundary (found: 34.5% on link-2,
      // seed 7 — pin +11 m over terrain, apex two samples below). The
      // landings are an engineering nicety; the class grade law is the
      // gate — where a residual pin-boundary step survives, restore the
      // full class grade on the approach window and re-solve.
      for (let repair = 0; repair < 3; repair++) {
        let dirty = false;
        for (let i = 1; i < n; i++) {
          const lim = (gStep[i] as number) * (ds[i] as number);
          if (Math.abs((ys[i] as number) - (ys[i - 1] as number)) <= lim + 0.02) continue;
          if (!(pinned(i - 1) || pinned(i))) continue;
          for (let j = Math.max(1, i - 10); j <= Math.min(n - 1, i + 10); j++) {
            if ((gStep[j] as number) < g) {
              gStep[j] = g;
              dirty = true;
            }
          }
        }
        if (!dirty) break;
        for (let k = 0; k < 6; k++) {
          cutFillClamp();
          waterFloor();
          gradeClamp();
        }
      }

      // fords AFTER the final profile: only where the finished grade line
      // still dips under REAL water (level above the local terrain — the
      // dry-texel bed−2 sentinel can't forge a ford any more), the crossing
      // is honest: profile drops to the bed there. With the causeway floor
      // above this stays a rare fallback (grade-vs-water conflicts).
      for (let i = 0; i < n; i++) {
        if (pinned(i)) continue;
        const p = poly[i] as number[];
        const wy = wAt(p[0] as number, p[1] as number);
        if (
          wy > (terrY[i] as number) + 0.05 &&
          wy - (ys[i] as number) > CLASSIFY.WATER_MIN_DEPTH_M * 0.6
        ) {
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
        // REAL water only (wAtReal, nearest-texel wet gate): dry texels hold a
        // bed−2 sentinel, and a deep profile cut under DRY ground once read
        // as "3 m under a lake" — false CUTs truncated healthy routes and
        // collapsed the network to 19 km (found 2026-07-06).
        const lakeAt = (k: number): boolean => {
          const q = poly[k] as number[];
          const wm = wAtReal(q[0] as number, q[1] as number);
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
              `wReal=${wAtReal(q[0] as number, q[1] as number).toFixed(1)} ys=${(ys[i] as number).toFixed(1)} terr=${(terrY[i] as number).toFixed(1)}`,
          );
          break;
        }
        // crossing-level law (backstop): the FINAL profile must meet every
        // built route it crosses at that route's grade line. A crossing the
        // junction leveling could not hold (pins released as infeasible —
        // e.g. an over-grade approach arriving 20 m below a terrace road:
        // the terrain AT the crossing looks compatible, so no terrain-based
        // check can see it) is a grade-separated step with no bridge — the
        // route honestly ENDS before it, like the lake CUT above.
        if (i > 0) {
          const a = poly[i - 1] as number[];
          const b = poly[i] as number[];
          const minX = Math.min(a[0] as number, b[0] as number) - 1;
          const maxX = Math.max(a[0] as number, b[0] as number) + 1;
          const minZ = Math.min(a[1] as number, b[1] as number) - 1;
          const maxZ = Math.max(a[1] as number, b[1] as number) + 1;
          let broken = false;
          for (const r of routes) {
            for (let k = 0; k < r.pts.length - 1 && !broken; k++) {
              const A = r.pts[k] as RoadPoint;
              const B = r.pts[k + 1] as RoadPoint;
              if (Math.min(A.x, B.x) > maxX || Math.max(A.x, B.x) < minX) continue;
              if (Math.min(A.z, B.z) > maxZ || Math.max(A.z, B.z) < minZ) continue;
              const X = segIntersect(a, b, [A.x, A.z], [B.x, B.z]);
              if (!X) continue;
              const abx = B.x - A.x;
              const abz = B.z - A.z;
              const l2 = abx * abx + abz * abz || 1;
              const u = Math.min(Math.max(((X[0] - A.x) * abx + (X[1] - A.z) * abz) / l2, 0), 1);
              const yOther = A.y + (B.y - A.y) * u;
              const t01 = Math.min(
                Math.max(
                  Math.hypot(X[0] - (a[0] as number), X[1] - (a[1] as number)) /
                    Math.max(ds[i] as number, 1e-3),
                  0,
                ),
                1,
              );
              const yOurs = (ys[i - 1] as number) + ((ys[i] as number) - (ys[i - 1] as number)) * t01;
              if (Math.abs(yOurs - yOther) > 0.8) broken = true;
            }
            if (broken) break;
          }
          if (broken) {
            console.warn(
              `[roads] ${name} CROSS-CUT at i=${i}/${n} (${(b[0] as number).toFixed(0)},${(b[1] as number).toFixed(0)}) ` +
                `— unlevelable crossing of a built route (profile misses its grade line)`,
            );
            break;
          }
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
    // reach the SW border (toCell clamps to the edge cell ≈ ∓2012 m) so the
    // valley-highway TERMINATES as a legit map exit, not a stub 68 m short of
    // it (old -1980; dead-end pass 2026-07-14 — probe-deadends world-edge)
    const exitSW: [number, number] = [-2020, 1780];
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
        // T-JUNCTION rule (owner anomaly «пересечения без узла»): a leg whose
        // MIDDLE rides an existing corridor for ≥ 10 cells (~80 m; a
        // perpendicular crossing of the ±2-cell mask is ≤ ~7) is duplicating
        // that road at its own, different grade line — the two profiles then
        // weave across each other and no junction leveling can reconcile
        // them within the class grade. End the route where it merges into
        // the network instead: the link JOINS the road it found (T-junction)
        // and the rest of the plan is dropped. Off-mask gaps ≤ 2 cells stay
        // part of one run (the weave oscillates off the mask edge).
        {
          let runStart = -1;
          let off = 0;
          let cutAt = -1;
          for (let ci = 0; ci < leg.length; ci++) {
            if (onNet(leg[ci] as Cell)) {
              if (runStart < 0) runStart = ci;
              off = 0;
            } else if (runStart >= 0 && ++off > 2) {
              if (ci - off - runStart + 1 >= 10) {
                cutAt = runStart;
                break;
              }
              runStart = -1;
              off = 0;
            }
          }
          if (cutAt < 0 && runStart >= 0 && leg.length - off - runStart >= 10) cutAt = runStart;
          if (cutAt >= 2) {
            console.warn(
              `[roads] ${name}[${i}]: mid-leg rides an existing corridor — T-junction, ` +
                `dropping ${leg.length - cutAt - 2} trailing cell(s)`,
            );
            leg = leg.slice(0, cutAt + 2);
            markCells(leg);
            cells.push(...(cells.length > 0 ? leg.slice(1) : leg));
            break; // remaining vias die with the merge — the network continues
          }
        }
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

    // ---- dead-end stitching (owner 2026-07-14: «дороги, по которым нельзя
    // ездить — заебали»). RoadNetwork ships independent polylines; a route
    // that ENDS in open rideable ground — not at the world edge, not at a
    // water bank, not against an unbuildable slope — becomes a degree-1
    // dead-end in the ride graph (RouteGraph). Connect every such tip to the
    // nearest OTHER route with a real, ridable connector through the SAME
    // A*+buildRoute pipeline (grade/water/wall laws all apply), or — if the
    // route is an isolated island no connector can reach — drop it (an
    // unreachable road is exactly «дорога по которой нельзя ездить»). Legit
    // termini are left alone. Runs BEFORE scenic so the connectors are in
    // netMask. Gate: tools/probe-deadends.ts (≤1 dead-end per big quadrant).
    const dropped = new Set<RoadRoute>();
    {
      const HALF = WORLD_SIZE / 2;
      const STITCH_DBG =
        typeof location !== 'undefined' && location.search.includes('rgdbg');
      const depthAt = (x: number, z: number): number => {
        const wl = wAtReal(x, z);
        const h = hAt(x, z);
        return wl > h ? wl - h : 0;
      };
      /** '' = illegitimate dead-end tip; else the excuse tag (edge/water/slope) */
      const excuseTip = (
        tx: number,
        tz: number,
        fx: number,
        fz: number,
        spec: RoadClassSpec,
        tipFord: boolean,
      ): string => {
        if (Math.max(Math.abs(tx), Math.abs(tz)) >= HALF - DEADEND_EDGE_M) return 'edge';
        if (tipFord || depthAt(tx, tz) > DEADEND_WATER_M) return 'water';
        const h0 = hAt(tx, tz);
        let fwdGrade = Infinity;
        let water = false;
        // Excuse only when the CONTINUATION corridor (forward cone ±22°, the
        // road's own travel direction) is blocked: terrain too steep to climb
        // (slope terminus — e.g. a valley road ending against the massif foot)
        // or standing water. Sideways ground is irrelevant — a road hitting a
        // wall dead-ahead has terminated even if a 45° detour exists; and
        // water 45° aside is dodgeable, not a terminus (advisor review
        // 2026-07-14). MIN grade over the cone = boxed only if the whole
        // forward corridor is unrideable.
        for (const deg of [-22, 0, 22]) {
          const a = (deg * Math.PI) / 180;
          const dx = fx * Math.cos(a) - fz * Math.sin(a);
          const dz = fx * Math.sin(a) + fz * Math.cos(a);
          for (const D of [DEADEND_AHEAD_M * 0.6, DEADEND_AHEAD_M]) {
            const px = tx + dx * D;
            const pz = tz + dz * D;
            const gg = Math.abs(hAt(px, pz) - h0) / D;
            if (gg < fwdGrade) fwdGrade = gg;
            if (depthAt(px, pz) > DEADEND_WATER_M) water = true;
          }
        }
        if (water) return 'water';
        if (fwdGrade > spec.maxGrade * DEADEND_SLOPE_MUL) return 'slope';
        return '';
      };
      /** [tipX, tipZ, fwdX, fwdZ] — outward continuation direction at a tip */
      const tipForward = (r: RoadRoute, which: 0 | 1): [number, number, number, number] => {
        const pts = r.pts;
        const tip = which === 0 ? (pts[0] as RoadPoint) : (pts[pts.length - 1] as RoadPoint);
        let ref = tip;
        if (which === 0) {
          for (let i = 1; i < pts.length; i++) {
            const p = pts[i] as RoadPoint;
            if (Math.hypot(p.x - tip.x, p.z - tip.z) >= 15) {
              ref = p;
              break;
            }
          }
        } else {
          for (let i = pts.length - 2; i >= 0; i--) {
            const p = pts[i] as RoadPoint;
            if (Math.hypot(p.x - tip.x, p.z - tip.z) >= 15) {
              ref = p;
              break;
            }
          }
        }
        let fx = tip.x - ref.x;
        let fz = tip.z - ref.z;
        const fl = Math.hypot(fx, fz) || 1;
        return [tip.x, tip.z, fx / fl, fz / fl];
      };
      const touchesOther = (self: RoadRoute, x: number, z: number): boolean => {
        for (const o of routes) {
          if (o === self) continue;
          for (const p of o.pts) {
            const dx = p.x - x;
            const dz = p.z - z;
            if (dx * dx + dz * dz < DEADEND_TOUCH_M * DEADEND_TOUCH_M) return true;
          }
        }
        return false;
      };
      // nearest vertex of EACH other route within CONNECT_MAX_M, sorted by
      // distance — the single closest route may be across an obstacle the A*
      // can't bridge, so the stitcher falls through to the next few
      const candidates = (
        self: RoadRoute,
        x: number,
        z: number,
      ): { x: number; z: number; route: RoadRoute; d: number }[] => {
        const out: { x: number; z: number; route: RoadRoute; d: number }[] = [];
        for (const o of routes) {
          if (o === self) continue;
          let bd = CONNECT_MAX_M * CONNECT_MAX_M;
          let bx = 0;
          let bz = 0;
          for (const p of o.pts) {
            const dx = p.x - x;
            const dz = p.z - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bd) {
              bd = d2;
              bx = p.x;
              bz = p.z;
            }
          }
          if (bd < CONNECT_MAX_M * CONNECT_MAX_M) out.push({ x: bx, z: bz, route: o, d: Math.sqrt(bd) });
        }
        out.sort((a, b) => a.d - b.d);
        return out;
      };
      /** min distance from (x,z) to any vertex of route rt (clustering test) */
      const nearRoute = (rt: RoadRoute, x: number, z: number): number => {
        let m = Infinity;
        for (const p of rt.pts) {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < m) m = d;
        }
        return m;
      };
      const single = spec(SurfaceId.Singletrack);
      // aim a connector this far SHORT of the target road: plunging a leg ONTO
      // a built road at a conflicting grade makes buildRoute's junction-cut
      // truncate it (CROSS-CUT); ending ~this short still clusters (< JOIN_R)
      const CONNECT_OFFSET_M = 12;
      /** connector far end within this of the target route = it will cluster
       *  into a junction (matches RouteGraph JOIN_R) */
      const CONNECT_REACH_M = 15;
      const buildConnector = (
        tx: number,
        tz: number,
        tgt: { x: number; z: number; route: RoadRoute },
        cls0: RoadClassSpec,
        idName: string,
      ): RoadRoute | null => {
        const gap = Math.hypot(tgt.x - tx, tgt.z - tz);
        // aim short of the road to dodge the merge cross-cut, but never so
        // short the connector collapses below ~18 m (too few points to build)
        const off = Math.min(CONNECT_OFFSET_M, Math.max(0, gap - 18));
        const aimX = tgt.x + ((tx - tgt.x) * off) / gap;
        const aimZ = tgt.z + ((tz - tgt.z) * off) / gap;
        const fromC = toCell(tx, tz);
        const toC = toCell(aimX, aimZ);
        // try the tip's own class first (a like-for-like link), then fall back
        // to the most permissive class (singletrack, maxGrade 0.2) — a short
        // link trail off a road stub is realistic and routes where the parent
        // class can't
        const classes =
          cls0.surfaceId === SurfaceId.Singletrack ? [cls0] : [cls0, single];
        for (const cls of classes) {
          let leg = route(fromC, toC, cls);
          if (!leg) leg = asphaltRetry(fromC, toC, cls);
          if (!leg || leg.length < 2) continue;
          const c = buildRoute(idName, cls, leg);
          if (c.pts.length < 3) continue;
          const cf = c.pts[0] as RoadPoint;
          const cl = c.pts[c.pts.length - 1] as RoadPoint;
          const cfTip = Math.hypot(cf.x - tx, cf.z - tz);
          const clTip = Math.hypot(cl.x - tx, cl.z - tz);
          const tipEnd = cfTip <= clTip ? cf : cl;
          const farEnd = tipEnd === cf ? cl : cf;
          if (Math.min(cfTip, clTip) >= DEADEND_TOUCH_M) continue; // lost the tip
          if (nearRoute(tgt.route, farEnd.x, farEnd.z) < CONNECT_REACH_M) return c;
        }
        return null;
      };
      /** no vertex of r within DEADEND_TOUCH_M of ANY other route = an
       *  unreachable island (nothing crosses or meets it anywhere) */
      const isIsland = (r: RoadRoute): boolean => {
        for (const p of r.pts) {
          for (const o of routes) {
            if (o === r) continue;
            for (const q of o.pts) {
              const dx = q.x - p.x;
              const dz = q.z - p.z;
              if (dx * dx + dz * dz < DEADEND_TOUCH_M * DEADEND_TOUCH_M) return false;
            }
          }
        }
        return true;
      };

      // Phase 1 — connect dangling illegitimate tips. Iterate a SNAPSHOT of the
      // original routes (connectors join by construction); push each connector
      // so later tips can see and reuse it.
      const original = [...routes];
      const pruneCandidates: RoadRoute[] = [];
      let connectId = 0;
      for (const r of original) {
        let failed = false;
        for (const which of [0, 1] as const) {
          const pts = r.pts;
          const tipP = which === 0 ? (pts[0] as RoadPoint) : (pts[pts.length - 1] as RoadPoint);
          if (touchesOther(r, tipP.x, tipP.z)) continue; // already a junction
          const [tx, tz, fx, fz] = tipForward(r, which);
          if (excuseTip(tx, tz, fx, fz, r.cls, tipP.ford)) continue; // legit terminus
          const cands = candidates(r, tx, tz);
          if (cands.length === 0) {
            failed = true; // isolated tip, nothing within CONNECT_MAX_M
            if (STITCH_DBG)
              console.warn(`[roads/stitch] ${r.name} tip(${tx.toFixed(0)},${tz.toFixed(0)}) no target ≤${CONNECT_MAX_M}m`);
            continue;
          }
          // try the nearest few routes — the closest may be unreachable
          let c: RoadRoute | null = null;
          for (const cand of cands.slice(0, 5)) {
            c = buildConnector(tx, tz, cand, r.cls, `connect-${connectId}`);
            if (c) break;
          }
          if (!c) {
            failed = true;
            if (STITCH_DBG)
              console.warn(
                `[roads/stitch] ${r.name} tip(${tx.toFixed(0)},${tz.toFixed(0)}) → ${cands[0]?.route.name} ` +
                  `gap ${(cands[0]?.d ?? 0).toFixed(0)}m CONNECT-FAIL (${cands.length} cand)`,
              );
            continue;
          }
          routes.push(c);
          markNetwork(c);
          connectId++;
        }
        if (failed) pruneCandidates.push(r);
      }

      // Phase 2 — drop unreachable islands (a route that stayed dangling AND
      // touches nothing anywhere). Never the asphalt spine. A route reachable
      // through a mid-body junction is kept even with one stub tip.
      for (const r of pruneCandidates) {
        if (r.cls.surfaceId === SurfaceId.Asphalt) continue;
        if (isIsland(r)) dropped.add(r);
      }
      console.log(
        `[roads] dead-end stitch: +${connectId} connector(s), dropped ${dropped.size} isolated route(s)`,
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

    return new RoadNetwork(
      routes.filter((r) => !dropped.has(r)),
      { asphaltGaps, asphaltCuts },
      scenic,
    );
  }
}
