/**
 * THE RESIDUAL, NAMED — Adreno GPU clock + busy sampler (Galaxy Tab S8 Ultra).
 *
 * WHY THIS EXISTS: the CDP profile (tools/profile-tablet.ts, 254 frames) showed
 * the main thread is (idle) 102 ms of a 167 ms frame — 61%. JS is only 52 ms and
 * three's GPU timestamps only 23.7 ms, so NEITHER explains the frame. That gap is
 * the `unexplainedMs` that perf-tablet has been reporting (97.8 / 176.1) all
 * along. Guessing at it is exactly the failure mode this campaign keeps hitting,
 * so this reads the answer straight out of the kernel instead.
 *
 * WHAT IT READS (KGSL = Qualcomm's GPU driver; all world-readable, NO root):
 *   /sys/class/kgsl/kgsl-3d0/devfreq/cur_freq   current GPU clock, Hz
 *   /sys/class/kgsl/kgsl-3d0/gpubusy            "busy total" since the LAST read
 *   /sys/class/kgsl/kgsl-3d0/devfreq/governor   msm-adreno-tz (the DVFS governor)
 *
 * gpubusy IS DESTRUCTIVE-READ: the counters reset each time you cat it, so the
 * ratio is "since my previous sample", not since boot. Sample on a fixed cadence
 * and the ratio is the GPU duty cycle over that interval. Never read it twice and
 * subtract — the second read is already a fresh window.
 *
 * THE TWO QUESTIONS IT ANSWERS, which no in-page counter can:
 *   1. Is the GPU actually saturated? (busy% -> if ~100%, the idle main thread is
 *      waiting on a genuinely swamped GPU, and the app IS GPU-bound even though
 *      three's timed passes sum to far less than the frame.)
 *   2. Does the clock MOVE between conditions? An ablation that removes GPU work
 *      but reads a HIGHER GPU ms is physically impossible at a fixed clock — the
 *      governor must have downclocked. That is measurable here, not inferable.
 *
 * Usage (run it AGAINST an already-running measurement, or standalone):
 *   npx tsx tools/gpu-clock-tablet.ts --seconds 12 --label base
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ADB = join(process.env['ANDROID_HOME'] ?? join(homedir(), 'Android/Sdk'), 'platform-tools/adb');
const KGSL = '/sys/class/kgsl/kgsl-3d0';

function adbShell(cmd: string, timeout = 15_000): string {
  return String(execFileSync(ADB, ['shell', cmd], { encoding: 'utf8', timeout })).trim();
}

export interface ClockSample {
  tMs: number;
  freqHz: number;
  busy: number;
  total: number;
  busyPct: number;
}

/** One shell round-trip for both files: two round-trips would straddle different
 *  gpubusy windows and mis-pair the clock with the duty cycle. */
export function sampleOnce(t0: number): ClockSample | null {
  const out = adbShell(`cat ${KGSL}/devfreq/cur_freq ${KGSL}/gpubusy`);
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const freqHz = Number(lines[0]);
  const parts = (lines[1] ?? '').split(/\s+/).map(Number);
  const busy = parts[0] ?? 0;
  const total = parts[1] ?? 0;
  if (!isFinite(freqHz) || total <= 0) return null;
  return { tMs: Date.now() - t0, freqHz, busy, total, busyPct: (busy / total) * 100 };
}

function stats(xs: number[]): { mean: number; med: number; min: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  return {
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    med: s[Math.floor(s.length / 2)] ?? 0,
    min: s[0] ?? 0,
    max: s[s.length - 1] ?? 0,
  };
}

type Args = Record<string, string | boolean>;
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else { out[a.slice(2)] = true; }
  }
  return out;
}
const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const label = str(args['label']) ?? 'clock';
  const seconds = Number(str(args['seconds']) ?? 12);
  const outPath = str(args['out']) ?? `shots/wip/gpuclock-${label}.json`;

  const gov = adbShell(`cat ${KGSL}/devfreq/governor`);
  const avail = adbShell(`cat ${KGSL}/devfreq/available_frequencies`).split(/\s+/).map(Number).filter(Boolean);
  const maxHz = Math.max(...avail);
  console.log(`[gpu-clock] governor=${gov} | ${avail.length} steps, max ${(maxHz / 1e6).toFixed(0)} MHz`);

  const t0 = Date.now();
  sampleOnce(t0); // prime: the FIRST gpubusy read covers an unknown window
  const rows: ClockSample[] = [];
  // THE CADENCE IS NOT COSMETIC. gpubusy zeroes its counters on every read, so a
  // tight loop measures a ~0-length window and returns "0 0" — which is how the
  // first version of this tool collected n=0 samples. The gap between reads IS
  // the measurement window; keep it long enough to cover several frames at 4-7 fps.
  const periodMs = Number(str(args['period']) ?? 250);
  while ((Date.now() - t0) / 1000 < seconds) {
    await new Promise((r) => setTimeout(r, periodMs));
    const s = sampleOnce(t0);
    if (s) rows.push(s);
  }
  if (rows.length === 0) throw new Error('no valid GPU clock samples — is KGSL readable? (cat /sys/class/kgsl/kgsl-3d0/gpubusy)');

  const f = stats(rows.map((r) => r.freqHz / 1e6));
  const b = stats(rows.map((r) => r.busyPct));
  console.log(
    `[RESULT ${label}] n=${rows.length} | clock mean ${f.mean.toFixed(0)} MHz (med ${f.med.toFixed(0)}, ` +
      `${f.min.toFixed(0)}..${f.max.toFixed(0)}) = ${((f.mean / (maxHz / 1e6)) * 100).toFixed(0)}% of max ${(maxHz / 1e6).toFixed(0)}`,
  );
  console.log(
    `[RESULT ${label}] GPU busy mean ${b.mean.toFixed(1)}% (med ${b.med.toFixed(1)}, ${b.min.toFixed(1)}..${b.max.toFixed(1)})`,
  );
  const verdict =
    b.mean > 95
      ? 'GPU IS SATURATED — an idle main thread here is waiting on a genuinely swamped GPU.'
      : b.mean > 70
        ? 'GPU heavily loaded but NOT pinned — some of the frame is not GPU execution.'
        : 'GPU is NOT the wall in this window — the frame is going somewhere else.';
  console.log(`[VERDICT ${label}] ${verdict}`);

  const row = {
    label,
    when: new Date().toISOString(),
    governor: gov,
    availableMHz: avail.map((x) => x / 1e6),
    maxMHz: maxHz / 1e6,
    samples: rows.length,
    clockMHz: f,
    busyPct: b,
    clockPctOfMax: (f.mean / (maxHz / 1e6)) * 100,
    verdict,
    raw: rows,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(row, null, 2));
  console.log(`[gpu-clock] wrote ${outPath}`);
}

main().catch((e: unknown) => {
  console.error('[gpu-clock] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
