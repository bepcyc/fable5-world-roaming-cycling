/**
 * Ride sensor layer — the seam between dashboards/physics and metric sources.
 *
 * RideHud (and later bike physics) consume RideSample through a SensorSource.
 * Real sources arrive in a later phase over Web Bluetooth (FTMS trainer,
 * cycling speed/cadence, heart rate 0x180D). DemoSensorSource fakes plausible
 * streams for development and demos and MUST stay labeled as demo wherever
 * its numbers appear — demo values never pose as real. Speed is deliberately
 * NOT part of this contract yet: the only real quantity today is rig ground
 * speed, which RideHud derives from the camera's logical pose itself.
 */

/** one dashboard-facing reading; null = this source has no such channel */
export interface RideSample {
  cadenceRpm: number | null;
  heartRateBpm: number | null;
  /** rider power at the pedals (W) — M1.3 physics consumes this; bike
   *  modes stay LOCKED without a source that provides it */
  powerW: number | null;
}

/** context a source may condition on (demo couples cadence/HR to motion) */
export interface SensorCtx {
  speedKmh: number;
  moving: boolean;
  /** mounted on a bike — the demo rider pedals whenever riding. Gating
   *  cadence on `moving` alone deadlocked standing starts: cadence waited
   *  for speed, speed waited for power, power waited for cadence — the
   *  owner's DEMO bike never left the spot */
  riding: boolean;
}

export interface SensorSource {
  /** 'demo' renders a DEMO badge; 'dev' the keyboard bike (?ridedev=1,
   *  DEV badge); 'ble' is the future real-sensor path (M1.4) */
  readonly kind: 'demo' | 'dev' | 'ble';
  update(dt: number, ctx: SensorCtx): void;
  read(): RideSample;
  /** optional back-channel: the rig reports live grade + surface Crr each
   *  fixed step; BLE trainers turn it into FTMS SIM-resistance writes
   *  (M1.4). Sources without physical resistance simply omit this. */
  setSimState?(gradeFrac: number, crr: number): void;
}

// ---- demo stream tuning -----------------------------------------------------
const CAD_BASE = 85; // rpm center while moving
const CAD_WANDER = 9; // rpm wander amplitude
const CAD_TAU_UP = 1.6; // s — spin-up toward target
const CAD_TAU_DOWN = 0.9; // s — decay when stopping
const HR_REST = 92; // bpm floor
const HR_SPAN = 68; // bpm added at full effort
const HR_TAU_UP = 25; // s — slow climb under effort
const HR_TAU_DOWN = 45; // s — slower recovery
const HR_NOISE = 1.5; // bpm of slow jitter
const WANDER_PERIOD = 7; // s per smooth wander segment
const FULL_EFFORT_KMH = 32; // effort saturates at this ground speed

/** deterministic PRNG (mulberry32) — demo streams replay identically */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plausible-but-fake cadence/HR: cadence spins toward ~85 rpm while moving
 * and decays to 0 at rest; HR climbs slowly with effort (speed) and recovers
 * slower, plus a little piecewise-smooth jitter. Deterministic by seed.
 */
export class DemoSensorSource implements SensorSource {
  readonly kind = 'demo' as const;
  private rand = mulberry32(0xc0ffee);
  private cad = 0;
  private hr = HR_REST;
  private wanderT = 0;
  private wanderFrom = 0;
  private wanderTo = 0;
  private jitterFrom = 0;
  private jitterTo = 0;

