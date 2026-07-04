/**
 * BikeRig — M1.3 movement-mode state machine + route-following bike mover.
 *
 * Modes: hike (the FlyCamera walk rig) ⇄ road / gravel / mtb. `M` cycles.
 * Bike modes are LOCKED without a power source (Pillar C honesty: no
 * phantom watts) — DemoSensorSource (?ride=demo, DEMO badge) and the
 * keyboard bike (?ridedev=1, DEV badge) satisfy the seam until BLE (M1.4).
 *
 * Riding follows the road graph (Zwift principle): position advances along
 * RouteGraph edges from the fixed-timestep BikeSolver; at junctions the
 * rider CHOOSES (owner directive: on-screen "turn ahead" pick, не по
 * рельсам) with ←/→, default = straightest exit. Dead ends U-turn.
 *
 * The solver runs ONLY on Engine.onFixedUpdate — never on frame dt — so
 * P1–P4 hold across ?dt sweeps. Camera: FlyCamera 'ride' mode (free
 * mouse-look, idle auto-align); eye height above the PROBED ground so the
 * wheels honestly track the carved surface (conformance ≤ 0.15 m).
 */

import type { Engine } from '../core/Engine';
import type { FlyCamera, GroundProbe } from '../core/FlyCamera';
import { stepBike, type BikeMode, type SolverState } from './BikeSolver';
import type { RouteGraph } from './RouteGraph';
import type { KeyboardPowerSource, SensorSource } from './Sensors';
import { MODE_LIMITS, surfaceDef, surfaceName, type RideMode } from './SurfaceMatrix';

const EYE_SADDLE = 1.62; // m — seated eye height
const G = 9.81; // m/s² — centripetal lean denominator
// --- Track B "ride feel" (pose-only; BikeSolver physics untouched) --------
// B1 eye-Y suspension: one-pole low-pass on the raw ground-eye height so the
// eye floats over carve micro-steps instead of snapping vertex to vertex.
const SUSP_RATE = 5; // one-pole rate 1/s (?ridesusp= override; ≤0 disables)
const SUSP_DEV_MAX = 0.2; // m — suspended eye clamped to raw ± this
// B2 eye roll: the eye takes a small fraction of the bike's cornering lean
// plus a share of the road bank (superelevation), never the full lean.
const ROLL_LEAN_FRAC = 0.35; // fraction of bike lean the eye rolls (?rideroll=)
const ROLL_BANK_K = 0.6; // road-bank contribution (?ridebank=)
const ROLL_MAX = 0.08; // rad — hard cap on eye roll
const ROLL_RATE = 4; // exp-damp rate 1/s toward roll target
const RIDE_YAWRATE_RATE = 5; // exp-damp rate 1/s for the pose yaw-rate estimate
// B6 look-ahead trajectory (pure pursuit toward a point down the route)
const TRAJ_LOOK_S = 1.2; // seconds of speed to look ahead (?ridelook=)
const TRAJ_LOOK_MIN = 6; // m
const TRAJ_LOOK_MAX = 25; // m
const TRAJ_PURSUIT_K = 3.5; // proportional yaw-rate gain on heading error
const TRAJ_ALAT_MAX = 4.5; // m/s² — lateral-accel budget capping yaw rate
const TRAJ_YAWRATE_FLOOR = 0.9; // rad/s — min yaw-rate cap at speed
const TRAJ_ERR_SNAP = 0.5; // rad — above this the cap releases (U-turn resync)
const APEX_MAX = 0.5; // m — max lateral apex cut (?rideapex=; 0 disables)
const APEX_MARGIN = 0.35; // m — keep this clear of the lane edge
const APEX_WIN_S = 0.8; // seconds of speed for the apex smoothing window
const APEX_RATE = 6; // exp-damp rate 1/s into the pose offset
const MOUNT_MAX_DIST = 30; // m — nearest road within this or bike is refused
const JUNCTION_BASE_M = 45; // chooser appears at max(this, v * 5.5) meters
const JUNCTION_LEAD_S = 5.5;
const NOTE_TTL_S = 2.6;
const MODE_ORDER: readonly RideMode[] = ['hike', 'road', 'gravel', 'mtb'];

export type Turn = 'left' | 'right' | 'straight' | 'sharp-left' | 'sharp-right' | 'u-turn';

export interface JunctionOption {
  turn: Turn;
  /** signed turn angle (rad; + = left) */
  angle: number;
  cls: string;
  route: string;
  arm: { edge: number; end: 0 | 1 };
}

