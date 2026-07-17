/**
 * NativeBridgeTransport — the THIRD BleTransport, for the Android WebView APK.
 *
 * WHY: `navigator.bluetooth` does not exist in Android WebView. Web Bluetooth
 * is a Chrome-*browser* feature; the embeddable WebView ships neither the
 * chooser nor the permission model. The APK therefore hosts its own GATT stack
 * in Kotlin (android/app/src/main/java/com/bepcyc/laas/BleBridge.kt) and this
 * file re-exposes it as the same `BleTransport`/`BleDeviceHandle` contract that
 * WebBluetoothTransport and FakeTransport implement. Nothing above the seam
 * (Capabilities, providers/, TrainerController, RoleMux, DeviceRegistry) learns
 * which stack is underneath — that is the entire point of Transport.ts.
 *
 * THE PROTOCOL, and why it looks like this: `addJavascriptInterface` can only
 * return a value SYNCHRONOUSLY, while every GATT operation is asynchronous. So
 * requests carry an id we mint here, `LaasBle.call()` returns nothing but an
 * "accepted for dispatch" ack, and the actual outcome arrives later through
 * `window.__laasBleRecv(json)` (Kotlin -> evaluateJavascript) where it resolves
 * the promise parked under that id. Notifications, scan hits and link drops
 * ride the same inbound channel unsolicited, with no id. Bytes are base64 both
 * ways, because the channel is a JS string literal and base64 is the cheapest
 * way to keep arbitrary GATT payloads out of escaping's reach.
 *
 * THE CHOOSER IS OURS NOW. Web Bluetooth's requestDevice() renders a chooser
 * supplied by the browser; native has no such thing. So requestAnyDevice()
 * scans through the bridge and renders the picker itself, in the page, styled
 * to match DeviceManagerUi — deliberately NOT an Android AlertDialog: an
 * in-page chooser keeps the whole device flow inside one renderer, and inside
 * the existing UI language. It resolves with a CONNECTED handle exactly like
 * its Web Bluetooth twin, so DeviceRegistry.addDevice() is unchanged.
 *
 * IDENTITY: `BleDeviceHandle.id` is the MAC address here, where Chrome hands
 * out an opaque per-origin id. Both are stable per device, which is all
 * DeviceRegistry's persisted role assignments require. They are NOT
 * interchangeable between the two transports — a device paired in Chrome and
 * the same device paired in the APK are two different registry entries. That is
 * correct and unavoidable: the ids come from different namespaces.
 */

import { t } from '../../core/I18n';
import { KNOWN_NAMES_KEY } from './DeviceRegistry';
import {
  canonicalUuid,
  KNOWN_SERVICES,
  type BleDeviceHandle,
  type BleTransport,
  type ServiceUuid,
} from './Transport';

// ---- the Kotlin-side object ----------------------------------------------------

interface LaasBleNative {
  available(): boolean;
  unavailableReason(): string;
  /** JSON in, sync ack JSON out — see BleBridge.call() */
  call(request: string): string;
}

interface InboundMsg {
  t: 'reply' | 'scan' | 'scanfail' | 'notify' | 'gone';
  id?: string;
  ok?: boolean;
  code?: string;
  error?: string;
  addr?: string;
  name?: string;
  rssi?: number;
  svc?: string;
  chr?: string;
  data?: string;
  services?: string[] | GattService[];
  /** 'alive' op reply: is this addr in the bridge's live connection map? */
  alive?: boolean;
}

/** one discovered service and its characteristics, with the raw property
 *  bitmask each one reports (READ 0x02, WRITE_NO_RESPONSE 0x04, WRITE 0x08,
 *  NOTIFY 0x10, INDICATE 0x20) */
export interface GattService {
  uuid: string;
  chars: { uuid: string; props: number }[];
}

function native(): LaasBleNative | null {
  return (window as unknown as { LaasBle?: LaasBleNative }).LaasBle ?? null;
}

/** Is the APK's native bridge present AND does the device have a radio?
 *  main.ts picks the transport on this — false on desktop/Chrome, where
 *  window.LaasBle simply does not exist. */
export function nativeBleAvailable(): boolean {
  try {
    return native()?.available() === true;
  } catch {
    return false;
  }
}

