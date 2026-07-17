/**
 * Quality — the single source of truth for every heavy rendering knob.
 *
 * Before this module the presets were "fake" (docs/PERF_MOBILE_KILLERS.md):
 * qualityConfig() carried 4 world-gen fields while every steady-state cost
 * (grass cull grid, shadow cascades, froxel grid, cloud march, GI cadence,
 * particle count, post stages) was a hardcoded constant shared by min and
 * ultra. preset=min paid the full ultra bill per frame, and ultra had no
 * lever to get richer. This module owns ALL of those axes.
 *
 * Resolution order per axis (same scheme as Threads.ts):
 *   1. URL override  — ?q.<axis>=<value>  (plus legacy aliases: grassscale,
 *      shadowmap, csmcasc, dpr — kept so existing tooling URLs stay valid)
 *   2. localStorage  — 'laas.quality' JSON blob written by the Settings UI
 *      (only when ?q.ls=1-gated OFF is not requested; harness runs pass
 *      ?q.ls=0 to ignore user settings for reproducibility)
 *   3. preset default — table below, keyed by ?preset=
 *
 * Consumers read the resolved snapshot ONCE at module/scene build time via
 * quality(). Axes marked live:true in QUALITY_META can be re-applied at
 * runtime; everything else needs a reload (the Settings UI says which).
 *
 * MEASUREMENT NOTES (Adreno 730 tablet + this box, 2026-07-15/16):
 *  - vegetation is 53% of all GPU work on the tablet; grass cull was the
 *    single most expensive pass (GRASS_GRID preset-driven since 2098573).
 *  - shadow map RESOLUTION is measured flat on the tablet tiler (R3) —
 *    the knob exists for attribution, not as a perf lever. Cascade COUNT
 *    and caster GEOMETRY are the real shadow costs.
 *  - depth prepass inverts on TBDR (R1) — see prepassMode() in Params.ts.
 *  - post quads are ~2.3 ms of 48 ms CPU on the tablet: pass-count is not
 *    a CPU lever, but each stage's GPU fill DOES scale with pixels.
 */

import type { QualityPreset } from './Params';

export interface QualitySettings {
  // ---- resolution ---------------------------------------------------------
  /** device-pixel-ratio cap; 0 = auto (min(devicePixelRatio, 1.5)) */
  renderScale: number;

  // ---- vegetation: ground carpets (GroundRing) ----------------------------
  /** grass slot-grid divisor S: cull threads and blade slots fall as 1/S²,
   *  survivors widen by S (coverage conserved). 3072 % S must be 0. */
  grassScale: number;
  /** blades per near clump (<=26 m band) */
  grassBladesNear: number;
  /** segments per near blade */
  grassSegsNear: number;
  /** blades per mid clump */
  grassBladesMid: number;
  /** segments per mid blade */
  grassSegsMid: number;
  /** fine grass ring reach (m); the far-tuft layer takes over beyond */
  grassRadius: number;
  /** 150-265 m super-tuft meadow silhouette layer */
  grassFarLayer: boolean;
  /** debris ring: cobbles/twigs/litter + road stone/grit/bloom pools */
  debris: boolean;

  // ---- vegetation: forests -------------------------------------------------
  /** multiplies tree LOD ring distances R0/R1/R2 (and extras rings) */
  treeRingScale: number;
  /** per-cascade vegetation shadow-caster draws (crown proxies + cards) */
  vegShadowCasters: boolean;

  // ---- sun shadows ----------------------------------------------------------
  /** CSM cascade count 1..4 */
  shadowCascades: number;
  /** shadow-map size per cascade (measured: NOT a perf lever on tilers) */
  shadowMapSize: number;
  /** CSM reach (m) */
  shadowMaxFar: number;
  /** PCSS contact-hardening filter (blocker search + Vogel PCF) */
  pcss: boolean;
  /** screen-space contact shadows in the post stack */
  contactShadows: boolean;

  // ---- volumetrics / sky ----------------------------------------------------
  /** froxel volumetric fog/shafts (160x90x64 grid, 2 kernels per frame) */
  froxels: boolean;
  /** froxel grid divisor: 1 = 160x90x64, 2 = 80x46x32 (8x fewer cells) */
  froxelScale: number;
  /** volumetric cloud layer (march + shadow LUT) */
  clouds: boolean;
  /** cloud raymarch steps per pixel (half-res pass) */
  cloudMarchSteps: number;
  /** cloud sun-shadow LUT resolution */
  cloudShadowRes: number;
  /** water caustics bake (512² compute per frame) */
  caustics: boolean;

