/**
 * FitImport — a FIT decoder sufficient to re-read the FIT files our own
 * exporter (src/ride/RideRecorder.ts) writes, producing the same
 * ImportedActivity shape as CsvImport.
 *
 * Importing FIT lets recorded activity files round-trip back into "playback of
 * files". Scope matches what our encoder emits:
 *   - 14-byte header, little-endian body, no developer fields;
 *   - definition + data messages;
 *   - file_id (0), record (20), session (18), lap (19), activity (34);
 *   - CRC-16, tolerant of the body-only-CRC quirk: some files in the wild
 *     store a trailing file CRC computed over the BODY ONLY, not header+body,
 *     unlike strict Garmin FIT. We accept either and never reject on CRC.
 * The decoder is defensive beyond that (12-byte headers, big-endian
 * architecture, compressed-timestamp records, developer fields skipped) so a
 * foreign-but-valid FIT does not crash it.
 */

import type { ImportedActivity, ImportedRecord } from './types';

const FIT_EPOCH_OFFSET_S = 631065600; // 1989-12-31T00:00:00Z, unix seconds
const SEMI_PER_DEG = 2 ** 32 / 360; // semicircles per degree ≈ 11930464.711
const INVALID_U8 = 0xff;
const INVALID_U16 = 0xffff;
const INVALID_U32 = 0xffffffff;
const INVALID_S8 = 0x7f;
const INVALID_S16 = 0x7fff;
const INVALID_S32 = 0x7fffffff;

// global message numbers
const MSG_FILE_ID = 0;
const MSG_SESSION = 18;
const MSG_LAP = 19;
const MSG_RECORD = 20;
const MSG_ACTIVITY = 34;

/** FIT CRC-16 (nibble-table implementation). */
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
];
function fitCrc(bytes: Uint8Array, from = 0, to = bytes.length, seed = 0): number {
  let crc = seed;
  for (let i = from; i < to; i++) {
    const b = bytes[i]!;
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf]!;
    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf]!;
  }
  return crc & 0xffff;
}

/** one declared field in a definition message. */
interface FieldDef {
  num: number;
  size: number;
  baseType: number;
}
interface MessageDef {
  globalNum: number;
  littleEndian: boolean;
  fields: FieldDef[];
  /** total byte length of developer fields to skip in each data message */
  devBytes: number;
}

/** decoded field values of one data message, keyed by field number. */
type FieldMap = Map<number, number | string | null>;

export interface FitDecodeResult {
  activity: ImportedActivity;
  /** header CRC matched (or absent → true). */
  headerCrcOk: boolean;
  /** trailing CRC verification outcome. */
  bodyCrc: 'body-only' | 'header+body' | 'mismatch' | 'absent';
  /** non-fatal notes (unknown messages, CRC mismatch, …). */
  warnings: string[];
}

export class FitImportError extends Error {}

/** true type of a raw numeric value being the FIT "invalid" sentinel. */
function isInvalid(baseType: number, size: number, value: number): boolean {
  const signed = baseType === 0x01 || baseType === 0x83 || baseType === 0x85 || baseType === 0x8c;
  if (baseType === 0x07) return false; // string handled separately
  if (baseType === 0x88) return value === INVALID_U32; // float32 raw bits
  if (size === 1) return value === (signed ? INVALID_S8 : INVALID_U8);
  if (size === 2) return value === (signed ? INVALID_S16 : INVALID_U16);
  if (size === 4) return value === (signed ? INVALID_S32 : INVALID_U32);
  return false;
}

function isSigned(baseType: number): boolean {
  return baseType === 0x01 || baseType === 0x83 || baseType === 0x85 || baseType === 0x8c;
}

/**
 * Decode a FIT byte buffer. Accepts ArrayBuffer / Uint8Array. Throws
 * FitImportError only on structurally impossible input (bad magic / truncation
 * mid-message); CRC problems are reported, never thrown.
 */
