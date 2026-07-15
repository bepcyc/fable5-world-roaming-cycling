/**
 * DeviceManagerUi — the Zwift-grade device manager. Replaces the old
 * slot-first ConnectUi (four fixed rows, each its own filtered chooser)
 * with the device-first shape the owner asked for:
 *
 *   [+ ADD DEVICE] → ONE chooser, every cycling-relevant service OR'd
 *   together (Transport.requestAnyDevice) → a card per connected device,
 *   its capabilities derived from the real GATT tree, not its name →
 *   5 role-assignment rows below, each a legible sentence
 *   ("POWER ← Assioma pedals · 242 W · LIVE") with a picker listing every
 *   device capable of that role plus "— none —" (sticky, real choice).
 *
 * A literal live-scanning radar is impossible on the web platform (no
 * background-scan API, requestDevice() shows exactly one chooser per
 * gesture) — this is the honest substitute: repeatable single-gesture
 * Add Device, building up a multi-device set one click at a time.
 *
 * Persistent HUD chip (top-right, matches the pre-rebuild #ble-panel
 * position): 5 dots, one per role, green=live/amber=stale-or-lost/
 * gray=unassigned. Click it (or `B`) to open the full manager over the
 * still-rendering ride — nothing pauses.
 */

import { t } from '../../core/I18n';
import type { Metric, Protocol, Role } from './Capabilities';
import type { BleSensorSource } from './BleSensorSource';
import type { ConnectionStage, PairedDevice } from './DeviceRegistry';
import type { RoleRow } from './RoleMux';

const ROLE_LABEL: Record<Role, string> = {
  power: 'POWER',
  cadence: 'CADENCE',
  speed: 'SPEED',
  heartRate: 'HEART',
  control: 'CONTROL',
};
const ROLE_ORDER: Role[] = ['power', 'cadence', 'speed', 'heartRate', 'control'];
const METRICS: Metric[] = ['power', 'cadence', 'speed', 'heartRate'];
const METRIC_UNIT: Record<Metric, string> = { power: 'W', cadence: 'rpm', speed: 'km/h', heartRate: 'bpm' };
const PROTOCOL_LABEL: Record<Protocol, string> = {
  ftms: 'FTMS',
  cps: 'Cycling Power',
  csc: 'CSC',
  hrs: 'Heart Rate',
  fec: 'Tacx FE-C',
};
const STAGE_LABEL: Record<ConnectionStage, string> = {
  connecting: 'CONNECTING…',
  discovering: 'DISCOVERING…',
  subscribing: 'SUBSCRIBING…',
  ready: 'READY',
  lost: 'LOST',
};

