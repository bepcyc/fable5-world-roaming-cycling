/**
 * Back-compat launcher entry + shared LAAS URL builder.
 *
 * The original Phase-0 launcher lived here: it probed Playwright-bundled
 * Chromium (`channel:'chromium'`) recipes and only checked that SOME WebGPU
 * adapter came up. That body predates Linux — on this box it could silently
 * hand tools a SwiftShader software adapter that looks alive, which is why
 * tools/launch-gpu.ts was written: it probes system-browser recipes and
 * VERIFIES the adapter is a real GPU. Half the tools had already migrated by
 * aliasing `launchWebGPUReal as launchWebGPU` per file; the other half were
 * still on the unverified path here. launchWebGPU() now simply delegates, so
 * every tool gets the GPU-verified launcher no matter which module it
 * imports from. The secure-context lesson (probe on http://localhost, never
 * about:blank — navigator.gpu is absent on opaque origins) lives on in
 * launch-gpu.ts.
 */

import type { Browser } from 'playwright';
import { type AdapterInfo, LAAS_ORIGIN, launchWebGPUReal } from './launch-gpu';

export { LAAS_ORIGIN };

/** Back-compat entry — delegates to the GPU-verified launcher (launch-gpu.ts). */
export async function launchWebGPU(): Promise<{ browser: Browser; info: AdapterInfo }> {
  return launchWebGPUReal();
}

export interface LaasPageOptions {
  scene?: string;
  seed?: number;
  T?: number;
  cam?: string;
  preset?: string;
  hud?: boolean;
  freeze?: boolean;
  width?: number;
  height?: number;
  extra?: Record<string, string>;
}

export function laasUrl(opts: LaasPageOptions, base = `${LAAS_ORIGIN}/`): string {
  const q = new URLSearchParams();
  if (opts.scene) q.set('scene', opts.scene);
  if (opts.seed !== undefined) q.set('seed', String(opts.seed));
  if (opts.T !== undefined) q.set('T', String(opts.T));
  if (opts.cam) q.set('cam', opts.cam);
  if (opts.preset) q.set('preset', opts.preset);
  q.set('hud', opts.hud ? '1' : '0');
  if (opts.freeze !== false) q.set('freeze', '1');
  for (const [k, v] of Object.entries(opts.extra ?? {})) q.set(k, v);
  return `${base}?${q.toString()}`;
}
