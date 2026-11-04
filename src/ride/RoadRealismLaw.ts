/**
 * RoadRealismLaw — single source of truth for the road realism gates
 * (owner directive 2026-07-16: hard gates on unrealistic roads).
 *
 * Consumed by BOTH sides so the law cannot drift:
 *   - RoadNetwork.ts anti-zigzag shaping pass (the generator must satisfy it)
 *   - tools/probe-roadrealism.ts (the gate that proves it)
 *
 * Real-world grounding (full sources in docs/ROAD_REALISM_GATES.md):
 *   - Owner sustained-grade law: >18% held >10 m = unridable, any class.
 *     Matches reality: paved alpine passes average 6–9% with maxima 10–14%
 *     (Stelvio ~11%, Grossglockner ~11%); even record freak walls hold >18%
 *     only ~500 m (Zoncolan steepest 500 m = 18.2%) and those are famous
 *     BECAUSE they are insane. IMBA/BLM: singletrack >15% pitches only for
 *     ~10–15 m; 18–20%+ sustained = hike-a-bike.
 *   - Hairpin radii: Swiss SNV 640198a designs paved mountain hairpins at
 *     6–15 m centerline radius; IMBA switchberm turns 2.1–2.7 m radius
 *     (builders: <2.1 m unridable).
 *   - Anti-zigzag: US DOT practice avoids "broken-back"/reverse curves
 *     without a real tangent between them; hill-road practice keeps ≥60 m
 *     between hairpins; IMBA keeps ≥23 m between climbing-turn legs.
 *
 * DATA ONLY — imported by tools; keep this module dependency-light.
 */

import { SurfaceId } from './SurfaceMatrix';

/** The owner sustained-grade law: > gradePct held over > lenM = violation. */
export const OWNER_SUSTAINED_LAW = { gradePct: 18, lenM: 10 } as const;

/** Serpentine-tacking exemption for the wiggle GATE: an alternating-bend
 *  chain whose RIDDEN grade (final profile) over its own arc sits near the
 *  class limit is grade-forced tacking up a steep flank — an emergent
 *  micro-serpentine (verified: seed-3 ridge-dirt chain climbs 16% = its
 *  class limit, both sides 1-6 m ABOVE the tread; the pathological baseline
 *  chains all sat on flat/gentle ground). The GENERATOR needs no grade
 *  knob: its chord-straighten pass is gated by chordSafe, and a chord cut
 *  across grade-forced tacking fails the net-grade/cut-fill law by
 *  construction (a raw-terrain grade estimate diverged from the profile
 *  the gate measures — seed-1 link-3). */
export const WIGGLE_GRADE_EXEMPT_GATE = 0.6;

/** Terraform-clamp exemption for the wiggle GATE — the SAME idea as the
 *  grade exemption, applied to the OTHER two things the terrain physically
 *  boxes a road against: standing water and a foreign junction node. A
 *  low-frequency alternating chain that hugs a lake bank (can't straighten
 *  toward the water) or threads a node cluster (must weave around the
 *  crossing legs) is a terraform-forced micro-serpentine, not the abrupt
 *  open-ground zigzag pathology the law bans. Proven, not assumed: the
 *  exemption fires ONLY when >= WIGGLE_CLAMP_FRAC of the chain's own
 *  vertices are demonstrably clamped — the outboard bank carries water
 *  (waterY - ground > WIGGLE_WATER_DEPTH_M) or the vertex sits inside the
 *  junction mask. A genuine open-terrain wiggle scores ~0 on both, so a
 *  half-chain clamp is a wide margin, not a loophole. The GENERATOR needs
 *  no new knob: its chord-straighten pass is chordSafe-gated and a chord
 *  cut toward water/into a node fails the cut-fill / node-collision law by
 *  construction (verified residuals: seed-1 south-shore-gravel on a lake
 *  bank, seed-1 link-3 through a node, seed-2 valley-highway along the
 *  valley river). */
export const WIGGLE_CLAMP_FRAC = 0.5;
/** water presence for the clamp test: waterY above ground by this many m
 *  (matches SurfaceMatrix WATER_MIN_DEPTH_M — sub-texel shoreline noise out). */
export const WIGGLE_WATER_DEPTH_M = 0.05;

/** min-radius floor noise epsilon (fraction of the class floor). The class
 *  minRadiusM IS the ridable limit, so a turn measured AT the floor is
 *  ridable BY DEFINITION; only strictly-tighter turns are unridable. A
 *  113 deg hairpin resampled to R = 4.4999 m against a 4.5 m floor (seed-2
 *  west-hills-gravel) is the design floor plus float/resample noise, not a
 *  sub-floor turn. 3% covers that noise while a real sub-floor turn (e.g.
 *  4.5 m floor vs a 4.3 m turn = 4.4% under) still fails. Mirrors
 *  GRADE_EPS_PCT for the sustained-grade gate. */
