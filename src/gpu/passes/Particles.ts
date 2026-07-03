/**
 * GPU particles (Phase 6) — snow at altitude, pollen motes in forest air,
 * drifting leaves under canopy. ≥100k budget (spec §2), wind-advected
 * (GPU-systems #12), zero CPU per-instance work.
 *
 * 131,072 particles live in a toroidal box around the camera (±36 m, ±24 m
 * vertical): a compute kernel integrates positions with the same global
 * wind/gust field the vegetation sways to, plus per-type behavior —
 * snow settles at ~0.9 m/s with cross-wind sway, pollen drifts nearly
 * buoyant on the gusts, leaves fall slowly while swirling. Particles
 * leaving the box (or dying) re-roll inside it; the TYPE re-rolls from the
 * environment at the new spot (snow over snowy biome, leaves under canopy,
 * pollen elsewhere), so populations follow the world without any CPU work.
 *
 * Rendered as one instanced draw of camera-facing quads (Standard material
 * — lit, receives CSM/cloud shade, §9 bans MeshBasic); soft radial alpha,
 * leaves spin in the quad plane and tint autumn-brown.
 */

import { DoubleSide, InstancedMesh, PlaneGeometry, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { IrradianceNode, MeshStandardNodeMaterial } from 'three/webgpu';
import type { ComputeNode, Renderer, StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  clamp,
  float,
  fract,
  instanceIndex,
  instancedArray,
  mix,
  positionLocal,
  positionWorld,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { hash13 } from '../noise/NoiseTSL';
import type { NF, NV2, NV3, NV4 } from '../TSLTypes';
import type { Heightfield } from '../../world/Heightfield';
import { WORLD_SIZE } from '../../world/WorldConst';
import { canopyAt } from './Scatter';
import type { ProbeGI } from './ProbeGI';
import { gustAt, windContext, windU } from '../../render/Wind';
import { weatherU } from '../../sky/Weather';

export const PARTICLE_COUNT = 131072;
const BOX_R = 36; // m, horizontal half-extent around the camera
const BOX_H = 24; // m, vertical half-extent

const T_POLLEN = 0;
const T_SNOW = 1;
const T_LEAF = 2;
// M1.6 rain: streak drops that convert into short ground-splash rings
const T_RAIN = 3;
const T_SPLASH = 4;

export class Particles {
  readonly mesh: InstancedMesh;
  private readonly stepK: ComputeNode;
  private readonly uCam = uniform(new Vector3());
  private readonly uCamRight = uniform(new Vector3(1, 0, 0));
  private readonly uCamUp = uniform(new Vector3(0, 1, 0));
  private readonly uDt = uniform(0.016);

  constructor(hf: Heightfield, canopyTex: StorageTexture | null, gi: ProbeGI | null = null) {
    // (x, y, z, type) — type carries through until the particle re-rolls
    const pos = instancedArray(PARTICLE_COUNT, 'vec4');
    // (phase, size01, age, ttl)
    const misc = instancedArray(PARTICLE_COUNT, 'vec4');

    const biomeTex = hf.biomeTex;
    if (!biomeTex) throw new Error('particles need the biome texture');

    const rollType = (p: NV3, h: NF): NF => {
      const uvW = clamp(p.xz.div(WORLD_SIZE).add(0.5), 0, 1);
      const snow = (texture(biomeTex, uvW, 0) as unknown as NV4).y;
      const cov = canopyTex ? canopyAt(canopyTex, p.xz) : (float(0) as NF);
      const isSnow = snow.greaterThan(0.35);
      const leafRoll = h.lessThan(0.45).and(cov.greaterThan(0.3));
      const envType = isSnow.select(
        float(T_SNOW),
        leafRoll.select(float(T_LEAF), float(T_POLLEN)),
      );
      // M1.6: precipitation claims its share of the pool everywhere
      const rain = (weatherU.rainAmt as unknown as NF);
      const isRain = hash13(p.mul(3.17)).lessThan(rain).and(rain.greaterThan(0.02));
      return isRain.select(float(T_RAIN), envType);
    };

    this.stepK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(PARTICLE_COUNT), () => {
        Return();
      });
      const cam = vec3(this.uCam);
      const P = pos.element(i);
      const M = misc.element(i);
      const p = P.xyz.toVar();
      const ty = P.w.toVar();
      const age = M.z.add(this.uDt as unknown as NF).toVar();

      // --- wind + per-type kinematics -------------------------------------------
      const d = vec2(windU.dir as unknown as NV2);
      const gust = windContext() ? gustAt(p.xz) : (float(0.5) as NF);
      const strength = (windU.strength as unknown as NF).mul(gust.mul(1.3).add(0.35));
      const phase = M.x.mul(6.2832);
      const swirlA = time.mul(M.x.mul(1.4).add(1.1)).add(phase);
      const isSnow = ty.greaterThan(T_SNOW - 0.5).and(ty.lessThan(T_SNOW + 0.5));
      const isLeaf = ty.greaterThan(T_LEAF - 0.5).and(ty.lessThan(T_LEAF + 0.5));
      const isRain = ty.greaterThan(T_RAIN - 0.5).and(ty.lessThan(T_RAIN + 0.5));
      const isSplash = ty.greaterThan(T_SPLASH - 0.5);
      // horizontal: shared wind + per-type swirl (rain barely swirls;
      // splash rings sit still on the ground)
      const windK = isLeaf.select(
        float(1.4),
        isSnow.select(float(1.1), isRain.select(float(0.95), float(0.8))),
      );
      const swirlR = isLeaf.select(
        float(0.8),
        isSnow.select(float(0.35), isRain.select(float(0.05), float(0.22))),
      );
      const still = isSplash.select(float(0), float(1));
      const vx = d.x
        .mul(strength)
        .mul(windK)
        .mul(2.2)
        .add(swirlA.cos().mul(swirlR))
        .mul(still);
      const vz = d.y
        .mul(strength)
        .mul(windK)
        .mul(2.2)
        .add(swirlA.sin().mul(swirlR))
        .mul(still);
      // vertical: snow settles, leaves flutter, pollen rides updrafts,
      // rain falls hard with a little per-drop spread
      const vy = isSnow
        .select(
          float(-0.9).add(swirlA.mul(1.7).sin().mul(0.18)),
          isLeaf.select(
            float(-0.55).add(swirlA.mul(2.3).sin().mul(0.3)),
            isRain.select(
              float(-8.2).add(M.x.sub(0.5).mul(1.6)),
              swirlA.mul(0.7).sin().mul(0.14).add(gust.sub(0.5).mul(0.25)),
            ),
          ),
        )
        .mul(still);
      p.addAssign(vec3(vx, vy, vz).mul(this.uDt as unknown as NF));

      // --- respawn: out of box / under ground / expired ----------------------------
      const ground = hf.sampleHeightNearest(p.xz);
      const hitGround = p.y.lessThan(ground.add(0.1));
      const out = p.x
        .sub(cam.x)
        .abs()
        .greaterThan(BOX_R)
        .or(p.z.sub(cam.z).abs().greaterThan(BOX_R))
        .or(p.y.sub(cam.y).abs().greaterThan(BOX_H))
        .or(hitGround)
        .or(age.greaterThan(M.w));
      // a raindrop reaching the ground becomes a short splash ring instead
      // of silently teleporting (Pillar A: rain must not read as streaks
      // only — the impact response sells it)
      const splashConvert = out.and(isRain).and(hitGround).and(age.greaterThan(0.05));
      If(splashConvert, () => {
        p.assign(vec3(p.x, ground.add(0.04), p.z));
        ty.assign(float(T_SPLASH));
        age.assign(0);
        misc.element(i).assign(
          vec4(M.x, hash13(p.mul(4.13)), 0, hash13(p.mul(5.71)).mul(0.14).add(0.16)),
        );
      }).Else(() => {
        If(out, () => {
          const r1 = hash13(vec3(float(i), time.mul(61.7), 3.1));
          const r2 = hash13(vec3(time.mul(47.3), float(i), 7.7));
          const r3 = hash13(vec3(float(i).mul(1.93), 11.3, time.mul(53.9)));
          const np = vec3(
            cam.x.add(r1.sub(0.5).mul(2 * BOX_R)),
            cam.y.add(r2.sub(0.5).mul(2 * BOX_H)),
            cam.z.add(r3.sub(0.5).mul(2 * BOX_R)),
          ).toVar();
          // never spawn under the terrain
          const g2 = hf.sampleHeightNearest(np.xz);
          np.y.assign(np.y.max(g2.add(0.6)));
          p.assign(np);
          // altitude band 0..1 of the box → type environment roll
          const hBand = np.y.sub(g2).div(60).clamp(0, 1);
          ty.assign(rollType(np, hash13(np.mul(0.71)).mul(0.4).add(hBand.mul(0.6))));
          age.assign(0);
          misc.element(i).assign(
            vec4(
              hash13(np.mul(1.37)),
              hash13(np.mul(2.11)),
              0,
              hash13(np.mul(3.71)).mul(14).add(8),
            ),
          );
        });
      });
      pos.element(i).assign(vec4(p, ty));
      misc.element(i).z.assign(age);
    })().compute(PARTICLE_COUNT);
    this.stepK.setName('particles');

    // ---------------- render: camera-facing lit quads -----------------------------
    const geo = new PlaneGeometry(1, 1);
    const mat = new MeshStandardNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = DoubleSide;
    mat.metalness = 0;
    mat.roughness = 0.9;

    const P = pos.element(instanceIndex) as unknown as NV4;
    const M = misc.element(instanceIndex) as unknown as NV4;
    const ty = P.w;
    const isSnowR = ty.greaterThan(T_SNOW - 0.5).and(ty.lessThan(T_SNOW + 0.5));
    const isLeafR = ty.greaterThan(T_LEAF - 0.5).and(ty.lessThan(T_LEAF + 0.5));
    const isRainR = ty.greaterThan(T_RAIN - 0.5).and(ty.lessThan(T_RAIN + 0.5));
    const isSplashR = ty.greaterThan(T_SPLASH - 0.5);
    const splashK = M.z.div(M.w.max(0.05)).clamp(0, 1); // splash life 0→1
    const sizeM = isLeafR.select(
      M.y.mul(0.05).add(0.045),
      isSnowR.select(
        M.y.mul(0.025).add(0.025),
        isSplashR.select(
          splashK.mul(0.055).add(0.022),
          M.y.mul(0.007).add(0.006),
        ),
      ),
    );
    // leaves spin in the billboard plane; snow/pollen stay axis-stable
    const spin = time
      .mul(isLeafR.select(M.x.mul(2.5).add(1.5), float(0)))
      .add(M.x.mul(6.2832));
    const ca = spin.cos();
    const sa = spin.sin();
    const lx = positionLocal.x.mul(ca).sub(positionLocal.y.mul(sa)).mul(sizeM);
    const ly = positionLocal.x.mul(sa).add(positionLocal.y.mul(ca)).mul(sizeM);
    const right = vec3(this.uCamRight);
    const up = vec3(this.uCamUp);
    const billboardPos = P.xyz.add(right.mul(lx)).add(up.mul(ly));
    // rain renders as a velocity-aligned streak: thin across, long along
    // the (wind-tilted) fall direction — reads as motion at any framerate
    const dR = vec2(windU.dir as unknown as NV2);
    const streakDir = vec3(
      dR.x.mul((windU.strength as unknown as NF).mul(2.0)),
      float(-8.2),
      dR.y.mul((windU.strength as unknown as NF).mul(2.0)),
    ).normalize();
    const rainPos = P.xyz
      .add(right.mul(positionLocal.x.mul(0.009)))
      .add(streakDir.mul(positionLocal.y.mul(0.36)));
    mat.positionNode = isRainR.select(rainPos, billboardPos);

    // fade-in after respawn, fade-out near end of life
    const lifeK = smoothstep(0, 0.6, M.z).mul(smoothstep(0, 1.5, M.w.sub(M.z)));
    const r2c = uv().sub(0.5).length().mul(2);
    const soft = smoothstep(1, isLeafR.select(float(0.75), float(0.25)), r2c);
    // streak alpha: soft across the width, feathered ends along the length
    const streakSoft = smoothstep(1, 0.1, uv().x.sub(0.5).abs().mul(2))
      .mul(smoothstep(0, 0.2, uv().y))
      .mul(smoothstep(1, 0.8, uv().y));
    // splash alpha: expanding ring that thins as it dies
    const ringSoft = smoothstep(0.3, 0.55, r2c)
      .mul(smoothstep(1, 0.72, r2c))
      .mul(splashK.oneMinus());
    const aK = isLeafR.select(
      float(1),
      isSnowR.select(
        float(0.95),
        isRainR.select(float(0.42), isSplashR.select(float(0.28), float(0.5))),
      ),
    );
    const softSel = isRainR.select(
      streakSoft,
      isSplashR.select(ringSoft, soft),
    );
    // splash lifeK: no slow fade-in — it must pop on impact
    const lifeSel = isSplashR.select(float(1), isRainR.select(smoothstep(0, 0.15, M.z), lifeK));
    // a streak grazing the lens stretches into a screen-wide white line —
    // fade rain within arm's reach (world-space camera distance)
    const camDist = positionWorld.sub(vec3(this.uCam)).length();
    const nearFade = isRainR.select(smoothstep(0.6, 2.2, camDist), float(1));
    mat.opacityNode = softSel.mul(lifeSel).mul(aK).mul(nearFade);

    const leafTint = mix(
      vec3(0.28, 0.16, 0.05),
      vec3(0.45, 0.3, 0.08),
      fract(M.x.mul(7.31)),
    );
    mat.colorNode = isLeafR.select(
      leafTint,
      isSnowR.select(
        vec3(0.85, 0.87, 0.92),
        isRainR.select(
          vec3(0.6, 0.65, 0.73),
          isSplashR.select(vec3(0.72, 0.76, 0.84), vec3(0.7, 0.66, 0.5)),
        ),
      ),
    );
    // ?partdbg=1 — oversized red emissive quads (pipeline-vs-tuning bisect);
    // ?partdbg=2 — analytic camera ring, sim buffers bypassed (data-vs-draw)
    const pdbg = new URLSearchParams(window.location.search).get('partdbg');
    if (pdbg === '1' || pdbg === '2') {
      const center =
        pdbg === '2'
          ? vec3(this.uCam).add(
              vec3(
                float(instanceIndex.mod(1024)).mul(0.00614).sin().mul(12),
                float(instanceIndex.div(1024)).mul(0.05).sub(3),
                float(instanceIndex.mod(1024)).mul(0.00614).cos().mul(12),
              ),
            )
          : P.xyz;
      mat.positionNode = center
        .add(right.mul(positionLocal.x.mul(0.25)))
        .add(up.mul(positionLocal.y.mul(0.25)));
      mat.colorNode = vec3(0, 0, 0);
      mat.emissiveNode = vec3(0, 40, 0);
      mat.opacityNode = float(1);
      mat.transparent = false;
      mat.depthWrite = true;
    }

    // probe-GI ambient: a flake in cliff shade must read pale blue-gray,
    // not black (no-black-shadows law applies to particles too)
    if (gi) {
      const irr = gi.irradiance(
        positionWorld as unknown as NV3,
        vec3(0, 1, 0) as unknown as NV3,
      );
      (mat as unknown as { setupLightMap: () => unknown }).setupLightMap = () =>
        new IrradianceNode(irr as unknown as ConstructorParameters<typeof IrradianceNode>[0]);
    }

    const mesh = new InstancedMesh(geo, mat, PARTICLE_COUNT);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 5; // after opaques, with the transparent water
    this.mesh = mesh;
  }

  update(renderer: Renderer, camera: PerspectiveCamera, dt: number): void {
    this.uCam.value.copy(camera.position);
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    this.uCamRight.value.set(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0).normalize();
    this.uCamUp.value.set(e[4] ?? 0, e[5] ?? 1, e[6] ?? 0).normalize();
    this.uDt.value = Math.min(Math.max(dt, 0), 0.05);
    renderer.compute(this.stepK);
  }
}