// ---- bytes ---------------------------------------------------------------------

function b64ToDataView(b64: string): DataView {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new DataView(u8.buffer);
}

function bufToB64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

/** Codes the Kotlin side raises for conditions the rider can actually fix get
 *  a translated sentence; everything else keeps the native message verbatim
 *  rather than being flattened into a vague one (DeviceManagerUi surfaces it). */
function messageFor(msg: InboundMsg): string {
  switch (msg.code) {
    case 'off':
      return t('ble.err.off');
    case 'perm':
      return t('ble.err.perm');
    case 'noadapter':
      return t('ble.err.noadapter');
    default:
      return msg.error ?? 'native BLE error';
  }
}

// ---- client --------------------------------------------------------------------

interface Pending {
  resolve: (m: InboundMsg) => void;
  reject: (e: Error) => void;
}

export interface ScanHit {
  addr: string;
  name: string;
  rssi: number;
  services: string[];
}

/**
 * Owns the duplex channel: one `__laasBleRecv` hook, one id sequence, one
 * pending-promise map, one notification routing table. A module singleton
 * because `window.__laasBleRecv` is a single global — two clients would fight
 * over it, and the Kotlin side only knows the one name.
 */
class NativeBleClient {
  private seq = 0;
  private pending = new Map<string, Pending>();
  /** `${addr}|${svc}|${chr}` -> notification sink */
  private notifySinks = new Map<string, (dv: DataView) => void>();
  /** addr -> link-drop sinks */
  private goneSinks = new Map<string, (() => void)[]>();
  private scanSink: ((hit: ScanHit) => void) | null = null;

  constructor() {
    (window as unknown as { __laasBleRecv?: (s: string) => void }).__laasBleRecv = (s) => this.recv(s);
  }

  private recv(raw: string): void {
    let msg: InboundMsg;
    try {
      msg = JSON.parse(raw) as InboundMsg;
    } catch {
      return;
    }
    if (msg.t === 'reply' && msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(messageFor(msg)));
      return;
    }
    if (msg.t === 'notify' && msg.addr && msg.svc && msg.chr && msg.data) {
      this.notifySinks.get(`${msg.addr}|${msg.svc}|${msg.chr}`)?.(b64ToDataView(msg.data));
      return;
    }
    if (msg.t === 'gone' && msg.addr) {
      const sinks = this.goneSinks.get(msg.addr) ?? [];
      this.goneSinks.delete(msg.addr);
      for (const cb of sinks) cb();
      return;
    }
    if (msg.t === 'scan' && msg.addr) {
      this.scanSink?.({
        addr: msg.addr,
        name: msg.name ?? msg.addr,
        rssi: msg.rssi ?? 0,
        services: (msg.services as string[]) ?? [],
      });
    }
  }

  call(op: string, args: Record<string, unknown> = {}): Promise<InboundMsg> {
    const bridge = native();
    if (!bridge) return Promise.reject(new Error(t('ble.err.noadapter')));
    const id = String(++this.seq);
    return new Promise<InboundMsg>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      let ack: { ok?: boolean; error?: string };
      try {
        ack = JSON.parse(bridge.call(JSON.stringify({ id, op, ...args }))) as { ok?: boolean; error?: string };
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      // sync ack only rejects malformed dispatch; the real outcome lands in recv()
      if (!ack.ok) {
        this.pending.delete(id);
        reject(new Error(ack.error ?? 'native BLE rejected the request'));
      }
    });
  }

  onScan(cb: ((hit: ScanHit) => void) | null): void {
    this.scanSink = cb;
  }

  onNotify(addr: string, svc: string, chr: string, cb: (dv: DataView) => void): void {
    this.notifySinks.set(`${addr}|${svc}|${chr}`, cb);
  }

  onGone(addr: string, cb: () => void): void {
    const list = this.goneSinks.get(addr) ?? [];
    list.push(cb);
    this.goneSinks.set(addr, list);
  }

  /** drop every sink for a device — a fresh connect to the same MAC must not
   *  inherit the previous link's callbacks */
  forget(addr: string): void {
    for (const key of [...this.notifySinks.keys()]) {
      if (key.startsWith(`${addr}|`)) this.notifySinks.delete(key);
    }
    this.goneSinks.delete(addr);
  }
}