export function decodeFit(input: ArrayBuffer | Uint8Array): FitDecodeResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings: string[] = [];
  if (bytes.length < 12) throw new FitImportError('FIT file too short for a header');

  const headerSize = bytes[0]!;
  if (headerSize !== 12 && headerSize !== 14) {
    throw new FitImportError(`Unexpected FIT header size ${headerSize}`);
  }
  // bytes 8..11 must spell ".FIT"
  if (
    bytes[8] !== 0x2e ||
    bytes[9] !== 0x46 ||
    bytes[10] !== 0x49 ||
    bytes[11] !== 0x54
  ) {
    throw new FitImportError('Missing .FIT signature');
  }
  const dataSize = bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | bytes[7]! * 2 ** 24;

  let headerCrcOk = true;
  if (headerSize === 14) {
    const stored = bytes[12]! | (bytes[13]! << 8);
    // A zero stored header CRC means "not computed" (some writers) → accept.
    if (stored !== 0) headerCrcOk = fitCrc(bytes, 0, 12) === stored;
  }

  const bodyStart = headerSize;
  const bodyEnd = Math.min(bodyStart + dataSize, bytes.length);
  // Trailing 2-byte CRC (if present) sits at bodyEnd.
  let bodyCrc: FitDecodeResult['bodyCrc'] = 'absent';
  if (bytes.length >= bodyEnd + 2) {
    const stored = bytes[bodyEnd]! | (bytes[bodyEnd + 1]! << 8);
    const overBody = fitCrc(bytes, bodyStart, bodyEnd);
    const overHeaderBody = fitCrc(bytes, 0, bodyEnd);
    if (stored === overBody) bodyCrc = 'body-only'; // trailing CRC over the body only
    else if (stored === overHeaderBody) bodyCrc = 'header+body'; // strict FIT
    else {
      bodyCrc = 'mismatch';
      warnings.push('Trailing CRC matched neither body-only nor header+body');
    }
  }

  // ---- walk the message stream --------------------------------------------
  const defs = new Map<number, MessageDef>(); // local type → definition
  const records: FieldMap[] = [];
  let fileId: FieldMap | null = null;
  let session: FieldMap | null = null;
  let lap: FieldMap | null = null;
  let activityMsg: FieldMap | null = null;

  let p = bodyStart;
  while (p < bodyEnd) {
    const header = bytes[p]!;
    p++;
    if ((header & 0x80) !== 0) {
      // compressed timestamp header: local type in bits 5-6, 5-bit time offset.
      const localType = (header >> 5) & 0x03;
      const def = defs.get(localType);
      if (!def) {
        warnings.push(`Compressed-timestamp data for undefined local type ${localType}`);
        break; // cannot know payload length → stop safely
      }
      const { map, consumed } = readDataMessage(bytes, p, def);
      p += consumed;
      dispatch(def.globalNum, map);
      continue;
    }

    const localType = header & 0x0f;
    const isDefinition = (header & 0x40) !== 0;
    const hasDev = (header & 0x20) !== 0;

    if (isDefinition) {
      if (p + 5 > bodyEnd) throw new FitImportError('Truncated definition message');
      // reserved (p), architecture (p+1), globalNum (p+2..3), fieldCount (p+4)
      const littleEndian = bytes[p + 1]! === 0;
      const globalNum = littleEndian
        ? bytes[p + 2]! | (bytes[p + 3]! << 8)
        : (bytes[p + 2]! << 8) | bytes[p + 3]!;
      const fieldCount = bytes[p + 4]!;
      p += 5;
      const fields: FieldDef[] = [];
      for (let i = 0; i < fieldCount; i++) {
        if (p + 3 > bodyEnd) throw new FitImportError('Truncated field definition');
        fields.push({ num: bytes[p]!, size: bytes[p + 1]!, baseType: bytes[p + 2]! });
        p += 3;
      }
      let devBytes = 0;
      if (hasDev) {
        if (p >= bodyEnd) throw new FitImportError('Truncated developer field count');
        const devCount = bytes[p]!;
        p++;
        for (let i = 0; i < devCount; i++) {
          if (p + 3 > bodyEnd) throw new FitImportError('Truncated developer field def');
          devBytes += bytes[p + 1]!; // size byte
          p += 3;
        }
      }
      defs.set(localType, { globalNum, littleEndian, fields, devBytes });
    } else {
      const def = defs.get(localType);
      if (!def) throw new FitImportError(`Data message for undefined local type ${localType}`);
      const { map, consumed } = readDataMessage(bytes, p, def);
      p += consumed;
      dispatch(def.globalNum, map);
    }
  }

  function dispatch(globalNum: number, map: FieldMap): void {
    switch (globalNum) {
      case MSG_FILE_ID:
        if (!fileId) fileId = map;
        break;
      case MSG_RECORD:
        records.push(map);
        break;
      case MSG_SESSION:
        if (!session) session = map;
        break;
      case MSG_LAP:
        if (!lap) lap = map;
        break;
      case MSG_ACTIVITY:
        if (!activityMsg) activityMsg = map;
        break;
      default:
        // file_creator (49), device_info (23), event (21), sport (12), … —
        // decoded and ignored; they carry nothing the ImportedActivity needs.
        break;
    }
  }

  const activity = assemble(fileId, records, session, lap, activityMsg);
  return { activity, headerCrcOk, bodyCrc, warnings };
}

