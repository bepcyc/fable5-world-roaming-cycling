/**
 * Reverse debug channel: in ?debug=1 the sim POSTs boot info / each step /
 * the device-loss crash to a desktop telemetry sink (tools/debug-telemetry-
 * server.ts) at the SAME host as the page, port 5199. Lets the developer watch
 * an on-device (phone) run live and — the point — actually receive the crash,
 * which is sent with navigator.sendBeacon so it survives the page dying.
 *
 * No-op unless enabled, so shipping with it wired in costs nothing.
 */

const PORT = 5199;

class Telemetry {
  private url: string | null;
  private t0 = performance.now();
  private steps: { t: number; pct: number; msg: string }[] = [];

  constructor(enabled: boolean) {
    // POST to the same host that served the page (phone → the desktop dev box)
    this.url = enabled ? `${location.protocol}//${location.hostname}:${PORT}/t` : null;
  }

  private post(obj: Record<string, unknown>, beacon = false): void {
    if (!this.url) return;
    const body = JSON.stringify({ ts: Math.round(performance.now() - this.t0), ...obj });
    try {
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(this.url, new Blob([body], { type: 'application/json' }));
      } else {
        void fetch(this.url, {
          method: 'POST',
          body,
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {
          /* offline / no sink — ignore */
        });
      }
    } catch {
      /* ignore */
    }
  }

  /** first thing: everything known BEFORE the heavy boot (owner's ask) */
  begin(info: Record<string, unknown>): void {
    this.post({
      ev: 'begin',
      ua: navigator.userAgent,
      screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      ...info,
    });
  }

  step(pct: number, msg: string): void {
    const t = Math.round(performance.now() - this.t0);
    this.steps.push({ t, pct, msg });
    this.post({ ev: 'step', t, pct: Math.round(pct * 100), msg });
  }

  /** device-loss / fatal — sendBeacon so it lands even as the page dies */
  crash(reason: string): void {
    this.post({ ev: 'CRASH', reason, lastSteps: this.steps.slice(-8) }, true);
  }

  ready(): void {
    this.post({ ev: 'READY', totalMs: Math.round(performance.now() - this.t0), steps: this.steps.length });
  }
}

let inst: Telemetry | null = null;
export function initTelemetry(enabled: boolean): void {
  inst = new Telemetry(enabled);
}
export function tele(): Telemetry | null {
  return inst;
}
