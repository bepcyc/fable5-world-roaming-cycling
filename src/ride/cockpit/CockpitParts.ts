/**
 * CockpitParts — procedural first-person bike cockpit geometry (M1.5.2).
 *
 * REWORK target = owner's three reference photos (shots/wip/what_i_want/
 * ref-gravel.jpg / ref-road-aero.jpg / ref-mtb.jpg), judged side-by-side:
 *   - road:   flat AERO top of complex section + integrated stem, bare
 *             hands over the hoods, ZERO cables, white frame tube.
 *   - gravel: round tops, flared drops w/ black tape, bare hands ON the
 *             tops by the bends, ONE thin cable at the head tube, white
 *             frame tube.
 *   - mtb:    wide straight riser, FULL black gloves with index fingers
 *             resting ON the brake levers, shifter pods at the grips,
 *             fork crown with two legs + colored adjusters (orange left,
 *             blue right), olive frame.
 * Hands are ANATOMY: domed palm, knuckle row, per-finger jointed chains
 * with gaps, opposing thumb + thenar pad, tapered bare forearms, thin
 * bracelet on the right wrist (road/gravel).
 *
 * PERSPECTIVE IS OURS (owner 2026-07-03): the ride gaze stays as-is; the
 * bike must simply OCCUPY the lower frame at that gaze — fit constants
 * sit high/close on purpose (fov 55° vertical is far narrower than human
 * peripheral vision, strict anthropometry pushes the bar off-screen).
 *
 * Local frame: origin = rider's EYE, +X right, +Y up, −Z forward (three
 * camera convention). One merged BufferGeometry per material per mode;
 * the three mode variants build once and toggle visibility.
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

// ---- fit constants (eye-relative) ------------------------------------------
// high/close on purpose: at the ride gaze (pitch ≈ −0.06, vfov 55°) the
// frame bottom edge is only ~0.54 rad below the view axis — the whole
// cockpit must fit inside that band to be SEEN (owner: «вел в кадре
// больше должен быть виден», perspective itself untouched)
export const BAR_DROP = 0.165; // eye → bar-clamp vertical
export const BAR_FWD = 0.40; // eye → bar-clamp horizontal
// 73° head angle, pointing DOWN the steerer: the tube bottom sits FORWARD
// (−Z) of its top — the previous +Z constant leaned the fork into the rider
const STEER_AXIS = new Vector3(0, -0.9563, -0.2924).normalize();

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
  /** view-depth bound for the TRAA per-object velocity gate */
  maxDist: number;
}

interface Part {
  geo: BufferGeometry;
  m: Matrix4;
}

const tmpQ = new Quaternion();
const Y_UP = new Vector3(0, 1, 0);

function place(geo: BufferGeometry, pos: Vector3, dir?: Vector3, roll = 0): Part {
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
  m.color = new Color('#101114');
  m.roughness = 0.4;
  m.metalness = 0.0;
  m.clearcoat = 0.4;
  m.clearcoatRoughness = 0.3;
  return m;
}

function alloyMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#454a52');
  m.metalness = 0.85;
  m.roughness = 0.34;
  return m;
}

function rubberMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#0c0c0f');
  m.roughness = 0.88;
  m.metalness = 0;
  return m;
}

/** glossy painted frame — white (road/gravel) or olive (MTB) */
function frameMat(hex: string, rough = 0.24): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial();
  m.color = new Color(hex);
  m.roughness = rough;
  m.metalness = 0.0;
  m.clearcoat = 0.9;
  m.clearcoatRoughness = 0.12;
  return m;
}

/** anodized adjuster dial (MTB fork crown) */
function anoMat(hex: string): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color(hex);
  m.metalness = 0.75;
  m.roughness = 0.38;
  return m;
}

/** bar tape: wrap ridges from tube-uv (uv.x runs along the sweep) */
function tapeMat(base: string, wrapsPerMeter: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.metalness = 0;
  const ridge = sin(fract(uv().x.mul(wrapsPerMeter)).mul(Math.PI * 2));
  const shade = ridge.mul(0.5).add(0.5);
  const c = new Color(base);
  m.colorNode = mix(
    vec3(c.r * 0.5, c.g * 0.5, c.b * 0.5),
    vec3(c.r, c.g, c.b),
    shade.pow(0.6),
  );
  m.roughnessNode = float(0.94).sub(shade.mul(0.08));
  return m;
}

function gloveMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#0e0f11');
  m.roughness = 0.93;
  m.metalness = 0;
  return m;
}

/** bare skin — warm tan per the reference photos */
function skinMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#997050');
  m.roughness = 0.66;
  m.metalness = 0;
  return m;
}

function braceletMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color('#6a5c4a');
  m.roughness = 0.7;
  m.metalness = 0.1;
  return m;
}

function tireMat(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.roughness = 0.92;
  m.metalness = 0;
  const band = sin(uv().x.mul(Math.PI * 2 * 96)).mul(0.5).add(0.5);
  m.colorNode = mix(vec3(0.055, 0.055, 0.06), vec3(0.085, 0.085, 0.09), band);
  m.roughnessNode = clamp(float(0.9).add(band.mul(0.08)), 0, 1);
  return m;
}

