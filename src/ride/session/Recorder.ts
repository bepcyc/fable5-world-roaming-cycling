/**
 * Recording loop engine. Any live source feeds it one reading at a time via
 * push(sample); it buffers readings within a throttle window, merges them,
 * and emits monotonic records with wall-clock timestamps. A five-state
 * moving/paused machine tracks start and pauses; calories come from device
 * totals when present, otherwise from power integration (or an HR-based model);
 * speed, distance, power and cadence are supplemented when a channel is
 * missing. HR arrives in the sample (no separate strap channel is modeled).
 * Pure TS; node-testable.
 */

import {
  ActivityType,
  dartRound,
  displayEps,
  eps,
  jToKCal,
  kmh2ms,
  ms2kmh,
  powerCalorieFactorDefault,
  truncDiv,
  SessionRecord,
  type SessionActivity,
} from './Model';
import {
  cadenceGapWorkaroundDefault,
  dataGapWorkaroundLastPositiveValue,
  heartRateGapWorkaroundDefault,
  heartRateLimitingCapAtLimit,
  heartRateLimitingMethodDefault,
  heartRateLimitingNoLimit,
  heartRateUpperLimitDefault,
} from './ExportModel';
import { hrBasedCaloriesPerMinute, PowerSpeed, type PowerSpeedConfig } from './PowerSpeed';

export const WorkoutState = {
  waitingForFirstMove: 'waitingForFirstMove',
  startedMoving: 'startedMoving',
  moving: 'moving',
  justPaused: 'justPaused',
  paused: 'paused',
} as const;
export type WorkoutStateT = (typeof WorkoutState)[keyof typeof WorkoutState];

export const FTMS_DATA_THRESHOLD_DEFAULT = 480; // ms (~2 Hz)
export const FTMS_DATA_THRESHOLD_MIN = 50;
export const DATA_MAP_EXPIRY = 4000; // ms — merge window

export interface AthleteParams {
  weight: number; // kg
  age: number; // yr
  isMale: boolean;
  vo2Max: number;
}

export interface RecorderConfig {
  sport: string;
  activityId: number;
  startTime: Date; // activity start before the first move
  throttleMs: number; // data threshold (>= 50)
  powerFactor: number;
  calorieFactor: number;
  hrCalorieFactor: number;
  extendTuning: boolean;
  useHrBasedCalorieCounting: boolean;
  athlete: AthleteParams;
  heartRateGapWorkaround: string;
  heartRateUpperLimit: number;
  heartRateLimitingMethod: string;
  cadenceGapWorkaround: boolean;
  heartRateMonitorWorkout: boolean;
  slowPace: number | null;
  powerSpeedConfig?: PowerSpeedConfig;
}

export interface RideSampleInput {
  timestamp: Date | number; // wall clock of this reading
  power?: number | null; // W
  speedKmh?: number | null; // km/h
  cadence?: number | null; // rpm
  hr?: number | null; // bpm
  distanceM?: number | null; // cumulative m (device total)
  caloriesKcal?: number | null; // cumulative kcal (device total)
  preciseCadence?: number | null;
  strokeCount?: number | null;
}

export interface ProcessResult {
  record: SessionRecord;
  workoutState: WorkoutStateT;
  persist: boolean; // persisted when state in {moving, startedMoving, justPaused}
}

