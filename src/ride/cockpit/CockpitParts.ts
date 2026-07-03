/**
 * CockpitParts — procedural first-person bike cockpit geometry (M1.5).
 *
 * Everything is real-dimension swept/merged geometry (Pillar A: no
 * primitive-looking shapes ship): handlebars as tubes swept along
 * anthropometric curves (compact road drop 42 cm / flared gravel drop /
 * 78 cm MTB riser), stem + spacer stack, rubber brake hoods with lever
 * blades, gloved hands built from per-finger capsule chains gripping the
 * bar, an out-front bike computer (live screen texture attaches in
 * Cockpit.ts), brake lines, and the fork crown + spinning front wheel.
 *
 * Local frame: origin = rider's EYE, +X right, +Y up, −Z forward (three
 * camera convention). All dimensions in meters from a real endurance
 * fit: bar clamp ≈ 0.40 m below and 0.62 m ahead of the eye.
 *
 * One merged BufferGeometry per material (7 draw calls per mode); the
 * three mode variants build once and toggle visibility.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, float, fract, mix, sin, uv, vec3 } from 'three/tsl';
import type { RideMode } from '../SurfaceMatrix';

// ---- fit constants (eye-relative, endurance posture) -----------------------
// slightly high/close vs strict anthropometry: at the default ride gaze
// (pitch ≈ −0.06) the hoods and computer must live in the lower frame, as
// they do in real riding peripheral vision (fov 55° vertical is narrower
// than human vision — strict numbers push the bar fully off-screen)
export const BAR_DROP = 0.30; // eye → bar-clamp vertical
export const BAR_FWD = 0.50; // eye → bar-clamp horizontal
const STEER_AXIS = new Vector3(0, -0.9563, 0.2924).normalize(); // 73° head angle

export interface CockpitBuild {
  /** whole cockpit (position/orient set per frame by Cockpit.ts) */
  root: Group;
  /** steering sub-group (bar+hands+fork+wheel) — small visual yaw */
  steer: Group;
  /** wheel sub-group — spins about its axle */
  wheel: Group;
  /** per-mode assemblies, toggled by visibility */
  modes: Record<Exclude<RideMode, 'hike'>, Group>;
  /** the computer screen mesh — Cockpit.ts assigns the live texture */
  screen: Mesh;
  /** world-space radius bound (for the TRAA depth gate) */
  maxDist: number;
}

interface Part {
  geo: BufferGeometry;
  m: Matrix4;
}

const tmpQ = new Quaternion();
const Y_UP = new Vector3(0, 1, 0);

function place(
  geo: BufferGeometry,
  pos: Vector3,
  dir?: Vector3,
  roll = 0,
): Part {
  const m = new Matrix4();
  if (dir) {
    tmpQ.setFromUnitVectors(Y_UP, dir.clone().normalize());
    m.makeRotationFromQuaternion(tmpQ);
    if (roll !== 0) m.multiply(new Matrix4().makeRotationY(roll));
  }
  m.setPosition(pos);
  return { geo, m };
}

function merged(parts: Part[]): BufferGeometry {
  const geos = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    g.applyMatrix4(p.m);
    // merged geometries must agree on attributes; drop uv2 etc.
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
    }
    return g;
  });
  const out = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return out ?? new BufferGeometry();
}

// ---- materials (engine idiom: node materials, lit by sun+hemi+IBL) ---------

function carbonMat(): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial();
  m.color = new Color('#111216');
  m.roughness = 0.38;
  m.metalness = 0.0;
  m.clearcoat = 0.65;
  m.clearcoatRoughness = 0.22;
  return m;
}

function alloyMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  // dark anodized — road components read near-black with metallic sheen
  m.color = new Color('#3a3e45');
  m.metalness = 0.85;
  m.roughness = 0.34;
  return m;
}

function rubberMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#0d0d10');
  m.roughness = 0.86;
  m.metalness = 0;
  return m;
}

/** bar tape: wrap ridges from tube-uv (uv.x runs along the sweep) */
function tapeMat(base: string, wrapsPerMeter: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.metalness = 0;
  const ridge = sin(fract(uv().x.mul(wrapsPerMeter)).mul(Math.PI * 2));
  const shade = ridge.mul(0.5).add(0.5); // 0..1 across each wrap
  const c = new Color(base);
  m.colorNode = mix(
    vec3(c.r * 0.55, c.g * 0.55, c.b * 0.55),
    vec3(c.r, c.g, c.b),
    shade.pow(0.6),
  );
  m.roughnessNode = float(0.94).sub(shade.mul(0.1));
  return m;
}

function gloveMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#16130f');
  m.roughness = 0.9;
  m.metalness = 0;
  return m;
}

/** bare skin — fingerless-glove fingers, wrists, forearms (owner ref) */
function skinMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#a06a4e');
  m.roughness = 0.72;
  m.metalness = 0;
  return m;
}

function tireMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.roughness = 0.92;
  m.metalness = 0;
  // subtle tread banding around the torus (uv.x = around the wheel) —
  // gives the spin something visible to carry
  const band = sin(uv().x.mul(Math.PI * 2 * 96)).mul(0.5).add(0.5);
  m.colorNode = mix(vec3(0.055, 0.055, 0.06), vec3(0.085, 0.085, 0.09), band);
  m.roughnessNode = clamp(float(0.9).add(band.mul(0.08)), 0, 1);
  return m;
}

// ---- handlebar curves -------------------------------------------------------

/** right half of a compact road drop bar (local: clamp center at origin) */
function dropBarPoints(halfWidth: number, flareDeg: number): Vector3[] {
  const f = Math.sin((flareDeg * Math.PI) / 180);
  const w = halfWidth;
  return [
    new Vector3(0, 0, 0),
    new Vector3(w * 0.55, 0.002, 0),
    new Vector3(w * 0.88, 0.002, -0.008),
    // ramp: sweeps forward toward the hood
    new Vector3(w * 0.985, -0.004, -0.048),
    // hood point (levers clamp here)
    new Vector3(w, -0.018, -0.078),
    // compact drop: forward-down, sweeping back to a short near-level tail
    new Vector3(w + f * 0.035, -0.052, -0.086),
    new Vector3(w + f * 0.07, -0.094, -0.052),
    new Vector3(w + f * 0.09, -0.113, -0.008),
    new Vector3(w + f * 0.1, -0.116, 0.03),
  ];
}

/** MTB riser: near-straight with backsweep/upsweep */
function riserBarPoints(halfWidth: number): Vector3[] {
  const w = halfWidth;
  return [
    new Vector3(0, 0, 0),
    new Vector3(w * 0.14, 0.002, 0.0),
    new Vector3(w * 0.3, 0.014, 0.008),
    new Vector3(w * 0.62, 0.022, 0.024),
    new Vector3(w, 0.026, 0.044),
  ];
}

function mirrorPoints(pts: Vector3[]): Vector3[] {
  return pts.map((p) => new Vector3(-p.x, p.y, p.z));
}

function sweep(pts: Vector3[], radius: number, seg = 64): TubeGeometry {
  const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.12);
  return new TubeGeometry(curve, seg, radius, 14, false);
}

/** sub-range sweep of the same curve (for tape overlays) */
function sweepRange(
  pts: Vector3[],
  radius: number,
  t0: number,
  t1: number,
  seg = 48,
): TubeGeometry {
  const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.12);
  const sub = new CatmullRomCurve3(
    Array.from({ length: 24 }, (_, i) =>
      curve.getPoint(t0 + ((t1 - t0) * i) / 23),
    ),
    false,
    'catmullrom',
    0.0,
  );
  return new TubeGeometry(sub, seg, radius, 14, false);
}

// ---- hands ------------------------------------------------------------------

interface HandSpec {
  /** wrist position (bar-clamp local) */
  wrist: Vector3;
  /** knuckle line center — where fingers start */
  knuckle: Vector3;
  /** direction fingers wrap around (axis of the gripped tube) */
  gripAxis: Vector3;
  /** outward normal of the back of the hand */
  backN: Vector3;
  /** unit direction of the first phalanx before the wrap bend */
  fingerN: Vector3;
  /** thumb rides ALONG the tube on top (bar-top grip, owner ref) instead
   *  of wrapping underneath (hoods/grips) */
  thumbOnTop?: boolean;
  side: 1 | -1;
}

/** fingerless-glove hand (owner ref): dark palm block + BARE-skin finger
 *  capsule-chains + thumb; returns per-material part lists */
