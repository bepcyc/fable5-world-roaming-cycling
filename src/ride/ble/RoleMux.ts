/**
 * RoleMux — the device-to-role assignment engine. Five roles: power,
 * cadence, speed, heartRate, control. Each role holds at most one
 * (deviceId, protocol) assignment, or an explicit sticky "none".
 *
 * DEFAULT-ASSIGN POLICY: when a provider/controller registers and the role
 * it can serve has never been touched (assignment === null), auto-fill it
 * — visibly marked as an automatic default in the UI (DeviceManagerUi).
 * A role already assigned (even to a now-disconnected device, even to
 * explicit "none") is NEVER overridden by a later connection — this is
 * the exact mechanism behind the owner's acceptance case: connect the
 * trainer (auto-fills power+cadence+control) → connect the pedals
 * (capable of power+cadence; nothing changes automatically) → the rider
 * manually re-points Power and Cadence to the pedals → Control stays on
 * the trainer (pedals never register a controller) → the trainer's own
 * power/cadence providers keep streaming, visible on its card, dimmed as
 * unused, but never reach `read()`.
 *
 * REVOLUTION-COUNTER OWNERSHIP: estimators live INSIDE each provider
 * (providers/*), never here — reassigning a role only changes which
 * provider's `sample()` gets projected, so it never disturbs an
 * estimator's baseline. This file does not (and must not) touch counters.
 *
 * CONTROL ACTIVATION is a separate concept from control ASSIGNMENT — see
 * activateControl()/releaseControl(); a controller is picked here but
 * never acquired here.
 */

import { deviceProfileKey, ROLES, type DeviceCapabilities, type Metric, type Protocol, type Role } from './Capabilities';
import type { TelemetryProvider } from './providers/Provider';
import type { TrainerController } from './TrainerController';

export type Assignment = { deviceId: string; protocol: Protocol } | 'none' | null;

export interface RoleCandidate {
  deviceId: string;
  deviceName: string;
  protocol: Protocol;
}

export interface RoleRow {
  role: Role;
  assignment: Assignment;
  /** live sample, honoring the current assignment; null if unassigned,
   *  assigned-but-stale/waiting, or assigned-but-disconnected — no
   *  synthesis, ever (Pillar C: an unavailable channel reads "—") */
  value: number | null;
  state: 'unassigned' | 'live' | 'stale' | 'waiting' | 'disconnected' | 'inactive';
  candidates: RoleCandidate[];
}

const PROTOCOL_PRIORITY: Record<Protocol, number> = { ftms: 0, cps: 1, csc: 2, hrs: 3, fec: 4 };
const LS_KEY = 'laas.ble.roleAssignments.v1';

function loadPersisted(): Partial<Record<Role, Assignment>> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<Role, Assignment>>) : {};
  } catch {
    return {};
  }
}

