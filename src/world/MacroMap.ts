/**
 * Macro terrain layout — the art-directed bones of the world, seed-jittered.
 *
 * Geography (per STATUS.md D3, serving the reference frames):
 *  - NE: serrated alpine massif (Witcher vista), ridges anisotropic NE–SW
 *  - a glacial U-valley descending NE→SW into a lake basin (SW corner)
 *  - center-S: karst tower plateau (scene1/3) with a tributary stream ravine
 *    cutting through it — tower cliffs form the ravine walls
 *  - elsewhere: rolling forested hills and meadows
 *
 * All functions are TSL graph builders of world-position (meters, origin at
 * world center) so the same math drives the 4096² bake, the analytic far
 * shell, and any later pass needing macro masks. Seed jitter is applied
 * JS-side (plain numbers baked into the graph) for determinism.
 */

import {
  abs,
  clamp,
  float,
  max,
  min,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_float,
  pow,
  saturate,
  smoothstep,
  vec2,
} from 'three/tsl';
import type { Rng, WorldSeed } from '../core/Seed';
import type { NF, NV2 } from '../gpu/TSLTypes';
import { KARST_PLATEAU, LAKE_LEVEL, WORLD_HALF } from './WorldConst';

export interface MacroParams {
  alpC: [number, number];
  alpR: number;
  lakeC: [number, number];
  lakeR: number;
  karstC: [number, number];
  karstR: number;
  karstRot: number;
  /** main valley polyline NE→SW with floor elevations at each vertex */
  valley: [number, number][];
  valleyFloors: number[];
  valleyWidth: number;
  /** tributary ravine through the karst zone joining the main valley */
  trib: [number, number][];
  tribFloors: number[];
  tribWidth: number;
  /** noise domain offsets (decorrelate fields per seed) */
  off: Record<
    'warp' | 'ridge' | 'hills' | 'karst' | 'detail' | 'hard' | 'far' | 'far2' | 'far3',
    [number, number]
  >;
  /**
   * П.8 tilted strata ledge-beds (ref-05): massif-global bedding orientation.
   * dip = unit XZ direction the beds descend toward (strike ⊥ to it, along
   * the NE–SW ridgelines); tilt = dip angle from horizontal (rad); period =
   * bed thickness measured along the bedding-plane normal (m). Shared by the
   * height synthesis (geometric ledges) and TerrainMaterial (color banding)
   * so the paint lands on the slabs.
   */
  strataDip: [number, number];
  strataTilt: number;
  strataPeriod: number;
}

function jit(rng: Rng, base: [number, number], amount: number): [number, number] {
  return [base[0] + rng.range(-amount, amount), base[1] + rng.range(-amount, amount)];
}

