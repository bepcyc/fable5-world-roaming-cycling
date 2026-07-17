/**
 * CsvImport — a TypeScript importer for the migration CSV format. Two modes,
 * decided by the first line:
 *
 *   - Migration  (magic `TMIW,{version},`): a previously exported CSV. Records
 *     are read straight through, one Record per data row.
 *   - MPower/Echelon2 (anything else): summary + power/rpm/hr/distance rows
 *     are RECONSTRUCTED into a full ~2 Hz time series — power→speed via the
 *     Cardano cubic, calories via extraCalorieFactor 3.9.
 *
 * Behavioural quirks of the format are preserved deliberately (each explained
 * inline) so files in the wild keep parsing byte-for-byte. This file has no DOM
 * and no side effects beyond returning an ImportedActivity; the Cardano
 * power-model and HR-calorie math (used only by MPower reconstruction) live
 * here because this importer is their only consumer.
 */

import type { ImportedActivity, ImportedRecord } from './types';

// ---- migration CSV format constants -----------------------------------------
// accepted migration-CSV signatures: the first is what our own CsvExport
// writes; the second is an opaque legacy signature accepted so existing
// files in the wild keep importing
const CSV_MAGICS = ['RIDE', 'TMIW'];
const CSV_VERSION = 5;
const RIDE_SUMMARY_TAG = 'RIDE SUMMARY';
const TOTAL_TIME_TAG = 'Total Time';
const TOTAL_DISTANCE_TAG = 'Total Distance';
const DEVICE_NAME_TAG = 'Device Name';
const DEVICE_ID_TAG = 'Device ID';
const HRM_ID_TAG = 'HRM ID';
const START_TIME_TAG = 'Start Time';
const END_TIME_TAG = 'End Time';
const CALORIES_TAG = 'CAL';
const STRIDES_TAG = 'Strides';
const UPLOADED_TAG = 'Uploaded';
const STRAVA_ID_TAG = 'Strava ID';
const FOUR_CC_TAG = 'Four CC';
const SPORT_TAG = 'Sport';
const POWER_FACTOR_TAG = 'Power Factor';
const CALORIE_FACTOR_TAG = 'Calorie Factor';
const HR_CALORIE_FACTOR_TAG = 'HR Calorie Factor';
const HRM_CALORIE_FACTOR_TAG = 'HRM Calorie Factor';
const HR_BASED_CALORIES_TAG = 'HR Based Calories';
const TIME_ZONE_TAG = 'Time Zone';
const SUUNTO_UPLOADED_TAG = 'SUUNTO Uploaded';
const SUUNTO_BLOB_URL_TAG = 'SUUNTO Blob Url';
const SUUNTO_WORKOUT_URL_TAG = 'SUUNTO Workout Url';
const SUUNTO_UPLOAD_ID_TAG = 'SUUNTO Upload Id';
const UNDER_ARMOUR_UPLOADED_TAG = 'Under Armour Uploaded';
const UA_WORKOUT_ID_TAG = 'Under Armour Workout Id';
const TRAINING_PEAKS_UPLOADED_TAG = 'Training Peaks Uploaded';
const TP_FILE_TRACKING_UUID_TAG = 'training_peaks_file_tracking_uuid';
const TP_ATHLETE_ID_TAG = 'training_peaks_athlete_id';
const TP_WORKOUT_ID_TAG = 'training_peaks_workout_id';
const MINUTES_UNIT_TAG = 'Minutes';
const HOURS_UNIT_TAG = 'Hours';
const MILE_UNIT_TAG = 'MI';
const KM_UNIT_TAG = 'KM';
const METER_UNIT_TAG = 'M';
const RIDE_DATA_TAG = 'RIDE DATA';
const POWER_HEADER_TAG = 'Power';
const RPM_HEADER_TAG = 'RPM';
const HR_HEADER_TAG = 'HR';
const DISTANCE_HEADER_TAG = 'DISTANCE';
const TIME_STAMP_TAG = 'TIME_STAMP';
const ELAPSED_TAG = 'ELAPSED';
const SPEED_TAG = 'SPEED';
const MOVING_TIME_TAG = 'Moving Time';

