/**
 * ReplaySensorSource — the "playback of files" seam. Feeds cadence / HR / power
 * from an imported activity (CsvImport / FitImport) into the ride sensor layer
 * on the same SensorSource contract the demo and BLE sources use.
 *
 * An imported activity is only a static record of a past workout; this source
 * brings it to life by iterating the stored records along their own time axis,
 * with play / pause / seek / rate (0.5× / 1× / 2×), loop, and an ended state.
 *
 * Honesty gates (Sensors.ts): `kind` is 'demo' so the DEMO badge shows — a
 * replayed number is NOT a live sensor. A `label` field carries 'REPLAY' for a
 * future UI that wants to distinguish playback from the synthetic demo rider.
 * Speed and distance from the file are exposed as READ-ONLY telemetry only;
 * the rig's ground speed stays sim-owned (Sensors.ts §comment) — we never fake
 * it through read().
 */

import type { RideSample, SensorCtx, SensorSource } from '../Sensors';
import type { ImportedActivity, ImportedRecord } from './types';

/** allowed playback rates (0.5× / 1× / 2×). */
export const REPLAY_RATES = [0.5, 1, 2] as const;
export type ReplayRate = (typeof REPLAY_RATES)[number];

/** read-only file telemetry not carried by the SensorSource channel. */
export interface ReplayTelemetry {
  /** file speed at the playhead, km/h (see CsvImport migration unit quirk) */
  speedKmh: number | null;
  /** file cumulative distance at the playhead, meters */
  distanceM: number | null;
  /** playhead elapsed, seconds */
  elapsedS: number;
  /** file cumulative calories at the playhead, kcal */
  caloriesKcal: number | null;
}

interface TimedRecord {
  /** normalized elapsed since activity start, milliseconds */
  tMs: number;
  rec: ImportedRecord;
}

/** linear interpolation of two nullable channels; null-safe. */
function lerpNullable(a: number | null, b: number | null, f: number): number | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

export class ReplaySensorSource implements SensorSource {
  /** 'demo' → the DEMO badge renders; replayed numbers are not live sensors. */
  readonly kind = 'demo' as const;
  /** future UI hook to distinguish playback from the synthetic demo rider. */
  readonly label = 'REPLAY' as const;

  readonly activity: ImportedActivity;
  private readonly track: TimedRecord[];
  private readonly durationMs: number;

  private headMs = 0;
  private paused = true;
  private rate: ReplayRate = 1;
  private looping = false;
  private isEnded = false;
  /** monotonic cursor into `track` so update() is O(1) amortized. */
  private cursor = 0;

  constructor(activity: ImportedActivity, opts?: { loop?: boolean; autoplay?: boolean }) {
    this.activity = activity;
    this.track = buildTrack(activity);
    this.durationMs = this.track.length ? this.track[this.track.length - 1]!.tMs : 0;
    this.looping = opts?.loop ?? false;
    this.paused = !(opts?.autoplay ?? false);
  }

  // ---- transport -----------------------------------------------------------

