/**
 * ?scene=terrain — terrain inspection scene (also currently ?scene=world).
 * Real CDLOD tiles + far shell + PBR terrain material, temporary sun/sky
 * lighting (replaced by the Phase-2 atmosphere stack).
 *
 * Views: ?view=hydro paints hydrology diagnostics on a preview grid.
 * ?alt=N puts the camera N meters above ground (ground-clamped spawn).
 */

import { DirectionalLight, HemisphereLight } from 'three';
import { mix, positionWorldDirection, smoothstep, vec3 } from 'three/tsl';
import { Heightfield } from '../world/Heightfield';
import { TerrainTiles } from '../world/TerrainTiles';
import type { WorldContext } from './Scenes';

export async function buildTerrainScene(ctx: WorldContext): Promise<void> {
  const { engine, params, seed } = ctx;

  const hf = await Heightfield.generate(
    engine.renderer,
    params,
    seed,
    (p, m) => ctx.progress(p * 0.92, m),
  );
  (engine as unknown as { heightfield?: Heightfield }).heightfield = hf;

  if (hf.cpuHeights) {
    let maxH = -Infinity;
    for (let i = 0; i < hf.cpuHeights.length; i += 7) {
      const v = hf.cpuHeights[i] as number;
      if (v > maxH) maxH = v;
    }
    engine.stats.counters['terrain.maxH'] = Math.round(maxH);
  }

  ctx.progress(0.94, 'terrain: building tiles');
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'split' && hf.preErosion) {
    // erosion before/after: pre-erosion clay on the left, eroded on the right
    const pre = new TerrainTiles(hf, null, {
      heightBuf: hf.preErosion,
      neutral: true,
      screenHalf: 'left',
    });
    const post = new TerrainTiles(hf, null, { neutral: true, screenHalf: 'right' });
    engine.scene.add(pre.mesh, post.mesh);
    engine.onUpdate(() => {
      pre.update(engine.camera);
      post.update(engine.camera);
    });
  } else {
    const tiles = new TerrainTiles(hf, view);
    engine.scene.add(tiles.mesh);
    engine.scene.add(tiles.farShell);
    engine.onUpdate(() => {
      tiles.update(engine.camera);
      engine.stats.counters['terrain.tiles'] = tiles.activeTiles;
    });
  }

  // temporary Phase-1 lighting: warm sun + cool sky hemisphere + gradient sky
  // (the real Hillaire atmosphere replaces all of this in Phase 2)
  const sun = new DirectionalLight(0xfff1de, 3.4);
  sun.position.set(-2600, 3400, 1400);
  engine.scene.add(sun);
  engine.scene.add(new HemisphereLight(0xbcd3ee, 0x474336, 0.85));
  const horizon = vec3(0.74, 0.82, 0.92);
  const zenith = vec3(0.22, 0.42, 0.75);
  engine.scene.backgroundNode = mix(
    horizon,
    zenith,
    smoothstep(-0.02, 0.5, positionWorldDirection.y),
  );

  // camera: ground-clamped spawn (?alt=) or a default SE vista
  const q = new URLSearchParams(window.location.search);
  const alt = Number(q.get('alt') ?? NaN);
  if (params.cam === null) {
    if (Number.isFinite(alt)) {
      const x = Number(q.get('x') ?? 600);
      const z = Number(q.get('z') ?? 900);
      const yaw = Number(q.get('yaw') ?? 2.4); // rad; 0 = looking −z (north)
      const y = hf.heightAtCpu(x, z) + alt;
      engine.camera.position.set(x, y, z);
      engine.camera.lookAt(x - Math.sin(yaw) * 100, y - 4, z - Math.cos(yaw) * 100);
    } else {
      engine.camera.position.set(1500, 1000, 1900);
      engine.camera.lookAt(0, 350, -300);
    }
  }
  // soft ground collision for fly camera
  engine.onUpdate(() => {
    const c = engine.camera.position;
    const ground = hf.heightAtCpu(c.x, c.z) + 1.4;
    if (c.y < ground) c.y = ground;
  });

  ctx.progress(1, 'terrain ready');
}
