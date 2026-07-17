/**
 * DeviceManagerUi — the Zwift-grade device manager, rebuilt as a role-card HUB
 * (one card per role) + a per-role PAIR modal, matching reference/zwift-ux/*.
 *
 *   HUB (#ble-mgr.on): a "PAIRED DEVICES" grid of ONE CARD PER ROLE —
 *   Power source / Resistance(control) / Cadence / Speed / Heart rate. Each
 *   card shows a role glyph, the LIVE VALUE (0 watts / 76 bpm …), the assigned
 *   device name with a BLE glyph, and a bold status strip at the bottom
 *   (CONNECTED green ✓ · SEARCH amber · LOST red · CONNECTING… amber pulse).
 *   A "known devices" strip below the grid keeps per-device
 *   reconnect/disconnect/FORGET reachable.
 *
 *   PAIR modal: tapping a role card opens it — title bar, a two-pill filter
 *   toggle (RECOMMENDED = service-filtered scan / ALL = every sensor), the
 *   list of candidate devices for that role (one tap assigns it), an animated
 *   spinner + "Looking for devices…" while a scan is in flight, a wake-the-
 *   sensor hint, and a single prominent CLOSE. One tap on a connected device
 *   lets RoleMux auto-assign every role it can serve; the hub reflects it
 *   instantly.
 *
 * A literal live-scanning radar is impossible on the web platform (no
 * background-scan API — requestDevice() shows exactly one browser chooser per
 * gesture), so the modal's SEARCH button is the honest single-gesture scan;
 * on the native APK NativeBridgeTransport draws its own in-page chooser.
 *
 * Persistent HUD chip (#ble-chip, top-right): 5 dots, one per role,
 * green=live / amber=stale-or-lost / gray=unassigned. Click it (or `N`) to
 * open the hub over the still-rendering ride — nothing pauses. (`N`, not `B`:
 * `B` toggles the ride HUD in RideHud, and one keycode driving both handlers
 * hid the whole dashboard every time you opened the manager — UX-15a.)
 *
 * Sensor-loss watchdog (#ble-lost-banner): when an ASSIGNED role goes
 * stale/disconnected mid-ride a tappable "Sensor lost — tap to reconnect"
 * banner appears. Web Bluetooth has no silent reconnect we can depend on, so
 * honest recovery is a one-tap gesture that re-opens the chooser (UX-13/15c).
 */

import { t } from '../../core/I18n';
import { announceMenuOpen, onOtherMenuOpen } from '../../core/MenuBus';
import type { Metric, Protocol, Role } from './Capabilities';
import type { BleSensorSource } from './BleSensorSource';
import type { ConnectionStage, PairedDevice } from './DeviceRegistry';
import type { RoleRow } from './RoleMux';

/** compact metric tag, reused on the device-card chips */
const ROLE_LABEL: Record<Role, string> = {
  power: 'POWER',
  cadence: 'CADENCE',
  speed: 'SPEED',
  heartRate: 'HEART',
  control: 'CONTROL',
};
/** chip-dot order on #ble-chip (unchanged) */
const ROLE_ORDER: Role[] = ['power', 'cadence', 'speed', 'heartRate', 'control'];
/** role-card grid order — power + resistance lead, echoing the reference hub */
const HUB_ORDER: Role[] = ['power', 'control', 'cadence', 'speed', 'heartRate'];
const METRICS: Metric[] = ['power', 'cadence', 'speed', 'heartRate'];
const METRIC_UNIT: Record<Metric, string> = { power: 'watts', cadence: 'rpm', speed: 'km/h', heartRate: 'bpm' };
const PROTOCOL_LABEL: Record<Protocol, string> = {
  ftms: 'FTMS',
  cps: 'Cycling Power',
  csc: 'CSC',
  hrs: 'Heart Rate',
  fec: 'Tacx FE-C',
  lf: 'Life Fitness',
  c2: 'Concept2 PM5',
  x70: 'Schwinn X70',
  precor: 'Precor',
  kf: 'KayakFirst',
  rsc: 'RSC',
};
const STAGE_LABEL: Record<ConnectionStage, string> = {
  connecting: 'CONNECTING…',
  discovering: 'DISCOVERING…',
  subscribing: 'SUBSCRIBING…',
  ready: 'READY',
  lost: 'LOST',
};
/** the metric a role-card ticker reads (control has no numeric value) */
const ROLE_METRIC: Partial<Record<Role, Metric>> = {
  power: 'power',
  cadence: 'cadence',
  speed: 'speed',
  heartRate: 'heartRate',
};

