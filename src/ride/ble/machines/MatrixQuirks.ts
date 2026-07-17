/**
 * Vendor FTMS quirk parsers — devices that VIOLATE the FTMS field layout for a
 * specific flag+length and must be parsed with a bespoke bit sequence, falling
 * back to the standard machine parser otherwise (Matrix bike/treadmill, Mr
 * Captain rower, CardioStrong IB50, NPE Runn treadmill).
 *
 * Matrix machines are resolved ONLY via the company-ID special treatment
 * (companyIds ∋ 859 Matrix Inc OR 1988 Johnson Health Tech) — see
 * DeviceResolver + needsMatrixSpecialTreatment below.
 */

import { bytesOf, shortValue } from './MetricDescriptors';
import {
  advanceFlag,
  finalize,
  makeBuilder,
  parseIndoorBike,
  parseRower,
  parseTreadmill,
  processCadence,
  processElapsedTime,
  processExpandedEnergy,
  processHeartRate,
  processPaceRower,
  processPower,
  processResistance,
  processSpeed,
  processStrokeRate,
  processTotalDistance,
  readFlag,
  skipField,
  type FtmsBuilder,
  type MachineRecord,
} from './FtmsMachines';

/** company ids: Matrix Inc = 859, Johnson Health Tech = 1988. */
export const MATRIX_INC_COMPANY_ID = 859;
export const JOHNSON_HEALTH_TECH_COMPANY_ID = 1988;

/** Matrix bikes/treadmills
 *  advertise ambiguous names (CTM/Johnson/Matrix) and are resolved only by
 *  company id + advertised machineType, never by the name-prefix loop. */
export function needsMatrixSpecialTreatment(companyIds: readonly number[]): boolean {
  return companyIds.includes(MATRIX_INC_COMPANY_ID) || companyIds.includes(JOHNSON_HEALTH_TECH_COMPANY_ID);
}

// Matrix bike violation flags: 29*256+254, 21*256+254 at length 20.
const MATRIX_BIKE_FLAGS = new Set([29 * 256 + 254, 21 * 256 + 254]);
// Matrix treadmill violation flags: 31*256+158, 27*256+158 at length 20.
const MATRIX_TREADMILL_FLAGS = new Set([31 * 256 + 158, 27 * 256 + 158]);
// Mr Captain rower violation flags: 11*256+66, 11*256+60 at length 20.
const MR_CAPTAIN_FLAGS = new Set([11 * 256 + 66, 11 * 256 + 60]);

/** Matrix Bike: promises every feature but ships
 *  only 20 bytes; ExpandedEnergy/HR/Elapsed/Remaining bits are consumed with
 *  NO bytes (advanceFlag-only) because the device lies about carrying them. */
export function parseMatrixBike(dv: DataView): MachineRecord {
  const data = bytesOf(dv);
  const flag = readFlag(data, 2);
  if (!MATRIX_BIKE_FLAGS.has(flag) || data.length !== 20) return parseIndoorBike(dv);
  const b = makeBuilder(dv, 2);
  processSpeed(b);
  skipField(b); // Average Speed
  processCadence(b);
  skipField(b); // Average Cadence
  processTotalDistance(b);
  processResistance(b);
  processPower(b);
  skipField(b); // Average Power
  advanceFlag(b); // Expanded Energy (lied)
  advanceFlag(b); // Heart Rate (lied)
  skipField(b, 1); // Metabolic Equivalent
  advanceFlag(b); // Elapsed Time (lied)
  advanceFlag(b); // Remaining Time (lied)
  return finalize(b);
}

/** Matrix Treadmill: 20-byte truncation of
 *  the treadmill layout; ExpandedEnergy is PARTIAL (total kcal only). */
export function parseMatrixTreadmill(dv: DataView): MachineRecord {
  const data = bytesOf(dv);
  const flag = readFlag(data, 2);
  if (!MATRIX_TREADMILL_FLAGS.has(flag) || data.length !== 20) return parseTreadmill(dv);
  const b = makeBuilder(dv, 2);
  processSpeed(b);
  skipField(b); // Average Speed
  processTotalDistance(b);
  skipField(b, 4); // Inclination and Ramp Angle
  skipField(b, 4); // Positive and Negative Elevation Gain
  advanceFlag(b); // Instantaneous Pace (lied)
  advanceFlag(b); // Average Pace (lied)
  processExpandedEnergy(b, true); // partial: total kcal only, 2 bytes
  advanceFlag(b); // Heart Rate (lied)
  skipField(b, 1); // Metabolic Equivalent
  advanceFlag(b); // Elapsed Time (lied)
  advanceFlag(b); // Remaining Time (lied)
  advanceFlag(b); // Force on Belt and Power (lied)
  return finalize(b);
}

/** Mr Captain scrambled ExpandedEnergy: the energy
 *  fields are MIS-ORDERED and per-minute is (wrongly) 2 bytes:
 *  caloriesPerMinute(short) → calories(short) → caloriesPerHour(short). */
function processEffedUpExpandedEnergy(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.rec.caloriesPerMinute = shortValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
    b.rec.caloriesKcal = shortValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
    b.rec.caloriesPerHour = shortValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
  }
  advanceFlag(b);
}

/** Mr Captain rower: broken 18-byte rower —
 *  no avg pace, mis-ordered 2-byte energy, single-byte elapsed, HR last. */
export function parseMrCaptain(dv: DataView): MachineRecord {
  const data = bytesOf(dv);
  const flag = readFlag(data, 2);
  if (!MR_CAPTAIN_FLAGS.has(flag) || data.length !== 20) return parseRower(dv);
  const b = makeBuilder(dv, 2);
  processStrokeRate(b, true);
  skipField(b); // Average Stroke Rate
  processTotalDistance(b);
  processPaceRower(b);
  advanceFlag(b); // Average Pace (not present)
  processPower(b);
  skipField(b); // Average Power
  processResistance(b);
  processEffedUpExpandedEnergy(b);
  skipField(b, 1); // Elapsed Time — broken single byte
  skipField(b); // Remaining Time
  processHeartRate(b); // HR last byte
  const rec = finalize(b);
  if (rec.cadenceRpm === null && rec.strokeRate !== null) {
    rec.cadenceRpm = rec.strokeRate;
    rec.preciseCadence = rec.strokeRate;
  }
  return rec;
}

/** CardioStrong IB50: standard indoor
 *  bike, but distance is reported in DECAMETERS → divider 0.1 (× 10 to meters).
 *  Unconditional (unlike the flag-gated Matrix/MrCaptain quirks). */
export function parseCardioStrongBike(dv: DataView): MachineRecord {
  const b = makeBuilder(dv, 2);
  processSpeed(b);
  skipField(b); // Average Speed
  processCadence(b);
  skipField(b); // Average Cadence
  processTotalDistance(b, 3, 0.1); // decameters → meters
  processResistance(b);
  processPower(b);
  skipField(b); // Average Power
  processExpandedEnergy(b);
  processHeartRate(b);
  skipField(b, 1); // Metabolic Equivalent
  processElapsedTime(b);
  skipField(b); // Remaining Time
  return finalize(b);
}

/** NPE Runn treadmill: plain FTMS treadmill with
 *  an on-board RSC sensor (merged separately); NO parsing override. */
export const parseNpeRunn = parseTreadmill;
