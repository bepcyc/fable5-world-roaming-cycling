/**
 * Strava upload feature. Public surface for the ride menu:
 *   StravaConfig  — endpoints, credentials, redirect/proxy, token storage
 *   StravaAuth    — authorize URL, code→token, refresh, expiry, deauthorize
 *   StravaUpload  — multipart FIT upload + status polling + fault mapping
 *   StatusCodes   — status/fault tables
 *
 * See docs/STRAVA_RECORDING_UX.md for the OAuth transport design and the
 * one-time API-app registration the owner must do.
 */

export * from './StatusCodes';
export * from './StravaConfig';
export { StravaAuth } from './StravaAuth';
export { StravaUpload } from './StravaUpload';
export type { UploadOptions, UploadResult, UploadPhase } from './StravaUpload';
