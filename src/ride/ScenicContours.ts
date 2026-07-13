/**
 * ScenicContours — P.5 v2 (ref-04): long decorative macro-isolines drawn
 * across green flanks.
 *
 * Advisor verdict (2026-07-13): a point-wise hard-stop trace cannot deliver
 * the ref-04 composition (2–4 near-horizontal paths lining a whole hillside)
 * — every local obstacle cuts it into stubs. Instead:
 *   1. smooth the planning height a little further (2 extra 3×3 box passes
 *      over the router grid ⇒ effective σ ≈ 12–16 m),
 *   2. extract FULL isolines by marching squares — no obstacle masking,
 *   3. evaluate obstacles ALONG the polyline with run-length tolerances
 *      (short rock/mud crossings are honest; deep water and persistent
 *      cliff bands are hard splits),
 *   4. score 360–1050 m windows and keep a "family": the best line plus
 *      1–3 neighbouring levels of the same flank (plus at most one second
 *      flank) — 3–6 polylines total.
 *
 * The result is DECORATIVE: ScenicField bakes it into a signed-distance
 * band the terrain material tints at mid/far camera distances. No carve,
 * no surface stamp, no physics — the rideable network is untouched.
 *
 * Deterministic: no RNG — a pure function of the terrain grids.
 */

import { LAKE_LEVEL, TREELINE, WORLD_SIZE } from '../world/WorldConst';
import { CLASSIFY } from './SurfaceMatrix';

export interface ScenicPolyline {
  /** world-space xz points ~10 m apart, oriented so the UPHILL side is the
   *  POSITIVE signed-lat side (ScenicField / TerrainMaterial convention) */
  pts: [number, number][];
  /** isoline elevation on the planning field (m) */
  level: number;
  /** polyline arclength (m) */
  length: number;
  score: number;
}

/** router-grid inputs (all owned by RoadNetwork.generate) */
export interface ScenicGrids {
  /** router grid size (cells across the world) */
  n: number;
  /** smoothed router heights (RoadNetwork gh — 2× 3×3 box over 8 m cells) */
  gh: Float32Array;
  /** terrain slope (rise/run) at router cells */
  gs: Float32Array;
  /** dilated water depth (m) at router cells */
  gd: Float32Array;
  /** wetland/mud penalty field (0 = dry ground) */
  gmud: Float32Array;
  /** cells within ~16 m of the built road network */
  netMask: Uint8Array;
}

// ---- tuning (advisor table, decorative column) ------------------------------
const STEP_M = 10; // resample step along the polyline
const LEVEL_STEP_M = 36; // elevation between candidate isolines
const WIN_MIN_M = 360;
const WIN_MAX_M = 1050;
const WIN_STRIDE_M = 120; // window slide stride inside long valid runs
const ROCK_SLOPE = 0.68; // above this the flank reads as rock, not meadow
const FLAT_SLOPE = 0.1; // below this the band is invisible (no flank)
const MAX_ROCK_RUN_M = 64;
const MAX_ROCK_FRAC = 0.2;
const MAX_MUD_RUN_M = 32;
const MAX_MUD_FRAC = 0.1;
const MAX_WATER_RUN_M = 16;
const LEVEL_FREE_M = 3; // |gh − level| below this is free (raw vs planning)
const FAMILY_R_M = 700; // same-flank radius (candidate midpoints)
const LEVEL_SEP_M = 24; // min level separation inside a flank family
const MAX_FLANKS = 2;
const MAX_PER_FLANK = 4;
const MAX_LINES = 6;

interface Candidate {
  pts: [number, number][];
  level: number;
  length: number;
  score: number;
  mid: [number, number];
}

