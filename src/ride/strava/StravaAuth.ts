/**
 * StravaAuth — the OAuth surface the ride menu drives: build the authorize
 * URL, exchange an authorization code for a token, refresh it when it expires,
 * report expiry, and deauthorize.
 *
 * A browser SPA cannot catch the redirect through a deep link and cannot reach
 * the token exchange directly (Strava serves no CORS on it, so every fetch is
 * routed through StravaConfig.proxied). The flow is therefore split into the
 * pieces the UI drives:
 *   buildAuthorizeUrl()  — the URL the CONNECT button opens (a navigation)
 *   exchangeCode(code)   — code → token (pasted code, or same-tab capture)
 *   ensureFreshToken()   — refresh when expired
 *   deauthorize()        — logout
 * See docs/STRAVA_RECORDING_UX.md for the redirect-capture design.
 */

import {
  AUTHORIZE_ENDPOINT,
  DEAUTHORIZE_ENDPOINT,
  STRAVA_SCOPE,
  TOKEN_ENDPOINT,
  clearToken,
  getClientId,
  getClientSecret,
  getRedirectUri,
  isConfigured,
  loadToken,
  proxied,
  saveToken,
  type StravaTokenRecord,
} from './StravaConfig';
import { StravaStatusCode, fault, type Fault } from './StatusCodes';

/** refresh this many seconds BEFORE the real expiry — browser + proxy latency
 *  makes cutting it fine risky, so renew a minute early. */
const EXPIRY_SKEW_S = 60;

interface TokenJson {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  message?: string;
}

export class StravaAuth {
  private token: StravaTokenRecord = loadToken();

  /** re-read the persisted token (after settings changes / another tab) */
  reload(): void {
    this.token = loadToken();
  }

  /** true when a non-empty access token is stored */
  isAuthorized(): boolean {
    const at = this.token.accessToken;
    return at != null && at.length > 0 && at !== 'null';
  }

  scope(): string | null {
    return this.token.scope;
  }

  expiresAt(): number | null {
    return this.token.expiresAt;
  }

  /** no expiry stored ⇒ not expired; otherwise compare against now, minus a
   *  small skew for latency. */
  isExpired(): boolean {
    const exp = this.token.expiresAt;
    if (exp == null) return false;
    return exp * 1000 - EXPIRY_SKEW_S * 1000 < Date.now();
  }

  /** Bearer header, or null when there is no usable token. */
  authHeader(): Record<string, string> | null {
    const at = this.token.accessToken;
    if (at != null && at.length > 0 && at !== 'Error' && at !== 'null') {
      return { Authorization: `Bearer ${at}` };
    }
    return null;
  }

  /**
   * Build the authorize URL. This URL is opened as a normal navigation (new
   * tab / Custom Tab), never fetched, so CORS does not apply. `approval_prompt`
   * is 'auto' (skip consent when already granted) or 'force'.
   */
  buildAuthorizeUrl(prompt: 'auto' | 'force' = 'auto'): string {
    const params = new URLSearchParams({
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
      response_type: 'code',
      approval_prompt: prompt,
      scope: STRAVA_SCOPE,
    });
    return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Exchange an authorization `code` for a token: POST client_id /
   * client_secret / code / grant_type=authorization_code. On success the token
   * is persisted with the requested scope.
   */
  async exchangeCode(code: string): Promise<Fault> {
    if (!isConfigured()) {
      return fault(StravaStatusCode.statusAuthError, 'Strava client id/secret not set');
    }
    const body = new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code: code.trim(),
      grant_type: 'authorization_code',
    });
    let json: TokenJson;
    try {
      const resp = await fetch(proxied(TOKEN_ENDPOINT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await resp.text();
      // an error response carries a `message` field instead of a token
      if (text.includes('"message"')) {
        return fault(StravaStatusCode.statusAuthError, `Strava: ${text.slice(0, 200)}`);
      }
      json = JSON.parse(text) as TokenJson;
    } catch (e) {
      return fault(StravaStatusCode.statusUnknownError, describeError(e));
    }
    if (!json.access_token || json.expires_at == null) {
      return fault(StravaStatusCode.statusAuthError, 'Strava returned no access token');
    }
    this.token = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_at,
      tokenType: json.token_type ?? null,
      scope: STRAVA_SCOPE,
    };
    saveToken(this.token);
    return fault(StravaStatusCode.statusOk, 'connected');
  }