const MPOWER_IMPORT_DEVICE_ID = 'MPowerImport'; // device id for reconstructed MPower imports
const SCHWINN_AC_PERF_PLUS_FOURCC = 'SAP+'; // Schwinn AC Performance Plus descriptor code
const SCHWINN_DEVICE_NAME = 'Schwinn AC Perf+'; // display name for the Schwinn AC Performance Plus
const SCHWINN_SPORT = 'Ride'; // default sport for the Schwinn descriptor
const SCHWINN_CAN_MEASURE_CALORIES = true; // the Schwinn AC Performance Plus reports calories directly
const EXTRA_CALORIE_FACTOR = 3.9; // extra calorie multiplier for the Schwinn AC Performance Plus
const POWER_CALORIE_FACTOR_DEFAULT = 4.0; // default power→calorie factor when a device can't measure calories

const MAX_PROGRESS_STEPS = 400; // max progress callbacks emitted during a long import
const TIME_RESOLUTION_FACTOR = 2; // reconstruction resolution: 2 records per second
const MS2KMH = 3.6; // m/s → km/h
const J_TO_KCAL = 0.239006 / 1000; // joules → kilocalories
const MI2KM = 1 / 0.621371; // miles → kilometers ≈ 1.609344

// HR gap / limiting selector values
const GAP_LAST_POSITIVE = 'last_positive_value';
const HR_LIMIT_NO_LIMIT = 'no_limit';
const HR_LIMIT_CAP = 'cap_at_limit';

// athlete / physics preference gates
const ATHLETE_BODY_WEIGHT_MIN = 1;
const ATHLETE_AGE_MIN = 0;
const VO2MAX_MIN = 15;

/**
 * Preference-backed knobs for the importer. Defaults are the out-of-the-box
 * values, so a bare `importCsv(text)` reproduces standard behaviour. Only
 * MPower reconstruction consumes most of these (migration reads records
 * straight through).
 */
