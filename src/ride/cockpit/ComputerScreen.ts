/**
 * ComputerScreen — live bike-computer display as a CanvasTexture.
 *
 * Draws a head-unit layout at 4 Hz: big speed, power / cadence /
 * distance / grade fields, and a scrolling 60 s power sparkline. Values
 * come from the same rig/sensor state the DOM dashboard shows (Pillar C:
 * the screen never invents numbers — missing channels read "--").
 *
 * The mesh material is emissive-driven so the display stays readable at
 * dusk and picks up a gentle bloom at night, like a real backlit unit.
 */

import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { Mesh } from 'three';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import { clamp, float, texture as texNode, uv, vec2 } from 'three/tsl';

const W = 256;
const H = 400;
const REFRESH_S = 0.25;
const SPARK_N = 60;

export interface ScreenData {
  kmh: number;
  powerW: number | null;
  cadenceRpm: number | null;
  distM: number;
  gradePct: number | null;
}

export class ComputerScreen {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: CanvasTexture;
  private acc = REFRESH_S; // draw on first update
  private spark: number[] = [];
  private sparkAcc = 0;

  constructor(mesh: Mesh) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.minFilter = LinearFilter;
    this.tex.anisotropy = 4;

    const m = new MeshPhysicalNodeMaterial();
    const t = texNode(this.tex, uv().mul(vec2(1, 1)));
    // dim diffuse + emissive backlight; clearcoat gives the glass a sky
    // reflection so the unit reads as a screen, not a sticker
    m.colorNode = t.rgb.mul(0.22);
    m.emissiveNode = t.rgb.mul(clamp(float(1.35), 0, 4));
    m.roughness = 0.35;
    m.clearcoat = 1.0;
    m.clearcoatRoughness = 0.08;
    m.metalness = 0;
    mesh.material = m;
  }

  update(dt: number, d: ScreenData): void {
    this.sparkAcc += dt;
    if (this.sparkAcc >= 1) {
      this.sparkAcc = 0;
      this.spark.push(d.powerW ?? 0);
      if (this.spark.length > SPARK_N) this.spark.shift();
    }
    this.acc += dt;
    if (this.acc < REFRESH_S) return;
    this.acc = 0;
    this.draw(d);
    this.tex.needsUpdate = true;
  }

  private draw(d: ScreenData): void {
    const c = this.ctx;
    // panel
    c.fillStyle = '#0a0f0d';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(180,220,200,0.22)';
    c.lineWidth = 2;
    c.strokeRect(3, 3, W - 6, H - 6);

    const mono = (px: number, bold = true): string =>
      `${bold ? 'bold ' : ''}${px}px ui-monospace, Menlo, Consolas, monospace`;

    // top: speed
    c.fillStyle = '#8fb2a2';
    c.font = mono(16);
    c.textAlign = 'left';
    c.fillText('KM/H', 18, 34);
    c.fillStyle = '#eaf6ee';
    c.font = mono(84);
    c.textAlign = 'center';
    c.fillText(d.kmh.toFixed(1), W / 2, 118);

    c.strokeStyle = 'rgba(180,220,200,0.16)';
    c.beginPath();
    c.moveTo(14, 140);
    c.lineTo(W - 14, 140);
    c.stroke();

    // grid: PWR | CAD / DIST | GRADE
    const cell = (
      label: string,
      value: string,
      unit: string,
      cx: number,
      cy: number,
      color: string,
    ): void => {
      c.textAlign = 'center';
      c.fillStyle = '#7d9c8d';
      c.font = mono(15);
      c.fillText(label, cx, cy);
      c.fillStyle = color;
      c.font = mono(44);
      c.fillText(value, cx, cy + 46);
      c.fillStyle = '#6d8a7c';
      c.font = mono(13);
      c.fillText(unit, cx, cy + 66);
    };
    const fmtN = (v: number | null): string => (v === null ? '--' : Math.round(v).toString());
    cell('PWR', fmtN(d.powerW), 'W', W * 0.27, 168, '#ffd166');
    cell('CAD', fmtN(d.cadenceRpm), 'RPM', W * 0.73, 168, '#bcd9ff');
    const km = d.distM / 1000;
    cell('DIST', km >= 100 ? km.toFixed(0) : km.toFixed(km >= 10 ? 1 : 2), 'KM', W * 0.27, 258, '#dcefe4');
    cell(
      'GRADE',
      d.gradePct === null ? '--' : `${d.gradePct >= 0 ? '+' : ''}${d.gradePct.toFixed(1)}`,
      '%',
      W * 0.73,
      258,
      d.gradePct !== null && d.gradePct > 1 ? '#ff9d7a' : d.gradePct !== null && d.gradePct < -1 ? '#8fd8ff' : '#dcefe4',
    );

    // power sparkline (last 60 s)
    c.strokeStyle = 'rgba(180,220,200,0.16)';
    c.beginPath();
    c.moveTo(14, 342);
    c.lineTo(W - 14, 342);
    c.stroke();
    const x0 = 18;
    const x1 = W - 18;
    const y0 = 388;
    const y1 = 350;
    const maxP = Math.max(220, ...this.spark);
    if (this.spark.length > 1) {
      c.strokeStyle = '#ffd166';
      c.lineWidth = 2.5;
      c.beginPath();
      this.spark.forEach((p, i) => {
        const x = x0 + ((x1 - x0) * i) / (SPARK_N - 1);
        const y = y0 - (y0 - y1) * Math.min(p / maxP, 1);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.stroke();
    } else {
      c.fillStyle = '#48605a';
      c.font = mono(13, false);
      c.textAlign = 'center';
      c.fillText('PWR 60s', W / 2, 372);
    }
  }
}
