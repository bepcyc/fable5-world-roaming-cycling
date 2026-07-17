/**
 * StravaUpload — multipart FIT upload plus the status-poll that follows it.
 *
 * A multipart request (data_type, trainer, commute, name, external_id,
 * description + the file) is POSTed to /uploads; the returned upload id is then
 * polled at /uploads/{id} until Strava reports the activity ready. Strava
 * carries the state in the response body's `status` field (StravaStatusText),
 * which fetch exposes reliably, so the poller reads the body rather than the
 * HTTP reason phrase. Every fetch routes through StravaConfig.proxied (Strava
 * serves no browser CORS).
 */

import { UPLOADS_ENDPOINT, ACTIVITY_URL_BASE, proxied } from './StravaConfig';
import type { StravaAuth } from './StravaAuth';
import {
  StravaStatusCode,
  StravaStatusText,
  fault,
  parseUploadResponse,
  type Fault,
} from './StatusCodes';

export type UploadPhase = 'auth' | 'uploading' | 'processing' | 'done' | 'error';

export interface UploadOptions {
  /** activity title (Strava `name`) */
  name: string;
  description?: string;
  /** mark as indoor/trainer (Strava `trainer`); default false keeps the map */
  trainer?: boolean;
  commute?: boolean;
  /** Strava `external_id` tag; default 'laas_rando' */
  externalId?: string;
  /** 'fit' (raw, RideRecorder's default) or 'fit.gz' (gzipped) */
  dataType?: string;
  onProgress?: (phase: UploadPhase, detail?: string) => void;
}

export interface UploadResult {
  ok: boolean;
  fault: Fault;
  uploadId?: number;
  activityId?: number;
  activityUrl?: string;
}

/** initial settle before the first status poll */
const POLL_INITIAL_MS = 800;
/** delay between status polls */
const POLL_INTERVAL_MS = 1500;
/** cap so a stuck "processing" state cannot poll forever */
const POLL_MAX_ATTEMPTS = 40;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class StravaUpload {
  constructor(private auth: StravaAuth) {}

  /**
   * Upload one FIT payload. `payload` is the narrow provider shape the ride
   * session exposes: raw FIT bytes + a suggested base name.
   */
  async upload(payload: { bytes: Uint8Array; name: string }, opts: UploadOptions): Promise<UploadResult> {
    const progress = opts.onProgress ?? ((): void => {});

    // --- token ---------------------------------------------------------------
    progress('auth');
    if (!this.auth.isAuthorized()) {
      return err(StravaStatusCode.statusNoAuthenticationYet, 'Not connected to Strava');
    }
    const accessToken = await this.auth.getValidAccessToken();
    if (!accessToken) {
      return err(StravaStatusCode.statusInvalidToken, 'Strava token invalid or expired');
    }
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    // --- multipart POST ------------------------------------------------------
    const dataType = opts.dataType ?? 'fit';
    const form = new FormData();
    form.set('data_type', dataType);
    form.set('trainer', opts.trainer ? 'true' : 'false');
    form.set('commute', opts.commute ? 'true' : 'false');
    form.set('name', opts.name);
    form.set('external_id', opts.externalId ?? 'laas_rando');
    if (opts.description) form.set('description', opts.description);
    const blobType = dataType.endsWith('gz') ? 'application/x-gzip' : 'application/octet-stream';
    // copy into a fresh ArrayBuffer so the Blob is not backed by a shared /
    // resizable buffer (SharedArrayBuffer is not a valid BlobPart)
    const buf = payload.bytes.slice().buffer;
    const fileName = `${payload.name}.${dataType.split('.')[0] ?? 'fit'}`;
    form.set('file', new Blob([buf], { type: blobType }), fileName);

    progress('uploading');
    let uploadId = 0;
    try {
      const resp = await fetch(proxied(UPLOADS_ENDPOINT), {
        method: 'POST',
        headers: authHeader, // do NOT set Content-Type — the browser adds the multipart boundary
        body: form,
      });
      if (resp.status === 429) {
        return err(StravaStatusCode.statusUnknownError, rateLimitMessage(resp));
      }
      const bodyText = await resp.text();
      const decoded = parseUploadResponse(safeJson(bodyText));
      if (resp.status < 200 || resp.status >= 300) {
        // 400 often means the activity was already uploaded (duplicate)
        const msg = decoded.error ?? `${resp.status} ${resp.statusText || 'upload rejected'}`;
        return err(StravaStatusCode.statusUnknownError, msg, { uploadId: decoded.id });
      }
      uploadId = decoded.id;
      if (uploadId <= 0) {
        return err(StravaStatusCode.statusUnknownError, decoded.error ?? 'Strava returned no upload id');
      }
    } catch (e) {
      return err(StravaStatusCode.statusUnknownError, describeError(e));
    }

    // --- poll /uploads/{id} until ready --------------------------------------
    progress('processing');
    await sleep(POLL_INITIAL_MS);
    const statusUrl = proxied(`${UPLOADS_ENDPOINT}/${uploadId}`);
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      let decoded;
      try {
        const resp = await fetch(statusUrl, { headers: authHeader });
        if (resp.status === 429) {
          return err(StravaStatusCode.statusUnknownError, rateLimitMessage(resp), { uploadId });
        }
        if (resp.status === 404) {
          // temp id gone — usually already processed
          return err(StravaStatusCode.statusNotFound, 'Upload not found (already processed?)', { uploadId });
        }
        decoded = parseUploadResponse(safeJson(await resp.text()));
      } catch (e) {
        return err(StravaStatusCode.statusUnknownError, describeError(e), { uploadId });
      }

      const status = decoded.status;
      if (decoded.error) {
        return err(StravaStatusCode.statusUnknownError, decoded.error, { uploadId });
      }
      if (status === StravaStatusText.ready || decoded.activityId > 0) {
        progress('done');
        const activityId = decoded.activityId;
        return {
          ok: true,
          fault: fault(StravaStatusCode.statusOk, 'Your activity is ready.'),
          uploadId,
          activityId,
          ...(activityId > 0 ? { activityUrl: `${ACTIVITY_URL_BASE}${activityId}` } : {}),
        };
      }
      if (status === StravaStatusText.errorMsg || status === StravaStatusText.deleted) {
        return err(StravaStatusCode.statusUnknownError, status || 'Upload failed', { uploadId });
      }
      // still processing (or empty) → keep waiting
      await sleep(POLL_INTERVAL_MS);
    }
    return err(StravaStatusCode.statusUnknownError, 'Timed out waiting for Strava to process the upload', {
      uploadId,
    });
  }
}

function err(code: number, message: string, extra?: { uploadId?: number }): UploadResult {
  return { ok: false, fault: fault(code, message), ...(extra?.uploadId ? { uploadId: extra.uploadId } : {}) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function rateLimitMessage(resp: Response): string {
  const usage = resp.headers.get('X-RateLimit-Usage');
  const limit = resp.headers.get('X-RateLimit-Limit');
  const retry = resp.headers.get('Retry-After');
  const parts = ['Strava rate limit reached'];
  if (usage && limit) parts.push(`(${usage} of ${limit})`);
  if (retry) parts.push(`— retry after ${retry}s`);
  return parts.join(' ');
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
