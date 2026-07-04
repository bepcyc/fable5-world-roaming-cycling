/**
 * Real-headed-Chrome crash probe. probe-menu-ride.ts drives the same menu
 * path but through Playwright's OWN headless-launched browser; that has been
 * reporting ALL PASS while the owner's real `just run-rxgpu` window (headed,
 * persistent ~/.cache/laas-chrome-profile, real display compositor) crashes
 * 100% of 100% on the same click. This probe instead CONNECTS via CDP to an
 * already-running real headed Chrome (launched exactly like run-rxgpu, plus
 * --remote-debugging-port so we can attach) so we exercise the actual path
 * that crashes instead of a synthetic stand-in.
 *
 * Usage:
 *   1) start the real dev server + real headed Chrome yourself (or let this
 *      probe assume they're already up) with a debug port, e.g.:
 *        google-chrome --user-data-dir="$HOME/.cache/laas-chrome-profile" \
 *          --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan \
 *          --enable-logging=stderr --remote-debugging-port=9333 \
 *          --new-window http://localhost:5173/
 *   2) CDP_PORT=9333 npx tsx tools/probe-real-crash.ts
 */
import { chromium } from 'playwright';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

const REAL_ORIGIN = process.env['REAL_ORIGIN'] ?? 'http://localhost:5173';