  // ---- GI ---------------------------------------------------------------------
  /** irradiance probes re-gathered per frame (of 256x256x6 total) */
  giProbesPerFrame: number;

  // ---- particles ----------------------------------------------------------------
  /** GPU particle pool (snow/pollen/leaves) */
  particleCount: number;

  // ---- post stack -----------------------------------------------------------------
  /** GTAO (half-res). Off also drops contact shadows (shared pass). */
  ao: boolean;
  /** GTAO sample count */
  aoSamples: number;
  /** screen-space bounce / color bleed */
  bounce: boolean;
  /** temporal AA (TRAA). Off also drops motion blur (samples TRAA history). */
  taa: boolean;
  /** road-speed motion blur */
  motionBlur: boolean;
  /** HDR bloom */
  bloom: boolean;

  // ---- world generation (bake-time; the original QualityConfig) -------------------
  heightRes: number;
  simRes: number;
  erosionIters: number;
  tileVerts: number;
}

/** high = today's shipped desktop behavior, byte for byte */
const HIGH: QualitySettings = {
  renderScale: 0,
  grassScale: 1,
  grassBladesNear: 5,
  grassSegsNear: 4,
  grassBladesMid: 3,
  grassSegsMid: 2,
  grassRadius: 155,
  grassFarLayer: true,
  debris: true,
  treeRingScale: 1,
  vegShadowCasters: true,
  shadowCascades: 4,
  shadowMapSize: 2048,
  shadowMaxFar: 3200,
  pcss: true,
  contactShadows: true,
  froxels: true,
  froxelScale: 1,
  clouds: true,
  cloudMarchSteps: 32,
  cloudShadowRes: 768,
  caustics: true,
  giProbesPerFrame: 3072,
  particleCount: 131072,
  ao: true,
  aoSamples: 8,
  bounce: true,
  taa: true,
  motionBlur: true,
  bloom: true,
  heightRes: 4096,
  simRes: 2048,
  erosionIters: 640,
  tileVerts: 65,
};

/**
 * Preset tables. Initial values reproduce the shipped behavior exactly
 * (min differs from high only where it already did: world-gen + grassScale;
 * prepass lives in Params.prepassMode). The perf campaign then re-tunes
 * min/ultra with a measured ablation per axis — see docs/PERF_* notes.
 */
const PRESETS: Record<QualityPreset, QualitySettings> = {
  /**
   * min — assembled from the measured ablation battery (2026-07-16, clean
   * mutex-era runs, docs/PERF_QUALITY_AXES.md): SWITCHES OFF rather than
   * shrinks. Kept ON deliberately: clouds (sky goes empty for ~0.1 ms),
   * TAA (dither crossfades shred without temporal history), veg shadow
   * casters (the world flattens; cascades 2 already halves caster draws),
   * AO (grounding), bloom (fixed: no longer blacks the frame), debris
   * (near-field richness, measured cheap).
   */
  min: {
    ...HIGH,
    grassScale: 2,
    grassBladesNear: 3,
    grassSegsNear: 2,
    grassBladesMid: 2,
    grassSegsMid: 1,
    grassRadius: 120,
    grassFarLayer: false,
    treeRingScale: 0.6,
    shadowCascades: 2,
    shadowMapSize: 1024,
    shadowMaxFar: 1600,
    contactShadows: false,
    froxels: false,
    froxelScale: 2,
    cloudMarchSteps: 16,
    cloudShadowRes: 384,
    caustics: false,
    giProbesPerFrame: 1024,
    particleCount: 16384,
    bounce: false,
    motionBlur: false,
    heightRes: 1024,
    simRes: 512,
    erosionIters: 150,
    tileVerts: 33,
  },
  low: {
    ...HIGH,
    grassScale: 2,
    treeRingScale: 0.8,
    shadowCascades: 3,
    contactShadows: false,
    froxelScale: 2,
    cloudMarchSteps: 24,
    giProbesPerFrame: 2048,
    particleCount: 65536,
    bounce: false,
    heightRes: 2048,
    simRes: 1024,
    erosionIters: 500,
    tileVerts: 49,
  },
  mid: {
    ...HIGH,
    heightRes: 2048,
    simRes: 1024,
    erosionIters: 640,
    tileVerts: 49,
  },
  high: HIGH,
  /**
   * ultra — spends budget on axes that are actually visible: lusher near
   * carpet, farther tree rings, sharper+farther shadows, denser cloud
   * march, faster GI convergence, more particles, more AO samples.
   */
  ultra: {
    ...HIGH,
    grassBladesNear: 7,
    grassSegsNear: 5,
    grassBladesMid: 4,
    grassSegsMid: 2,
    grassRadius: 200,
    treeRingScale: 1.35,
    shadowMapSize: 4096,
    shadowMaxFar: 4800,
    cloudMarchSteps: 48,
    cloudShadowRes: 1024,
    giProbesPerFrame: 6144,
    particleCount: 262144,
    aoSamples: 12,
    heightRes: 4096,
    simRes: 2048,
    erosionIters: 900,
    tileVerts: 81,
  },
};