export function makeMacroParams(seed: WorldSeed): MacroParams {
  // separate streams per component: adding draws to one never re-rolls others
  const rngAnchor = seed.rng('macro-anchors');
  const rngValley = seed.rng('macro-valley');
  const rngTrib = seed.rng('macro-trib');
  const rngOff = seed.rng('macro-offsets');
  const rngStrata = seed.rng('macro-strata');
  const lakeC = jit(rngAnchor, [-1380, 1290], 130);
  const off = (): [number, number] => [rngOff.range(-500, 500), rngOff.range(-500, 500)];
  // the spline continues THROUGH the lake to the map edge: the lake needs an
  // outlet river or it becomes a closed basin and floods the valley to its
  // spill saddle (discovered the hard way)
  const valley: [number, number][] = [
    jit(rngValley, [1520, -1530], 90),
    jit(rngValley, [830, -770], 150),
    jit(rngValley, [70, -70], 170),
    jit(rngValley, [-630, 520], 150),
    jit(rngValley, [-1120, 1000], 110),
    lakeC,
    jit(rngValley, [-1840, 1700], 90),
    [-2200, 2040],
  ];
  const karstC = jit(rngAnchor, [640, 660], 140);
  // tributary: from deep in the karst zone NW-ward to join the main valley
  const trib: [number, number][] = [
    jit(rngTrib, [karstC[0] + 360, karstC[1] + 290], 80),
    jit(rngTrib, [karstC[0] - 40, karstC[1] - 60], 90),
    jit(rngTrib, [karstC[0] - 420, karstC[1] - 330], 90),
    valley[3] as [number, number],
  ];
  return {
    alpC: jit(rngAnchor, [1460, -1470], 150),
    alpR: 1820 + rngAnchor.range(-120, 120),
    lakeC,
    lakeR: 600 + rngAnchor.range(-60, 60),
    karstC,
    karstR: 900 + rngAnchor.range(-80, 80),
    karstRot: 0.35 + rngAnchor.range(-0.25, 0.25),
    valley,
    // lake sill ≈ 141 at the rim, outlet descends off-map
    valleyFloors: [690, 468, 300, 212, 172, 141, 133, 120],
    valleyWidth: 360,
    trib,
    tribFloors: [318, 286, 246, 213],
    tribWidth: 150,
    // beds strike along the NE–SW ridgelines (domain dir (1,1)/√2), so the
    // dip azimuth is the perpendicular (1,−1)/√2 ± jitter; 12–20° from
    // horizontal, 30–48 m thick beds
    strataDip: (() => {
      const az = -Math.PI / 4 + rngStrata.range(-0.3, 0.3);
      return [Math.cos(az), Math.sin(az)] as [number, number];
    })(),
    strataTilt: 0.21 + rngStrata.range(0, 0.14),
    strataPeriod: 58 + rngStrata.range(-10, 14),
    off: {
      warp: off(),
      ridge: off(),
      hills: off(),
      karst: off(),
      detail: off(),
      hard: off(),
      // far/far2/far3 drawn LAST in the rngOff stream: adding the two outer
      // bands (П.6) must not re-roll any earlier offset for a given seed
      far: off(),
      far2: off(),
      far3: off(),
    },
  };
}

/** smooth 1→0 radial falloff */
function falloff(d: NF, r: number): NF {
  return smoothstep(r, r * 0.25, d);
}

/** distance from p to segment ab, plus the segment-local parameter t */
function segDist(p: NV2, a: [number, number], b: [number, number]): { d: NF; t: NF } {
  const av = vec2(a[0], a[1]);
  const ab = vec2(b[0] - a[0], b[1] - a[1]);
  const len2 = ab.dot(ab);
  const t = saturate(p.sub(av).dot(ab).div(len2));
  const d = p.sub(av.add(ab.mul(t))).length();
  return { d, t };
}

interface SplineField {
  /** warped distance to the polyline */
  dist: NF;
  /** floor elevation at the nearest point (interpolated along the spline) */
  floor: NF;
}

/**
 * Distance + interpolated floor elevation for a carving spline.
 * Pure expression folding: keeps (best distance, floor at best) via select().
 */
function splineField(p: NV2, pts: [number, number][], floors: number[]): SplineField {
  let bestD: NF = float(1e9);
  let bestF: NF = float(floors[0] ?? 0);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as [number, number];
    const b = pts[i + 1] as [number, number];
    const f0 = floors[i] ?? 0;
    const f1 = floors[i + 1] ?? 0;
    const { d, t } = segDist(p, a, b);
    const f = t.mul(f1 - f0).add(f0);
    const closer = d.lessThan(bestD);
    bestF = closer.select(f, bestF);
    bestD = min(bestD, d);
  }
  return { dist: bestD, floor: bestF };
}

export interface ValleyFields {
  valleyDist: NF;
  valleyFloor: NF;
  tribDist: NF;
  tribFloor: NF;
}

