/**
 * Surface classification at full height resolution — the M1.1 data layer.
 *
 * Discretizes the terrain into SurfaceId classes (src/ride/SurfaceMatrix.ts)
 * by replicating the MATERIAL's continuous-field splat weights 1:1
 * (src/render/TerrainMaterial.ts:216-254 — keep in lockstep on any splat
 * retune!) and picking the class with the largest composite contribution.
 * Running the same TSL math on the same GPU fields means the discrete map
 * matches what the player SEES by construction — no CPU noise-port drift.
 *
 * On top of the land argmax:
 *   - water from waterY − ground depth (same field the water surface renders
 *     from): > FORD_MAX_DEPTH_M ⇒ WaterDeep, > WATER_MIN_DEPTH_M ⇒ Shallow
 *   - wetland mud: Wetland biome + high moisture on near-flat ground
 *   - pond-silt beds (splat pondK) ⇒ Mud when not under standing water
 *
 * Output: u32 per texel (SurfaceId), res×res. Computed ONCE at boot — the
 * discrete field is spatially fixed, so consumers get temporal stability
 * for free; boundary hysteresis is the reader's job (majority sampling in
 * Heightfield.surfaceAtCpu). M1.2 roads stamp their classes over this map.
 */

import type { Renderer, StorageBufferNode, StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  float,
  instanceIndex,
  instancedArray,
  int,
  texture,
  smoothstep,
  uint,
  vec2,
} from 'three/tsl';
import { bilerpFloatBuffer, uvToGrid } from '../BufferSample';
import type { NF, NV4 } from '../TSLTypes';
import type { FloatBuffer } from './HeightSynthesis';
import { zoneMasks, type MacroParams } from '../../world/MacroMap';
import { Biome, WORLD_SIZE } from '../../world/WorldConst';
import { CLASSIFY, SurfaceId } from '../../ride/SurfaceMatrix';

export interface SurfaceClassifyOpts {
  res: number;
  simRes: number;
  mp: MacroParams;
  /** renderable water surface (m), sim res — waterY buffer */
  waterY: FloatBuffer;
  /** rgba8: biomeId/8, snow, vegDensity, rockExposure */
  biomeTex: StorageTexture;
  /** rgba16f at sim res: moisture, flowStrength, riverDepth, W */
  fieldsTex: StorageTexture;
}

export type UintBuffer = StorageBufferNode<'uint'>;

