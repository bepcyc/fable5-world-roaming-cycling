/**
 * Capability derivation — pure functions only, no I/O. `GattProbe` is a
 * snapshot DeviceRegistry gathers once after connect (which known services
 * are present + each service's Feature characteristic, if readable);
 * `deriveCapabilities` turns that snapshot into what a device can offer.
 *
 * FOUR SEPARATE DIMENSIONS make up a working device (design decision, see
 * docs/BLE_ZWIFT_PLAN.md phase-2 design — codex corrected an earlier
 * two-phase "declared→confirmed" idea for coupling UI/fallback/reconnect
 * logic to packet timing):
 *   1. CAPABILITY (this file) — can this protocol on this device EVER
 *      produce this metric? Session-level, near-static.
 *   2. SUBSCRIPTION — did startNotify/read actually succeed? (DeviceRegistry)
 *   3. STREAM STATE — waiting / live / stale / disconnected, elapsed-time
 *      aged (providers/*)
 *   4. ASSIGNMENT — which role, if any, currently reads this provider (RoleMux)
 *
 * A Feature characteristic (CP Feature 0x2A65, CSC Feature 0x2A5C, FTMS
 * Feature 0x2ACC) is a CONNECT-TIME probe: when present and its bit is 0,
 * the metric is definitively unsupported. When present and 1, or when the
 * characteristic itself is absent/unreadable, capability stays optimistic
 * — dimension 3 (the first live notification actually carrying the field)
 * is what proves it, never a hard requirement to already have proof before
 * offering the chip.
 *
 * RSC (0x1814) EXCLUSION: this file never inspects `runningSpeedCadence`
 * at all — no code path here can produce a cadence capability from it,
 * full stop. Its "Instantaneous Cadence" field is steps/min from an
 * accelerometer gait algorithm, categorically unrelated to crank RPM
 * (measured live: the owner's HRMPro+ chest strap advertises 0x1814
 * alongside 0x180D Heart Rate — a naive "any characteristic shaped like
 * cadence" scan would misclassify it).
 */

import type { CpFeatureBits, CscFeatureBits, FtmsFeatures } from './Parsers';
import { serviceKey, SVC, type ServiceUuid } from './Transport';

export type Metric = 'power' | 'cadence' | 'speed' | 'heartRate';
export type Role = Metric | 'control';
export const ROLES: readonly Role[] = ['power', 'cadence', 'speed', 'heartRate', 'control'];

/**
 * Protocol identity. The original five plus the ported families:
 *   c2     Concept2 PM5 erg (service 0x0030, multi-characteristic merge)
 *   x70    Schwinn X70 (service 0x8980, power model + HR side-channel)
 *   precor Precor Spinner Chrono Power (service 0xee07, 19B fixed)
 *   kf     KayakFirst (service 0xffe0, serial ASCII)
 *   lf     Life Fitness (FTMS + handshake; SUPPRESSES a bare `ftms` entry)
 *   rsc    Running Speed & Cadence 0x1814 — see the RSC note below.
 */
export type Protocol = 'ftms' | 'cps' | 'csc' | 'hrs' | 'fec' | 'c2' | 'x70' | 'precor' | 'kf' | 'lf' | 'rsc';

/** stable identity for one (device, protocol) telemetry/control source —
 *  the key RoleMux and DeviceRegistry both index providers/controllers by,
 *  so a role assignment and a live provider always agree on identity. */
export function deviceProfileKey(deviceId: string, protocol: Protocol): string {
  return `${deviceId}:${protocol}`;
}

/** semantic control flags, NOT a protocol-priority chain — a device can
 *  offer both simulation (SIM/grade) and a fixed target-power (ERG) mode;
 *  which one is USED is a RoleMux/UI decision, never auto-selected here */
export interface ControlCapability {
  simulation: boolean;
  targetPower: boolean;
}

export interface DeviceCapabilities {
  power: boolean;
  cadence: boolean;
  speed: boolean;
  heartRate: boolean;
  control: ControlCapability | null;
}

