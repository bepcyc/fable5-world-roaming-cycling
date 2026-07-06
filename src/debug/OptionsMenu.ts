/**
 * OptionsMenu — the human-facing settings panel (owner ask, session 7).
 *
 * Before this, weather/time/bike mode were URL-params and console hooks
 * only. This panel makes them clickable — tablet-friendly (the LAN flow
 * has no keyboard): a ⚙ button or `O` opens a glass card:
 *   WEATHER  icon cards, dry / rain / after-rain / fog (WeatherState.set
 *            eases the transition — no visual pop)
 *   TIME     5..21 h slider on a dawn→noon→dusk gradient, sun-dot thumb,
 *            applies on release (a ToD change re-bakes sky/IBL/shadow)
 *   BIKE     the HUD chip's own mode glyphs; BikeRig rules stay honest —
 *            without a power source the rig refuses and flashes why
 *   KEYS     cheat-sheet of the existing bindings
 *
 * DOM+CSS like RideHud (TRAA never touches it). Opening releases pointer
 * lock so the cursor can click; a click outside or ✕ closes. Zero
 * per-frame work while closed.
 */

import type { LaasHooks } from '../core/Hooks';
import { t } from '../core/I18n';
import { MODE_ICON } from '../ride/RideHud';
import type { WeatherKind, WeatherState } from '../sky/Weather';

interface RideCtl {
  setMode(m: string): boolean;
  teleportEdge(edgeId: number, s: number, dir: 1 | -1): boolean;
  state(): { mode: string; note: string | null };
}

interface GraphLite {
  edges: { id: number; length: number; cls: { name: string }; pts: { x: number; z: number; s: number }[] }[];
}

type SourceKind = 'none' | 'demo' | 'dev' | 'ble';

/** per-mode surface preference for the "teleport to a rideable spot" UX —
 *  clicking ROAD far from any road must take you TO a road, not refuse */
const MODE_CLS: Record<string, string[]> = {
  road: ['asphalt', 'gravel-fine'],
  gravel: ['gravel-fine', 'gravel-coarse', 'dirt-road', 'asphalt'],
  mtb: ['singletrack', 'dirt-road', 'gravel-coarse'],
};