function handParts(s: HandSpec): { glove: Part[]; skin: Part[] } {
  const glove: Part[] = [];
  const skin: Part[] = [];
  const grip = s.gripAxis.clone().normalize();
  const back = s.backN.clone().normalize();
  const along = s.fingerN.clone().normalize();

  // palm/back-of-hand: rounded box covering the knuckle line — the
  // fingerless glove must read as a SOLID dark mitt from above, not as
  // dark patches over skin (owner: «пятна»)
  const palmLen = 0.095;
  const palm = new RoundedBoxGeometry(0.07, 0.034, palmLen, 3, 0.014);
  const palmM = new Matrix4();
  {
    const zAxis = along.clone().negate(); // palm length runs along fingers' root line
    const xAxis = grip.clone();
    const yAxis = new Vector3().crossVectors(zAxis, xAxis).normalize();
    const xo = new Vector3().crossVectors(yAxis, zAxis).normalize();
    palmM.makeBasis(xo, yAxis, zAxis);
    palmM.setPosition(
      s.knuckle.clone().addScaledVector(along, -palmLen * 0.42).addScaledVector(back, 0.001),
    );
  }
  glove.push({ geo: palm, m: palmM });

  // fingers: 4 chains of 3 capsules wrapping around gripAxis; the outer
  // fingers are progressively shorter (index → pinky)
  for (let fIdx = 0; fIdx < 4; fIdx++) {
    const t = (fIdx / 3 - 0.5) * 0.058; // spread along grip axis
    const base = s.knuckle.clone().addScaledVector(grip, t);
    const fr = 0.0075 - fIdx * 0.0005;
    const fk = 1 - fIdx * 0.09;
    const lens = [0.027 * fk, 0.022 * fk, 0.017 * fk];
    // wrap: each segment bends further around the gripped tube — the
    // direction rotates in the (along, −back) plane
    let ang = 0.25;
    let pos = base.clone();
    for (let seg = 0; seg < 3; seg++) {
      ang += (seg === 0 ? 0.8 : 0.95) * (1 - fIdx * 0.03);
      const d = along
        .clone()
        .multiplyScalar(Math.cos(ang))
        .addScaledVector(back, -Math.sin(ang))
        .normalize();
      const len = lens[seg] as number;
      const cap = new CapsuleGeometry(fr, len, 3, 8);
      const mid = pos.clone().addScaledVector(d, len * 0.5);
      // fingerless gloves: first phalanx still gloved, the rest is skin
      (seg === 0 ? glove : skin).push(place(cap, mid, d));
      pos = pos.addScaledVector(d, len);
    }
  }

  // thumb: 2 segments — along the tube on top (bar-top grip) or wrapping
  // under the inner side (hoods / MTB grips)
  {
    const base = s.knuckle
      .clone()
      .addScaledVector(grip, -0.045)
      .addScaledVector(back, -0.004)
      .addScaledVector(along, -0.028);
    const inner = grip.clone().multiplyScalar(-s.side);
    const d1 = s.thumbOnTop
      ? inner.clone().addScaledVector(along, 0.55).normalize()
      : along.clone().multiplyScalar(0.5).addScaledVector(back, -0.85).normalize();
    const c1 = new CapsuleGeometry(0.009, 0.03, 3, 8);
    glove.push(place(c1, base.clone().addScaledVector(d1, 0.015), d1));
    const d2 = s.thumbOnTop
      ? inner.clone().addScaledVector(along, 1.1).addScaledVector(back, -0.15).normalize()
      : along.clone().multiplyScalar(0.9).addScaledVector(back, -0.4).normalize();
    const c2 = new CapsuleGeometry(0.0082, 0.026, 3, 8);
    skin.push(
      place(c2, base.clone().addScaledVector(d1, 0.03).addScaledVector(d2, 0.013), d2),
    );
  }
  return { glove, skin };
}

/** bare forearm from wrist back UP toward the rider's (off-frame) elbow.
 *  +Z is toward the rider in bar-clamp space — elbows sit behind wrists.
 *  Left wrist carries a sports watch (owner ref). */
