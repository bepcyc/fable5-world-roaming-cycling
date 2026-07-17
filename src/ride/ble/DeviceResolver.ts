/**
 * DeviceResolver — the name/vendor identity layer. Given a scan digest (name,
 * advertised service UUIDs, company ids, manufacturers, derived machine type)
 * plus a handful of user prefs, it returns the matching descriptor entry
 * (fourCC + sport + data service/char + quirk flags) or null (unsupported).
 * Every supported device family is represented as a DESCRIPTORS entry.
 *
 * Resolution order:
 *   1. Name-prefix loop (skipped entirely for Matrix machines) with the
 *      Concept2-also-advertises-FTMS guard and the Technogym/Stryd fourCC quirk.
 *   2. Service-fallback order (no FTMS): precor → schwinnX70 → c2 → kayak →
 *      cyclingPower → cyclingCadence → heartRate.
 *   3. Matrix company-id case; else persisted last-used sport; else generic
 *      FTMS descriptor for the advertised machine-type's sport.
 *
 * PURE / side-effect-free (node-testable). Capability derivation still keys off
 * SERVICE PRESENCE in Capabilities.ts — this resolver only names the descriptor
 * and carries its quirk flags.
 */

import {
  JOHNSON_HEALTH_TECH_COMPANY_ID,
  MATRIX_INC_COMPANY_ID,
  needsMatrixSpecialTreatment,
} from './machines/MatrixQuirks';

// ---- sports + machine types ---------------------------------------------------

export type Sport =
  | 'ride'
  | 'run'
  | 'kayaking'
  | 'canoeing'
  | 'rowing'
  | 'nordicSki'
  | 'rockClimbing'
  | 'stairStepper'
  | 'swim'
  | 'elliptical'
  | 'workout';

/** MachineType enum bits. */
export const MACHINE_TYPE = {
  notFitnessMachine: 0,
  treadmill: 1,
  crossTrainer: 2,
  stepClimber: 4,
  stairClimber: 8,
  rower: 16,
  indoorBike: 32,
} as const;
export type MachineType = number;

const SPECIFIC_FTMS_TYPES = new Set<number>([
  MACHINE_TYPE.treadmill,
  MACHINE_TYPE.crossTrainer,
  MACHINE_TYPE.stepClimber,
  MACHINE_TYPE.stairClimber,
  MACHINE_TYPE.rower,
  MACHINE_TYPE.indoorBike,
]);

/** map a single-machine-type byte to its sport. */
export function machineTypeSport(mt: MachineType): Sport {
  switch (mt) {
    case MACHINE_TYPE.treadmill:
      return 'run';
    case MACHINE_TYPE.crossTrainer:
      return 'elliptical';
    case MACHINE_TYPE.stepClimber:
      return 'stairStepper';
    case MACHINE_TYPE.stairClimber:
      return 'rockClimbing';
    case MACHINE_TYPE.rower:
      return 'rowing';
    case MACHINE_TYPE.indoorBike:
    default:
      return 'ride';
  }
}

export function isSpecificFtms(mt: MachineType | null): boolean {
  return mt !== null && SPECIFIC_FTMS_TYPES.has(mt);
}

// ---- service short-UUIDs referenced by the fallback order ---------------------

const SVC = {
  ftms: '1826',
  precor: 'ee07',
  schwinnX70: '8980',
  c2Erg: '0030',
  kayakFirst: 'ffe0',
  cyclingPower: '1818',
  cyclingCadence: '1816',
  heartRate: '180d',
} as const;

/** services a device may advertise to be "worthy" of the filtered scan
 *  used to decide chooser worthiness. */
export const WORTHY_SCAN_SERVICES: readonly string[] = [
  SVC.ftms,
  SVC.precor,
  SVC.schwinnX70,
  SVC.cyclingPower,
  SVC.cyclingCadence,
  SVC.c2Erg,
  SVC.kayakFirst,
  SVC.heartRate,
];

