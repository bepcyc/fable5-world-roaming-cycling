/**
 * SettingsMenu — the full graphics settings screen (owner ask 2026-07-16:
 * "every heavy knob lives in the app settings; a proper multi-screen
 * settings of a serious game, everything behind an advanced-mode gate").
 *
 * Renders entirely from QUALITY_META (Quality.ts): one tab per meta.tab,
 * one row per axis — a toggle for booleans, a slider for ranges, discrete
 * cards for enumerated values. The preset row (min/low/mid/high/ultra)
 * shows which table the current values came from; any deviation flips the
 * selection to CUSTOM (stored overrides in localStorage 'laas.quality').
 *
 * Apply semantics: every axis is a boot-constant (materials compile TSL
 * constants at scene build), so changes persist immediately but take
 * effect on reload — the footer shows a RESTART button once anything
 * differs from the running values. renderScale (meta.live) additionally
 * applies immediately through the live hook.
 *
 * Visual language follows OptionsMenu.ts (glass card, opt-card grid,
 * monospace chrome) scaled up to a centered full-height sheet with a tab
 * rail. DOM+CSS only — TRAA never touches it; zero per-frame work while
 * closed. All strings via I18n (en/de/ru) — no literals here.
 */

import { t } from './I18n';
import { announceMenuOpen } from './MenuBus';
import type { QualityPreset } from './Params';
import {
  QUALITY_META,
  quality,
  presetOf,
  storedOverrides,
  storeOverrides,
  type AxisMeta,
  type QualitySettings,
} from './Quality';

const PRESET_ORDER: QualityPreset[] = ['min', 'low', 'mid', 'high', 'ultra'];
const TAB_ORDER: AxisMeta['tab'][] = [
  'display',
  'vegetation',
  'shadows',
  'atmosphere',
  'effects',
  'world',
];

const ADVANCED_LS_KEY = 'laas.settings.advanced';