function forearmParts(
  wrist: Vector3,
  side: 1 | -1,
  elbowAt?: Vector3,
): { skin: Part[]; watch: Part[]; elbowEnd: Vector3 } {
  // up-and-OUT toward the elbow, clearing the camera's near cone — an
  // elbow near the lens smears a featureless panel into the frame corners
  const elbow = elbowAt ?? new Vector3(side * 0.27, 0.04, 0.33);
  const dir = elbow.clone().sub(wrist);
  const len = dir.length() * 0.55; // draw the lower HALF only: the upper
  // half lives behind the camera in normal poses, but cornering lean can
  // swing it across the lens as a screen-wide "log" (owner: «шлак»)
  dir.normalize();
  const cone = new CylinderGeometry(0.031, 0.027, len, 12);
  const mid = wrist.clone().addScaledVector(dir, len * 0.5);
  const endCap = new SphereGeometry(0.032, 12, 10);
  const skin: Part[] = [
    place(cone, mid, dir),
    { geo: endCap, m: new Matrix4().setPosition(wrist.clone().addScaledVector(dir, len)) },
  ];
  const watch: Part[] = [];
  if (side === -1) {
    // slim strap + small face hugging the top of the wrist (ref photo) —
    // v1 read as a dark blob; keep it tight and low-profile
    const strap = new TorusGeometry(0.0285, 0.0032, 8, 18);
    watch.push(place(strap, wrist.clone().addScaledVector(dir, 0.04), dir));
    const face = new CylinderGeometry(0.011, 0.011, 0.0035, 14);
    const facePos = wrist
      .clone()
      .addScaledVector(dir, 0.04)
      .add(new Vector3(0, 0.0265, 0));
    watch.push(place(face, facePos, new Vector3(side * 0.15, 1, -0.08).normalize()));
  }
  return { skin, watch, elbowEnd: elbow };
}

// ---- hoods + levers (road/gravel) ------------------------------------------

function hoodParts(hoodPoint: Vector3, side: 1 | -1, flareDeg: number): Part[] {
  const parts: Part[] = [];
  const flare = (flareDeg * Math.PI) / 180;
  // hood body: capsule laid along the ramp direction (forward, slight down)
  const bodyDir = new Vector3(side * 0.06 + side * flare * 0.3, -0.24, -0.96).normalize();
  const body = new CapsuleGeometry(0.019, 0.06, 4, 12);
  // squash sideways a touch (hoods are taller than wide)
  body.applyMatrix4(new Matrix4().makeScale(0.85, 1, 1.08));
  parts.push(place(body, hoodPoint.clone().add(new Vector3(0, 0.014, -0.016)), bodyDir));
  // horn: the raised front knuckle of the lever body
  const horn = new SphereGeometry(0.017, 12, 10);
  horn.applyMatrix4(new Matrix4().makeScale(0.82, 1.15, 1.25));
  parts.push({
    geo: horn,
    m: new Matrix4().setPosition(hoodPoint.clone().add(new Vector3(0, 0.032, -0.06))),
  });
  return parts;
}

function leverParts(hoodPoint: Vector3, side: 1 | -1, flareDeg: number): Part[] {
  // brake lever blade: flattened tube arcing down from the horn
  const f = (flareDeg * Math.PI) / 180;
  const p0 = hoodPoint.clone().add(new Vector3(0, 0.02, -0.058));
  const pts = [
    p0,
    p0.clone().add(new Vector3(side * (0.004 + f * 0.02), -0.04, -0.012)),
    p0.clone().add(new Vector3(side * (0.006 + f * 0.05), -0.085, -0.004)),
    p0.clone().add(new Vector3(side * (0.007 + f * 0.07), -0.118, 0.012)),
  ];
  const blade = sweep(pts, 0.0055, 20);
  // flatten into a blade profile (scale across X in local hood frame)
  blade.applyMatrix4(
    new Matrix4()
      .makeTranslation(p0.x, p0.y, p0.z)
      .multiply(new Matrix4().makeScale(0.5, 1, 1))
      .multiply(new Matrix4().makeTranslation(-p0.x, -p0.y, -p0.z)),
  );
  return [{ geo: blade, m: new Matrix4() }];
}

// ---- computer ---------------------------------------------------------------