let client: NativeBleClient | null = null;
function bleClient(): NativeBleClient {
  if (!client) client = new NativeBleClient();
  return client;
}

// ---- handle --------------------------------------------------------------------

class NativeDeviceHandle implements BleDeviceHandle {
  readonly id: string;
  readonly name: string;
  connected = true;
  /** canonical service uuid -> (characteristic uuid -> property bitmask),
   *  straight from the one discoverServices() the bridge ran. Native has no
   *  Web Bluetooth authorization model, so this is the device's REAL tree; it
   *  self-scopes because only KNOWN_SERVICES are ever asked about. */
  private tree: Map<string, Map<string, number>>;
  private disconnectCbs: (() => void)[] = [];

  constructor(addr: string, name: string, tree: Map<string, Map<string, number>>) {
    this.id = addr;
    this.name = name;
    this.tree = tree;
    bleClient().onGone(addr, () => {
      this.connected = false;
      for (const cb of this.disconnectCbs) cb();
    });
  }

  hasService(service: ServiceUuid): boolean {
    return this.tree.has(canonicalUuid(service));
  }

  hasCharacteristic(service: ServiceUuid, chr: ServiceUuid): boolean {
    return this.tree.get(canonicalUuid(service))?.has(canonicalUuid(chr)) === true;
  }

  /** BEYOND the BleTransport contract, and deliberately so: this is native-only
   *  reconnaissance for decoding the Tacx vendor service, where the direction
   *  of cf800002/cf800003 is undocumented and must be read off the device
   *  rather than guessed. Web Bluetooth exposes `properties` too, but nothing
   *  in the sensor layer needs it, so it stays off the shared interface —
   *  TacxControlsProbe feature-detects this method. */
  properties(service: ServiceUuid, chr: ServiceUuid): number | null {
    return this.tree.get(canonicalUuid(service))?.get(canonicalUuid(chr)) ?? null;
  }

  /** the device's complete real GATT tree — what the vendor-service capture
   *  needs to report before it touches anything */
  dumpTree(): Record<string, { uuid: string; props: number }[]> {
    const out: Record<string, { uuid: string; props: number }[]> = {};
    for (const [svc, chars] of this.tree) {
      out[svc] = [...chars].map(([uuid, props]) => ({ uuid, props }));
    }
    return out;
  }

  async startNotify(service: ServiceUuid, chr: ServiceUuid, cb: (dv: DataView) => void): Promise<void> {
    const svc = canonicalUuid(service);
    const c = canonicalUuid(chr);
    // sink BEFORE the CCCD write: a chatty sensor can push its first frame
    // between the peripheral enabling notifications and this promise
    // resolving, and that frame must not fall on the floor
    bleClient().onNotify(this.id, svc, c, cb);
    await bleClient().call('notify', { addr: this.id, svc, chr: c });
  }

  async read(service: ServiceUuid, chr: ServiceUuid): Promise<DataView | null> {
    try {
      const r = await bleClient().call('read', {
        addr: this.id,
        svc: canonicalUuid(service),
        chr: canonicalUuid(chr),
      });
      return r.data ? b64ToDataView(r.data) : null;
    } catch {
      return null; // contract: absent/failed reads are null, never a throw
    }
  }

  async write(service: ServiceUuid, chr: ServiceUuid, data: ArrayBuffer): Promise<void> {
    await bleClient().call('write', {
      addr: this.id,
      svc: canonicalUuid(service),
      chr: canonicalUuid(chr),
      data: bufToB64(data),
    });
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb);
  }

  disconnect(): void {
    void bleClient().call('disconnect', { addr: this.id }).catch(() => {
      /* already gone — the 'gone' event has done, or will do, the bookkeeping */
    });
  }

  /** ground truth from the native side's connection map — a BT-stack restart
   *  can swallow onConnectionStateChange and freeze `connected` at true
   *  (zombie-READY, hit live 2026-07-17); the bridge's `conns` cannot lie */
  async probeAlive(): Promise<boolean> {
    try {
      return (await bleClient().call('alive', { addr: this.id })).alive === true;
    } catch {
      return false; // bridge unreachable == link unusable either way
    }
  }
}

// ---- in-page chooser -----------------------------------------------------------