export interface CsvImportOptions {
  extendTuning: boolean; // default false
  heartRateGapWorkaround: string; // default 'last_positive_value'
  heartRateUpperLimit: number; // default 0 (off)
  heartRateLimitingMethod: string; // default 'no_limit'
  useHeartRateBasedCalorieCounting: boolean; // default false
  athleteBodyWeight: number; // default 80 kg
  athleteAge: number; // default 30 yr
  athleteGenderMale: boolean; // default male
  athleteVO2Max: number; // default 15
  /** MPower power factor, default 1.0 */
  powerFactor: number;
  /** MPower calorie factor, default 1.0 */
  calorieFactor: number;
  /** MPower hr-calorie factor, default 1.0 */
  hrCalorieFactor: number;
  /** timeZone when the CSV carries none (MPower path); defaults to device tz */
  timeZone: string;
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function defaultOptions(): CsvImportOptions {
  return {
    extendTuning: false,
    heartRateGapWorkaround: GAP_LAST_POSITIVE,
    heartRateUpperLimit: 0,
    heartRateLimitingMethod: HR_LIMIT_NO_LIMIT,
    useHeartRateBasedCalorieCounting: false,
    athleteBodyWeight: 80,
    athleteAge: 30,
    athleteGenderMale: true,
    athleteVO2Max: 15,
    powerFactor: 1.0,
    calorieFactor: 1.0,
    hrCalorieFactor: 1.0,
    timeZone: defaultTimeZone(),
  };
}

// ---- numeric parse helpers (whole-string integer / double, else null) -------

/** whole-string base-10 integer parse; returns null on anything else. */
function intTryParse(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!/^[+-]?[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** whole-string finite double parse; returns null on anything else. */
function doubleTryParse(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === '') return null;
  // Leading/trailing whitespace is already trimmed above; CSV values are plain
  // decimals, so reject anything Number() cannot turn into a finite value.
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** digits-only test — matches `^\d+$` (no sign, no decimal point). */
function isNumericOnly(s: string): boolean {
  return /^[0-9]+$/.test(s);
}

// ---- Cardano power↔speed model ----------------------------------------------
// Constants use the standard defaults (80 kg athlete, 9 kg bike, 15 °C air, etc.).
const PS_G = 9.8067;
const PS_ATHLETE_WEIGHT = 80;
const PS_BIKE_WEIGHT = 9;
const PS_ROLLING_RESISTANCE = 0.005;
const PS_DRAG_COEFF = 0.63;
const PS_FRONTAL_AREA = 0.509;
const PS_AIR_DENSITY = 1.226; // airDensityDefault @ 15 °C
const PS_DRAG_FORCE_TUNE = 1.0; // dragForceTuneDefault=100%
const PS_DRIVETRAIN_LOSS = 2; // driveTrainLossDefault=2%
const PS_A = 0.5 * PS_FRONTAL_AREA * PS_DRAG_COEFF * PS_AIR_DENSITY * PS_DRAG_FORCE_TUNE;
const PS_C = PS_G * (PS_ATHLETE_WEIGHT + PS_BIKE_WEIGHT) * PS_ROLLING_RESISTANCE;
const PS_Q = PS_C / (3 * PS_A);
const PS_DRIVETRAIN_FRACTION = 1.0 - PS_DRIVETRAIN_LOSS / 100.0;

/** sign-preserving cube root (Math.pow rejects negative bases, so guard). */
function signedCbrt(x: number): number {
  return x > 0 ? Math.pow(x, 1 / 3) : -Math.pow(-x, 1 / 3);
}

const velocityForPowerCache = new Map<number, number>();

/**
 * velocityForPowerCardano (m/s) — Cardano root of `a·v³ + c·v = frac·power`.
 * sportFactor is NOT applied (ride model). Memoized per integer power.
 */
function velocityForPowerCardano(power: number): number {
  const cached = velocityForPowerCache.get(power);
  if (cached !== undefined) return cached;
  const dNeg = PS_DRIVETRAIN_FRACTION * power;
  const r = dNeg / (2 * PS_A);
  const e = Math.sqrt(PS_Q * PS_Q * PS_Q + r * r);
  const s = signedCbrt(r + e);
  const t = signedCbrt(r - e);
  const speed = s + t;
  velocityForPowerCache.set(power, speed);
  return speed;
}

/**
 * hrBasedCaloriesPerMinute (kcal/min). weight kg, age yr.
 */
function hrBasedCaloriesPerMinute(
  heartRate: number,
  weight: number,
  age: number,
  isMale: boolean,
  vo2Max: number,
): number {
  if (vo2Max > VO2MAX_MIN) {
    if (isMale) {
      return (
        (-59.3954 + (-36.3781 + 0.271 * age + 0.394 * weight + 0.404 * vo2Max + 0.634 * heartRate)) /
        4.184
      );
    }
    return (-59.3954 + (0.274 * age + 0.103 * weight + 0.38 * vo2Max + 0.45 * heartRate)) / 4.184;
  }
  if (isMale) {
    return (-55.0969 + 0.6309 * heartRate + 0.1988 * weight + 0.2017 * age) / 4.184;
  }
  return (-20.4022 + 0.4472 * heartRate - 0.1263 * weight + 0.074 * age) / 4.184;
}

// ---- WorkoutRow -------------------------------------------------------------

interface WorkoutRowArgs {
  rowString: string;
  lastHeartRate: number;
  heartRateGapWorkaround: boolean;
  heartRateUpperLimit: number;
  heartRateLimitingMethod: string;
  tuneRatio: number;
  extendTuning: boolean;
}

class WorkoutRow {
  power = 0;
  cadence = 0;
  heartRate = 0;
  distance = 0.0;

  constructor(args: WorkoutRowArgs) {
    const {
      rowString,
      lastHeartRate,
      heartRateGapWorkaround,
      heartRateUpperLimit,
      heartRateLimitingMethod,
      tuneRatio,
      extendTuning,
    } = args;
    if (rowString.length > 0) {
      const values = rowString.split(',');
      // Precedence quirk kept for byte/behaviour compatibility: in the expression
      // `(intTryParse(values[0]) ?? 0 * tuneRatio).round()`, `*` binds tighter than
      // `??`, so tuneRatio multiplies ONLY the 0 fallback, never the parsed power.
      // Power therefore stays untuned here.
      const p = intTryParse(values[0]);
      this.power = Math.round(p !== null ? p : 0 * tuneRatio);
      this.cadence = intTryParse(values[1]) ?? 0;
      this.heartRate = intTryParse(values[2]) ?? 0;
      if (this.heartRate === 0 && lastHeartRate > 0 && heartRateGapWorkaround) {
        this.heartRate = lastHeartRate;
      } else if (
        heartRateUpperLimit > 0 &&
        this.heartRate > heartRateUpperLimit &&
        heartRateLimitingMethod !== HR_LIMIT_NO_LIMIT
      ) {
        this.heartRate = heartRateLimitingMethod === HR_LIMIT_CAP ? heartRateUpperLimit : 0;
      }
      const d = doubleTryParse(values[3]) ?? 0.0;
      this.distance = d * (extendTuning ? tuneRatio : 1.0);
    }
  }

  isMoving(): boolean {
    return this.power > 0 || this.cadence > 0;
  }
}

// ---- the importer -----------------------------------------------------------

export type SetProgress = (fraction: number) => void;

/**
 * The CSV importer. `start` seeds the workout time for MPower files (which
 * carry no absolute start); migration files override it from the `Start Time`
 * row. Call `import()`; on failure it returns null and sets `message` to a
 * diagnostic string.
 */
export class CsvImporter {
  start: Date | null;
  end: Date | null = null;
  message = '';

  private lines: string[] = [];
  private linePointer = 0;
  private migration = false;
  private version = CSV_VERSION;
  private readonly opts: CsvImportOptions;

  constructor(start: Date | null, opts?: Partial<CsvImportOptions>) {
    this.start = start;
    this.opts = { ...defaultOptions(), ...(opts ?? {}) };
  }

  /**
   * Advance to the first line starting with `lead`. NOTE the quirk — this
   * returns `linePointer <= lines.length`, i.e. ALWAYS true, so the
   * `if (!findLine(...))` guards can never fail and a missing section instead
   * surfaces later as an out-of-range access. Kept for behaviour compatibility;
   * that out-of-range access is caught by import()'s try/catch (→ null +
   * message), which produces the expected "import failed" outcome.
   */
  private findLine(lead: string): boolean {
    while (this.linePointer < this.lines.length && !this.lines[this.linePointer]!.startsWith(lead)) {
      this.linePointer++;
    }
    return this.linePointer <= this.lines.length;
  }

  private lineCols(): string[] {
    const line = this.lines[this.linePointer];
    if (line === undefined) {
      // An out-of-range line would throw here; convert it to the null-return contract.
      throw new CsvImportError('Unexpected end of CSV content');
    }
    return line.split(',');
  }

  import(csv: string, setProgress?: SetProgress): ImportedActivity | null {
    const progress: SetProgress = setProgress ?? (() => {});
    try {
      return this.importInner(csv, progress);
    } catch (err) {
      if (err instanceof CsvImportError) {
        this.message = err.message;
        return null;
      }
      // Malformed input surfaces as an unhandled exception → import fails.
      this.message = this.message || 'Malformed CSV content';
      return null;
    }
  }

  private importInner(csv: string, setProgress: SetProgress): ImportedActivity | null {
    // Split on \n, \r, or \r\n; a trailing newline is dropped (see splitLines).
    this.lines = splitLines(csv);
    if (this.lines.length < 20) {
      this.message = 'Content too short';
      return null;
    }

    this.migration = false;
    this.linePointer = 0;
    const firstLine = this.lines[0]!.split(',');
    if (firstLine.length > 1) {
      if (!CSV_MAGICS.includes(firstLine[0]!)) {
        if (firstLine[0]!.length > 0) {
          this.message = 'Cannot recognize migration CSV magic';
          return null;
        }
      } else {
        if (!isNumericOnly(firstLine[1]!)) {
          this.message = 'CSV version number is not an integer';
          return null;
        }
        this.migration = true;
        this.version = parseInt(firstLine[1]!, 10);
      }
    }

    if (!this.findLine(RIDE_SUMMARY_TAG)) {
      this.message = `Cannot locate ${RIDE_SUMMARY_TAG}`;
      return null;
    }

    // Total Time
    if (!this.findLine(TOTAL_TIME_TAG)) {
      this.message = `Couldn't find ${TOTAL_TIME_TAG}`;
      return null;
    }
    const timeLine = this.lineCols();
    const timeValue = doubleTryParse(timeLine[1]);
    if (timeValue === null) {
      this.message = `Couldn't parse ${TOTAL_TIME_TAG}`;
      return null;
    }
    let totalElapsed = Math.round(timeValue); // seconds by default
    if ((timeLine[2] ?? '').trim() === MINUTES_UNIT_TAG) {
      totalElapsed = Math.round(timeValue * 60);
    } else if ((timeLine[2] ?? '').trim() === HOURS_UNIT_TAG) {
      totalElapsed = Math.round(timeValue * 3600);
    }

    // Total Distance
    if (!this.findLine(TOTAL_DISTANCE_TAG)) {
      this.message = `Couldn't find ${TOTAL_DISTANCE_TAG}`;
      return null;
    }
    const distanceLine = this.lineCols();
    const distanceValue = doubleTryParse(distanceLine[1]);
    if (distanceValue === null) {
      this.message = `Couldn't parse ${TOTAL_DISTANCE_TAG}`;
      return null;
    }
    let totalDistance = 0.0;
    const distUnit = (distanceLine[2] ?? '').trim();
    if (distUnit === MILE_UNIT_TAG) {
      totalDistance = distanceValue * 1000 * MI2KM;
    } else if (distUnit === KM_UNIT_TAG) {
      totalDistance = distanceValue * 1000;
    } else if (distUnit === METER_UNIT_TAG) {
      totalDistance = distanceValue;
    }

    // ---- summary header block --------------------------------------------
    let deviceName = '';
    let deviceId = MPOWER_IMPORT_DEVICE_ID;
    let hrmId = '';
    let calories = 0;
    let strides = 0;
    let fourCC = SCHWINN_AC_PERF_PLUS_FOURCC;
    let sport = SCHWINN_SPORT;
    let calorieFactor = 1.0;
    let hrCalorieFactor = 1.0;
    let hrmCalorieFactor = 1.0;
    let hrBasedCalories = false;
    let powerFactor = 1.0;
    let timeZone = this.opts.timeZone;
    let endTime = 0;
    let movingTime = 0;

    if (this.migration) {
      this.linePointer++;
      deviceName = this.expectTag(DEVICE_NAME_TAG)[1]?.trim() ?? '';
      this.linePointer++;
      deviceId = this.expectTag(DEVICE_ID_TAG)[1]?.trim() ?? '';
      this.linePointer++;
      const startTimeLine = this.expectTag(START_TIME_TAG);
      const startTime = intTryParse(startTimeLine[1]) ?? 0;
      if (startTime === 0) {
        this.message = `Couldn't parse ${START_TIME_TAG}`;
        return null;
      }
      this.start = new Date(startTime);
      this.linePointer++;
      const endTimeLine = this.expectTag(END_TIME_TAG);
      endTime = intTryParse(endTimeLine[1]) ?? 0;
      if (endTime === 0) {
        // Unfinished activity: the field was written with `endTime == startTime +
        // 1000*...`, using `==` (a no-op comparison, NOT an assignment) — a real
        // bug kept for compatibility, so endTime stays 0 and end below becomes
        // epoch 0. It is corrected at the tail from the last record's timestamp.
        if (totalElapsed > 0) {
          // endTime == startTime + 1000 * totalElapsed;  (no-op comparison, preserved)
        } else {
          this.message = `Couldn't parse ${END_TIME_TAG}`;
          return null;
        }
      }
      this.end = new Date(endTime);
      this.linePointer++;
      calories = intTryParse(this.expectTag(CALORIES_TAG)[1]) ?? 0;
      this.linePointer++;
      if (this.version >= 5) {
        strides = intTryParse(this.expectTag(STRIDES_TAG)[1]) ?? 0;
        this.linePointer++;
      }
      this.expectTag(UPLOADED_TAG); // uploaded — parsed & discarded
      this.linePointer++;
      this.expectTag(STRAVA_ID_TAG); // stravaId — parsed & discarded
      this.linePointer++;
      fourCC = this.expectTag(FOUR_CC_TAG)[1]?.trim() ?? '';
      this.linePointer++;
      sport = this.expectTag(SPORT_TAG)[1]?.trim() ?? '';
      this.linePointer++;
      powerFactor = doubleTryParse(this.expectTag(POWER_FACTOR_TAG)[1]) ?? 1.0;
      this.linePointer++;
      calorieFactor = doubleTryParse(this.expectTag(CALORIE_FACTOR_TAG)[1]) ?? 1.0;
      this.linePointer++;
      if (this.version > 1) {
        hrCalorieFactor = doubleTryParse(this.expectTag(HR_CALORIE_FACTOR_TAG)[1]) ?? 1.0;
        this.linePointer++;
        hrmCalorieFactor = doubleTryParse(this.expectTag(HRM_CALORIE_FACTOR_TAG)[1]) ?? 1.0;
        this.linePointer++;
        hrmId = this.expectTag(HRM_ID_TAG)[1]?.trim() ?? '';
        this.linePointer++;
        hrBasedCalories = (this.expectTag(HR_BASED_CALORIES_TAG)[1] ?? '').trim().toLowerCase() === 'true';
        this.linePointer++;
        timeZone = this.expectTag(TIME_ZONE_TAG)[1]?.trim() ?? '';
        this.linePointer++;
        this.expectTag(SUUNTO_UPLOADED_TAG);
        this.linePointer++;
        this.expectTag(SUUNTO_BLOB_URL_TAG);
        this.linePointer++;
        this.expectTag(SUUNTO_WORKOUT_URL_TAG);
        this.linePointer++;
        this.expectTag(SUUNTO_UPLOAD_ID_TAG);
        this.linePointer++;
        this.expectTag(UNDER_ARMOUR_UPLOADED_TAG);
        this.linePointer++;
        this.expectTag(UA_WORKOUT_ID_TAG);
        this.linePointer++;
        this.expectTag(TRAINING_PEAKS_UPLOADED_TAG);
        this.linePointer++;
        if (this.version < 4) {
          this.expectTag(TP_ATHLETE_ID_TAG);
        } else {
          this.expectTag(TP_FILE_TRACKING_UUID_TAG);
        }
        this.linePointer++;
        this.expectTag(TP_WORKOUT_ID_TAG);
        this.linePointer++;
      }
      if (this.version > 2) {
        movingTime = intTryParse(this.expectTag(MOVING_TIME_TAG)[1]) ?? 0;
        this.linePointer++;
      }
    } else {
      // MPower path — synthesize summary fields from the Schwinn descriptor.
      fourCC = SCHWINN_AC_PERF_PLUS_FOURCC;
      deviceName = SCHWINN_DEVICE_NAME;
      sport = SCHWINN_SPORT;
      // per-device factors (power, calorie, hr-calorie) — default 1.0
      calorieFactor =
        this.opts.calorieFactor * (SCHWINN_CAN_MEASURE_CALORIES ? 1.0 : POWER_CALORIE_FACTOR_DEFAULT);
      hrCalorieFactor = this.opts.hrCalorieFactor;
      hrBasedCalories = this.opts.useHeartRateBasedCalorieCounting;
      powerFactor = this.opts.powerFactor;
      if (this.start === null) {
        // Not recognized as migration data; assume now() as the start.
        this.start = new Date();
      }
      this.end = new Date(this.start.getTime() + totalElapsed * 1000);
    }

    if (movingTime === 0 && totalElapsed > 0) {
      movingTime = totalElapsed * 1000;
    }

    if (!this.findLine(RIDE_DATA_TAG)) {
      this.message = `Cannot locate ${RIDE_DATA_TAG}`;
      return null;
    }
    this.linePointer++;
    const rideDataHeader = this.lineCols();
    if (
      (rideDataHeader[0] ?? '').trim() !== POWER_HEADER_TAG ||
      (rideDataHeader[1] ?? '').trim() !== RPM_HEADER_TAG ||
      (rideDataHeader[2] ?? '').trim() !== HR_HEADER_TAG ||
      (rideDataHeader[3] ?? '').trim() !== DISTANCE_HEADER_TAG
    ) {
      this.message = 'Unexpected detailed ride data format';
      return null;
    }
    if (
      this.migration &&
      ((rideDataHeader[4] ?? '').trim() !== TIME_STAMP_TAG ||
        (rideDataHeader[5] ?? '').trim() !== ELAPSED_TAG ||
        (rideDataHeader[6] ?? '').trim() !== SPEED_TAG ||
        (rideDataHeader[7] ?? '').trim() !== CALORIES_TAG)
    ) {
      this.message = 'Unexpected detailed ride data format';
      return null;
    }

    const activity: ImportedActivity = {
      deviceName,
      deviceId,
      hrmId,
      startMs: (this.start ?? new Date()).getTime(),
      endMs: this.end ? this.end.getTime() : null,
      distance: totalDistance,
      elapsed: totalElapsed,
      movingTime,
      calories,
      strides,
      sport,
      fourCC,
      powerFactor,
      calorieFactor,
      hrCalorieFactor,
      hrmCalorieFactor,
      hrBasedCalories,
      timeZone,
      source: this.migration ? 'csv-migration' : 'csv-mpower',
      records: [],
    };

    const extendTuning = this.opts.extendTuning;

    // Quirk: numRow is taken with linePointer AT the header row (before the ++
    // below), so it counts the header line too — a deliberate off-by-one that
    // feeds secondsPerRow and the progress denominator. Kept for compatibility.
    const numRow = this.lines.length - this.linePointer;
    this.linePointer++;

    if (this.migration) {
      this.importMigrationRecords(activity, numRow, endTime, setProgress);
    } else {
      this.importMPowerRecords(activity, numRow, totalElapsed, powerFactor, calorieFactor, hrCalorieFactor, hrBasedCalories, extendTuning, setProgress);
    }

    return activity;
  }

  /** expect the current line's tag (col0) to equal `tag`, else fail the import. */
  private expectTag(tag: string): string[] {
    const cols = this.lineCols();
    if ((cols[0] ?? '').trim() !== tag) {
      throw new CsvImportError(`Couldn't parse ${tag}`);
    }
    return cols;
  }

  // ---- migration record reconstruction -------------------------------------
  private importMigrationRecords(
    activity: ImportedActivity,
    numRow: number,
    endTime: number,
    setProgress: SetProgress,
  ): void {
    const progressSteps = Math.trunc(numRow / MAX_PROGRESS_STEPS);
    let progressCounter = 0;
    let recordCounter = 0;
    let lastTimeStamp = 0;

    while (this.linePointer < this.lines.length) {
      const values = this.lines[this.linePointer]!.split(',');
      const timeStampInt = intTryParse(values[4]);
      let timeStampMs: number | null = null;
      if (timeStampInt !== null) {
        timeStampMs = timeStampInt;
        lastTimeStamp = timeStampInt;
      }
      // Migration reads col6 (SPEED, exported as m/s) straight into Record.speed,
      // whose declared unit is km/h — a latent unit mismatch in the format's own
      // round-trip, preserved for compatibility.
      const record: ImportedRecord = {
        timeStampMs,
        distance: doubleTryParse(values[3]),
        elapsed: intTryParse(values[5]),
        elapsedMillis: null,
        calories: intTryParse(values[7]),
        power: intTryParse(values[0]),
        speed: doubleTryParse(values[6]),
        cadence: intTryParse(values[1]),
        heartRate: intTryParse(values[2]),
      };
      activity.records.push(record);

      this.linePointer++;
      recordCounter++;
      progressCounter++;
      if (progressSteps > 0 && progressCounter === progressSteps) {
        progressCounter = 0;
        setProgress(recordCounter / numRow);
      }
    }

    // Adjust end if this was an unfinished workout (masks the endTime==0 bug).
    if (lastTimeStamp > 0 && lastTimeStamp > endTime) {
      activity.endMs = lastTimeStamp;
    }
  }

  // ---- MPower reconstruction -----------------------------------------------
  private importMPowerRecords(
    activity: ImportedActivity,
    numRow: number,
    totalElapsed: number,
    powerFactor: number,
    calorieFactor: number,
    hrCalorieFactor: number,
    hrBasedCalories: boolean,
    extendTuning: boolean,
    setProgress: SetProgress,
  ): void {
    const secondsPerRow = totalElapsed / numRow;
    const milliSecondsPerRow = Math.round(secondsPerRow * 1000);
    const secondsPerRowInt = Math.round(secondsPerRow);
    const recordsPerRow = secondsPerRowInt * TIME_RESOLUTION_FACTOR;
    const milliSecondsPerRecord = (secondsPerRow * 1000) / recordsPerRow;
    const milliSecondsPerRecordInt = Math.round(milliSecondsPerRecord);

    const recordCount = numRow * recordsPerRow;
    const progressSteps = Math.trunc(recordCount / MAX_PROGRESS_STEPS);
    let progressCounter = 0;
    let recordCounter = 0;
    let movingTimeMillis = 0;
    let energy = 0;
    let strides = 0;
    let distance = 0;
    let elapsed = 0; // ms (double)
    let nextRow: WorkoutRow | null = null;
    let lastHeartRate = 0;
    let timeStampMs = (this.start ?? new Date()).getTime();

    const gapWorkaround = this.opts.heartRateGapWorkaround === GAP_LAST_POSITIVE;
    const heartRateUpperLimit = this.opts.heartRateUpperLimit;
    const heartRateLimitingMethod = this.opts.heartRateLimitingMethod;
    const weight = this.opts.athleteBodyWeight;
    const age = this.opts.athleteAge;
    const isMale = this.opts.athleteGenderMale;
    const vo2Max = this.opts.athleteVO2Max;
    const useHrBasedCalorieCounting =
      hrBasedCalories && weight > ATHLETE_BODY_WEIGHT_MIN && age > ATHLETE_AGE_MIN;

    while (this.linePointer < this.lines.length) {
      const row: WorkoutRow =
        nextRow ??
        new WorkoutRow({
          rowString: this.lines[this.linePointer]!,
          lastHeartRate,
          heartRateGapWorkaround: gapWorkaround,
          heartRateUpperLimit,
          heartRateLimitingMethod,
          tuneRatio: powerFactor,
          extendTuning,
        });

      if (this.linePointer + 1 >= this.lines.length) {
        nextRow = new WorkoutRow({
          rowString: '',
          lastHeartRate,
          heartRateGapWorkaround: gapWorkaround,
          heartRateUpperLimit,
          heartRateLimitingMethod,
          tuneRatio: 1.0,
          extendTuning,
        });
      } else {
        nextRow = new WorkoutRow({
          rowString: this.lines[this.linePointer + 1]!,
          lastHeartRate,
          heartRateGapWorkaround: gapWorkaround,
          heartRateUpperLimit,
          heartRateLimitingMethod,
          tuneRatio: powerFactor,
          extendTuning,
        });
      }

      const dPower = (nextRow.power - row.power) / recordsPerRow;
      const dCadence = (nextRow.cadence - row.cadence) / recordsPerRow;
      const dHeartRate = (nextRow.heartRate - row.heartRate) / recordsPerRow;
      let power = row.power;
      let cadence = row.cadence;
      let heartRate = row.heartRate;
      lastHeartRate = row.heartRate;

      for (let i = 0; i < recordsPerRow; i++) {
        const powerInt = Math.round(power);
        const speed = velocityForPowerCardano(powerInt); // m/s
        const dDistance = (speed * milliSecondsPerRecord) / 1000;

        activity.records.push({
          timeStampMs,
          distance,
          elapsed: Math.trunc(elapsed / 1000),
          elapsedMillis: Math.round(elapsed),
          calories: Math.round(energy),
          power: powerInt,
          speed: speed * MS2KMH, // km/h
          cadence: Math.round(cadence),
          heartRate: Math.round(heartRate),
        });

        distance += dDistance;
        let dEnergy = 0.0;
        if (useHrBasedCalorieCounting && row.heartRate > 0) {
          dEnergy =
            (hrBasedCaloriesPerMinute(row.heartRate, weight, age, isMale, vo2Max) *
              milliSecondsPerRecord) /
            (1000 * 60) *
            hrCalorieFactor;
        } else {
          dEnergy =
            (power * milliSecondsPerRecord) / 1000 * J_TO_KCAL * calorieFactor * EXTRA_CALORIE_FACTOR;
        }
        energy += dEnergy;
        strides += (cadence * milliSecondsPerRecord) / (1000 * 60);

        timeStampMs += milliSecondsPerRecordInt;
        elapsed += milliSecondsPerRecord;
        power += dPower;
        cadence += dCadence;
        heartRate += dHeartRate;

        recordCounter++;
        progressCounter++;
        if (progressSteps > 0 && progressCounter === progressSteps) {
          progressCounter = 0;
          setProgress(recordCounter / recordCount);
        }
      }

      if (row.isMoving()) {
        movingTimeMillis += milliSecondsPerRow;
      }

      this.linePointer++;
    }

    activity.movingTime = movingTimeMillis;
    activity.distance = distance;
    activity.calories = Math.round(energy);
    activity.strides = Math.round(strides);
  }
}

/** internal control-flow error carrying a diagnostic string. */
class CsvImportError extends Error {}

/** Split on \n / \r / \r\n; a single trailing line terminator is dropped. */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\n') {
      out.push(cur);
      cur = '';
    } else if (ch === '\r') {
      out.push(cur);
      cur = '';
      if (s[i + 1] === '\n') i++;
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** convenience: one-shot import with defaults. */
export function importCsv(
  csv: string,
  start: Date | null = null,
  opts?: Partial<CsvImportOptions>,
  setProgress?: SetProgress,
): { activity: ImportedActivity | null; message: string } {
  const importer = new CsvImporter(start, opts);
  const activity = importer.import(csv, setProgress);
  return { activity, message: importer.message };
}
