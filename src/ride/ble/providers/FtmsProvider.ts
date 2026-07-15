/**
 * FTMS telemetry provider — Indoor Bike Data 0x2AD2 (service 0x1826).
 * Control (Fitness Machine Control Point 0x2AD9) lives in
 * ../TrainerController.ts (FtmsController) — this file is telemetry only.
 */

import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { parseIndoorBikeData } from '../Parsers';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class FtmsProvider implements TelemetryProvider {
  readonly protocol = 'ftms' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private power = new AgingChannel();
  private cadence = new AgingChannel();
  private speed = new AgingChannel();
  private heartRate = new AgingChannel();

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.ftms, CHR.indoorBikeData, (dv) => this.onData(dv));
  }

  stop(): void {
    // Web Bluetooth has no reliable per-characteristic unsubscribe we can
    // depend on across implementations; stopping consumption is enough —
    // channels simply age out to null once nothing reads update() anymore.
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

  private onData(dv: DataView): void {
    const b = parseIndoorBikeData(dv);
    if (b.truncated) this.malformedCount++;
    if (this.capabilities.power && b.powerW !== null) this.power.stamp(b.powerW);
    if (this.capabilities.cadence && b.cadenceRpm !== null) this.cadence.stamp(b.cadenceRpm);
    if (this.capabilities.speed && b.speedKmh !== null) this.speed.stamp(b.speedKmh / 3.6);
    if (this.capabilities.heartRate && b.heartRateBpm !== null) this.heartRate.stamp(b.heartRateBpm);
  }
}
