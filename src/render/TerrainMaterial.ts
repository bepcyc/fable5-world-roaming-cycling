/**
 * Terrain shading — shared by near tiles and the far vista shell.
 *
 * Splat classes are derived from CONTINUOUS fields (slope, snow, moisture,
 * rock exposure, zone masks) so everything filters cleanly; the quantized
 * biome id channel is only for scatter passes (read with textureLoad there).
 *
 * Macro–meso–micro law: every class gets a 2–50 m macro variation layer, a
 * ~1.5 m meso albedo/normal band, and a ~0.2 m micro normal band (near only).
 * Snow edges are hash-dithered. Wet margins darken. Far mode swaps the micro
 * bands for far-detail synthesis: ridged noise re-amplified in the normal
 * domain so distant mountains stay serrated (Pillar D).
 */

import type { StorageTexture } from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';
import type { NF, NV2, NV3, NV4 } from '../gpu/TSLTypes';
import { hash12 } from '../gpu/noise/NoiseTSL';
import { zoneMasks, type MacroParams } from '../world/MacroMap';
import { LAKE_LEVEL, WORLD_SIZE } from '../world/WorldConst';

export interface TerrainShadingInputs {
  /** rgba16f: xyz world normal, w slope */
  normalTex: StorageTexture;
  /** rgba8: biomeId/8, snow, vegDensity, rockExposure (LINEAR-filtered) */
  biomeTex: StorageTexture;
  /** rgba16f at sim res: moisture, flowStrength, riverDepth, W */
  fieldsTex: StorageTexture;
  mp: MacroParams;
  /** far shell: cheaper bands + far-detail synthesis */
  far: boolean;
  /**
   * world-space normal override (xyz) + slope (w). The far shell passes its
   * analytic per-vertex normal here — the baked normal texture does not exist
   * beyond the world edge.
   */
  baseNormalSlope?: NV4;
}

export interface TerrainShading {
  colorNode: NV3;
  normalNode: NV3;
  roughnessNode: NF;
}

const uvFromWorld = (p: NV2): NV2 => p.div(WORLD_SIZE).add(0.5);

