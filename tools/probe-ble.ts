/**
 * M1.4 BLE sensor-layer probe — the milestone acceptance battery.
 *
 * PURE section (node, milliseconds): exercises the actual parsers against
 * hand-built spec-conformant payloads (byte layouts from
 * docs/notes/ble-ftms-research.md) —
 *   HR 0x2A37 (u8/u16 formats, RR intervals, truncation)
 *   CPS 0x2A63 (flags gating, crank rollover mod 2^16, 1/1024 s ticks)
 *   CSC 0x2A5B
 *   FTMS 0x2AD2 (INVERTED bit-0 speed, cadence wire = rpm×2, s16 resistance)
 *   FTMS features / control-point encode+response, RevolutionRate math
 *   defensive parsing: truncated + lying-flags payloads must not throw
 *
 * LIVE section (needs dev server on :5173, headless Chromium — which has NO
 * Bluetooth stack, hence ?ride=blefake stages a scripted FakeTransport under
 * the same adapter interface the real Web Bluetooth path uses):
 *   gate  — bike modes locked while the BLE source has no live power
 *   flow  — fake FTMS trainer connected → power/cadence on the dashboard,
 *           bike mounts, rides
 *   SIM   — control-point traffic observed: Request Control (0x00) FIRST,
 *           then Set Indoor Bike Simulation (0x11) writes whose decoded
 *           grade tracks the rig's live grade (±0.05 abs)
 *   P6    — trainer link dropped mid-ride: powerW reads null immediately,
 *           speed decays monotonically (honest coast — full stop-from-0 W
 *           physics is already proven at solver level by P1), NO page
 *           error, Connect UI flips to RECONNECT; a re-staged device
 *           reconnects and watts flow again
 *   P7    — ?ride=demo still renders the DEMO badge; ?ride=blefake renders
 *           NO badge (real-data path) but does render the BLE panel
 *
 * Usage: npx tsx tools/probe-ble.ts [--pure-only] [--shots]
 */

import {
  parseCsc,
  parseCyclingPower,
  parseFtmsCpResponse,
  parseFtmsFeatures,
  parseHeartRate,
  parseIndoorBikeData,
  encodeRequestControl,
  encodeSimParams,
  encodeTargetPower,
  RevolutionRate,
} from '../src/ride/ble/Parsers';

let pass = true;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

