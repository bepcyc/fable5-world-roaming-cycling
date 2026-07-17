/**
 * KayakFirst telemetry provider — service 0xffe0, serial-over-BLE on the single
 * notify+write characteristic 0xffe1. isPolling: the device only emits a
 * data frame in response to a poll command ("6"), so update() issues one every
 * pollThreshold (1000 ms). Data frames ('6'…CRLF, ';'-separated) → distance /
 * speed / cadence / power. No heart rate.
 */

import { bytesOf } from '../machines/MetricDescriptors';
import { encodeKayakCommand, KAYAK_CMD, parseKayakData, skipKayakPacket } from '../machines/KayakFirst';
import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

const POLL_PERIOD_S = 1.0; // pollThreshold 1000 ms

export class KayakFirstProvider implements TelemetryProvider {
  readonly protocol = 'kf' as const;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly capabilities: DeviceCapabilities;
  malformedCount = 0;

  private handle: BleDeviceHandle;
  private power = new AgingChannel();
  private cadence = new AgingChannel();
  private speed = new AgingChannel();
  private sincePollS = 0;
  private pollBusy = false;

  constructor(handle: BleDeviceHandle, capabilities: DeviceCapabilities) {
    this.handle = handle;
    this.deviceId = handle.id;
    this.deviceName = handle.name;
    this.capabilities = capabilities;
  }

  async start(): Promise<void> {
    await this.handle.startNotify(SVC.kayakFirst, CHR.kayakFirstAllAround, (dv) => this.onData(dv));
  }

  stop(): void {
    /* aging channels decay on their own once update() stops being fed */
  }

  update(dt: number): void {
    this.power.tick(dt);
    this.cadence.tick(dt);
    this.speed.tick(dt);
    // polling device: request a data frame every pollThreshold
    this.sincePollS += dt;
    if (!this.pollBusy && this.sincePollS >= POLL_PERIOD_S && this.handle.connected) {
      this.sincePollS = 0;
      this.pollBusy = true;
      const chunk = encodeKayakCommand(KAYAK_CMD.pollData)[0]!;
      this.handle
        .write(SVC.kayakFirst, CHR.kayakFirstAllAround, chunk.buffer as ArrayBuffer)
        .catch(() => {
          /* poll write hiccup — next tick retries */
        })
        .finally(() => {
          this.pollBusy = false;
        });
    }
  }

  sample(metric: Metric): MetricSample {
    const state: StreamState = this.handle.connected ? 'live' : 'disconnected';
    if (!this.handle.connected) return { value: null, state: 'disconnected' };
    if (metric === 'power') return { value: this.power.value, state: this.power.state() };
    if (metric === 'cadence') return { value: this.cadence.value, state: this.cadence.state() };
    if (metric === 'speed') return { value: this.speed.value, state: this.speed.state() };
    return { value: null, state };
  }

  private onData(dv: DataView): void {
    const d = bytesOf(dv);
    if (skipKayakPacket(d)) return; // noise frame
    const r = parseKayakData(d);
    if (r === null) return; // partial fragment / non-data frame
    if (this.capabilities.power && r.powerW !== null) this.power.stamp(r.powerW);
    if (this.capabilities.cadence && r.cadenceRpm !== null) this.cadence.stamp(r.cadenceRpm);
    if (this.capabilities.speed && r.speedKmh !== null) this.speed.stamp(r.speedKmh / 3.6);
  }
}