// Styled to the same PAIR-modal shape as DeviceManagerUi's per-role modal
// (reference/zwift-ux/*): a dark title bar, two filter pills, a live device
// list with an animated spinner + "Looking for devices…", a wake-the-sensor
// hint box, and REFRESH / CLOSE actions — in OUR dark-glass language, not
// Zwift's branding.
const CHOOSER_STYLE = `
#ble-scan{position:fixed;inset:0;z-index:1002;display:flex;align-items:center;justify-content:center;
  padding:14px;background:rgba(4,6,5,0.8);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
  font-family:ui-monospace,Menlo,Consolas,monospace}
#ble-scan .bs-card{width:min(440px,94vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;
  color:#dff0e6;background:rgba(12,16,14,0.98);border:1px solid rgba(255,255,255,0.14);
  border-radius:15px;box-shadow:0 10px 34px rgba(0,0,0,0.6)}
#ble-scan .bs-bar{flex:none;padding:12px 15px;background:rgba(0,0,0,0.4);
  border-bottom:1px solid rgba(255,255,255,0.08);
  font:bold 12px/1.2 ui-monospace,monospace;letter-spacing:0.14em;color:#ffe9b0}
#ble-scan .bs-body{padding:14px 15px 16px;overflow-y:auto;display:flex;flex-direction:column}
#ble-scan .bs-filters-lbl{font:bold 8px/1 ui-monospace,monospace;letter-spacing:0.14em;color:#8fb39e;margin-bottom:7px}
#ble-scan .bs-pillrow{display:flex;gap:7px;margin-bottom:13px}
#ble-scan .bs-pill{flex:1;text-align:center;padding:9px;border-radius:9px;cursor:pointer;
  font:bold 10px/1 ui-monospace,monospace;letter-spacing:0.08em;color:#a9bfb2;
  background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.16)}
#ble-scan .bs-pill:hover{border-color:rgba(255,255,255,0.32)}
#ble-scan .bs-pill.on{color:#1a1410;background:#ffd166;border-color:#ffd166}
#ble-scan .bs-list{overflow-y:auto;display:flex;flex-direction:column;gap:6px;min-height:74px;margin-bottom:12px}
#ble-scan .bs-looking{display:flex;align-items:center;gap:10px;padding:8px 2px;color:#8fb39e;
  font:10px/1 ui-monospace,monospace;letter-spacing:0.05em}
#ble-scan .bs-spinner{width:20px;height:20px;border-radius:50%;flex:none;
  border:3px solid rgba(255,255,255,0.14);border-top-color:#ffd166;animation:bsSpin 0.8s linear infinite}
@keyframes bsSpin{to{transform:rotate(360deg)}}
#ble-scan .bs-item{display:flex;align-items:center;gap:9px;padding:11px;border-radius:9px;cursor:pointer;
  border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.03)}
#ble-scan .bs-item:hover{background:rgba(255,255,255,0.1)}
#ble-scan .bs-radio{width:14px;height:14px;border-radius:50%;flex:none;box-sizing:border-box;
  border:2px solid rgba(188,217,255,0.55)}
#ble-scan .bs-nm{font:bold 11px/1.3 ui-monospace,monospace;flex:1;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
#ble-scan .bs-ble{width:9px;height:12px;flex:none;color:#bcd9ff;opacity:0.85}
#ble-scan .bs-rssi{font:9px/1 ui-monospace,monospace;color:#8fb39e;flex:none}
#ble-scan .bs-empty{font:10px/1.5 ui-monospace,monospace;color:#8fb39e;padding:8px 2px}
#ble-scan .bs-hint{display:flex;gap:9px;align-items:flex-start;padding:10px 11px;border-radius:10px;
  background:rgba(0,0,0,0.32);border:1px solid rgba(255,255,255,0.08);margin-bottom:13px}
#ble-scan .bs-hint svg{width:16px;height:16px;flex:none;color:#8fb39e;margin-top:1px}
#ble-scan .bs-hint .bs-hint-t{font:9px/1.5 ui-monospace,monospace;color:#c9b9a4}
#ble-scan .bs-actions{display:flex;gap:8px}
#ble-scan .bs-btn{flex:1;font:bold 10px/1 ui-monospace,monospace;letter-spacing:0.06em;
  color:#dff0e6;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);
  border-radius:9px;padding:11px;cursor:pointer;text-align:center}
#ble-scan .bs-btn:hover{background:rgba(255,255,255,0.15)}
#ble-scan .bs-btn.primary{color:#1a1410;background:#ffd166;border-color:#ffd166}
#ble-scan .bs-btn.primary:hover{background:#ffdb85}
`;

