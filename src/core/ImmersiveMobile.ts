/**
 * Mobile immersive + hard-landscape enforcement (offline-APK / phone Chrome).
 *
 * The engine's renderer is already aspect-adaptive (Engine resizes on every
 * window 'resize'), so there is neither stretch nor crop — the job here is only
 * to (a) take the whole screen (fullscreen hides the browser chrome / URL bar)
 * and (b) force landscape. Both are best-effort: `requestFullscreen` and
 * `screen.orientation.lock` reject on unsupported/denied contexts, so the CSS
 * `@media (orientation:portrait)` #rotate overlay in index.html is the
 * guaranteed fallback that always covers the screen in portrait.
 *
 * Desktop / Electron are left completely untouched (isMobileDevice() === false),
 * so no one on a keyboard ever gets forced into fullscreen.
 *
 * Orientation lock on Chrome Android is ONLY permitted while fullscreen, hence
 * the order: requestFullscreen() THEN orientation.lock('landscape'). We arm on
 * documentElement (not the canvas) so the HTML menu / HUD overlays stay visible.
 */

import { isMobileDevice } from './BrowserGate';

async function enterImmersive(): Promise<void> {
  try {
    const el = document.documentElement as HTMLElement & {
      requestFullscreen(options?: FullscreenOptions): Promise<void>;
    };
    if (!document.fullscreenElement && el.requestFullscreen) {
      await el.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {
    /* denied/unsupported — the CSS #rotate overlay is the fallback */
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    await orientation.lock?.('landscape');
  } catch {
    /* lock unsupported/denied — CSS #rotate overlay handles portrait */
  }
}

/** Arm a first-gesture handler that enters fullscreen+landscape. No-op on desktop. */
export function initImmersiveMobile(): void {
  if (!isMobileDevice()) return; // desktop / Electron untouched

  const onGesture = (): void => {
    void enterImmersive();
  };
  // capture:true so the very first tap anywhere arms immersive before any
  // in-page handler can swallow it; NOT once — re-fires are harmless (guarded)
  document.addEventListener('pointerup', onGesture, { capture: true });

  // if the user exits fullscreen (system gesture), re-arming happens naturally
  // because the pointerup listener is still attached — the next tap re-enters.
  document.addEventListener('fullscreenchange', () => {
    // no-op: listener persists; this hook exists so a future exit-handler has a
    // seam, and documents the re-entry contract.
    if (document.fullscreenElement === null) {
      /* next pointerup re-enters immersive */
    }
  });
}
