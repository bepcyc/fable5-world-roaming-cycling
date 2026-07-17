/**
 * RSC telemetry provider — Running Speed & Cadence Measurement 0x2A53
 * (service 0x1814). SPEED ONLY: the RSC "cadence" field is steps/min
 * from a gait algorithm, categorically NOT crank RPM, so it is never stamped
 * as a cycling cadence source (RSC-exclusion invariant — Capabilities.ts,
 * ble-sensors-helper). This provider is not auto-attached (deriveProtocol-
 * Capabilities never emits `rsc`); it exists for completeness / explicit use.
 */

import { parseRsc } from '../Parsers';
import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class RscProvider implements TelemetryProvider {
  readonly protocol = 'rsc' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private speed = new AgingChannel();

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.runningSpeedCadence, CHR.rscMeasurement, (dv) => this.onData(dv));
  }

  stop(): void {
    /* aging channel decays on its own once update() stops being fed */
  }

  update(dt: number): void {
    this.speed.tick(dt);
  }

  sample(metric: Metric): MetricSample {
    const state: StreamState = this.handle.connected ? 'live' : 'disconnected';
    if (!this.handle.connected) return { value: null, state: 'disconnected' };
    if (metric === 'speed') return { value: this.speed.value, state: this.speed.state() };
    // cadence is intentionally never served from RSC
    return { value: null, state };
  }

  private onData(dv: DataView): void {
    const r = parseRsc(dv);
    if (r.truncated) this.malformedCount++;
    if (this.capabilities.speed && r.speedKmh !== null) this.speed.stamp(r.speedKmh / 3.6);
  }
}
