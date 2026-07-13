/**
 * Weather visual states (M1.6) — dry / rain / after-rain / fog.
 *
 * An orchestrator that LERPS existing levers; no new render systems:
 *   froxel fog        fogK + wxBoost (un-gates the noon suppression)
 *   aerial haze       Atmosphere.fogU (promoted FOG_K/H0/HF)
 *   cloud deck        Clouds.coverage / density
 *   surface wetness   weatherU.wetness → TerrainMaterial wet term
 *   precipitation     weatherU.rainAmt → Particles rain/splash types
 *   light             sun intensity dim + environmentIntensity (IBL kept,
 *                     no rebake — cheap, good enough for a visual-only M)
 *
 * Determinism: `?weather=<state>` SNAPS at boot (probes/shots reproduce
 * exactly); runtime transitions ease toward targets with tau `?weathert`
 * (seconds, default 6) driven by worldTime deltas — ?freeze pins them.
 * Physics coupling (crr/grip via weatherSensitivity) is Phase 3 — NOT here.
 *
 * weatherU is the module singleton other systems read (windU pattern).
 */

import type { Scene } from 'three';
import { runiform } from '../gpu/RenderUniform';
import type { Froxels } from '../gpu/passes/Froxels';
import type { Atmosphere } from './Atmosphere';
import type { Clouds } from './Clouds';
import type { SunSky } from './SunSky';

/** global weather uniforms — read by TerrainMaterial (wet) and Particles */
export const weatherU = {
  /** 0..1 global surface wetness (albedo darken + roughness drop) */
  wetness: runiform(0),
  /** 0..1 precipitation amount → fraction of particles rolling rain */
  rainAmt: runiform(0),
  /** 0..1 micro-droplet coverage on vegetation (rain/fog/dew) — driver WIP,
   *  stays 0 until the WeatherState integrator lands */
  droplets: runiform(0),
};

export type WeatherKind = 'dry' | 'rain' | 'after-rain' | 'fog';

interface Targets {
  fogK: number;
  wxBoost: number;
  aerialK: number;
  /** aerial haze scale height (km) → Atmosphere.fogU.hf: tall for clear-day
   *  horizon haze (ridge layering, ref-04), ground-hugging for fog state */
  aerialHf: number;
  cov: number;
  cdens: number;
  overcast: number;
  wetness: number;
  rain: number;
  sunDim: number;
  envK: number;
}

const STATES: Record<WeatherKind, Targets> = {
  // dry = «ясный день с горизонтной дымкой» (ref-04): tall haze column
  // (hf 0.95 km) + moderate density — far ridge bands sink step by step,
  // foreground stays clean (Atmosphere.aerial's near-gate owns the curve)
  dry: { fogK: 0.4, wxBoost: 0, aerialK: 0.19, aerialHf: 0.95, cov: 0.62, cdens: 0.85, overcast: 0, wetness: 0, rain: 0, sunDim: 1, envK: 1 },
  rain: { fogK: 1.0, wxBoost: 0.4, aerialK: 0.52, aerialHf: 0.65, cov: 1.0, cdens: 1.25, overcast: 1.0, wetness: 0.92, rain: 0.85, sunDim: 0.25, envK: 0.5 },
  'after-rain': { fogK: 0.75, wxBoost: 0.3, aerialK: 0.34, aerialHf: 0.8, cov: 0.5, cdens: 0.75, overcast: 0.12, wetness: 1, rain: 0, sunDim: 0.9, envK: 0.85 },
  fog: { fogK: 2.8, wxBoost: 1, aerialK: 0.9, aerialHf: 0.38, cov: 0.88, cdens: 0.7, overcast: 0.45, wetness: 0.3, rain: 0, sunDim: 0.55, envK: 0.7 },
};

export function parseWeather(q: URLSearchParams): WeatherKind {
  const w = q.get('weather');
  return w === 'rain' || w === 'after-rain' || w === 'fog' ? w : 'dry';
}

export class WeatherState {
  private cur: Targets;
  private target: Targets;
  private kind: WeatherKind;
  private tau: number;
  private appliedDim = 1;
  private lastWt: number | null = null;
  /** micro-droplet coverage on vegetation — integrated OUTSIDE the shared
   *  ease: beading up under rain is fast, drying out is slow (asymmetric
   *  taus), and clear early mornings add dew from SunSky.timeOfDay */
  private dropsCur = 0;
  private static readonly DROPS: Record<WeatherKind, number> = {
    dry: 0,
    rain: 1,
    'after-rain': 0.55,
    fog: 0.28,
  };

