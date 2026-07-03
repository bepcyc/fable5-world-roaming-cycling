/**
 * BleSensorSource — the real-sensor implementation of the SensorSource seam
 * (M1.4). Merges up to four device slots into one RideSample:
 *
 *   trainer (FTMS 0x1826)  → power / cadence / HR fallback + SIM control
 *   power   (CPS  0x1818)  → power (authoritative), cadence from crank revs
 *   csc     (CSC  0x1816)  → cadence from crank revs (fallback)
 *   hr      (HRS  0x180D)  → heart rate (authoritative)
 *
 * Channel priority: power CPS > FTMS; cadence CPS crank > FTMS > CSC crank;
 * HR dedicated strap > FTMS-embedded. Every channel is stamped on arrival
 * and goes null after STALE_S without notifications — a dropped sensor
 * reads "—" on the dashboard and powerW=null lets the solver coast
 * honestly (P6). NO synthetic values, ever: kind='ble' renders no badge
 * because nothing here is fake (Pillar C).
 *
 * SIM-gradient resistance (FTMS Control Point 0x2AD9, in scope per Q6):
 * Request Control (0x00) once after connect, then Set Indoor Bike
 * Simulation Parameters (0x11) whenever the grade the rig reports moves
 * ≥ SIM_EPS or SIM_PERIOD_S elapses. 'Control Not Permitted' (0x05) and
 * Machine Status 'Control Permission Lost' (0xFF) both trigger a
 * re-request; trainers without the SIM feature bit degrade to read-only
 * (graceful fallback per ROADMAP). Writes are serialized — Web Bluetooth
 * rejects overlapping GATT operations.
 *
 * All parsing is defensive (see Parsers.ts) — a garbage notification
 * increments a counter instead of throwing.
 */

import type { RideSample, SensorCtx, SensorSource } from '../Sensors';
import {
  parseCsc,
  parseCyclingPower,
  parseFtmsCpResponse,
  parseFtmsFeatures,
  parseHeartRate,
  parseIndoorBikeData,
  encodeRequestControl,
  encodeSimParams,
  RevolutionRate,
  FTMS_RESULT,
} from './Parsers';
import { CHR, SVC, type BleDeviceHandle, type BleDeviceKind, type BleTransport } from './Transport';

const STALE_S = 3.0; // channel with no notification this long reads null
const SIM_EPS = 0.001; // grade delta (fraction) that triggers a SIM write
const SIM_PERIOD_S = 2.0; // keep-alive SIM write cadence when grade is steady
const SIM_MIN_GAP_S = 0.25; // never write faster than this (1–4 Hz trainers)
const DEFAULT_CW = 0.51; // kg/m — 0.5·rho·CdA for a road rider, FTMS Cw field

interface Channel<T> {
  value: T | null;
  ageS: number;
}

function stamp<T>(ch: Channel<T>, v: T): void {
  ch.value = v;
  ch.ageS = 0;
}

function ageOut<T>(ch: Channel<T>, dt: number): void {
  ch.ageS += dt;
  if (ch.ageS > STALE_S) ch.value = null;
}

export interface SlotState {
  kind: BleDeviceKind;
  name: string;
  connected: boolean;
}

export class BleSensorSource implements SensorSource {
  readonly kind = 'ble' as const;

  private transport: BleTransport;
  private devices = new Map<BleDeviceKind, BleDeviceHandle>();
  private listeners: (() => void)[] = [];

  // merged channels (independent staleness clocks)
  private cpsPower: Channel<number> = { value: null, ageS: 0 };
  private cpsCadence: Channel<number> = { value: null, ageS: 0 };
  private ftmsPower: Channel<number> = { value: null, ageS: 0 };
  private ftmsCadence: Channel<number> = { value: null, ageS: 0 };
  private ftmsHr: Channel<number> = { value: null, ageS: 0 };
  private cscCadence: Channel<number> = { value: null, ageS: 0 };
  private hr: Channel<number> = { value: null, ageS: 0 };

  private cpsCrank = new RevolutionRate(1024, 16);
  private cscCrank = new RevolutionRate(1024, 16);

  // FTMS SIM control state
  private simSupported = false;
  private controlGranted = false;
  private controlRequested = false;
  private writeBusy = false;
  private lastSimGrade: number | null = null;
  private simCrr = 0.004;
  private sinceSimS = 0;
  private sinceWriteS = 0;
  private pendingGrade: number | null = null;

  /** diagnostics for probes / HUD tooltip */
  readonly counters = { notifications: 0, malformed: 0, simWrites: 0, controlDenied: 0 };