// ---- handlebar curves -------------------------------------------------------

/** right half of a compact road/gravel drop bar (clamp center at origin) */
function dropBarPoints(halfWidth: number, flareDeg: number): Vector3[] {
  const f = Math.sin((flareDeg * Math.PI) / 180);
  const w = halfWidth;
  return [
    new Vector3(0, 0, 0),
    new Vector3(w * 0.55, 0.002, 0),
    new Vector3(w * 0.88, 0.002, -0.008),
    new Vector3(w * 0.985, -0.004, -0.048),
    new Vector3(w, -0.018, -0.078), // hood point
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
    Array.from({ length: 24 }, (_, i) => curve.getPoint(t0 + ((t1 - t0) * i) / 23)),
    false,
    'catmullrom',
    0.0,
  );
  return new TubeGeometry(sub, seg, radius, 14, false);
}

// ---- hands v2 (anatomy) -----------------------------------------------------

interface Hand2Spec {
  /** knuckle-row center (index..pinky midpoint), assembly space */
  knuckleC: Vector3;
  /** grip-tube axis, pointing OUTWARD (toward this hand's side) */
  tHat: Vector3;
  /** back-of-hand normal (up out of the hand) */
  nHat: Vector3;
  /** initial finger direction before curl (⊥ tHat, away from rider) */
  fHat: Vector3;
  /** cumulative curl angles per phalanx (rad) — rotates fHat toward −nHat */
  curl: [number, number, number];
  /** index finger override (MTB: extended onto the brake lever) */
  indexCurl?: [number, number, number];
  /** wrap thumb under the tube (tops/grips) vs alongside (hoods) */
  thumbUnder: boolean;
  /** full glove (MTB) — everything in glove material, plus knuckle pads */
  gloved: boolean;
  /** thin cord bracelet on this wrist (right hand, road/gravel refs) */
  bracelet: boolean;
  /** where the forearm goes (elbow direction, assembly space) */
  elbow: Vector3;
  side: 1 | -1;
}

interface HandOut {
  skin: Part[];
  glove: Part[];
  bracelet: Part[];
}

/**
 * Anatomy hand: domed palm slab + 4-knuckle row + per-finger jointed
 * capsule chains with real gaps + opposing thumb w/ thenar pad + tapered
 * forearm (lower half only — the upper half lives behind the camera).
 */
