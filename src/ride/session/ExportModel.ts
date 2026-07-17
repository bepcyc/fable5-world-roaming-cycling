/**
 * Shared export pipeline. buildExportModel() turns an activity plus its stored
 * records into an ExportModel the format encoders consume: it inserts
 * interpolated points across long gaps for GPS smoothness, converts speed from
 * km/h to m/s in place (so every format sees m/s), attaches synthetic GPS
 * coordinates, applies the cadence gap-fill and heart-rate gap/limit rules, and
 * computes the aggregate statistics. Pure TS.
 */

import {
  eps,
  kmh2ms,
  maxInit,
  minInit,
  truncDiv,
  ActivityType,
  slowSpeeds,
  sport2Sport,
  speedOrPace,
  type SessionActivity,
  type SessionRecord,
} from './Model';
import { TrackCalculator, TrackManager, type LonLat } from './Track';

// ---- export target ----------------------------------------------------------
export const ExportTarget = {
  regular: 0,
  suunto: 1,
} as const;

// ---- HR / cadence preference constants --------------------------------------
export const dataGapWorkaroundLastPositiveValue = 'last_positive_value';
export const dataGapWorkaroundNoWorkaround = 'no_workaround';
export const dataGapWorkaroundDoNotWriteZeros = 'do_not_write_zeros';
export const heartRateGapWorkaroundDefault = dataGapWorkaroundLastPositiveValue;

export const heartRateLimitingWriteZero = 'write_zero';
export const heartRateLimitingWriteNothing = 'write_nothing';
export const heartRateLimitingCapAtLimit = 'cap_at_limit';
export const heartRateLimitingNoLimit = 'no_limit';
export const heartRateLimitingMethodDefault = heartRateLimitingNoLimit;
export const heartRateUpperLimitDefault = 0;

export const cadenceGapWorkaroundDefault = true;

// ---- device descriptor ------------------------------------------------------
/** The device fields the file encoders read; the caller supplies its own. */
export interface DeviceDescriptor {
  fullName: string; // "<vendor> <model>"
  modelName: string; // TCX ProductID
  manufacturerFitId: number; // FIT manufacturer id
  isAntPlus: boolean; // selects the FIT source_type
}

export const stravaFitId = 265; // generic fallback FIT manufacturer id
export const suuntoFitId = 23;

/** Generic fallback descriptor. */
export const DEFAULT_DEVICE_DESCRIPTOR: DeviceDescriptor = {
  fullName: 'Generic Trainer',
  modelName: 'Generic',
  manufacturerFitId: stravaFitId,
  isAntPlus: false,
};

// ---- ExportRecord -----------------------------------------------------------
export class ExportRecord {
  record: SessionRecord;
  latitude: number; // degrees
  longitude: number;

  constructor(record: SessionRecord, latitude = 0.0, longitude = 0.0) {
    this.record = record;
    this.latitude = latitude;
    this.longitude = longitude;
  }

  /** elapsed seconds (double) = (timeStamp - activity.start) ms / 1000. */
  elapsed(activity: SessionActivity): number {
    const ts = this.record.timeStamp ?? new Date();
    return (ts.getTime() - activity.start.getTime()) / 1000;
  }
}

// ---- StatisticsAccumulator --------------------------------------------------
/**
 * Aggregates over export records. Only positive samples count (speed uses eps).
 * max/min seed to maxInit(-10000)/minInit(10000) and ExportModel copies those
 * raw seeds, so a metric with no data reports 10000/-10000 downstream.
 */
export class StatisticsAccumulator {
  powerSum = 0;
  powerCount = 0;
  maxPower = maxInit;
  minPower = minInit;
  speedSum = 0.0;
  speedCount = 0;
  maxSpeed = maxInit;
  minSpeed = minInit;
  heartRateSum = 0;
  heartRateCount = 0;
  maxHeartRate = maxInit;
  minHeartRate = minInit;
  cadenceSum = 0;
  cadenceCount = 0;
  maxCadence = maxInit;
  minCadence = minInit;

  get avgPower(): number {
    return this.powerCount > 0 ? this.powerSum / this.powerCount : 0.0;
  }
  get avgSpeed(): number {
    return this.speedCount > 0 ? this.speedSum / this.speedCount : 0.0;
  }
  get avgHeartRate(): number {
    return this.heartRateCount > 0 ? truncDiv(this.heartRateSum, this.heartRateCount) : 0;
  }
  get avgCadence(): number {
    return this.cadenceCount > 0 ? truncDiv(this.cadenceSum, this.cadenceCount) : 0;
  }

