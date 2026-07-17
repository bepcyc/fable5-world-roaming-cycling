/**
 * Schwinn X70 (170/270/570) indoor bike — fixed-layout 17-byte packet with a
 * cadence-driven POWER MODEL (the bike reports no power) and an HR side-channel.
 *
 * The decoder is STATEFUL (power smoothing + a sliding-window cadence
 * estimator), so it is a class, not a pure function; but it touches no I/O and
 * is fully node-testable. Control: on requestControl it writes the HR-stream
 * start command; start/stop opcodes are ignored.
 */

import { rawByte, ByteMetricDescriptor, ShortMetricDescriptor, SixByteMetricDescriptor } from './MetricDescriptors';

// ---- GATT UUIDs (16-bit short form) -------------------------------------------

export const SCHWINN_X70_SERVICE = 0x8980;
export const SCHWINN_X70_CHR = {
  measurement: 0x82a0, // 17B measurement
  control: 0xb3c0, // control write
  extraMeasurement: 0xf580, // 20B, contains HR
} as const;

/** written to the control char on requestControl to start the HR stream. */
export const SCHWINN_X70_HR_STREAM_START = new Uint8Array([0x05, 0x03, 0xd9, 0x00, 0x1f]);

export const SCHWINN_X70_MAGIC = [17, 32, 0];
export const SCHWINN_X70_MAGIC_FLAG = 32 * 256 + 17; // 8209

// 25×3 resistance→power coefficient table, indexed by (resistance - 1) % 25.
// Each row is [a, b, c] for power = a*cad² + b*cad + c, clamped ≥ 0.
export const SCHWINN_X70_RESISTANCE_POWER_COEFFS: readonly (readonly [number, number, number])[] = [
  [-0.0014, 0.792, -13.985],
  [-0.0004, 0.9991, -19.051],
  [0.0015, 0.9179, -13.745],
  [0.004, 0.9857, -13.095],
  [0.0027, 1.3958, -22.741],
  [0.0057, 1.1586, -15.126],
  [-0.0013, 2.4666, -49.052],
  [0.0002, 2.6349, -52.39],
  [0.0034, 2.624, -48.072],
  [0.0147, 1.6372, -19.653],
  [0.0062, 2.5851, -43.254],
  [0.0064, 3.2864, -59.336],
  [0.0048, 3.6734, -69.245],
  [0.0184, 2.1842, -28.936],
  [0.0052, 4.3939, -78.603],
  [0.0094, 3.8871, -65.982],
  [0.0165, 3.3074, -49.906],
  [0.0251, 3.2956, -44.436],
  [0.0281, 2.9107, -38.767],
  [0.0311, 2.9435, -35.851],
  [0.0141, 5.5646, -88.686],
  [0.0517, 1.8361, -13.777],
  [0.0467, 2.9273, -35.908],
  [0.0429, 4.1821, -50.141],
  [0.0652, 3.667, -46.863],
];

export function schwinnPowerFromCadenceResistance(cadence: number, resistance: number): number {
  const idx = ((resistance - 1) % 25 + 25) % 25;
  const c = SCHWINN_X70_RESISTANCE_POWER_COEFFS[idx]!;
  return Math.max(c[0] * cadence * cadence + c[1] * cadence + c[2], 0);
}

// ---- power↔speed (Cardano) — physics constants -------------------------------
// gConst 9.8067, Crr 0.005, Cd 0.63, frontalArea 0.509 m²; athlete 80 kg /
// bike 9 kg / driveTrainLoss 2% / air density 1.226 (15°C) / dragTune 100%.
const G = 9.8067;
const CRR = 0.005;
const CD = 0.63;
const FRONTAL_AREA = 0.509;
const ATHLETE_KG = 80;
const BIKE_KG = 9;
const DRIVE_TRAIN_LOSS = 2; // percent
const AIR_DENSITY = 1.226;
const DRAG_TUNE = 1.0; // dragForceTuneDefault 100 / 100
const MS2KMH = 3.6;