function handParts2(s: Hand2Spec): HandOut {
  const skin: Part[] = [];
  const glove: Part[] = [];
  const bracelet: Part[] = [];
  const body = s.gloved ? glove : skin; // hand shell target
  const t = s.tHat.clone().normalize();
  const n = s.nHat.clone().normalize();
  // orthonormalize f against t (curl math assumes f ⊥ t)
  const f = s.fHat.clone().addScaledVector(t, -s.fHat.dot(t)).normalize();

  // curl direction at cumulative angle θ: rotate f toward −n
  const curlDir = (theta: number): Vector3 =>
    f.clone().multiplyScalar(Math.cos(theta)).addScaledVector(n, -Math.sin(theta)).normalize();

  // ---- palm: ONE cohesive pillow following the back-of-hand slope.
  // backDir tilts UP toward the wrist (f points down-forward with the
  // fingers), so the palm drapes naturally over the gripped tube.
  const backDir = f.clone().negate(); // toward the wrist, sloping up
  {
    const m = new Matrix4();
    const z = backDir.clone();
    const x = t.clone();
    let y = new Vector3().crossVectors(z, x).normalize();
    if (y.dot(n) < 0) {
      // left hand: keep the dome UP regardless of the lateral-axis sign
      x.negate();
      y = new Vector3().crossVectors(z, x).normalize();
    }
    const xo = new Vector3().crossVectors(y, z).normalize();
    const palmUp = y.clone();
    const slab = new RoundedBoxGeometry(0.058, 0.02, 0.062, 3, 0.01);
    m.makeBasis(xo, y, z);
    m.setPosition(s.knuckleC.clone().addScaledVector(backDir, 0.038).addScaledVector(palmUp, -0.003));
    body.push({ geo: slab, m });
    // dome: low rise toward the knuckles, INSIDE the slab silhouette
    const dome = new RoundedBoxGeometry(0.05, 0.014, 0.05, 3, 0.007);
    const md = m.clone();
    md.setPosition(
      s.knuckleC.clone().addScaledVector(backDir, 0.03).addScaledVector(palmUp, 0.0068),
    );
    body.push({ geo: dome, m: md });
  }

  // ---- fingers: 4 jointed chains, spread along t — DENSE like a real
  // hand (~1.5 mm gaps), thick phalanges, curling around the tube.
  // t points OUTWARD; the index rides INWARD (thumb side, toward the
  // stem) on both hands, so the index sits at −1.5·spread along t.
  const FSPREAD = 0.0185;
  for (let fi = 0; fi < 4; fi++) {
    const fk = 1 - fi * 0.09; // index → pinky length taper
    const isIndex = fi === 0;
    const base = s.knuckleC.clone().addScaledVector(t, (fi - 1.5) * FSPREAD);
    const curl = isIndex && s.indexCurl ? s.indexCurl : s.curl;
    const r0 = 0.0085 - fi * 0.0006;
    const lens = [0.029 * fk, 0.023 * fk, 0.013 * fk];
    // knuckle bump at the chain root, tucked into the palm edge
    const kn = new SphereGeometry(r0 * 0.92, 10, 8);
    body.push({ geo: kn, m: new Matrix4().setPosition(base.clone().addScaledVector(n, -0.002)) });
    // ONE smooth flesh arc through the joint waypoints (capsule chains
    // read as caterpillars — the kinks poke through the skin)
    let theta = curl[0];
    let pos = base.clone();
    const way: Vector3[] = [pos.clone()];
    for (let seg = 0; seg < 3; seg++) {
      if (seg > 0) theta += curl[seg] as number;
      const d = curlDir(theta);
      pos = pos.addScaledVector(d, lens[seg] as number);
      way.push(pos.clone());
    }
    const rF = r0 * 0.95;
    const curve = new CatmullRomCurve3(way, false, 'catmullrom', 0.35);
    body.push({ geo: new TubeGeometry(curve, 12, rF, 9, false), m: new Matrix4() });
    body.push({ geo: new SphereGeometry(rF * 0.9, 9, 8), m: new Matrix4().setPosition(pos) });
    // gloved MTB hands: knuckle pad strip across the first phalanx
    if (s.gloved) {
      const pad = new RoundedBoxGeometry(0.015, 0.006, 0.02, 2, 0.0028);
      const pm = new Matrix4();
      const d0 = curlDir(curl[0]);
      const zx = d0.clone();
      const yx = n.clone();
      const xx = new Vector3().crossVectors(yx, zx).normalize();
      const yo = new Vector3().crossVectors(zx, xx).normalize();
      pm.makeBasis(xx, yo, zx);
      pm.setPosition(base.clone().addScaledVector(d0, 0.014).addScaledVector(n, r0 * 0.75));
      glove.push({ geo: pad, m: pm });
    }
  }

  // ---- thumb: thenar pad + 2 jointed segments on the inner side
  {
    const inward = t.clone().negate();
    const tBase = s.knuckleC
      .clone()
      .addScaledVector(inward, 0.038)
      .addScaledVector(backDir, 0.034)
      .addScaledVector(n, -0.015);
    const thenar = new CapsuleGeometry(0.012, 0.02, 3, 10);
    body.push(place(thenar, tBase.clone().addScaledVector(backDir, 0.01), inward));
    const d1 = s.thumbUnder
      ? inward.clone().addScaledVector(n, -0.9).addScaledVector(f, 0.25).normalize()
      : inward.clone().addScaledVector(n, -0.55).addScaledVector(f, 0.35).normalize();
    const c1 = new CapsuleGeometry(0.0086, 0.017, 3, 9);
    body.push(place(c1, tBase.clone().addScaledVector(d1, 0.017), d1));
    const p1 = tBase.clone().addScaledVector(d1, 0.034);
    body.push({ geo: new SphereGeometry(0.0095, 8, 7), m: new Matrix4().setPosition(p1) });
    const d2 = s.thumbUnder
      ? d1.clone().addScaledVector(n, -0.5).addScaledVector(f, 0.5).normalize()
      : d1.clone().addScaledVector(n, -0.3).addScaledVector(f, 0.7).normalize();
    const c2 = new CapsuleGeometry(0.0078, 0.015, 3, 9);
    body.push(place(c2, p1.clone().addScaledVector(d2, 0.013), d2));
  }

  // ---- wrist + forearm (lower half, tapered, exits toward frame corner)
  {
    const wrist = s.knuckleC.clone().addScaledVector(backDir, 0.088).addScaledVector(n, -0.007);
    const wristBall = new SphereGeometry(0.0185, 12, 10);
    // wrist is skin even on gloved hands (short MTB gloves end at the cuff)
    skin.push({ geo: wristBall, m: new Matrix4().setPosition(wrist) });
    const dir = s.elbow.clone().sub(wrist);
    const len = dir.length() * 0.55;
    dir.normalize();
    const arm = new CylinderGeometry(0.0225, 0.0185, len, 14);
    skin.push(place(arm, wrist.clone().addScaledVector(dir, len * 0.5), dir));
    skin.push({
      geo: new SphereGeometry(0.0225, 12, 10),
      m: new Matrix4().setPosition(wrist.clone().addScaledVector(dir, len)),
    });
    if (s.gloved) {
      // glove cuff ring at the wrist
      const cuff = new TorusGeometry(0.0245, 0.005, 8, 16);
      glove.push(place(cuff, wrist.clone().addScaledVector(dir, 0.012), dir));
    }
    if (s.bracelet) {
      // thin double cord loop just up the forearm (ref: right wrist)
      const b1 = new TorusGeometry(0.0215, 0.002, 8, 18);
      bracelet.push(place(b1, wrist.clone().addScaledVector(dir, 0.05), dir));
      const b2 = new TorusGeometry(0.0212, 0.0016, 8, 18);
      bracelet.push(place(b2, wrist.clone().addScaledVector(dir, 0.058), dir));
    }
  }
  return { skin, glove, bracelet };
}

