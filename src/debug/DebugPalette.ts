/**
 * Single source of truth for every debug-overlay palette, shared by the
 * engine AND the node tooling (tsx imports this file directly), so pixel
 * classifiers can match debug colors EXACTLY instead of by hue window.
 *
 * Rules (owner verdict 2026-07-16, docs/WARPLAN_BLACK_ROADS_GRASS.md era):
 * - pure black is FORBIDDEN in every palette: a black pixel in a debug mode
 *   always means "fragment fell through / NaN / dead draw" — detector food;
 * - cyan (SURF_COL.anomaly) is reserved for the broken-class marker;
 * - vegetation/ring palettes avoid nature look-alikes (meadow greens, sky
 *   blues, soil browns) so flat-colored draws pop against the real world;
 * - all values are LINEAR shader constants < 1 (emissive, pre-tonemap).
 *   The canvas converts to sRGB on present; tools must compare against
 *   linearToSrgb8() of these constants. With ?dbgexact=1 the post chain is
 *   bypassed entirely, making that comparison exact (± rounding).
 *
 * This module must stay dependency-free (no three/TSL imports) so node
 * tools can import it without dragging the renderer in.
 */

/** linear 0..1 -> sRGB 0..255 (the transform the canvas applies on present) */
export function linearToSrgb8(c: readonly number[]): [number, number, number] {
  const f = (v: number): number => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255)));
  };
  return [f(c[0] ?? 0), f(c[1] ?? 0), f(c[2] ?? 0)];
}

/** surface overlay (?surfdbg=1) — keys mirror SurfaceMatrix classes.
 *  Confusables resolved 2026-07-16: gravelRiver was khaki (vs the two gravel
 *  yellows), soil was dark tan (vs dirtRoad brown). */
export const SURF_COL = {
  water: [0.85, 0.02, 0.02], // bright red (shallow / renderable water)
  waterDeep: [0.5, 0.0, 0.12], // dark crimson (deep water — blocks everything)
  asphalt: [0.95, 0.4, 0.0], // orange
  gravelFine: [0.95, 0.85, 0.0], // yellow
  gravelCoarse: [0.6, 0.5, 0.0], // olive/dark-yellow
  gravelRiver: [0.62, 0.58, 0.95], // periwinkle (was khaki — clashed with gravels)
  dirtRoad: [0.6, 0.34, 0.12], // brown
  singletrack: [0.9, 0.1, 0.7], // magenta
  grass: [0.15, 0.8, 0.15], // green
  forest: [0.04, 0.38, 0.08], // dark green
  soil: [0.82, 0.6, 0.38], // light sand (was dark tan — clashed with dirtRoad)
  scree: [0.7, 0.7, 0.74], // light gray
  rock: [0.45, 0.47, 0.55], // blue-gray
  snow: [0.92, 0.95, 1.0], // white
  mud: [0.5, 0.12, 0.58], // purple
  anomaly: [0.0, 0.95, 0.95], // RESERVED bright cyan — broken road class id
} as const;

/** VegClass draw-id palette (?clsdbg=1), indexed by VegClass (0..23).
 *  Replaces hsl(id*47) which collided with nature: flower-umbel landed on
 *  sky blue (scanners matched the SKY as flowers), boulder on water cyan.
 *  Warm/purple set only — no meadow greens, no sky blues, no soil browns. */
export const VEG_DBG: readonly (readonly [number, number, number])[] = [
  [0.9, 0.1, 0.1], // 0 spruce — red
  [1.0, 0.55, 0.0], // 1 pine — orange
  [1.0, 0.9, 0.1], // 2 beech — yellow
  [0.95, 0.3, 0.6], // 3 birch — pink
  [0.55, 0.1, 0.9], // 4 karst-gnarl — violet
  [0.7, 0.35, 0.05], // 5 snag — rust
  [0.5, 0.5, 0.5], // 6 (unused) — gray
  [0.5, 0.5, 0.5], // 7 (unused) — gray
  [1.0, 0.2, 0.3], // 8 hazel — coral
  [1.0, 0.6, 0.8], // 9 pink-bush — light pink
  [0.8, 0.0, 0.8], // 10 juniper — magenta
  [1.0, 0.8, 0.45], // 11 fern — apricot
  [1.0, 0.75, 0.0], // 12 flower-umbel — GOLD (was sky blue!)
  [0.75, 0.25, 1.0], // 13 flower-bell — bright violet
  [1.0, 0.4, 0.9], // 14 flower-daisy — hot pink
  [0.5, 0.5, 0.5], // 15 (unused) — gray
  [0.85, 0.45, 0.2], // 16 log — copper
  [0.6, 0.2, 0.45], // 17 stump — plum
  [0.95, 0.95, 0.6], // 18 boulder — pale yellow (was water cyan!)
  [0.85, 0.6, 0.95], // 19 slab — lilac
  [1.0, 0.3, 0.05], // 20 stone-large — vermilion
  [0.95, 0.7, 0.6], // 21 stone-medium — salmon
  [0.7, 0.55, 0.9], // 22 stone-small — periwinkle
  [0.9, 0.15, 0.75], // 23 branch — fuchsia
] as const;

/** GroundRing draw-group palette (?ringdbg / ?ringonly), indexed by group.
 *  Same anti-nature rules; litter was near-white (invisible on scree). */
export const RING_DBG: readonly (readonly [number, number, number])[] = [
  [1.0, 0.45, 0.0], // 0 grass-near — orange
  [0.95, 0.85, 0.1], // 1 grass-mid — yellow
  [0.9, 0.1, 0.1], // 2 grass-far — red
  [0.75, 0.25, 1.0], // 3 stream-cobble — violet
  [1.0, 0.6, 0.8], // 4 stream-pebble — pink
  [0.85, 0.45, 0.2], // 5 twig — copper
  [0.6, 0.2, 0.45], // 6 bark-chip — plum
  [1.0, 0.8, 0.45], // 7 litter — apricot (was near-white)
  [0.8, 0.0, 0.8], // 8 grass-super-far — magenta
  [0.95, 0.7, 0.6], // 9 road-cobble — salmon
  [0.7, 0.55, 0.9], // 10 road-pebble — periwinkle
  [1.0, 0.75, 0.0], // 11 road-trefoil — gold
  [0.55, 0.1, 0.9], // 12 road-thyme — deep violet
  [1.0, 0.3, 0.05], // 13 road-grit — vermilion
] as const;

/** CSS color string for legend swatches (converts linear -> sRGB). */
export function cssOf(c: readonly number[]): string {
  const [r, g, b] = linearToSrgb8(c);
  return `rgb(${r},${g},${b})`;
}