export function traceScenicContours(g: ScenicGrids): ScenicPolyline[] {
  const N = g.n;

  // planning field: 2 extra box passes over the already-smoothed router grid
  const ghs = g.gh.slice();
  const tmp = new Float32Array(N * N);
  for (let it = 0; it < 2; it++) {
    tmp.set(ghs);
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        let sum = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(Math.max(x + dx, 0), N - 1);
            const zz = Math.min(Math.max(z + dz, 0), N - 1);
            sum += tmp[zz * N + xx] as number;
          }
        }
        ghs[z * N + x] = sum / 9;
      }
    }
  }

  /** continuous grid coord → world (grid values live at cell centers) */
  const gw = (c: number): number => ((c + 0.5) / N - 0.5) * WORLD_SIZE;
  /** world → nearest router cell index */
  const cellAt = (x: number, z: number): number => {
    const cx = Math.min(Math.max(Math.round((x / WORLD_SIZE + 0.5) * N - 0.5), 0), N - 1);
    const cz = Math.min(Math.max(Math.round((z / WORLD_SIZE + 0.5) * N - 0.5), 0), N - 1);
    return cz * N + cx;
  };
  /** bilinear planning-field sample at world xz (orientation test) */
  const ghsAt = (x: number, z: number): number => {
    const gx = Math.min(Math.max((x / WORLD_SIZE + 0.5) * N - 0.5, 0), N - 1.001);
    const gz = Math.min(Math.max((z / WORLD_SIZE + 0.5) * N - 0.5, 0), N - 1.001);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    const at = (xx: number, zz: number): number =>
      ghs[Math.min(zz, N - 1) * N + Math.min(xx, N - 1)] as number;
    const t = at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx;
    const b = at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx;
    return t * (1 - fz) + b * fz;
  };

  // ---- candidate windows over every level --------------------------------
  const candidates: Candidate[] = [];
  for (let level = LAKE_LEVEL + 20; level <= TREELINE - 20; level += LEVEL_STEP_M) {
    for (const chain of extractIsoChains(ghs, N, level)) {
      // grid → world, light corner rounding, fixed-step resample
      let poly = chain.map(([gx, gz]) => [gw(gx), gw(gz)] as [number, number]);
      poly = chaikin1(poly);
      poly = resample(poly, STEP_M);
      if (poly.length * STEP_M < WIN_MIN_M) continue;

      // per-point criteria on the RAW router grids (full field — the trace
      // itself was never masked; tolerances are applied on the runs below)
      const nPts = poly.length;
      const hard = new Uint8Array(nPts);
      const rock = new Uint8Array(nPts);
      const mud = new Uint8Array(nPts);
      const water = new Uint8Array(nPts);
      const flat = new Uint8Array(nPts);
      const net = new Uint8Array(nPts);
      const err = new Float32Array(nPts);
      for (let i = 0; i < nPts; i++) {
        const [x, z] = poly[i] as [number, number];
        if (Math.abs(x) > WORLD_SIZE / 2 - 60 || Math.abs(z) > WORLD_SIZE / 2 - 60) {
          hard[i] = 1;
          continue;
        }
        const ci = cellAt(x, z);
        const h = g.gh[ci] as number;
        const d = g.gd[ci] as number;
        // deep water and the altitude corridor are hard; everything else is
        // a soft category with a run-length tolerance
        if (d > CLASSIFY.FORD_MAX_DEPTH_M || h < LAKE_LEVEL + 15 || h > TREELINE - 12) {
          hard[i] = 1;
          continue;
        }
        const s = g.gs[ci] as number;
        if (s > ROCK_SLOPE) rock[i] = 1;
        if ((g.gmud[ci] as number) > 0) mud[i] = 1;
        if (d > 0.02) water[i] = 1;
        if (s < FLAT_SLOPE) flat[i] = 1;
        if (g.netMask[ci] === 1) net[i] = 1;
        err[i] = Math.max(0, Math.abs(h - level) - LEVEL_FREE_M);
      }
      // over-tolerance runs become hard (persistent cliff / bog / channel)
      markLongRuns(rock, hard, MAX_ROCK_RUN_M / STEP_M);
      markLongRuns(mud, hard, MAX_MUD_RUN_M / STEP_M);
      markLongRuns(water, hard, MAX_WATER_RUN_M / STEP_M);

      // maximal hard-free runs → scored windows
      let runStart = -1;
      for (let i = 0; i <= nPts; i++) {
        const bad = i === nPts || hard[i] === 1;
        if (!bad) {
          if (runStart < 0) runStart = i;
          continue;
        }
        if (runStart >= 0) {
          const runEnd = i; // exclusive
          const runLen = (runEnd - runStart - 1) * STEP_M;
          if (runLen >= WIN_MIN_M) {
            const winPts = Math.min(runEnd - runStart, Math.floor(WIN_MAX_M / STEP_M) + 1);
            const stride = Math.max(1, Math.floor(WIN_STRIDE_M / STEP_M));
            let best: Candidate | null = null;
            for (let w0 = runStart; w0 + winPts <= runEnd; w0 += stride) {
              const c = scoreWindow(poly, w0, w0 + winPts, level, { rock, mud, water, flat, net, err });
              if (c && (!best || c.score > best.score)) best = c;
              if (w0 + winPts === runEnd) break;
            }
            // make sure the tail-aligned window is also tried
            if (runEnd - winPts > runStart) {
              const c = scoreWindow(poly, runEnd - winPts, runEnd, level, { rock, mud, water, flat, net, err });
              if (c && (!best || c.score > best.score)) best = c;
            }
            if (best) candidates.push(best);
          }
          runStart = -1;
        }
      }
    }
  }

  // ---- family selection: best line seeds flank 1; neighbouring levels of
  // the same flank join it; at most one second flank — 3–6 lines total
  candidates.sort((a, b) => b.score - a.score);
  const flanks: { anchor: [number, number]; lines: Candidate[] }[] = [];
  let total = 0;
  for (const c of candidates) {
    if (total >= MAX_LINES) break;
    let f = flanks.find(
      (fl) => Math.hypot(fl.anchor[0] - c.mid[0], fl.anchor[1] - c.mid[1]) < FAMILY_R_M,
    );
    if (!f) {
      if (flanks.length >= MAX_FLANKS) continue;
      f = { anchor: c.mid, lines: [] };
      flanks.push(f);
    }
    if (f.lines.length >= MAX_PER_FLANK) continue;
    if (f.lines.some((p) => Math.abs(p.level - c.level) < LEVEL_SEP_M)) continue;
    f.lines.push(c);
    total++;
  }

  // ---- orient: uphill on the POSITIVE signed-lat side (ScenicField sign
  // convention: for segment a→b, offset (−abz, abx) is the positive side)
  const out: ScenicPolyline[] = [];
  for (const f of flanks) {
    for (const c of f.lines) {
      const pts = c.pts;
      const mi = pts.length >> 1;
      const a = pts[Math.max(0, mi - 1)] as [number, number];
      const b = pts[Math.min(pts.length - 1, mi + 1)] as [number, number];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const dl = Math.hypot(dx, dz) || 1;
      const px = (-dz / dl) * 16; // positive-lat side probe
      const pz = (dx / dl) * 16;
      const m = pts[mi] as [number, number];
      if (ghsAt(m[0] + px, m[1] + pz) < ghsAt(m[0] - px, m[1] - pz)) pts.reverse();
      out.push({ pts, level: c.level, length: c.length, score: c.score });
    }
  }
  return out;
}