function computerParts(center: Vector3): { body: Part[]; screen: Mesh } {
  const parts: Part[] = [];
  const TILT = 0.42; // top face pitched back toward the rider's eye
  // body: landscape head unit, top face slightly toward the rider
  const body = new RoundedBoxGeometry(0.062, 0.016, 0.096, 3, 0.006);
  const tilt = new Matrix4().makeRotationX(TILT);
  const bodyM = tilt.clone().setPosition(center);
  parts.push({ geo: body, m: bodyM });
  // side buttons
  for (const sx of [-1, 1]) {
    const btn = new BoxGeometry(0.004, 0.006, 0.018);
    const bm = tilt.clone();
    bm.setPosition(center.clone().add(new Vector3(sx * 0.033, 0, 0.01).applyMatrix4(tilt)));
    parts.push({ geo: btn, m: bm });
  }
  // screen: separate mesh (live canvas texture assigned by Cockpit.ts).
  // Plane starts in XY (normal +Z, +Y = texture top): rotationX(−π/2)
  // lays it flat (top edge forward, normal up); +TILT pitches the normal
  // back toward the eye. Offset along the tilted up-axis clears the body.
  const scr = new PlaneGeometry(0.05, 0.08);
  const screen = new Mesh(scr); // material attached later
  screen.rotation.set(-Math.PI / 2 + TILT, 0, 0);
  screen.position
    .copy(center)
    .add(new Vector3(0, 0.0088, 0).applyMatrix4(new Matrix4().makeRotationX(TILT)));
  return { body: parts, screen };
}

// ---- mode assemblies --------------------------------------------------------

interface ModeSpec {
  kind: 'drop' | 'riser';
  halfWidth: number;
  flareDeg: number;
  tape: MeshStandardNodeMaterial | null;
  handsOn: 'hoods' | 'grips' | 'tops';
}

