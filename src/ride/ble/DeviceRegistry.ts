/**
 * DeviceRegistry — owns the paired-device list, connect/reconnect/forget,
 * per-protocol GATT probing + capability derivation, and provider isolation
 * (one broken characteristic on a multi-service device must never poison
 * another protocol on the same device). Feeds everything it discovers into
 * `RoleMux`, which owns role assignment.
 *
 * Identity: keyed by `BluetoothDevice.id` (never by name) — Chrome's own
 * stable per-origin-per-device id. Selecting the same device twice via Add
 * Device reuses/updates the existing card rather than spawning duplicate
 * providers, guarded by a per-device generation token so a stale async
 * callback from a superseded connection attempt can never mutate the
 * current one's state (double-click Add Device, or a fast reconnect racing
 * a slow disconnect).
 */

import {
  deriveProtocolCapabilities,
  deviceProfileKey,
  type DeviceCapabilities,
  type GattProbe,
  type Protocol,
} from './Capabilities';
import { parseCpFeature, parseCscFeature, parseFtmsFeatures } from './Parsers';
import { C2Provider } from './providers/C2Provider';
import { CpsProvider } from './providers/CpsProvider';
import { CscProvider } from './providers/CscProvider';
import { FtmsProvider } from './providers/FtmsProvider';
import { HrsProvider } from './providers/HrsProvider';
import { KayakFirstProvider } from './providers/KayakFirstProvider';
import { LfProvider } from './providers/LfProvider';
import { PrecorProvider } from './providers/PrecorProvider';
import { RscProvider } from './providers/RscProvider';
import { SchwinnX70Provider } from './providers/SchwinnX70Provider';
import { TacxFecProvider } from './providers/TacxFecProvider';
import { RoleMux } from './RoleMux';
import { FtmsController, TacxFecController } from './TrainerController';
import { CHR, SVC, serviceKey, type BleDeviceHandle, type BleTransport } from './Transport';

export type ConnectionStage = 'connecting' | 'discovering' | 'subscribing' | 'ready' | 'lost';

export interface PairedDevice {
  readonly id: string;
  name: string;
  /** null once a persisted-but-never-reconnected-this-session entry, or
   *  after a deliberate disconnect — "Known devices", not "connected" */
  handle: BleDeviceHandle | null;
  stage: ConnectionStage;
  protocols: Protocol[];
  lastError: string | null;
}

/** exported for NativeBridgeTransport's chooser: the native picker seeds its
 *  list with saved devices so a paired-but-not-currently-advertising trainer
 *  (the owner's Tacx goes quiet after its first bond) stays reachable */
export const KNOWN_NAMES_KEY = 'laas.ble.knownDeviceNames.v1';

function loadKnownNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_NAMES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function saveKnownNames(m: Record<string, string>): void {
  try {
    localStorage.setItem(KNOWN_NAMES_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled/full — non-fatal, this is a convenience cache */
  }
}

async function probeGatt(handle: BleDeviceHandle): Promise<GattProbe> {
  const services = new Set<string>();
  for (const svc of [
    SVC.ftms,
    SVC.cyclingPower,
    SVC.csc,
    SVC.heartRate,
    SVC.tacxFec,
    SVC.battery,
    SVC.runningSpeedCadence,
    SVC.concept2Erg,
    SVC.schwinnX70,
    SVC.precor,
    SVC.kayakFirst,
    SVC.lifeFitnessControl,
  ]) {
    if (handle.hasService(svc)) services.add(serviceKey(svc));
  }
  const cpFeature = handle.hasService(SVC.cyclingPower)
    ? await handle.read(SVC.cyclingPower, CHR.cpFeature).then((dv) => (dv ? parseCpFeature(dv) : null))
    : null;
  const cscFeature = handle.hasService(SVC.csc)
    ? await handle.read(SVC.csc, CHR.cscFeature).then((dv) => (dv ? parseCscFeature(dv) : null))
    : null;
  const ftmsFeature = handle.hasService(SVC.ftms)
    ? await handle.read(SVC.ftms, CHR.ftmsFeature).then((dv) => (dv ? parseFtmsFeatures(dv) : null))
    : null;
  return { services, cpFeature, cscFeature, ftmsFeature };
}

export class DeviceRegistry {
  readonly roleMux = new RoleMux();
  private devices = new Map<string, PairedDevice>();
  private knownNames: Record<string, string>;
  private listeners: (() => void)[] = [];
  private transport: BleTransport;
  private generation = new Map<string, number>();
  /** zombie-READY watchdog state (see update()) */
  private aliveT = 0;
  private aliveBusy = new Set<string>();

  constructor(transport: BleTransport) {
    this.transport = transport;
    this.knownNames = loadKnownNames();
    for (const [id, name] of Object.entries(this.knownNames)) {
      this.devices.set(id, { id, name, handle: null, stage: 'lost', protocols: [], lastError: null });
    }
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }
  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  available(): boolean {
    return this.transport.available();
  }

  list(): PairedDevice[] {
    return [...this.devices.values()];
  }

  /** MUST be called from a user gesture (Web Bluetooth requirement) */
  async addDevice(all = false): Promise<void> {
    const handle = all ? await this.transport.requestAllDevices() : await this.transport.requestAnyDevice();
    await this.bind(handle);
  }

  /** re-pairing an already-known-but-disconnected device — still a fresh
   *  chooser gesture (Web Bluetooth has no silent reconnect we depend on;
   *  getDevices() is flag-gated and Chromium calls Linux support
   *  "partially implemented, not supported"). If the user picks the SAME
   *  physical device, bind() below re-matches its stable id to this entry. */
  async reconnect(): Promise<void> {
    await this.addDevice(false);
  }

  disconnect(id: string): void {
    this.devices.get(id)?.handle?.disconnect();
  }

  forget(id: string): void {
    this.disconnect(id);
    this.teardown(id);
    this.devices.delete(id);
    delete this.knownNames[id];
    saveKnownNames(this.knownNames);
    this.notify();
  }

  private async bind(handle: BleDeviceHandle): Promise<void> {
    // teardown() FIRST (bumps generation), THEN capture this bind's own
    // gen from the just-bumped counter — guarantees THIS attempt is always
    // the newest, and invalidates a previous still-in-flight bind() for
    // the same id even if it hadn't reached its own attachProtocol() await
    // yet (adversarial review finding, 2026-07-15 — codex gpt-5.6-sol: the
    // pre-fix ordering captured `gen` BEFORE teardown(), so teardown() and
    // forget() never actually invalidated anything, and forget()-during-
    // discovery could let a still-resolving GATT probe register ghost
    // providers into RoleMux for a device the user had just forgotten).
    this.teardown(handle.id); // dedupe: re-selecting a known device replaces its providers, not duplicates them
    const gen = (this.generation.get(handle.id) ?? 0) + 1;
    this.generation.set(handle.id, gen);
    const stale = (): boolean => this.generation.get(handle.id) !== gen;

    const entry: PairedDevice = {
      id: handle.id,
      name: handle.name,
      handle,
      stage: 'discovering',
      protocols: [],
      lastError: null,
    };
    this.devices.set(handle.id, entry);
    this.knownNames[handle.id] = handle.name;
    saveKnownNames(this.knownNames);
    handle.onDisconnect(() => {
      if (stale()) return;
      // bump generation HERE too — a real link drop mid-discovery must
      // invalidate THIS bind's own still-in-flight probeGatt()/
      // attachProtocol() continuation, or it can finish afterward and
      // overwrite this 'lost' stage back to 'ready' (adversarial review
      // finding, 2026-07-15 — the pre-fix onDisconnect only flipped
      // `entry.stage`, which the async continuation below could clobber).
      this.generation.set(handle.id, gen + 1);
      entry.stage = 'lost';
      // link loss must actually stop projecting this device's telemetry
      // and release control if it was the active controller — NOT just
      // flip a display flag (codex build-review finding, 2026-07-15: the
      // pre-fix code only set `stage`, leaving a dead handle's provider
      // live in RoleMux and `update()` still attempting writes against
      // it). Assignment itself is untouched — RoleMux.read()/candidatesFor
      // simply stop finding a provider for this deviceId, surfacing as
      // "assigned but disconnected," exactly the intended orphaned state.
      this.unregisterRoleMux(handle.id);
      this.notify();
    });
    this.notify();

    try {
      const probe = await probeGatt(handle);
      if (stale()) return;
      entry.stage = 'subscribing';
      this.notify();
      const perProtocol = deriveProtocolCapabilities(probe);
      for (const protocol of Object.keys(perProtocol) as Protocol[]) {
        if (stale()) return;
        const caps = perProtocol[protocol];
        if (!caps) continue;
        try {
          await this.attachProtocol(handle, protocol, caps, stale);
          if (stale()) return; // superseded while attachProtocol's start() was in flight — never record onto an orphaned entry
          entry.protocols.push(protocol);
        } catch (e) {
          // provider isolation: one broken characteristic on THIS protocol
          // must not stop the others on the same device from attaching
          entry.lastError = e instanceof Error ? e.message : String(e);
        }
      }
      if (stale()) return;
      entry.stage = entry.protocols.length > 0 ? 'ready' : 'lost';
    } catch (e) {
      if (stale()) return;
      entry.stage = 'lost';
      entry.lastError = e instanceof Error ? e.message : String(e);
    }
    this.notify();
  }

  /**
   * NOTE the `stale` re-check right after each `await p.start()`, BEFORE
   * registering into RoleMux: without it, a superseded bind() attempt
   * (the user double-clicked Add Device on the same physical device, or a
   * fast reconnect raced a slow one) could have its OWN teardown() run
   * before this attempt's subscribe resolves — then this stale attempt
   * would register itself into RoleMux with nothing left to remove it,
   * leaking a dead-generation provider indefinitely (codex build-review
   * finding, 2026-07-15). A stale provider is deliberately left
   * unregistered (not registered-then-immediately-torn-down) — its
   * subscription callback lives on the now-superseded `handle`, which
   * either never fires again (real disconnect) or is harmlessly
   * overwritten by the newer attempt's own subscribe on the fresh handle.
   */
  private async attachProtocol(
    handle: BleDeviceHandle,
    protocol: Protocol,
    caps: DeviceCapabilities,
    stale: () => boolean,
  ): Promise<void> {
    if (protocol === 'ftms') {
      const p = new FtmsProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
      if (caps.control) this.roleMux.registerController(handle.id, handle.name, new FtmsController(handle, caps.control));
    } else if (protocol === 'cps') {
      const p = new CpsProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    } else if (protocol === 'csc') {
      const p = new CscProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    } else if (protocol === 'hrs') {
      const p = new HrsProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    } else if (protocol === 'fec') {
      const p = new TacxFecProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
      this.roleMux.registerController(handle.id, handle.name, new TacxFecController(handle));
    } else if (protocol === 'lf') {
      // Life Fitness: FTMS bike behind a handshake; control is standard FTMS.
      const p = new LfProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
      if (caps.control) this.roleMux.registerController(handle.id, handle.name, new FtmsController(handle, caps.control));
    } else if (protocol === 'c2') {
      const p = new C2Provider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    } else if (protocol === 'x70') {
      const p = new SchwinnX70Provider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    } else if (protocol === 'precor') {
      const p = new PrecorProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    } else if (protocol === 'kf') {
      const p = new KayakFirstProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    } else if (protocol === 'rsc') {
      // RSC is not auto-derived (Capabilities.ts RSC exclusion); this branch
      // exists so an explicit `rsc` capability, if ever added, streams speed.
      const p = new RscProvider(handle, caps);
      await p.start();
      if (stale()) return;
      this.roleMux.registerProvider(p);
    }
  }

  /** remove this device's providers/controllers from RoleMux WITHOUT
   *  touching `entry.protocols` — used on link loss, where the lost
   *  card should keep showing what it used to support (grayed by the
   *  'lost' stage styling), just no longer feeding any role live. */
  private unregisterRoleMux(id: string): void {
    const entry = this.devices.get(id);
    if (!entry) return;
    for (const protocol of entry.protocols) {
      this.roleMux.unregisterProvider(id, protocol);
      this.roleMux.unregisterController(id, protocol);
    }
  }

  /** full teardown (dedupe-on-rebind, forget()): also clears the
   *  capability list, since a fresh bind is about to rebuild it (or the
   *  device is being forgotten entirely). ALSO bumps the generation token
   *  — forget()/a fresh bind() must invalidate any still-in-flight bind()
   *  for this id SYNCHRONOUSLY (adversarial review finding, 2026-07-15):
   *  forget() severs a real BluetoothDevice's GATT link asynchronously
   *  (the 'gattserverdisconnected' event is browser-scheduled, not
   *  immediate), so relying on the onDisconnect handler alone left a
   *  window where a still-resolving probeGatt()/attachProtocol() could
   *  register a "ghost" provider into RoleMux for a device the user had
   *  already forgotten and deleted from `this.devices`. bind() itself
   *  always re-derives its own `gen` from the counter AFTER calling this,
   *  so this bump never makes a bind() stale to itself. */
  private teardown(id: string): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.unregisterRoleMux(id);
    const entry = this.devices.get(id);
    if (entry) entry.protocols = [];
  }

  /** diagnostic: everything discovered for one (device, protocol) pair —
   *  DeviceManagerUi's advanced per-channel disclosure reads this. */
  profileKey(deviceId: string, protocol: Protocol): string {
    return deviceProfileKey(deviceId, protocol);
  }

  update(dt: number): void {
    this.roleMux.update(dt);
    // zombie-READY watchdog: a BT-stack restart can swallow the disconnect
    // callback entirely, freezing a dead link at stage 'ready' (hit live
    // 2026-07-17 — green card, every op failing "device not connected").
    // Poll the transport's ground truth and run the normal loss path when
    // it disagrees. Fire-and-forget with a re-entry guard; entries whose
    // handle lacks probeAlive() keep the old event-only behavior.
    this.aliveT += dt;
    if (this.aliveT >= ALIVE_POLL_S) {
      this.aliveT = 0;
      for (const entry of this.devices.values()) {
        const handle = entry.handle;
        if (entry.stage !== 'ready' || !handle?.probeAlive || this.aliveBusy.has(entry.id)) continue;
        this.aliveBusy.add(entry.id);
        void handle
          .probeAlive()
          .then((alive) => {
            if (alive) return;
            const cur = this.devices.get(entry.id);
            if (!cur || cur.handle !== handle || cur.stage !== 'ready') return; // superseded meanwhile
            this.generation.set(entry.id, (this.generation.get(entry.id) ?? 0) + 1);
            cur.stage = 'lost';
            this.unregisterRoleMux(entry.id);
            this.notify();
          })
          .catch(() => {})
          .finally(() => this.aliveBusy.delete(entry.id));
      }
    }
  }
}

/** liveness poll cadence — cheap (one tiny bridge call per ready device) */
const ALIVE_POLL_S = 4;
