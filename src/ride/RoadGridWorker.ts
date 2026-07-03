/**
 * Road router-grid worker — computes a horizontal band of the 512² routing
 * grids (height + water depth) from row slices of the CPU terrain mirrors.
 * Pure function of its inputs; job order is preserved by the pool, so the
 * result is bit-identical to the single-threaded path (determinism law).
 */

export interface RoadGridJob {
  /** output rows [z0, z1) of the N×N router grid */
  z0: number;
  z1: number;
  n: number;
  worldSize: number;
  /** height rows [hRow0, hRow0+rows) at full res */
  heights: Float32Array;
  hRow0: number;
  hRes: number;
  /** waterY rows [wRow0, ...) at sim res */
  waterY: Float32Array;
  wRow0: number;
  wRes: number;
}

export interface RoadGridResult {
  z0: number;
  gh: Float32Array;
  gd: Float32Array;
}

function bilerpRows(
  a: Float32Array,
  res: number,
  row0: number,
  x: number,
  z: number,
  worldSize: number,
): number {
  const gx = Math.min(Math.max((x / worldSize + 0.5) * res - 0.5, 0), res - 1.001);
  const gz = Math.min(Math.max((z / worldSize + 0.5) * res - 0.5, 0), res - 1.001);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;
  const rows = a.length / res;
  const at = (xx: number, zz: number): number => {
    const r = Math.min(Math.max(zz - row0, 0), rows - 1);
    return a[r * res + Math.min(xx, res - 1)] ?? 0;
  };
  const t = at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx;
  const b = at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx;
  return t * (1 - fz) + b * fz;
}

export function computeRoadGridBand(job: RoadGridJob): RoadGridResult {
  const { z0, z1, n, worldSize } = job;
  const rows = z1 - z0;
  const gh = new Float32Array(rows * n);
  const gd = new Float32Array(rows * n);
  const cw = (c: number): number => ((c + 0.5) / n - 0.5) * worldSize;
  for (let z = z0; z < z1; z++) {
    for (let x = 0; x < n; x++) {
      const wx = cw(x);
      const wz = cw(z);
      const h = bilerpRows(job.heights, job.hRes, job.hRow0, wx, wz, worldSize);
      const w = bilerpRows(job.waterY, job.wRes, job.wRow0, wx, wz, worldSize);
      gh[(z - z0) * n + x] = h;
      gd[(z - z0) * n + x] = Math.max(0, w - h);
    }
  }
  return { z0, gh, gd };
}

// worker entry (absent when imported for the single-threaded fallback)
if (typeof self !== 'undefined' && typeof (self as { postMessage?: unknown }).postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (ev: MessageEvent<RoadGridJob>): void => {
    const r = computeRoadGridBand(ev.data);
    (self as unknown as { postMessage(m: RoadGridResult, t: Transferable[]): void }).postMessage(
      r,
      [r.gh.buffer, r.gd.buffer],
    );
  };
}
