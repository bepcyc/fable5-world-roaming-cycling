/**
 * Ride dashboard + junction chooser — the M1.3 rider-facing UI.
 *
 * Top bar: metric cards SPEED / POWER / GRADE / CADENCE / HR + mode chip.
 * Hidden by default; `B` toggles. `?ride=1` boots it visible; `?ride=demo`
 * attaches DemoSensorSource (DEMO badge); `?ridedev=1` attaches the
 * keyboard bike (DEV badge). Synthetic numbers are ALWAYS badged (Pillar C)
 * — cadence/HR/power read "—" without a source.
 *
 * Bottom center: the junction chooser (owner directive: Zwift-style
 * on-screen "turn ahead" pick, не по рельсам) — arrow cards, ←/→ select,
 * live distance countdown. Center: status banner (BLOCKED / STALLED /
 * mode notes). All DOM+CSS, zero canvas — TRAA never touches it.
 *
 * Speed is always real — horizontal rig speed from the clean logical pose;
 * in ride mode the pose is solver-driven, so dashboard speed == solver
 * speed (±1 % acceptance, `ride.hudKmh100` vs `ride.kmh100` counters).
 */

import type { Engine } from '../core/Engine';
import type { FlyCamera } from '../core/FlyCamera';
import type { BikeRig, JunctionPreview, Turn } from './BikeRig';
import { Cockpit } from './cockpit/Cockpit';
import { RideRecorder } from './RideRecorder';
import { DemoSensorSource, KeyboardPowerSource, type SensorSource } from './Sensors';

const SPEED_TAU = 0.45; // s — display smoothing of raw pose-delta speed
const TELEPORT_SPEED = 200; // m/s — faster than any ride ⇒ programmatic jump
const MOVING_MS = 0.3; // m/s — demo "pedaling" threshold
const REFRESH_S = 0.15; // text refresh cadence
const MS_TO_KMH = 3.6;

interface Card {
  root: HTMLDivElement;
  value: HTMLDivElement;
  unit: HTMLDivElement;
}

const STYLE = `
#ride-hud{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:1000;
  display:flex;gap:8px;align-items:stretch;pointer-events:none;
  font-family:ui-monospace,Menlo,Consolas,monospace}
.rh-card{background:rgba(9,13,11,0.58);backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.09);
  border-radius:10px;padding:7px 14px 8px;min-width:88px;text-align:center;
  color:#87a094;box-shadow:0 2px 10px rgba(0,0,0,0.25)}
.rh-label{font-size:9px;letter-spacing:0.12em;opacity:0.85}
.rh-value{font-size:26px;font-weight:700;line-height:1.12;
  font-variant-numeric:tabular-nums;transition:color 0.3s}
.rh-unit{font-size:9px;opacity:0.8}
.rh-chip{display:flex;flex-direction:column;justify-content:center;align-items:center;
  gap:2px;min-width:64px;border-radius:10px;padding:6px 12px;
  background:rgba(9,13,11,0.58);backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,0.09);color:#cfe3d6;
  box-shadow:0 2px 10px rgba(0,0,0,0.25)}
.rh-chip .ico{width:22px;height:22px;opacity:0.95}
.rh-chip .lbl{font:bold 9px/1.1 ui-monospace,Menlo,monospace;letter-spacing:0.12em}
.rh-badge{align-self:flex-start;border-radius:8px;padding:3px 7px;
  font:bold 9px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.1em}
#ride-banner{position:fixed;top:23%;left:50%;transform:translate(-50%,0);
  z-index:1001;pointer-events:none;text-align:center;
  font:bold 15px/1.35 ui-monospace,Menlo,monospace;letter-spacing:0.06em;
  padding:10px 22px;border-radius:12px;color:#ffd9c9;
  background:rgba(30,10,6,0.62);border:1px solid rgba(255,140,90,0.35);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  opacity:0;transition:opacity 0.25s}
#ride-hazard{position:fixed;top:88px;left:50%;transform:translate(-50%,0);
  z-index:1001;pointer-events:none;text-align:center;
  font:bold 13px/1.3 ui-monospace,Menlo,monospace;letter-spacing:0.08em;
  padding:8px 18px;border-radius:10px;color:#ffe08a;
  background:rgba(38,26,4,0.66);border:1px solid rgba(255,209,102,0.45);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  opacity:0;transition:opacity 0.25s}
#ride-hazard .rz-dist{color:#fff3cf}
#ride-banner.info{color:#dcefe4;background:rgba(8,16,12,0.62);
  border-color:rgba(160,220,190,0.28)}
#ride-junction{position:fixed;bottom:15%;left:50%;transform:translate(-50%,12px);
  z-index:1001;pointer-events:none;text-align:center;opacity:0;
  transition:opacity 0.28s,transform 0.28s;
  font-family:ui-monospace,Menlo,Consolas,monospace}
#ride-junction.on{opacity:1;transform:translate(-50%,0)}
.rj-title{font:bold 11px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.18em;
  color:#e9f4ed;text-shadow:0 1px 6px rgba(0,0,0,0.7);margin-bottom:7px}
.rj-dist{color:#ffd166}
.rj-row{display:flex;gap:10px;justify-content:center}
.rj-opt{width:76px;border-radius:12px;padding:9px 6px 7px;
  background:rgba(9,13,11,0.64);backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.10);
  color:#9db8ab;transition:transform 0.18s,border-color 0.18s,background 0.18s;
  box-shadow:0 3px 14px rgba(0,0,0,0.35)}
.rj-opt.sel{transform:translateY(-4px) scale(1.06);color:#f2fbf5;
  border-color:rgba(255,209,102,0.85);background:rgba(26,30,20,0.78);
  box-shadow:0 6px 20px rgba(0,0,0,0.45),0 0 0 1px rgba(255,209,102,0.25)}
.rj-opt svg{width:30px;height:30px;display:block;margin:0 auto 4px}
.rj-cls{font:bold 8px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.08em;
  text-transform:uppercase;opacity:0.9}
.rj-hint{margin-top:8px;font:10px/1.2 ui-monospace,Menlo,monospace;
  color:#b9cdc1;text-shadow:0 1px 5px rgba(0,0,0,0.8);letter-spacing:0.08em}
.rj-hint b{color:#ffd166}
`;

