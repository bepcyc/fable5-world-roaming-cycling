/**
 * CSV export — a compact summary + per-record table with a short magic and
 * version header. UTF-8, comma-separated, trailing comma on most lines.
 * Data-row speed is m/s (already converted in the shared pass). Pure TS.
 */

import { dartDouble } from './Model';
import type { ExportModel } from './ExportModel';

const CSV_MAGIC = 'RIDE';
const CSV_VERSION = 1;

class Sb {
  private s = '';
  write(text: string): void {
    this.s += text;
  }
  writeln(text: string): void {
    this.s += text + '\n';
  }
  toString(): string {
    return this.s;
  }
}

function boolStr(b: boolean): string {
  return b ? 'true' : 'false';
}

function addActivity(sb: Sb, model: ExportModel): void {
  const a = model.activity;
  sb.writeln(`Total Time,${a.elapsed},Seconds,`);
  sb.writeln(`Total Distance,${dartDouble(a.distance)},M,`);
  sb.writeln(`Device Name,${a.deviceName},`);
  sb.writeln(`Device ID,${a.deviceId},`);
  sb.writeln(`Start Time,${a.start.getTime()},`);
  sb.writeln(`End Time,${a.end !== null ? String(a.end.getTime()) : ''},`);
  sb.writeln(`CAL,${a.calories},`);
  sb.writeln(`Strides,${a.strides}`); // no trailing comma on this line
  sb.writeln(`Uploaded,${boolStr(a.uploaded)},`);
  sb.writeln(`Strava ID,${a.stravaId},`);
  sb.writeln(`Four CC,${a.fourCC},`);
  sb.writeln(`Sport,${a.sport},`);
  sb.writeln(`Power Factor,${dartDouble(a.powerFactor)},`);
  sb.writeln(`Calorie Factor,${dartDouble(a.calorieFactor)},`);
  sb.writeln(`HR Calorie Factor,${dartDouble(a.hrCalorieFactor)},`);
  sb.writeln(`HRM Calorie Factor,${dartDouble(a.hrmCalorieFactor)},`);
  sb.writeln(`HRM ID,${a.hrmId},`);
  sb.writeln(`HR Based Calories,${boolStr(a.hrBasedCalories)},`);
  sb.writeln(`Time Zone,${a.timeZone},`);
  sb.writeln(`SUUNTO Uploaded,${boolStr(a.suuntoUploaded)},`);
  sb.writeln(`SUUNTO Blob Url,${a.suuntoBlobUrl},`);
  sb.writeln(`SUUNTO Workout Url,${a.suuntoWorkoutUrl},`);
  sb.writeln(`SUUNTO Upload Id,${a.suuntoUploadIdentifier},`);
  sb.writeln(`Under Armour Uploaded,${boolStr(a.underArmourUploaded)},`);
  sb.writeln(`Under Armour Workout Id,${a.uaWorkoutId},`);
  sb.writeln(`Training Peaks Uploaded,${boolStr(a.trainingPeaksUploaded)},`);
  sb.writeln(`training_peaks_file_tracking_uuid,${a.trainingPeaksFileTrackingUuid},`);
  sb.writeln(`training_peaks_workout_id,${a.trainingPeaksWorkoutId},`);
  sb.writeln(`Moving Time,${a.movingTime},`);
  sb.writeln('');
  addDetailData(sb, model);
}

function addDetailData(sb: Sb, model: ExportModel): void {
  sb.writeln('RIDE DATA');
  sb.write('Power,');
  sb.write('RPM,');
  sb.write('HR,');
  sb.write('DISTANCE,');
  sb.write('TIME_STAMP,');
  sb.write('ELAPSED,');
  sb.write('SPEED,');
  sb.writeln('CAL,');
  for (const er of model.records) {
    const r = er.record;
    sb.write(`${r.power ?? ''},`);
    sb.write(`${r.cadence ?? ''},`);
    sb.write(`${r.heartRate ?? ''},`);
    sb.write(`${r.distance !== null ? r.distance.toFixed(2) : ''},`);
    sb.write(`${r.timeStamp !== null ? String(r.timeStamp.getTime()) : ''},`);
    sb.write(`${r.elapsed ?? ''},`);
    sb.write(`${r.speed !== null ? r.speed.toFixed(2) : ''},`);
    sb.writeln(`${r.calories ?? ''},`);
  }
}

/** Encode the CSV document as UTF-8 bytes. */
export function encodeCsv(model: ExportModel): Uint8Array {
  const sb = new Sb();
  sb.writeln(`${CSV_MAGIC},${CSV_VERSION},`);
  sb.writeln('RIDE SUMMARY,');
  addActivity(sb, model);
  return new TextEncoder().encode(sb.toString());
}

export function encodeCsvString(model: ExportModel): string {
  return new TextDecoder().decode(encodeCsv(model));
}
