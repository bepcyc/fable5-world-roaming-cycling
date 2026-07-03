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
 *  3. A cell is POOLED where that fill level clears its bed by a margin;
 *     there the flat fill level replaces the raw domed surface. Where
 *     the fill hugs the bed (flowing reach — water escapes downstream)
 *     the raw sloped surface is kept, so rivers do not terrace.
 *
 * Lakes are already at their flat multigrid fill level W: the flood
 * reproduces W exactly, so they pass through unchanged.
 */

/** below this clearance over the bed the fill is "hugging" the channel —
 *  treat as flowing reach and keep the raw sloped surface */
const POOL_MARGIN = 0.06;
/** max UPWARD correction: filling a shallow concave dip to the spill level
 *  is legitimate (funnel dips around islands), but a marsh sitting meters
 *  below its topographic spill is its own waterbody at its own level —
 *  raising it builds translucent water walls over the terrain (seen at the
 *  Dawn-lake bookmark). Such cells keep their raw surface. */
const RAISE_CAP = 1.0;
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
export function flattenPooledWater(
  raw: Float32Array,
  bed: Float32Array,
  res: number,
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
      const cand = level > b ? level : b;
      if (cand < (fill[ni] as number)) {
        fill[ni] = cand;
        heap.push(ni);
      }
    }
  }

  // 3. pooled cells take the flat fill level; flowing reaches keep the raw
  // slope. Downward correction (bubble domes) is unbounded; upward is
  // capped (RAISE_CAP) so under-spill marshes stay at their own level.
  let pooledCells = 0;
  let maxDrop = 0;
  for (let i = 0; i < n; i++) {
    if ((raw[i] as number) <= DRY || !done[i]) continue;
    const f = fill[i] as number;
    const r = raw[i] as number;
    if (f > (bed[i] as number) + POOL_MARGIN && f < r + RAISE_CAP) {
      const drop = r - f;
      if (drop > maxDrop) maxDrop = drop;
      raw[i] = f;
      pooledCells++;
    }
  }
  return { wetCells, pooledCells, maxDrop };
}