// ---- window scoring ---------------------------------------------------------
function scoreWindow(
  poly: [number, number][],
  i0: number,
  i1: number, // exclusive
  level: number,
  f: {
    rock: Uint8Array;
    mud: Uint8Array;
    water: Uint8Array;
    flat: Uint8Array;
    net: Uint8Array;
    err: Float32Array;
  },
): Candidate | null {
  const count = i1 - i0;
  const len = (count - 1) * STEP_M;
  let rockM = 0;
  let mudM = 0;
  let waterM = 0;
  let flatM = 0;
  let netM = 0;
  let errSum = 0;
  for (let i = i0; i < i1; i++) {
    if (f.rock[i]) rockM += STEP_M;
    if (f.mud[i]) mudM += STEP_M;
    if (f.water[i]) waterM += STEP_M;
    if (f.flat[i]) flatM += STEP_M;
    if (f.net[i]) netM += STEP_M;
    errSum += f.err[i] as number;
  }
  if (rockM > len * MAX_ROCK_FRAC) return null;
  if (mudM > len * MAX_MUD_FRAC) return null;
  // a window that is mostly flat has no flank to draw on
  if (flatM > len * 0.45) return null;
  const errMean = errSum / count;
  // advisor scoring sketch: length dominates, obstacles and network overlap
  // subtract, level wobble (raw vs planning field) subtracts weakly
  const score =
    len - 3 * rockM - 6 * mudM - 10 * waterM - 8 * netM - 2 * flatM - 4 * errMean;
  const pts = poly.slice(i0, i1).map((p) => [p[0], p[1]] as [number, number]);
  const mid = pts[pts.length >> 1] as [number, number];
  return { pts, level, length: len, score, mid: [mid[0], mid[1]] };
}

/** flip run points to hard where a same-category run exceeds maxRun cells */
function markLongRuns(cat: Uint8Array, hard: Uint8Array, maxRun: number): void {
  let start = -1;
  for (let i = 0; i <= cat.length; i++) {
    const on = i < cat.length && cat[i] === 1 && hard[i] === 0;
    if (on) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start > maxRun) {
      for (let k = start; k < i; k++) hard[k] = 1;
    }
    start = -1;
  }
}

// ---- marching squares --------------------------------------------------------
/**
 * Extract iso-level chains from a res×res field (values at cell centers).
 * Returns chains of continuous GRID coordinates. Edge-keyed adjacency keeps
 * every crossing shared exactly between the two adjacent cells, so chains
 * connect without float hashing; ambiguous saddles resolve on the cell mean.
 */