// ---- descriptor entry (fourCC + sport + data service/char + quirk flags) ------

export interface DescriptorEntry {
  fourCC: string;
  sport: Sport;
  isMultiSport: boolean;
  vendorName?: string;
  modelName?: string;
  manufacturerNamePart?: string;
  dataServiceId?: number;
  dataCharacteristicId?: number;
  /** 1 (Concept2/CSC/RSC/HRM), 2 (default FTMS), 3 (cross-trainer + fixed) */
  flagByteSize: number;
  hasFeatureFlags: boolean; // false for fixed-layout devices
  listenOnControl: boolean; // false: Schwinn X70 / Precor / Concept2 / KayakFirst / all sensors
  canMeasureCalories: boolean; // false: Bowflex C7, Schwinn IC4/IC8, InternalMotion
  doNotReadManufacturerName: boolean; // true: all Life Fitness, InternalMotion, InternalHR
  isPolling: boolean; // KayakFirst
  fragmentedPackets: boolean; // KayakFirst
  supportsSpinDown: boolean; // forced true for KPro
  /** whether start/stop workout opcodes should be signalled */
  shouldSignalStartStop: boolean;
}

type EntryInit = Partial<DescriptorEntry> & { fourCC: string; sport: Sport };

function entry(init: EntryInit): DescriptorEntry {
  return {
    isMultiSport: false,
    flagByteSize: 2,
    hasFeatureFlags: true,
    listenOnControl: true,
    canMeasureCalories: true,
    doNotReadManufacturerName: false,
    isPolling: false,
    fragmentedPackets: false,
    supportsSpinDown: false,
    shouldSignalStartStop: true,
    ...init,
  };
}

// ---- the full descriptor registry (all 38 files + factory-only fourCCs) -------

