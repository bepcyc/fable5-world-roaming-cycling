/**
 * RoadField — GPU side of the M1.2 road network.
 *
 * Owns the uploaded segment/bucket buffers and every pass that consumes them:
 *   - carve():  flatten the 4096² height buffer to the road profiles (runs
 *     after composeEroded, BEFORE rebuildDerivedMaps — Heightfield order)
 *   - bake():   2048² baked field (signed lateral + per-texel meta) — the
 *     ONE road-distance source for the material, veg exclusion and audits;
 *     using a single sampler is the anti-drift guard (assessment §5.3)
 *   - stamp():  write SurfaceId 10–14 into the M1.1 surface map (after
 *     runSurfaceClassify; water classes keep priority — fords stay water)
 *   - vegAudit(): counts scatter instances inside the road surface (probe)
 *
 * LOCKSTEP TRIANGLE (see TerrainMaterial.ts / SurfaceClassify.ts headers):
 * splat weights ↔ classifier ↔ road mix. The road's material blend reads
 * the SAME baked field this module writes; any change to widths/shoulder
 * geometry here changes carve, stamp, material and veg together.
 *
 * Realism: cross-sections carry crown + superelevation (banking); cut/fill
 * embankments blend at ≈1:1.6 slopes with aprons sized by the actual
 * height mismatch — roads sit in the terrain, never float over it.
 */

import type { Renderer, StorageBufferNode } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Return,
  atomicAdd,
  clamp,
  float,
  instanceIndex,
  instancedArray,
  int,
  mix,
  smoothstep,
  uint,
  vec2,
  vec4,
} from 'three/tsl';
import { bilerpFloatBuffer, uvToGrid } from '../BufferSample';
import type { NF, NI, NU, NV2, NV4 } from '../TSLTypes';
import type { FloatBuffer } from './HeightSynthesis';
import type { UintBuffer } from './SurfaceClassify';
import { ROAD_CLASSES, RoadNetwork } from '../../ride/RoadNetwork';
import { SurfaceId } from '../../ride/SurfaceMatrix';
import { WORLD_SIZE } from '../../world/WorldConst';

/** baked-field resolution (2 m/texel — the signed lateral is near-linear
 *  around the corridor, so bilinear reconstruction is sub-texel accurate) */
export const ROAD_FIELD_RES = 2048;
/** "no road here" sentinel for the signed lateral (m) */
export const ROAD_FAR = 64;
/** compacted shoulder beyond the surfaced half-width (m) — carve keeps it
 *  at profile grade; the material paints it as worn verge */
export const ROAD_SHOULDER = 0.7;
/** embankment run per rise (1:1.6 ≈ 32° — stable engineered fill) */
const EMBANK_RUN = 1.6;

const BUCKET_N = 128; // 32 m bucket cells over the world
const BUCKET_R = 34; // segment gather radius ≥ max carve reach (m)

export interface RoadSampleBaked {
  /** baked centerline distance (m; ROAD_FAR = no road) — unsigned */
  lat: NF;
  /** unsigned centerline distance (m) */
  dist: NF;
  halfW: NF;
  /** SurfaceId as float (exact small integers) */
  surfIdF: NF;
  /** 0..1 how much micro-displacement survives on this surface */
  dispScale: NF;
  /** 1 where the nearest segment is a ford */
  ford: NF;
  /** 1 inside the surfaced width, 0 outside (smooth 0.7 m edge) */
  edgeK: NF;
}

interface SegBuffers {
  segsA: StorageBufferNode<'vec4'>; // ax, az, bx, bz
  segsB: StorageBufferNode<'vec4'>; // y0, y1, halfW, surfIdF
  segsC: StorageBufferNode<'vec4'>; // bank0, bank1, dispScale, fordF
  starts: StorageBufferNode<'uint'>; // bucket start offsets (BUCKET_N²+1)
  list: StorageBufferNode<'uint'>; // flattened segment indices
  nSeg: number;
}

export class RoadField {
  readonly net: RoadNetwork;
  private readonly seg: SegBuffers;
  /** baked signed lateral (ROAD_FIELD_RES², f32) */
  latBuf: FloatBuffer | null = null;
  /** baked per-texel meta of the nearest segment (halfW, surfId, disp, ford) */
  metaBuf: StorageBufferNode<'vec4'> | null = null;

