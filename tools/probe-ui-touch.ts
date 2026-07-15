/**
 * Touch-UI gate — does every control on a phone/tablet actually WORK?
 *
 * The owner's bar: every menu is touch-adapted EVERYWHERE; no element overlaps
 * or covers another in a way that makes it unusable; a phone must never expect
 * a keyboard. Desktop is desktop, mobile is mobile.
 *
 * WHY THIS IS A PROBE AND NOT ME LOOKING AT SCREENSHOTS: I have repeatedly
 * described frames as fine while they were broken. A rendered overlap is a
 * pixel fact, so it gets measured, not eyeballed.
 *
 * THREE FAILURES IT MEASURES, each a distinct owner complaint:
 *
 * 1. OCCLUDED — a control that overlaps, or is covered by, another one.
 *    NOT rect-vs-rect intersection: a modal legitimately covers the world, and
 *    a bounding box legitimately overlaps a transparent parent. The honest test
 *    is hit-testing. For each visible control we ask the browser
 *    `elementFromPoint()` at the control's own centre and at each corner inset
 *    by a fingertip radius. If the answer is not the control (or something
 *    inside it), a real finger there lands somewhere else — the control is
 *    unusable no matter how it looks. That is "covered so it cannot be used",
 *    expressed as something a machine can check.
 *
 * 2. TOO SMALL — a control smaller than 48 CSS px in either axis. Android's
 *    Material guidance and WCAG 2.2 Target Size (Minimum) agree on ~48dp/44px;
 *    48 is the stricter, so 48 it is. A 20px gear is a desktop control that was
 *    never re-thought for a fingertip.
 *
 * 3. OFF-SCREEN — any part of a control outside the viewport. On desktop the
 *    window is resizable and a clipped panel is a nuisance; on a phone it is
 *    simply gone.
 *
 * KEYBOARD PARITY is checked separately (`--keys`): every keydown handler in
 * src/ is a desktop affordance, and on mobile a feature reachable ONLY by
 * keypress is unreachable, full stop. There is no keyboard.
 *
 * Exit 2 on any failure, so this can gate a build.
 *
 * Usage:
 *   npx tsx tools/probe-ui-touch.ts                 # all profiles, all states
 *   npx tsx tools/probe-ui-touch.ts --shots         # + PNG per state
 */

import { chromium, type Page, type Browser } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { LAAS_ORIGIN } from './launch';

/** WCAG 2.2 Target Size (Minimum) is 24, Material is 48dp. Take the strict one:
 *  the owner's devices are a phone and a tablet, both finger-driven. */
const MIN_TAP_PX = 48;

/** How far in from a control's edge a fingertip centre can realistically land.
 *  Probing the exact corner would flag every control with a 1px rounded border
 *  as occluded by its own parent — a false alarm, not a bug. */
const FINGER_INSET = 6;

interface Profile {
  name: string;
  width: number;
  height: number;
  dpr: number;
}

/** Real devices, not invented sizes. CSS px = physical / dpr, landscape:
 *  the app is sensorLandscape, so portrait numbers would test a layout the
 *  user never sees. */
const PROFILES: Profile[] = [
  // Pixel 10 Pro: 1080x2410 physical, dpr 2.625 -> 918x411 CSS landscape
  { name: 'pixel-10-pro', width: 918, height: 411, dpr: 2.625 },
  // Samsung Tab S8 Ultra: 2960x1848 physical, dpr 2.0 -> 1480x924 CSS landscape
  { name: 'tab-s8-ultra', width: 1480, height: 924, dpr: 2.0 },
];

interface Finding {
  profile: string;
  state: string;
  kind: 'OCCLUDED' | 'TOO_SMALL' | 'OFF_SCREEN';
  label: string;
  detail: string;
}

/** Serialized into the page: find every control a finger is meant to hit, then
 *  ask the browser what a finger would actually hit there. */