/** per-axis metadata: drives validation here and the Settings UI later */
export interface AxisMeta {
  /** i18n key suffix (settings.<key>) */
  key: keyof QualitySettings;
  kind: 'number' | 'boolean';
  min?: number;
  max?: number;
  step?: number;
  /** allowed discrete values (overrides min/max) */
  values?: readonly number[];
  /** re-appliable at runtime without a reload */
  live?: boolean;
  /** settings tab */
  tab: 'display' | 'vegetation' | 'shadows' | 'atmosphere' | 'effects' | 'world';
  /** legacy URL alias kept working (tooling compatibility) */
  legacyParam?: string;
}

export const QUALITY_META: readonly AxisMeta[] = [
  { key: 'renderScale', kind: 'number', min: 0, max: 2, step: 0.05, live: true, tab: 'display', legacyParam: 'dpr' },
  { key: 'grassScale', kind: 'number', values: [1, 2, 3, 4, 6, 8], tab: 'vegetation', legacyParam: 'grassscale' },
  { key: 'grassBladesNear', kind: 'number', min: 1, max: 7, step: 1, tab: 'vegetation' },
  { key: 'grassSegsNear', kind: 'number', min: 1, max: 5, step: 1, tab: 'vegetation' },
  { key: 'grassBladesMid', kind: 'number', min: 1, max: 5, step: 1, tab: 'vegetation' },
  { key: 'grassSegsMid', kind: 'number', min: 1, max: 3, step: 1, tab: 'vegetation' },
  { key: 'grassRadius', kind: 'number', min: 40, max: 240, step: 5, tab: 'vegetation' },
  { key: 'grassFarLayer', kind: 'boolean', tab: 'vegetation' },
  { key: 'debris', kind: 'boolean', tab: 'vegetation' },
  { key: 'treeRingScale', kind: 'number', min: 0.25, max: 2, step: 0.05, tab: 'vegetation' },
  { key: 'vegShadowCasters', kind: 'boolean', tab: 'shadows' },
  { key: 'shadowCascades', kind: 'number', min: 1, max: 4, step: 1, tab: 'shadows', legacyParam: 'csmcasc' },
  { key: 'shadowMapSize', kind: 'number', values: [256, 512, 1024, 2048, 4096], tab: 'shadows', legacyParam: 'shadowmap' },
  { key: 'shadowMaxFar', kind: 'number', min: 400, max: 6400, step: 100, tab: 'shadows' },
  { key: 'pcss', kind: 'boolean', tab: 'shadows' },
  { key: 'contactShadows', kind: 'boolean', tab: 'shadows' },
  { key: 'froxels', kind: 'boolean', tab: 'atmosphere' },
  { key: 'froxelScale', kind: 'number', values: [1, 2], tab: 'atmosphere' },
  { key: 'clouds', kind: 'boolean', tab: 'atmosphere' },
  { key: 'cloudMarchSteps', kind: 'number', min: 8, max: 64, step: 4, tab: 'atmosphere' },
  { key: 'cloudShadowRes', kind: 'number', values: [256, 384, 512, 768, 1024], tab: 'atmosphere' },
  { key: 'caustics', kind: 'boolean', tab: 'atmosphere' },
  { key: 'giProbesPerFrame', kind: 'number', values: [512, 1024, 2048, 3072, 6144], tab: 'effects' },
  { key: 'particleCount', kind: 'number', values: [0, 16384, 32768, 65536, 131072, 262144], tab: 'effects' },
  { key: 'ao', kind: 'boolean', tab: 'effects' },
  { key: 'aoSamples', kind: 'number', min: 4, max: 16, step: 2, tab: 'effects' },
  { key: 'bounce', kind: 'boolean', tab: 'effects' },
  { key: 'taa', kind: 'boolean', tab: 'effects' },
  { key: 'motionBlur', kind: 'boolean', tab: 'effects' },
  { key: 'bloom', kind: 'boolean', tab: 'effects' },
  { key: 'heightRes', kind: 'number', values: [1024, 2048, 4096], tab: 'world' },
  { key: 'simRes', kind: 'number', values: [512, 1024, 2048], tab: 'world' },
  { key: 'erosionIters', kind: 'number', min: 100, max: 1200, step: 50, tab: 'world' },
  { key: 'tileVerts', kind: 'number', values: [33, 49, 65, 81], tab: 'world' },
] as const;

