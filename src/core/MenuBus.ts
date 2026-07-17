/**
 * MenuBus — the one-overlay-at-a-time rule (owner UX bug, 2026-07-17:
 * "menus never close when you expect and all stack on top of each other").
 *
 * Every full/partial overlay (pause card, options panel, BLE device
 * manager, graphics sheet) announces itself when it OPENS; every other
 * overlay listens and closes itself in response. No central registry, no
 * z-order arbitration, no ownership graph — just "opening one dismisses
 * the rest", which is the whole UX contract phones and Zwift follow.
 *
 * Deliberately DOM-event based (not a shared singleton) so independently
 * constructed classes (GameMenu is wired before the engine exists,
 * DeviceManagerUi may be built lazily mid-ride) need no dependency on each
 * other — same decoupling pattern as the __laasDbg seams.
 */

const EVT = 'laas:menu-open';

/** call when an overlay becomes visible; every OTHER overlay closes */
export function announceMenuOpen(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVT, { detail: id }));
}

/** subscribe an overlay: `close` fires whenever a DIFFERENT overlay opens.
 *  `ignore` lists overlays that legitimately stack ON TOP of this one and
 *  return to it on close (the graphics sheet over the pause card, UX-11). */
export function onOtherMenuOpen(id: string, close: () => void, ignore: readonly string[] = []): void {
  window.addEventListener(EVT, (e) => {
    const who = (e as CustomEvent<string>).detail;
    if (who !== id && !ignore.includes(who)) close();
  });
}