  processExportRecord(er: ExportRecord): void {
    const r = er.record;
    if ((r.power ?? 0) > 0) {
      this.powerSum += r.power as number;
      this.powerCount++;
      this.maxPower = Math.max(this.maxPower, r.power as number);
      this.minPower = Math.min(this.minPower, r.power as number);
    }
    if ((r.speed ?? 0.0) > eps) {
      this.speedSum += r.speed as number;
      this.speedCount++;
      this.maxSpeed = Math.max(this.maxSpeed, r.speed as number);
      this.minSpeed = Math.min(this.minSpeed, r.speed as number);
    }
    if ((r.heartRate ?? 0) > 0) {
      this.heartRateSum += r.heartRate as number;
      this.heartRateCount++;
      this.maxHeartRate = Math.max(this.maxHeartRate, r.heartRate as number);
      this.minHeartRate = Math.min(this.minHeartRate, r.heartRate as number);
    }
    if ((r.cadence ?? 0) > 0) {
      this.cadenceSum += r.cadence as number;
      this.cadenceCount++;
      this.maxCadence = Math.max(this.maxCadence, r.cadence as number);
      this.minCadence = Math.min(this.minCadence, r.cadence as number);
    }
  }
}

// ---- MeasurementCounter -----------------------------------------------------
/** Counts positive samples so the JSON export knows which series to emit. */
export class MeasurementCounter {
  readonly si: boolean;
  readonly sport: string;
  powerCounter = 0;
  speedCounter = 0;
  cadenceCounter = 0;
  hrCounter = 0;
  slowPace: number;

  constructor(si: boolean, sport: string) {
    this.si = si;
    this.sport = sport;
    if (sport !== ActivityType.ride) {
      const slowSpeed = slowSpeeds[sport2Sport(sport)] ?? eps;
      this.slowPace = speedOrPace(slowSpeed, si, sport);
    } else {
      this.slowPace = 0.0;
    }
  }

  processRecord(record: SessionRecord): void {
    if (record.power !== null && record.power > 0) this.powerCounter++;
    if (record.speed !== null && record.speed > 0) this.speedCounter++;
    if (record.cadence !== null && record.cadence > 0) this.cadenceCounter++;
    if (record.heartRate !== null && record.heartRate > 0) this.hrCounter++;
  }

  get hasPower(): boolean {
    return this.powerCounter > 0;
  }
  get hasSpeed(): boolean {
    return this.speedCounter > 0;
  }
  get hasCadence(): boolean {
    return this.cadenceCounter > 0;
  }
  get hasHeartRate(): boolean {
    return this.hrCounter > 0;
  }
}

// ---- ExportModel ------------------------------------------------------------
export interface ExportModelInit {
  activity: SessionActivity;
  rawData: boolean;
  calculateGps: boolean;
  descriptor: DeviceDescriptor;
  altitude: number;
  records: ExportRecord[];
  exportTarget: number;
  // TCX author / build metadata
  author: string;
  name: string;
  swVersionMajor: string;
  swVersionMinor: string;
  buildVersionMajor: string;
  buildVersionMinor: string;
  langID: string;
  partNumber: string;
  // FIT record HR handling + file timestamps
  heartRateGapWorkaround: string;
  heartRateUpperLimit: number;
  heartRateLimitingMethod: string;
  now: Date;
}

export class ExportModel {
  activity: SessionActivity;
  rawData: boolean;
  calculateGps: boolean;
  descriptor: DeviceDescriptor;
  altitude: number; // m
  records: ExportRecord[];
  exportTarget: number;

  averageSpeed = 0.0; // m/s
  maximumSpeed = 0.0;
  minimumSpeed = 0.0;
  averageHeartRate = 0;
  maximumHeartRate = 0;
  minimumHeartRate = 0;
  averageCadence = 0;
  maximumCadence = 0;
  minimumCadence = 0;
  averagePower = 0.0;
  maximumPower = 0;
  minimumPower = 0;

  author: string;
  name: string;
  swVersionMajor: string;
  swVersionMinor: string;
  buildVersionMajor: string;
  buildVersionMinor: string;
  langID: string;
  partNumber: string;

  heartRateGapWorkaround: string;
  heartRateUpperLimit: number;
  heartRateLimitingMethod: string;
  now: Date;