const STYLE = `
#opt-fab{position:fixed;right:16px;bottom:16px;z-index:1200;width:48px;height:48px;
  border-radius:14px;background:rgba(9,13,11,0.66);border:1px solid rgba(255,255,255,0.14);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#cfe3d6;
  cursor:pointer;user-select:none;pointer-events:auto;display:flex;align-items:center;
  justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.35);
  transition:transform 0.16s,background 0.16s}
#opt-fab:hover{background:rgba(24,32,28,0.8);transform:scale(1.06)}
#opt-fab svg{width:24px;height:24px;transition:transform 0.35s}
#opt-fab.on svg{transform:rotate(90deg)}
#opt-panel{position:fixed;right:16px;bottom:76px;z-index:1200;width:292px;
  border-radius:16px;background:rgba(10,14,12,0.82);border:1px solid rgba(255,255,255,0.12);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:#cfe3d6;
  font-family:ui-monospace,Menlo,Consolas,monospace;padding:14px 16px 16px;
  pointer-events:auto;box-shadow:0 10px 34px rgba(0,0,0,0.45);
  opacity:0;transform:translateY(10px) scale(0.98);visibility:hidden;
  transition:opacity 0.22s,transform 0.22s,visibility 0.22s}
#opt-panel.on{opacity:1;transform:translateY(0) scale(1);visibility:visible}
.opt-title{display:flex;align-items:center;justify-content:space-between;
  font:bold 12px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.2em;color:#eaf6ee;
  margin-bottom:12px}
.opt-x{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;
  justify-content:center;cursor:pointer;color:#8fb2a2;font:14px/1 ui-monospace,monospace;
  border:1px solid transparent;transition:all 0.15s}
.opt-x:hover{color:#eaf6ee;border-color:rgba(255,255,255,0.15);background:rgba(255,255,255,0.06)}
.opt-h{font:bold 9.5px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.18em;
  color:#7d9c8d;margin:12px 0 7px;text-transform:uppercase}
.opt-grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:7px}
.opt-grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
.opt-card{display:flex;flex-direction:column;align-items:center;gap:4px;
  padding:9px 4px 7px;border-radius:11px;min-height:46px;justify-content:center;
  background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);
  font:bold 9.5px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.06em;color:#9db8ab;
  cursor:pointer;user-select:none;transition:all 0.16s;text-transform:uppercase}
.opt-card svg{width:22px;height:22px;opacity:0.9}
.opt-card:hover{background:rgba(255,255,255,0.1);transform:translateY(-1px)}
.opt-card.sel{color:#ffe9b0;border-color:rgba(255,209,102,0.8);
  background:linear-gradient(180deg,rgba(66,56,24,0.55),rgba(46,42,22,0.55));
  box-shadow:0 0 0 1px rgba(255,209,102,0.25),0 3px 10px rgba(0,0,0,0.3)}
.opt-card.sel svg{opacity:1}
.opt-todwrap{position:relative;padding:2px 0 0}
#opt-tod{-webkit-appearance:none;appearance:none;width:100%;height:10px;border-radius:6px;
  outline:none;cursor:pointer;border:1px solid rgba(255,255,255,0.14);
  background:linear-gradient(90deg,
    #1a2340 0%, #7a4a2a 8%, #ffb45e 18%, #bfe0ff 38%, #cfeaff 55%,
    #ffd166 78%, #ff9040 88%, #232a4d 100%)}
#opt-tod::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:22px;height:22px;
  border-radius:50%;background:radial-gradient(circle at 35% 35%, #fff7d9, #ffd166 55%, #e8a63d);
  border:2px solid rgba(255,255,255,0.75);box-shadow:0 0 10px rgba(255,209,102,0.65);
  cursor:pointer}
#opt-tod::-moz-range-thumb{width:20px;height:20px;border-radius:50%;
  background:radial-gradient(circle at 35% 35%, #fff7d9, #ffd166 55%, #e8a63d);
  border:2px solid rgba(255,255,255,0.75);box-shadow:0 0 10px rgba(255,209,102,0.65);
  cursor:pointer}
.opt-todv{display:flex;justify-content:space-between;margin-top:5px;
  font:10px/1.2 ui-monospace,Menlo,monospace;color:#7d9c8d}
.opt-todv b{color:#ffd166;font-size:12px;letter-spacing:0.08em}
.opt-keys{font:10px/1.65 ui-monospace,Menlo,monospace;color:#7d9c8d;white-space:pre;
  background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);
  border-radius:10px;padding:8px 10px}
.opt-keys b{color:#cfe3d6}
.opt-hint{font:10px/1.45 ui-monospace,Menlo,monospace;color:#ffb84d;margin-top:6px;
  min-height:14px;transition:opacity 0.25s;opacity:0}
.opt-hint.on{opacity:1}
@keyframes optShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}
  75%{transform:translateX(4px)}}
.opt-shake{animation:optShake 0.28s 2}
`;

/** weather glyphs (24×24, stroke style matches the HUD mode icons) */
const WX_ICON: Record<WeatherKind, string> = {
  dry: '<circle cx="12" cy="12" r="4.4" fill="none" stroke-width="1.7"/><path d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9" stroke-width="1.7" stroke-linecap="round"/>',
  rain: '<path d="M7 15a4.2 4.2 0 01-.6-8.4 5.4 5.4 0 0110.5 1.2A3.6 3.6 0 0117 15z" fill="none" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.5 17.5l-1.2 2.6M12.5 17.5l-1.2 2.6M16.5 17.5l-1.2 2.6" stroke-width="1.7" stroke-linecap="round"/>',
  'after-rain': '<path d="M8 13.5a3.8 3.8 0 01-.5-7.6 4.8 4.8 0 019.2 1A3.2 3.2 0 0116.5 13.5z" fill="none" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 16l-.9 2M12.5 16l-.9 2" stroke-width="1.6" stroke-linecap="round"/><path d="M17.2 16.2a3 3 0 102.6 4.4M20.6 15.5v2.8h-2.8" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  fog: '<path d="M4 9h13M6.5 12.5H20M4 16h10.5M12 19.5h8" fill="none" stroke-width="1.8" stroke-linecap="round"/>',
};