function buildModeAssembly(
  spec: ModeSpec,
  mats: {
    carbon: MeshPhysicalNodeMaterial;
    alloy: MeshStandardNodeMaterial;
    rubber: MeshStandardNodeMaterial;
    glove: MeshStandardNodeMaterial;
    skin: MeshStandardNodeMaterial;
  },
): Group {
  const g = new Group();
  const carbon: Part[] = [];
  const alloy: Part[] = [];
  const rubber: Part[] = [];
  const glove: Part[] = [];
  const skin: Part[] = [];
  const tape: Part[] = [];

  const clamp0 = new Vector3(0, 0, 0); // bar clamp center (assembly local)

  // ---- bar tube(s)
  const barR = 0.0112;
  if (spec.kind === 'drop') {
    const ptsR = dropBarPoints(spec.halfWidth, spec.flareDeg);
    const ptsL = mirrorPoints(ptsR);
    carbon.push({ geo: sweep(ptsR, barR), m: new Matrix4() });
    carbon.push({ geo: sweep(ptsL, barR), m: new Matrix4() });
    // tape: ramps + drops (t 0.42..1) and tops partial (0.12..0.42)
    if (spec.tape) {
      for (const pts of [ptsR, ptsL]) {
        tape.push({ geo: sweepRange(pts, barR + 0.0032, 0.14, 0.995), m: new Matrix4() });
      }
    }
    // bar-end plugs close the tape tail
    for (const pts of [ptsR, ptsL]) {
      const end = (pts[pts.length - 1] as Vector3).clone();
      const prev = pts[pts.length - 2] as Vector3;
      const axis = end.clone().sub(prev).normalize();
      const plug = new CylinderGeometry(0.0135, 0.0135, 0.005, 14);
      alloy.push(place(plug, end.clone().addScaledVector(axis, 0.001), axis));
    }
    // hoods + levers + hands
    const hoodR = ptsR[4] as Vector3;
    const hoodL = new Vector3(-hoodR.x, hoodR.y, hoodR.z);
    for (const [hp, side] of [
      [hoodR, 1],
      [hoodL, -1],
    ] as [Vector3, 1 | -1][]) {
      rubber.push(...hoodParts(hp, side, spec.flareDeg));
      alloy.push(...leverParts(hp, side, spec.flareDeg));
      let hand: { glove: Part[]; skin: Part[] };
      let wrist: Vector3;
      if (spec.handsOn === 'tops') {
        // owner-ref gravel posture: hands on the BAR TOPS beside the
        // hoods, thumbs riding along the tube on top
        const gp = new Vector3(
          (hp.x - 0.035 * Math.sign(hp.x)) * 1,
          hp.y + 0.016,
          hp.z + 0.052,
        );
        wrist = gp.clone().add(new Vector3(side * 0.006, 0.022, 0.055));
        hand = handParts({
          wrist,
          knuckle: gp.clone().add(new Vector3(side * 0.002, 0.012, -0.033)),
          gripAxis: new Vector3(side * 0.96, -0.02, -0.28).normalize(),
          backN: new Vector3(side * 0.1, 0.93, 0.35).normalize(),
          fingerN: new Vector3(side * 0.04, -0.72, -0.69).normalize(),
          thumbOnTop: true,
          side,
        });
      } else {
        // road posture: palm ON the hood, fingers wrapping the horn
        wrist = hp.clone().add(new Vector3(side * 0.008, 0.024, 0.048));
        hand = handParts({
          wrist,
          knuckle: hp.clone().add(new Vector3(side * 0.002, 0.027, -0.046)),
          gripAxis: new Vector3(side * (0.1 + spec.flareDeg * 0.012), -0.25, -0.96).normalize(),
          backN: new Vector3(side * 0.22, 0.9, 0.33).normalize(),
          fingerN: new Vector3(side * 0.05, -0.3, -0.95).normalize(),
          side,
        });
      }
      glove.push(...hand.glove);
      skin.push(...hand.skin);
      const fa = forearmParts(wrist, side);
      skin.push(...fa.skin);
      glove.push(...fa.watch);
    }
  } else {
    const ptsR = riserBarPoints(spec.halfWidth);
    const ptsL = mirrorPoints(ptsR);
    carbon.push({ geo: sweep(ptsR, barR), m: new Matrix4() });
    carbon.push({ geo: sweep(ptsL, barR), m: new Matrix4() });
    // grips: ribbed lock-on sleeves on the outer 13 cm (tape material slot
    // carries the ring pattern) + alloy lock rings and end flanges
    for (const pts of [ptsR, ptsL]) {
      tape.push({ geo: sweepRange(pts, 0.0155, 0.72, 0.985, 24), m: new Matrix4() });
      const end = (pts[pts.length - 1] as Vector3).clone();
      const axis = end.clone().sub(pts[pts.length - 2] as Vector3).normalize();
      const flange = new CylinderGeometry(0.0185, 0.0185, 0.006, 14);
      alloy.push(place(flange, end, axis));
      const lockRing = new CylinderGeometry(0.017, 0.017, 0.006, 14);
      alloy.push(place(lockRing, end.clone().addScaledVector(axis, -0.128), axis));
    }
    // MTB brake levers: short blades angled down-forward from near the grips
    for (const side of [1, -1] as const) {
      const gp = new Vector3(side * spec.halfWidth * 0.68, 0.02, 0.028);
      const pts2 = [
        gp,
        gp.clone().add(new Vector3(side * 0.02, -0.016, -0.05)),
        gp.clone().add(new Vector3(side * 0.026, -0.03, -0.088)),
      ];
      alloy.push({ geo: sweep(pts2, 0.005, 12), m: new Matrix4() });
      // hands on grips
      const gripCenter = new Vector3(side * spec.halfWidth * 0.86, 0.024, 0.038);
      const wrist = gripCenter.clone().add(new Vector3(side * 0.01, 0.03, 0.062));
      const hand = handParts({
        wrist,
        knuckle: gripCenter.clone().add(new Vector3(side * 0.004, 0.02, -0.012)),
        gripAxis: new Vector3(side * 0.95, 0.06, 0.28).normalize(),
        backN: new Vector3(0, 1, 0.1).normalize(),
        fingerN: new Vector3(side * 0.08, -0.35, -0.93).normalize(),
        side,
      });
      glove.push(...hand.glove);
      skin.push(...hand.skin);
      // MTB stance: elbows out wide, high, back toward the rider
      const fa = forearmParts(wrist, side, new Vector3(side * 0.36, 0.15, 0.3));
      skin.push(...fa.skin);
      glove.push(...fa.watch);
    }
  }

  // ---- stem + steerer stack (shared shape) — from clamp back to steer axis
  const steerTop = clamp0.clone().add(new Vector3(0, -0.012, 0.1));
  {
    const stemDir = steerTop.clone().sub(clamp0).normalize();
    const stemLen = steerTop.distanceTo(clamp0);
    const stemBody = new CylinderGeometry(0.0165, 0.019, stemLen, 12);
    carbon.push(place(stemBody, clamp0.clone().addScaledVector(stemDir, stemLen * 0.5), stemDir));
    // faceplate + its 4 bolts
    const face = new RoundedBoxGeometry(0.045, 0.042, 0.014, 2, 0.005);
    carbon.push({ geo: face, m: new Matrix4().setPosition(clamp0.clone().add(new Vector3(0, 0, -0.012))) });
    for (const bx of [-0.0125, 0.0125]) {
      for (const by of [-0.013, 0.013]) {
        const bolt = new CylinderGeometry(0.0028, 0.0028, 0.003, 8);
        alloy.push(
          place(bolt, clamp0.clone().add(new Vector3(bx, by, -0.0205)), new Vector3(0, 0, -1)),
        );
      }
    }
    // spacers + top cap down the steerer
    let along = 0.008;
    for (const h of [0.012, 0.01, 0.008]) {
      const sp = new CylinderGeometry(0.0168, 0.0168, h, 14);
      alloy.push(place(sp, steerTop.clone().addScaledVector(STEER_AXIS, along + h / 2), STEER_AXIS));
      along += h + 0.0015;
    }
    const cap = new CylinderGeometry(0.018, 0.018, 0.007, 14);
    alloy.push(place(cap, steerTop.clone().addScaledVector(STEER_AXIS, -0.006), STEER_AXIS));
  }

  // ---- brake lines: out of the hoods/levers, hugging under the bar, then
  // dropping along the steerer to vanish behind the fork crown
  for (const side of [1, -1] as const) {
    const x0 = spec.kind === 'drop' ? spec.halfWidth * 0.94 : spec.halfWidth * 0.6;
    const y0 = spec.kind === 'drop' ? -0.012 : 0.012;
    const z0 = spec.kind === 'drop' ? -0.07 : 0.02;
    const pts = [
      new Vector3(side * x0, y0, z0),
      new Vector3(side * x0 * 0.6, y0 - 0.03, z0 + 0.075),
      new Vector3(side * 0.045, -0.045, 0.035),
      new Vector3(side * 0.018, -0.16, -0.055),
      new Vector3(side * 0.012, -0.42, -0.12),
    ];
    rubber.push({ geo: sweep(pts, 0.0024, 28), m: new Matrix4() });
  }

  const mk = (parts: Part[], mat: MeshStandardNodeMaterial | MeshPhysicalNodeMaterial): void => {
    if (parts.length === 0) return;
    const mesh = new Mesh(merged(parts), mat);
    mesh.frustumCulled = false; // always near-camera; skip the recompute
    g.add(mesh);
  };
  mk(carbon, mats.carbon);
  mk(alloy, mats.alloy);
  mk(rubber, mats.rubber);
  mk(glove, mats.glove);
  mk(skin, mats.skin);
  if (spec.tape) mk(tape, spec.tape);
  return g;
}