export function emptyCapabilities(): DeviceCapabilities {
  return { power: false, cadence: false, speed: false, heartRate: false, control: null };
}

/** merge two devices' claims for the SAME role (used to show the union of
 *  what a multi-protocol device can do, e.g. a Tacx offering power via both
 *  CPS and FE-C) */
export function mergeCapabilities(a: DeviceCapabilities, b: DeviceCapabilities): DeviceCapabilities {
  return {
    power: a.power || b.power,
    cadence: a.cadence || b.cadence,
    speed: a.speed || b.speed,
    heartRate: a.heartRate || b.heartRate,
    control:
      a.control || b.control
        ? {
            simulation: (a.control?.simulation ?? false) || (b.control?.simulation ?? false),
            targetPower: (a.control?.targetPower ?? false) || (b.control?.targetPower ?? false),
          }
        : null,
  };
}

/** what DeviceRegistry gathers once, right after connect+discovery */
export interface GattProbe {
  services: Set<string>; // ukey'd service ids actually present
  cpFeature: CpFeatureBits | null; // null = characteristic absent/unreadable
  cscFeature: CscFeatureBits | null;
  ftmsFeature: FtmsFeatures | null;
}

export function hasSvc(probe: GattProbe, svc: ServiceUuid): boolean {
  return probe.services.has(serviceKey(svc));
}

/** derive the capability set for EACH protocol a device exposes,
 *  keyed by protocol so a multi-protocol device (Tacx: CPS+CSC+FE-C) shows
 *  one entry per protocol — the UI's "advanced" per-channel disclosure and
 *  RoleMux's duplicate-source arbitration both need this granularity, not
 *  a single flattened device-level capability set. */
