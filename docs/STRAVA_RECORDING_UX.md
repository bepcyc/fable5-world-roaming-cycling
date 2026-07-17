# Strava upload + ride-recording control — research & shipped design

Two coupled features landed on branch `strava-upload` (based on v0.5.1):

1. A complete Strava *"Upload activities"* stack — OAuth authorize / token
   exchange / refresh / deauthorize, the multipart FIT upload and its
   status-polling loop, and the fault/status-code mapping. Lives in
   `src/ride/strava/`.
2. A ride-recording control surface (pause / resume / finish → save-file /
   sync-to-Strava / discard), whose UX follows familiar indoor-cycling app
   conventions. Lives in `src/ride/RideMenu.ts`.

This note records the UX research behind the design, the flows actually
shipped, the browser-CORS reality that shaped the OAuth transport, and the
one-time Strava API-app registration the **owner must do** before any upload can
run.

---

## 1. UX research

### Zwift — end-ride flow

After a Zwift ride ends the app shows a **save screen with three choices**:

- **Save** — caches the ride locally as a `.fit` (downloadable later from the
  Zwift website's activity list).
- **Save + Upload to Strava** — saves locally *and* auto-uploads to every
  connected service (Strava, etc.). The Strava link is a one-time account
  connection made in settings; at ride end it just fires.
- **Discard** — throws the ride data away.

Key takeaways adopted here: a *single* end-of-ride card; save-local and
save+sync are **separate buttons** (not a checkbox); discard is always present;
the service connection is established once and simply *used* at finish time.

Sources:
- Zwift & Strava — <https://support.strava.com/hc/en-us/articles/216918677-Zwift-and-Strava>
- Retrieve a lost/partial Zwift .fit — <https://zwiftinsider.com/retrieve-lost-ride/>
- Zwift keyboard shortcuts (end-ride via menu) — <https://zwiftinsider.com/keyboard-shortcuts/>

### MyWhoosh — pause / resume / finish + Strava sync

MyWhoosh runs an in-ride overlay: you can **pause** a session and **resume** it,
and on **finish** the completed ride is uploaded and then **auto-shared to the
connected Strava (and TrainingPeaks) account**. Connection is a one-time
account link (OAuth) done in settings/integrations; afterwards finished rides
sync automatically, and past rides can be pushed manually.

Key takeaways adopted here: an unobtrusive in-ride pause control; pause shows an
elapsed/distance snapshot; finishing is what triggers the sync; the Strava
connection state is visible and manageable next to the finish action.

Sources:
- Sync MyWhoosh with Strava & TrainingPeaks — <https://www.toolify.ai/ai-news/sync-your-mywhoosh-account-with-strava-and-trainingpeaks-195601>
- Connect MyWhoosh to Strava (link / auto-upload / troubleshoot) — <https://www.youtube.com/watch?v=XsdTMeloWI0>
- Upload previous MyWhoosh rides to Strava — <https://www.youtube.com/watch?v=LctckTGUDoA>

---

## 2. Strava browser-CORS reality (verified)

A native app never faces browser CORS. LAAS runs in a browser (and Electron /
Android WebView), so it does. What was verified against Strava's developer docs
and the community:

- **The OAuth token exchange is *not* CORS-enabled.** `POST
  https://www.strava.com/oauth/token` (equivalently the newer
  `.../api/v3/oauth/token`) does **not** return `Access-Control-Allow-Origin`,
  so a browser `fetch` to it is blocked. This is a long-standing, acknowledged
  gap. The Strava REST API in general is designed for server-side callers and
  does not serve permissive CORS to arbitrary browser origins — the FIT upload
  (`POST /api/v3/uploads`) and its status poll are in the same boat.
  Sources: Strava API + CORS thread <https://groups.google.com/g/strava-api/c/YizXJN5EBM4>,
  CORS proxy that exists *because* of this <https://github.com/JamesRandall/StravaAPIProxy>.
- **The authorize step is *not* a fetch** — it's a top-level browser navigation
  to `https://www.strava.com/oauth/authorize?...`, so CORS never applies there.
  Only the *token exchange* and the *API calls* need a CORS-clean transport.
- **localhost and 127.0.0.1 redirect URIs are white-listed** by Strava for
  development apps (confirmed in the authentication docs), which is what makes
  the loopback / copy-the-code redirect design below legal without owning a
  public domain. Source: <https://developers.strava.com/docs/authentication/>.

### How LAAS handles it

`StravaConfig` exposes an optional, configurable **CORS proxy prefix**
(`laas.strava.corsProxy`, empty by default). Every Strava *fetch* (token
exchange, refresh, deauthorize, upload, poll) is routed through `proxied(url)`:

- proxy empty → the request goes **direct** to Strava. This works as-is in
  **Electron** (renderer with `webSecurity` off, or a `net`/main-process
  forward) and in the **Android WebView / native bridge**, which are not bound
  by browser same-origin rules — and in any browser once Strava ever ships CORS.
- proxy set → the URL is rewritten. Two conventions are supported so the owner
  can point at whatever they run:
  - a `{url}` placeholder → replaced with the URL-encoded target
    (e.g. `https://worker.example.dev/?url={url}`);
  - otherwise a plain prefix (e.g. `https://worker.example.dev/` →
    `https://worker.example.dev/https://www.strava.com/oauth/token`, the
    cors-anywhere / `StravaAPIProxy`-style convention).

The **authorize navigation is never proxied** (it's a normal browser redirect).

---

## 3. OAuth redirect capture across our three environments

`redirect_uri` is configurable (`laas.strava.redirectUri`), default
`http://127.0.0.1/laas-strava` (a loopback the OS/native layer can catch and the
browser white-lists). Two capture paths are shipped, so *some* path works
everywhere:

1. **Copy-the-code (primary, session-safe, works everywhere).** CONNECT opens
   the authorize URL in a new tab. Strava redirects to `redirect_uri?code=…`.
   The user copies the `code` value out of the address bar and pastes it into
   the field on the end-ride card; the app exchanges it for a token (through the
   proxy). No local server, no page reload, so the in-memory ride is preserved.
   This is exactly the fallback Strava's localhost white-listing is meant for.
2. **Automatic same-tab capture (convenience, web).** If the owner sets
   `redirect_uri` to the app's own origin, letting Strava redirect the *same
   tab* back to the app, `StravaAuth.captureRedirect()` (called at boot) finds
   `?code=…` on `window.location`, exchanges it, and strips the query. Note this
   path reboots the game, so it's for *connecting between rides*, not at finish.

Per-environment intent:

- **Web on localhost / LAN** — copy-the-code always works; owners who set
  `redirect_uri` to the app origin also get automatic same-tab capture.
- **Electron loopback** — a tiny loopback listener (or a navigation intercept)
  on `127.0.0.1` catches the redirect and hands the code to the renderer;
  copy-the-code remains the no-glue fallback. Token exchange runs direct
  (no browser CORS in Electron).
- **Android Custom Tab on 127.0.0.1** — the native app registers the loopback /
  intent, catches `code`, and passes it into the page (`__laasStravaCode`);
  copy-the-code remains the fallback. Native HTTP is CORS-free.

---

## 4. Shipped flows

**In-ride control.** While a bike is being ridden, a small unobtrusive record
pill (top-right, touch) and the **`P`** key open the **PAUSE card**. Opening it
pauses the `RideRecorder` sample feed and shows an **elapsed / distance**
snapshot. Buttons: **RESUME** (un-pauses the feed) and **FINISH**.

**End-ride card** (from FINISH):

- **Activity name** field, default `LAAS Ride YYYY-MM-DD`.
- **Strava connection row** — shows Connected / Not connected with
  **CONNECT** / **DISCONNECT**, plus a **Strava settings** disclosure holding
  the Client ID / Client secret / redirect URI / CORS-proxy fields and the
  registration hint.
- **SAVE & SYNC TO STRAVA** — if not authorized, launches the OAuth flow first
  (authorize tab + code paste); then uploads via `StravaUpload` with live
  progress (uploading → processing → done) and a result toast linking to the
  created activity.
- **SAVE FILE** — the existing local `.fit` download (same path as `Ctrl+E`).
- **DISCARD** — confirms, then resets the recorder and starts a fresh session.

All overlays participate in `MenuBus` (opening one closes the others), use
mobile-first hit targets, and every string is `t()`-localized (en / de / ru).

---

## 5. Owner action — register a Strava API application (required, one-time)

No client id/secret ships with LAAS. Until these are set, CONNECT/upload cannot
run.

1. Sign in at **<https://www.strava.com/settings/api>** and create an app
   ("Create & Manage Your App").
2. Note the **Client ID** and **Client Secret**.
3. Set **Authorization Callback Domain** to match your `redirect_uri` host —
   `127.0.0.1` or `localhost` for development (both are white-listed), or your
   own domain for a hosted deploy.
4. In LAAS: end-ride card → **Strava settings** → paste **Client ID** and
   **Client Secret**; adjust **redirect URI** to match the callback domain; if
   running in a plain browser, set a **CORS proxy** URL (see §2).
5. Requested scope is **`activity:write`** (create uploads). The first CONNECT
   sends you to Strava's consent screen; approve it once.

These are stored in `localStorage` (`laas.strava.clientId`,
`laas.strava.clientSecret`, `laas.strava.redirectUri`, `laas.strava.corsProxy`).
The client secret in browser `localStorage` is a **known limitation** of a
backend-less SPA — acceptable for a personal single-user simulator, but it is
why a hosted multi-user deployment should move the token exchange behind the
owner's own proxy/worker rather than shipping the secret to clients.