export interface JunctionPreview {
  distM: number;
  options: JunctionOption[];
  selected: number;
}

/** P5: first impassable point ahead along the default route */
export interface HazardAhead {
  distM: number;
  kind: 'surface' | 'slope';
  /** surface name (kind=surface) or grade fraction as string (kind=slope) */
  what: string;
}

// P5 lookahead tuning: scan far enough that the HUD can warn ≥2 s out at
// any legal speed; rescan cheaply on a coarse cadence, not every step
const HAZARD_SCAN_S = 0.15;
const HAZARD_STEP_M = 3;
const HAZARD_LOOK_S = 6;
const HAZARD_LOOK_MIN_M = 60;

export interface RideState {
  mode: RideMode;
  riding: boolean;
  vMs: number;
  powerW: number;
  grade: number;
  surfaceId: number;
  surface: string;
  status: 'allowed' | 'degraded' | 'blocked';
  blocked: boolean;
  stalled: boolean;
  ford: boolean;
  route: string;
  distM: number;
  junction: JunctionPreview | null;
  note: string | null;
  /** P5: nearest impassable point on the default route ahead (null = clear) */
  hazard: HazardAhead | null;
  /** B4: signed road bank at the ridden point (+ raises the outside) —
   *  the cockpit sits on the banked surface */
  bank: number;
}

export class BikeRig {
  private engine: Engine;
  private fly: FlyCamera;
  private graph: RouteGraph;
  private probe: GroundProbe;
  private source: SensorSource | null;

  private mode: RideMode = 'hike';
  private solver: SolverState = { v: 0, stalled: false };
  private edge = 0;
  private s = 0;
  private dir: 1 | -1 = 1;
  private lastOut = { blocked: false, stalled: false, accel: 0, grade: 0, surfaceId: 2 };
  private status: 'allowed' | 'degraded' | 'blocked' = 'allowed';
  private ford = false;
  private distM = 0;
  private junction: JunctionPreview | null = null;
  private note: string | null = null;
  private noteT = 0;
  private brake = false;
  private hazard: HazardAhead | null = null;
  private hazardScanT = 0;
  // fixed-step pose pair — the camera interpolates between them with the
  // engine's fixedAlpha (render smoothness AND dashboard==solver parity at
  // coarse ?dt values: pose-delta speed integrates exactly)
  private posePrev = { x: 0, y: 0, z: 0, heading: 0 };
  private poseCur = { x: 0, y: 0, z: 0, heading: 0 };
  // --- Track B ride-feel state (pose generation only) ---------------------
  // B1: suspended eye-Y (one-pole); B2: eye roll (fixed-step pair + smoother);
  // B6: pure-pursuit heading + apex offset. Runtime-tunable knobs mirror the
  // ?ride* query params and the __laasDbg.rideFeel setters.
  private suspY: number | null = null;
  private rollSm = 0;
  private rollPrev = 0;
  private rollCur = 0;
  private lastFixedHeading: number | null = null;
  private yawRateSm = 0;
  private headingCur = 0;
  private offX = 0;
  private offZ = 0;
  private bank = 0;
  private suspRate = SUSP_RATE;
  private rollLeanFrac = ROLL_LEAN_FRAC;
  private rollBankK = ROLL_BANK_K;
  private trajOn = true;
  private lookS = TRAJ_LOOK_S;
  private apexMax = APEX_MAX;

