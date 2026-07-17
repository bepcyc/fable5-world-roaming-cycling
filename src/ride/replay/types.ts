/**
 * Imported-activity data model for the replay stack.
 *
 * A self-contained Record/Activity shape kept LOCAL to src/ride/replay —
 * deliberately NOT importing from src/ride/session/Model.ts (that module is
 * authored by another wave and may not exist yet). Unit conventions:
 *   distance  meters (cumulative)      speed     km/h (instantaneous)
 *   elapsed   seconds (cumulative)     cadence   rpm
 *   calories  kcal (cumulative)        heartRate bpm
 *   power     watts (instantaneous)    timeStamp ms since epoch
 *
 * `null` means "this source has no such channel for this sample" — every
 * per-sample channel is independently nullable.
 */

/** one imported time sample */
export interface ImportedRecord {
  /** wall-clock timestamp, ms since Unix epoch */
  timeStampMs: number | null;
  /** cumulative distance, meters */
  distance: number | null;
  /** cumulative elapsed, seconds */
  elapsed: number | null;
  /** cumulative elapsed, milliseconds (finer-grained companion to `elapsed`) */
  elapsedMillis: number | null;
  /** cumulative calories, kcal */
  calories: number | null;
  /** instantaneous power, watts */
  power: number | null;
  /** instantaneous speed, km/h (see CsvImport migration unit quirk) */
  speed: number | null;
  /** cadence, rpm */
  cadence: number | null;
  /** heart rate, bpm */
  heartRate: number | null;
  /** synthetic/real latitude, degrees (FIT only; CSV imports carry none) */
  lat?: number | null;
  /** synthetic/real longitude, degrees (FIT only) */
  lon?: number | null;
  /** altitude, meters (FIT only) */
  altitude?: number | null;
}

/** how an activity was imported — for badging / diagnostics */
export type ImportSource = 'csv-migration' | 'csv-mpower' | 'fit';

/** one imported workout plus its records */
export interface ImportedActivity {
  deviceName: string;
  deviceId: string;
  hrmId: string;
  /** workout start, ms since epoch */
  startMs: number;
  /** workout end, ms since epoch; null = unfinished */
  endMs: number | null;
  /** total distance, meters */
  distance: number;
  /** total elapsed, seconds */
  elapsed: number;
  /** total moving time, milliseconds */
  movingTime: number;
  /** total calories, kcal */
  calories: number;
  /** total strides/strokes/revs */
  strides: number;
  /** ActivityType string, e.g. "Ride" */
  sport: string;
  /** device descriptor code, e.g. "SAP+" */
  fourCC: string;
  powerFactor: number;
  calorieFactor: number;
  hrCalorieFactor: number;
  hrmCalorieFactor: number;
  hrBasedCalories: boolean;
  /** IANA time zone, e.g. "Europe/Berlin" */
  timeZone: string;
  source: ImportSource;
  records: ImportedRecord[];
}