export const DESCRIPTORS: Record<string, DescriptorEntry> = {
  // FTMS generic machines (indoor_bike/treadmill/rower/cross/stair/step)
  GRid: entry({ fourCC: 'GRid', sport: 'ride', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  GRun: entry({ fourCC: 'GRun', sport: 'run', dataServiceId: 0x1826, dataCharacteristicId: 0x2acd }),
  GRow: entry({ fourCC: 'GRow', sport: 'rowing', isMultiSport: true, dataServiceId: 0x1826, dataCharacteristicId: 0x2ad1 }),
  GCan: entry({ fourCC: 'GCan', sport: 'canoeing', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad1 }),
  GKay: entry({ fourCC: 'GKay', sport: 'kayaking', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad1 }),
  GSwi: entry({ fourCC: 'GSwi', sport: 'swim', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad1 }),
  GXtr: entry({ fourCC: 'GXtr', sport: 'elliptical', dataServiceId: 0x1826, dataCharacteristicId: 0x2ace, flagByteSize: 3 }),
  GEll: entry({ fourCC: 'GEll', sport: 'elliptical', dataServiceId: 0x1826, dataCharacteristicId: 0x2ace, flagByteSize: 3 }),
  GSrC: entry({ fourCC: 'GSrC', sport: 'rockClimbing', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad0 }),
  GSpC: entry({ fourCC: 'GSpC', sport: 'stairStepper', dataServiceId: 0x1826, dataCharacteristicId: 0x2acf }),

  // FTMS vendor quirks (flag/length-gated overrides, resolved by name/company id)
  CSIB: entry({ fourCC: 'CSIB', sport: 'ride', vendorName: 'CardioStrong', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  MxBk: entry({ fourCC: 'MxBk', sport: 'ride', manufacturerNamePart: 'CTM', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  MxTm: entry({ fourCC: 'MxTm', sport: 'run', manufacturerNamePart: 'CTM', dataServiceId: 0x1826, dataCharacteristicId: 0x2acd }),
  MrCn: entry({ fourCC: 'MrCn', sport: 'rowing', manufacturerNamePart: 'XG', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad1 }),
  RUNN: entry({ fourCC: 'RUNN', sport: 'run', manufacturerNamePart: 'North Pole Engineering', dataServiceId: 0x1826, dataCharacteristicId: 0x2acd }),

  // Life Fitness family (FTMS + connect handshake)
  LFBk: entry({ fourCC: 'LFBk', sport: 'ride', manufacturerNamePart: 'LifeFitness', doNotReadManufacturerName: true, dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  LFTm: entry({ fourCC: 'LFTm', sport: 'run', manufacturerNamePart: 'LifeFitness', doNotReadManufacturerName: true, dataServiceId: 0x1826, dataCharacteristicId: 0x2acd }),
  LFEl: entry({ fourCC: 'LFEl', sport: 'elliptical', manufacturerNamePart: 'LifeFitness', doNotReadManufacturerName: true, dataServiceId: 0x1826, dataCharacteristicId: 0x2ace, flagByteSize: 3 }),
  LFSr: entry({ fourCC: 'LFSr', sport: 'rockClimbing', manufacturerNamePart: 'LifeFitness', doNotReadManufacturerName: true, dataServiceId: 0x1826, dataCharacteristicId: 0x2ad0 }),
  LFSp: entry({ fourCC: 'LFSp', sport: 'stairStepper', manufacturerNamePart: 'LifeFitness', doNotReadManufacturerName: true, dataServiceId: 0x1826, dataCharacteristicId: 0x2acf }),

  // Factory-only FTMS indoor bikes
  BFC7: entry({ fourCC: 'BFC7', sport: 'ride', vendorName: 'Bowflex', manufacturerNamePart: 'Nautilus', canMeasureCalories: false, dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  SIC4: entry({ fourCC: 'SIC4', sport: 'ride', vendorName: 'Schwinn', manufacturerNamePart: 'Nautilus', canMeasureCalories: false, dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  S130: entry({ fourCC: 'S130', sport: 'ride', vendorName: 'Schwinn', manufacturerNamePart: 'Nautilus', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  Stg2: entry({ fourCC: 'Stg2', sport: 'ride', vendorName: 'Stages', manufacturerNamePart: 'Stages', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  ysS3: entry({ fourCC: 'ysS3', sport: 'ride', vendorName: 'Yesoul', manufacturerNamePart: 'Yesoul', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  M667: entry({ fourCC: 'M667', sport: 'ride', vendorName: 'Merach', manufacturerNamePart: 'HUAWEI Technologies', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad2 }),
  VFUP: entry({ fourCC: 'VFUP', sport: 'rowing', vendorName: 'Virtufit', manufacturerNamePart: 'XEBEX', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad1 }),

  // Concept2 PM5 (fixed layout, flagByteSize 1, no manufacturer verify)
  Cpt2: entry({ fourCC: 'Cpt2', sport: 'rowing', isMultiSport: true, vendorName: 'Concept2', manufacturerNamePart: 'Concept2', dataServiceId: 0x0030, dataCharacteristicId: 0x0031, flagByteSize: 1, hasFeatureFlags: false, listenOnControl: false }),
  C2Rw: entry({ fourCC: 'C2Rw', sport: 'rowing', vendorName: 'Concept2', manufacturerNamePart: 'Concept2', dataServiceId: 0x0030, dataCharacteristicId: 0x0031, flagByteSize: 1, hasFeatureFlags: false, listenOnControl: false }),
  C2Sk: entry({ fourCC: 'C2Sk', sport: 'nordicSki', vendorName: 'Concept2', manufacturerNamePart: 'Concept2', dataServiceId: 0x0030, dataCharacteristicId: 0x0031, flagByteSize: 1, hasFeatureFlags: false, listenOnControl: false }),
  C2Bk: entry({ fourCC: 'C2Bk', sport: 'ride', vendorName: 'Concept2', manufacturerNamePart: 'Concept2', dataServiceId: 0x0030, dataCharacteristicId: 0x0031, flagByteSize: 1, hasFeatureFlags: false, listenOnControl: false }),

  // Schwinn X70 (fixed 17B, power model, HR side-channel)
  SX70: entry({ fourCC: 'SX70', sport: 'ride', vendorName: 'Schwinn', manufacturerNamePart: 'Nautilus', dataServiceId: 0x8980, dataCharacteristicId: 0x82a0, flagByteSize: 3, hasFeatureFlags: false, listenOnControl: false }),
  // Schwinn AC Performance Plus — STUB / not implemented for streaming
  'SAP+': entry({ fourCC: 'SAP+', sport: 'ride', vendorName: 'Schwinn' }),

  // Precor (fixed 19B)
  PSCP: entry({ fourCC: 'PSCP', sport: 'ride', vendorName: 'Precor', manufacturerNamePart: 'Precor', dataServiceId: 0xee07, dataCharacteristicId: 0xe01d, flagByteSize: 3, hasFeatureFlags: false, listenOnControl: false }),

  // KayakFirst (serial ASCII, polling, handshake)
  K1st: entry({ fourCC: 'K1st', sport: 'kayaking', isMultiSport: true, dataServiceId: 0xffe0, dataCharacteristicId: 0xffe1, isPolling: true, fragmentedPackets: true, listenOnControl: false }),
  KPro: entry({ fourCC: 'KPro', sport: 'kayaking', isMultiSport: true, vendorName: 'KayakPro', manufacturerNamePart: 'NPE', dataServiceId: 0x1826, dataCharacteristicId: 0x2ad1, supportsSpinDown: true }),

  // Cycling sensor descriptors (CPS / CSC, cycling + paddling),
  PowB: entry({ fourCC: 'PowB', sport: 'ride', dataServiceId: 0x1818, dataCharacteristicId: 0x2a63, listenOnControl: false }),
  PowP: entry({ fourCC: 'PowP', sport: 'kayaking', dataServiceId: 0x1818, dataCharacteristicId: 0x2a63, flagByteSize: 1, listenOnControl: false }),
  CSCB: entry({ fourCC: 'CSCB', sport: 'ride', dataServiceId: 0x1816, dataCharacteristicId: 0x2a5b, flagByteSize: 1, listenOnControl: false }),
  CSCP: entry({ fourCC: 'CSCP', sport: 'kayaking', dataServiceId: 0x1816, dataCharacteristicId: 0x2a5b, flagByteSize: 1, listenOnControl: false }),

  // RSC foot pods (Stryd / Technogym Run)
  Strd: entry({ fourCC: 'Strd', sport: 'run', vendorName: 'Stryd', dataServiceId: 0x1814, dataCharacteristicId: 0x2a53, flagByteSize: 1, listenOnControl: false }),
  TRun: entry({ fourCC: 'TRun', sport: 'run', manufacturerNamePart: 'Technogym', dataServiceId: 0x1814, dataCharacteristicId: 0x2a53, flagByteSize: 1, listenOnControl: false }),

  // Heart-rate + internal / platform-channel sources,
  HRMT: entry({ fourCC: 'HRMT', sport: 'ride', isMultiSport: true, dataServiceId: 0x180d, dataCharacteristicId: 0x2a37, flagByteSize: 1, listenOnControl: false }),
  BHTH: entry({ fourCC: 'BHTH', sport: 'workout', isMultiSport: true, dataServiceId: 0x180d, dataCharacteristicId: 0x2a37, flagByteSize: 1, listenOnControl: false, doNotReadManufacturerName: true }),
  INTH: entry({ fourCC: 'INTH', sport: 'workout', isMultiSport: true, dataServiceId: 0x180d, dataCharacteristicId: 0x2a37, flagByteSize: 1, listenOnControl: false, doNotReadManufacturerName: true }),
  INTM: entry({ fourCC: 'INTM', sport: 'ride', isMultiSport: true, flagByteSize: 1, listenOnControl: false, canMeasureCalories: false, doNotReadManufacturerName: true }),
};

/** genericDescriptorForSport. */
export function genericDescriptorForSport(sport: Sport): DescriptorEntry {
  switch (sport) {
    case 'ride':
      return DESCRIPTORS.GRid!;
    case 'run':
      return DESCRIPTORS.GRun!;
    case 'kayaking':
      return DESCRIPTORS.GKay!;
    case 'canoeing':
      return DESCRIPTORS.GCan!;
    case 'rockClimbing':
      return DESCRIPTORS.GSrC!;
    case 'rowing':
      return DESCRIPTORS.GRow!;
    case 'stairStepper':
      return DESCRIPTORS.GSpC!;
    case 'swim':
      return DESCRIPTORS.GSwi!;
    case 'elliptical':
      return DESCRIPTORS.GXtr!;
    case 'nordicSki':
      return DESCRIPTORS.C2Sk!;
    case 'workout':
      return DESCRIPTORS.C2Bk!;
    default:
      return DESCRIPTORS.GRid!;
  }
}

// ---- name-prefix table, preserved order -------------------------------------

interface NamePrefixEntry {
  fourCC: string;
  prefixes: string[]; // lowered startsWith targets
  postfix?: string; // lowered endsWith requirement
  postfixExclusions?: string[]; // lowered endsWith exclusions
  manufacturerPrefix?: string; // lowered "contains" requirement
  ambiguous?: boolean; // skip the name loop (Matrix)
  sportsMatch?: boolean; // require FTMS machine-type sport == descriptor sport
}

const NAME_PREFIXES: NamePrefixEntry[] = [
  { fourCC: 'BHTH', prefixes: ['bht hrm'] },
  { fourCC: 'BFC7', prefixes: ['c7-'] },
  { fourCC: 'CSIB', prefixes: ['fs-ib50'] },
  { fourCC: 'C2Bk', prefixes: ['pm5'], postfix: 'bike' },
  { fourCC: 'Cpt2', prefixes: ['pm5'], postfixExclusions: ['bike', 'row', 'ski'] },
  { fourCC: 'C2Rw', prefixes: ['pm5'], postfix: 'row' },
  { fourCC: 'C2Sk', prefixes: ['pm5'], postfix: 'ski' },
  { fourCC: 'GRid', prefixes: ['ftms bike'] },
  { fourCC: 'GCan', prefixes: ['ftms canoe'] },
  { fourCC: 'GXtr', prefixes: ['ftms cross trainer'] },
  { fourCC: 'GEll', prefixes: ['ftms elliptical'] },
  { fourCC: 'GKay', prefixes: ['ftms kayak'] },
  { fourCC: 'GRow', prefixes: ['ftms rower'] },
  { fourCC: 'GSrC', prefixes: ['ftms stair climb'] },
  { fourCC: 'GSpC', prefixes: ['ftms step climb'] },
  { fourCC: 'GSwi', prefixes: ['ftms swim'] },
  { fourCC: 'GRun', prefixes: ['ftms treadmill'] },
  { fourCC: 'INTH', prefixes: ['internal heart rate'] },
  { fourCC: 'INTM', prefixes: ['internal motion'] },
  { fourCC: 'KPro', prefixes: ['kayakpro', 'kp'] },
  { fourCC: 'LFBk', prefixes: ['lf'], manufacturerPrefix: 'lifefitness', ambiguous: true, sportsMatch: true },
  { fourCC: 'LFEl', prefixes: ['lf'], manufacturerPrefix: 'lifefitness', ambiguous: true, sportsMatch: true },
  { fourCC: 'LFSr', prefixes: ['lf'], manufacturerPrefix: 'lifefitness', ambiguous: true, sportsMatch: true },
  { fourCC: 'LFSp', prefixes: ['lf'], manufacturerPrefix: 'lifefitness', ambiguous: true, sportsMatch: true },
  { fourCC: 'LFTm', prefixes: ['lf'], manufacturerPrefix: 'lifefitness', ambiguous: true, sportsMatch: true },
  { fourCC: 'MxBk', prefixes: ['ctm', 'johnson', 'matrix'], ambiguous: true },
  { fourCC: 'MxTm', prefixes: ['ctm', 'johnson', 'matrix'], ambiguous: true },
  { fourCC: 'M667', prefixes: ['merach-mr667'] },
  { fourCC: 'MrCn', prefixes: ['xg'] },
  { fourCC: 'RUNN', prefixes: ['runn'] },
  { fourCC: 'PowB', prefixes: ['stages ic'] },
  { fourCC: 'PSCP', prefixes: ['chrono'] },
  { fourCC: 'SAP+', prefixes: ['schwinn ac perf+'] },
  { fourCC: 'SIC4', prefixes: ['ic bike'] },
  { fourCC: 'S130', prefixes: ['sch130', 'sch230', 'sch510'] },
  { fourCC: 'SX70', prefixes: ['schwinn 170', 'schwinn 270', 'schwinn 570'] },
  { fourCC: 'Stg2', prefixes: ['stages bike'] },
  { fourCC: 'Strd', prefixes: ['stryd'] },
  { fourCC: 'TRun', prefixes: ['treadmill'], manufacturerPrefix: 'technogym' },
  { fourCC: 'VFUP', prefixes: ['virtufit-up2'] },
  { fourCC: 'ysS3', prefixes: ['yesoul'] },
];

// ---- resolver inputs ----------------------------------------------------------

export interface AdvertisementDigest {
  platformName: string;
  /** normalized 4-hex-char lowercase short-form service UUIDs */
  serviceUuids: string[];
  companyIds: number[];
  /** advertised manufacturer strings (lowered comparison happens internally) */
  manufacturers: string[];
  /** single derived machine type (null = not a specific FTMS machine) */
  machineType: MachineType | null;
  /** FTMS-advertised machine-type sports (for sportsMatch disambiguation) */
  machineTypes: MachineType[];
}

export interface ResolverPrefs {
  heartRateMonitorWorkout: boolean;
  treadmillRscOnlyMode: 'never' | 'always' | 'auto';
  paddlingWithCyclingSensors: boolean;
  /** persisted last-used sport for this MAC, or null */
  deviceUsageSport: Sport | null;
}

const DEFAULT_PREFS: ResolverPrefs = {
  heartRateMonitorWorkout: false,
  treadmillRscOnlyMode: 'never',
  paddlingWithCyclingSensors: false,
  deviceUsageSport: null,
};

function isPrefixContained(manufacturers: string[], manufacturerPrefix?: string): boolean {
  if (!manufacturerPrefix) return true;
  if (manufacturers.length === 0) return true;
  const p = manufacturerPrefix.toLowerCase();
  return manufacturers.some((m) => m.toLowerCase().includes(p));
}

function shouldBeExcludedByBluetoothName(loweredName: string, exclusions?: string[]): boolean {
  return (exclusions ?? []).some((x) => loweredName.endsWith(x));
}

// ---- the pipeline --------------

export function determineDescriptor(
  digest: AdvertisementDigest,
  prefs: Partial<ResolverPrefs> = {},
): DescriptorEntry | null {
  const p: ResolverPrefs = { ...DEFAULT_PREFS, ...prefs };
  const services = new Set(digest.serviceUuids.map((s) => s.toLowerCase()));
  const hasFtms = services.has(SVC.ftms);

  let descriptor: DescriptorEntry | null = null;

  // Step 1 — name-prefix loop (Matrix machines skip it entirely).
  if (!needsMatrixSpecialTreatment(digest.companyIds)) {
    const lowerName = digest.platformName.toLowerCase();
    const ftmsSports = new Set(digest.machineTypes.map(machineTypeSport));
    for (const np of NAME_PREFIXES) {
      if (descriptor) break;
      if (np.ambiguous) continue; // Matrix names resolved via company-id branch only
      const cand = DESCRIPTORS[np.fourCC];
      if (!cand) continue;
      for (const prefix of np.prefixes) {
        if (!lowerName.startsWith(prefix)) continue;
        if (np.postfix && !lowerName.endsWith(np.postfix)) continue;
        if (shouldBeExcludedByBluetoothName(lowerName, np.postfixExclusions)) continue;
        if (np.sportsMatch && !ftmsSports.has(cand.sport)) continue;
        if (!isPrefixContained(digest.manufacturers, np.manufacturerPrefix)) continue;

        // Technogym Run guard: only in RSC-only "always" mode below; in "never"
        // it must never win the treadmill name-match.
        if (np.fourCC === 'TRun' && p.treadmillRscOnlyMode === 'never') continue;
        // Concept2 that ALSO advertises FTMS → let the FTMS path win.
        if ((np.fourCC === 'C2Rw' || np.fourCC === 'Cpt2' || np.fourCC === 'C2Bk' || np.fourCC === 'C2Sk') && hasFtms) {
          continue;
        }

        let chosen = cand;
        // Run descriptor + treadmillRscOnlyMode "always" → force Technogym RSC.
        if (chosen.sport === 'run' && np.fourCC !== 'TRun' && p.treadmillRscOnlyMode === 'always') {
          chosen = DESCRIPTORS.TRun ?? chosen;
        }
        descriptor = chosen;
        break;
      }
    }
  }

  if (descriptor) return descriptor;

  // Step 2 — infer from services / usage.
  if (!hasFtms) {
    if (services.has(SVC.precor)) return DESCRIPTORS.PSCP!;
    if (services.has(SVC.schwinnX70)) return DESCRIPTORS.SX70!;
    if (services.has(SVC.c2Erg)) return DESCRIPTORS.Cpt2!;
    if (services.has(SVC.kayakFirst)) return DESCRIPTORS.K1st!;
    if (services.has(SVC.cyclingPower)) return p.paddlingWithCyclingSensors ? DESCRIPTORS.PowP! : DESCRIPTORS.PowB!;
    if (services.has(SVC.cyclingCadence)) return p.paddlingWithCyclingSensors ? DESCRIPTORS.CSCP! : DESCRIPTORS.CSCB!;
    if (services.has(SVC.heartRate) && p.heartRateMonitorWorkout) return DESCRIPTORS.HRMT!;
    return null;
  }

  if (needsMatrixSpecialTreatment(digest.companyIds)) {
    if (digest.machineType === MACHINE_TYPE.treadmill) return DESCRIPTORS.MxTm!;
    if (digest.machineType === MACHINE_TYPE.indoorBike) return DESCRIPTORS.MxBk!;
    return null;
  }

  if (p.deviceUsageSport !== null) return genericDescriptorForSport(p.deviceUsageSport);

  if (isSpecificFtms(digest.machineType)) return genericDescriptorForSport(machineTypeSport(digest.machineType!));

  return null;
}

/** scan worthiness: connectable + non-empty id, and (if filtered)
 *  advertises a worthy service OR matches a non-ambiguous name prefix. */
export function isWorthyForScan(digest: AdvertisementDigest, filterDevices: boolean): boolean {
  if (!filterDevices) return true;
  const services = new Set(digest.serviceUuids.map((s) => s.toLowerCase()));
  if (WORTHY_SCAN_SERVICES.some((s) => services.has(s))) return true;
  const lowerName = digest.platformName.toLowerCase();
  return NAME_PREFIXES.some(
    (np) =>
      !np.ambiguous &&
      np.prefixes.some((prefix) => lowerName.startsWith(prefix)) &&
      isPrefixContained(digest.manufacturers, np.manufacturerPrefix),
  );
}

export { MATRIX_INC_COMPANY_ID, JOHNSON_HEALTH_TECH_COMPANY_ID, needsMatrixSpecialTreatment };
