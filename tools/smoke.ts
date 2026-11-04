/**
 * smoke.ts — the headless/CI-safe end-to-end tier (kanzo fable5#132).
 *
 * Two tiers, reported honestly:
 *   B (real GPU headless): launch-gpu.ts finds a REAL adapter — boots
 *      ?scene=sanity to __laas.ready with zero page errors. Runs on the
 *      owner box (AMD + the headless --use-angle=vulkan recipe); skipped
 *      cleanly everywhere else.
 *   A (no GPU required): proves the app layer end-to-end without a device —
 *      (1) the bundle executes (window.__laas appears), (2) boot resolves to
 *      ready OR the fail-loud path sets __laas.error AND renders the
 *      #laas-fatal overlay, (3) BrowserGate's real decision function
 *      (__laasGateVerdict, the seam probe-ux16-gate.ts also uses) rejects a
 *      non-Chromium env with "Google Chrome is required". A live non-Chromium
 *      run is impossible to emulate: navigator.userAgentData is an
 *      unforgeable own-property in Chromium, so a UA-string override still
 *      brands the browser as Chromium (verified 2026-11-04).
 *
 * Measured on this box 2026-11-04: SwiftShader WebGPU is NOT a smoke tier —
 * the adapter comes up (--use-webgpu-adapter=swiftshader → google/swiftshader,
 * 10 storage buffers) and scene=sanity builds in ~76 s on CPU, but the device
 * is then dropped with OperationError "Instance dropped in popErrorScope"
 * before ready — 3/3 runs (once at 1.3 s, twice post-build). Tier A therefore
 * does not depend on adapter behaviour at all.
 *
 * Server: reuses a dev server already answering at LAAS_ORIGIN (LAAS_PORT,
 * default 5174 — the same origin every other tool uses); spawns its own
 * `vite --strictPort` there when the port is free and kills it on exit.
 * Chrome for tier A: CHROME_BIN, the launch-gpu candidate list, then the
 * Playwright-bundled chromium.
 *
 *   npx tsx tools/smoke.ts          — both tiers as available
 *   npx tsx tools/smoke.ts --tier-a — force the no-GPU tier only
 */

import { chromium, type Browser } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { LAAS_ORIGIN, launchWebGPUReal } from './launch-gpu';
import { laasUrl } from './launch';

const BOOT_TIMEOUT = 60_000;
const READY_TIMEOUT = 150_000;
const USER = process.env['USER'] ?? '';

const BIN_CANDIDATES = [
  process.env['CHROME_BIN'],
  `/etc/profiles/per-user/${USER}/bin/google-chrome`,
  `/etc/profiles/per-user/${USER}/bin/chromium`,
  '/run/current-system/sw/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/opt/google/chrome/chrome',
].filter((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p));

interface LaasWindow {
  __laas?: { ready?: boolean; error?: string | null };
}

let failed = false;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

function probeHttp(url: string, timeoutMs = 1500): Promise<number> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await probeHttp(url)) > 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never answered ${url}`);
}

/** Reuse the dev server at LAAS_ORIGIN when present; else spawn our own. */
async function ensureServer(): Promise<ChildProcess | null> {
  if ((await probeHttp(LAAS_ORIGIN, 1500)) > 0) {
    // A server answers — but only a vite DEV server serves /src/main.ts;
    // `vite preview` under the '/laas/' build base does not (verified
    // 2026-11-04: it SPA-falls-back to index.html and the bundle 404s).
    const dev = await probeHttp(`${LAAS_ORIGIN}/src/main.ts`, 1500);
    if (dev === 200) {
      console.log(`[smoke] reusing dev server at ${LAAS_ORIGIN}`);
      return null;
    }
    throw new Error(
      `${LAAS_ORIGIN} answers but is not a vite dev server ` +
        `(/src/main.ts → ${dev}) — stop it or set LAAS_PORT to a free port`,
    );
  }
  const port = LAAS_ORIGIN.match(/:(\d+)/)?.[1] ?? '5174';
  const proc = spawn('npx', ['vite', '--port', port, '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[vite] ${d}`));
  try {
    await waitHttp(LAAS_ORIGIN, 20_000);
  } catch (e) {
    proc.kill();
    throw e;
  }
  console.log(`[smoke] spawned dev server at ${LAAS_ORIGIN}`);
  return proc;
}

async function launchChrome(args: string[] = []): Promise<Browser> {
  for (const exe of BIN_CANDIDATES) {
    try {
      return await chromium.launch({ headless: true, executablePath: exe, args });
    } catch {
      /* next candidate */
    }
  }
  return chromium.launch({ headless: true, channel: 'chromium', args });
}

