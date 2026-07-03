/**
 * Pure BLE GATT characteristic parsers for the ride sensor layer (M1.4).
 *
 * Every parser takes a DataView (notification payload) and returns a plain
 * object; no I/O, no state except the explicit revolution accumulators —
 * fully probe-testable without a Bluetooth stack. All multi-byte fields are
 * LITTLE-ENDIAN per Bluetooth SIG GATT conventions.
 *
 * Spec sources (verified 2026-07-03, see docs/notes/ble-ftms-research.md):
 * - GATT Specification Supplement (HR §3.113, CPS §3.65, CSC §3.62, FTMS
 *   Indoor Bike Data §3.138)
 * - FTMS v1.0 §4.9 (Indoor Bike Data), §4.16 (Control Point), §4.17 (Status)
 * - Cycling Power Service 1.1 + CPS test spec (control point op codes)
 *
 * DEFENSIVE PARSING CONTRACT: a malformed/truncated notification must never
 * throw — every field read is bounds-checked; missing bytes yield nulls and
 * a `truncated` marker so callers can count garbage without crashing.
 */

// ---- bounds-checked little-endian readers -----------------------------------

class Cursor {
  readonly dv: DataView;
  off = 0;
  truncated = false;
  constructor(dv: DataView) {
    this.dv = dv;
  }
  private has(n: number): boolean {
    if (this.off + n > this.dv.byteLength) {
      this.truncated = true;
      return false;
    }
    return true;
  }
  u8(): number | null {
    if (!this.has(1)) return null;
    return this.dv.getUint8(this.off++);
  }
  u16(): number | null {
    if (!this.has(2)) return null;
    const v = this.dv.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  i16(): number | null {
    if (!this.has(2)) return null;
    const v = this.dv.getInt16(this.off, true);
    this.off += 2;
    return v;
  }
  u24(): number | null {
    if (!this.has(3)) return null;
    const v =
      this.dv.getUint8(this.off) |
      (this.dv.getUint8(this.off + 1) << 8) |
      (this.dv.getUint8(this.off + 2) << 16);
    this.off += 3;
    return v;
  }
  u32(): number | null {
    if (!this.has(4)) return null;
    const v = this.dv.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  skip(n: number): void {
    if (this.has(n)) this.off += n;
  }
}

// ---- Heart Rate Measurement 0x2A37 (service 0x180D) --------------------------

export interface HeartRateData {
  bpm: number | null;
  /** null = sensor-contact feature unsupported */
  sensorContact: boolean | null;
  energyKj: number | null;
  /** RR intervals in SECONDS (spec unit 1/1024 s), oldest first */
  rrS: number[];
  truncated: boolean;
}

/** flags u8: bit0 HR format (0=u8, 1=u16), bits1-2 sensor contact
 *  (2=supported+no-contact, 3=supported+contact), bit3 energy expended,
 *  bit4 RR intervals present (repeated u16 to end of payload) */
export function parseHeartRate(dv: DataView): HeartRateData {
  const c = new Cursor(dv);
  const flags = c.u8();
  if (flags === null) {
    return { bpm: null, sensorContact: null, energyKj: null, rrS: [], truncated: true };
  }
  const bpm = flags & 0x01 ? c.u16() : c.u8();
  const contactBits = (flags >> 1) & 0x03;
  const sensorContact = contactBits === 3 ? true : contactBits === 2 ? false : null;
  const energyKj = flags & 0x08 ? c.u16() : null;
  const rrS: number[] = [];
  if (flags & 0x10) {
    for (;;) {
      const rr = c.u16();
      if (rr === null) break;
      rrS.push(rr / 1024);
    }
    // trailing odd byte (if any) already flagged truncated by the failed read
    if (rrS.length > 0 && c.off === dv.byteLength) c.truncated = false;
  }
  return { bpm, sensorContact, energyKj, rrS, truncated: c.truncated };
}

// ---- Cycling Power Measurement 0x2A63 (service 0x1818) ------------------------

export interface CyclingPowerData {
  /** instantaneous power, W (mandatory field; null only if payload broken) */
  powerW: number | null;
  /** left-pedal share of total power, percent 0..100 (spec unit 1/2 %) */
  pedalBalancePct: number | null;
  /** true when balance is referenced to the LEFT pedal (flags bit 1) */
  balanceRefLeft: boolean;
  /** accumulated torque, N·m (spec unit 1/32 N·m) */
  accTorqueNm: number | null;
  wheel: { revs: number; eventT: number } | null;
  crank: { revs: number; eventT: number } | null;
  truncated: boolean;
}

/** flags u16 + sint16 power, optional fields in bit order:
 *  bit0 pedal balance u8 (+bit1 reference), bit2 acc torque u16 (+bit3 src),
 *  bit4 wheel rev (u32 cum + u16 time 1/2048 s — NOT the CSC 1/1024!),
 *  bit5 crank rev (u16 cum + u16 time 1/1024 s),
 *  bit6 extreme force 2×s16, bit7 extreme torque 2×s16,
 *  bit8 extreme angles u24 (2×12 bit), bit9/10 dead-spot angles u16,
 *  bit11 accumulated energy u16 kJ, bit12 offset-compensation indicator */
export function parseCyclingPower(dv: DataView): CyclingPowerData {
  const c = new Cursor(dv);
  const flags = c.u16();
  const powerW = flags === null ? null : c.i16();
  const out: CyclingPowerData = {
    powerW,
    pedalBalancePct: null,
    balanceRefLeft: false,
    accTorqueNm: null,
    wheel: null,
    crank: null,
    truncated: c.truncated,
  };
  if (flags === null || powerW === null) {
    out.truncated = true;
    return out;
  }
  if (flags & 0x0001) {
    const b = c.u8();
    if (b !== null) out.pedalBalancePct = b / 2;
    out.balanceRefLeft = (flags & 0x0002) !== 0;
  }
  if (flags & 0x0004) {
    const t = c.u16();
    if (t !== null) out.accTorqueNm = t / 32;
  }
  if (flags & 0x0010) {
    const revs = c.u32();
    const eventT = c.u16(); // 1/2048 s
    if (revs !== null && eventT !== null) out.wheel = { revs, eventT };
  }
  if (flags & 0x0020) {
    const revs = c.u16();
    const eventT = c.u16(); // 1/1024 s
    if (revs !== null && eventT !== null) out.crank = { revs, eventT };
  }
  // remaining optional fields are skipped, not needed by the dashboard —
  // but still bounds-checked so a lying flags word can't throw
  if (flags & 0x0040) c.skip(4); // extreme force magnitudes
  if (flags & 0x0080) c.skip(4); // extreme torque magnitudes
  if (flags & 0x0100) c.skip(3); // extreme angles (packed 2×12 bit)
  if (flags & 0x0200) c.skip(2); // top dead spot angle
  if (flags & 0x0400) c.skip(2); // bottom dead spot angle
  if (flags & 0x0800) c.skip(2); // accumulated energy
  out.truncated = c.truncated;
  return out;
}

// ---- CSC Measurement 0x2A5B (service 0x1816) ----------------------------------

export interface CscData {
  wheel: { revs: number; eventT: number } | null;
  crank: { revs: number; eventT: number } | null;
  truncated: boolean;
}

/** flags u8: bit0 wheel rev (u32 cum + u16 time 1/1024 s), bit1 crank rev
 *  (u16 cum + u16 time 1/1024 s). NOTE: CSC wheel event time is 1/1024 s,
 *  CPS wheel event time is 1/2048 s — different services, different units. */
export function parseCsc(dv: DataView): CscData {
  const c = new Cursor(dv);
  const flags = c.u8();
  const out: CscData = { wheel: null, crank: null, truncated: false };
  if (flags === null) {
    out.truncated = true;
    return out;
  }
  if (flags & 0x01) {
    const revs = c.u32();
    const eventT = c.u16();
    if (revs !== null && eventT !== null) out.wheel = { revs, eventT };
  }
  if (flags & 0x02) {
    const revs = c.u16();
    const eventT = c.u16();
    if (revs !== null && eventT !== null) out.crank = { revs, eventT };
  }
  out.truncated = c.truncated;
  return out;
}

// ---- revolution-data accumulator (cadence / speed from cumulative counters) ---

/**
 * Turns (cumulative revolutions, last event time) pairs into a rate.
 * Handles counter and timer rollover (mod counterBits / mod 2^16 ticks) and
 * the "no new event" case (identical event time → keep last rate, decay to
 * zero after `staleS` without events — rider stopped pedaling).
 */
export class RevolutionRate {
  private prevRevs: number | null = null;
  private prevT: number | null = null;
  private rate = 0; // rev/s
  private idleS = 0;
  private readonly ticksPerS: number;
  private readonly revsMod: number;
  private readonly staleS: number;

  constructor(ticksPerS: 1024 | 2048, revsBits: 16 | 32, staleS = 3.0) {
    this.ticksPerS = ticksPerS;
    this.revsMod = revsBits === 16 ? 0x10000 : 0x100000000;
    this.staleS = staleS;
  }

  /** feed one (revs, eventT) sample; dt = wall time since previous feed */
  push(revs: number, eventT: number, dt: number): void {
    if (this.prevRevs === null || this.prevT === null) {
      this.prevRevs = revs;
      this.prevT = eventT;
      return;
    }
    const dRevs = (revs - this.prevRevs + this.revsMod) % this.revsMod;
    const dTicks = (eventT - this.prevT + 0x10000) % 0x10000;
    if (dTicks > 0 && dRevs > 0) {
      // reject absurd jumps (sensor reset / reconnect): > 20 rev/s is garbage
      const r = dRevs / (dTicks / this.ticksPerS);
      if (r <= 20) this.rate = r;
      this.prevRevs = revs;
      this.prevT = eventT;
      this.idleS = 0;
    } else if (dRevs === 0) {
      // same counter — pedaling stopped; decay after stale window
      this.prevRevs = revs;
      this.prevT = eventT;
      this.idleS += dt;
      if (this.idleS >= this.staleS) this.rate = 0;
    }
  }

  /** advance idle clock on frames without a notification */
  tick(dt: number): void {
    this.idleS += dt;
    if (this.idleS >= this.staleS) this.rate = 0;
  }

  revPerS(): number {
    return this.rate;
  }

  reset(): void {
    this.prevRevs = null;
    this.prevT = null;
    this.rate = 0;
    this.idleS = 0;
  }
}

// ---- FTMS Indoor Bike Data 0x2AD2 (service 0x1826) ----------------------------

export interface IndoorBikeData {
  speedKmh: number | null;
  cadenceRpm: number | null;
  totalDistanceM: number | null;
  resistance: number | null;
  powerW: number | null;
  heartRateBpm: number | null;
  elapsedS: number | null;
  truncated: boolean;
}

/** flags u16 then fields in bit order. TRAP: bit 0 is "More Data" and is
 *  INVERTED — Instantaneous Speed is present when bit0 == 0 (single/final
 *  notification of a record); bit0 == 1 marks a continuation without speed.
 *  Resistance Level: spec history is ambiguous (GSS says u8, FTMS-era
 *  Assigned Numbers said s16) — real trainers ship s16 2 bytes and both
 *  pycycling and Auuki parse 2 bytes; we read s16. */
export function parseIndoorBikeData(dv: DataView): IndoorBikeData {
  const c = new Cursor(dv);
  const flags = c.u16();
  const out: IndoorBikeData = {
    speedKmh: null,
    cadenceRpm: null,
    totalDistanceM: null,
    resistance: null,
    powerW: null,
    heartRateBpm: null,
    elapsedS: null,
    truncated: false,
  };
  if (flags === null) {
    out.truncated = true;
    return out;
  }
  if ((flags & 0x0001) === 0) {
    const v = c.u16();
    if (v !== null) out.speedKmh = v / 100;
  }
  if (flags & 0x0002) c.skip(2); // average speed
  if (flags & 0x0004) {
    const v = c.u16();
    if (v !== null) out.cadenceRpm = v / 2;
  }
  if (flags & 0x0008) c.skip(2); // average cadence
  if (flags & 0x0010) {
    const v = c.u24();
    if (v !== null) out.totalDistanceM = v;
  }
  if (flags & 0x0020) {
    const v = c.i16();
    if (v !== null) out.resistance = v;
  }
  if (flags & 0x0040) {
    const v = c.i16();
    if (v !== null) out.powerW = v;
  }
  if (flags & 0x0080) c.skip(2); // average power
  if (flags & 0x0100) {
    // expended energy = total u16 + per-hour u16 + per-minute u8 (0xFFFF/0xFF
    // sentinels mean "not available"); dashboard doesn't use them — skip
    c.skip(5);
  }
  if (flags & 0x0200) {
    const v = c.u8();
    if (v !== null) out.heartRateBpm = v;
  }
  if (flags & 0x0400) c.skip(1); // metabolic equivalent
  if (flags & 0x0800) {
    const v = c.u16();
    if (v !== null) out.elapsedS = v;
  }
  if (flags & 0x1000) c.skip(2); // remaining time
  out.truncated = c.truncated;
  return out;
}

// ---- FTMS Fitness Machine Feature 0x2ACC ---------------------------------------

export interface FtmsFeatures {
  cadence: boolean;
  powerMeasurement: boolean;
  resistanceLevel: boolean;
  heartRate: boolean;
  powerTarget: boolean;
  resistanceTarget: boolean;
  indoorBikeSimulation: boolean;
  wheelCircumference: boolean;
  spinDown: boolean;
}

/** two u32 LE bitfields: machine features + target-setting features */
export function parseFtmsFeatures(dv: DataView): FtmsFeatures {
  const c = new Cursor(dv);
  const machine = c.u32() ?? 0;
  const targets = c.u32() ?? 0;
  return {
    cadence: (machine & (1 << 1)) !== 0,
    resistanceLevel: (machine & (1 << 7)) !== 0,
    heartRate: (machine & (1 << 10)) !== 0,
    powerMeasurement: (machine & (1 << 14)) !== 0,
    resistanceTarget: (targets & (1 << 2)) !== 0,
    powerTarget: (targets & (1 << 3)) !== 0,
    indoorBikeSimulation: (targets & (1 << 13)) !== 0,
    wheelCircumference: (targets & (1 << 14)) !== 0,
    spinDown: (targets & (1 << 15)) !== 0,
  };
}

// ---- FTMS Fitness Machine Control Point 0x2AD9 ---------------------------------

export const FTMS_OP = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetResistance: 0x04,
  setTargetPower: 0x05,
  start: 0x07,
  stop: 0x08,
  setIndoorBikeSimulation: 0x11,
  setWheelCircumference: 0x12,
  spinDownControl: 0x13,
  responseCode: 0x80,
} as const;

export const FTMS_RESULT = {
  success: 0x01,
  opNotSupported: 0x02,
  invalidParameter: 0x03,
  operationFailed: 0x04,
  controlNotPermitted: 0x05,
} as const;

/** Set Indoor Bike Simulation Parameters (op 0x11) request payload:
 *  wind s16 (0.001 m/s), grade s16 (0.01 %), Crr u8 (0.0001), Cw u8
 *  (0.01 kg/m). `grade` here is a FRACTION (0.05 = 5%) to match
 *  BikeRig.state().grade; clamped to the field ranges. */
export function encodeSimParams(
  windMs: number,
  grade: number,
  crr: number,
  cwKgM: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(7);
  const dv = new DataView(buf);
  dv.setUint8(0, FTMS_OP.setIndoorBikeSimulation);
  dv.setInt16(1, clampI16(Math.round(windMs * 1000)), true);
  dv.setInt16(3, clampI16(Math.round(grade * 100 * 100)), true); // % in 0.01 steps
  dv.setUint8(5, clampU8(Math.round(crr / 0.0001)));
  dv.setUint8(6, clampU8(Math.round(cwKgM / 0.01)));
  return buf;
}

export function encodeRequestControl(): ArrayBuffer {
  return new Uint8Array([FTMS_OP.requestControl]).buffer;
}

/** Set Target Power (op 0x05, ERG): s16 W */
export function encodeTargetPower(watts: number): ArrayBuffer {
  const buf = new ArrayBuffer(3);
  const dv = new DataView(buf);
  dv.setUint8(0, FTMS_OP.setTargetPower);
  dv.setInt16(1, clampI16(Math.round(watts)), true);
  return buf;
}

export interface FtmsCpResponse {
  requestOp: number;
  result: number;
  ok: boolean;
}

/** control-point response indication: 0x80, request op, result code */
export function parseFtmsCpResponse(dv: DataView): FtmsCpResponse | null {
  const c = new Cursor(dv);
  const rc = c.u8();
  if (rc !== FTMS_OP.responseCode) return null;
  const requestOp = c.u8();
  const result = c.u8();
  if (requestOp === null || result === null) return null;
  return { requestOp, result, ok: result === FTMS_RESULT.success };
}

function clampI16(v: number): number {
  return Math.max(-32768, Math.min(32767, v));
}
function clampU8(v: number): number {
  return Math.max(0, Math.min(255, v));
}
