/**
 * BLE transport adapter — the boundary that makes the sensor layer testable
 * without a Bluetooth stack. Everything above this file (Capabilities,
 * providers/, TrainerController, RoleMux, DeviceRegistry) talks ONLY to
 * `BleDeviceHandle`/`BleTransport`; the real implementation wraps Web
 * Bluetooth, the fake one drives tools/probe-ble.ts in headless Chromium,
 * which has no BT stack at all.
 *
 * Web Bluetooth constraints baked into the design (verified 2026-07-15,
 * docs/notes/ble-ftms-research.md):
 * - requestDevice() REQUIRES transient user activation → only ever called
 *   from a real click handler (DeviceManagerUi's Add Device button).
 * - filters[] is OR ACROSS ENTRIES, AND WITHIN AN ENTRY: `filters:
 *   [{services:[a,b]}]` requires the device advertise BOTH a and b — this
 *   is the exact bug that made the Tacx invisible under the old
 *   KIND_PROFILE.trainer filter. requestAnyDevice() below builds ONE
 *   filter entry PER acceptable service (an OR chooser).
 * - Only services listed in filters[].services or optionalServices are
 *   ever reachable after connect — getPrimaryService() on anything else
 *   throws SecurityError, even if the device actually has it (measured:
 *   the real Tacx's Nordic DFU service and an unidentified vendor service
 *   are invisible to us for exactly this reason, and correctly so — we
 *   never intend to touch them). KNOWN_SERVICES below is the complete,
 *   deliberately-scoped list of services this app ever authorizes.
 * - getDevices()/watchAdvertisements() (silent reconnect) are flag-gated
 *   in Chrome and Chromium itself calls Linux Web Bluetooth "partially
 *   implemented, not supported" — we do NOT depend on them; reconnect is
 *   always a fresh chooser gesture (DeviceRegistry then re-matches the
 *   returned BluetoothDevice.id against any persisted role assignment).
 * - Linux Chrome needs chrome://flags/#enable-experimental-web-platform-features
 *   (owner machine is pop-os — surfaced in DeviceManagerUi when
 *   navigator.bluetooth is absent).
 */

// ---- UUIDs ---------------------------------------------------------------------
// Web Bluetooth accepts 16-bit SIG UUIDs as plain numbers (canonicalized to
// the full 128-bit form internally) and 128-bit vendor UUIDs as lowercase
// hyphenated strings — both appear below, hence ServiceUuid = number|string.

export type ServiceUuid = number | string;

export const SVC = {
  ftms: 0x1826,
  cyclingPower: 0x1818,
  csc: 0x1816,
  heartRate: 0x180d,
  battery: 0x180f,
  /** Running Speed and Cadence — NEVER a cycling-cadence source. Its
   *  "Instantaneous Cadence" field is steps/min from an accelerometer gait
   *  algorithm, categorically unrelated to crank RPM (measured live: the
   *  owner's HRMPro+ chest strap advertises this ALONGSIDE Heart Rate).
   *  Listed here only so it can be discovered/shown honestly — no provider
   *  ever reads from it. */
  runningSpeedCadence: 0x1814,
  /** Tacx/Garmin "FE-C over BLE" — measured live on the owner's Tacx Smart
   *  Bike 12583, which advertises NO 0x1826 FTMS at all. This is that
   *  trainer's ONLY resistance-control path. */
  tacxFec: '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e',
} as const;

export const CHR = {
  indoorBikeData: 0x2ad2,
  ftmsFeature: 0x2acc,
  ftmsControlPoint: 0x2ad9,
  ftmsStatus: 0x2ada,
  cyclingPowerMeasurement: 0x2a63,
  cpFeature: 0x2a65,
  cscMeasurement: 0x2a5b,
  cscFeature: 0x2a5c,
  heartRateMeasurement: 0x2a37,
  batteryLevel: 0x2a19,
  rscMeasurement: 0x2a53,
  /** notify, trainer → client */
  tacxFecTx: '6e40fec2-b5a3-f393-e0a9-e50e24dcca9e',
  /** write, client → trainer */
  tacxFecRx: '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e',
} as const;

export interface KnownService {
  uuid: ServiceUuid;
  label: string;
  chars: ServiceUuid[];
  /** included as its own OR filter entry in the "Add device" chooser.
   *  false = still authorized (optionalServices, discoverable post-connect)
   *  but never by itself a reason a device appears in the primary chooser
   *  — Battery alone and RSC alone are not cycling-relevant signals. */
  chooserFilter: boolean;
}