function savePersisted(a: ReadonlyMap<Role, Assignment>): void {
  try {
    const obj: Partial<Record<Role, Assignment>> = {};
    for (const r of ROLES) obj[r] = a.get(r) ?? null;
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch {
    /* storage disabled/full — non-fatal, this is a convenience cache */
  }
}

interface ControllerEntry {
  deviceId: string;
  deviceName: string;
  protocol: Protocol;
  controller: TrainerController;
}

export class RoleMux {
  private assignments = new Map<Role, Assignment>(ROLES.map((r) => [r, null]));
  private providers = new Map<string, TelemetryProvider>();
  private controllers = new Map<string, ControllerEntry>();
  private listeners: (() => void)[] = [];

  private controlActive = false;
  private activeController: TrainerController | null = null;
  /** bumped on every event that must invalidate an in-flight
   *  activateControl() — a control (re)assignment, an explicit release, or
   *  the active controller's device disconnecting/unregistering. An
   *  activateControl() call captures this counter before awaiting
   *  acquire() and refuses to commit its result if it's changed by the
   *  time acquire() resolves (codex build-review finding, 2026-07-15: an
   *  unguarded async race let a superseded acquire() "resurrect" control
   *  after the user had already reassigned or released it). */
  private controlGen = 0;

  constructor() {
    const persisted = loadPersisted();
    for (const r of ROLES) {
      const a = persisted[r];
      if (a !== undefined) this.assignments.set(r, a);
    }
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private notify(): void {
    savePersisted(this.assignments);
    for (const cb of this.listeners) cb();
  }

  // ---- registration (DeviceRegistry) -------------------------------------------

  registerProvider(provider: TelemetryProvider): void {
    this.providers.set(deviceProfileKey(provider.deviceId, provider.protocol), provider);
    for (const m of ['power', 'cadence', 'speed', 'heartRate'] as Metric[]) {
      if (!provider.capabilities[m]) continue;
      if (this.assignments.get(m) === null) {
        this.assignments.set(m, { deviceId: provider.deviceId, protocol: provider.protocol });
      }
    }
    this.notify();
  }

  unregisterProvider(deviceId: string, protocol: Protocol): void {
    const key = deviceProfileKey(deviceId, protocol);
    this.providers.get(key)?.stop();
    this.providers.delete(key);
    this.notify();
  }

  registerController(deviceId: string, deviceName: string, controller: TrainerController): void {
    const key = deviceProfileKey(deviceId, controller.protocol);
    this.controllers.set(key, { deviceId, deviceName, protocol: controller.protocol, controller });
    if (this.assignments.get('control') === null) {
      this.assignments.set('control', { deviceId, protocol: controller.protocol });
    }
    this.notify();
  }

  unregisterController(deviceId: string, protocol: Protocol): void {
    const key = deviceProfileKey(deviceId, protocol);
    const entry = this.controllers.get(key);
    if (!entry) return;
    // bump UNCONDITIONALLY, not only when this was already the active
    // controller: an activateControl() call for THIS controller can be
    // mid-acquire() (device disconnects during its very first activation,
    // before `activeController` is ever committed) — in that window the
    // active-controller check below is false, but the in-flight acquire
    // must still be invalidated or it would resurrect control for a
    // now-gone device once it resolves.
    this.controlGen++;
    if (entry.controller === this.activeController) {
      this.activeController = null;
      this.controlActive = false;
    }
    this.controllers.delete(key);
    this.notify();
  }

  // ---- assignment (user action, DeviceManagerUi) -------------------------------

  /** explicit pick, including "none" — sticky, persisted, never
   *  auto-overridden by a later connection. */
  assign(role: Role, target: { deviceId: string; protocol: Protocol } | 'none'): void {
    const wasActiveControl = role === 'control' && this.controlActive;
    if (role === 'control') this.controlGen++; // invalidate any in-flight activateControl() from before this reassignment
    this.assignments.set(role, target);
    if (wasActiveControl) {
      // reassigning the live controller away mid-ride must release the old
      // one — never leave a stale GATT control-point lock behind
      void this.activeController?.release();
      this.activeController = null;
      this.controlActive = false;
    }
    this.notify();
  }

  candidatesFor(role: Role): RoleCandidate[] {
    const out: RoleCandidate[] =
      role === 'control'
        ? [...this.controllers.values()].map((c) => ({
            deviceId: c.deviceId,
            deviceName: c.deviceName,
            protocol: c.protocol,
          }))
        : [...this.providers.values()]
            .filter((p) => p.capabilities[role as Metric])
            .map((p) => ({ deviceId: p.deviceId, deviceName: p.deviceName, protocol: p.protocol }));
    return out.sort((a, b) => PROTOCOL_PRIORITY[a.protocol] - PROTOCOL_PRIORITY[b.protocol]);
  }

  assignmentFor(role: Role): Assignment {
    return this.assignments.get(role) ?? null;
  }

  // ---- reading (BleSensorSource facade) ----------------------------------------

  /** the assigned provider's latest LIVE value for this metric, or null.
   *  Never averaged/merged across providers serving the same metric —
   *  exactly one selected channel per role, per the duplicate-source
   *  arbitration rule. */
  read(metric: Metric): number | null {
    const a = this.assignments.get(metric);
    if (!a || a === 'none') return null;
    const p = this.providers.get(deviceProfileKey(a.deviceId, a.protocol));
    if (!p) return null; // assigned device not currently connected
    const s = p.sample(metric);
    return s.state === 'live' ? s.value : null;
  }

  hasLivePower(): boolean {
    return this.read('power') !== null;
  }

  update(dt: number): void {
    for (const p of this.providers.values()) p.update(dt);
    if (this.controlActive && this.activeController) this.activeController.update(dt);
  }

  // ---- control activation (BikeRig mount/dismount hook) -------------------------

  /** ONLY called from BikeRig.mount() — a controllable device being
   *  connected/assigned must never start sending resistance writes on its
   *  own; activation is tied to the rider actually mounting a bike.
   *
   *  Generation-guarded: `acquire()` is async, and a reassignment/release/
   *  disconnect can legitimately happen while it's in flight. Committing
   *  its result unconditionally would let a SUPERSEDED activation
   *  "resurrect" control after the caller already moved on — captured
   *  `myGen` is compared against the live counter before writing anything
   *  back, and a superseded-but-successful acquire is released rather than
   *  left dangling on a device nobody is using anymore. */
  async activateControl(): Promise<boolean> {
    const a = this.assignments.get('control');
    if (!a || a === 'none') return false;
    const entry = this.controllers.get(deviceProfileKey(a.deviceId, a.protocol));
    if (!entry) return false;
    const myGen = this.controlGen;
    const granted = await entry.controller.acquire();
    if (myGen !== this.controlGen) {
      // superseded while awaiting — don't resurrect a stale activation
      if (granted) void entry.controller.release();
      return this.controlActive;
    }
    this.activeController = entry.controller;
    this.controlActive = granted;
    this.notify();
    return granted;
  }

  /** ONLY called from BikeRig.dismount() (and internally on control
   *  reassignment/link loss) */
  async releaseControl(): Promise<void> {
    this.controlGen++; // invalidate any in-flight activateControl()
    const c = this.activeController;
    this.controlActive = false;
    this.activeController = null;
    if (c) await c.release();
    this.notify();
  }

  setSimState(gradeFrac: number, crr: number): void {
    if (this.controlActive && this.activeController) {
      this.activeController.setSimulation(gradeFrac * 100, crr);
    }
  }

  // ---- UI projection --------------------------------------------------------------

  rows(): RoleRow[] {
    return ROLES.map((role) => this.rowFor(role));
  }

  private rowFor(role: Role): RoleRow {
    const assignment = this.assignments.get(role) ?? null;
    const candidates = this.candidatesFor(role);
    if (!assignment) return { role, assignment: null, value: null, state: 'unassigned', candidates };
    if (assignment === 'none') return { role, assignment: 'none', value: null, state: 'unassigned', candidates };

    if (role === 'control') {
      const entry = this.controllers.get(deviceProfileKey(assignment.deviceId, assignment.protocol));
      if (!entry) return { role, assignment, value: null, state: 'disconnected', candidates };
      const state = this.controlActive && this.activeController === entry.controller ? 'live' : 'inactive';
      return { role, assignment, value: null, state, candidates };
    }

    const p = this.providers.get(deviceProfileKey(assignment.deviceId, assignment.protocol));
    if (!p) return { role, assignment, value: null, state: 'disconnected', candidates };
    const s = p.sample(role as Metric);
    return { role, assignment, value: s.value, state: s.state, candidates };
  }

  /** device-facing view: which roles a given device currently feeds — the
   *  "Used for: Power, Cadence" reciprocal tag on its card. */
  rolesFedBy(deviceId: string): Role[] {
    return ROLES.filter((r) => {
      const a = this.assignments.get(r);
      return a != null && a !== 'none' && a.deviceId === deviceId;
    });
  }

  deviceNameFor(deviceId: string, protocol: Protocol): string | null {
    return (
      this.providers.get(deviceProfileKey(deviceId, protocol))?.deviceName ??
      this.controllers.get(deviceProfileKey(deviceId, protocol))?.deviceName ??
      null
    );
  }

  capabilitiesFor(deviceId: string, protocol: Protocol): DeviceCapabilities | null {
    return this.providers.get(deviceProfileKey(deviceId, protocol))?.capabilities ?? null;
  }

  /** live sample for one (device, protocol, metric) triple REGARDLESS of
   *  role assignment — the device card's ticker shows this even when the
   *  provider isn't feeding anything (dimmed, "visible but unused" — the
   *  concrete evidence for the split-topology acceptance case: the
   *  trainer's own power keeps streaming after Power is reassigned to
   *  pedals, just never reaching RideSample). */
  sampleFor(deviceId: string, protocol: Protocol, metric: Metric): { value: number | null; state: string } | null {
    const p = this.providers.get(deviceProfileKey(deviceId, protocol));
    return p ? p.sample(metric) : null;
  }

  controlCapabilityFor(deviceId: string, protocol: Protocol): { simulation: boolean; targetPower: boolean } | null {
    return this.controllers.get(deviceProfileKey(deviceId, protocol))?.controller.capabilities ?? null;
  }

  isActiveController(deviceId: string, protocol: Protocol): boolean {
    const entry = this.controllers.get(deviceProfileKey(deviceId, protocol));
    return !!entry && this.controlActive && this.activeController === entry.controller;
  }
}
