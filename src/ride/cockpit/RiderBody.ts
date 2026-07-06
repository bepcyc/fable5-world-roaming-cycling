/**
 * RiderBody — low-poly rider imported and posed ONCE (M1.5.3 pivot).
 *
 * Owner decision 2026-07-04: procedural hand synthesis is dead-ended
 * ("кривые культи"); import a ready rigged mesh, pose it in CODE around
 * the bar (contact by construction), freeze forever. Aesthetic direction:
 * low-poly rider (+ later low-poly cockpit), detail stays on the computer.
 *
 * Asset: "Adventurer" by Quaternius (poly.pizza/m/5EGWBMpuXq), CC0 /
 * public domain. Rigged, ~10k tris, articulated fingers on both hands.
 * Served from /rider/adventurer.glb (public/).
 *
 * Approach: load GLB → hide head (camera sits in its eyes) + backpack →
 * lean the spine, two-bone-IK both arms onto the grip targets, curl the
 * fingers around the tube axis, fold the legs toward the pedals → the
 * skeleton is then NEVER touched again (static pose; skinning runs but
 * the pose is frozen — bake to static geometry is a later perf pass).
 *
 * Iteration discipline: pose constants below are JUDGED BY SCREENSHOT
 * against owner references (iron rules #0/#1/#2) — expect refinement.
 */

import {
  Bone,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ---- pose targets (cockpit-root = eye space; -Z forward, +Y up) -------- */

/** grip targets per side (road hoods; steer space folded in already) */

export interface GripSpec {
  /** road hood body center, cockpit-root space (right side; left mirrors) */
  hoodR: Vector3;
  /** hood body axis (points forward-down, right side) */
  hoodDir: Vector3;
  /** hood capsule radius */
  hoodRad: number;
  /** brake lever blade segment (right side, root space; left mirrors) —
   *  fingertips drape past the hood nose and close onto the LEVER */
  leverA: Vector3;
  leverB: Vector3;
  leverRad: number;
  /** hood horn (front pommel sphere) — part of the grip solid so the hand
   *  drapes onto/around it instead of leaving it standing proud */
  hornC: Vector3;
  hornRad: number;
  /** the REAL bar tube (bend + drop polyline, root space) the fingers wrap
   *  — MUST be in the grip solid or the wrap solver lets fingers pass
   *  straight THROUGH the visible bar. Consecutive points = capsules. */
  dropPts: Vector3[];
  barR: number;
}
/** hips anchor in eye space — scooted onto the saddle NOSE (riders do
 *  exactly this on the hoods; also buys reach: v14 sat 7 cm too far back
 *  for the Adventurer's short arms) */
const HIPS_POS = new Vector3(0, -0.54, 0.27);
/** spine forward-lean per joint (rad, about +X) — road posture ~45° */
const LEAN = { abdomen: 0.42, torso: 0.38, chest: 0.22 };

/** IK pole hint: elbows slightly down and out (v2: -1 sank the forearms
 *  below the frame edge — road posture keeps elbows soft, not dropped) */
const ELBOW_HINT = new Vector3(0.3, -0.35, 0.15);

interface ArmBones {
  upper: Bone;
  lower: Bone;
  wrist: Bone;
}

function bone(root: Object3D, name: string): Bone | null {
  const o = root.getObjectByName(name);
  return o instanceof Bone ? o : null;
}

const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();

/** Rotate `b` (in its own local frame) so the world direction toward
 *  `childW` becomes the world direction toward `targetW`. Rig-agnostic:
 *  no assumption about which local axis runs along the bone. */
function aimBone(b: Bone, childW: Vector3, targetW: Vector3): void {
  b.updateWorldMatrix(true, false);
  const bw = _v0.setFromMatrixPosition(b.matrixWorld);
  const cur = _v1.copy(childW).sub(bw).normalize();
  const des = _v2.copy(targetW).sub(bw).normalize();
  b.getWorldQuaternion(_q);
  _qi.copy(_q).invert();
  cur.applyQuaternion(_qi);
  des.applyQuaternion(_qi);
  _q.setFromUnitVectors(cur, des);
  b.quaternion.multiply(_q);
}

/** Two-bone analytic IK: place the wrist at `targetW` (in world/group
 *  space), elbow biased toward `poleW`. Falls back to full extension when
 *  the target is out of reach. */
function solveArm(arm: ArmBones, targetW: Vector3, poleDir: Vector3): void {
  arm.upper.updateWorldMatrix(true, true);
  const s = new Vector3().setFromMatrixPosition(arm.upper.matrixWorld);
  const e = new Vector3().setFromMatrixPosition(arm.lower.matrixWorld);
  const w = new Vector3().setFromMatrixPosition(arm.wrist.matrixWorld);
  const l1 = s.distanceTo(e);
  const l2 = e.distanceTo(w);
  const toT = new Vector3().copy(targetW).sub(s);
  const d = Math.min(toT.length(), (l1 + l2) * 0.999);
  toT.normalize();
  // elbow position: law of cosines in the (shoulder→target, pole) plane
  const a1 = Math.acos(
    Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))),
  );
  const side = new Vector3()
    .copy(poleDir)
    .addScaledVector(toT, -poleDir.dot(toT))
    .normalize();
  const elbowW = new Vector3()
    .copy(s)
    .addScaledVector(toT, Math.cos(a1) * l1)
    .addScaledVector(side, Math.sin(a1) * l1);
  aimBone(arm.upper, e, elbowW);
  arm.upper.updateWorldMatrix(true, true);
  const w2 = new Vector3().setFromMatrixPosition(arm.wrist.matrixWorld);
  aimBone(arm.lower, w2, targetW);
}

