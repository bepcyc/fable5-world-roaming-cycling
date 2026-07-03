/**
 * Cockpit — first-person bike rig driver (M1.5).
 *
 * Owns the CockpitParts build: positions it on the LOGICAL ride pose every
 * frame (eye = FlyCamera basePos; yaw = bike travel heading, NOT the free
 * mouse-look — looking around sweeps your gaze across a world-stable
 * cockpit, exactly like on a real bike), and layers the motion language:
 *   pitch  — follows road grade (smoothed)
 *   roll   — cornering lean (v·yawRate/g) + cadence rocking (power-scaled)
 *   jitter — surface texture buzz (amplitude from SurfaceId, speed-scaled,
 *            deterministic from worldTime so ?freeze probes stay stable)
 *   steer  — small visual bar yaw from the smoothed heading rate
 *   wheel  — spins at v/R
 * Registered on engine.onUpdate AFTER the FlyCamera mover (construction
 * order guarantees it), so the pose it reads is this frame's.
 *
 * Writes cockpitVelU prev/cur transforms for the TRAA reprojection seam
 * (see CockpitVelocity.ts) — no smear under camera rotation or travel.
 */

import { Matrix4 } from 'three';
import type { Engine } from '../../core/Engine';
import type { FlyCamera } from '../../core/FlyCamera';
import type { BikeRig } from '../BikeRig';
import type { SensorSource } from '../Sensors';
import { SurfaceId, type RideMode } from '../SurfaceMatrix';
import { BAR_DROP, buildCockpit, type CockpitBuild } from './CockpitParts';
import { ComputerScreen } from './ComputerScreen';
import { cockpitVelU } from './CockpitVelocity';

const WHEEL_R = 0.335;
const MOUNT_S = 0.45; // rise-in duration
const G = 9.81;

/** per-surface buzz amplitude (m) at full speed factor */
function buzzAmp(surfaceId: number): number {
  switch (surfaceId) {
    case SurfaceId.Asphalt:
      return 0.0004;
    case SurfaceId.GravelFine:
      return 0.0013;
    case SurfaceId.GravelCoarse:
    case SurfaceId.DirtRoad:
      return 0.0026;
    case SurfaceId.Singletrack:
    case SurfaceId.Rock:
    case SurfaceId.Scree:
    case SurfaceId.GravelRiver:
      return 0.0036;
    default:
      return 0.002;
  }
}

