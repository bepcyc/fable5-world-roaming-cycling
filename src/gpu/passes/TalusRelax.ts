/**
 * TalusRelax — universal angle-of-repose (talus) relaxation on the FULL-RES
 * height buffer. Bake-time only, fully deterministic (no RNG, fixed iteration
 * count, ping-pong buffers — bit-reproducible per seed).
 *
 * Why it exists: both existing talus relaxations run at SIM res (2 m/texel) —
 * Erosion.ts thermalK (every erosion iteration) and FlowRivers mkRelax (after
 * river carve). Two architectural gaps let near-vertical walls through to the
 * final field anyway:
 *   1. composeEroded() re-adds the full-res detail residual (raw synth minus
 *      its own sim-res upsample) — that residual never saw ANY relaxation.
 *   2. RoadField.carve() cuts directly into the composed full-res field with
 *      no relaxation afterwards; its apron border butts into the unrelaxed
 *      surroundings.
 * This pass is applied twice from Heightfield.generate() (post-compose and
 * post-road-carve) and is the final authority on slope form.
 *
 * Kernel: gather form over all 8 neighbors (Erosion.ts thermalK template —
 * symmetric pair transfers, no atomics). Material law: critical slope
 * tanθc = min(0.50 + hardness^2.2 · 3.0, 1.54)
 *   hardness 0.08 (bog floor)   → 27°   loose soil angle of repose
 *   hardness 0.34 (soil base)   → 38°   owner's 36–40° soft-ground ceiling
 *   hardness ≥0.62 (rock/karst) → 57°   ceiling: rock belts near crests stay
 *                                       steep and short; valley-to-peak sheer
 *                                       walls relax (owner 2026-07-14: "просили
 *                                       баварские Альпы, сделали Пакистан")
 * plus shed-rate max((1−hardness)^1.5, 0.20) — soft soil flows freely; rock is
 * slow but NOT frozen, so super-critical rock faces actually shed their excess
 * (the old (1−h)^1.5 alone gave karst 0.005 → walls never moved at all).
 *
 * Optional gates (weight → 0 freezes a cell):
 *   waterY   — shoreline cells ≤0.4 m above the water surface are frozen so
 *              the baked water sheet never ends up perched over a slumped bank
 *              (the "гель над ямкой" bug class — see reconcileWaterAfterCarve).
 *   roadField — tread + shoulder (+2 m) untouched, full relax from +8 m out;
 *              Heightfield re-runs roadField.carve() afterwards to re-pin the
 *              designed profile exactly (probe-roadgates guard).
 */

import type { ComputeNode, Renderer } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  clamp,
  float,
  instanceIndex,
  instancedArray,
  max,
  smoothstep,
  vec2,
} from 'three/tsl';
import { bilerpFloatBuffer, uvToGrid } from '../BufferSample';
import type { NF, NI } from '../TSLTypes';
import type { FloatBuffer } from './HeightSynthesis';
import { ROAD_SHOULDER, type RoadField } from './RoadField';

export interface TalusRelaxOpts {
  /** grid resolution (full res, 4096) */
  res: number;
  /** texel size in meters (WORLD_SIZE / res) */
  texel: number;
  /** number of ping-pong PAIRS of half-steps (A→B, B→A); result stays in height */
  iters: number;
  /** sim-res water surface: shore cells freeze so water never perches */
  waterY?: { buf: FloatBuffer; res: number };
  /** road mask (post-carve pass only): tread + shoulder stay untouched */
  roadField?: RoadField;
}

/** all 8 neighbors — diagonal gully banks relax as well as axis-aligned ones
 *  (FlowRivers' cardinal-only slice(0,4) was half-blind to meanders) */
const OFFS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
];
/** transfer rate per half-step per neighbor pair; worst-case total outflow
 *  8·K = 0.48 of the excess — same stability margin as the proven FlowRivers
 *  relax (4·0.12), plus the hard CAP below (Erosion.ts pattern) */
const K = 0.1;
/** max net displacement per half-step (m) — 0.35→0.9 (2026-07-14): tall
 *  (80–160 m) rock walls need >60 m of redistribution; at 0.35 the fixed
 *  iteration budget could never converge them to the material ceiling */
const CAP = 0.9;

/** critical slope (rise/run) for the material — see header table.
 *  Bavarian-Alps retune 2026-07-14: rock ceiling 64°→57° (tan 2.05→1.54) —
 *  Wetterstein-style rock belts stay steep and short near the crests, but
 *  valley-to-peak sheer walls do not exist there. Soft-ground angles
 *  (hardness ≤0.34 → ≤38°) are unchanged. */
