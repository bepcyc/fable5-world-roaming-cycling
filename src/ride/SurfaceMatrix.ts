/**
 * SurfaceMatrix — THE one-file surface × mode truth (RANDO brief, Pillar D).
 *
 * Every surface/mode constant lives HERE: physics (M1.3 solver), HUD
 * warnings (P5), audio (M1.7), and the road generator (M1.2 tags) import
 * from this file and nowhere else. One import site per consuming system.
 *
 * DATA ONLY — no engine imports, no logic beyond tiny pure lookups.
 *
 * Units are SI and natural (Pillar B): speeds m/s, slopes rise/run,
 * Crr dimensionless. Crr values follow published rolling-resistance
 * measurements (bicyclerollingresistance.com ranges, Wilson "Bicycling
 * Science" ch. 6): asphalt 0.004–0.008, packed gravel ~0.008–0.015,
 * dirt/single ~0.015–0.025, meadow grass 0.03–0.08, mud/snow 0.1–0.3.
 * They are STARTING points — M1.3 probes (P1–P4) tune against tolerances,
 * never against feel.
 */

/** discrete surface classes — ids are STORED in the surface map (u8) */
export const enum SurfaceId {
  // natural terrain (M1.1 classifier output)
  Grass = 0, // meadow sward (the splat's grass class)
  Forest = 1, // forest floor: litter, moss, roots
  Soil = 2, // bare soil / packed earth (splat base class)
  Scree = 3, // loose talus slopes
  Rock = 4, // exposed rock faces / slabs
  GravelRiver = 5, // river-channel gravel & cobbles (splat's riverW class)
  Mud = 6, // wetland margins, soaked silt (pond beds, sedge flats)
  Snow = 7, // snow cover (classification field, not the dithered edge)
  WaterShallow = 8, // fordable water (see WATER thresholds below)
  WaterDeep = 9, // deep water — blocks everything (hike included)
  // road network classes (M1.2 stamps these over the natural map)
  Asphalt = 10,
  GravelFine = 11, // packed fine gravel (rideable on a road bike)
  GravelCoarse = 12, // loose coarse gravel
  DirtRoad = 13, // graded dirt / doubletrack
  Singletrack = 14,
  COUNT = 15,
}

export const SURFACE_NAMES: readonly string[] = [
  'grass',
  'forest',
  'soil',
  'scree',
  'rock',
  'gravel-river',
  'mud',
  'snow',
  'water-shallow',
  'water-deep',
  'asphalt',
  'gravel-fine',
  'gravel-coarse',
  'dirt-road',
  'singletrack',
];

export type RideMode = 'hike' | 'road' | 'gravel' | 'mtb';

/**
 * allowed  — normal traversal at the surface's own params
 * degraded — traversable but punished (high Crr / low caps / stall risk);
 *            the M1.3 solver lets bad Crr+caps grind you to a stop (P1)
 * blocked  — mode cannot enter; HUD warns ahead of the boundary (P5)
 */
export type SurfaceStatus = 'allowed' | 'degraded' | 'blocked';

export interface ModeParams {
  status: SurfaceStatus;
  /** rolling-resistance coefficient (dimensionless; hike: effort analog) */
  crr: number;
  /** hard surface speed cap for this mode (m/s) — control/safety, not aero */
  maxSpeed: number;
  /** braking/cornering traction 0..1 (1 = dry asphalt) */
  grip: number;
  /** 0..1 tendency to bog down / wash out on this surface */
  stallRisk: number;
}

export interface SurfaceDef {
  id: SurfaceId;
  name: string;
  /** audio bank key (M1.7) */
  soundId: string;
  /** 0..1 how strongly rain/wetness degrades crr+grip (M1.6/M3.1 modifier) */
  weatherSensitivity: number;
  modes: Record<RideMode, ModeParams>;
}

/** shorthand row builder — keeps the table below readable */
const m = (
  status: SurfaceStatus,
  crr: number,
  maxSpeed: number,
  grip: number,
  stallRisk: number,
): ModeParams => ({ status, crr, maxSpeed, grip, stallRisk });

/** a blocked cell: params are the "if forced there anyway" fallback */
const BLOCKED = m('blocked', 0.5, 0, 0.2, 1);

/**
 * The matrix. Movement-model law (brief):
 *   hike   — goes almost anywhere; mud/water/steepness slow it; deep water blocks
 *   road   — asphalt + fine gravel only; anything worse degrades fast toward a stop
 *   gravel — asphalt→dirt; limited mud; fords shallow streams
 *   mtb    — best off-road; blocked by deep water/extreme slopes; deep mud ~stalls
 * Hike maxSpeed = natural walking/scramble pace on that footing (sprint is a
 * mode-level multiplier in M1.3, not surface data). Bike degraded rows carry
 * honest Crr so the natural solver produces the slowdown (no fake brakes).
 */
