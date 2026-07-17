/**
 * Browser download helper — the ONLY DOM-touching module. Wraps export bytes
 * or text in a Blob and triggers an <a download> with the right mime type and
 * extension per format (plus the gzip variant). Everything else in this
 * package is pure, node-testable TypeScript.
 */

export type ExportFormat = 'fit' | 'tcx' | 'csv' | 'json';

const NON_COMPRESSED_MIME: Readonly<Record<ExportFormat, string>> = {
  fit: 'application/octet-stream',
  tcx: 'text/xml',
  csv: 'text/csv',
  json: 'application/json',
};
const COMPRESSED_MIME = 'application/x-gzip';

export function mimeType(format: ExportFormat, compressed = false): string {
  return compressed ? COMPRESSED_MIME : NON_COMPRESSED_MIME[format];
}

export function fileExtension(format: ExportFormat, compressed = false): string {
  return compressed ? `${format}.gz` : format;
}

export interface DownloadOptions {
  /** Filename stub (e.g. SessionActivity.getFileNameStub(), which ends in "."). */
  filenameStub?: string;
  compressed?: boolean;
}

function buildFileName(format: ExportFormat, opts: DownloadOptions): string {
  const ext = fileExtension(format, opts.compressed ?? false);
  const stub = opts.filenameStub;
  if (stub && stub.length > 0) {
    return stub.endsWith('.') ? `${stub}${ext}` : `${stub}.${ext}`;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `ride-${ts}.${ext}`;
}

/**
 * Trigger a browser download of an export payload. `data` may be raw bytes
 * (FIT) or a string (TCX/CSV/JSON); both are wrapped as a Blob.
 */
export function downloadExport(
  data: Uint8Array | string,
  format: ExportFormat,
  opts: DownloadOptions = {},
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('downloadExport requires a browser DOM environment');
  }
  const compressed = opts.compressed ?? false;
  const part: BlobPart =
    typeof data === 'string'
      ? data
      : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const blob = new Blob([part], { type: mimeType(format, compressed) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildFileName(format, opts);
  a.click();
  URL.revokeObjectURL(url);
}
