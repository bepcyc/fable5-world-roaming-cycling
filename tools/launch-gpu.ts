/**
 * GPU-asserting Playwright launcher — Linux/NixOS aware (Mac fallback kept).
 *
 * tools/launch.ts predates Linux: its recipes rely on the Playwright-bundled
 * Chromium (`channel:'chromium'`), which does not even start on NixOS (FHS
 * dynamic linking), and headless Linux Chrome silently substitutes the
 * SwiftShader CPU rasterizer unless `--use-angle=vulkan` is present — a
 * poisoned adapter that looks alive. This launcher probes system-browser
 * `executablePath` recipes with the Vulkan flag set, VERIFIES the adapter is
 * a real GPU (rejects swiftshader/llvmpipe), caches the winner, and returns
 * the adapter identity so callers can print it next to their measurements.
 * Requires the dev server on :5173 (secure-context probe, as launch.ts).
 * Binary override: CHROME_BIN=/path/to/chrome.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';

/** Claude-tooling dev server origin. 5174 by default: the OWNER runs
 *  his own vite on 5173 (LAN/tablet flow) — tooling must never squat
 *  on it. Override with LAAS_PORT. */
export const LAAS_ORIGIN = `http://localhost:${process.env['LAAS_PORT'] ?? '5174'}`;

export interface AdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

interface GpuRecipe {
  headless: boolean;
  executablePath?: string;
  channel?: string;
  args: string[];
}

// NO --use-angle=vulkan: WebGPU runs on Dawn's own Vulkan backend, never
// through ANGLE. Adding it opens a second, uncoordinated Vulkan client
// (ANGLE's GL-on-Vulkan) against the same GPU, which native-crashes the GPU
// process (SIGFPE) under real (headed, on-screen) presentation — invisible
// here since this launcher is headless, but matches the real `run-rxgpu`
// crash 1:1 (see Justfile run-rxgpu, tools/probe-real-crash.ts).
const LINUX_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan'];
const USER = process.env['USER'] ?? '';
const BIN_CANDIDATES = [
  process.env['CHROME_BIN'],
  `/etc/profiles/per-user/${USER}/bin/google-chrome`, // NixOS per-user profile
  `/etc/profiles/per-user/${USER}/bin/chromium`,
  '/run/current-system/sw/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/opt/google/chrome/chrome',
].filter((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p));

const CANDIDATES: GpuRecipe[] = [
  // Linux: system browser headless with the full Vulkan flag set
  ...BIN_CANDIDATES.map((p) => ({ headless: true, executablePath: p, args: LINUX_FLAGS })),
  // Headless-only ANGLE fallback: without a display, Chrome's native path
  // yields SwiftShader on some boxes (RX 6800/RDNA-2, flag matrix verified
  // 2026-07-04: unsafe+vulkan → swiftshader; +--use-angle=vulkan → amd/rdna-2).
  // HEADLESS ONLY — under real headed presentation this flag is the SIGFPE
  // GPU-process crash (see the LINUX_FLAGS comment above); never add it to
  // the headed candidates below.
  ...BIN_CANDIDATES.map((p) => ({
    headless: true,
    executablePath: p,
    args: [...LINUX_FLAGS, '--use-angle=vulkan'],
  })),
  // Mac (upstream): bundled Chromium exposes a Metal adapter out of the box
  { headless: true, channel: 'chromium', args: [] },
  { headless: true, channel: 'chromium', args: ['--enable-unsafe-webgpu'] },
  // last resort: headed system browser (Wayland)
  ...BIN_CANDIDATES.map((p) => ({
    headless: false,
    executablePath: p,
    args: [...LINUX_FLAGS, '--ozone-platform=wayland'],
  })),
];

const CACHE_PATH = '.cache/webgpu-gpu-recipe.json';
const PROBE_BASE = `${LAAS_ORIGIN}`;

function isRealGpu(info: AdapterInfo): boolean {
  return info.architecture !== 'swiftshader' && !/llvmpipe|swiftshader/i.test(info.description);
}

async function probeRecipe(
  recipe: GpuRecipe,
): Promise<{ browser: Browser; info: AdapterInfo } | null> {
  let browser: Browser | null = null;
  try {
    const opts: Parameters<typeof chromium.launch>[0] = {
      headless: recipe.headless,
      args: recipe.args,
    };
    if (recipe.executablePath) opts.executablePath = recipe.executablePath;
    if (recipe.channel) opts.channel = recipe.channel;
    browser = await chromium.launch(opts);
    const page = await browser.newPage();
    await page.goto(`${PROBE_BASE}/__webgpu_probe__`, { waitUntil: 'domcontentloaded' });
    const info = (await page.evaluate(async () => {
      const gpu = (
        navigator as Navigator & {
          gpu?: { requestAdapter(o?: object): Promise<unknown> };
        }
      ).gpu;
      if (!gpu) return null;
      const adapter = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) as {
        info?: Record<string, string | undefined>;
      } | null;
      const i = adapter?.info;
      if (!i) return null;
      return {
        vendor: i['vendor'] ?? '',
        architecture: i['architecture'] ?? '',
        device: i['device'] ?? '',
        description: i['description'] ?? '',
      };
    })) as AdapterInfo | null;
    await page.close();
    if (info && isRealGpu(info)) return { browser, info };
    await browser.close();
    return null;
  } catch {
    if (browser) await browser.close().catch(() => undefined);
    return null;
  }
}

/** Launch a browser whose WebGPU adapter is a REAL GPU; throw otherwise. */
export async function launchWebGPUReal(): Promise<{
  browser: Browser;
  info: AdapterInfo;
  recipe: GpuRecipe;
}> {
  try {
    const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as GpuRecipe;
    const hit = await probeRecipe(cached);
    if (hit) return { ...hit, recipe: cached };
  } catch {
    /* no cache yet */
  }
  for (const recipe of CANDIDATES) {
    const hit = await probeRecipe(recipe);
    if (hit) {
      mkdirSync('.cache', { recursive: true });
      writeFileSync(CACHE_PATH, JSON.stringify(recipe, null, 2));
      console.log(
        `[launch-gpu] adapter ${hit.info.vendor}/${hit.info.architecture} — headless=${recipe.headless} ` +
          `exe=${recipe.executablePath ?? recipe.channel ?? 'default'} args=[${recipe.args.join(' ')}]`,
      );
      return { ...hit, recipe };
    }
  }
  throw new Error(
    'No launch recipe produced a REAL WebGPU adapter (SwiftShader/llvmpipe rejected). ' +
      'Dev server must run on :5173. On Linux the working set is a system Chrome via ' +
      'executablePath + --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan ' +
      '(see docs/notes/nixos-webgpu-launch-recipe.md); override the binary with CHROME_BIN.',
  );
}