export const SURFACE_MATRIX: readonly SurfaceDef[] = [
  {
    id: SurfaceId.Grass,
    name: SURFACE_NAMES[SurfaceId.Grass] as string,
    soundId: 'sfc-grass',
    weatherSensitivity: 0.7,
    modes: {
      hike: m('allowed', 0.05, 1.7, 0.8, 0.05),
      road: m('degraded', 0.055, 4.5, 0.5, 0.35),
      gravel: m('degraded', 0.038, 6, 0.55, 0.2),
      mtb: m('degraded', 0.028, 7, 0.6, 0.12),
    },
  },
  {
    id: SurfaceId.Forest,
    name: SURFACE_NAMES[SurfaceId.Forest] as string,
    soundId: 'sfc-forest',
    weatherSensitivity: 0.7,
    modes: {
      hike: m('allowed', 0.06, 1.5, 0.75, 0.08),
      road: BLOCKED,
      gravel: m('degraded', 0.045, 4, 0.5, 0.3),
      mtb: m('degraded', 0.03, 5.5, 0.55, 0.18),
    },
  },
  {
    id: SurfaceId.Soil,
    name: SURFACE_NAMES[SurfaceId.Soil] as string,
    soundId: 'sfc-soil',
    weatherSensitivity: 0.8,
    modes: {
      hike: m('allowed', 0.045, 1.7, 0.8, 0.04),
      road: m('degraded', 0.03, 6, 0.6, 0.25),
      gravel: m('degraded', 0.02, 8, 0.65, 0.12),
      mtb: m('degraded', 0.016, 9, 0.7, 0.08),
    },
  },
  {
    id: SurfaceId.Scree,
    name: SURFACE_NAMES[SurfaceId.Scree] as string,
    soundId: 'sfc-scree',
    weatherSensitivity: 0.3,
    modes: {
      hike: m('degraded', 0.12, 0.7, 0.45, 0.4),
      road: BLOCKED,
      gravel: BLOCKED,
      mtb: m('degraded', 0.06, 2.5, 0.35, 0.6),
    },
  },
  {
    id: SurfaceId.Rock,
    name: SURFACE_NAMES[SurfaceId.Rock] as string,
    soundId: 'sfc-rock',
    weatherSensitivity: 0.5,
    modes: {
      hike: m('degraded', 0.07, 0.9, 0.85, 0.15),
      road: BLOCKED,
      gravel: BLOCKED,
      mtb: m('degraded', 0.015, 4, 0.75, 0.3),
    },
  },
  {
    id: SurfaceId.GravelRiver,
    name: SURFACE_NAMES[SurfaceId.GravelRiver] as string,
    soundId: 'sfc-gravel-river',
    weatherSensitivity: 0.4,
    modes: {
      hike: m('degraded', 0.08, 1.1, 0.6, 0.2),
      road: BLOCKED,
      gravel: m('degraded', 0.03, 3.5, 0.45, 0.35),
      mtb: m('degraded', 0.025, 4.5, 0.5, 0.25),
    },
  },
  {
    id: SurfaceId.Mud,
    name: SURFACE_NAMES[SurfaceId.Mud] as string,
    soundId: 'sfc-mud',
    weatherSensitivity: 1,
    modes: {
      // P1 mud-stop: the road bike ENTERS (degraded, not blocked) and the
      // honest Crr + solver decelerate it to a stop within tolerance
      hike: m('degraded', 0.13, 0.8, 0.4, 0.45),
      road: m('degraded', 0.28, 2, 0.25, 0.9),
      gravel: m('degraded', 0.12, 3, 0.3, 0.6),
      mtb: m('degraded', 0.09, 3.5, 0.35, 0.5),
    },
  },
  {
    id: SurfaceId.Snow,
    name: SURFACE_NAMES[SurfaceId.Snow] as string,
    soundId: 'sfc-snow',
    weatherSensitivity: 0.6,
    modes: {
      hike: m('degraded', 0.1, 0.9, 0.5, 0.3),
      road: BLOCKED,
      gravel: BLOCKED,
      mtb: m('degraded', 0.09, 3.5, 0.3, 0.55),
    },
  },
  {
    id: SurfaceId.WaterShallow,
    name: SURFACE_NAMES[SurfaceId.WaterShallow] as string,
    soundId: 'sfc-water-shallow',
    weatherSensitivity: 0,
    modes: {
      // P3 ford: gravel bike crosses ≤ FORD_MAX_DEPTH_M; deeper re-classifies
      // as WaterDeep, so these rows only ever see fordable depth
      hike: m('degraded', 0.1, 0.9, 0.55, 0.3),
      road: m('degraded', 0.14, 1.5, 0.4, 0.7),
      gravel: m('degraded', 0.09, 2.5, 0.45, 0.45),
      mtb: m('degraded', 0.08, 3, 0.5, 0.4),
    },
  },
  {
    id: SurfaceId.WaterDeep,
    name: SURFACE_NAMES[SurfaceId.WaterDeep] as string,
    soundId: 'sfc-water-deep',
    weatherSensitivity: 0,
    modes: { hike: BLOCKED, road: BLOCKED, gravel: BLOCKED, mtb: BLOCKED },
  },
  // ---- road network surfaces (M1.2 stamps them; params ready now) ---------
  {
    id: SurfaceId.Asphalt,
    name: SURFACE_NAMES[SurfaceId.Asphalt] as string,
    soundId: 'sfc-asphalt',
    weatherSensitivity: 0.3,
    modes: {
      hike: m('allowed', 0.03, 1.8, 1, 0),
      road: m('allowed', 0.004, 22, 1, 0),
      gravel: m('allowed', 0.005, 20, 1, 0),
      mtb: m('allowed', 0.0075, 16, 1, 0),
    },
  },
  {
    id: SurfaceId.GravelFine,
    name: SURFACE_NAMES[SurfaceId.GravelFine] as string,
    soundId: 'sfc-gravel-fine',
    weatherSensitivity: 0.4,
    modes: {
      hike: m('allowed', 0.035, 1.8, 0.9, 0.02),
      road: m('allowed', 0.008, 13, 0.75, 0.08),
      gravel: m('allowed', 0.0075, 14, 0.8, 0.05),
      mtb: m('allowed', 0.009, 13, 0.85, 0.03),
    },
  },
  {
    id: SurfaceId.GravelCoarse,
    name: SURFACE_NAMES[SurfaceId.GravelCoarse] as string,
    soundId: 'sfc-gravel-coarse',
    weatherSensitivity: 0.4,
    modes: {
      hike: m('allowed', 0.045, 1.6, 0.8, 0.05),
      road: m('degraded', 0.02, 7, 0.5, 0.3),
      gravel: m('allowed', 0.014, 11, 0.65, 0.12),
      mtb: m('allowed', 0.013, 11, 0.7, 0.08),
    },
  },
  {
    id: SurfaceId.DirtRoad,
    name: SURFACE_NAMES[SurfaceId.DirtRoad] as string,
    soundId: 'sfc-dirt',
    weatherSensitivity: 0.8,
    modes: {
      hike: m('allowed', 0.04, 1.7, 0.85, 0.03),
      road: m('degraded', 0.022, 8, 0.55, 0.25),
      gravel: m('allowed', 0.016, 10, 0.7, 0.1),
      mtb: m('allowed', 0.014, 11, 0.75, 0.06),
    },
  },
  {
    id: SurfaceId.Singletrack,
    name: SURFACE_NAMES[SurfaceId.Singletrack] as string,
    soundId: 'sfc-single',
    weatherSensitivity: 0.8,
    modes: {
      hike: m('allowed', 0.045, 1.6, 0.8, 0.04),
      road: BLOCKED,
      gravel: m('degraded', 0.022, 6, 0.55, 0.25),
      mtb: m('allowed', 0.017, 9, 0.7, 0.1),
    },
  },
];