/** Rotate `b` in world space by quaternion `dqW` (local-frame conversion). */
function rotateBoneWorld(b: Bone, dqW: Quaternion): void {
  b.updateWorldMatrix(true, false);
  b.getWorldQuaternion(_q);
  _qi.copy(_q).invert();
  // local delta = inv(parentWorld→boneWorld) ∘ dqW ∘ (boneWorld)
  const local = new Quaternion().copy(_qi).multiply(dqW).multiply(_q);
  b.quaternion.multiply(local);
}

/**
 * Orient the wrist so the fingers run along `fingerDirW` and the palm
 * faces `palmNormalW` — derived from the REAL bone layout (Wrist→Middle1 =
 * finger direction; (Index1−Pinky1)×fingers = palm normal), so no
 * guessing about the rig's local axes.
 */
function orientWrist(
  root: Object3D,
  side: 'L' | 'R',
  fingerDirW: Vector3,
  palmNormalW: Vector3,
): void {
  const wrist = bone(root, `Wrist${side}`);
  // reference bones: use MID-finger segments, not the metacarpal bases —
  // Index1/Middle1/Pinky1 sit millimetres from the wrist and give a
  // degenerate basis (v10 debug: fingers matched the target while the
  // visible palm pointed at the camera)
  const idx = bone(root, `Index2${side}`);
  const mid = bone(root, `Middle3${side}`);
  const pnk = bone(root, `Pinky2${side}`);
  if (!wrist || !idx || !mid || !pnk) return;
  root.updateWorldMatrix(true, true);
  const wp = new Vector3().setFromMatrixPosition(wrist.matrixWorld);
  const mp = new Vector3().setFromMatrixPosition(mid.matrixWorld);
  const ip = new Vector3().setFromMatrixPosition(idx.matrixWorld);
  const pp = new Vector3().setFromMatrixPosition(pnk.matrixWorld);
  const fCur = mp.sub(wp).normalize();
  // palm normal: right hand = (index−pinky)×fingers, left mirrors
  const across = ip.sub(pp);
  const nCur = new Vector3().crossVectors(across, fCur).normalize();
  // NOTE: no L-mirror here — Adventurer's left-hand bone layout keeps the
  // same index→pinky chirality as the right (verified by frame v8: with a
  // negate the left palm faced up and the hand fell under the bar)
  // step 1: swing fingers onto the target line
  const q1 = new Quaternion().setFromUnitVectors(fCur, fingerDirW.clone().normalize());
  rotateBoneWorld(wrist, q1);
  // step 2: twist about the finger axis until the palm faces the target
  const nAfter = nCur.clone().applyQuaternion(q1);
  const f = fingerDirW.clone().normalize();
  const nT = palmNormalW.clone().addScaledVector(f, -palmNormalW.dot(f)).normalize();
  const nA = nAfter.addScaledVector(f, -nAfter.dot(f)).normalize();
  const cos = Math.max(-1, Math.min(1, nA.dot(nT)));
  const sin = new Vector3().crossVectors(nA, nT).dot(f);
  const q2 = new Quaternion().setFromAxisAngle(f, Math.atan2(sin, cos));
  rotateBoneWorld(wrist, q2);
  // TEMP debug (removed after pose accepted): verify the wrist really took
  // the requested orientation
  root.updateWorldMatrix(true, true);
  const wp2 = new Vector3().setFromMatrixPosition(wrist.matrixWorld);
  const mp2 = new Vector3().setFromMatrixPosition(mid.matrixWorld).sub(wp2).normalize();
  console.log(
    `[rider] wrist${side} fingers want(${fingerDirW.x.toFixed(2)},${fingerDirW.y.toFixed(2)},${fingerDirW.z.toFixed(2)})` +
    ` got(${mp2.x.toFixed(2)},${mp2.y.toFixed(2)},${mp2.z.toFixed(2)}) twist=${Math.atan2(sin, cos).toFixed(2)}`,
  );
}

/** Curl one finger chain about the (world) grip axis. */
function curlChain(root: Object3D, names: string[], axisW: Vector3, rad: number): void {
  for (const nm of names) {
    const b = bone(root, nm);
    if (!b) continue;
    b.updateWorldMatrix(true, false);
    b.getWorldQuaternion(_q);
    _qi.copy(_q).invert();
    const axisL = _v0.copy(axisW).applyQuaternion(_qi).normalize();
    _q.setFromAxisAngle(axisL, rad);
    b.quaternion.multiply(_q);
  }
}

/** clearance of a world point to the hood capsule surface (same math as
 *  tools/probe-grip.ts: distance to the SEGMENT-clamped axis − radius −
 *  flesh). Negative = the bone center is inside flesh contact. */
const HOOD_T_MIN = -0.025;
const HOOD_T_MAX = 0.045;
const R_FLESH = 0.008;
function hoodGap(pW: Vector3, hoodCW: Vector3, hoodAxisW: Vector3, rad: number): number {
  _v0.copy(pW).sub(hoodCW);
  const tRaw = _v0.dot(hoodAxisW);
  const t = Math.max(HOOD_T_MIN, Math.min(HOOD_T_MAX, tRaw));
  _v1.copy(_v0).addScaledVector(hoodAxisW, -t);
  // TRUE segment distance: beyond the caps the axial residual counts too
  // (perp-only faked −14 mm "penetration" for fingertips past the nose)
  return Math.hypot(_v1.length(), tRaw - t) - rad - R_FLESH;
}

