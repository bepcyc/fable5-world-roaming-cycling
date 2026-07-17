/**
 * Turn-picker gate (docs/TURN_PICKER.md) — geometry-true layout + the
 * Zwift cutoff + the no-teleport law, measured, not eyeballed.
 *
 * Rides a real ≥3-arm fork headlessly at three power levels and asserts:
 *  (a) ORDER   — the chooser's options are sorted strictly left→right by
 *                the REAL signed exit angle, recomputed here from raw graph
 *                geometry (chords), independent of BikeRig.buildOptions;
 *                glyph side matches the angle sign.
 *  (b) CUTOFF  — the pickable preview never exists inside the lock
 *                distance; once locked, it never reopens for the node.
 *  (c) NO-TELEPORT — a per-frame pose recorder spans the whole approach
 *                and the crossing; any frame-to-frame position jump
 *                > max(0.5 m, 2.5·v·dt + 0.1) is a red teleport. Runs with
 *                a LATE pick (just above the cutoff) and with NO pick.
 *  (d) DEFAULT — with no pick the bike takes the straightest exit; with a
 *                pick it takes the picked exit — verified by edge id.
 *  (e) TOUCH   — a Playwright touchscreen tap on a card re-selects it
 *                (the phone path probe-ui-touch audits geometrically).
 *
 * The fork is chosen with the LARGEST node cluster radius reachable by a
 * ≥140 m approach edge — exactly the junction shape whose old crossing
 * snapped the pose between polylines (the owner's "teleport").
 *
 * Usage: npx tsx tools/probe-turnpicker.ts [--shots] [--timeout 600000]
 */

import type { Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { LAAS_ORIGIN, launchWebGPUReal } from './launch-gpu';

const VIEW = { width: 1600, height: 900 };

let pass = true;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) pass = false;
}

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
}

interface GateExit {
  edge: number;
  end: 0 | 1;
  angleDeg: number;
}
interface Fork {
  node: number;
  edge: number;
  s0: number;
  dir: 1 | -1;
  nodeR: number;
  approachLen: number;
  exits: GateExit[];
}
interface SnapOpt {
  e: number;
  end: 0 | 1;
  a: number;
  t: string;
}
interface Snap {
  edge: number;
  s: number;
  v: number;
  j: { d: number; l: number; sel: number; opts: SnapOpt[] } | null;
  lk: { t: string; d: number } | null;
  bridge: number;
}
interface RecFrame {
  t: number;
  x: number;
  z: number;
  v: number;
  jd: number | null;
  jl: number | null;
  lk: string | null;
  edge: number;
}

/** find candidate forks + gate-side geometry (raw graph, chords — NOT
 *  BikeRig.buildOptions). String-evaluated: esbuild's __name wrapper breaks
 *  function-form page.evaluate in tsx-compiled tools (see probe-ui-touch). */
const FIND_FORKS_JS = `(() => {
  const g = window.__laasDbg.rideGraph;
  const armPt = (arm) => {
    const oe = g.edges[arm.edge];
    return arm.end === 0 ? oe.pts[0] : oe.pts[oe.pts.length - 1];
  };
  const armChord = (arm) => {
    const oe = g.edges[arm.edge];
    const p0 = armPt(arm);
    const sm = g.sample(oe.id, arm.end === 0 ? Math.min(12, oe.length) : Math.max(oe.length - 12, 0));
    const dx = sm.x - p0.x, dz = sm.z - p0.z, m = Math.hypot(dx, dz) || 1;
    return { x: dx / m, z: dz / m };
  };
  const out = [];
  for (const n of g.nodes) {
    if (n.arms.length < 3) continue;
    let nodeR = 0;
    for (const a of n.arms) {
      const p = armPt(a);
      nodeR = Math.max(nodeR, Math.hypot(p.x - n.x, p.z - n.z));
    }
    for (const arm of n.arms) {
      const e = g.edges[arm.edge];
      if (!e || e.length < 140) continue;
      const dir = arm.end === 1 ? 1 : -1;
      const s0 = dir > 0 ? Math.max(e.length - 130, 0) : Math.min(130, e.length);
      // incoming travel chord over the last 12 m before the node
      const sEnd = dir > 0 ? e.length : 0;
      const sBack = dir > 0 ? Math.max(e.length - 12, 0) : Math.min(12, e.length);
      const a2 = g.sample(e.id, sBack), b2 = g.sample(e.id, sEnd);
      let ix = b2.x - a2.x, iz = b2.z - a2.z;
      const im = Math.hypot(ix, iz) || 1;
      ix /= im; iz /= im;
      const exits = [];
      for (const x of n.arms) {
        if (x.edge === arm.edge) continue;
        const o = armChord(x);
        const angle = Math.atan2(iz * o.x - ix * o.z, ix * o.x + iz * o.z);
        exits.push({ edge: x.edge, end: x.end, angleDeg: (angle * 180) / Math.PI });
      }
      if (exits.length >= 2) {
        out.push({ node: n.id, edge: e.id, s0, dir, nodeR, approachLen: e.length, exits });
      }
    }
  }
  out.sort((a, b) => b.nodeR - a.nodeR);
  return out.slice(0, 12);
})()`;