  update(dt: number, ctx: SensorCtx): void {
    // shared piecewise-smooth wander (new random target every WANDER_PERIOD)
    this.wanderT += dt / WANDER_PERIOD;
    if (this.wanderT >= 1) {
      this.wanderT %= 1;
      this.wanderFrom = this.wanderTo;
      this.wanderTo = this.rand() * 2 - 1;
      this.jitterFrom = this.jitterTo;
      this.jitterTo = this.rand() * 2 - 1;
    }
    const s = this.wanderT * this.wanderT * (3 - 2 * this.wanderT); // smoothstep
    const wander = this.wanderFrom + (this.wanderTo - this.wanderFrom) * s;
    const jitter = this.jitterFrom + (this.jitterTo - this.jitterFrom) * s;

    const cadTarget = ctx.riding || ctx.moving ? CAD_BASE + CAD_WANDER * wander : 0;
    const cadTau = cadTarget > this.cad ? CAD_TAU_UP : CAD_TAU_DOWN;
    this.cad += (cadTarget - this.cad) * (1 - Math.exp(-dt / cadTau));

    const effort = Math.min(ctx.speedKmh / FULL_EFFORT_KMH, 1);
    const hrTarget = HR_REST + HR_SPAN * effort + HR_NOISE * jitter;
    const hrTau = hrTarget > this.hr ? HR_TAU_UP : HR_TAU_DOWN;
    this.hr += (hrTarget - this.hr) * (1 - Math.exp(-dt / hrTau));
  }

  read(): RideSample {
    return {
      cadenceRpm: this.cad < 1 ? 0 : this.cad,
      heartRateBpm: this.hr,
      // demo power: plausible steady effort coupled to the same wander the
      // cadence uses — badged DEMO wherever it appears, never poses as real.
      // Floored at 0: while cadence spins up from a standstill the linear
      // coupling went NEGATIVE (owner saw −210 W on the dashboard)
      powerW:
        this.cad < 1
          ? 0
          : Math.max(0, DEMO_POWER_BASE + DEMO_POWER_WANDER * ((this.cad - CAD_BASE) / CAD_WANDER)),
    };
  }
}

const DEMO_POWER_BASE = 185; // W — steady endurance effort
const DEMO_POWER_WANDER = 45;

// ---- keyboard bike (?ridedev=1 — development builds only) -------------------
const DEV_POWER_DEFAULT = 220; // W target while W is held
const DEV_POWER_STEP = 20; // W per +/- press
const DEV_POWER_MIN = 40;
const DEV_POWER_MAX = 900;
const DEV_SPRINT_MULT = 1.7; // Shift burst
const DEV_RAMP_TAU = 0.35; // s — power ramps like legs, not a switch

/**
 * KeyboardPowerSource — the ?ridedev=1 seam implementation: hold W to pedal
 * at a target wattage (+/- tunes it, Shift bursts), release to coast. Power
 * is synthetic (DEV badge); cadence derives from it; HR stays null.
 * Probes bypass the keyboard via setOverride().
 */
export class KeyboardPowerSource implements SensorSource {
  readonly kind = 'dev' as const;
  targetW = DEV_POWER_DEFAULT;
  private pedaling = false;
  private sprint = false;
  private powerNow = 0;
  private override: number | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') this.pedaling = true;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = true;
      if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        this.targetW = Math.min(this.targetW + DEV_POWER_STEP, DEV_POWER_MAX);
      }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        this.targetW = Math.max(this.targetW - DEV_POWER_STEP, DEV_POWER_MIN);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') this.pedaling = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = false;
    });
    window.addEventListener('blur', () => {
      this.pedaling = false;
      this.sprint = false;
    });
  }

  /** probe control: force a constant power (null returns to keyboard) */
  setOverride(w: number | null): void {
    this.override = w;
  }

  update(dt: number, _ctx: SensorCtx): void {
    const target =
      this.override ?? (this.pedaling ? this.targetW * (this.sprint ? DEV_SPRINT_MULT : 1) : 0);
    this.powerNow += (target - this.powerNow) * (1 - Math.exp(-dt / DEV_RAMP_TAU));
    if (this.powerNow < 1) this.powerNow = 0;
  }

  read(): RideSample {
    // cadence follows power plausibly (~85 rpm at endurance effort)
    const cad = this.powerNow <= 1 ? 0 : 62 + 28 * Math.min(this.powerNow / 300, 1.4);
    return { cadenceRpm: cad, heartRateBpm: null, powerW: this.powerNow };
  }
}