/** The complete, deliberately-scoped set of services this app ever
 *  authorizes. Deliberately does NOT include the Nordic DFU service or the
 *  unidentified vendor service seen on the real Tacx (cf800001-...) — we
 *  never intend to touch either, and Web Bluetooth's own guidance is to
 *  keep optionalServices to what's actually used, not "everything we might
 *  ever see" (fingerprinting/permission-surface cost for zero benefit). */
export const KNOWN_SERVICES: KnownService[] = [
  {
    uuid: SVC.ftms,
    label: 'FTMS',
    chars: [CHR.indoorBikeData, CHR.ftmsFeature, CHR.ftmsControlPoint, CHR.ftmsStatus],
    chooserFilter: true,
  },
  {
    uuid: SVC.cyclingPower,
    label: 'Cycling Power',
    chars: [CHR.cyclingPowerMeasurement, CHR.cpFeature],
    chooserFilter: true,
  },
  { uuid: SVC.csc, label: 'CSC', chars: [CHR.cscMeasurement, CHR.cscFeature], chooserFilter: true },
  { uuid: SVC.heartRate, label: 'Heart Rate', chars: [CHR.heartRateMeasurement], chooserFilter: true },
  {
    uuid: SVC.tacxFec,
    label: 'Tacx FE-C',
    chars: [CHR.tacxFecTx, CHR.tacxFecRx],
    chooserFilter: true,
  },
  { uuid: SVC.battery, label: 'Battery', chars: [CHR.batteryLevel], chooserFilter: false },
  {
    uuid: SVC.runningSpeedCadence,
    label: 'RSC',
    chars: [CHR.rscMeasurement],
    chooserFilter: false,
  },
];

/** canonical map key for a service/characteristic UUID — shared with
 *  Capabilities.ts and DeviceRegistry.ts so "is this service present"
 *  checks always agree on identity regardless of numeric-vs-string form. */
export function serviceKey(u: ServiceUuid): string {
  return typeof u === 'number' ? `0x${u.toString(16)}` : u.toLowerCase();
}
const ukey = serviceKey;

/** Full 128-bit form of a service UUID, as `BluetoothRemoteGATTService.uuid`
 *  always reports it — 16-bit SIG numbers expand through the Bluetooth Base
 *  UUID. Needed because we key our own maps by `serviceKey` (`0x180d`) but the
 *  browser hands back `0000180d-0000-1000-8000-00805f9b34fb`. */
