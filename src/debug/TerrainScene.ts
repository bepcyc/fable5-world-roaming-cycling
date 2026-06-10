/**
 * ?scene=terrain — terrain inspection scene.
 * Phase-1 preview version: a single dense displaced grid over the whole world
 * with a hillshade debug material (palette by altitude/slope + macro masks).
 * Will grow: erosion split view, biome/moisture/flow view modes, real tiles.
 */

import { Mesh, PlaneGeometry } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { clamp, dot, mix, normalize, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { Heightfield } from '../world/Heightfield';
import { LAKE_LEVEL, SNOWLINE_BASE, WORLD_SIZE } from '../world/WorldConst';
import type { WorldContext } from './Scenes';

export async function buildTerrainScene(ctx: WorldContext): Promise<void> {
  const { engine, params, seed } = ctx;

  const hf = await Heightfield.generate(
    engine.renderer,
    params,
    seed,
    (p, m) => ctx.progress(p * 0.9, m),
  );
  // stash for other systems / console poking
  (engine as unknown as { heightfield?: Heightfield }).heightfield = hf;

  const SEGS = 1024;
  const geo = new PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);

  const mat = new MeshStandardNodeMaterial();
  const wxz = positionLocal.xz;
  mat.positionNode = positionLocal.add(vec3(0, hf.sampleHeight(wxz), 0));

  // hillshade debug shading via emissive (real PBR terrain material comes next)
  const ns = hf.sampleNormalSlope(wxz);
  const h = hf.sampleHeight(wxz);
  const sun = normalize(vec3(0.55, 0.65, 0.32));
  const light = clamp(dot(ns.normal, sun), 0, 1).mul(0.75).add(0.25);

  const grass = vec3(0.3, 0.42, 0.18);
  const forest = vec3(0.16, 0.3, 0.14);
  const rock = vec3(0.45, 0.41, 0.38);
  const snow = vec3(0.92, 0.94, 0.98);
  const water = vec3(0.1, 0.22, 0.32);

  const slopeT = smoothstep(0.55, 1.1, ns.slope);
  let col = mix(mix(grass, forest, smoothstep(220, 420, h)), rock, slopeT);
  const snowT = smoothstep(SNOWLINE_BASE, SNOWLINE_BASE + 140, h).mul(
    smoothstep(1.35, 0.7, ns.slope),
  );
  col = mix(col, snow, snowT);
  col = mix(col, water, smoothstep(LAKE_LEVEL + 1.5, LAKE_LEVEL - 1.5, h));

  mat.colorNode = vec3(0, 0, 0);
  mat.emissiveNode = col.mul(light);

  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  engine.scene.add(mesh);

  engine.stats.counters['terrain.previewVerts'] = (SEGS + 1) * (SEGS + 1);

  // default camera: high SE vantage looking NW across valley toward the massif
  if (params.cam === null) {
    engine.camera.position.set(1500, 950, 1750);
    engine.camera.lookAt(0, 350, 0);
  }
  ctx.progress(1, 'terrain preview ready');
}
