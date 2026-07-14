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
import { hash12, hash22 } from '../gpu/noise/NoiseTSL';
import type { RoadSampleBaked } from '../gpu/passes/RoadField';
import type { ScenicSampleBaked } from '../gpu/passes/ScenicField';
import { SurfaceId } from '../ride/SurfaceMatrix';
import {
  PERIOD_FBM,
  PERIOD_RID,
  PERIOD_VAL,
} from '../gpu/passes/NoiseBake';
import { sunU } from './VegMaterials';
import { SURF_COL, palette } from './DebugSurface';
import { weatherU } from '../sky/Weather';
import {
  FAR_BAND_ENV,
  beddingBasis,
  beddingCorePhase,
  zoneMasks,
  type MacroParams,
} from '../world/MacroMap';
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
  /**
   * P.5 scenic contour bands (ScenicField.sampleBaked) — near tiles only.
   * Decorative: a faint worn-path tint on green flanks that fades IN with
   * camera distance (the mid/far composition of ref-04); never physical.
   */
  scenic?: { sampleBaked(p: NV2): ScenicSampleBaked } | null;
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
 * Gravel-carpet Worley cell (soft treads): nearest jittered feature in the
 * 3×3 cell neighborhood. Returns squared distance d2 (cell units), the offset
 * TO the nearest feature (analytic gradient: ∇h needs no epsilon taps and no
 * dFdx quad artifacts) and the WINNING cell's tone hash (mx_cell_noise would
 * hash the lattice cell, not the owner — tone seams would cut stones).
 * Pure select-chain expressions — no assign, material-graph safe. Cell coords
 * wrap to a 1024 period before hashing: cm-scale cells reach ~2e5 at the
 * world edge where fract() inside hash22 degrades; an 11–29 m repeat is
 * invisible on 1–3 cm features.
 */
