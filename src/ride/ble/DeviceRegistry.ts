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
import { CpsProvider } from './providers/CpsProvider';
import { CscProvider } from './providers/CscProvider';
import { FtmsProvider } from './providers/FtmsProvider';
import { HrsProvider } from './providers/HrsProvider';
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

const KNOWN_NAMES_KEY = 'laas.ble.knownDeviceNames.v1';

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
    const gen = (this.generation.get(handle.id) ?? 0) + 1;
    this.generation.set(handle.id, gen);
    const stale = (): boolean => this.generation.get(handle.id) !== gen;

    this.teardown(handle.id); // dedupe: re-selecting a known device replaces its providers, not duplicates them
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
   *  device is being forgotten entirely). */
  private teardown(id: string): void {
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
  }
}