let styleInjected = false;

const BS_BLE_GLYPH =
  '<svg class="bs-ble" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7.5 16 16.5 12 20V4l4 3.5L8 16.5"/></svg>';
const BS_SEARCH_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>';

/** The chooser Web Bluetooth would have drawn for us, in the PAIR-modal shape
 *  of DeviceManagerUi (reference/zwift-ux/*): title bar, RECOMMENDED/ALL filter
 *  pills, a live device list with a spinner + "Looking for devices…", the
 *  wake-the-sensor hint, and REFRESH / CLOSE actions.
 *
 *  Live-updating list: a BLE scan streams the same device repeatedly, so hits
 *  are keyed by MAC and the row is refreshed in place rather than appended.
 *
 *  SEEDED with saved devices (DeviceRegistry's known-names cache): a trainer
 *  that stops advertising its service list after the first bond (the owner's
 *  Tacx — it vanished from every service-filtered scan forever) is still
 *  connectable by MAC, so it must stay pickable even with zero scan hits.
 *  A live hit for the same MAC upgrades the row in place (SAVED → dBm). */
class ScanChooser {
  private root: HTMLDivElement;
  private list: HTMLDivElement;
  private pillRec: HTMLDivElement;
  private pillAll: HTMLDivElement;
  private hits = new Map<string, ScanHit & { saved?: boolean }>();
  private onPick: (hit: ScanHit) => void;
  private allMode: boolean;
  /** wired by chooseAndConnect: stop + restart the native scan (the BLE
   *  stack occasionally goes quiet mid-scan; the owner asked for an explicit
   *  refresh instead of reopening the whole chooser) */
  onRescan: (() => void) | null = null;
  /** switch the LIVE scan between service-filtered (RECOMMENDED) and every-
   *  sensor (ALL) without tearing the chooser down — chooseAndConnect owns the
   *  native scan args and does the actual restart. */
  onModeChange: ((all: boolean) => void) | null = null;

  /** drop live hits back to the saved seed set (rescan/mode-switch restarts the
   *  radio — stale rows must not linger looking fresh) */
  resetLive(): void {
    for (const [addr, hit] of [...this.hits]) {
      if (!hit.saved) this.hits.delete(addr);
    }
    this.render();
  }

  /** reflect a mode flip in the pills (the caller performs the rescan) */
  setMode(all: boolean): void {
    this.allMode = all;
    this.pillRec.classList.toggle('on', !all);
    this.pillAll.classList.toggle('on', all);
  }

