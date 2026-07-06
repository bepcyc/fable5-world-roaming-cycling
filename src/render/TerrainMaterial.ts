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
 *
 * PERF: all repeated noise comes from the baked NoiseBake textures (was ~35
 * live noise evaluations per pixel ≈ 52 ms/frame; now ~14 filtered fetches).
 * Gradient channels are pre-derived, so bump/ridge detail is one fetch
 * instead of four finite-difference evaluations.
 */

import type { StorageTexture } from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  float,
  mix,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  vec2,
  vec3,
} from 'three/tsl';
import type { NF, NV2, NV3, NV4 } from '../gpu/TSLTypes';
import { hash12 } from '../gpu/noise/NoiseTSL';
import type { RoadSampleBaked } from '../gpu/passes/RoadField';
import { SurfaceId } from '../ride/SurfaceMatrix';
import {
  PERIOD_FBM,
  PERIOD_RID,
  PERIOD_VAL,
} from '../gpu/passes/NoiseBake';
import { sunU } from './VegMaterials';
import { SURF_COL, palette } from './DebugSurface';
import { weatherU } from '../sky/Weather';
import { zoneMasks, type MacroParams } from '../world/MacroMap';
import { LAKE_LEVEL, WORLD_HALF, WORLD_SIZE } from '../world/WorldConst';

export interface TerrainShadingInputs {
  /** rgba16f: xyz world normal, w slope */
  normalTex: StorageTexture;
  /** rgba8: biomeId/8, snow, vegDensity, rockExposure (LINEAR-filtered) */
  biomeTex: StorageTexture;
  /** rgba16f at sim res: moisture, flowStrength, riverDepth, W */
  fieldsTex: StorageTexture;
  /** baked tileable noise (NoiseBake channel map) */
  noiseA: StorageTexture;
  noiseB: StorageTexture;
  mp: MacroParams;
  /** far shell: cheaper bands + far-detail synthesis */
  far: boolean;
  /**
   * world-space normal override (xyz) + slope (w). The far shell passes its
   * analytic per-vertex normal here — the baked normal texture does not exist
   * beyond the world edge.
   */
  baseNormalSlope?: NV4;
  /**
   * M1.2 road field sampler (RoadField.sampleBaked) — near tiles only; the
   * far shell lives beyond the world edge where no roads exist. LOCKSTEP:
   * the same sampler drives carve/stamp/veg exclusion (RoadField.ts header).
   */
  road?: { sampleBaked(p: NV2): RoadSampleBaked } | null;
}

export interface TerrainShading {
  colorNode: NV3;
  normalNode: NV3;
  roughnessNode: NF;
  /** final shading normal in WORLD space (for probe irradiance) */
  worldNormalNode: NV3;
  /** Shift+C surface-debug color: flat per-class palette + world grid, painted
   *  from the same class weights as colorNode. Applied by the caller as an
   *  UNLIT emissive when surfaceDbgU is on. */
  surfaceDebugNode: NV3;
}

const uvFromWorld = (p: NV2): NV2 => p.div(WORLD_SIZE).add(0.5);

/**
 * Micro-displacement constants — SHARED by the TerrainTiles vertex stage
 * (geometry) and the fragment normal counterpart below. fbm(2.6 m) rolls +
 * val(0.9 m) breakup + ridged(1.15 m) creases (rock-weighted); amplitude
 * fades out 45→85 m and is gated by slope/rockExposure so grass meadows
 * stay smooth under their blade carpet (veg sits on the undisplaced field).
 */
export const DISP = {
  base: 0.15,
  rock: 0.55,
  gravel: 0.3,
  fade0: 45,
  fade1: 85,
  sF1: 2.6,
  sF2: 0.9,
  sRid: 1.15,
  wF1: 0.55,
  wF2: 0.33,
  wRid: 0.62,
  ridBase: 0.25,
  slopeKnee0: 0.45,
  slopeKnee1: 0.95,
} as const;