// ---- hoods + levers (road/gravel) ------------------------------------------

function hoodParts(hoodPoint: Vector3, side: 1 | -1, flareDeg: number): Part[] {
  const parts: Part[] = [];
  const flare = (flareDeg * Math.PI) / 180;
  const bodyDir = new Vector3(side * 0.06 + side * flare * 0.3, -0.24, -0.96).normalize();
  const body = new CapsuleGeometry(0.019, 0.062, 4, 12);
  body.applyMatrix4(new Matrix4().makeScale(0.85, 1, 1.08));
  parts.push(place(body, hoodPoint.clone().add(new Vector3(0, 0.014, -0.016)), bodyDir));
  const horn = new SphereGeometry(0.0175, 12, 10);
  horn.applyMatrix4(new Matrix4().makeScale(0.82, 1.12, 1.3));
  parts.push({
    geo: horn,
    m: new Matrix4().setPosition(hoodPoint.clone().add(new Vector3(0, 0.03, -0.062))),
  });
  return parts;
}

function leverParts(hoodPoint: Vector3, side: 1 | -1, flareDeg: number): Part[] {
  const f = (flareDeg * Math.PI) / 180;
  const p0 = hoodPoint.clone().add(new Vector3(0, 0.018, -0.06));
  const pts = [
    p0,
    p0.clone().add(new Vector3(side * (0.004 + f * 0.02), -0.042, -0.012)),
    p0.clone().add(new Vector3(side * (0.006 + f * 0.05), -0.088, -0.002)),
    p0.clone().add(new Vector3(side * (0.007 + f * 0.07), -0.12, 0.014)),
  ];
  const blade = sweep(pts, 0.0056, 20);
  blade.applyMatrix4(
    new Matrix4()
      .makeTranslation(p0.x, p0.y, p0.z)
      .multiply(new Matrix4().makeScale(0.5, 1, 1))
      .multiply(new Matrix4().makeTranslation(-p0.x, -p0.y, -p0.z)),
  );
  return [{ geo: blade, m: new Matrix4() }];
}

// ---- computer (phone-format head unit, owner refs) --------------------------

function computerParts(center: Vector3): { body: Part[]; screen: Mesh; mount: Part[] } {
  const parts: Part[] = [];
  const TILT = 0.55; // screen normal pitched back toward the rider's eye
  // portrait phone body ~62×126 mm, thin
  const body = new RoundedBoxGeometry(0.058, 0.012, 0.118, 4, 0.0055);
  const tilt = new Matrix4().makeRotationX(TILT);
  const bodyM = tilt.clone().setPosition(center);
  parts.push({ geo: body, m: bodyM });
  // camera-side power button nub
  const btn = new BoxGeometry(0.004, 0.005, 0.012);
  const bm = tilt.clone();
  bm.setPosition(center.clone().add(new Vector3(0.032, 0, -0.026).applyMatrix4(tilt)));
  parts.push({ geo: btn, m: bm });

  // screen: separate mesh (live canvas texture assigned by Cockpit.ts)
  const scr = new PlaneGeometry(0.0495, 0.1055);
  const screen = new Mesh(scr);
  screen.rotation.set(-Math.PI / 2 + TILT, 0, 0);
  screen.position
    .copy(center)
    .add(new Vector3(0, 0.0075, 0).applyMatrix4(new Matrix4().makeRotationX(TILT)));

  // out-front mount: riser post from the stem + cradle under the body
  const mount: Part[] = [];
  const post = new CylinderGeometry(0.006, 0.007, 0.034, 10);
  mount.push(
    place(post, center.clone().add(new Vector3(0, -0.019, 0.012)), new Vector3(0, 1, -0.28).normalize()),
  );
  const cradle = new RoundedBoxGeometry(0.028, 0.008, 0.044, 2, 0.003);
  const cm = tilt.clone();
  cm.setPosition(center.clone().add(new Vector3(0, -0.0105, 0).applyMatrix4(tilt)));
  mount.push({ geo: cradle, m: cm });
  return { body: parts, screen, mount };
}

// ---- frame tubes (the bike below the bars — owner: it must READ as a bike) --