/** deterministic 0..1 hash (worldTime-keyed — stable under ?freeze) */
function h1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class Cockpit {
  private build: CockpitBuild;
  private screen: ComputerScreen;
  private fly: FlyCamera;
  private rig: BikeRig;
  /** live source getter — the options menu can swap sources at runtime */
  private source: () => SensorSource | null;

  private crankPhase = 0;
  private pitchSm = 0;
  private leanSm = 0;
  private yawRateSm = 0;
  private lastHeading: number | null = null;
  private mountK = 0;
  private jx = 0;
  private jy = 0;
  private jtx = 0;
  private jty = 0;
  private jSeed = -1;
  private shownMode: RideMode | null = null;
  private prevM = new Matrix4();
  private lastM = new Matrix4();
  private hasPrev = false;
  /** ride timer (s) — accumulates while actually moving (auto-pause) */
  private rideS = 0;
  /** ?ckdbg=1|road|gravel|mtb — cockpit pinned to the free camera gaze in
   *  ANY mode, for shape/aesthetic inspection from arbitrary --cam poses */
  private dbg: RideMode | null;

  constructor(
    engine: Engine,
    fly: FlyCamera,
    rig: BikeRig,
    source: () => SensorSource | null,
  ) {
    this.fly = fly;
    this.rig = rig;
    this.source = source;
    const dq = new URLSearchParams(window.location.search).get('ckdbg');
    this.dbg = dq === null ? null : dq === 'gravel' ? 'gravel' : dq === 'mtb' ? 'mtb' : 'road';
    this.build = buildCockpit();
    this.build.root.visible = false;
    this.screen = new ComputerScreen(this.build.screen);
    engine.scene.add(this.build.root);
    cockpitVelU.maxDist.value = this.build.maxDist;
    engine.onUpdate((dt, wt) => this.update(dt, wt));
    // probe hook (tools/probe-cktraa.ts): live-toggle the TRAA velocity fix
    const dbg =
      (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg ?? {};
    dbg['ckVelFix'] = (on: boolean): void => {
      this.velFix = on;
    };
    (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg = dbg;
  }

  /** TRAA velocity seam enable (probe-toggleable to demonstrate the smear) */
  private velFix = true;

  private update(dt: number, wt: number): void {
    const st = this.rig.state();
    if (this.dbg) st.mode = this.dbg;
    const riding = this.dbg !== null || (st.riding && this.fly.mode === 'ride');
    const root = this.build.root;

    if (!riding) {
      if (root.visible) root.visible = false;
      if (cockpitVelU.on.value !== 0) cockpitVelU.on.value = 0;
      this.mountK = 0;
      this.lastHeading = null;
      this.hasPrev = false;
      return;
    }
    root.visible = true;
    this.mountK = Math.min(this.mountK + dt / MOUNT_S, 1);

    // ---- mode variant
    if (this.shownMode !== st.mode) {
      this.shownMode = st.mode;
      for (const [name, g] of Object.entries(this.build.modes)) {
        g.visible = name === st.mode;
      }
    }

    // ---- pose: eye position + travel heading (debug: pinned to the gaze)
    const pose = this.fly.getPose();
    const heading = this.dbg !== null ? pose.yaw : this.fly.rideViewHeading;
    root.position.set(pose.p[0], pose.p[1], pose.p[2]);

    // heading rate (smoothed) → lean + visual steer
    if (this.lastHeading !== null && dt > 1e-6) {
      let dh = heading - this.lastHeading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const rate = dh / dt;
      this.yawRateSm += (rate - this.yawRateSm) * (1 - Math.exp(-dt * 6));
    }
    this.lastHeading = heading;

    // ---- motion language
    const v = st.vMs;
    // grade pitch: nose up on climbs (positive grade = rising along travel)
    const pitchTarget = Math.atan(st.grade);
    this.pitchSm += (pitchTarget - this.pitchSm) * (1 - Math.exp(-dt * 3.2));
    // cornering lean: balance the centripetal acceleration. Capped LOW:
    // real riders lean the bike, not their eye line — past ~0.2 rad the
    // near forearm sweeps across the lens as a giant blob (owner report)
    const leanTarget = Math.max(Math.min((v * this.yawRateSm) / G, 0.2), -0.2);
    this.leanSm += (leanTarget - this.leanSm) * (1 - Math.exp(-dt * 4.5));
    // cadence rocking (one full L/R sway per crank revolution)
    const rpm = this.source()?.read().cadenceRpm ?? 0;
    this.crankPhase += ((rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    const powerK = Math.min(st.powerW / 350, 1);
    const swayAmp = v > 0.3 && rpm > 20 ? 0.0045 + 0.011 * powerK : 0;
    const sway = Math.sin(this.crankPhase) * swayAmp;
    const bobY = Math.cos(this.crankPhase * 2) * swayAmp * 0.35;

    // surface buzz — deterministic, retargeted at 25 Hz
    const seed = Math.floor(wt * 25);
    if (seed !== this.jSeed) {
      this.jSeed = seed;
      const amp = buzzAmp(st.surfaceId) * Math.min(v / 8, 1);
      this.jtx = (h1(seed) - 0.5) * 2 * amp;
      this.jty = (h1(seed + 57) - 0.5) * 2 * amp;
    }
    const jk = 1 - Math.exp(-dt * 40);
    this.jx += (this.jtx - this.jx) * jk;
    this.jy += (this.jty - this.jy) * jk;

    // compose: yaw → pitch → roll (YXZ), rise-in on mount
    const rise = (1 - easeOut(this.mountK)) * -0.16;
    root.rotation.order = 'YXZ';
    // dbg: yaw-only follow — pitching the camera down INSPECTS the cockpit
    root.rotation.set(this.dbg !== null ? 0 : this.pitchSm, heading, this.leanSm + sway);
    root.position.y += rise + bobY;

    // steer sub-group: visual bar yaw from heading rate + counter-steer hint
    const steer = this.build.steer;
    steer.rotation.y =
      Math.max(Math.min(this.yawRateSm * 0.3, 0.09), -0.09) - Math.sin(this.crankPhase) * 0.004;
    steer.position.x = this.jx;
    steer.position.y = -BAR_DROP + this.jy; // fit baseline + buzz
    // wheel spin (front wheel: top moves toward -Z)
    this.build.wheel.rotation.x -= (v / WHEEL_R) * dt;

    // ---- live screen: reference metrics page (map page under ?ckmap=1)
    if (v > 0.4) this.rideS += dt; // auto-pause like a real head unit
    const read = this.source()?.read();
    const pose2 = this.fly.getPose();
    this.screen.update(
      dt,
      {
        kmh: v * 3.6,
        powerW: st.riding ? st.powerW : (read?.powerW ?? null),
        cadenceRpm: read?.cadenceRpm ?? null,
        hrBpm: read?.heartRateBpm ?? null,
        distM: st.distM,
        elapsedS: this.rideS,
        hazard: st.hazard
          ? { distM: st.hazard.distM, label: st.hazard.kind === 'slope' ? 'STEEP' : st.hazard.what.toUpperCase() }
          : null,
      },
      {
        graph: this.rig.routeGraph,
        x: pose2.p[0],
        z: pose2.p[2],
        heading,
      },
    );

    // ---- TRAA reprojection transforms (frame-paced: exactly once per frame)
    root.updateMatrixWorld(true);
    if (!this.hasPrev) {
      this.lastM.copy(root.matrixWorld);
      this.hasPrev = true;
    }
    this.prevM.copy(this.lastM);
    this.lastM.copy(root.matrixWorld);
    (cockpitVelU.prev.value as Matrix4).copy(this.prevM);
    (cockpitVelU.curInv.value as Matrix4).copy(this.lastM).invert();
    cockpitVelU.on.value = this.velFix ? 1 : 0;
  }
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}
