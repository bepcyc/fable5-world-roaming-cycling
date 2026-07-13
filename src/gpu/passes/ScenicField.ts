/**
 * ScenicField — GPU side of the P.5 v2 scenic contour bands (ref-04).
 *
 * A deliberately LIGHT sibling of RoadField: the same segment/bucket layout
 * and the same signed-lateral bake, but nothing else — no carve, no vertical
 * profiles, no surface stamp, no veg audit. The polylines from
 * ScenicContours are purely decorative; the terrain material tints a narrow
 * band around them at mid/far camera distances (composition read of green
 * flanks lined with near-level paths).
 *
 * The field is baked ONCE at boot and never touched again; the per-fragment
 * cost in the material is a single bilinear buffer sample + cheap math.
 *
 * Sign convention: ScenicContours orients every polyline so the UPHILL side
 * of the flank has POSITIVE lat (the material darkens the negative/downhill
 * band edge). SIGNED distance keeps bilinear reconstruction sub-texel exact
 * across the centerline (same rationale as RoadField's signed lat).
 */

import type { Renderer, StorageBufferNode } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Return,
  clamp,
  float,
  instanceIndex,
  instancedArray,
  vec2,
} from 'three/tsl';
import { bilerpFloatBuffer, uvToGrid } from '../BufferSample';
import type { NF, NI, NU, NV2, NV4 } from '../TSLTypes';
import type { FloatBuffer } from './HeightSynthesis';
import type { ScenicPolyline } from '../../ride/ScenicContours';
import { WORLD_SIZE } from '../../world/WorldConst';

/** baked-field resolution (4 m/texel — the signed lateral is near-linear
 *  around the band, so bilinear reconstruction stays sub-texel accurate) */
export const SCENIC_FIELD_RES = 1024;
/** "no band here" sentinel for the signed lateral (m) */
export const SCENIC_FAR = 24;

const BUCKET_N = 128; // 32 m bucket cells over the world
const BUCKET_R = 26; // segment gather radius > widest material response (m)

export interface ScenicSampleBaked {
  /** signed centerline distance (m; positive = uphill side; SCENIC_FAR = none) */
  lat: NF;
  /** unsigned centerline distance (m) */
  dist: NF;
}

export class ScenicField {
  private readonly segsA: StorageBufferNode<'vec4'>; // ax, az, bx, bz
  private readonly starts: StorageBufferNode<'uint'>;
  private readonly list: StorageBufferNode<'uint'>;
  private readonly nSeg: number;
  /** baked signed lateral (SCENIC_FIELD_RES², f32) */
  latBuf: FloatBuffer | null = null;