export async function runSurfaceClassify(
  renderer: Renderer,
  height: FloatBuffer,
  opts: SurfaceClassifyOpts,
): Promise<UintBuffer> {
  const { res, simRes, mp } = opts;
  const out = instancedArray(res * res, 'uint') as UintBuffer;
  const texel = WORLD_SIZE / res;

  const kernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(res * res), () => {
      Return();
    });
    const x = i.mod(res).toInt();
    const y = i.div(res).toInt();
    const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(res);
    const wpos = uv.sub(0.5).mul(WORLD_SIZE);
    const h = height.element(i).toVar();

    // central-difference slope — the exact rebuildDerivedMaps formula
    // (Heightfield.ts:508-509), so probe slope == material slope
    const xm = float(x).sub(1).clamp(0, res - 1).toInt();
    const xp = float(x).add(1).clamp(0, res - 1).toInt();
    const ym = float(y).sub(1).clamp(0, res - 1).toInt();
    const yp = float(y).add(1).clamp(0, res - 1).toInt();
    const hl = height.element(y.mul(res).add(xm));
    const hr = height.element(y.mul(res).add(xp));
    const hd = height.element(ym.mul(res).add(x));
    const hu = height.element(yp.mul(res).add(x));
    const slope = vec2(hl.sub(hr), hd.sub(hu)).length().div(texel * 2).toVar();

    const bio = texture(opts.biomeTex, uv, 0) as unknown as NV4;
    const snowField = bio.y;
    const vegDensity = bio.z;
    const rockExposure = bio.w;
    const biomeId = bio.x.mul(8).add(0.5).floor().toInt();
    const fields = texture(opts.fieldsTex, uv, 0) as unknown as NV4;
    const moisture = fields.x;
    const flowStrength = fields.y;
    const riverDepth = fields.z;
    const zm = zoneMasks(wpos, mp);

    // ---- splat class weights (TerrainMaterial.ts:216-246, sans dither) ----
    const rockW = smoothstep(0.62, 1.15, slope).max(rockExposure.mul(0.85)).toVar();
    const screeW = smoothstep(0.42, 0.62, slope)
      .mul(smoothstep(1.15, 0.7, slope))
      .mul(smoothstep(380, 700, h))
      .mul(rockW.oneMinus());
    const grassW = smoothstep(0.5, 0.22, slope)
      .mul(vegDensity)
      .mul(zm.tKarst.mul(0.5).oneMinus())
      .mul(rockW.oneMinus())
      .toVar();
    const forestW = vegDensity
      .mul(smoothstep(0.9, 0.45, slope))
      .mul(smoothstep(0.25, 0.6, moisture.add(zm.tKarst.mul(0.3))))
      .mul(rockW.oneMinus());
    const riverW = smoothstep(0.3, 0.68, flowStrength)
      .mul(smoothstep(0.45, 0.2, slope))
      .mul(grassW.mul(0.75).oneMinus());
    const pondK = smoothstep(1.1, 2.6, riverDepth).mul(smoothstep(0.3, 0.12, slope)).toVar();
    const snowW = smoothstep(0.16, 0.5, snowField);
    const gravelW = riverW.mul(0.85).mul(pondK.oneMinus());

    // ---- composite contributions (mix-chain algebra) -----------------------
    // mix(col, X, w) gives layer X weight w and scales everything before it
    // by (1−w); contribution of layer k = w_k · Π(1−w_j) over later layers j.
    const afterForest = forestW.oneMinus();
    const afterScree = screeW.oneMinus();
    const afterRock = rockW.oneMinus();
    const afterGravel = gravelW.oneMinus();
    const afterPond = pondK.oneMinus();
    const afterSnow = snowW.oneMinus();
    const tailRock = afterGravel.mul(afterPond).mul(afterSnow); // after the rock layer
    const tailScree = afterRock.mul(tailRock);
    const tailForest = afterScree.mul(tailScree);
    const tailGrass = afterForest.mul(tailForest);
    const cSoil = grassW.oneMinus().mul(tailGrass);
    const cGrass = grassW.mul(tailForest);
    const cForest = forestW.mul(tailScree);
    const cScree = screeW.mul(tailRock);
    const cRock = rockW.mul(afterGravel).mul(afterPond).mul(afterSnow);
    const cGravel = gravelW.mul(afterPond).mul(afterSnow);
    const cSilt = pondK.mul(afterSnow);
    const cSnow = snowW;

    // ---- argmax over the 8 contributions -----------------------------------
    const bestW = cSoil.toVar();
    const bestId = uint(SurfaceId.Soil).toVar();
    const consider = (w: NF, id: SurfaceId): void => {
      If(w.greaterThan(bestW), () => {
        bestW.assign(w);
        bestId.assign(uint(id));
      });
    };
    consider(cGrass, SurfaceId.Grass);
    consider(cForest, SurfaceId.Forest);
    consider(cScree, SurfaceId.Scree);
    consider(cRock, SurfaceId.Rock);
    consider(cGravel, SurfaceId.GravelRiver);
    consider(cSilt, SurfaceId.Mud); // exposed pond-silt bed reads as mud
    consider(cSnow, SurfaceId.Snow);

    // wetland margins: sedge flats are mud underfoot even where the splat
    // paints grass/forest colors (snow keeps priority — frozen bog is snow)
    If(
      biomeId
        .equal(int(Biome.Wetland))
        .and(moisture.greaterThan(CLASSIFY.MUD_MOISTURE))
        .and(slope.lessThan(CLASSIFY.MUD_MAX_SLOPE))
        .and(bestId.notEqual(uint(SurfaceId.Snow))),
      () => {
        bestId.assign(uint(SurfaceId.Mud));
      },
    );

    // ---- water overrides everything (same field the water renders from) ---
    const waterYv = bilerpFloatBuffer(opts.waterY, simRes, uvToGrid(uv, simRes));
    const depth = waterYv.sub(h);
    If(depth.greaterThan(CLASSIFY.WATER_MIN_DEPTH_M), () => {
      bestId.assign(uint(SurfaceId.WaterShallow));
      If(depth.greaterThan(CLASSIFY.FORD_MAX_DEPTH_M), () => {
        bestId.assign(uint(SurfaceId.WaterDeep));
      });
    });

    out.element(i).assign(bestId);
  })().compute(res * res);
  kernel.setName('surfaceClassify');
  await renderer.computeAsync(kernel);
  return out;
}
