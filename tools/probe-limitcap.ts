/**
 * Mobile-limits probe — the owner's tablet repro (`?limitcap=mobile` caps
 * diag.limits to the WebGPU baseline: maxStorageBuffersPerShaderStage=8).
 * The known bug: some compute stage binds 9 storage buffers → invalid
 * pipeline cascade → grass vanishes / device loss on real tablets.
 *
 * PASS = boots clean with zero pipeline/validation errors under the caps.
 *
 * Usage: LAAS_PORT=5174 npx tsx tools/probe-limitcap.ts
 */

import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';

async function main(): Promise<void> {
  const { browser } = await launchWebGPUReal();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.text().startsWith('[BINDPROBE]')) console.log(m.text().slice(0, 900));
  });
  // name the offenders: log every bind-group layout that exceeds 8 storage
  // buffers together with a snippet of the most recent WGSL module (its
  // buffer names identify the TSL kernel — labels are empty in three)
  await page.addInitScript(() => {
    const g = window as unknown as { GPUDevice?: { prototype: unknown } };
    const proto = g.GPUDevice?.prototype as {
      createShaderModule?: (d: { code?: string }) => unknown;
      createBindGroupLayout?: (d: {
        entries?: { buffer?: { type?: string } }[];
      }) => unknown;
    };
    if (!proto?.createShaderModule || !proto.createBindGroupLayout) return;
    let lastCode = '';
    const csm = proto.createShaderModule;
    proto.createShaderModule = function (d: { code?: string }) {
      lastCode = d?.code ?? '';
      return csm.call(this, d);
    };
    const cbgl = proto.createBindGroupLayout;
    proto.createBindGroupLayout = function (d: {
      entries?: { buffer?: { type?: string } }[];
    }) {
      const n = (d?.entries ?? []).filter(
        (e) => e.buffer && e.buffer.type !== 'uniform',
      ).length;
      if (n > 8) {
        const names = [...lastCode.matchAll(/var<storage[^>]*>\s*(\w+)/g)]
          .map((m) => m[1])
          .join(',');
        console.warn(`[BINDPROBE] storage=${n} buffers: ${names || lastCode.slice(0, 220)}`);
      }
      return cbgl.call(this, d);
    };
  });

  await page.goto(
    `${LAAS_ORIGIN}/?scene=world&seed=1&T=11&preset=high&limitcap=mobile`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  await page.evaluate(async () => {
    if (window.__laas.settle) await window.__laas.settle(120);
  });
  await page.screenshot({ path: 'shots/wip/limitcap-mobile.png' });
  await browser.close();

  const pipeErrs = errors.filter((e) =>
    /storage buffer|pipeline|validation|exceeds|invalid/i.test(e),
  );
  const uniq = [...new Set(pipeErrs.map((e) => e.slice(0, 400)))];
  console.log(`boot error: ${bootErr ?? 'none'}`);
  console.log(`console errors: ${errors.length}, pipeline/validation: ${pipeErrs.length}`);
  for (const e of uniq.slice(0, 12)) console.log('---\n' + e);
  const pass = bootErr === null && pipeErrs.length === 0;
  console.log(pass ? 'ALL PASS' : 'FAILURES');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