function frameParts(kind: 'drop' | 'riser'): Part[] {
  const parts: Part[] = [];
  // head tube: fat tube along the steering axis under the stem
  const htTop = new Vector3(0, -0.03, 0.085);
  const htLen = 0.17;
  const ht = new CylinderGeometry(0.034, 0.036, htLen, 16);
  parts.push(place(ht, htTop.clone().addScaledVector(STEER_AXIS, htLen / 2), STEER_AXIS));
  // top tube: from the head tube toward the saddle (toward/below the
  // camera — reads as the frame tube dropping down-center of the frame)
  const ttA = htTop.clone().addScaledVector(STEER_AXIS, htLen * 0.38).add(new Vector3(0, 0.012, 0));
  const ttB = new Vector3(0, kind === 'riser' ? -0.44 : -0.40, 0.54);
  {
    const dir = ttB.clone().sub(ttA);
    const len = dir.length();
    dir.normalize();
    const tt = new CylinderGeometry(0.028, 0.042, len, 14);
    parts.push(place(tt, ttA.clone().addScaledVector(dir, len * 0.5), dir));
  }
  // down tube stub: forward-down from the head tube bottom (silhouette
  // thickness behind the head tube; mostly occluded at the ride gaze)
  const dtA = htTop.clone().addScaledVector(STEER_AXIS, htLen * 0.92);
  const dtB = dtA.clone().add(new Vector3(0, -0.34, -0.10));
  {
    const dir = dtB.clone().sub(dtA);
    const len = dir.length();
    dir.normalize();
    const dt = new CylinderGeometry(0.03, 0.036, len, 14);
    parts.push(place(dt, dtA.clone().addScaledVector(dir, len * 0.5), dir));
  }
  return parts;
}

// ---- mode assemblies --------------------------------------------------------

interface ModeSpec {
  kind: 'drop' | 'riser';
  halfWidth: number;
  flareDeg: number;
  /** aero wing top + integrated stem (road ref) */
  aero: boolean;
  tape: MeshStandardNodeMaterial | null;
  handsOn: 'hoods' | 'grips' | 'tops';
  /** number of visible control lines (road 0 / gravel 1 / mtb 2) */
  cables: 0 | 1 | 2;
  frame: MeshPhysicalNodeMaterial;
  gloved: boolean;
}

interface SharedMats {
  carbon: MeshPhysicalNodeMaterial;
  alloy: MeshStandardNodeMaterial;
  rubber: MeshStandardNodeMaterial;
  glove: MeshStandardNodeMaterial;
  skin: MeshStandardNodeMaterial;
  bracelet: MeshStandardNodeMaterial;
  anoOrange: MeshStandardNodeMaterial;
  anoBlue: MeshStandardNodeMaterial;
}