function extractIsoChains(field: Float32Array, res: number, level: number): [number, number][][] {
  const hKey = (x: number, z: number): number => (z * res + x) * 2; // (x,z)-(x+1,z)
  const vKey = (x: number, z: number): number => (z * res + x) * 2 + 1; // (x,z)-(x,z+1)
  const pointOf = new Map<number, [number, number]>();
  const adj = new Map<number, number[]>();
  const at = (x: number, z: number): number => field[z * res + x] as number;
  const lerpT = (a: number, b: number): number => (level - a) / (b - a);

  const edgePoint = (key: number): void => {
    if (pointOf.has(key)) return;
    const cellIdx = key >> 1;
    const x = cellIdx % res;
    const z = (cellIdx / res) | 0;
    if ((key & 1) === 0) {
      pointOf.set(key, [x + lerpT(at(x, z), at(x + 1, z)), z]);
    } else {
      pointOf.set(key, [x, z + lerpT(at(x, z), at(x, z + 1))]);
    }
  };
  const link = (e1: number, e2: number): void => {
    edgePoint(e1);
    edgePoint(e2);
    let l1 = adj.get(e1);
    if (!l1) adj.set(e1, (l1 = []));
    l1.push(e2);
    let l2 = adj.get(e2);
    if (!l2) adj.set(e2, (l2 = []));
    l2.push(e1);
  };

  for (let z = 0; z < res - 1; z++) {
    for (let x = 0; x < res - 1; x++) {
      const a = at(x, z); // bottom-left
      const b = at(x + 1, z); // bottom-right
      const c = at(x + 1, z + 1); // top-right
      const d = at(x, z + 1); // top-left
      const idx =
        (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const B = hKey(x, z);
      const T = hKey(x, z + 1);
      const L = vKey(x, z);
      const R = vKey(x + 1, z);
      switch (idx) {
        case 1:
        case 14:
          link(L, B);
          break;
        case 2:
        case 13:
          link(B, R);
          break;
        case 3:
        case 12:
          link(L, R);
          break;
        case 4:
        case 11:
          link(R, T);
          break;
        case 6:
        case 9:
          link(B, T);
          break;
        case 7:
        case 8:
          link(L, T);
          break;
        case 5: // bl+tr saddle: resolve on the cell mean
          if ((a + b + c + d) / 4 >= level) {
            link(L, T);
            link(B, R);
          } else {
            link(L, B);
            link(R, T);
          }
          break;
        case 10: // br+tl saddle
          if ((a + b + c + d) / 4 >= level) {
            link(L, B);
            link(R, T);
          } else {
            link(L, T);
            link(B, R);
          }
          break;
      }
    }
  }

  // walk chains: open ones from degree-1 edges first, then remaining loops
  const usedSeg = new Set<number>();
  const segId = (e1: number, e2: number): number =>
    e1 < e2 ? e1 * 0x400000 + e2 : e2 * 0x400000 + e1;
  const chains: [number, number][][] = [];
  const walk = (start: number): void => {
    const chain: number[] = [start];
    let cur = start;
    for (;;) {
      const nexts = adj.get(cur) ?? [];
      let nxt = -1;
      for (const cand of nexts) {
        if (!usedSeg.has(segId(cur, cand))) {
          nxt = cand;
          break;
        }
      }
      if (nxt < 0) break;
      usedSeg.add(segId(cur, nxt));
      chain.push(nxt);
      cur = nxt;
    }
    if (chain.length > 2) {
      chains.push(chain.map((k) => pointOf.get(k) as [number, number]));
    }
  };
  for (const [e, ns] of adj) {
    if (ns.length === 1 && !usedSeg.has(segId(e, ns[0] as number))) walk(e);
  }
  for (const [e, ns] of adj) {
    for (const cand of ns) {
      if (!usedSeg.has(segId(e, cand))) {
        walk(e);
        break;
      }
    }
  }
  return chains;
}

// ---- polyline helpers ----------------------------------------------------------
/** one Chaikin corner-rounding pass (endpoints kept) */
function chaikin1(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const q: [number, number][] = [pts[0] as [number, number]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as [number, number];
    const b = pts[i + 1] as [number, number];
    q.push(
      [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25],
      [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75],
    );
  }
  q.push(pts[pts.length - 1] as [number, number]);
  return q;
}

/** fixed-step arclength resample */
function resample(pts: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [pts[0] as [number, number]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as [number, number];
    const b = pts[i + 1] as [number, number];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t < seg) {
      const k = t / seg;
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      t += step;
    }
    carry = seg - (t - step);
  }
  out.push(pts[pts.length - 1] as [number, number]);
  return out;
}
