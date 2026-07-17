/**
 * FIT binary encoder. Little-endian throughout: a 14-byte header, a body of
 * definition + data messages, and a trailing 2-byte CRC.
 *
 * Two behaviours worth calling out:
 *  - non-null integers are clamped to (threshold - 2) before emission, so a
 *    value forced to an "invalid" constant (0xFF, 0xFFFF) comes out one less
 *    (0xFE, 0xFFFE).
 *  - the trailing file CRC covers the BODY ONLY, not the 14 header bytes.
 * Consumes an ExportModel and returns the file bytes.
 */

import {
  ActivityType,
  dartRound,
  degToFitGps,
  fitEpochUnixSeconds,
  maxUint8,
  maxUint16,
  maxUint24,
  maxUint32,
} from './Model';
import { ExportTarget, suuntoFitId, type ExportModel, type ExportRecord } from './ExportModel';

// ---- FIT base types ---------------------------------------------------------
const BT = {
  enum: { id: 0x00, size: 1 },
  sint8: { id: 0x01, size: 1 },
  uint8: { id: 0x02, size: 1 },
  sint16: { id: 0x83, size: 2 },
  uint16: { id: 0x84, size: 2 },
  sint32: { id: 0x85, size: 4 },
  uint32: { id: 0x86, size: 4 },
  string: { id: 0x07, size: 1 },
} as const;

// ---- FIT enum values --------------------------------------------------------
const FitFileType = { activity: 4 };
const FitProductEnum = { suunto7: 40 };
const FitDeviceType = { fitnessEquipment: 17 };
const FitSourceType = { antPlus: 1, bluetoothLowEnergy: 3 };
const FitActivityEnum = { manual: 0 };
const FitEventEnum = { timer: 0, session: 8, lap: 9, activity: 26 };
const FitEventType = { start: 0, stop: 1 };
const FitSessionTrigger = { activityEnd: 0 };
const FitLapTrigger = { sessionEnd: 7 };
const FIT_MESSAGE = {
  fileId: 0,
  sport: 12,
  session: 18,
  lap: 19,
  record: 20,
  event: 21,
  deviceInfo: 23,
  activity: 34,
  fileCreator: 49,
};

const FIT_HEADER_SIZE = 14;
const FIT_PROTOCOL_VERSION = 0x20; // 32
const FIT_PROFILE_VERSION = 2083; // 0x0823

// ---- CRC-16 -----------------------------------------------------------------
const crcTable = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
];

function crcByte(crc: number, byte: number): number {
  let tmp = crcTable[crc & 0xf] as number;
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ (crcTable[byte & 0xf] as number);
  tmp = crcTable[crc & 0xf] as number;
  crc = (crc >> 4) & 0x0fff;
  crc = crc ^ tmp ^ (crcTable[(byte >> 4) & 0xf] as number);
  return crc;
}

export function crcData(data: number[]): number {
  let crc = 0;
  for (const b of data) crc = crcByte(crc, b);
  return crc;
}

/** Seconds since the FIT epoch (1989-12-31Z). Null -> 0. */
export function fitTimeStamp(dateTime: Date | null): number {
  if (dateTime === null) return 0;
  return Math.trunc((dateTime.getTime() - fitEpochUnixSeconds * 1000) / 1000);
}

/** FIT altitude = round((altitude + 500) * 5) (scale 5, offset 500 m). */
export function convertAltitudeForFit(altitude: number): number {
  return dartRound((altitude + 500) * 5);
}

// ---- primitive writer -------------------------------------------------------
class FitWriter {
  out: number[] = [];

