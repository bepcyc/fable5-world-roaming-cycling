/**
 * Trainer resistance control — a THIN semantic boundary
 * (acquire/setSimulation/setTargetPower/release) shared by two protocol
 * implementations that never leak their own mechanics through it: FTMS
 * Fitness Machine Control Point 0x2AD9 opcodes never appear outside
 * FtmsController, FE-C tunnel frames never appear outside
 * TacxFecController.
 *
 * RoleMux/BikeRig hold exactly ONE ACTIVE controller per ride and never
 * auto-switch protocols mid-session — a device that happens to expose both
 * FTMS and FE-C would otherwise risk sending duplicate/contradictory
 * resistance commands to the same trainer.
 *
 * ACTIVATION is deliberately NOT tied to connect time or role assignment:
 * a controllable device simply being connected/assigned must never start
 * sending resistance writes to a trainer nobody is riding (today's
 * pre-rebuild code got this wrong — setupTrainer() called requestControl()
 * unconditionally on connect). acquire()/release() are called from
 * BikeRig's existing mount()/dismount() lifecycle instead (BikeRig.ts).
 */

import {
  encodeBasicResistance,
  encodeFecFrame,
  encodeTargetPower as encodeFecTargetPowerPage,
  encodeTrackResistance,
} from './FecFrame';
import {
  encodeRequestControl,
  encodeSimParams,
  encodeTargetPower as encodeFtmsTargetPower,
  FTMS_RESULT,
  parseFtmsCpResponse,
} from './Parsers';
import { CHR, SVC, type BleDeviceHandle } from './Transport';

export interface ControllerCapability {
  simulation: boolean;
  targetPower: boolean;
}

export interface TrainerController {
  readonly protocol: 'ftms' | 'fec';
  readonly capabilities: ControllerCapability;
  /** acquire the control point; resolves true once control is actually
   *  usable. Only ever called once the rider mounts a controlled bike. */
  acquire(): Promise<boolean>;
  /** SIM/grade mode; rate-limited + latest-wins internally (see update()) */
  setSimulation(gradePercent: number, crr: number): void;
  /** ERG/fixed-power mode */
  setTargetPower(watts: number): void;
  /** advance the internal write-throttle clock — call once per ride tick
   *  while active; an unchanged target still gets a periodic keep-alive
   *  write so a trainer that resets resistance on silence doesn't drift */
  update(dt: number): void;
  /** best-effort release on dismount/reassignment/link loss */
  release(): Promise<void>;
  readonly lastAcquireDenied: boolean;
}

const SIM_EPS = 0.001; // grade delta (fraction) that triggers a write
const SIM_PERIOD_S = 2.0; // keep-alive write cadence when grade is steady
const MIN_WRITE_GAP_S = 0.25; // never write faster than this (1-4 Hz trainers)
const DEFAULT_CW = 0.51; // kg/m — 0.5·rho·CdA for a road rider, FTMS Cw field

type PendingTarget = { kind: 'sim'; gradePercent: number; crr: number } | { kind: 'power'; watts: number };

/** shared latest-wins write-throttle: callers push targets via
 *  setSimulation/setTargetPower every tick; update() decides whether a
 *  GATT write is actually due (moved enough, or the keep-alive period
 *  elapsed) and never queues more than the single most-recent target —
 *  a rapid sequence of grade changes (descending a switchback) must not
 *  force the trainer through every intermediate value. */
abstract class ThrottledController implements TrainerController {
  abstract readonly protocol: 'ftms' | 'fec';
  abstract readonly capabilities: ControllerCapability;
  lastAcquireDenied = false;

  protected pending: PendingTarget | null = null;
  private lastSent: PendingTarget | null = null;
  private sinceWriteS = 0;
  private sinceKeepAliveS = 0;
  private writeBusy = false;

  abstract acquire(): Promise<boolean>;
  protected abstract sendSim(gradePercent: number, crr: number): Promise<void>;
  protected abstract sendPower(watts: number): Promise<void>;
  abstract release(): Promise<void>;

  setSimulation(gradePercent: number, crr: number): void {
    if (!this.capabilities.simulation) return;
    this.pending = { kind: 'sim', gradePercent, crr };
  }

  setTargetPower(watts: number): void {
    if (!this.capabilities.targetPower) return;
    this.pending = { kind: 'power', watts };
  }

  update(dt: number): void {
    this.sinceWriteS += dt;
    this.sinceKeepAliveS += dt;
    if (this.writeBusy || !this.pending || this.sinceWriteS < MIN_WRITE_GAP_S) return;

    const moved = !this.sameTarget(this.pending, this.lastSent);
    if (!moved && this.sinceKeepAliveS < SIM_PERIOD_S) return;

    const target = this.pending;
    this.writeBusy = true;
    this.sinceWriteS = 0;
    this.sinceKeepAliveS = 0;
    const write =
      target.kind === 'sim' ? this.sendSim(target.gradePercent, target.crr) : this.sendPower(target.watts);
    write
      .then(() => {
        this.lastSent = target;
      })
      .catch(() => {
        /* link hiccup mid-write — next tick retries with the still-pending target */
      })
      .finally(() => {
        this.writeBusy = false;
      });
  }

