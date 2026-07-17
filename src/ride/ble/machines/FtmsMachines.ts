/**
 * Complete FTMS data-characteristic engine — the flag-driven parser shared by
 * ALL SIX FTMS data characteristics:
 *   Indoor Bike   0x2AD2 (flagByteSize 2)
 *   Treadmill     0x2ACD (flagByteSize 2)
 *   Rower         0x2AD1 (flagByteSize 2)
 *   Cross Trainer 0x2ACE (flagByteSize 3)  ← 24-bit flags
 *   Stair Climber 0x2AD0 (flagByteSize 2)
 *   Step Climber  0x2ACF (flagByteSize 2)
 *
 * A packet is a flag word (1-3 bytes) followed by the fields its bits enable,
 * in a fixed order. Offsets are deterministic from the flag, so the walk reads
 * each field inline as it advances a running byte counter. Every field-
 * processor consumes exactly one flag bit via `advanceFlag` (flag >>= 1).
 *
 * The processor functions are EXPORTED so the vendor quirks (MatrixQuirks,
 * LifeFitness) can compose their own bit sequences for machines that violate
 * the standard layout.
 *
 * NEGATED-BIT rule: Instant Speed (bike/treadmill/cross-trainer), Stroke Rate
 * (rower) and Floors (stair/step) are present when their flag bit is 0.
 * SIGNED fields: power / resistance / force-on-belt / inclination are FTMS
 * sint16 and read signed (shortSignedValue) — see MetricDescriptors.ts.
 */

import {
  bytesOf,
  byteValue,
  rawByte,
  shortSignedValue,
  shortValue,
  threeByteValue,
} from './MetricDescriptors';

export interface MachineRecord {
  speedKmh: number | null;
  cadenceRpm: number | null;
  preciseCadence: number | null;
  distanceM: number | null;
  resistance: number | null;
  powerW: number | null;
  caloriesKcal: number | null;
  caloriesPerHour: number | null;
  caloriesPerMinute: number | null;
  heartRateBpm: number | null;
  elapsedS: number | null;
  /** rower: seconds; treadmill: min/km after km-min conversion */
  paceS: number | null;
  strokeRate: number | null;
  strokeCount: number | null;
  inclinationPct: number | null;
  truncated: boolean;
}

export function emptyRecord(): MachineRecord {
  return {
    speedKmh: null,
    cadenceRpm: null,
    preciseCadence: null,
    distanceM: null,
    resistance: null,
    powerW: null,
    caloriesKcal: null,
    caloriesPerHour: null,
    caloriesPerMinute: null,
    heartRateBpm: null,
    elapsedS: null,
    paceS: null,
    strokeRate: null,
    strokeCount: null,
    inclinationPct: null,
    truncated: false,
  };
}

export interface FtmsBuilder {
  readonly data: Uint8Array;
  /** byteCounter — absolute index of the next payload byte */
  bc: number;
  flag: number;
  hrIndex: number | null;
  rec: MachineRecord;
}

/** little-endian flag word over flagByteSize bytes */
export function readFlag(d: Uint8Array, flagByteSize: number): number {
  let flag = d[0] ?? 0;
  if (flagByteSize > 1) flag += 256 * (d[1] ?? 0);
  if (flagByteSize > 2) flag += 65536 * (d[2] ?? 0);
  return flag;
}

export function makeBuilder(dv: DataView, flagByteSize: number): FtmsBuilder {
  const data = bytesOf(dv);
  return { data, bc: flagByteSize, flag: readFlag(data, flagByteSize), hrIndex: null, rec: emptyRecord() };
}

/** consume one flag bit WITHOUT reading any bytes */
export function advanceFlag(b: FtmsBuilder): void {
  b.flag = Math.trunc(b.flag / 2);
}

// ---- reusable field processors (each consumes exactly one flag bit) -----------

/** Instant Speed — NEGATED first bit (present when bit==0). uint16 /100 km/h. */
export function processSpeed(b: FtmsBuilder): void {
  if (b.flag % 2 === 0) {
    b.rec.speedKmh = shortValue(b.data, b.bc, b.bc + 1, 100);
    b.bc += 2;
  }
  advanceFlag(b);
}

export function skipField(b: FtmsBuilder, size = 2, inverse = false): void {
  if (b.flag % 2 === (inverse ? 0 : 1)) b.bc += size;
  advanceFlag(b);
}

/** uint16 /divider rpm. inverse=true means "present when bit==0" (LF quirk). */
export function processCadence(b: FtmsBuilder, divider = 2, inverse = false): void {
  if (b.flag % 2 === (inverse ? 0 : 1)) {
    const v = shortValue(b.data, b.bc, b.bc + 1, divider);
    b.rec.cadenceRpm = v;
    b.rec.preciseCadence = v;
    b.bc += 2;
  }
  advanceFlag(b);
}

