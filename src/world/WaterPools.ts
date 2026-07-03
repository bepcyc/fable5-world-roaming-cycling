/**
 * M1.4.2 water-surface fix: flatten pooled reaches of the river water
 * surface to their spill level via Priority-Flood (Barnes et al. 2014,
 * epsilon=0), keeping legitimately sloped flowing reaches untouched.
 *
 * Why: hydrology renders rivers at carved bed + smoothed depth
 * (FlowRivers waterYRaw), so a pooled/widened reach — where the depth
 * blur peaks mid-pool — reads as a convex "bubble" dome. Physically a
 * pool can only stand at the level of its downstream spill point.
 *
 * Algorithm (CPU, sim-res grid, wet cells only):
 *  1. Seed a min-heap with every wet cell that touches a dry cell or the
 *     grid border (candidate outlets), keyed by its raw surface level.
 *  2. Priority-flood inward: pop the lowest cell, claim unvisited wet
 *     neighbors at pool level max(popped level, neighbor bed) — the
 *     classic fill of the carved bed from outlet levels. Because the
 *     heap pops globally lowest first, pool interiors are always claimed
 *     through their true (lowest) outlet, never a raised rim cell.
 *  3. Every wet cell takes its stepped pool level: sloped reaches become
 *     a pool-riffle staircase (flat mirrors, dry breaks where the bed
 *     crosses the level) instead of a glassy sheet draped over the slope;
 *     genuine pools fill flat to their spill. Lakes reproduce their own
 *     already-flat level W unchanged.
 *
 * Lakes are already at their flat multigrid fill level W: the flood
 * reproduces W exactly, so they pass through unchanged.
 */

/** vertical extent of one stream pool step: climbing a reach, the water
 *  level stays FLAT until the bed rises this far above it, then jumps to a
 *  new pool anchored at the bed (pool-riffle staircase). Without stepping,
 *  visible water on sloped reaches keeps its raw bed+depth surface and
 *  reads as a glassy sheet DRAPED over the slope (owner: "вода налипает").
 *  0.35 m over 2–4 m texels keeps the wet-wet step gradient under the
 *  buildWaterY cliff-cut threshold (0.35 rise/run), so steps render as
 *  short smoothed slides, not severed shards. */
const POOL_STEP = 0.35;
/** wet sentinel: waterYRaw is −1e4 on dry cells */
const DRY = -1e3;

interface FlattenStats {
  wetCells: number;
  pooledCells: number;
  maxDrop: number;
}

/** binary min-heap of cell indices keyed by an external level array */
class MinHeap {
  private idx: Int32Array;
  private n = 0;
  constructor(
    capacity: number,
    private key: Float32Array,
  ) {
    this.idx = new Int32Array(capacity);
  }
  get size(): number {
    return this.n;
  }
  push(i: number): void {
    if (this.n === this.idx.length) {
      const g = new Int32Array(this.idx.length * 2);
      g.set(this.idx);
      this.idx = g;
    }
    let c = this.n++;
    this.idx[c] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if ((this.key[this.idx[p] as number] as number) <= (this.key[i] as number)) break;
      this.idx[c] = this.idx[p] as number;
      this.idx[p] = i;
      c = p;
    }
  }
  pop(): number {
    const top = this.idx[0] as number;
    const last = this.idx[--this.n] as number;
    if (this.n > 0) {
      let c = 0;
      const kLast = this.key[last] as number;
      for (;;) {
        const l = c * 2 + 1;
        if (l >= this.n) break;
        const r = l + 1;
        const m =
          r < this.n &&
          (this.key[this.idx[r] as number] as number) < (this.key[this.idx[l] as number] as number)
            ? r
            : l;
        if ((this.key[this.idx[m] as number] as number) >= kLast) break;
        this.idx[c] = this.idx[m] as number;
        c = m;
      }
      this.idx[c] = last;
    }
    return top;
  }
}

/**
 * Flatten pooled water in place: `raw` (waterYRaw readback) is rewritten
 * with the corrected surface. `bed` is the carved sim-res terrain.
 */
/** standing water may not slope: wet cells whose corrected surface still
 *  drops more than this (rise/run) toward a wet neighbor are ramp remnants
 *  (staircase risers, drape leftovers the bilinear would re-slope) — they
 *  render DRY, leaving flat mirrors separated by riffle breaks. Lakes and
 *  flat pools have ~zero wet-wet gradient and are untouched. */
