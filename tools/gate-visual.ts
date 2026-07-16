/**
 * Visual regression gate runner (WARPLAN_BLACK_ROADS_GRASS "never again"
 * gates, front F owns the runner). Boots the app once per check frame and
 * exits non-zero on any fail.
 *
 * Checks:
 *   black-veg      p7 + p4 world cams, ROI = bottom 40% of the frame,
 *                  near-black (max channel <= 22) fraction < 0.25%.
 *   stand-solid    gallery ?flowerdbg=solid: near-black fraction < 0.4%
 *                  outside the text plaques (rows 12%..97%).
 *   ablate-sanity  every ?ablate key renders a live frame (mean luminance
 *                  > 0.02) — catches output-wiring kills like the bloom one.
 *   flower-frost   frost cam far band (rows 3%..33%) bluish < 3%.
 *   palette-exact  spot1 ?surfdbg=1&dbgexact=1: >= 60% of pixels sit within
 *                  +-4/255 of a linearToSrgb8(SURF_COL) palette constant.
 *   grass-blue     delegates to tools/gate-grass-blue.ts (own boots).
 *
 * Usage:
 *   LAAS_PORT=5185 npx tsx tools/gate-visual.ts [--only a,b,...] [--keep]
 *   --only black-veg,ablate-sanity   run a subset
 *   --keep                           keep shot PNGs (default: temp dir)
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { laasUrl } from './launch';
import { launchWebGPUReal as launchWebGPU } from './launch-gpu';
import { SURF_COL, linearToSrgb8 } from '../src/debug/DebugPalette';

interface Shot {
  scene: string;
  seed?: number;
  T?: number;
  cam?: string;
  extra?: Record<string, string>;
}

const W = 1920;
const H = 1080;

const P7_CAM = '-342.36,271.38,120.51,1.1708,-0.7494,55';
const P4_CAM = '-686.00,257.52,477.08,1.5671,-0.7798,55';
const FROST_CAM = '-1114.14,173.68,1121.58,-1.5808,-0.0600,55';
const SPOT1_CAM = '-685,330,557,0,-1.45,55';

const ABLATE_KEYS = [
  'ao', 'bounce', 'contact', 'taa', 'mblur', 'bloom', 'clouds', 'aerial', 'grade',
] as const;

interface Pixels {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function readPixels(path: string): Promise<Pixels> {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** fps chip (top-left) and gear button (bottom-right) — never judged */
function isHud(x: number, y: number, w: number, h: number): boolean {
  return (x < 120 && y < 40) || (x > w - 90 && y > h - 90);
}

function blackPct(px: Pixels, y0f: number, y1f: number, vMax = 22): number {
  const y0 = Math.round(px.height * y0f);
  const y1 = Math.round(px.height * y1f);
  let black = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < px.width; x++) {
      if (isHud(x, y, px.width, px.height)) continue;
      const o = (y * px.width + x) * px.channels;
      total++;
      if (
        (px.data[o] ?? 255) <= vMax &&
        (px.data[o + 1] ?? 255) <= vMax &&
        (px.data[o + 2] ?? 255) <= vMax
      ) {
        black++;
      }
    }
  }
  return total ? (100 * black) / total : 0;
}

function meanLum(px: Pixels): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < px.height; y += 2) {
    for (let x = 0; x < px.width; x += 2) {
      if (isHud(x, y, px.width, px.height)) continue;
      const o = (y * px.width + x) * px.channels;
      const r = (px.data[o] ?? 0) / 255;
      const g = (px.data[o + 1] ?? 0) / 255;
      const b = (px.data[o + 2] ?? 0) / 255;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function bluePct(px: Pixels, y0f: number, y1f: number): number {
  const y0 = Math.round(px.height * y0f);
  const y1 = Math.round(px.height * y1f);
  let blue = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < px.width; x++) {
      const o = (y * px.width + x) * px.channels;
      const r = (px.data[o] ?? 0) / 255;
      const g = (px.data[o + 1] ?? 0) / 255;
      const b = (px.data[o + 2] ?? 0) / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const d = mx - mn;
      let hDeg = 0;
      if (d !== 0) {
        if (mx === r) hDeg = 60 * (((g - b) / d) % 6);
        else if (mx === g) hDeg = 60 * ((b - r) / d + 2);
        else hDeg = 60 * ((r - g) / d + 4);
      }
      if (hDeg < 0) hDeg += 360;
      const s = mx === 0 ? 0 : d / mx;
      total++;
      if (hDeg >= 185 && hDeg <= 255 && s >= 0.1 && mx >= 0.45) blue++;
    }
  }
  return total ? (100 * blue) / total : 0;
}

/** fraction of pixels within +-tol of any SURF_COL palette constant */
function paletteMatchPct(px: Pixels, tol = 4): number {
  const palette = Object.values(SURF_COL).map((c) => linearToSrgb8(c));
  let match = 0;
  let total = 0;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (isHud(x, y, px.width, px.height)) continue;
      const o = (y * px.width + x) * px.channels;
      const r = px.data[o] ?? 0;
      const g = px.data[o + 1] ?? 0;
      const b = px.data[o + 2] ?? 0;
      total++;
      for (const [pr, pg, pb] of palette) {
        if (Math.abs(r - pr) <= tol && Math.abs(g - pg) <= tol && Math.abs(b - pb) <= tol) {
          match++;
          break;
        }
      }
    }
  }
  return total ? (100 * match) / total : 0;
}