export function buildTerrainShading(inp: TerrainShadingInputs): TerrainShading {
  const wp = positionWorld;
  const wxz = wp.xz;
  const uv = uvFromWorld(wxz);
  const h = wp.y;

  const ns = inp.baseNormalSlope ?? texture(inp.normalTex, uv);
  const baseNormal = ns.xyz.normalize().toVar();
  const slope = ns.w.toVar();
  const bio = texture(inp.biomeTex, uv);
  const snowField = bio.g;
  const vegDensity = bio.b;
  const rockExposure = bio.a;
  const fields = texture(inp.fieldsTex, uv);
  const moisture = fields.x;
  const flowStrength = fields.y;
  const riverDepth = fields.z;
  const zm = zoneMasks(wxz, inp.mp);

  // ---------- macro variation (2–50 m breakup — tiling killer) ----------------
  const macroA = mx_noise_float(wxz.div(43.7)).mul(0.5).add(0.5);
  const macroB = mx_noise_float(wxz.div(11.3).add(57.1)).mul(0.5).add(0.5);
  const macroMix = macroA.mul(0.65).add(macroB.mul(0.35));
  const macroTint = macroMix.sub(0.5).mul(0.16); // ±8% value shift

  // ---------- meso/micro detail noise ------------------------------------------
  const meso = inp.far
    ? float(0.5)
    : mx_fractal_noise_float(wxz.div(1.45), 3, 2.1, 0.55, 1).mul(0.5).add(0.5);
  const micro = inp.far ? float(0.5) : mx_noise_float(wxz.div(0.19)).mul(0.5).add(0.5);

  // ---------- class palettes ----------------------------------------------------
  // rock: subtle strata banding; warm rust in the alpine zone, pale gray in
  // karst. Low contrast + heavy phase warp so it reads as geology, not zebra.
  const strataPhase = h
    .mul(0.028)
    .add(mx_noise_float(wxz.div(74)).mul(3.6))
    .add(mx_noise_float(wxz.div(540)).mul(2.4));
  const strata = mx_noise_float(vec2(strataPhase, mx_noise_float(wxz.div(610)).mul(1.7)))
    .mul(0.5)
    .add(0.5)
    .mul(0.55)
    .add(0.22); // compress contrast
  const alpRock = mix(vec3(0.35, 0.26, 0.2), vec3(0.5, 0.41, 0.34), strata);
  const karstRock = mix(vec3(0.44, 0.44, 0.42), vec3(0.58, 0.56, 0.52), strata);
  const genericRock = mix(vec3(0.4, 0.38, 0.35), vec3(0.49, 0.47, 0.43), strata);
  let rockCol = mix(genericRock, karstRock, zm.tKarst);
  rockCol = mix(rockCol, alpRock, zm.tAlp.mul(0.85));
  // iron-oxide bands: dark rust layers at noise-chosen elevations (refs show
  // strong hue layering on alpine faces)
  const ironPhase = mx_noise_float(vec2(h.mul(0.011), mx_noise_float(wxz.div(800)).mul(1.3)));
  const ironBand = smoothstep(0.32, 0.58, ironPhase).mul(smoothstep(0.85, 0.55, ironPhase));
  rockCol = mix(rockCol, vec3(0.3, 0.18, 0.12), ironBand.mul(zm.tAlp.mul(0.6).add(0.12)));
  // lichen/weathering: dark macro splotches on long-exposed faces
  const lichen = smoothstep(0.6, 0.85, mx_noise_float(wxz.div(23.7)).mul(0.5).add(0.5));
  rockCol = mix(rockCol, rockCol.mul(0.62), lichen.mul(0.5));
  // cavity dirt: concave-ish micro band darkening
  rockCol = rockCol.mul(meso.mul(0.22).add(0.89)).mul(micro.mul(0.1).add(0.95));

  const scree = vec3(0.45, 0.43, 0.4).mul(meso.mul(0.35).add(0.78));
  const soil = mix(vec3(0.2, 0.15, 0.1), vec3(0.32, 0.25, 0.16), meso).mul(
    micro.mul(0.2).add(0.9),
  );
  // grass field color: green with dry yellowish macro patches
  const grassG = mix(vec3(0.19, 0.28, 0.1), vec3(0.3, 0.36, 0.13), macroA);
  const grassDry = vec3(0.42, 0.4, 0.2);
  const grassCol = mix(grassG, grassDry, smoothstep(0.62, 0.85, macroB)).mul(
    meso.mul(0.25).add(0.85),
  );
  // forest floor: litter brown blended w/ moss by moisture
  const litter = mix(soil, vec3(0.23, 0.2, 0.12), meso);
  const mossy = vec3(0.13, 0.2, 0.08);
  const forestFloor = mix(litter, mossy, smoothstep(0.45, 0.8, moisture).mul(0.7));
  // gravel/cobble tint in stream channels
  const gravel = mix(vec3(0.4, 0.39, 0.37), vec3(0.55, 0.53, 0.5), micro);
  const snowCol = mix(vec3(0.86, 0.88, 0.94), vec3(0.93, 0.95, 0.99), macroA).mul(
    meso.mul(0.08).add(0.95),
  );

  // ---------- class weights ------------------------------------------------------
  const rockW = smoothstep(0.62, 1.15, slope).max(rockExposure.mul(0.85)).toVar();
  const screeW = smoothstep(0.42, 0.62, slope)
    .mul(smoothstep(1.15, 0.7, slope))
    .mul(smoothstep(380, 700, h))
    .mul(rockW.oneMinus());
  const grassW = smoothstep(0.5, 0.22, slope)
    .mul(vegDensity)
    .mul(zm.tKarst.mul(0.5).oneMinus())
    .mul(rockW.oneMinus());
  const forestW = vegDensity
    .mul(smoothstep(0.9, 0.45, slope))
    .mul(smoothstep(0.25, 0.6, moisture.add(zm.tKarst.mul(0.3))))
    .mul(rockW.oneMinus());
  const riverW = smoothstep(0.12, 0.5, flowStrength).mul(smoothstep(0.45, 0.2, slope));

  // snow with hash-dithered edge (reads as crisp organic boundary, not gradient)
  const dither = hash12(wxz.mul(7.31)).sub(0.5).mul(0.34);
  const snowW = smoothstep(0.2, 0.58, snowField.add(dither)).toVar();

  // ---------- composite -----------------------------------------------------------
  let col: NV3 = soil;
  col = mix(col, grassCol, grassW);
  col = mix(col, forestFloor, forestW);
  col = mix(col, scree, screeW);
  col = mix(col, rockCol, rockW);
  col = mix(col, gravel, riverW.mul(0.85));
  col = mix(col, snowCol, snowW);
  col = col.mul(macroTint.add(1));

  // wet darkening: river margins, lake shores, marshes
  const shoreWet = smoothstep(LAKE_LEVEL + 2.5, LAKE_LEVEL + 0.3, h);
  const wet = clamp(
    smoothstep(0.55, 0.95, moisture).mul(0.5).add(riverDepth.mul(2)).add(shoreWet.mul(0.6)),
    0,
    0.75,
  ).mul(snowW.oneMinus());
  col = col.mul(wet.mul(0.55).oneMinus());

  // ---------- normal perturbation ---------------------------------------------------
  // far-detail synthesis (Pillar D): serrated normal-domain detail keeps
  // mid/far ridges craggy where geometric density has LOD'd out. Applied by
  // DISTANCE on both near tiles and the far shell.
  const camDist = wp.sub(cameraPosition).length();
  const farK = inp.far ? float(1) : smoothstep(900, 2600, camDist);
  const e = 22;
  const ridgeAt = (q: NV2): NF =>
    mx_fractal_noise_float(q.div(310), 3, 2.2, 0.55, 1).abs().oneMinus();
  const rdx = ridgeAt(wxz.add(vec2(e, 0))).sub(ridgeAt(wxz.sub(vec2(e, 0))));
  const rdz = ridgeAt(wxz.add(vec2(0, e))).sub(ridgeAt(wxz.sub(vec2(0, e))));
  const farAmp = smoothstep(0.5, 1.1, slope).mul(0.4).add(0.08).mul(farK);
  // never let detail flip the surface away from the sky
  const perturbed = baseNormal.add(vec3(rdx, 0, rdz).mul(farAmp));
  let nrm: NV3 = vec3(perturbed.x, perturbed.y.max(0.1), perturbed.z).normalize();

  if (!inp.far) {
    // meso + micro analytic bumps near camera, stronger on rock
    const e1 = 0.9;
    const b1x = mx_noise_float(wxz.add(vec2(e1, 0)).div(1.45)).sub(
      mx_noise_float(wxz.sub(vec2(e1, 0)).div(1.45)),
    );
    const b1z = mx_noise_float(wxz.add(vec2(0, e1)).div(1.45)).sub(
      mx_noise_float(wxz.sub(vec2(0, e1)).div(1.45)),
    );
    const e2 = 0.12;
    const b2x = mx_noise_float(wxz.add(vec2(e2, 0)).div(0.19)).sub(
      mx_noise_float(wxz.sub(vec2(e2, 0)).div(0.19)),
    );
    const b2z = mx_noise_float(wxz.add(vec2(0, e2)).div(0.19)).sub(
      mx_noise_float(wxz.sub(vec2(0, e2)).div(0.19)),
    );
    const bumpAmp = mix(float(0.25), float(0.85), rockW)
      .mul(snowW.mul(0.7).oneMinus())
      .mul(farK.oneMinus());
    nrm = nrm
      .add(vec3(b1x.mul(0.7).add(b2x.mul(0.45)), 0, b1z.mul(0.7).add(b2z.mul(0.45))).mul(bumpAmp))
      .normalize();
  }

  // ---------- roughness ---------------------------------------------------------------
  const rough = mix(float(0.94), float(0.8), rockW)
    .sub(snowW.mul(0.32))
    .sub(wet.mul(0.45))
    .clamp(0.25, 1);

  return {
    colorNode: col,
    normalNode: transformNormalToView(nrm),
    roughnessNode: rough,
  };
}