  constructor(
    onPick: (hit: ScanHit) => void,
    onCancel: () => void,
    known: { addr: string; name: string }[] = [],
    initialAll = false,
  ) {
    this.onPick = onPick;
    this.allMode = initialAll;
    for (const k of known) {
      this.hits.set(k.addr, { addr: k.addr, name: k.name, rssi: 0, services: [], saved: true });
    }
    if (!styleInjected) {
      const style = document.createElement('style');
      style.textContent = CHOOSER_STYLE;
      document.head.appendChild(style);
      styleInjected = true;
    }
    this.root = document.createElement('div');
    this.root.id = 'ble-scan';
    const card = document.createElement('div');
    card.className = 'bs-card';

    const bar = document.createElement('div');
    bar.className = 'bs-bar';
    bar.textContent = t('ble.scan.title');

    const body = document.createElement('div');
    body.className = 'bs-body';

    const flabel = document.createElement('div');
    flabel.className = 'bs-filters-lbl';
    flabel.textContent = t('ble.pair.filters');
    const pillRow = document.createElement('div');
    pillRow.className = 'bs-pillrow';
    this.pillRec = document.createElement('div');
    this.pillRec.className = `bs-pill${initialAll ? '' : ' on'}`;
    this.pillRec.textContent = t('ble.pair.recommended');
    this.pillRec.addEventListener('click', () => {
      if (this.allMode) this.onModeChange?.(false);
    });
    this.pillAll = document.createElement('div');
    this.pillAll.className = `bs-pill${initialAll ? ' on' : ''}`;
    this.pillAll.textContent = t('ble.pair.all');
    this.pillAll.addEventListener('click', () => {
      if (!this.allMode) this.onModeChange?.(true);
    });
    pillRow.append(this.pillRec, this.pillAll);

    this.list = document.createElement('div');
    this.list.className = 'bs-list';

    const hint = document.createElement('div');
    hint.className = 'bs-hint';
    hint.innerHTML = BS_SEARCH_GLYPH;
    const hintT = document.createElement('div');
    hintT.className = 'bs-hint-t';
    hintT.textContent = t('ble.scan.hint');
    hint.appendChild(hintT);

    const actions = document.createElement('div');
    actions.className = 'bs-actions';
    const rescan = document.createElement('div');
    rescan.className = 'bs-btn';
    rescan.textContent = t('ble.scan.rescan');
    rescan.addEventListener('click', () => this.onRescan?.());
    const cancel = document.createElement('div');
    cancel.className = 'bs-btn primary';
    cancel.textContent = t('ble.scan.cancel');
    cancel.addEventListener('click', onCancel);
    actions.append(rescan, cancel);

    body.append(flabel, pillRow, this.list, hint, actions);
    card.append(bar, body);
    this.root.appendChild(card);
    document.body.appendChild(this.root);
    this.render();
  }

  add(hit: ScanHit): void {
    const prev = this.hits.get(hit.addr);
    this.hits.set(hit.addr, hit);
    // fresh device or a saved seed just proven live — the row set/order
    // changes (and the "looking" spinner clears), re-render; a repeat hit only
    // refreshes its dBm in place
    if (!prev || prev.saved) this.render();
    else {
      const rssi = this.list.querySelector<HTMLDivElement>(`[data-addr="${CSS.escape(hit.addr)}"] .bs-rssi`);
      if (rssi) rssi.textContent = `${hit.rssi} dBm`;
    }
  }

  private render(): void {
    this.list.replaceChildren();
    // live hits strongest-first (the sensor the rider sits on is the near
    // one); saved-but-silent devices after — present, tappable, honest
    const rows = [...this.hits.values()].sort((a, b) => {
      if (!!a.saved !== !!b.saved) return a.saved ? 1 : -1;
      return b.rssi - a.rssi;
    });
    // spinner + "Looking for devices…" until a genuinely LIVE (advertising)
    // device appears — saved-but-silent seed rows do not count as "found", so
    // the rider keeps seeing the scan work (reference zwift-2/3 → zwift-4)
    const hasLive = rows.some((r) => !r.saved);
    if (!hasLive) {
      const looking = document.createElement('div');
      looking.className = 'bs-looking';
      const spin = document.createElement('div');
      spin.className = 'bs-spinner';
      const txt = document.createElement('span');
      txt.textContent = t('ble.pair.looking');
      looking.append(spin, txt);
      this.list.appendChild(looking);
    }
    for (const hit of rows) {
      const row = document.createElement('div');
      row.className = 'bs-item';
      row.dataset['addr'] = hit.addr;
      const radio = document.createElement('div');
      radio.className = 'bs-radio';
      const nm = document.createElement('div');
      nm.className = 'bs-nm';
      nm.textContent = hit.name;
      const ble = document.createElement('span');
      ble.innerHTML = BS_BLE_GLYPH;
      const rssi = document.createElement('div');
      rssi.className = 'bs-rssi';
      rssi.textContent = hit.saved ? t('ble.scan.saved') : `${hit.rssi} dBm`;
      row.append(radio, nm, ble, rssi);
      row.addEventListener('click', () => this.onPick(hit));
      this.list.appendChild(row);
    }
  }

  close(): void {
    this.root.remove();
  }
}

// ---- transport -----------------------------------------------------------------

export class NativeBridgeTransport implements BleTransport {
  available(): boolean {
    return nativeBleAvailable();
  }

