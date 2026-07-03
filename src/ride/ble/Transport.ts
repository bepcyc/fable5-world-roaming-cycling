/**
 * BLE transport adapter — the boundary that makes M1.4 testable without a
 * Bluetooth stack. `BleSensorSource` talks ONLY to this interface; the real
 * implementation wraps Web Bluetooth, the fake one drives probes (P6
 * dropout, SIM-gradient observation) in headless Chromium, which has no BT.
 *
 * Web Bluetooth constraints baked into the design (verified 2026-07-03,
 * docs/notes/ble-ftms-research.md):
 * - requestDevice() REQUIRES transient user activation → connect() is only
 *   ever called from the Connect UI button handler, never automatically.
 * - Any service not in a requestDevice filter must be pre-listed in
 *   optionalServices, or getPrimaryService throws SecurityError.
 * - getDevices()/watchAdvertisements (silent reconnect) are flag-gated in
 *   Chrome — we therefore treat "user re-picks from chooser" as the normal
 *   reconnect path and only OFFER gattserverdisconnected auto-retry on the
 *   still-permitted BluetoothDevice object we hold.
 * - Linux Chrome needs chrome://flags/#enable-experimental-web-platform-features
 *   (owner machine is pop-os — surfaced in the Connect UI when
 *   navigator.bluetooth is absent).
 */

export type BleDeviceKind = 'trainer' | 'power' | 'csc' | 'hr';

/** UUIDs (16-bit SIG names accepted by Web Bluetooth as full 128-bit) */
export const SVC = {
  ftms: 0x1826,
  cyclingPower: 0x1818,
  csc: 0x1816,
  heartRate: 0x180d,
  battery: 0x180f,
} as const;

export const CHR = {
  indoorBikeData: 0x2ad2,
  ftmsFeature: 0x2acc,
  ftmsControlPoint: 0x2ad9,
  ftmsStatus: 0x2ada,
  cyclingPowerMeasurement: 0x2a63,
  cscMeasurement: 0x2a5b,
  heartRateMeasurement: 0x2a37,
} as const;

/** which service+characteristics each device slot subscribes to */
export const KIND_PROFILE: Record<
  BleDeviceKind,
  { filterServices: number[]; optionalServices: number[] }
> = {
  trainer: {
    filterServices: [SVC.ftms],
    optionalServices: [SVC.cyclingPower, SVC.csc, SVC.battery],
  },
  power: { filterServices: [SVC.cyclingPower], optionalServices: [SVC.csc, SVC.battery] },
  csc: { filterServices: [SVC.csc], optionalServices: [SVC.battery] },
  hr: { filterServices: [SVC.heartRate], optionalServices: [SVC.battery] },
};

/** one connected GATT device, service discovery + notify + write abstracted */
export interface BleDeviceHandle {
  readonly name: string;
  /** true while the GATT link is up */
  readonly connected: boolean;
  /** does the device expose this service? (post-discovery) */
  hasService(service: number): boolean;
  /** subscribe to notifications/indications; resolves once started.
   *  cb receives each notification payload. Missing characteristic → throws. */
  startNotify(service: number, chr: number, cb: (dv: DataView) => void): Promise<void>;
  /** one-shot characteristic read (features etc.); null if absent */
  read(service: number, chr: number): Promise<DataView | null>;
  /** write to a characteristic (control point ops use with-response) */
  write(service: number, chr: number, data: ArrayBuffer): Promise<void>;
  /** register link-drop callback (gattserverdisconnected analog) */
  onDisconnect(cb: () => void): void;
  /** tear the link down deliberately */
  disconnect(): void;
}

export interface BleTransport {
  /** is a Bluetooth stack available at all? (navigator.bluetooth on Linux
   *  Chrome is absent without the experimental flag) */
  available(): boolean;
  /** open the device chooser for a slot — MUST be called from a user
   *  gesture on the real transport. Rejects on user-cancel. */
  requestDevice(kind: BleDeviceKind): Promise<BleDeviceHandle>;
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
  getCharacteristic(chr: number): Promise<WBCharacteristic>;
}
interface WBServer {
  connected: boolean;
  connect(): Promise<WBServer>;
  getPrimaryService(svc: number): Promise<WBService>;
  disconnect(): void;
}
interface WBDevice {
  name?: string;
  gatt?: WBServer;
  addEventListener(type: 'gattserverdisconnected', cb: () => void): void;
}
interface WBBluetooth {
  requestDevice(options: {
    filters: { services: number[] }[];
    optionalServices: number[];
  }): Promise<WBDevice>;
}

class RealDeviceHandle implements BleDeviceHandle {
  readonly name: string;
  private device: WBDevice;
  private server: WBServer;
  private services = new Map<number, WBService | null>();
  private disconnectCbs: (() => void)[] = [];

  constructor(device: WBDevice, server: WBServer, probed: Map<number, WBService | null>) {
    this.device = device;
    this.server = server;
    this.services = probed;
    this.name = device.name ?? 'BLE device';
    this.device.addEventListener('gattserverdisconnected', () => {
      for (const cb of this.disconnectCbs) cb();
    });
  }

  get connected(): boolean {
    return this.server.connected;
  }