const SNAP_JS = `(() => {
  const dbg = window.__laasDbg;
  const st = dbg.ride.state();
  const c = window.__laas.stats ? window.__laas.stats.counters : {};
  return {
    edge: dbg.ride.edge, s: dbg.ride.s, v: st.vMs,
    j: st.junction ? {
      d: st.junction.distM, l: st.junction.lockM, sel: st.junction.selected,
      opts: st.junction.options.map((o) => ({ e: o.arm.edge, end: o.arm.end, a: o.angle, t: o.turn })),
    } : null,
    lk: st.turnLocked ? { t: st.turnLocked.turn, d: st.turnLocked.distM } : null,
    bridge: c['ride.bridge'] || 0,
  };
})()`;

const REC_START_JS = `(() => {
  const rec = { frames: [], on: true };
  window.__tpRec = rec;
  const step = (ts) => {
    if (!rec.on) return;
    const pose = window.__laas.getPose();
    const dbg = window.__laasDbg;
    const st = dbg.ride.state();
    rec.frames.push({
      t: ts, x: pose.p[0], z: pose.p[2], v: st.vMs,
      jd: st.junction ? st.junction.distM : null,
      jl: st.junction ? st.junction.lockM : null,
      lk: st.turnLocked ? st.turnLocked.turn : null,
      edge: dbg.ride.edge,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})()`;

const REC_STOP_JS = `(() => {
  const rec = window.__tpRec;
  if (!rec) return [];
  rec.on = false;
  return rec.frames;
})()`;

async function settle(page: Page, frames: number): Promise<void> {
  await page.evaluate(
    `(async () => { if (window.__laas.settle) await window.__laas.settle(${frames}); })()`,
  );
}

async function snap(page: Page): Promise<Snap> {
  return (await page.evaluate(SNAP_JS)) as Snap;
}

/** continuity scan over recorder frames: red on any teleport-sized jump */
function continuity(frames: RecFrame[], tag: string): void {
  let worst = 0;
  let worstAt = '';
  let bad = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1] as RecFrame;
    const b = frames[i] as RecFrame;
    const dt = Math.max((b.t - a.t) / 1000, 1e-3);
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const v = Math.max(a.v, b.v);
    const cap = Math.max(0.5, 2.5 * v * dt + 0.1);
    if (d > cap) {
      bad++;
      if (d - cap > worst) {
        worst = d - cap;
        worstAt = `frame ${i} d=${d.toFixed(2)}m cap=${cap.toFixed(2)}m v=${v.toFixed(1)}`;
      }
    }
  }
  check(`no-teleport ${tag}`, bad === 0, bad === 0 ? `${frames.length} frames clean` : `${bad} jump(s), worst ${worstAt}`);
}

/** cutoff scan: no frame may show a pickable preview inside its lock dist */
function cutoff(frames: RecFrame[], tag: string): void {
  let bad = 0;
  let lockSeen = false;
  let reopened = 0;
  let firstEdge = frames[0]?.edge ?? -1;
  for (const f of frames) {
    if (f.edge !== firstEdge) break; // approach over — crossing swaps edges
    if (f.jd !== null && f.jl !== null && f.jd <= f.jl) bad++;
    if (f.lk !== null) lockSeen = true;
    if (lockSeen && f.jd !== null) reopened++;
  }
  check(`picker hidden inside cutoff ${tag}`, bad === 0, bad === 0 ? '' : `${bad} frame(s) pickable inside lock dist`);
  check(`lock happens before node ${tag}`, lockSeen, '');
  check(`picker never reopens after lock ${tag}`, reopened === 0, reopened === 0 ? '' : `${reopened} frame(s)`);
}