const MAX_SURFACE_SLOPE = 0.05;

export function flattenPooledWater(
  raw: Float32Array,
  bed: Float32Array,
  res: number,
  texel: number,
): FlattenStats {
  const n = res * res;
  // tentative fill level per cell (only meaningful on wet cells)
  const fill = new Float32Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap(Math.max(1024, res * 8), fill);

  // 1. seeds: wet cells touching dry/border, at their raw surface level.
  // Seeds are NOT final — a raised bubble-rim cell that touches dry ground
  // still gets re-lowered when the flood reaches it through the pool's true
  // (lowest) outlet, so no wall of seed cells survives around a flat pool.
  let wetCells = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      if ((raw[i] as number) <= DRY) continue;
      wetCells++;
      let outlet = x === 0 || y === 0 || x === res - 1 || y === res - 1;
      if (!outlet) {
        outlet =
          (raw[i - 1] as number) <= DRY ||
          (raw[i + 1] as number) <= DRY ||
          (raw[i - res] as number) <= DRY ||
          (raw[i + res] as number) <= DRY;
      }
      if (outlet) {
        fill[i] = raw[i] as number;
        heap.push(i);
      }
    }
  }

  // 2. priority-flood the wet region from the outlets (lazy-decrease heap:
  // stale entries are skipped via the `done` flag)
  while (heap.size > 0) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    const level = fill[i] as number;
    const x = i % res;
    const y = (i / res) | 0;
    // 4-connectivity matches the wet/dry adjacency used for seeding
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x;
      const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
      if (nx < 0 || ny < 0 || nx >= res || ny >= res) continue;
      const ni = ny * res + nx;
      if (done[ni] || (raw[ni] as number) <= DRY) continue;
      const b = bed[ni] as number;
      // stepped fill: hold the pool level FLAT until the bed climbs a full
      // POOL_STEP above it, then start the next pool anchored at the bed.
      // Cells whose bed sits within (level, level+STEP] keep the flat level
      // BELOW their bed — they render dry, forming the riffle break between
      // two mirror-flat pools.
      const cand = b > level + POOL_STEP ? b : level;
      if (cand < (fill[ni] as number)) {
        fill[ni] = cand;
        heap.push(ni);
      }
    }
  }

  // 3. Every wet cell takes min(raw, stepped pool level): the correction
  // only ever LOWERS water — bubble domes and slope-draped sheets get cut
  // down to flat stepped mirrors (dry riffle breaks where the level dives
  // under the bed), while existing shallow films and pools are never
  // deepened (owner constraint: no redefining puddles/streams as deep).
  let pooledCells = 0;
  let maxDrop = 0;
  for (let i = 0; i < n; i++) {
    if ((raw[i] as number) <= DRY || !done[i]) continue;
    const f = fill[i] as number;
    const r = raw[i] as number;
    if (f < r) {
      const drop = r - f;
      if (drop > maxDrop) maxDrop = drop;
      raw[i] = f;
      pooledCells++;
    }
  }

  // 4. slope cut: dry out wet cells whose surface still slopes toward a
  // wet neighbor (see MAX_SURFACE_SLOPE). Two-phase (collect then apply)
  // so the scan sees a consistent field.
  const maxDelta = MAX_SURFACE_SLOPE * texel;
  const cut: number[] = [];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const w = raw[i] as number;
      if (w <= DRY) continue;
      let grad = 0;
      if (x > 0 && (raw[i - 1] as number) > DRY) grad = Math.max(grad, Math.abs(w - (raw[i - 1] as number)));
      if (x < res - 1 && (raw[i + 1] as number) > DRY) grad = Math.max(grad, Math.abs(w - (raw[i + 1] as number)));
      if (y > 0 && (raw[i - res] as number) > DRY) grad = Math.max(grad, Math.abs(w - (raw[i - res] as number)));
      if (y < res - 1 && (raw[i + res] as number) > DRY) grad = Math.max(grad, Math.abs(w - (raw[i + res] as number)));
      if (grad > maxDelta) cut.push(i);
    }
  }
  for (const i of cut) raw[i] = -1e4;
  return { wetCells, pooledCells, maxDrop };
}