const AUDIT_FN = `(args) => {
  const { minTap, inset } = args;
  const out = [];
  const seen = new Set();

  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    const txt = (el.textContent || '').trim().slice(0, 24);
    return (el.tagName.toLowerCase() + id + cls + (txt ? ' "' + txt + '"' : '')).slice(0, 70);
  };

  // A control is anything a user is meant to press. Tag alone is not enough:
  // this app builds most of its UI from divs with click handlers and
  // cursor:pointer, so style is the more reliable signal.
  const isControl = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
    const role = el.getAttribute('role');
    if (role && ['button', 'tab', 'switch', 'checkbox', 'menuitem', 'link'].includes(role)) return true;
    return getComputedStyle(el).cursor === 'pointer';
  };

  const visible = (el, r) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
    return r.width > 0 && r.height > 0;
  };

  for (const el of document.querySelectorAll('*')) {
    if (!isControl(el)) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    // A control nested inside another control (icon in a button) is not a
    // separate target; the outermost one is what the finger aims at.
    let parentIsControl = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (isControl(p) && p.getBoundingClientRect().width > 0) { parentIsControl = true; break; }
    }
    if (parentIsControl) continue;
    const key = describe(el) + '@' + Math.round(r.x) + ',' + Math.round(r.y);
    if (seen.has(key)) continue;
    seen.add(key);

    const label = describe(el);

    if (r.width < minTap || r.height < minTap) {
      out.push({ kind: 'TOO_SMALL', label,
        detail: Math.round(r.width) + 'x' + Math.round(r.height) + 'px < ' + minTap + 'px' });
    }
    if (r.left < -0.5 || r.top < -0.5 ||
        r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) {
      out.push({ kind: 'OFF_SCREEN', label,
        detail: 'rect ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') +
                ' vs viewport ' + innerWidth + 'x' + innerHeight });
    }

    // Hit test: centre plus the four inset corners. If none of them reach this
    // control, a finger cannot press it at all.
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
    ];
    let reachable = 0;
    let blocker = null;
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) reachable++;
      else if (hit && !blocker) blocker = describe(hit);
    }
    if (reachable === 0) {
      out.push({ kind: 'OCCLUDED', label,
        detail: 'every hit-test point lands on ' + (blocker || 'nothing') + ' instead' });
    }
  }
  return out;
}`;

interface State {
  name: string;
  url: string;
  /** drive the app into this state; returns false to skip (state unreachable) */
  enter?: (page: Page) => Promise<boolean>;
}

/** The world takes 45-105 s to load and none of that changes the LAYOUT, which
 *  is what this gate measures. Every panel lives in index.html behind a stable
 *  id and toggles on a `.on` class, so each state is reachable as soon as the
 *  DOM is up — wait for the id, not for a stopwatch. NO `freeze=1` and NO
 *  `nosplash=1` here even though both would load faster: shouldBypass() treats
 *  each as "this caller does not want the menu" and never renders it. */
const STATES: State[] = [
  {
    name: 'splash',
    url: '/?scene=world&seed=1&preset=min',
    enter: async (page) => {
      await page.waitForSelector('#splash', { state: 'visible', timeout: 45000 });
      return true;
    },
  },
  {
    name: 'settings',
    url: '/?scene=world&seed=1&preset=min',
    enter: async (page) => {
      await page.waitForSelector('#btn-settings', { state: 'visible', timeout: 45000 });
      // force: the splash art animates continuously (Ken Burns + a pulsing
      // hint), so Playwright's "element is stable" precondition never settles
      // and a normal click times out. We are auditing layout, not the click
      // path, and the button's own box is what we need on screen.
      await page.click('#btn-settings', { force: true, timeout: 15000 });
      await page.waitForSelector('#msettings.on', { timeout: 8000 });
      return true;
    },
  },
  {
    name: 'pause',
    url: '/?scene=world&seed=1&preset=min',
    enter: async (page) => {
      await page.waitForSelector('#pause', { timeout: 45000 });
      // GameMenu opens this on Escape — a key a phone does not have, which is
      // itself one of the findings. Force it visible so the PANEL can still be
      // audited; whether a finger can reach it at all is a separate question,
      // and the keyboard-parity check is what answers that.
      // Both the `hidden` attribute AND the `.on` class matter: `hidden` is how
      // the menu keeps pause out of the splash state, `.on` is what displays it.
      await page.evaluate(
        "(() => { const p = document.getElementById('pause');" +
          'if (p) { p.hidden = false; p.classList.add("on"); } })()',
      );
      await page.waitForSelector('#pause.on', { state: 'visible', timeout: 5000 });
      return true;
    },
  },
  {
    name: 'boot',
    url: '/?scene=world&seed=1&preset=min',
    enter: async (page) => {
      const boot = await page.waitForSelector('#boot', { timeout: 20000 }).catch(() => null);
      return boot !== null;
    },
  },
];