const WEATHERS: WeatherKind[] = ['dry', 'rain', 'after-rain', 'fog'];
const MODES = ['hike', 'road', 'gravel', 'mtb'];

/** power sources: label / icon / hint (BLE reloads into the boot flow) */
const SOURCES: { kind: SourceKind; label: string; icon: string; hint: string }[] = [
  { kind: 'none', label: t('source.off'), hint: t('source.offHint'), icon: '<circle cx="12" cy="12" r="7.5" fill="none" stroke-width="1.7"/><path d="M7 17L17 7" stroke-width="1.7" stroke-linecap="round"/>' },
  { kind: 'demo', label: t('source.demo'), hint: t('source.demoHint'), icon: '<path d="M5 17V9.5M9.5 17V6M14 17v-6.5M18.5 17V8" stroke-width="1.9" stroke-linecap="round"/>' },
  { kind: 'dev', label: t('source.keys'), hint: t('source.keysHint'), icon: '<rect x="3.5" y="7" width="17" height="10" rx="2" fill="none" stroke-width="1.6"/><path d="M6.5 10h1M9.5 10h1M12.5 10h1M15.5 10h1M7.5 13.5h9" stroke-width="1.6" stroke-linecap="round"/>' },
  { kind: 'ble', label: t('source.ble'), hint: t('source.bleHint'), icon: '<path d="M12 3.5v17l4.5-4L9 9.5M12 12l4.5-4L12 3.5" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' },
];

export class OptionsMenu {
  private fab: HTMLDivElement;
  private panel: HTMLDivElement;
  private wxBtns = new Map<string, HTMLDivElement>();
  private modeBtns = new Map<string, HTMLDivElement>();
  private srcBtns = new Map<string, HTMLDivElement>();
  private srcRow: HTMLDivElement | null = null;
  private hint: HTMLDivElement | null = null;
  private open = false;