/** Just the carving-spline fields (shared by macroTerrain and the river pass). */
export function valleyFields(p: NV2, mp: MacroParams): ValleyFields {
  const o = mp.off;
  const vWarpV = vec2(
    mx_noise_float(p.div(290).add(vec2(o.warp[0], o.warp[1]))),
    mx_noise_float(p.div(290).add(vec2(o.warp[1] + 53, o.warp[0] - 53))),
  ).mul(85);
  // fine meander octave: spline segments are straight lines — without this
  // the carved trenches read as long ruler-straight scars (user-flagged)
  const vWarpF = vec2(
    mx_noise_float(p.div(61).add(vec2(o.warp[0] + 211, o.warp[1] - 97))),
    mx_noise_float(p.div(61).add(vec2(o.warp[1] - 131, o.warp[0] + 173))),
  ).mul(16);
  const pWarped = p.add(vWarpV).add(vWarpF);
  const valley = splineField(pWarped, mp.valley, mp.valleyFloors);
  const trib = splineField(pWarped, mp.trib, mp.tribFloors);
  return {
    valleyDist: valley.dist,
    valleyFloor: valley.floor,
    tribDist: trib.dist,
    tribFloor: trib.floor,
  };
}

export interface ZoneMasks {
  tAlp: NF;
  tKarst: NF;
  tLake: NF;
}

/** Just the zone falloffs (cheap subset for classification/material passes). */
export function zoneMasks(p: NV2, mp: MacroParams): ZoneMasks {
  const o = mp.off;
  const dAlp = p.sub(vec2(mp.alpC[0], mp.alpC[1])).length();
  const tAlp = pow(falloff(dAlp, mp.alpR), 1.2);
  const dLake = p.sub(vec2(mp.lakeC[0], mp.lakeC[1])).length();
  const tLake = falloff(dLake, mp.lakeR);
  const kw = vec2(
    mx_noise_float(p.div(430).add(vec2(o.karst[0], o.karst[1]))),
    mx_noise_float(p.div(430).add(vec2(o.karst[1], o.karst[0]))),
  ).mul(190);
  const pk = p.add(kw);
  const ca = Math.cos(mp.karstRot);
  const sa = Math.sin(mp.karstRot);
  const pkr = vec2(
    pk.x.sub(mp.karstC[0]).mul(ca).sub(pk.y.sub(mp.karstC[1]).mul(sa)).div(1.3),
    pk.x.sub(mp.karstC[0]).mul(sa).add(pk.y.sub(mp.karstC[1]).mul(ca)).mul(1.15),
  );
  const tKarst = falloff(pkr.length(), mp.karstR);
  return { tAlp, tKarst, tLake };
}

export interface MacroNodes {
  /** pre-erosion terrain height (m) */
  height: NF;
  /** alpine mass falloff 0..1 */
  tAlp: NF;
  /** karst zone falloff 0..1 */
  tKarst: NF;
  /** lake basin falloff 0..1 */
  tLake: NF;
  /** warped distance to main valley spline */
  valleyDist: NF;
  /** warped distance to tributary ravine spline */
  tribDist: NF;
  /** local valley floor elevation */
  valleyFloor: NF;
  /** rock hardness 0..1 (erosion resistance) */
  hardness: NF;
}

/**
 * Build the macro terrain graph at p (world meters).
 * `detail`: 'full' for the bake, 'far' for the analytic vista shell
 * (fewer octaves, no karst interior, adds outer mountain ranges).
 */