/**
 * Per-mode traversability slope limits (rise/run) — the P4 slope-block
 * mechanic (technical impossibility, NOT power limits: the M1.3 solver
 * handles gradient power naturally). Hike passes what bikes cannot.
 */
export const MODE_LIMITS: Record<RideMode, { maxSlope: number }> = {
  hike: { maxSlope: 1.2 }, // ~50° scramble ceiling
  road: { maxSlope: 0.25 },
  gravel: { maxSlope: 0.35 },
  mtb: { maxSlope: 0.65 }, // ~33° — beyond this even MTB dismounts
};

/**
 * Classification thresholds (surface truth constants — Pillar D says they
 * live here, next to the classes they produce; the GPU classifier and any
 * CPU consumer import THESE, never re-declare).
 *
 * WATER_MIN_DEPTH_M: water presence = waterY − ground above this. 0.05 m
 * keeps sub-texel shoreline noise out (waterY is sim-res 2 m/texel vs the
 * 1 m height grid — the documented ≥0.25 m compare trap applies to EQUALITY
 * tests, not this one-sided presence test; transect probe validates).
 * FORD_MAX_DEPTH_M: shallow/deep split — brief fords are "≤ ~10 cm streams",
 * measured at sim-res smoothing; 0.45 m is knee depth, past it water reads
 * (and physically acts) deep. P3 tunes ford behavior INSIDE the shallow band.
 */
export const CLASSIFY = {
  WATER_MIN_DEPTH_M: 0.05,
  FORD_MAX_DEPTH_M: 0.45,
  /** wetland/pond-silt mud gate: splat pondK > this ⇒ Mud when not underwater */
  MUD_POND_K: 0.45,
  /** moisture above this on near-flat wetland biome ground ⇒ Mud */
  MUD_MOISTURE: 0.72,
  MUD_MAX_SLOPE: 0.35,
} as const;

/** lookup helpers (pure; the only logic this file carries) */
export function surfaceDef(id: number): SurfaceDef {
  return (SURFACE_MATRIX[id] ?? SURFACE_MATRIX[SurfaceId.Soil]) as SurfaceDef;
}

export function surfaceName(id: number): string {
  return SURFACE_NAMES[id] ?? `unknown-${id}`;
}
