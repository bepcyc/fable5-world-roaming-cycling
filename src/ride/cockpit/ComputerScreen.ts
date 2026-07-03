/**
 * ComputerScreen — live bike-computer display as a CanvasTexture.
 *
 * M1.5.2 layout = the owner's three reference photos, verbatim: portrait
 * phone-format unit, near-black panel, white numerals; top status row,
 * SPEED huge with km/h, then a 2×2 grid POWER | CADENCE / HEART RATE
 * (with the red bar) | DISTANCE, then TIMER (hh:mm:ss), page dots at the
 * bottom. Metrics live ON the device (owner mandate) — no invented
 * numbers (Pillar C): missing sensors read "--".
 *
 * The Garmin-style route map + red hazard strip from session 7 stays as
 * an ALTERNATE page (?ckmap=1); the hazard strip also overlays the
 * metrics page as a red banner when the P5 lookahead fires.
 *
 * Redraws at 4 Hz; emissive-driven so the display reads at dusk.
 */

import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { Mesh } from 'three';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import { clamp, float, texture as texNode, uv } from 'three/tsl';
import type { RouteGraph } from '../RouteGraph';

const W = 256;
const H = 544;
const REFRESH_S = 0.25;
const MAP_H = 300; // px — map pane height (map page)
const MAP_RANGE_M = 130;

export interface ScreenData {
  kmh: number;
  powerW: number | null;
  cadenceRpm: number | null;
  hrBpm: number | null;
  distM: number;
  /** ride timer, seconds (auto-pause handled by the caller) */
  elapsedS: number;
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

const FG = '#f2f4f5';
const DIM = '#9aa3a6';
const RED = '#e5342c';

export class ComputerScreen {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: CanvasTexture;
  private acc = REFRESH_S; // draw on first update
  private mapPage: boolean;

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
    this.mapPage = new URLSearchParams(window.location.search).get('ckmap') === '1';

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
    this.acc += dt;
    if (this.acc < REFRESH_S) return;
    this.acc = 0;
    this.draw(d, map);
    this.tex.needsUpdate = true;
  }

  // ---- metrics page (the reference layout) ---------------------------------

  private draw(d: ScreenData, map: MapCtx | null): void {
    const c = this.ctx;
    c.fillStyle = '#060809';
    c.fillRect(0, 0, W, H);

    const sans = (px: number, weight = 700): string =>
      `${weight} ${px}px -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;

    if (this.mapPage && map) {
      this.drawMapPage(d, map);
      return;
    }

    // status row: signal bars left, battery right
    c.fillStyle = DIM;
    for (let i = 0; i < 4; i++) {
      const bh = 4 + i * 3;
      c.fillRect(14 + i * 7, 26 - bh, 5, bh);
    }
    c.strokeStyle = DIM;
    c.lineWidth = 2;
    c.strokeRect(W - 40, 12, 24, 13);
    c.fillRect(W - 15, 15, 3, 7);
    c.fillRect(W - 38, 14, 17, 9);

    // SPEED
    c.textAlign = 'center';
    c.fillStyle = DIM;
    c.font = sans(15, 600);
    c.fillText('SPEED', W / 2, 58);
    c.fillStyle = FG;
    const sp = d.kmh;
    const spMain = Math.floor(sp).toString();
    const spFrac = `.${Math.floor((sp % 1) * 10)}`;
    c.font = sans(92);
    const mainW = c.measureText(spMain).width;
    c.font = sans(44);
    const fracW = c.measureText(spFrac).width;
    const x0 = W / 2 - (mainW + fracW) / 2;
    c.textAlign = 'left';
    c.font = sans(92);
    c.fillText(spMain, x0, 142);
    c.font = sans(44);
    c.fillText(spFrac, x0 + mainW, 142);
    c.fillStyle = DIM;
    c.font = sans(14, 600);
    c.fillText('km/h', x0 + mainW + 4, 164);

    // grid lines
    c.strokeStyle = 'rgba(255,255,255,0.14)';
    c.lineWidth = 1;
    const gy0 = 186;
    const rowH = 118;
    line(c, 10, gy0, W - 10, gy0);
    line(c, 10, gy0 + rowH, W - 10, gy0 + rowH);
    line(c, 10, gy0 + rowH * 2, W - 10, gy0 + rowH * 2);
    line(c, W / 2, gy0, W / 2, gy0 + rowH * 2);

    const fmtN = (v: number | null): string =>
      v === null ? '--' : Math.round(v).toString();
    const km = d.distM / 1000;
    const kmS = km >= 100 ? km.toFixed(0) : km.toFixed(1);

    this.cell(W * 0.25, gy0 + 6, 'POWER', fmtN(d.powerW), 'W', null);
    this.cell(W * 0.75, gy0 + 6, 'CADENCE', fmtN(d.cadenceRpm), 'rpm', null);
    this.cell(W * 0.25, gy0 + rowH + 6, 'HEART RATE', fmtN(d.hrBpm), 'bpm', RED);
    this.cell(W * 0.75, gy0 + rowH + 6, 'DISTANCE', kmS, 'km', null);

    // TIMER
    c.textAlign = 'center';
    c.fillStyle = DIM;
    c.font = sans(15, 600);
    c.fillText('TIMER', W / 2, gy0 + rowH * 2 + 30);
    c.fillStyle = FG;
    c.font = sans(46);
    c.fillText(hms(d.elapsedS), W / 2, gy0 + rowH * 2 + 76);

    // bottom: page dots + tiny status segments (ref look)
    const dy = H - 18;
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i === 0 ? FG : 'rgba(255,255,255,0.25)';
      c.beginPath();
      c.arc(W / 2 - 21 + i * 14, dy, 3, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#37b24d';
    c.fillRect(16, dy - 2, 22, 4);
    c.fillStyle = RED;
    c.fillRect(W - 38, dy - 2, 22, 4);

    // hazard: red banner over the top band (P5 warning on-device)
    if (d.hazard) {
      c.fillStyle = 'rgba(178,32,28,0.94)';
      c.fillRect(0, 0, W, 40);
      c.fillStyle = '#ffe9e6';
      c.font = sans(19);
      c.textAlign = 'center';
      c.fillText(
        `⚠ ${d.hazard.label} · ${Math.max(Math.round(d.hazard.distM / 5) * 5, 5)} m`,
        W / 2,
        27,
      );
    }
  }

  private cell(
    cx: number,
    top: number,
    label: string,
    value: string,
    unit: string,
    barColor: string | null,
  ): void {
    const c = this.ctx;
    const sans = (px: number, weight = 700): string =>
      `${weight} ${px}px -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
    c.textAlign = 'center';
    c.fillStyle = DIM;
    c.font = sans(13, 600);
    c.fillText(label, cx, top + 16);
    c.fillStyle = FG;
    c.font = sans(52);
    c.fillText(value, cx, top + 68);
    if (barColor) {
      c.fillStyle = barColor;
      c.fillRect(cx - 34, top + 78, 68, 5);
    }
    c.fillStyle = DIM;
    c.font = sans(12, 600);
    c.fillText(unit, cx, top + 98);
  }

