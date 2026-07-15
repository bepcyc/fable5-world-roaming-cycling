/**
 * ANT+-over-BLE tunnel frame codec — Tacx/Garmin "FE-C over BLE"
 * (6e40fec1-b5a3-f393-e0a9-e50e24dcca9e). This is the ONLY resistance-
 * control path for the owner's real Tacx Smart Bike 12583: it advertises
 * and connects with NO 0x1826 FTMS anywhere in its GATT tree (measured
 * live, both advertisement and full connected discovery).
 *
 * Frame (13 bytes on the wire, verified against pycycling's
 * tacx_trainer_control.py — real working code against Tacx hardware):
 *   [0] 0xA4 sync
 *   [1] 0x09 length (channel byte + 8 page bytes = 9)
 *   [2] 0x4F msg id (tunneled ANT broadcast data)
 *   [3] 0x05 channel
 *   [4..11] 8 page bytes: page id + 7 content bytes
 *   [12] checksum = sum(frame[1..11]) & 0xFF (plain additive, NOT the XOR
 *        checksum raw ANT+ RF uses — this additive form is what ships
 *        against real Tacx hardware over the BLE tunnel specifically)
 *
 * Pages implemented (deliberately minimal — see docs/BLE_ZWIFT_PLAN.md
 * risks: page 55 user-config bit-packing was never independently verified,
 * so it is NOT implemented):
 *   16 (0x10) General FE Data       — telemetry: speed, heart rate
 *   25 (0x19) Specific Trainer Data — telemetry: cadence, inst./acc. power
 *   48 (0x30) Basic Resistance      — control: 0-100% in 0.5% steps
 *   49 (0x31) Target Power (ERG)    — control: 0.25 W resolution
 *   51 (0x33) Track Resistance      — control: grade, ±200% at 0.01% steps
 *   71 (0x47) Command Status        — ack: last command + sequence + result
 */

export const FEC_PAGE = {
  generalFeData: 0x10,
  specificTrainerData: 0x19,
  basicResistance: 0x30,
  targetPower: 0x31,
  trackResistance: 0x33,
  commandStatus: 0x47,
} as const;

const FEC_SYNC = 0xa4;
const FEC_MSG_ID = 0x4f; // ANT broadcast data tunneled over BLE
const FEC_CHANNEL = 0x05;
const RESERVED = 0xff; // ANT+ reserved-field convention

/** wrap an 8-byte page (page id + 7 content bytes) into the 13-byte tunnel
 *  frame with its additive checksum. */
export function encodeFecFrame(page: readonly number[]): ArrayBuffer {
  if (page.length !== 8) throw new Error(`FE-C page must be exactly 8 bytes, got ${page.length}`);
  const frame = new Uint8Array(13);
  frame[0] = FEC_SYNC;
  frame[1] = 0x09;
  frame[2] = FEC_MSG_ID;
  frame[3] = FEC_CHANNEL;
  frame.set(page, 4);
  let checksum = 0;
  for (let i = 1; i <= 11; i++) checksum = (checksum + (frame[i] ?? 0)) & 0xff;
  frame[12] = checksum;
  return frame.buffer;
}

export interface DecodedFecFrame {
  pageId: number;
  page: number[]; // the 8 raw page bytes, page[0] === pageId
  checksumOk: boolean;
}

/** unwrap a 13-byte tunnel frame; defensive per the project's parsing
 *  contract — truncated/malformed payloads return null, never throw. */
export function decodeFecFrame(dv: DataView): DecodedFecFrame | null {
  if (dv.byteLength < 13) return null;
  if (dv.getUint8(0) !== FEC_SYNC) return null;
  let checksum = 0;
  for (let i = 1; i <= 11; i++) checksum = (checksum + dv.getUint8(i)) & 0xff;
  const page: number[] = [];
  for (let i = 0; i < 8; i++) page.push(dv.getUint8(4 + i));
  return { pageId: page[0] ?? -1, page, checksumOk: checksum === dv.getUint8(12) };
}

// ---- control pages (client → trainer) ------------------------------------------

/** Page 48 (0x30) Basic Resistance — 0-100% total resistance, 0.5% steps
 *  (raw = round(percent×2), clamped 0..200). NOT newtons — the "0-200 in
 *  newtons" note in an earlier draft of this project's research was a
 *  transcription artifact, corrected against pycycling's source. */
export function encodeBasicResistance(percent: number): readonly number[] {
  const raw = Math.max(0, Math.min(200, Math.round(percent * 2)));
  return [FEC_PAGE.basicResistance, RESERVED, RESERVED, RESERVED, RESERVED, RESERVED, RESERVED, raw];
}

/** Page 49 (0x31) Target Power (ERG mode) — uint16 LE, 0.25 W resolution.
 *  CLAMP CONFLICT (codex build-review, 2026-07-15): this project's own
 *  phase-1 research said 0-4000 W; codex's review cited the ANT+ FE-C
 *  Android SDK docs for the trainer target-power range as 0-1000 W
 *  (thisisant.com AntPlusFitnessEquipmentPcc.TrainerMethods). Neither was
 *  independently re-verified against the primary ANT+ FE-C spec PDF this
 *  session. Clamping to the LOWER (more conservative) bound is the safe
 *  direction when uncertain: a too-low ceiling only means the trainer
 *  never gets asked for wattage a real rider is unlikely to hold in ERG
 *  mode anyway (fails safe — request under-delivers, visibly, never
 *  over-delivers); a too-high ceiling risks sending an out-of-spec value
 *  to real hardware we have not tested against physically. */