/** clearance to an arbitrary capsule given by endpoints (world) */
function segGap(pW: Vector3, aW: Vector3, bW: Vector3, rad: number): number {
  _v0.copy(bW).sub(aW);
  const len2 = _v0.lengthSq();
  _v1.copy(pW).sub(aW);
  const t = len2 > 0 ? Math.max(0, Math.min(1, _v1.dot(_v0) / len2)) : 0;
  _v1.addScaledVector(_v0, -t);
  return _v1.length() - rad - R_FLESH;
}

/**
 * Contact-driven flexion: rotate `b` about the (world) bend axis until the
 * MIDPOINT of the phalanx (bone origin → `probe` joint) reaches `gapTarget`
 * above the hood capsule — the segment kisses the surface tangentially, so
 * the finger wraps the hood BY CONSTRUCTION instead of by a hand-tuned
 * scalar (and a long middle finger stops early instead of diving its next
 * joint past the hood nose). Linear scan for the first crossing (no
 * monotonicity assumption). Returns the angle used.
 */
function curlToContact(
  b: Bone,
  probe: Bone,
  axisW: Vector3,
  solid: (p: Vector3) => number,
  gapTarget: number,
  maxRad: number,
  opts: { autoDir?: boolean; probeMid?: boolean } = {},
): number {
  const probeMid = opts.probeMid !== false;
  b.updateWorldMatrix(true, false);
  b.getWorldQuaternion(_q);
  _qi.copy(_q).invert();
  // NOT the shared _v0 scratch — probeGap→solid() overwrites it per step
  const axisL = axisW.clone().applyQuaternion(_qi).normalize();
  const qBase = b.quaternion.clone();
  const mid = new Vector3();
  const probeGap = (theta: number): number => {
    b.quaternion.copy(qBase).multiply(_q.setFromAxisAngle(axisL, theta));
    probe.updateWorldMatrix(true, false);
    mid.setFromMatrixPosition(probe.matrixWorld);
    if (!probeMid) return solid(mid);
    // the phalanx stops at its FIRST contact anywhere along the segment:
    // min of endpoint and midpoint clearance (midpoint alone let a
    // tangent-kissed phalanx sink its far joint 13 mm into the flank)
    const gEnd = solid(mid);
    mid.add(_v2.setFromMatrixPosition(b.matrixWorld)).multiplyScalar(0.5);
    return Math.min(gEnd, solid(mid));
  };
  if (opts.autoDir) {
    // bind-pose axes differ per side/finger — pick the rotation sense the
    // scan direction expects: flex scans POSITIVE toward contact, the
    // extend branch scans NEGATIVE away from it
    const g0 = probeGap(0);
    const gPlus = probeGap(0.05);
    if (g0 > gapTarget ? gPlus >= g0 : gPlus > g0) {
      axisL.negate();
    }
  }
  let used = 0;
  if (probeGap(0) <= gapTarget) {
    // already at/inside the target — EXTEND until clear (a one-way
    // flexion scan can never lift a phalanx the cup/seat left too deep)
    for (let theta = -0.02; theta >= -0.7; theta -= 0.02) {
      used = theta;
      if (probeGap(theta) >= gapTarget) break;
    }
  } else {
    // flex toward contact; if the solid is out of the orbit's reach stop
    // at the CLOSEST approach instead of balling into a mid-air claw
    let bestTheta = 0;
    let bestGap = Infinity;
    let crossed = false;
    for (let theta = 0; theta <= maxRad + 1e-6; theta += 0.02) {
      const g = probeGap(theta);
      if (g < bestGap) {
        bestGap = g;
        bestTheta = theta;
      }
      if (g <= gapTarget) {
        used = theta;
        crossed = true;
        break;
      }
    }
    if (!crossed) used = bestTheta;
  }
  probeGap(used);
  return used;
}

/**
 * Load + pose + attach the rider under `parent` (a cockpit mode group —
 * shares the eye-anchored cockpit space). Async fire-and-forget: the
 * cockpit builds sync; the rider pops in when the GLB lands (~2 MB).
 */
/** parametric arm pose — the search space for the numeric grip optimizer */
export interface PoseParams {
  handAlong: number;
  palmPad: number;
  curl: number;
  curlTip: number;
  /** extra twist about the finger axis after palm alignment (rad) */
  twist: number;
  /** grip-frame pitch about the palm transverse axis (rad) */
  pitch: number;
  /** knuckle-row seat bias ALONG the hood axis (m): negative = behind the
   *  hood center, positive = forward toward the horn/nose. Advancing the
   *  seat walks the hand's web onto the horn (ref: hand embraces it). */
  seatAlong?: number;
  /** knuckle-row seat LIFT off the surface (m): raises the row above the
   *  hood so the back of the hand rides over the front pommel/horn */
  seatLift?: number;
  /** HAMMER-GRIP ROLL (rad) about the hood axis: 0 = palm flat on top
   *  (bar-hang — the WRONG class, sessions 11-12), ~1.1 = palm rolled onto
   *  the OUTER face so the fist closes around the hood laterally — fingers
   *  over the top and down the INNER face, thumb opposing below, web on the
   *  horn. This is the owner's «хват молотка», the reference grip class. */
  roll?: number;
}
// v15 semantics (contact-driven wrap): handAlong/palmPad seed the wrist
// target (the MCP self-centering passes converge it onto the hood), curl =
// minimum flexion floor (a dead-straight phalanx reads robotic), curlTip =
// distal/middle tendon ratio, twist = outward palm roll, pitch = hand
// nose-down over the hood hump. Wrap angles themselves are SOLVED against
// the hood capsule per finger per side — not tuned here.
/** Named grip presets (owner, 2026-07-04): the target grip is `hammer`
 *  (обхват капюшона кулаком, перепонка на горбе); `straight` is the
 *  roll≈0.95 pose the owner liked as a separate «прямой хват» — kept
 *  switchable for the future (dbg.riderGrip.applyPreset / future UI). */