  addNonFloatingNumber(value: number | null, length: number, signed = false): void {
    const wasNull = value === null;
    let n: number;
    if (value === null) {
      if (length === 1) n = signed ? 0x7f : 0xff;
      else if (length === 2) n = signed ? 0x7fff : 0xffff;
      else if (length === 4) n = signed ? 0x7fffffff : 0xffffffff;
      else n = 0;
    } else {
      n = value;
    }

    let threshold = maxUint8;
    if (length === 2) threshold = maxUint16;
    else if (length === 3) threshold = maxUint24;
    else if (length === 4) threshold = maxUint32;

    if (n < 0) n += threshold; // two's-complement wrap

    if (!wasNull) {
      // Clamp non-null values to threshold-2 (keeps clear of the invalid
      // constant); a forced 0xFF/0xFFFF therefore emits as 0xFE/0xFFFE.
      n = Math.min(n, threshold - 2);
    }

    for (let i = 0; i < length; i++) {
      this.out.push(n % maxUint8);
      n = Math.trunc(n / maxUint8);
    }
  }

  addByte(v: number | null, signed = false): void {
    this.addNonFloatingNumber(v, 1, signed);
  }
  addShort(v: number | null, signed = false): void {
    this.addNonFloatingNumber(v, 2, signed);
  }
  addLong(v: number | null, signed = false): void {
    this.addNonFloatingNumber(v, 4, signed);
  }
  addString(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const b of bytes) this.out.push(b);
    this.out.push(0);
  }
  addGpsCoordinate(coordinate: number): void {
    this.addLong(dartRound(coordinate * degToFitGps), true);
  }
}

interface FitFieldDef {
  num: number;
  size: number;
  base: number;
}
function f(num: number, bt: { id: number; size: number }): FitFieldDef {
  return { num, size: bt.size, base: bt.id };
}
function strField(num: number, length: number): FitFieldDef {
  return { num, size: length + 1, base: BT.string.id };
}

/** Definition message: header|0x40, reserved, arch, global(LE), count, fields. */
function buildDefinition(local: number, global: number, fields: FitFieldDef[]): number[] {
  const w = new FitWriter();
  w.addByte(local + 0x40);
  w.addByte(0); // reserved
  w.addByte(0); // architecture (little-endian)
  w.addShort(global);
  w.addByte(fields.length);
  for (const fd of fields) {
    w.out.push(fd.num, fd.size, fd.base);
  }
  return w.out;
}

// ---- sport mapping ----------------------------------------------------------
const cyclingSportId = 2;
const runningSportId = 1;
const fitnessEquipmentSportId = 4;
const swimmingSportId = 5;
const genericSportId = 0;
const trainingSportId = 10;
const paddlingSportId = 19;

const fitSportMap: Readonly<Record<string, [number, number]>> = {
  [ActivityType.alpineSki]: [13, 9],
  [ActivityType.backcountrySki]: [12, 0],
  [ActivityType.canoeing]: [paddlingSportId, 0],
  [ActivityType.crossfit]: [trainingSportId, 0],
  [ActivityType.eBikeRide]: [cyclingSportId, 28],
  [ActivityType.elliptical]: [fitnessEquipmentSportId, 15],
  [ActivityType.golf]: [25, 0],
  [ActivityType.handcycle]: [genericSportId, 12],
  [ActivityType.hike]: [17, 3],
  [ActivityType.iceSkate]: [33, 0],
  IndoorRowing: [fitnessEquipmentSportId, 14],
  IndoorRunning: [runningSportId, 45],
  [ActivityType.inlineSkate]: [30, 0],
  [ActivityType.kayaking]: [41, 0],
  [ActivityType.kitesurf]: [44, 0],
  [ActivityType.nordicSki]: [12, 0],
  OpenWaterSwim: [swimmingSportId, 18],
  Paddling: [paddlingSportId, 0],
  [ActivityType.ride]: [cyclingSportId, 0],
  [ActivityType.rockClimbing]: [48, 0],
  [ActivityType.rollerSki]: [genericSportId, 0],
  [ActivityType.rowing]: [15, 0],
  [ActivityType.run]: [runningSportId, 0],
  [ActivityType.sail]: [32, 0],
  [ActivityType.skateboard]: [genericSportId, 0],
  [ActivityType.snowboard]: [14, 0],
  [ActivityType.snowshoe]: [35, 0],
  [ActivityType.soccer]: [7, 0],
  [ActivityType.stairStepper]: [fitnessEquipmentSportId, 16],
  [ActivityType.standUpPaddling]: [37, 0],
  [ActivityType.surfing]: [38, 0],
  [ActivityType.swim]: [swimmingSportId, 0],
  Treadmill: [runningSportId, 1],
  TrackRide: [cyclingSportId, 13],
  TrackRun: [runningSportId, 4],
  [ActivityType.velomobile]: [genericSportId, 0],
  [ActivityType.virtualRide]: [cyclingSportId, 6],
  [ActivityType.virtualRun]: [runningSportId, 1],
  VirtualRowing: [paddlingSportId, 14],
  [ActivityType.walk]: [11, 0],
  [ActivityType.weightTraining]: [trainingSportId, 0],
  [ActivityType.wheelchair]: [genericSportId, 0],
  [ActivityType.windsurf]: [43, 0],
  [ActivityType.workout]: [genericSportId, 0],
  [ActivityType.yoga]: [trainingSportId, 43],
};

