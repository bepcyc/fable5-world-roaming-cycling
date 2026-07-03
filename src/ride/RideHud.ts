/**
 * Ride dashboard — Zwift/MyWhoosh-style metric cards: SPEED / CADENCE / HR.
 *
 * Hidden by default; `B` toggles. `?ride=1` boots it visible; `?ride=demo`
 * additionally attaches DemoSensorSource (fake cadence/HR, amber DEMO badge).
 * Without a source, cadence/HR read "—": real values only ever come from
 * real sensors (Web Bluetooth — later phase). Speed is always real —
 * horizontal rig speed from the clean logical pose (getPose strips walk
 * bob/dip), so camera effects never pollute the number. Pose jumps
 * (bookmarks/probes/flythrough seeks) read as a reset, not a speed spike.
 */

import type { Engine } from '../core/Engine';
import type { FlyCamera } from '../core/FlyCamera';
import { RideRecorder } from './RideRecorder';
import { DemoSensorSource, type SensorSource } from './Sensors';

const SPEED_TAU = 0.45; // s — display smoothing of raw pose-delta speed
const TELEPORT_SPEED = 200; // m/s — faster than any ride ⇒ programmatic jump
const MOVING_MS = 0.3; // m/s — demo "pedaling" threshold
const REFRESH_S = 0.2; // text refresh cadence (5 Hz, matches HUD's 4 Hz feel)
const MS_TO_KMH = 3.6;

interface Card {
  root: HTMLDivElement;
  value: HTMLDivElement;
}

export class RideHud {
  private fly: FlyCamera;
  private source: SensorSource | null;
  private root: HTMLDivElement;
  private speed: Card;
  private cadence: Card;
  private heart: Card;
  private visible: boolean;
  private last: { x: number; z: number } | null = null;
  private speedMs = 0;
  private acc = 0;
  /** DRAFT session recorder (.fit export via Ctrl+E) */
  private recorder = new RideRecorder();

  constructor(engine: Engine, fly: FlyCamera) {
    this.fly = fly;
    const ride = new URLSearchParams(window.location.search).get('ride');
    this.visible = ride !== null && ride !== '0';
    this.source = ride === 'demo' ? new DemoSensorSource() : null;

    this.root = document.createElement('div');
    this.root.id = 'ride-hud';
    this.root.style.cssText = [
      'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:1000', 'display:flex', 'gap:6px', 'align-items:stretch',
      'pointer-events:none',
    ].join(';');
    this.speed = makeCard('SPEED', 'km/h', '#e8f4ec');
    this.cadence = makeCard('CADENCE', 'rpm', '#bcd9ff');
    this.heart = makeCard('HEART RATE', 'bpm', '#ff8f88');
    this.root.append(this.speed.root, this.cadence.root, this.heart.root);
    if (this.source?.kind === 'demo') this.root.appendChild(makeDemoBadge());
    document.body.appendChild(this.root);
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

  private applyVisibility(): void {
    this.root.style.display = this.visible ? 'flex' : 'none';
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

    this.acc += dt;
    if (this.acc < REFRESH_S) return;
    this.acc = 0;
    if (!this.visible) return;
    const sample = this.source?.read() ?? { cadenceRpm: null, heartRateBpm: null };
    // session recording (1 Hz decimation inside; power arrives with M1.3)
    {
      const p = this.fly.getPose().p;
      this.recorder.addSample(Date.now(), p[0], p[2], p[1], this.speedMs, sample, null);
    }
    this.speed.value.textContent = kmh.toFixed(1);
    this.cadence.value.textContent = fmt(sample.cadenceRpm);
    this.heart.value.textContent = fmt(sample.heartRateBpm);
  }
}

function fmt(v: number | null): string {
  return v === null ? '—' : Math.round(v).toString();
}

function makeCard(label: string, unit: string, color: string): Card {
  const root = document.createElement('div');
  root.style.cssText = [
    'background:rgba(8,12,10,0.62)', 'border-radius:6px', 'padding:6px 12px 7px',
    'min-width:84px', 'text-align:center',
    'font:11px/1.2 ui-monospace,Menlo,monospace', 'color:#8fa89b',
  ].join(';');
  const labelEl = document.createElement('div');
  labelEl.textContent = label;
  labelEl.style.cssText = 'font-size:9px;letter-spacing:0.08em';
  const value = document.createElement('div');
  value.textContent = '—';
  value.style.cssText = `font-size:24px;font-weight:700;line-height:1.15;color:${color};font-variant-numeric:tabular-nums`;
  const unitEl = document.createElement('div');
  unitEl.textContent = unit;
  unitEl.style.cssText = 'font-size:9px';
  root.append(labelEl, value, unitEl);
  return { root, value };
}

function makeDemoBadge(): HTMLDivElement {
  const badge = document.createElement('div');
  badge.textContent = 'DEMO';
  badge.title = 'simulated cadence/HR — connect real sensors for real data';
  badge.style.cssText = [
    'background:rgba(64,44,4,0.75)', 'color:#ffb84d', 'border-radius:6px',
    'padding:2px 6px', 'font:bold 9px/1.2 ui-monospace,Menlo,monospace',
    'letter-spacing:0.1em', 'align-self:flex-start',
  ].join(';');
  return badge;
}