export const GRIP_PRESETS: Record<'hammer' | 'straight', PoseParams> = {
  hammer: {
    handAlong: 0.0525,
    palmPad: 0.004,
    curl: 0.22,
    curlTip: 0.85,
    twist: 0.15,
    pitch: 0.08,
    seatAlong: 0.012,
    seatLift: 0,
    roll: 1.05,
  },
  straight: {
    // frozen from the roll-sweep frame the owner approved (sweep-roll-1):
    // ck-pose-sweep BASE of 2026-07-04 + roll=0.95, seat at hood center
    handAlong: 0.0525,
    palmPad: 0.004,
    curl: 0.15,
    curlTip: 0.85,
    twist: 0.15,
    pitch: 0.08,
    seatAlong: -0.005,
    seatLift: 0,
    roll: 0.95,
  },
};
const DEFAULT_POSE: PoseParams = GRIP_PRESETS.hammer;

const ARM_BONES = (() => {
  // spine bones included: poseArms adds REACH lean on top of the base
  // road lean, so the rest snapshot must capture the leaned spine for
  // applyPose to stay idempotent
  const names: string[] = ['Abdomen', 'Torso', 'Chest'];
  for (const side of ['L', 'R']) {
    for (const b of ['Shoulder', 'UpperArm', 'LowerArm', 'Wrist']) names.push(`${b}${side}`);
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky'])
      for (const i of [1, 2, 3, 4]) names.push(`${f}${i}${side}`);
    for (const i of [1, 2, 3]) names.push(`Thumb${i}${side}`);
  }
  return names;
})();

/** pose both arms/hands from the grip spec + params (idempotent only after
 *  a rest-pose reset — rotations are cumulative). `root` = cockpit root:
 *  targets/directions are given in root space and converted to WORLD here,
 *  so posing works identically whether the cockpit sits at the world
 *  origin or is riding at (500, 408, −390). */
interface GripFrame {
  sgn: number;
  target: Vector3;
  fingerDir: Vector3;
  palmNormal: Vector3;
  bendAxis: Vector3;
  hoodCW: Vector3;
  hoodAxisW: Vector3;
  latW: Vector3;
  pole: Vector3;
  /** clearance to the grip solid = hood capsule ∪ brake lever blade */
  solid: (p: Vector3) => number;
}