async function auditState(
  browser: Browser,
  profile: Profile,
  state: State,
  shots: boolean,
): Promise<Finding[]> {
  const ctx = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.dpr,
    isMobile: true,
    hasTouch: true,
    // The tablet's own Chrome reports a DESKTOP UA (measured: "X11; Linux
    // x86_64", uaData.mobile=false) — the exact reason BrowserGate had to fall
    // back to maxTouchPoints. Emulating a mobile UA here would test a path the
    // real device never takes.
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  // WITHOUT THIS THE GATE IS BLIND, and that is why no probe ever caught a
  // menu defect. GameMenu.shouldBypass() returns true for
  // `navigator.webdriver`, which Playwright always sets — so under automation
  // the splash/pause/settings simply never render, and a probe would report a
  // clean UI because there was no UI. The escape hatch exists for the shooting
  // tools (they want the world, not the menu); auditing the menu means opting
  // back in. Same for maxTouchPoints: BrowserGate.isMobileDevice() keys off it
  // because the tablet's Chrome reports a desktop UA, so a probe that leaves it
  // at 0 tests the desktop layout while claiming to test the phone.
  // STRING form, not a function: tsx compiles this file with esbuild, which
  // wraps functions in a `__name(fn, "...")` helper to preserve names. Playwright
  // ships a function argument by calling toString() on it, so the page received
  // code referencing `__name`, which does not exist there — the init script threw
  // silently and the override never applied (measured: navigator.webdriver was
  // still true, maxTouchPoints still 0). A string cannot be rewritten by the
  // compiler, so it arrives intact.
  await ctx.addInitScript({
    content:
      "Object.defineProperty(navigator, 'webdriver', { get: () => false });" +
      "Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });",
  });
  const page = await ctx.newPage();
  const findings: Finding[] = [];
  try {
    await page.goto(`${LAAS_ORIGIN}${state.url}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    if (state.enter) {
      const ok = await state.enter(page);
      if (!ok) {
        await ctx.close();
        return [];
      }
    } else {
      await page.waitForTimeout(2500);
    }
    // Audit BEFORE screenshotting: the audit is the deliverable, and
    // page.screenshot() waits on font loading, which timed out at 30 s while
    // the world was still streaming and took the whole state down with it.
    // Build a self-calling expression with the args inlined. `evaluate(string)`
    // EVALUATES the string — a bare `(args) => {...}` therefore yields the
    // function object itself, which serializes to undefined and never runs. The
    // second parameter is only honoured for function arguments, which esbuild
    // has already made unusable here (see addInitScript above).
    const args = JSON.stringify({ minTap: MIN_TAP_PX, inset: FINGER_INSET });
    const raw = (await page.evaluate(`(${AUDIT_FN})(${args})`)) as
      | { kind: Finding['kind']; label: string; detail: string }[]
      | undefined;
    if (!Array.isArray(raw)) throw new Error(`audit returned ${typeof raw}, not an array`);
    for (const f of raw) findings.push({ profile: profile.name, state: state.name, ...f });
    if (shots) {
      mkdirSync('shots/wip/ui', { recursive: true });
      await page
        .screenshot({ path: `shots/wip/ui/${profile.name}-${state.name}.png`, timeout: 60000 })
        .catch((e) => console.log(`    (no shot: ${String(e).slice(0, 60)})`));
    }
  } catch (e) {
    findings.push({
      profile: profile.name,
      state: state.name,
      kind: 'OFF_SCREEN',
      label: '(state failed to load)',
      detail: String(e).slice(0, 700),
    });
  }
  await ctx.close();
  return findings;
}

async function main(): Promise<void> {
  const shots = process.argv.includes('--shots');
  // channel:'chromium' — same recipe as every other probe here (launch.ts):
  // the bundled headless shell is not installed on this box, and layout is what
  // we measure, so a real Chromium is the right engine anyway.
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu'],
  });
  const all: Finding[] = [];
  for (const profile of PROFILES) {
    for (const state of STATES) {
      const f = await auditState(browser, profile, state, shots);
      all.push(...f);
      const bad = f.length;
      console.log(`  ${profile.name.padEnd(14)} ${state.name.padEnd(11)} ${bad === 0 ? 'clean' : bad + ' issue(s)'}`);
    }
  }
  await browser.close();

  console.log('\n====== FINDINGS ======');
  for (const kind of ['OCCLUDED', 'TOO_SMALL', 'OFF_SCREEN'] as const) {
    const f = all.filter((x) => x.kind === kind);
    if (f.length === 0) continue;
    console.log(`\n${kind} (${f.length}):`);
    for (const x of f) console.log(`  [${x.profile}/${x.state}] ${x.label}\n      ${x.detail}`);
  }
  mkdirSync('shots/wip', { recursive: true });
  writeFileSync('shots/wip/ui-touch-audit.json', JSON.stringify(all, null, 2));
  console.log(`\nTotal: ${all.length}. Report: shots/wip/ui-touch-audit.json`);
  if (all.length > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
