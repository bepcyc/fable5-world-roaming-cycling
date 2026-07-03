/**
 * BikeSolver — the M1.3 power→speed integrator core. PURE: no engine, no
 * DOM, no time sources — probes run it headless in node at any dt and the
 * live BikeRig steps it at the engine's fixed timestep. All surface truth
 * comes from SurfaceMatrix (Pillar D); all physics is natural (Pillar B):
 * real gravity, published rolling-resistance and drag figures, no fake
 * brakes — degraded surfaces slow the bike because their Crr is honest.
 *
 * Model (Wilson, "Bicycling Science" ch. 4–6; Martin et al. 1998):
 *   m·dv/dt = η·P/max(v, V_TORQUE) − m·g·(Crr·cosθ + sinθ)
 *             − ½·ρ·CdA·v² − F_brake
 * with θ = atan(grade). Semi-implicit Euler on v; the propulsion clamp
 * V_TORQUE caps standing-start torque (a real rider cannot deliver 250 W
 * at 0 m/s — pedal force limits torque, ≈ P/1.4 N here).
 *
 * Mode-level caps from the matrix are CONTROL behavior, not physics: when
 * v exceeds the surface's maxSpeed for the mode, the rider brakes toward
 * the cap at a grip-limited rate (nobody bombs singletrack at 60 km/h).
 */

import {
  MODE_LIMITS,
  surfaceDef,
  type ModeParams,
  type RideMode,
} from './SurfaceMatrix';

export type BikeMode = Exclude<RideMode, 'hike'>;

/** rider + bike + drivetrain figures (literature defaults; probes tune) */
export interface BikeSpec {
  /** rider + machine mass (kg) */
  massKg: number;
  /** drag area CdA (m²) for the typical riding position of the mode */
  cda: number;
  /** drivetrain efficiency 0..1 */
  eff: number;
}

export const BIKE_SPECS: Record<BikeMode, BikeSpec> = {
  // 75 kg rider; road 8 kg / hoods CdA (Martin et al. wind-tunnel ranges)
  road: { massKg: 83, cda: 0.32, eff: 0.976 },
  gravel: { massKg: 85, cda: 0.38, eff: 0.976 },
  mtb: { massKg: 88, cda: 0.44, eff: 0.97 },
};

export const G = 9.81; // m/s² — Pillar B, non-negotiable
export const RHO = 1.225; // kg/m³ sea-level air
const V_TORQUE = 1.4; // m/s — standing-start propulsion clamp
/** braking: μ = MU_BRAKE·grip; grip=1 (dry asphalt) ⇒ ~0.66 g full brake */
const MU_BRAKE = 0.66;
/** rider governor: fraction of full brake used to hold the surface cap */
const GOVERNOR_K = 0.6;
/** below this speed on a high-stall surface the wheels bog down (latch) */
const STALL_V = 0.55; // m/s
const STALL_RISK_MIN = 0.5;

export interface SolverState {
  /** ground speed along the route (m/s, ≥ 0) */
  v: number;
  /** latched: bogged down on a high-stall surface until it changes */
  stalled: boolean;
}

export interface SolverStep {
  /** rider power at the pedals (W, ≥ 0) */
  powerW: number;
  /** brake input 0..1 */
  brake: number;
  /** signed grade along travel (rise/run; + = climbing) */
  grade: number;
  /** surface under the wheels (SurfaceId — stamped map, fords read water) */
  surfaceId: number;
  mode: BikeMode;
  dt: number;
}

export interface SolverOut {
  v: number;
  stalled: boolean;
  /** surface/slope forbids this mode here (P4 slope-block, blocked cells) */
  blocked: boolean;
  /** net acceleration this step (m/s²) — HUD/debug */
  accel: number;
  /** surface params used (HUD shows status) */
  params: ModeParams;
}

/** one fixed step; PURE — same inputs ⇒ same outputs at any dt */
export function stepBike(state: SolverState, inp: SolverStep): SolverOut {
  const def = surfaceDef(inp.surfaceId);
  const p = def.modes[inp.mode];
  const spec = BIKE_SPECS[inp.mode];
  const limit = MODE_LIMITS[inp.mode];
  const m = spec.massKg;
  const theta = Math.atan(inp.grade);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  const blocked = p.status === 'blocked' || Math.abs(inp.grade) > limit.maxSlope;

  let v = state.v;
  let stalled = state.stalled;

  // stall latch: released only by leaving the surface (dismount & walk out)
  if (stalled && (p.stallRisk < STALL_RISK_MIN || p.status === 'allowed')) {
    stalled = false;
  }

  // propulsion is cut when blocked/stalled — the mode simply cannot ride here
  const drive = blocked || stalled ? 0 : (spec.eff * Math.max(inp.powerW, 0)) / Math.max(v, V_TORQUE);

  const rollDrag = m * G * (p.crr * cosT + sinT); // signed: + resists uphill
  const aero = 0.5 * RHO * spec.cda * v * v;

  // braking: rider input, the maxSpeed governor, and the blocked hard-stop
  const brakeMax = MU_BRAKE * p.grip * m * G * cosT;
  let brakeF = Math.min(Math.max(inp.brake, 0), 1) * brakeMax;
  if (blocked) brakeF = brakeMax; // forced dismount — stop at grip limit
  else if (v > p.maxSpeed) brakeF = Math.max(brakeF, GOVERNOR_K * brakeMax);

  const a = (drive - rollDrag - aero - brakeF) / m;
  v = v + a * inp.dt;
  // brakes hold on a climb: no rolling backwards (trackstand floor)
  if (v < 0) v = 0;

  // bog-down: crawling on a high-stall degraded surface latches to a stop
  if (!stalled && p.status === 'degraded' && p.stallRisk >= STALL_RISK_MIN && v < STALL_V) {
    // only latch when the rider is actually trying (or was moving) — a
    // clean coast-down to zero on firm ground must not read as a stall
    v = 0;
    stalled = true;
  }
  if (blocked) stalled = false; // blocked banner wins; no double report

  return { v, stalled, blocked, accel: a, params: p };
}

/**
 * Analytic steady-state speed for constant power on constant grade/surface
 * (cubic root via bisection) — P2's independent truth, also used by probes.
 */
export function steadyStateV(
  powerW: number,
  grade: number,
  surfaceId: number,
  mode: BikeMode,
): number {
  const def = surfaceDef(surfaceId);
  const p = def.modes[mode];
  const spec = BIKE_SPECS[mode];
  const theta = Math.atan(grade);
  const roll = spec.massKg * G * (p.crr * Math.cos(theta) + Math.sin(theta));
  const need = (v: number): number => (roll + 0.5 * RHO * spec.cda * v * v) * v;
  const target = spec.eff * powerW;
  if (need(p.maxSpeed) <= target) return p.maxSpeed; // governor caps it
  let lo = 0;
  let hi = p.maxSpeed;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (need(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
