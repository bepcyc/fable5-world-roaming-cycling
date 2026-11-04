/**
 * Shared scaffold for the UX-batch-A behavioural probes (UX-08/10/15/16).
 *
 * These probes need what probe-ui-touch's layout gate deliberately avoids: a
 * REAL running world on a REAL GPU, driven through a mobile touch context. The
 * mobile-context recipe is lifted verbatim from tools/probe-ui-touch.ts (the
 * webdriver + maxTouchPoints override is what makes BrowserGate.isMobileDevice()
 * and GameMenu.shouldBypass() behave like the phone the user actually holds);
 * boot/settle mirror tools/probe-ridehud.ts. Kept in one place so each per-case
 * probe stays a few lines of its own behaviour.
 */

import type { Browser, BrowserContext, Page } from 'playwright';

/** A real device profile. The owner's targets are a phone and a tablet; the
 *  default here is the phone (portrait metrics the UX-08 brief names). Layout
 *  correctness is probe-ui-touch's job — these probes test BEHAVIOUR, so the
 *  #rotate overlay in portrait is irrelevant (events are dispatched straight
 *  at elements, not hit-tested). */
export interface UxProfile {
  width: number;
  height: number;
  dpr: number;
}
export const PHONE_PORTRAIT: UxProfile = { width: 390, height: 844, dpr: 3 };
export const PHONE_LANDSCAPE: UxProfile = { width: 918, height: 411, dpr: 2.625 };

/** The tablet's own Chrome reports a DESKTOP UA — the exact reason BrowserGate
 *  falls back to maxTouchPoints. Emulating a mobile UA would test a path the
 *  device never takes (see probe-ui-touch.ts). */
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export async function mobileContext(
  browser: Browser,
  profile: UxProfile = PHONE_PORTRAIT,
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.dpr,
    isMobile: true,
    hasTouch: true,
    userAgent: DESKTOP_UA,
  });
  // STRING form, not a function — esbuild rewrites function args (see the long
  // note in probe-ui-touch.ts). webdriver:false opts the menu back in;
  // maxTouchPoints:5 is what BrowserGate.isMobileDevice() keys off.
  await ctx.addInitScript({
    content:
      "Object.defineProperty(navigator, 'webdriver', { get: () => false });" +
      "Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });",
  });
  return ctx;
}

/** boot a page and wait until the app is ready (or reports a fatal error) */
export async function bootWorld(
  ctx: BrowserContext,
  url: string,
  timeout = 600_000,
): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout, polling: 500 },
  );
  const error = await page.evaluate(() => window.__laas.error);
  if (error) throw new Error(`App reported fatal error:\n${error}`);
  return page;
}

export async function settle(page: Page, frames: number): Promise<void> {
  await page.evaluate(
    async (n) => window.__laas.settle && (await window.__laas.settle(n)),
    frames,
  );
}

/** Teleport the rider onto the nearest edge of a road class and mount the
 *  matching bike — the same move OptionsMenu makes when you pick a bike far
 *  from a road. Returns false if no such edge exists / mount refused. */
export async function mountOnClass(page: Page, cls: string, mode: string): Promise<boolean> {
  return page.evaluate(
    ({ cls, mode }) => {
      const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg;
      if (!dbg) return false;
      const graph = dbg['rideGraph'] as
        | { edges: { id: number; cls: { name: string }; pts: { s: number }[] }[] }
        | undefined;
      const ride = dbg['ride'] as
        | { teleportEdge(id: number, s: number, dir: 1 | -1): boolean; setMode(m: string): boolean }
        | undefined;
      if (!graph || !ride) return false;
      const edge = graph.edges.find((e) => e.cls.name === cls) ?? graph.edges[0];
      if (!edge) return false;
      const mid = edge.pts[Math.floor(edge.pts.length / 2)] ?? edge.pts[0];
      if (!mid) return false;
      ride.teleportEdge(edge.id, mid.s, 1);
      return ride.setMode(mode);
    },
    { cls, mode },
  );
}

export interface CheckRunner {
  check(name: string, ok: boolean, detail?: string): void;
  readonly failed: boolean;
}

export function makeChecks(): CheckRunner {
  let anyFailed = false;
  return {
    check(name: string, ok: boolean, detail = ''): void {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
      if (!ok) anyFailed = true;
    },
    get failed(): boolean {
      return anyFailed;
    },
  };
}