export function encodeTargetPower(watts: number): readonly number[] {
  const raw = Math.max(0, Math.min(4000, Math.round(watts * 4)));
  return [
    FEC_PAGE.targetPower,
    RESERVED,
    RESERVED,
    RESERVED,
    RESERVED,
    RESERVED,
    raw & 0xff,
    (raw >> 8) & 0xff,
  ];
}

/** Page 51 (0x33) Track Resistance (SIM/grade) — grade is an UNSIGNED
 *  offset-biased uint16: raw = round((gradePercent + 200) / 0.01), the
 *  +200 bias itself doing the sign-handling (covers -200%..+200% at 0.01%
 *  resolution). Rolling-resistance coefficient: uint8, 5e-5 resolution. */
export function encodeTrackResistance(gradePercent: number, crr = 0.004): readonly number[] {
  const g = Math.max(-200, Math.min(200, gradePercent));
  const raw = Math.max(0, Math.min(0xffff, Math.round((g + 200) / 0.01)));
  const crrRaw = Math.max(0, Math.min(255, Math.round(crr / 5e-5)));
  return [
    FEC_PAGE.trackResistance,
    RESERVED,
    RESERVED,
    RESERVED,
    RESERVED,
    raw & 0xff,
    (raw >> 8) & 0xff,
    crrRaw,
  ];
}

export function decodeTrackResistanceGrade(page: readonly number[]): number {
  const raw = ((page[6] ?? 0) << 8) | (page[5] ?? 0);
  return raw * 0.01 - 200;
}

// ---- telemetry pages (trainer → client) -----------------------------------------

export interface GeneralFeData {
  /** m/s; null = 0xFFFF sentinel (invalid — no unit conversion needed
   *  client-side, unlike CPS/CSC wheel-revolution speed, which is why this
   *  is the FE-C speed capability's actual source, see Capabilities.ts) */
  speedMs: number | null;
  /** bpm; null = 0xFF sentinel (invalid) */
  heartRateBpm: number | null;
}

/** Page 16 (0x10) General FE Data: byte1 equipment type, byte2 elapsed
 *  time (0.25 s units, not decoded — not needed by the dashboard), byte3
 *  distance (1 m units, not decoded), bytes4-5 speed (uint16 LE, 0.001
 *  m/s units), byte6 heart rate, byte7 FE state + lap-toggle bits (not
 *  decoded). */
export function decodeGeneralFeData(page: readonly number[]): GeneralFeData {
  const speedRaw = ((page[5] ?? 0) << 8) | (page[4] ?? 0);
  const hrRaw = page[6] ?? 0xff;
  return {
    speedMs: speedRaw === 0xffff ? null : speedRaw / 1000,
    heartRateBpm: hrRaw === 0xff ? null : hrRaw,
  };
}

export interface SpecificTrainerData {
  updateEventCount: number;
  /** rpm; null = 0xFF sentinel (invalid) */
  cadenceRpm: number | null;
  /** accumulated power, W, wraps mod 65536 */
  accPowerW: number;
  /** instantaneous power, W; null = 0xFFF sentinel (invalid) */
  instPowerW: number | null;
}

/** Page 25 (0x19) Specific Trainer/Stationary Bike Data:
 *  byte1 update-event-count, byte2 instantaneous cadence (0xFF invalid),
 *  bytes3-4 accumulated power (u16 LE), bytes5-6 a packed u16 LE whose low
 *  12 bits are instantaneous power (0xFFF invalid) and whose high 4 bits
 *  are trainer status flags (not decoded — not needed by the dashboard). */
export function decodeSpecificTrainerData(page: readonly number[]): SpecificTrainerData {
  const cadenceRaw = page[2] ?? 0xff;
  const accPowerW = ((page[4] ?? 0) << 8) | (page[3] ?? 0);
  const packed = ((page[6] ?? 0) << 8) | (page[5] ?? 0);
  const instPowerRaw = packed & 0x0fff;
  return {
    updateEventCount: page[1] ?? 0,
    cadenceRpm: cadenceRaw === 0xff ? null : cadenceRaw,
    accPowerW,
    instPowerW: instPowerRaw === 0xfff ? null : instPowerRaw,
  };
}

// ---- command status (ack) --------------------------------------------------------

export interface CommandStatus {
  lastCommandPageId: number;
  sequenceNumber: number;
  statusCode: number;
}

/** Page 71 (0x47) Command Status: byte1 last-received-command page id,
 *  byte2 sequence number, byte3 status code, bytes4-7 response data
 *  (command-specific, not decoded generically here). */
export function decodeCommandStatus(page: readonly number[]): CommandStatus {
  return {
    lastCommandPageId: page[1] ?? 0,
    sequenceNumber: page[2] ?? 0,
    statusCode: page[3] ?? 0,
  };
}