  /** the "cycling devices" chooser: one scan filter PER known cycling service
   *  = OR across filters, matching the Web Bluetooth chooser's shape (a single
   *  multi-service filter would be AND, which is what once hid the Tacx). The
   *  RECOMMENDED/ALL pills flip this at runtime — no second chooser session. */
  requestAnyDevice(): Promise<BleDeviceHandle> {
    return this.chooseAndConnect(false);
  }

  /** the literal "all sensors" escape hatch — no service filter at all */
  requestAllDevices(): Promise<BleDeviceHandle> {
    return this.chooseAndConnect(true);
  }

  /** one chooser session that serves BOTH scan modes: `all=false` filters by
   *  KNOWN_SERVICES (OR across entries) + saved MACs; `all=true` accepts every
   *  advertiser. The two entry points above only seed the initial mode — the
   *  chooser's filter pills switch it live via onModeChange, which restarts the
   *  native scan with fresh args (BleTransport's interface is untouched; this
   *  is all internal to the native transport). */
  private async chooseAndConnect(initialAll: boolean): Promise<BleDeviceHandle> {
    const c = bleClient();
    // saved devices (registry's known-names cache): seeded into the picker AND
    // sent as per-address scan filters. A bonded trainer that stops putting
    // its service UUIDs in the advertisement (the owner's Tacx after its first
    // connect) fails every service filter forever — the MAC filter still
    // matches it, and the seeded row keeps it pickable even fully silent.
    let known: { addr: string; name: string }[] = [];
    try {
      const names = JSON.parse(localStorage.getItem(KNOWN_NAMES_KEY) ?? '{}') as Record<string, string>;
      known = Object.entries(names).map(([addr, name]) => ({ addr, name }));
    } catch {
      /* storage disabled/corrupt — the picker just starts empty */
    }
    let allMode = initialAll;
    // scan args for the CURRENT mode. RECOMMENDED = one filter per cycling
    // service (OR) + saved MACs. saved-MAC filters are an ADDITION to the
    // service filters (a bonded trainer that hides its services from the
    // advertisement still matches by address). They must NEVER ride along in
    // the show-all path: with services==null they would become the ONLY
    // filters and silently shrink "every sensor in the world" down to the
    // saved two (found live by the owner, 2026-07-17).
    const buildArgs = (): Record<string, unknown> => {
      const services = allMode
        ? null
        : KNOWN_SERVICES.filter((s) => s.chooserFilter).map((s) => canonicalUuid(s.uuid));
      const args: Record<string, unknown> = {};
      if (services) {
        args['services'] = services;
        if (known.length > 0) args['addrs'] = known.map((k) => k.addr);
      }
      return args;
    };
    const hit = await new Promise<ScanHit>((resolve, reject) => {
      const chooser = new ScanChooser(
        (h) => {
          void stop();
          resolve(h);
        },
        () => {
          void stop();
          // DeviceManagerUi.guarded() swallows /cancel/i — a dismissed chooser
          // is a non-event, exactly as a dismissed Web Bluetooth chooser is
          reject(new Error('cancelled'));
        },
        known,
        initialAll,
      );
      const stop = async (): Promise<void> => {
        c.onScan(null);
        chooser.close();
        try {
          await c.call('stopScan');
        } catch {
          /* scan already stopped */
        }
      };
      const restart = (): void => {
        void c
          .call('stopScan')
          .catch(() => {})
          .then(() => c.call('scan', buildArgs()))
          .catch(() => {
            /* scan restart failed — the picker stays usable with saved rows */
          });
      };
      c.onScan((h) => chooser.add(h));
      chooser.onRescan = () => {
        chooser.resetLive();
        restart();
      };
      chooser.onModeChange = (all) => {
        allMode = all;
        chooser.setMode(all);
        chooser.resetLive();
        restart();
      };
      c.call('scan', buildArgs()).catch((e: unknown) => {
        void stop();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });

    // a re-connect to a MAC we held before must not inherit the dead link's sinks
    c.forget(hit.addr);
    const r = await c.call('connect', { addr: hit.addr });
    const tree = new Map<string, Map<string, number>>();
    for (const s of (r.services as GattService[]) ?? []) {
      tree.set(s.uuid.toLowerCase(), new Map(s.chars.map((x) => [x.uuid.toLowerCase(), x.props])));
    }
    return new NativeDeviceHandle(hit.addr, r.name ?? hit.name, tree);
  }
}