// ---- glyphs (decorative, stroke/fill currentColor — our accent palette) --------
const G = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ROLE_GLYPH: Record<Role, string> = {
  power: G('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="currentColor" stroke-width="1"/>'),
  cadence: G('<circle cx="12" cy="12" r="8"/><path d="M12 12l4-2"/><path d="M20 6v4h-4"/><path d="M20 10a8 8 0 1 0-2 5"/>'),
  speed: G('<path d="M4 19a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><circle cx="12" cy="15" r="1.3" fill="currentColor"/>'),
  heartRate: G('<path d="M20.4 6.6a4.6 4.6 0 0 0-8.4-1.9A4.6 4.6 0 0 0 3.6 6.6c0 3.8 4.4 7.1 8.4 10.5 4-3.4 8.4-6.7 8.4-10.5Z"/><path d="M3.6 12h4l1.5-3 2 6 1.5-3h7.8"/>'),
  control: G('<path d="M4 8h8M18 8h2"/><circle cx="15" cy="8" r="2.2"/><path d="M4 16h2M12 16h8"/><circle cx="9" cy="16" r="2.2"/>'),
};
const BLE_GLYPH = `<svg class="bm-ble" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7.5 16 16.5 12 20V4l4 3.5L8 16.5"/></svg>`;
const CHECK_GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const DOT_GLYPH = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>`;

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
  align-items:center;justify-content:center;padding:14px}
#ble-mgr.on{display:flex}
#ble-mgr .bm-card{position:relative;width:min(560px,96vw);max-height:94vh;overflow-y:auto;
  font-family:ui-monospace,Menlo,Consolas,monospace;color:#dff0e6;
  background:rgba(12,16,14,0.94);border:1px solid rgba(255,255,255,0.12);
  border-radius:16px;padding:18px 18px 20px;box-shadow:0 8px 30px rgba(0,0,0,0.5)}
#ble-mgr .bm-title{display:flex;align-items:center;justify-content:space-between;
  font:bold 13px/1.2 ui-monospace,monospace;letter-spacing:0.16em;color:#ffe9b0}
#ble-mgr .bm-x{cursor:pointer;width:24px;height:24px;display:flex;align-items:center;
  justify-content:center;border-radius:6px;border:1px solid rgba(255,255,255,0.12);opacity:0.8}
#ble-mgr .bm-x:hover{opacity:1;background:rgba(255,255,255,0.08)}
#ble-mgr .bm-sub{font:10px/1.4 ui-monospace,monospace;color:#8fb39e;margin:6px 0 14px}
#ble-mgr .bm-h{font:bold 9px/1.4 ui-monospace,monospace;letter-spacing:0.12em;
  color:#8fb39e;margin:16px 0 8px;text-transform:uppercase}
#ble-mgr .bm-note{font:10px/1.5 ui-monospace,monospace;color:#c9b9a4;margin-top:4px}
#ble-mgr .bm-btn{font:bold 10px/1 ui-monospace,monospace;letter-spacing:0.06em;
  color:#dff0e6;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);
  border-radius:8px;padding:9px 12px;cursor:pointer;text-align:center}
#ble-mgr .bm-btn:hover{background:rgba(255,255,255,0.15)}
#ble-mgr .bm-btn.primary{color:#1a1410;background:#ffd166;border-color:#ffd166;font-weight:bold}
#ble-mgr .bm-btn.primary:hover{background:#ffdb85}
#ble-mgr .bm-btn.big{padding:14px;font-size:12px;letter-spacing:0.1em;border-radius:11px}
#ble-mgr .bm-btn.small{padding:6px 9px;font-size:9px}
#ble-mgr .bm-btn.danger{color:#ffb09a;border-color:rgba(255,138,112,0.5)}
#ble-mgr .bm-btn.danger:hover{background:rgba(255,138,112,0.12)}
#ble-mgr .bm-link{font:9px/1.4 ui-monospace,monospace;color:#8fb39e;text-decoration:underline;
  cursor:pointer;margin-top:8px;display:inline-block}
#ble-mgr .bm-err{font:9px/1.4 ui-monospace,monospace;color:#ffb09a;margin-top:8px;white-space:pre-wrap}
/* ---- role-card hub ------------------------------------------------------- */
#ble-mgr .bm-rolegrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
#ble-mgr .bm-rolecard{position:relative;display:flex;flex-direction:column;min-height:122px;
  border-radius:13px;padding:12px 13px 0;cursor:pointer;overflow:hidden;
  border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.03);
  transition:border-color 0.12s ease,transform 0.06s ease}
#ble-mgr .bm-rolecard:hover{border-color:rgba(255,255,255,0.3)}
#ble-mgr .bm-rolecard:active{transform:scale(0.985)}
#ble-mgr .bm-rc-head{font:bold 10px/1.2 ui-monospace,monospace;letter-spacing:0.1em;color:#cfe3d6}
#ble-mgr .bm-rc-body{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:1;padding:6px 0}
#ble-mgr .bm-rc-ico{width:40px;height:40px;flex:none;color:#dff0e6;opacity:0.92}
#ble-mgr .bm-rc-ico svg{width:100%;height:100%}
#ble-mgr .bm-rc-val{text-align:right;line-height:1;min-width:0}
#ble-mgr .bm-rc-num{font:bold 27px/1 ui-monospace,monospace;color:#eef7f0}
#ble-mgr .bm-rc-unit{display:block;font:9px/1 ui-monospace,monospace;color:#8fb39e;letter-spacing:0.05em;margin-top:3px}
#ble-mgr .bm-rc-dev{display:flex;align-items:center;gap:5px;font:10px/1.3 ui-monospace,monospace;
  color:#ffe9b0;min-height:15px;overflow:hidden}
#ble-mgr .bm-rc-dev .bm-rc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ble-mgr .bm-ble{width:9px;height:12px;flex:none;opacity:0.75}
#ble-mgr .bm-rc-status{margin:9px -13px 0;padding:8px 13px;display:flex;align-items:center;gap:6px;
  font:bold 9px/1 ui-monospace,monospace;letter-spacing:0.1em;background:rgba(0,0,0,0.34);color:#8fb39e}
#ble-mgr .bm-rc-status svg{width:13px;height:13px;flex:none}
#ble-mgr .bm-rolecard.state-live{border-color:rgba(126,224,163,0.42);background:rgba(28,52,42,0.34)}
#ble-mgr .bm-rolecard.state-live .bm-rc-status{color:#7ee0a3}
#ble-mgr .bm-rolecard.state-live .bm-rc-ico{color:#a9e6c2}
#ble-mgr .bm-rolecard.state-search{border-color:rgba(255,209,102,0.42);background:rgba(58,45,20,0.32)}
#ble-mgr .bm-rolecard.state-search .bm-rc-status{color:#ffd166}
#ble-mgr .bm-rolecard.state-search .bm-rc-ico{opacity:0.5}
#ble-mgr .bm-rolecard.state-busy{border-color:rgba(255,209,102,0.5);background:rgba(58,45,20,0.32)}
#ble-mgr .bm-rolecard.state-busy .bm-rc-status{color:#ffd166}
#ble-mgr .bm-rolecard.state-busy .bm-rc-ico{color:#ffd166;animation:bmPulse 0.9s ease-in-out infinite}
#ble-mgr .bm-rolecard.state-lost{border-color:rgba(255,138,112,0.5);background:rgba(58,26,20,0.34)}
#ble-mgr .bm-rolecard.state-lost .bm-rc-status{color:#ff8a70}
#ble-mgr .bm-rolecard.state-lost .bm-rc-ico{color:#ffb09a}
@keyframes bmPulse{0%,100%{opacity:1}50%{opacity:0.35}}
/* ---- known-devices strip ------------------------------------------------- */
#ble-mgr .bm-devcard{border:1px solid rgba(255,255,255,0.1);border-radius:10px;
  padding:10px 11px;margin-bottom:9px;background:rgba(255,255,255,0.03)}
#ble-mgr .bm-devcard.stage-lost{border-color:rgba(255,138,112,0.45)}
#ble-mgr .bm-devcard.stage-ready{border-color:rgba(126,224,163,0.3)}
#ble-mgr .bm-row1{display:flex;align-items:center;gap:7px}
#ble-mgr .bm-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#5a6a61}
#ble-mgr .bm-devcard.stage-ready .bm-dot{background:#7ee0a3;box-shadow:0 0 5px rgba(126,224,163,0.7)}
#ble-mgr .bm-devcard.stage-lost .bm-dot{background:#ff8a70;box-shadow:0 0 5px rgba(255,138,112,0.6)}
#ble-mgr .bm-devcard.stage-connecting .bm-dot,
#ble-mgr .bm-devcard.stage-discovering .bm-dot,
#ble-mgr .bm-devcard.stage-subscribing .bm-dot{background:#ffd166;
  box-shadow:0 0 5px rgba(255,209,102,0.7);animation:bmPulse 0.9s ease-in-out infinite}
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
/* ---- per-role pair modal ------------------------------------------------- */
#ble-mgr .bm-pair{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
  padding:14px;z-index:3;background:rgba(4,6,5,0.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
#ble-mgr .bm-pairpanel{width:min(440px,92%);max-height:86vh;overflow:hidden;display:flex;flex-direction:column;
  background:rgba(12,16,14,0.98);border:1px solid rgba(255,255,255,0.14);border-radius:15px;
  box-shadow:0 10px 34px rgba(0,0,0,0.6)}
#ble-mgr .bm-pairbar{display:flex;align-items:center;justify-content:space-between;flex:none;
  padding:12px 15px;background:rgba(0,0,0,0.4);border-bottom:1px solid rgba(255,255,255,0.08);
  font:bold 12px/1.2 ui-monospace,monospace;letter-spacing:0.14em;color:#ffe9b0}
#ble-mgr .bm-pairbar .bm-x{border-color:rgba(255,255,255,0.18)}
#ble-mgr .bm-pairbody{padding:14px 15px 16px;overflow-y:auto;display:flex;flex-direction:column}
#ble-mgr .bm-filters-lbl{font:bold 8px/1 ui-monospace,monospace;letter-spacing:0.14em;color:#8fb39e;margin-bottom:7px}
#ble-mgr .bm-pillrow{display:flex;gap:7px;margin-bottom:13px}
#ble-mgr .bm-pill{flex:1;text-align:center;padding:9px;border-radius:9px;cursor:pointer;
  font:bold 10px/1 ui-monospace,monospace;letter-spacing:0.08em;color:#a9bfb2;
  background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.16)}
#ble-mgr .bm-pill:hover{border-color:rgba(255,255,255,0.32)}
#ble-mgr .bm-pill.on{color:#1a1410;background:#ffd166;border-color:#ffd166}
#ble-mgr .bm-list{display:flex;flex-direction:column;gap:6px;min-height:74px;margin-bottom:11px}
#ble-mgr .bm-pickopt{font:10px/1.3 ui-monospace,monospace;padding:10px 11px;border-radius:9px;
  border:1px solid rgba(255,255,255,0.12);cursor:pointer;color:#dff0e6;
  display:flex;align-items:center;gap:9px;background:rgba(255,255,255,0.03)}
#ble-mgr .bm-pickopt:hover{background:rgba(255,255,255,0.09)}
#ble-mgr .bm-pickopt.sel{border-color:rgba(126,224,163,0.55);background:rgba(28,52,42,0.3)}
#ble-mgr .bm-radio{width:14px;height:14px;border-radius:50%;flex:none;
  border:2px solid rgba(255,255,255,0.28);box-sizing:border-box}
#ble-mgr .bm-pickopt.sel .bm-radio{border-color:#7ee0a3;background:radial-gradient(circle,#7ee0a3 0 40%,transparent 46%)}
#ble-mgr .bm-pickopt .bm-pk-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:bold}
#ble-mgr .bm-pickopt .bm-pk-proto{font:8px/1 ui-monospace,monospace;letter-spacing:0.06em;color:#8fb39e;flex:none}
#ble-mgr .bm-pickopt .bm-ble{color:#bcd9ff}
#ble-mgr .bm-scanning{display:flex;flex-direction:column;align-items:center;gap:11px;padding:18px 0;
  color:#8fb39e;font:10px/1 ui-monospace,monospace;letter-spacing:0.06em}
#ble-mgr .bm-spinner{width:26px;height:26px;border-radius:50%;
  border:3px solid rgba(255,255,255,0.14);border-top-color:#ffd166;animation:bmSpin 0.8s linear infinite}
@keyframes bmSpin{to{transform:rotate(360deg)}}
#ble-mgr .bm-hint{display:flex;gap:9px;align-items:flex-start;padding:10px 11px;border-radius:10px;cursor:pointer;
  background:rgba(0,0,0,0.32);border:1px solid rgba(255,255,255,0.08);margin-bottom:13px}
#ble-mgr .bm-hint svg{width:16px;height:16px;flex:none;color:#8fb39e;margin-top:1px}
#ble-mgr .bm-hint .bm-hint-t{font:9px/1.5 ui-monospace,monospace;color:#c9b9a4}
#ble-mgr .bm-pair-actions{display:flex;gap:8px}
#ble-mgr .bm-pair-actions .bm-btn{flex:1}
/* sensor-loss watchdog banner — tappable, top-center below the HUD (UX-15c). */
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

function roleCardLabel(role: Role): string {
  return t(`ble.role.${role}`);
}

export class DeviceManagerUi {
  private source: BleSensorSource;
  private chip: HTMLDivElement;
  private root: HTMLDivElement;
  private lostBanner!: HTMLDivElement;
  private visible: boolean;
  /** which role's PAIR modal is open (null = hub view; 'add' = generic add) */
  private pairRole: Role | 'add' | null = null;
  /** RECOMMENDED (false) vs ALL (true) pill — which scan variant SEARCH uses */
  private pairAll = false;
  /** true while an addDevice() gesture is awaiting the chooser/connect */
  private scanning = false;
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
      if (!this.visible) this.pairRole = null;
      this.render();
    });
    document.body.appendChild(this.chip);

    this.root = el('div');
    this.root.id = 'ble-mgr';
    // backdrop tap/click closes: with a pair modal open it steps back to the
    // hub, otherwise it dismisses the whole manager (one-overlay UX rule).
    this.root.addEventListener('click', (e) => {
      if (e.target !== this.root) return;
      if (this.pairRole !== null) this.closePair();
      else this.close();
    });
    document.body.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      // `N` (not `B`): `B` is RideHud's dashboard toggle. Two window-keydown
      // handlers on one keycode hid the HUD every time the manager opened
      // (UX-15a). `N` for "network"/sensors is otherwise unused.
      if (e.code === 'KeyN') {
        this.visible = !this.visible;
        if (!this.visible) this.pairRole = null;
        this.render();
      }
      // Escape steps back: a pair modal first, then the manager (GameMenu's
      // pause handler defers to any open overlay, so this is the only consumer
      // of the press).
      if (e.code === 'Escape' && this.visible) {
        if (this.pairRole !== null) this.closePair();
        else this.close();
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
    // packet) and often does NOT fire onChange, and live values tick with no
    // onChange either — so poll: refresh the visible hub AND the watchdog. The
    // pair modal's scan spinner is skipped from re-render so its CSS animation
    // does not restart every tick.
    window.setInterval(() => {
      this.updateWatchdog();
      if (this.visible && !this.scanning) this.render();
    }, 1000);
    this.render();
  }

  /** probe/dbg API — open/close the full manager programmatically (real
   *  usage always goes through the chip click / `N` key, which is what
   *  exercises the same code path) */
  open(): void {
    this.visible = true;
    this.render();
  }
  close(): void {
    this.visible = false;
    this.pairRole = null;
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
    // suppressed while the hub is open: the role cards already show the lost
    // state there, and the banner physically overlapped the hub title
    // (caught on the first live screenshot of the redesign)
    const lost =
      !this.visible && (this.forceLost || (this.source.available() && this.hasLostRole()));
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

  // ---- render ----------------------------------------------------------------

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
    label.textContent = t('ble.pairedDevices');
    const x = el('div', 'bm-x');
    x.textContent = '✕';
    x.addEventListener('click', () => this.close());
    title.append(label, x);
    card.appendChild(title);

    if (!this.source.available()) {
      const note = el('div', 'bm-note');
      note.innerHTML = t('ble.unavailable');
      card.appendChild(note);
      this.root.appendChild(card);
      return;
    }

    const sub = el('div', 'bm-sub');
    sub.textContent = t('ble.subtitle');
    card.appendChild(sub);

    card.appendChild(this.buildRoleGrid());
    card.appendChild(this.buildKnownDevices());

    if (this.lastError) {
      const err = el('div', 'bm-err');
      err.textContent = this.lastError;
      card.appendChild(err);
    }
    this.root.appendChild(card);

    // the pair modal is pinned to the manager viewport (a sibling of the
    // scrollable card), so a scrolled hub can never push it off-screen
    if (this.pairRole !== null) this.root.appendChild(this.buildPairModal());
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

  // ---- role-card hub ---------------------------------------------------------

  private buildRoleGrid(): HTMLElement {
    const grid = el('div', 'bm-rolegrid');
    const rows = this.source.registry.roleMux.rows();
    const byId = new Map(this.source.registry.list().map((d) => [d.id, d]));
    for (const role of HUB_ORDER) {
      const row = rows.find((r) => r.role === role);
      if (row) grid.appendChild(this.buildRoleCard(row, byId));
    }
    return grid;
  }

  /**
   * ONE card per role, class `bm-rolecard` — and ALSO `bm-rolerow` so the
   * headless DOM probe (tools/probe-ble.ts asserts exactly 5 `.bm-rolerow`)
   * keeps passing across the hub rebuild. Card state is a blend of the role's
   * own RoleRow.state and, for in-flight connections, the feeding device's
   * ConnectionStage (so "connecting/discovering/subscribing" reads as amber
   * ACTIVITY, not red-until-suddenly-green — owner UX rule 2026-07-17).
   */
  private buildRoleCard(row: RoleRow, byId: Map<string, PairedDevice>): HTMLElement {
    const a = row.assignment;
    const dev = a !== null && a !== 'none' ? byId.get(a.deviceId) ?? null : null;
    const inFlight = dev?.stage === 'connecting' || dev?.stage === 'discovering' || dev?.stage === 'subscribing';

    let stateCls: string;
    let statusText: string;
    let statusGlyph: string;
    if (a === null || a === 'none') {
      stateCls = 'state-search';
      statusText = t('ble.status.search');
      statusGlyph = DOT_GLYPH;
    } else if (inFlight) {
      stateCls = 'state-busy';
      statusText = dev ? STAGE_LABEL[dev.stage] : t('ble.status.waiting');
      statusGlyph = DOT_GLYPH;
    } else if (row.state === 'stale' || row.state === 'disconnected') {
      stateCls = 'state-lost';
      statusText = t('ble.status.lost');
      statusGlyph = DOT_GLYPH;
    } else if (row.state === 'waiting') {
      stateCls = 'state-busy';
      statusText = t('ble.status.waiting');
      statusGlyph = DOT_GLYPH;
    } else if (row.state === 'live') {
      stateCls = 'state-live';
      statusText = row.role === 'control' ? t('ble.status.active') : t('ble.status.connected');
      statusGlyph = CHECK_GLYPH;
    } else {
      // control assigned + device connected but not currently activated
      // (state 'inactive'), or any other assigned-and-present resting state
      stateCls = 'state-live';
      statusText = t('ble.status.connected');
      statusGlyph = CHECK_GLYPH;
    }

    const card = el('div', `bm-rolerow bm-rolecard ${stateCls}`);
    card.dataset['role'] = row.role;

    const head = el('div', 'bm-rc-head');
    head.textContent = roleCardLabel(row.role);
    card.appendChild(head);

    const body = el('div', 'bm-rc-body');
    const ico = el('div', 'bm-rc-ico');
    ico.innerHTML = ROLE_GLYPH[row.role];
    body.appendChild(ico);

    const metric = ROLE_METRIC[row.role];
    if (metric) {
      const valBox = el('div', 'bm-rc-val');
      const num = el('div', 'bm-rc-num');
      num.textContent = row.state === 'live' && row.value !== null ? fmtNum(metric, row.value) : '—';
      const unit = el('div', 'bm-rc-unit');
      unit.textContent = METRIC_UNIT[metric];
      valBox.append(num, unit);
      body.appendChild(valBox);
    }
    card.appendChild(body);

    const devLine = el('div', 'bm-rc-dev');
    const mux = this.source.registry.roleMux;
    const devName = a !== null && a !== 'none' ? mux.deviceNameFor(a.deviceId, a.protocol) : null;
    if (devName) {
      devLine.innerHTML = BLE_GLYPH;
      const nm = el('span', 'bm-rc-name');
      nm.textContent = devName;
      devLine.appendChild(nm);
    } else {
      const nm = el('span', 'bm-rc-name');
      nm.textContent = a === 'none' ? t('ble.role.none') : t('ble.role.unassigned');
      nm.style.opacity = '0.7';
      devLine.appendChild(nm);
    }
    card.appendChild(devLine);

    const status = el('div', 'bm-rc-status');
    status.innerHTML = statusGlyph;
    const st = document.createElement('span');
    st.textContent = statusText;
    status.appendChild(st);
    card.appendChild(status);

    card.addEventListener('click', () => this.openPair(row.role));
    return card;
  }

  // ---- known-devices strip (per-device reconnect / disconnect / FORGET) ------

  private buildKnownDevices(): HTMLElement {
    const wrap = document.createDocumentFragment() as unknown as HTMLElement;
    const h = el('div', 'bm-h');
    h.textContent = t('ble.knownDevices');
    wrap.appendChild(h);

    const devices = this.source.registry.list();
    if (devices.length === 0) {
      const note = el('div', 'bm-note');
      note.textContent = t('ble.noDevices');
      wrap.appendChild(note);
    }
    for (const d of devices) wrap.appendChild(this.buildDeviceCard(d));

    const btns = el('div', 'bm-cardbtns');
    const add = el('div', 'bm-btn primary big');
    add.textContent = t('ble.addDevice');
    add.addEventListener('click', () => this.openPair('add'));
    btns.appendChild(add);
    wrap.appendChild(btns);

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
    // cadence over BOTH Cycling Power (0x1818) and CSC (0x1816), so a per-protocol
    // loop would draw two identical CADENCE chips (the owner called that a bug,
    // 2026-07-15). Cadence is ONE physical quantity; which protocols carry it
    // moves into the chip's tooltip instead of being duplicated on screen.
    const chips = el('div', 'bm-chips');
    for (const metric of METRICS) {
      const carriers = d.protocols.filter((p) => mux.capabilitiesFor(d.id, p)?.[metric]);
      if (carriers.length === 0) continue;
      const a = mux.assignmentFor(metric);
      const assignedHere = a !== null && a !== 'none' && a.deviceId === d.id && carriers.includes(a.protocol);
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
      tag.textContent = t('ble.usedFor', { roles: used.map((r) => ROLE_LABEL[r]).join(', ') });
      card.appendChild(tag);
    }

    // one reading per metric: the protocol actually feeding the role if this
    // device holds it, else the first carrier that is genuinely streaming
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
      rc.textContent = t('ble.reconnect');
      rc.addEventListener('click', () => void this.guarded(() => this.source.registry.reconnect()));
      btns.appendChild(rc);
    } else {
      const disc = el('div', 'bm-btn small');
      disc.textContent = t('ble.disconnect');
      disc.addEventListener('click', () => this.source.registry.disconnect(d.id));
      btns.appendChild(disc);
    }
    const forget = el('div', 'bm-btn small danger');
    forget.textContent = t('ble.forget');
    forget.addEventListener('click', () => this.source.registry.forget(d.id));
    btns.appendChild(forget);
    card.appendChild(btns);

    return card;
  }

  // ---- per-role pair modal ---------------------------------------------------

  private openPair(role: Role | 'add'): void {
    this.pairRole = role;
    this.lastError = '';
    this.render();
  }

  private closePair(): void {
    this.pairRole = null;
    this.render();
  }

  /** the SEARCH gesture: RECOMMENDED = requestAnyDevice (service-filtered) /
   *  ALL = requestAllDevices. addDevice() is a real user gesture (button
   *  click), which Web Bluetooth requires; RoleMux auto-assigns whatever the
   *  connected device can serve, so the hub reflects it on the next render.
   *  The modal stays open so cancel keeps context and a success shows the new
   *  device in the candidate list. */
  private async startScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.render();
    await this.guarded(() => this.source.registry.addDevice(this.pairAll));
    this.scanning = false;
    this.render();
  }

  private buildPairModal(): HTMLElement {
    const overlay = el('div', 'bm-pair');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closePair();
    });
    const panel = el('div', 'bm-pairpanel');

    const bar = el('div', 'bm-pairbar');
    const barTitle = document.createElement('span');
    barTitle.textContent =
      this.pairRole === 'add' || this.pairRole === null
        ? t('ble.pair.title')
        : `${t('ble.pair.title')} · ${roleCardLabel(this.pairRole)}`;
    const barX = el('div', 'bm-x');
    barX.textContent = '✕';
    barX.addEventListener('click', () => this.closePair());
    bar.append(barTitle, barX);
    panel.appendChild(bar);

    const bodyEl = el('div', 'bm-pairbody');

    // FILTERS: two pills — service-filtered scan vs every sensor
    const flabel = el('div', 'bm-filters-lbl');
    flabel.textContent = t('ble.pair.filters');
    bodyEl.appendChild(flabel);
    const pills = el('div', 'bm-pillrow');
    const rec = el('div', `bm-pill${this.pairAll ? '' : ' on'}`);
    rec.textContent = t('ble.pair.recommended');
    rec.addEventListener('click', () => {
      this.pairAll = false;
      this.render();
    });
    const all = el('div', `bm-pill${this.pairAll ? ' on' : ''}`);
    all.textContent = t('ble.pair.all');
    all.addEventListener('click', () => {
      this.pairAll = true;
      this.render();
    });
    pills.append(rec, all);
    bodyEl.appendChild(pills);

    // list: candidates for the role (one tap assigns), or the scan spinner
    const list = el('div', 'bm-list');
    if (this.scanning) {
      const scanning = el('div', 'bm-scanning');
      scanning.appendChild(el('div', 'bm-spinner'));
      const txt = document.createElement('span');
      txt.textContent = t('ble.pair.looking');
      scanning.appendChild(txt);
      list.appendChild(scanning);
    } else if (this.pairRole !== 'add' && this.pairRole !== null) {
      list.appendChild(this.buildCandidateList(this.pairRole));
    } else {
      const empty = el('div', 'bm-scanning');
      const txt = document.createElement('span');
      txt.textContent = t('ble.pair.empty');
      empty.appendChild(txt);
      list.appendChild(empty);
    }
    bodyEl.appendChild(list);

    // hint — tapping it widens the scan to ALL (reference "set filters to All")
    const hint = el('div', 'bm-hint');
    hint.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>';
    const hintT = el('div', 'bm-hint-t');
    hintT.textContent = t('ble.showAll');
    hint.appendChild(hintT);
    hint.addEventListener('click', () => {
      this.pairAll = true;
      this.render();
    });
    bodyEl.appendChild(hint);

    const actions = el('div', 'bm-pair-actions');
    const scanBtn = el('div', 'bm-btn primary');
    scanBtn.textContent = t('ble.pair.scan');
    scanBtn.addEventListener('click', () => void this.startScan());
    const closeBtn = el('div', 'bm-btn');
    closeBtn.textContent = t('ble.pair.close');
    closeBtn.addEventListener('click', () => this.closePair());
    actions.append(scanBtn, closeBtn);
    bodyEl.appendChild(actions);

    panel.appendChild(bodyEl);
    overlay.appendChild(panel);
    return overlay;
  }

  /** the role's candidate devices as tappable `.bm-pickopt` rows (probe/tacx
   *  tooling asserts against `.bm-pickopt`), plus a sticky "— none —". */
  private buildCandidateList(role: Role): HTMLElement {
    const mux = this.source.registry.roleMux;
    const frag = document.createDocumentFragment() as unknown as HTMLElement;
    const rows = mux.rows();
    const row = rows.find((r) => r.role === role);
    const a = row?.assignment ?? null;

    const noneOpt = el('div', `bm-pickopt${a === 'none' ? ' sel' : ''}`);
    noneOpt.appendChild(el('div', 'bm-radio'));
    const noneName = el('div', 'bm-pk-name');
    noneName.textContent = t('ble.role.none');
    noneName.style.opacity = '0.75';
    noneOpt.appendChild(noneName);
    noneOpt.addEventListener('click', () => {
      mux.assign(role, 'none');
      this.closePair();
    });
    frag.appendChild(noneOpt);

    for (const c of row?.candidates ?? []) {
      const sel = a !== null && a !== 'none' && a.deviceId === c.deviceId && a.protocol === c.protocol;
      const opt = el('div', `bm-pickopt${sel ? ' sel' : ''}`);
      opt.appendChild(el('div', 'bm-radio'));
      const nm = el('div', 'bm-pk-name');
      nm.textContent = c.deviceName;
      const ble = document.createElement('span');
      ble.className = 'bm-ble-wrap';
      ble.innerHTML = BLE_GLYPH;
      const proto = el('div', 'bm-pk-proto');
      proto.textContent = PROTOCOL_LABEL[c.protocol];
      opt.append(nm, ble, proto);
      opt.addEventListener('click', () => {
        mux.assign(role, { deviceId: c.deviceId, protocol: c.protocol });
        this.closePair();
      });
      frag.appendChild(opt);
    }
    return frag;
  }
}

/** big-number string for a role card (no unit — the unit is a separate line) */
function fmtNum(metric: Metric, value: number): string {
  const v = metric === 'power' || metric === 'heartRate' ? Math.round(value) : Math.round(value * 10) / 10;
  return `${v}`;
}

/** number + unit for the device-card ticker line */
function fmt(metric: Metric, value: number): string {
  return `${fmtNum(metric, value)} ${METRIC_UNIT[metric]}`;
}
