/**
 * cockpitVelU — TRAA velocity seam for the view-locked cockpit.
 *
 * PostStack's TRAA consumes analytic camera reprojection from depth —
 * exact for the static world, WRONG for geometry that rides with the
 * camera (assessment §2.6/§5.5): every camera move predicts world-motion
 * for cockpit pixels, TRAA samples history from the wrong place → smear.
 *
 * Fix: pixels closer than `maxDist` (the cockpit bound; the world is
 * essentially never < 1.35 m from the eye at ride height) reproject
 * through the cockpit rig's own prev/cur transform instead of the
 * world-static assumption. Cockpit.ts writes these each frame; PostStack
 * reads them inside velReproject. `on` gates the branch to ride mode so
 * walk/fly frames keep the pure camera path.
 *
 * Module singleton (runiform), same pattern as windU/sunU.
 */

import { Matrix4 } from 'three';
import { runiform } from '../../gpu/RenderUniform';

export const cockpitVelU = {
  /** inverse of the cockpit root's CURRENT worldMatrix */
  curInv: runiform(new Matrix4()),
  /** cockpit root's PREVIOUS-frame worldMatrix */
  prev: runiform(new Matrix4()),
  /** 1 while the cockpit is visible (ride mode), else 0 */
  on: runiform(0),
  /** view-distance bound of cockpit geometry (m) */
  maxDist: runiform(1.35),
};
