/**
 * CPU thread budget (owner directive 2026-07-03): boot-time CPU work uses
 * every core the system has, and the count is user-configurable.
 *
 * Resolution order: `?threads=N` URL param → localStorage 'laas.threads'
 * (set from the HUD menu, F4 cycles auto→1→2→4→…→max) → auto
 * (`navigator.hardwareConcurrency`). 0 means "auto".
 *
 * Consumers: RoadNetwork router-grid preparation (M1.2); future CPU-heavy
 * boot/runtime stages (GPX corridor bake M2.1, physics workers) take the
 * same budget from here — one knob, one truth.
 */

export const THREADS_LS_KEY = 'laas.threads';

/** hardware core count (≥1, safe in workers/headless) */
export function hardwareThreads(): number {
  return Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 4);
}

/** resolve the effective thread count from param/localStorage/hardware */
export function resolveThreads(param: number): number {
  if (param > 0) return Math.min(param, 64);
  try {
    const ls = Number(globalThis.localStorage?.getItem(THREADS_LS_KEY) ?? 0);
    if (ls > 0) return Math.min(ls, 64);
  } catch {
    /* storage unavailable (headless probes) — fall through to auto */
  }
  return hardwareThreads();
}

/** store the user's choice (0 = auto); applied on next world generation */
export function storeThreads(n: number): void {
  try {
    if (n <= 0) globalThis.localStorage?.removeItem(THREADS_LS_KEY);
    else globalThis.localStorage?.setItem(THREADS_LS_KEY, String(n));
  } catch {
    /* ignore */
  }
}

/**
 * Run `jobs` payloads through a transient pool of module workers, `threads`
 * wide. Each payload is posted with its transfer list; results come back in
 * job order. Falls back to `local` when workers are unavailable or the pool
 * is size 1 (determinism is unaffected — jobs are pure functions).
 */
export async function runWorkerJobs<J, R>(
  makeWorker: () => Worker,
  jobs: { payload: J; transfer: Transferable[] }[],
  threads: number,
  local: (payload: J) => R,
): Promise<R[]> {
  const n = Math.min(threads, jobs.length);
  if (n <= 1 || typeof Worker === 'undefined') {
    return jobs.map((j) => local(j.payload));
  }
  const results = new Array<R>(jobs.length);
  let next = 0;
  const workers = Array.from({ length: n }, () => makeWorker());
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const feed = (): void => {
              if (next >= jobs.length) {
                resolve();
                return;
              }
              const idx = next++;
              const job = jobs[idx] as { payload: J; transfer: Transferable[] };
              w.onmessage = (ev: MessageEvent<R>): void => {
                results[idx] = ev.data;
                feed();
              };
              w.onerror = (e): void => {
                reject(new Error(`worker job ${idx} failed: ${e.message}`));
              };
              w.postMessage(job.payload, job.transfer);
            };
            feed();
          }),
      ),
    );
  } finally {
    for (const w of workers) w.terminate();
  }
  return results;
}
