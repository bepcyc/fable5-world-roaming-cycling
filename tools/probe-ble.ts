/**
 * BLE sensor-layer probe — Zwift-grade rebuild acceptance battery
 * (docs/BLE_ZWIFT_PLAN.md). Three sections:
 *
 * PURE (plain node, milliseconds): parsers against hand-built
 * spec-conformant payloads, capability derivation, FE-C frame codec golden
 * fixtures, and the filters[]-OR-not-AND regression (the literal root
 * cause this whole rebuild starts from).
 *
 * ARCHITECTURE (plain node, milliseconds — NO browser/Bluetooth stack
 * needed at all): DeviceRegistry+RoleMux+providers+BleSensorSource run
 * against FakeTransport/FakeDevice exactly as in the browser, since none
 * of that code touches `document`/`window`/`navigator` — only
 * BleSensorSource.available()/the real WebBluetoothTransport do, and
 * neither is exercised here. This proves the owner's split-role
 * acceptance case (pedals → power+cadence, trainer → control only, its
 * own power channel deliberately unused), control activation gated to
 * mount (not connect), provider isolation, and reconnect-by-identity —
 * all deterministically, without headless-Chromium flake.
 *
 * LIVE (needs the dev server + headless Chromium, which has NO Bluetooth
 * stack, hence ?ride=blefake stages the same FakeTransport through the
 * real main.ts wiring): honesty gate, DOM chip/manager presence, badge
 * absence for real-data mode, DEMO badge still renders for ?ride=demo.
 *
 * Usage: LAAS_PORT=5177 npx tsx tools/probe-ble.ts [--pure-only] [--shots]
 */

import {
  parseCsc,
  parseCyclingPower,
  parseCpFeature,
  parseCscFeature,
  parseFtmsCpResponse,
  parseFtmsFeatures,
  parseHeartRate,
  parseIndoorBikeData,
  encodeRequestControl,
  encodeSimParams,
  encodeTargetPower,
  RevolutionRate,
} from '../src/ride/ble/Parsers';
import {
  decodeCommandStatus,
  decodeFecFrame,
  decodeGeneralFeData,
  decodeSpecificTrainerData,
  encodeBasicResistance,
  encodeFecFrame,
  encodeTargetPower as encodeFecTargetPower,
  encodeTrackResistance,
  FEC_PAGE,
} from '../src/ride/ble/FecFrame';
import { deriveProtocolCapabilities, type GattProbe } from '../src/ride/ble/Capabilities';
import { buildAnyDeviceFilters, CHR, SVC, serviceKey, FakeDevice, FakeTransport } from '../src/ride/ble/Transport';
import { BleSensorSource } from '../src/ride/ble/BleSensorSource';

let pass = true;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

