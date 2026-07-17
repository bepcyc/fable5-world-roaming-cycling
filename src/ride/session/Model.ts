/**
 * Session data model: one time sample (SessionRecord) and one workout
 * (SessionActivity), plus the numeric constants, sport catalog, pace/unit
 * conventions and monotonic-clamping helpers the recorder and exporters share.
 *
 * Units: speed km/h, distance m, elapsed s, movingTime ms, calories kcal.
 * Pure TypeScript, no DOM.
 */

// ---- global numeric constants -----------------------------------------------
export const eps = 1e-6; // generic ">0" epsilon
export const displayEps = 1e-4; // display/speed epsilon
export const workaroundEpsRatio = 0.05;
export const minInit = 10000; // aggregate min seed
export const maxInit = -10000; // aggregate max seed
export const jToCal = 0.239006;
export const jToKCal = jToCal / 1000.0;
export const calToJ = 1 / jToCal;
export const km2mi = 0.621371;
export const mi2km = 1 / km2mi;
export const m2mile = km2mi / 1000.0;
export const m2yard = 1.09361;
export const thousandYardsInMeters = 1000.0 / m2yard;
export const lbToKg = 0.45359237;
export const kgToLb = 1 / lbToKg;
export const ftToM = 0.3048;
export const degToFitGps = 11930464.711111111; // 2^32 / 360 (degrees -> FIT semicircles)
export const maxUint8 = 256;
export const maxByte = 255;
export const maxUint16 = 65536;
export const maxUint24 = maxUint8 * maxUint16; // 16777216
export const maxUint32 = maxUint16 * maxUint16; // 4294967296
export const ms2kmh = 3.6;
export const kmh2ms = 1 / 3.6;
export const powerCalorieFactorDefault = 4.0;
// FIT epoch: 1989-12-31T00:00:00Z = unix 631065600
export const fitEpochUnixSeconds = 631065600;

export const emptyMeasurement = '--';

/**
 * Round half AWAY from zero ((3.5)->4, (-3.5)->-4), unlike Math.round which
 * rounds half toward +Infinity. Used wherever integer scaling must be exact.
 */
export function dartRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Integer truncation toward zero (like `/` followed by floor for positives). */
export function truncDiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/**
 * Format a double the way the wire formats expect: integral values keep a
 * trailing ".0" (56 -> "56.0", 2 -> "2.0"); non-integral use the shortest
 * round-trip form. Used for JSON time-series timestamps/elevation and TCX
 * altitude, where a bare integer would change the bytes.
 */
export function dartDouble(x: number): string {
  if (Number.isFinite(x) && Number.isInteger(x)) return `${x}.0`;
  return x.toString();
}

// ---- sport catalog ----------------------------------------------------------
export const ActivityType = {
  alpineSki: 'AlpineSki',
  backcountrySki: 'BackcountrySki',
  canoeing: 'Canoeing',
  crossfit: 'Crossfit',
  eBikeRide: 'EBikeRide',
  elliptical: 'Elliptical',
  golf: 'Golf',
  handcycle: 'Handcycle',
  hike: 'Hike',
  iceSkate: 'IceSkate',
  inlineSkate: 'InlineSkate',
  kayaking: 'Kayaking',
  kitesurf: 'Kitesurf',
  nordicSki: 'NordicSki',
  ride: 'Ride',
  rockClimbing: 'RockClimbing',
  rollerSki: 'RollerSki',
  rowing: 'Rowing',
  run: 'Run',
  sail: 'Sail',
  skateboard: 'Skateboard',
  snowboard: 'Snowboard',
  snowshoe: 'Snowshoe',
  soccer: 'Soccer',
  stairStepper: 'StairStepper',
  standUpPaddling: 'StandUpPaddling',
  surfing: 'Surfing',
  swim: 'Swim',
  velomobile: 'Velomobile',
  virtualRide: 'VirtualRide',
  virtualRun: 'VirtualRun',
  walk: 'Walk',
  weightTraining: 'WeightTraining',
  wheelchair: 'Wheelchair',
  windsurf: 'Windsurf',
  workout: 'Workout',
  yoga: 'Yoga',
} as const;

