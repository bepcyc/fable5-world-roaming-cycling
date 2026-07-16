/**
 * Perf gate — CI-style pass/fail on the two shipping presets.
 *
 * Runs the perf-mobile harness (fixed spot, vsync-free, machine gate, GPU
 * clock recorded) once per preset config and asserts clock-normalized GPU
 * work stays inside its budget. Designed NOT to flap:
 *  - metric is gpuWorkUnits = gpuTotalMs x mean sclk MHz (clock lottery
 *    immune; see docs/PERF_QUALITY_AXES.md);
 *  - thresholds carry >= 3x the measured session noise (~8-10%);
 *  - a run with meterValid=false or machine.contended=true is a HARD ERROR
 *    (invalid measurement), not a fail — rerun on a quiet box.
 *
 * Budgets (set 2026-07-16 from the clean mutex-era battery; update them
 * WITH a measurement, never by hand-waving):
 *  - min: W <= MIN_MAX_W. The min preset must stay lean; a regression that
 *    sneaks heavy work back into min trips this first.
 *  - ultra: W >= ULTRA_MIN_W. Ultra must stay RICHER than high — the
 *    failure mode is someone gutting ultra until it silently equals min.
 *
 * Usage: LAAS_PORT=5182 npx tsx tools/gate-perf.ts [--skip-ultra]
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Budgets in gpuWorkUnits (ms x MHz), set from the 2026-07-16 measured
// values (docs/PERF_QUALITY_AXES.md): assembled min = 1148/1238/1533 at the
// mobile profile; ultra @1080p = 14921 (high = 6544). Headroom >= 30%.
const MIN_MAX_W = 2000; // min ceiling — a regression that fattens min trips here
const ULTRA_MIN_W = 9000; // ultra floor — gutting ultra toward high trips here

// Per-preset spot y: each preset generates its own terrain (heightRes), so
// the ground at the campaign xz differs; the harness drift gate demands the
// exact eye height. Measured 2026-07-16.
const ULTRA_CAM = '-870,187.015,862,1.69,0.1';

interface Row {
  label: string;
  gpuWorkUnits: number | null;
  gpuTotalMs: number;
  meterValid: boolean;
  machine: { contended: boolean };
  drawCalls: number;
}

function run(label: string, extraArgs: string): Row {
  const cmd =
    `npx tsx tools/perf-mobile.ts --wait-idle 3600 --label ${label} ${extraArgs} ` +
    `--out shots/wip/gate-${label}.json --shot shots/wip/gate-${label}.png`;
  console.log(`[gate-perf] ${cmd}`);
  execSync(cmd, { stdio: 'inherit', timeout: 20 * 60_000 });
  return JSON.parse(readFileSync(`shots/wip/gate-${label}.json`, 'utf8')) as Row;
}

function main(): void {
  const skipUltra = process.argv.includes('--skip-ultra');
  let failed = false;

  const min = run('gate-min', '--preset min');
  if (!min.meterValid || min.machine.contended) {
    throw new Error('gate-min measurement invalid (vsync-capped or contended box) — rerun');
  }
  const minW = min.gpuWorkUnits ?? NaN;
  const minOk = Number.isFinite(minW) && minW <= MIN_MAX_W;
  console.log(
    `[gate-perf] min: W=${minW} (<= ${MIN_MAX_W}) gpu=${min.gpuTotalMs.toFixed(3)}ms ` +
      `draws=${min.drawCalls} -> ${minOk ? 'PASS' : 'FAIL'}`,
  );
  if (!minOk) failed = true;

  if (!skipUltra) {
    const ultra = run('gate-ultra', `--preset ultra --w 1920 --h 1080 --dpr 1 --cam ${ULTRA_CAM}`);
    if (!ultra.meterValid || ultra.machine.contended) {
      throw new Error('gate-ultra measurement invalid — rerun');
    }
    const uW = ultra.gpuWorkUnits ?? NaN;
    const ultraOk = Number.isFinite(uW) && uW >= ULTRA_MIN_W;
    console.log(
      `[gate-perf] ultra: W=${uW} (>= ${ULTRA_MIN_W}) gpu=${ultra.gpuTotalMs.toFixed(3)}ms ` +
        `draws=${ultra.drawCalls} -> ${ultraOk ? 'PASS' : 'FAIL'}`,
    );
    if (!ultraOk) failed = true;
  }

  if (failed) {
    console.error('[gate-perf] FAIL');
    process.exit(1);
  }
  console.log('[gate-perf] all budgets hold');
}

main();