function buildModeAssembly(spec: ModeSpec, mats: SharedMats): Group {
  const g = new Group();
  const carbon: Part[] = [];
  const alloy: Part[] = [];
  const rubber: Part[] = [];
  const glove: Part[] = [];
  const skin: Part[] = [];
  const tape: Part[] = [];
  const bracelet: Part[] = [];
  const frame: Part[] = [];

  const barR = 0.0115;

  const addHand = (s: Hand2Spec): void => {
    const h = handParts2(s);
    skin.push(...h.skin);
    glove.push(...h.glove);
    bracelet.push(...h.bracelet);
  };

  if (spec.kind === 'drop') {
    const ptsR = dropBarPoints(spec.halfWidth, spec.flareDeg);
    const ptsL = mirrorPoints(ptsR);

    if (spec.aero) {
      // ---- road-aero: wing top + integrated stem, ZERO cables
      // wing: sweep the top run then flatten/widen it in the fore-aft plane
      for (const pts of [ptsR, ptsL]) {
        const top = sweepRange(pts, 0.0105, 0.0, 0.40, 40);
        // flatten Y ×0.6, widen Z ×2.3 → ~53×13 mm airfoil-ish section
        top.applyMatrix4(new Matrix4().makeScale(1, 0.6, 2.3));
        // re-seat: Z-scaling drags the slightly-forward top run further
        // forward — pull back so the wing trailing edge meets the stem
        top.applyMatrix4(new Matrix4().makeTranslation(0, 0.004, 0.02));
        carbon.push({ geo: top, m: new Matrix4() });
        // round drops from the hood point down (taped below)
        carbon.push({ geo: sweepRange(pts, barR, 0.42, 0.995, 40), m: new Matrix4() });
      }
      // integrated stem: airfoil box blending into the steerer
      const stem = new RoundedBoxGeometry(0.044, 0.026, 0.108, 3, 0.011);
      carbon.push({
        geo: stem,
        m: new Matrix4()
          .makeRotationX(-0.1)
          .setPosition(new Vector3(0, -0.005, 0.052)),
      });
    } else {
      // ---- gravel: classic round bar
      carbon.push({ geo: sweep(ptsR, barR), m: new Matrix4() });
      carbon.push({ geo: sweep(ptsL, barR), m: new Matrix4() });
      // stem + faceplate + spacers (visible on the round cockpit)
      const steerTop = new Vector3(0, -0.012, 0.095);
      const stemDir = steerTop.clone().normalize();
      const stemLen = steerTop.length();
      const stemBody = new CylinderGeometry(0.0165, 0.019, stemLen, 12);
      carbon.push(place(stemBody, stemDir.clone().multiplyScalar(stemLen * 0.5), stemDir));
      const face = new RoundedBoxGeometry(0.045, 0.042, 0.014, 2, 0.005);
      carbon.push({ geo: face, m: new Matrix4().setPosition(new Vector3(0, 0, -0.012)) });
      for (const bx of [-0.0125, 0.0125]) {
        for (const by of [-0.013, 0.013]) {
          const bolt = new CylinderGeometry(0.0028, 0.0028, 0.003, 8);
          alloy.push(place(bolt, new Vector3(bx, by, -0.0205), new Vector3(0, 0, -1)));
        }
      }
      let along = 0.008;
      for (const h of [0.012, 0.01]) {
        const sp = new CylinderGeometry(0.0168, 0.0168, h, 14);
        alloy.push(place(sp, steerTop.clone().addScaledVector(STEER_AXIS, along + h / 2), STEER_AXIS));
        along += h + 0.0015;
      }
    }

    // tape on drops (both road + gravel — black per refs)
    if (spec.tape) {
      for (const pts of [ptsR, ptsL]) {
        tape.push({
          geo: sweepRange(pts, barR + 0.003, spec.aero ? 0.46 : 0.3, 0.995),
          m: new Matrix4(),
        });
      }
    }
    // bar-end plugs
    for (const pts of [ptsR, ptsL]) {
      const end = (pts[pts.length - 1] as Vector3).clone();
      const prev = pts[pts.length - 2] as Vector3;
      const axis = end.clone().sub(prev).normalize();
      const plug = new CylinderGeometry(0.0138, 0.0138, 0.005, 14);
      alloy.push(place(plug, end.clone().addScaledVector(axis, 0.001), axis));
    }

    // hoods + levers + hands
    const hoodR = ptsR[4] as Vector3;
    const hoodL = new Vector3(-hoodR.x, hoodR.y, hoodR.z);
    for (const [hp0, side] of [
      [hoodR, 1],
      [hoodL, -1],
    ] as [Vector3, 1 | -1][]) {
      // aero wing's widened chord overhangs the hood zone — push the
      // hood assembly forward so it rises clear of the wing edge
      const hp = spec.aero ? hp0.clone().add(new Vector3(0, 0.004, -0.026)) : hp0;
      rubber.push(...hoodParts(hp, side, spec.flareDeg));
      alloy.push(...leverParts(hp, side, spec.flareDeg));
      if (spec.handsOn === 'tops') {
        // gravel ref: bare hands ON the tops right at the bends — palm
        // draped over the tube, back of hand ~30° nose-down, fingers
        // wrapping the front-underside
        const gp = new Vector3(hp.x - side * 0.052, hp.y + 0.016, hp.z + 0.066);
        addHand({
          knuckleC: gp.clone().add(new Vector3(side * 0.002, 0.015, 0.005)),
          tHat: new Vector3(side * 0.97, -0.01, -0.24),
          nHat: new Vector3(side * 0.07, 0.95, -0.3),
          fHat: new Vector3(side * 0.05, -0.15, -0.99),
          curl: [0.25, 1.3, 1.35],
          thumbUnder: true,
          gloved: false,
          bracelet: side === 1,
          elbow: new Vector3(side * 0.24, -0.30, 0.20),
          side,
        });
      } else {
        // road ref: bare hands draped OVER the hoods, knuckles up
        addHand({
          knuckleC: hp.clone().add(new Vector3(side * 0.002, 0.034, -0.048)),
          tHat: new Vector3(side * 0.985, -0.08, -0.15),
          nHat: new Vector3(side * 0.1, 0.9, -0.42),
          fHat: new Vector3(side * 0.03, -0.35, -0.94),
          curl: [0.35, 0.95, 1.0],
          thumbUnder: false,
          gloved: false,
          bracelet: side === 1,
          elbow: new Vector3(side * 0.22, -0.30, 0.18),
          side,
        });
      }
    }

    // control lines: road-aero 0 (fully internal), gravel 1 thin at the
    // head tube (ref: single housing loop)
    if (spec.cables === 1) {
      const pts = [
        new Vector3(-0.035, -0.014, 0.02),
        new Vector3(-0.05, -0.09, -0.055),
        new Vector3(-0.022, -0.19, -0.075),
      ];
      rubber.push({ geo: sweep(pts, 0.0022, 24), m: new Matrix4() });
    }
  } else {
    // ---- MTB: riser bar, grips, pods, full gloves, index on the levers
    const ptsR = riserBarPoints(spec.halfWidth);
    const ptsL = mirrorPoints(ptsR);
    carbon.push({ geo: sweep(ptsR, barR), m: new Matrix4() });
    carbon.push({ geo: sweep(ptsL, barR), m: new Matrix4() });
    // stem (short MTB stack)
    const steerTop = new Vector3(0, -0.012, 0.06);
    const stemDir = steerTop.clone().normalize();
    const stemLen = steerTop.length();
    carbon.push(
      place(
        new CylinderGeometry(0.018, 0.02, stemLen, 12),
        stemDir.clone().multiplyScalar(stemLen * 0.5),
        stemDir,
      ),
    );

    for (const pts of [ptsR, ptsL]) {
      // lock-on grips (ribbed rubber via tape slot) + flange + lock rings
      tape.push({ geo: sweepRange(pts, 0.0158, 0.72, 0.985, 24), m: new Matrix4() });
      const end = (pts[pts.length - 1] as Vector3).clone();
      const axis = end.clone().sub(pts[pts.length - 2] as Vector3).normalize();
      alloy.push(place(new CylinderGeometry(0.0185, 0.0185, 0.006, 14), end, axis));
      alloy.push(
        place(new CylinderGeometry(0.017, 0.017, 0.006, 14), end.clone().addScaledVector(axis, -0.128), axis),
      );
    }

    for (const side of [1, -1] as const) {
      const gripC = new Vector3(side * spec.halfWidth * 0.86, 0.0245, 0.0395);
      const barAxis = new Vector3(side * 0.96, 0.02, 0.26).normalize();
      // brake lever: clamp + pivot body + blade reaching under the index
      const clampP = gripC.clone().addScaledVector(barAxis, -0.055);
      alloy.push(place(new CylinderGeometry(0.014, 0.014, 0.012, 10), clampP, barAxis));
      const bladePts = [
        clampP.clone().add(new Vector3(side * 0.012, -0.005, -0.03)),
        clampP.clone().add(new Vector3(side * 0.03, -0.014, -0.052)),
        clampP.clone().add(new Vector3(side * 0.052, -0.024, -0.06)),
      ];
      alloy.push({ geo: sweep(bladePts, 0.0056, 16), m: new Matrix4() });
      // shifter pod (right) / dropper remote (left) under the bar
      const pod = new RoundedBoxGeometry(0.03, 0.016, 0.024, 2, 0.005);
      rubber.push({
        geo: pod,
        m: new Matrix4().setPosition(clampP.clone().add(new Vector3(side * 0.012, -0.018, 0.012))),
      });
      // short hose stubs from the lever bodies (visible in the ref)
      if (spec.cables === 2) {
        const hosePts = [
          clampP.clone().add(new Vector3(0, -0.004, -0.014)),
          clampP.clone().add(new Vector3(-side * 0.05, -0.035, 0.02)),
          new Vector3(side * 0.02, -0.1, 0.055),
        ];
        rubber.push({ geo: sweep(hosePts, 0.0024, 20), m: new Matrix4() });
      }
      // full-glove hand on the grip, INDEX EXTENDED onto the lever blade
      addHand({
        knuckleC: gripC.clone().add(new Vector3(side * 0.002, 0.021, 0.006)),
        tHat: barAxis.clone(),
        nHat: new Vector3(side * 0.04, 0.95, -0.3),
        fHat: new Vector3(side * 0.02, -0.15, -0.99),
        curl: [0.25, 1.25, 1.3],
        indexCurl: [0.12, 0.12, 0.08],
        thumbUnder: true,
        gloved: true,
        bracelet: false,
        elbow: new Vector3(side * 0.33, -0.28, 0.22),
        side,
      });
    }
  }

  // ---- frame tubes (white road/gravel, olive MTB — the BIKE below)
  frame.push(...frameParts(spec.kind));

  const mk = (
    parts: Part[],
    mat: MeshStandardNodeMaterial | MeshPhysicalNodeMaterial,
  ): void => {
    if (parts.length === 0) return;
    const mesh = new Mesh(merged(parts), mat);
    mesh.frustumCulled = false;
    g.add(mesh);
  };
  mk(carbon, mats.carbon);
  mk(alloy, mats.alloy);
  mk(rubber, mats.rubber);
  mk(glove, mats.glove);
  mk(skin, mats.skin);
  mk(bracelet, mats.bracelet);
  mk(frame, spec.frame);
  if (spec.tape) mk(tape, spec.tape);
  return g;
}