const STYLE = `
#ble-chip{position:fixed;top:10px;right:10px;z-index:999;display:flex;
  align-items:center;gap:6px;padding:6px 9px;border-radius:9px;cursor:pointer;
  font-family:ui-monospace,Menlo,Consolas,monospace;
  background:rgba(9,13,11,0.58);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,0.09);box-shadow:0 2px 10px rgba(0,0,0,0.25)}
#ble-chip .bc-lbl{font:bold 9px/1 ui-monospace,monospace;letter-spacing:0.1em;color:#cfe3d6}
#ble-chip .bc-dots{display:flex;gap:4px}
#ble-chip .bc-dot{width:6px;height:6px;border-radius:50%;background:#5a6a61}
#ble-chip .bc-dot.live{background:#7ee0a3;box-shadow:0 0 5px rgba(126,224,163,0.7)}
#ble-chip .bc-dot.warn{background:#ff8a70;box-shadow:0 0 5px rgba(255,138,112,0.6)}
#ble-mgr{position:fixed;inset:0;z-index:1001;display:none;
  background:rgba(4,6,5,0.72);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
  align-items:flex-start;justify-content:flex-end;padding:10px}
#ble-mgr.on{display:flex}
#ble-mgr .bm-card{width:min(420px,94vw);max-height:96vh;overflow-y:auto;
  font-family:ui-monospace,Menlo,Consolas,monospace;color:#dff0e6;
  background:rgba(12,16,14,0.94);border:1px solid rgba(255,255,255,0.12);
  border-radius:14px;padding:16px 16px 18px;box-shadow:0 8px 30px rgba(0,0,0,0.5)}
#ble-mgr .bm-title{display:flex;align-items:center;justify-content:space-between;
  font:bold 12px/1.2 ui-monospace,monospace;letter-spacing:0.14em;color:#ffe9b0;margin-bottom:10px}
#ble-mgr .bm-x{cursor:pointer;width:22px;height:22px;display:flex;align-items:center;
  justify-content:center;border-radius:6px;border:1px solid rgba(255,255,255,0.12);opacity:0.8}
#ble-mgr .bm-x:hover{opacity:1;background:rgba(255,255,255,0.08)}
#ble-mgr .bm-h{font:bold 9px/1.4 ui-monospace,monospace;letter-spacing:0.12em;
  color:#8fb39e;margin:14px 0 7px;text-transform:uppercase}
#ble-mgr .bm-note{font:10px/1.5 ui-monospace,monospace;color:#c9b9a4;margin-top:4px}
#ble-mgr .bm-btn{font:bold 10px/1 ui-monospace,monospace;letter-spacing:0.06em;
  color:#dff0e6;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);
  border-radius:8px;padding:9px 12px;cursor:pointer;text-align:center}
#ble-mgr .bm-btn:hover{background:rgba(255,255,255,0.15)}
#ble-mgr .bm-btn.primary{color:#1a1410;background:#ffd166;border-color:#ffd166;font-weight:bold}
#ble-mgr .bm-btn.primary:hover{background:#ffdb85}
#ble-mgr .bm-btn.small{padding:5px 8px;font-size:9px}
#ble-mgr .bm-btn.danger{color:#ffb09a;border-color:rgba(255,138,112,0.5)}
#ble-mgr .bm-link{font:9px/1.4 ui-monospace,monospace;color:#8fb39e;text-decoration:underline;
  cursor:pointer;margin-top:8px;display:inline-block}
#ble-mgr .bm-err{font:9px/1.4 ui-monospace,monospace;color:#ffb09a;margin-top:8px;white-space:pre-wrap}
#ble-mgr .bm-devcard{border:1px solid rgba(255,255,255,0.1);border-radius:10px;
  padding:10px 11px;margin-bottom:9px;background:rgba(255,255,255,0.03)}
#ble-mgr .bm-devcard.stage-lost{border-color:rgba(255,138,112,0.45)}
#ble-mgr .bm-devcard.stage-ready{border-color:rgba(126,224,163,0.3)}
#ble-mgr .bm-row1{display:flex;align-items:center;gap:7px}
#ble-mgr .bm-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#5a6a61}
#ble-mgr .bm-devcard.stage-ready .bm-dot{background:#7ee0a3;box-shadow:0 0 5px rgba(126,224,163,0.7)}
#ble-mgr .bm-devcard.stage-lost .bm-dot{background:#ff8a70;box-shadow:0 0 5px rgba(255,138,112,0.6)}
#ble-mgr .bm-devname{font:bold 11px/1.3 ui-monospace,monospace;flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ble-mgr .bm-stage{font:9px/1 ui-monospace,monospace;letter-spacing:0.06em;color:#8fb39e;flex:none}
#ble-mgr .bm-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
#ble-mgr .bm-chip{font:bold 8px/1 ui-monospace,monospace;letter-spacing:0.06em;
  padding:4px 7px;border-radius:999px;border:1px solid rgba(255,255,255,0.16);
  color:#a9bfb2;opacity:0.55}
#ble-mgr .bm-chip.live{opacity:1;color:#7ee0a3;border-color:rgba(126,224,163,0.5)}
#ble-mgr .bm-chip.assigned{opacity:1;color:#ffe9b0;border-color:rgba(255,209,102,0.6);
  box-shadow:0 0 0 1px rgba(255,209,102,0.25) inset}
#ble-mgr .bm-chip.stalewarn{color:#ffb09a;border-color:rgba(255,138,112,0.5);opacity:1}
#ble-mgr .bm-usedfor{font:9px/1.4 ui-monospace,monospace;color:#ffe9b0;opacity:0.85;margin-top:6px}
#ble-mgr .bm-vals{font:9px/1.6 ui-monospace,monospace;color:#a9bfb2;margin-top:6px}
#ble-mgr .bm-vals b{color:#dff0e6}
#ble-mgr .bm-cardbtns{display:flex;gap:6px;margin-top:9px}
#ble-mgr .bm-rolerow{border-top:1px solid rgba(255,255,255,0.07);padding:9px 0}
#ble-mgr .bm-rolesent{display:flex;align-items:baseline;gap:6px;cursor:pointer;flex-wrap:wrap}
#ble-mgr .bm-rolelbl{font:bold 10px/1.3 ui-monospace,monospace;letter-spacing:0.08em;
  color:#dff0e6;width:70px;flex:none}
#ble-mgr .bm-rolearrow{color:#5a6a61}
#ble-mgr .bm-roledev{color:#ffe9b0;font:10px/1.3 ui-monospace,monospace}
#ble-mgr .bm-roleval{color:#a9bfb2;font:10px/1.3 ui-monospace,monospace}
#ble-mgr .bm-rolestate{font:bold 8px/1 ui-monospace,monospace;letter-spacing:0.08em;padding:2px 6px;
  border-radius:999px;border:1px solid rgba(255,255,255,0.14)}
#ble-mgr .bm-rolestate.live{color:#7ee0a3;border-color:rgba(126,224,163,0.5)}
#ble-mgr .bm-rolestate.stale,#ble-mgr .bm-rolestate.disconnected{color:#ffb09a;border-color:rgba(255,138,112,0.5)}
#ble-mgr .bm-rolestate.unassigned,#ble-mgr .bm-rolestate.waiting,#ble-mgr .bm-rolestate.inactive{color:#8fb39e}
#ble-mgr .bm-picker{margin-top:7px;display:flex;flex-direction:column;gap:4px}
#ble-mgr .bm-pickopt{font:9px/1.3 ui-monospace,monospace;padding:6px 8px;border-radius:7px;
  border:1px solid rgba(255,255,255,0.1);cursor:pointer;color:#dff0e6;display:flex;justify-content:space-between}
#ble-mgr .bm-pickopt:hover{background:rgba(255,255,255,0.08)}
#ble-mgr .bm-pickopt.sel{border-color:rgba(255,209,102,0.6);color:#ffe9b0}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

export class DeviceManagerUi {
  private source: BleSensorSource;
  private chip: HTMLDivElement;
  private root: HTMLDivElement;
  private visible: boolean;
  private openPicker: Role | null = null;
  private lastError = '';

  constructor(source: BleSensorSource, startVisible: boolean) {
    this.source = source;
    this.visible = startVisible;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.chip = el('div');
    this.chip.id = 'ble-chip';
    const lbl = el('div', 'bc-lbl');
    lbl.textContent = 'BLE';
    const dots = el('div', 'bc-dots');
    for (const r of ROLE_ORDER) {
      const d = el('div', 'bc-dot');
      d.dataset['role'] = r;
      dots.appendChild(d);
    }
    this.chip.append(lbl, dots);
    this.chip.addEventListener('click', () => {
      this.visible = !this.visible;
      this.render();
    });
    document.body.appendChild(this.chip);

    this.root = el('div');
    this.root.id = 'ble-mgr';
    document.body.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyB') {
        this.visible = !this.visible;
        this.render();
      }
    });
    source.onChange(() => this.render());
    this.render();
  }

  /** probe/dbg API — open/close the full manager programmatically (real
   *  usage always goes through the chip click / `B` key, which is what
   *  exercises the same code path) */
  open(): void {
    this.visible = true;
    this.render();
  }
  close(): void {
    this.visible = false;
    this.render();
  }

  private async guarded(action: () => Promise<void>): Promise<void> {
    this.lastError = '';
    try {
      await action();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // chooser-cancel is a non-event, not an error
      if (!/cancel/i.test(msg)) this.lastError = msg;
    }
    this.render();
  }

  private render(): void {
    this.renderChip();
    this.root.className = this.visible ? 'on' : '';
    if (!this.visible) return;
    this.root.replaceChildren();
    const card = el('div', 'bm-card');

    const title = el('div', 'bm-title');
    // `label`, not `t`: `t` is the project-wide translate function, and a local
    // shadowing it here made t('ble.unavailable') a call on an HTMLSpanElement.
    const label = document.createElement('span');
    label.textContent = 'BLUETOOTH SENSORS';
    const x = el('div', 'bm-x');
    x.textContent = '\u2715';
    x.addEventListener('click', () => {
      this.visible = false;
      this.render();
    });
    title.append(label, x);
    card.appendChild(title);

    if (!this.source.available()) {
      const note = el('div', 'bm-note');
      note.innerHTML = t('ble.unavailable');
      card.appendChild(note);
      this.root.appendChild(card);
      return;
    }

    card.appendChild(this.buildDeviceSection());
    card.appendChild(this.buildRoleSection());

    if (this.lastError) {
      const err = el('div', 'bm-err');
      err.textContent = this.lastError;
      card.appendChild(err);
    }
    this.root.appendChild(card);
  }

  private renderChip(): void {
    const rows = this.source.registry.roleMux.rows();
    for (const el of this.chip.querySelectorAll<HTMLDivElement>('.bc-dot')) {
      const role = el.dataset['role'] as Role;
      const row = rows.find((r) => r.role === role);
      const warn = !!row && !!row.assignment && row.state !== 'unassigned' && row.state !== 'inactive' && row.state !== 'live';
      el.className = 'bc-dot' + (row?.state === 'live' ? ' live' : warn ? ' warn' : '');
    }
  }

  // ---- device section --------------------------------------------------------

  private buildDeviceSection(): HTMLElement {
    const wrap = document.createDocumentFragment() as unknown as HTMLElement;
    const h = el('div', 'bm-h');
    h.textContent = 'Known devices';
    wrap.appendChild(h);

    const devices = this.source.registry.list();
    if (devices.length === 0) {
      const note = el('div', 'bm-note');
      note.textContent = t('ble.noDevices');
      wrap.appendChild(note);
    }
    for (const d of devices) wrap.appendChild(this.buildDeviceCard(d));

    const btns = el('div', 'bm-cardbtns');
    const add = el('div', 'bm-btn primary');
    add.textContent = '+ ADD DEVICE';
    add.addEventListener('click', () => void this.guarded(() => this.source.registry.addDevice(false)));
    btns.appendChild(add);
    wrap.appendChild(btns);

    const allLink = el('div', 'bm-link');
    allLink.textContent = t('ble.showAll');
    allLink.addEventListener('click', () => void this.guarded(() => this.source.registry.addDevice(true)));
    wrap.appendChild(allLink);

    return wrap;
  }

  private buildDeviceCard(d: PairedDevice): HTMLElement {
    const mux = this.source.registry.roleMux;
    const card = el('div', `bm-devcard stage-${d.stage}`);

    const row1 = el('div', 'bm-row1');
    row1.appendChild(el('div', 'bm-dot'));
    const name = el('div', 'bm-devname');
    name.textContent = d.name;
    const stage = el('div', 'bm-stage');
    stage.textContent = STAGE_LABEL[d.stage];
    row1.append(name, stage);
    card.appendChild(row1);

    const chips = el('div', 'bm-chips');
    for (const protocol of d.protocols) {
      const caps = mux.capabilitiesFor(d.id, protocol);
      if (!caps) continue;
      for (const metric of METRICS) {
        if (!caps[metric]) continue;
        const s = mux.sampleFor(d.id, protocol, metric);
        const assignedTo = mux.assignmentFor(metric);
        const isAssigned = assignedTo !== null && assignedTo !== 'none' && assignedTo.deviceId === d.id && assignedTo.protocol === protocol;
        const chip = el('div', 'bm-chip');
        chip.classList.toggle('live', s?.state === 'live');
        chip.classList.toggle('assigned', isAssigned);
        chip.classList.toggle('stalewarn', isAssigned && (s?.state === 'stale' || s?.state === 'disconnected'));
        chip.title = `${PROTOCOL_LABEL[protocol]}`;
        chip.textContent = ROLE_LABEL[metric];
        chips.appendChild(chip);
      }
      const ctrl = mux.controlCapabilityFor(d.id, protocol);
      if (ctrl) {
        const assignedTo = mux.assignmentFor('control');
        const isAssigned = assignedTo !== null && assignedTo !== 'none' && assignedTo.deviceId === d.id && assignedTo.protocol === protocol;
        const active = mux.isActiveController(d.id, protocol);
        const chip = el('div', 'bm-chip');
        chip.classList.toggle('live', active);
        chip.classList.toggle('assigned', isAssigned);
        chip.title = `${PROTOCOL_LABEL[protocol]} — ${ctrl.simulation ? 'SIM' : ''}${ctrl.simulation && ctrl.targetPower ? '/' : ''}${ctrl.targetPower ? 'ERG' : ''}`;
        chip.textContent = 'CONTROL';
        chips.appendChild(chip);
      }
    }
    if (chips.childElementCount > 0) card.appendChild(chips);

    const used = mux.rolesFedBy(d.id);
    if (used.length > 0) {
      const tag = el('div', 'bm-usedfor');
      tag.textContent = `Used for: ${used.map((r) => ROLE_LABEL[r]).join(', ')}`;
      card.appendChild(tag);
    }

    const vals: string[] = [];
    for (const protocol of d.protocols) {
      for (const metric of METRICS) {
        const s = mux.sampleFor(d.id, protocol, metric);
        if (s && s.state === 'live' && s.value !== null) {
          vals.push(`${ROLE_LABEL[metric]} <b>${fmt(metric, s.value)}</b>`);
        }
      }
    }
    if (vals.length > 0) {
      const v = el('div', 'bm-vals');
      v.innerHTML = vals.join(' &nbsp;·&nbsp; ');
      card.appendChild(v);
    }
    if (d.lastError) {
      const err = el('div', 'bm-err');
      err.textContent = d.lastError;
      card.appendChild(err);
    }

    const btns = el('div', 'bm-cardbtns');
    if (d.stage === 'lost' || !d.handle) {
      const rc = el('div', 'bm-btn small');
      rc.textContent = 'RECONNECT';
      rc.addEventListener('click', () => void this.guarded(() => this.source.registry.reconnect()));
      btns.appendChild(rc);
    } else {
      const disc = el('div', 'bm-btn small');
      disc.textContent = 'DISCONNECT';
      disc.addEventListener('click', () => this.source.registry.disconnect(d.id));
      btns.appendChild(disc);
    }
    const forget = el('div', 'bm-btn small danger');
    forget.textContent = 'FORGET';
    forget.addEventListener('click', () => this.source.registry.forget(d.id));
    btns.appendChild(forget);
    card.appendChild(btns);

    return card;
  }

  // ---- role section -----------------------------------------------------------

  private buildRoleSection(): HTMLElement {
    const wrap = document.createDocumentFragment() as unknown as HTMLElement;
    const h = el('div', 'bm-h');
    h.textContent = 'Roles';
    wrap.appendChild(h);
    const rows = this.source.registry.roleMux.rows();
    for (const role of ROLE_ORDER) {
      const row = rows.find((r) => r.role === role);
      if (row) wrap.appendChild(this.buildRoleRow(row));
    }
    return wrap;
  }

  private buildRoleRow(row: RoleRow): HTMLElement {
    const mux = this.source.registry.roleMux;
    const wrap = el('div', 'bm-rolerow');
    const sent = el('div', 'bm-rolesent');
    const lbl = el('div', 'bm-rolelbl');
    lbl.textContent = ROLE_LABEL[row.role];
    sent.appendChild(lbl);
    sent.appendChild(document.createTextNode('←'));

    const a = row.assignment;
    if (a === null) {
      const dev = el('span', 'bm-roleval');
      dev.textContent = '— unassigned —';
      sent.appendChild(dev);
    } else if (a === 'none') {
      const dev = el('span', 'bm-roleval');
      dev.textContent = '— none —';
      sent.appendChild(dev);
    } else {
      const devName = mux.deviceNameFor(a.deviceId, a.protocol) ?? 'unknown device';
      const dev = el('span', 'bm-roledev');
      dev.textContent = devName;
      sent.appendChild(dev);
      if (row.value !== null) {
        const val = el('span', 'bm-roleval');
        val.textContent = `· ${fmt(row.role === 'control' ? 'power' : (row.role as Metric), row.value)}`;
        sent.appendChild(val);
      }
    }
    const state = el('span', `bm-rolestate ${row.state}`);
    state.textContent = row.state.toUpperCase();
    sent.appendChild(state);

    sent.addEventListener('click', () => {
      this.openPicker = this.openPicker === row.role ? null : row.role;
      this.render();
    });
    wrap.appendChild(sent);

    if (this.openPicker === row.role) {
      const picker = el('div', 'bm-picker');
      const noneOpt = el('div', `bm-pickopt${a === 'none' ? ' sel' : ''}`);
      noneOpt.textContent = '— none —';
      noneOpt.addEventListener('click', () => {
        mux.assign(row.role, 'none');
        this.openPicker = null;
        this.render();
      });
      picker.appendChild(noneOpt);
      for (const c of row.candidates) {
        const sel = a !== null && a !== 'none' && a.deviceId === c.deviceId && a.protocol === c.protocol;
        const opt = el('div', `bm-pickopt${sel ? ' sel' : ''}`);
        const left = document.createElement('span');
        left.textContent = c.deviceName;
        const right = document.createElement('span');
        right.textContent = PROTOCOL_LABEL[c.protocol];
        opt.append(left, right);
        opt.addEventListener('click', () => {
          mux.assign(row.role, { deviceId: c.deviceId, protocol: c.protocol });
          this.openPicker = null;
          this.render();
        });
        picker.appendChild(opt);
      }
      wrap.appendChild(picker);
    }
    return wrap;
  }
}

function fmt(metric: Metric, value: number): string {
  const unit = METRIC_UNIT[metric];
  const v = metric === 'power' || metric === 'heartRate' ? Math.round(value) : Math.round(value * 10) / 10;
  return `${v} ${unit}`;
}