// ---- fork + wheel -----------------------------------------------------------

function buildForkWheel(
  mats: { carbon: MeshPhysicalNodeMaterial; alloy: MeshStandardNodeMaterial },
  tire: MeshStandardNodeMaterial,
): { fork: Group; wheel: Group } {
  const fork = new Group();
  const carbon: Part[] = [];
  // real head-tube geometry (bar-clamp local): the crown sits ~0.49 m down
  // the steerer, the axle another 0.46 m below with ~0.14 m forward rake
  const crownC = new Vector3(0, -0.49, -0.17);
  const axle = new Vector3(0, -0.94, -0.31);
  const crown = new RoundedBoxGeometry(0.062, 0.05, 0.052, 2, 0.012);
  carbon.push({ geo: crown, m: new Matrix4().setPosition(crownC) });
  // visible steerer segment from the spacer stack down to the crown
  const steerSeg = new CylinderGeometry(0.0155, 0.0155, 0.42, 12);
  carbon.push(
    place(steerSeg, crownC.clone().add(new Vector3(0, 0.22, 0.062)), STEER_AXIS),
  );
  for (const side of [1, -1] as const) {
    const top = crownC.clone().add(new Vector3(side * 0.032, -0.01, 0));
    const bot = axle.clone().add(new Vector3(side * 0.05, 0.0, 0));
    const dir = bot.clone().sub(top);
    const len = dir.length();
    const leg = new CylinderGeometry(0.011, 0.015, len, 10);
    carbon.push(place(leg, top.clone().addScaledVector(dir.normalize(), len * 0.5), dir));
  }
  const forkMesh = new Mesh(merged(carbon), mats.carbon);
  forkMesh.frustumCulled = false;
  fork.add(forkMesh);

  // wheel: tire torus + rim + hub + spokes, spinning group at the axle
  const wheel = new Group();
  wheel.position.copy(axle);
  const R = 0.335;
  const tireGeo = new TorusGeometry(R, 0.016, 12, 48);
  tireGeo.rotateY(Math.PI / 2);
  const tireMesh = new Mesh(tireGeo, tire);
  tireMesh.frustumCulled = false;
  wheel.add(tireMesh);
  const rimParts: Part[] = [];
  const rim = new TorusGeometry(R - 0.022, 0.009, 8, 40);
  rim.rotateY(Math.PI / 2);
  rimParts.push({ geo: rim, m: new Matrix4() });
  const hub = new CylinderGeometry(0.016, 0.016, 0.08, 10);
  hub.rotateZ(Math.PI / 2);
  rimParts.push({ geo: hub, m: new Matrix4() });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const spoke = new CylinderGeometry(0.0012, 0.0012, R - 0.03, 4);
    const dir = new Vector3(0, Math.cos(a), Math.sin(a));
    rimParts.push(place(spoke, dir.clone().multiplyScalar((R - 0.03) / 2), dir));
  }
  const rimMesh = new Mesh(merged(rimParts), mats.alloy);
  rimMesh.frustumCulled = false;
  wheel.add(rimMesh);

  fork.add(wheel);
  return { fork, wheel };
}

