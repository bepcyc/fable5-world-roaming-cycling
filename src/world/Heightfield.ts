/**
 * Heightfield — owner of all terrain GPU state. Orchestrates the generation
 * passes (synthesis → erosion → hydrology → classification) and exposes
 * buffers/textures + TSL sampling helpers to the rest of the engine.
 *
 * Layout: row-major res×res grids; texel (x,y) ↔ world
 * ((x+0.5)/res − 0.5)·WORLD_SIZE on both axes (x→world x, y→world z).
 */

import { FloatType, HalfFloatType, NearestFilter, RedFormat } from 'three';
import type { Renderer } from 'three/webgpu';
import { StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  clamp,
  float,
  floor,
  fract,
  instanceIndex,
  instancedArray,
  mix,
  texture,
  textureStore,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { LaasParams } from '../core/Params';
import type { WorldSeed } from '../core/Seed';
import { bilerpFloatBuffer, uvToGrid } from '../gpu/BufferSample';
import type { NF, NV2, NV3 } from '../gpu/TSLTypes';
import { runBiomeSnow } from '../gpu/passes/BiomeSnow';
import { runErosion } from '../gpu/passes/Erosion';
import { runFlowRivers, type FlowResult } from '../gpu/passes/FlowRivers';
import {
  runHeightSynthesis,
  type FloatBuffer,
  type SynthesisResult,
} from '../gpu/passes/HeightSynthesis';
import { makeMacroParams, type MacroParams } from './MacroMap';
import { WORLD_SIZE, qualityConfig, type QualityConfig } from './WorldConst';

export type ProgressFn = (p: number, msg: string) => void;

export class Heightfield {
  readonly cfg: QualityConfig;
  readonly mp: MacroParams;
  readonly res: number;

  /** final height (m), res×res storage buffer — single source of truth */
  readonly height: SynthesisResult['height'];
  readonly hardness: SynthesisResult['hardness'];
  /** pre-erosion copy kept for the ?scene=terrain split view */
  preErosion: FloatBuffer | null = null;
  /** erosion by-products at sim res (moisture/soil hints for later passes) */
  simWater: FloatBuffer | null = null;
  simSediment: FloatBuffer | null = null;
  simRes = 0;
  /** hydrology outputs at sim res */
  flow: FlowResult | null = null;
  /** rgba16f at sim res: moisture, flowStrength, riverDepth, waterSurface W */
  fieldsTex: StorageTexture | null = null;
  /** rgba8 at full res: biomeId/8, snow, vegDensity, rockExposure */
  biomeTex: StorageTexture | null = null;
  /** CPU height mirror for camera clamping / tools (filled by readback) */
  cpuHeights: Float32Array | null = null;

  /** r32float height texture (nearest-sample / textureLoad only) */
  readonly heightTex: StorageTexture;
  /** rgba16f: xyz = world-space normal, w = slope (rise/run) */
  readonly normalTex: StorageTexture;

  private constructor(
    cfg: QualityConfig,
    mp: MacroParams,
    synth: SynthesisResult,
    heightTex: StorageTexture,
    normalTex: StorageTexture,
  ) {
    this.cfg = cfg;
    this.mp = mp;
    this.res = synth.res;
    this.height = synth.height;
    this.hardness = synth.hardness;
    this.heightTex = heightTex;
    this.normalTex = normalTex;
  }

  static async generate(
    renderer: Renderer,
    params: LaasParams,
    seed: WorldSeed,
    progress: ProgressFn,
  ): Promise<Heightfield> {
    const cfg = qualityConfig(params.preset);
    const mp = makeMacroParams(seed);

    progress(0.04, `terrain: synthesizing ${cfg.heightRes}² heightfield`);
    const synth = await runHeightSynthesis(renderer, cfg.heightRes, mp);

    const heightTex = new StorageTexture(cfg.heightRes, cfg.heightRes);
    heightTex.type = FloatType;
    heightTex.format = RedFormat;
    heightTex.magFilter = NearestFilter;
    heightTex.minFilter = NearestFilter;
    heightTex.generateMipmaps = false;

    const normalTex = new StorageTexture(cfg.heightRes, cfg.heightRes);
    normalTex.type = HalfFloatType;
    normalTex.generateMipmaps = false;

    const hf = new Heightfield(cfg, mp, synth, heightTex, normalTex);

    // --- erosion at sim res, then detail-preserving compose back to full res --
    progress(0.08, `terrain: synthesizing ${cfg.simRes}² erosion grid`);
    const synthSim = await runHeightSynthesis(renderer, cfg.simRes, mp);

    progress(0.1, `terrain: eroding (${cfg.erosionIters} iterations)`);
    const erosion = await runErosion(renderer, synthSim.height, synthSim.hardness, {
      res: cfg.simRes,
      texel: WORLD_SIZE / cfg.simRes,
      iters: cfg.erosionIters,
      onProgress: (d, t) => progress(0.1 + 0.45 * (d / t), `terrain: eroding ${d}/${t}`),
    });
    hf.simWater = erosion.water;
    hf.simSediment = erosion.sediment;
    hf.simRes = cfg.simRes;

    // hydrology BEFORE compose: river carve must reach the full-res field
    hf.flow = await runFlowRivers(renderer, erosion.eroded, erosion.water, {
      res: cfg.simRes,
      texel: WORLD_SIZE / cfg.simRes,
      seed: seed.sub('hydrology'),
      mp,
      onProgress: (msg, frac) => progress(0.55 + frac * 0.12, msg),
    });

    progress(0.7, 'terrain: composing eroded field');
    await hf.composeEroded(renderer, synthSim.height, erosion.eroded);

    progress(0.82, 'terrain: deriving maps');
    await hf.rebuildDerivedMaps(renderer);
    await hf.buildFieldsTex(renderer);

    progress(0.88, 'terrain: biome + snow classification');
    if (!hf.fieldsTex) throw new Error('fieldsTex missing before biome pass');
    hf.biomeTex = await runBiomeSnow(renderer, hf.height, {
      res: hf.res,
      mp,
      normalTex: hf.normalTex,
      fieldsTex: hf.fieldsTex,
    });

    progress(0.93, 'terrain: height readback for camera');
    const ab = await renderer.getArrayBufferAsync(hf.height.value);
    hf.cpuHeights = new Float32Array(ab);
    return hf;
  }

  /** CPU height lookup (bilinear) — camera clamping, bookmarks, tools */
  heightAtCpu(x: number, z: number): number {
    const hts = this.cpuHeights;
    if (!hts) return 0;
    const res = this.res;
    const gx = Math.min(Math.max(((x / WORLD_SIZE) + 0.5) * res - 0.5, 0), res - 1.001);
    const gz = Math.min(Math.max(((z / WORLD_SIZE) + 0.5) * res - 0.5, 0), res - 1.001);
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    const i = (xx: number, zz: number): number => hts[Math.min(zz, res - 1) * res + Math.min(xx, res - 1)] ?? 0;
    const a = i(x0, z0) * (1 - fx) + i(x0 + 1, z0) * fx;
    const b = i(x0, z0 + 1) * (1 - fx) + i(x0 + 1, z0 + 1) * fx;
    return a * (1 - fz) + b * fz;
  }

  /** pack sim-res hydrology fields into a filterable rgba16f texture */
  private async buildFieldsTex(renderer: Renderer): Promise<void> {
    const flow = this.flow;
    if (!flow) return;
    const res = this.simRes;
    const tex = new StorageTexture(res, res);
    tex.type = HalfFloatType;
    tex.generateMipmaps = false;
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(res * res), () => {
        Return();
      });
      const x = i.mod(res);
      const y = i.div(res);
      textureStore(
        tex,
        uvec2(x.toUint(), y.toUint()),
        vec4(
          flow.moisture.element(i),
          flow.flowStrength.element(i),
          flow.riverDepth.element(i),
          flow.waterSurface.element(i),
        ),
      ).toWriteOnly();
    })().compute(res * res);
    kernel.setName('fieldsTexPack');
    await renderer.computeAsync(kernel);
    this.fieldsTex = tex;
  }

  /**
   * height ← upsample(eroded_sim) + (height_full − upsample(preSim)).
   * Keeps full-res synthesis micro-detail riding on the eroded macro field.
   * Also snapshots the pre-erosion full-res height for the split view.
   */
  private async composeEroded(
    renderer: Renderer,
    preSim: FloatBuffer,
    erodedSim: FloatBuffer,
  ): Promise<void> {
    const res = this.res;
    const simRes = this.simRes;
    const pre = instancedArray(res * res, 'float');
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(res * res), () => {
        Return();
      });
      const x = i.mod(res);
      const y = i.div(res);
      const h = this.height.element(i).toVar();
      pre.element(i).assign(h);
      const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(res);
      const g = uvToGrid(uv, simRes);
      const macroEroded = bilerpFloatBuffer(erodedSim, simRes, g);
      const macroPre = bilerpFloatBuffer(preSim, simRes, g);
      this.height.element(i).assign(macroEroded.add(h.sub(macroPre)));
    })().compute(res * res);
    kernel.setName('erosionCompose');
    await renderer.computeAsync(kernel);
    this.preErosion = pre;
  }

  /** height buffer → height texture + central-difference normals/slope */
  async rebuildDerivedMaps(renderer: Renderer): Promise<void> {
    const res = this.res;
    const height = this.height;
    const texel = WORLD_SIZE / res;
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(res * res), () => {
        Return();
      });
      const x = i.mod(res).toInt();
      const y = i.div(res).toInt();
      const xm = clamp(float(x).sub(1), 0, res - 1).toInt();
      const xp = clamp(float(x).add(1), 0, res - 1).toInt();
      const ym = clamp(float(y).sub(1), 0, res - 1).toInt();
      const yp = clamp(float(y).add(1), 0, res - 1).toInt();
      const h = height.element(i).toVar();
      const hl = height.element(y.mul(res).add(xm)).toVar();
      const hr = height.element(y.mul(res).add(xp)).toVar();
      const hd = height.element(ym.mul(res).add(x)).toVar();
      const hu = height.element(yp.mul(res).add(x)).toVar();
      const n = vec3(hl.sub(hr), float(texel * 2), hd.sub(hu)).normalize();
      const slope = vec2(hl.sub(hr), hd.sub(hu)).length().div(texel * 2);
      textureStore(this.heightTex, uvec2(x.toUint(), y.toUint()), vec4(h, 0, 0, 1)).toWriteOnly();
      textureStore(
        this.normalTex,
        uvec2(x.toUint(), y.toUint()),
        vec4(n, slope),
      ).toWriteOnly();
    })().compute(res * res);
    kernel.setName('terrainDerivedMaps');
    await renderer.computeAsync(kernel);
  }

  /** world xz (m) → uv in [0,1]² over the height grid */
  uvFromWorld(p: NV2): NV2 {
    return p.div(WORLD_SIZE).add(0.5);
  }

  /**
   * Manual-bilinear height sample from the storage buffer (vertex-stage safe;
   * r32float textures are not filterable).
   */
  sampleHeight(p: NV2): NF {
    return this.sampleHeightFrom(this.height, p);
  }

  /** same, from an arbitrary res×res float buffer (e.g. preErosion) */
  sampleHeightFrom(buf: FloatBuffer, p: NV2): NF {
    const res = this.res;
    const uv = this.uvFromWorld(p);
    const g = clamp(uv, 0, 1).mul(res).sub(0.5);
    const i0 = floor(g);
    const f = fract(g);
    const x0 = clamp(i0.x, 0, res - 1).toInt();
    const y0 = clamp(i0.y, 0, res - 1).toInt();
    const x1 = clamp(i0.x.add(1), 0, res - 1).toInt();
    const y1 = clamp(i0.y.add(1), 0, res - 1).toInt();
    const h00 = buf.element(y0.mul(res).add(x0));
    const h10 = buf.element(y0.mul(res).add(x1));
    const h01 = buf.element(y1.mul(res).add(x0));
    const h11 = buf.element(y1.mul(res).add(x1));
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }

  /** filtered normal+slope sample (fragment stage) */
  sampleNormalSlope(p: NV2): { normal: NV3; slope: NF } {
    const t = texture(this.normalTex, this.uvFromWorld(p));
    return { normal: t.xyz.normalize(), slope: t.w };
  }
}