const treadWorley = (p: NV2): { d2: NF; off: NV2; id: NF } => {
  const cell = p.floor();
  const f = p.fract();
  let d2: NF | null = null;
  let off: NV2 | null = null;
  let id: NF | null = null;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const c = cell.add(vec2(ox, oy));
      const cw = c.sub(c.mul(1 / 1024).floor().mul(1024));
      const rnd = hash22(cw);
      const o = vec2(ox, oy).add(rnd).sub(f);
      const d = o.dot(o).toVar();
      const cid = rnd.x.mul(57.31).add(rnd.y.mul(113.7)).fract();
      if (d2 === null) {
        d2 = d; off = o; id = cid;
      } else {
        const win = d.lessThan(d2);
        off = win.select(o, off) as NV2;
        id = win.select(cid, id) as NF;
        d2 = win.select(d, d2).toVar() as NF;
      }
    }
  }
  return { d2: d2!, off: off!, id: id! };
};

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
  // Chebyshev radius from the world ORIGIN — the same metric the far-band
  // envelopes use (MacroMap FAR_BAND_ENV), shared by outsideK and the П.6-7
  // per-plane tone steps below
  const chebR = wxz.abs().x.max(wxz.abs().y);
  // Beyond the world edge the baked maps clamp to their last texel row and
  // SMEAR it radially across the vista shell (pale streaks). Cross-fade to
  // procedural estimates outside the domain (far shell only).
  const outsideK = inp.far
    ? smoothstep(WORLD_HALF * 0.96, WORLD_HALF * 1.0, chebR)
    : float(0);
  // П.6-7: which far PLANE a fragment sits on — 0 = bandA (foothills),
  // 1 = bandB (middle range), 2 = bandC (horizon wall). Radially these are
  // ramps across the env gaps, but on screen the planes are separated by the
  // envelope troughs, so between visible surfaces the step reads as a
  // DISCRETE contrast/tone jump (ref-04) — not fog, tone only.
  const planStep = inp.far
    ? smoothstep(FAR_BAND_ENV.A[2], FAR_BAND_ENV.B[1], chebR).add(
        smoothstep(FAR_BAND_ENV.B[2], FAR_BAND_ENV.C[1], chebR),
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
  // П.6-7 texture ladder: the NEAR far-plane (bandA) gets a live coarse 140 m
  // variation instead of the dead 0.5 constant; the farther planes flatten
  // out (B ≈30% left, C fully flat) — texture density itself becomes a
  // per-plane depth cue, orthogonal to fog
  const meso = inp.far
    ? mix(fbmV(140, 0.41, 0.09), float(0.5), planStep.mul(0.7).clamp(0, 1))
    : fbmV(1.45);
  const micro = inp.far ? float(0.5) : val(0.19, 0.71, 0.13);

  // ---------- class palettes ----------------------------------------------------
  // rock: strata banding; warm rust in the alpine zone, pale gray in karst.
  // П.8: ONE bedding phase (beddingCorePhase — the same plane family the
  // geometric ledge-beds step along in MacroMap) drives the albedo bands,
  // the iron seams AND the slab-edge normal bump below, so paint, rust and
  // light all land on the same diagonal slabs. Warp budget ≤0.30 period —
  // the old ±7.3-period jitter erased the coherent signal entirely.
  const bb = beddingBasis(inp.mp);
  // one fetch yields the warp value (.y) and its gradient (.zw) for the bump
  const wTex = texture(inp.noiseA, wxz.div(430 * PERIOD_FBM).add(vec2(0.17, 0.53)));
  const bedWarp = wTex.y.sub(0.5).mul(2 * 0.3);
  const bedWarpG = wTex.zw.div(430).mul(2 * 0.3); // ∇warp, 1/m
  const phi = beddingCorePhase(h, wxz, inp.mp).add(bedWarp).toVar();
  const bandF = phi.fract().toVar();
  const bandI = phi.floor();
  // piecewise-constant per-bed character: .x = tone amplitude, .y = iron pick
  const bedHash = texture(
    inp.noiseA,
    vec2(bandI.mul(0.618).add(31.7), bandI.mul(0.343).add(7.3)).div(PERIOD_VAL),
  );
  // mega-packets: slow contrast envelope grouping ~4 beds (ref-05 hierarchy).
  // Deeper envelope (0.35..1.3, was 0.55..1.3) + slower frequency: inside a
  // packet trough neighbouring beds flatten together instead of alternating —
  // kills the even "zebra" read on shadowed walls
  const megaK = band(phi.mul(0.24), float(13.7)).mul(0.95).add(0.35); // 0.35..1.3
  // steep rock faces of the alpine massif read as exposed bedding (ref-05):
  // hard slab profile there (lit weathered crest at the bed top, dark
  // recessed shelf); elsewhere a soft band keeps the old low-contrast look
  // banding retreats to genuinely steep summit rock (0.55→0.85 floor): with
  // green now on the flanks, the old wide gate painted zebra tonal rings on
  // ground that should read as meadow (owner: "полосы как баг заливки")
  const strataBoost = zm.tAlp.mul(smoothstep(0.85, 1.25, slope)).toVar();
  const bedToneHard = smoothstep(0.62, 0.16, bandF)
    .mul(bedHash.x.mul(0.5).add(0.6)) // wider per-bed tone random (0.6..1.1)
    .mul(megaK)
    .clamp(0.05, 1.0);
  const bedToneSoft = band(phi, bedHash.x.mul(1.7).add(31.7)).mul(0.5).add(0.28);
  // zebra fix: on the LESS steep parts of the massif the hard band contrast
  // compresses toward mid-tone — packets still read, individual stripes stop
  // shouting at equal contrast everywhere (ref-05 shadowed walls)
  const bedContrast = smoothstep(0.7, 1.15, slope).mul(0.45).add(0.55); // 0.55..1
  const strata = mix(bedToneSoft, mix(float(0.5), bedToneHard, bedContrast), strataBoost);
  // reference peaks are DARK: gray-blue mass with rust faces catching light —
  // pale palettes washed the whole massif into cream at golden hour
  const alpRock = mix(vec3(0.16, 0.135, 0.125), vec3(0.38, 0.26, 0.18), strata);
  const karstRock = mix(vec3(0.3, 0.3, 0.29), vec3(0.5, 0.48, 0.44), strata);
  const genericRock = mix(vec3(0.26, 0.245, 0.225), vec3(0.42, 0.39, 0.35), strata);
  let rockCol = mix(genericRock, karstRock, zm.tKarst);
  rockCol = mix(rockCol, alpRock, zm.tAlp.mul(0.85));
  // iron-oxide seams: rust is a per-BED property (~20% of beds, hash-picked),
  // a thin stripe hugging the slab crest — same bedding phase, so the hue
  // layering the refs show runs along the slabs, not across them
  const ironSel = smoothstep(0.66, 0.74, bedHash.y);
  const ironBand = ironSel
    .mul(smoothstep(0.02, 0.08, bandF))
    .mul(smoothstep(0.3, 0.16, bandF));
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
  const grassG = mix(vec3(0.038, 0.105, 0.019), vec3(0.066, 0.148, 0.029), macroA);
  const grassDry = vec3(0.15, 0.122, 0.052);
  const grassCol = mix(
    grassG,
    grassDry,
    smoothstep(0.6, 0.92, patchN.mul(0.55).add(macroB.mul(0.45))),
  ).mul(meso.mul(0.25).add(0.85));
  // forest floor: litter brown blended w/ moss by moisture
  const litter = mix(soil, vec3(0.18, 0.15, 0.095), meso);
  const mossy = vec3(0.105, 0.2, 0.06);
  const forestFloor = mix(litter, mossy, smoothstep(0.45, 0.8, moisture).mul(0.7));
  // gravel/cobble tint in stream channels
  const gravel = mix(vec3(0.34, 0.33, 0.31), vec3(0.47, 0.45, 0.43), micro);
  const snowCol = mix(vec3(0.86, 0.88, 0.94), vec3(0.93, 0.95, 0.99), macroA).mul(
    meso.mul(0.08).add(0.95),
  );

  // ---------- class weights ------------------------------------------------------
  // Bavarian cover retune (owner 2026-07-14): green climbs to the crest, bare
  // rock/scree only near the summit. rock floor 0.62→0.95 (35.5°→43.5°) so only
  // genuinely steep faces read as bare rock; scree altitude gate 380→1050 m so
  // it stops painting mid-mountain from the valley up, and it now yields to
  // grass in the overlap (grassW.oneMinus); grass slope ceiling widened
  // 0.22→0.7 rad so meadow survives the 25-45° flanks the new macro-form has.
  const rockW = smoothstep(1.15, 1.7, slope).max(rockExposure.mul(0.85)).toVar();
  const screeW = smoothstep(0.42, 0.62, slope)
    .mul(smoothstep(1.15, 0.7, slope))
    .mul(smoothstep(1450, 1700, h))
    .mul(rockW.oneMinus());
  const grassW = smoothstep(1.35, 0.62, slope)
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
  let mudCol: NV3 = vec3(0.055, 0.052, 0.038); // far shell keeps the flat silt
  let mudGlossK: NF = float(0); // glossy-lens roughness drop, pre-gated by pondK
  let mudG: NV2 = vec2(0, 0); // mud ∇h (lens rims + prints), pre-faded·pondK
  if (!inp.far) {
    // mud pattern is NEAR-only and worley-free by design (natural class covers
    // wide areas — budget); contribution is gated by pondK so grass/rock/forest
    // pixels pay a few coherent fetches and zero visible effect
    const camDm = wp.sub(cameraPosition).length();
    const fadeMA = smoothstep(40, 18, camDm); // albedo fade
    const fadeMN = smoothstep(26, 12, camDm); // normal fade — tighter (TRAA)
    // (a) glossy lenses: standing-water film blobs 0.5–1 m; ONE fetch gives
    //     the field (.y) AND its gradient (.zw) for the recessed rim normal
    const lzT = texture(inp.noiseA, wxz.div(0.9 * PERIOD_FBM).add(vec2(0.67, 0.31)));
    const lens = smoothstep(0.56, 0.72, lzT.y);
    // (b) pores/blobs: sparse cm-speckle from baked value noise (no worley);
    //     0.11 m scale — same world-edge precision class as the existing
    //     val(0.12) road grain
    const pore = smoothstep(0.78, 0.95, val(0.11, 0.23, 0.51));
    // zero-mean silt mottle around the palette (hue held)
    const mudTone = lzT.y.sub(0.5).mul(0.18).mul(fadeMA);
    mudCol = mudCol
      .mul(mudTone.add(1))
      .mul(float(1).sub(lens.mul(0.20).mul(fadeMA))) // water film darker
      .mul(float(1).sub(pore.mul(0.12).mul(fadeMA)));
    // gloss: roughness drop INSIDE lenses only — spatial pattern on top of the
    // uniform wet/moisture darkening, not a duplicate of it
    mudGlossK = lens.mul(0.35).mul(fadeMA).mul(pondK);
    // prints/unevenness: recessed lens rims (analytic, same fetch) + low
    // trampled bumps; h-gradient convention matches gSum/gCarpet
    const lensG = lzT.zw.div(0.9)
      .mul(lens.mul(lens.oneMinus()).mul(4)) // rim band of the smoothstep
      .mul(-0.045); // lenses sit RECESSED
    const printG = fbmG(0.45, 0.19, 0.87).mul(0.03);
    mudG = lensG.add(printG).mul(fadeMN).mul(pondK);
  }
  let col: NV3 = soil;
  col = mix(col, grassCol, grassW);
  col = mix(col, forestFloor, forestW);
  col = mix(col, scree, screeW);
  col = mix(col, rockCol, rockW);
  // П.8 ledge greens: ref-05 shows GREEN turf ribbons on the flat shelf tops
  // between protruding slab edges — without them the massif reads as bare
  // "zebra". Shelf zone = high bandF (the long shallow tail behind the crest,
  // the falling side of bedToneHard's profile) — the built-in "locally
  // flatter" surrogate of the bed profile. Per-bed pick via bedHash.z (only
  // some beds carry turf), broken along the bed by one baked patch noise so
  // it reads as ribbons/clumps, not painted stripes. Existing grass/moss
  // tones only — no new palette.
  const LEDGE_GREEN = 0.6; // strength knob
  const shelfF = smoothstep(0.3, 0.55, bandF); // shelf behind the crest
  const ledgeSel = smoothstep(0.3, 0.62, bedHash.z); // per-bed turf pick
  const ledgePatch = smoothstep(0.3, 0.68, val(9.7, 0.41, 0.19)); // ribbons
  const ledgeVegK = strataBoost
    .mul(shelfF)
    .mul(ledgeSel)
    .mul(ledgePatch)
    .mul(smoothstep(1.45, 1.0, slope)) // turf can't hold on near-vertical
    .mul(snowW.oneMinus())
    .mul(LEDGE_GREEN);
  const ledgeGreen = mix(mossy, grassG, macroA);
  col = mix(col, ledgeGreen, ledgeVegK.mul(rockW).clamp(0, 0.85));
  col = mix(col, gravel, riverW.mul(0.85).mul(pondK.oneMinus()));
  col = mix(col, mudCol, pondK);
  col = mix(col, snowCol, snowW);
  col = col.mul(macroTint.add(1));
  if (inp.far) {
    // Aerial perspective toward an absolute cold/light destination. The old
    // gate was planStep-only, but planStep is 0 across the NEAREST far band
    // (bandA, chebR < A[2]) — so the prominent horizon ranges got ZERO fade and
    // stayed dark/warm (measured rgb(123,148,163) v0.64 vs ref rgb(165,204,240)
    // v0.93 — read as "brown murk"). Fade now grows with DISTANCE (chebR) so
    // bandA also washes toward light blue, with the discrete ladder adding a
    // small per-plane step on top.
    const aerialBlue = vec3(0.64, 0.79, 0.94);
    const distAerial = smoothstep(WORLD_HALF, 7500, chebR).pow(0.85).mul(0.8);
    const aerialK = distAerial.add(planStep.mul(0.16)).clamp(0, 0.92);
    col = mix(col, aerialBlue, aerialK);
  }

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

  // wet darkening: river margins, lake shores, marshes — SLOPE-GATED (water
  // films live on gentle ground only; mirrors the pondK discipline above and
  // the WaterMaterial rampK gate). Exposed rock/scree sheds water: damp there.
  // The M1.6 global weather wetness (rain/after-rain) rides the same term, so
  // the albedo darken AND the roughness drop downstream react together.
  const wetSlope = smoothstep(0.5, 0.22, slope); // full <~12°, zero >~27°
  const wetShed = float(1).sub(rockW.max(screeW).mul(0.7)); // rock/scree damp
  const shoreWet = smoothstep(LAKE_LEVEL + 2.5, LAKE_LEVEL + 0.3, h)
    .mul(smoothstep(0.45, 0.8, moisture)); // horizontal proximity via the lake's own moisture halo
  const wetLocal = clamp(
    smoothstep(0.55, 0.95, moisture).mul(0.5).add(riverDepth.mul(2)).add(shoreWet.mul(0.6)),
    0,
    0.75,
  ).mul(wetSlope).mul(wetShed);
  const wetRain = (weatherU.wetness as unknown as NF).mul(0.72);
  const wet = wetLocal.max(wetRain).mul(snowW.oneMinus()).toVar();
  col = col.mul(wet.mul(0.55).oneMinus());
  let wetEff: NF = wet; // hoist: road block substitutes its own wet response

  // ---------- M1.2 road surfaces --------------------------------------------------
  // Painted from the SAME baked field the carve/stamp/veg passes consume.
  // Realism: per-class engineering palettes, wheel tracks where tires run
  // (|lat| ≈ 0.55·halfW), grassy center strip on doubletrack, worn dusty
  // verge fading into the terrain, wet darkening strongest on asphalt.
  let roadCore: NF = float(0);
  let roadDispK: NF = float(1);
  let roadRough: NF = float(0.88);
  // gravel carpet (soft treads 12–14): weight incl. edge falloff + the
  // distance-faded analytic ∇h of the stone domes, consumed at the
  // normal-perturbation stage below (hoist pattern: see roadCore)
  let treadK: NF = float(0);
  let treadG: NV2 = vec2(0, 0);
  // asphalt/gravel-fine class detail ∇h — pre-weighted (is()·core·fade) inside
  // the road block, folded into the 4th normal stage with treadG (same hoist
  // pattern; zero vector when no road / other classes)
  let extraG: NV2 = vec2(0, 0);
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
    // ---------- gravel carpet: continuous embedded micro-fraction (ref-01) ----
    // Soft treads read as a DENSE half-buried fraction, not smooth cream:
    // two world-space Worley layers (~2.8 cm stones + ~1.1 cm chips),
    // per-stone tone from the winning-cell hash, analytic paraboloid-dome
    // gradient for the normal. Tone is ZERO-MEAN around each class palette,
    // so the distance fade IS the LOD-to-mean; instanced 3–8 cm fraction
    // (GroundRing) rides on top of this base layer.
    const treadW = is(SurfaceId.GravelCoarse)
      .add(is(SurfaceId.DirtRoad))
      .add(is(SurfaceId.Singletrack))
      .clamp(0, 1);
    const camD = wp.sub(cameraPosition).length();
    const SC = 0.028; // coarse stone cell, m
    const SF = 0.011; // fine chip cell, m
    const gcw = treadWorley(wxz.div(SC));
    const gfw = treadWorley(wxz.div(SF));
    // albedo fades: fine fraction is subpixel past ~14 m from saddle height
    const fadeAC = smoothstep(45, 22, camD);
    const fadeAF = smoothstep(14, 6, camD);
    const tone = gcw.id.sub(0.5).mul(0.34).mul(fadeAC)
      .add(gfw.id.sub(0.5).mul(0.18).mul(fadeAF));
    // inter-stone seams (fines/shadow between domes → stones read embedded)
    const seam = smoothstep(0.32, 0.9, gcw.d2).mul(0.14).mul(fadeAC)
      .add(smoothstep(0.36, 1.0, gfw.d2).mul(0.07).mul(fadeAF));
    // brighter stones drift warm, darker cool — stays inside the palette
    const carpetTint = vec3(
      tone.mul(1.1).add(1),
      tone.add(1),
      tone.mul(0.85).add(1),
    ).mul(seam.oneMinus());
    // normal fades TIGHTER than albedo (high-freq normal = TRAA shimmer)
    const fadeNC = smoothstep(32, 15, camD);
    const fadeNF = smoothstep(10, 4, camD);
    // dome h = A·(1 − d2/R²): ∇h_world = 2A·off/(R²·S); rim rolled off so
    // the gradient cutoff doesn't facet
    const R2 = 0.5625; // stone radius 0.75 cell units, squared
    const domeC = smoothstep(R2, R2 * 0.55, gcw.d2);
    const domeF = smoothstep(R2, R2 * 0.55, gfw.d2);
    const AC = 0.35 * SC;
    const AF = 0.3 * SF;
    treadG = gcw.off.mul((2 * AC) / (R2 * SC)).mul(domeC).mul(fadeNC)
      .add(gfw.off.mul((2 * AF) / (R2 * SF)).mul(domeF).mul(fadeNF));
    treadK = treadW.mul(core);
    // ---------- asphalt weathering (SurfaceId 10): aggregate + cracks + patches
    const isAsp = is(SurfaceId.Asphalt);
    // (a) aggregate speckle: REUSE fine Worley chips — zero extra Worley cost.
    //     zero-mean per-chip tone, ±5% value
    const aggTone = gfw.id.sub(0.5).mul(0.10).mul(fadeAF);
    // (b) cracks: meandering level-set of baked fbm — ONE fetch gives value (.y)
    //     AND analytic gradient (.zw) for the groove normal. Sparse mask from
    //     the already-fetched macroB (11.3 m) — cracks cluster, ~25–30% of area
    const ckT = texture(inp.noiseA, wxz.div(2.3 * PERIOD_FBM).add(vec2(0.57, 0.11)));
    const ckN = ckT.y.sub(0.5);
    const ckMask = smoothstep(0.58, 0.72, macroB);
    const crack = smoothstep(0.035, 0.008, ckN.abs()).mul(ckMask).mul(fadeAC);
    // (c) patches/blotches: low-frequency sealant blobs, darker + smoother
    const patch = smoothstep(0.60, 0.68, val(7.7, 0.13, 0.67));
    // (d) weathered edge: aggregate exposed near the surfaced edge → lighter,
    //     specklier, rougher
    const edgeWear = smoothstep(0.70, 1.0, latN);
    const aspTone = aggTone.mul(edgeWear.mul(0.8).add(1))
      .add(edgeWear.mul(0.05).mul(fadeAC))
      .sub(crack.mul(0.30))
      .sub(patch.mul(0.10));
    // neutral-gray tint (hue held: asphalt palette is near-achromatic)
    const aspTint = vec3(aspTone.add(1), aspTone.add(1), aspTone.mul(0.97).add(1));
    // normal: sub-mm aggregate domes (reuse domeF) + V-groove of the crack
    // (∇h = sign(n)·∇n·depth inside the line); h-gradient convention = gCarpet
    const aggG = gfw.off.mul((2 * 0.06 * SF) / (R2 * SF)).mul(domeF).mul(fadeNF);
    const grooveG = ckT.zw.div(2.3).mul(ckN.sign()).mul(crack).mul(0.05).mul(fadeNC);
    extraG = extraG.add(aggG.add(grooveG).mul(isAsp).mul(core));
    // ---------- packed fine gravel (SurfaceId 11): compacted chip carpet ------
    const isFine = is(SurfaceId.GravelFine);
    // tone: fine chips dominant but MUTED (packed = uniform), faint coarse mottle
    const fineTone = gfw.id.sub(0.5).mul(0.10).mul(fadeAF)
      .add(gcw.id.sub(0.5).mul(0.06).mul(fadeAC));
    // seams almost filled by fines — much weaker than the loose carpet's 0.14
    const fineSeam = smoothstep(0.50, 1.05, gfw.d2).mul(0.05).mul(fadeAF);
    // rut band: the existing wheel-track band modulated low-frequency along
    // the road so ruts breathe instead of running as constant stripes
    const fineTint = vec3(fineTone.mul(1.05).add(1), fineTone.add(1), fineTone.mul(0.9).add(1))
      .mul(fineSeam.oneMinus())
      .mul(float(1).sub(track.mul(0.06).mul(macroMix)));
    // normal: near-flat compacted domes — amplitude 0.10·SF vs the loose
    // carpet's 0.30·SF (chips) / 0.35·SC (stones): ~3× flatter
    const fineG = gfw.off.mul((2 * 0.10 * SF) / (R2 * SF)).mul(domeF).mul(fadeNF)
      .add(gcw.off.mul((2 * 0.05 * SC) / (R2 * SC)).mul(domeC).mul(fadeNC));
    extraG = extraG.add(fineG.mul(isFine).mul(core));
    let roadCol: NV3 = asphalt.mul(is(SurfaceId.Asphalt));
    roadCol = roadCol.add(gravelFine.mul(is(SurfaceId.GravelFine)));
    roadCol = roadCol.add(gravelCoarse.mul(is(SurfaceId.GravelCoarse)));
    roadCol = roadCol.add(dirt.mul(is(SurfaceId.DirtRoad)));
    roadCol = roadCol.add(single.mul(is(SurfaceId.Singletrack)));
    // gravel-carpet tint BEFORE wetK: rain darkening rides on top (the
    // carpet is an INPUT to the PBR albedo, not a post-effect)
    roadCol = roadCol.mul(mix(vec3(1, 1, 1), carpetTint, treadW));
    // class weathering tints (zero-mean, hue held) — same pre-wetK slot
    roadCol = roadCol.mul(mix(vec3(1, 1, 1), aspTint, isAsp));
    roadCol = roadCol.mul(mix(vec3(1, 1, 1), fineTint, isFine));
    // wet response: pavement takes RAIN only — the moisture halo never wets
    // the polotno (owner: no water on roads). Ford margins keep the local
    // damp. Asphalt darkens hard, dirt/gravel moderately.
    const wetRoad = wetRain.max(wetLocal.mul(rs.ford)).mul(snowW.oneMinus());
    const wetK = wetRoad.mul(is(SurfaceId.Asphalt).mul(0.35).add(0.45));
    roadCol = roadCol.mul(wetK.oneMinus());
    wetEff = mix(wetEff, wetRoad, core);
    col = mix(col, roadCol, core);
    // worn dusty verge between the surfaced edge and the wild ground
    const verge = smoothstep(rs.halfW.add(2.2), rs.halfW.add(0.45), rs.dist)
      .mul(core.oneMinus())
      .mul(hasRoad)
      .mul(snowW.oneMinus());
    col = mix(col, mix(soil, gravelFine, float(0.35)), verge.mul(0.35));
    roadCore = core;
    roadDispK = float(1).sub(core.mul(float(1).sub(rs.dispScale)));
    // asphalt: micro-rough field (aggregate speckle ±, crack interiors rough,
    // fresh patches smooth, weathered edge rough); packed fine gravel reads
    // smoother than loose gravel/dirt but rougher than asphalt
    const aspRough = float(0.6)
      .add(gfw.id.sub(0.5).mul(0.06).mul(fadeAF))
      .add(crack.mul(0.15))
      .add(edgeWear.mul(0.08))
      .sub(patch.mul(0.08))
      .clamp(0.5, 0.85);
    roadRough = mix(mix(float(0.88), float(0.78), isFine), aspRough, isAsp);

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

  const camDist = wp.sub(cameraPosition).length();

  // ---------- P.5 scenic contour bands (ref-04) -----------------------------------
  // Decorative macro-isoline paths blended from the baked ScenicField —
  // pure mid/far COMPOSITION of green flanks lined with near-level trails.
  // Not rideable, not carved, not stamped: material tint only. Fades IN
  // with camera distance so up close the band vanishes (a material-only
  // stripe under the wheels would read as painted terrain), and only lives
  // on green slopes (grassW gate); real roads keep their own paint.
  if (inp.scenic && !inp.far) {
    const sc = inp.scenic.sampleBaked(wxz);
    const lat = sc.lat; // signed: positive = uphill side (ScenicContours orients)
    const halfW = float(2.1); // ≈4.2 m visible tread band
    const farIn = smoothstep(100, 180, camDist);
    // breakup along the line: world-anchored macro noise drops ~15–25% of
    // the band so it reads as a worn path, not a plotted curve
    const brk = float(1).sub(smoothstep(0.4, 0.8, val(11.7, 0.83, 0.37)).mul(0.24));
    const green = smoothstep(0.2, 0.5, grassW).mul(snowW.oneMinus());
    const bandK = smoothstep(halfW.add(0.8), halfW.sub(0.6), sc.dist)
      .mul(farIn)
      .mul(brk)
      .mul(green)
      .mul(roadCore.oneMinus());
    // worn-path tint: blend toward bare soil (18–32% per the advisor spec)
    col = mix(col, soil, bandK.mul(0.28));
    // dark downhill edge (5–10%): the shadowed bench-cut lip that makes the
    // line read as a path on the flank instead of a flat decal
    const below = lat.negate(); // > 0 on the downhill side
    const lowK = smoothstep(halfW.mul(0.2), halfW.mul(0.8), below)
      .mul(smoothstep(halfW.add(1.6), halfW.add(0.3), below))
      .mul(farIn)
      .mul(brk)
      .mul(green)
      .mul(roadCore.oneMinus());
    col = col.mul(float(1).sub(lowK.mul(0.08)));
  }

  // ---------- normal perturbation ---------------------------------------------------
  // far-detail synthesis (Pillar D): serrated normal-domain detail keeps
  // mid/far ridges craggy where geometric density has LOD'd out. Applied by
  // DISTANCE on both near tiles and the far shell.
  const farK = inp.far ? float(1) : smoothstep(900, 2600, camDist);
  // П.8 slab-edge gate: where the bedding shows (steep alpine faces, no
  // snow) — shared by the bedding bump below and the isotropic-noise damping
  const bedGate = strataBoost.mul(snowW.mul(0.8).oneMinus()).toVar();
  // pre-baked ridged gradient at 310 m features; ×44 ≈ the old ±22 m
  // finite-difference amplitude (×2: baked noise is [0,1], mx was [-1,1])
  const rg = ridG(310).mul(44 * 2);
  // crag synthesis belongs to ROCK faces — on smooth vegetated hills the
  // ridged gradient field printed parallel pale corrugation streaks; damped
  // on bedding walls so the diagonal rhythm wins over isotropic crag
  let farAmp = smoothstep(0.5, 1.1, slope)
    .mul(0.4)
    .add(smoothstep(0.32, 0.7, slope).mul(0.08))
    .mul(farK)
    .mul(bedGate.mul(0.6).oneMinus());
  if (inp.far) {
    // П.6-7: crag strength steps DOWN per far plane (1.0 / 0.675 / 0.35) —
    // the near foothills keep crunchy relief, the horizon wall goes flat
    farAmp = farAmp.mul(float(1).sub(planStep.mul(0.325)));
  }
  // never let detail flip the surface away from the sky
  const perturbed = baseNormal.add(vec3(rg.x, 0, rg.y).mul(farAmp));
  let nrm: NV3 = vec3(perturbed.x, perturbed.y.max(0.1), perturbed.z).normalize();

  // П.8 bedding bump: virtual slab displacement d = A·prof(bandF) along the
  // bed normal, applied as n' = normalize(n − ∇ₜd) with the TANGENTIAL phase
  // gradient (CPU-constant ∇φ + the baked warp gradient — pure ALU, no extra
  // fetches). prof' is asymmetric: a sharp rise at the slab edge catches the
  // light, the long shallow fall reads as the shelf behind it.
  {
    // prof(f) = smoothstep(0, 0.24, f) − f·0.62 → prof' ∈ [−0.62, +5.6]
    const tR = bandF.div(0.24).clamp(0, 1);
    const profD = tR.mul(tR.oneMinus()).mul(6).div(0.24).sub(0.62);
    const gPhi = vec3(bb.gX, bb.gY, bb.gZ).add(vec3(bedWarpG.x, 0, bedWarpG.y));
    const gTan = gPhi.sub(baseNormal.mul(baseNormal.dot(gPhi)));
    const BED_BUMP = 1.15; // m of virtual slab displacement
    nrm = nrm.sub(gTan.mul(profD).mul(BED_BUMP).mul(bedGate));
    nrm = vec3(nrm.x, nrm.y.max(0.08), nrm.z).normalize();
  }

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
    const gR = ridG(DISP.sRid)
      .mul(rockKd.mul(1 - DISP.ridBase).add(DISP.ridBase).mul(DISP.wRid))
      // П.8: micro ridged creases yield to the diagonal bedding on slab walls
      .mul(bedGate.mul(0.45).oneMinus());
    const gSum = gF.add(gR).mul(dispAmpF);
    nrm = nrm.add(vec3(gSum.x.negate(), 0, gSum.y.negate())).normalize();

    // gravel-carpet stone domes (soft treads 12–14): analytic ∇h of the
    // jittered paraboloid pebbles — ∇h is already distance-faded (15–32 m
    // coarse, 4–10 m fine, anti-TRAA-shimmer); treadK gates to the tread.
    // Height-gradient convention matches gSum above: n' = n − ∇ₜh.
    const gCarpet = treadG.mul(treadK).add(extraG).add(mudG);
    nrm = nrm.add(vec3(gCarpet.x.negate(), 0, gCarpet.y.negate()));
    nrm = vec3(nrm.x, nrm.y.max(0.08), nrm.z).normalize();
  }

  // ---------- roughness ---------------------------------------------------------------
  // wet gloss = standing water film; a film does not hold on an incline, so
  // the roughness drop gets a HARD slope gate (full <~8.5°, zero >~22°) on
  // top of the already-gated wetEff — rain gloss survives on real (flat)
  // pavement but never on a defective near-vertical slab
  const rough = mix(mix(float(0.94), float(0.8), rockW), roadRough, roadCore)
    .sub(snowW.mul(0.32))
    .sub(mudGlossK)
    .sub(wetEff.mul(smoothstep(0.3, 0.12, slope)).mul(0.45))
    .clamp(0.25, 1);

  return {
    colorNode: col,
    normalNode: transformNormalToView(nrm),
    roughnessNode: rough,
    worldNormalNode: nrm,
    surfaceDebugNode: surfDbg,
  };
}