/** uint24 (or uint16 when numBytes=2) meters. */
export function processTotalDistance(b: FtmsBuilder, numBytes = 3, divider = 1): void {
  if (b.flag % 2 === 1) {
    b.rec.distanceM = threeByteValue(b.data, b.bc, b.bc + numBytes - 1, divider);
    b.bc += numBytes;
  }
  advanceFlag(b);
}

/** sint16 resistance level. */
export function processResistance(b: FtmsBuilder, divider = 1): void {
  if (b.flag % 2 === 1) {
    b.rec.resistance = shortSignedValue(b.data, b.bc, b.bc + 1, divider);
    b.bc += 2;
  }
  advanceFlag(b);
}

/** sint16 Watts. */
export function processPower(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.rec.powerW = shortSignedValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
  }
  advanceFlag(b);
}

/** uint16 kcal (+ uint16/hr + uint8/min unless partial). */
export function processExpandedEnergy(b: FtmsBuilder, partial = false): void {
  if (b.flag % 2 === 1) {
    b.rec.caloriesKcal = shortValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
    if (!partial) {
      b.rec.caloriesPerHour = shortValue(b.data, b.bc, b.bc + 1);
      b.bc += 2;
      b.rec.caloriesPerMinute = byteValue(b.data, b.bc);
      b.bc += 1;
    }
  }
  advanceFlag(b);
}

/** uint8 HR — records the byte index (read at finalize). */
export function processHeartRate(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.hrIndex = b.bc;
    b.bc += 1;
  }
  advanceFlag(b);
}

/** uint16 seconds. */
export function processElapsedTime(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.rec.elapsedS = shortValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
  }
  advanceFlag(b);
}

/** step/min (uint16) → cadence if unset; + uint16 avg step rate skipped. */
export function processStepMetrics(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    if (b.rec.cadenceRpm === null) {
      const v = shortValue(b.data, b.bc, b.bc + 1);
      b.rec.cadenceRpm = v;
      b.rec.preciseCadence = v;
    }
    b.bc += 2; // step/min
    b.bc += 2; // avg step rate (skipped)
  }
  advanceFlag(b);
}

/** uint16 /divider stroke/stride count; skipBytes precede it (Floors). */
export function processStrideCount(b: FtmsBuilder, divider = 1, inverse = false, skipBytes = 0): void {
  if (b.flag % 2 === (inverse ? 0 : 1)) {
    b.bc += skipBytes;
    b.rec.strokeCount = shortValue(b.data, b.bc, b.bc + 1, divider);
    b.bc += 2;
  }
  advanceFlag(b);
}

/** sint16 /10 inclination % + sint16 ramp angle (skipped). */
export function processInclination(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.rec.inclinationPct = shortSignedValue(b.data, b.bc, b.bc + 1, 10);
    b.bc += 2; // inclination
    b.bc += 2; // ramp angle (skipped)
  }
  advanceFlag(b);
}

/** rower: uint8 /2 stroke rate + uint16 stroke count. NEGATED (present bit==0). */
export function processStrokeRate(b: FtmsBuilder, negated: boolean): void {
  if (b.flag % 2 === (negated ? 0 : 1)) {
    b.rec.strokeRate = byteValue(b.data, b.bc, 2);
    b.bc += 1;
    b.rec.strokeCount = shortValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
  }
  advanceFlag(b);
}

/** treadmill pace: uint8 /10 km/min (stored raw in paceS; converted later). */
export function processPaceTreadmill(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.rec.paceS = byteValue(b.data, b.bc, 10);
    b.bc += 1;
  }
  advanceFlag(b);
}

/** rower pace: uint16 seconds. */
export function processPaceRower(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.rec.paceS = shortValue(b.data, b.bc, b.bc + 1);
    b.bc += 2;
  }
  advanceFlag(b);
}

/** treadmill Force on Belt + Power Output: sint16 N + sint16 W. */
export function processForceAndPower(b: FtmsBuilder): void {
  if (b.flag % 2 === 1) {
    b.rec.resistance = shortSignedValue(b.data, b.bc, b.bc + 1); // N
    b.bc += 2;
    b.rec.powerW = shortSignedValue(b.data, b.bc, b.bc + 1); // W
    b.bc += 2;
  }
  advanceFlag(b);
}

/** HR is a raw uint8 (no sentinel);
 *  truncated iff the packet is shorter than the fields the flags claimed. */