/** [sportId, subSportId]. Canoeing -> Kayaking; unknown -> Workout (0,0). */
export function toFitSport(sport: string): [number, number] {
  let s = sport;
  if (s === ActivityType.canoeing) s = ActivityType.kayaking;
  if (!(s in fitSportMap)) s = 'Workout';
  return fitSportMap[s] ?? [0, 0];
}

// ---- message serializers ----------------------------------------------------
function serializeFileId(model: ExportModel, local: number, productLen: number): number[] {
  const suunto = model.exportTarget === ExportTarget.suunto;
  const fields: FitFieldDef[] = [f(0, BT.enum), f(1, BT.uint16)];
  if (suunto) fields.push(f(2, BT.uint16));
  fields.push(f(4, BT.uint32), strField(8, productLen));
  const def = buildDefinition(local, FIT_MESSAGE.fileId, fields);

  const d = new FitWriter();
  d.out = [local];
  d.addByte(FitFileType.activity);
  d.addShort(suunto ? suuntoFitId : model.descriptor.manufacturerFitId);
  if (suunto) d.addShort(FitProductEnum.suunto7);
  d.addLong(fitTimeStamp(model.now));
  d.addString(model.descriptor.fullName);
  return def.concat(d.out);
}

function serializeFileCreator(local: number): number[] {
  const def = buildDefinition(local, FIT_MESSAGE.fileCreator, [f(0, BT.uint16)]);
  const d = new FitWriter();
  d.out = [local];
  d.addShort(85);
  return def.concat(d.out);
}

function serializeDeviceInfo(model: ExportModel, local: number, productLen: number): number[] {
  const fields: FitFieldDef[] = [
    f(253, BT.uint32),
    f(1, BT.uint8),
    f(2, BT.uint16),
    f(25, BT.enum),
    strField(27, productLen),
  ];
  const def = buildDefinition(local, FIT_MESSAGE.deviceInfo, fields);
  const d = new FitWriter();
  d.out = [local];
  d.addLong(fitTimeStamp(model.now));
  d.addByte(FitDeviceType.fitnessEquipment);
  d.addShort(model.descriptor.manufacturerFitId);
  d.addByte(model.descriptor.isAntPlus ? FitSourceType.antPlus : FitSourceType.bluetoothLowEnergy);
  d.addString(model.descriptor.fullName);
  return def.concat(d.out);
}

