/**
 * Strava status/fault tables.
 *
 * The numeric fault codes are LAAS-internal (NOT HTTP codes) — the ride menu
 * maps them to localized toasts. The status phrases are the literal English
 * strings Strava returns in an upload's `status` field; the upload poller
 * (StravaUpload.ts) branches on them. Kept as plain lookups so both mappings
 * stay auditable in one place.
 */

/** LAAS-internal fault codes — not HTTP status codes. */
export const StravaStatusCode = {
  statusOk: 0,
  statusInvalidToken: 1,
  statusUnknownError: 2,
  statusTokenNotKnownYet: 3,
  statusNotFound: 4,
  statusNoAuthenticationYet: 5,
  statusJsonIsEmpty: 6,
  statusAuthError: 7,
  statusDeAuthorizeError: 8,
  statusSegmentNotRidden: 9,
} as const;

export type StravaStatusCodeValue = (typeof StravaStatusCode)[keyof typeof StravaStatusCode];

/**
 * The literal `status` strings Strava puts in the upload-status JSON. Strava
 * carries the state in the response body's `status` field, which fetch exposes
 * reliably, so the poller compares against these rather than the HTTP reason
 * phrase.
 */
export const StravaStatusText = {
  ready: 'Your activity is ready.',
  deleted: 'The created activity has been deleted.',
  errorMsg: 'There was an error processing your activity.',
  processed: 'Your activity is still being processed.',
  notFound: 'Not Found',
  ok: 'OK',
} as const;

/** A fault: an internal status code plus a human-readable message. */
export interface Fault {
  statusCode: number;
  message: string;
}

export function fault(statusCode: number, message: string): Fault {
  return { statusCode, message };
}

/**
 * Decoded upload-status body. Strava's `/uploads` and `/uploads/{id}` return
 * exactly these fields; missing fields fall back to sensible defaults.
 */
export interface UploadActivityResponse {
  id: number;
  externalId: string;
  error: string | null;
  status: string;
  activityId: number;
}

export function parseUploadResponse(json: unknown): UploadActivityResponse {
  const m = (json ?? {}) as Record<string, unknown>;
  return {
    id: typeof m['id'] === 'number' ? (m['id'] as number) : 0,
    externalId: typeof m['external_id'] === 'string' ? (m['external_id'] as string) : '',
    error: typeof m['error'] === 'string' ? (m['error'] as string) : null,
    status: typeof m['status'] === 'string' ? (m['status'] as string) : '',
    activityId: typeof m['activity_id'] === 'number' ? (m['activity_id'] as number) : 0,
  };
}