interface Check {
  name: string;
  run: (shoot: (name: string, s: Shot) => Promise<string>) => Promise<string[]>;
}

const failures: string[] = [];
function judge(name: string, detail: string, ok: boolean): string {
  const line = `[gate-visual] ${name}: ${detail} -> ${ok ? 'PASS' : 'FAIL'}`;
  console.log(line);
  if (!ok) failures.push(line);
  return line;
}

const CHECKS: Check[] = [
  {
    name: 'black-veg',
    run: async (shoot) => {
      const out: string[] = [];
      for (const [label, cam] of [['p7', P7_CAM], ['p4', P4_CAM]] as const) {
        const png = await shoot(`black-veg-${label}`, {
          scene: 'world', seed: 1, T: 14, cam,
        });
        const px = await readPixels(png);
        const pct = blackPct(px, 0.6, 1.0);
        out.push(judge('black-veg', `${label} bottom-40% blackPct=${pct.toFixed(3)}% (limit 0.25%)`, pct < 0.25));
      }
      return out;
    },
  },
  {
    name: 'stand-solid',
    run: async (shoot) => {
      const png = await shoot('stand-solid', {
        scene: 'gallery', T: 14, extra: { flowerdbg: 'solid' },
      });
      const px = await readPixels(png);
      const pct = blackPct(px, 0.12, 0.97);
      return [judge('stand-solid', `blackPct=${pct.toFixed(3)}% (limit 0.4%)`, pct < 0.4)];
    },
  },
  {
    name: 'ablate-sanity',
    run: async (shoot) => {
      const out: string[] = [];
      for (const key of ABLATE_KEYS) {
        const png = await shoot(`ablate-${key}`, {
          scene: 'world', seed: 1, T: 14, cam: P7_CAM, extra: { ablate: key },
        });
        const px = await readPixels(png);
        const lum = meanLum(px);
        out.push(judge('ablate-sanity', `${key} meanLum=${lum.toFixed(4)} (min 0.02)`, lum > 0.02));
      }
      return out;
    },
  },
  {
    name: 'flower-frost',
    run: async (shoot) => {
      const png = await shoot('flower-frost', {
        scene: 'world', seed: 1, T: 14, cam: FROST_CAM,
      });
      const px = await readPixels(png);
      const pct = bluePct(px, 0.03, 0.33);
      return [judge('flower-frost', `far-band bluePct=${pct.toFixed(3)}% (limit 3%)`, pct < 3)];
    },
  },
  {
    name: 'palette-exact',
    run: async (shoot) => {
      const png = await shoot('palette-exact', {
        scene: 'world', seed: 1, T: 14, cam: SPOT1_CAM,
        extra: { surfdbg: '1', dbgexact: '1' },
      });
      const px = await readPixels(png);
      const pct = paletteMatchPct(px);
      return [judge('palette-exact', `palette-match=${pct.toFixed(2)}% (min 60%)`, pct >= 60)];
    },
  },
  {
    name: 'grass-blue',
    run: async () => {
      // delegated gate: separate boots, honours the same LAAS_PORT
      const r = spawnSync('npx', ['tsx', 'tools/gate-grass-blue.ts'], {
        stdio: 'inherit',
        timeout: 20 * 60 * 1000,
      });
      return [judge('grass-blue', `exit=${r.status ?? 'timeout'}`, r.status === 0)];
    },
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? '').split(',')) : null;
  const keep = args.includes('--keep');
  const dir = keep
    ? (mkdirSync('shots/wip/gate-visual', { recursive: true }), 'shots/wip/gate-visual')
    : mkdtempSync(join(tmpdir(), 'gate-visual-'));

  const checks = CHECKS.filter((c) => !only || only.has(c.name));
  if (checks.length === 0) {
    console.error('[gate-visual] no checks selected');
    process.exit(2);
  }

  const needsBrowser = checks.some((c) => c.name !== 'grass-blue');
  const browser = needsBrowser ? (await launchWebGPU()).browser : null;

  const shoot = async (name: string, s: Shot): Promise<string> => {
    if (!browser) throw new Error('browser not launched');
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
    });
    const url = laasUrl({
      scene: s.scene,
      seed: s.seed,
      T: s.T,
      cam: s.cam,
      extra: s.extra,
    });
    console.log(`[gate-visual] shoot ${name}: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction(
        () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
        undefined,
        { timeout: 180000, polling: 250 },
      )
      .catch(() => {
        throw new Error(`[${name}] timed out waiting for ready`);
      });
    const err = await page.evaluate(() => window.__laas.error);
    if (err) throw new Error(`[${name}] app fatal: ${err}`);
    await page.evaluate(
      async (f) => window.__laas.settle && (await window.__laas.settle(f)),
      24,
    );
    const png = join(dir, `${name}.png`);
    await page.screenshot({ path: png });
    await page.close();
    return png;
  };

  try {
    for (const c of checks) {
      await c.run(shoot);
    }
  } finally {
    if (browser) await browser.close();
  }

  if (failures.length > 0) {
    console.error(`[gate-visual] RED — ${failures.length} check(s) failed:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log('[gate-visual] GREEN — all checks passed');
}

main().catch((e: unknown) => {
  console.error('[gate-visual] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