export function macroTerrain(p: NV2, mp: MacroParams, detail: 'full' | 'far'): MacroNodes {
  const full = detail === 'full';
  const o = mp.off;

  // --- zone masks (shared with classification passes) ------------------------
  const { tAlp, tKarst, tLake } = zoneMasks(p, mp);
  // karst-warped domain (towers reuse this)
  const kw = vec2(
    mx_noise_float(p.div(430).add(vec2(o.karst[0], o.karst[1]))),
    mx_noise_float(p.div(430).add(vec2(o.karst[1], o.karst[0]))),
  ).mul(190);
  const pk = p.add(kw);

  // --- valley + tributary splines (position-warped; see valleyFields) --------
  const vf = valleyFields(p, mp);
  const valleyDist = vf.valleyDist;
  const tribDist = vf.tribDist;

  // --- base + hills ----------------------------------------------------------
  // NOTE mx_noise/mx_fractal outputs are SIGNED (≈[-1,1]) — remap explicitly.
  const hillsRaw = mx_fractal_noise_float(
    p.div(1350).add(vec2(o.hills[0], o.hills[1])),
    full ? 5 : 4,
    2.1,
    0.52,
    1,
  )
    .mul(0.5)
    .add(0.5)
    .saturate();
  // compress the lows (1−(1−n)^1.7): dales stay shallow → terrain drains
  // instead of pooling in deep fBm bowls
  const hillsN = hillsRaw.oneMinus().pow(1.7).oneMinus();
  const hillsMask = tAlp.oneMinus().mul(tKarst.mul(0.72).oneMinus());
  const base = float(192)
    .add(hillsN.mul(135).mul(hillsMask))
    .add(float(KARST_PLATEAU - 192).mul(tKarst))
    .sub(tLake.pow(1.5).mul(110));

  // --- alpine ridges (anisotropic, serrated) ---------------------------------
  // rotate domain 45° and squash so ridgelines align NE–SW like a real range
  const ridgeAt = (pw: NV2, oct: number): NF => {
    const pr = vec2(
      pw.x.add(pw.y).mul(0.7071),
      pw.y.sub(pw.x).mul(0.7071 * 1.65),
    )
      .div(2100)
      .add(vec2(o.ridge[0], o.ridge[1]).div(1000));
    let r: NF = float(0);
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < oct; i++) {
      const n = abs(mx_noise_float(pr.mul(freq).add(i * 7.31))).oneMinus();
      r = r.add(n.mul(n).mul(amp));
      norm += amp;
      amp *= 0.52;
      freq *= 2.13;
    }
    return r.div(norm);
  };
  const ridgeOct = full ? 7 : 5;
  const ridge = ridgeAt(p, ridgeOct);
  const mountains = tAlp.mul(ridge.pow(1.5).mul(1380).add(tAlp.mul(470)));

  // --- П.8 tilted strata ledge-beds (ref-05) ----------------------------------
  // The reference massif is NOT a triangular saw: diagonal bedding planes
  // protrude through the green cover as stacked slabs with grassy shelves
  // between them. Step the steep alpine flanks along a massif-global TILTED
  // bedding axis (true plane family: h·cosθ + dip·sinθ), warped so the bands
  // fragment instead of wrapping the massif as clean contour rings. Runs
  // BEFORE erosion (amplitude at the top of the ≤6 m budget — erosion softens
  // the treads) and feeds hardness below so slab crests resist washing.
  const dipDir = vec2(mp.strataDip[0], mp.strataDip[1]);
  const dipOff = p.sub(vec2(mp.alpC[0], mp.alpC[1])).dot(dipDir);
  // slope proxy of the ridge mass (coarse octaves, finite differences):
  // ledges live on steep faces only — valley floors, roads-to-be and the
  // lake basin sit where this gate is ~0, so the world barely moves there
  const slopeOct = full ? 4 : 3;
  const eL = 26;
  const mAt = (r: NF): NF => r.pow(1.5).mul(1380);
  const m0 = mAt(ridgeAt(p, slopeOct));
  const mX = mAt(ridgeAt(p.add(vec2(eL, 0)), slopeOct));
  const mZ = mAt(ridgeAt(p.add(vec2(0, eL)), slopeOct));
  const slopeProxy = vec2(mX.sub(m0), mZ.sub(m0)).length().div(eL).mul(tAlp);
  const ledgeGate = smoothstep(0.5, 0.85, slopeProxy).mul(smoothstep(0.22, 0.5, tAlp));
  const sWarp = mx_noise_float(p.div(170).add(vec2(o.hard[0] + 7.7, o.hard[1] - 3.3))).mul(0.55);
  const sPhase = base
    .add(mountains)
    .mul(Math.cos(mp.strataTilt))
    .add(dipOff.mul(Math.sin(mp.strataTilt)))
    .div(mp.strataPeriod)
    .add(sWarp);
  const bandI = sPhase.floor();
  const bandF = sPhase.fract();
  // per-band amplitude (layer-cake irregularity — mirrors RockBuilder bandAmp)
  const bandAmp = mx_noise_float(
    vec2(bandI.mul(0.618).add(o.ridge[1]), bandI.mul(0.343).add(o.ridge[0])),
  )
    .mul(0.45)
    .add(0.95); // ≈0.5..1.4
  // ledge profile: quick rise, slow fall (protruding slab edge → back shelf),
  // recentered so the massif keeps its mean height. Range ≈ [−0.42, +0.43].
  const ledgeProf = min(bandF.mul(4.2), 1).sub(bandF.mul(0.62)).sub(0.42);
  const ledge = ledgeProf.mul(6.0).mul(bandAmp).mul(ledgeGate);

  // --- karst towers (full detail only — far shell sees plateau mass) ---------
  let towers: NF = float(0);
  if (full) {
    // two worley scales + wall-line wobble kill the repeating-scallop read
    const f1a = mx_worley_noise_float(pk.div(80), 1.0);
    const f1b = mx_worley_noise_float(pk.div(133).add(31.7), 1.0);
    const wallNoise = mx_noise_float(pk.div(9.5)).mul(0.05);
    const f1 = min(f1a, f1b.add(0.12)).add(wallNoise);
    // plateau cores high, narrow near-vertical walls; F1 small near cell centers
    const towerMask = smoothstep(0.46, 0.31, f1);
    const towerHNoise = mx_noise_float(p.div(310).add(vec2(o.karst[0] + 99, o.karst[1] - 99)))
      .mul(0.5)
      .add(0.5);
    const towerH = towerHNoise.mul(80).add(78);
    // keep the tributary ravine open: towers fade within ~130 m of the stream,
    // so tower cliffs become the ravine walls
    const ravineKeep = smoothstep(55, 150, tribDist);
    towers = towerMask.mul(towerH).mul(tKarst.pow(0.8)).mul(ravineKeep);
    // shallow winding gullies between towers
    const gully = pow(saturate(abs(mx_noise_float(pk.div(210))).mul(2.2).oneMinus()), 3);
    towers = towers.sub(gully.mul(26).mul(tKarst).mul(towerMask.oneMinus()));
  }

  // --- pre-valley height ------------------------------------------------------
  const detailN = full
    ? mx_fractal_noise_float(p.div(62).add(vec2(o.detail[0], o.detail[1])), 4, 2.05, 0.5, 1).mul(7)
    : float(0);
  let h: NF = base.add(mountains).add(towers).add(detailN).add(ledge);

  // --- far shell: outer ranges beyond the world edge --------------------------
  if (!full) {
    // П.6 (ref-04): THREE independent ridge bands at increasing radii, each
    // with its own frequency/phase/gaps, and each farther band ~25% TALLER
    // than the one before — so the distant crest lines peek over the nearer
    // ones and new silhouette layers "appear" as the camera climbs.
    // Chebyshev radius keeps the bands parallel to the (square) world edge.
    const r = max(abs(p.x), abs(p.y));
    /** radial envelope: rise r0→r1, plateau, fall r2→r3 */
    const env = (r0: number, r1: number, r2: number, r3: number): NF =>
      smoothstep(r0, r1, r).mul(smoothstep(r3, r2, r));
    /** one ridged range: fBm ridges × gaps (broken wall) × slow crest swell */
    const ridgeBand = (
      band: NF,
      off: [number, number],
      scale: number,
      octaves: number,
      amp: number,
      gapPeriod: number,
      gapPhase: number,
    ): NF => {
      const pf = p.div(scale).add(vec2(off[0], off[1]));
      let outer: NF = float(0);
      let a = 0.5;
      let freq = 1;
      let norm = 0;
      for (let i = 0; i < octaves; i++) {
        const n = abs(mx_noise_float(pf.mul(freq).add(i * 3.7))).oneMinus();
        outer = outer.add(n.mul(n).mul(a));
        norm += a;
        a *= 0.5;
        freq *= 2.1;
      }
      outer = outer.div(norm);
      // gaps: the range breaks into separate massifs, not a continuous wall
      const gaps = smoothstep(
        0.25,
        0.75,
        mx_noise_float(p.div(gapPeriod).add(gapPhase)).mul(0.5).add(0.5),
      );
      // longitudinal variation: slow crest swell along the range (≈0.75–1.15)
      const swell = mx_noise_float(p.div(gapPeriod * 1.9).add(gapPhase + 57.2))
        .mul(0.2)
        .add(0.95);
      return outer.pow(1.5).mul(amp).mul(band).mul(gaps).mul(swell);
    };
    // foothills just past the edge / middle range / horizon wall
    const bandA = ridgeBand(
      env(WORLD_HALF + 600, 4400, 5800, 7400),
      o.far,
      2200,
      5,
      950,
      3500,
      17.3,
    );
    const bandB = ridgeBand(env(5600, 7600, 9400, 11400), o.far2, 2900, 4, 1550, 4400, 63.1);
    const bandC = ridgeBand(env(9400, 11200, 12600, 13800), o.far3, 3700, 4, 2320, 5400, 41.7);
    // rim fade on the EUCLIDEAN radius: the shell ring is circular (outer
    // radius FAR_RADIUS) while the band envelopes are Chebyshev — on the
    // diagonals a band would otherwise get sliced off as a cliff at the rim
    const rim = smoothstep(13900, 12900, p.length());
    // max(), not sum: in the overlap zones two ranges keep two distinct
    // silhouettes instead of merging into one additive hump
    h = h.add(max(bandA, max(bandB, bandC)).mul(rim));
  }

  // gentle monotonic tilt toward the valley spine so hill country drains
  // (drainage-by-design: post-hoc erosion cannot carve 30 m through saddles)
  h = h.add(min(valleyDist.mul(0.06), 95).mul(tAlp.oneMinus()).mul(tKarst.oneMinus()));

  // --- carve valley + tributary (U-profiles down to interpolated floors) ------
  // outer U-shape plus a narrower inner trench so the floor isn't an airstrip
  const uMain = pow(smoothstep(0, mp.valleyWidth, valleyDist), 2.2);
  h = vf.valleyFloor.add(h.sub(vf.valleyFloor).mul(uMain));
  // inner trench concentrates the river (floors are tuned so its bottom stays
  // above lake level until the mouth); the trench fades across the lake so the
  // outlet sill stays at the designed lake level
  const trench = smoothstep(120, 18, valleyDist)
    .mul(16)
    .mul(smoothstep(0.5, 0.12, tLake));
  h = h.sub(trench);
  if (full) {
    const uTrib = pow(smoothstep(0, mp.tribWidth, tribDist), 1.6);
    const tribInfl = tKarst.pow(0.5); // tributary only carves inside/near karst
    const carved = vf.tribFloor.add(h.sub(vf.tribFloor).mul(uTrib));
    h = carved.mul(tribInfl).add(h.mul(tribInfl.oneMinus()));
  }

  // keep the lake basin genuinely below lake level (tight to the basin core)
  const lakeBed = float(LAKE_LEVEL - 13);
  h = h.sub(max(0, h.sub(lakeBed)).mul(tLake.pow(3.4).mul(0.95)));

  // --- hardness (erosion resistance + later: strata/talus behavior) -----------
  const strata = mx_noise_float(
    vec2(h.mul(0.016), mx_noise_float(p.div(900)).mul(2)).add(vec2(o.hard[0], o.hard[1])),
  )
    .mul(0.5)
    .add(0.5);
  const hardness = clamp(
    float(0.34)
      .add(strata.mul(0.36))
      .add(tKarst.mul(0.28))
      .add(tAlp.mul(0.18))
      // П.8: slab crests are the resistant beds — harder so erosion carves
      // the shelves between them instead of washing the steps flat
      .add(ledgeGate.mul(ledgeProf.add(0.42)).mul(0.28))
      .sub(tLake.mul(0.2)),
    0.08,
    0.97,
  );

  return {
    height: h,
    tAlp,
    tKarst,
    tLake,
    valleyDist,
    tribDist,
    valleyFloor: vf.valleyFloor,
    hardness,
  };
}