  constructor(net: RoadNetwork) {
    this.net = net;
    this.seg = RoadField.upload(net);
  }

  // ------------------------------------------------------------------ upload
  private static upload(net: RoadNetwork): SegBuffers {
    const segs = [...net.segments()];
    const n = Math.max(segs.length, 1);
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const c = new Float32Array(n * 4);
    segs.forEach((s, i) => {
      a.set([s.ax, s.az, s.bx, s.bz], i * 4);
      b.set([s.y0, s.y1, s.cls.halfWidth, s.cls.surfaceId], i * 4);
      c.set([s.bank0, s.bank1, s.cls.dispScale, s.ford ? 1 : 0], i * 4);
    });

    // bucket grid: segment index lists per 32 m cell (within BUCKET_R reach)
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
          // exact rect-to-segment distance gate (AABB pre-filter above)
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

    return {
      segsA: instancedArray(a, 'vec4'),
      segsB: instancedArray(b, 'vec4'),
      segsC: instancedArray(c, 'vec4'),
      starts: instancedArray(starts, 'uint'),
      list: instancedArray(flat, 'uint'),
      nSeg: segs.length,
    };
  }

  // ------------------------------------------------------- exact evaluation
  /**
   * Full bucket-loop evaluation at world xz (boot kernels only: carve/stamp).
   * Returns everything the cross-section needs; `has` gates empty buckets.
   */
  private evalExact(p: NV2): {
    has: NF;
    dist: NF;
    lat: NF;
    profile: NF;
    halfW: NF;
    surfIdF: NF;
    dispScale: NF;
    ford: NF;
  } {
    const { segsA, segsB, segsC, starts, list } = this.seg;
    const cx = clamp(p.x.div(WORLD_SIZE).add(0.5).mul(BUCKET_N).floor(), 0, BUCKET_N - 1).toInt();
    const cz = clamp(p.y.div(WORLD_SIZE).add(0.5).mul(BUCKET_N).floor(), 0, BUCKET_N - 1).toInt();
    const ci = cz.mul(BUCKET_N).add(cx);
    const s0 = (starts.element(ci) as unknown as NU).toInt();
    const s1 = (starts.element(ci.add(1)) as unknown as NU).toInt();

    const bestD = float(1e5).toVar();
    const bestSide = float(1).toVar();
    const bestT = float(0).toVar();
    const bestSeg = int(0).toVar();
    // runner-up from a DIFFERENT road (junction partner) — its profile is
    // blended in near crossings so intersections grade smoothly instead of
    // stepping between the two carved surfaces (a rideable junction apron)
    const nextD = float(1e5).toVar();
    const nextT = float(0).toVar();
    const nextSeg = int(0).toVar();
    const has = float(0).toVar();
    Loop({ start: s0, end: s1, type: 'int', condition: '<' }, ({ i }: { readonly i: NI }) => {
      const si = (list.element(i) as unknown as NU).toInt();
      const A = segsA.element(si) as unknown as NV4;
      const ab = A.zw.sub(A.xy);
      const len2 = ab.dot(ab).max(1e-6);
      const t = p.sub(A.xy).dot(ab).div(len2).saturate();
      const dv = p.sub(A.xy.add(ab.mul(t)));
      const d = dv.length();
      // segment endpoints of the same polyline are ~14 m apart — treat
      // candidates whose foot points are near as "the same road"
      const bq = segsA.element(bestSeg) as unknown as NV4;
      const bFoot = bq.xy.add(bq.zw.sub(bq.xy).mul(bestT));
      const foot = A.xy.add(ab.mul(t));
      const sameRoad = foot.sub(bFoot).length().lessThan(10);
      If(d.lessThan(bestD), () => {
        If(has.greaterThan(0.5).and(sameRoad.not()), () => {
          nextD.assign(bestD);
          nextT.assign(bestT);
          nextSeg.assign(bestSeg);
        });
        bestD.assign(d);
        bestT.assign(t);
        bestSeg.assign(si);
        bestSide.assign(ab.x.mul(dv.y).sub(ab.y.mul(dv.x)).sign());
        has.assign(1);
      }).ElseIf(d.lessThan(nextD).and(sameRoad.not()), () => {
        nextD.assign(d);
        nextT.assign(t);
        nextSeg.assign(si);
      });
    });

    const B = segsB.element(bestSeg) as unknown as NV4;
    const C = segsC.element(bestSeg) as unknown as NV4;
    const lat = bestD.mul(bestSide);
    const halfW = B.z;
    const surfIdF = B.w;
    const yC = mix(B.x, B.y, bestT);
    const bank = mix(C.x, C.y, bestT);
    const crown = crownOf(surfIdF);
    // finished cross-section: centerline + superelevation + drainage camber
    let profile = yC
      .add(bank.mul(lat))
      .add(crown.mul(halfW.sub(bestD).max(0)));
    // junction apron: within the crossing footprint the two road surfaces
    // meet — blend toward the partner's centerline height as it gets close
    const B2 = segsB.element(nextSeg) as unknown as NV4;
    const y2 = mix(B2.x, B2.y, nextT);
    // gate on the surfaced widths actually overlapping (true crossing) —
    // switchback legs of one serpentine run ~15–25 m apart and must NOT
    // exchange heights (found the hard way: ±2 m steps on hill gravel)
    const meetW = smoothstep(B2.z.add(halfW), float(0), nextD).mul(0.5);
    profile = mix(profile, y2, meetW);
    return {
      has,
      dist: bestD,
      lat,
      profile,
      halfW,
      surfIdF,
      dispScale: C.z,
      ford: C.w,
    };
  }

