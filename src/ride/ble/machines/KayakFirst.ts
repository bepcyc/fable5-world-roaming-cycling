/**
 * KayakFirst — serial-over-BLE on a single notify+write characteristic. ASCII
 * commands terminated with CRLF, chunked at a 20-byte MTU; data frames start
 * with '6' (0x36) and are ';'-separated. isPolling (poll "6" every 1000 ms),
 * fragmentedPackets (frames reassembled until a CRLF terminator).
 */

export const KAYAK_FIRST_SERVICE = 0xffe0;
export const KAYAK_FIRST_CHR = {
  allAround: 0xffe1, // notify + write (control point = this char)
  readWrite: 0x2901,
  readOnly: 0x2902,
} as const;

export const KAYAK_MTU = 20;
export const KAYAK_DATA_STREAM_FLAG = 0x36; // ASCII '6'
export const KAYAK_SEPARATOR = 0x3b; // ASCII ';'
const CRLF = '\r\n';
export const KAYAK_BOAT_WEIGHT_DEFAULT = 12;

export const KAYAK_CMD = {
  reset: '1',
  handshake: '2',
  newHandshake: '21',
  configuration: '3',
  displayConfiguration: '5',
  pollData: '6',
  parameters: '8',
  start: '9;1',
  stop: '9;3',
} as const;

const RESET_BYTE = 0x31;
const HANDSHAKE_BYTE = 0x32;
const CONFIGURATION_BYTE = 0x33;
const DISPLAY_CONFIG_BYTE = 0x35;
const START_STOP_BYTE = 0x39;

/** keySelector "whole packet" flag values. */
export const KAYAK_VALID_FLAGS: readonly number[] = [
  RESET_BYTE + 0x0d * 256,
  RESET_BYTE + KAYAK_SEPARATOR * 256,
  RESET_BYTE + 1 * 256,
  HANDSHAKE_BYTE + KAYAK_SEPARATOR * 256,
  CONFIGURATION_BYTE + KAYAK_SEPARATOR * 256,
  DISPLAY_CONFIG_BYTE + KAYAK_SEPARATOR * 256,
  KAYAK_DATA_STREAM_FLAG + KAYAK_SEPARATOR * 256,
  START_STOP_BYTE + KAYAK_SEPARATOR * 256,
];

/** encode a command (+CRLF) into ≤20-byte MTU chunks (fragmented write). */
export function encodeKayakCommand(command: string): Uint8Array[] {
  const full = new TextEncoder().encode(command + CRLF);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < full.length; i += KAYAK_MTU) chunks.push(full.slice(i, i + KAYAK_MTU));
  return chunks.length > 0 ? chunks : [new Uint8Array(0)];
}

export interface KayakHandshakeArgs {
  isNew: boolean;
  unixEpochSec: number;
  tzOffsetMinutes: number;
  athleteWeightKg: number;
  isKayaking: boolean;
  boatWeight?: number;
}

/** handshake payload "<2|21>;<epoch>;<tzMin>;<weight>;<sportFlag|boatWeight>". */
export function buildKayakHandshake(a: KayakHandshakeArgs): string {
  const prefix = a.isNew ? KAYAK_CMD.newHandshake : KAYAK_CMD.handshake;
  let cmd = `${prefix};${a.unixEpochSec};${a.tzOffsetMinutes};${a.athleteWeightKg};`;
  if (prefix === KAYAK_CMD.handshake) cmd += a.isKayaking ? '1' : '2';
  else cmd += String(a.boatWeight ?? KAYAK_BOAT_WEIGHT_DEFAULT);
  return cmd;
}

/** display-config command "5;<slot>;<slot>;…" (one per configured display slot). */
export function buildKayakDisplayConfig(slots: readonly number[]): string {
  return KAYAK_CMD.displayConfiguration + slots.map((s) => `;${s}`).join('');
}

/** a gathered fragment is whole when it ends CRLF, or is the 2-byte reset ack. */
export function isKayakWholePacket(d: Uint8Array): boolean {
  const n = d.length;
  return (n >= 2 && d[n - 1] === 0x0a && d[n - 2] === 0x0d) || (n === 2 && d[0] === RESET_BYTE && d[1] === 1);
}

/** drop the 3-byte "6\r\n" noise frame and all-zero/one noise. */
export function skipKayakPacket(d: Uint8Array): boolean {
  if (d.length === 3 && d[0] === KAYAK_DATA_STREAM_FLAG && d[2] === 0x0a && d[1] === 0x0d) return true;
  return d.length > 0 && d.every((e) => e === 0 || e === 1);
}

export interface KayakRecord {
  distanceM: number | null;
  elapsedS: number | null;
  powerW: number | null;
  speedKmh: number | null;
  cadenceRpm: number | null;
}

function num(parts: string[], i: number): number | null {
  const v = parts[i];
  if (v === undefined) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function int(parts: string[], i: number): number | null {
  const n = num(parts, i);
  return n === null ? null : Math.trunc(n);
}

/** parse a data frame (starts with '6', ';'-split, needs ≥24 fields):
 *  distance=parts[9], speed=parts[11]*3.6 (m/s→km/h), cadence=parts[13],
 *  power=parts[21], elapsed=parts[22]. */
export function parseKayakData(d: Uint8Array): KayakRecord | null {
  if (d.length === 0 || d[0] !== KAYAK_DATA_STREAM_FLAG) return null;
  const parts = new TextDecoder().decode(d).split(';');
  if (parts.length < 24) return null;
  const speedMs = num(parts, 11) ?? 0;
  return {
    distanceM: num(parts, 9),
    elapsedS: int(parts, 22),
    powerW: int(parts, 21),
    speedKmh: speedMs * 3.6,
    cadenceRpm: int(parts, 13),
  };
}
