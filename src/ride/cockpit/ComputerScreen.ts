/**
 * ComputerScreen — live bike-computer display as a CanvasTexture.
 *
 * Owner-reference layout (Garmin-style): the TOP is a heading-up ROUTE
 * MAP drawn from the actual RouteGraph (current edge highlighted, road
 * classes tinted, rider chevron), the BOTTOM is the data row (big speed,
 * power / cadence / distance / grade). When the P5 hazard lookahead has
 * an impassable zone inside the reaction window, a red WARNING strip
 * slides over the map bottom — exactly like the reference photo.
 *
 * Redraws at 4 Hz; values come from the same rig/sensor state the DOM
 * dashboard shows (Pillar C: no invented numbers — missing reads "--").
 * The mesh material is emissive-driven so the display stays readable at
 * dusk and blooms gently at night, like a real backlit unit.
 */

import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { Mesh } from 'three';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import { clamp, float, texture as texNode, uv } from 'three/tsl';
import type { RouteGraph } from '../RouteGraph';

const W = 256;
const H = 400;
const REFRESH_S = 0.25;
const MAP_H = 210; // px — map pane height
const MAP_RANGE_M = 130; // world meters from rider to the map top edge

export interface ScreenData {
  kmh: number;
  powerW: number | null;
  cadenceRpm: number | null;
  distM: number;
  gradePct: number | null;
  /** P5 hazard inside the warning window (null = clear) */
  hazard: { distM: number; label: string } | null;
}

export interface MapCtx {
  graph: RouteGraph;
  x: number;
  z: number;
  heading: number;
}

