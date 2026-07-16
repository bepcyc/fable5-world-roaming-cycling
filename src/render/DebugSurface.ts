/**
 * Surface debug overlay (owner request 2026-07-06): a diagnostic view that
 * repaints every surface/object type in a flat contrasting color plus a
 * world-space grid, so classification defects (misclassified water, hairline
 * "micro roads", stray sticks) jump out at a glance.
 *
 * Driven by ONE live uniform (surfaceDbgU 0/1) so Shift+C toggles it without
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

// Palette moved to src/debug/DebugPalette.ts (single source for engine +
// node tools — exact pixel matching). Re-exported for existing importers.
export { SURF_COL } from '../debug/DebugPalette';

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
