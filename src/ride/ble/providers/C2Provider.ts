/**
 * Concept2 PM5 telemetry provider — service 0x0030, multi-characteristic. The
 * telemetry roles are split across companion characteristics:
 *   0x0032 Additional Status 1 → speed, stroke rate (cadence), heart rate
 *   0x0036 Additional Stroke Data → power
 *   0x0031 General Status → distance (no role) ; 0x0033 → calories (no role)
 * Each notification stamps its own channels — the "merge" is the union of live
 * channels, isolated per characteristic (a missing companion never breaks the
 * rest). Live channels are combined by taking the best of each metric.
 */

import { bytesOf } from '../machines/MetricDescriptors';
import { parseC2AdditionalStatus1, parseC2AdditionalStrokeData } from '../machines/Concept2';
import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class C2Provider implements TelemetryProvider {
  readonly protocol = 'c2' as const;
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
    // Subscribe to each companion independently; at least one must succeed or
    // the provider is useless (throw so DeviceRegistry records the failure).
    let any = false;
    try {
      await this.handle.startNotify(SVC.concept2Erg, CHR.c2AdditionalStatus1, (dv) => this.onStatus1(dv));
      any = true;
    } catch {
      /* companion absent — tolerated */
    }
    try {
      await this.handle.startNotify(SVC.concept2Erg, CHR.c2AdditionalStrokeData, (dv) => this.onStroke(dv));
      any = true;
    } catch {
      /* companion absent — tolerated */
    }
    if (!any) throw new Error('Concept2: no telemetry characteristic subscribable');
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

  private onStatus1(dv: DataView): void {
    const s = parseC2AdditionalStatus1(bytesOf(dv));
    if (this.capabilities.speed && s.speedKmh !== null) this.speed.stamp(s.speedKmh / 3.6);
    if (this.capabilities.cadence && s.cadenceRpm !== null) this.cadence.stamp(s.cadenceRpm);
    if (this.capabilities.heartRate && s.heartRateBpm !== null) this.heartRate.stamp(s.heartRateBpm);
  }

  private onStroke(dv: DataView): void {
    const s = parseC2AdditionalStrokeData(bytesOf(dv));
    if (this.capabilities.power && s.powerW !== null) this.power.stamp(s.powerW);
  }
}