  constructor(init: ExportModelInit) {
    this.activity = init.activity;
    this.rawData = init.rawData;
    this.calculateGps = init.calculateGps;
    this.descriptor = init.descriptor;
    this.altitude = init.altitude;
    this.records = init.records;
    this.exportTarget = init.exportTarget;
    this.author = init.author;
    this.name = init.name;
    this.swVersionMajor = init.swVersionMajor;
    this.swVersionMinor = init.swVersionMinor;
    this.buildVersionMajor = init.buildVersionMajor;
    this.buildVersionMinor = init.buildVersionMinor;
    this.langID = init.langID;
    this.partNumber = init.partNumber;
    this.heartRateGapWorkaround = init.heartRateGapWorkaround;
    this.heartRateUpperLimit = init.heartRateUpperLimit;
    this.heartRateLimitingMethod = init.heartRateLimitingMethod;
    this.now = init.now;

    // Records are assumed ordered by timeStamp ascending.
    if (this.records.length > 0) {
      const lastRecord = this.records[this.records.length - 1] as ExportRecord;
      const firstRecord = this.records[0] as ExportRecord;
      if (
        this.activity.elapsed === 0 &&
        lastRecord.record.timeStamp !== null &&
        firstRecord.record.timeStamp !== null
      ) {
        this.activity.elapsed = Math.floor(
          (lastRecord.record.timeStamp.getTime() - firstRecord.record.timeStamp.getTime()) / 1000,
        );
      }
      if (this.activity.distance < eps && (lastRecord.record.distance ?? 0.0) > eps) {
        this.activity.distance = lastRecord.record.distance as number;
      }
    }

    if (!this.rawData) {
      const accu = new StatisticsAccumulator();
      for (const tp of this.records) accu.processExportRecord(tp);
      this.averageSpeed = accu.avgSpeed;
      this.maximumSpeed = accu.maxSpeed;
      this.minimumSpeed = accu.minSpeed;
      this.averageHeartRate = accu.avgHeartRate;
      this.maximumHeartRate = accu.maxHeartRate;
      this.minimumHeartRate = accu.minHeartRate;
      this.averageCadence = accu.avgCadence;
      this.maximumCadence = accu.maxCadence;
      this.minimumCadence = accu.minCadence;
      this.averagePower = accu.avgPower;
      this.maximumPower = accu.maxPower;
      this.minimumPower = accu.minPower;
    }
  }
}

// ---- pipeline ---------------------------------------------------------------
export interface ExportOptions {
  rawData?: boolean;
  calculateGps?: boolean;
  exportTarget?: number; // ExportTarget.*
  descriptor?: DeviceDescriptor;
  timeZone?: string; // override for track selection (default activity.timeZone)
  useLongTrack?: boolean;
  now?: Date; // FIT file_id/device_info time_created (default new Date())
  cadenceGapWorkaround?: boolean;
  heartRateGapWorkaround?: string;
  heartRateUpperLimit?: number;
  heartRateLimitingMethod?: string;
  // TCX author/build metadata
  author?: string;
  appName?: string;
  appVersion?: string; // "1.0.0"
  buildNumber?: string;
  langID?: string;
  partNumber?: string;
}

function shallowCloneActivity(a: SessionActivity): SessionActivity {
  const c = Object.create(Object.getPrototypeOf(a)) as SessionActivity;
  return Object.assign(c, a);
}

function recordToExport(
  record: SessionRecord,
  calculator: TrackCalculator,
  calculateGps: boolean,
  rawData: boolean,
): ExportRecord {
  record.distance ??= 0.0;
  // km/h -> m/s in place; this is why every format downstream sees m/s.
  if (!rawData && record.speed !== null) {
    record.speed = record.speed * kmh2ms;
  }
  const exportRecord = new ExportRecord(record);
  if (record.distance !== null && !rawData && calculateGps) {
    const gps: LonLat = calculator.gpsCoordinates(record.distance);
    exportRecord.longitude = gps.dx;
    exportRecord.latitude = gps.dy;
  }
  return exportRecord;
}

/**
 * Prepare an ExportModel from an activity and its stored records. Both the
 * activity and the records are cloned first, so the in-place mutations here
 * (speed to m/s, distance fill, elapsed/distance derivation) never touch the
 * caller's state and repeated exports stay independent.
 */