// ---- fork + wheel -----------------------------------------------------------

// fork crown sits under the head tube; the axle rakes forward of it
const CROWN_C = new Vector3(0, -0.42, -0.05);
const AXLE_C = new Vector3(0, -0.83, -0.24);

/** per-mode fork (NO wheel — the wheel is shared so one spin drives all) */
function buildFork(
  frameM: MeshPhysicalNodeMaterial,
  mats: SharedMats,
  mtb: boolean,
): Group {
  const fork = new Group();
  const framePs: Part[] = [];
  const anoO: Part[] = [];
  const anoB: Part[] = [];
  const alloyPs: Part[] = [];
  if (mtb) {
    // suspension fork: crown + stanchions + colored top-cap adjusters
    // (owner ref: orange LEFT, blue RIGHT)
    const crown = new RoundedBoxGeometry(0.11, 0.042, 0.055, 2, 0.014);
    framePs.push({ geo: crown, m: new Matrix4().setPosition(CROWN_C) });
    for (const side of [1, -1] as const) {
      const topC = CROWN_C.clone().add(new Vector3(side * 0.046, 0.012, 0));
      alloyPs.push(place(new CylinderGeometry(0.019, 0.019, 0.035, 14), topC, STEER_AXIS));
      const dial = new CylinderGeometry(0.0145, 0.0145, 0.009, 14);
      const dialP = topC.clone().addScaledVector(STEER_AXIS, -0.024);
      (side === -1 ? anoO : anoB).push(place(dial, dialP, STEER_AXIS));
      const bot = AXLE_C.clone().add(new Vector3(side * 0.052, 0, 0));
      const legDir = bot.clone().sub(topC);
      const legLen = legDir.length();
      legDir.normalize();
      alloyPs.push(
        place(
          new CylinderGeometry(0.0175, 0.0195, legLen, 12),
          topC.clone().addScaledVector(legDir, legLen * 0.5),
          legDir,
        ),
      );
    }
  } else {
    // rigid painted fork: small crown + blades, frame color
    const crown = new RoundedBoxGeometry(0.06, 0.045, 0.05, 2, 0.012);
    framePs.push({ geo: crown, m: new Matrix4().setPosition(CROWN_C) });
    for (const side of [1, -1] as const) {
      const top = CROWN_C.clone().add(new Vector3(side * 0.03, -0.01, 0));
      const bot = AXLE_C.clone().add(new Vector3(side * 0.047, 0, 0));
      const dir = bot.clone().sub(top);
      const len = dir.length();
      const leg = new CylinderGeometry(0.011, 0.0145, len, 10);
      framePs.push(place(leg, top.clone().addScaledVector(dir.normalize(), len * 0.5), dir));
    }
  }
  const forkMesh = new Mesh(merged(framePs), frameM);
  forkMesh.frustumCulled = false;
  fork.add(forkMesh);
  if (alloyPs.length > 0) {
    const m2 = new Mesh(merged(alloyPs), mats.alloy);
    m2.frustumCulled = false;
    fork.add(m2);
  }
  for (const [ps, mat] of [
    [anoO, mats.anoOrange],
    [anoB, mats.anoBlue],
  ] as [Part[], MeshStandardNodeMaterial][]) {
    if (ps.length > 0) {
      const mm = new Mesh(merged(ps), mat);
      mm.frustumCulled = false;
      fork.add(mm);
    }
  }
  return fork;
}

