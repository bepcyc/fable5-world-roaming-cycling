/**
 * Replay stack public surface — file import (CSV both modes, FIT) plus a
 * SensorSource that plays imported records back through the ride sensor layer.
 *
 * Wiring into HUD/menus is a later wave; this module only exports the pieces.
 * Nothing here is imported by existing files yet (NEW FILES ONLY constraint).
 */

export type { ImportedActivity, ImportedRecord, ImportSource } from './types';

export {
  CsvImporter,
  importCsv,
  type CsvImportOptions,
  type SetProgress,
} from './CsvImport';

export {
  decodeFit,
  importFit,
  FitImportError,
  type FitDecodeResult,
} from './FitImport';

export {
  ReplaySensorSource,
  REPLAY_RATES,
  type ReplayRate,
  type ReplayTelemetry,
} from './ReplaySource';

export { pickFile, readPicked, looksLikeFit, type PickedFile } from './FilePick';

import type { ImportedActivity } from './types';
import { importCsv } from './CsvImport';
import { importFit } from './FitImport';
import { looksLikeFit, type PickedFile } from './FilePick';

/**
 * Route a picked file to the right importer: FIT by signature/extension, else
 * CSV (which self-selects migration vs MPower from its first line). Returns the
 * ImportedActivity or throws/returns null with a message on failure.
 */
export function importPickedFile(picked: PickedFile): {
  activity: ImportedActivity | null;
  message: string;
} {
  if (looksLikeFit(picked)) {
    try {
      return { activity: importFit(picked.arrayBuffer), message: '' };
    } catch (err) {
      return { activity: null, message: err instanceof Error ? err.message : 'FIT decode failed' };
    }
  }
  return importCsv(picked.text);
}
