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
 * gray=unassigned. Click it (or `N`) to open the full manager over the
 * still-rendering ride — nothing pauses. (`N`, not `B`: `B` toggles the
 * ride HUD in RideHud, and one keycode driving both handlers hid the whole
 * dashboard every time you opened the manager — UX-15a.)
 *
 * Sensor-loss watchdog: when an ASSIGNED role goes stale/disconnected mid-ride
 * a tappable "Sensor lost — tap to reconnect" banner appears. Web Bluetooth
 * has no silent reconnect we can depend on (getDevices()/watchAdvertisements
 * are flag-gated), so honest recovery is a one-tap gesture that re-opens the
 * chooser — this is the web's Zwift-path, surfaced instead of leaving the
 * rider to notice "suddenly heavy and stopped" (UX-13/15c).
 */

import { t } from '../../core/I18n';
import { announceMenuOpen, onOtherMenuOpen } from '../../core/MenuBus';
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
/* sensor-loss watchdog banner — tappable, top-center below the HUD (UX-15c).
   min-height 48 so a finger can reliably hit it; the tap IS the Web-Bluetooth
   reconnect gesture. */
#ble-lost-banner{position:fixed;top:96px;left:50%;transform:translateX(-50%);
  z-index:1002;display:none;align-items:center;gap:9px;cursor:pointer;
  padding:11px 18px;border-radius:12px;min-height:48px;box-sizing:border-box;
  font:bold 12px/1.25 ui-monospace,Menlo,Consolas,monospace;letter-spacing:0.04em;
  color:#ffd9c9;background:rgba(44,12,8,0.86);border:1px solid rgba(255,120,90,0.6);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  box-shadow:0 3px 16px rgba(0,0,0,0.45);pointer-events:auto;text-transform:uppercase;
  text-align:center;max-width:min(92vw,460px)}