export function canonicalUuid(u: ServiceUuid): string {
  if (typeof u !== 'number') return u.toLowerCase();
  return `${u.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
}

/** one connected GATT device, service discovery + notify + write abstracted */
export interface BleDeviceHandle {
  /** BluetoothDevice.id — stable per origin+device, the identity
   *  DeviceRegistry keys persisted role assignments on. Fakes synthesize
   *  one so probes can exercise the same identity-matching logic. */
  readonly id: string;
  readonly name: string;
  /** true while the GATT link is up */
  readonly connected: boolean;
  /** does the device expose this AUTHORIZED service? (post-discovery) */
  hasService(service: ServiceUuid): boolean;
  /** does the service expose this specific characteristic? */
  hasCharacteristic(service: ServiceUuid, chr: ServiceUuid): boolean;
  /** subscribe to notifications/indications; resolves once started.
   *  cb receives each notification payload. Missing/failing characteristic
   *  → rejects (never silently no-ops — a broken characteristic on one
   *  service must be visible so provider-isolation can catch it). */
  startNotify(service: ServiceUuid, chr: ServiceUuid, cb: (dv: DataView) => void): Promise<void>;
  /** one-shot characteristic read (features etc.); null if absent/failed */
  read(service: ServiceUuid, chr: ServiceUuid): Promise<DataView | null>;
  /** write to a characteristic (control point ops use with-response) */
  write(service: ServiceUuid, chr: ServiceUuid, data: ArrayBuffer): Promise<void>;
  /** register link-drop callback (gattserverdisconnected analog) */
  onDisconnect(cb: () => void): void;
  /** tear the link down deliberately */
  disconnect(): void;
}

export interface BleTransport {
  /** is a Bluetooth stack available at all? (navigator.bluetooth on Linux
   *  Chrome is absent without the experimental flag) */
  available(): boolean;
  /** open the "cycling devices" chooser — one OR-filter entry per known
   *  cycling-relevant service. MUST be called from a user gesture.
   *  Rejects on user-cancel. */
  requestAnyDevice(): Promise<BleDeviceHandle>;
  /** the literal "все датчики" escape hatch: acceptAllDevices, no service
   *  filter at all — for a sensor this registry doesn't yet recognize. */
  requestAllDevices(): Promise<BleDeviceHandle>;
}

// ---- real Web Bluetooth transport --------------------------------------------
// Minimal ambient typings — tsconfig lib "DOM" (TS 5.9) does not ship Web
// Bluetooth; these cover exactly what we call, nothing more.

interface WBCharacteristic {
  value: DataView | null;
  startNotifications(): Promise<WBCharacteristic>;
  readValue(): Promise<DataView>;
  writeValueWithResponse(data: ArrayBuffer): Promise<void>;
  addEventListener(type: 'characteristicvaluechanged', cb: (ev: Event) => void): void;
}
interface WBService {
  uuid: string;
  getCharacteristic(chr: ServiceUuid): Promise<WBCharacteristic>;
}
interface WBServer {
  connected: boolean;
  connect(): Promise<WBServer>;
  getPrimaryService(svc: ServiceUuid): Promise<WBService>;
  /** all authorized services in ONE round trip — see connectAndDiscover */
  getPrimaryServices?: () => Promise<WBService[]>;
  disconnect(): void;
}
interface WBDevice {
  id: string;
  name?: string;
  gatt?: WBServer;
  addEventListener(type: 'gattserverdisconnected', cb: () => void): void;
}
interface WBBluetooth {
  requestDevice(options: {
    filters?: { services: ServiceUuid[] }[];
    acceptAllDevices?: boolean;
    optionalServices: ServiceUuid[];
  }): Promise<WBDevice>;
}

class RealDeviceHandle implements BleDeviceHandle {
  readonly id: string;
  readonly name: string;
  private device: WBDevice;
  private server: WBServer;
  private services: Map<string, WBService | null>;
  private chars = new Map<string, WBCharacteristic | null>();
  private disconnectCbs: (() => void)[] = [];

  constructor(device: WBDevice, server: WBServer, services: Map<string, WBService | null>) {
    this.device = device;
    this.server = server;
    this.services = services;
    this.id = device.id;
    this.name = device.name ?? 'BLE device';
    this.device.addEventListener('gattserverdisconnected', () => {
      for (const cb of this.disconnectCbs) cb();
    });
  }

  get connected(): boolean {
    return this.server.connected;
  }

  hasService(service: ServiceUuid): boolean {
    return this.services.get(ukey(service)) != null;
  }

  hasCharacteristic(service: ServiceUuid, chr: ServiceUuid): boolean {
    return this.chars.get(`${ukey(service)}:${ukey(chr)}`) != null;
  }

  private svc(service: ServiceUuid): WBService {
    const s = this.services.get(ukey(service));
    if (!s) throw new Error(`service ${ukey(service)} not present`);
    return s;
  }

  /** lazily resolve+cache a characteristic within an already-authorized
   *  service; a missing one throws once and stays cached as absent. */
  private async chr(service: ServiceUuid, chr: ServiceUuid): Promise<WBCharacteristic> {
    const key = `${ukey(service)}:${ukey(chr)}`;
    const cached = this.chars.get(key);
    if (cached) return cached;
    if (this.chars.has(key)) throw new Error(`characteristic ${key} not present`);
    try {
      const c = await this.svc(service).getCharacteristic(chr);
      this.chars.set(key, c);
      return c;
    } catch (e) {
      this.chars.set(key, null);
      throw e;
    }
  }

  async startNotify(service: ServiceUuid, chr: ServiceUuid, cb: (dv: DataView) => void): Promise<void> {
    const c = await this.chr(service, chr);
    c.addEventListener('characteristicvaluechanged', () => {
      if (c.value) cb(c.value);
    });
    await c.startNotifications();
  }

  async read(service: ServiceUuid, chr: ServiceUuid): Promise<DataView | null> {
    try {
      const c = await this.chr(service, chr);
      return await c.readValue();
    } catch {
      return null;
    }
  }

  async write(service: ServiceUuid, chr: ServiceUuid, data: ArrayBuffer): Promise<void> {
    const c = await this.chr(service, chr);
    await c.writeValueWithResponse(data);
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb);
  }

  disconnect(): void {
    this.server.disconnect();
  }
}

/**
 * Discover which of KNOWN_SERVICES this peripheral actually exposes.
 *
 * ONE getPrimaryServices() call, not one getPrimaryService() per known
 * service. This is a bug fix, not a tidy-up. The per-service loop asked for
 * all of KNOWN_SERVICES sequentially and swallowed a NotFoundError for each
 * absent one — so the cost of connecting scaled with our registry rather than
 * with the device, and every await landed BEFORE the provider could subscribe.
 *
 * A single-purpose peripheral pays that worst: an HR strap has 0x180D and
 * nothing else, so it ate one rejection per remaining known service before
 * anyone called startNotifications(). Straps run short supervision timeouts
 * and drop the link through that window; the next call then finds
 * `server.connected === false` and Web Bluetooth throws its "GATT Server is
 * disconnected" DOMException. Devices with richer service sets (the trainer,
 * the power pedals) kept working, which is exactly why the breakage looked
 * like "HR specifically is broken". Reported by the owner 2026-07-15.
 *
 * getPrimaryServices() returns only services already authorized via
 * filters/optionalServices — the same scope the loop had — so nothing widens.
 * It rejects with NotFoundError when the device exposes none of them; that is
 * a legitimate empty result, not a failure. The loop stays as a fallback for
 * any implementation lacking the plural form (our own FakeTransport never gets
 * here — it implements BleDeviceHandle directly).
 */
async function discoverServices(server: WBServer): Promise<Map<string, WBService | null>> {
  const services = new Map<string, WBService | null>(KNOWN_SERVICES.map((s) => [ukey(s.uuid), null]));
  if (typeof server.getPrimaryServices === 'function') {
    let found: WBService[] = [];
    try {
      found = await server.getPrimaryServices();
    } catch {
      found = []; // NotFoundError = device has none of ours
    }
    const byCanonical = new Map(KNOWN_SERVICES.map((s) => [canonicalUuid(s.uuid), ukey(s.uuid)]));
    for (const svc of found) {
      const key = byCanonical.get(svc.uuid.toLowerCase());
      if (key) services.set(key, svc);
    }
    return services;
  }
  for (const s of KNOWN_SERVICES) {
    try {
      services.set(ukey(s.uuid), await server.getPrimaryService(s.uuid));
    } catch {
      services.set(ukey(s.uuid), null);
    }
  }
  return services;
}

async function connectAndDiscover(device: WBDevice): Promise<RealDeviceHandle> {
  if (!device.gatt) throw new Error('device has no GATT server');
  const server = await device.gatt.connect();
  return new RealDeviceHandle(device, server, await discoverServices(server));
}

/** ONE filter entry PER service = OR across entries. A single entry
 *  listing multiple services would be AND — the exact bug that hid the
 *  Tacx (0x1818+0x1816+FE-C, no 0x1826) behind a filter written for
 *  FTMS-only trainers. Exported as a pure function (no navigator.bluetooth
 *  dependency) so tools/probe-ble.ts can assert the OR-shape directly,
 *  in plain Node, without a browser. */
export function buildAnyDeviceFilters(): { services: ServiceUuid[] }[] {
  return KNOWN_SERVICES.filter((s) => s.chooserFilter).map((s) => ({ services: [s.uuid] }));
}

export function optionalServices(): ServiceUuid[] {
  return KNOWN_SERVICES.map((s) => s.uuid);
}

export class WebBluetoothTransport implements BleTransport {
  available(): boolean {
    return 'bluetooth' in navigator;
  }

  private bt(): WBBluetooth {
    return (navigator as unknown as { bluetooth: WBBluetooth }).bluetooth;
  }

  async requestAnyDevice(): Promise<BleDeviceHandle> {
    const device = await this.bt().requestDevice({
      filters: buildAnyDeviceFilters(),
      optionalServices: optionalServices(),
    });
    return connectAndDiscover(device);
  }

  async requestAllDevices(): Promise<BleDeviceHandle> {
    const device = await this.bt().requestDevice({
      acceptAllDevices: true,
      optionalServices: optionalServices(),
    });
    return connectAndDiscover(device);
  }
}

// ---- fake transport (probes: capability derivation, role mux, P6 dropout) ------

export interface FakeWrite {
  service: ServiceUuid;
  chr: ServiceUuid;
  bytes: Uint8Array;
}

interface FakeCharSpec {
  /** startNotify() rejects for this characteristic (models a real device
   *  whose subscribe genuinely fails on one broken characteristic while
   *  the rest of the device stays healthy — provider isolation depends on
   *  this being testable, not just assumed). */
  subscribeFails?: boolean;
  /** read() resolves null (characteristic present but unreadable) */
  readFails?: boolean;
}

let fakeIdCounter = 0;

/**
 * FakeDevice — scripted GATT peripheral for headless probes. The probe:
 *   1. declares services (constructor) and, optionally, per-characteristic
 *      failure modes (scriptCharacteristic),
 *   2. pushes notifications with `emit()` (parsed exactly like real ones),
 *   3. inspects control-point traffic in `writes`,
 *   4. severs the link with `drop()` to exercise dropout.
 */
export class FakeDevice implements BleDeviceHandle {
  readonly id: string;
  readonly name: string;
  connected = true;
  readonly writes: FakeWrite[] = [];
  /** map "svc:chr" → static readable value */
  readonly readable = new Map<string, DataView>();
  private services: Set<string>;
  private charSpecs = new Map<string, FakeCharSpec>();
  private notifyCbs = new Map<string, (dv: DataView) => void>();
  private disconnectCbs: (() => void)[] = [];

  constructor(name: string, services: ServiceUuid[], id?: string) {
    this.name = name;
    this.id = id ?? `fake-${name}-${++fakeIdCounter}`;
    this.services = new Set(services.map(ukey));
  }

  /** probe API — script a characteristic's subscribe/read outcome */
  scriptCharacteristic(service: ServiceUuid, chr: ServiceUuid, spec: FakeCharSpec): void {
    this.charSpecs.set(`${ukey(service)}:${ukey(chr)}`, spec);
  }

  hasService(service: ServiceUuid): boolean {
    return this.services.has(ukey(service));
  }

  hasCharacteristic(service: ServiceUuid, chr: ServiceUuid): boolean {
    if (!this.hasService(service)) return false;
    return this.charSpecs.get(`${ukey(service)}:${ukey(chr)}`)?.subscribeFails !== true;
  }

  async startNotify(service: ServiceUuid, chr: ServiceUuid, cb: (dv: DataView) => void): Promise<void> {
    if (!this.hasService(service)) throw new Error('no such service');
    const spec = this.charSpecs.get(`${ukey(service)}:${ukey(chr)}`);
    if (spec?.subscribeFails) throw new Error(`subscribe failed (scripted): ${ukey(service)}:${ukey(chr)}`);
    this.notifyCbs.set(`${ukey(service)}:${ukey(chr)}`, cb);
  }

  async read(service: ServiceUuid, chr: ServiceUuid): Promise<DataView | null> {
    const spec = this.charSpecs.get(`${ukey(service)}:${ukey(chr)}`);
    if (spec?.readFails) return null;
    return this.readable.get(`${ukey(service)}:${ukey(chr)}`) ?? null;
  }

  async write(service: ServiceUuid, chr: ServiceUuid, data: ArrayBuffer): Promise<void> {
    if (!this.connected) throw new Error('GATT link down');
    const bytes = new Uint8Array(data.slice(0));
    this.writes.push({ service, chr, bytes });
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb);
  }

  disconnect(): void {
    this.drop();
  }

  /** probe API — push one notification into the parser path */
  emit(service: ServiceUuid, chr: ServiceUuid, bytes: Uint8Array): void {
    if (!this.connected) return;
    const cb = this.notifyCbs.get(`${ukey(service)}:${ukey(chr)}`);
    if (cb) cb(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  /** probe API — reply to the most recent write on a characteristic by
   *  emitting a notification/indication (control-point response frames) */
  respond(notifyService: ServiceUuid, notifyChr: ServiceUuid, bytes: Uint8Array): void {
    this.emit(notifyService, notifyChr, bytes);
  }

  /** probe API — simulate a link drop (rider's battery dies mid-climb) */
  drop(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const cb of this.disconnectCbs) cb();
  }
}

export class FakeTransport implements BleTransport {
  /** one FIFO queue — a probe stages exactly the device(s) it wants
   *  regardless of which chooser variant (any/all) it's simulating; the
   *  real distinction (filter application) doesn't exist for a fake. */
  private pending: FakeDevice[] = [];

  available(): boolean {
    return true;
  }

  stage(device: FakeDevice): void {
    this.pending.push(device);
  }

  private take(): Promise<BleDeviceHandle> {
    const d = this.pending.shift();
    if (!d) return Promise.reject(new Error('fake transport: no staged device (user cancelled)'));
    return Promise.resolve(d);
  }

  requestAnyDevice(): Promise<BleDeviceHandle> {
    return this.take();
  }

  requestAllDevices(): Promise<BleDeviceHandle> {
    return this.take();
  }
}
