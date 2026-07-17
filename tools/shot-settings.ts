/**
 * Screenshot every tab of the graphics SettingsMenu (Phase 5 proof).
 *
 * Boots the world (bypass splash via webdriver), opens the settings screen
 * through hooks.openGraphicsSettings, enables advanced mode, then clicks
 * through the tab rail and screenshots each pane.
 *
 * Usage: LAAS_PORT=5182 npx tsx tools/shot-settings.ts [--preset min] [--lang ru]
 */

import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { launchWebGPUReal, LAAS_ORIGIN } from './launch-gpu';

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = true;
    }
  }
  return out;
}

const TABS = ['display', 'vegetation', 'shadows', 'atmosphere', 'effects', 'world'];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const preset = typeof args['preset'] === 'string' ? args['preset'] : 'min';
  const lang = typeof args['lang'] === 'string' ? args['lang'] : 'en';
  const { browser } = await launchWebGPUReal({});
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const url = `${LAAS_ORIGIN}/?scene=world&seed=1&preset=${preset}&dpr=0.6&T=14&lang=${lang}`;
  console.log(`[shot-settings] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 900_000, polling: 500 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);
  mkdirSync('shots/wip', { recursive: true });

  // open the settings sheet
  await page.evaluate(() => {
    (window.__laas as unknown as { openGraphicsSettings?: () => void }).openGraphicsSettings?.();
  });
  await page.waitForSelector('#qset.on', { timeout: 10_000 });

  // force advanced mode ON so every tab is reachable
  const advOn = await page.evaluate(() => {
    const adv = document.querySelector('.qset-adv');
    if (adv && !adv.classList.contains('on')) (adv as HTMLElement).click();
    return document.querySelector('.qset-adv')?.classList.contains('on') ?? false;
  });
  console.log(`[shot-settings] advanced mode: ${advOn}`);

  for (const tab of TABS) {
    const clicked = await page.evaluate((name) => {
      const btns = [...document.querySelectorAll('.qset-tab')] as HTMLElement[];
      const hit = btns.find((b) => b.style.display !== 'none' && b.dataset['tab'] === name);
      if (hit) {
        hit.click();
        return true;
      }
      // fallback: click by index order (tabs render in TAB_ORDER)
      const visible = btns.filter((b) => b.style.display !== 'none');
      const idx = ['display', 'vegetation', 'shadows', 'atmosphere', 'effects', 'world'].indexOf(name);
      const el = visible[idx];
      if (el) {
        el.click();
        return true;
      }
      return false;
    }, tab);
    if (!clicked) {
      console.warn(`[shot-settings] tab ${tab} not clickable`);
      continue;
    }
    await page.waitForTimeout(250);
    const path = `shots/wip/settings-${lang}-${tab}.png`;
    await page.screenshot({ path });
    console.log(`[shot-settings] wrote ${path}`);
  }
  await browser.close();
}

main().catch((e: unknown) => {
  console.error('[shot-settings] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