async function main(): Promise<void> {
  const shots = process.argv.includes('--shots');
  const timeout = arg('timeout', 600_000);
  const { browser, info } = await launchWebGPUReal();
  console.log(`[probe-turnpicker] adapter ${info.vendor}/${info.architecture}`);
  const page = await browser.newPage({
    viewport: VIEW,
    deviceScaleFactor: 1,
    hasTouch: true,
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const t0 = Date.now();
  await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=1&T=11&hud=0&freeze=1&ridedev=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout, polling: 500 },
  );
  const error = await page.evaluate(() => window.__laas.error);
  if (error) throw new Error(`App reported fatal error:\n${error}`);
  console.log(`[boot] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (shots) mkdirSync('shots/wip', { recursive: true });

  const forks = (await page.evaluate(FIND_FORKS_JS)) as Fork[];
  check('fork candidates found (≥3 arms, ≥140 m approach)', forks.length > 0, `n=${forks.length} widest nodeR=${forks[0]?.nodeR.toFixed(1)}m`);
  if (forks.length === 0) throw new Error('no usable fork in this seed');
  const fork = forks[0] as Fork;
  console.log(
    `[fork] node=${fork.node} approach edge=${fork.edge} dir=${fork.dir} nodeR=${fork.nodeR.toFixed(1)}m exits=[${fork.exits
      .map((x) => `${x.edge}:${x.angleDeg.toFixed(0)}°`)
      .join(', ')}]`,
  );

  /** ride the approach once; returns everything the asserts need */
  interface RideResult {
    frames: RecFrame[];
    firstPreview: Snap | null;
    lockedSnap: Snap | null;
    crossedTo: number;
    pickedEdge: number | null;
    tapMoved: boolean | null;
    domCards: number;
    shotsTaken: string[];
  }
  async function ride(
    powerW: number,
    mode: 'none' | 'tap' | 'late',
    shotPrefix: string | null,
  ): Promise<RideResult> {
    await page.evaluate(
      `(() => { const r = window.__laasDbg.ride; r.teleportEdge(${fork.edge}, ${fork.s0}, ${fork.dir}); r.setPower(${powerW}); })()`,
    );
    await page.evaluate(REC_START_JS);
    const res: RideResult = {
      frames: [],
      firstPreview: null,
      lockedSnap: null,
      crossedTo: -1,
      pickedEdge: null,
      tapMoved: null,
      domCards: 0,
      shotsTaken: [],
    };
    const shot = async (name: string): Promise<void> => {
      if (!shotPrefix) return;
      const p = `shots/wip/${shotPrefix}-${name}.png`;
      await page.screenshot({ path: p });
      res.shotsTaken.push(p);
    };
    const deadline = Date.now() + 240_000;
    let shotFar = false;
    let shotMid = false;
    let shotLock = false;
    while (Date.now() < deadline) {
      await settle(page, 3);
      const s = await snap(page);
      if (s.edge !== fork.edge) {
        res.crossedTo = s.edge;
        await shot('crossed');
        break;
      }
      if (s.j && !res.firstPreview) {
        res.firstPreview = s;
        await settle(page, 12); // HUD refresh cadence is 0.15 s — let it paint
        res.domCards = (await page.evaluate(
          `(() => document.querySelectorAll('#ride-junction .rj-opt').length)()`,
        )) as number;
      }
      if (s.j && !shotFar && s.j.d < s.j.l + 45) {
        shotFar = true;
        await shot('preview');
      }
      if (s.j && !shotMid && s.j.d < s.j.l + 18) {
        shotMid = true;
        await shot('near');
      }
      if (s.lk && !res.lockedSnap) {
        res.lockedSnap = s;
        if (!shotLock) {
          shotLock = true;
          await settle(page, 12); // let the HUD's 0.15 s refresh paint the chip
          await shot('locked');
        }
      }
      // interaction modes, each fired once while the window is open.
      // lockRef falls back when lockM is absent (pre-cutoff builds) so the
      // ride still EXERCISES the pick — the contract check below reddens.
      if (s.j && res.pickedEdge === null) {
        const n = s.j.opts.length;
        const nonDefault = s.j.sel === 0 ? n - 1 : 0;
        const lockRef = typeof s.j.l === 'number' ? s.j.l : 20;
        if (mode === 'tap' && s.j.d > lockRef + 25) {
          // touch path: tap the target card's own box (probe-ui-touch law)
          const box = await page.evaluate(
            `(() => { const el = document.querySelectorAll('#ride-junction .rj-opt')[${nonDefault}];
               if (!el) return null; const r = el.getBoundingClientRect();
               return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
          ) as { x: number; y: number } | null;
          if (box) {
            await page.touchscreen.tap(box.x, box.y);
            await settle(page, 3);
            const after = await snap(page);
            res.tapMoved = after.j !== null && after.j.sel === nonDefault;
            res.pickedEdge = s.j.opts[nonDefault]?.e ?? null;
          }
        } else if (mode === 'late' && s.j.d < lockRef + 12) {
          // last-moment pick, ~one bike length above the cutoff
          await page.evaluate(
            `(() => { window.__laasDbg.ride.pickJunctionOption(${nonDefault}); })()`,
          );
          res.pickedEdge = s.j.opts[nonDefault]?.e ?? null;
        }
      }
    }
    await settle(page, 30); // ride the bridge out before stopping the recorder
    res.frames = (await page.evaluate(REC_STOP_JS)) as RecFrame[];
    await page.evaluate(`(() => { window.__laasDbg.ride.setPower(0); })()`);
    return res;
  }

  // ---- case 1: slow ride, NO pick → default (straightest) exit ------------
  {
    const r = await ride(120, 'none', null);
    const tag = '@120W default';
    check(`fork crossed ${tag}`, r.crossedTo >= 0, `edge=${r.crossedTo}`);
    cutoff(r.frames, tag);
    continuity(r.frames, tag);
    const straightest = [...fork.exits].sort(
      (a, b) => Math.abs(a.angleDeg) - Math.abs(b.angleDeg),
    )[0] as GateExit;
    check(
      `default = straightest exit ${tag}`,
      r.crossedTo === straightest.edge,
      `crossed=${r.crossedTo} expected=${straightest.edge} (${straightest.angleDeg.toFixed(0)}°)`,
    );
    // (a) ORDER against gate-side geometry, from the first preview
    const j = r.firstPreview?.j ?? null;
    check(`preview appeared ${tag}`, j !== null, '');
    if (j) {
      check(
        'preview carries lockM (cutoff contract)',
        typeof j.l === 'number' && j.l > 0,
        `lockM=${String(j.l)}`,
      );
      const degs = j.opts.map((o) => (o.a * 180) / Math.PI);
      const sorted = degs.every((d, i) => i === 0 || (degs[i - 1] as number) > d - 1e-6);
      check('options sorted left→right by signed angle', sorted, `[${degs.map((d) => d.toFixed(0)).join(', ')}]`);
      let matched = 0;
      let sideOk = 0;
      for (const o of j.opts) {
        const gx = fork.exits.find((x) => x.edge === o.e && x.end === o.end);
        if (!gx) continue;
        if (Math.abs(gx.angleDeg - (o.a * 180) / Math.PI) <= 6) matched++;
        const deg = (o.a * 180) / Math.PI;
        const wantSide = deg > 14 ? 'left' : deg < -14 ? 'right' : 'straight';
        const side = o.t.includes('left') ? 'left' : o.t.includes('right') ? 'right' : o.t;
        if (
          wantSide === 'straight'
            ? side === 'straight' || Math.abs(deg) < 16
            : side === wantSide || o.t === 'u-turn'
        ) {
          sideOk++;
        }
      }
      check('option angles match raw graph geometry ±6°', matched === j.opts.length, `${matched}/${j.opts.length}`);
      check('glyph side matches angle sign', sideOk === j.opts.length, `${sideOk}/${j.opts.length}`);
      check('DOM shows one card per option', r.domCards === j.opts.length, `cards=${r.domCards} opts=${j.opts.length}`);
    }
  }

  // ---- case 2: medium ride, TOUCH pick of a non-default card --------------
  {
    const r = await ride(250, 'tap', shots ? 'turnpicker-250w' : null);
    const tag = '@250W tap';
    check(`fork crossed ${tag}`, r.crossedTo >= 0, `edge=${r.crossedTo}`);
    cutoff(r.frames, tag);
    continuity(r.frames, tag);
    check(`touch tap re-selects a card ${tag}`, r.tapMoved === true, `moved=${String(r.tapMoved)}`);
    check(
      `crossing takes the tapped exit ${tag}`,
      r.pickedEdge !== null && r.crossedTo === r.pickedEdge,
      `crossed=${r.crossedTo} picked=${String(r.pickedEdge)}`,
    );
    if (shots) console.log(`[shots] ${r.shotsTaken.join(' ')}`);
  }

  // ---- case 3: fast ride, LATE pick just above the cutoff ------------------
  {
    const r = await ride(420, 'late', null);
    const tag = '@420W late-pick';
    check(`fork crossed ${tag}`, r.crossedTo >= 0, `edge=${r.crossedTo}`);
    cutoff(r.frames, tag);
    continuity(r.frames, tag);
    check(
      `late pick still lands its exit ${tag}`,
      r.pickedEdge !== null && r.crossedTo === r.pickedEdge,
      `crossed=${r.crossedTo} picked=${String(r.pickedEdge)}`,
    );
  }

  await page.close();
  await browser.close();
  console.log(pass ? '[probe-turnpicker] ALL PASS' : '[probe-turnpicker] FAILURES PRESENT');
  if (!pass) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[probe-turnpicker] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