/** read one data message's fields; returns the map and bytes consumed. */
function readDataMessage(
  bytes: Uint8Array,
  offset: number,
  def: MessageDef,
): { map: FieldMap; consumed: number } {
  const map: FieldMap = new Map();
  let p = offset;
  for (const f of def.fields) {
    if (f.baseType === 0x07) {
      // string — read up to `size` bytes, stop at NUL, UTF-8 decode.
      const raw = bytes.subarray(p, p + f.size);
      let end = raw.indexOf(0);
      if (end < 0) end = raw.length;
      map.set(f.num, decodeUtf8(raw.subarray(0, end)));
      p += f.size;
      continue;
    }
    const natural = naturalSize(f.baseType);
    if (natural > 0 && f.size === natural) {
      const value = readInt(bytes, p, f.size, def.littleEndian, isSigned(f.baseType));
      map.set(f.num, isInvalid(f.baseType, f.size, rawUnsigned(bytes, p, f.size, def.littleEndian)) ? null : value);
    } else {
      // array field or unknown base type → skip its bytes (value unavailable).
      map.set(f.num, null);
    }
    p += f.size;
  }
  return { map, consumed: p - offset + def.devBytes };
}

function naturalSize(baseType: number): number {
  switch (baseType) {
    case 0x00: // enum
    case 0x01: // sint8
    case 0x02: // uint8
    case 0x0a: // uint8z
    case 0x0d: // byte
      return 1;
    case 0x83: // sint16
    case 0x84: // uint16
    case 0x8b: // uint16z
      return 2;
    case 0x85: // sint32
    case 0x86: // uint32
    case 0x8c: // uint32z
    case 0x88: // float32
      return 4;
    default:
      return 0;
  }
}

function rawUnsigned(bytes: Uint8Array, p: number, size: number, le: boolean): number {
  // sizes are ≤ 4 here, so a plain JS number holds the full u32 range exactly.
  let v = 0;
  if (le) {
    for (let i = size - 1; i >= 0; i--) v = v * 256 + bytes[p + i]!;
  } else {
    for (let i = 0; i < size; i++) v = v * 256 + bytes[p + i]!;
  }
  return v;
}