const tanCrit = (hard: NF): NF => float(0.5).add(hard.pow(2.2).mul(3.0)).min(1.54);
/** shed rate: soft soil flows, hard rock is slow but never frozen (see header);
 *  floor 0.1→0.2 + K 0.06→0.1: hard-rock decay ≈3× faster per half-step —
 *  the old K·shed=0.006 never converged in the 28-pair budget (8·K=0.8 < 1,
 *  same stability margin class as FlowRivers' 4·0.12) */
const shedRate = (hard: NF): NF => float(1).sub(hard).pow(1.5).max(0.25);

export async function runTalusRelax(
  renderer: Renderer,
  height: FloatBuffer,
  hardness: FloatBuffer,
  opts: TalusRelaxOpts,
): Promise<void> {
  const { res, texel, iters } = opts;
  const N = res * res;
  const worldSize = texel * res;
  const hT = instancedArray(N, 'float'); // transient ping-pong partner

  const guard = (body: () => void) =>
    Fn<void>(() => {
      If(instanceIndex.greaterThanEqual(N), () => {
        Return();
      });
      body();
    });

  const cellXY = (): { x: NI; y: NI; i: NI } => {
    const i = instanceIndex.toInt();
    return { x: i.mod(res), y: i.div(res), i };
  };
  /** clamped neighbor index */
  const at = (x: NI, y: NI, ox: number, oy: number): NI => {
    const cx = clamp(float(x).add(ox), 0, res - 1).toInt();
    const cy = clamp(float(y).add(oy), 0, res - 1).toInt();
    return cy.mul(res).add(cx);
  };

  const mkStep = (src: FloatBuffer, dst: FloatBuffer): ComputeNode => {
    const k = guard(() => {
      const { x, y, i } = cellXY();
      const h0 = src.element(i).toVar();
      const hard0 = hardness.element(i).toVar();
      const tan0 = tanCrit(hard0);
      const rate0 = shedRate(hard0);
      // net material transfer (m of height): symmetric pair terms — excess
      // over the angle of repose sheds downhill at the SOFTER side's rate
      let net: NF = float(0);
      for (const [ox, oy] of OFFS) {
        const dist = texel * Math.hypot(ox, oy);
        const j = at(x, y, ox, oy);
        const hn = src.element(j);
        const hardN = hardness.element(j).toVar();
        const excOut = max(0, h0.sub(hn).sub(tan0.mul(dist)));
        const excIn = max(0, hn.sub(h0).sub(tanCrit(hardN).mul(dist)));
        net = net.add(excIn.mul(shedRate(hardN))).sub(excOut.mul(rate0));
      }

      // --- shape gates (weight 0 = frozen cell) ---------------------------
      let w: NF = float(1);
      const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(res);
      if (opts.waterY) {
        // sim-res waterY: dry cells hold bed−2 (Heightfield.buildWaterY), so
        // h0 > wy+1.2 everywhere on dry land — the gate only bites at shores
        const wy = bilerpFloatBuffer(
          opts.waterY.buf,
          opts.waterY.res,
          uvToGrid(uv, opts.waterY.res),
        );
        w = w.mul(smoothstep(wy.add(0.4), wy.add(1.2), h0)) as NF;
      }
      if (opts.roadField) {
        const p = uv.sub(0.5).mul(worldSize);
        const rs = opts.roadField.sampleBaked(p);
        const dCore = rs.halfW.add(ROAD_SHOULDER);
        // tread+shoulder+2 m frozen, full relax from +8 m out; where there is
        // no road at all halfW=0 (bake sentinel) → weight 1
        const wRoad = rs.halfW
          .greaterThan(0.01)
          .select(smoothstep(dCore.add(2), dCore.add(8), rs.dist), float(1));
        w = w.mul(wRoad) as NF;
      }

      dst.element(i).assign(h0.add(clamp(net.mul(K), -CAP, CAP).mul(w)));
    })().compute(N);
    k.setName('talusRelax');
    return k;
  };

  // even number of half-steps: result always lands back in `height`
  const kA = mkStep(height, hT);
  const kB = mkStep(hT, height);
  const nodes: ComputeNode[] = [];
  for (let it = 0; it < iters; it++) nodes.push(kA, kB);
  await renderer.computeAsync(nodes);
}