const STYLE = `
/* UX-11 bug 1: the sheet is opened from the main menu (over the #splash,
   z 2000) AND from the pause card (#pause, z 1500) — at the old 1400/1401 it
   rendered BEHIND both and was invisible/dead. It must sit above every menu
   layer but below the boot loader and the fatal-error overlay (both z 5000)
   and the portrait #rotate blocker. */
#qset-veil{position:fixed;inset:0;z-index:2400;background:rgba(4,7,6,0.62);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  opacity:0;visibility:hidden;transition:opacity 0.22s,visibility 0.22s}
#qset-veil.on{opacity:1;visibility:visible}
#qset{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(0.985);
  z-index:2401;width:min(880px,94vw);height:min(640px,92vh);display:flex;
  flex-direction:column;border-radius:18px;overflow:hidden;
  background:rgba(10,14,12,0.92);border:1px solid rgba(255,255,255,0.12);
  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);color:#cfe3d6;
  font-family:ui-monospace,Menlo,Consolas,monospace;
  box-shadow:0 18px 60px rgba(0,0,0,0.55);opacity:0;visibility:hidden;
  transition:opacity 0.22s,transform 0.22s,visibility 0.22s}
#qset.on{opacity:1;visibility:visible;transform:translate(-50%,-50%) scale(1)}
.qset-head{display:flex;align-items:center;justify-content:space-between;
  padding:16px 20px 12px;border-bottom:1px solid rgba(255,255,255,0.08)}
.qset-title{font:bold 14px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.22em;
  color:#eaf6ee;text-transform:uppercase}
.qset-x{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;
  justify-content:center;cursor:pointer;color:#8fb2a2;font:16px/1 ui-monospace,monospace;
  border:1px solid transparent;transition:all 0.15s}
.qset-x:hover{color:#eaf6ee;border-color:rgba(255,255,255,0.15);background:rgba(255,255,255,0.06)}
.qset-presets{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:14px 20px 6px}
.qset-preset{padding:10px 4px;border-radius:11px;text-align:center;cursor:pointer;
  background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);
  font:bold 10px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.08em;color:#9db8ab;
  text-transform:uppercase;user-select:none;transition:all 0.16s}
.qset-preset:hover{background:rgba(255,255,255,0.1)}
.qset-preset.sel{color:#ffe9b0;border-color:rgba(255,209,102,0.8);
  background:linear-gradient(180deg,rgba(66,56,24,0.55),rgba(46,42,22,0.55));
  box-shadow:0 0 0 1px rgba(255,209,102,0.25)}
.qset-adv{display:flex;align-items:center;gap:8px;padding:8px 20px 4px;
  font:10px/1.4 ui-monospace,Menlo,monospace;color:#7d9c8d;cursor:pointer;user-select:none}
.qset-adv .sw{width:30px;height:16px;border-radius:9px;position:relative;
  background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.16);transition:background 0.18s}
.qset-adv .sw::after{content:'';position:absolute;left:1px;top:1px;width:12px;height:12px;
  border-radius:50%;background:#8fb2a2;transition:transform 0.18s,background 0.18s}
.qset-adv.on .sw{background:rgba(255,209,102,0.35)}
.qset-adv.on .sw::after{transform:translateX(14px);background:#ffd166}
.qset-body{flex:1;display:flex;min-height:0}
.qset-rail{width:148px;flex:none;display:flex;flex-direction:column;gap:4px;
  padding:12px 10px;border-right:1px solid rgba(255,255,255,0.07);overflow-y:auto}
.qset-tab{padding:9px 12px;border-radius:9px;cursor:pointer;user-select:none;
  font:bold 10px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.1em;color:#7d9c8d;
  text-transform:uppercase;transition:all 0.15s;border:1px solid transparent}
.qset-tab:hover{color:#cfe3d6;background:rgba(255,255,255,0.05)}
.qset-tab.sel{color:#ffe9b0;background:rgba(255,209,102,0.09);
  border-color:rgba(255,209,102,0.35)}
.qset-pane{flex:1;overflow-y:auto;padding:12px 20px 18px}
.qset-row{display:flex;align-items:center;justify-content:space-between;gap:14px;
  padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.05)}
.qset-lbl{flex:1;min-width:0}
.qset-lbl .n{font:bold 11px/1.35 ui-monospace,Menlo,monospace;color:#cfe3d6}
.qset-lbl .d{font:9.5px/1.4 ui-monospace,Menlo,monospace;color:#6d8a7c;margin-top:1px}
.qset-reload-badge{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:5px;
  font:bold 8px/1.4 ui-monospace,monospace;letter-spacing:0.08em;color:#ffb84d;
  border:1px solid rgba(255,184,77,0.4);vertical-align:1px}
.qset-ctl{flex:none;display:flex;align-items:center;gap:8px}
.qset-toggle{width:40px;height:20px;border-radius:11px;position:relative;cursor:pointer;
  background:rgba(255,255,255,0.09);border:1px solid rgba(255,255,255,0.16);transition:background 0.18s}
.qset-toggle::after{content:'';position:absolute;left:2px;top:2px;width:14px;height:14px;
  border-radius:50%;background:#8fb2a2;transition:transform 0.18s,background 0.18s}
.qset-toggle.on{background:rgba(255,209,102,0.4)}
.qset-toggle.on::after{transform:translateX(19px);background:#ffd166}
.qset-slider{width:170px;display:flex;align-items:center;gap:9px}
.qset-slider input{-webkit-appearance:none;appearance:none;flex:1;height:6px;border-radius:4px;
  outline:none;cursor:pointer;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.1)}
.qset-slider input::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
  width:15px;height:15px;border-radius:50%;background:#ffd166;cursor:pointer;
  border:2px solid rgba(255,255,255,0.6)}
.qset-slider input::-moz-range-thumb{width:13px;height:13px;border-radius:50%;
  background:#ffd166;cursor:pointer;border:2px solid rgba(255,255,255,0.6)}
.qset-val{min-width:44px;text-align:right;font:bold 11px/1 ui-monospace,monospace;color:#ffe9b0}
.qset-cards{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;max-width:280px}
.qset-card{padding:5px 9px;border-radius:8px;cursor:pointer;user-select:none;
  background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);
  font:bold 10px/1.2 ui-monospace,monospace;color:#9db8ab;transition:all 0.15s}
.qset-card:hover{background:rgba(255,255,255,0.1)}
.qset-card.sel{color:#ffe9b0;border-color:rgba(255,209,102,0.8);
  background:rgba(255,209,102,0.12)}
.qset-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 20px;border-top:1px solid rgba(255,255,255,0.08)}
.qset-note{font:9.5px/1.45 ui-monospace,Menlo,monospace;color:#7d9c8d;flex:1}
.qset-note.hot{color:#ffb84d}
.qset-btn{padding:9px 18px;border-radius:10px;cursor:pointer;user-select:none;
  font:bold 11px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.12em;
  text-transform:uppercase;transition:all 0.16s;border:1px solid rgba(255,255,255,0.14);
  background:rgba(255,255,255,0.05);color:#9db8ab}
.qset-btn:hover{background:rgba(255,255,255,0.11);color:#cfe3d6}
.qset-btn.hot{color:#1c1508;background:linear-gradient(180deg,#ffe9b0,#ffd166);
  border-color:rgba(255,209,102,0.9)}
.qset-btn.hot:hover{filter:brightness(1.06)}
@media (max-width:700px){
  .qset-rail{width:106px}
  .qset-slider{width:120px}
  .qset-presets{grid-template-columns:repeat(3,1fr)}
}
`;