export function deriveProtocolCapabilities(probe: GattProbe): Partial<Record<Protocol, DeviceCapabilities>> {
  const out: Partial<Record<Protocol, DeviceCapabilities>> = {};

  // Life Fitness (control service 0x4b90): FTMS-backed but needs a handshake
  // and emits cadence even when the FTMS flag lies (LF bike override). When
  // present it SUPPRESSES the bare `ftms` entry so a single `lf` provider owns
  // the machine rather than two providers fighting over 0x2AD2.
  const hasLf = hasSvc(probe, SVC.lifeFitnessControl);

  if (hasSvc(probe, SVC.ftms) && !hasLf) {
    const f = probe.ftmsFeature;
    out.ftms = {
      // Feature char absent/unreadable → optimistic (Indoor Bike Data
      // almost always carries power/cadence/speed in practice); present
      // and the bit is 0 → definitively unsupported.
      power: f ? f.powerMeasurement : true,
      cadence: f ? f.cadence : true,
      speed: true,
      heartRate: f ? f.heartRate : false, // only claim HR-via-trainer if proven — most trainers don't
      // control needs firm proof — never synthesize a capability. Also:
      // a Feature char that's PRESENT but declares BOTH SIM and ERG bits
      // false must stay null, not a truthy-but-useless {false,false}
      // object (codex build-review finding, 2026-07-15 — DeviceRegistry's
      // `if (caps.control)` check would otherwise register a controller
      // that can never actually be used for anything).
      control:
        f && (f.indoorBikeSimulation || f.powerTarget)
          ? { simulation: f.indoorBikeSimulation, targetPower: f.powerTarget }
          : null,
    };
  }

  if (hasSvc(probe, SVC.cyclingPower)) {
    const f = probe.cpFeature;
    out.cps = {
      power: true, // CP Measurement's Instantaneous Power is mandatory whenever the service exists
      cadence: f ? f.crankRevolutionSupported : true,
      // wheel-revolution data alone cannot become a speed reading: wheel
      // circumference is never transmitted by the sensor, only
      // app-configured, and this build has no wheel-circumference config
      // UI — never claim a capability we cannot honestly compute.
      speed: false,
      heartRate: false,
      control: null, // CP Control Point (0x2A66) is calibration-only — cannot drive resistance (measured on the real Tacx)
    };
  }

  if (hasSvc(probe, SVC.csc)) {
    const f = probe.cscFeature;
    out.csc = {
      power: false,
      cadence: f ? f.crankRevolutionSupported : true,
      speed: false, // same wheel-circumference gap as CPS wheel data
      heartRate: false,
      control: null,
    };
  }

  if (hasSvc(probe, SVC.heartRate)) {
    out.hrs = { power: false, cadence: false, speed: false, heartRate: true, control: null };
  }

  if (hasSvc(probe, SVC.tacxFec)) {
    // FE-C has no Feature characteristic equivalent — pages 16/25 telemetry
    // and pages 48/49/51 control are protocol-level facts once the service
    // itself is present (measured: real Tacx GATT tree has the tunnel
    // service and nothing else gates it). This is the concrete mechanism
    // the whole rebuild exists for: capability from SERVICE PRESENCE, not
    // a device-name/model branch.
    // page 16 General FE Data carries heart rate too (TacxFecProvider
    // decodes and stamps it) — claiming false here would silently drop a
    // real channel the owner's "see every sensor" bar requires.
    out.fec = { power: true, cadence: true, speed: true, heartRate: true, control: { simulation: true, targetPower: true } };
  }

  if (hasLf) {
    // Life Fitness streams standard FTMS after the handshake; capability mirrors
    // an FTMS bike (cadence always true — the LF override recovers it even when
    // the flag bit is 0). Control is real FTMS control when the feature says so.
    const f = probe.ftmsFeature;
    out.lf = {
      power: f ? f.powerMeasurement : true,
      cadence: true,
      speed: true,
      heartRate: f ? f.heartRate : false,
      control:
        f && (f.indoorBikeSimulation || f.powerTarget)
          ? { simulation: f.indoorBikeSimulation, targetPower: f.powerTarget }
          : null,
    };
  }

  if (hasSvc(probe, SVC.concept2Erg)) {
    // PM5: distance(0x0031) + speed/strokeRate/HR(0x0032) + calories(0x0033) +
    // stroke power(0x0036), merged. All four telemetry roles are reachable.
    out.c2 = { power: true, cadence: true, speed: true, heartRate: true, control: null };
  }

  if (hasSvc(probe, SVC.schwinnX70)) {
    // 17B packet → cadence + a resistance-driven power MODEL → Cardano speed;
    // HR arrives on the 0xf580 side-channel. No resistance control path here.
    out.x70 = { power: true, cadence: true, speed: true, heartRate: true, control: null };
  }

  if (hasSvc(probe, SVC.precor)) {
    // 19B fixed layout carries power / speed / cadence / HR directly.
    out.precor = { power: true, cadence: true, speed: true, heartRate: true, control: null };
  }

  if (hasSvc(probe, SVC.kayakFirst)) {
    // ASCII data frame → distance / speed / cadence / power (no heart rate).
    out.kf = { power: true, cadence: true, speed: true, heartRate: false, control: null };
  }

  // RSC (0x1814) is DELIBERATELY NOT derived here — the RSC-exclusion invariant
  // (this file's header + ble-sensors-helper) forbids treating it as a cycling
  // telemetry source. The parser (Parsers.parseRsc) and RscProvider exist for
  // completeness/explicit opt-in, but a chest strap advertising RSC alongside
  // Heart Rate (the owner's HRMPro+) must never auto-offer a bogus SPEED/cadence
  // candidate. No `out.rsc` here, by design.

  return out;
}

/** flattened, UNION-of-protocols capability set for a device — used by the
 *  role picker to decide which roles a device can EVER be offered for;
 *  the per-protocol breakdown above stays available for the advanced
 *  multi-channel disclosure. */
export function deriveDeviceCapabilities(probe: GattProbe): DeviceCapabilities {
  const perProtocol = deriveProtocolCapabilities(probe);
  let out = emptyCapabilities();
  for (const caps of Object.values(perProtocol)) out = mergeCapabilities(out, caps);
  return out;
}
