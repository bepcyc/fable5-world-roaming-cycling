/**
 * Life Fitness telemetry provider — an FTMS bike behind a REQUIRED scripted
 * handshake (across services 0x4b90/0x4b91) plus the LF-bike
 * flag override on the FTMS Indoor Bike characteristic 0x2AD2 (). Emitting
 * `lf` suppresses the bare `ftms` provider (Capabilities.ts) so exactly one
 * provider owns 0x2AD2. Resistance control is standard FTMS (FtmsController,
 * registered by DeviceRegistry) — this file is telemetry + handshake only.
 *
 * SCOPE NOTE: this provider streams the LF BIKE (0x2AD2). LF treadmill /
 * elliptical / stair / step stream on their own FTMS data characteristics and
 * are represented as descriptors (DeviceResolver) with parsers ready
 * (FtmsMachines), but are not wired to a machine-type-aware LF provider here —
 * that belongs to the UI/integration wave.
 */

import { buildLifeFitnessHandshake, parseLifeFitnessBike, type LifeFitnessAthlete } from '../machines/LifeFitness';
import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

/** placeholder athlete for the handshake — the magic bytes are what unlock
 *  streaming; the user fields are informational. A future wave can thread real
 *  athlete config through here. */
const DEFAULT_ATHLETE: LifeFitnessAthlete = {
  firstName: 'Rider',
  lastName: 'LAAS',
  email: 'rider@laas.local',
  age: 30,
  isMale: true,
  weightKg: 75,
  heightCm: 178,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class LfProvider implements TelemetryProvider {
  readonly protocol = 'lf' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private power = new AgingChannel();
  private cadence = new AgingChannel();
  private speed = new AgingChannel();
  private heartRate = new AgingChannel();
  private stopped = false;

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.ftms, CHR.indoorBikeData, (dv) => this.onData(dv));
    // the handshake is required to make the machine stream, but must not block
    // start()'s resolution (its stepped delays run for ~7 s) — fire and forget
    void this.runHandshake();
  }

  stop(): void {
    this.stopped = true;
  }

  update(dt: number): void {
    this.power.tick(dt);
    this.cadence.tick(dt);
    this.speed.tick(dt);
    this.heartRate.tick(dt);
  }

  sample(metric: Metric): MetricSample {
    const state: StreamState = this.handle.connected ? 'live' : 'disconnected';
    if (!this.handle.connected) return { value: null, state: 'disconnected' };
    const ch =
      metric === 'power'
        ? this.power
        : metric === 'cadence'
          ? this.cadence
          : metric === 'speed'
            ? this.speed
            : metric === 'heartRate'
              ? this.heartRate
              : null;
    if (!ch) return { value: null, state };
    return { value: ch.value, state: ch.state() };
  }

  private async runHandshake(): Promise<void> {
    for (const step of buildLifeFitnessHandshake(DEFAULT_ATHLETE)) {
      if (this.stopped || !this.handle.connected) return;
      if (step.delayMs > 0) await sleep(step.delayMs);
      try {
        if (step.kind === 'subscribe') {
          await this.handle.startNotify(step.service, step.chr, () => {
            /* LF status frames are informational */
          });
        } else if (step.bytes) {
          await this.handle.write(step.service, step.chr, step.bytes.buffer as ArrayBuffer);
        }
      } catch {
        /* a single handshake write failing is non-fatal — continue the script */
      }
    }
  }

  private onData(dv: DataView): void {
    const r = parseLifeFitnessBike(dv);
    if (r.truncated) this.malformedCount++;
    if (this.capabilities.power && r.powerW !== null) this.power.stamp(r.powerW);
    if (this.capabilities.cadence && r.cadenceRpm !== null) this.cadence.stamp(r.cadenceRpm);
    if (this.capabilities.speed && r.speedKmh !== null) this.speed.stamp(r.speedKmh / 3.6);
    if (this.capabilities.heartRate && r.heartRateBpm !== null) this.heartRate.stamp(r.heartRateBpm);
  }
}