  hasService(service: number): boolean {
    return this.services.get(service) != null;
  }

  private svc(service: number): WBService {
    const s = this.services.get(service);
    if (!s) throw new Error(`service 0x${service.toString(16)} not present`);
    return s;
  }

  async startNotify(service: number, chr: number, cb: (dv: DataView) => void): Promise<void> {
    const c = await this.svc(service).getCharacteristic(chr);
    c.addEventListener('characteristicvaluechanged', () => {
      if (c.value) cb(c.value);
    });
    await c.startNotifications();
  }

  async read(service: number, chr: number): Promise<DataView | null> {
    try {
      const c = await this.svc(service).getCharacteristic(chr);
      return await c.readValue();
    } catch {
      return null;
    }
  }

  async write(service: number, chr: number, data: ArrayBuffer): Promise<void> {
    const c = await this.svc(service).getCharacteristic(chr);
    await c.writeValueWithResponse(data);
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb);
  }

  disconnect(): void {
    this.server.disconnect();
  }
}

export class WebBluetoothTransport implements BleTransport {
  available(): boolean {
    return 'bluetooth' in navigator;
  }

  async requestDevice(kind: BleDeviceKind): Promise<BleDeviceHandle> {
    const bt = (navigator as unknown as { bluetooth: WBBluetooth }).bluetooth;
    const prof = KIND_PROFILE[kind];
    const device = await bt.requestDevice({
      filters: [{ services: prof.filterServices }],
      optionalServices: prof.optionalServices,
    });
    if (!device.gatt) throw new Error('device has no GATT server');
    const server = await device.gatt.connect();
    // discover once; absent optional services become null (hasService=false)
    const probed = new Map<number, WBService | null>();
    for (const svc of [...prof.filterServices, ...prof.optionalServices]) {
      try {
        probed.set(svc, await server.getPrimaryService(svc));
      } catch {
        probed.set(svc, null);
      }
    }
    return new RealDeviceHandle(device, server, probed);
  }
}

// ---- fake transport (probes: P6 dropout, SIM-gradient observation) ------------

export interface FakeWrite {
  service: number;
  chr: number;
  bytes: Uint8Array;
}

/**
 * FakeDevice — scripted GATT peripheral for headless probes. The probe:
 *   1. declares services/characteristics,
 *   2. pushes notifications with `emit()` (parsed exactly like real ones),
 *   3. inspects control-point traffic in `writes`,
 *   4. severs the link with `drop()` to exercise P6.
 * Control-point writes auto-answer success (op 0x80/req/0x01) unless a
 * custom responder is installed — mirrors a well-behaved FTMS trainer.
 */
export class FakeDevice implements BleDeviceHandle {
  readonly name: string;
  connected = true;
  readonly writes: FakeWrite[] = [];
  /** map "svc:chr" → static readable value */
  readonly readable = new Map<string, DataView>();
  respondToControlPoint = true;
  private services: Set<number>;
  private notifyCbs = new Map<string, (dv: DataView) => void>();
  private disconnectCbs: (() => void)[] = [];

  constructor(name: string, services: number[]) {
    this.name = name;
    this.services = new Set(services);
  }

  hasService(service: number): boolean {
    return this.services.has(service);
  }

  async startNotify(service: number, chr: number, cb: (dv: DataView) => void): Promise<void> {
    if (!this.services.has(service)) throw new Error('no such service');
    this.notifyCbs.set(`${service}:${chr}`, cb);
  }

  async read(service: number, chr: number): Promise<DataView | null> {
    return this.readable.get(`${service}:${chr}`) ?? null;
  }

  async write(service: number, chr: number, data: ArrayBuffer): Promise<void> {
    if (!this.connected) throw new Error('GATT link down');
    const bytes = new Uint8Array(data.slice(0));
    this.writes.push({ service, chr, bytes });
    if (this.respondToControlPoint && chr === CHR.ftmsControlPoint) {
      const resp = new Uint8Array([0x80, bytes[0] ?? 0, 0x01]);
      this.emit(service, chr, resp);
    }
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb);
  }

  disconnect(): void {
    this.drop();
  }

  /** probe API — push one notification into the parser path */
  emit(service: number, chr: number, bytes: Uint8Array): void {
    if (!this.connected) return;
    const cb = this.notifyCbs.get(`${service}:${chr}`);
    if (cb) cb(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  /** probe API — simulate a link drop (rider's battery dies mid-climb) */
  drop(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const cb of this.disconnectCbs) cb();
  }
}

export class FakeTransport implements BleTransport {
  /** queue of devices handed out per requestDevice call, FIFO per kind */
  readonly pending = new Map<BleDeviceKind, FakeDevice[]>();

  available(): boolean {
    return true;
  }

  stage(kind: BleDeviceKind, device: FakeDevice): void {
    const q = this.pending.get(kind) ?? [];
    q.push(device);
    this.pending.set(kind, q);
  }

  async requestDevice(kind: BleDeviceKind): Promise<BleDeviceHandle> {
    const q = this.pending.get(kind);
    const d = q?.shift();
    if (!d) throw new Error(`fake transport: no staged device for '${kind}' (user cancelled)`);
    return d;
  }
}