function serializeActivity(model: ExportModel, local: number): number[] {
  const regular = model.exportTarget === ExportTarget.regular;
  const fields: FitFieldDef[] = [f(253, BT.uint32)];
  if (regular) fields.push(f(0, BT.uint32));
  fields.push(f(1, BT.uint16), f(2, BT.enum), f(3, BT.enum), f(4, BT.enum));
  const def = buildDefinition(local, FIT_MESSAGE.activity, fields);

  const d = new FitWriter();
  d.out = [local];
  d.addLong(fitTimeStamp(model.activity.start));
  if (regular) d.addLong(model.activity.movingTime);
  d.addShort(1);
  d.addByte(FitActivityEnum.manual);
  d.addByte(FitEventEnum.activity);
  d.addByte(FitEventType.stop);
  return def.concat(d.out);
}

function serializeSession(model: ExportModel, local: number): number[] {
  const regular = model.exportTarget === ExportTarget.regular;
  const fields: FitFieldDef[] = [
    f(253, BT.uint32),
    f(0, BT.enum),
    f(1, BT.enum),
    f(2, BT.uint32),
    f(5, BT.enum),
  ];
  if (regular) fields.push(f(6, BT.enum));
  fields.push(f(7, BT.uint32), f(8, BT.uint32), f(9, BT.uint32));
  if (regular) fields.push(f(10, BT.uint32));
  fields.push(
    f(11, BT.uint16),
    f(14, BT.uint16),
    f(15, BT.uint16),
    f(16, BT.uint8),
    f(17, BT.uint8),
    f(18, BT.uint8),
    f(19, BT.uint8),
    f(20, BT.uint16),
    f(21, BT.uint16),
    f(22, BT.uint16),
    f(23, BT.uint16),
  );
  if (regular) fields.push(f(28, BT.enum));
  fields.push(f(50, BT.uint16), f(71, BT.uint16));
  const def = buildDefinition(local, FIT_MESSAGE.session, fields);

  const first = model.records.length > 0 ? (model.records[0] as ExportRecord) : null;
  const last =
    model.records.length > 0 ? (model.records[model.records.length - 1] as ExportRecord) : null;
  const [sportId, subSportId] = toFitSport(model.activity.sport);
  const eps = 1e-6;

  const d = new FitWriter();
  d.out = [local];
  d.addLong(fitTimeStamp(last?.record.timeStamp ?? null));
  d.addByte(FitEventEnum.session);
  d.addByte(FitEventType.stop);
  d.addLong(fitTimeStamp(first?.record.timeStamp ?? null));
  d.addByte(sportId);
  if (regular) d.addByte(subSportId);
  d.addLong(model.activity.elapsed * 1000);
  d.addLong(model.activity.movingTime);
  d.addLong(Math.ceil(model.activity.distance * 100));
  if (regular) d.addLong(model.activity.strides);
  d.addShort(Math.max(model.activity.calories, 0));
  d.addShort(model.averageSpeed > eps ? dartRound(model.averageSpeed * 1000) : 0);
  d.addShort(model.maximumSpeed > eps ? dartRound(model.maximumSpeed * 1000) : 0);
  d.addByte(Math.max(model.averageHeartRate, 0));
  d.addByte(Math.max(model.maximumHeartRate, 0));
  d.addByte(Math.max(model.averageCadence, 0));
  d.addByte(Math.max(model.maximumCadence, 0));
  d.addShort(model.averagePower > eps ? dartRound(model.averagePower) : 0);
  d.addShort(model.maximumPower > eps ? dartRound(model.maximumPower) : 0);
  d.addShort(0);
  d.addShort(0);
  if (regular) d.addByte(FitSessionTrigger.activityEnd);
  d.addShort(convertAltitudeForFit(model.altitude));
  d.addShort(convertAltitudeForFit(model.altitude));
  return def.concat(d.out);
}