// ---- public builder ---------------------------------------------------------

export function buildCockpit(): CockpitBuild {
  const mats = {
    carbon: carbonMat(),
    alloy: alloyMat(),
    rubber: rubberMat(),
    glove: gloveMat(),
    skin: skinMat(),
  };

  const root = new Group();
  root.name = 'cockpit';
  const steer = new Group();
  steer.name = 'cockpit-steer';
  // steer group origin at the bar clamp; root origin stays at the eye
  steer.position.set(0, -BAR_DROP, -BAR_FWD);
  root.add(steer);

  const road = buildModeAssembly(
    { kind: 'drop', halfWidth: 0.2, flareDeg: 0, tape: tapeMat('#1a1b1e', 42), handsOn: 'hoods' },
    mats,
  );
  const gravel = buildModeAssembly(
    { kind: 'drop', halfWidth: 0.22, flareDeg: 13, tape: tapeMat('#8a6f52', 42), handsOn: 'tops' },
    mats,
  );
  const mtb = buildModeAssembly(
    // tape slot = ribbed lock-on grip rubber (rings read at glove distance)
    { kind: 'riser', halfWidth: 0.39, flareDeg: 0, tape: tapeMat('#101013', 150), handsOn: 'grips' },
    mats,
  );
  road.name = 'road';
  gravel.name = 'gravel';
  mtb.name = 'mtb';
  gravel.visible = false;
  mtb.visible = false;
  steer.add(road, gravel, mtb);

  const { fork, wheel } = buildForkWheel(mats, tireMat());
  steer.add(fork);

  // computer floats out front of the clamp on its mount
  const comp = computerParts(new Vector3(0, 0.012, -0.105));
  const alloyParts: Part[] = [
    // out-front mount arm
    place(
      new CylinderGeometry(0.005, 0.005, 0.1, 8),
      new Vector3(0, 0.004, -0.055),
      new Vector3(0, 0.12, -1).normalize(),
    ),
    ...comp.body,
  ];
  const compMesh = new Mesh(merged(alloyParts), mats.rubber);
  compMesh.frustumCulled = false;
  steer.add(compMesh);
  comp.screen.frustumCulled = false;
  steer.add(comp.screen);

  return {
    root,
    steer,
    wheel,
    modes: { road, gravel, mtb },
    screen: comp.screen,
    maxDist: 1.35,
  };
}