/** per-road-class map tint (matches the HUD chooser accents) */
const CLS_TINT: Record<string, string> = {
  asphalt: '#b9cfe6',
  'gravel-fine': '#e6d4a8',
  'gravel-coarse': '#d4bf90',
  'dirt-road': '#d1a878',
  singletrack: '#b3d693',
};

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
    const t = texNode(this.tex, uv());
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

  update(dt: number, d: ScreenData, map: MapCtx | null = null): void {
    this.sparkAcc += dt;
    if (this.sparkAcc >= 1) {
      this.sparkAcc = 0;
      this.spark.push(d.powerW ?? 0);
      if (this.spark.length > 60) this.spark.shift();
    }
    this.acc += dt;
    if (this.acc < REFRESH_S) return;
    this.acc = 0;
    this.draw(d, map);
    this.tex.needsUpdate = true;
  }

  private drawMap(map: MapCtx, hazard: ScreenData['hazard']): void {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(4, 4, W - 8, MAP_H);
    c.clip();
    c.fillStyle = '#101613';
    c.fillRect(4, 4, W - 8, MAP_H);

    // rider anchor: bottom-center third of the map, heading-up
    const ax = W / 2;
    const ay = 4 + MAP_H * 0.78;
    const scale = (MAP_H * 0.78) / MAP_RANGE_M; // px per meter
    const cosH = Math.cos(map.heading);
    const sinH = Math.sin(map.heading);
    const toPx = (wx: number, wz: number): [number, number] => {
      const dx = wx - map.x;
      const dz = wz - map.z;
      // world → rider-local (heading-up): forward = -Z rotated by heading
      const lx = dx * cosH - dz * sinH;
      const lz = dx * sinH + dz * cosH;
      return [ax + lx * scale, ay + lz * scale];
    };

    // faint range ring
    c.strokeStyle = 'rgba(170,210,190,0.10)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(ax, ay, 60 * scale, 0, Math.PI * 2);
    c.stroke();

    const R2 = (MAP_RANGE_M + 60) ** 2;
    for (const e of map.graph.edges) {
      const pts = e.pts;
      if (pts.length < 2) continue;
      // cheap cull: skip edges whose first point is far outside the range
      const p0 = pts[0] as { x: number; z: number };
      const ddx = p0.x - map.x;
      const ddz = p0.z - map.z;
      if (ddx * ddx + ddz * ddz > R2 * 9) continue;
      c.strokeStyle = CLS_TINT[e.cls.name] ?? '#9fb4a8';
      c.lineWidth = e.cls.name === 'asphalt' ? 5 : e.cls.name === 'singletrack' ? 2.5 : 4;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.globalAlpha = 0.85;
      c.beginPath();
      let started = false;
      for (let i = 0; i < pts.length; i += 2) {
        const p = pts[Math.min(i, pts.length - 1)] as { x: number; z: number };
        const [px, py] = toPx(p.x, p.z);
        if (!started) {
          c.moveTo(px, py);
          started = true;
        } else c.lineTo(px, py);
      }
      c.stroke();
    }
    c.globalAlpha = 1;

    // rider chevron
    c.fillStyle = '#ffd166';
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(ax, ay - 11);
    c.lineTo(ax - 7, ay + 7);
    c.lineTo(ax, ay + 3);
    c.lineTo(ax + 7, ay + 7);
    c.closePath();
    c.fill();
    c.stroke();

    // red hazard strip over the map bottom (reference: Garmin warning)
    if (hazard) {
      const y0 = 4 + MAP_H - 34;
      c.fillStyle = 'rgba(178,32,28,0.92)';
      c.fillRect(4, y0, W - 8, 34);
      c.fillStyle = '#ffe9e6';
      c.font = 'bold 15px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      c.fillText(`⚠ ${hazard.label} · ${Math.max(Math.round(hazard.distM / 5) * 5, 5)} m`, W / 2, y0 + 22);
    }
    c.restore();
    // pane frame
    this.ctx.strokeStyle = 'rgba(180,220,200,0.2)';
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeRect(4, 4, W - 8, MAP_H);
  }

  private draw(d: ScreenData, map: MapCtx | null): void {
    const c = this.ctx;
    // panel
    c.fillStyle = '#0a0f0d';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(180,220,200,0.22)';
    c.lineWidth = 2;
    c.strokeRect(2, 2, W - 4, H - 4);

    const mono = (px: number, bold = true): string =>
      `${bold ? 'bold ' : ''}${px}px ui-monospace, Menlo, Consolas, monospace`;

    if (map) this.drawMap(map, d.hazard);

    // data pane below the map
    const y0 = map ? MAP_H + 10 : 10;
    c.fillStyle = '#7d9c8d';
    c.font = mono(13);
    c.textAlign = 'left';
    c.fillText('KM/H', 16, y0 + 22);
    c.fillStyle = '#eaf6ee';
    c.font = mono(64);
    c.textAlign = 'center';
    c.fillText(d.kmh.toFixed(1), W / 2, y0 + 78);

    const cell = (
      label: string,
      value: string,
      cx: number,
      cy: number,
      color: string,
    ): void => {
      c.textAlign = 'center';
      c.fillStyle = '#6d8a7c';
      c.font = mono(12);
      c.fillText(label, cx, cy);
      c.fillStyle = color;
      c.font = mono(30);
      c.fillText(value, cx, cy + 32);
    };
    const fmtN = (v: number | null): string => (v === null ? '--' : Math.round(v).toString());
    const rowY = y0 + 106;
    cell('PWR', fmtN(d.powerW), W * 0.18, rowY, '#ffd166');
    cell('CAD', fmtN(d.cadenceRpm), W * 0.5, rowY, '#bcd9ff');
    const km = d.distM / 1000;
    cell('KM', km >= 100 ? km.toFixed(0) : km.toFixed(km >= 10 ? 1 : 2), W * 0.82, rowY, '#dcefe4');
    // grade strip
    c.fillStyle = '#6d8a7c';
    c.font = mono(12);
    c.textAlign = 'left';
    c.fillText('GRADE', 16, H - 14);
    c.fillStyle =
      d.gradePct !== null && d.gradePct > 1
        ? '#ff9d7a'
        : d.gradePct !== null && d.gradePct < -1
          ? '#8fd8ff'
          : '#dcefe4';
    c.font = mono(20);
    c.textAlign = 'right';
    c.fillText(
      d.gradePct === null ? '--' : `${d.gradePct >= 0 ? '+' : ''}${d.gradePct.toFixed(1)} %`,
      W - 16,
      H - 12,
    );
  }
}