export function buildExportModel(
  inputActivity: SessionActivity,
  inputRecords: SessionRecord[],
  opts: ExportOptions = {},
): ExportModel {
  const rawData = opts.rawData ?? false;
  const calculateGps = opts.calculateGps ?? true;
  const exportTarget = opts.exportTarget ?? ExportTarget.regular;
  const descriptor = opts.descriptor ?? DEFAULT_DEVICE_DESCRIPTOR;
  const cadenceGapWorkaround = opts.cadenceGapWorkaround ?? cadenceGapWorkaroundDefault;
  const heartRateGapWorkaround = opts.heartRateGapWorkaround ?? heartRateGapWorkaroundDefault;
  const heartRateUpperLimit = opts.heartRateUpperLimit ?? heartRateUpperLimitDefault;
  const heartRateLimitingMethod = opts.heartRateLimitingMethod ?? heartRateLimitingMethodDefault;

  const activity = shallowCloneActivity(inputActivity);
  const track = new TrackManager().getTrack(activity.sport, {
    timeZone: opts.timeZone ?? activity.timeZone,
    useLongTrack: opts.useLongTrack,
    now: opts.now,
  });
  const calculator = new TrackCalculator(track);

  const records = inputRecords.map((r) => r.clone());
  const exportRecords: ExportRecord[] = [];
  let previousRecord: SessionRecord | null = null;
  let lastPositiveCadence = 0;
  let lastPositiveHeartRate = 0;

  for (const r of records) {
    const prepRecords: SessionRecord[] = [];
    // Over long gaps, insert interpolated clones for GPS smoothness.
    if (previousRecord !== null && calculateGps) {
      const prev = previousRecord;
      if (
        (prev.distance !== null && r.distance !== null) ||
        (prev.calories !== null && r.calories !== null)
      ) {
        const dTMillis = (r.timeStamp as Date).getTime() - (prev.timeStamp as Date).getTime();
        if (dTMillis >= 2000) {
          const dividerCount = truncDiv(dTMillis - 500, 1000);
          if (dividerCount > 0) {
            let time = (prev.timeStamp as Date).getTime();
            const timePart = truncDiv(dTMillis, dividerCount + 1);
            const dDistance =
              prev.distance !== null && r.distance !== null ? r.distance - prev.distance : null;
            const distancePart = dDistance !== null ? dDistance / (dividerCount + 1) : null;
            let distance = prev.distance;
            const dCalories =
              prev.calories !== null && r.calories !== null ? r.calories - prev.calories : null;
            const caloriesPart = dCalories !== null ? dCalories / (dividerCount + 1) : null;
            let calories = prev.calories !== null ? prev.calories : null;
            const dElapsed =
              prev.elapsed !== null && r.elapsed !== null ? r.elapsed - prev.elapsed : null;
            const elapsedPart = dElapsed !== null ? truncDiv(dElapsed, dividerCount + 1) : null;
            let elapsed = prev.elapsed;

            for (let i = 0; i < dividerCount; i++) {
              time += timePart;
              const rClone = r.clone();
              rClone.timeStamp = new Date(time);
              if (elapsed !== null && elapsedPart !== null) {
                elapsed += elapsedPart;
                rClone.elapsed = elapsed;
              }
              if (distance !== null && distancePart !== null) {
                distance += distancePart;
                rClone.distance = distance;
              }
              if (calories !== null && caloriesPart !== null) {
                calories += caloriesPart;
                rClone.calories = Math.trunc(calories);
              }
              prepRecords.push(rClone);
            }
          }
        }
      }
    }

    prepRecords.push(r);

    for (const prepRecord of prepRecords) {
      const record = recordToExport(prepRecord, calculator, calculateGps, rawData);
      if (!rawData) {
        const rec = record.record;
        // cadence gap-fill
        if ((rec.speed ?? 0.0) > eps) {
          if (
            (rec.cadence === null || rec.cadence === 0) &&
            lastPositiveCadence > 0 &&
            cadenceGapWorkaround
          ) {
            rec.cadence = lastPositiveCadence;
          } else if (rec.cadence !== null && rec.cadence > 0) {
            lastPositiveCadence = rec.cadence;
          }
        }
        if (rec.heartRate === null && heartRateLimitingMethod === heartRateLimitingWriteZero) {
          rec.heartRate = 0;
        }
        // heart-rate gap-fill
        if (
          (rec.heartRate === 0 || rec.heartRate === null) &&
          lastPositiveHeartRate > 0 &&
          heartRateGapWorkaround === dataGapWorkaroundLastPositiveValue
        ) {
          rec.heartRate = lastPositiveHeartRate;
        } else if ((rec.heartRate ?? 0) > 0) {
          lastPositiveHeartRate = rec.heartRate as number;
        }
        // heart-rate upper-limit
        if (
          heartRateUpperLimit > 0 &&
          rec.heartRate !== null &&
          rec.heartRate > heartRateUpperLimit &&
          heartRateLimitingMethod !== heartRateLimitingNoLimit
        ) {
          rec.heartRate =
            heartRateLimitingMethod === heartRateLimitingCapAtLimit ? heartRateUpperLimit : 0;
        }
      }
      exportRecords.push(record);
    }

    previousRecord = r;
  }

  const version = opts.appVersion ?? '1.0.0';
  const versionParts = version.split('.');
  return new ExportModel({
    activity,
    rawData,
    calculateGps,
    descriptor,
    author: opts.author ?? 'Indoor Cycling',
    name: opts.appName ?? 'Indoor Cycling',
    swVersionMajor: versionParts[0] ?? '1',
    swVersionMinor: versionParts[1] ?? '0',
    buildVersionMajor: versionParts[2] ?? '0',
    buildVersionMinor: opts.buildNumber ?? '1',
    langID: opts.langID ?? 'en-US',
    partNumber: opts.partNumber ?? '0',
    altitude: track.altitude,
    exportTarget,
    records: exportRecords,
    heartRateGapWorkaround,
    heartRateUpperLimit,
    heartRateLimitingMethod,
    now: opts.now ?? new Date(),
  });
}