async function main(): Promise<void> {
  const port = process.env['CDP_PORT'] ?? '9333';
  console.log(`${ts()} connecting over CDP :${port} ...`);
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  browser.on('disconnected', () => console.log(`${ts()} [browser event] DISCONNECTED`));
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context found');
  ctx.on('close', () => console.log(`${ts()} [context event] CLOSE`));
  let page = ctx.pages()[0];
  if (!page) page = await ctx.waitForEvent('page');
  page.on('console', (m) => console.log(`${ts()} [console.${m.type()}] ${m.text().slice(0, 800)}`));
  page.on('pageerror', (e) => console.log(`${ts()} [pageerror] ${e.message}`));
  page.on('crash', () => console.log(`${ts()} [PAGE CRASH]`));
  page.on('close', () => console.log(`${ts()} [page event] CLOSE`));

  // trace every GPU resource creation so if the native process dies we still
  // have the last calls in the console log (which flushes before the crash).
  // Raw JS STRING, not a function ref — tsx/esbuild injects a `__name()` call
  // into compiled function bodies for name-preservation, which throws
  // ReferenceError in the isolated init-script realm (no closure access) and
  // silently kills the whole init script before any patching runs.
  await page.addInitScript({
    content: `
      (function () {
        function patch(ctorName, methods) {
          var ctor = window[ctorName];
          var proto = ctor && ctor.prototype;
          if (!proto) return;
          methods.forEach(function (m) {
            var orig = proto[m];
            if (typeof orig !== 'function') return;
            proto[m] = function () {
              try {
                var desc = arguments[0];
                var summary = JSON.stringify(desc, function (k, v) {
                  return typeof v === 'bigint' ? v.toString() : v;
                });
                console.log('[GPUTRACE] ' + ctorName + '.' + m + ' ' + (summary ? summary.slice(0, 260) : String(desc)));
              } catch (e) {
                console.log('[GPUTRACE] ' + ctorName + '.' + m + ' <unserializable> ' + e);
              }
              return orig.apply(this, arguments);
            };
          });
        }
        patch('GPUDevice', ['createBuffer', 'createTexture', 'createComputePipeline', 'createRenderPipeline', 'createBindGroupLayout', 'createSampler', 'createShaderModule', 'createView']);
        patch('GPUTexture', ['createView']);
        patch('GPUComputePassEncoder', ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);
        console.log('[GPUTRACE] instrumentation installed');
      })();
    `,
  });
  await page.goto(`${REAL_ORIGIN}/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

  console.log(`${ts()} waiting for __laas ready...`);
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 120_000, polling: 500 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  console.log(`${ts()} boot error: ${bootErr ?? 'none'}`);
  if (bootErr) {
    await browser.close().catch(() => undefined);
    return;
  }

  const settle = async (n: number): Promise<void> => {
    await page.evaluate(async (k) => {
      if (window.__laas.settle) await window.__laas.settle(k);
    }, n);
  };

  await settle(30);
  await page.screenshot({ path: 'shots/wip/real-crash-1-boot-hike.png' });
  console.log(`${ts()} screenshot 1 (hike boot) taken`);

  console.log(`${ts()} pressing O to open menu...`);
  await page.keyboard.press('o');
  await page.waitForSelector('#opt-panel.on', { timeout: 5_000 });
  await page.click('#opt-panel .opt-card:has-text("DEMO")');
  await settle(20);
  await page.screenshot({ path: 'shots/wip/real-crash-2-demo-selected.png' });
  console.log(`${ts()} screenshot 2 (DEMO selected) taken`);

  console.log(`${ts()} clicking GRAVEL — the owner's crashing click...`);
  await page.click('#opt-panel .opt-card:has-text("GRAVEL")');
  console.log(`${ts()} GRAVEL clicked, waiting/settling...`);

  // don't let one hung evaluate() hide a crash — race settle against a timeout
  for (let i = 0; i < 20; i++) {
    try {
      await Promise.race([
        settle(10),
        new Promise((_, rej) => setTimeout(() => rej(new Error('settle timeout')), 3000)),
      ]);
      const st = await page
        .evaluate(`window.__laasDbg && window.__laasDbg.ride ? window.__laasDbg.ride.state() : null`)
        .catch((e: unknown) => `EVAL ERR: ${String(e)}`);
      console.log(`${ts()} tick ${i}: ${JSON.stringify(st)}`);
    } catch (e) {
      console.log(`${ts()} tick ${i} FAILED: ${String(e)}`);
    }
  }

  try {
    await page.screenshot({ path: 'shots/wip/real-crash-3-after-gravel.png' });
    console.log(`${ts()} screenshot 3 (after gravel) taken`);
  } catch (e) {
    console.log(`${ts()} screenshot 3 FAILED: ${String(e)}`);
  }

  const alive = await page
    .evaluate(() => navigator.gpu.requestAdapter().then((a) => a !== null))
    .catch((e: unknown) => `EVAL ERR: ${String(e)}`);
  console.log(`${ts()} adapter alive check: ${JSON.stringify(alive)}`);
  if (alive !== true) {
    console.log(`${ts()} DEVICE DEAD after GRAVEL — stopping here`);
    return;
  }

  // owner also reported ROAD crashing — cycle through every mode via the
  // real menu, same as the owner would with repeated clicks
  for (const label of ['HIKE', 'ROAD', 'HIKE', 'MTB', 'GRAVEL']) {
    const open = await page.evaluate(() => document.querySelector('#opt-panel.on') !== null);
    if (!open) {
      await page.keyboard.press('o');
      await page.waitForSelector('#opt-panel.on', { timeout: 5_000 });
    }
    console.log(`${ts()} clicking ${label}...`);
    await page.click(`#opt-panel .opt-card:has-text("${label}")`);
    try {
      await Promise.race([
        settle(30),
        new Promise((_, rej) => setTimeout(() => rej(new Error('settle timeout')), 4000)),
      ]);
      const st = await page
        .evaluate(`window.__laasDbg && window.__laasDbg.ride ? window.__laasDbg.ride.state() : null`)
        .catch((e: unknown) => `EVAL ERR: ${String(e)}`);
      console.log(`${ts()} after ${label}: ${JSON.stringify(st)}`);
    } catch (e) {
      console.log(`${ts()} ${label} FAILED: ${String(e)}`);
    }
    const stillAlive = await page
      .evaluate(() => navigator.gpu.requestAdapter().then((a) => a !== null))
      .catch(() => false);
    console.log(`${ts()} adapter alive after ${label}: ${stillAlive}`);
    if (!stillAlive) {
      console.log(`${ts()} DEVICE DEAD after ${label} — stopping here`);
      return;
    }
  }

  await page.screenshot({ path: 'shots/wip/real-crash-4-all-modes-survived.png' });
  console.log(`${ts()} screenshot 4 (all modes survived) taken`);
  console.log(`${ts()} ALL PASS — done, leaving browser open for inspection`);
}

main().catch((e: unknown) => {
  console.error(`${ts()} FATAL:`, e);
  process.exitCode = 1;
});
