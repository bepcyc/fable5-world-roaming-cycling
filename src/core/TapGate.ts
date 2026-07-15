/**
 * Mobile-only "tap to start" gate — makes the Custom Tab toolbar disappear
 * for the WHOLE ~45-105s world load instead of only once "in game".
 *
 * requestFullscreen() needs transient user activation (a real gesture) and
 * there is no Custom Tabs API to launch without browser chrome, so
 * ImmersiveMobile.ts already arms a persistent first-tap listener that
 * enters fullscreen+landscape. The owner-reported bug is that a passive
 * phone user has nothing worth tapping until the splash's Start button goes
 * from "LOADING NN%" to ready, so the FIRST real tap doesn't happen until
 * well after the toolbar has already been sitting there through the load.
 *
 * #tapgate fixes that by covering the whole screen the instant this module
 * runs (mobile only), so the user's very first tap — before any loading
 * progress is meaningfully visible — is forced to land on it. It does NOT
 * duplicate the fullscreen call: ImmersiveMobile's listener is registered
 * on `document` with `capture: true`, so it already fires for a tap
 * anywhere, including on this gate — this module only has to get out of
 * the way once that tap has happened.
 *
 * It does not gate the world load itself: boot() in main.ts already starts
 * loading unconditionally the moment the module runs, in parallel with
 * whatever the splash/menu is showing — gating the load behind a tap would
 * make an already slow load slower for no reason. This is a pure visual
 * overlay; hiding it changes nothing about load progress or timing.
 */

import { isMobileDevice } from './BrowserGate';
import { shouldBypass } from './GameMenu';
import type { LaasParams } from './Params';

/** Arm the tap gate. No-op on desktop/Electron and under every escape hatch
 *  `shouldBypass` already recognizes (webdriver — every Playwright probe/
 *  screenshot tool trips this — nosplash=1, non-'world' scenes, freeze=1). */
export function initTapGate(params: LaasParams): void {
  if (!isMobileDevice() || shouldBypass(params)) return;
  const gate = document.getElementById('tapgate');
  if (!gate) return;
  gate.classList.add('on');
  // one-shot: the SAME tap satisfies ImmersiveMobile's document-level
  // capture listener (fires for any target) — this listener only needs to
  // dismiss the overlay, never re-shown once the user has tapped once.
  gate.addEventListener('pointerup', () => gate.classList.remove('on'), { once: true });
}