export function buildTerrainShading(inp: TerrainShadingInputs): TerrainShading {
  const wp = positionWorld;
  const wxz = wp.xz;
  const uv = uvFromWorld(wxz);
  const h = wp.y;

  // --- baked-noise helpers (uv = world / (scale · channel period)) -----------
  /** value noise [0,1] at world feature scale `s` m */
  const val = (s: number, ox = 0, oz = 0): NF =>
    texture(inp.noiseA, wxz.div(s * PERIOD_VAL).add(vec2(ox, oz))).x;
  /** signed value noise [-1,1] */
  const valS = (s: number, ox = 0, oz = 0): NF => val(s, ox, oz).mul(2).sub(1);
  /** fbm-3 [0,1] */
  const fbmV = (s: number, ox = 0, oz = 0): NF =>
    texture(inp.noiseA, wxz.div(s * PERIOD_FBM).add(vec2(ox, oz))).y;
  /** fbm-3 gradient (d/dx, d/dz in world units at feature scale s) */
  const fbmG = (s: number, ox = 0, oz = 0): NV2 =>
    texture(inp.noiseA, wxz.div(s * PERIOD_FBM).add(vec2(ox, oz))).zw.div(s);
  /** ridged-3 gradient (world units at feature scale s) */
  const ridG = (s: number): NV2 =>
    texture(inp.noiseB, wxz.div(s * PERIOD_RID)).xy.div(s);
  /** 1D band noise [0,1] along an arbitrary phase axis */
  const band = (phase: NF, lane: NF): NF =>
    texture(inp.noiseA, vec2(phase, lane).div(PERIOD_VAL)).x;

  const ns = inp.baseNormalSlope ?? texture(inp.normalTex, uv);
  const baseNormal = ns.xyz.normalize().toVar();
  const slope = ns.w.toVar();
  const bio = texture(inp.biomeTex, uv);
  const fields = texture(inp.fieldsTex, uv);
  // Beyond the world edge the baked maps clamp to their last texel row and
  // SMEAR it radially across the vista shell (pale streaks). Cross-fade to
  // procedural estimates outside the domain (far shell only).
  const outsideK = inp.far
    ? smoothstep(
        WORLD_HALF * 0.96,
        WORLD_HALF * 1.0,
        wxz.abs().x.max(wxz.abs().y),
      )
    : float(0);
  const snowProc = smoothstep(950, 1300, h.add(valS(620, 0.23, 0.57).mul(140)));
  const vegProc = smoothstep(0.55, 0.28, slope).mul(smoothstep(1350, 900, h));
  const rockProc = smoothstep(0.55, 0.95, slope);
  const snowField = mix(bio.g, snowProc, outsideK);
  const vegDensity = mix(bio.b, vegProc, outsideK);
  const rockExposure = mix(bio.a, rockProc, outsideK);
  const moisture = mix(fields.x, float(0.35), outsideK);
  const flowStrength = mix(fields.y, float(0), outsideK);
  const riverDepth = mix(fields.z, float(0), outsideK);
  const zm = zoneMasks(wxz, inp.mp);

  // ---------- macro variation (2–50 m breakup — tiling killer) ----------------
  const macroA = val(43.7);
  const macroB = val(11.3, 0.37, 0.61);
  const macroMix = macroA.mul(0.65).add(macroB.mul(0.35));
  const macroTint = macroMix.sub(0.5).mul(0.16); // ±8% value shift

  // ---------- meso/micro detail noise ------------------------------------------
  const meso = inp.far ? float(0.5) : fbmV(1.45);
  const micro = inp.far ? float(0.5) : val(0.19, 0.71, 0.13);

  // ---------- class palettes ----------------------------------------------------
  // rock: subtle strata banding; warm rust in the alpine zone, pale gray in
  // karst. Low contrast + heavy phase warp so it reads as geology, not zebra.
  const strataPhase = h
    .mul(0.028)
    .add(valS(74, 0.11, 0.83).mul(3.6))
    .add(valS(540, 0.43, 0.29).mul(2.4))
    .add(valS(27, 0.91, 0.07).mul(1.3)); // fine jitter fragments the bands
  const strata = band(strataPhase, valS(610, 0.67, 0.41).mul(1.7).add(31.7))
    .mul(0.36)
    .add(0.3); // compress contrast — long smooth walls turn 'layer cake' fast
  // reference peaks are DARK: gray-blue mass with rust faces catching light —
  // pale palettes washed the whole massif into cream at golden hour
  const alpRock = mix(vec3(0.16, 0.135, 0.125), vec3(0.38, 0.26, 0.18), strata);
  const karstRock = mix(vec3(0.3, 0.3, 0.29), vec3(0.5, 0.48, 0.44), strata);
  const genericRock = mix(vec3(0.26, 0.245, 0.225), vec3(0.42, 0.39, 0.35), strata);
  let rockCol = mix(genericRock, karstRock, zm.tKarst);
  rockCol = mix(rockCol, alpRock, zm.tAlp.mul(0.85));
  // iron-oxide bands: dark rust layers at noise-chosen elevations (refs show
  // strong hue layering on alpine faces)
  const ironPhase = band(h.mul(0.011), valS(800, 0.07, 0.93).mul(1.3).add(57.3));
  const ironBand = smoothstep(0.45, 0.62, ironPhase).mul(smoothstep(0.85, 0.62, ironPhase));
  rockCol = mix(rockCol, vec3(0.3, 0.18, 0.12), ironBand.mul(zm.tAlp.mul(0.6).add(0.12)));
  // lichen/weathering: dark macro splotches on long-exposed faces
  const lichen = smoothstep(0.6, 0.85, val(23.7, 0.53, 0.27));
  rockCol = mix(rockCol, rockCol.mul(0.62), lichen.mul(0.5));
  // cavity dirt: concave-ish micro band darkening
  rockCol = rockCol.mul(meso.mul(0.22).add(0.89)).mul(micro.mul(0.1).add(0.95));

  const scree = vec3(0.36, 0.345, 0.325).mul(meso.mul(0.35).add(0.78));
  const soil = mix(vec3(0.155, 0.12, 0.085), vec3(0.24, 0.195, 0.135), meso).mul(
    micro.mul(0.2).add(0.9),
  );
  // grass field color = the FINAL grass LOD: matched to the blade-ring
  // palette (screen-average of the blade ramps) with the SAME ~1.6 m patch
  // dryness, so the geometric grass dissolves into this instead of ending
  // at a visible ring edge ("empty terrain" feedback)
  const patchN = val(1.6, 0.23, 0.77);
  const grassG = mix(vec3(0.036, 0.094, 0.019), vec3(0.06, 0.13, 0.028), macroA);
  const grassDry = vec3(0.15, 0.122, 0.052);
  const grassCol = mix(
    grassG,
    grassDry,
    smoothstep(0.6, 0.92, patchN.mul(0.55).add(macroB.mul(0.45))),
  ).mul(meso.mul(0.25).add(0.85));
  // forest floor: litter brown blended w/ moss by moisture
  const litter = mix(soil, vec3(0.18, 0.15, 0.095), meso);
  const mossy = vec3(0.11, 0.185, 0.065);
  const forestFloor = mix(litter, mossy, smoothstep(0.45, 0.8, moisture).mul(0.7));
  // gravel/cobble tint in stream channels
  const gravel = mix(vec3(0.34, 0.33, 0.31), vec3(0.47, 0.45, 0.43), micro);
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
  // gravel only for REAL channels on open ground: weak-flow rills under
  // grass painted pale streaks down every meadow hillside — those should
  // darken via moisture instead
  const riverW = smoothstep(0.3, 0.68, flowStrength)
    .mul(smoothstep(0.45, 0.2, slope))
    .mul(grassW.mul(0.75).oneMinus());

  // snow with hash-dithered edge (reads as crisp organic boundary, not
  // gradient). Dither only near the boundary — ungated it sprinkled white
  // pixels over bare rock wherever snowField hovered above zero.
  const ditherGate = smoothstep(0.06, 0.22, snowField).mul(smoothstep(0.95, 0.6, snowField));
  const dither = hash12(wxz.mul(7.31)).sub(0.5).mul(0.34).mul(ditherGate);
  const snowW = smoothstep(0.16, 0.5, snowField.add(dither)).toVar();

  // ---------- composite -----------------------------------------------------------
  // standing-water beds (kettle ponds, lake): fine dark silt, not gravel —
  // the real Phase-6 water surface + Beer–Lambert absorption sit above this
  const pondK = smoothstep(1.1, 2.6, riverDepth).mul(smoothstep(0.3, 0.12, slope));
  let col: NV3 = soil;
  col = mix(col, grassCol, grassW);
  col = mix(col, forestFloor, forestW);
  col = mix(col, scree, screeW);
  col = mix(col, rockCol, rockW);
  col = mix(col, gravel, riverW.mul(0.85).mul(pondK.oneMinus()));
  col = mix(col, vec3(0.055, 0.052, 0.038), pondK);
  col = mix(col, snowCol, snowW);
  col = col.mul(macroTint.add(1));

  // ---------- Shift+C surface-debug palette (natural classes) --------------------
  // Same weights as the composite above, but flat separable colors. Road
  // classes override this inside the road block below; the grid + return
  // happen just before the shading result is assembled.
  let surfDbg: NV3 = palette(SURF_COL.soil);
  surfDbg = mix(surfDbg, palette(SURF_COL.grass), grassW);
  surfDbg = mix(surfDbg, palette(SURF_COL.forest), forestW);
  surfDbg = mix(surfDbg, palette(SURF_COL.scree), screeW);
  surfDbg = mix(surfDbg, palette(SURF_COL.rock), rockW);
  surfDbg = mix(surfDbg, palette(SURF_COL.gravelRiver), riverW.mul(0.85).mul(pondK.oneMinus()));
  surfDbg = mix(surfDbg, palette(SURF_COL.mud), pondK);
  surfDbg = mix(surfDbg, palette(SURF_COL.snow), snowW);

  // feedback 2.8 (splat half): a real grass field is DIRECTIONAL — forward
  // scatter through backlit blades brightens and warms it toward the sun at
  // grazing view angles. Distance-gated: near meadows have actual blades
  // (g0–g3); this gives the 200 m+ sward the same directional life so the
  // far layers dissolve into a live field, not flat paint.
  {
    const vDir = positionWorld.sub(cameraPosition).normalize();
    const sunD = vec3(sunU.dir as unknown as NV3).normalize();
    const toSun = vDir.dot(sunD).max(0);
    const grazing = float(1).sub(baseNormal.dot(vDir.negate()).abs()).pow2();
    const sheenK = grassW
      .mul(snowW.oneMinus())
      .mul(toSun.pow(3))
      .mul(grazing)
      .mul(smoothstep(0.05, 0.22, sunD.y))
      .mul(smoothstep(60, 220, positionWorld.sub(cameraPosition).length()))
      .mul(0.55);
    col = col.add(vec3(0.085, 0.1, 0.032).mul(sheenK)) as NV3;
  }

  // gorge/ravine wall vegetation (scene1: ravine walls are NOT bare — they
  // carry moss bands, hanging greens and ledge clumps). Steep faces in damp
  // valleys grow green in noise pockets: fbm bands read as hanging veg,
  // value-noise pockets as ledge clumps. Karst gorges get the most.
  const wallK = smoothstep(0.62, 1.0, slope)
    .mul(smoothstep(0.12, 0.42, moisture.add(riverDepth.mul(2))))
    .mul(smoothstep(1350, 700, h))
    .mul(snowW.oneMinus())
    .mul(zm.tKarst.mul(0.45).add(0.55));
  const wallBands = smoothstep(0.38, 0.72, fbmV(7.3, 0.13, 0.49));
  const ledgePock = smoothstep(0.45, 0.78, val(2.9, 0.61, 0.07));
  const wallVeg = wallK
    .mul(wallBands.mul(0.85).add(ledgePock.mul(0.6)))
    .clamp(0, 0.92);
  const wallGreen = mix(vec3(0.07, 0.115, 0.04), vec3(0.105, 0.165, 0.05), macroA);
  col = mix(col, wallGreen, wallVeg);

  // wet darkening: river margins, lake shores, marshes — plus the M1.6
  // global weather wetness (rain/after-rain) riding the same term, so the
  // albedo darken AND the roughness drop downstream react together
  const shoreWet = smoothstep(LAKE_LEVEL + 2.5, LAKE_LEVEL + 0.3, h);
  const wetLocal = clamp(
    smoothstep(0.55, 0.95, moisture).mul(0.5).add(riverDepth.mul(2)).add(shoreWet.mul(0.6)),
    0,
    0.75,
  );
  const wet = wetLocal.max((weatherU.wetness as unknown as NF).mul(0.72)).mul(snowW.oneMinus());
  col = col.mul(wet.mul(0.55).oneMinus());

  // ---------- M1.2 road surfaces --------------------------------------------------
  // Painted from the SAME baked field the carve/stamp/veg passes consume.
  // Realism: per-class engineering palettes, wheel tracks where tires run
  // (|lat| ≈ 0.55·halfW), grassy center strip on doubletrack, worn dusty
  // verge fading into the terrain, wet darkening strongest on asphalt.
  let roadCore: NF = float(0);
  let roadDispK: NF = float(1);
  let roadRough: NF = float(0.88);
  if (inp.road && !inp.far) {
    const rs = inp.road.sampleBaked(wxz);
    const hasRoad = rs.halfW.greaterThan(0.01).select(float(1), float(0));
    const core = rs.edgeK.mul(hasRoad).mul(snowW.oneMinus()).toVar();
    const latN = rs.dist.div(rs.halfW.max(0.2)); // 0 center → 1 surfaced edge
    // wheel tracks: two compaction bands where tires actually run
    const track = smoothstep(0.16, 0.02, latN.sub(0.55).abs());
    const sid = rs.surfIdF;
    const is = (id: SurfaceId): NF =>
      sid.greaterThan(id - 0.5).and(sid.lessThan(id + 0.5)).select(float(1), float(0));
    // asphalt: weathered mountain blacktop, faint patchwork, tire-polished bands
    const asphalt = mix(vec3(0.062, 0.062, 0.066), vec3(0.095, 0.093, 0.094), val(3.1, 0.19, 0.53))
      .mul(macroMix.mul(0.2).add(0.9))
      .add(vec3(0.014, 0.014, 0.013).mul(track));
    // gravel reads as STONES, not concrete (owner feedback 2026-07-03):
    // ~12 cm pebble grain + bright/dark speckle chips on the fine pack,
    // ~35 cm loose stone mottling on the coarse road
    const grain = val(0.12, 0.41, 0.29);
    const grainC = val(0.34, 0.87, 0.15);
    const speck = smoothstep(0.72, 0.95, grain);
    const speckD = smoothstep(0.28, 0.05, grain);
    const gravelFine = mix(vec3(0.25, 0.225, 0.19), vec3(0.35, 0.325, 0.28), grain)
      .add(vec3(0.06, 0.058, 0.052).mul(speck))
      .sub(vec3(0.045, 0.045, 0.04).mul(speckD))
      .mul(float(1).sub(track.mul(0.14)));
    const gravelCoarse = mix(vec3(0.26, 0.25, 0.23), vec3(0.45, 0.43, 0.4), grainC)
      .add(vec3(0.07, 0.068, 0.06).mul(speck))
      .sub(vec3(0.05, 0.05, 0.045).mul(speckD));
    // graded dirt: compacted soil, darker ruts, grassy center strip
    const rut = smoothstep(0.18, 0.04, latN.sub(0.55).abs());
    let dirt = mix(soil, vec3(0.295, 0.245, 0.175), float(0.6))
      .mul(float(1).sub(rut.mul(0.18)));
    dirt = mix(dirt, grassCol.mul(0.85), smoothstep(0.3, 0.08, latN).mul(0.45).mul(grassW.add(0.3).min(1)));
    // singletrack: narrow worn earth ribbon
    const single = mix(soil, vec3(0.24, 0.195, 0.135), float(0.7)).mul(micro.mul(0.15).add(0.9));
    let roadCol: NV3 = asphalt.mul(is(SurfaceId.Asphalt));
    roadCol = roadCol.add(gravelFine.mul(is(SurfaceId.GravelFine)));
    roadCol = roadCol.add(gravelCoarse.mul(is(SurfaceId.GravelCoarse)));
    roadCol = roadCol.add(dirt.mul(is(SurfaceId.DirtRoad)));
    roadCol = roadCol.add(single.mul(is(SurfaceId.Singletrack)));
    // wet response: asphalt darkens hard, dirt/gravel moderately
    const wetK = wet.mul(is(SurfaceId.Asphalt).mul(0.35).add(0.45));
    roadCol = roadCol.mul(wetK.oneMinus());
    col = mix(col, roadCol, core);
    // worn dusty verge between the surfaced edge and the wild ground
    const verge = smoothstep(rs.halfW.add(2.2), rs.halfW.add(0.45), rs.dist)
      .mul(core.oneMinus())
      .mul(hasRoad)
      .mul(snowW.oneMinus());
    col = mix(col, mix(soil, gravelFine, float(0.35)), verge.mul(0.35));
    roadCore = core;
    roadDispK = float(1).sub(core.mul(float(1).sub(rs.dispScale)));
    // asphalt reads smoother than any natural class; gravels/dirt stay matte
    roadRough = mix(float(0.88), float(0.6), is(SurfaceId.Asphalt));

    // surface-debug palette by road-stamp class. surfIdF arrives FRACTIONAL
    // here (measured ≈13.5–14.6 on defect corridors) — landing on the ±0.5
    // window boundaries the natural `is()` uses, so every window misses and the
    // core reads black. Round to the nearest class id and clamp to the valid
    // range, then match exactly — no core can fall through. Debug-only: the
    // natural `is()` above is untouched.
    const sidI = sid.add(0.5).floor().clamp(0, SurfaceId.COUNT - 1);
    const isDbg = (id: SurfaceId): NF =>
      sidI.equal(float(id)).select(float(1), float(0));
    const sidCol = (id: SurfaceId, c: readonly number[]): NV3 => palette(c).mul(isDbg(id));
    let roadDbg: NV3 = sidCol(SurfaceId.Grass, SURF_COL.grass);
    roadDbg = roadDbg.add(sidCol(SurfaceId.Forest, SURF_COL.forest));
    roadDbg = roadDbg.add(sidCol(SurfaceId.Soil, SURF_COL.soil));
    roadDbg = roadDbg.add(sidCol(SurfaceId.Scree, SURF_COL.scree));
    roadDbg = roadDbg.add(sidCol(SurfaceId.Rock, SURF_COL.rock));
    roadDbg = roadDbg.add(sidCol(SurfaceId.GravelRiver, SURF_COL.gravelRiver));
    roadDbg = roadDbg.add(sidCol(SurfaceId.Mud, SURF_COL.mud));
    roadDbg = roadDbg.add(sidCol(SurfaceId.Snow, SURF_COL.snow));
    roadDbg = roadDbg.add(sidCol(SurfaceId.WaterShallow, SURF_COL.water));
    roadDbg = roadDbg.add(sidCol(SurfaceId.WaterDeep, SURF_COL.waterDeep));
    roadDbg = roadDbg.add(sidCol(SurfaceId.Asphalt, SURF_COL.asphalt));
    roadDbg = roadDbg.add(sidCol(SurfaceId.GravelFine, SURF_COL.gravelFine));
    roadDbg = roadDbg.add(sidCol(SurfaceId.GravelCoarse, SURF_COL.gravelCoarse));
    roadDbg = roadDbg.add(sidCol(SurfaceId.DirtRoad, SURF_COL.dirtRoad));
    roadDbg = roadDbg.add(sidCol(SurfaceId.Singletrack, SURF_COL.singletrack));
    // fallback: a road core whose id matched NO class (broken/NaN surfIdF —
    // the very corridors that read black) gets the loud anomaly color instead,
    // so the defect is visible rather than swallowed.
    const matched = isDbg(SurfaceId.Grass)
      .add(isDbg(SurfaceId.Forest)).add(isDbg(SurfaceId.Soil))
      .add(isDbg(SurfaceId.Scree)).add(isDbg(SurfaceId.Rock))
      .add(isDbg(SurfaceId.GravelRiver)).add(isDbg(SurfaceId.Mud))
      .add(isDbg(SurfaceId.Snow)).add(isDbg(SurfaceId.WaterShallow))
      .add(isDbg(SurfaceId.WaterDeep)).add(isDbg(SurfaceId.Asphalt))
      .add(isDbg(SurfaceId.GravelFine)).add(isDbg(SurfaceId.GravelCoarse))
      .add(isDbg(SurfaceId.DirtRoad)).add(isDbg(SurfaceId.Singletrack))
      .clamp(0, 1);
    roadDbg = mix(palette(SURF_COL.anomaly), roadDbg, matched);
    surfDbg = mix(surfDbg, roadDbg, core);
  }

  // ---------- normal perturbation ---------------------------------------------------
  // far-detail synthesis (Pillar D): serrated normal-domain detail keeps
  // mid/far ridges craggy where geometric density has LOD'd out. Applied by
  // DISTANCE on both near tiles and the far shell.
  const camDist = wp.sub(cameraPosition).length();
  const farK = inp.far ? float(1) : smoothstep(900, 2600, camDist);
  // pre-baked ridged gradient at 310 m features; ×44 ≈ the old ±22 m
  // finite-difference amplitude (×2: baked noise is [0,1], mx was [-1,1])
  const rg = ridG(310).mul(44 * 2);
  // crag synthesis belongs to ROCK faces — on smooth vegetated hills the
  // ridged gradient field printed parallel pale corrugation streaks
  const farAmp = smoothstep(0.5, 1.1, slope)
    .mul(0.4)
    .add(smoothstep(0.32, 0.7, slope).mul(0.08))
    .mul(farK);
  // never let detail flip the surface away from the sky
  const perturbed = baseNormal.add(vec3(rg.x, 0, rg.y).mul(farAmp));
  let nrm: NV3 = vec3(perturbed.x, perturbed.y.max(0.1), perturbed.z).normalize();

  if (!inp.far) {
    // meso + micro analytic bumps near camera, stronger on rock — baked fbm
    // gradients at two scales (×2e ≈ old FD amplitudes, ×2 range factor)
    const b1 = fbmG(1.45).mul(1.8 * 2);
    const b2 = fbmG(0.19, 0.31, 0.77).mul(0.24 * 2);
    const bumpAmp = mix(float(0.25), float(0.85), rockW)
      .mul(snowW.mul(0.7).oneMinus())
      .mul(farK.oneMinus())
      // engineered surfaces are graded — bumps follow the class dispScale
      // (asphalt flat, gravel keeps its pebble relief; owner feedback)
      .mul(roadDispK);
    nrm = nrm
      .add(
        vec3(
          b1.x.mul(0.7).add(b2.x.mul(0.45)),
          0,
          b1.y.mul(0.7).add(b2.y.mul(0.45)),
        ).mul(bumpAmp),
      )
      .normalize();

    // geometric micro-displacement counterpart (TerrainTiles vertex): the
    // silhouette now has fbm/ridged relief — light it with the analytic
    // height-gradient normal (−∂h/∂x, 0, −∂h/∂z), same amplitudes + fade,
    // or the displaced surface shades as if it were still flat. Same gating
    // curve as the vertex stage (NOT rockW — different knees).
    const rockKd = smoothstep(DISP.slopeKnee0, DISP.slopeKnee1, slope).max(
      rockExposure.mul(0.85),
    );
    // gravel banks/streambeds are lumpy even on gentle slopes
    const gravelKd = smoothstep(0.32, 0.7, flowStrength)
      .max(smoothstep(0.02, 0.2, riverDepth))
      .mul(float(DISP.gravel));
    const dispAmpF = mix(float(DISP.base), float(DISP.rock), rockKd)
      .max(gravelKd)
      .mul(snowW.mul(0.75).oneMinus())
      .mul(
        clamp(float(DISP.fade1).sub(camDist).div(DISP.fade1 - DISP.fade0), 0, 1),
      )
      // road gating — KEEP IN LOCKSTEP with the TerrainTiles vertex stage
      .mul(roadDispK);
    const gF = fbmG(DISP.sF1).mul(2 * DISP.wF1);
    const gR = ridG(DISP.sRid).mul(
      rockKd.mul(1 - DISP.ridBase).add(DISP.ridBase).mul(DISP.wRid),
    );
    const gSum = gF.add(gR).mul(dispAmpF);
    nrm = nrm.add(vec3(gSum.x.negate(), 0, gSum.y.negate())).normalize();
  }

  // ---------- roughness ---------------------------------------------------------------
  const rough = mix(mix(float(0.94), float(0.8), rockW), roadRough, roadCore)
    .sub(snowW.mul(0.32))
    .sub(wet.mul(0.45))
    .clamp(0.25, 1);

  return {
    colorNode: col,
    normalNode: transformNormalToView(nrm),
    roughnessNode: rough,
    worldNormalNode: nrm,
    surfaceDebugNode: surfDbg,
  };
}
