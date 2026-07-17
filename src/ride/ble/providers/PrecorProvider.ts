/**
 * Precor Spinner Chrono Power telemetry provider — service 0xee07, 19-byte
 * fixed-layout packet carrying power / speed / cadence / HR directly.
 * No control writes (listenOnControl=false).
 */

import { bytesOf } from '../machines/MetricDescriptors';
import { parsePrecor } from '../machines/Precor';
import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class PrecorProvider implements TelemetryProvider {
  readonly protocol = 'precor' as const;
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
    await this.handle.startNotify(SVC.precor, CHR.precorMeasurement, (dv) => this.onData(dv));
  }

  stop(): void {
    /* aging channels decay on their own once update() stops being fed */
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
    const r = parsePrecor(bytesOf(dv));
    if (r === null) {
      this.malformedCount++;
      return;
    }
    if (this.capabilities.power && r.powerW !== null) this.power.stamp(r.powerW);
    if (this.capabilities.cadence && r.cadenceRpm !== null) this.cadence.stamp(r.cadenceRpm);
    if (this.capabilities.speed && r.speedKmh !== null) this.speed.stamp(r.speedKmh / 3.6);
    if (this.capabilities.heartRate && r.heartRateBpm !== null && r.heartRateBpm > 0) {
      this.heartRate.stamp(r.heartRateBpm);
    }
  }
}