export const waterSports: readonly string[] = [
  ActivityType.kayaking,
  ActivityType.canoeing,
  ActivityType.rowing,
  ActivityType.swim,
];
export const paddleSports: readonly string[] = [ActivityType.kayaking, ActivityType.canoeing];

// paddle grouping used by the slow-speed lookups
export const PADDLE_SPORT = 'Paddle';

/** Collapse a sport into the prefix that keys slow/pacer speeds. */
export function sport2Sport(sport: string): string {
  if (
    sport === ActivityType.kayaking ||
    sport === ActivityType.canoeing ||
    sport === ActivityType.rowing ||
    sport === ActivityType.nordicSki
  ) {
    return PADDLE_SPORT;
  }
  if (sport === ActivityType.stairStepper || sport === ActivityType.rockClimbing) {
    return ActivityType.swim;
  }
  return sport;
}

// per-sport "too slow to display" thresholds (km/h)
export const slowSpeeds: Readonly<Record<string, number>> = {
  [ActivityType.ride]: 1.0,
  [ActivityType.run]: 0.5,
  [PADDLE_SPORT]: 0.2,
  [ActivityType.swim]: 0.1,
  [ActivityType.elliptical]: 0.2,
  [ActivityType.stairStepper]: 0.1,
  [ActivityType.rockClimbing]: 0.1,
};

// per-sport leaderboard pacer speeds (km/h)
export const pacerSpeeds: Readonly<Record<string, number>> = {
  [ActivityType.ride]: 40.0,
  [ActivityType.run]: 14.85,
  [PADDLE_SPORT]: 10.65,
  [ActivityType.swim]: 3.43,
  [ActivityType.elliptical]: 10.65,
  [ActivityType.stairStepper]: 3.43,
  [ActivityType.rockClimbing]: 3.43,
};

// ---- pace <-> speed conventions --------------------------------------------
export function speedByUnitCore(speed: number, si: boolean): number {
  return si ? speed : speed * km2mi;
}

/** km/h -> displayed speed (Ride) or the sport's pace form (others). */
export function speedOrPace(speed: number, si: boolean, sport: string): number {
  if (sport === ActivityType.ride) {
    return si ? speed : speed * km2mi;
  }
  if (Math.abs(speed) < displayEps) return 0.0;
  if (sport === ActivityType.run || sport === ActivityType.elliptical) {
    const pace = 60.0 / speed;
    return si ? pace : pace / km2mi;
  }
  if (
    sport === ActivityType.kayaking ||
    sport === ActivityType.canoeing ||
    sport === ActivityType.rowing ||
    sport === ActivityType.nordicSki
  ) {
    return 30.0 / speed;
  }
  if (sport === ActivityType.swim) {
    return 6.0 / speed;
  }
  return speed;
}

