/**
 * Surface debug overlay (owner request 2026-07-06): a diagnostic view that
 * repaints every surface/object type in a flat contrasting color plus a
 * world-space grid, so classification defects (misclassified water, hairline
 * "micro roads", stray sticks) jump out at a glance.
 *
 * Driven by ONE live uniform (surfaceDbgU 0/1) so Shift+W toggles it without
 * rebuilding any material graph. `?surfdbg=1` sets it at boot (tools/shoot.ts
 * repro). Terrain classes are painted from the SAME continuous weights the
 * natural shader uses (TerrainMaterial); water is the WaterSurface mesh; both
 * emit the debug color UNLIT (emissiveNode) so sun/shadow don't muddy it.
 */

import { fract, fwidth, smoothstep, uniform, vec3 } from 'three/tsl';
import type { NF, NV2, NV3 } from '../gpu/TSLTypes';

/** 0 = off, 1 = on. Shared instance — every material references this node. */
export const surfaceDbgU = uniform(0);

type Mutable = { value: number };

export function setSurfaceDbg(on: boolean): void {
  (surfaceDbgU as unknown as Mutable).value = on ? 1 : 0;
}
export function isSurfaceDbg(): boolean {
  return (surfaceDbgU as unknown as Mutable).value > 0.5;
}
export function toggleSurfaceDbg(): boolean {
  const next = !isSurfaceDbg();
  setSurfaceDbg(next);
  return next;
}

/**
 * Per-class debug palette (bright, maximally separable hues). Emissive is
 * shown pre-tonemap, so values are kept < 1 to avoid clipping to white after
 * the post stack. Keep in sync with the legend in DebugOverlay.
 */
export const SURF_COL = {
  water: [0.85, 0.02, 0.02], // bright red (shallow / renderable water)
  waterDeep: [0.5, 0.0, 0.12], // dark crimson (deep water — blocks everything)
  asphalt: [0.95, 0.4, 0.0], // orange
  gravelFine: [0.95, 0.85, 0.0], // yellow
  gravelCoarse: [0.6, 0.5, 0.0], // olive/dark-yellow
  gravelRiver: [0.75, 0.68, 0.15], // khaki (natural stream gravel)
  dirtRoad: [0.6, 0.34, 0.12], // brown
  singletrack: [0.9, 0.1, 0.7], // magenta
  grass: [0.15, 0.8, 0.15], // green
  forest: [0.04, 0.38, 0.08], // dark green
  soil: [0.45, 0.3, 0.14], // tan/soil brown
  scree: [0.7, 0.7, 0.74], // light gray
  rock: [0.45, 0.47, 0.55], // blue-gray
  snow: [0.92, 0.95, 1.0], // white
  mud: [0.5, 0.12, 0.58], // purple
  anomaly: [0.0, 0.95, 0.95], // bright cyan — road core whose class id is broken
} as const;

/** vec3 node from a palette tuple. */
export const palette = (c: readonly number[]): NV3 =>
  vec3(c[0] as number, c[1] as number, c[2] as number);

/**
 * Polygon wireframe mask (0..1, 1 on a triangle edge) from a mesh's grid
 * coordinates (integer at each vertex line). Uses screen-space derivatives
 * (fwidth) so edges stay a constant ~1 px thick at any distance/angle instead
 * of aliasing. Covers the quad rows/cols plus the shared diagonal, so the
 * actual TRIANGULATION shows — a sagging road reads as stretched tris, a
 * micro-road as a dense sliver of them.
 */
export function polyWire(gc: NV2): NF {
  const f = fract(gc);
  const w = fwidth(gc).max(1e-5); // px width per axis
  // rows + columns: distance (in px) to the nearest integer grid line. ~2.5 px
  // lines so the mesh is legible after downscale, AA'd so they don't shimmer.
  const dRC = f.min(f.oneMinus()).div(w);
  const rc = smoothstep(2.5, 0.7, dRC.x.min(dRC.y)); // 1 on a line
  // shared diagonal of the quad (PlaneGeometry splits corner-to-corner)
  const diagV = f.x.sub(f.y);
  const diag = smoothstep(2.5, 0.7, diagV.abs().div(fwidth(diagV).max(1e-5)));
  return rc.max(diag.mul(0.85));
}