  play(): void {
    if (this.isEnded && !this.looping) return; // ended, non-looping: seek first
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  togglePlay(): void {
    if (this.paused) this.play();
    else this.pause();
  }
  get isPaused(): boolean {
    return this.paused;
  }
  get ended(): boolean {
    return this.isEnded;
  }

  /** set an exact rate; ignores values outside {0.5,1,2}. */
  setRate(rate: number): void {
    if ((REPLAY_RATES as readonly number[]).includes(rate)) this.rate = rate as ReplayRate;
  }
  /** cycle 0.5 → 1 → 2 → 0.5. */
  cycleRate(): ReplayRate {
    const i = REPLAY_RATES.indexOf(this.rate);
    this.rate = REPLAY_RATES[(i + 1) % REPLAY_RATES.length]!;
    return this.rate;
  }
  get playbackRate(): ReplayRate {
    return this.rate;
  }

  set loop(on: boolean) {
    this.looping = on;
  }
  get loop(): boolean {
    return this.looping;
  }

  /** seek to an absolute elapsed time (seconds), clamped to [0, duration]. */
  seek(seconds: number): void {
    this.seekMs(seconds * 1000);
  }
  /** seek to a fraction of the whole activity, clamped to [0,1]. */
  seekFraction(fraction: number): void {
    this.seekMs(Math.max(0, Math.min(1, fraction)) * this.durationMs);
  }
  private seekMs(ms: number): void {
    this.headMs = Math.max(0, Math.min(this.durationMs, ms));
    this.isEnded = false;
    // reset the monotonic cursor to bracket the new head
    this.cursor = 0;
    while (
      this.cursor < this.track.length - 1 &&
      this.track[this.cursor + 1]!.tMs <= this.headMs
    ) {
      this.cursor++;
    }
  }
  /** jump back to the start (paused state unchanged). */
  restart(): void {
    this.seekMs(0);
  }

  // ---- progress / telemetry ------------------------------------------------

  get durationS(): number {
    return this.durationMs / 1000;
  }
  get elapsedS(): number {
    return this.headMs / 1000;
  }
  /** 0..1 fraction of the activity played. */
  progress(): number {
    return this.durationMs > 0 ? this.headMs / this.durationMs : 0;
  }
  get recordCount(): number {
    return this.track.length;
  }

  // ---- SensorSource contract ----------------------------------------------

  update(dt: number, _ctx: SensorCtx): void {
    if (this.paused || this.isEnded || this.track.length === 0) return;
    this.headMs += dt * 1000 * this.rate;
    if (this.headMs >= this.durationMs) {
      if (this.looping) {
        // wrap, preserving overshoot; guard against a zero-length track
        this.headMs = this.durationMs > 0 ? this.headMs % this.durationMs : 0;
        this.cursor = 0;
      } else {
        this.headMs = this.durationMs;
        this.isEnded = true;
      }
    }
    this.advanceCursor();
  }

  read(): RideSample {
    const snap = this.sampleAt(this.headMs);
    return {
      cadenceRpm: snap.cadence,
      heartRateBpm: snap.heartRate,
      powerW: snap.power,
    };
  }

  // ---- file-derived telemetry (read-only; NOT fed to the rig as speed) -----

  telemetry(): ReplayTelemetry {
    const snap = this.sampleAt(this.headMs);
    return {
      speedKmh: snap.speed,
      distanceM: snap.distance,
      elapsedS: this.headMs / 1000,
      caloriesKcal: snap.calories,
    };
  }

  /** the interpolated record at the current playhead (for UI). */
  currentRecord(): ImportedRecord {
    return this.sampleAt(this.headMs);
  }

  // ---- interpolation core --------------------------------------------------

  private advanceCursor(): void {
    while (
      this.cursor < this.track.length - 1 &&
      this.track[this.cursor + 1]!.tMs <= this.headMs
    ) {
      this.cursor++;
    }
    while (this.cursor > 0 && this.track[this.cursor]!.tMs > this.headMs) {
      this.cursor--;
    }
  }

  /** linear time interpolation of the record channels at `tMs`. */
  private sampleAt(tMs: number): ImportedRecord {
    const n = this.track.length;
    if (n === 0) {
      return {
        timeStampMs: null,
        distance: null,
        elapsed: Math.round(tMs / 1000),
        elapsedMillis: Math.round(tMs),
        calories: null,
        power: null,
        speed: null,
        cadence: null,
        heartRate: null,
      };
    }
    // locate bracketing pair around tMs using (already-advanced) cursor
    let i = Math.max(0, Math.min(this.cursor, n - 1));
    while (i < n - 1 && this.track[i + 1]!.tMs <= tMs) i++;
    while (i > 0 && this.track[i]!.tMs > tMs) i--;
    const a = this.track[i]!;
    const b = i < n - 1 ? this.track[i + 1]! : a;
    const span = b.tMs - a.tMs;
    const f = span > 0 ? Math.max(0, Math.min(1, (tMs - a.tMs) / span)) : 0;
    const ra = a.rec;
    const rb = b.rec;
    return {
      timeStampMs:
        ra.timeStampMs !== null && rb.timeStampMs !== null
          ? Math.round(ra.timeStampMs + (rb.timeStampMs - ra.timeStampMs) * f)
          : ra.timeStampMs ?? rb.timeStampMs,
      distance: lerpNullable(ra.distance, rb.distance, f),
      elapsed: Math.round(tMs / 1000),
      elapsedMillis: Math.round(tMs),
      calories: lerpNullable(ra.calories, rb.calories, f),
      power: lerpNullable(ra.power, rb.power, f),
      speed: lerpNullable(ra.speed, rb.speed, f),
      cadence: lerpNullable(ra.cadence, rb.cadence, f),
      heartRate: lerpNullable(ra.heartRate, rb.heartRate, f),
      lat: lerpNullable(ra.lat ?? null, rb.lat ?? null, f),
      lon: lerpNullable(ra.lon ?? null, rb.lon ?? null, f),
      altitude: lerpNullable(ra.altitude ?? null, rb.altitude ?? null, f),
    };
  }
}

/**
 * Build a monotonic time axis (ms from activity start) for the records. Prefers
 * each record's own elapsedMillis, then elapsed×1000, then timeStamp−start.
 * Non-decreasing time is enforced so interpolation never divides by a negative
 * span — the record channels are cumulative and thus monotonic by construction.
 */
function buildTrack(activity: ImportedActivity): TimedRecord[] {
  const out: TimedRecord[] = [];
  let lastT = 0;
  for (const rec of activity.records) {
    let tMs: number;
    if (rec.elapsedMillis !== null && rec.elapsedMillis !== undefined) {
      tMs = rec.elapsedMillis;
    } else if (rec.elapsed !== null && rec.elapsed !== undefined) {
      tMs = rec.elapsed * 1000;
    } else if (rec.timeStampMs !== null && rec.timeStampMs !== undefined) {
      tMs = rec.timeStampMs - activity.startMs;
    } else {
      tMs = lastT;
    }
    if (tMs < lastT) tMs = lastT; // clamp non-monotonic samples forward
    lastT = tMs;
    out.push({ tMs, rec });
  }
  return out;
}
