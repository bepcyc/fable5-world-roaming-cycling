/**
 * ?segments=1 — split cpu.submit into PER-RENDER-CONTEXT CPU segments.
 *
 * docs/log/GPU_CPU_ISSUE_CODEX.md §5 P0.2 asks to split post.render() into CPU segments
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

  let acc = new Map<string, { ms: number; self: number; n: number; depth: number }>();
  let index = 0;
  let depth = 0;
  // THE BRACKETS NEST, so a naive sum double-counts and can exceed cpu.submit.
  // Measured: quad0 51.0 ms CONTAINS Scene 48.0 ms, which CONTAINS the four
  // shadow maps (17.2 ms) — because PassNode.updateBefore calls renderer.render()
  // from inside the post quad's own render (PassNode.js:802-869), and the shadow
  // maps render from inside the scene's. Summing those three levels reported
  // 119.7 ms for a 50 ms bracket. So track SELF time too: a context's own cost is
  // its wall time minus the time its children spent inside it.
  const childMs: number[] = [];

  r._renderScene = function patched(scene: SceneLike, camera: CameraLike, useFrameBufferTarget?: boolean): unknown {
    const label = labelFor(scene, camera, index++);
    const myDepth = depth;
    childMs[depth + 1] = 0;
    depth++;
    const t0 = performance.now();
    try {
      return original(scene, camera, useFrameBufferTarget);
    } finally {
      const dt = performance.now() - t0;
      depth--;
      const kids = childMs[depth + 1] ?? 0;
      childMs[depth] = (childMs[depth] ?? 0) + dt; // charge myself to my parent
      const cur = acc.get(label) ?? { ms: 0, self: 0, n: 0, depth: myDepth };
      cur.ms += dt; // inclusive: me + everything nested inside me
      cur.self += dt - kids; // exclusive: my own encoding work
      cur.n += 1;
      acc.set(label, cur);
    }
  };

  return function flush(): void {
    // CLEAR STALE KEYS FIRST. Without this the counters are a LIE, and the first
    // version of this file produced exactly that: boot renders the world in a
    // handful of frames that each issue ~1200 _renderScene calls, so labels like
    // `quad1167` got written once during boot and then LINGERED forever, because
    // a steady-state frame (19 contexts) never overwrites them. Reading the
    // counters later averaged those fossils and reported 13605 ms/frame for a
    // context that no longer exists. A key that is not written THIS frame must
    // not survive into this frame's report.
    for (const k of Object.keys(sink.counters)) {
      if (k.startsWith('seg.')) delete sink.counters[k];
    }
    for (const [label, v] of acc) {
      // x100 to match the existing cpu.updateMs100 / cpu.submitMs100 contract.
      // Ms100 = INCLUSIVE (with nested children), Self100 = EXCLUSIVE (this
      // context's own encoding). Only the Self column is safe to add up.
      sink.counters[`seg.${label}Ms100`] = Math.round(v.ms * 100);
      sink.counters[`seg.${label}Self100`] = Math.round(v.self * 100);
      sink.counters[`seg.${label}Calls`] = v.n;
      sink.counters[`seg.${label}Depth`] = v.depth;
    }
    sink.counters['seg.contexts'] = index;
    acc = new Map();
    index = 0;
    depth = 0;
    childMs.length = 0;
  };
}
