/**
 * Heart Rate Service telemetry provider — HR Measurement 0x2A37
 * (service 0x180D).
 */

import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { parseHeartRate } from '../Parsers';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class HrsProvider implements TelemetryProvider {
  readonly protocol = 'hrs' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private heartRate = new AgingChannel();

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.heartRate, CHR.heartRateMeasurement, (dv) => this.onData(dv));
  }

  stop(): void {
    /* no live state beyond the aging channel — it decays on its own */
  }

  update(dt: number): void {
    this.heartRate.tick(dt);
  }

  sample(metric: Metric): MetricSample {
    const state: StreamState = this.handle.connected ? 'live' : 'disconnected';
    if (!this.handle.connected) return { value: null, state: 'disconnected' };
    if (metric === 'heartRate') return { value: this.heartRate.value, state: this.heartRate.state() };
    return { value: null, state };
  }

  private onData(dv: DataView): void {
    const h = parseHeartRate(dv);
    if (h.truncated) this.malformedCount++;
    if (h.bpm !== null) this.heartRate.stamp(h.bpm);
  }
}