  // ---- map page (session-7 Garmin look, kept under ?ckmap=1) ---------------

  private drawMapPage(d: ScreenData, map: MapCtx): void {
    const c = this.ctx;
    this.drawMap(map, d.hazard);
    const sans = (px: number, weight = 700): string =>
      `${weight} ${px}px -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
    const y0 = MAP_H + 14;
    c.fillStyle = DIM;
    c.font = sans(14, 600);
    c.textAlign = 'center';
    c.fillText('SPEED', W / 2, y0 + 16);
    c.fillStyle = FG;
    c.font = sans(72);
    c.fillText(d.kmh.toFixed(1), W / 2, y0 + 86);
    const fmtN = (v: number | null): string =>
      v === null ? '--' : Math.round(v).toString();
    const km = d.distM / 1000;
    this.cell(W * 0.25, y0 + 104, 'POWER', fmtN(d.powerW), 'W', null);
    this.cell(W * 0.75, y0 + 104, 'DISTANCE', km >= 100 ? km.toFixed(0) : km.toFixed(1), 'km', null);
  }

  private drawMap(map: MapCtx, hazard: ScreenData['hazard']): void {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(4, 4, W - 8, MAP_H);
    c.clip();
    c.fillStyle = '#101613';
    c.fillRect(4, 4, W - 8, MAP_H);

    const ax = W / 2;
    const ay = 4 + MAP_H * 0.78;
    const scale = (MAP_H * 0.78) / MAP_RANGE_M;
    const cosH = Math.cos(map.heading);
    const sinH = Math.sin(map.heading);
    const toPx = (wx: number, wz: number): [number, number] => {
      const dx = wx - map.x;
      const dz = wz - map.z;
      const lx = dx * cosH - dz * sinH;
      const lz = dx * sinH + dz * cosH;
      return [ax + lx * scale, ay + lz * scale];
    };

    c.strokeStyle = 'rgba(170,210,190,0.10)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(ax, ay, 60 * scale, 0, Math.PI * 2);
    c.stroke();

    const R2 = (MAP_RANGE_M + 60) ** 2;
    for (const e of map.graph.edges) {
      const pts = e.pts;
      if (pts.length < 2) continue;
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

    if (hazard) {
      const y0 = 4 + MAP_H - 34;
      c.fillStyle = 'rgba(178,32,28,0.92)';
      c.fillRect(4, y0, W - 8, 34);
      c.fillStyle = '#ffe9e6';
      c.font = 'bold 15px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      c.fillText(
        `⚠ ${hazard.label} · ${Math.max(Math.round(hazard.distM / 5) * 5, 5)} m`,
        W / 2,
        y0 + 22,
      );
    }
    c.restore();
    this.ctx.strokeStyle = 'rgba(180,220,200,0.2)';
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeRect(4, 4, W - 8, MAP_H);
  }
}

function line(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}

function hms(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(ss)}`;
}