function defaultConfig(partial: Partial<RecorderConfig>): RecorderConfig {
  return {
    sport: partial.sport ?? ActivityType.ride,
    activityId: partial.activityId ?? 0,
    startTime: partial.startTime ?? new Date(),
    throttleMs: Math.max(partial.throttleMs ?? FTMS_DATA_THRESHOLD_DEFAULT, FTMS_DATA_THRESHOLD_MIN),
    powerFactor: partial.powerFactor ?? 1.0,
    calorieFactor: partial.calorieFactor ?? 1.0,
    hrCalorieFactor: partial.hrCalorieFactor ?? 1.0,
    extendTuning: partial.extendTuning ?? false,
    useHrBasedCalorieCounting: partial.useHrBasedCalorieCounting ?? false,
    athlete: partial.athlete ?? { weight: 80, age: 30, isMale: true, vo2Max: 0 },
    heartRateGapWorkaround: partial.heartRateGapWorkaround ?? heartRateGapWorkaroundDefault,
    heartRateUpperLimit: partial.heartRateUpperLimit ?? heartRateUpperLimitDefault,
    heartRateLimitingMethod: partial.heartRateLimitingMethod ?? heartRateLimitingMethodDefault,
    cadenceGapWorkaround: partial.cadenceGapWorkaround ?? cadenceGapWorkaroundDefault,
    heartRateMonitorWorkout: partial.heartRateMonitorWorkout ?? false,
    slowPace: partial.slowPace ?? null,
    ...(partial.powerSpeedConfig ? { powerSpeedConfig: partial.powerSpeedConfig } : {}),
  };
}

/** Running avg/max over persisted records (speed in km/h). */
class LiveStats {
  powerSum = 0;
  powerCount = 0;
  maxPower = 0;
  speedSum = 0;
  speedCount = 0;
  maxSpeed = 0;
  cadenceSum = 0;
  cadenceCount = 0;
  maxCadence = 0;
  hrSum = 0;
  hrCount = 0;
  maxHr = 0;

  add(r: SessionRecord): void {
    if ((r.power ?? 0) > 0) {
      this.powerSum += r.power as number;
      this.powerCount++;
      this.maxPower = Math.max(this.maxPower, r.power as number);
    }
    if ((r.speed ?? 0) > 0) {
      this.speedSum += r.speed as number;
      this.speedCount++;
      this.maxSpeed = Math.max(this.maxSpeed, r.speed as number);
    }
    if ((r.cadence ?? 0) > 0) {
      this.cadenceSum += r.cadence as number;
      this.cadenceCount++;
      this.maxCadence = Math.max(this.maxCadence, r.cadence as number);
    }
    if ((r.heartRate ?? 0) > 0) {
      this.hrSum += r.heartRate as number;
      this.hrCount++;
      this.maxHr = Math.max(this.maxHr, r.heartRate as number);
    }
  }
}

export class Recorder {
  readonly cfg: RecorderConfig;
  private readonly powerSpeed: PowerSpeed;

  workoutState: WorkoutStateT = WorkoutState.waitingForFirstMove;
  private activityStart: Date;
  private lastRecord: SessionRecord;

  private residueCalories = 0.0;
  private lastPositiveCadence = 0;
  private strokeCountAcc = 0.0;
  private lastPositiveCalories = 0.0;
  private firstCalories = true;
  private startingCalories = 0.0;
  private firstDistance = true;
  private startingDistance = 0.0;
  private firstStrokeCount = true;
  private startingStrokeCount = 0.0;
  private deviceHasTotalCalorieReporting = false;
  private hasTotalDistanceReporting = false;
  private hasTotalStrokeCountReporting = false;
  private hasPowerReporting = false;
  private hasSpeedReporting = false;

  // throttle / merge
  private pending: SessionRecord[] = [];
  private lastEmitMs: number | null = null;

  readonly records: SessionRecord[] = [];
  private readonly stats = new LiveStats();

  constructor(config: Partial<RecorderConfig> = {}) {
    this.cfg = defaultConfig(config);
    this.powerSpeed = new PowerSpeed(this.cfg.powerSpeedConfig);
    this.activityStart = new Date(this.cfg.startTime.getTime());
    this.lastRecord = new SessionRecord({ sport: this.cfg.sport });
  }

  private get isMoving(): boolean {
    return (
      this.workoutState === WorkoutState.moving || this.workoutState === WorkoutState.startedMoving
    );
  }

  /** With a single feed there is no per-fragment movement history, so a paused
   *  decision rests entirely on the current sample being idle. */
  private wasNotMoving(): boolean {
    return true;
  }

