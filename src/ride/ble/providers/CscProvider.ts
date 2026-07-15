/**
 * Cycling Speed and Cadence telemetry provider — CSC Measurement 0x2A5B
 * (service 0x1816). Cadence-only in this build (wheel-revolution speed
 * needs an app-configured wheel circumference this build doesn't have —
 * see Capabilities.ts). A dedicated CSC-only device (standalone cadence
 * sensor, e.g. Wahoo RPM) is exactly what this provider is for.
 */

import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { parseCsc, RevolutionRate } from '../Parsers';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class CscProvider implements TelemetryProvider {
  readonly protocol = 'csc' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private cadence = new AgingChannel();
  private crank = new RevolutionRate(1024, 16);

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.csc, CHR.cscMeasurement, (dv) => this.onData(dv));
  }

  stop(): void {
    this.crank.reset();
  }

  update(dt: number): void {
    this.cadence.tick(dt);
    this.crank.tick(dt);
  }

  sample(metric: Metric): MetricSample {
    const state: StreamState = this.handle.connected ? 'live' : 'disconnected';
    if (!this.handle.connected) return { value: null, state: 'disconnected' };
    if (metric === 'cadence') return { value: this.cadence.value, state: this.cadence.state() };
    return { value: null, state };
  }

  private onData(dv: DataView): void {
    const c = parseCsc(dv);
    if (c.truncated) this.malformedCount++;
    if (this.capabilities.cadence && c.crank) {
      const rate = this.crank.push(c.crank.revs, c.crank.eventT, 0);
      // see CpsProvider.ts / RevolutionRate.push() — null means no
      // genuinely accepted sample, must not re-stamp the channel
      if (rate !== null) this.cadence.stamp(rate * 60);
    }
  }
}
