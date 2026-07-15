/**
 * Road SHAPE gate — where does the asphalt bubble out, and where does it thin
 * to a thread?
 *
 * The owner, 2026-07-15, naming the anomaly precisely: "you need to find where
 * the asphalt bubbles out and thins into narrow paths. It's not a normal road,
 * it's an anomaly — cover it with a gate and run it across three seeds."
 * And, correcting an earlier wrong diagnosis of mine: "there can be gravel
 * under the wheels on a road bike, that's specified everywhere... but your
 * picture is genuinely strange in the road's SHAPE" — the surface CLASS is by
 * design and is NOT the bug. The GEOMETRY is.
 *
 * WHAT IS MEASURED: the road declares its width (RoadNetwork.ts: asphalt
 * halfWidth 2.9 → a 5.8 m two-lane). So walk the centreline from RouteGraph
 * and, at each station, cut PERPENDICULAR to the local axis and find how far
 * the road-class surface actually extends. That measured width, against the
 * declared one, is the anomaly:
 *   ratio = measuredWidth / declaredWidth
 *   ratio ≥ BUBBLE_X  → bubble: the carve splayed into a blob
 *   ratio ≤ THIN_X    → thinning: the ribbon necked down to a thread
 * A screenshot cannot separate these from a normal road at a glance — that is
 * why this exists as numbers, and why the eye kept calling a delta "a road".
 *
 * Also reported per station (cheap, and they explain the shape): tread
 * flatness, edge step, cross slope, water on the tread.
 *
 * Usage:
 *   npx tsx tools/probe-roadshape.ts --seeds 1,2,3 --cls asphalt
 *   npx tsx tools/probe-roadshape.ts --seeds 1 --cls asphalt --out shots/wip/roadshape.json
 * Exit code 2 if the gate fails (anomalies over budget) — CI-usable.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from 'playwright';
import { launchWebGPUReal, LAAS_ORIGIN } from './launch-gpu';

/** A blob this much wider than declared is not a road any more. */
const BUBBLE_X = 2.0;
/** Necked below this fraction of declared width = a thread, not a lane. */
const THIN_X = 0.5;
/** Gate: share of stations allowed to be anomalous, per seed. */
const MAX_ANOMALY_PCT = 5;

interface Args {
  [k: string]: string | boolean;
}
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith('--')) {
      out[k] = n;
      i++;
    } else out[k] = true;
  }
  return out;
}
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

interface Station {
  x: number;
  z: number;
  measuredW: number;
  ratio: number;
  kind: 'ok' | 'bubble' | 'thinning';
  treadFlatnessMm: number;
  edgeStepM: number;
  crossSlopePct: number;
  wetTread: number;
}
interface SeedResult {
  seed: number;
  declaredW: number;
  stations: Station[];
  bubbles: number;
  thins: number;
  anomalyPct: number;
}