function poseArms(root: Object3D, rig: Object3D, grip: GripSpec, p: PoseParams): void {
  root.updateWorldMatrix(true, true);
  rig.updateWorldMatrix(true, true);
  const rootQ = new Quaternion();
  root.getWorldQuaternion(rootQ);
  // grip frame from the REAL hood line (by construction): fingers along
  // the hood axis, palm normal = world-down ⊥ axis, both tilted by pitch
  const gripFrame = (side: 'L' | 'R'): GripFrame => {
    const sgn = side === 'L' ? -1 : 1;
    const hood = grip.hoodR.clone();
    hood.x = sgn * Math.abs(hood.x);
    const fingerDir = grip.hoodDir.clone();
    fingerDir.x *= sgn;
    fingerDir.normalize();
    const down = new Vector3(0, -1, 0);
    const palmNormal = down
      .clone()
      .addScaledVector(fingerDir, -down.dot(fingerDir))
      .normalize();
    // HAMMER-GRIP ROLL: rotate the palm normal about the hood axis from
    // pure-down toward INBOARD — the palm lands on the hood's outer face,
    // the fist closes AROUND it (thumb opposition) instead of hanging on
    // top (bar-hang, the wrong grip class of sessions 11-12). +sgn·roll
    // moves "down" toward −x on the right / +x on the left (verified:
    // axis≈−z, (0,0,−1)×(0,−1,0)=(−1,0,0)).
    const roll = p.roll ?? 0;
    if (roll !== 0) {
      const qr = new Quaternion().setFromAxisAngle(fingerDir, sgn * roll);
      palmNormal.applyQuaternion(qr);
    }
    const bendAxis = new Vector3().crossVectors(fingerDir, palmNormal).normalize();
    // capsule axis for contact math stays UNPITCHED (it is the real hood);
    // pitch tilts only the hand frame
    const hoodAxisW = fingerDir.clone().applyQuaternion(rootQ).normalize();
    if (p.pitch !== 0) {
      const qp = new Quaternion().setFromAxisAngle(bendAxis, p.pitch);
      fingerDir.applyQuaternion(qp);
      palmNormal.applyQuaternion(qp);
    }
    // wrist target: back along fingers, off the surface by radius + pad —
    // the PALM (not the wrist) lands on the hood. Convert root → WORLD.
    const target = hood
      .clone()
      .addScaledVector(fingerDir, -p.handAlong)
      .addScaledVector(palmNormal, -(grip.hoodRad + p.palmPad));
    root.localToWorld(target);
    const hoodCW = root.localToWorld(hood.clone());
    fingerDir.applyQuaternion(rootQ);
    palmNormal.applyQuaternion(rootQ);
    bendAxis.applyQuaternion(rootQ);
    const latW = new Vector3().crossVectors(hoodAxisW, palmNormal).normalize();
    const pole = ELBOW_HINT.clone();
    pole.x *= sgn;
    pole.applyQuaternion(rootQ);
    const mirror = (v: Vector3): Vector3 => {
      const m = v.clone();
      m.x *= sgn;
      return root.localToWorld(m);
    };
    const leverAW = mirror(grip.leverA);
    const leverBW = mirror(grip.leverB);
    // the REAL bar tube (bend + drop): fingers wrap AROUND it instead of
    // passing through — the visible tube MUST be in the solid (owner:
    // "рука проходит сквозь руль"; skill: model the whole solid).
    const dropW = grip.dropPts.map(mirror);
    // HORN is back in the solid (session 13): with the hammer-grip roll the
    // fingers wrap the hood body LATERALLY (not down over the nose), so the
    // horn is an obstacle the web rests against — in the solid it keeps the
    // wrap from clipping the restored pommel. (Session 12's 24 mm dig only
    // happened with the DOWN-curling bar-hang scan.)
    const hornCW = mirror(grip.hornC);
    const solid = (pW: Vector3): number => {
      let g = Math.min(
        hoodGap(pW, hoodCW, hoodAxisW, grip.hoodRad),
        segGap(pW, leverAW, leverBW, grip.leverRad),
        pW.distanceTo(hornCW) - grip.hornRad - R_FLESH,
      );
      for (let i = 0; i + 1 < dropW.length; i++)
        g = Math.min(g, segGap(pW, dropW[i] as Vector3, dropW[i + 1] as Vector3, grip.barR));
      return g;
    };
    return { sgn, target, fingerDir, palmNormal, bendAxis, hoodCW, hoodAxisW, latW, pole, solid };
  };
  const frames = { L: gripFrame('L'), R: gripFrame('R') };

  // ---- reach (v14 ROOT CAUSE): Adventurer's arms are ~15 cm too short
  // for the hood targets — solveArm silently clamped and the hands fell
  // back onto the bar tops (wrist measured 172–176 mm behind the hood
  // center). Reach is composed honestly: hips scooted to the saddle nose
  // (HIPS_POS), then a PROGRESS-GUARDED forward hinge of the invisible
  // torso (≤0.35 rad — hood-riding back angle), then the residual deficit
  // is taken by lengthening the stylized short arms toward adult road
  // proportions (first person shows forearms only).
  const reachDeficit = (): number => {
    rig.updateWorldMatrix(true, true);
    let worst = 0;
    for (const side of ['L', 'R'] as const) {
      const up = bone(rig, `UpperArm${side}`);
      const lo = bone(rig, `LowerArm${side}`);
      const wr = bone(rig, `Wrist${side}`);
      if (!up || !lo || !wr) continue;
      const s = new Vector3().setFromMatrixPosition(up.matrixWorld);
      const e = new Vector3().setFromMatrixPosition(lo.matrixWorld);
      const w = new Vector3().setFromMatrixPosition(wr.matrixWorld);
      const reach = s.distanceTo(e) + e.distanceTo(w);
      worst = Math.max(worst, s.distanceTo(frames[side].target) - reach * 0.93);
    }
    return worst;
  };
  const abdomen = bone(rig, 'Abdomen');
  let hinged = 0;
  let prevWorst = Infinity;
  while (abdomen && hinged < 0.35) {
    const worst = reachDeficit();
    if (worst <= 0.005 || worst >= prevWorst - 0.002) break;
    prevWorst = worst;
    const step = Math.min(0.07, worst * 0.5, 0.35 - hinged);
    abdomen.rotateX(step);
    hinged += step;
  }
  {
    const worst = reachDeficit();
    if (worst > 0.005) {
      const upL = bone(rig, 'UpperArmL');
      const upR = bone(rig, 'UpperArmR');
      if (upL && upR) {
        // symmetric fit: worst side dictates, both arms stay equal;
        // multiplicative fixpoint keeps applyPose idempotent (scale is
        // not part of the rest snapshot)
        let factor = 1;
        for (const [up, lo, wr] of [
          [upL, bone(rig, 'LowerArmL'), bone(rig, 'WristL')],
          [upR, bone(rig, 'LowerArmR'), bone(rig, 'WristR')],
        ] as const) {
          if (!lo || !wr) continue;
          const s = new Vector3().setFromMatrixPosition(up.matrixWorld);
          const e = new Vector3().setFromMatrixPosition(lo.matrixWorld);
          const w = new Vector3().setFromMatrixPosition(wr.matrixWorld);
          const side = up === upL ? 'L' : 'R';
          const reach = s.distanceTo(e) + e.distanceTo(w);
          factor = Math.max(factor, s.distanceTo(frames[side].target) / (reach * 0.93));
        }
        for (const up of [upL, upR]) {
          const s = Math.min(factor, 1.5 / up.scale.x);
          if (s <= 1.001) continue;
          up.scale.multiplyScalar(s);
          // arms lengthen, the HAND does not: counter-scale at the wrist
          // (×1.5 hands read as giant paws over the hoods)
          const wr = bone(rig, up === upL ? 'WristL' : 'WristR');
          if (wr) wr.scale.multiplyScalar(1 / s);
        }
      }
    }
  }

  for (const side of ['L', 'R'] as const) {
    const upper = bone(rig, `UpperArm${side}`);
    const lower = bone(rig, `LowerArm${side}`);
    const wrist = bone(rig, `Wrist${side}`);
    if (!upper || !lower || !wrist) {
      console.error(`[rider] arm bones missing for side ${side} — pose skipped`);
      continue;
    }
    const { sgn, target, fingerDir, palmNormal, bendAxis, hoodAxisW, latW, pole, solid } =
      frames[side];
    const { hoodCW } = frames[side];
    // ---- seat the palm: IK + wrist orient, then MEASURE where the MCP
    // knuckle row actually landed and re-target — self-centering absorbs
    // per-side bind-pose offsets instead of hand-tuned constants
    // (v14 defect: hands perched behind/outside the hoods). Seat by the
    // CENTRAL knuckles: mean-seating the flat row dug them −12 mm into
    // the round capsule while the outer pair floated
    const mcpNames = ['Middle2', 'Ring2'];
    for (let pass = 0; pass < 3; pass++) {
      solveArm({ upper, lower, wrist }, target, pole);
      orientWrist(rig, side, fingerDir, palmNormal);
      if (p.twist !== 0) {
        rotateBoneWorld(wrist, new Quaternion().setFromAxisAngle(fingerDir, sgn * p.twist));
      }
      rig.updateWorldMatrix(true, true);
      const mcp = new Vector3();
      let n = 0;
      for (const nm of mcpNames) {
        const b = bone(rig, `${nm}${side}`);
        if (!b) continue;
        mcp.add(_v0.setFromMatrixPosition(b.matrixWorld));
        n++;
      }
      if (n === 0) break;
      mcp.multiplyScalar(1 / n);
      // knuckle row belongs just behind the hood center, laterally
      // centered, and SEATED — the central knuckles kiss the solid at
      // +2 mm (height was unconstrained before: the left row sat 16 mm
      // deep while the metric's mean looked fine). seatAlong walks the row
      // forward toward the horn; seatLift raises it to ride over the pommel
      const seatAlong = p.seatAlong ?? -0.005;
      const seatLift = p.seatLift ?? 0;
      const heightErr = solid(mcp) - 0.002 - seatLift;
      const err = mcp.sub(hoodCW);
      const alongErr = err.dot(hoodAxisW) - seatAlong;
      const latErr = err.dot(latW);
      if (Math.abs(alongErr) < 0.002 && Math.abs(latErr) < 0.002 && Math.abs(heightErr) < 0.002)
        break;
      target
        .addScaledVector(hoodAxisW, -alongErr)
        .addScaledVector(latW, -latErr)
        .addScaledVector(palmNormal, heightErr);
    }
    // ---- level the knuckle row about the finger axis: the bind palm is
    // not flat and not L/R-symmetric — a residual wrist ROLL left one
    // ring knuckle 12–16 mm deep while the other hand's floated. Solve
    // the roll so the RING knuckle kisses the solid (the middle knuckle
    // sits near the roll axis and barely moves).
    {
      const ring2 = bone(rig, `Ring2${side}`);
      if (ring2)
        curlToContact(wrist, ring2, fingerDir, solid, 0.002, 0.35, {
          autoDir: true,
          probeMid: false,
        });
    }
    // ---- parallel phalanges: the metacarpal fan STAYS (all four seg-1
    // pivots share one point at the wrist — the fan IS the knuckle
    // spacing); each finger's phalanx ray (seg2→seg3) is yawed onto the
    // hood axis in the palm plane so the fingers drape parallel, like the
    // reference, instead of splaying
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
      const a = bone(rig, `${f}2${side}`);
      const b = bone(rig, `${f}3${side}`);
      if (!a || !b) continue;
      a.updateWorldMatrix(true, true);
      b.updateWorldMatrix(true, false);
      const dir = _v0
        .setFromMatrixPosition(b.matrixWorld)
        .sub(_v1.setFromMatrixPosition(a.matrixWorld));
      dir.addScaledVector(palmNormal, -dir.dot(palmNormal)).normalize();
      const fwd = _v1.copy(fingerDir).addScaledVector(palmNormal, -fingerDir.dot(palmNormal)).normalize();
      const yaw = Math.atan2(_v2.crossVectors(dir, fwd).dot(palmNormal), dir.dot(fwd));
      curlChain(rig, [`${f}2${side}`], palmNormal, yaw);
    }
    // ---- conform the hand to the grip solid, row by row, PER FINGER —
    // every constant-based variant failed one hand or one finger (the
    // Adventurer bind pose is not L/R symmetric):
    // • CUP: each metacarpal rolls about the finger axis (auto direction)
    //   until its KNUCKLE kisses the solid — the palm wraps the tube;
    // • θ2: each proximal phalanx flexes until its midpoint kisses;
    // • θ3: each middle phalanx flexes to a −2 mm flesh press;
    // • θ4: distal follows its own PIP (tendon coupling, ≈0.85·θ3).
    // Bidirectional scans both flex into contact and LIFT out of it, so
    // fingers the seat left too deep extend instead of digging.
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
      const s1b = bone(rig, `${f}1${side}`);
      const s2b = bone(rig, `${f}2${side}`);
      const s3b = bone(rig, `${f}3${side}`);
      const s4b = bone(rig, `${f}4${side}`);
      if (!s1b || !s2b || !s3b || !s4b) continue;
      // maxRad 1.0 (was 0.6): with the hammer roll the PINKY knuckle starts
      // ~19 mm off the solid and the 0.6 cap left it at closest-approach —
      // the visible splayed "wing" (probe-grip: Pinky3 21 mm, both sides)
      curlToContact(s1b, s2b, fingerDir, solid, 0.002, 1.0, {
        autoDir: true,
        probeMid: false,
      });
      // autoDir here too: after the cup roll a finger's direction can
      // stray far enough from the hood axis that the nominal bend sense
      // inverts — the L ring extend-scan spun the wrong way and left its
      // PIP 13 mm deep
      // maxRad 1.9: wrap the thin round tube (Ø24) down the front and under.
      // (The 13 mm "penetration" the metric flags is the seated KNUCKLE row
      // resting on a tube thinner than the hood capsule — seg3/4 fingertips
      // sit at ±4 mm, a clean wrap — so a wider arc here is safe.)
      // NO autoDir on the wrap curls (session 13): +bendAxis by construction
      // curls the fingertip TOWARD the palm (axis×f = palmNormal) — the
      // world-axis rotation is bind-pose-agnostic. autoDir picked "whichever
      // side shrinks the gap first" and wrapped some fingers the WRONG WAY
      // around the tube (down the OUTER face) — the owner read it as an
      // inside-out grip («обхватываешь изнутри»), the splayed wing.
      curlToContact(s2b, s3b, bendAxis, solid, 0.001, 1.9);
      const s3 = curlToContact(s3b, s4b, bendAxis, solid, -0.002, 1.9);
      // flexion floor only in the flex direction — never fight a lift
      const t3 = s3 < 0 ? s3 : Math.max(p.curl, s3);
      curlChain(rig, [`${f}3${side}`], bendAxis, t3 - s3);
      curlChain(rig, [`${f}4${side}`], bendAxis, t3 * p.curlTip);
    }
    // ---- thumb: opposes on the INBOARD face of the hood — aim the
    // metacarpal forward-inboard-down, then wrap to contact (v14 defect:
    // −THUMB_CURL about the finger axis pointed it up and outward)
    const th1 = bone(rig, `Thumb1${side}`);
    const th2 = bone(rig, `Thumb2${side}`);
    const th3 = bone(rig, `Thumb3${side}`);
    if (th1 && th2 && th3) {
      // HAMMER GRIP: the thumb OPPOSES the fingers — it departs from the
      // web (on the horn) and wraps DOWN the near face of the hood to close
      // the fist, meeting the fingertips from the other side. Direction =
      // into the hood (palmNormal, now rolled inboard) + world-down + a
      // touch forward; the contact solve wraps it onto the surface.
      // probe-bar v29: 0.35·fwd+0.7·palm+0.45·down left Thumb3 hanging 33 mm
      // off, 95 mm BEHIND the hood (down-back into air). The reference thumb
      // runs FORWARD along the hood's inner face, parallel to the wrapped
      // fingers — mostly fingerDir, palm-side bias, barely any extra down.
      const downW = new Vector3(0, -1, 0).applyQuaternion(rootQ);
      const thumbDir = fingerDir
        .clone()
        .multiplyScalar(0.8)
        .addScaledVector(palmNormal, 0.5)
        .addScaledVector(downW, 0.15)
        .normalize();
      th1.updateWorldMatrix(true, true);
      const t1w = new Vector3().setFromMatrixPosition(th1.matrixWorld);
      const t2w = new Vector3().setFromMatrixPosition(th2.matrixWorld);
      aimBone(th1, t2w, t1w.clone().addScaledVector(thumbDir, 0.1));
      const tt = curlToContact(th2, th3, bendAxis, solid, 0.002, 0.9, { autoDir: true });
      curlChain(rig, [`Thumb3${side}`], bendAxis, Math.max(0.15, tt * 0.5));
    }
  }
  // SYMMETRY: reflect the proven right-hand wrap onto the left. The rig's
  // left hand is a COPY of the right (dump-hand-frames: det same sign), not
  // a mirror, so the independent per-side solve diverges (L middle overshot).
  mirrorRightHandToLeft(root, rig);
}

