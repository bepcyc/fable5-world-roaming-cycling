/**
 * CPU PROFILER — THE REAL TABLET (Galaxy Tab S8 Ultra / SM-X900, Adreno 730).
 *
 * docs/log/GPU_CPU_ISSUE_CODEX.md §5 P0.2: "If direct TSL-node boundaries are
 * inconvenient, use a CDP CPU profile over 200-300 frames of a real tablet and
 * look for Bindings._update, UniformsGroup.update, NodeManager.updateForRender,
 * _projectObject, WebGPUBackend._draw, GPUQueue.submit/Dawn wire calls."
 *
 * That is exactly what this does. tools/perf-tablet.ts answers HOW MUCH
 * (cpu.submit = 31.8 ms); this answers WHAT IS IN IT, by name, with self time.
 *
 * WHY A REAL PROFILE AND NOT MORE COUNTERS:
 *   cpu.submit is one bracket around three's whole render+encode path
 *   (Engine.ts:205-236). Adding synchronous sub-counters can only split it at
 *   boundaries WE own; the cost lives inside three (bindings, uniform groups,
 *   node updates, draw encoding), which our brackets cannot see. A sampling
 *   profiler attributes by FUNCTION, straight through the library.
 *
 * WHAT IT MEASURES: the page's main JS thread in the renderer process — the
 * thread that runs rAF, three's traversal/encode, and the Dawn wire calls that
 * `GPUQueue.submit()` turns into. It does NOT see the GPU process or the driver.
 *
 * THE OBSERVER WARNING (measured, 236e3ea): this project ALREADY proved a large
 * observer effect on this device — ?notimestamp=1 made the app 34.5% SLOWER, not
 * faster. A sampling profiler is another observer. Its ABSOLUTE ms are therefore
 * NOT production numbers; the RANKING of functions by self time is what this tool
 * is for. Do not quote profiled frameMs as the device's frameMs.
 *
 * Usage:
 *   npx tsx tools/profile-tablet.ts --label baseline --frames 250
 *   npx tsx tools/profile-tablet.ts --label no-shadows --url-extra "ablate=shadows"
 *
 * Writes shots/wip/profile-tablet-<label>.json  (top self-time frames + the raw
 * aggregate) and .cpuprofile (loadable in Chrome DevTools -> Performance).
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SPOT_CAM = '-870,182.7,862,1.69,0.1';
const ORIGIN = process.env['LAAS_TABLET_ORIGIN'] ?? 'http://127.0.0.1:5176';
const BASE_PARAMS = [
  'scene=world',
  'seed=1',
  'preset=min',
  'dpr=0.6',
  'T=14',
  'freeze=0',
  'nosplash=1',
  `cam=${SPOT_CAM}`,
];

const ADB = join(process.env['ANDROID_HOME'] ?? join(homedir(), 'Android/Sdk'), 'platform-tools/adb');
const CDP_PORT = 9223;
const DEV_PORT = 5176;

function adb(args: string[], timeout = 30_000): string {
  return String(execFileSync(ADB, args, { encoding: 'utf8', timeout })).trim();
}
function adbShell(cmd: string, timeout = 30_000): string {
  return adb(['shell', cmd], timeout);
}

function ensureDevice(): void {
  const devices = adb(['devices']);
  const online = devices.split('\n').slice(1).filter((l) => /\tdevice$/.test(l.trim()));
  if (online.length === 0) {
    throw new Error(`no adb device online:\n${devices}\nif adb hung: adb kill-server && adb start-server`);
  }
  adbShell('input keyevent KEYCODE_WAKEUP');
  adb(['reverse', `tcp:${DEV_PORT}`, `tcp:${DEV_PORT}`]);
  adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote']);
}

function readDevice(): { model: string; batteryPct: number; tempC: number; focus: string; chromeForeground: boolean } {
  const model = adbShell('getprop ro.product.model');
  const batt = adbShell('dumpsys battery');
  const level = Number(/level:\s*(\d+)/.exec(batt)?.[1] ?? -1);
  const temp = Number(/temperature:\s*(\d+)/.exec(batt)?.[1] ?? -1) / 10;
  let focus = '';
  try {
    focus = adbShell('dumpsys window | grep -E "mCurrentFocus" | head -1').replace(/\s+/g, ' ').trim();
  } catch {
    /* gate, not a requirement */
  }
  return { model, batteryPct: level, tempC: temp, focus, chromeForeground: /chrome/i.test(focus) };
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function cdpTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(10_000) });
  return (await res.json()) as CdpTarget[];
}

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (m: MessageEvent): void => {
      const d = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (d.id === undefined) return;
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error.message));
      else p.resolve(d.result);
    };
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('CDP ws connect timeout')), 20_000);
      ws.onopen = (): void => { clearTimeout(to); resolve(); };
      ws.onerror = (): void => { clearTimeout(to); reject(new Error(`CDP ws failed: ${wsUrl}`)); };
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string, timeoutMs = 30_000, awaitPromise = false): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)) as {
      result?: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) {
      throw new Error(`in-page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value as T;
  }

  close(): void { this.ws.close(); }
}

/* ---- the V8 sampling profile -------------------------------------------- */

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** Self time per node, summed from the sample stream — timeDeltas[i] is the gap
 *  BEFORE samples[i], so charge each delta to the sample it precedes. This is the
 *  same accounting DevTools does; hitCount alone would assume a uniform interval,
 *  which is not true on a thermally-throttled device. */
function selfTimeByNode(p: CpuProfile): Map<number, number> {
  const self = new Map<number, number>();
  for (let i = 0; i < p.samples.length; i++) {
    const id = p.samples[i] as number;
    const dt = (p.timeDeltas[i] ?? 0) / 1000; // us -> ms
    self.set(id, (self.get(id) ?? 0) + dt);
  }
  return self;
}

/** Aggregate self time by function identity (name + url:line), because three
 *  inlines the same function into many call paths and per-node rows would
 *  scatter one real cost across dozens of tree positions. */
function aggregate(p: CpuProfile, frames: number): { fn: string; url: string; selfMs: number; selfMsPerFrame: number; pct: number }[] {
  const self = selfTimeByNode(p);
  const byNode = new Map(p.nodes.map((n) => [n.id, n]));
  const acc = new Map<string, { fn: string; url: string; selfMs: number }>();
  let total = 0;
  for (const [id, ms] of self) {
    const n = byNode.get(id);
    if (!n) continue;
    const cf = n.callFrame;
    const name = cf.functionName || '(anonymous)';
    const url = cf.url ? `${cf.url.split('/').slice(-1)[0]}:${cf.lineNumber + 1}` : '';
    const key = `${name}@${url}`;
    const cur = acc.get(key) ?? { fn: name, url, selfMs: 0 };
    cur.selfMs += ms;
    acc.set(key, cur);
    total += ms;
  }
  return [...acc.values()]
    .map((r) => ({ ...r, selfMsPerFrame: r.selfMs / Math.max(1, frames), pct: total > 0 ? (r.selfMs / total) * 100 : 0 }))
    .sort((a, b) => b.selfMs - a.selfMs);
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

function srcFingerprint(): string {
  try {
    const h = execSync(`find src -name '*.ts' -type f -exec sha256sum {} + | sort -k2 | sha256sum`, { encoding: 'utf8', timeout: 30_000 });
    return String(h).trim().split(/\s+/)[0]?.slice(0, 12) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const label = str(args['label']) ?? 'tablet';
  const urlExtra = str(args['url-extra']) ?? '';
  const wantFrames = Number(str(args['frames']) ?? 250);
  const warmupMs = Number(str(args['warmup']) ?? 10_000);
  const intervalUs = Number(str(args['interval']) ?? 250);
  const outPath = str(args['out']) ?? `shots/wip/profile-tablet-${label}.json`;
  const profPath = str(args['profile-out']) ?? `shots/wip/profile-tablet-${label}.cpuprofile`;
  const readyTimeoutMs = Number(str(args['ready-timeout']) ?? 300_000);

  const params = [...BASE_PARAMS];
  if (urlExtra) params.push(...urlExtra.split('&').filter(Boolean));
  const url = `${ORIGIN}/?${params.join('&')}`;

  console.log(`[profile-tablet] url ${url}`);
  ensureDevice();
  const code = adbShell(`curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://127.0.0.1:${DEV_PORT}/`, 20_000);
  if (!code.includes('200')) throw new Error(`device cannot reach the dev server (http ${code}) — is vite up on ${DEV_PORT}?`);

  const before = readDevice();
  console.log(`[profile-tablet] device ${before.model} — battery ${before.batteryPct}%, ${before.tempC.toFixed(1)}C`);

  adbShell(`am start -a android.intent.action.VIEW -n com.android.chrome/com.google.android.apps.chrome.Main -d '${url}'`, 30_000);
  await new Promise((r) => setTimeout(r, 4000));

  let target: CdpTarget | undefined;
  const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    const ts = await cdpTargets();
    target = ts.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).find((t) => t.url.includes(`:${DEV_PORT}/`));
    if (target) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`no CDP page target on :${DEV_PORT}`);

  // Trap 5 (benchmark-fps SKILL): a second live sim tab = a second WebGPU world
  // on the same GPU = the run is void. Close our duplicates.
  for (const t of await cdpTargets()) {
    if (t.type === 'page' && t.id !== target.id && t.url.includes(`:${DEV_PORT}/`)) {
      await fetch(`http://localhost:${CDP_PORT}/json/close/${t.id}`).catch(() => undefined);
      console.log(`[profile-tablet] closed duplicate tab ${t.id}`);
    }
  }

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const t0 = Date.now();
  await cdp.send('Page.reload', { ignoreCache: true });
  console.log('[profile-tablet] Page.reload(ignoreCache) issued — waiting for __laas.ready…');
  let ready = false;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const st = await cdp.evaluate<string>(
        `(() => { const l = window.__laas; if (!l) return 'no-laas'; if (l.error) return 'ERR:' + l.error; return l.ready ? 'READY' : 'booting'; })()`,
        15_000,
      );
      if (st === 'READY') { ready = true; break; }
      if (st?.startsWith('ERR:')) throw new Error(`app fatal: ${st.slice(4)}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('app fatal')) throw e;
    }
  }
  if (!ready) throw new Error(`__laas.ready never became true within ${readyTimeoutMs / 1000}s`);
  console.log(`[profile-tablet] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const fp = srcFingerprint();
  const canvas = await cdp.evaluate<{ w: number; h: number } | null>(
    `(() => { const c = document.querySelector('canvas'); return c ? { w: c.width, h: c.height } : null; })()`,
  );
  console.log(`[profile-tablet] canvas ${canvas?.w}x${canvas?.h} | srcFingerprint ${fp}`);

  const focusNow = readDevice();
  if (!focusNow.chromeForeground) {
    throw new Error(`Chrome is NOT foregrounded (${focusNow.focus}) — rAF is throttled in the background; the profile would be fiction.`);
  }

  console.log(`[profile-tablet] warmup ${warmupMs} ms…`);
  await new Promise((r) => setTimeout(r, warmupMs));

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs });

  const frameBefore = await cdp.evaluate<number>(`window.__laas.stats.frame`);
  await cdp.send('Profiler.start');
  console.log(`[profile-tablet] profiling ${wantFrames} frames at ${intervalUs} us sampling…`);

  // Wait on the app's OWN frame counter, not on wall time: the whole point is
  // "200-300 frames", and at 4-7 fps that is 30-70 s which no fixed sleep can
  // hit across ablations that change the frame rate.
  const frameDeadline = Date.now() + 240_000;
  let frameNow = frameBefore;
  while (Date.now() < frameDeadline) {
    await new Promise((r) => setTimeout(r, 1000));
    frameNow = await cdp.evaluate<number>(`window.__laas.stats.frame`);
    if (frameNow - frameBefore >= wantFrames) break;
  }
  const framesProfiled = frameNow - frameBefore;

  const stopped = (await cdp.send('Profiler.stop', {}, 120_000)) as { profile: CpuProfile };
  const p = stopped.profile;
  const wallMs = (p.endTime - p.startTime) / 1000;
  console.log(`[profile-tablet] stopped: ${framesProfiled} frames in ${wallMs.toFixed(0)} ms (${p.samples.length} samples, ${p.nodes.length} nodes)`);
  console.log(`[profile-tablet] profiled frameMs ${(wallMs / Math.max(1, framesProfiled)).toFixed(1)} — NOT a production number (the profiler is an observer)`);

  const rows = aggregate(p, framesProfiled);
  const after = readDevice();

  console.log(`\n[TOP SELF TIME ${label}] (per frame, ${framesProfiled} frames)`);
  console.log(`  ${'function'.padEnd(38)} ${'file:line'.padEnd(26)} ${'ms/frame'.padStart(9)} ${'%'.padStart(6)}`);
  for (const r of rows.slice(0, 30)) {
    console.log(`  ${r.fn.slice(0, 37).padEnd(38)} ${r.url.slice(0, 25).padEnd(26)} ${r.selfMsPerFrame.toFixed(3).padStart(9)} ${r.pct.toFixed(1).padStart(6)}`);
  }

  // The named suspects from docs/log/STATUS.md:538-559 (the OLD desktop profile). Printing
  // them explicitly makes "the tablet has a different shape" a measured statement
  // instead of an impression.
  const suspects = ['_update', 'update', 'updateForRender', 'updateMatrixWorld', '_projectObject', '_renderObjectDirect', 'getMaterialCacheKey', 'cyrb53', '_draw', 'submit', 'draw', 'finishRender', 'finishCompute', 'setup', 'analyze', 'build'];
  const suspectRows = rows.filter((r) => suspects.some((s) => r.fn === s || r.fn.endsWith(`.${s}`)));
  console.log(`\n[docs/log/STATUS.md SUSPECTS ${label}] (desktop profile named these: Bindings._update 2.64, UniformsGroup.update 1.1, updateForRender 1.6, updateMatrixWorld 0.67, _projectObject 0.51 ms/frame)`);
  for (const r of suspectRows.slice(0, 20)) {
    console.log(`  ${r.fn.slice(0, 37).padEnd(38)} ${r.url.slice(0, 25).padEnd(26)} ${r.selfMsPerFrame.toFixed(3).padStart(9)} ${r.pct.toFixed(1).padStart(6)}`);
  }

  cdp.close();

  mkdirSync(dirname(profPath), { recursive: true });
  writeFileSync(profPath, JSON.stringify(p));
  console.log(`\n[profile-tablet] raw profile -> ${profPath}  (open in DevTools -> Performance -> Load)`);

  const row = {
    label,
    when: new Date().toISOString(),
    device: { model: before.model },
    thermal: { tempBeforeC: before.tempC, tempAfterC: after.tempC, batteryBeforePct: before.batteryPct, batteryAfterPct: after.batteryPct },
    url,
    urlExtra,
    srcFingerprint: fp,
    canvas,
    samplingIntervalUs: intervalUs,
    framesProfiled,
    wallMs,
    profiledFrameMs: wallMs / Math.max(1, framesProfiled),
    samples: p.samples.length,
    nodes: p.nodes.length,
    topSelf: rows.slice(0, 60),
    suspects: suspectRows.slice(0, 30),
    profilePath: profPath,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(row, null, 2));
  console.log(`[profile-tablet] wrote ${outPath}`);
}

main().catch((e: unknown) => {
  console.error('[profile-tablet] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