const laasState = (page: { evaluate: (f: () => unknown) => Promise<unknown> }) =>
  page.evaluate(() => ({
    laas: typeof (window as LaasWindow).__laas,
    ready: (window as LaasWindow).__laas?.ready === true,
    error: (window as LaasWindow).__laas?.error ?? null,
  })) as Promise<{ laas: string; ready: boolean; error: string | null }>;

/** Tier B — real GPU headless: sanity scene must reach __laas.ready. */
async function tierB(): Promise<boolean> {
  let launched: { browser: Browser; info: { vendor: string; architecture: string } };
  try {
    launched = await launchWebGPUReal();
  } catch (e) {
    console.log(`[smoke] tier B skipped — no real-GPU headless recipe (${String(e).slice(0, 140)})`);
    return false;
  }
  console.log(`[smoke] tier B adapter ${launched.info.vendor}/${launched.info.architecture}`);
  const page = await launched.browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  try {
    await page.goto(
      laasUrl({ scene: 'sanity', seed: 1, preset: 'min', extra: { dpr: '0.5', notimestamp: '1' } }),
      { waitUntil: 'domcontentloaded' },
    );
    try {
      await page.waitForFunction(
        () => {
          const l = (window as LaasWindow).__laas;
          return !!l && (l.ready === true || l.error !== null);
        },
        undefined,
        { timeout: READY_TIMEOUT, polling: 500 },
      );
    } catch {
      errors.push('timeout: never reached ready or error');
    }
    const s = await laasState(page);
    check('tier B: sanity scene reaches __laas.ready', s.ready && !s.error, s.error ?? '');
    check('tier B: zero page errors', errors.length === 0, errors[0] ?? '');
  } finally {
    await launched.browser.close();
  }
  return true;
}

/** Tier A — no GPU: bundle executes, boot resolves, gate logic works. */
async function tierA(): Promise<void> {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.goto(
      laasUrl({ scene: 'sanity', seed: 1, extra: { notimestamp: '1' } }),
      { waitUntil: 'domcontentloaded' },
    );

    // (1) the JS bundle must actually execute
    let booted = true;
    try {
      await page.waitForFunction(
        () => typeof (window as LaasWindow).__laas === 'object',
        undefined,
        { timeout: BOOT_TIMEOUT, polling: 500 },
      );
    } catch {
      booted = false;
    }
    check('tier A: bundle executes (window.__laas)', booted);
    if (!booted) return;

    // (2) boot must RESOLVE — either ready, or the fail-loud error path
    let resolved = true;
    try {
      await page.waitForFunction(
        () => {
          const l = (window as LaasWindow).__laas;
          return !!l && (l.ready === true || l.error !== null);
        },
        undefined,
        { timeout: READY_TIMEOUT, polling: 500 },
      );
    } catch {
      resolved = false;
    }
    const s = await laasState(page);
    check(
      'tier A: boot resolves (ready or fail-loud)',
      resolved && (s.ready || s.error !== null),
      s.ready ? 'ready' : (s.error ?? errors[0] ?? '').slice(0, 140),
    );
    if (!s.ready) {
      const overlay = await page.evaluate(() => !!document.getElementById('laas-fatal'));
      check('tier A: fail-loud renders the #laas-fatal overlay', overlay);
    }

    // (3) BrowserGate decision logic via the in-page seam — the same seam
    // probe-ux16-gate.ts uses for the verdict matrix (a live non-Chromium
    // browser cannot be emulated: userAgentData is unforgeable).
    type Verdict = { pass: true } | { pass: false; title: string };
    const nonChromium = await page.evaluate(() => {
      const fn = (
        globalThis as unknown as {
          __laasGateVerdict?: (e: {
            nogate: boolean;
            mobile: boolean;
            chromium: boolean;
            webgpu: boolean;
          }) => Verdict;
        }
      ).__laasGateVerdict;
      if (!fn) return null;
      return fn({ nogate: false, mobile: false, chromium: false, webgpu: false });
    });
    check(
      'tier A: gateVerdict rejects non-Chromium',
      nonChromium !== null && !nonChromium.pass && nonChromium.title === 'Google Chrome is required',
      nonChromium === null ? '__laasGateVerdict not exposed' : JSON.stringify(nonChromium),
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const server = await ensureServer();
  try {
    const b = process.argv.includes('--tier-a') ? false : await tierB();
    await tierA();
    console.log(
      `[smoke] DONE — tier B ${b ? 'ran' : 'skipped'}; tier A done` +
        (failed ? ' (FAILURES above)' : ''),
    );
  } finally {
    server?.kill();
  }
  if (failed) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