/** "<min>:<ss>" with truncated minutes/seconds, seconds zero-padded to 2. */
export function paceString(pace: number): string {
  const minutes = Math.trunc(pace);
  const seconds = Math.trunc((pace - minutes) * 60.0);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function speedOrPaceString(
  speed: number,
  si: boolean,
  sport: string,
  limitSlowSpeed = false,
): string {
  const spd = speedOrPace(speed, si, sport);
  if (sport === ActivityType.ride) {
    return spd.toFixed(2);
  }
  if (
    sport === ActivityType.run ||
    sport === ActivityType.kayaking ||
    sport === ActivityType.canoeing ||
    sport === ActivityType.rowing ||
    sport === ActivityType.swim ||
    sport === ActivityType.elliptical ||
    sport === ActivityType.nordicSki
  ) {
    if (Math.abs(speed) < displayEps) return '0:00';
    if (limitSlowSpeed) {
      const slowSpeed = slowSpeeds[sport2Sport(sport)] ?? eps;
      if (speed < slowSpeed) return '0:00';
    }
    let pace = 60.0 / speed;
    if (
      sport === ActivityType.kayaking ||
      sport === ActivityType.canoeing ||
      sport === ActivityType.rowing ||
      sport === ActivityType.nordicSki
    ) {
      pace /= 2.0;
    } else if (sport === ActivityType.swim) {
      pace /= 10.0;
    } else if (!si) {
      pace /= km2mi;
    }
    return paceString(pace);
  }
  return spd.toFixed(2);
}

export function getSpeedUnit(si: boolean, sport: string): string {
  if (sport === ActivityType.ride) return si ? 'kmh' : 'mph';
  if (sport === ActivityType.run || sport === ActivityType.elliptical) {
    return si ? 'min /km' : 'min /mi';
  }
  if (
    sport === ActivityType.kayaking ||
    sport === ActivityType.canoeing ||
    sport === ActivityType.rowing ||
    sport === ActivityType.nordicSki
  ) {
    return 'min /500';
  }
  if (sport === ActivityType.swim) return 'min /100';
  return si ? 'kmh' : 'mph';
}

export function getCadenceUnit(sport: string): string {
  if (
    sport === ActivityType.kayaking ||
    sport === ActivityType.canoeing ||
    sport === ActivityType.rowing ||
    sport === ActivityType.swim ||
    sport === ActivityType.elliptical ||
    sport === ActivityType.nordicSki
  ) {
    return 'spm';
  }
  return 'rpm';
}

export function distanceString(distance: number, si: boolean, highRes: boolean): string {
  if (si) {
    return highRes ? distance.toFixed(0) : (distance / 1000).toFixed(2);
  }
  return highRes ? (distance * m2yard).toFixed(0) : (distance * m2mile).toFixed(2);
}

export function distanceUnit(si: boolean, highRes: boolean): string {
  if (si) return highRes ? 'm' : 'km';
  return highRes ? 'yd' : 'mi';
}

export function speedTitle(sport: string): string {
  return sport === ActivityType.ride ? 'Speed' : 'Pace';
}

/** Milliseconds -> "HH:MM:SS", zero-padded to 8 characters. */
export function durationToDisplay(totalMs: number): string {
  const totalSeconds = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const body = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return body.padStart(8, '0');
}

// ---- SessionRecord ----------------------------------------------------------

/** Construction shape for SessionRecord — timeStamp accepts Date or unix ms. */
export interface RecordInit {
  id?: number;
  activityId?: number;
  timeStamp?: Date | number | null;
  distance?: number | null;
  elapsed?: number | null;
  calories?: number | null;
  power?: number | null;
  speed?: number | null; // km/h
  cadence?: number | null;
  heartRate?: number | null;
  elapsedMillis?: number | null;
  pace?: number | null;
  sport?: string | null;
  caloriesPerHour?: number | null;
  caloriesPerMinute?: number | null;
  resistance?: number | null;
  preciseCadence?: number | null;
  strokeCount?: number | null;
  inclination?: number | null;
}

const UNSET_FK = -9223372036854775808; // default activity FK before assignment

function toDate(v: Date | number | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v);
}

export class SessionRecord {
  id: number;
  activityId: number;
  timeStamp: Date | null;
  distance: number | null; // m, cumulative
  elapsed: number | null; // s, cumulative
  calories: number | null; // kcal, cumulative
  power: number | null; // W, instantaneous
  speed: number | null; // km/h, instantaneous
  cadence: number | null; // rpm/spm
  heartRate: number | null; // bpm

  // transient (non-persisted) fields
  elapsedMillis: number | null;
  pace: number | null;
  sport: string | null;
  caloriesPerHour: number | null;
  caloriesPerMinute: number | null;
  movingTime = 0; // ms, cumulative
  resistance: number | null;
  preciseCadence: number | null;
  strokeCount: number | null;
  inclination: number | null;

  constructor(init: RecordInit = {}) {
    this.id = init.id ?? 0;
    this.activityId = init.activityId ?? UNSET_FK;
    this.timeStamp = init.timeStamp === undefined ? new Date() : toDate(init.timeStamp);
    if (this.timeStamp === null) this.timeStamp = new Date();
    this.distance = init.distance ?? null;
    this.elapsed = init.elapsed ?? null;
    this.calories = init.calories ?? null;
    this.power = init.power ?? null;
    this.speed = init.speed ?? null;
    this.cadence = init.cadence ?? null;
    this.heartRate = init.heartRate ?? null;
    this.elapsedMillis = init.elapsedMillis ?? null;
    this.pace = init.pace ?? null;
    this.sport = init.sport ?? null;
    this.caloriesPerHour = init.caloriesPerHour ?? null;
    this.caloriesPerMinute = init.caloriesPerMinute ?? null;
    this.resistance = init.resistance ?? null;
    this.preciseCadence = init.preciseCadence ?? null;
    this.strokeCount = init.strokeCount ?? null;
    this.inclination = init.inclination ?? null;
    this.paceToSpeed();
  }