  private sameTarget(a: PendingTarget, b: PendingTarget | null): boolean {
    if (!b || a.kind !== b.kind) return false;
    if (a.kind === 'sim' && b.kind === 'sim') return Math.abs(a.gradePercent - b.gradePercent) < SIM_EPS * 100;
    if (a.kind === 'power' && b.kind === 'power') return a.watts === b.watts;
    return false;
  }
}

// ---- FTMS -------------------------------------------------------------------------

export class FtmsController extends ThrottledController {
  readonly protocol = 'ftms' as const;
  readonly capabilities: ControllerCapability;
  private handle: BleDeviceHandle;
  private granted = false;

  constructor(handle: BleDeviceHandle, capabilities: ControllerCapability) {
    super();
    this.handle = handle;
    this.capabilities = capabilities;
  }

  async acquire(): Promise<boolean> {
    this.granted = false;
    this.lastAcquireDenied = false;
    try {
      // control-point responses arrive as indications on the same characteristic
      await this.handle.startNotify(SVC.ftms, CHR.ftmsControlPoint, (dv) => this.onCpResponse(dv));
    } catch {
      /* some trainers only support indicate-after-request; ignore */
    }
    try {
      await this.handle.startNotify(SVC.ftms, CHR.ftmsStatus, (dv) => this.onMachineStatus(dv));
    } catch {
      /* Fitness Machine Status 0x2ADA is optional — many trainers omit it */
    }
    try {
      await this.handle.write(SVC.ftms, CHR.ftmsControlPoint, encodeRequestControl());
    } catch {
      this.lastAcquireDenied = true;
      return false;
    }
    // response indication updates `granted` asynchronously; give it one
    // GATT round-trip's worth of grace before reporting the outcome
    await new Promise((r) => setTimeout(r, 50));
    if (!this.granted) this.lastAcquireDenied = true;
    return this.granted;
  }

  async release(): Promise<void> {
    this.granted = false;
    // FTMS has no explicit "release control" opcode in the spec's op list
    // (Stop/Pause 0x08 pauses the ride, it doesn't hand control back) —
    // simply stop issuing writes; the trainer's own idle timeout, if any,
    // owns reclaiming the control point from an inactive client.
  }

  protected async sendSim(gradePercent: number, crr: number): Promise<void> {
    if (!this.granted) return;
    await this.handle.write(
      SVC.ftms,
      CHR.ftmsControlPoint,
      encodeSimParams(0, gradePercent / 100, crr, DEFAULT_CW),
    );
  }

  protected async sendPower(watts: number): Promise<void> {
    if (!this.granted) return;
    await this.handle.write(SVC.ftms, CHR.ftmsControlPoint, encodeFtmsTargetPower(watts));
  }

  private onCpResponse(dv: DataView): void {
    const r = parseFtmsCpResponse(dv);
    if (!r) return;
    if (r.requestOp === 0x00) {
      this.granted = r.ok;
    } else if (r.result === FTMS_RESULT.controlNotPermitted) {
      this.granted = false; // trainer revoked control (app switch, idle reset)
    }
  }

  private onMachineStatus(dv: DataView): void {
    if (dv.byteLength >= 1 && dv.getUint8(0) === 0xff) this.granted = false; // Control Permission Lost
  }
}

// ---- Tacx FE-C ----------------------------------------------------------------------

export class TacxFecController extends ThrottledController {
  readonly protocol = 'fec' as const;
  readonly capabilities: ControllerCapability = { simulation: true, targetPower: true };
  private handle: BleDeviceHandle;

  constructor(handle: BleDeviceHandle) {
    super();
    this.handle = handle;
  }

  async acquire(): Promise<boolean> {
    // FE-C has no request/grant handshake analogous to FTMS's Request
    // Control op — any GATT-connected client may write control pages.
    // "Acquired" here means only "the link is up and writable."
    this.lastAcquireDenied = !this.handle.connected;
    return this.handle.connected;
  }

  async release(): Promise<void> {
    /* no release primitive in the pages this build implements (48/49/51)
     * — simply stop issuing writes, matching FtmsController's release() */
  }

  protected async sendSim(gradePercent: number, crr: number): Promise<void> {
    await this.handle.write(
      SVC.tacxFec,
      CHR.tacxFecRx,
      encodeFecFrame(encodeTrackResistance(gradePercent, crr)),
    );
  }

  protected async sendPower(watts: number): Promise<void> {
    await this.handle.write(SVC.tacxFec, CHR.tacxFecRx, encodeFecFrame(encodeFecTargetPowerPage(watts)));
  }

  /** exposed for completeness (basic %-resistance mode) — not wired to
   *  ThrottledController's sim/power split since BikeRig only ever drives
   *  grade-simulation; kept as a direct call for a future manual-%-mode UI */
  async sendBasicResistance(percent: number): Promise<void> {
    await this.handle.write(SVC.tacxFec, CHR.tacxFecRx, encodeFecFrame(encodeBasicResistance(percent)));
  }
}