function dv(...bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

// ==================================================================================
// PURE — parsers, capability derivation, FE-C codec, filter-shape regression
// ==================================================================================

function purePart(): void {
  console.log('--- pure parser battery ---');

  let h = parseHeartRate(dv(0x06, 142));
  check('HR u8 + contact', h.bpm === 142 && h.sensorContact === true && !h.truncated);
  h = parseHeartRate(dv(0x19, 0x2c, 0x01, 0x10, 0x27, 0x00, 0x02, 0x00, 0x04));
  check(
    'HR u16 + energy + RR×2',
    h.bpm === 300 && h.energyKj === 10000 && h.rrS.length === 2 &&
      Math.abs((h.rrS[0] ?? 0) - 0.5) < 1e-9 && Math.abs((h.rrS[1] ?? 0) - 1.0) < 1e-9,
  );
  h = parseHeartRate(dv(0x01, 0x55));
  check('HR truncated → null, no throw', h.bpm === null && h.truncated);

  let p = parseCyclingPower(dv(0x00, 0x00, 0xc8, 0x00));
  check('CPS power-only', p.powerW === 200 && p.crank === null && !p.truncated);
  p = parseCyclingPower(dv(0x27, 0x00, 0x2c, 0x01, 100, 0x40, 0x00, 0x10, 0x00, 0x34, 0x12));
  check(
    'CPS balance+torque+crank',
    p.powerW === 300 && p.pedalBalancePct === 50 && p.balanceRefLeft &&
      p.accTorqueNm === 2 && p.crank?.revs === 0x0010 && p.crank?.eventT === 0x1234,
  );
  p = parseCyclingPower(dv(0x10, 0x00, 0xc8, 0x00, 0x01));
  check('CPS lying flags → truncated, no throw', p.powerW === 200 && p.wheel === null && p.truncated);

  const c = parseCsc(dv(0x03, 0x0a, 0, 0, 0, 0x00, 0x08, 0x05, 0x00, 0x00, 0x04));
  check(
    'CSC wheel+crank',
    c.wheel?.revs === 10 && c.wheel?.eventT === 0x0800 && c.crank?.revs === 5 && c.crank?.eventT === 0x0400,
  );

  // ---- CP/CSC Feature — connect-time capability probe ----
  // CP Feature: bit2 wheel + bit3 crank supported
  const cpf = parseCpFeature(dv(0x0c, 0x00, 0x00, 0x00));
  check('CP Feature bit2+bit3', cpf.wheelRevolutionSupported && cpf.crankRevolutionSupported);
  const cpfNoCrank = parseCpFeature(dv(0x04, 0x00, 0x00, 0x00)); // wheel only
  check('CP Feature wheel-only (no crank)', cpfNoCrank.wheelRevolutionSupported && !cpfNoCrank.crankRevolutionSupported);
  const cscf = parseCscFeature(dv(0x03, 0x00)); // bit0 wheel + bit1 crank
  check('CSC Feature bit0+bit1', cscf.wheelRevolutionSupported && cscf.crankRevolutionSupported);

  // ---- RevolutionRate: rollover vs physical reset ----
  const rr = new RevolutionRate(1024, 16);
  rr.push(100, 10000, 0);
  rr.push(103, 12048, 1);
  check('RevRate 90 rpm', Math.abs(rr.revPerS() * 60 - 90) < 0.1);
  rr.push(0xfffe, 0xff00, 1);
  rr.push(1, 0x0100, 1); // genuine mod-2^16 rollover — small wrapped delta
  check('RevRate rollover', Math.abs(rr.revPerS() - 6) < 0.01);
  rr.tick(3.5);
  check('RevRate stale → 0', rr.revPerS() === 0);

  // physical reset (reconnect/battery pull): counter drops from 50000 to 10
  // — must NOT read as "the counter almost wrapped 65536 revs" (the bug
  // this rebuild fixes; see Parsers.ts wrapOrReset)
  const rr2 = new RevolutionRate(1024, 16);
  rr2.push(50000, 40000, 0);
  rr2.push(50003, 40512, 1); // normal +3 revs / +512 ticks = 6 rev/s
  check('RevRate baseline before reset', Math.abs(rr2.revPerS() - 6) < 0.01);
  rr2.push(10, 100, 1); // physical reset — raw delta -49993, NOT a plausible near-modulus wrap
  check('RevRate physical reset holds last rate, no spurious spike', Math.abs(rr2.revPerS() - 6) < 0.01, `${rr2.revPerS().toFixed(2)} rev/s`);
  rr2.push(13, 612, 1); // resumes counting from the new baseline — 3 revs/0.5s = 6 rev/s
  check('RevRate resumes cleanly after reset', Math.abs(rr2.revPerS() - 6) < 0.01, `${rr2.revPerS().toFixed(2)} rev/s`);

  // ---- RevolutionRate.push() RETURN-VALUE contract (codex build-review
  // finding, 2026-07-15): the pre-fix code let a reset re-stamp the
  // AgingChannel with the OLD held-over rate, reading "freshly live" even
  // though nothing new was measured. push() must return null exactly when
  // no genuinely accepted sample was produced — callers gate stamp() on it.
  const rr3 = new RevolutionRate(1024, 16);
  check('RevRate.push() first-ever call returns null (no baseline yet)', rr3.push(100, 10000, 0) === null);
  const firstReal = rr3.push(103, 12048, 1); // +3 revs/+2048 ticks(2s) = 1.5 rev/s = 90 rpm
  check('RevRate.push() normal forward sample returns the rate, not null', firstReal !== null && Math.abs((firstReal ?? 0) * 60 - 90) < 0.1, `${firstReal}`);
  const idleSample = rr3.push(103, 13072, 1); // same rev count — idle, but still a genuine liveness sample
  check('RevRate.push() idle (no new revs) still returns a sample, not null', idleSample !== null, `${idleSample}`);
  const resetSample = rr3.push(2, 50, 1); // physical reset — raw delta far outside plausible wrap
  check('RevRate.push() on physical reset returns null (the exact codex-found bug)', resetSample === null, `${resetSample}`);
  const spike = rr3.push(2 + 50, 50 + 10, 1); // 50 revs / 10 ticks(1024/s) = 5120 rev/s — implausible spike
  check('RevRate.push() on an implausible spike returns null, does not resurrect a stale rate', spike === null, `${spike}`);

  let b = parseIndoorBikeData(dv(0x44, 0x00, 0xf6, 0x09, 0xaa, 0x00, 0xd2, 0x00));
  check('IBD speed+cadence+power (bit0 inverted)', b.speedKmh === 25.5 && b.cadenceRpm === 85 && b.powerW === 210);
  b = parseIndoorBikeData(dv(0x21, 0x02, 0xfe, 0xff, 145));
  check('IBD more-data + s16 resistance + HR', b.speedKmh === null && b.resistance === -2 && b.heartRateBpm === 145);
  b = parseIndoorBikeData(dv(0x40, 0x00, 0x00, 0x00, 0xfb, 0xff));
  check('IBD negative power s16', b.powerW === -5);
  b = parseIndoorBikeData(dv(0x05, 0x00));
  check('IBD truncated → no throw', b.truncated && b.cadenceRpm === null);

  const f = parseFtmsFeatures(dv(0x86, 0x40, 0x00, 0x00, 0x0c, 0xa0, 0x00, 0x00));
  check('FTMS features bits', f.cadence && f.powerMeasurement && f.indoorBikeSimulation && f.spinDown && !f.wheelCircumference);

  const sim = new Uint8Array(encodeSimParams(0, 0.05, 0.004, 0.51));
  check(
    'encode SIM 0x11 grade=5%',
    sim[0] === 0x11 && new DataView(sim.buffer).getInt16(3, true) === 500 && sim[5] === 40 && sim[6] === 51,
  );
  check('encode SIM negative grade', new DataView(new Uint8Array(encodeSimParams(0, -0.08, 0.004, 0.51)).buffer).getInt16(3, true) === -800);
  check('encode RequestControl', new Uint8Array(encodeRequestControl())[0] === 0x00);
  const erg = new Uint8Array(encodeTargetPower(250));
  check('encode ERG 0x05', erg[0] === 0x05 && new DataView(erg.buffer).getInt16(1, true) === 250);

  const ok = parseFtmsCpResponse(dv(0x80, 0x11, 0x01));
  const denied = parseFtmsCpResponse(dv(0x80, 0x11, 0x05));
  check('CP response parse', ok?.ok === true && denied?.ok === false && parseFtmsCpResponse(dv(0x42)) === null);

  parseHeartRate(dv());
  parseCyclingPower(dv());
  parseCsc(dv());
  parseIndoorBikeData(dv());
  check('empty payloads → no throw', true);

  console.log('--- filters[]-OR-not-AND regression (the root-cause bug) ---');
  const filters = buildAnyDeviceFilters();
  check(
    'requestAnyDevice: one OR entry per service (not one AND entry with many)',
    filters.length >= 5 && filters.every((f) => f.services.length === 1),
    `entries=${filters.length} shapes=[${filters.map((f) => f.services.length).join(',')}]`,
  );
  check(
    'FTMS and Cycling Power are SEPARATE OR entries (Tacx has no 0x1826, must still match)',
    filters.some((f) => f.services[0] === SVC.ftms) && filters.some((f) => f.services[0] === SVC.cyclingPower),
  );
  check('Tacx FE-C vendor UUID is its own filter entry', filters.some((f) => f.services[0] === SVC.tacxFec));

  console.log('--- FE-C tunnel frame codec (golden bytes) ---');
  // page 48 Basic Resistance, 50% → raw 100 = 0x64 (independently hand/script-derived)
  const p48 = encodeBasicResistance(50);
  check('encode page48 50% resistance', p48.join(',') === [0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x64].join(','));
  const f48 = new Uint8Array(encodeFecFrame(p48));
  check(
    'FE-C frame envelope + checksum (page48)',
    f48[0] === 0xa4 && f48[1] === 0x09 && f48[2] === 0x4f && f48[3] === 0x05 && f48[12] === 0xeb,
    `[${Array.from(f48).map((x) => x.toString(16)).join(',')}]`,
  );
  // page 49 Target Power 250 W → raw 1000 = 0x03E8
  const p49 = encodeFecTargetPower(250);
  check('encode page49 250W', p49.join(',') === [0x31, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe8, 0x03].join(','));
  const f49 = new Uint8Array(encodeFecFrame(p49));
  check('FE-C frame checksum (page49)', f49[12] === 0x74);
  // page 51 Track Resistance 5.5% grade, Crr 0.004 → raw 20550, crrRaw 80
  const p51 = encodeTrackResistance(5.5, 0.004);
  check('encode page51 5.5% grade', p51.join(',') === [0x33, 0xff, 0xff, 0xff, 0xff, 0x46, 0x50, 0x50].join(','));
  const f51 = new Uint8Array(encodeFecFrame(p51));
  check('FE-C frame checksum (page51)', f51[12] === 0x72);
  const decGrade = decodeTrackResistanceGradeFromPage(p51);
  check('decode page51 grade round-trips', Math.abs(decGrade - 5.5) < 0.01, `${decGrade}`);
  // negative grade
  const p51n = encodeTrackResistance(-12.25, 0.004);
  check('encode page51 -12.25% grade', p51n.join(',') === [0x33, 0xff, 0xff, 0xff, 0xff, 0x57, 0x49, 0x50].join(','));

  // decode independently constructed frames (not just encode round-trips)
  const rxFrame = decodeFecFrame(dv(0xa4, 0x09, 0x4f, 0x05, 0x19, 3, 85, 0x2c, 0x01, 0xd7, 0x00, 0xff, 0x00));
  // checksum byte deliberately WRONG (0x00) to prove checksumOk catches it
  check('decode FE-C frame, wrong checksum flagged', rxFrame !== null && rxFrame.pageId === 0x19 && rxFrame.checksumOk === false);
  const trainerData = rxFrame ? decodeSpecificTrainerData(rxFrame.page) : null;
  check(
    'decode page25 Specific Trainer Data',
    trainerData?.cadenceRpm === 85 && trainerData?.accPowerW === 300 && trainerData?.instPowerW === 215,
    JSON.stringify(trainerData),
  );
  const genFe = decodeGeneralFeData([0x10, 25, 0, 0, 0x40, 0x1f, 145, 0]); // speed raw 0x1f40=8000 → 8.0 m/s
  check('decode page16 General FE Data', genFe.speedMs === 8.0 && genFe.heartRateBpm === 145);
  const status = decodeCommandStatus([0x47, 0x33, 7, 0, 0, 0, 0, 0]);
  check('decode page71 Command Status', status.lastCommandPageId === 0x33 && status.sequenceNumber === 7 && status.statusCode === 0);
  check('FEC_PAGE constants match the pages tested above', FEC_PAGE.trackResistance === 0x33 && FEC_PAGE.specificTrainerData === 0x19);
  const truncatedFrame = decodeFecFrame(dv(0xa4, 0x09));
  check('FE-C frame truncated → null, no throw', truncatedFrame === null);

  console.log('--- capability derivation (real GATT + feature bits, RSC exclusion) ---');
  // Tacx-shaped: 0x1818 + 0x1816 + FE-C tunnel, NO 0x1826 (measured live)
  const tacxProbe: GattProbe = {
    services: new Set(['0x1818', '0x1816', SVC.tacxFec.toLowerCase()]),
    cpFeature: { wheelRevolutionSupported: false, crankRevolutionSupported: true },
    cscFeature: { wheelRevolutionSupported: false, crankRevolutionSupported: true },
    ftmsFeature: null,
  };
  const tacxCaps = deriveProtocolCapabilities(tacxProbe);
  check(
    'Tacx-shaped device: NO ftms capability key at all (measured: no 0x1826 anywhere)',
    tacxCaps.ftms === undefined,
  );
  check('Tacx-shaped device: cps power+cadence', !!tacxCaps.cps?.power && !!tacxCaps.cps?.cadence);
  check('Tacx-shaped device: csc cadence (redundant with cps, both real)', !!tacxCaps.csc?.cadence);
  check(
    'Tacx-shaped device: fec is its ONLY control path (simulation+targetPower)',
    tacxCaps.fec?.control?.simulation === true && tacxCaps.fec?.control?.targetPower === true,
  );
  check('CP Control Point cannot drive resistance — cps.control stays null even though the char exists', tacxCaps.cps?.control === null);

  // HRMPro+-shaped: 0x180D + 0x1814 (RSC) + 0x180F — measured live
  const hrmProbe: GattProbe = {
    services: new Set(['0x180d', '0x1814', '0x180f']),
    cpFeature: null,
    cscFeature: null,
    ftmsFeature: null,
  };
  const hrmCaps = deriveProtocolCapabilities(hrmProbe);
  check('HRMPro+-shaped device: heartRate capability present', hrmCaps.hrs?.heartRate === true);
  check(
    'RSC EXCLUSION: 0x1814 present but produces NO cadence candidate anywhere (RSC is not even a valid Protocol key, by type)',
    Object.values(hrmCaps).every((c) => c?.cadence !== true),
  );

  // CP Feature absent/unreadable → optimistic capability, not a hard false
  const noFeatureProbe: GattProbe = {
    services: new Set(['0x1818']),
    cpFeature: null,
    cscFeature: null,
    ftmsFeature: null,
  };
  const noFeatureCaps = deriveProtocolCapabilities(noFeatureProbe);
  check('CP Feature char absent → cadence stays optimistic (true), not hard-false', noFeatureCaps.cps?.cadence === true);

  // CP Feature present, crank bit explicitly 0 → definitively unsupported
  const noCrankProbe: GattProbe = {
    services: new Set(['0x1818']),
    cpFeature: { wheelRevolutionSupported: true, crankRevolutionSupported: false },
    cscFeature: null,
    ftmsFeature: null,
  };
  const noCrankCaps = deriveProtocolCapabilities(noCrankProbe);
  check(
    'CP Feature present + crank bit 0 → cadence definitively false (no fallback inside CPS)',
    noCrankCaps.cps?.cadence === false,
  );

  // FTMS Feature present but BOTH SIM and ERG bits false → control must be
  // null, NOT a truthy-but-useless {simulation:false,targetPower:false}
  // object (codex build-review finding, 2026-07-15 — a truthy-empty
  // control object would make DeviceRegistry register a controller that
  // can never actually do anything).
  const noControlProbe: GattProbe = {
    services: new Set(['0x1826']),
    cpFeature: null,
    cscFeature: null,
    ftmsFeature: {
      cadence: true,
      powerMeasurement: true,
      resistanceLevel: false,
      heartRate: false,
      powerTarget: false,
      resistanceTarget: false,
      indoorBikeSimulation: false,
      wheelCircumference: false,
      spinDown: false,
    },
  };
  const noControlCaps = deriveProtocolCapabilities(noControlProbe);
  check(
    'FTMS Feature present, SIM+ERG both false → control is null, not a truthy-empty object',
    noControlCaps.ftms?.control === null,
    JSON.stringify(noControlCaps.ftms?.control),
  );

  // FE-C now claims heartRate capability (page 16 carries it, decoded by
  // TacxFecProvider — dropping a real channel would fail the "see every
  // sensor" bar)
  const fecHrProbe: GattProbe = {
    services: new Set([SVC.tacxFec.toLowerCase()]),
    cpFeature: null,
    cscFeature: null,
    ftmsFeature: null,
  };
  check('FE-C claims heartRate capability (page 16 General FE Data)', deriveProtocolCapabilities(fecHrProbe).fec?.heartRate === true);
}

function decodeTrackResistanceGradeFromPage(page: readonly number[]): number {
  const raw = ((page[6] ?? 0) << 8) | (page[5] ?? 0);
  return raw * 0.01 - 200;
}

// ==================================================================================
// ARCHITECTURE — DeviceRegistry/RoleMux/providers/BleSensorSource against
// FakeTransport, in plain Node — no browser, no Bluetooth stack needed.
// ==================================================================================

function stageFtmsTrainer(name: string, id?: string): FakeDevice {
  const d = new FakeDevice(name, [SVC.ftms], id);
  d.readable.set(
    `${serviceKey(SVC.ftms)}:${serviceKey(CHR.ftmsFeature)}`,
    new DataView(new Uint8Array([0x86, 0x40, 0x00, 0x00, 0x08, 0x20, 0x00, 0x00]).buffer), // cadence+power feature, SIM+ERG target
  );
  return d;
}

function stageTacxShaped(name: string, id?: string): FakeDevice {
  const d = new FakeDevice(name, [SVC.cyclingPower, SVC.csc, SVC.tacxFec], id);
  d.readable.set(
    `${serviceKey(SVC.cyclingPower)}:${serviceKey(CHR.cpFeature)}`,
    new DataView(new Uint8Array([0x0c, 0x00, 0x00, 0x00]).buffer), // wheel+crank supported
  );
  d.readable.set(
    `${serviceKey(SVC.csc)}:${serviceKey(CHR.cscFeature)}`,
    new DataView(new Uint8Array([0x03, 0x00]).buffer),
  );
  return d;
}

function stagePedalsShaped(name: string, id?: string): FakeDevice {
  // power meter pedals: 0x1818 ONLY, crank data present, no control at all
  const d = new FakeDevice(name, [SVC.cyclingPower], id);
  d.readable.set(
    `${serviceKey(SVC.cyclingPower)}:${serviceKey(CHR.cpFeature)}`,
    new DataView(new Uint8Array([0x08, 0x00, 0x00, 0x00]).buffer), // crank only, no wheel
  );
  return d;
}

/** narrows a RoleMux Assignment down to its deviceId, or null for
 *  unassigned/explicit-none — keeps the acceptance-case checks below
 *  readable without unsafe casts. */
function assignedId(a: unknown): string | null {
  return a && typeof a === 'object' && 'deviceId' in a ? (a as { deviceId: string }).deviceId : null;
}

function cpmBytes(watts: number, crankRevs: number, crankEventT: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0x0020, true); // flags: bit5 crank revolution data
  view.setInt16(2, watts, true);
  view.setUint16(4, crankRevs, true);
  view.setUint16(6, crankEventT, true);
  return buf;
}