  constructor(polys: ScenicPolyline[]) {
    const segs: { ax: number; az: number; bx: number; bz: number }[] = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.pts.length - 1; i++) {
        const a = poly.pts[i] as [number, number];
        const b = poly.pts[i + 1] as [number, number];
        segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1] });
      }
    }
    const n = Math.max(segs.length, 1);
    const a = new Float32Array(n * 4);
    segs.forEach((s, i) => {
      a.set([s.ax, s.az, s.bx, s.bz], i * 4);
    });

    // bucket grid: segment index lists per 32 m cell (RoadField pattern)
    const cellM = WORLD_SIZE / BUCKET_N;
    const lists: number[][] = Array.from({ length: BUCKET_N * BUCKET_N }, () => []);
    segs.forEach((s, i) => {
      const minX = Math.min(s.ax, s.bx) - BUCKET_R;
      const maxX = Math.max(s.ax, s.bx) + BUCKET_R;
      const minZ = Math.min(s.az, s.bz) - BUCKET_R;
      const maxZ = Math.max(s.az, s.bz) + BUCKET_R;
      const c0x = Math.max(0, Math.floor((minX / WORLD_SIZE + 0.5) * BUCKET_N));
      const c1x = Math.min(BUCKET_N - 1, Math.floor((maxX / WORLD_SIZE + 0.5) * BUCKET_N));
      const c0z = Math.max(0, Math.floor((minZ / WORLD_SIZE + 0.5) * BUCKET_N));
      const c1z = Math.min(BUCKET_N - 1, Math.floor((maxZ / WORLD_SIZE + 0.5) * BUCKET_N));
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const rx0 = (cx / BUCKET_N - 0.5) * WORLD_SIZE;
          const rz0 = (cz / BUCKET_N - 0.5) * WORLD_SIZE;
          if (segRectDist(s.ax, s.az, s.bx, s.bz, rx0, rz0, rx0 + cellM, rz0 + cellM) <= BUCKET_R) {
            (lists[cz * BUCKET_N + cx] as number[]).push(i);
          }
        }
      }
    });
    const starts = new Uint32Array(BUCKET_N * BUCKET_N + 1);
    let total = 0;
    lists.forEach((l, i) => {
      starts[i] = total;
      total += l.length;
    });
    starts[BUCKET_N * BUCKET_N] = total;
    const flat = new Uint32Array(Math.max(total, 1));
    let o = 0;
    for (const l of lists) for (const i of l) flat[o++] = i;

    this.segsA = instancedArray(a, 'vec4');
    this.starts = instancedArray(starts, 'uint');
    this.list = instancedArray(flat, 'uint');
    this.nSeg = segs.length;
  }

  // ------------------------------------------------------------------- bake
  /** bake the SCENIC_FIELD_RES² signed-lateral field (material source) */
  async bake(renderer: Renderer): Promise<void> {
    const FR = SCENIC_FIELD_RES;
    const lat = instancedArray(FR * FR, 'float');
    const { segsA, starts, list, nSeg } = this;
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(FR * FR), () => {
        Return();
      });
      if (nSeg === 0) {
        lat.element(i).assign(SCENIC_FAR);
        return;
      }
      const x = i.mod(FR);
      const y = i.div(FR);
      const p = vec2(float(x).add(0.5), float(y).add(0.5)).div(FR).sub(0.5).mul(WORLD_SIZE);
      const cx = clamp(p.x.div(WORLD_SIZE).add(0.5).mul(BUCKET_N).floor(), 0, BUCKET_N - 1).toInt();
      const cz = clamp(p.y.div(WORLD_SIZE).add(0.5).mul(BUCKET_N).floor(), 0, BUCKET_N - 1).toInt();
      const ci = cz.mul(BUCKET_N).add(cx);
      const s0 = (starts.element(ci) as unknown as NU).toInt();
      const s1 = (starts.element(ci.add(1)) as unknown as NU).toInt();
      const bestD = float(1e5).toVar();
      const bestSide = float(1).toVar();
      const has = float(0).toVar();
      Loop({ start: s0, end: s1, type: 'int', condition: '<' }, ({ i: k }: { readonly i: NI }) => {
        const si = (list.element(k) as unknown as NU).toInt();
        const A = segsA.element(si) as unknown as NV4;
        const ab = A.zw.sub(A.xy);
        const len2 = ab.dot(ab).max(1e-6);
        const t = p.sub(A.xy).dot(ab).div(len2).saturate();
        const dv = p.sub(A.xy.add(ab.mul(t)));
        const d = dv.length();
        If(d.lessThan(bestD), () => {
          bestD.assign(d);
          bestSide.assign(ab.x.mul(dv.y).sub(ab.y.mul(dv.x)).sign());
          has.assign(1);
        });
      });
      lat
        .element(i)
        .assign(
          has
            .greaterThan(0.5)
            .select(clamp(bestD.mul(bestSide), -SCENIC_FAR, SCENIC_FAR), float(SCENIC_FAR)),
        );
    })().compute(FR * FR);
    kernel.setName('scenicFieldBake');
    await renderer.computeAsync(kernel);
    this.latBuf = lat;
  }

  // -------------------------------------------------- baked-field sampling
  /** cheap per-fragment sample: one bilinear buffer read + abs */
  sampleBaked(p: NV2): ScenicSampleBaked {
    const latB = this.latBuf;
    if (!latB) throw new Error('ScenicField.bake() must run first');
    const FR = SCENIC_FIELD_RES;
    const uv = clamp(p.div(WORLD_SIZE).add(0.5), 0, 1);
    const lat = bilerpFloatBuffer(latB, FR, uvToGrid(uv, FR));
    return { lat, dist: lat.abs() };
  }
}

/** CPU: min distance from segment (a,b) to axis-aligned rect (RoadField's
 *  sample-based conservative estimate — 9 points along the segment) */
function segRectDist(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number {
  let best = Infinity;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    const dx = Math.max(x0 - px, 0, px - x1);
    const dz = Math.max(z0 - pz, 0, pz - z1);
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}