function serializeLap(model: ExportModel, local: number): number[] {
  const regular = model.exportTarget === ExportTarget.regular;
  const fields: FitFieldDef[] = [
    f(253, BT.uint32),
    f(0, BT.enum),
    f(1, BT.enum),
    f(2, BT.uint32),
    f(7, BT.uint32),
    f(8, BT.uint32),
    f(9, BT.uint32),
  ];
  if (regular) fields.push(f(10, BT.uint32));
  fields.push(
    f(11, BT.uint16),
    f(13, BT.uint16),
    f(14, BT.uint16),
    f(15, BT.uint8),
    f(16, BT.uint8),
    f(17, BT.uint8),
    f(18, BT.uint8),
    f(19, BT.uint16),
    f(20, BT.uint16),
    f(24, BT.enum),
    f(25, BT.enum),
  );
  if (regular) fields.push(f(39, BT.enum));
  fields.push(f(42, BT.uint16), f(43, BT.uint16), f(62, BT.uint16));
  const def = buildDefinition(local, FIT_MESSAGE.lap, fields);

  const first = model.records.length > 0 ? (model.records[0] as ExportRecord) : null;
  const last =
    model.records.length > 0 ? (model.records[model.records.length - 1] as ExportRecord) : null;
  const [sportId, subSportId] = toFitSport(model.activity.sport);
  const eps = 1e-6;
  const alt = convertAltitudeForFit(model.altitude);

  const d = new FitWriter();
  d.out = [local];
  d.addLong(fitTimeStamp(last?.record.timeStamp ?? null));
  d.addByte(FitEventEnum.lap);
  d.addByte(FitEventType.stop);
  d.addLong(fitTimeStamp(first?.record.timeStamp ?? null));
  d.addLong(model.activity.elapsed * 1000);
  d.addLong(model.activity.movingTime);
  d.addLong(Math.ceil(model.activity.distance * 100));
  if (regular) d.addLong(model.activity.strides);
  d.addShort(Math.max(model.activity.calories, 0));
  d.addShort(model.averageSpeed > eps ? dartRound(model.averageSpeed * 1000) : 0);
  d.addShort(model.maximumSpeed > eps ? dartRound(model.maximumSpeed * 1000) : 0);
  d.addByte(Math.max(model.averageHeartRate, 0));
  d.addByte(Math.max(model.maximumHeartRate, 0));
  d.addByte(Math.max(model.averageCadence, 0));
  d.addByte(Math.max(model.maximumCadence, 0));
  d.addShort(model.averagePower > eps ? dartRound(model.averagePower) : 0);
  d.addShort(model.maximumPower > eps ? dartRound(model.maximumPower) : 0);
  d.addByte(FitLapTrigger.sessionEnd);
  d.addByte(sportId);
  if (regular) d.addByte(subSportId);
  d.addShort(alt);
  d.addShort(alt);
  d.addShort(alt);
  return def.concat(d.out);
}

function buildEventDefinition(local: number): number[] {
  return buildDefinition(local, FIT_MESSAGE.event, [
    f(253, BT.uint32),
    f(0, BT.enum),
    f(1, BT.enum),
    f(3, BT.uint32),
  ]);
}
function serializeEventData(local: number, start: boolean, record: ExportRecord | null): number[] {
  const d = new FitWriter();
  d.out = [local];
  d.addLong(fitTimeStamp(record?.record.timeStamp ?? null));
  d.addByte(FitEventEnum.timer);
  d.addByte(start ? FitEventType.start : FitEventType.stop);
  d.addLong(FitActivityEnum.manual);
  return d.out;
}

function buildRecordDefinition(local: number, gps: boolean): number[] {
  const fields: FitFieldDef[] = [f(253, BT.uint32)];
  if (gps) fields.push(f(0, BT.sint32), f(1, BT.sint32), f(2, BT.uint16));
  fields.push(
    f(3, BT.uint8),
    f(4, BT.uint8),
    f(5, BT.uint32),
    f(6, BT.uint16),
    f(7, BT.uint16),
    f(32, BT.sint16),
  );
  return buildDefinition(local, FIT_MESSAGE.record, fields);
}

