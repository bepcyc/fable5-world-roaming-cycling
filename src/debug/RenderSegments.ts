/**
 * ?segments=1 — split cpu.submit into PER-RENDER-CONTEXT CPU segments.
 *
 * GPU_CPU_ISSUE_CODEX.md §5 P0.2 asks to split post.render() into CPU segments
 * (exposure compute, scene+shadows, half-res MRT, TRAA, bloom, composite, rest).
 *
 * WHY IT SEGMENTS BY RENDER CONTEXT AND NOT BY POST STAGE: our post graph is a
 * TSL node graph, not a call sequence — there is no "bloom()" call at frame time
 * to bracket. What actually exists at frame time is `Renderer._renderScene()`,
 * which EVERY render context funnels through (Renderer.js:1417, ending in
 * `backend.finishRender()` -> its own `queue.submit()` at 1729) and which
 * `_renderQuad` also calls for each full-screen pass (Renderer.js:1841). The
 * measured `render.frameCalls = 19` ARE those calls. Bracketing `_renderScene`
 * therefore attributes CPU to the real submission boundaries — the thing the doc
 * wants to consolidate — instead of to node names that have no frame-time cost.
 *
 * WHAT THE PROFILE ALREADY PROVED (254 frames, tablet, 2026-07-15): the cost
 * inside these brackets is three's per-render-object binding/UBO work —
 * Bindings._update 7.44 + Bindings.updateForRender 6.96 + UniformsGroup.update
 * 4.32 = 18.7 ms/frame = 36% of all JS. Segments say WHICH CONTEXT pays it.
 *
 * COST WHEN OFF: one `if` at install time. The patch is never applied without
 * ?segments=1, so production and the desktop preset are byte-identical.
 *
 * READ THE NUMBERS AS RELATIVE. performance.now() is coarsened by Chrome and the
 * observer effect on this device is REAL and INVERTED (?notimestamp=1 made the
 * app 34.5% SLOWER, commit 236e3ea) — rank the contexts, do not quote absolutes
 * as production ms.
 */

import type { WebGPURenderer } from 'three/webgpu';

interface SceneLike {
  name?: string;
  isQuadMesh?: boolean;
  type?: string;
}
interface CameraLike {
  name?: string;
  isArrayCamera?: boolean;
}

/** Per-frame accumulator, published into stats.counters as `seg.<label>Ms100`. */
export interface SegmentSink {
  counters: Record<string, number>;
}

/** Name a render context by what it actually renders. Quad passes are the post
 *  graph's full-screen stages; a named scene is ours; shadows arrive as our
 *  scene with a shadow camera, so the camera disambiguates. */
function labelFor(scene: SceneLike, camera: CameraLike, index: number): string {
  if (scene.isQuadMesh === true) return `quad${index}`;
  const s = scene.name && scene.name.length > 0 ? scene.name : (scene.type ?? 'scene');
  const c = camera.name && camera.name.length > 0 ? `.${camera.name}` : '';
  return `${s}${c}`;
}

/**
 * Install the segment timer. Returns a per-frame flush to call once the frame's
 * render work is done — it publishes the accumulated segments and resets them.
 */
export function installRenderSegments(renderer: WebGPURenderer, sink: SegmentSink): () => void {
  type RenderScene = (scene: SceneLike, camera: CameraLike, useFrameBufferTarget?: boolean) => unknown;
  const r = renderer as unknown as { _renderScene: RenderScene };
  const original = r._renderScene.bind(renderer);

  let acc = new Map<string, { ms: number; n: number }>();
  let index = 0;

  r._renderScene = function patched(scene: SceneLike, camera: CameraLike, useFrameBufferTarget?: boolean): unknown {
    const label = labelFor(scene, camera, index++);
    const t0 = performance.now();
    try {
      return original(scene, camera, useFrameBufferTarget);
    } finally {
      const dt = performance.now() - t0;
      const cur = acc.get(label) ?? { ms: 0, n: 0 };
      cur.ms += dt;
      cur.n += 1;
      acc.set(label, cur);
    }
  };

  return function flush(): void {
    for (const [label, v] of acc) {
      // x100 to match the existing cpu.updateMs100 / cpu.submitMs100 contract
      sink.counters[`seg.${label}Ms100`] = Math.round(v.ms * 100);
      sink.counters[`seg.${label}Calls`] = v.n;
    }
    sink.counters['seg.contexts'] = index;
    acc = new Map();
    index = 0;
  };
}
