/**
 * Perf baseline — avg + 1% low fps per bookmark plus a moving (flythrough)
 * sample, from an in-page rAF sampler. Reproducible version of the session-0
 * scratchpad run behind docs/PERF-BASELINE.md.
 *
 * One boot, then bookmark jumps by key (world gen costs ~50 s on the fork's
 * dev box — see docs/notes/one-boot-many-probes.md); real-GPU adapter
 * asserted and printed next to the numbers; freeze=0 so the world moves like
 * gameplay. The sampler body is a STRING evaluate — tsx/esbuild injects a
 * __name helper around named fns in compiled evaluate callbacks.
 *
 * Usage:
 *   npx tsx tools/perf-baseline.ts [--w 3440] [--h 1440] [--bookmarks 1,2,3,4,7]
 *     [--ms 30000] [--movems 45000] [--seed 1] [--preset high]
 *     [--out shots/wip/perf-baseline.json] [--nofly]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from 'playwright';
import { launchWebGPUReal } from './launch-gpu';
import { LAAS_ORIGIN } from './launch';

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

interface SampleRow {
  label: string;
  frames: number;
  avgFps: number;
  low1Fps: number;
  p95Ms: number;
  worstMs: number;
  triangles: number;
  drawCalls: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const width = Number(str(args['w']) ?? 3440);
  const height = Number(str(args['h']) ?? 1440);
  const bookmarks = (str(args['bookmarks']) ?? '1,2,3,4,7').split(',').map((s) => s.trim());
  const sampleMs = Number(str(args['ms']) ?? 30_000);
  const moveMs = Number(str(args['movems']) ?? 45_000);
  const seed = Number(str(args['seed']) ?? 1);
  const preset = str(args['preset']);
  const outPath = str(args['out']) ?? `shots/wip/perf-baseline-${Date.now()}.json`;

  const { browser, info } = await launchWebGPUReal();
  console.log(`[perf-baseline] adapter ${info.vendor}/${info.architecture} @${width}x${height}`);

  const first = bookmarks[0] ?? '1';
  let url =
    `${LAAS_ORIGIN}/?scene=world&seed=${seed}&hud=0&freeze=0&shot=${first}`;
  if (preset) url += `&preset=${preset}`;

  const page: Page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 900_000, polling: 500 },
  );
  const error = await page.evaluate(() => window.__laas.error);
  if (error) throw new Error(`App reported fatal error:\n${error}`);
  const bootS = (Date.now() - t0) / 1000;
  console.log(`[perf-baseline] ready in ${bootS.toFixed(1)}s`);

  const settle = async (frames: number): Promise<void> => {
    await page.evaluate(
      async (n) => window.__laas.settle && (await window.__laas.settle(n)),
      frames,
    );
  };

  const rows: SampleRow[] = [];
  async function sample(label: string, ms: number): Promise<void> {
    const times = (await page.evaluate(`(() => new Promise((res) => {
      const t = [];
      let last = performance.now(); const t0 = last;
      requestAnimationFrame(function tick(now) {
        t.push(now - last); last = now;
        if (now - t0 < ${ms}) requestAnimationFrame(tick); else res(t);
      });
    }))()`)) as number[];
    const xs = times.slice(5).sort((a, b) => a - b);
    const n = xs.length;
    if (n === 0) throw new Error(`no frames sampled at ${label}`);
    const avgMs = xs.reduce((a, b) => a + b, 0) / n;
    const worst = xs.slice(Math.max(0, n - Math.max(1, Math.ceil(n / 100))));
    const worstAvg = worst.reduce((a, b) => a + b, 0) / worst.length;
    const stats = await page.evaluate(() => ({
      triangles: window.__laas.stats?.triangles ?? 0,
      drawCalls: window.__laas.stats?.drawCalls ?? 0,
    }));
    const row: SampleRow = {
      label,
      frames: n,
      avgFps: 1000 / avgMs,
      low1Fps: 1000 / worstAvg,
      p95Ms: xs[Math.floor(n * 0.95)] ?? 0,
      worstMs: xs[n - 1] ?? 0,
      triangles: stats.triangles,
      drawCalls: stats.drawCalls,
    };
    rows.push(row);
    console.log(
      `[sample] ${label}: avg ${row.avgFps.toFixed(1)} fps, 1%low ${row.low1Fps.toFixed(1)} fps, ` +
        `p95 ${row.p95Ms.toFixed(0)} ms, frames ${n}, tris ${row.triangles}`,
    );
  }

  for (let i = 0; i < bookmarks.length; i++) {
    const bm = bookmarks[i] as string;
    if (i > 0) await page.keyboard.press(bm);
    await settle(120);
    await sample(`bm${bm} ${width}x${height}${preset ? ` ${preset}` : ''}`, sampleMs);
  }
  if (args['nofly'] !== true) {
    await page.keyboard.press('f'); // flythrough ≈65 m/s — stress, NOT bike speed
    await settle(60);
    await sample(`flythrough ${width}x${height} (moving ~65 m/s)`, moveMs);
  }

  await browser.close();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ adapter: info, width, height, seed, preset: preset ?? 'high', bootS, rows }, null, 2),
  );
  console.log(`[perf-baseline] wrote ${outPath}`);
}

main().catch((e: unknown) => {
  console.error('[perf-baseline] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