function serializeRecordData(model: ExportModel, local: number, er: ExportRecord): number[] {
  const gps = model.calculateGps;
  const rec = er.record;
  const d = new FitWriter();
  d.out = [local];
  const dateTime = rec.timeStamp ?? model.now;
  d.addLong(fitTimeStamp(dateTime));
  if (gps) {
    d.addGpsCoordinate(er.latitude);
    d.addGpsCoordinate(er.longitude);
    d.addShort(convertAltitudeForFit(model.altitude));
  }
  // Resolve heart rate: a forced 0xFF passes through addByte, which clamps a
  // non-null 0xFF down to 0xFE.
  if (rec.heartRate !== null) {
    if (
      rec.heartRate === 0 &&
      (model.heartRateGapWorkaround === 'do_not_write_zeros' ||
        model.heartRateLimitingMethod === 'write_nothing')
    ) {
      rec.heartRate = 0xff;
    }
  } else if (
    model.heartRateGapWorkaround !== 'do_not_write_zeros' &&
    model.heartRateLimitingMethod !== 'write_nothing'
  ) {
    rec.heartRate = 0;
  } else {
    rec.heartRate = 0xff;
  }

  d.addByte(rec.heartRate ?? 0);
  d.addByte(rec.cadence ?? 0);
  d.addLong(dartRound((rec.distance ?? 0.0) * 100));
  d.addShort(dartRound((rec.speed ?? 0.0) * 1000));
  d.addShort(rec.power !== null ? dartRound(rec.power) : 0);
  d.addShort(0, true);
  return d.out;
}

function serializeSport(local: number, sport: string): number[] {
  const def = buildDefinition(local, FIT_MESSAGE.sport, [f(0, BT.enum), f(1, BT.enum)]);
  const [item1, item2] = toFitSport(sport);
  return def.concat([local, item1, item2]);
}

// ---- header + assembly ------------------------------------------------------
function buildHeader(dataSize: number): number[] {
  const w = new FitWriter();
  w.out = [FIT_HEADER_SIZE, FIT_PROTOCOL_VERSION];
  w.addShort(FIT_PROFILE_VERSION);
  w.addLong(dataSize);
  for (const b of new TextEncoder().encode('.FIT')) w.out.push(b);
  // header CRC over the first 12 bytes
  w.addShort(crcData(w.out));
  return w.out;
}

/** Encode the full FIT file bytes for an export model. */
export function encodeFit(model: ExportModel): Uint8Array {
  const body: number[] = [];
  const productLen = model.descriptor.fullName.length;
  let local = 0;

  if (model.exportTarget === ExportTarget.regular) {
    body.push(...serializeFileId(model, local, productLen));
    local++;
    body.push(...serializeFileCreator(local));
    local++;
    body.push(...serializeDeviceInfo(model, local, productLen));
    local++;
    body.push(...serializeActivity(model, local));
    local++;
    body.push(...serializeSession(model, local));
    local++;
    body.push(...buildRecordDefinition(local, model.calculateGps));
    for (const er of model.records) body.push(...serializeRecordData(model, local, er));
    local++;
    body.push(...serializeSport(local, model.activity.sport));
    local++;
  } else {
    body.push(...serializeFileId(model, local, productLen));
    local++;
    body.push(...buildRecordDefinition(local, model.calculateGps));
    for (const er of model.records) body.push(...serializeRecordData(model, local, er));
    local++;
    body.push(...buildEventDefinition(local));
    body.push(...serializeEventData(local, true, model.records[0] ?? null));
    body.push(...serializeEventData(local, false, model.records[model.records.length - 1] ?? null));
    local++;
    body.push(...serializeLap(model, local));
    local++;
    body.push(...serializeSession(model, local));
    local++;
    body.push(...serializeActivity(model, local));
    local++;
  }

  const dataSize = body.length;
  // Trailing file CRC covers the body only (not the 14 header bytes), appended
  // through the same clamping path as every other short.
  const bodyW = new FitWriter();
  bodyW.out = body.slice();
  bodyW.addShort(crcData(body));
  const header = buildHeader(dataSize);
  return Uint8Array.from(header.concat(bodyW.out));
}
