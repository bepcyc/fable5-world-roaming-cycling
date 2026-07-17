/**
 * Schwinn X70 telemetry provider — service 0x8980. The bike reports no power,
 * so a stateful decoder derives power from cadence+resistance and speed from a
 * Cardano power↔speed model (). HR arrives on a side-channel (0xf580).
 * On start the HR-stream-start command is written (the trainer expects it on
 * requestControl; there is no resistance-control path for this device).
 */

import { bytesOf } from '../machines/MetricDescriptors';
import {
  parseSchwinnX70HeartRate,
  SchwinnX70Decoder,
  SCHWINN_X70_HR_STREAM_START,
} from '../machines/SchwinnX70';
import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class SchwinnX70Provider implements TelemetryProvider {
  readonly protocol = 'x70' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private power = new AgingChannel();
  private cadence = new AgingChannel();
  private speed = new AgingChannel();
  private heartRate = new AgingChannel();
  private decoder = new SchwinnX70Decoder();

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.schwinnX70, CHR.schwinnX70Measurement, (dv) => this.onData(dv));
    // best-effort HR-stream-start; the bike only emits HR after this write
    try {
      await this.handle.write(SVC.schwinnX70, CHR.schwinnX70Control, SCHWINN_X70_HR_STREAM_START.buffer);
    } catch {
      /* control write refused — HR just won't stream, rest of telemetry works */
    }
    try {
      await this.handle.startNotify(SVC.schwinnX70, CHR.schwinnX70Extra, (dv) => this.onHeartRate(dv));
    } catch {
      /* HR side-channel absent — tolerated */
    }
  }

  stop(): void {
    this.decoder.reset();
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
    const r = this.decoder.decode(bytesOf(dv));
    if (r === null) {
      this.malformedCount++;
      return;
    }
    if (this.capabilities.power && r.powerW !== null) this.power.stamp(r.powerW);
    if (this.capabilities.cadence && r.cadenceRpm !== null) this.cadence.stamp(r.cadenceRpm);
    if (this.capabilities.speed && r.speedKmh !== null) this.speed.stamp(r.speedKmh / 3.6);
  }

  private onHeartRate(dv: DataView): void {
    const hr = parseSchwinnX70HeartRate(bytesOf(dv));
    if (this.capabilities.heartRate && hr !== null && hr > 0) this.heartRate.stamp(hr);
  }
}