export const QUALITY_LS_KEY = 'laas.quality';

function clampAxis(meta: AxisMeta, v: number): number {
  if (meta.values) {
    // snap to the nearest allowed value
    let best = meta.values[0] ?? 0;
    for (const a of meta.values) if (Math.abs(a - v) < Math.abs(best - v)) best = a;
    return best;
  }
  const lo = meta.min ?? -Infinity;
  const hi = meta.max ?? Infinity;
  return Math.min(hi, Math.max(lo, v));
}

function parseAxis(meta: AxisMeta, raw: string): number | boolean | null {
  if (meta.kind === 'boolean') {
    if (raw === '1' || raw === 'true' || raw === 'on') return true;
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? clampAxis(meta, n) : null;
}

export function presetOf(search: string = globalThis.location?.search ?? ''): QualityPreset {
  const raw = new URLSearchParams(search).get('preset') ?? 'high';
  return raw === 'min' || raw === 'low' || raw === 'mid' || raw === 'ultra'
    ? raw
    : 'high';
}

/** the stored user overrides (Settings UI writes these); {} when none */
export function storedOverrides(): Partial<QualitySettings> {
  try {
    const raw = globalThis.localStorage?.getItem(QUALITY_LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<QualitySettings> = {};
    for (const meta of QUALITY_META) {
      const v = obj[meta.key];
      if (meta.kind === 'boolean' && typeof v === 'boolean') {
        (out as Record<string, unknown>)[meta.key] = v;
      } else if (meta.kind === 'number' && typeof v === 'number' && Number.isFinite(v)) {
        (out as Record<string, unknown>)[meta.key] = clampAxis(meta, v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function storeOverrides(o: Partial<QualitySettings>): void {
  try {
    if (Object.keys(o).length === 0) globalThis.localStorage?.removeItem(QUALITY_LS_KEY);
    else globalThis.localStorage?.setItem(QUALITY_LS_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable — ignore */
  }
}

let cached: QualitySettings | null = null;
let cachedSearch: string | null = null;

/**
 * Resolve the effective quality snapshot. Cached per search string —
 * consumers read constants at module/scene build time and MUST all see the
 * same values within one boot.
 */
export function quality(search: string = globalThis.location?.search ?? ''): QualitySettings {
  if (cached && cachedSearch === search) return cached;
  const q = new URLSearchParams(search);
  const preset = presetOf(search);
  const out: QualitySettings = { ...PRESETS[preset] };

  // 2) user settings from localStorage — unless the run opts out (?q.ls=0;
  //    harness/probe runs do, so a saved custom profile can never poison a
  //    measurement or a reproducible screenshot URL)
  if (q.get('q.ls') !== '0') {
    Object.assign(out, storedOverrides());
  }

  // 3) URL overrides win — ?q.<axis>= first, then legacy aliases
  for (const meta of QUALITY_META) {
    const raw = q.get(`q.${meta.key}`) ?? (meta.legacyParam ? q.get(meta.legacyParam) : null);
    if (raw === null) continue;
    const v = parseAxis(meta, raw);
    if (v !== null) (out as unknown as Record<string, unknown>)[meta.key] = v;
  }

  // grassScale must divide the 3072 base grid into an integer
  if (3072 % out.grassScale !== 0) out.grassScale = 2;

  cached = out;
  cachedSearch = search;
  return out;
}

/** test-only: drop the cache (quality() is otherwise boot-constant) */
export function resetQualityCache(): void {
  cached = null;
  cachedSearch = null;
}