/** per-road-class accent (matches world materials' reading) */
const CLS_COLOR: Record<string, string> = {
  asphalt: '#9fb4c8',
  'gravel-fine': '#c8b790',
  'gravel-coarse': '#b8a67e',
  'dirt-road': '#c09a6e',
  singletrack: '#9dbf7f',
};

/** mode glyphs (24×24 path content) — shared with the options menu */
export const MODE_ICON: Record<string, string> = {
  hike: '<path d="M12 3.2a2 2 0 110 4 2 2 0 010-4zm-1.4 5.2l-2.8 2.2.9 3-2.2 6.2h2.1l1.9-5.2 2 2.2.4 3h2l-.6-4.4-2.2-2.4.7-2.6c.9 1 2.1 1.7 3.6 1.9v-1.9c-1.1-.2-2-.8-2.7-1.7l-1-1.3a2.4 2.4 0 00-2.1-1z"/>',
  road: '<circle cx="6" cy="16.5" r="3.4" fill="none" stroke-width="1.6"/><circle cx="18" cy="16.5" r="3.4" fill="none" stroke-width="1.6"/><path d="M6 16.5l3.4-7h5.8l2.8 7M9.4 9.5L8 7h2.5M14 9l-3 7.5" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  gravel: '<circle cx="6" cy="16.5" r="3.4" fill="none" stroke-width="1.6"/><circle cx="18" cy="16.5" r="3.4" fill="none" stroke-width="1.6"/><path d="M6 16.5l3.4-7h5.8l2.8 7M9.4 9.5L8 7h2.5M14 9l-3 7.5" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="4" cy="21.4" r="0.8"/><circle cx="8.4" cy="21.8" r="0.8"/><circle cx="13" cy="21.4" r="0.8"/><circle cx="17.6" cy="21.8" r="0.8"/><circle cx="21" cy="21.3" r="0.8"/>',
  mtb: '<circle cx="6" cy="16.5" r="3.4" fill="none" stroke-width="1.9"/><circle cx="18" cy="16.5" r="3.4" fill="none" stroke-width="1.9"/><path d="M6 16.5l3.2-6.4h6l2.8 6.4M9.2 10.1L7.6 7.4h2.6M14.4 9.4l-3.2 7.1" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 5.5l3.2-2.2 2.6 2.6 3-2 2.6 2.4 3.2-2.2 2.9 2.2" fill="none" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>',
};

