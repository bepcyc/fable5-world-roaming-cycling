/**
 * Concept2 PM5 ergometer — fixed-layout, multi-characteristic.
 *
 * The primary characteristic (0x0031 General Status) carries only distance;
 * speed / stroke rate / HR / pace / calories / power arrive on companion
 * characteristics (0x0032, 0x0033, 0x0036) and are mergeBest-folded into one
 * sample (mergeConcept2). `hasFeatureFlags=false`, flagByteSize=1,
 * listenOnControl=false, manufacturer "Concept2".
 */

import { rawByte, shortValue, threeByteValue } from './MetricDescriptors';

// ---- GATT UUIDs (16-bit short form) ------------------------------------------

export const C2_DEVICE_INFO_SERVICE = 0x0010;
export const C2_DEVICE_INFO_CHR = {
  modelNumber: 0x0011,
  serialNumber: 0x0012,
  hardwareRevision: 0x0013,
  firmwareRevision: 0x0014,
  manufacturerName: 0x0015,
  ergMachineType: 0x0016,
} as const;

export const C2_CONTROL_SERVICE = 0x0020;
export const C2_CONTROL_CHR = {
  receive: 0x0021, // CSAFE frame in
  transmit: 0x0022, // CSAFE frame out
} as const;

export const C2_ERG_SERVICE = 0x0030;
export const C2_ERG_CHR = {
  generalStatus: 0x0031, // 19B — distance (primary)
  additionalStatus1: 0x0032, // 17B — speed/strokeRate/HR/pace
  additionalStatus2: 0x0033, // 20B — total calories
  statusSamplingRate: 0x0034,
  strokeData: 0x0035,
  additionalStrokeData: 0x0036, // 15B — stroke power
  splitIntervalData: 0x0037,
  additionalSplitIntervalData: 0x0038,
  workoutSummaryData: 0x0039,
  workoutAdditionalSummaryData: 0x003a,
  hrBeltInformation: 0x003b,
  forceCurveData: 0x003d,
  multiplexedInformation: 0x0080,
} as const;

export interface Concept2Sample {
  distanceM: number | null;
  speedKmh: number | null;
  /** stroke rate, spm (mapped to cadence) */
  cadenceRpm: number | null;
  heartRateBpm: number | null;
  /** seconds / 500m */
  paceS: number | null;
  caloriesKcal: number | null;
  powerW: number | null;
}

function empty(): Concept2Sample {
  return {
    distanceM: null,
    speedKmh: null,
    cadenceRpm: null,
    heartRateBpm: null,
    paceS: null,
    caloriesKcal: null,
    powerW: null,
  };
}

/** 0x0031 General Status (19B): distance = ThreeByte(3,5)/10 [m]. */
export function parseC2GeneralStatus(d: Uint8Array): Concept2Sample {
  const out = empty();
  if (d.length !== 19) return out;
  out.distanceM = threeByteValue(d, 3, 5, 10);
  return out;
}

/** 0x0032 Additional Status 1 (17B): speed = Short(3,4)/(1000/3.6) [km/h],
 *  strokeRate = data[5] [spm], heartRate = data[6] (null if 0 or ≥255),
 *  pace = Short(7,8)/100 [s/500m]. */
export function parseC2AdditionalStatus1(d: Uint8Array): Concept2Sample {
  const out = empty();
  if (d.length !== 17) return out;
  out.speedKmh = shortValue(d, 3, 4, 1000 / 3.6);
  out.cadenceRpm = rawByte(d, 5);
  const hr = rawByte(d, 6);
  out.heartRateBpm = hr !== null && hr > 0 && hr < 255 ? hr : null;
  out.paceS = shortValue(d, 7, 8, 100);
  return out;
}

/** 0x0033 Additional Status 2 (20B): calories = Short(6,7) [kcal]. */
export function parseC2AdditionalStatus2(d: Uint8Array): Concept2Sample {
  const out = empty();
  if (d.length !== 20) return out;
  out.caloriesKcal = shortValue(d, 6, 7);
  return out;
}

/** 0x0036 Additional Stroke Data (15B): power = Short(3,4) [W]. */
export function parseC2AdditionalStrokeData(d: Uint8Array): Concept2Sample {
  const out = empty();
  if (d.length !== 15) return out;
  out.powerW = shortValue(d, 3, 4);
  return out;
}

function bestOf(a: number | null, b: number | null, smaller: boolean): number | null {
  // mergeBest: take the LARGER of two positive values (SMALLER positive for
  // pace), else fill nulls from the other (mergeBest).
  if (a !== null && a > 0 && b !== null && b > 0) return smaller ? Math.min(a, b) : Math.max(a, b);
  if (a !== null && a > 0) return a;
  if (b !== null && b > 0) return b;
  return a ?? b;
}

/** mergeBest-fold the three companion characteristics into the primary sample
 *  pace taking the smaller positive. */
export function mergeConcept2(a: Concept2Sample, b: Concept2Sample): Concept2Sample {
  return {
    distanceM: bestOf(a.distanceM, b.distanceM, false),
    speedKmh: bestOf(a.speedKmh, b.speedKmh, false),
    cadenceRpm: bestOf(a.cadenceRpm, b.cadenceRpm, false),
    heartRateBpm: bestOf(a.heartRateBpm, b.heartRateBpm, false),
    paceS: bestOf(a.paceS, b.paceS, true),
    caloriesKcal: bestOf(a.caloriesKcal, b.caloriesKcal, false),
    powerW: bestOf(a.powerW, b.powerW, false),
  };
}