  /** Derive speed (km/h) from a sport-specific pace when speed is missing. */
  paceToSpeed(): void {
    if (this.sport !== null && this.speed === null && this.pace !== null) {
      if (Math.abs(this.pace) < displayEps) {
        this.speed = 0.0;
      } else if (this.sport === ActivityType.run || this.sport === ActivityType.elliptical) {
        this.speed = 60.0 / this.pace; // minutes/km
      } else if (
        this.sport === ActivityType.kayaking ||
        this.sport === ActivityType.canoeing ||
        this.sport === ActivityType.rowing
      ) {
        this.speed = 30.0 / (this.pace / 60.0); // seconds/500m
      } else if (this.sport === ActivityType.swim) {
        this.speed = 6.0 / (this.pace / 60.0); // seconds/100m
      } else {
        // NordicSki and any other sport fall through to minutes/km here even
        // though the display layer treats NordicSki as seconds/500m.
        this.speed = 60.0 / this.pace;
      }
    }
  }

  speedByUnit(si: boolean): number {
    return speedByUnitCore(this.speed ?? 0.0, si);
  }

  /** True when every motion signal reads zero/idle. */
  isNotMoving(): boolean {
    return (
      (this.power ?? 0) === 0 &&
      (this.speed ?? 0.0) < eps &&
      (this.pace ?? 0.0) === 0.0 &&
      (this.caloriesPerHour ?? 0.0) < eps &&
      (this.caloriesPerMinute ?? 0.0) < eps &&
      (this.cadence ?? 0) === 0
    );
  }

  /** Apply calibration factors to power (and, when extended, speed/distance/pace)
   *  and to the calorie fields. */
  adjustByFactors(powerFactor: number, calorieFactor: number, extendTuning: boolean): void {
    if (Math.abs(powerFactor - 1.0) > eps) {
      if (this.power !== null) this.power = dartRound(this.power * powerFactor);
      if (extendTuning) {
        if (this.speed !== null) this.speed = this.speed * powerFactor;
        if (this.distance !== null) this.distance = this.distance * powerFactor;
        if (this.pace !== null) this.pace = this.pace / powerFactor;
      }
    }
    if (Math.abs(calorieFactor - 1.0) > eps) {
      if (this.calories !== null) this.calories = dartRound(this.calories * calorieFactor);
      if (this.caloriesPerHour !== null) this.caloriesPerHour = this.caloriesPerHour * calorieFactor;
      if (this.caloriesPerMinute !== null) {
        this.caloriesPerMinute = this.caloriesPerMinute * calorieFactor;
      }
    }
  }

  /** Advance elapsed/timestamp while paused, keeping the clock ticking. */
  adjustTime(newElapsed: number, newElapsedMillis: number): void {
    if (this.elapsedMillis !== null && this.timeStamp !== null) {
      const dMillis = newElapsedMillis - this.elapsedMillis;
      this.timeStamp = new Date(this.timeStamp.getTime() + dMillis);
    }
    this.elapsed = newElapsed;
    this.elapsedMillis = newElapsedMillis;
  }

  // ---- monotonic (non-decreasing) enforcement -------------------------------
  private cumulativeDistanceEnforcement(last: SessionRecord, force: boolean): void {
    if (last.distance !== null) {
      if (this.distance !== null) {
        if (this.distance < last.distance) this.distance = last.distance;
      } else if (force) {
        this.distance = last.distance;
      }
    }
  }

  private cumulativeElapsedTimeEnforcement(last: SessionRecord, force: boolean): void {
    if (last.elapsed !== null) {
      if (this.elapsed !== null) {
        if (this.elapsed < last.elapsed) this.elapsed = last.elapsed;
      } else if (force) {
        this.elapsed = last.elapsed;
      }
    }
  }

