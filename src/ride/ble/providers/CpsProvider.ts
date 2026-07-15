/**
 * Cycling Power Service telemetry provider — CP Measurement 0x2A63
 * (service 0x1818). Owns its own crank RevolutionRate estimator: cadence
 * here comes from Crank Revolution Data (flags bit5) when the notification
 * actually carries it — a device can advertise 0x1818 alone (no 0x1816
 * CSC) and still give cadence this way, which is exactly the owner's
 * Tacx's situation.
 */

import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { parseCyclingPower, RevolutionRate } from '../Parsers';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class CpsProvider implements TelemetryProvider {
  readonly protocol = 'cps' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private power = new AgingChannel();
  private cadence = new AgingChannel();
  private crank = new RevolutionRate(1024, 16);

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.cyclingPower, CHR.cyclingPowerMeasurement, (dv) => this.onData(dv));
  }

  stop(): void {
    this.crank.reset();
  }

  update(dt: number): void {
    this.power.tick(dt);
    this.cadence.tick(dt);
    this.crank.tick(dt);
  }

  sample(metric: Metric): MetricSample {
    const state: StreamState = this.handle.connected ? 'live' : 'disconnected';
    if (!this.handle.connected) return { value: null, state: 'disconnected' };
    if (metric === 'power') return { value: this.power.value, state: this.power.state() };
    if (metric === 'cadence') return { value: this.cadence.value, state: this.cadence.state() };
    return { value: null, state };
  }

  private onData(dv: DataView): void {
    const p = parseCyclingPower(dv);
    if (p.truncated) this.malformedCount++;
    if (this.capabilities.power && p.powerW !== null) this.power.stamp(p.powerW);
    // per-notification flags bit is the authority on whether crank data is
    // in THIS packet — CP Feature only says the device is ever capable
    if (this.capabilities.cadence && p.crank) {
      const rate = this.crank.push(p.crank.revs, p.crank.eventT, 0);
      // null = no genuinely accepted sample this push (first-ever packet,
      // physical reset, or a rejected implausible spike) — do NOT re-stamp
      // the channel, or a stale/reset reading would read "freshly live"
      // (codex build-review finding, see RevolutionRate.push() docstring)
      if (rate !== null) this.cadence.stamp(rate * 60);
    }
  }
}
