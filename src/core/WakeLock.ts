/**
 * Screen Wake Lock — keeps the display on for the length of a ride.
 *
 * Without this the OS treats LAAS like any other page: the screen dims and
 * locks mid-ride on both the offline APK (Chrome Custom Tab) and desktop
 * Chrome/Electron, and a locked phone screen means a dead HUD until the
 * rider unlocks it again.
 *
 * `navigator.wakeLock.request('screen')` is unconditionally best-effort: it
 * REJECTS (does not throw synchronously) when the API is unsupported, the
 * document is not visible, or the platform declines for battery reasons —
 * all wrapped so a denial never breaks boot.
 *
 * THE LOCK IS RELEASED BY THE PLATFORM WHENEVER THE TAB/APP GOES HIDDEN
 * (backgrounded, screen off, app-switched away) — this is spec behavior,
 * not a bug. The sentinel's own 'release' event fires then too, but it does
 * NOT reacquire itself. Re-requesting only on `visibilitychange` back to
 * 'visible' is what makes the lock survive the phone screen having gone
 * dark once already; skipping this re-arm is the single most common way
 * wake-lock code silently stops working after the first backgrounding.
 *
 * No user gesture is required in Chrome (verified: `request()` resolves
 * from a plain top-level call with the document visible) — unlike
 * ImmersiveMobile's fullscreen+orientation lock, this needs no first-tap.
 */

let sentinel: WakeLockSentinel | null = null;

async function acquire(): Promise<void> {
  if (sentinel !== null) return; // already held
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null; // platform-released (backgrounded) — visibilitychange re-arms
    });
  } catch {
    /* unsupported / backgrounded / battery saver — best-effort, no throw */
  }
}

/** Request the screen wake lock now and keep re-acquiring it after every
 *  backgrounding. Desktop AND mobile: a rider watching the HUD on a laptop
 *  doesn't want the display to sleep mid-ride either, and the API is a
 *  harmless no-op/reject anywhere it isn't wanted. */
export function initWakeLock(): void {
  if (!('wakeLock' in navigator)) return; // unsupported browser — no-op

  void acquire();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void acquire();
  });
}