  /**
   * Ensure a usable, non-expired access token, refreshing with the refresh
   * token when needed. Returns true if we end up with a valid token. Does NOT
   * launch the full authorize flow — that is user-gesture driven (CONNECT →
   * buildAuthorizeUrl).
   */
  async ensureFreshToken(): Promise<boolean> {
    if (!this.isAuthorized()) return false;
    if (!this.isExpired()) return true;
    const rt = this.token.refreshToken;
    if (!rt) return false;
    if (!isConfigured()) return false;

    const body = new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      grant_type: 'refresh_token',
      refresh_token: rt,
    });
    try {
      const resp = await fetch(proxied(TOKEN_ENDPOINT), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (resp.status < 200 || resp.status >= 300) return false;
      const json = (await resp.json()) as TokenJson;
      if (!json.access_token) return false;
      // Strava can rotate the refresh token — keep the new one if present.
      this.token = {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? rt,
        expiresAt: json.expires_at ?? this.token.expiresAt,
        tokenType: json.token_type ?? this.token.tokenType,
        scope: this.token.scope ?? STRAVA_SCOPE,
      };
      saveToken(this.token);
      return true;
    } catch {
      return false;
    }
  }

  /** convenience: fresh token if we can get one, else null (upload uses this) */
  async getValidAccessToken(): Promise<string | null> {
    const ok = await this.ensureFreshToken();
    return ok ? this.token.accessToken : null;
  }

  /**
   * Revoke the token and forget it: POST the deauthorize endpoint with the
   * Bearer header, then clear storage regardless of the outcome. Strava also
   * offers POST /oauth/revoke (Basic auth); the /oauth/deauthorize path used
   * here still works.
   */
  async deauthorize(): Promise<Fault> {
    const header = this.authHeader();
    let result: Fault;
    if (!header) {
      result = fault(StravaStatusCode.statusNoAuthenticationYet, 'No authentication yet');
    } else {
      try {
        const resp = await fetch(proxied(DEAUTHORIZE_ENDPOINT), { method: 'POST', headers: header });
        result =
          resp.status >= 200 && resp.status < 300
            ? fault(StravaStatusCode.statusOk, 'Deauthorized')
            : fault(StravaStatusCode.statusDeAuthorizeError, 'Deauthorize failed');
      } catch (e) {
        result = fault(StravaStatusCode.statusDeAuthorizeError, describeError(e));
      }
    }
    clearToken();
    this.token = loadToken();
    return result;
  }

  /**
   * Same-tab redirect capture (web convenience). If the page loaded with
   * `?code=…&scope=…` (Strava's success redirect shape) and we are configured,
   * exchange the code and strip it from the URL. Returns the resulting Fault,
   * or null if there was nothing to capture. Also honors a native-injected
   * `window.__laasStravaCode` (Android Custom Tab loopback bridge).
   */
  async captureRedirect(): Promise<Fault | null> {
    const native = (globalThis as unknown as { __laasStravaCode?: string }).__laasStravaCode;
    if (native) {
      (globalThis as unknown as { __laasStravaCode?: string }).__laasStravaCode = undefined;
      return isConfigured() ? this.exchangeCode(native) : null;
    }
    let search: string;
    try {
      search = globalThis.location?.search ?? '';
    } catch {
      return null;
    }
    if (!search) return null;
    const q = new URLSearchParams(search);
    const code = q.get('code');
    // require the Strava success shape (code + scope) to avoid grabbing an
    // unrelated `code` query param, and only if credentials are present
    if (!code || !q.get('scope') || !isConfigured()) return null;
    const result = await this.exchangeCode(code);
    try {
      q.delete('code');
      q.delete('scope');
      q.delete('state');
      const rest = q.toString();
      const clean = globalThis.location.pathname + (rest ? `?${rest}` : '') + globalThis.location.hash;
      globalThis.history?.replaceState(null, '', clean);
    } catch {
      /* history unavailable in headless probes */
    }
    return result;
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