  // ------------------------------------------------------------------ carve
  /** flatten the height buffer to the road profiles (cut/fill embankments) */
  async carve(renderer: Renderer, height: FloatBuffer, res: number): Promise<void> {
    if (this.seg.nSeg === 0) return;
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(res * res), () => {
        Return();
      });
      const x = i.mod(res);
      const y = i.div(res);
      const p = vec2(float(x).add(0.5), float(y).add(0.5)).div(res).sub(0.5).mul(WORLD_SIZE);
      const r = this.evalExact(p);
      If(r.has.greaterThan(0.5), () => {
        const h = height.element(i);
        const dCore = r.halfW.add(ROAD_SHOULDER);
        const dh = h.sub(r.profile);
        // embankment apron: run grows with the actual cut/fill height
        const apron = clamp(dh.abs().mul(EMBANK_RUN).add(2.5), 3, 26);
        const w = smoothstep(dCore.add(apron), dCore, r.dist);
        height.element(i).assign(mix(h, r.profile, w));
      });
    })().compute(res * res);
    kernel.setName('roadCarve');
    await renderer.computeAsync(kernel);
  }

  // ------------------------------------------------------------------- bake
  /** bake the 2048² signed-lateral + meta field (material/veg/audit source) */
  async bake(renderer: Renderer): Promise<void> {
    const FR = ROAD_FIELD_RES;
    const lat = instancedArray(FR * FR, 'float');
    const meta = instancedArray(FR * FR, 'vec4');
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(FR * FR), () => {
        Return();
      });
      const x = i.mod(FR);
      const y = i.div(FR);
      const p = vec2(float(x).add(0.5), float(y).add(0.5)).div(FR).sub(0.5).mul(WORLD_SIZE);
      if (this.seg.nSeg === 0) {
        lat.element(i).assign(ROAD_FAR);
        meta.element(i).assign(vec4(0, 0, 0, 0));
        return;
      }
      const r = this.evalExact(p);
      const ok = r.has.greaterThan(0.5);
      // SIGNED lateral: bilinear across the centerline passes through zero
      // exactly, so |bilerp| stays sub-texel accurate — narrow singletrack
      // (halfW 0.55 < the 2 m texel) survives. Sign flips between DIFFERENT
      // roads once caused diamond artifacts — cured at the source (the
      // router no longer duplicates corridors; see RoadNetwork markCells).
      lat.element(i).assign(ok.select(clamp(r.lat, -ROAD_FAR, ROAD_FAR), float(ROAD_FAR)));
      meta
        .element(i)
        .assign(
          ok.select(vec4(r.halfW, r.surfIdF, r.dispScale, r.ford), vec4(0, 0, 0, 0)),
        );
    })().compute(FR * FR);
    kernel.setName('roadFieldBake');
    await renderer.computeAsync(kernel);
    this.latBuf = lat;
    this.metaBuf = meta;
  }

  // ------------------------------------------------------------------ stamp
  /** write road SurfaceIds over the classified map (water keeps priority) */
  async stamp(renderer: Renderer, surface: UintBuffer, res: number): Promise<void> {
    if (this.seg.nSeg === 0) return;
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(res * res), () => {
        Return();
      });
      const x = i.mod(res);
      const y = i.div(res);
      const p = vec2(float(x).add(0.5), float(y).add(0.5)).div(res).sub(0.5).mul(WORLD_SIZE);
      const r = this.evalExact(p);
      const cur = surface.element(i);
      const isWater = cur
        .equal(uint(SurfaceId.WaterShallow))
        .or(cur.equal(uint(SurfaceId.WaterDeep)));
      // narrow trails (singletrack halfW < the 1 m map texel) still must own
      // the nearest texel row — floor the stamp width at the texel radius
      If(
        r.has
          .greaterThan(0.5)
          .and(r.dist.lessThan(r.halfW.max(0.75)))
          .and(isWater.not()),
        () => {
          surface.element(i).assign(r.surfIdF.add(0.5).toUint());
        },
      );
    })().compute(res * res);
    kernel.setName('roadStamp');
    await renderer.computeAsync(kernel);
  }

  // ------------------------------------------------- baked-field sampling
  /**
   * Cheap per-frame/per-candidate sample of the baked field — THE shared
   * road query for the terrain material, scatter exclusion and ground-ring
   * kernels (one sampler ⇒ no drift between sites).
   */
  sampleBaked(p: NV2): RoadSampleBaked {
    const latB = this.latBuf;
    const metaB = this.metaBuf;
    if (!latB || !metaB) throw new Error('RoadField.bake() must run first');
    const FR = ROAD_FIELD_RES;
    const uv = clamp(p.div(WORLD_SIZE).add(0.5), 0, 1);
    const lat = bilerpFloatBuffer(latB, FR, uvToGrid(uv, FR));
    const g = uv.mul(FR);
    const gx = clamp(g.x.floor(), 0, FR - 1).toInt();
    const gy = clamp(g.y.floor(), 0, FR - 1).toInt();
    const meta = metaB.element(gy.mul(FR).add(gx)) as unknown as NV4;
    const dist = lat.abs();
    const halfW = meta.x;
    const edgeK = smoothstep(halfW.add(0.35), halfW.sub(0.35), dist).mul(
      halfW.greaterThan(0.01).select(float(1), float(0)),
    );
    return {
      lat,
      dist,
      halfW,
      surfIdF: meta.y,
      dispScale: meta.z,
      ford: meta.w,
      edgeK,
    };
  }

  // ------------------------------------------------------------------ audit
  /** count instances of a scatter layer inside the road surface (probe) */
  async vegAudit(
    renderer: Renderer,
    layers: { name: string; bufA: StorageBufferNode<'vec4'>; count: number; margin: number }[],
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const layer of layers) {
      if (layer.count === 0 || this.seg.nSeg === 0) {
        out[layer.name] = 0;
        continue;
      }
      const counter = instancedArray(1, 'uint').toAtomic();
      const kernel = Fn(() => {
        const i = instanceIndex;
        If(i.greaterThanEqual(uint(layer.count)), () => {
          Return();
        });
        const A = layer.bufA.element(i) as unknown as NV4;
        const s = this.sampleBaked(vec2(A.x, A.z));
        If(
          s.halfW.greaterThan(0.01).and(s.dist.lessThan(s.halfW.add(layer.margin))),
          () => {
            atomicAdd(counter.element(0), uint(1));
          },
        );
      })().compute(layer.count);
      kernel.setName(`roadVegAudit-${layer.name}`);
      await renderer.computeAsync(kernel);
      const attr = (counter as unknown as { value: unknown }).value;
      const ab = await renderer.getArrayBufferAsync(
        attr as Parameters<Renderer['getArrayBufferAsync']>[0],
      );
      out[layer.name] = new Uint32Array(ab)[0] ?? 0;
    }
    return out;
  }
}

/** per-class crown cross-slope as a TSL select chain over the surface id */
function crownOf(surfIdF: NF): NF {
  let e: NF = float(0);
  for (const c of ROAD_CLASSES) {
    e = surfIdF
      .greaterThan(c.surfaceId - 0.5)
      .and(surfIdF.lessThan(c.surfaceId + 0.5))
      .select(float(c.crownSlope), e) as NF;
  }
  return e;
}

/** CPU: min distance from segment (a,b) to axis-aligned rect */
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
  // sample-based conservative estimate: 9 points along the segment vs rect
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