#ble-lost-banner.on{display:flex}
#ble-lost-banner .bl-ico{width:18px;height:18px;flex:none}
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
  private lostBanner!: HTMLDivElement;
  private visible: boolean;
  private openPicker: Role | null = null;
  private lastError = '';
  /** test seam: force the loss condition on regardless of live role state,
   *  so probes can exercise the banner + reconnect click without waiting out
   *  a real 3 s staleness on a scripted device (see forceSensorLost) */
  private forceLost = false;
  /** how many times the reconnect gesture has fired (probe assertion) */
  reconnectAttempts = 0;

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
    // backdrop tap/click closes (one-overlay UX rule): the manager fills the
    // screen with a dimmed veil — tapping outside the card is the universal
    // "dismiss" gesture and previously did nothing
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    document.body.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      // `N` (not `B`): `B` is RideHud's dashboard toggle. Two window-keydown
      // handlers on one keycode hid the HUD every time the manager opened
      // (UX-15a). `N` for "network"/sensors is otherwise unused.
      if (e.code === 'KeyN') {
        this.visible = !this.visible;
        this.render();
      }
      // Escape closes the manager when it is the open overlay (GameMenu's
      // pause handler defers to any open overlay, so this is the only
      // consumer of the press)
      if (e.code === 'Escape' && this.visible) {
        this.close();
      }
    });
    // one overlay at a time: opening pause/options/graphics dismisses this
    onOtherMenuOpen('ble-mgr', () => {
      if (this.visible) this.close();
    });
    source.onChange(() => {
      this.render();
      this.updateWatchdog();
    });
    this.buildLostBanner();
    // staleness is time-based (RoleMux marks a role stale ~3 s after its last
    // packet) and may not fire onChange, so poll the watchdog too
    window.setInterval(() => this.updateWatchdog(), 1200);
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

  // ---- sensor-loss watchdog (UX-15c) ----------------------------------------

  private buildLostBanner(): void {
    this.lostBanner = el('div');
    this.lostBanner.id = 'ble-lost-banner';
    this.lostBanner.setAttribute('role', 'button');
    this.lostBanner.innerHTML =
      '<svg class="bl-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v17l4.5-4L9 9.5M12 12l4.5-4L12 3.5"/><path d="M4 4l16 16"/></svg>' +
      `<span>${t('ble.sensorLost')}</span>`;
    this.lostBanner.setAttribute('aria-label', t('ble.sensorLost'));
    // the tap IS the Web-Bluetooth reconnect gesture
    this.lostBanner.addEventListener('click', () => void this.reconnectLost());
    document.body.appendChild(this.lostBanner);
  }

  /** any ASSIGNED role whose live provider has gone quiet/dropped */
  private hasLostRole(): boolean {
    return this.source.registry.roleMux
      .rows()
      .some(
        (r) =>
          r.assignment !== null &&
          r.assignment !== 'none' &&
          (r.state === 'stale' || r.state === 'disconnected'),
      );
  }

  private updateWatchdog(): void {
    const lost = this.forceLost || (this.source.available() && this.hasLostRole());
    this.lostBanner.classList.toggle('on', lost);
  }

  /** the banner tap: a user gesture, so it's allowed to open the chooser.
   *  Reconnect is a fresh chooser (Web Bluetooth has no silent path we depend
   *  on) — DeviceRegistry.reconnect() re-matches the stable device id. */
  private async reconnectLost(): Promise<void> {
    this.reconnectAttempts++;
    this.forceLost = false; // a real reconnect resolves the artificial trigger
    this.lostBanner.classList.remove('on'); // optimistic; watchdog re-shows if still lost
    await this.guarded(() => this.source.registry.reconnect());
    this.updateWatchdog();
  }

  /** probe/test seam: force the loss banner on/off (see forceLost) */
  forceSensorLost(on: boolean): void {
    this.forceLost = on;
    this.updateWatchdog();
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
    const wasOn = this.root.className === 'on';
    this.root.className = this.visible ? 'on' : '';
    if (!this.visible) return;
    if (!wasOn) announceMenuOpen('ble-mgr'); // closes every other overlay
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

    // ONE CHIP PER METRIC, not per (protocol, metric). The owner's Tacx reports
    // cadence over BOTH Cycling Power (0x1818) and CSC (0x1816), so the old
    // per-protocol loop drew two identical CADENCE chips and a values line
    // reading "CADENCE 0 rpm · CADENCE 0 rpm". The owner called that a bug
    // (2026-07-15) and he is right: cadence is ONE physical quantity, and a
    // panel that shows it twice is asking the rider to care about our protocol
    // plumbing. Which protocols carry it IS real information, so it moves into
    // the chip's tooltip instead of being duplicated on screen.
    const chips = el('div', 'bm-chips');
    for (const metric of METRICS) {
      const carriers = d.protocols.filter((p) => mux.capabilitiesFor(d.id, p)?.[metric]);
      if (carriers.length === 0) continue;
      const a = mux.assignmentFor(metric);
      const assignedHere = a !== null && a !== 'none' && a.deviceId === d.id && carriers.includes(a.protocol);
      // staleness is only meaningful for the protocol actually feeding the
      // role — a second, unassigned carrier going quiet is not a warning
      // (`assignedHere` already narrows `a` to the object form: TS narrows
      // through aliased conditions, so re-testing it here would be dead code)
      const assignedSample = assignedHere ? mux.sampleFor(d.id, a.protocol, metric) : null;
      const anyLive = carriers.some((p) => mux.sampleFor(d.id, p, metric)?.state === 'live');
      const chip = el('div', 'bm-chip');
      chip.classList.toggle('live', anyLive);
      chip.classList.toggle('assigned', assignedHere);
      chip.classList.toggle(
        'stalewarn',
        assignedHere && (assignedSample?.state === 'stale' || assignedSample?.state === 'disconnected'),
      );
      chip.title = carriers.map((p) => PROTOCOL_LABEL[p]).join(' + ');
      chip.textContent = ROLE_LABEL[metric];
      chips.appendChild(chip);
    }
    // likewise one CONTROL chip, though FTMS and FE-C can both offer control
    const ctrlCarriers = d.protocols.filter((p) => mux.controlCapabilityFor(d.id, p));
    if (ctrlCarriers.length > 0) {
      const a = mux.assignmentFor('control');
      const assignedHere = a !== null && a !== 'none' && a.deviceId === d.id && ctrlCarriers.includes(a.protocol);
      const chip = el('div', 'bm-chip');
      chip.classList.toggle('live', ctrlCarriers.some((p) => mux.isActiveController(d.id, p)));
      chip.classList.toggle('assigned', assignedHere);
      chip.title = ctrlCarriers
        .map((p) => {
          const c = mux.controlCapabilityFor(d.id, p);
          const modes = [c?.simulation ? 'SIM' : null, c?.targetPower ? 'ERG' : null].filter(Boolean).join('/');
          return `${PROTOCOL_LABEL[p]}${modes ? ` — ${modes}` : ''}`;
        })
        .join(' + ');
      chip.textContent = 'CONTROL';
      chips.appendChild(chip);
    }
    if (chips.childElementCount > 0) card.appendChild(chips);

    const used = mux.rolesFedBy(d.id);
    if (used.length > 0) {
      const tag = el('div', 'bm-usedfor');
      tag.textContent = `Used for: ${used.map((r) => ROLE_LABEL[r]).join(', ')}`;
      card.appendChild(tag);
    }

    // one reading per metric, for the same reason as the chips above: the
    // protocol actually feeding the role if this device holds it, else the
    // first carrier that is genuinely streaming
    const vals: string[] = [];
    for (const metric of METRICS) {
      const carriers = d.protocols.filter((p) => mux.capabilitiesFor(d.id, p)?.[metric]);
      const a = mux.assignmentFor(metric);
      const preferred = a !== null && a !== 'none' && a.deviceId === d.id && carriers.includes(a.protocol) ? a.protocol : null;
      const order = preferred ? [preferred, ...carriers.filter((p) => p !== preferred)] : carriers;
      for (const p of order) {
        const s = mux.sampleFor(d.id, p, metric);
        if (s && s.state === 'live' && s.value !== null) {
          vals.push(`${ROLE_LABEL[metric]} <b>${fmt(metric, s.value)}</b>`);
          break;
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
