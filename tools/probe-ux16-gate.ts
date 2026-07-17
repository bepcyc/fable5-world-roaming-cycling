/**
 * UX-16 — first launch on a phone is no longer a dead-end.
 *
 * The bug: BrowserGate hard-blocked any mobile browser with "A computer is
 * required" (no way forward but the undocumented ?nogate=1), even on a phone
 * that CAN run WebGPU. Two proofs here:
 *
 *  1. INTEGRATION — a mobile touch context on a secure origin (localhost) with
 *     WebGPU present boots straight into the game, no #laas-fatal gate. (The
 *     matching BEFORE — the old gate blocking on a non-loopback host — is
 *     captured separately for the SBS.)
 *  2. DECISION MATRIX — the pure gateVerdict() is evaluated in-page across the
 *     whole environment matrix: mobile+WebGPU passes (the fix), mobile without
 *     WebGPU gets an ACTIONABLE how-to (not "buy a computer"), and no verdict
 *     ever produces the old dead-end string again.
 *
 * Usage: LAAS_PORT=5186 npx tsx tools/probe-ux16-gate.ts
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';
import { bootWorld, makeChecks, mobileContext, PHONE_LANDSCAPE } from './ux-probe-util';

type Verdict = { pass: true } | { pass: false; title: string; details: string[] };
interface Env {
  nogate: boolean;
  mobile: boolean;
  chromium: boolean;
  webgpu: boolean;
}

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ux16] adapter ${info.vendor}/${info.architecture}`);
  const ctx = await mobileContext(browser, PHONE_LANDSCAPE);
  const c = makeChecks();
  try {
    // INTEGRATION: mobile viewport, secure origin, WebGPU present → the game
    // loads (nosplash renders the world directly; the gate still runs — only
    // nogate skips it). If the gate blocked, bootWorld would see __laas.error.
    const page = await bootWorld(
      ctx,
      `${LAAS_ORIGIN}/?scene=world&seed=1&preset=min&nosplash=1`,
    );
    const gated = await page.evaluate(() => !!document.getElementById('laas-fatal'));
    c.check('mobile + WebGPU boots into the game (no gate screen)', !gated);
    await page.screenshot({ path: 'shots/wip/ux/ux16-stalo.png' });

    // DECISION MATRIX: evaluate the real pure verdict in-page
    const verdict = (env: Env): Promise<Verdict> =>
      page.evaluate((e) => {
        const fn = (globalThis as unknown as { __laasGateVerdict?: (x: Env) => Verdict })
          .__laasGateVerdict;
        if (!fn) throw new Error('__laasGateVerdict not exposed');
        return fn(e);
      }, env);

    const vMobileGpu = await verdict({ nogate: false, mobile: true, chromium: true, webgpu: true });
    c.check('mobile+Chrome+WebGPU → PASS (the fix)', vMobileGpu.pass);

    const vMobileNoGpu = await verdict({ nogate: false, mobile: true, chromium: true, webgpu: false });
    c.check(
      'mobile+Chrome, no WebGPU → actionable how-to, not "computer required"',
      !vMobileNoGpu.pass && /Enable WebGPU/i.test(vMobileNoGpu.title),
      vMobileNoGpu.pass ? '' : vMobileNoGpu.title,
    );

    const vDesktopGpu = await verdict({ nogate: false, mobile: false, chromium: true, webgpu: true });
    c.check('desktop+Chrome+WebGPU → PASS', vDesktopGpu.pass);

    const vDesktopNoGpu = await verdict({ nogate: false, mobile: false, chromium: true, webgpu: false });
    c.check(
      'desktop, no WebGPU → WebGPU-unavailable notice',
      !vDesktopNoGpu.pass && /WebGPU is unavailable/i.test(vDesktopNoGpu.title),
    );

    const vSafari = await verdict({ nogate: false, mobile: true, chromium: false, webgpu: true });
    c.check(
      'non-Chromium → Chrome-required (any form factor)',
      !vSafari.pass && /Chrome is required/i.test(vSafari.title),
    );

    const vNogate = await verdict({ nogate: true, mobile: true, chromium: false, webgpu: false });
    c.check('?nogate=1 still bypasses everything', vNogate.pass);

    // the dead-end string must be gone from every branch
    const anyDeadEnd = [vMobileGpu, vMobileNoGpu, vDesktopGpu, vDesktopNoGpu, vSafari, vNogate].some(
      (v) => !v.pass && /a computer is required/i.test(v.title),
    );
    c.check('old "A computer is required" dead-end is gone', !anyDeadEnd);

    await page.close();
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(c.failed ? '[probe-ux16] FAILURES PRESENT' : '[probe-ux16] ALL PASS');
  if (c.failed) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[probe-ux16] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