  constructor(transport: BleTransport) {
    this.transport = transport;
  }

  /** Bluetooth stack present? (Linux Chrome hides it behind a flag) */
  available(): boolean {
    return this.transport.available();
  }

  /** UI subscription — fires on any connect/disconnect */
  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  slots(): SlotState[] {
    const out: SlotState[] = [];
    for (const [kind, d] of this.devices) {
      out.push({ kind, name: d.name, connected: d.connected });
    }
    return out;
  }

  /** true if at least one live device supplies power (bikes stay locked
   *  otherwise — the no-sensor gate reads through RideSample.powerW) */
  hasLivePower(): boolean {
    return this.cpsPower.value !== null || this.ftmsPower.value !== null;
  }

  /**
   * Connect one device slot. MUST be invoked from a user gesture (button
   * click) — Web Bluetooth rejects requestDevice without transient user
   * activation. Rejects on chooser cancel; caller shows the error.
   */
  async connect(kind: BleDeviceKind): Promise<void> {
    const device = await this.transport.requestDevice(kind);
    this.devices.get(kind)?.disconnect();
    this.devices.set(kind, device);
    device.onDisconnect(() => this.handleDrop(kind));

    switch (kind) {
      case 'hr':
        await device.startNotify(SVC.heartRate, CHR.heartRateMeasurement, (dv) =>
          this.onHr(dv),
        );
        break;
      case 'power':
        this.cpsCrank.reset();
        await device.startNotify(SVC.cyclingPower, CHR.cyclingPowerMeasurement, (dv) =>
          this.onCps(dv),
        );
        break;
      case 'csc':
        this.cscCrank.reset();
        await device.startNotify(SVC.csc, CHR.cscMeasurement, (dv) => this.onCsc(dv));
        break;
      case 'trainer':
        await this.setupTrainer(device);
        break;
    }
    this.emitChange();
  }

  disconnect(kind: BleDeviceKind): void {
    this.devices.get(kind)?.disconnect();
  }

  // ---- SensorSource ----------------------------------------------------------

  update(dt: number, _ctx: SensorCtx): void {
    for (const ch of [
      this.cpsPower,
      this.cpsCadence,
      this.ftmsPower,
      this.ftmsCadence,
      this.ftmsHr,
      this.cscCadence,
      this.hr,
    ]) {
      ageOut(ch, dt);
    }
    this.cpsCrank.tick(dt);
    this.cscCrank.tick(dt);

    // SIM-gradient pump (trainer connected + feature + grade from the rig)
    this.sinceSimS += dt;
    this.sinceWriteS += dt;
    if (this.pendingGrade !== null) this.maybeWriteSim();
  }

  read(): RideSample {
    return {
      powerW: this.cpsPower.value ?? this.ftmsPower.value,
      cadenceRpm: this.cpsCadence.value ?? this.ftmsCadence.value ?? this.cscCadence.value,
      heartRateBpm: this.hr.value ?? this.ftmsHr.value,
    };
  }

  /** BikeRig feeds the live grade (fraction) + surface Crr each fixed step;
   *  actual GATT writes are rate-limited and serialized here */
  setSimState(gradeFrac: number, crr: number): void {
    this.pendingGrade = gradeFrac;
    this.simCrr = crr;
  }

  // ---- notification handlers ---------------------------------------------------

  private onHr(dv: DataView): void {
    this.counters.notifications++;
    const h = parseHeartRate(dv);
    if (h.truncated) this.counters.malformed++;
    if (h.bpm !== null) stamp(this.hr, h.bpm);
  }

  private onCps(dv: DataView): void {
    this.counters.notifications++;
    const p = parseCyclingPower(dv);
    if (p.truncated) this.counters.malformed++;
    if (p.powerW !== null) stamp(this.cpsPower, p.powerW);
    if (p.crank) {
      this.cpsCrank.push(p.crank.revs, p.crank.eventT, 0);
      stamp(this.cpsCadence, this.cpsCrank.revPerS() * 60);
    }
  }

  private onCsc(dv: DataView): void {
    this.counters.notifications++;
    const c = parseCsc(dv);
    if (c.truncated) this.counters.malformed++;
    if (c.crank) {
      this.cscCrank.push(c.crank.revs, c.crank.eventT, 0);
      stamp(this.cscCadence, this.cscCrank.revPerS() * 60);
    }
  }