  private makeStub(sample: RideSampleInput): SessionRecord {
    return new SessionRecord({
      timeStamp: sample.timestamp,
      power: sample.power ?? null,
      speed: sample.speedKmh ?? null,
      cadence: sample.cadence ?? null,
      heartRate: sample.hr ?? null,
      distance: sample.distanceM ?? null,
      calories: sample.caloriesKcal ?? null,
      preciseCadence: sample.preciseCadence ?? null,
      strokeCount: sample.strokeCount ?? null,
      sport: this.cfg.sport,
    });
  }

  /**
   * Feed one live reading. Buffers within the throttle window; when the window
   * elapses (or on the first sample) the buffered readings are merged and one
   * processed record is emitted. Returns the emitted record, or null while
   * still buffering.
   */
  push(sample: RideSampleInput): ProcessResult | null {
    const stub = this.makeStub(sample);
    const sampleMs = (stub.timeStamp as Date).getTime();
    this.pending.push(stub);

    if (this.lastEmitMs === null || sampleMs - this.lastEmitMs >= this.cfg.throttleMs) {
      this.lastEmitMs = sampleMs;
      return this.emit(sampleMs);
    }
    return null;
  }

  /** Force-emit any buffered readings (call on stop). */
  flush(): ProcessResult | null {
    if (this.pending.length === 0) return null;
    const sampleMs = (this.pending[this.pending.length - 1] as SessionRecord).timeStamp!.getTime();
    this.lastEmitMs = sampleMs;
    return this.emit(sampleMs);
  }

  private emit(sampleMs: number): ProcessResult {
    // merge the buffered readings not older than the expiry window.
    const eligible = this.pending.filter(
      (s) => sampleMs - (s.timeStamp as Date).getTime() <= DATA_MAP_EXPIRY,
    );
    const src = eligible.length > 0 ? eligible : this.pending;
    const merged = (src[0] as SessionRecord).clone();
    for (let i = 1; i < src.length; i++) merged.mergeBest(src[i] as SessionRecord);
    merged.timeStamp = new Date(sampleMs);
    this.pending = [];

    const result = this.processRecord(merged);
    if (result.persist) {
      this.records.push(result.record);
      this.stats.add(result.record);
    }
    return result;
  }

  private optionallyCalculateSpeed(stub: SessionRecord): boolean {
    if (stub.speed === null && (stub.power ?? 0) > eps) {
      stub.speed = this.powerSpeed.velocityForPowerCardano(stub.power as number) * ms2kmh;
      return true;
    }
    return false;
  }

  private optionallyCalculateDistance(stub: SessionRecord, dT: number): boolean {
    if ((stub.speed ?? 0.0) > 0 && dT > eps) {
      const dD = (stub.speed ?? 0.0) * kmh2ms * dT;
      stub.distance = (stub.distance ?? 0.0) + dD;
      return true;
    }
    return false;
  }

  private pausedRecord(stub: SessionRecord): SessionRecord {
    if (stub.calories !== null) {
      stub.calories = Math.max(stub.calories - dartRound(this.startingCalories), 0);
    }
    if (stub.distance !== null) {
      stub.distance = Math.max(stub.distance - this.startingDistance, 0.0);
    }
    if (stub.strokeCount !== null) {
      stub.strokeCount = Math.max(stub.strokeCount - this.startingStrokeCount, 0.0);
    }
    stub.cumulativeMetricsEnforcements(this.lastRecord, {
      forDistance: !this.firstDistance,
      forCalories: !this.firstCalories,
      forStrokeCount: !this.firstStrokeCount,
      force: true,
    });
    return stub;
  }

