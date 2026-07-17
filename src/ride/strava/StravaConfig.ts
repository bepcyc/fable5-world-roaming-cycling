/**
 * StravaConfig — endpoints, app credentials and the persisted OAuth token.
 *
 * LAAS ships no client id/secret: the owner registers their own API app at
 * https://www.strava.com/settings/api and pastes the Client ID / Client secret
 * / redirect URI (and, in a plain browser, a CORS-proxy URL) into the
 * Strava-settings panel. Everything here reads/writes localStorage so those
 * values, and the token, survive reloads.
 *
 * CORS reality (see docs/STRAVA_RECORDING_UX.md): Strava does not serve
 * permissive CORS on the token exchange or the REST API, so a plain browser
 * fetch is blocked. Every Strava *fetch* is routed through proxied(); the
 * *authorize* step is a top-level navigation, so it is never proxied.
 */

// ---- endpoints -------------------------------------------------------------
const STRAVA_URL = 'https://www.strava.com/';
/** POST token exchange. `${STRAVA_URL}api/v3/oauth/token` is the equivalent
 *  Strava also documents; either routes the same. */
export const TOKEN_ENDPOINT = `${STRAVA_URL}oauth/token`;
export const AUTHORIZE_ENDPOINT = `${STRAVA_URL}oauth/authorize`;
export const DEAUTHORIZE_ENDPOINT = `${STRAVA_URL}oauth/deauthorize`;
export const UPLOADS_ENDPOINT = `${STRAVA_URL}api/v3/uploads`;
export const ACTIVITY_URL_BASE = `${STRAVA_URL}activities/`;

/** upload scope: create uploads / activities. */
export const STRAVA_SCOPE = 'activity:write';

// ---- localStorage keys -----------------------------------------------------
const LS = {
  clientId: 'laas.strava.clientId',
  clientSecret: 'laas.strava.clientSecret',
  redirectUri: 'laas.strava.redirectUri',
  corsProxy: 'laas.strava.corsProxy',
  // persisted OAuth token record
  accessToken: 'laas.strava.accessToken',
  refreshToken: 'laas.strava.refreshToken',
  expiresAt: 'laas.strava.expiresAt',
  scope: 'laas.strava.scope',
  tokenType: 'laas.strava.tokenType',
} as const;

/** A loopback default; Strava white-lists 127.0.0.1/localhost for dev apps.
 *  Nothing serves it — the copy-the-code UI recovers the `code` from it. */
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1/laas-strava';

function get(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function set(key: string, value: string): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, value);
    else globalThis.localStorage?.removeItem(key);
  } catch {
    /* headless probes have no storage */
  }
}

// ---- app credentials -------------------------------------------------------
export function getClientId(): string {
  return get(LS.clientId).trim();
}
export function setClientId(v: string): void {
  set(LS.clientId, v.trim());
}
export function getClientSecret(): string {
  return get(LS.clientSecret).trim();
}
export function setClientSecret(v: string): void {
  set(LS.clientSecret, v.trim());
}
export function getRedirectUri(): string {
  return get(LS.redirectUri).trim() || DEFAULT_REDIRECT_URI;
}
export function setRedirectUri(v: string): void {
  set(LS.redirectUri, v.trim());
}
export function getCorsProxy(): string {
  return get(LS.corsProxy).trim();
}
export function setCorsProxy(v: string): void {
  set(LS.corsProxy, v.trim());
}

/** true once the owner has pasted both credentials — CONNECT is inert otherwise */
export function isConfigured(): boolean {
  return getClientId().length > 0 && getClientSecret().length > 0;
}

/**
 * Route a Strava REST URL through the optional CORS proxy. Two conventions:
 *   - a `{url}` placeholder → replaced with the URL-encoded target
 *     (e.g. `https://worker.example/?url={url}`);
 *   - otherwise a plain prefix
 *     (e.g. `https://worker.example/` → `.../https://www.strava.com/...`).
 * Empty proxy → direct (correct in Electron / native, and in any browser once
 * Strava serves CORS).
 */
export function proxied(url: string): string {
  const p = getCorsProxy();
  if (!p) return url;
  if (p.includes('{url}')) return p.replace('{url}', encodeURIComponent(url));
  return p + url;
}

// ---- persisted OAuth token -------------------------------------------------
export interface StravaTokenRecord {
  accessToken: string | null;
  refreshToken: string | null;
  /** unix seconds (Strava `expires_at`) */
  expiresAt: number | null;
  scope: string | null;
  tokenType: string | null;
}

export function loadToken(): StravaTokenRecord {
  const at = get(LS.accessToken);
  const rt = get(LS.refreshToken);
  const exp = get(LS.expiresAt);
  const sc = get(LS.scope);
  const tt = get(LS.tokenType);
  return {
    accessToken: at ? at : null,
    refreshToken: rt ? rt : null,
    expiresAt: exp ? Number(exp) : null,
    scope: sc ? sc : null,
    tokenType: tt ? tt : null,
  };
}

export function saveToken(t: StravaTokenRecord): void {
  set(LS.accessToken, t.accessToken ?? '');
  set(LS.refreshToken, t.refreshToken ?? '');
  set(LS.expiresAt, t.expiresAt != null ? String(t.expiresAt) : '');
  set(LS.scope, t.scope ?? '');
  set(LS.tokenType, t.tokenType ?? '');
}

export function clearToken(): void {
  saveToken({ accessToken: null, refreshToken: null, expiresAt: null, scope: null, tokenType: null });
}