  constructor(
    private hooks: LaasHooks,
    private weather: WeatherState,
    initialTod: number,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.fab = document.createElement('div');
    this.fab.id = 'opt-fab';
    this.fab.title = t('opt.fabTitle');
    this.fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.2 12a7.2 7.2 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7.4 7.4 0 00-2.1-1.2L14.3 3h-4l-.4 2.7a7.4 7.4 0 00-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.3 7.3 0 000 2.4l-2 1.5 2 3.4 2.3-1c.6.5 1.4.9 2.1 1.2l.4 2.7h4l.4-2.7a7.4 7.4 0 002.1-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>';
    document.body.appendChild(this.fab);

    this.panel = document.createElement('div');
    this.panel.id = 'opt-panel';
    document.body.appendChild(this.panel);

    // title row
    const title = document.createElement('div');
    title.className = 'opt-title';
    title.innerHTML = `<span>${t('opt.title')}</span>`;
    const x = document.createElement('div');
    x.className = 'opt-x';
    x.textContent = '✕';
    x.addEventListener('click', () => this.toggle(false));
    title.appendChild(x);
    this.panel.appendChild(title);

    // WEATHER
    this.panel.appendChild(h(t('opt.weather')));
    const wxRow = document.createElement('div');
    wxRow.className = 'opt-grid2';
    for (const w of WEATHERS) {
      const b = card(
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${WX_ICON[w]}</svg>`,
        t('weather.' + w),
      );
      b.addEventListener('click', () => {
        this.weather.set(w);
        this.refresh();
      });
      this.wxBtns.set(w, b);
      wxRow.appendChild(b);
    }
    this.panel.appendChild(wxRow);

    // TIME OF DAY
    this.panel.appendChild(h(t('opt.timeOfDay')));
    const wrap = document.createElement('div');
    wrap.className = 'opt-todwrap';
    const tod = document.createElement('input');
    tod.type = 'range';
    tod.id = 'opt-tod';
    tod.min = '5';
    tod.max = '21';
    tod.step = '0.25';
    tod.value = String(Math.min(Math.max(initialTod, 5), 21));
    const out = document.createElement('div');
    out.className = 'opt-todv';
    const outB = document.createElement('b');
    outB.textContent = fmtTod(Number(tod.value));
    out.append(mk('span', t('opt.dawn')), outB, mk('span', t('opt.dusk')));
    // live label while dragging; the expensive sky/IBL/shadow re-bake fires
    // on release only
    tod.addEventListener('input', () => {
      outB.textContent = fmtTod(Number(tod.value));
    });
    tod.addEventListener('change', () => {
      this.hooks.setTimeOfDay?.(Number(tod.value));
    });
    wrap.appendChild(tod);
    this.panel.appendChild(wrap);
    this.panel.appendChild(out);

    // POWER SOURCE — without one the bikes are LOCKED (Pillar C honesty);
    // this is exactly why "clicking ROAD did nothing" before (owner bug)
    this.panel.appendChild(h(t('opt.powerSource')));
    const srcRow = document.createElement('div');
    srcRow.className = 'opt-grid4';
    this.srcRow = srcRow;
    for (const s of SOURCES) {
      const b = card(
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${s.icon}</svg>`,
        s.label,
      );
      b.addEventListener('click', () => {
        if (s.kind === 'ble') {
          // BLE needs the boot-time connect flow (secure context + UI)
          const u = new URL(window.location.href);
          u.searchParams.set('ride', 'ble');
          u.searchParams.delete('ridedev');
          window.location.assign(u.toString());
          return;
        }
        this.setSource(s.kind === 'none' ? null : s.kind);
        this.showHint(s.hint);
        this.refresh();
      });
      this.srcBtns.set(s.kind, b);
      srcRow.appendChild(b);
    }
    this.panel.appendChild(srcRow);

    // BIKE
    this.panel.appendChild(h(t('opt.bike')));
    const modeRow = document.createElement('div');
    modeRow.className = 'opt-grid4';
    for (const m of MODES) {
      const b = card(
        `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor">${MODE_ICON[m] ?? ''}</svg>`,
        t('mode.' + m),
      );
      b.addEventListener('click', () => {
        const ride = this.rideCtl();
        let ok = ride?.setMode(m) ?? false;
        if (!ok && m !== 'hike') {
          if (this.sourceKind() === 'none') {
            // the silent-refusal trap: point at the POWER SOURCE section
            this.showHint(t('opt.needPowerHint'));
            this.srcRow?.classList.remove('opt-shake');
            void this.srcRow?.offsetWidth; // restart the animation
            this.srcRow?.classList.add('opt-shake');
          } else if (ride) {
            // no suitable road within mount range — take the rider to the
            // nearest spot of this mode's preferred surface (owner UX rule)
            const spot = this.nearestSpot(m);
            if (spot) {
              ride.teleportEdge(spot.edge, spot.s, 1);
              ok = ride.setMode(m);
              this.showHint(ok ? t('opt.teleportedTo', { surface: t('surface.' + spot.cls) }) : (ride.state().note ?? ''));
            } else {
              this.showHint(ride.state().note ?? t('opt.noRideableRoad'));
            }
          }
        }
        this.refresh();
      });
      this.modeBtns.set(m, b);
      modeRow.appendChild(b);
    }
    this.panel.appendChild(modeRow);

    // hint line (source explanations / lock reasons)
    this.hint = document.createElement('div');
    this.hint.className = 'opt-hint';
    this.panel.appendChild(this.hint);

    // KEYS
    this.panel.appendChild(h(t('opt.keys')));
    const keys = document.createElement('div');
    keys.className = 'opt-keys';
    keys.innerHTML =
      `<b>M</b> ${t('opt.keyBikeMode')}    <b>V</b> ${t('opt.keyWalkFly')}\n` +
      `<b>B</b> ${t('opt.keyDashboard')}    <b>O</b> ${t('opt.keyThisMenu')}\n` +
      `<b>←/→</b> ${t('opt.keyPickTurn')}   <b>Space/S</b> ${t('opt.keyBrake')}\n` +
      `<b>[ ]</b> ${t('opt.keyTime')}        <b>1..9</b> ${t('opt.keyViews')}\n` +
      `<b>Shift+D</b> ${t('opt.keyDebug')}   <b>Ctrl+E</b> .fit`;
    this.panel.appendChild(keys);

    this.fab.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      if (this.open) this.toggle(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyO' && !e.repeat) this.toggle();
    });
  }

  private rideCtl(): RideCtl | null {
    const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg;
    return (dbg?.['ride'] as RideCtl | undefined) ?? null;
  }

  private sourceKind(): SourceKind {
    const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg;
    const fn = dbg?.['rideSourceKind'] as (() => string) | undefined;
    return (fn?.() ?? 'none') as SourceKind;
  }

  private setSource(kind: 'demo' | 'dev' | null): void {
    const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg;
    const fn = dbg?.['rideSetSource'] as ((k: 'demo' | 'dev' | null) => string) | undefined;
    fn?.(kind);
  }

  private showHint(text: string): void {
    if (!this.hint) return;
    this.hint.textContent = text;
    this.hint.classList.add('on');
    window.setTimeout(() => this.hint?.classList.remove('on'), 3500);
  }

  /** nearest point on an edge of the mode's preferred class (falls back
   *  to ANY road) — measured from the current camera pose */
  private nearestSpot(mode: string): { edge: number; s: number; cls: string } | null {
    const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg;
    const graph = dbg?.['rideGraph'] as GraphLite | undefined;
    const getPose = (window as unknown as { __laas?: { getPose?: () => { p: number[] } } })
      .__laas?.getPose;
    if (!graph || !getPose) return null;
    const p = getPose().p;
    const px = p[0] ?? 0;
    const pz = p[2] ?? 0;
    const prefs = MODE_CLS[mode] ?? [];
    const rank = (cls: string): number => {
      const i = prefs.indexOf(cls);
      return i === -1 ? prefs.length : i;
    };
    let best: { edge: number; s: number; cls: string; rank: number; d2: number } | null = null;
    for (const e of graph.edges) {
      const r = rank(e.cls.name);
      for (let i = 0; i < e.pts.length; i += 3) {
        const pt = e.pts[Math.min(i, e.pts.length - 1)];
        if (!pt) continue;
        const dx = pt.x - px;
        const dz = pt.z - pz;
        const d2 = dx * dx + dz * dz;
        // better class rank always wins; distance breaks ties within rank
        if (!best || r < best.rank || (r === best.rank && d2 < best.d2)) {
          best = { edge: e.id, s: pt.s, cls: e.cls.name, rank: r, d2 };
        }
      }
    }
    return best ? { edge: best.edge, s: best.s, cls: best.cls } : null;
  }

  /** open the panel programmatically (pause-menu "Settings" button).
   *  Deferred a tick: the caller's own click is still bubbling toward
   *  `document`, where this class's own "click outside closes" listener
   *  lives — opening synchronously would see this.open flip true and
   *  immediately close it again within that same click. */
  show(): void {
    window.setTimeout(() => this.toggle(true), 0);
  }

  private toggle(to?: boolean): void {
    this.open = to ?? !this.open;
    this.panel.classList.toggle('on', this.open);
    this.fab.classList.toggle('on', this.open);
    if (this.open) {
      document.exitPointerLock();
      this.refresh();
    }
  }

  private refresh(): void {
    for (const [w, b] of this.wxBtns) b.classList.toggle('sel', w === this.weather.state);
    const mode = this.rideCtl()?.state().mode ?? 'hike';
    for (const [m, b] of this.modeBtns) b.classList.toggle('sel', m === mode);
    const src = this.sourceKind();
    for (const [k, b] of this.srcBtns) b.classList.toggle('sel', k === src);
  }
}

function h(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'opt-h';
  el.textContent = text;
  return el;
}

function card(iconSvg: string, label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'opt-card';
  el.innerHTML = `${iconSvg}<span>${label}</span>`;
  return el;
}

function mk(tag: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function fmtTod(t: number): string {
  const hh = Math.floor(t);
  const mm = Math.round((t - hh) * 60);
  return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
}
