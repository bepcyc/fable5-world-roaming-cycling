/**
 * Precor Spinner Chrono Power — fixed-layout 19-byte packet carrying power /
 * speed / cadence / HR / distance directly. No control writes.
 */

import { rawByte, ShortMetricDescriptor, ThreeByteMetricDescriptor } from './MetricDescriptors';

export const PRECOR_SERVICE = 0xee07;
export const PRECOR_MEASUREMENT_CHR = 0xe01d;

export const PRECOR_MAGIC = [83, 89, 22];
export const PRECOR_MAGIC_FLAG = 22 * 65536 + 89 * 256 + 83;

const TIME_METRIC = new ShortMetricDescriptor(3, 4);
const SPEED_METRIC = new ShortMetricDescriptor(6, 7, 100); // km/h
const CADENCE_METRIC = new ShortMetricDescriptor(8, 9, 10); // rpm
const DISTANCE_METRIC = new ThreeByteMetricDescriptor(10, 12); // m
const CALORIES_METRIC = new ShortMetricDescriptor(13, 14); // kcal
const POWER_METRIC = new ShortMetricDescriptor(17, 18); // W
const HR_BYTE_INDEX = 5;

export interface PrecorRecord {
  heartRateBpm: number | null;
  elapsedS: number | null;
  caloriesKcal: number | null;
  speedKmh: number | null;
  powerW: number | null;
  cadenceRpm: number | null;
  distanceM: number | null;
}

export function isPrecorPacket(d: Uint8Array): boolean {
  if (d.length !== 19) return false;
  for (let i = 0; i < PRECOR_MAGIC.length; i++) if (d[i] !== PRECOR_MAGIC[i]) return false;
  return true;
}

/** parse one 19-byte Precor packet; null for a non-Precor payload. */
export function parsePrecor(d: Uint8Array): PrecorRecord | null {
  if (!isPrecorPacket(d)) return null;
  return {
    heartRateBpm: rawByte(d, HR_BYTE_INDEX),
    elapsedS: TIME_METRIC.getValue(d),
    caloriesKcal: CALORIES_METRIC.getValue(d),
    speedKmh: SPEED_METRIC.getValue(d),
    powerW: POWER_METRIC.getValue(d),
    cadenceRpm: CADENCE_METRIC.getValue(d),
    distanceM: DISTANCE_METRIC.getValue(d),
  };
}
