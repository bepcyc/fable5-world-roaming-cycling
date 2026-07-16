/**
 * Gate: far grass must read as grass, not a blue frost carpet (WARPLAN Front C
 * / gate 5). Boots the world at the exact baseline repro spot, shoots the far
 * and near pitch pair, and measures the bluish-pixel fraction in the far band
 * ROI (same metric as tools/measure-grass-blue.mjs / the main-thread baseline).
 *
 * PASS: far-band bluish < 3.0 %, near-band bluish < 0.05 %.
 * Exits non-zero on any fail. Honours LAAS_PORT (see launch-gpu.ts).
 *
 * Usage: LAAS_PORT=5181 npx tsx tools/gate-grass-blue.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { laasUrl } from './launch';
import { launchWebGPUReal as launchWebGPU } from './launch-gpu';

// bluish-pixel fraction in a horizontal band ROI — same metric as
// tools/measure-grass-blue.mjs and the main-thread baseline: hue 185..255,
// sat >= 0.10, value >= 0.45, over rows 3%..33% of the frame.
async function measureBlue(
  imgPath: string,
  topFrac = 0.03,
  botFrac = 0.33,
): Promise<{ bluePct: number; blue: number; total: number }> {
  const { data, info } = await sharp(imgPath).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const y0 = Math.round(height * topFrac);
  const y1 = Math.round(height * botFrac);
  let blue = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = (data[idx] ?? 0) / 255;
      const g = (data[idx + 1] ?? 0) / 255;
      const b = (data[idx + 2] ?? 0) / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const d = mx - mn;
      let h = 0;
      if (d !== 0) {
        if (mx === r) h = 60 * (((g - b) / d) % 6);
        else if (mx === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
      }
      if (h < 0) h += 360;
      const s = mx === 0 ? 0 : d / mx;
      total++;
      if (h >= 185 && h <= 255 && s >= 0.1 && mx >= 0.45) blue++;
    }
  }
  return { bluePct: total ? (100 * blue) / total : 0, blue, total };
}

interface Probe {
  name: string;
  cam: string;
  limit: number; // max allowed bluePct
}

const SPOT = '-1114.14,173.68,1121.58';
const YAW = '-1.5808';
const FOV = '55';
const PROBES: Probe[] = [
  { name: 'far', cam: `${SPOT},${YAW},-0.06,${FOV}`, limit: 3.0 },
  { name: 'near', cam: `${SPOT},${YAW},-0.75,${FOV}`, limit: 0.05 },
];

async function main(): Promise<void> {
  const W = 1920;
  const H = 1080;
  const dir = mkdtempSync(join(tmpdir(), 'gate-grass-blue-'));
  const { browser } = await launchWebGPU();
  let failed = false;
  try {
    for (const p of PROBES) {
      const page = await browser.newPage({
        viewport: { width: W, height: H },
        deviceScaleFactor: 1,
      });
      const url = laasUrl({ scene: 'world', seed: 1, T: 14, cam: p.cam, width: W, height: H });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page
        .waitForFunction(
          () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
          undefined,
          { timeout: 300000, polling: 250 },
        )
        .catch(() => {
          throw new Error(`[${p.name}] timed out waiting for ready`);
        });
      const err = await page.evaluate(() => window.__laas.error);
      if (err) throw new Error(`[${p.name}] app fatal: ${err}`);
      await page.evaluate(
        async (f) => window.__laas.settle && (await window.__laas.settle(f)),
        24,
      );
      const shot = join(dir, `${p.name}.png`);
      await page.screenshot({ path: shot });
      await page.close();
      const r = await measureBlue(shot);
      const ok = r.bluePct < p.limit;
      if (!ok) failed = true;
      console.log(
        `[gate-grass-blue] ${p.name}: bluePct=${r.bluePct.toFixed(3)}% ` +
          `(limit ${p.limit}%) -> ${ok ? 'PASS' : 'FAIL'}`,
      );
    }
  } finally {
    await browser.close();
  }
  if (failed) {
    console.error('[gate-grass-blue] RED — far grass reads blue');
    process.exit(1);
  }
  console.log('[gate-grass-blue] GREEN');
}

main().catch((e: unknown) => {
  console.error('[gate-grass-blue] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