  private onIndoorBike(dv: DataView): void {
    this.counters.notifications++;
    const b = parseIndoorBikeData(dv);
    if (b.truncated) this.counters.malformed++;
    if (b.powerW !== null) stamp(this.ftmsPower, b.powerW);
    if (b.cadenceRpm !== null) stamp(this.ftmsCadence, b.cadenceRpm);
    if (b.heartRateBpm !== null) stamp(this.ftmsHr, b.heartRateBpm);
  }

  // ---- trainer control ----------------------------------------------------------

  private async setupTrainer(device: BleDeviceHandle): Promise<void> {
    await device.startNotify(SVC.ftms, CHR.indoorBikeData, (dv) => this.onIndoorBike(dv));

    // feature discovery → SIM capability (graceful read-only fallback)
    const feat = await device.read(SVC.ftms, CHR.ftmsFeature);
    this.simSupported = feat ? parseFtmsFeatures(feat).indoorBikeSimulation : false;
    this.controlGranted = false;
    this.controlRequested = false;

    if (this.simSupported) {
      // control-point responses arrive as indications on the same path
      await device.startNotify(SVC.ftms, CHR.ftmsControlPoint, (dv) => this.onCpResponse(dv));
      // machine status is optional in the wild — ignore if absent
      try {
        await device.startNotify(SVC.ftms, CHR.ftmsStatus, (dv) => this.onMachineStatus(dv));
      } catch {
        /* many trainers omit 0x2ADA — fine */
      }
      void this.requestControl(device);
    }
  }

  private async requestControl(device: BleDeviceHandle): Promise<void> {
    if (this.controlRequested) return;
    this.controlRequested = true;
    try {
      await device.write(SVC.ftms, CHR.ftmsControlPoint, encodeRequestControl());
    } catch {
      this.controlRequested = false; // link hiccup — retried on next SIM tick
    }
  }

  private onCpResponse(dv: DataView): void {
    const r = parseFtmsCpResponse(dv);
    if (!r) return;
    if (r.requestOp === 0x00) {
      this.controlGranted = r.ok;
      this.controlRequested = r.ok; // failed request may be retried
      if (!r.ok) this.counters.controlDenied++;
    } else if (r.result === FTMS_RESULT.controlNotPermitted) {
      // trainer revoked control (app switch, idle reset) — re-request
      this.controlGranted = false;
      this.controlRequested = false;
      this.counters.controlDenied++;
    }
  }

  private onMachineStatus(dv: DataView): void {
    if (dv.byteLength >= 1 && dv.getUint8(0) === 0xff) {
      // Control Permission Lost — some other client took over
      this.controlGranted = false;
      this.controlRequested = false;
    }
  }

  private maybeWriteSim(): void {
    const device = this.devices.get('trainer');
    if (!device || !device.connected || !this.simSupported || this.writeBusy) return;
    if (!this.controlGranted) {
      if (!this.controlRequested) void this.requestControl(device);
      return;
    }
    if (this.sinceWriteS < SIM_MIN_GAP_S) return;
    const grade = this.pendingGrade;
    if (grade === null) return;
    const moved = this.lastSimGrade === null || Math.abs(grade - this.lastSimGrade) >= SIM_EPS;
    if (!moved && this.sinceSimS < SIM_PERIOD_S) return;

    this.writeBusy = true;
    this.sinceWriteS = 0;
    this.sinceSimS = 0;
    this.lastSimGrade = grade;
    device
      .write(SVC.ftms, CHR.ftmsControlPoint, encodeSimParams(0, grade, this.simCrr, DEFAULT_CW))
      .then(() => {
        this.counters.simWrites++;
      })
      .catch(() => {
        // link hiccup mid-write — drop handler owns recovery
      })
      .finally(() => {
        this.writeBusy = false;
      });
  }

  // ---- dropout -------------------------------------------------------------------

  private handleDrop(kind: BleDeviceKind): void {
    // channels go stale on their own clocks — but null them immediately so
    // the solver starts coasting the moment the link dies, not 3 s later
    if (kind === 'power') {
      this.cpsPower.value = null;
      this.cpsCadence.value = null;
      this.cpsCrank.reset();
    } else if (kind === 'csc') {
      this.cscCadence.value = null;
      this.cscCrank.reset();
    } else if (kind === 'hr') {
      this.hr.value = null;
    } else {
      this.ftmsPower.value = null;
      this.ftmsCadence.value = null;
      this.ftmsHr.value = null;
      this.controlGranted = false;
      this.controlRequested = false;
      this.lastSimGrade = null;
    }
    this.emitChange();
  }

  private emitChange(): void {
    for (const cb of this.listeners) cb();
  }
}