  private processRecord(stub: SessionRecord): ProcessResult {
    const now = stub.timeStamp ?? new Date();
    const isNotMoving = stub.isNotMoving() && !this.cfg.heartRateMonitorWorkout;

    if (this.workoutState === WorkoutState.waitingForFirstMove) {
      if (isNotMoving) {
        const elapsedMillis = now.getTime() - this.activityStart.getTime();
        stub.adjustTime(truncDiv(elapsedMillis, 1000), elapsedMillis);
        this.lastRecord.adjustTime(truncDiv(elapsedMillis, 1000), elapsedMillis);
        return { record: this.pausedRecord(stub), workoutState: this.workoutState, persist: false };
      }
      // First move out of waiting always lands on startedMoving; rebase the
      // activity start so elapsed begins now.
      this.workoutState = WorkoutState.startedMoving;
      this.activityStart = new Date(now.getTime());
    } else if (isNotMoving && this.wasNotMoving()) {
      this.workoutState = this.isMoving ? WorkoutState.justPaused : WorkoutState.paused;
    } else if (this.workoutState === WorkoutState.startedMoving) {
      this.workoutState = WorkoutState.moving;
    } else if (this.workoutState !== WorkoutState.moving) {
      this.workoutState = WorkoutState.startedMoving;
    }

    stub.adjustByFactors(this.cfg.powerFactor, this.cfg.calorieFactor, this.cfg.extendTuning);

    const elapsedMillis = now.getTime() - this.activityStart.getTime();
    const elapsed = elapsedMillis / 1000.0;

    // capture starting values so cumulative device totals rebase to 0 at start.
    const deviceReportsTotalCalories = stub.calories !== null;
    this.deviceHasTotalCalorieReporting ||= deviceReportsTotalCalories;
    if (this.firstCalories) {
      if (this.deviceHasTotalCalorieReporting && (stub.calories ?? 0) > 0) {
        this.startingCalories = stub.calories as number;
        this.firstCalories = false;
      }
    }
    this.hasTotalDistanceReporting ||= stub.distance !== null;
    if (this.hasTotalDistanceReporting && this.firstDistance && (stub.distance ?? 0.0) >= 50.0) {
      this.startingDistance = stub.distance as number;
      this.firstDistance = false;
    }
    this.hasTotalStrokeCountReporting ||= stub.strokeCount !== null;
    if (
      this.hasTotalStrokeCountReporting &&
      this.firstStrokeCount &&
      (stub.strokeCount ?? 0.0) >= 5.0
    ) {
      this.startingStrokeCount = stub.strokeCount as number;
      this.firstStrokeCount = false;
    }
    this.hasPowerReporting ||= (stub.power ?? 0) > 0;
    this.hasSpeedReporting ||= (stub.speed ?? 0.0) > 0.0;

    stub.elapsed = dartRound(elapsed);
    stub.elapsedMillis = elapsedMillis;

    if (this.workoutState === WorkoutState.paused) {
      this.lastRecord.adjustTime(stub.elapsed, elapsedMillis);
      return { record: this.pausedRecord(stub), workoutState: this.workoutState, persist: false };
    }

    if (!this.hasSpeedReporting && this.isMoving) this.optionallyCalculateSpeed(stub);

    const dTMillis = elapsedMillis - (this.lastRecord.elapsedMillis ?? 0);
    const dT = dTMillis / 1000.0;
    if ((stub.distance ?? 0.0) < eps) {
      stub.distance = this.lastRecord.distance ?? 0.0;
      this.optionallyCalculateDistance(stub, dT);
    }

    // moving time only advances here (the paused branch returned earlier).
    stub.movingTime = this.lastRecord.movingTime + dTMillis;
    if (stub.movingTime >= 2000) {
      this.firstDistance = false;
      this.firstCalories = false;
      this.firstStrokeCount = false;
    }

    stub.distance ??= 0.0;
    if (this.startingDistance > eps) {
      stub.distance = Math.max((stub.distance as number) - this.startingDistance, 0.0);
    }
    stub.strokeCount ??= 0.0;
    if (this.startingStrokeCount > eps) {
      stub.strokeCount = Math.max((stub.strokeCount as number) - this.startingStrokeCount, 0.0);
    }

    // heart rate: hold the last positive reading, then apply the upper limit.
    if (
      (stub.heartRate === null || stub.heartRate === 0) &&
      (this.lastRecord.heartRate ?? 0) > 0 &&
      this.cfg.heartRateGapWorkaround === dataGapWorkaroundLastPositiveValue
    ) {
      stub.heartRate = this.lastRecord.heartRate;
    }
    if (
      this.cfg.heartRateUpperLimit > 0 &&
      (stub.heartRate ?? 0) > this.cfg.heartRateUpperLimit &&
      this.cfg.heartRateLimitingMethod !== heartRateLimitingNoLimit
    ) {
      stub.heartRate =
        this.cfg.heartRateLimitingMethod === heartRateLimitingCapAtLimit
          ? this.cfg.heartRateUpperLimit
          : 0;
    }

    // ---- calories ----
    const calories1 = stub.calories !== null ? stub.calories : 0.0;
    let calories = 0.0;
    if (
      this.deviceHasTotalCalorieReporting &&
      calories1 > eps &&
      (!this.cfg.useHrBasedCalorieCounting || stub.heartRate === null || stub.heartRate === 0)
    ) {
      // device-reported total calories
      calories = calories1;
    } else {
      // integrate (accumulating a fractional residue)
      let deltaCalories = 0.0;
      if (this.cfg.useHrBasedCalorieCounting && (stub.heartRate ?? 0) > 0) {
        stub.caloriesPerMinute =
          hrBasedCaloriesPerMinute(
            stub.heartRate as number,
            this.cfg.athlete.weight,
            this.cfg.athlete.age,
            this.cfg.athlete.isMale,
            this.cfg.athlete.vo2Max,
          ) * this.cfg.hrCalorieFactor;
      }
      if (deltaCalories < eps && stub.caloriesPerHour !== null && stub.caloriesPerHour > eps) {
        deltaCalories = (stub.caloriesPerHour / (60 * 60)) * dT;
      }
      if (deltaCalories < eps && stub.caloriesPerMinute !== null && stub.caloriesPerMinute > eps) {
        deltaCalories = (stub.caloriesPerMinute / 60) * dT;
      }
      // supplement power from energy/speed while moving with no power reading.
      if (this.isMoving && (stub.power ?? 0) < eps) {
        if ((stub.caloriesPerMinute ?? 0.0) > eps) {
          stub.power = dartRound((stub.caloriesPerMinute as number) * (50.0 / 3.0));
        } else if ((stub.caloriesPerHour ?? 0.0) > eps) {
          stub.power = dartRound((stub.caloriesPerHour as number) * (5.0 / 18.0));
        } else if (!this.hasPowerReporting && (stub.speed ?? 0) > displayEps) {
          stub.power = Math.trunc(
            this.powerSpeed.powerForVelocity((stub.speed as number) * kmh2ms, this.cfg.sport),
          );
        }
        if (stub.power !== null) stub.power = dartRound(stub.power * this.cfg.powerFactor);
        if (!this.hasSpeedReporting && this.isMoving) {
          if (this.optionallyCalculateSpeed(stub)) this.optionallyCalculateDistance(stub, dT);
        }
      }
      // power -> calories (the main path): W * s * jToKCal * calorieFactor * 4.
      if (deltaCalories < eps && (stub.power ?? 0) > eps) {
        deltaCalories =
          (stub.power as number) *
          dT *
          jToKCal *
          this.cfg.calorieFactor *
          powerCalorieFactorDefault;
      }
      this.residueCalories += deltaCalories;
      const lastCalories = this.lastRecord.calories ?? 0.0;
      calories = lastCalories + this.residueCalories;
      if (Math.floor(calories) > lastCalories) {
        this.residueCalories = calories - Math.floor(calories);
      }
    }

    // supplement power from speed outside the calorie block.
    if (
      this.isMoving &&
      !this.hasPowerReporting &&
      (stub.power ?? 0) < eps &&
      stub.speed !== null &&
      stub.speed > displayEps
    ) {
      stub.power = dartRound(
        this.powerSpeed.powerForVelocity(stub.speed * kmh2ms, this.cfg.sport) * this.cfg.powerFactor,
      );
    }

    // cadence gap-fill.
    const paceMoving =
      stub.pace !== null &&
      stub.pace > 0.0 &&
      this.cfg.slowPace !== null &&
      stub.pace < this.cfg.slowPace;
    const speedMoving = stub.speed !== null && stub.speed > eps;
    if (paceMoving || speedMoving) {
      if (
        (stub.cadence === null || stub.cadence === 0) &&
        this.lastPositiveCadence > 0 &&
        this.cfg.cadenceGapWorkaround
      ) {
        stub.cadence = this.lastPositiveCadence;
      } else if (stub.cadence !== null && stub.cadence > 0) {
        this.lastPositiveCadence = stub.cadence;
      }
    }

    // stroke-count integration.
    if (stub.strokeCount === null || stub.strokeCount <= eps) {
      if (stub.preciseCadence !== null && stub.preciseCadence >= eps) {
        this.strokeCountAcc += (stub.preciseCadence * dT) / 60.0;
      } else if (stub.cadence !== null && stub.cadence > 0) {
        this.strokeCountAcc += (stub.cadence * dT) / 60.0;
      }
      if (this.strokeCountAcc > eps) stub.strokeCount = this.strokeCountAcc;
    }

    // hold the last positive calorie total.
    if (calories < eps && this.lastPositiveCalories > eps) {
      calories = this.lastPositiveCalories;
    } else if (calories > eps && this.lastPositiveCalories < eps) {
      this.lastPositiveCalories = calories;
    }

    // rebase by the starting calories.
    if (this.startingCalories > eps) {
      calories = Math.max(calories - this.startingCalories, 0.0);
    }

    stub.calories = Math.floor(calories);
    stub.activityId = this.cfg.activityId;
    stub.sport = this.cfg.sport;

    stub.cumulativeMetricsEnforcements(this.lastRecord, {
      forDistance: !this.firstDistance,
      forCalories: !this.firstCalories,
      forStrokeCount: !this.firstStrokeCount,
    });

    this.lastRecord = stub;
    return { record: stub, workoutState: this.workoutState, persist: true };
  }

