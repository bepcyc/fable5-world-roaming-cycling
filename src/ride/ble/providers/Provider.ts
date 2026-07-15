/**
 * Shared telemetry-provider contract + the aging-channel primitive every
 * provider (Ftms/Cps/Csc/Hrs/TacxFec) builds its metric samples out of.
 *
 * One provider = one (device, protocol) pair, owning ONE GATT subscription
 * and everything derived from it — its own stream-state clock and, where
 * relevant, its own RevolutionRate estimator. REASSIGNING which ROLE reads
 * a provider's output never touches any of that (RoleMux only changes
 * which provider's `sample()` gets projected into RideSample); only the
 * provider's own device lifecycle (connect/reconnect/teardown) resets it.
 */

import type { DeviceCapabilities, Metric } from '../Capabilities';

export type StreamState = 'waiting' | 'live' | 'stale' | 'disconnected';

export interface MetricSample {
  value: number | null;
  state: StreamState;
}

/** channel with no notification this long reads stale (existing project
 *  constant, unchanged from the pre-rebuild BleSensorSource) */
export const STALE_S = 3.0;

/** one metric's (value, freshness) pair with elapsed-time-based aging —
 *  NOT an N-packet threshold, since notification rates differ across
 *  devices/protocols (a 1 Hz HR strap and a 4 Hz trainer would need
 *  different N; wall-clock staleness is device-agnostic). */
export class AgingChannel {
  value: number | null = null;
  private ageS = 0;
  private seen = false;

  stamp(v: number): void {
    this.value = v;
    this.ageS = 0;
    this.seen = true;
  }

  tick(dt: number): void {
    if (!this.seen) return;
    this.ageS += dt;
    if (this.ageS > STALE_S) this.value = null;
  }

  state(): StreamState {
    if (!this.seen) return 'waiting';
    return this.value !== null ? 'live' : 'stale';
  }
}

export interface TelemetryProvider {
  readonly protocol: 'ftms' | 'cps' | 'csc' | 'hrs' | 'fec';
  readonly deviceId: string;
  readonly deviceName: string;
  /** dimension 1 (Capabilities.ts) — what this protocol on this device
   *  could EVER produce, static for the life of the connection */
  readonly capabilities: DeviceCapabilities;
  /** subscribe; isolated per provider — one broken characteristic on a
   *  multi-service device must never poison another provider's telemetry */
  start(): Promise<void>;
  /** stop tracking (role reassignment away, device teardown) */
  stop(): void;
  /** age the stream-state clock; dt = seconds since the last update() call */
  update(dt: number): void;
  sample(metric: Metric): MetricSample;
  /** defensive-parsing diagnostics (probe/HUD tooltip use) */
  readonly malformedCount: number;
}