  private cumulativeMovingTimeEnforcement(last: SessionRecord): void {
    if (this.movingTime < last.movingTime) this.movingTime = last.movingTime;
  }

  private cumulativeCaloriesEnforcement(last: SessionRecord, force: boolean): void {
    if (last.calories !== null) {
      if (this.calories !== null) {
        if (this.calories < last.calories) this.calories = last.calories;
      } else if (force) {
        this.calories = last.calories;
      }
    }
  }

  private cumulativeStrokeCountEnforcement(last: SessionRecord, force: boolean): void {
    if (last.strokeCount !== null) {
      if (this.strokeCount !== null) {
        if (this.strokeCount < last.strokeCount) this.strokeCount = last.strokeCount;
      } else if (force) {
        this.strokeCount = last.strokeCount;
      }
    }
  }

  private nonNegativeEnforcement(): void {
    if (this.distance !== null && this.distance < 0.0) this.distance = 0.0;
    if (this.elapsed !== null && this.elapsed < 0) this.elapsed = 0;
    if (this.movingTime < 0) this.movingTime = 0;
    if (this.calories !== null && this.calories < 0) this.calories = 0;
  }

  /** Clamp the cumulative fields to be non-decreasing vs the previous record
   *  and non-negative. */
  cumulativeMetricsEnforcements(
    last: SessionRecord,
    opts: {
      forDistance?: boolean;
      forCalories?: boolean;
      forStrokeCount?: boolean;
      force?: boolean;
    } = {},
  ): void {
    const force = opts.force ?? false;
    if (opts.forDistance) this.cumulativeDistanceEnforcement(last, force);
    this.cumulativeElapsedTimeEnforcement(last, force);
    this.cumulativeMovingTimeEnforcement(last);
    if (opts.forCalories) this.cumulativeCaloriesEnforcement(last, force);
    if (opts.forStrokeCount) this.cumulativeStrokeCountEnforcement(last, force);
    this.nonNegativeEnforcement();
  }

  clone(): SessionRecord {
    const r = new SessionRecord({
      activityId: this.activityId,
      timeStamp: this.timeStamp,
      distance: this.distance,
      elapsed: this.elapsed,
      calories: this.calories,
      power: this.power,
      speed: this.speed,
      cadence: this.cadence,
      heartRate: this.heartRate,
      elapsedMillis: this.elapsedMillis,
      pace: this.pace,
      sport: this.sport,
      caloriesPerHour: this.caloriesPerHour,
      caloriesPerMinute: this.caloriesPerMinute,
      resistance: this.resistance,
      preciseCadence: this.preciseCadence,
      strokeCount: this.strokeCount,
      inclination: this.inclination,
    });
    r.movingTime = this.movingTime;
    return r;
  }

  /** A zeroed sample; pace is null for Ride, else 0. */
  static getZero(sport: string): SessionRecord {
    return new SessionRecord({
      distance: 0.0,
      elapsed: 0,
      calories: 0,
      power: 0,
      speed: 0.0,
      pace: sport === ActivityType.ride ? null : 0.0,
      cadence: 0,
      heartRate: 0,
      elapsedMillis: 0,
      caloriesPerHour: 0.0,
      caloriesPerMinute: 0.0,
      resistance: 0,
      preciseCadence: 0.0,
      strokeCount: 0.0,
      inclination: 0.0,
      sport,
    });
  }

  /** Fill nulls from another record. */
  merge(other: SessionRecord): SessionRecord {
    this.distance ??= other.distance;
    this.elapsed ??= other.elapsed;
    this.calories ??= other.calories;
    this.power ??= other.power;
    this.speed ??= other.speed;
    this.pace ??= other.pace;
    this.cadence ??= other.cadence;
    this.heartRate ??= other.heartRate;
    this.caloriesPerHour ??= other.caloriesPerHour;
    this.caloriesPerMinute ??= other.caloriesPerMinute;
    this.resistance ??= other.resistance;
    this.preciseCadence ??= other.preciseCadence;
    this.strokeCount ??= other.strokeCount;
    return this;
  }