/** ONE shared wheel for all modes (spun by Cockpit.ts) */
function buildWheel(mats: SharedMats, tire: MeshStandardNodeMaterial): Group {
  const wheel = new Group();
  wheel.position.copy(AXLE_C);
  const R = 0.335;
  const tireGeo = new TorusGeometry(R, 0.021, 12, 48);
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
  return wheel;
}

// ---- public builder ---------------------------------------------------------

export function buildCockpit(): CockpitBuild {
  const mats: SharedMats = {
    carbon: carbonMat(),
    alloy: alloyMat(),
    rubber: rubberMat(),
    glove: gloveMat(),
    skin: skinMat(),
    bracelet: braceletMat(),
    anoOrange: anoMat('#d96716'),
    anoBlue: anoMat('#2b6fd4'),
  };
  const framePearl = frameMat('#e9eaec');
  const frameOlive = frameMat('#6b7050', 0.42);

  const root = new Group();
  root.name = 'cockpit';
  const steer = new Group();
  steer.name = 'cockpit-steer';
  steer.position.set(0, -BAR_DROP, -BAR_FWD);
  root.add(steer);

  const road = buildModeAssembly(
    {
      kind: 'drop',
      halfWidth: 0.2,
      flareDeg: 0,
      aero: true,
      tape: tapeMat('#141518', 46),
      handsOn: 'hoods',
      cables: 0,
      frame: framePearl,
      gloved: false,
    },
    mats,
  );
  const gravel = buildModeAssembly(
    {
      kind: 'drop',
      halfWidth: 0.22,
      flareDeg: 13,
      aero: false,
      tape: tapeMat('#17181b', 44),
      handsOn: 'tops',
      cables: 1,
      frame: framePearl,
      gloved: false,
    },
    mats,
  );
  const mtb = buildModeAssembly(
    {
      kind: 'riser',
      halfWidth: 0.39,
      flareDeg: 0,
      aero: false,
      tape: tapeMat('#101013', 150),
      handsOn: 'grips',
      cables: 2,
      frame: frameOlive,
      gloved: true,
    },
    mats,
  );
  road.name = 'road';
  gravel.name = 'gravel';
  mtb.name = 'mtb';
  gravel.visible = false;
  mtb.visible = false;
  steer.add(road, gravel, mtb);

  // per-mode forks (toggle with their mode); ONE shared wheel spins for all
  road.add(buildFork(framePearl, mats, false));
  gravel.add(buildFork(framePearl, mats, false));
  mtb.add(buildFork(frameOlive, mats, true));
  const wheel = buildWheel(mats, tireMat());
  steer.add(wheel);

  // computer floats out front on its riser mount (shared across modes)
  const comp = computerParts(new Vector3(0, 0.017, -0.118));
  const compBody = new Mesh(merged([...comp.body, ...comp.mount]), mats.rubber);
  compBody.frustumCulled = false;
  steer.add(compBody);
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
