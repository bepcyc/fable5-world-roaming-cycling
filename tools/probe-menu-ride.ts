/**
 * Menu ride-path probe — reproduce the owner's DEMO+GRAVEL crash through the
 * REAL OptionsMenu UI (not the dbg API): boot plain `/` exactly like
 * `just run-rxgpu` does, press O, click DEMO, click GRAVEL, then ride and
 * cycle modes while watching for GPU-process death / device loss (the owner
 * sees "GPU state invalid after WaitForGetOffsetInRange" + exit_code=136 and
 * the next boot reports "WebGPU unavailable").
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/probe-menu-ride.ts
 * Frames land in shots/wip/menu-ride-*.png (send each to the owner's bot).
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';

let pass = true;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

async function main(): Promise<void> {
  const { browser } = await launchWebGPUReal();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  let crashed = false;
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error('[pageerror]', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const t = m.text();
      // device-loss / pipeline errors surface here long before a full crash
      if (/gpu|device|pipeline|buffer|shader|webgpu/i.test(t)) {
        errors.push(t);
        console.error(`[console.${m.type()}]`, t.slice(0, 500));
      }
    }
  });
  page.on('crash', () => {
    crashed = true;
    console.error('[CRASH] renderer process died');
  });

  // owner path: plain origin, zero params (run-rxgpu opens http://localhost:5173/)
  await page.goto(`${LAAS_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  check('boot plain / clean', bootErr === null, bootErr ?? '');
  if (bootErr) {
    await browser.close();
    process.exitCode = 1;
    return;
  }
  const settle = (n: number): Promise<void> =>
    page.evaluate(async (k) => {
      if (window.__laas.settle) await window.__laas.settle(k);
    }, n);

  await settle(30);
  await page.screenshot({ path: 'shots/wip/menu-ride-1-boot.png' });

  // open the menu the human way and pick DEMO
  await page.keyboard.press('o');
  await page.waitForSelector('#opt-panel.on', { timeout: 5_000 });
  await page.click('#opt-panel .opt-card:has-text("DEMO")');
  await settle(20);
  await page.screenshot({ path: 'shots/wip/menu-ride-2-demo.png' });

  // the owner's crashing click
  await page.click('#opt-panel .opt-card:has-text("GRAVEL")');
  await settle(40);
  const st1 = (await page.evaluate(
    `window.__laasDbg.ride ? window.__laasDbg.ride.state() : null`,
  )) as { mode: string; note: string | null } | null;
  console.log('after GRAVEL click:', JSON.stringify(st1));
  await page.screenshot({ path: 'shots/wip/menu-ride-3-gravel.png' });
  check('GRAVEL mounts via menu', st1?.mode === 'gravel', `mode=${st1?.mode} note=${st1?.note}`);

  // ride ~12 s of frames on DEMO power — the hang may come while riding
  for (let i = 0; i < 12 && !crashed; i++) await settle(60);
  const alive1 = await page
    .evaluate(() => navigator.gpu.requestAdapter().then((a) => a !== null))
    .catch(() => false);
  check('adapter alive after 12 s gravel ride', alive1 === true && !crashed, `crashed=${crashed}`);
  // the standing-start deadlock check: DEMO watts must actually MOVE the bike
  const st2 = (await page.evaluate(
    `window.__laasDbg.ride ? window.__laasDbg.ride.state() : null`,
  )) as { vMs: number; powerW: number } | null;
  check(
    'DEMO rides from a standstill',
    (st2?.vMs ?? 0) > 0.8 && (st2?.powerW ?? 0) > 50,
    `v=${st2?.vMs.toFixed(2)} m/s power=${Math.round(st2?.powerW ?? 0)} W`,
  );
  await page.screenshot({ path: 'shots/wip/menu-ride-5-riding.png' });

  // shake the tree: cycle modes through the same menu cards several times
  const seq = ['HIKE', 'GRAVEL', 'ROAD', 'MTB', 'HIKE', 'GRAVEL'];
  for (const label of seq) {
    if (crashed) break;
    const open = await page.evaluate(
      () => document.querySelector('#opt-panel.on') !== null,
    );
    if (!open) {
      await page.keyboard.press('o');
      await page.waitForSelector('#opt-panel.on', { timeout: 5_000 });
    }
    await page.click(`#opt-panel .opt-card:has-text("${label}")`);
    await settle(45);
    const st = (await page
      .evaluate(`window.__laasDbg.ride ? window.__laasDbg.ride.state() : null`)
      .catch(() => null)) as { mode: string; note: string | null } | null;
    console.log(`cycle ${label}:`, JSON.stringify(st));
  }
  await settle(60);
  await page.screenshot({ path: 'shots/wip/menu-ride-4-cycles.png' });

  const alive2 = await page
    .evaluate(() => navigator.gpu.requestAdapter().then((a) => a !== null))
    .catch(() => false);
  check('adapter alive after mode cycles', alive2 === true && !crashed, `crashed=${crashed}`);
  const gpuErrs = errors.filter((e) => /device|lost|pipeline|invalid/i.test(e));
  check('no device/pipeline errors logged', gpuErrs.length === 0, gpuErrs.slice(0, 3).join(' | '));

  await browser.close();
  console.log(pass ? 'ALL PASS' : 'FAILURES');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