  /**
   * Combine multi-fragment samples: keep the larger of self/other for each
   * metric; for pace keep the smaller positive value (lower pace = faster).
   */
  mergeBest(other: SessionRecord): SessionRecord {
    this.distance = mergeMax(this.distance, other.distance);
    this.elapsed = mergeMax(this.elapsed, other.elapsed);
    this.calories = mergeMax(this.calories, other.calories);
    this.power = mergeMax(this.power, other.power);
    this.speed = mergeMax(this.speed, other.speed);
    this.pace = mergeMinPace(this.pace, other.pace);
    this.cadence = mergeMax(this.cadence, other.cadence);
    this.heartRate = mergeMax(this.heartRate, other.heartRate);
    this.caloriesPerHour = mergeMax(this.caloriesPerHour, other.caloriesPerHour);
    this.caloriesPerMinute = mergeMax(this.caloriesPerMinute, other.caloriesPerMinute);
    this.resistance = mergeMax(this.resistance, other.resistance);
    this.preciseCadence = mergeMax(this.preciseCadence, other.preciseCadence);
    this.strokeCount = mergeMax(this.strokeCount, other.strokeCount);
    return this;
  }

  /** Add a continuation record's cumulative fields (for stitched sessions). */
  static offsetForward(record: SessionRecord, continuation: SessionRecord): SessionRecord {
    const c = record.clone();
    if (c.distance !== null && continuation.distance !== null) c.distance += continuation.distance;
    if (c.elapsed !== null && continuation.elapsed !== null) c.elapsed += continuation.elapsed;
    if (
      c.elapsedMillis !== null &&
      (continuation.elapsedMillis !== null || continuation.elapsed !== null)
    ) {
      c.elapsedMillis +=
        continuation.elapsedMillis !== null
          ? continuation.elapsedMillis
          : (continuation.elapsed ?? 0) * 1000;
    }
    if (c.calories !== null && continuation.calories !== null) c.calories += continuation.calories;
    return c;
  }

  /** Subtract a continuation record's cumulative fields. */
  static offsetBack(record: SessionRecord, continuation: SessionRecord): SessionRecord {
    const c = record.clone();
    if (c.distance !== null && continuation.distance !== null) c.distance -= continuation.distance;
    if (c.elapsed !== null && continuation.elapsed !== null) c.elapsed -= continuation.elapsed;
    if (c.calories !== null && continuation.calories !== null) c.calories -= continuation.calories;
    return c;
  }
}

function mergeMax(a: number | null, b: number | null): number | null {
  const na = a ?? 0;
  if (a !== null && na > 0 && (b ?? 0) > na) return b;
  return a ?? b;
}
function mergeMinPace(a: number | null, b: number | null): number | null {
  const na = a ?? 0;
  const nb = b ?? 0;
  if (a !== null && na > 0 && nb > 0 && nb < na) return b;
  return a ?? b;
}

// ---- SessionActivity --------------------------------------------------------

export interface ActivityInit {
  id?: number;
  deviceName: string;
  deviceId: string;
  hrmId: string;
  start: Date;
  end?: Date | null;
  distance?: number; // m
  elapsed?: number; // s
  movingTime?: number; // ms
  calories?: number; // kcal
  strides?: number;
  fourCC: string;
  sport: string;
  powerFactor: number;
  calorieFactor: number;
  hrCalorieFactor: number;
  hrmCalorieFactor: number;
  hrBasedCalories: boolean;
  timeZone: string;
  uploaded?: boolean;
  stravaId?: number;
  stravaActivityId?: number;
  suuntoUploaded?: boolean;
  suuntoBlobUrl?: string;
  suuntoUploadIdentifier?: string;
  suuntoWorkoutUrl?: string;
  underArmourUploaded?: boolean;
  uaWorkoutId?: number;
  trainingPeaksUploaded?: boolean;
  trainingPeaksWorkoutId?: number;
  trainingPeaksFileTrackingUuid?: string;
}