  constructor(
    private froxels: Froxels | null,
    private atmosphere: Atmosphere,
    private clouds: Clouds | null,
    private sunSky: SunSky,
    private scene: Scene,
  ) {
    const q = new URLSearchParams(window.location.search);
    this.kind = parseWeather(q);
    const tq = Number(q.get('weathert') ?? NaN);
    this.tau = Number.isFinite(tq) ? Math.max(tq, 0.1) : 6;
    this.target = { ...STATES[this.kind] };
    this.cur = { ...this.target }; // boot SNAP — deterministic shots
    this.dropsCur = this.dropsTarget(); // droplets snap too (incl. boot dew)
    // ?fog=N override stays king for existing probes/tuning flows
    const fq = Number(q.get('fog') ?? NaN);
    if (Number.isFinite(fq) && froxels) this.cur.fogK = this.target.fogK = fq;
    this.apply();
    // probe/console surface
    const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg ?? {};
    dbg['weather'] = (k: string): boolean => {
      if (k === 'dry' || k === 'rain' || k === 'after-rain' || k === 'fog') {
        this.set(k);
        return true;
      }
      return false;
    };
    dbg['weatherState'] = (): string => this.kind;
    dbg['weatherDroplets'] = (): number => this.dropsCur;
    (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg = dbg;
  }

  get state(): WeatherKind {
    return this.kind;
  }

  /** ease toward a new state (runtime transitions — 60 s capture rule) */
  set(kind: WeatherKind): void {
    this.kind = kind;
    this.target = { ...STATES[kind] };
  }

  /** engine.onUpdate hook — worldTime-driven so ?freeze pins transitions */
  update(worldTime: number): void {
    const dt = this.lastWt === null ? 0 : Math.max(worldTime - this.lastWt, 0);
    this.lastWt = worldTime;
    if (dt > 0) {
      const k = 1 - Math.exp(-dt / this.tau);
      const c = this.cur as unknown as Record<string, number>;
      const t = this.target as unknown as Record<string, number>;
      for (const key of Object.keys(c)) {
        c[key] = (c[key] as number) + ((t[key] as number) - (c[key] as number)) * k;
      }
      // droplets: bead up fast under rain/fog, dry out slow ("потом
      // обсыхают") — deliberately NOT the shared tau
      const dTgt = this.dropsTarget();
      const dTau = dTgt > this.dropsCur ? 7 : 55;
      this.dropsCur += (dTgt - this.dropsCur) * (1 - Math.exp(-dt / dTau));
    }
    this.apply();
  }

  /** dew window: beads form before sunrise (~4:40→5:40), burn off through
   *  mid-morning (~7:30→9:25); rain/fog targets win via max() */
  private dewK(): number {
    const t = this.sunSky.timeOfDay;
    const up = Math.min(Math.max((t - 4.6) / 1.0, 0), 1);
    const down = Math.min(Math.max((9.4 - t) / 1.9, 0), 1);
    return 0.45 * Math.min(up, down);
  }

  private dropsTarget(): number {
    return Math.max(WeatherState.DROPS[this.kind], this.dewK());
  }

  private apply(): void {
    const c = this.cur;
    if (this.froxels) {
      this.froxels.fogK.value = c.fogK;
      this.froxels.wxBoost.value = c.wxBoost;
    }
    this.atmosphere.fogU.k.value = c.aerialK;
    this.atmosphere.fogU.hf.value = c.aerialHf;
    if (this.clouds) {
      this.clouds.coverage.value = c.cov;
      this.clouds.density.value = c.cdens;
      this.clouds.overcast.value = c.overcast;
    }
    weatherU.wetness.value = c.wetness;
    weatherU.rainAmt.value = c.rain;
    weatherU.droplets.value = this.dropsCur;
    // sun dim: derive the undimmed base from the CURRENT intensity so ToD
    // edits ([ / ]) keep working — the math re-bases every frame
    const sun = this.sunSky.sun;
    const base = sun.intensity / this.appliedDim;
    this.appliedDim = Math.max(c.sunDim, 1e-3);
    sun.intensity = base * this.appliedDim;
    this.scene.environmentIntensity = c.envK;
  }
}
