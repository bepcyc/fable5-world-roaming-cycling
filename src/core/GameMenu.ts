/**
 * Main menu / pause flow (owner ask, 2026-07-06): the splash art + Start/
 * Settings/Exit buttons live as static markup in index.html so they paint
 * before main.ts even runs — this class only wires behavior onto them.
 *
 * States: MENU (splash showing, boot() runs in the background regardless)
 * → PLAYING (splash hidden, engine live) ⇄ PAUSED (Esc; engine.paused
 * freezes worldTime/physics/updateFns, the frame keeps rendering so the
 * pause card sits over a still — not black — world). "Main menu" from
 * pause keeps the world paused and re-shows the splash with the Start
 * button relabeled "ПРОДОЛЖИТЬ" — the world is never torn down mid-session
 * (Engine has no dispose; a real "new ride" would just reload the page).
 *
 * Bypass (`?nosplash=1`, `navigator.webdriver`, non-`world` debug scenes,
 * `?freeze=1`): the menu DOM is hidden immediately and no listeners are
 * attached — every screenshot tool / probe sees exactly the old `#boot`
 * flow, byte-for-byte.
 */

import type { Engine } from './Engine';
import type { LaasHooks } from './Hooks';
import { LANG, type Lang, storeLang, t } from './I18n';
import type { LaasParams, QualityPreset } from './Params';
import { hardwareThreads, storeThreads, THREADS_LS_KEY } from './Threads';

type GameState = 'MENU' | 'PLAYING' | 'PAUSED';

function shouldBypass(params: LaasParams): boolean {
  const q = new URLSearchParams(window.location.search);
  if (q.get('nosplash') === '1') return true;
  if ((navigator as unknown as { webdriver?: boolean }).webdriver === true) return true;
  if (params.scene !== 'world') return true;
  if (params.freeze) return true;
  return false;
}

const PRESETS: QualityPreset[] = ['low', 'high', 'ultra'];
const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
];

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`GameMenu: #${id} missing in index.html`);
  return e as T;
}

export class GameMenu {
  private readonly bypass: boolean;
  private state: GameState = 'MENU';
  private engine: Engine | null = null;
  private worldReady = false;
  private pendingStart = false;
  private hasPlayedOnce = false;
  private progressTimer: number | undefined;

  private splash = el<HTMLDivElement>('splash');
  private pause = el<HTMLDivElement>('pause');
  private splashContent = el<HTMLDivElement>('splash-content');
  private splashHint = el<HTMLDivElement>('splash-hint');
  private msettings = el<HTMLDivElement>('msettings');
  private startBtn = el<HTMLButtonElement>('btn-start');
  private startLabel = el<HTMLSpanElement>('btn-start-label');

