/**
 * Tacx FE-C telemetry provider — tunneled ANT+ pages 16 (General FE Data:
 * speed, heart rate) and 25 (Specific Trainer Data: cadence, power), both
 * arriving as notifications on the SAME characteristic (6e40fec2), routed
 * by page id. Control (pages 48/49/51) lives in ../TrainerController.ts
 * (TacxFecController) — this file is telemetry only.
 *
 * This is a device's SECONDARY telemetry path by design: when the same
 * device also has CPS/CSC (the owner's real Tacx does — measured, all
 * three coexist), the role picker's default ordering prefers the standard
 * GATT services and reserves FE-C power/cadence for the "advanced"
 * multi-channel disclosure, so ordinary riders never have to understand
 * two same-looking "power" entries for one trainer.
 */

import { type DeviceCapabilities, type Metric } from '../Capabilities';
import { decodeFecFrame, decodeGeneralFeData, decodeSpecificTrainerData, FEC_PAGE } from '../FecFrame';
import { CHR, SVC, type BleDeviceHandle } from '../Transport';
import { AgingChannel, type MetricSample, type StreamState, type TelemetryProvider } from './Provider';

export class TacxFecProvider implements TelemetryProvider {
  readonly protocol = 'fec' as const;
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
    await this.handle.startNotify(SVC.tacxFec, CHR.tacxFecTx, (dv) => this.onFrame(dv));
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

  private onFrame(dv: DataView): void {
    const frame = decodeFecFrame(dv);
    if (!frame || !frame.checksumOk) {
      this.malformedCount++;
      return;
    }
    if (frame.pageId === FEC_PAGE.specificTrainerData) {
      const d = decodeSpecificTrainerData(frame.page);
      if (this.capabilities.cadence && d.cadenceRpm !== null) this.cadence.stamp(d.cadenceRpm);
      if (this.capabilities.power && d.instPowerW !== null) this.power.stamp(d.instPowerW);
    } else if (frame.pageId === FEC_PAGE.generalFeData) {
      const d = decodeGeneralFeData(frame.page);
      if (this.capabilities.speed && d.speedMs !== null) this.speed.stamp(d.speedMs);
      if (this.capabilities.heartRate && d.heartRateBpm !== null) this.heartRate.stamp(d.heartRateBpm);
    }
  }
}