/** Reflect the solved RIGHT hand's world rotations across the bike-centre
 *  plane (root x=0) onto the LEFT so the grip is symmetric. Rotation
 *  reflection about the x-normal plane is M·R·M → the quaternion (w,x,−y,−z)
 *  taken in ROOT space (the plane where the two hands are symmetric — NOT
 *  world, which is tilted while riding). Wrist→tips so each parent's world
 *  is current before its child. Finger POSITIONS follow from the left arm's
 *  own IK (already aimed at the mirror-image target). */
function mirrorRightHandToLeft(root: Object3D, rig: Object3D): void {
  root.updateWorldMatrix(true, false);
  const rootMat = root.matrixWorld;
  const rootInvMat = rootMat.clone().invert();
  const rootQ = new Quaternion();
  root.getWorldQuaternion(rootQ);
  const rootInvQ = rootQ.clone().invert();
  const qw = new Quaternion();
  const pInv = new Quaternion();
  const p = new Vector3();
  const parInvMat = new Matrix4();
  const names: string[] = ['Wrist'];
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) for (const i of [1, 2, 3, 4]) names.push(`${f}${i}`);
  for (const i of [1, 2, 3]) names.push(`Thumb${i}`);
  for (const nm of names) {
    const bR = bone(rig, `${nm}R`);
    const bL = bone(rig, `${nm}L`);
    const par = bL?.parent;
    if (!bR || !bL || !par) continue;
    bR.updateWorldMatrix(true, false);
    par.updateWorldMatrix(true, false);
    parInvMat.copy(par.matrixWorld).invert();
    // ROTATION: reflect the right bone's world rotation across root x=0
    bR.getWorldQuaternion(qw);
    qw.premultiply(rootInvQ);
    qw.set(qw.x, -qw.y, -qw.z, qw.w);
    qw.premultiply(rootQ);
    par.getWorldQuaternion(pInv).invert();
    bL.quaternion.copy(pInv).multiply(qw);
    // POSITION: the rig's LEFT hand is a copy, so its bone OFFSETS are not
    // mirrored either — reflect the right bone's world position too (across
    // root x=0) and re-express in the left parent's frame, or the mirrored
    // rotations alone tear the mesh (v27 voids). Skip the wrist: its place
    // comes from the left arm's own IK (already at the mirror target).
    if (nm !== 'Wrist') {
      p.setFromMatrixPosition(bR.matrixWorld).applyMatrix4(rootInvMat);
      p.x = -p.x;
      p.applyMatrix4(rootMat).applyMatrix4(parInvMat);
      bL.position.copy(p);
    }
    bL.updateWorldMatrix(true, false);
  }
}

