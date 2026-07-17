/**
 * Pre-boot environment gate — runs before ANY engine work so users on
 * unsupported setups get a clear message instead of a broken boot screen.
 *
 * Order of checks (gateVerdict, pure + unit-testable):
 *  1. non-Chromium browser → Chrome required, on ANY form factor. The engine
 *     is built and tested exclusively against Chrome's WebGPU; Safari/Firefox
 *     coverage of the features used here is incomplete (user-verified:
 *     neither boots). Brand list from UA-CH when present (covers Chrome, Edge,
 *     Brave, Arc, Opera), "Chrome/" UA token as the fallback — HeadlessChrome
 *     passes both, so the Playwright tooling is unaffected.
 *  2. mobile/tablet → NO LONGER a hard dead-end (UX-16). WebGPU presence is
 *     the real gate: a phone that exposes WebGPU is an experimental-but-
 *     supported target, so it boots (the adapter-level probe in boot() still
 *     fails loud on a dead adapter). A phone WITHOUT WebGPU gets an actionable
 *     how-to (secure context / Chrome Android / flags), not "buy a computer".
 *     This also covers the offline APK (Chrome Custom Tab on 127.0.0.1 exposes
 *     WebGPU), so the old loopback special-case is gone. Detection is
 *     capability/UA based, never screen size (isMobileDevice below).
 *  3. desktop Chromium but `navigator.gpu` missing → the standard actionable
 *     checklist (update, hardware acceleration, chrome://gpu).
 *
 * `?nogate=1` skips everything (tooling/debug escape hatch).
 */

import { failLoud } from './Diagnostics';

interface UAClientHints {
  mobile?: boolean;
  brands?: { brand: string; version: string }[];
}

function clientHints(): UAClientHints | undefined {
  return (navigator as { userAgentData?: UAClientHints }).userAgentData;
}

/** phone/tablet detection — capability + UA based, never screen metrics */
export function isMobileDevice(): boolean {
  if (clientHints()?.mobile === true) return true;
  const ua = navigator.userAgent;
  // Kindle = Silk. Phones keep "Mobile"; most Android tablets keep "Android".
  if (/Android|iPhone|iPod|iPad|Windows Phone|IEMobile|Silk|Mobile/i.test(ua)) return true;
  // …but a tablet in "desktop site" mode lies COMPLETELY, and that is not an
  // edge case — it is the default on Samsung tablets. Measured on a Galaxy Tab
  // S8 Ultra (Android 16) 2026-07-15: ua = "Mozilla/5.0 (X11; Linux x86_64) …
  // Chrome/150" — no Android token, no Mobile token, userAgentData.mobile
  // false. Every UA test above misses, and the old code then also cost us
  // fullscreen and the landscape lock, since ImmersiveMobile gates on this.
  // iPadOS 13+ pulls the same trick with a "Macintosh" UA.
  //
  // When the UA lies, device capability is the only honest signal: a machine
  // with a real pointing device reports `pointer: fine` as its PRIMARY pointer,
  // so a touchscreen laptop is still correctly treated as desktop; coarse +
  // multi-touch means a screen you hold in your hands. index.html's #rotate
  // overlay already relies on `pointer: coarse` for exactly this reason.
  if (navigator.maxTouchPoints > 2 && matchMedia('(pointer: coarse)').matches) return true;
  return false;
}

/** Chrome or any Chromium-based browser (Edge, Brave, Arc, Opera, ...) */
export function isChromiumBrowser(): boolean {
  const brands = clientHints()?.brands;
  if (brands && brands.length > 0) {
    return brands.some((b) => /Chromium|Google Chrome/i.test(b.brand));
  }
  // every Chromium UA carries "Chrome/" (incl. HeadlessChrome); Safari and
  // Firefox never do
  return /Chrome\//.test(navigator.userAgent);
}

/** The environment the gate decides on. Sampled from live globals in
 *  browserGate(); passed explicitly to gateVerdict() so the decision is pure
 *  and the whole matrix is unit-testable (no host/secure-context juggling). */
export interface GateEnv {
  nogate: boolean;
  mobile: boolean;
  chromium: boolean;
  webgpu: boolean;
}

export type GateVerdict = { pass: true } | { pass: false; title: string; details: string[] };

/** Pure gate decision. See the file header for the ordering rationale. */
export function gateVerdict(env: GateEnv): GateVerdict {
  if (env.nogate) return { pass: true };

  // non-Chromium can't run the engine on any form factor
  if (!env.chromium) {
    return {
      pass: false,
      title: 'Google Chrome is required',
      details: [
        'LAAS is built and tested against Chrome’s WebGPU implementation.',
        'Safari and Firefox currently cannot run it.',
        '',
        'Please open this page in Google Chrome 113 or newer.',
        'Chromium-based browsers (Edge, Brave, Arc, Opera) should also work.',
      ],
    };
  }

  // mobile/tablet: WebGPU presence is the gate, not the form factor (UX-16).
  // A phone that exposes WebGPU boots; one that doesn't gets a real how-to.
  if (env.mobile) {
    if (env.webgpu) return { pass: true };
    return {
      pass: false,
      title: 'Enable WebGPU to play on mobile',
      details: [
        'This runs a desktop-class GPU engine through WebGPU, which this',
        'browser is not exposing right now. Two common reasons on mobile:',
        '',
        '  • Insecure origin: open this over https:// or http://localhost —',
        '    NOT a plain http://<LAN-IP> address. WebGPU is hidden on',
        '    insecure origins (the secure-context requirement).',
        '  • WebGPU disabled: use the latest Google Chrome for Android; if',
        '    needed, enable chrome://flags → “Unsafe WebGPU Support”, reload.',
        '',
        'Mobile is experimental (it may hit memory limits) — prefer',
        '?preset=min&dpr=0.6. A laptop on Chrome stays the smooth path.',
      ],
    };
  }

  // desktop Chromium: WebGPU must be present
  if (!env.webgpu) {
    return {
      pass: false,
      title: 'WebGPU is unavailable in this browser',
      details: [
        'You are on a Chromium browser, but it does not expose WebGPU.',
        '',
        'Things to check:',
        '  • Update Chrome — WebGPU needs version 113 or newer.',
        '  • Settings → System → “Use hardware acceleration” must be ON',
        '    (relaunch after changing it).',
        '  • chrome://gpu should list WebGPU as “Hardware accelerated”.',
        '  • On Linux, recent Chrome may need chrome://flags/#enable-vulkan',
        '    or launching with --enable-features=Vulkan.',
      ],
    };
  }

  return { pass: true };
}

/** @returns true when boot may proceed; false after rendering a notice */
export function browserGate(): boolean {
  const v = gateVerdict({
    nogate: new URLSearchParams(window.location.search).get('nogate') === '1',
    mobile: isMobileDevice(),
    chromium: isChromiumBrowser(),
    webgpu: 'gpu' in navigator && !!navigator.gpu,
  });
  if (v.pass) return true;
  failLoud(v.title, v.details);
  return false;
}

// test seam (consistent with __laas/__laasDbg): tools/probe-ux16-gate.ts
// exercises the full verdict matrix here, which is impractical to reproduce
// by standing up every secure/insecure × loopback host combination live.
(globalThis as unknown as { __laasGateVerdict?: typeof gateVerdict }).__laasGateVerdict =
  gateVerdict;