async function tick(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function architecturePart(): Promise<void> {
  console.log('--- architecture battery (FakeTransport, plain node, no browser) ---');

  // === acceptance case: pedals → power+cadence, trainer → control ONLY ===
  const transport = new FakeTransport();
  const source = new BleSensorSource(transport);
  const registry = source.registry;

  const trainer = stageTacxShaped('FakeTacx', 'dev-trainer-1');
  transport.stage(trainer);
  await registry.addDevice();
  await tick(60);

  const trainerEntry = registry.list().find((d) => d.id === 'dev-trainer-1');
  check('Tacx-shaped device reaches ready (cps+csc+fec all attach)', trainerEntry?.stage === 'ready', `stage=${trainerEntry?.stage} err=${trainerEntry?.lastError}`);
  check(
    'Tacx-shaped device auto-fills power+cadence+control (nothing else connected yet)',
    registry.roleMux.assignmentFor('power') !== null &&
      registry.roleMux.assignmentFor('cadence') !== null &&
      registry.roleMux.assignmentFor('control') !== null,
  );
  const powerAssignAfterTrainer = registry.roleMux.assignmentFor('power');
  check(
    'auto-fill picked the trainer, standard GATT (cps) preferred over its own fec channel',
    powerAssignAfterTrainer !== 'none' && powerAssignAfterTrainer?.deviceId === 'dev-trainer-1' && powerAssignAfterTrainer.protocol === 'cps',
  );

  trainer.emit(SVC.cyclingPower, CHR.cyclingPowerMeasurement, cpmBytes(180, 10, 1024));
  await tick(20);
  check('trainer power streams before any bike is mounted', source.read().powerW === 180, `p=${source.read().powerW}`);

  // FE-C page 16 General FE Data carries heart rate too (codex build-review
  // finding, 2026-07-15: it was decoded but discarded — a real channel
  // silently dropped). This device has no 0x180D service, so its ONLY HR
  // source is FE-C, and it's the only device connected so far — HR should
  // auto-fill to it.
  check("HR role auto-filled to the FE-C trainer (its ONLY HR-capable protocol)", assignedId(registry.roleMux.assignmentFor('heartRate')) === 'dev-trainer-1');
  const page16 = [0x10, 25, 0, 0, 0x40, 0x1f, 142, 0]; // speed 8.0 m/s (unused here), HR 142 bpm
  trainer.emit(SVC.tacxFec, CHR.tacxFecTx, new Uint8Array(encodeFecFrame(page16)));
  await tick(20);
  const trainerHr = registry.roleMux.sampleFor('dev-trainer-1', 'fec', 'heartRate');
  check('FE-C page16 heart rate decoded and live', trainerHr?.state === 'live' && trainerHr.value === 142, JSON.stringify(trainerHr));

  // control must NOT be active yet — nobody has mounted a bike
  check('control NOT active before mount (device connected/assigned ≠ activated)', trainer.writes.length === 0, `writes=${trainer.writes.length}`);
  check('control not yet the active controller before activation', !registry.roleMux.isActiveController('dev-trainer-1', 'fec'));

  // connect the pedals — capable of power+cadence; nothing auto-changes
  const pedals = stagePedalsShaped('FakePedals', 'dev-pedals-1');
  transport.stage(pedals);
  await registry.addDevice();
  await tick(60);
  check(
    'connecting pedals does NOT move the already-assigned power/cadence roles',
    assignedId(registry.roleMux.assignmentFor('power')) === 'dev-trainer-1',
  );
  check('pedals never register a controller (no control capability)', registry.roleMux.candidatesFor('control').every((c) => c.deviceId !== 'dev-pedals-1'));

  // the owner's manual re-point: Power + Cadence → pedals
  registry.roleMux.assign('power', { deviceId: 'dev-pedals-1', protocol: 'cps' });
  registry.roleMux.assign('cadence', { deviceId: 'dev-pedals-1', protocol: 'cps' });
  pedals.emit(SVC.cyclingPower, CHR.cyclingPowerMeasurement, cpmBytes(245, 20, 2048));
  trainer.emit(SVC.cyclingPower, CHR.cyclingPowerMeasurement, cpmBytes(999, 12, 2048)); // trainer's own power keeps arriving
  await tick(20);
  check('after re-point, RideSample tracks the PEDALS', source.read().powerW === 245, `p=${source.read().powerW}`);
  const trainerOwnSample = registry.roleMux.sampleFor('dev-trainer-1', 'cps', 'power');
  check(
    "trainer's own CPS provider keeps streaming (visible, dimmed) but never reaches RideSample",
    trainerOwnSample?.state === 'live' && trainerOwnSample.value === 999 && source.read().powerW !== 999,
    `trainerOwn=${trainerOwnSample?.value} rideSample=${source.read().powerW}`,
  );
  check('control assignment untouched by the power/cadence re-point (still the trainer)', assignedId(registry.roleMux.assignmentFor('control')) === 'dev-trainer-1');

  // === control activation gated by mount, not by connect/assignment ===
  check('still no control writes before activation', trainer.writes.length === 0);
  source.activateControl();
  await tick(50);
  // FE-C has no request/grant handshake (unlike FTMS, exercised separately
  // below) — "acquired" means only "the link is writable," so the proof of
  // activation here is `isActiveController`, not an acquire-specific write;
  // the SIM write check right after is the concrete behavioral proof.
  check(
    'activateControl() actually activates the assigned FE-C controller (BikeRig.mount() hook, not connect-time)',
    registry.roleMux.isActiveController('dev-trainer-1', 'fec'),
  );
  source.setSimState(0.055, 0.004);
  await tick(20);
  registry.update(0.3); // advance the controller's write-throttle clock
  await tick(20);
  const fecWrites = trainer.writes.filter((w) => w.chr === CHR.tacxFecRx);
  check('SIM write reaches the FE-C control path (Tacx has no FTMS)', fecWrites.length > 0, `fecWrites=${fecWrites.length}`);
  if (fecWrites.length > 0) {
    const last = fecWrites[fecWrites.length - 1];
    const decoded = last ? decodeFecFrame(new DataView(last.bytes.buffer, last.bytes.byteOffset, last.bytes.byteLength)) : null;
    const grade = decoded ? decodeTrackResistanceGradeFromPage(decoded.page) : NaN;
    check('written grade tracks the rig grade (5.5%, ±0.1)', Math.abs(grade - 5.5) < 0.1, `wire=${grade}`);
  }

  source.releaseControl();
  await tick(20);
  const writesBeforeRelease = trainer.writes.length;
  registry.update(3);
  await tick(20);
  check('no further control writes after release (control genuinely stopped, not just unobserved)', trainer.writes.length === writesBeforeRelease);

  // === dropout: power reads null the instant the link drops ===
  pedals.drop();
  await tick(20);
  check('P6: power reads null immediately on drop (Pillar C — no synthesis)', source.read().powerW === null);
  const pedalsEntry = registry.list().find((d) => d.id === 'dev-pedals-1');
  check('P6: device card flips to lost', pedalsEntry?.stage === 'lost');

  // reconnect: SAME physical device (same BluetoothDevice.id) re-selected
  // from a fresh chooser gesture — the persisted role assignment (still
  // pointing at dev-pedals-1) re-matches automatically, no re-pick needed
  const pedals2 = stagePedalsShaped('FakePedals', 'dev-pedals-1');
  transport.stage(pedals2);
  await registry.addDevice();
  await tick(60);
  pedals2.emit(SVC.cyclingPower, CHR.cyclingPowerMeasurement, cpmBytes(260, 5, 512));
  await tick(20);
  check('P6: reconnect-by-identity restores live power without re-assigning roles', source.read().powerW === 260, `p=${source.read().powerW}`);

  // === generation-token dedupe: same id selected twice never duplicates providers ===
  const beforeCandidates = registry.roleMux.candidatesFor('power').length;
  const dupe = stagePedalsShaped('FakePedals-dupe-selection', 'dev-pedals-1');
  transport.stage(dupe);
  await registry.addDevice();
  await tick(60);
  const afterCandidates = registry.roleMux.candidatesFor('power').length;
  check(
    'selecting the same device id twice does not spawn a duplicate power candidate',
    afterCandidates === beforeCandidates,
    `before=${beforeCandidates} after=${afterCandidates}`,
  );
  check('only ONE paired-device entry exists for that id', registry.list().filter((d) => d.id === 'dev-pedals-1').length === 1);

  // === provider isolation: one broken characteristic must not poison the device ===
  const flaky = new FakeDevice('FlakyDevice', [SVC.cyclingPower, SVC.heartRate], 'dev-flaky-1');
  flaky.scriptCharacteristic(SVC.heartRate, CHR.heartRateMeasurement, { subscribeFails: true });
  transport.stage(flaky);
  await registry.addDevice();
  await tick(60);
  const flakyEntry = registry.list().find((d) => d.id === 'dev-flaky-1');
  check(
    'provider isolation: CPS attaches despite HRS subscribe failing on the same device',
    !!flakyEntry?.protocols.includes('cps') && !flakyEntry.protocols.includes('hrs'),
    `protocols=${flakyEntry?.protocols.join(',')} err=${flakyEntry?.lastError}`,
  );
  check('device still reaches ready (at least one protocol attached)', flakyEntry?.stage === 'ready');

  // === RSC exclusion, end-to-end through the real capability pipeline ===
  const hrmShaped = new FakeDevice('FakeHRMPro', [SVC.heartRate, SVC.runningSpeedCadence, SVC.battery], 'dev-hrm-1');
  transport.stage(hrmShaped);
  await registry.addDevice();
  await tick(60);
  check(
    'RSC-shaped device never appears as a cadence candidate (running dynamics ≠ crank RPM)',
    registry.roleMux.candidatesFor('cadence').every((c) => c.deviceId !== 'dev-hrm-1'),
  );
  check(
    'RSC-shaped device DOES appear as a heartRate candidate',
    registry.roleMux.candidatesFor('heartRate').some((c) => c.deviceId === 'dev-hrm-1'),
  );

  // === explicit "none" is sticky — a later connection must not override it ===
  registry.roleMux.assign('speed', 'none');
  const speedShaped = stageTacxShaped('AnotherTacx', 'dev-trainer-2');
  transport.stage(speedShaped);
  await registry.addDevice();
  await tick(60);
  check("explicit 'none' assignment survives a later capable device connecting", registry.roleMux.assignmentFor('speed') === 'none');

  // === FTMS controller path (Request Control → grant → SIM write) —
  // separate protocol from the FE-C path already exercised above; the
  // FakeDevice does NOT auto-ack control-point writes (a scripted probe
  // must simulate the trainer's own indication via respond()) ===
  const ftmsTrainer = stageFtmsTrainer('FakeFTMSTrainer', 'dev-ftms-1');
  transport.stage(ftmsTrainer);
  await registry.addDevice();
  await tick(60);
  registry.roleMux.assign('control', { deviceId: 'dev-ftms-1', protocol: 'ftms' });

  const activation = registry.roleMux.activateControl();
  await tick(20); // let acquire()'s subscribe + write land
  const reqWrite = ftmsTrainer.writes.find((w) => w.chr === CHR.ftmsControlPoint);
  check('FTMS acquire sends Request Control (op 0x00)', reqWrite?.bytes[0] === 0x00, `writes=${ftmsTrainer.writes.length}`);
  ftmsTrainer.respond(SVC.ftms, CHR.ftmsControlPoint, new Uint8Array([0x80, 0x00, 0x01])); // trainer grants control
  const granted = await activation;
  check('FTMS control granted after the trainer indicates success', granted === true);

  source.setSimState(0.03, 0.004);
  registry.update(0.3);
  await tick(20);
  const ftmsSimWrites = ftmsTrainer.writes.filter((w) => w.chr === CHR.ftmsControlPoint && w.bytes[0] === 0x11);
  check('FTMS SIM write (op 0x11) observed after grant', ftmsSimWrites.length > 0, `writes=${ftmsSimWrites.length}`);

  await registry.roleMux.releaseControl();
  check('release() clears the active controller (FTMS path)', !registry.roleMux.isActiveController('dev-ftms-1', 'ftms'));

  // === codex build-review race #1: concurrent addDevice() on the SAME
  // device id must not leak an orphaned/duplicate registration — the
  // pre-fix code registered a superseded bind()'s provider into RoleMux
  // even after a newer bind() had already torn it down (generation check
  // only ran BEFORE attachProtocol(), not after its internal await) ===
  const raceA = stagePedalsShaped('RaceDeviceA', 'dev-race-1');
  const raceB = stagePedalsShaped('RaceDeviceB', 'dev-race-1'); // same id — "the same physical device selected twice"
  transport.stage(raceA);
  transport.stage(raceB);
  await Promise.all([registry.addDevice(), registry.addDevice()]); // genuinely concurrent, not sequential
  await tick(60);
  check(
    'concurrent addDevice() race: exactly one paired-device entry survives',
    registry.list().filter((d) => d.id === 'dev-race-1').length === 1,
  );
  check(
    'concurrent addDevice() race: exactly one power candidate for that id (no orphaned duplicate)',
    registry.roleMux.candidatesFor('power').filter((c) => c.deviceId === 'dev-race-1').length === 1,
  );

  // === codex build-review race #2: a device disconnects WHILE its very
  // first activateControl() is still awaiting acquire() — the pre-fix
  // code had no generation guard on activation at all, so the stale
  // acquire() result would commit `activeController`/`controlActive` for
  // a device that is already gone ===
  const raceCtrl = stageFtmsTrainer('RaceFTMS', 'dev-racectrl-1');
  transport.stage(raceCtrl);
  await registry.addDevice();
  await tick(60);
  registry.roleMux.assign('control', { deviceId: 'dev-racectrl-1', protocol: 'ftms' });
  const raceActivation = registry.roleMux.activateControl(); // NOT awaited — acquire() is mid-flight
  await tick(10); // let the Request Control write land
  raceCtrl.respond(SVC.ftms, CHR.ftmsControlPoint, new Uint8Array([0x80, 0x00, 0x01])); // trainer grants...
  raceCtrl.drop(); // ...but the device disconnects before activateControl() ever resolves
  await tick(60);
  await raceActivation; // let the superseded activation finish resolving
  check(
    'control-op generation guard: a disconnect mid-first-activation is not resurrected once acquire() resolves',
    !registry.roleMux.isActiveController('dev-racectrl-1', 'ftms'),
  );

  // === reassignment mid-activation: assign control elsewhere WHILE the
  // previous device's activateControl() is still awaiting acquire() ===
  const reassignA = stageFtmsTrainer('ReassignA', 'dev-reassign-a');
  const reassignB = stageFtmsTrainer('ReassignB', 'dev-reassign-b');
  transport.stage(reassignA);
  transport.stage(reassignB);
  await registry.addDevice();
  await registry.addDevice();
  await tick(60);
  registry.roleMux.assign('control', { deviceId: 'dev-reassign-a', protocol: 'ftms' });
  const reassignActivation = registry.roleMux.activateControl();
  await tick(10);
  reassignA.respond(SVC.ftms, CHR.ftmsControlPoint, new Uint8Array([0x80, 0x00, 0x01]));
  registry.roleMux.assign('control', { deviceId: 'dev-reassign-b', protocol: 'ftms' }); // reassigned before A's acquire resolves
  await tick(60);
  await reassignActivation;
  check(
    "control-op generation guard: reassigning control mid-activation doesn't let the OLD device's acquire commit",
    !registry.roleMux.isActiveController('dev-reassign-a', 'ftms'),
  );

  console.log(pass ? 'architecture battery: all checks above passed' : 'architecture battery: SEE FAILURES ABOVE');
}

// ==================================================================================
// LIVE — real engine + DOM, headless Chromium (no Bluetooth stack; FakeTransport
// stages devices exactly as architecturePart() above, through the REAL main.ts
// wiring this time — proves BikeRig/RideHud/UI integration, not just the modules).
// ==================================================================================

async function livePart(shots: boolean): Promise<void> {
  console.log('--- live engine battery (fake BLE transport, real main.ts wiring) ---');
  const { LAAS_ORIGIN, launchWebGPUReal } = await import('./launch-gpu');
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ble] adapter ${info.vendor}/${info.architecture}`);
  let pageErrors = 0;

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => {
    pageErrors++;
    console.error('[pageerror]', err.message);
  });
  const url = `${LAAS_ORIGIN}/?scene=world&seed=1&T=11&hud=0&freeze=1&ride=blefake&road=asphalt,0.3`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const error = await page.evaluate(() => window.__laas.error);
  if (error) throw new Error(`App reported fatal error:\n${error}`);
  console.log(`[boot] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const settle = (frames: number): Promise<void> =>
    page.evaluate(async (n) => {
      if (window.__laas.settle) await window.__laas.settle(n);
    }, frames);
  const dbgEval = <T,>(fn: (dbg: Record<string, unknown>) => T): Promise<T> =>
    page.evaluate(
      (src) => {
        const dbg = (window as unknown as { __laasDbg: Record<string, unknown> }).__laasDbg;
        // eslint-disable-next-line no-new-func
        return (new Function('dbg', `return (${src})(dbg)`) as (d: unknown) => T)(dbg);
      },
      fn.toString(),
    );

  // no-power gate: BLE source attached, nothing connected → bikes locked
  const locked = await dbgEval((dbg) => {
    const r = dbg['ride'] as { setMode(m: string): boolean; state(): { riding: boolean } };
    r.setMode('road');
    return !r.state().riding;
  });
  check('gate: bikes locked with no live power channel', locked);

  // stage + connect a fake FTMS trainer through the REAL DeviceRegistry
  await dbgEval((dbg) => {
    const mk = dbg['bleMakeFakeDevice'] as (
      name: string,
      services: (number | string)[],
      id?: string,
    ) => { readable: Map<string, DataView>; emit(svc: number | string, chr: number | string, bytes: Uint8Array): void };
    const d = mk('FakeKICKR', [0x1826], 'live-trainer-1');
    d.readable.set(
      '0x1826:0x2acc',
      new DataView(new Uint8Array([0x86, 0x40, 0x00, 0x00, 0x08, 0x20, 0x00, 0x00]).buffer),
    );
    (dbg['bleFake'] as { stage(d: unknown): void }).stage(d);
    (dbg['bleTrainer'] as unknown) = d;
    const pump = setInterval(() => {
      d.emit(0x1826, 0x2ad2, new Uint8Array([0x44, 0x00, 0x28, 0x0a, 0xaa, 0x00, 0xd7, 0x00]));
    }, 250);
    (dbg['blePump'] as unknown) = pump;
    return (dbg['bleSource'] as { registry: { addDevice(all?: boolean): Promise<void> } }).registry.addDevice();
  });
  await settle(60);

  const sample = await dbgEval((dbg) => (dbg['bleSource'] as { read(): { powerW: number | null; cadenceRpm: number | null } }).read());
  check('fake trainer telemetry flows (power+cadence) through real DeviceRegistry', sample.powerW === 215 && sample.cadenceRpm === 85, `p=${sample.powerW} cad=${sample.cadenceRpm}`);

  const riding = await dbgEval((dbg) => {
    const r = dbg['ride'] as { setMode(m: string): boolean; state(): { riding: boolean } };
    r.setMode('road');
    return r.state().riding;
  });
  check('bike mounts once power channel is live', riding);
  await settle(120);

  // control activation happened at mount — the trainer must have received
  // a control-point write by now (FTMS Request Control)
  const controlWrites = await dbgEval((dbg) => (dbg['bleTrainer'] as { writes: { chr: number }[] }).writes.length);
  check('mounting activated control (FTMS control-point write observed)', controlWrites > 0, `writes=${controlWrites}`);

  if (shots) {
    await page.screenshot({ path: 'shots/wip/probe-ble-riding.png' });
    console.log('[shot] shots/wip/probe-ble-riding.png');
  }

  // dismount → control released; further ride ticks send no more writes
  const writesAtDismount = await dbgEval((dbg) => {
    const r = dbg['ride'] as { setMode(m: string): boolean };
    r.setMode('hike');
    return (dbg['bleTrainer'] as { writes: { chr: number }[] }).writes.length;
  });
  await settle(120);
  const writesAfterDismount = await dbgEval((dbg) => (dbg['bleTrainer'] as { writes: { chr: number }[] }).writes.length);
  check('dismount releases control — no further writes accumulate', writesAfterDismount === writesAtDismount, `${writesAtDismount} → ${writesAfterDismount}`);

  // remount to continue the dropout test
  await dbgEval((dbg) => (dbg['ride'] as { setMode(m: string): boolean }).setMode('road'));
  await settle(60);

  // ---- device-manager UI: chip + full panel DOM ----
  const chipPresent = await page.evaluate(() => document.querySelector('#ble-chip') !== null);
  check('BLE chip present in DOM', chipPresent);
  await dbgEval((dbg) => (dbg['bleUi'] as { open(): void }).open());
  const mgrOpen = await page.evaluate(() => document.querySelector('#ble-mgr.on') !== null);
  check('device manager opens (chip/B toggle)', mgrOpen);
  const cardCount = await page.evaluate(() => document.querySelectorAll('.bm-devcard').length);
  check('device manager shows the connected device as a card', cardCount >= 1, `cards=${cardCount}`);
  const roleRowCount = await page.evaluate(() => document.querySelectorAll('.bm-rolerow').length);
  check('device manager shows all 5 role rows', roleRowCount === 5, `rows=${roleRowCount}`);
  if (shots) {
    await page.screenshot({ path: 'shots/wip/probe-ble-manager.png' });
    console.log('[shot] shots/wip/probe-ble-manager.png');
  }
  await dbgEval((dbg) => (dbg['bleUi'] as { close(): void }).close());

  // ---- P6: dropout mid-ride ----
  const runway = await dbgEval((dbg) => {
    interface GEdge { id: number; length: number }
    interface Graph { edges: GEdge[]; sample(e: number, s: number): { grade: number } }
    const graph = dbg['rideGraph'] as Graph;
    const r = dbg['ride'] as { teleportEdge(e: number, s: number, d: 1 | -1): boolean };
    for (const e of graph.edges) {
      if (e.length < 80) continue;
      for (const d of [1, -1] as const) {
        let ok = true;
        for (const s of [10, e.length * 0.5, e.length - 10]) {
          if (graph.sample(e.id, s).grade * d < 0.015) ok = false;
        }
        if (ok) {
          r.teleportEdge(e.id, d > 0 ? 10 : e.length - 10, d);
          return e.id;
        }
      }
    }
    return -1;
  });
  check('P6: uphill runway found for coast test', runway >= 0, `edge=${runway}`);
  await settle(120);
  const v0 = await dbgEval((dbg) => {
    const r = dbg['ride'] as { state(): { vMs: number } };
    clearInterval(dbg['blePump'] as number);
    (dbg['bleTrainer'] as { drop(): void }).drop();
    return r.state().vMs;
  });
  await settle(30);
  const afterDrop = await dbgEval((dbg) => {
    const s = dbg['bleSource'] as { read(): { powerW: number | null } };
    const r = dbg['ride'] as { state(): { vMs: number; riding: boolean } };
    return { powerW: s.read().powerW, v: r.state().vMs, riding: r.state().riding };
  });
  check('P6: power reads null immediately after drop', afterDrop.powerW === null);
  check('P6: still riding (no crash, no dismount)', afterDrop.riding && pageErrors === 0);

  const vs: number[] = [afterDrop.v];
  for (let i = 0; i < 20; i++) {
    await settle(60);
    const v = await dbgEval((dbg) => (dbg['ride'] as { state(): { vMs: number } }).state().vMs);
    vs.push(v);
    if (v < 0.3) break;
  }
  const decayed = vs.every((v, i) => i === 0 || v <= (vs[i - 1] ?? Infinity) + 0.05);
  check('P6: coast to natural stop (uphill, no watts)', decayed && (vs[vs.length - 1] ?? 1) < 0.3 && v0 > 1, `v=[${vs.map((v) => (v * 3.6).toFixed(1)).join(' → ')}] km/h`);

  // reconnect: stage a fresh device with the SAME id, watts flow again
  await dbgEval((dbg) => {
    const mk = dbg['bleMakeFakeDevice'] as (
      name: string,
      services: (number | string)[],
      id?: string,
    ) => { readable: Map<string, DataView>; emit(svc: number | string, chr: number | string, bytes: Uint8Array): void };
    const d = mk('FakeKICKR', [0x1826], 'live-trainer-1');
    d.readable.set('0x1826:0x2acc', new DataView(new Uint8Array([0x86, 0x40, 0x00, 0x00, 0x08, 0x20, 0x00, 0x00]).buffer));
    (dbg['bleFake'] as { stage(d: unknown): void }).stage(d);
    const pump = setInterval(() => {
      d.emit(0x1826, 0x2ad2, new Uint8Array([0x44, 0x00, 0x28, 0x0a, 0xaa, 0x00, 0xd7, 0x00]));
    }, 250);
    (dbg['blePump'] as unknown) = pump;
    return (dbg['bleSource'] as { registry: { addDevice(all?: boolean): Promise<void> } }).registry.addDevice();
  });
  await settle(60);
  const rejoined = await dbgEval((dbg) => (dbg['bleSource'] as { read(): { powerW: number | null } }).read().powerW);
  check('P6: reconnect-by-identity restores live power', rejoined === 215, `p=${rejoined}`);
  await dbgEval((dbg) => clearInterval(dbg['blePump'] as number));

  // ---- P7: badges ----
  const noBadge = await page.evaluate(() => document.querySelectorAll('.rh-badge').length);
  check('P7: BLE path renders NO badge (real data)', noBadge === 0, `badges=${noBadge}`);
  await page.close();

  const p2 = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await p2.goto(`${LAAS_ORIGIN}/?scene=sanity&seed=1&hud=0&ride=demo`, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const demoBadge = await p2.evaluate(() => Array.from(document.querySelectorAll('.rh-badge')).some((b) => b.textContent === 'DEMO'));
  check('P7: demo mode still renders the DEMO badge', demoBadge);
  await p2.close();
  await browser.close();
}

async function main(): Promise<void> {
  const pureOnly = process.argv.includes('--pure-only');
  const shots = process.argv.includes('--shots');
  purePart();
  await architecturePart();
  if (!pureOnly) await livePart(shots);
  console.log(pass ? '\nALL PASS' : '\nFAILURES — see above');
  process.exit(pass ? 0 : 1);
}

void main();
