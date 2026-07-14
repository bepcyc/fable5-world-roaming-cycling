/** Boot overlay progress reporting (also mirrored to hooks for tooling).
 *
 *  ?debug=1 adds an on-screen diagnostic overlay: GPU adapter, device limits,
 *  preset / dpr / screen+render resolution, and a TIMED log of every boot step.
 *  It is NOT hidden on success and (crucially) survives a device-loss crash, so
 *  a phone that dies mid-bake shows exactly WHICH step it reached and how long
 *  each took — the fastest way to see whether world-gen or first render is the
 *  culprit, and whether the adapter limits are the mobile floor. */

import { describeDiagnostics } from './Diagnostics';
import type { LaasHooks } from './Hooks';
import type { LaasParams } from './Params';
import { tele } from './Telemetry';

export class BootUI {
  private msg: HTMLElement | null;
  private bar: HTMLElement | null;
  private root: HTMLElement | null;
  private hooks: LaasHooks;
  private params: LaasParams | null;
  private head: HTMLElement | null = null;
  private log: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private t0 = performance.now();
  private headerFilled = false;

  constructor(hooks: LaasHooks, params?: LaasParams) {
    this.hooks = hooks;
    this.params = params ?? null;
    this.msg = document.getElementById('boot-msg');
    this.bar = document.getElementById('boot-bar');
    this.root = document.getElementById('boot');
    if (params?.debug) this.mountDebug();
  }

  private mountDebug(): void {
    const box = document.createElement('div');
    box.id = 'boot-debug';
    box.style.cssText =
      'position:fixed;top:0;left:0;z-index:99999;max-width:min(96vw,660px);max-height:78vh;' +
      'overflow:auto;background:rgba(0,0,0,.82);font:11px/1.35 ui-monospace,SFMono-Regular,monospace;' +
      'padding:8px 10px;white-space:pre-wrap;word-break:break-word;pointer-events:none;' +
      'border-bottom-right-radius:8px;text-shadow:0 1px 2px #000';
    const head = document.createElement('div');
    head.style.color = '#ffd88a';
    const log = document.createElement('div');
    log.style.color = '#a8d8ff';
    box.appendChild(head);
    box.appendChild(log);
    document.body.appendChild(box);
    this.head = head;
    this.log = log;
    this.scroller = box;
    this.refreshHeader();
  }

  private refreshHeader(): void {
    if (!this.head || !this.params) return;
    const p = this.params;
    const d = this.hooks.diag;
    const dpr = p.dpr ?? window.devicePixelRatio;
    const lines: string[] = [];
    if (d) lines.push(...describeDiagnostics(d));
    else lines.push('adapter: (probing WebGPU…)');
    lines.push(
      `preset: ${p.preset}    dpr: ${p.dpr ?? `auto(${window.devicePixelRatio.toFixed(2)})`}`,
      `screen: ${window.innerWidth}x${window.innerHeight}  render≈${Math.round(window.innerWidth * dpr)}x${Math.round(window.innerHeight * dpr)}`,
      `seed ${p.seed}  T ${p.timeOfDay}  scene ${p.scene}`,
      '─── boot steps ───',
    );
    this.head.textContent = lines.join('\n');
    if (d) this.headerFilled = true;
  }

  set(progress: number, message: string): void {
    this.hooks.progress = progress;
    this.hooks.progressMsg = message;
    tele()?.step(progress, message);
    if (this.msg) this.msg.textContent = message;
    if (this.bar) this.bar.style.width = `${Math.round(progress * 100)}%`;
    if (this.log) {
      // diag lands after construction (probeWebGPU) — fill the header once it does
      if (!this.headerFilled && this.hooks.diag) this.refreshHeader();
      const t = (performance.now() - this.t0).toFixed(0).padStart(5, ' ');
      const row = document.createElement('div');
      row.textContent = `+${t}ms  ${String(Math.round(progress * 100)).padStart(3, ' ')}%  ${message}`;
      this.log.appendChild(row);
      if (this.scroller) this.scroller.scrollTop = this.scroller.scrollHeight;
    }
  }

  hide(): void {
    this.set(1, 'ready');
    tele()?.ready();
    // Fade the splash panel. The ?debug=1 box is a SEPARATE element (appended
    // to body, pointer-events:none) so it stays visible — the full timed boot
    // log remains readable with the world rendering behind it.
    if (this.root) {
      this.root.style.opacity = '0';
      const el = this.root;
      setTimeout(() => {
        el.style.display = 'none';
      }, 600);
    }
  }
}