function dv(...bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

function purePart(): void {
  console.log('--- pure parser battery ---');

  // HR: u8 format, contact supported+on, no RR
  let h = parseHeartRate(dv(0x06, 142));
  check('HR u8 + contact', h.bpm === 142 && h.sensorContact === true && !h.truncated);
  // HR: u16 format + energy + two RR intervals (0.5 s and 1.0 s)
  h = parseHeartRate(dv(0x19, 0x2c, 0x01, 0x10, 0x27, 0x00, 0x02, 0x00, 0x04));
  check(
    'HR u16 + energy + RR×2',
    h.bpm === 300 && h.energyKj === 10000 && h.rrS.length === 2 &&
      Math.abs((h.rrS[0] ?? 0) - 0.5) < 1e-9 && Math.abs((h.rrS[1] ?? 0) - 1.0) < 1e-9,
    `bpm=${h.bpm} rr=[${h.rrS.join(',')}]`,
  );
  // HR truncated: flags promise u16 HR, only one byte follows
  h = parseHeartRate(dv(0x01, 0x55));
  check('HR truncated → null, no throw', h.bpm === null && h.truncated);

  // CPS: power only (flags 0x0000, 200 W)
  let p = parseCyclingPower(dv(0x00, 0x00, 0xc8, 0x00));
  check('CPS power-only', p.powerW === 200 && p.crank === null && !p.truncated);
  // CPS: balance(bit0)+ref(bit1) + torque(bit2) + crank(bit5)
  p = parseCyclingPower(dv(0x27, 0x00, 0x2c, 0x01, 100, 0x40, 0x00, 0x10, 0x00, 0x34, 0x12));
  check(
    'CPS balance+torque+crank',
    p.powerW === 300 && p.pedalBalancePct === 50 && p.balanceRefLeft &&
      p.accTorqueNm === 2 && p.crank?.revs === 0x0010 && p.crank?.eventT === 0x1234,
    `p=${p.powerW} bal=${p.pedalBalancePct} tq=${p.accTorqueNm} crank=${p.crank?.revs}/${p.crank?.eventT}`,
  );
  // CPS lying flags: promises wheel data (bit4) but payload ends — no throw
  p = parseCyclingPower(dv(0x10, 0x00, 0xc8, 0x00, 0x01));
  check('CPS lying flags → truncated, no throw', p.powerW === 200 && p.wheel === null && p.truncated);

  // CSC: wheel + crank present
  const c = parseCsc(dv(0x03, 0x0a, 0, 0, 0, 0x00, 0x08, 0x05, 0x00, 0x00, 0x04));
  check(
    'CSC wheel+crank',
    c.wheel?.revs === 10 && c.wheel?.eventT === 0x0800 && c.crank?.revs === 5 && c.crank?.eventT === 0x0400,
  );

  // RevolutionRate: 90 rpm crank — 3 revs per 2 s (2048 ticks @1024/s)
  const rr = new RevolutionRate(1024, 16);
  rr.push(100, 10000, 0);
  rr.push(103, 12048, 1);
  check('RevRate 90 rpm', Math.abs(rr.revPerS() * 60 - 90) < 0.1, `${(rr.revPerS() * 60).toFixed(2)} rpm`);
  // counter rollover across 0xFFFF and timer rollover across 0x10000
  rr.push(0xfffe, 0xff00, 1);
  rr.push(1, 0x0100, 1); // +3 revs, +512 ticks = 0.5 s → 6 rev/s
  check('RevRate rollover', Math.abs(rr.revPerS() - 6) < 0.01, `${rr.revPerS().toFixed(2)} rev/s`);
  // stale decay: no new events for > 3 s → 0
  rr.tick(3.5);
  check('RevRate stale → 0', rr.revPerS() === 0);

  // FTMS Indoor Bike Data: bit0=0 (speed PRESENT — inverted), cadence(bit2),
  // power(bit6): [flags][speed 25.50 km/h][cadence 170 = 85 rpm][power 210]
  let b = parseIndoorBikeData(dv(0x44, 0x00, 0xf6, 0x09, 0xaa, 0x00, 0xd2, 0x00));
  check(
    'IBD speed+cadence+power (bit0 inverted)',
    b.speedKmh === 25.5 && b.cadenceRpm === 85 && b.powerW === 210,
    `v=${b.speedKmh} cad=${b.cadenceRpm} p=${b.powerW}`,
  );
  // More Data continuation: bit0=1 → NO speed; resistance(bit5) s16 + HR(bit9)
  b = parseIndoorBikeData(dv(0x21, 0x02, 0xfe, 0xff, 145));
  check(
    'IBD more-data + s16 resistance + HR',
    b.speedKmh === null && b.resistance === -2 && b.heartRateBpm === 145,
    `res=${b.resistance} hr=${b.heartRateBpm}`,
  );
  // negative power (regen/backpedal) reads signed
  b = parseIndoorBikeData(dv(0x40, 0x00, 0x00, 0x00, 0xfb, 0xff));
  check('IBD negative power s16', b.powerW === -5);
  // truncated: flags promise cadence, nothing follows
  b = parseIndoorBikeData(dv(0x05, 0x00));
  check('IBD truncated → no throw', b.truncated && b.cadenceRpm === null);

  // FTMS features: target bit13 = indoor bike simulation
  const f = parseFtmsFeatures(dv(0x86, 0x40, 0x00, 0x00, 0x0c, 0xa0, 0x00, 0x00));
  check(
    'FTMS features bits',
    f.cadence && f.powerMeasurement && f.indoorBikeSimulation && f.spinDown && !f.wheelCircumference,
  );

  // control-point encodes: SIM 5 % grade, Crr 0.004, Cw 0.51
  const sim = new Uint8Array(encodeSimParams(0, 0.05, 0.004, 0.51));
  check(
    'encode SIM 0x11 grade=5%',
    sim[0] === 0x11 && sim[1] === 0 && sim[2] === 0 &&
      new DataView(sim.buffer).getInt16(3, true) === 500 && sim[5] === 40 && sim[6] === 51,
    `[${Array.from(sim).join(',')}]`,
  );
  const neg = new Uint8Array(encodeSimParams(0, -0.08, 0.004, 0.51));
  check('encode SIM negative grade', new DataView(neg.buffer).getInt16(3, true) === -800);
  check('encode RequestControl', new Uint8Array(encodeRequestControl())[0] === 0x00);
  const erg = new Uint8Array(encodeTargetPower(250));
  check('encode ERG 0x05', erg[0] === 0x05 && new DataView(erg.buffer).getInt16(1, true) === 250);

  // control-point response indications
  const ok = parseFtmsCpResponse(dv(0x80, 0x11, 0x01));
  const denied = parseFtmsCpResponse(dv(0x80, 0x11, 0x05));
  check(
    'CP response parse',
    ok?.ok === true && denied?.ok === false && denied.result === 0x05 &&
      parseFtmsCpResponse(dv(0x42)) === null,
  );

  // empty payloads never throw
  parseHeartRate(dv());
  parseCyclingPower(dv());
  parseCsc(dv());
  parseIndoorBikeData(dv());
  check('empty payloads → no throw', true);
}

// ---- live section ---------------------------------------------------------------

async function livePart(shots: boolean): Promise<void> {
  console.log('--- live engine battery (fake BLE transport) ---');
  const { launchWebGPUReal } = await import('./launch-gpu');
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-ble] adapter ${info.vendor}/${info.architecture}`);
  let pageErrors = 0;

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => {
    pageErrors++;
    console.error('[pageerror]', err.message);
  });
  const url = 'http://localhost:5173/?scene=world&seed=1&T=11&hud=0&freeze=1&ride=blefake&road=asphalt,0.3';
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
  /** run a snippet with (dbg) in page context */
  const dbgEval = <T,>(fn: (dbg: Record<string, unknown>) => T): Promise<T> =>
    page.evaluate(
      (src) => {
        const dbg = (window as unknown as { __laasDbg: Record<string, unknown> }).__laasDbg;
        // eslint-disable-next-line no-new-func
        return (new Function('dbg', `return (${src})(dbg)`) as (d: unknown) => T)(dbg);
      },
      fn.toString(),
    );

  // no-power gate: BLE source attached but nothing connected → bikes locked
  const locked = await dbgEval((dbg) => {
    const r = dbg['ride'] as { setMode(m: string): boolean; state(): { riding: boolean } };
    r.setMode('road');
    return !r.state().riding;
  });
  check('gate: bikes locked with no live power channel', locked);

  // stage + connect a fake FTMS trainer (SIM-capable), start telemetry pump
  await dbgEval((dbg) => {
    interface FakeT {
      stage(kind: string, d: unknown): void;
    }
    interface Src {
      connect(kind: string): Promise<void>;
    }
    const mk = dbg['bleMakeFakeDevice'] as (name: string, services: number[]) => {
      readable: Map<string, DataView>;
      emit(svc: number, chr: number, bytes: Uint8Array): void;
    };
    const d = mk('FakeKICKR', [0x1826]);
    // features: machine cadence+power, targets SIM(bit13)+ERG(bit3)
    d.readable.set(
      `${0x1826}:${0x2acc}`,
      new DataView(new Uint8Array([0x86, 0x40, 0x00, 0x00, 0x08, 0x20, 0x00, 0x00]).buffer),
    );
    (dbg['bleFake'] as FakeT).stage('trainer', d);
    (dbg['bleTrainer'] as unknown) = d;
    // telemetry pump: 4 Hz Indoor Bike Data — 26.00 km/h, 85 rpm, 215 W
    const pump = setInterval(() => {
      d.emit(
        0x1826,
        0x2ad2,
        new Uint8Array([0x44, 0x00, 0x28, 0x0a, 0xaa, 0x00, 0xd7, 0x00]),
      );
    }, 250);
    (dbg['blePump'] as unknown) = pump;
    return (dbg['bleSource'] as Src).connect('trainer');
  });
  await settle(60);

  const sample = await dbgEval((dbg) => {
    const s = dbg['bleSource'] as { read(): { powerW: number | null; cadenceRpm: number | null } };
    return s.read();
  });
  check(
    'fake trainer telemetry flows (power+cadence)',
    sample.powerW === 215 && sample.cadenceRpm === 85,
    `p=${sample.powerW} cad=${sample.cadenceRpm}`,
  );

  // mount + ride on live watts
  const riding = await dbgEval((dbg) => {
    const r = dbg['ride'] as { setMode(m: string): boolean; state(): { riding: boolean } };
    r.setMode('road');
    return r.state().riding;
  });
  check('bike mounts once power channel is live', riding);
  await settle(300); // ride a few seconds — SIM writes accumulate

  // SIM-gradient path: Request Control first, then 0x11 writes tracking grade
  const simObs = await dbgEval((dbg) => {
    const d = dbg['bleTrainer'] as { writes: { chr: number; bytes: Uint8Array }[] };
    const r = dbg['ride'] as { state(): { grade: number } };
    const cp = d.writes.filter((w) => w.chr === 0x2ad9);
    const first = cp[0]?.bytes[0];
    const sims = cp.filter((w) => w.bytes[0] === 0x11);
    const lastSim = sims[sims.length - 1];
    let lastGrade = NaN;
    if (lastSim) {
      const dvv = new DataView(lastSim.bytes.buffer, lastSim.bytes.byteOffset);
      lastGrade = dvv.getInt16(3, true) / 10000; // 0.01 % steps → fraction
    }
    return { first, simCount: sims.length, lastGrade, rigGrade: r.state().grade };
  });
  check('SIM: Request Control (0x00) precedes all', simObs.first === 0x00, `first op=${simObs.first}`);
  check('SIM: gradient writes observed', simObs.simCount >= 2, `writes=${simObs.simCount}`);
  check(
    'SIM: written grade tracks rig grade ±0.05',
    Number.isFinite(simObs.lastGrade) && Math.abs(simObs.lastGrade - simObs.rigGrade) < 0.05,
    `wire=${simObs.lastGrade.toFixed(4)} rig=${simObs.rigGrade.toFixed(4)}`,
  );

  if (shots) {
    await page.screenshot({ path: 'shots/wip/probe-ble-riding.png' });
    console.log('[shot] shots/wip/probe-ble-riding.png');
  }

  // ---- P6: dropout mid-ride ------------------------------------------------------
  // deterministic runway: coast equilibrium on a downhill is ~constant speed
  // (honest physics, verified live) — a NATURAL STOP needs an uphill, so
  // teleport onto an edge whose grade along our direction is ≥ +1.5 %
  const runway = await dbgEval((dbg) => {
    interface GEdge { id: number; length: number }
    interface Graph { edges: GEdge[]; sample(e: number, s: number): { grade: number } }
    const graph = dbg['rideGraph'] as Graph;
    const r = dbg['ride'] as { teleportEdge(e: number, s: number, d: 1 | -1): boolean };
    for (const e of graph.edges) {
      if (e.length < 80) continue;
      for (const dir of [1, -1] as const) {
        let ok = true;
        for (const s of [10, e.length * 0.5, e.length - 10]) {
          if (graph.sample(e.id, s).grade * dir < 0.015) ok = false;
        }
        if (ok) {
          r.teleportEdge(e.id, dir > 0 ? 10 : e.length - 10, dir);
          return e.id;
        }
      }
    }
    return -1;
  });
  check('P6: uphill runway found for coast test', runway >= 0, `edge=${runway}`);
  await settle(120); // reach speed on the climb with live watts
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

  // natural stop: without watts, the uphill coast must bleed to ~standstill
  const vs: number[] = [afterDrop.v];
  for (let i = 0; i < 20; i++) {
    await settle(60);
    const v = await dbgEval((dbg) => (dbg['ride'] as { state(): { vMs: number } }).state().vMs);
    vs.push(v);
    if (v < 0.3) break;
  }
  const decayed = vs.every((v, i) => i === 0 || v <= (vs[i - 1] ?? Infinity) + 0.05);
  check(
    'P6: coast to natural stop (uphill, no watts)',
    decayed && (vs[vs.length - 1] ?? 1) < 0.3 && v0 > 1,
    `v=[${vs.map((v) => (v * 3.6).toFixed(1)).join(' → ')}] km/h`,
  );

  // reconnect UI: the trainer row must offer RECONNECT after the drop
  const rowState = await page.evaluate(() => {
    const row = document.querySelector('#ble-panel .bp-row[data-kind="trainer"]');
    return { cls: row?.className ?? '', btn: row?.querySelector('.bp-btn')?.textContent ?? '' };
  });
  check(
    'P6: Connect UI flips to RECONNECT',
    rowState.cls.includes('lost') && rowState.btn === 'RECONNECT',
    `cls='${rowState.cls}' btn='${rowState.btn}'`,
  );
  if (shots) {
    await page.screenshot({ path: 'shots/wip/probe-ble-dropout.png' });
    console.log('[shot] shots/wip/probe-ble-dropout.png');
  }

  // reconnect: stage a fresh device, connect, watts flow again
  await dbgEval((dbg) => {
    const mk = dbg['bleMakeFakeDevice'] as (name: string, services: number[]) => {
      readable: Map<string, DataView>;
      emit(svc: number, chr: number, bytes: Uint8Array): void;
    };
    const d = mk('FakeKICKR-2', [0x1826]);
    d.readable.set(
      `${0x1826}:${0x2acc}`,
      new DataView(new Uint8Array([0x86, 0x40, 0x00, 0x00, 0x08, 0x20, 0x00, 0x00]).buffer),
    );
    (dbg['bleFake'] as { stage(k: string, d: unknown): void }).stage('trainer', d);
    const pump = setInterval(() => {
      d.emit(0x1826, 0x2ad2, new Uint8Array([0x44, 0x00, 0x28, 0x0a, 0xaa, 0x00, 0xd7, 0x00]));
    }, 250);
    (dbg['blePump'] as unknown) = pump;
    return (dbg['bleSource'] as { connect(k: string): Promise<void> }).connect('trainer');
  });
  await settle(60);
  const rejoined = await dbgEval((dbg) => {
    const s = dbg['bleSource'] as { read(): { powerW: number | null } };
    return s.read().powerW;
  });
  check('P6: reconnect restores live power', rejoined === 215, `p=${rejoined}`);
  await dbgEval((dbg) => clearInterval(dbg['blePump'] as number));

  // ---- P7: badges ------------------------------------------------------------------
  const noBadge = await page.evaluate(() => document.querySelectorAll('.rh-badge').length);
  const hasPanel = await page.evaluate(() => document.querySelector('#ble-panel') !== null);
  check('P7: BLE path renders NO badge (real data)', noBadge === 0, `badges=${noBadge}`);
  check('P7: BLE panel present', hasPanel);
  await page.close();

  const p2 = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await p2.goto('http://localhost:5173/?scene=sanity&seed=1&hud=0&ride=demo', {
    waitUntil: 'domcontentloaded',
  });
  await p2.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const demoBadge = await p2.evaluate(
    () =>
      Array.from(document.querySelectorAll('.rh-badge')).some((b) => b.textContent === 'DEMO'),
  );
  check('P7: demo mode still renders the DEMO badge', demoBadge);
  await p2.close();
  await browser.close();
}

async function main(): Promise<void> {
  const pureOnly = process.argv.includes('--pure-only');
  const shots = process.argv.includes('--shots');
  purePart();
  if (!pureOnly) await livePart(shots);
  console.log(pass ? '\nALL PASS' : '\nFAILURES — see above');
  process.exit(pass ? 0 : 1);
}

void main();
