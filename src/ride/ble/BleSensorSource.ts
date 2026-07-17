/**
 * BleSensorSource — the real-sensor implementation of the SensorSource
 * seam. A THIN FACADE over DeviceRegistry+RoleMux: `read()`/`update()`/
 * `setSimState()`/`available()` keep the exact contract BikeRig/RideHud
 * already depend on, so this rewrite required zero changes to either file
 * beyond the one additive BikeRig mount()/dismount() control-activation
 * hook (activateControl()/releaseControl() below).
 *
 * NO synthetic values, ever: kind='ble' renders no badge because nothing
 * here is fake (Pillar C). `read().powerW` is null whenever the assigned
 * power role has no live provider — BikeRig's honesty gate (mount()) locks
 * the bikes on exactly that null, same as before this rebuild.
 */

import type { RideSample, SensorCtx, SensorSource } from '../Sensors';
import { DeviceRegistry } from './DeviceRegistry';
import type { BleTransport } from './Transport';

export class BleSensorSource implements SensorSource {
  readonly kind = 'ble' as const;
  readonly registry: DeviceRegistry;

  constructor(transport: BleTransport) {
    this.registry = new DeviceRegistry(transport);
  }

  /** Bluetooth stack present? (Linux Chrome hides it behind a flag) */
  available(): boolean {
    return this.registry.available();
  }

  /** UI subscription — fires on any connect/disconnect/role change */
  onChange(cb: () => void): void {
    this.registry.onChange(cb);
    this.registry.roleMux.onChange(cb);
  }

  update(dt: number, _ctx: SensorCtx): void {
    this.registry.update(dt);
  }

  read(): RideSample {
    return {
      powerW: this.registry.roleMux.read('power'),
      cadenceRpm: this.registry.roleMux.read('cadence'),
      heartRateBpm: this.registry.roleMux.read('heartRate'),
    };
  }

  /** BikeRig feeds the live grade (fraction) + surface Crr each fixed
   *  step; the active trainer controller (if any) rate-limits the actual
   *  GATT writes internally. No-op if control hasn't been activated. */
  setSimState(gradeFrac: number, crr: number): void {
    this.registry.roleMux.setSimState(gradeFrac, crr);
  }

  /** ERG mode passthrough — fixed target watts instead of slope simulation */
  setErgTarget(watts: number): void {
    this.registry.roleMux.setErgTarget(watts);
  }

  /** BikeRig.mount() hook — acquire the assigned controller's control
   *  point. Deliberately NOT called at connect/assignment time: a
   *  controllable device sitting in the manager must never start sending
   *  resistance writes to a trainer nobody is riding. */
  activateControl(): void {
    void this.registry.roleMux.activateControl();
  }

  /** BikeRig.dismount() hook — release the control point. */
  releaseControl(): void {
    void this.registry.roleMux.releaseControl();
  }
}
