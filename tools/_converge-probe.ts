/**
 * Convergence probe: does drawCalls plateau at the fixed spot, and when?
 * The skill claims 727 = converged, but identical 60 s-warmup runs produced
 * 727 and 995. Sample the curve instead of guessing.
 */
import { launchWebGPUReal, LAAS_ORIGIN } from './launch-gpu';
import type { Page } from 'playwright';

const SPOT_CAM = '-870,182.7,862,1.69,0.1';

async function main(): Promise<void> {
  const { browser, info } = await launchWebGPUReal({
    extraArgs: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-features=CalculateNativeWinOcclusion'],
  });
  console.log(`adapter ${info.vendor}/${info.architecture}`);
  const url = `${LAAS_ORIGIN}/?scene=world&seed=1&hud=0&freeze=0&preset=min&dpr=0.6&T=14&cam=${SPOT_CAM}`;
  const page: Page = await browser.newPage({ viewport: { width: 1000, height: 448 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__laas && (window.__laas.ready || window.__laas.error !== null), undefined, {
    timeout: 900_000,
    polling: 500,
  });
  const [cx, cy, cz, cyaw, cpitch] = SPOT_CAM.split(',').map(Number) as number[];
  await page.evaluate((pose) => window.__laas.setPose?.(pose as never), { p: [cx, cy, cz], yaw: cyaw, pitch: cpitch });
  console.log('t_s,drawCalls,triangles,fps');
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => ({
      d: window.__laas.stats?.drawCalls ?? 0,
      t: window.__laas.stats?.triangles ?? 0,
      f: window.__laas.stats?.fps ?? 0,
    }));
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)},${s.d},${s.t},${s.f.toFixed(1)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  await browser.close();
}
main().catch((e: unknown) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