/** value formatting for the slider/cards readout */
function fmtVal(meta: AxisMeta, v: number): string {
  if (meta.key === 'renderScale' && v === 0) return t('settings.auto');
  if (meta.step !== undefined && meta.step < 1) return v.toFixed(2);
  if (v >= 10000) return `${Math.round(v / 1024)}k`;
  return String(v);
}

export class SettingsMenu {
  private veil: HTMLDivElement;
  private sheet: HTMLDivElement;
  private pane: HTMLDivElement;
  private note: HTMLDivElement;
  private restartBtn: HTMLDivElement;
  private presetBtns = new Map<string, HTMLDivElement>();
  private tabBtns = new Map<string, HTMLDivElement>();
  private advToggle: HTMLDivElement;

  private activeTab: AxisMeta['tab'] = 'display';
  private advanced = false;
  /** values as booted (what the running world uses) */
  private readonly booted: QualitySettings;
  /** preset the URL selected */
  private readonly bootPreset: QualityPreset;
  /** working copy shown in the UI = preset defaults + stored overrides */
  private work: QualitySettings;
  private workPreset: QualityPreset;

  constructor(private onLive?: (s: QualitySettings) => void) {
    this.booted = { ...quality() };
    this.bootPreset = presetOf();
    this.workPreset = this.bootPreset;
    this.work = this.resolveWork();
    try {
      this.advanced = globalThis.localStorage?.getItem(ADVANCED_LS_KEY) === '1';
    } catch {
      /* ignore */
    }

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.veil = document.createElement('div');
    this.veil.id = 'qset-veil';
    this.veil.addEventListener('click', () => this.hide());
    document.body.appendChild(this.veil);

    this.sheet = document.createElement('div');
    this.sheet.id = 'qset';
    document.body.appendChild(this.sheet);

    // head
    const head = document.createElement('div');
    head.className = 'qset-head';
    const title = document.createElement('div');
    title.className = 'qset-title';
    title.textContent = t('settings.title');
    const x = document.createElement('div');
    x.className = 'qset-x';
    x.textContent = '✕';
    x.addEventListener('click', () => this.hide());
    head.append(title, x);
    this.sheet.appendChild(head);

    // preset row
    const presets = document.createElement('div');
    presets.className = 'qset-presets';
    for (const p of PRESET_ORDER) {
      const b = document.createElement('div');
      b.className = 'qset-preset';
      b.textContent = t(`preset.${p}`);
      b.addEventListener('click', () => this.pickPreset(p));
      this.presetBtns.set(p, b);
      presets.appendChild(b);
    }
    const custom = document.createElement('div');
    custom.className = 'qset-preset';
    custom.textContent = t('preset.custom');
    this.presetBtns.set('custom', custom);
    presets.appendChild(custom);
    this.sheet.appendChild(presets);

    // advanced gate
    this.advToggle = document.createElement('div');
    this.advToggle.className = 'qset-adv';
    const sw = document.createElement('div');
    sw.className = 'sw';
    const swLbl = document.createElement('span');
    swLbl.textContent = t('settings.advanced');
    this.advToggle.append(sw, swLbl);
    this.advToggle.addEventListener('click', () => {
      this.advanced = !this.advanced;
      try {
        globalThis.localStorage?.setItem(ADVANCED_LS_KEY, this.advanced ? '1' : '0');
      } catch {
        /* ignore */
      }
      this.render();
    });
    this.sheet.appendChild(this.advToggle);

    // body: tab rail + pane
    const body = document.createElement('div');
    body.className = 'qset-body';
    const rail = document.createElement('div');
    rail.className = 'qset-rail';
    for (const tab of TAB_ORDER) {
      const b = document.createElement('div');
      b.className = 'qset-tab';
      b.dataset['tab'] = tab; // stable hook for tooling screenshots
      b.textContent = t(`settings.tab.${tab}`);
      b.addEventListener('click', () => {
        this.activeTab = tab;
        this.render();
      });
      this.tabBtns.set(tab, b);
      rail.appendChild(b);
    }
    this.pane = document.createElement('div');
    this.pane.className = 'qset-pane';
    body.append(rail, this.pane);
    this.sheet.appendChild(body);

    // footer
    const foot = document.createElement('div');
    foot.className = 'qset-foot';
    this.note = document.createElement('div');
    this.note.className = 'qset-note';
    const reset = document.createElement('div');
    reset.className = 'qset-btn';
    reset.textContent = t('settings.reset');
    reset.addEventListener('click', () => this.resetToPreset());
    this.restartBtn = document.createElement('div');
    this.restartBtn.className = 'qset-btn hot';
    this.restartBtn.textContent = t('settings.restart');
    this.restartBtn.addEventListener('click', () => this.restart());
    foot.append(this.note, reset, this.restartBtn);
    this.sheet.appendChild(foot);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.sheet.classList.contains('on')) this.hide();
    });
  }

  show(): void {
    // announce BEFORE turning on: the pause card deliberately ignores 'qset'
    // (the sheet stacks over it and returns to it, UX-11), everything else
    // (options panel, BLE manager) closes — one-overlay rule, MenuBus.ts
    announceMenuOpen('qset');
    this.render();
    this.veil.classList.add('on');
    this.sheet.classList.add('on');
    document.exitPointerLock?.();
  }

  hide(): void {
    this.veil.classList.remove('on');
    this.sheet.classList.remove('on');
  }

  // ---- state ------------------------------------------------------------------

  /** preset defaults for workPreset + stored overrides on top */
  private resolveWork(): QualitySettings {
    const base = this.presetDefaults(this.workPreset);
    return { ...base, ...storedOverrides() };
  }

  private presetDefaults(p: QualityPreset): QualitySettings {
    // quality() resolves URL+LS on top of the preset; to get the pure table we
    // resolve with a synthetic search that disables LS and carries no overrides
    return { ...quality(`?preset=${p}&q.ls=0`) };
  }

  private isCustom(): boolean {
    const base = this.presetDefaults(this.workPreset);
    return QUALITY_META.some((m) => this.work[m.key] !== base[m.key]);
  }

  private needsRestart(): boolean {
    return (
      this.workPreset !== this.bootPreset ||
      QUALITY_META.some((m) => !(m.live ?? false) && this.work[m.key] !== this.booted[m.key])
    );
  }

  private persist(): void {
    // store only the diff vs the selected preset's defaults
    const base = this.presetDefaults(this.workPreset);
    const diff: Partial<QualitySettings> = {};
    for (const m of QUALITY_META) {
      if (this.work[m.key] !== base[m.key]) {
        (diff as Record<string, unknown>)[m.key] = this.work[m.key];
      }
    }
    storeOverrides(diff);
  }

  private pickPreset(p: QualityPreset): void {
    this.workPreset = p;
    this.work = { ...this.presetDefaults(p) };
    storeOverrides({});
    this.applyLive();
    this.render();
  }

  private resetToPreset(): void {
    this.work = { ...this.presetDefaults(this.workPreset) };
    storeOverrides({});
    this.applyLive();
    this.render();
  }

  private setAxis(meta: AxisMeta, v: number | boolean): void {
    (this.work as unknown as Record<string, unknown>)[meta.key] = v;
    this.persist();
    if (meta.live) this.applyLive();
    this.render();
  }

  private applyLive(): void {
    this.onLive?.(this.work);
  }

  private restart(): void {
    if (!window.confirm(t('menu.confirmReload'))) return;
    this.persist();
    const q = new URLSearchParams(window.location.search);
    if (this.workPreset !== this.bootPreset) q.set('preset', this.workPreset);
    // drop stale per-axis URL overrides — localStorage now carries the diff
    for (const m of QUALITY_META) {
      q.delete(`q.${m.key}`);
      if (m.legacyParam) q.delete(m.legacyParam);
    }
    const qs = q.toString();
    window.location.href =
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
  }

  // ---- rendering -----------------------------------------------------------------

  private render(): void {
    // preset selection
    const custom = this.isCustom();
    for (const [key, btn] of this.presetBtns) {
      btn.classList.toggle(
        'sel',
        custom ? key === 'custom' : key === this.workPreset,
      );
    }
    this.advToggle.classList.toggle('on', this.advanced);

    // tabs (hidden entirely outside advanced mode — basic mode shows display only)
    for (const [tab, btn] of this.tabBtns) {
      const visible = this.advanced || tab === 'display';
      btn.style.display = visible ? '' : 'none';
      btn.classList.toggle('sel', tab === this.activeTab);
    }
    if (!this.advanced && this.activeTab !== 'display') this.activeTab = 'display';

    // rows
    this.pane.textContent = '';
    for (const meta of QUALITY_META) {
      if (meta.tab !== this.activeTab) continue;
      this.pane.appendChild(this.rowFor(meta));
    }

    // footer state
    const restart = this.needsRestart();
    this.restartBtn.style.display = restart ? '' : 'none';
    this.note.classList.toggle('hot', restart);
    this.note.textContent = restart ? t('settings.restartNote') : t('settings.savedNote');
  }

  private rowFor(meta: AxisMeta): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'qset-row';
    const lbl = document.createElement('div');
    lbl.className = 'qset-lbl';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = t(`settings.${meta.key}`);
    if (!(meta.live ?? false)) {
      const badge = document.createElement('span');
      badge.className = 'qset-reload-badge';
      badge.textContent = t('settings.reloadBadge');
      n.appendChild(badge);
    }
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = t(`settings.${meta.key}.hint`);
    lbl.append(n, d);
    const ctl = document.createElement('div');
    ctl.className = 'qset-ctl';

    if (meta.kind === 'boolean') {
      const sw = document.createElement('div');
      sw.className = 'qset-toggle' + (this.work[meta.key] ? ' on' : '');
      sw.addEventListener('click', () => this.setAxis(meta, !this.work[meta.key]));
      ctl.appendChild(sw);
    } else if (meta.values) {
      const cards = document.createElement('div');
      cards.className = 'qset-cards';
      for (const v of meta.values) {
        const c = document.createElement('div');
        c.className = 'qset-card' + (this.work[meta.key] === v ? ' sel' : '');
        c.textContent = fmtVal(meta, v);
        c.addEventListener('click', () => this.setAxis(meta, v));
        cards.appendChild(c);
      }
      ctl.appendChild(cards);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'qset-slider';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(meta.min ?? 0);
      input.max = String(meta.max ?? 1);
      input.step = String(meta.step ?? 1);
      input.value = String(this.work[meta.key]);
      const val = document.createElement('div');
      val.className = 'qset-val';
      val.textContent = fmtVal(meta, this.work[meta.key] as number);
      input.addEventListener('input', () => {
        val.textContent = fmtVal(meta, Number(input.value));
      });
      input.addEventListener('change', () => this.setAxis(meta, Number(input.value)));
      wrap.append(input, val);
      ctl.appendChild(wrap);
    }

    row.append(lbl, ctl);
    return row;
  }
}
