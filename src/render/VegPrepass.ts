/**
 * Depth prepass for high-overdraw vegetation (Phase 7 perf directive).
 *
 * Meadow grass / forest card crowns shade every covered pixel 2–8× (random
 * draw order defeats early-Z). The classic fix, zero visual change: rasterize
 * the SAME geometry depth-only first, then run the shaded pass with
 * depthFunc=EQUAL so the full lighting model (PCSS taps, BRDF, MRT writes)
 * executes exactly once per visible pixel.
 *
 * Correctness hinges on the two passes discarding the SAME fragments:
 *   - the twin shares the live node graph (positionNode / maskNode /
 *     opacityNode+alphaTest) — identical WGSL expressions on identical
 *     inputs give identical positions and discards (TSL `time` and the
 *     TRAA jitter are per-frame constants, shared by both passes);
 *   - any depth-written-but-color-discarded pixel would z-block whatever
 *     is behind (hole to sky), so a prepass twin is only valid when its
 *     discard chain matches the color material's exactly.
 *
 * The twin uses the base NodeMaterial (no lighting model, color writes
 * masked) — it is a technical depth writer, not a world surface (§9's
 * MeshBasicMaterial ban targets unlit world shading; nothing here shades).
 */

import { EqualDepth, type Material, type Side } from 'three';
import { Mesh, NodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { log } from '../core/Log';

/**
 * Mark every vertex shader's clip-space position `@invariant` (WGSL's
 * depth-prepass tool): without it Metal may fuse/reassociate the position
 * math differently between the depth-only and shaded pipelines, the
 * last-ulp depth mismatch fails depthFunc=EQUAL, and the shaded pass drops
 * out (background showing through blade-shaped holes). The builder class
 * isn't exported from the three/webgpu bundle — take the prototype from a
 * live instance. Cost: only position-expression optimizations are
 * restricted, identically in every pipeline.
 */
export function installPositionInvariance(renderer: WebGPURenderer): void {
  const backend = renderer.backend as unknown as {
    createNodeBuilder(o: object, r: unknown): object;
  };
  const builder = backend.createNodeBuilder(new Mesh(), renderer);
  const proto = Object.getPrototypeOf(builder) as {
    _getWGSLVertexCode(d: unknown): string;
    __laasInvariant?: boolean;
  };
  if (proto.__laasInvariant === true) return;
  proto.__laasInvariant = true;
  const orig = proto._getWGSLVertexCode;
  let warned = false;
  proto._getWGSLVertexCode = function (this: unknown, d: unknown): string {
    const code = orig.call(this, d);
    const patched = code.replace(
      '@builtin( position ) builtinClipSpace',
      '@invariant @builtin( position ) builtinClipSpace',
    );
    // The marker is an exact string from three's WGSL emitter: a silent
    // no-op here disables depth invariance for EVERY pipeline and the
    // prepass EQUAL trick starts dropping fragments world-wide (frost).
    if (patched === code && !warned) {
      warned = true;
      log.warn('laas', 'position-invariance marker NOT FOUND - prepass EQUAL is unsafe');
    }
    return patched;
  };
}

export interface PrepassNodes {
  positionNode: unknown;
  maskNode?: unknown;
  /** alpha-tested cutouts: share opacity chain + threshold */
  opacityNode?: unknown;
  alphaTest?: number;
  side: Side;
}

interface NodeMatShape {
  positionNode: unknown;
  maskNode: unknown;
  opacityNode: unknown;
  colorNode: unknown;
}

/**
 * Build the depth-only twin for `mesh` (sharing its geometry — and with it
 * the indirect-draw slot) and flip the color material to depthFunc=EQUAL.
 * Caller adds the returned mesh to the same group.
 */
export function depthPrepassTwin(mesh: Mesh, nodes: PrepassNodes): Mesh {
  const m = new NodeMaterial();
  const ms = m as unknown as NodeMatShape;
  ms.positionNode = nodes.positionNode;
  if (nodes.maskNode !== undefined) ms.maskNode = nodes.maskNode;
  if (nodes.opacityNode !== undefined) {
    ms.opacityNode = nodes.opacityNode;
    m.alphaTest = nodes.alphaTest ?? 0.5;
  }
  // alpha = colorNode.a × opacity — pin a=1 so the alpha test still sees the
  // cutout. rgb MUST be pinned too: colorWrite=false does not reach every
  // MRT attachment on the WebGPU backend, and the twin's default shading
  // leaked pale sky-lit speckle into the scene at the dither-fade band —
  // the owner's "frost" (bisected 2026-07-16: prepass=0 kills it, every
  // material/visibility toggle does not).
  ms.colorNode = vec4(0, 0, 0, 1);
  m.side = nodes.side;
  m.colorWrite = false;
  m.depthWrite = true;
  m.depthTest = true;

  const twin = new Mesh(mesh.geometry, m);
  twin.frustumCulled = false;
  twin.castShadow = false;
  twin.receiveShadow = false;
  twin.renderOrder = -100; // before all opaque — later draws z-cull against it

  const colorMat = mesh.material as Material;
  colorMat.depthFunc = EqualDepth;
  colorMat.depthWrite = false;
  return twin;
}
