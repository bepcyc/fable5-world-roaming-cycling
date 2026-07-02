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
}

/** context a source may condition on (demo couples cadence/HR to motion) */
export interface SensorCtx {
  speedKmh: number;
  moving: boolean;
}

export interface SensorSource {
  /** 'demo' renders a DEMO badge; 'ble' is the future real-sensor path */
  readonly kind: 'demo' | 'ble';
  update(dt: number, ctx: SensorCtx): void;
  read(): RideSample;
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

    const cadTarget = ctx.moving ? CAD_BASE + CAD_WANDER * wander : 0;
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
    };
  }
}
