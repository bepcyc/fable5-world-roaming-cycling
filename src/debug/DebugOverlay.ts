/**
 * Debug overlay (owner directive 2026-07-03): Shift+D toggles an OPAQUE
 * corner panel with the live scene-reproduction parameters — everything
 * needed to re-create exactly what the viewer is looking at:
 * scene type, world seed, preset, time of day, camera mode, logical pose
 * (position / yaw / pitch), view direction vector, and a ready-to-paste
 * `--cam` string for tools/shoot.ts. Updates every frame.
 */

import type { Engine } from '../core/Engine';
import type { FlyCamera } from '../core/FlyCamera';
import type { LaasParams } from '../core/Params';
import { SURF_COL, isSurfaceDbg, toggleSurfaceDbg } from '../render/DebugSurface';

/** legend rows: [ru label, palette key] — order groups roads then nature */
const LEGEND: readonly [string, keyof typeof SURF_COL][] = [
  ['вода', 'water'],
  ['асфальт', 'asphalt'],
  ['гравий (мелк.)', 'gravelFine'],
  ['гравий (кр.)', 'gravelCoarse'],
  ['русло-гравий', 'gravelRiver'],
  ['грунтовка', 'dirtRoad'],
  ['сингл', 'singletrack'],
  ['трава', 'grass'],
  ['лес', 'forest'],
  ['почва', 'soil'],
  ['осыпь', 'scree'],
  ['камень', 'rock'],
  ['снег', 'snow'],
  ['грязь', 'mud'],
  ['дорога: битый класс', 'anomaly'],
];

export class DebugOverlay {
  private el: HTMLDivElement;
  private badge: HTMLDivElement;
  private visible = false;

  constructor(
    private engine: Engine,
    private fly: FlyCamera,
    private params: LaasParams,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'debug-overlay';
    this.el.style.cssText = [
      'position:fixed', 'bottom:10px', 'right:10px', 'z-index:1200',
      'color:#d9e8e0', 'background:#0a0f0c', // OPAQUE by request
      'padding:10px 12px', 'font:12px/1.5 ui-monospace,Menlo,monospace',
      'white-space:pre', 'border:1px solid #2c3a32', 'border-radius:4px',
      'pointer-events:none', 'display:none', 'user-select:text',
    ].join(';');
    document.body.appendChild(this.el);

    // Shift+W surface-overlay legend (top-left). Hidden until the mode is on.
    this.badge = document.createElement('div');
    this.badge.id = 'surfdbg-legend';
    this.badge.style.cssText = [
      'position:fixed', 'top:10px', 'left:10px', 'z-index:1200',
      'color:#e8f0ea', 'background:#0a0f0ccc',
      'padding:8px 10px', 'font:11px/1.45 ui-monospace,Menlo,monospace',
      'border:1px solid #2c3a32', 'border-radius:4px',
      'pointer-events:none', 'user-select:none',
      'display:none',
    ].join(';');
    const rgb = (c: readonly number[]): string =>
      `rgb(${Math.round((c[0] as number) * 255)},${Math.round((c[1] as number) * 255)},${Math.round((c[2] as number) * 255)})`;
    this.badge.innerHTML =
      '<b>surface overlay</b> — Shift+W<br>' +
      LEGEND.map(
        ([label, key]) =>
          `<span style="display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px;background:${rgb(SURF_COL[key])};border:1px solid #0006"></span>${label}`,
      ).join('<br>');
    document.body.appendChild(this.badge);
    this.badge.style.display = isSurfaceDbg() ? 'block' : 'none';

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyD' && e.shiftKey) {
        e.preventDefault();
        this.visible = !this.visible;
        this.el.style.display = this.visible ? 'block' : 'none';
      }
      // Shift+W: toggle the surface-debug overlay (defeats FlyCamera forward)
      if (e.code === 'KeyW' && e.shiftKey) {
        e.preventDefault();
        this.badge.style.display = toggleSurfaceDbg() ? 'block' : 'none';
      }
    });

    engine.onUpdate(() => {
      if (this.visible) this.render();
    });
  }

  private render(): void {
    const pose = this.fly.getPose();
    const [x, y, z] = pose.p;
    const { yaw, pitch } = pose;
    // view direction from yaw/pitch (three.js: yaw 0 → −Z)
    const cp = Math.cos(pitch);
    const dir = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
    const cam = this.engine.camera;
    const f = (n: number, d = 2): string => n.toFixed(d);
    this.el.textContent = [
      `scene   ${this.params.scene}   mode ${this.fly.mode}`,
      `seed    ${this.params.seed}   preset ${this.params.preset}   T ${this.params.timeOfDay}`,
      `pos     ${f(x)}, ${f(y)}, ${f(z)}`,
      `yaw     ${f(yaw, 4)}   pitch ${f(pitch, 4)}   fov ${f(cam.fov, 1)}`,
      `dir     ${f(dir[0] as number, 3)}, ${f(dir[1] as number, 3)}, ${f(dir[2] as number, 3)}`,
      `--cam "${f(x, 1)},${f(y, 1)},${f(z, 1)},${f(yaw, 2)},${f(pitch, 2)},${f(cam.fov, 0)}"`,
      `Shift+D close`,
    ].join('\n');
  }
}