  constructor(
    private hooks: LaasHooks,
    private params: LaasParams,
  ) {
    this.bypass = shouldBypass(params);
    if (this.bypass) {
      this.splash.hidden = true;
      this.pause.hidden = true;
      return; // zero listeners — identical to the pre-menu #boot-only flow
    }

    el<HTMLButtonElement>('btn-start').addEventListener('click', () => this.onStartClick());
    el<HTMLButtonElement>('btn-settings').addEventListener('click', () => this.openMachineSettings());
    el<HTMLButtonElement>('btn-exit').addEventListener('click', () => this.onExitClick());
    el<HTMLDivElement>('msettings-close').addEventListener('click', () => this.closeMachineSettings());

    el<HTMLButtonElement>('btn-resume').addEventListener('click', () => this.resume());
    el<HTMLButtonElement>('btn-pause-settings').addEventListener('click', () => this.onPauseSettingsClick());
    el<HTMLButtonElement>('btn-mainmenu').addEventListener('click', () => this.onMainMenuClick());

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      if (this.state === 'PLAYING') this.openPause();
      else if (this.state === 'PAUSED') this.resume();
    });

    this.buildMachineSettings();
    this.startProgressPolling();
  }

  /** Engine exists only after Engine.create() resolves — wire it in once available. */
  bindEngine(engine: Engine): void {
    this.engine = engine;
  }

  /** Called once boot() finishes (world built, engine started+settled). */
  onWorldReady(): void {
    if (this.bypass) return;
    this.worldReady = true;
    window.clearInterval(this.progressTimer);
    if (this.pendingStart) this.enterGame();
    else this.updateStartLabel();
  }

  // ---- main menu -----------------------------------------------------------

  private startProgressPolling(): void {
    this.progressTimer = window.setInterval(() => this.updateStartLabel(), 150);
    this.updateStartLabel();
  }

  private updateStartLabel(): void {
    if (this.worldReady) {
      this.startLabel.textContent = this.hasPlayedOnce ? t('menu.resume') : t('menu.start');
      this.startBtn.removeAttribute('data-disabled');
      this.splashHint.textContent = '';
    } else {
      const pct = Math.round((this.hooks.progress ?? 0) * 100);
      this.startLabel.textContent = t('menu.loading', { pct });
      this.splashHint.textContent = this.pendingStart ? t('menu.waitingHint') : '';
    }
  }

  private onStartClick(): void {
    if (!this.worldReady) {
      this.pendingStart = true;
      this.updateStartLabel();
      return;
    }
    this.enterGame();
  }

  private enterGame(): void {
    this.pendingStart = false;
    this.splash.hidden = true;
    this.pause.classList.remove('on');
    if (this.engine) this.engine.paused = false;
    this.state = 'PLAYING';
    this.hasPlayedOnce = true;
  }

  private onExitClick(): void {
    window.close();
    window.setTimeout(() => {
      this.splashHint.textContent = t('menu.exitBlockedHint');
    }, 150);
  }

  // ---- pause ----------------------------------------------------------------

  private openPause(): void {
    if (!this.engine) return;
    this.engine.paused = true;
    this.state = 'PAUSED';
    this.pause.classList.add('on');
  }

  private resume(): void {
    if (!this.engine) return;
    this.engine.paused = false;
    this.state = 'PLAYING';
    this.pause.classList.remove('on');
  }

  private onPauseSettingsClick(): void {
    // hide the pause chrome, open the in-world OptionsMenu (weather/ToD/bike/
    // keys) on top of the still-frozen frame; Esc from here resumes directly
    // — OptionsMenu is designed to float during live play too, so leaving it
    // open across the resume is its normal supported mode, not a bug.
    this.pause.classList.remove('on');
    this.hooks.openSettings?.();
  }

  private onMainMenuClick(): void {
    // world stays paused; splash comes back with Start relabeled "продолжить"
    this.pause.classList.remove('on');
    this.splash.hidden = false;
    this.state = 'MENU';
    this.updateStartLabel();
  }

  // ---- machine settings (graphics preset / cpu threads — reload required) --

  private openMachineSettings(): void {
    this.splashContent.style.display = 'none';
    this.msettings.classList.add('on');
  }

  private closeMachineSettings(): void {
    this.msettings.classList.remove('on');
    this.splashContent.style.display = '';
  }

  private buildMachineSettings(): void {
    const presetRow = el<HTMLDivElement>('msettings-preset');
    for (const p of PRESETS) {
      const card = document.createElement('div');
      card.className = 'msettings-card-item';
      if (p === this.params.preset) card.classList.add('sel');
      card.textContent = t('preset.' + p);
      card.addEventListener('click', () => this.applyPreset(p));
      presetRow.appendChild(card);
    }

    const max = hardwareThreads();
    const current = (() => {
      try {
        return Number(window.localStorage?.getItem(THREADS_LS_KEY) ?? 0) || 0;
      } catch {
        return 0;
      }
    })();
    const options = Array.from(new Set([0, 1, 2, 4, max])).filter((n) => n <= max || n === 0);
    const threadRow = el<HTMLDivElement>('msettings-threads');
    for (const n of options) {
      const card = document.createElement('div');
      card.className = 'msettings-card-item';
      if (n === current) card.classList.add('sel');
      card.textContent = n === 0 ? t('msettings.auto') : String(n);
      card.addEventListener('click', () => this.applyThreads(n));
      threadRow.appendChild(card);
    }

    const langRow = el<HTMLDivElement>('msettings-language');
    for (const l of LANGS) {
      const card = document.createElement('div');
      card.className = 'msettings-card-item';
      if (l.code === LANG) card.classList.add('sel');
      card.textContent = l.label; // endonym — never translated
      card.addEventListener('click', () => this.applyLang(l.code));
      langRow.appendChild(card);
    }

    const seedInput = el<HTMLInputElement>('msettings-seed-input');
    seedInput.value = String(this.params.seed);
    el<HTMLDivElement>('msettings-seed-random').title = t('msettings.seedRandom');
    el<HTMLDivElement>('msettings-seed-random').addEventListener('click', () => {
      seedInput.value = String(Math.floor(Math.random() * 4294967296));
    });
    const seedApply = el<HTMLDivElement>('msettings-seed-apply');
    seedApply.textContent = t('msettings.seedApply');
    seedApply.addEventListener('click', () => this.applySeed(seedInput.value));
  }

  private confirmReload(): boolean {
    if (!this.hasPlayedOnce) return true;
    return window.confirm(t('menu.confirmReload'));
  }

  private applyPreset(p: QualityPreset): void {
    if (!this.confirmReload()) return;
    const q = new URLSearchParams(window.location.search);
    q.set('preset', p);
    window.location.search = q.toString();
  }

  private applyThreads(n: number): void {
    if (!this.confirmReload()) return;
    storeThreads(n);
    window.location.reload();
  }

  private applyLang(l: Lang): void {
    if (l === LANG) return;
    if (!this.confirmReload()) return;
    storeLang(l);
    window.location.reload();
  }

  private applySeed(raw: string): void {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 0 || n > 4294967295) return;
    if (n === this.params.seed) return;
    if (!this.confirmReload()) return;
    const q = new URLSearchParams(window.location.search);
    q.set('seed', String(n));
    window.location.search = q.toString();
  }
}