export function finalize(b: FtmsBuilder): MachineRecord {
  b.rec.heartRateBpm = b.hrIndex !== null ? rawByte(b.data, b.hrIndex) : null;
  b.rec.truncated = b.data.length < b.bc;
  return b.rec;
}

// ---- the six standard characteristic parsers ---------------------------------

/** Indoor Bike Data characteristic 0x2AD2. */
export function parseIndoorBike(dv: DataView): MachineRecord {
  const b = makeBuilder(dv, 2);
  processSpeed(b);
  skipField(b); // Average Speed
  processCadence(b);
  skipField(b); // Average Cadence
  processTotalDistance(b);
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

/** Treadmill Data characteristic 0x2ACD. */
export function parseTreadmill(dv: DataView): MachineRecord {
  const b = makeBuilder(dv, 2);
  processSpeed(b);
  skipField(b); // Average Speed
  processTotalDistance(b);
  processInclination(b);
  skipField(b, 4); // Positive and Negative Elevation Gain
  processPaceTreadmill(b);
  skipField(b, 1); // Average Pace
  processExpandedEnergy(b);
  processHeartRate(b);
  skipField(b, 1); // Metabolic Equivalent
  processElapsedTime(b);
  skipField(b); // Remaining Time
  processForceAndPower(b);
  const rec = finalize(b);
  // stubRecord pace handling: km/min pace → speed, then reciprocal → min/km
  if (rec.paceS !== null && rec.paceS > 0) {
    if (rec.speedKmh === null) rec.speedKmh = rec.paceS * 60;
    rec.paceS = 1 / rec.paceS;
  }
  return rec;
}

/** Rower Data characteristic 0x2AD1. */
export function parseRower(dv: DataView): MachineRecord {
  const b = makeBuilder(dv, 2);
  processStrokeRate(b, true);
  skipField(b, 1); // Average Stroke Rate
  processTotalDistance(b);
  processPaceRower(b);
  skipField(b); // Average Pace
  processPower(b);
  skipField(b); // Average Power
  processResistance(b);
  processExpandedEnergy(b);
  processHeartRate(b);
  skipField(b, 1); // Metabolic Equivalent
  processElapsedTime(b);
  skipField(b); // Remaining Time
  const rec = finalize(b);
  // record cadence = stroke rate (stateful sliding-average smoothing is a
  // provider-level concern — the instantaneous value is what we expose)
  if (rec.cadenceRpm === null && rec.strokeRate !== null) {
    rec.cadenceRpm = rec.strokeRate;
    rec.preciseCadence = rec.strokeRate;
  }
  return rec;
}

/** Cross Trainer Data characteristic 0x2ACE — 24-bit flags. */
export function parseCrossTrainer(dv: DataView): MachineRecord {
  const b = makeBuilder(dv, 3);
  processSpeed(b);
  skipField(b); // Average Speed
  processTotalDistance(b);
  processStepMetrics(b);
  processStrideCount(b, 10);
  skipField(b, 4); // Positive and Negative Elevation Gain
  skipField(b, 4); // Inclination and Ramp Angle
  processResistance(b, 10);
  processPower(b);
  skipField(b); // Average Power
  processExpandedEnergy(b);
  processHeartRate(b);
  skipField(b, 1); // Metabolic Equivalent
  processElapsedTime(b);
  skipField(b); // Remaining Time
  return finalize(b);
}

/** Stair Climber Data characteristic 0x2AD0. */
export function parseStairClimber(dv: DataView): MachineRecord {
  const b = makeBuilder(dv, 2);
  skipField(b, 2, true); // Floors (inverse)
  processCadence(b, 1); // Steps / min
  skipField(b); // Average step rate
  processTotalDistance(b, 2); // Positive elevation gain
  processStrideCount(b); // Stride count
  processExpandedEnergy(b);
  processHeartRate(b);
  skipField(b, 1); // Metabolic Equivalent
  processElapsedTime(b);
  skipField(b); // Remaining Time
  return finalize(b);
}

/** Step Climber Data characteristic 0x2ACF. */
export function parseStepClimber(dv: DataView): MachineRecord {
  const b = makeBuilder(dv, 2);
  processStrideCount(b, 1, true, 2); // Floors + Step Count (inverse, skip 2)
  processCadence(b, 1); // Steps / min
  skipField(b); // Average step rate
  processTotalDistance(b, 2); // Positive elevation gain
  processExpandedEnergy(b);
  processHeartRate(b);
  skipField(b, 1); // Metabolic Equivalent
  processElapsedTime(b);
  skipField(b); // Remaining Time
  return finalize(b);
}