  constructor(
    engine: Engine,
    fly: FlyCamera,
    graph: RouteGraph,
    probe: GroundProbe,
    source: SensorSource | null,
  ) {
    this.engine = engine;
    this.fly = fly;
    this.graph = graph;
    this.probe = probe;
    this.source = source;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !e.repeat) this.cycleMode();
      if (this.mode !== 'hike') {
        if (e.code === 'Space' || e.code === 'KeyS' || e.code === 'ArrowDown') this.brake = true;
        if (e.code === 'ArrowLeft') this.pick(-1);
        if (e.code === 'ArrowRight') this.pick(1);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' || e.code === 'KeyS' || e.code === 'ArrowDown') this.brake = false;
    });
    window.addEventListener('blur', () => {
      this.brake = false;
    });

    engine.onFixedUpdate((dt) => this.fixedStep(dt));
    // camera pulls the interpolated pose DURING its own update — never stale
    fly.rideDriver = (out) => {
      const a = Math.min(Math.max(this.engine.fixedAlpha, 0), 1);
      const p = this.posePrev;
      const c = this.poseCur;
      out.x = p.x + (c.x - p.x) * a;
      out.y = p.y + (c.y - p.y) * a;
      out.z = p.z + (c.z - p.z) * a;
      let dh = c.heading - p.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      out.heading = p.heading + dh * a;
      out.roll = this.rollPrev + (this.rollCur - this.rollPrev) * a;
    };

    // ride-feel knobs: ?ride* query params (read once here, pattern
    // Cockpit.ts) then live-tunable via __laasDbg.rideFeel setters
    const q = new URLSearchParams(window.location.search);
    const num = (k: string, d: number): number => {
      const v = q.get(k);
      const n = v === null ? NaN : parseFloat(v);
      return Number.isFinite(n) ? n : d;
    };
    this.suspRate = num('ridesusp', SUSP_RATE);
    this.rollLeanFrac = num('rideroll', ROLL_LEAN_FRAC);
    this.rollBankK = num('ridebank', ROLL_BANK_K);
    this.lookS = num('ridelook', TRAJ_LOOK_S);
    this.apexMax = num('rideapex', APEX_MAX);
    this.trajOn = q.get('ridetraj') !== '0';
    const dbg =
      (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg ?? {};
    dbg['rideFeel'] = {
      setRoll: (k: number): void => {
        this.rollLeanFrac = k;
      },
      setBank: (k: number): void => {
        this.rollBankK = k;
      },
      setSusp: (rate: number): void => {
        this.suspRate = rate;
      },
      setTraj: (on: boolean): void => {
        this.trajOn = on;
      },
      setLook: (s: number): void => {
        this.lookS = s;
      },
      setApex: (m: number): void => {
        this.apexMax = m;
      },
      state: (): { rollMrad: number; eyeDevMm: number; offMm: number; hdgErrMrad: number } => {
        const cc = this.engine.stats.counters;
        return {
          rollMrad: cc['ride.rollMrad'] ?? 0,
          eyeDevMm: cc['ride.eyeDevMm'] ?? 0,
          offMm: cc['ride.offMm'] ?? 0,
          hdgErrMrad: cc['ride.hdgErrMrad'] ?? 0,
        };
      },
    };
    (window as unknown as { __laasDbg?: Record<string, unknown> }).__laasDbg = dbg;
  }

  get riding(): boolean {
    return this.mode !== 'hike';
  }

  state(): RideState {
    const src = this.source?.read();
    return {
      mode: this.mode,
      riding: this.riding,
      vMs: this.solver.v,
      powerW: this.riding ? (src?.powerW ?? 0) : 0,
      grade: this.lastOut.grade,
      surfaceId: this.lastOut.surfaceId,
      surface: surfaceName(this.lastOut.surfaceId),
      status: this.status,
      blocked: this.lastOut.blocked,
      stalled: this.lastOut.stalled,
      ford: this.ford,
      route: this.riding ? (this.graph.edges[this.edge]?.route ?? '') : '',
      distM: this.distM,
      junction: this.junction,
      note: this.note,
      hazard: this.hazard,
      bank: this.bank,
    };
  }

  /** probe API — enter a mode programmatically (same rules as the M key) */
  setMode(mode: RideMode): boolean {
    if (mode === this.mode) return true;
    if (mode === 'hike') {
      this.dismount();
      return true;
    }
    return this.mount(mode);
  }

  /** probe API — place the bike at a fraction along a class's first edge */
  teleport(clsName: string, frac: number): boolean {
    const edge =
      this.graph.edges.find((e) => e.cls.name === clsName) ?? this.graph.edges[0];
    if (!edge) return false;
    this.edge = edge.id;
    this.s = Math.min(Math.max(frac, 0), 1) * edge.length;
    this.dir = 1;
    this.solver = { v: 0, stalled: false };
    if (this.mode === 'hike') this.mode = 'road';
    const sm = this.graph.sample(this.edge, this.s);
    const g = this.probe(sm.x, sm.z);
    this.seedPose(sm.x, g.ground + EYE_SADDLE, sm.z, Math.atan2(-sm.tx, -sm.tz));
    return true;
  }

  /** probe API — mount directly onto an edge, aimed at one of its nodes */
  teleportEdge(edgeId: number, s: number, dir: 1 | -1): boolean {
    const e = this.graph.edges[edgeId];
    if (!e) return false;
    this.edge = edgeId;
    this.s = Math.min(Math.max(s, 0), e.length);
    this.dir = dir;
    this.solver = { v: 0, stalled: false };
    this.junction = null;
    if (this.mode === 'hike') this.mode = 'road';
    const sm = this.graph.sample(this.edge, this.s);
    const g = this.probe(sm.x, sm.z);
    this.seedPose(sm.x, g.ground + EYE_SADDLE, sm.z, this.heading(sm.tx, sm.tz));
    return true;
  }

  private seedPose(x: number, y: number, z: number, heading: number): void {
    this.posePrev = { x, y, z, heading };
    this.poseCur = { x, y, z, heading };
    // ride-feel state starts settled on the seed pose (no snap on mount)
    this.suspY = y;
    this.rollSm = 0;
    this.rollPrev = 0;
    this.rollCur = 0;
    this.lastFixedHeading = heading;
    this.yawRateSm = 0;
    this.headingCur = heading;
    this.offX = 0;
    this.offZ = 0;
    this.fly.beginRide(x, y, z, heading);
  }

  /** probe API — force power (keyboard source only) */
  setPower(w: number | null): void {
    const src = this.source as KeyboardPowerSource | null;
    if (src && typeof src.setOverride === 'function') src.setOverride(w);
  }

  /** runtime power-source swap (options menu): the honesty gates in
   *  mount() keep applying — a null source still locks the bikes */
  setSource(source: SensorSource | null): void {
    this.source = source;
  }

  /** route graph accessor (bike-computer map, M1.5 owner ref) */
  get routeGraph(): RouteGraph {
    return this.graph;
  }

  private cycleMode(): void {
    const i = MODE_ORDER.indexOf(this.mode);
    const next = MODE_ORDER[(i + 1) % MODE_ORDER.length] as RideMode;
    if (next === 'hike') {
      this.dismount();
      return;
    }
    if (!this.mount(next)) {
      // couldn't mount THIS bike — fall back to hike rather than sticking
      if (this.mode !== 'hike') this.dismount();
    }
  }

  private mount(mode: RideMode): boolean {
    if (mode === 'hike') return false;
    if (!this.source) {
      this.flash('BIKES LOCKED — NO POWER SOURCE (?ride=ble to connect sensors)');
      return false;
    }
    // BLE honesty gate: a BLE source with no live power channel is the same
    // as no source — connect the trainer/power meter first (Pillar C)
    if (this.source.kind === 'ble' && this.source.read().powerW === null) {
      this.flash('BIKES LOCKED — CONNECT A POWER SOURCE (trainer or power meter)');
      return false;
    }
    if (this.riding) {
      // already on the network — just swap machines
      this.mode = mode;
      this.flash(`${mode.toUpperCase()} BIKE`);
      return true;
    }
    const pose = this.fly.getPose();
    const pr = this.graph.project(pose.p[0], pose.p[2]);
    if (pr.edge < 0 || pr.dist > MOUNT_MAX_DIST) {
      this.flash(`NO ROAD WITHIN ${MOUNT_MAX_DIST} m`);
      return false;
    }
    this.edge = pr.edge;
    this.s = pr.s;
    // face the way the camera faces
    const sm = this.graph.sample(this.edge, this.s);
    const fx = -Math.sin(pose.yaw);
    const fz = -Math.cos(pose.yaw);
    this.dir = fx * sm.tx + fz * sm.tz >= 0 ? 1 : -1;
    this.solver = { v: 0, stalled: false };
    this.junction = null;
    this.mode = mode;
    const g = this.probe(sm.x, sm.z);
    this.seedPose(sm.x, g.ground + EYE_SADDLE, sm.z, this.heading(sm.tx, sm.tz));
    this.flash(`${mode.toUpperCase()} BIKE`);
    return true;
  }

  private dismount(): void {
    if (this.mode === 'hike') return;
    this.mode = 'hike';
    this.junction = null;
    this.hazard = null;
    this.solver = { v: 0, stalled: false };
    this.fly.setMode('walk');
    this.flash('ON FOOT');
  }

  private flash(msg: string): void {
    this.note = msg;
    this.noteT = NOTE_TTL_S;
  }

  private heading(tx: number, tz: number): number {
    return Math.atan2(-tx * this.dir, -tz * this.dir);
  }

  private pick(step: -1 | 1): void {
    if (!this.junction || this.junction.options.length < 2) return;
    const n = this.junction.options.length;
    this.junction.selected = Math.min(Math.max(this.junction.selected + step, 0), n - 1);
  }

  private fixedStep(dt: number): void {
    if (this.noteT > 0) {
      this.noteT -= dt;
      if (this.noteT <= 0) this.note = null;
    }
    if (!this.riding) return;
    const mode = this.mode as BikeMode;

    const sm = this.graph.sample(this.edge, this.s);
    const g = this.probe(sm.x, sm.z);
    const grade = sm.grade * this.dir;
    const powerW = this.source?.read().powerW ?? 0;

    const out = stepBike(this.solver, {
      powerW,
      brake: this.brake ? 1 : 0,
      grade,
      surfaceId: g.surfaceId,
      mode,
      dt,
    });
    this.solver = { v: out.v, stalled: out.stalled };
    this.status = out.params.status;
    // BLE trainers mirror the terrain: live grade + honest surface Crr →
    // FTMS SIM writes (rate-limited inside the source)
    this.source?.setSimState?.(grade, out.params.crr);
    this.lastOut = {
      blocked: out.blocked,
      stalled: out.stalled,
      accel: out.accel,
      grade,
      surfaceId: g.surfaceId,
    };
    this.ford = sm.ford;

    // advance along the edge; cross nodes with the picked (or default) exit
    let ds = out.v * dt;
    this.distM += ds;
    let guard = 4;
    while (ds > 0 && guard-- > 0) {
      const e = this.graph.edges[this.edge];
      if (!e) break;
      const remain = this.dir > 0 ? e.length - this.s : this.s;
      if (ds < remain) {
        this.s += ds * this.dir;
        ds = 0;
        break;
      }
      ds -= remain;
      const nodeId = this.dir > 0 ? e.b : e.a;
      const exits = this.graph.exits(nodeId, e.id);
      if (exits.length === 0) {
        // dead end — honest U-turn, scrubbing most speed
        this.dir = this.dir > 0 ? -1 : 1;
        this.s = this.dir > 0 ? 0 : e.length;
        this.solver.v *= 0.25;
        this.flash('DEAD END — U-TURN');
        this.junction = null;
        ds = 0;
        break;
      }
      const opts = this.buildOptions(nodeId, e.id);
      const chosen =
        this.junction && this.junction.options.length === opts.length
          ? (opts[this.junction.selected] ?? opts[0])
          : this.defaultOption(opts);
      const arm = (chosen as JunctionOption).arm;
      this.edge = arm.edge;
      this.dir = arm.end === 0 ? 1 : -1;
      this.s = this.dir > 0 ? 0 : (this.graph.edges[this.edge]?.length ?? 0);
      this.junction = null;
    }

    // junction preview for the chooser UI
    this.updateJunctionPreview();

    // P5 hazard lookahead — coarse cadence, ~20 probes max per scan
    this.hazardScanT -= dt;
    if (this.hazardScanT <= 0) {
      this.hazardScanT = HAZARD_SCAN_S;
      this.hazard = this.scanHazard();
    }

    // ---- pose generation: Track B "ride feel" (pose-only; the physics above
    // is already integrated). Heading = pure-pursuit toward a look-ahead
    // point; position = center-line + small apex offset; eye Y = suspended
    // over the (offset) carved surface; roll = a fraction of lean + bank.
    const sm2 = this.graph.sample(this.edge, this.s);
    const e2 = this.graph.edges[this.edge];
    const v = out.v;
    const tangentHeading = this.heading(sm2.tx, sm2.tz);

    // B6 heading — pure pursuit. ?ridetraj=0 restores the exact legacy
    // tangent heading; low speed / imminent dead end falls back to tangent.
    let hdgErr = 0;
    if (this.trajOn && v >= 0.5) {
      const L = Math.max(TRAJ_LOOK_MIN, Math.min(v * this.lookS, TRAJ_LOOK_MAX));
      const tgt = this.walkAhead(this.edge, this.s, this.dir, L);
      if (tgt.reached >= 2) {
        // bearing to target in the SAME frame as heading() (atan2(-x, -z))
        const bearing = Math.atan2(-(tgt.x - sm2.x), -(tgt.z - sm2.z));
        let err = bearing - this.headingCur;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        hdgErr = err;
        const cap = Math.max(TRAJ_YAWRATE_FLOOR, TRAJ_ALAT_MAX / Math.max(v, 3));
        let rate = err * TRAJ_PURSUIT_K;
        // inside the snap band, hold the lateral-accel cap; a big error
        // (U-turn / teleport) releases it so the view resyncs within ~30°
        if (Math.abs(err) <= TRAJ_ERR_SNAP) rate = Math.max(Math.min(rate, cap), -cap);
        const h = this.headingCur + rate * dt;
        this.headingCur = Math.atan2(Math.sin(h), Math.cos(h));
      } else {
        this.headingCur = tangentHeading;
      }
    } else {
      this.headingCur = tangentHeading;
    }

    // B2 eye roll — yaw-rate fed from the ACTUAL pose heading (headingCur),
    // so anticipated lean comes for free. Bank sign: bank raises the OUTSIDE
    // of a curve, so in a correctly superelevated corner the bank term AGREES
    // with the lean term; if they fight on a hairpin, flip the *this.dir on
    // the bank term below.
    if (this.lastFixedHeading === null) this.lastFixedHeading = this.headingCur;
    let dh = this.headingCur - this.lastFixedHeading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.lastFixedHeading = this.headingCur;
    this.yawRateSm += (dh / dt - this.yawRateSm) * (1 - Math.exp(-dt * RIDE_YAWRATE_RATE));
    const lean = Math.max(Math.min((v * this.yawRateSm) / G, 0.2), -0.2);
    const rollTarget = Math.max(
      Math.min(this.rollLeanFrac * lean + this.rollBankK * sm2.bank * this.dir, ROLL_MAX),
      -ROLL_MAX,
    );
    this.rollSm += (rollTarget - this.rollSm) * (1 - Math.exp(-dt * ROLL_RATE));
    this.rollPrev = this.rollCur;
    this.rollCur = this.rollSm;

    // B6 apex — nudge the ridden line toward the average of a point behind,
    // here, and a point ahead, bounded by the lane half-width. Disabled by
    // ?ridetraj=0 or ?rideapex=0 (offset relaxes/snaps to the center-line).
    if (this.trajOn && this.apexMax > 0 && v >= 0.5 && e2) {
      const W = Math.max(5, Math.min(v * APEX_WIN_S, 14));
      const sBehind = Math.max(Math.min(this.s - W * this.dir, e2.length), 0);
      const behind = this.graph.sample(this.edge, sBehind);
      const ahead = this.walkAhead(this.edge, this.s, this.dir, W);
      const avgX = (behind.x + sm2.x + ahead.x) / 3;
      const avgZ = (behind.z + sm2.z + ahead.z) / 3;
      let ox = avgX - sm2.x;
      let oz = avgZ - sm2.z;
      const cap = Math.max(0, Math.min(this.apexMax, e2.cls.halfWidth - APEX_MARGIN));
      const mag = Math.hypot(ox, oz);
      if (mag > cap && mag > 1e-6) {
        ox = (ox / mag) * cap;
        oz = (oz / mag) * cap;
      }
      const ak = 1 - Math.exp(-dt * APEX_RATE);
      this.offX += (ox - this.offX) * ak;
      this.offZ += (oz - this.offZ) * ak;
    } else if (this.trajOn && this.apexMax > 0) {
      // too slow to carve — relax the offset back to the center-line
      const ak = 1 - Math.exp(-dt * APEX_RATE);
      this.offX += (0 - this.offX) * ak;
      this.offZ += (0 - this.offZ) * ak;
    } else {
      this.offX = 0;
      this.offZ = 0;
    }

    // probe the OFFSET point so the eye height + bank track the surface the
    // wheels actually ride, not the center-line
    const px = sm2.x + this.offX;
    const pz = sm2.z + this.offZ;
    const g2 = this.probe(px, pz);

    // B1 eye-Y suspension — one-pole over the raw ground eye, clamped so the
    // eye never floats more than SUSP_DEV_MAX off the true surface
    const yRaw = g2.ground + EYE_SADDLE;
    if (this.suspRate <= 0 || this.suspY === null) {
      this.suspY = yRaw;
    } else {
      this.suspY += (yRaw - this.suspY) * (1 - Math.exp(-dt * this.suspRate));
      this.suspY = Math.max(Math.min(this.suspY, yRaw + SUSP_DEV_MAX), yRaw - SUSP_DEV_MAX);
    }

    // B4: expose the ridden bank so the cockpit sits on the banked surface
    this.bank = sm2.bank * this.dir;

    this.posePrev = this.poseCur;
    this.poseCur = { x: px, y: this.suspY, z: pz, heading: this.headingCur };

    // counters — probes assert against THESE (dashboard parity check)
    const c = this.engine.stats.counters;
    c['ride.kmh100'] = Math.round(this.solver.v * 3.6 * 100);
    c['ride.powerW'] = Math.round(powerW);
    c['ride.grade1000'] = Math.round(grade * 1000);
    c['ride.surface'] = g.surfaceId;
    c['ride.blocked'] = out.blocked ? 1 : 0;
    c['ride.stalled'] = out.stalled ? 1 : 0;
    c['ride.mode'] = MODE_ORDER.indexOf(this.mode);
    // Track B ride-feel telemetry (__laasDbg.rideFeel.state mirrors these)
    c['ride.rollMrad'] = Math.round(this.rollCur * 1000);
    c['ride.eyeDevMm'] = Math.round((this.suspY - yRaw) * 1000);
    c['ride.offMm'] = Math.round(Math.hypot(this.offX, this.offZ) * 1000);
    c['ride.hdgErrMrad'] = Math.round(hdgErr * 1000);
  }

  /**
   * P5: walk the DEFAULT route ahead (current chooser pick at the first
   * junction, straightest exit beyond) sampling surface + travel grade;
   * return the first point the CURRENT mode cannot enter.
   */
  private scanHazard(): HazardAhead | null {
    if (!this.riding) return null;
    const mode = this.mode;
    const limit = MODE_LIMITS[mode].maxSlope;
    const look = Math.max(HAZARD_LOOK_MIN_M, this.solver.v * HAZARD_LOOK_S);
    let edge = this.edge;
    let s = this.s;
    let dir = this.dir;
    let travelled = 0;
    let firstJunction = true;
    let guard = 96;
    while (travelled < look && guard-- > 0) {
      const e = this.graph.edges[edge];
      if (!e) break;
      const remain = dir > 0 ? e.length - s : s;
      const step = Math.min(HAZARD_STEP_M, look - travelled);
      if (step < remain) {
        s += step * dir;
        travelled += step;
        const sm = this.graph.sample(edge, s);
        const g = this.probe(sm.x, sm.z);
        const grade = sm.grade * dir;
        if (surfaceDef(g.surfaceId).modes[mode].status === 'blocked') {
          return { distM: travelled, kind: 'surface', what: surfaceName(g.surfaceId) };
        }
        if (Math.abs(grade) > limit) {
          return { distM: travelled, kind: 'slope', what: `${(grade * 100).toFixed(0)}%` };
        }
      } else {
        // cross the node the way the rider would
        travelled += remain;
        const nodeId = dir > 0 ? e.b : e.a;
        const exits = this.graph.exits(nodeId, e.id);
        if (exits.length === 0) break; // dead end U-turns before any zone
        let arm = null;
        if (firstJunction && this.junction && exits.length >= 2) {
          const opts = this.buildOptions(nodeId, e.id);
          arm = opts[this.junction.selected]?.arm ?? null;
        }
        if (!arm) {
          const inSm = this.graph.sample(e.id, dir > 0 ? e.length : 0);
          arm = this.straightestExit(nodeId, e.id, inSm.tx * dir, inSm.tz * dir);
        }
        if (!arm) break;
        firstJunction = false;
        edge = arm.edge;
        dir = arm.end === 0 ? 1 : -1;
        s = dir > 0 ? 0 : (this.graph.edges[edge]?.length ?? 0);
      }
    }
    return null;
  }

  /**
   * B6: walk `dist` metres down the route from (edge, s, dir) and return the
   * point reached — the same route the rider will take (current chooser pick
   * at the FIRST junction, straightest exit beyond; dead ends stop early with
   * reached < dist). Graph-only (no ground probes); clones the scanHazard
   * traversal, one edge per iteration, guarded to ≤8 crossings.
   */
  private walkAhead(
    startEdge: number,
    startS: number,
    startDir: 1 | -1,
    dist: number,
  ): { x: number; z: number; reached: number } {
    let edge = startEdge;
    let s = startS;
    let dir: 1 | -1 = startDir;
    let travelled = 0;
    let firstJunction = true;
    let guard = 8;
    const here = this.graph.sample(edge, s);
    let px = here.x;
    let pz = here.z;
    while (travelled < dist && guard-- > 0) {
      const e = this.graph.edges[edge];
      if (!e) break;
      const remain = dir > 0 ? e.length - s : s;
      const step = dist - travelled;
      if (step < remain) {
        s += step * dir;
        travelled += step;
        const sm = this.graph.sample(edge, s);
        px = sm.x;
        pz = sm.z;
        break;
      }
      // reach the node at the end of this edge
      travelled += remain;
      s = dir > 0 ? e.length : 0;
      const endSm = this.graph.sample(edge, s);
      px = endSm.x;
      pz = endSm.z;
      const nodeId = dir > 0 ? e.b : e.a;
      const exits = this.graph.exits(nodeId, e.id);
      if (exits.length === 0) break; // dead end — stop, reached < dist
      let arm: { edge: number; end: 0 | 1 } | null = null;
      if (firstJunction && this.junction && exits.length >= 2) {
        const opts = this.buildOptions(nodeId, e.id);
        arm = opts[this.junction.selected]?.arm ?? null;
      }
      if (!arm) {
        const inSm = this.graph.sample(e.id, dir > 0 ? e.length : 0);
        arm = this.straightestExit(nodeId, e.id, inSm.tx * dir, inSm.tz * dir);
      }
      if (!arm) break;
      firstJunction = false;
      edge = arm.edge;
      dir = arm.end === 0 ? 1 : -1;
      s = dir > 0 ? 0 : (this.graph.edges[edge]?.length ?? 0);
    }
    return { x: px, z: pz, reached: travelled };
  }

  private straightestExit(
    nodeId: number,
    arrivedEdge: number,
    inx: number,
    inz: number,
  ): { edge: number; end: 0 | 1 } | null {
    const exits = this.graph.exits(nodeId, arrivedEdge);
    let best: { arm: { edge: number; end: 0 | 1 }; turn: number } | null = null;
    for (const arm of exits) {
      const oe = this.graph.edges[arm.edge];
      if (!oe) continue;
      const sm = this.graph.sample(
        oe.id,
        arm.end === 0 ? Math.min(10, oe.length) : Math.max(oe.length - 10, 0),
      );
      const outDir = arm.end === 0 ? 1 : -1;
      const ox = sm.tx * outDir;
      const oz = sm.tz * outDir;
      const turn = Math.abs(Math.atan2(inx * oz - inz * ox, inx * ox + inz * oz));
      if (!best || turn < best.turn) best = { arm, turn };
    }
    return best?.arm ?? null;
  }

  private buildOptions(nodeId: number, arrivedEdge: number): JunctionOption[] {
    const exits = this.graph.exits(nodeId, arrivedEdge);
    // incoming heading at the node
    const e = this.graph.edges[this.edge];
    const inSm = e ? this.graph.sample(e.id, this.dir > 0 ? e.length : 0) : null;
    const inx = inSm ? inSm.tx * this.dir : 0;
    const inz = inSm ? inSm.tz * this.dir : 1;
    const opts = exits.map((arm) => {
      const oe = this.graph.edges[arm.edge];
      const sm = oe
        ? this.graph.sample(oe.id, arm.end === 0 ? Math.min(10, oe.length) : Math.max(oe.length - 10, 0))
        : null;
      const outDir = arm.end === 0 ? 1 : -1;
      const ox = sm ? sm.tx * outDir : 0;
      const oz = sm ? sm.tz * outDir : 1;
      // signed angle in the XZ plane (+ = left turn for -z forward frames)
      const cross = inx * oz - inz * ox;
      const dot = inx * ox + inz * oz;
      const angle = Math.atan2(cross, dot);
      return {
        turn: classifyTurn(angle),
        angle,
        cls: oe?.cls.name ?? '',
        route: oe?.route ?? '',
        arm,
      } satisfies JunctionOption;
    });
    // left → right ordering for the chooser
    opts.sort((a, b) => b.angle - a.angle);
    return opts;
  }

  private defaultOption(opts: JunctionOption[]): JunctionOption {
    let best = opts[0] as JunctionOption;
    for (const o of opts) if (Math.abs(o.angle) < Math.abs(best.angle)) best = o;
    return best;
  }

  private updateJunctionPreview(): void {
    const e = this.graph.edges[this.edge];
    if (!e) {
      this.junction = null;
      return;
    }
    const remain = this.dir > 0 ? e.length - this.s : this.s;
    const lead = Math.max(JUNCTION_BASE_M, this.solver.v * JUNCTION_LEAD_S);
    const nodeId = this.dir > 0 ? e.b : e.a;
    const exits = this.graph.exits(nodeId, e.id);
    if (remain > lead || exits.length < 2) {
      if (this.junction && (remain > lead || exits.length < 2)) this.junction = null;
      return;
    }
    if (!this.junction) {
      const options = this.buildOptions(nodeId, e.id);
      const def = this.defaultOption(options);
      this.junction = { distM: remain, options, selected: options.indexOf(def) };
    } else {
      this.junction.distM = remain;
    }
  }

  /** slope limit for the CURRENT mode (HUD detail) */
  modeMaxSlope(): number {
    return MODE_LIMITS[this.mode].maxSlope;
  }
}

function classifyTurn(angle: number): Turn {
  const a = angle;
  const deg = (a * 180) / Math.PI;
  if (deg > 135) return 'u-turn';
  if (deg > 55) return 'sharp-left';
  if (deg > 18) return 'left';
  if (deg < -135) return 'u-turn';
  if (deg < -55) return 'sharp-right';
  if (deg < -18) return 'right';
  return 'straight';
}
