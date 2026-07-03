/**
 * BLE Connect UI (M1.4) — the user-gesture surface Web Bluetooth demands.
 *
 * requestDevice() only works from transient user activation, so sensors
 * connect through REAL BUTTONS, never automatically. One row per device
 * slot (trainer / power / cadence / heart rate): status dot + device name +
 * CONNECT button that opens the Chrome chooser. A dropped link flips the
 * row to RECONNECT (again a button — silent reconnection via getDevices()
 * is flag-gated in Chrome and not relied upon; see research notes §7).
 *
 * When the browser has no Bluetooth stack (Linux Chrome without the
 * experimental flag — the owner's machine), the panel says so and points
 * at chrome://flags instead of failing silently.
 *
 * Toggle with the ride HUD (`B`). Same glass styling as RideHud; DOM+CSS
 * only. Panel lives top-right, clear of dashboard, banner, junction UI.
 */

import type { BleSensorSource } from './BleSensorSource';
import type { BleDeviceKind } from './Transport';

const SLOTS: { kind: BleDeviceKind; label: string; hint: string }[] = [
  { kind: 'trainer', label: 'TRAINER', hint: 'smart trainer (FTMS) — power, cadence, SIM resistance' },
  { kind: 'power', label: 'POWER', hint: 'power meter (cycling power service)' },
  { kind: 'csc', label: 'CADENCE', hint: 'cadence/speed sensor (CSC)' },
  { kind: 'hr', label: 'HEART', hint: 'heart-rate strap' },
];

const STYLE = `
#ble-panel{position:fixed;top:10px;right:10px;z-index:1000;width:228px;
  font-family:ui-monospace,Menlo,Consolas,monospace;color:#a9bfb2;
  background:rgba(9,13,11,0.58);backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.09);
  border-radius:10px;padding:9px 10px;box-shadow:0 2px 10px rgba(0,0,0,0.25)}
#ble-panel .bp-title{font:bold 9px/1.2 ui-monospace,Menlo,monospace;
  letter-spacing:0.14em;color:#cfe3d6;margin-bottom:7px}
#ble-panel .bp-row{display:flex;align-items:center;gap:7px;padding:4px 0}
#ble-panel .bp-dot{width:7px;height:7px;border-radius:50%;flex:none;
  background:#5a6a61;transition:background 0.25s}
#ble-panel .bp-row.on .bp-dot{background:#7ee0a3;box-shadow:0 0 6px rgba(126,224,163,0.7)}
#ble-panel .bp-row.lost .bp-dot{background:#ff8a70;box-shadow:0 0 6px rgba(255,138,112,0.6)}
#ble-panel .bp-lbl{font:bold 9px/1.2 ui-monospace,Menlo,monospace;
  letter-spacing:0.1em;width:52px;flex:none}
#ble-panel .bp-name{font:9px/1.25 ui-monospace,Menlo,monospace;opacity:0.85;
  flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ble-panel .bp-btn{font:bold 8px/1 ui-monospace,Menlo,monospace;
  letter-spacing:0.08em;color:#dff0e6;background:rgba(255,255,255,0.08);
  border:1px solid rgba(255,255,255,0.16);border-radius:7px;
  padding:5px 8px;cursor:pointer;flex:none;transition:background 0.15s}
#ble-panel .bp-btn:hover{background:rgba(255,255,255,0.16)}
#ble-panel .bp-btn:disabled{opacity:0.45;cursor:default}
#ble-panel .bp-row.lost .bp-btn{border-color:rgba(255,138,112,0.55);color:#ffd9c9}
#ble-panel .bp-note{font:9px/1.45 ui-monospace,Menlo,monospace;color:#c9b9a4;
  margin-top:6px;opacity:0.9}
#ble-panel .bp-err{font:9px/1.4 ui-monospace,Menlo,monospace;color:#ffb09a;
  margin-top:5px;min-height:0;white-space:normal}
`;

export class BleConnectUi {
  private source: BleSensorSource;
  private root: HTMLDivElement;
  private rows = new Map<BleDeviceKind, { row: HTMLDivElement; name: HTMLDivElement; btn: HTMLButtonElement; was: boolean }>();
  private err: HTMLDivElement;
  private visible: boolean;

  constructor(source: BleSensorSource, startVisible: boolean) {
    this.source = source;
    this.visible = startVisible;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'ble-panel';
    const title = document.createElement('div');
    title.className = 'bp-title';
    title.textContent = 'BLUETOOTH SENSORS';
    this.root.appendChild(title);

    if (!source.available()) {
      // Linux Chrome ships Web Bluetooth behind a flag (research notes §7)
      const note = document.createElement('div');
      note.className = 'bp-note';
      note.innerHTML =
        'Web Bluetooth недоступен в этом браузере.<br>' +
        'Linux Chrome: включить<br><b>chrome://flags/#enable-experimental-web-platform-features</b><br>' +
        '(нужен BlueZ ≥ 5.41) и перезапустить.';
      this.root.appendChild(note);
    } else {
      for (const s of SLOTS) {
        const row = document.createElement('div');
        row.className = 'bp-row';
        row.dataset['kind'] = s.kind;
        row.title = s.hint;
        const dot = document.createElement('div');
        dot.className = 'bp-dot';
        const lbl = document.createElement('div');
        lbl.className = 'bp-lbl';
        lbl.textContent = s.label;
        const name = document.createElement('div');
        name.className = 'bp-name';
        name.textContent = '—';
        const btn = document.createElement('button');
        btn.className = 'bp-btn';
        btn.textContent = 'CONNECT';
        // one persistent handler: connected → deliberate drop, else the
        // chooser (a fresh user gesture either way)
        btn.addEventListener('click', () => {
          const live = this.source.slots().find((x) => x.kind === s.kind)?.connected;
          if (live) this.source.disconnect(s.kind);
          else void this.connect(s.kind, btn);
        });
        row.append(dot, lbl, name, btn);
        this.root.appendChild(row);
        this.rows.set(s.kind, { row, name, btn, was: false });
      }
    }

    this.err = document.createElement('div');
    this.err.className = 'bp-err';
    this.root.appendChild(this.err);
    document.body.appendChild(this.root);

    source.onChange(() => this.refresh());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyB') {
        this.visible = !this.visible;
        this.applyVisibility();
      }
    });
    this.applyVisibility();
    this.refresh();
  }

  private async connect(kind: BleDeviceKind, btn: HTMLButtonElement): Promise<void> {
    this.err.textContent = '';
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await this.source.connect(kind);
    } catch (e) {
      // chooser cancel lands here too — that's a non-event, show softly
      const msg = e instanceof Error ? e.message : String(e);
      this.err.textContent = /cancel/i.test(msg) ? '' : msg;
    } finally {
      btn.disabled = false;
      this.refresh();
    }
  }

  private refresh(): void {
    const slots = new Map(this.source.slots().map((s) => [s.kind, s]));
    for (const [kind, r] of this.rows) {
      const s = slots.get(kind);
      if (s?.connected) {
        r.row.className = 'bp-row on';
        r.name.textContent = s.name;
        r.btn.textContent = 'DROP';
        r.was = true;
      } else if (r.was) {
        // had a device, lost the link — reconnect needs a fresh gesture
        r.row.className = 'bp-row lost';
        r.name.textContent = s ? `${s.name} · LOST` : 'connection lost';
        r.btn.textContent = 'RECONNECT';
      } else {
        r.row.className = 'bp-row';
        r.name.textContent = '—';
        r.btn.textContent = 'CONNECT';
      }
    }
  }

  private applyVisibility(): void {
    this.root.style.display = this.visible ? 'block' : 'none';
  }
}