async function measureSeed(seed: number, cls: string, preset: string): Promise<SeedResult> {
  const { browser, info } = await launchWebGPUReal();
  const page: Page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  const url = `${LAAS_ORIGIN}/?scene=world&seed=${seed}&preset=${preset}&hud=0&freeze=1&T=14`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) {
    await browser.close();
    throw new Error(`seed ${seed}: app error:\n${err}`);
  }
  console.log(`[roadshape] seed=${seed} ready (adapter ${info.vendor}/${info.architecture})`);

  // String evaluate: tsx/esbuild injects __name into named fns in callbacks.
  const SAMPLER = `(() => {
    const hooks = window.__laas;
    const probe = hooks.groundProbe;
    const roads = hooks.roads;
    if (!probe) return JSON.stringify({ err: 'no groundProbe' });
    if (!roads || !roads.routes) return JSON.stringify({ err: 'no roads.routes' });

    // road-class surface ids (SurfaceMatrix.ts): Asphalt 10, GravelFine 11,
    // GravelCoarse 12, DirtRoad 13, Singletrack 14 — GravelRiver(5) is NOT a
    // road, it is the riverbed class the carve must not dissolve into.
    var ROAD_IDS = { 10: 1, 11: 1, 12: 1, 13: 1, 14: 1 };
    var CLS = ${JSON.stringify(cls)};
    // RoadRoute.cls is a RoadClassSpec OBJECT (RoadNetwork.ts:116-120), not a
    // string. Guessing through r.cls || r.klass || r.type picked the object,
    // String()'d it to [object Object], matched nothing, and reported "no
    // routes of class asphalt" on a map full of asphalt. Read the declared
    // field instead of guessing at field names. (No backticks in this comment:
    // the whole function is a template literal, and one would close it.)
    var routes = roads.routes.filter(function (r) {
      return !!(r.cls && r.cls.name === CLS);
    });
    if (!routes.length) {
      return JSON.stringify({ err: 'no routes of class ' + CLS, seen: Array.from(new Set(
        roads.routes.map(function (r) { return r.cls ? r.cls.name : '(no cls)'; }))) });
    }
    var pick = routes.slice().sort(function (a, b) { return (b.pts ? b.pts.length : 0) - (a.pts ? a.pts.length : 0); })[0];
    var pts = pick.pts || [];
    // Same trap as the class lookup above, and this file fell into it twice:
    // halfWidth is declared on RoadClassSpec (RoadNetwork.ts:38), reached as
    // route.cls.halfWidth. Probing for a field by trying names until one is
    // truthy reads whatever exists and calls it an answer; read the type.
    var halfW = pick.cls && pick.cls.halfWidth;
    if (!halfW) {
      return JSON.stringify({ err: 'no halfWidth on route ' + (pick.name || '(unnamed)'),
        clsKeys: pick.cls ? Object.keys(pick.cls) : null });
    }

    var out = [];
    var STEP = Math.max(1, Math.floor(pts.length / 80));
    for (var i = 1; i < pts.length - 1; i += STEP) {
      var p = pts[i], a = pts[i - 1], b = pts[i + 1];
      var px = p.x != null ? p.x : p[0], pz = p.z != null ? p.z : p[1];
      var ax = a.x != null ? a.x : a[0], az = a.z != null ? a.z : a[1];
      var bx = b.x != null ? b.x : b[0], bz = b.z != null ? b.z : b[1];
      var dx = bx - ax, dz = bz - az;
      var L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      var nx = -dz, nz = dx;

      // cut far enough out to catch a blob: ±6x the declared half-width
      var span = halfW * 6, ds = 0.2;
      var cut = [];
      for (var s = -span; s <= span; s += ds) {
        var g = probe(px + nx * s, pz + nz * s);
        cut.push({ s: s, h: g.ground, w: g.water, sid: g.surfaceId });
      }
      // measured width = the CONTIGUOUS road-class run through s=0
      var mid = Math.round(span / ds);
      var lo = mid, hi = mid;
      if (!ROAD_IDS[cut[mid].sid]) { lo = mid; hi = mid; }
      else {
        while (lo > 0 && ROAD_IDS[cut[lo - 1].sid]) lo--;
        while (hi < cut.length - 1 && ROAD_IDS[cut[hi + 1].sid]) hi++;
      }
      var measuredW = (hi - lo) * ds;

      var tread = cut.filter(function (c) { return Math.abs(c.s) <= halfW; });
      var th = tread.map(function (c) { return c.h; });
      var pp = th.length ? (Math.max.apply(null, th) - Math.min.apply(null, th)) : 0;
      var at = function (s) { var best = cut[0], bd = 1e9;
        for (var j = 0; j < cut.length; j++) { var d = Math.abs(cut[j].s - s); if (d < bd) { bd = d; best = cut[j]; } }
        return best; };
      var edge = Math.max(Math.abs(at(-halfW).h - at(-halfW - 1).h), Math.abs(at(halfW).h - at(halfW + 1).h));
      var cross = ((at(halfW).h - at(-halfW).h) / (2 * halfW)) * 100;
      var wet = tread.filter(function (c) { return c.w > c.h; }).length;

      out.push({ x: +px.toFixed(1), z: +pz.toFixed(1), measuredW: +measuredW.toFixed(2),
        treadFlatnessMm: +(pp * 1000).toFixed(0), edgeStepM: +edge.toFixed(3),
        crossSlopePct: +cross.toFixed(1), wetTread: wet });
    }
    return JSON.stringify({ halfWidth: halfW, stations: out });
  })()`;

  const raw = (await page.evaluate(SAMPLER)) as string;
  await browser.close();
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (d['err']) throw new Error(`seed ${seed}: ${String(d['err'])} ${JSON.stringify(d['seen'] ?? '')}`);

  const halfW = d['halfWidth'] as number;
  const declaredW = halfW * 2;
  const stations: Station[] = (d['stations'] as Record<string, number>[]).map((s) => {
    const ratio = (s['measuredW'] as number) / declaredW;
    const kind: Station['kind'] =
      ratio >= BUBBLE_X ? 'bubble' : ratio <= THIN_X ? 'thinning' : 'ok';
    return {
      x: s['x'] as number,
      z: s['z'] as number,
      measuredW: s['measuredW'] as number,
      ratio: +ratio.toFixed(2),
      kind,
      treadFlatnessMm: s['treadFlatnessMm'] as number,
      edgeStepM: s['edgeStepM'] as number,
      crossSlopePct: s['crossSlopePct'] as number,
      wetTread: s['wetTread'] as number,
    };
  });
  const bubbles = stations.filter((s) => s.kind === 'bubble').length;
  const thins = stations.filter((s) => s.kind === 'thinning').length;
  return {
    seed,
    declaredW,
    stations,
    bubbles,
    thins,
    anomalyPct: stations.length ? ((bubbles + thins) / stations.length) * 100 : 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seeds = (str(args['seeds']) ?? '1,2,3').split(',').map((s) => Number(s.trim()));
  const cls = str(args['cls']) ?? 'asphalt';
  const preset = str(args['preset']) ?? 'high';
  const outPath = str(args['out']) ?? `shots/wip/roadshape-${cls}.json`;

  const results: SeedResult[] = [];
  for (const seed of seeds) results.push(await measureSeed(seed, cls, preset));

  console.log(`\n╔═══ ROAD SHAPE «${cls}» — GATE ═══`);
  console.log(`║ declared roadbed width: ${results[0]?.declaredW.toFixed(1)} m`);
  console.log(`║ bubble: width ≥ ${BUBBLE_X}× declared | thinning: ≤ ${THIN_X}×`);
  console.log(`║ budget: ≤ ${MAX_ANOMALY_PCT}% stations per seed\n`);
  let failed = 0;
  for (const r of results) {
    const ok = r.anomalyPct <= MAX_ANOMALY_PCT;
    if (!ok) failed++;
    console.log(
      `  seed ${r.seed}: stations ${r.stations.length} | BUBBLES ${r.bubbles} | THINNING ${r.thins} | anomalies ${r.anomalyPct.toFixed(1)}% ${ok ? '✓' : '✗ FAIL'}`,
    );
    const worst = r.stations
      .filter((s) => s.kind !== 'ok')
      .sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1))
      .slice(0, 4);
    for (const w of worst) {
      console.log(
        `      ${w.kind.padEnd(11)} x=${w.x} z=${w.z}  width ${w.measuredW} m (${w.ratio}× declared)  flatness ${w.treadFlatnessMm}mm  edge step ${w.edgeStepM}m  water ${w.wetTread}`,
      );
    }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ cls, BUBBLE_X, THIN_X, MAX_ANOMALY_PCT, results }, null, 2),
  );
  console.log(`\n[roadshape] wrote ${outPath}`);
  if (failed > 0) {
    console.error(`[roadshape] GATE FAILED on ${failed}/${results.length} seeds`);
    process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error('[roadshape] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
