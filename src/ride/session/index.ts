/**
 * Workout recording + export pipeline. Public surface.
 *
 * Recording:  new Recorder(config) -> push(sample) -> records[]; finish(activity).
 * Export:     exportFit/Tcx/Csv/Json(activity, records, opts) -> bytes/string.
 * Download:   downloadExport(bytes|string, format, { filenameStub, compressed }).
 *
 * Every module is pure TypeScript except Download.ts (browser Blob/anchor).
 */

export * from './Model';
export * from './PowerSpeed';
export * from './Track';
export * from './ExportModel';
export * from './FitExport';
export * from './TcxExport';
export * from './CsvExport';
export * from './JsonExport';
export * from './Recorder';
export * from './Download';

import { buildExportModel, type ExportOptions } from './ExportModel';
import { encodeFit } from './FitExport';
import { encodeTcxString } from './TcxExport';
import { encodeCsvString } from './CsvExport';
import { encodeJsonString } from './JsonExport';
import type { SessionActivity, SessionRecord } from './Model';

/** Build the FIT activity file bytes for an activity + its stored records. */
export function exportFit(
  activity: SessionActivity,
  records: SessionRecord[],
  opts?: ExportOptions,
): Uint8Array {
  return encodeFit(buildExportModel(activity, records, opts));
}

/** Build the TCX document string. */
export function exportTcx(
  activity: SessionActivity,
  records: SessionRecord[],
  opts?: ExportOptions,
): string {
  return encodeTcxString(buildExportModel(activity, records, opts));
}

/** Build the CSV string. */
export function exportCsv(
  activity: SessionActivity,
  records: SessionRecord[],
  opts?: ExportOptions,
): string {
  return encodeCsvString(buildExportModel(activity, records, opts));
}

/** Build the workout JSON string. */
export function exportJson(
  activity: SessionActivity,
  records: SessionRecord[],
  opts?: ExportOptions,
): string {
  return encodeJsonString(buildExportModel(activity, records, opts));
}