export class SessionActivity {
  id: number;
  deviceName: string;
  deviceId: string;
  hrmId: string;
  start: Date;
  end: Date | null;
  distance: number; // m total
  elapsed: number; // s total
  movingTime: number; // ms total
  calories: number; // kcal total
  strides: number;
  fourCC: string;
  sport: string;
  powerFactor: number;
  calorieFactor: number;
  hrCalorieFactor: number;
  hrmCalorieFactor: number;
  hrBasedCalories: boolean;
  timeZone: string;
  uploaded: boolean;
  stravaId: number;
  stravaActivityId: number;
  suuntoUploaded: boolean;
  suuntoBlobUrl: string;
  suuntoUploadIdentifier: string;
  suuntoWorkoutUrl: string;
  underArmourUploaded: boolean;
  uaWorkoutId: number;
  trainingPeaksUploaded: boolean;
  trainingPeaksWorkoutId: number;
  trainingPeaksFileTrackingUuid: string;
  /** Human-readable workout title (used by the JSON export). */
  title = 'Workout';

  constructor(init: ActivityInit) {
    this.id = init.id ?? 0;
    this.deviceName = init.deviceName;
    this.deviceId = init.deviceId;
    this.hrmId = init.hrmId;
    this.start = init.start;
    this.end = init.end ?? null;
    this.distance = init.distance ?? 0.0;
    this.elapsed = init.elapsed ?? 0;
    this.movingTime = init.movingTime ?? 0;
    this.calories = init.calories ?? 0;
    this.strides = init.strides ?? 0;
    this.fourCC = init.fourCC;
    this.sport = init.sport;
    this.powerFactor = init.powerFactor;
    this.calorieFactor = init.calorieFactor;
    this.hrCalorieFactor = init.hrCalorieFactor;
    this.hrmCalorieFactor = init.hrmCalorieFactor;
    this.hrBasedCalories = init.hrBasedCalories;
    this.timeZone = init.timeZone;
    this.uploaded = init.uploaded ?? false;
    this.stravaId = init.stravaId ?? 0;
    this.stravaActivityId = init.stravaActivityId ?? 0;
    this.suuntoUploaded = init.suuntoUploaded ?? false;
    this.suuntoBlobUrl = init.suuntoBlobUrl ?? '';
    this.suuntoUploadIdentifier = init.suuntoUploadIdentifier ?? '';
    this.suuntoWorkoutUrl = init.suuntoWorkoutUrl ?? '';
    this.underArmourUploaded = init.underArmourUploaded ?? false;
    this.uaWorkoutId = init.uaWorkoutId ?? 0;
    this.trainingPeaksUploaded = init.trainingPeaksUploaded ?? false;
    this.trainingPeaksWorkoutId = init.trainingPeaksWorkoutId ?? 0;
    this.trainingPeaksFileTrackingUuid = init.trainingPeaksFileTrackingUuid ?? '';
  }

  get elapsedString(): string {
    return durationToDisplay(this.elapsed * 1000);
  }

  get movingTimeString(): string {
    return durationToDisplay(this.movingTime);
  }

  /** Set end = now and copy the final totals. */
  finish(
    distance: number | null,
    elapsed: number | null,
    calories: number | null,
    strides: number | null,
    movingTime: number,
  ): void {
    this.end = new Date();
    this.distance = distance ?? 0.0;
    this.elapsed = elapsed ?? 0;
    this.calories = calories ?? 0;
    this.strides = strides ?? 0;
    this.movingTime = movingTime;
  }

  /** "Activity_{M/d/yyyy}_{H:m:s}." with '/' and ':' replaced by '-'. */
  getFileNameStub(): string {
    const d = this.start;
    const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const time = `${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}`;
    return `Activity_${date}_${time}.`.replace(/\//g, '-').replace(/:/g, '-');
  }
}

// ---- WorkoutSummary (leaderboard row) ---------------------------------------
export interface WorkoutSummary {
  deviceName: string;
  deviceId: string;
  manufacturer: string;
  start: Date;
  distance: number; // m
  elapsed: number; // s
  movingTime: number; // ms
  sport: string;
  powerFactor: number;
  calorieFactor: number;
}

/** Derived leaderboard speed (km/h) = elapsed>0 ? distance/elapsed*3.6 : 0. */
export function workoutSummarySpeed(s: WorkoutSummary): number {
  return s.elapsed > 0 ? (s.distance / s.elapsed) * 3.6 : 0;
}