export function attachRider(parent: Group, grip: GripSpec): void {
  new GLTFLoader().load(
    '/rider/adventurer.glb',
    (gltf) => {
    const rig = gltf.scene;

    // TRANSPARENT RIDER (owner, 2026-07-04): first-person shows ONLY the
    // arms/hands. Head (camera inside), backpack, legs and feet are hidden;
    // the torso rides behind the camera inside Adventurer_Body.
    for (const nm of ['Adventurer_Head', 'Backpack', 'Adventurer_Feet', 'Adventurer_Legs']) {
      const o = rig.getObjectByName(nm);
      if (o) o.visible = false;
    }
    // v2 verdict: node-material copy rendered the body BLACK (atlas
    // sampling mismatch suspected) — keep the loader's own materials,
    // only matte them down; WebGPURenderer handles MeshStandardMaterial
    rig.traverse((o) => {
      if (o instanceof SkinnedMesh || o instanceof Mesh) {
        // Quaternius low-poly GLBs ship WITHOUT a normal attribute — the
        // WebGPU/TSL pipeline then drops the mesh entirely (console:
        // 'Vertex attribute "normal" not found'). That was the invisible
        // rider (v3). Flat-shaded normals match the low-poly look.
        if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
        const src = o.material as MeshStandardMaterial;
        src.roughness = 0.95;
        src.metalness = 0;
        src.flatShading = true;
        o.frustumCulled = false; // eye-anchored; bounds never re-fit after posing
      }
    });

    // ---- seat the body: face -Z (asset faces +Z), hips onto the saddle
    rig.rotation.y = Math.PI;
    const hips = bone(rig, 'Hips');
    if (hips) {
      rig.updateWorldMatrix(true, true);
      const hw = new Vector3().setFromMatrixPosition(hips.matrixWorld);
      rig.position.add(new Vector3().copy(HIPS_POS).sub(hw));
    }

    // ---- spine lean (about local X toward -Z travel after the Y-flip)
    for (const [nm, rad] of [
      ['Abdomen', LEAN.abdomen],
      ['Torso', LEAN.torso],
      ['Chest', LEAN.chest],
    ] as const) {
      bone(rig, nm)?.rotateX(rad);
    }

    // legs/feet are hidden (transparent rider) — no leg posing needed

    // ---- arms: snapshot the rest pose FIRST (rotations are cumulative),
    // then pose parametrically — the same entry point the numeric grip
    // optimizer replays live (Adventurer bone names: no dots — WristL)
    const rest = new Map<string, Quaternion>();
    for (const nm of ARM_BONES) {
      const b = bone(rig, nm);
      if (b) rest.set(nm, b.quaternion.clone());
    }
    const resetArms = (): void => {
      for (const [nm, q] of rest) bone(rig, nm)?.quaternion.copy(q);
      rig.updateWorldMatrix(true, true);
    };
    // attach FIRST, then pose: solveArm/orientWrist work in WORLD space,
    // so the rig must already live under the (camera-riding) cockpit root
    parent.add(rig);
    poseArms(parent, rig, grip, DEFAULT_POSE);
    rig.updateWorldMatrix(true, true);

    // measurable grip (owner, 2026-07-04): live objects + replayable pose
    // API — tools/optimize-grip.ts converges on NUMBERS in ONE page load,
    // frames only confirm
    const w = window as unknown as { __laasDbg?: Record<string, unknown> };
    if (w.__laasDbg)
      w.__laasDbg['riderGrip'] = {
        root: parent,
        rig,
        spec: {
          hoodR: grip.hoodR.toArray(),
          hoodDir: grip.hoodDir.toArray(),
          hoodRad: grip.hoodRad,
          leverA: grip.leverA.toArray(),
          leverB: grip.leverB.toArray(),
          leverRad: grip.leverRad,
          hornC: grip.hornC.toArray(),
          hornRad: grip.hornRad,
          dropPts: grip.dropPts.map((p) => p.toArray()),
          barR: grip.barR,
        },
        presets: GRIP_PRESETS,
        applyPreset: (name: keyof typeof GRIP_PRESETS): void => {
          resetArms();
          poseArms(parent, rig, grip, GRIP_PRESETS[name] ?? DEFAULT_POSE);
          rig.updateWorldMatrix(true, true);
        },
        applyPose: (p: PoseParams): void => {
          resetArms();
          poseArms(parent, rig, grip, p);
          rig.updateWorldMatrix(true, true);
        },
        // rest-pose reset without re-posing — lets tools measure the raw
        // bind-pose bone layout (L/R chirality, finger fan) numerically
        reset: (): void => {
          resetArms();
          rig.updateWorldMatrix(true, true);
        },
      };
    },
    undefined,
    // a silent load failure previously read as "rider skipped" — never again
    (err) => console.error('[rider] adventurer.glb load FAILED:', err),
  );
}