  // ---- totals + live stats --------------------------------------------------

  get sampleCount(): number {
    return this.records.length;
  }

  /** Populate the activity's end/totals from the last persisted record. */
  finish(activity: SessionActivity): void {
    const last = this.records[this.records.length - 1];
    if (last) {
      activity.finish(
        last.distance,
        last.elapsed,
        last.calories,
        last.strokeCount !== null ? dartRound(last.strokeCount) : 0,
        last.movingTime,
      );
    } else {
      activity.finish(0.0, 0, 0, 0, 0);
    }
  }

  get avgPowerW(): number {
    return this.stats.powerCount > 0 ? this.stats.powerSum / this.stats.powerCount : 0;
  }
  get maxPowerW(): number {
    return this.stats.maxPower;
  }
  get avgSpeedKmh(): number {
    return this.stats.speedCount > 0 ? this.stats.speedSum / this.stats.speedCount : 0;
  }
  get maxSpeedKmh(): number {
    return this.stats.maxSpeed;
  }
  get avgCadence(): number {
    return this.stats.cadenceCount > 0
      ? truncDiv(this.stats.cadenceSum, this.stats.cadenceCount)
      : 0;
  }
  get maxCadence(): number {
    return this.stats.maxCadence;
  }
  get avgHeartRate(): number {
    return this.stats.hrCount > 0 ? truncDiv(this.stats.hrSum, this.stats.hrCount) : 0;
  }
  get maxHeartRate(): number {
    return this.stats.maxHr;
  }
}