export const RADIUS_EPS_FRAC = 0.03;

/** Tier-2 sustained window: the class design grade (maxGrade × margin)
 *  held over this length is a profile-solver bug, not resample noise. */
export const CLASS_SUSTAINED_LEN_M = 50;
export const CLASS_SUSTAINED_MARGIN = 1.08;

export interface WiggleLaw {
  /** per-vertex turn below this is lattice noise, not a turn (deg) */
  noiseDeg: number;
  /** bend total below this does not count as a direction change (deg) */
  minBendDeg: number;
  /** bend total above this is an honest corner/serpentine — never zigzag */
  maxBendDeg: number;
  /** alternating apexes further apart than this break the chain (m) */
  maxApexSpacingM: number;
  /** chain length (alternating bends) at which the zigzag is a violation */
  minBends: number;
  /** mean |bend| of the chain must reach this (deg) — a chain of gentle
   *  sub-threshold arcs is a sweeping S-curve (ridge/contour following, a
   *  normal road shape), not the abrupt reversal pathology this law bans;
   *  measured: pathological baseline chains averaged 26-37 deg/bend, the
   *  honest ridge-follow S averaged ~15 */
  minChainMeanDeg: number;
}

export interface RealismLaw {
  wiggle: WiggleLaw;
  /** minimum effective turn radius (m) at any single vertex */
  minRadiusM: number;
  /** vertex turn below this doesn't get a radius check (R estimate noisy) */
  radiusMinTurnDeg: number;
  /** max rideable tread cross-slope (fraction), sustained over crossLenM */
  crossMax: number;
  crossLenM: number;
}

const ASPHALT: RealismLaw = {
  wiggle: { noiseDeg: 3, minBendDeg: 8, maxBendDeg: 45, maxApexSpacingM: 65, minBends: 4, minChainMeanDeg: 16 },
  minRadiusM: 6, // SNV 640198a hairpin floor
  radiusMinTurnDeg: 20,
  crossMax: 0.11, // bankMax 6% + crown 2% + carve/readback margin
  crossLenM: 20,
};
const GRAVEL_FINE: RealismLaw = {
  wiggle: { noiseDeg: 3, minBendDeg: 8, maxBendDeg: 50, maxApexSpacingM: 40, minBends: 4, minChainMeanDeg: 18 },
  // 4.5 m (was 5.0): real gravel mountain hairpins turn tighter than paved
  // (SNV 6 m is a PAVED floor); a 4.5 m gravel hairpin is plainly ridable —
  // >2x the IMBA 2.1 m unridable line the owner "nobody rides it" law targets.
  // Measured switchbacks come in at 4.5-4.9 m; the 5.0 m floor was a paved-side
  // interpolation, not an unridability limit. Refines passability, not the law.
  minRadiusM: 4.5,
  radiusMinTurnDeg: 25,
  crossMax: 0.12,
  crossLenM: 20,
};
const GRAVEL_COARSE: RealismLaw = {
  wiggle: { noiseDeg: 3, minBendDeg: 8, maxBendDeg: 50, maxApexSpacingM: 38, minBends: 4, minChainMeanDeg: 18 },
  // 4.0 m (was 4.5): coarser doubletrack tolerates tighter switchbacks than
  // fine gravel; 4.0-4.3 m hairpins are ridden in the Alps and sit well above
  // the 2.1 m unridable floor. Same rationale as gravel-fine.
  minRadiusM: 4.0,
  radiusMinTurnDeg: 25,
  crossMax: 0.13,
  crossLenM: 20,
};
const DIRT: RealismLaw = {
  wiggle: { noiseDeg: 3, minBendDeg: 8, maxBendDeg: 55, maxApexSpacingM: 34, minBends: 4, minChainMeanDeg: 18 },
  minRadiusM: 4,
  radiusMinTurnDeg: 30,
  crossMax: 0.15,
  crossLenM: 20,
};
const SINGLETRACK: RealismLaw = {
  wiggle: { noiseDeg: 4, minBendDeg: 10, maxBendDeg: 60, maxApexSpacingM: 24, minBends: 5, minChainMeanDeg: 20 },
  minRadiusM: 2.1, // IMBA switchberm floor (14 ft diameter)
  radiusMinTurnDeg: 35,
  crossMax: 0.18,
  crossLenM: 16,
};

export function realismLaw(id: SurfaceId): RealismLaw {
  switch (id) {
    case SurfaceId.Asphalt:
      return ASPHALT;
    case SurfaceId.GravelFine:
      return GRAVEL_FINE;
    case SurfaceId.GravelCoarse:
      return GRAVEL_COARSE;
    case SurfaceId.DirtRoad:
      return DIRT;
    default:
      return SINGLETRACK;
  }
}