/** arrow glyphs for the chooser (24×24, stroke drawn) */
function turnSvg(turn: Turn, color: string): string {
  const arrow: Record<Turn, string> = {
    straight: '<path d="M12 20V6M7.5 10.5L12 5.5l4.5 5"/>',
    left: '<path d="M16.5 20v-8.5a3 3 0 00-3-3H6M9.5 4.5L5.5 8.5l4 4"/>',
    right: '<path d="M7.5 20v-8.5a3 3 0 013-3H18M14.5 4.5l4 4-4 4"/>',
    'sharp-left': '<path d="M15 20V9L7 13.5M7.5 7.5L6.5 14l6-1"/>',
    'sharp-right': '<path d="M9 20V9l8 4.5M16.5 7.5l1 6.5-6-1"/>',
    'u-turn': '<path d="M8 20v-9a4 4 0 018 0v3M19.5 11.5L16 15.5l-3.5-4"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${arrow[turn]}</svg>`;
}

export class RideHud {
  private fly: FlyCamera;
  private source: SensorSource | null;
  private rig: BikeRig | null = null;
  private root: HTMLDivElement;
  private chip: HTMLDivElement;
  private chipIco: SVGSVGElement;
  private chipLbl: HTMLDivElement;
  private speed: Card;
  private power: Card;
  private grade: Card;
  private dist: Card;
  private cadence: Card;
  private heart: Card;
  private banner: HTMLDivElement;
  private hazardEl: HTMLDivElement;
  private badgeEl: HTMLDivElement | null = null;
  /** M1.5 first-person cockpit — self-driving once constructed */
  cockpit: Cockpit | null = null;
  private junctionEl: HTMLDivElement;
  private junctionRow: HTMLDivElement;
  private junctionTitle: HTMLDivElement;
  private junctionKey = '';
  private visible: boolean;
  private last: { x: number; z: number } | null = null;
  private speedMs = 0;
  private acc = 0;
  private engine: Engine;
  /** DRAFT session recorder (.fit export via Ctrl+E) */
  private recorder = new RideRecorder();

  constructor(engine: Engine, fly: FlyCamera, source: SensorSource | null) {
    this.fly = fly;
    this.engine = engine;
    this.source = source;
    const ride = new URLSearchParams(window.location.search).get('ride');
    this.visible = (ride !== null && ride !== '0') || engine.params.rideDev;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'ride-hud';
    // mode chip
    this.chip = document.createElement('div');
    this.chip.className = 'rh-chip';
    this.chip.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"></svg><div class="lbl">HIKE</div>`;
    this.chipIco = this.chip.querySelector('svg') as SVGSVGElement;
    this.chipLbl = this.chip.querySelector('.lbl') as HTMLDivElement;

    this.speed = makeCard('SPEED', 'km/h', '#eaf6ee');
    this.power = makeCard('POWER', 'W', '#ffd166');
    this.grade = makeCard('GRADE', '%', '#cfe3d6');
    this.dist = makeCard('DISTANCE', 'km', '#dcefe4');
    this.cadence = makeCard('CADENCE', 'rpm', '#bcd9ff');
    this.heart = makeCard('HEART RATE', 'bpm', '#ff8f88');
    this.root.append(
      this.chip,
      this.speed.root,
      this.power.root,
      this.grade.root,
      this.dist.root,
      this.cadence.root,
      this.heart.root,
    );
    this.applyBadge();
    document.body.appendChild(this.root);

    this.banner = document.createElement('div');
    this.banner.id = 'ride-banner';
    document.body.appendChild(this.banner);

    // P5: amber pre-warning strip (impassable zone ahead on the route)
    this.hazardEl = document.createElement('div');
    this.hazardEl.id = 'ride-hazard';
    document.body.appendChild(this.hazardEl);

    this.junctionEl = document.createElement('div');
    this.junctionEl.id = 'ride-junction';
    this.junctionEl.innerHTML = `<div class="rj-title">TURN AHEAD · <span class="rj-dist">0 m</span></div><div class="rj-row"></div><div class="rj-hint"><b>←</b> / <b>→</b> choose</div>`;
    this.junctionTitle = this.junctionEl.querySelector('.rj-dist') as HTMLDivElement;
    this.junctionRow = this.junctionEl.querySelector('.rj-row') as HTMLDivElement;
    document.body.appendChild(this.junctionEl);

    this.applyVisibility();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyB') {
        this.visible = !this.visible;
        this.applyVisibility();
      }
      // DRAFT .fit session export (owner ask 2026-07-03, Zwift-style)
      if (e.code === 'KeyE' && e.ctrlKey) {
        e.preventDefault();
        this.recorder.download();
      }
    });

    engine.onUpdate((dt) => this.update(dt));
  }

  /** BikeRig attaches after world build (needs the road graph) */
  attachRig(rig: BikeRig): void {
    this.rig = rig;
    // M1.5 cockpit: rides the same rig/sensor state; zero footprint until
    // a bike is mounted (group hidden, uniforms parked)
    this.cockpit = new Cockpit(this.engine, this.fly, rig, () => this.source);
    // options menu: runtime power-source swap (demo/keyboard). The
    // honesty rules ride along — badges follow the source kind, a null
    // source keeps bikes locked. BLE stays a boot-time flow (secure
    // context + user-gesture connect UI), the menu reloads for it.
    const dbg =
      (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg ?? {};
    dbg['rideSetSource'] = (kind: 'demo' | 'dev' | null): string => {
      const src =
        kind === 'demo' ? new DemoSensorSource() : kind === 'dev' ? new KeyboardPowerSource() : null;
      this.source = src;
      this.rig?.setSource(src);
      this.applyBadge();
      if (src && !this.visible) {
        this.visible = true; // picking a source means "I want to ride"
        this.applyVisibility();
      }
      return this.source?.kind ?? 'none';
    };
    dbg['rideSourceKind'] = (): string => this.source?.kind ?? 'none';
    (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg = dbg;
  }

  /** (re)draw the honesty badge for the current source */
  private applyBadge(): void {
    this.badgeEl?.remove();
    this.badgeEl = null;
    if (this.source?.kind === 'demo') {
      this.badgeEl = makeBadge('DEMO', '#ffb84d', 'rgba(64,44,4,0.75)', 'simulated cadence/HR/power — connect real sensors for real data');
    } else if (this.source?.kind === 'dev') {
      this.badgeEl = makeBadge('DEV', '#7fc4ff', 'rgba(6,30,52,0.75)', 'keyboard bike — W pedal, Shift burst, +/- watts, S/Space brake');
    }
    if (this.badgeEl) this.root.appendChild(this.badgeEl);
  }

  private applyVisibility(): void {
    this.root.style.display = this.visible ? 'flex' : 'none';
    if (!this.visible) {
      this.banner.style.opacity = '0';
      this.hazardEl.style.opacity = '0';
      this.junctionEl.classList.remove('on');
    }
  }

  /** registered after the camera mover — getPose is fresh for this frame */
  private update(dt: number): void {
    if (dt > 1e-6) {
      const p = this.fly.getPose().p;
      if (this.last) {
        const raw = Math.hypot(p[0] - this.last.x, p[2] - this.last.z) / dt;
        if (raw > TELEPORT_SPEED) this.speedMs = 0;
        else this.speedMs += (raw - this.speedMs) * (1 - Math.exp(-dt / SPEED_TAU));
      }
      this.last = { x: p[0], z: p[2] };
    }
    const kmh = this.speedMs * MS_TO_KMH;
    this.source?.update(dt, { speedKmh: kmh, moving: this.speedMs > MOVING_MS });
    this.engine.stats.counters['ride.hudKmh100'] = Math.round(kmh * 100);

    this.acc += dt;
    if (this.acc < REFRESH_S) return;
    this.acc = 0;
    if (!this.visible) return;

    const st = this.rig?.state() ?? null;
    const sample = this.source?.read() ?? { cadenceRpm: null, heartRateBpm: null, powerW: null };
    // session recording (1 Hz decimation inside; power is real solver input)
    {
      const p = this.fly.getPose().p;
      this.recorder.addSample(
        Date.now(),
        p[0],
        p[2],
        p[1],
        this.speedMs,
        sample,
        st?.riding ? st.powerW : null,
      );
    }

    this.speed.value.textContent = kmh.toFixed(1);
    this.power.value.textContent = st?.riding ? Math.round(st.powerW).toString() : fmt(sample.powerW);
    this.cadence.value.textContent = fmt(sample.cadenceRpm);
    this.heart.value.textContent = fmt(sample.heartRateBpm);
    if (st?.riding) {
      const pct = st.grade * 100;
      this.grade.value.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}`;
      this.grade.value.style.color = pct > 1 ? '#ff9d7a' : pct < -1 ? '#8fd8ff' : '#cfe3d6';
      const km = st.distM / 1000;
      this.dist.value.textContent = km >= 100 ? km.toFixed(1) : km.toFixed(2);
    } else {
      this.grade.value.textContent = '—';
      this.grade.value.style.color = '#cfe3d6';
      this.dist.value.textContent = '—';
    }

    // mode chip
    const mode = st?.mode ?? 'hike';
    this.chipLbl.textContent = mode.toUpperCase();
    const ico = MODE_ICON[mode] ?? MODE_ICON['hike'] ?? '';
    if (this.chipIco.dataset['m'] !== mode) {
      this.chipIco.dataset['m'] = mode;
      this.chipIco.innerHTML = ico;
    }

    // P5 pre-warning: impassable zone ahead on the route. Shows when the
    // zone is inside the reaction window (≥2 s guaranteed: window is 3.5 s
    // at speed, floored at 12 m for near-standstill approaches).
    {
      const hz = st?.riding ? st.hazard : null;
      const v = st?.vMs ?? 0;
      const windowM = Math.min(Math.max(v * 3.5, 12), 60);
      const show = hz !== null && !st?.blocked && hz.distM <= windowM;
      if (show && hz) {
        const label =
          hz.kind === 'slope'
            ? `TOO STEEP AHEAD (${hz.what})`
            : `${hz.what.toUpperCase().replace(/-/g, ' ')} AHEAD`;
        this.hazardEl.innerHTML = `⚠ ${label} · <span class="rz-dist">${Math.max(Math.round(hz.distM / 5) * 5, 5)} m</span> — DISMOUNT (M) OR TURN`;
        this.hazardEl.style.opacity = '1';
      } else {
        this.hazardEl.style.opacity = '0';
      }
      this.engine.stats.counters['ride.hazardShown'] = show ? 1 : 0;
      this.engine.stats.counters['ride.hazardDm'] = hz ? Math.round(hz.distM * 10) : -1;
    }

    // banner: hard states win, then transient notes
    if (st?.blocked) {
      this.showBanner(
        Math.abs(st.grade) > (this.rig?.modeMaxSlope() ?? 1)
          ? `TOO STEEP FOR ${mode.toUpperCase()} — ${(st.grade * 100).toFixed(0)} % · DISMOUNT (M)`
          : `${st.surface.toUpperCase()} BLOCKS ${mode.toUpperCase()} — DISMOUNT (M)`,
        false,
      );
    } else if (st?.stalled) {
      this.showBanner(`BOGGED DOWN IN ${st.surface.toUpperCase()} — DISMOUNT (M)`, false);
    } else if (st?.note) {
      this.showBanner(st.note, true);
    } else {
      this.banner.style.opacity = '0';
    }

    this.renderJunction(st?.junction ?? null);
  }

  private showBanner(text: string, info: boolean): void {
    this.banner.textContent = text;
    this.banner.classList.toggle('info', info);
    this.banner.style.opacity = '1';
  }

  private renderJunction(j: JunctionPreview | null): void {
    if (!j || j.options.length < 2) {
      this.junctionEl.classList.remove('on');
      this.junctionKey = '';
      return;
    }
    this.junctionTitle.textContent = `${Math.max(Math.round(j.distM / 5) * 5, 0)} m`;
    const key = j.options.map((o) => o.turn + o.cls).join('|');
    if (key !== this.junctionKey) {
      this.junctionKey = key;
      this.junctionRow.innerHTML = '';
      for (const o of j.options) {
        const el = document.createElement('div');
        el.className = 'rj-opt';
        const color = CLS_COLOR[o.cls] ?? '#cfe3d6';
        el.innerHTML = `${turnSvg(o.turn, 'currentColor')}<div class="rj-cls" style="color:${color}">${o.cls}</div>`;
        this.junctionRow.appendChild(el);
      }
    }
    const kids = this.junctionRow.children;
    for (let i = 0; i < kids.length; i++) {
      (kids[i] as HTMLElement).classList.toggle('sel', i === j.selected);
    }
    this.junctionEl.classList.add('on');
  }
}

function fmt(v: number | null): string {
  return v === null ? '—' : Math.round(v).toString();
}

function makeCard(label: string, unit: string, color: string): Card {
  const root = document.createElement('div');
  root.className = 'rh-card';
  const labelEl = document.createElement('div');
  labelEl.className = 'rh-label';
  labelEl.textContent = label;
  const value = document.createElement('div');
  value.className = 'rh-value';
  value.textContent = '—';
  value.style.color = color;
  const unitEl = document.createElement('div');
  unitEl.className = 'rh-unit';
  unitEl.textContent = unit;
  root.append(labelEl, value, unitEl);
  return { root, value, unit: unitEl };
}

function makeBadge(text: string, fg: string, bg: string, title: string): HTMLDivElement {
  const badge = document.createElement('div');
  badge.className = 'rh-badge';
  badge.textContent = text;
  badge.title = title;
  badge.style.color = fg;
  badge.style.background = bg;
  return badge;
}