const CARDANO_A = 0.5 * FRONTAL_AREA * CD * AIR_DENSITY * DRAG_TUNE;
const CARDANO_C = G * (ATHLETE_KG + BIKE_KG) * CRR;
const CARDANO_Q = CARDANO_C / (3 * CARDANO_A);
const DRIVE_TRAIN_FRACTION = 1 - DRIVE_TRAIN_LOSS / 100;

function cbrtSigned(x: number): number {
  return x > 0 ? Math.pow(x, 1 / 3) : -Math.pow(-x, 1 / 3);
}

/** velocityForPowerCardano — cubic power↔speed solution, returns m/s. */
export function velocityForPowerCardano(power: number): number {
  const dNeg = DRIVE_TRAIN_FRACTION * power;
  const r = dNeg / (2 * CARDANO_A);
  const e = Math.sqrt(CARDANO_Q * CARDANO_Q * CARDANO_Q + r * r);
  return cbrtSigned(r + e) + cbrtSigned(r - e);
}

// ---- sliding-window cadence estimator ----------------------------------------

interface CadenceSample {
  time: number;
  revolutions: number;
  timeStamp: number; // wall-clock ms
}

const EPS = 1e-6;
const REVOLUTION_SLIDING_WINDOW_S = 4; // revolutionSlidingWindowDefault
const SENSOR_DATA_THRESHOLD_MS = 480; // sensorDataThresholdDefault (= ftmsDataThresholdDefault)

/** Sliding-window revolution→cadence estimator with event-time + revolution
 *  overflow handling. `now` is injectable for deterministic tests. */
export class CadenceMixin {
  private readonly queue: CadenceSample[] = [];
  private overflowCounter = 0;
  constructor(
    private readonly eventTimeOverflow: number,
    private readonly revolutionOverflow: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private diff(later: number, earlier: number, overflow: number): number {
    let d = later - earlier;
    if (d < 0) d += overflow;
    return d;
  }

  addCadenceData(time: number, revolutions: number): void {
    if (this.queue.length > 0) {
      const last = this.queue[this.queue.length - 1]!;
      const revDiff = this.diff(revolutions, last.revolutions, this.revolutionOverflow);
      if (revDiff < EPS) {
        last.timeStamp = this.now(); // duplicate rev count — bump timestamp only
        return;
      }
      if (revolutions < last.revolutions) this.overflowCounter++;
    }
    this.queue.push({ time, revolutions, timeStamp: this.now() });
    this.trimQueue();
  }

  private trimQueue(): void {
    while (this.queue.length > 1) {
      const first = this.queue[0]!;
      const last = this.queue[this.queue.length - 1]!;
      const timeDiff = this.diff(last.time, first.time, this.eventTimeOverflow);
      const stampDiff = (last.timeStamp - first.timeStamp) / 1000 - SENSOR_DATA_THRESHOLD_MS / 1000;
      if (timeDiff > REVOLUTION_SLIDING_WINDOW_S || stampDiff > REVOLUTION_SLIDING_WINDOW_S) {
        this.queue.shift();
      } else break;
    }
  }

  computeCadence(): number {
    if (this.queue.length <= 1) return 0;
    const first = this.queue[0]!;
    const last = this.queue[this.queue.length - 1]!;
    const timeDiff = this.diff(last.time, first.time, this.eventTimeOverflow);
    if (timeDiff < EPS) return 0;
    const revDiff = this.diff(last.revolutions, first.revolutions, this.revolutionOverflow);
    return (revDiff * 60) / timeDiff;
  }

  clear(): void {
    this.queue.length = 0;
    this.overflowCounter = 0;
  }
}

// ---- decoder ------------------------------------------------------------------

const TIME_METRIC = new ShortMetricDescriptor(8, 9);
const CALORIES_METRIC = new SixByteMetricDescriptor(10, 15);
const CADENCE_METRIC = new ShortMetricDescriptor(4, 5); // revolution counter
const RESISTANCE_METRIC = new ByteMetricDescriptor(16);

export interface SchwinnRecord {
  powerW: number | null;
  speedKmh: number | null;
  cadenceRpm: number | null;
  resistance: number | null;
  caloriesKcal: number | null;
}

function emptySchwinn(): SchwinnRecord {
  return { powerW: null, speedKmh: null, cadenceRpm: null, resistance: null, caloriesKcal: null };
}

export function isSchwinnX70Packet(d: Uint8Array): boolean {
  if (d.length !== 17) return false;
  for (let i = 0; i < SCHWINN_X70_MAGIC.length; i++) if (d[i] !== SCHWINN_X70_MAGIC[i]) return false;
  return true;
}

export class SchwinnX70Decoder {
  private lastTime = -1;
  private lastPower = -1;
  private lastRxTime = Date.now();
  private lastRecord: SchwinnRecord | null = null;
  private readonly cadence: CadenceMixin;