function readInt(bytes: Uint8Array, p: number, size: number, le: boolean, signed: boolean): number {
  const u = rawUnsigned(bytes, p, size, le);
  if (!signed) return u;
  const bits = size * 8;
  const signBit = 2 ** (bits - 1);
  return u >= signBit ? u - 2 ** bits : u;
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function num(map: FieldMap | null, field: number): number | null {
  if (!map) return null;
  const v = map.get(field);
  return typeof v === 'number' ? v : null;
}
function str(map: FieldMap | null, field: number): string | null {
  if (!map) return null;
  const v = map.get(field);
  return typeof v === 'string' ? v : null;
}

/** FIT sport id → ActivityType string (inverse of the encoder's sport mapping). */
function fitSportToActivityType(sportId: number | null): string {
  switch (sportId) {
    case 1:
      return 'Run';
    case 2:
      return 'Ride';
    case 5:
      return 'Swim';
    case 11:
      return 'Walk';
    case 12:
      return 'NordicSki';
    case 15:
      return 'Rowing';
    case 41:
      return 'Kayaking';
    default:
      return 'Ride'; // our files are cycling; sane default
  }
}

/** FIT timestamp (seconds since 1989-12-31) → ms since Unix epoch, or null. */
function fitTsToMs(seconds: number | null): number | null {
  if (seconds === null) return null;
  return (seconds + FIT_EPOCH_OFFSET_S) * 1000;
}

function assemble(
  fileId: FieldMap | null,
  recordMsgs: FieldMap[],
  session: FieldMap | null,
  lap: FieldMap | null,
  activityMsg: FieldMap | null,
): ImportedActivity {
  const totals = session ?? lap; // session preferred; lap is the fallback

  // start / end
  const sessionStartMs = fitTsToMs(num(totals, 2)); // start_time
  const firstRecTsMs = recordMsgs.length ? fitTsToMs(num(recordMsgs[0]!, 253)) : null;
  const fileCreatedMs = fitTsToMs(num(fileId, 4)); // time_created
  const startMs = sessionStartMs ?? firstRecTsMs ?? fileCreatedMs ?? Date.now();

  const sessionEndMs = fitTsToMs(num(totals, 253)); // end_time / timestamp
  const activityTsMs = fitTsToMs(num(activityMsg, 253));
  const lastRecTsMs = recordMsgs.length
    ? fitTsToMs(num(recordMsgs[recordMsgs.length - 1]!, 253))
    : null;
  const endMs = sessionEndMs ?? activityTsMs ?? lastRecTsMs ?? null;

  // records
  const records: ImportedRecord[] = recordMsgs.map((m) => {
    const tsMs = fitTsToMs(num(m, 253));
    const latRaw = num(m, 0); // position_lat, semicircles
    const lonRaw = num(m, 1); // position_long
    const altRaw = num(m, 2); // altitude, (m+500)*5
    const speedRaw = num(m, 6); // mm/s
    const distRaw = num(m, 5); // cm
    return {
      timeStampMs: tsMs,
      distance: distRaw === null ? null : distRaw / 100, // m
      elapsed: tsMs === null ? null : Math.round((tsMs - startMs) / 1000),
      elapsedMillis: tsMs === null ? null : tsMs - startMs,
      calories: null, // FIT records carry no per-sample calories
      power: num(m, 7), // W
      speed: speedRaw === null ? null : (speedRaw / 1000) * 3.6, // km/h
      cadence: num(m, 4), // rpm
      heartRate: num(m, 3), // bpm
      lat: latRaw === null ? null : latRaw / SEMI_PER_DEG,
      lon: lonRaw === null ? null : lonRaw / SEMI_PER_DEG,
      altitude: altRaw === null ? null : altRaw / 5 - 500, // m
    };
  });

  // totals — session values when present, else derived from records
  const totalDistanceRaw = num(totals, 9); // cm
  const lastRecDist = records.length ? records[records.length - 1]!.distance : null;
  const distance = totalDistanceRaw !== null ? totalDistanceRaw / 100 : lastRecDist ?? 0;

  const totalElapsedMs = num(totals, 7); // total_elapsed_time, ms
  const derivedElapsedS =
    firstRecTsMs !== null && lastRecTsMs !== null
      ? Math.round((lastRecTsMs - firstRecTsMs) / 1000)
      : 0;
  const elapsed = totalElapsedMs !== null ? Math.round(totalElapsedMs / 1000) : derivedElapsedS;

  const totalTimerMs = num(totals, 8); // total_timer_time, ms
  const movingTime = totalTimerMs !== null ? totalTimerMs : elapsed * 1000;

  const calories = num(totals, 11) ?? 0; // total_calories, kcal
  const strides = num(totals, 10) ?? 0; // total_cycles

  const sport = fitSportToActivityType(num(totals, 5)); // session/lap sport id

  const manufacturer = num(fileId, 1);
  const productName = str(fileId, 8);
  const deviceName = productName ?? (manufacturer !== null ? `FIT manufacturer ${manufacturer}` : 'FIT import');

  return {
    deviceName,
    deviceId: 'FitImport',
    hrmId: '',
    startMs,
    endMs,
    distance,
    elapsed,
    movingTime,
    calories,
    strides,
    sport,
    fourCC: '',
    powerFactor: 1.0,
    calorieFactor: 1.0,
    hrCalorieFactor: 1.0,
    hrmCalorieFactor: 1.0,
    hrBasedCalories: false,
    timeZone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })(),
    source: 'fit',
    records,
  };
}

/** convenience: decode and return just the activity (throws on hard errors). */
export function importFit(input: ArrayBuffer | Uint8Array): ImportedActivity {
  return decodeFit(input).activity;
}
