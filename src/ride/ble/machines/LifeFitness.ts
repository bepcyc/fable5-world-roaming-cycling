/**
 * Life Fitness family — the scripted connect handshake that is REQUIRED to
 * make an LF machine stream data, plus the LF-bike FTMS flag override.
 *
 * LF machines speak standard FTMS (indoor bike / treadmill / cross-trainer /
 * stair / step) but only AFTER the connect handshake writes a fixed sequence
 * of user-data + magic values across services 0x4b90 (control) and 0x4b91
 * (user). `doNotReadManufacturerName` is true for all LF descriptors.
 */

import { bytesOf } from './MetricDescriptors';
import {
  finalize,
  makeBuilder,
  parseIndoorBike,
  processCadence,
  processElapsedTime,
  processExpandedEnergy,
  processHeartRate,
  processPower,
  processResistance,
  processSpeed,
  processTotalDistance,
  readFlag,
  skipField,
  type MachineRecord,
} from './FtmsMachines';

// ---- Life Fitness proprietary GATT -------------------------------------------

export const LF_CONTROL_SERVICE = 0x4b90;
export const LF_USER_SERVICE = 0x4b91;

export const LF_CHR = {
  control1: 0x58dc, // write 0x01 then later 0x02
  status1: 0x51de, // notify
  control2: 0x69e2, // write magic [00 00 00 01 b8 5b 5d]
  userUnk1: 0x4cf2, // write 32-byte ASCII magic
  userUnk2: 0xe85e, // write [0x00]
  firstName: 0x2a8a,
  lastName: 0x2a90,
  email: 0x2a87,
  age: 0x2a80,
  gender: 0x2a8c, // 0=male, 1=female
  language: 0x2aa2,
  weight: 0x2a98, // uint16 kg, 0.005 res
  height: 0x2a8e, // uint16 m, 0.01 res (cm)
} as const;

/** 32-byte ASCII magic written to 0x4b91/0x4cf2. */
export const LF_USER_MAGIC = 'f77ab82b7a2440078f33c5aa6ee7a31b';
/** 7-byte magic written to 0x4b90/0x69e2 (control2). */
export const LF_CONTROL2_MAGIC = [0x00, 0x00, 0x00, 0x01, 0xb8, 0x5b, 0x5d];

export interface LifeFitnessAthlete {
  firstName: string;
  lastName: string;
  email: string;
  age: number;
  isMale: boolean;
  weightKg: number;
  heightCm: number;
}

/** one step of the connect handshake. `kind: 'subscribe'` is the
 *  status-notify subscription (step 1, informational); every other step is
 *  a control-point write after `delayMs`. */
export interface LifeFitnessStep {
  kind: 'subscribe' | 'write';
  service: number;
  chr: number;
  bytes?: Uint8Array;
  delayMs: number;
}

function utf8z(s: string): Uint8Array {
  const body = new TextEncoder().encode(s);
  const out = new Uint8Array(body.length + 1);
  out.set(body, 0);
  out[body.length] = 0x00; // NUL terminator
  return out;
}

function u16le(v: number): Uint8Array {
  const raw = Math.max(0, Math.min(0xffff, Math.round(v)));
  return new Uint8Array([raw & 0xff, (raw >> 8) & 0xff]);
}

/**
 * The full 14-step LF connect handshake. Delays:
 * 2000 ms "longer" for the first two control writes, 500 ms "shorter" after.
 * The registry/provider executes these in order, awaiting each delay.
 */
export function buildLifeFitnessHandshake(a: LifeFitnessAthlete): LifeFitnessStep[] {
  return [
    { kind: 'subscribe', service: LF_CONTROL_SERVICE, chr: LF_CHR.status1, delayMs: 0 },
    { kind: 'write', service: LF_CONTROL_SERVICE, chr: LF_CHR.control1, bytes: new Uint8Array([0x01]), delayMs: 2000 },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.firstName, bytes: utf8z(a.firstName), delayMs: 2000 },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.lastName, bytes: utf8z(a.lastName), delayMs: 500 },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.email, bytes: utf8z(a.email), delayMs: 500 },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.age, bytes: new Uint8Array([a.age & 0xff]), delayMs: 500 },
    {
      kind: 'write',
      service: LF_USER_SERVICE,
      chr: LF_CHR.gender,
      bytes: new Uint8Array([a.isMale ? 0 : 1]),
      delayMs: 500,
    },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.language, bytes: new Uint8Array([0x65, 0x6e]), delayMs: 500 },
    {
      kind: 'write',
      service: LF_USER_SERVICE,
      chr: LF_CHR.userUnk1,
      bytes: new TextEncoder().encode(LF_USER_MAGIC),
      delayMs: 500,
    },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.userUnk2, bytes: new Uint8Array([0x00]), delayMs: 500 },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.weight, bytes: u16le(a.weightKg / 0.005), delayMs: 500 },
    { kind: 'write', service: LF_USER_SERVICE, chr: LF_CHR.height, bytes: u16le(a.heightCm), delayMs: 500 },
    {
      kind: 'write',
      service: LF_CONTROL_SERVICE,
      chr: LF_CHR.control2,
      bytes: new Uint8Array(LF_CONTROL2_MAGIC),
      delayMs: 500,
    },
    { kind: 'write', service: LF_CONTROL_SERVICE, chr: LF_CHR.control1, bytes: new Uint8Array([0x02]), delayMs: 500 },
  ];
}

// ---- LF bike flag override ---------------------------------------------------

// LF violates FTMS: it emits Instant Cadence even though the flag bit is 0, so
// cadence uses processCadence(inverse:true). Only for these (flag, length) pairs.
const LF_BIKE_VARIANTS = new Map<number, number>([
  [9 * 256 + 250, 26],
  [11 * 256 + 250, 27],
  [25 * 256 + 250, 28],
  [27 * 256 + 250, 29],
]);

export function parseLifeFitnessBike(dv: DataView): MachineRecord {
  const data = bytesOf(dv);
  const flag = readFlag(data, 2);
  if (LF_BIKE_VARIANTS.get(flag) !== data.length) return parseIndoorBike(dv);
  const b = makeBuilder(dv, 2);
  processSpeed(b);
  skipField(b); // Average Speed
  processCadence(b, 2, true); // Instant Cadence — inverse (present when bit==0)
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