  constructor(now?: () => number) {
    // initCadence(64, maxUint16) — event-time overflow 64 s, rev overflow 65536.
    this.cadence = new CadenceMixin(64, 65536, now);
    if (now) this.lastRxTime = now();
  }

  /** parse one 17-byte measurement; returns null for a non-Schwinn packet,
   *  an empty record on (re)seed, or the decoded record. */
  decode(d: Uint8Array, nowMs: number = Date.now()): SchwinnRecord | null {
    if (!isSchwinnX70Packet(d)) return null;
    const time = TIME_METRIC.getValue(d);
    const caloriesRaw = CALORIES_METRIC.getValue(d);
    const durationSec = (nowMs - this.lastRxTime) / 1000;
    this.lastRxTime = nowMs;
    if (time === null || caloriesRaw === null) return emptySchwinn();
    if (this.lastTime < 0 || durationSec > 63) {
      this.lastTime = time;
      this.lastPower = 0;
      this.lastRecord = null;
      return emptySchwinn();
    }
    if (time === this.lastTime) return this.lastRecord ?? emptySchwinn();
    this.lastTime = time;

    this.cadence.addCadenceData(time / 1024, CADENCE_METRIC.getValue(d) ?? 0);
    const cadence = Math.min(Math.trunc(this.cadence.computeCadence()), 255);
    const resistance = Math.max(Math.trunc(RESISTANCE_METRIC.getValue(d) ?? 1), 1);
    const power = schwinnPowerFromCadenceResistance(cadence, resistance);
    if (this.lastPower === -1 || Math.abs(this.lastPower - power) < 400) this.lastPower = power;
    else this.lastPower += (power - this.lastPower) / 2;
    if (this.lastPower < 0) this.lastPower = 1;

    const integerPower = Math.trunc(this.lastPower);
    const record: SchwinnRecord = {
      powerW: integerPower,
      speedKmh: velocityForPowerCardano(integerPower) * MS2KMH,
      cadenceRpm: cadence,
      resistance,
      caloriesKcal: Math.trunc(caloriesRaw / 2097152),
    };
    this.lastRecord = record;
    return record;
  }

  reset(): void {
    this.lastTime = -1;
    this.lastPower = -1;
    this.lastRecord = null;
    this.cadence.clear();
  }
}

// ---- HR side-channel ----------------------------------------------------------

const SCHWINN_HR_MARKER_INDEX = 15;
const SCHWINN_HR_MARKER_VALUE = 0x5a;
const SCHWINN_HR_INDEX = 16;

/** char 0xf580, 20 bytes: valid iff data[15]==0x5a → heartRate = data[16]. */
export function parseSchwinnX70HeartRate(d: Uint8Array): number | null {
  if (d.length !== 20) return null;
  if (rawByte(d, SCHWINN_HR_MARKER_INDEX) !== SCHWINN_HR_MARKER_VALUE) return null;
  return rawByte(d, SCHWINN_HR_INDEX);
}
