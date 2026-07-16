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
 * rider CHOOSES (owner directive: on-screen "turn ahead" pick, not on
 * rails) with ←/→ or a tap, options laid out left→right by real exit angle.
 * The choice window CLOSES at a cutoff BEFORE the node (Zwift rule,
 * docs/TURN_PICKER.md): the pick is frozen into a LockedTurn, late input is
 * structurally impossible, and the crossing rides a continuity bridge — the
 * pose NEVER jumps between the two edge polylines. Default = straightest
 * exit. Dead ends U-turn.
 *
 * The solver runs ONLY on Engine.onFixedUpdate — never on frame dt — so
 * P1–P4 hold across ?dt sweeps. Camera: FlyCamera 'ride' mode (free
 * mouse-look, idle auto-align); eye height above the PROBED ground so the
 * wheels honestly track the carved surface (conformance ≤ 0.15 m).
 */

import type { Engine } from '../core/Engine';
import type { FlyCamera, GroundProbe } from '../core/FlyCamera';
import { t } from '../core/I18n';
import { stepBike, type BikeMode, type SolverState } from './BikeSolver';
import type { RoadPoint } from './RoadNetwork';
import { samplePolyline, type EdgeSample, type GraphArm, type RouteGraph } from './RouteGraph';
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
const JUNCTION_BASE_M = 45; // chooser appears at max(this, v * 5.5) m (+ node radius)
const JUNCTION_LEAD_S = 5.5;
// Zwift rule (docs/TURN_PICKER.md): the choice window CLOSES before the node.
// v·1.2 s ≈ one steering reaction; the 8 m floor keeps walking-pace approaches
// from choosing inside the apron; the node's physical radius is added on top
// so the lock lands BEFORE the roads visibly split.
const LOCK_BASE_M = 8; // m — cutoff floor
const LOCK_LEAD_S = 1.2; // s — dynamic cutoff at speed
// junction continuity bridge (no-teleport law): Bézier stitched between the
// arrival edge's terminal point and the chosen exit's entry point
const BRIDGE_MIN_M = 0.05; // m — below this the endpoints coincide, no bridge
const BRIDGE_STEP_M = 2; // m — bridge polyline sampling step
const ARM_CHORD_M = 12; // m — chord length for junction arm directions
const NOTE_TTL_S = 2.6;
const MODE_ORDER: readonly RideMode[] = ['hike', 'road', 'gravel', 'mtb'];

export type Turn =
  | 'straight'
  | 'slight-left'
  | 'slight-right'
  | 'left'
  | 'right'
  | 'sharp-left'
  | 'sharp-right'
  | 'u-turn';

export interface JunctionOption {
  turn: Turn;
  /** signed turn angle (rad; + = left) */
  angle: number;
  cls: string;
  route: string;
  arm: GraphArm;
}

export interface JunctionPreview {
  /** node this preview belongs to (stale-guard for locks and walkers) */
  nodeId: number;
  /** edge the preview approaches the node on */
  viaEdge: number;
  distM: number;
  /** distance at which the choice locks (HUD + gate assert against this) */
  lockM: number;
  options: JunctionOption[];
  selected: number;
}

/** a committed turn: frozen at the cutoff, consumed at the node crossing */
interface LockedTurn {
  nodeId: number;
  viaEdge: number;
  arm: GraphArm;
  turn: Turn;
  cls: string;
  angle: number;
}

/** synthetic polyline stitched across a junction (docs/TURN_PICKER.md) */
interface Bridge {
  pts: RoadPoint[];
  length: number;
  s: number;
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
  /** committed turn (choice window closed, node not crossed yet) */
  turnLocked: { turn: Turn; cls: string; angle: number; distM: number } | null;
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
  private locked: LockedTurn | null = null;
  private bridge: Bridge | null = null;
  /** node id → max distance from centroid to any arm endpoint (lazy) */
  private nodeRadiusCache = new Map<number, number>();
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
      turnLocked: this.locked
        ? {
            turn: this.locked.turn,
            cls: this.locked.cls,
            angle: this.locked.angle,
            distM: this.remainToNode(),
          }
        : null,
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
    this.junction = null;
    this.locked = null;
    this.bridge = null;
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
    this.locked = null;
    this.bridge = null;
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

  /** touch UI (RideHud junction cards): pick a turn by index — the tap
   *  equivalent of ←/→, which only fires from a keydown listener and so is
   *  unreachable on a device with no keyboard. Same clamp as pick(). */
  pickJunctionOption(index: number): void {
    if (!this.junction) return;
    const n = this.junction.options.length;
    this.junction.selected = Math.min(Math.max(index, 0), n - 1);
  }

  /** touch UI (RideHud brake button): hold-to-brake — the tap equivalent of
   *  Space/S/↓, which only fire from keydown/keyup listeners. */
  setBrake(on: boolean): void {
    this.brake = on;
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
      this.flash(t('ride.lockedNoPower'));
      return false;
    }
    // BLE honesty gate: a BLE source with no live power channel is the same
    // as no source — connect the trainer/power meter first (Pillar C)
    if (this.source.kind === 'ble' && this.source.read().powerW === null) {
      this.flash(t('ride.lockedConnectPower'));
      return false;
    }
    if (this.riding) {
      // already on the network — just swap machines
      this.mode = mode;
      this.flash(t('ride.mountBike', { mode: t('mode.' + mode) }));
      return true;
    }
    const pose = this.fly.getPose();
    const pr = this.graph.project(pose.p[0], pose.p[2]);
    if (pr.edge < 0 || pr.dist > MOUNT_MAX_DIST) {
      this.flash(t('ride.noRoadWithin', { dist: MOUNT_MAX_DIST }));
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
    this.locked = null;
    this.bridge = null;
    this.mode = mode;
    const g = this.probe(sm.x, sm.z);
    this.seedPose(sm.x, g.ground + EYE_SADDLE, sm.z, this.heading(sm.tx, sm.tz));
    this.flash(t('ride.mountBike', { mode: t('mode.' + mode) }));
    // control ACTIVATION (not assignment) happens here, on the transition
    // from not-riding to riding — a controllable BLE device sitting in the
    // device manager must never send resistance writes on its own, only
    // once the rider actually mounts a bike (BLE_ZWIFT_PLAN.md design)
    this.source.activateControl?.();
    return true;
  }

  private dismount(): void {
    if (this.mode === 'hike') return;
    this.mode = 'hike';
    this.junction = null;
    this.locked = null;
    this.bridge = null;
    this.hazard = null;
    this.solver = { v: 0, stalled: false };
    this.fly.setMode('walk');
    this.flash(t('ride.onFoot'));
    this.source?.releaseControl?.();
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

    const sm = this.curSample();
    const g = this.probe(sm.x, sm.z);
    const grade = sm.grade; // curSample() is travel-framed
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

    // advance along bridge/edge; cross nodes with the LOCKED (or default) exit
    let ds = out.v * dt;
    this.distM += ds;
    let guard = 6;
    while (ds > 0 && guard-- > 0) {
      // a junction bridge is consumed before the edge it leads into
      if (this.bridge) {
        const remainB = this.bridge.length - this.bridge.s;
        if (ds < remainB) {
          this.bridge.s += ds;
          ds = 0;
          break;
        }
        ds -= remainB;
        this.bridge = null;
        continue;
      }
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
        this.flash(t('ride.deadEndUturn'));
        this.junction = null;
        this.locked = null;
        ds = 0;
        break;
      }
      // the exit was committed at the cutoff (LockedTurn). A node reached
      // WITHOUT a lock (mount right next to it, several nodes in one step)
      // takes the default; single continuations pass straight through.
      const fromDir = this.dir;
      let arm: GraphArm;
      if (this.locked && this.locked.nodeId === nodeId && this.locked.viaEdge === e.id) {
        arm = this.locked.arm;
      } else if (exits.length === 1) {
        arm = exits[0] as GraphArm;
      } else {
        arm = this.defaultOption(this.buildOptions(nodeId, e.id, fromDir)).arm;
      }
      this.locked = null;
      this.junction = null;
      this.edge = arm.edge;
      this.dir = arm.end === 0 ? 1 : -1;
      this.s = this.dir > 0 ? 0 : (this.graph.edges[this.edge]?.length ?? 0);
      // continuity: the two polylines do NOT share a point — ride a stitched
      // bridge between them instead of snapping (no-teleport law)
      this.bridge = this.buildBridge(e.id, fromDir, arm);
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
    const sm2 = this.curSample();
    const e2 = this.graph.edges[this.edge];
    const v = out.v;
    const tangentHeading = Math.atan2(-sm2.tx, -sm2.tz);

    // B6 heading — pure pursuit. ?ridetraj=0 restores the exact legacy
    // tangent heading; low speed / imminent dead end falls back to tangent.
    let hdgErr = 0;
    if (this.trajOn && v >= 0.5) {
      const L = Math.max(TRAJ_LOOK_MIN, Math.min(v * this.lookS, TRAJ_LOOK_MAX));
      const tgt = this.lookPoint(L);
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
      Math.min(this.rollLeanFrac * lean + this.rollBankK * sm2.bank, ROLL_MAX),
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
      const behind = this.bridge
        ? samplePolyline(this.bridge.pts, this.bridge.length, Math.max(this.bridge.s - W, 0))
        : this.graph.sample(
            this.edge,
            Math.max(Math.min(this.s - W * this.dir, e2.length), 0),
          );
      const ahead = this.lookPoint(W);
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
    this.bank = sm2.bank;

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
    // turn-picker lifecycle (tools/probe-turnpicker.ts asserts against these)
    c['ride.junctionShown'] = this.junction ? 1 : 0;
    c['ride.turnLocked'] = this.locked ? 1 : 0;
    c['ride.bridge'] = this.bridge ? 1 : 0;
  }

  /** metres to the node ahead (bridge remainder included while stitching) */
  private remainToNode(): number {
    const e = this.graph.edges[this.edge];
    if (!e) return 0;
    const remain = this.dir > 0 ? e.length - this.s : this.s;
    return remain + (this.bridge ? this.bridge.length - this.bridge.s : 0);
  }

  /** current sample in the TRAVEL frame (tangent/grade/bank along motion);
   *  bridges are built in travel order, edge samples get dir applied */
  private curSample(): EdgeSample {
    if (this.bridge) return samplePolyline(this.bridge.pts, this.bridge.length, this.bridge.s);
    const sm = this.graph.sample(this.edge, this.s);
    if (this.dir > 0) return sm;
    return { ...sm, grade: -sm.grade, bank: -sm.bank, tx: -sm.tx, tz: -sm.tz };
  }

  /** point `dist` metres down the committed route — bridge first, then edges */
  private lookPoint(dist: number): { x: number; z: number; reached: number } {
    if (this.bridge) {
      const remainB = this.bridge.length - this.bridge.s;
      if (dist <= remainB) {
        const p = samplePolyline(this.bridge.pts, this.bridge.length, this.bridge.s + dist);
        return { x: p.x, z: p.z, reached: dist };
      }
      const w = this.walkAhead(this.edge, this.s, this.dir, dist - remainB);
      return { x: w.x, z: w.z, reached: remainB + w.reached };
    }
    return this.walkAhead(this.edge, this.s, this.dir, dist);
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
    // while stitching across a junction the walk starts at the exit edge's
    // entry; count the bridge remainder so distances measure from the bike
    let travelled = this.bridge ? this.bridge.length - this.bridge.s : 0;
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
        let arm: GraphArm | null = null;
        if (firstJunction && exits.length >= 2) arm = this.plannedArm(nodeId, e.id);
        if (!arm) {
          const inD = this.travelChord(e.id, dir as 1 | -1);
          arm = this.straightestExit(nodeId, e.id, inD.x, inD.z);
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

  /** the exit the rider is committed to (locked) or currently previewing —
   *  matched against the approach so a stale plan never routes a walker */
  private plannedArm(nodeId: number, viaEdge: number): GraphArm | null {
    if (this.locked && this.locked.nodeId === nodeId && this.locked.viaEdge === viaEdge) {
      return this.locked.arm;
    }
    if (this.junction && this.junction.nodeId === nodeId && this.junction.viaEdge === viaEdge) {
      return this.junction.options[this.junction.selected]?.arm ?? null;
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
      let arm: GraphArm | null = null;
      if (firstJunction && exits.length >= 2) arm = this.plannedArm(nodeId, e.id);
      if (!arm) {
        const inD = this.travelChord(e.id, dir);
        arm = this.straightestExit(nodeId, e.id, inD.x, inD.z);
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
  ): GraphArm | null {
    const exits = this.graph.exits(nodeId, arrivedEdge);
    let best: { arm: GraphArm; turn: number } | null = null;
    for (const arm of exits) {
      const outD = this.armDir(arm);
      const turn = Math.abs(
        Math.atan2(inz * outD.x - inx * outD.z, inx * outD.x + inz * outD.z),
      );
      if (!best || turn < best.turn) best = { arm, turn };
    }
    return best?.arm ?? null;
  }

  /** unit travel direction over the LAST ~12 m of an edge (chord — junction
   *  aprons wiggle, a chord reads the approach like a rider does) */
  private travelChord(edgeId: number, dir: 1 | -1): { x: number; z: number } {
    const e = this.graph.edges[edgeId];
    if (!e) return { x: 0, z: -1 };
    const sEnd = dir > 0 ? e.length : 0;
    const sBack = dir > 0 ? Math.max(e.length - ARM_CHORD_M, 0) : Math.min(ARM_CHORD_M, e.length);
    const a = this.graph.sample(edgeId, sBack);
    const b = this.graph.sample(edgeId, sEnd);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const m = Math.hypot(dx, dz);
    if (m > 1e-6) return { x: dx / m, z: dz / m };
    return { x: b.tx * dir, z: b.tz * dir };
  }

  /** unit travel direction of an arm LEAVING its node (first ~12 m chord) */
  private armDir(arm: GraphArm): { x: number; z: number } {
    const oe = this.graph.edges[arm.edge];
    if (!oe) return { x: 0, z: -1 };
    const p0 = (arm.end === 0 ? oe.pts[0] : oe.pts[oe.pts.length - 1]) as RoadPoint;
    const sm = this.graph.sample(
      oe.id,
      arm.end === 0 ? Math.min(ARM_CHORD_M, oe.length) : Math.max(oe.length - ARM_CHORD_M, 0),
    );
    const dx = sm.x - p0.x;
    const dz = sm.z - p0.z;
    const m = Math.hypot(dx, dz);
    if (m > 1e-6) return { x: dx / m, z: dz / m };
    const outDir = arm.end === 0 ? 1 : -1;
    return { x: sm.tx * outDir, z: sm.tz * outDir };
  }

  private buildOptions(nodeId: number, arrivedEdge: number, dir: 1 | -1): JunctionOption[] {
    const exits = this.graph.exits(nodeId, arrivedEdge);
    const inD = this.travelChord(arrivedEdge, dir);
    const opts = exits.map((arm) => {
      const oe = this.graph.edges[arm.edge];
      const outD = this.armDir(arm);
      // signed XZ angle from the incoming to the exit direction. three.js
      // frame (x right, z south, y up): positive rotation about +y = LEFT.
      // Proof case: heading north in=(0,−1), exit east out=(1,0) is a RIGHT
      // turn → cross=−1 → −90°. (The old code had this cross NEGATED, which
      // mirrored every label AND the card order — the owner's "left renders
      // right of straight".)
      const cross = inD.z * outD.x - inD.x * outD.z;
      const dot = inD.x * outD.x + inD.z * outD.z;
      const angle = Math.atan2(cross, dot);
      return {
        turn: classifyTurn(angle),
        angle,
        cls: oe?.cls.name ?? '',
        route: oe?.route ?? '',
        arm,
      } satisfies JunctionOption;
    });
    // left → right, exactly as the roads fan out (+angle = left)
    opts.sort((a, b) => b.angle - a.angle);
    return opts;
  }

  private defaultOption(opts: JunctionOption[]): JunctionOption {
    let best = opts[0] as JunctionOption;
    for (const o of opts) if (Math.abs(o.angle) < Math.abs(best.angle)) best = o;
    return best;
  }

  /** physical spread of a junction cluster: max distance from the node
   *  centroid to any arm's node-side endpoint (0 = tight join, ~15 m for
   *  lattice-snapped connectors). The show/lock distances add this so the
   *  choice closes BEFORE the roads visibly split. */
  private nodeRadius(nodeId: number): number {
    const cached = this.nodeRadiusCache.get(nodeId);
    if (cached !== undefined) return cached;
    const n = this.graph.nodes[nodeId];
    let r = 0;
    if (n) {
      for (const arm of n.arms) {
        const oe = this.graph.edges[arm.edge];
        const p = oe
          ? ((arm.end === 0 ? oe.pts[0] : oe.pts[oe.pts.length - 1]) as RoadPoint)
          : undefined;
        if (p) r = Math.max(r, Math.hypot(p.x - n.x, p.z - n.z));
      }
    }
    this.nodeRadiusCache.set(nodeId, r);
    return r;
  }

  /**
   * Continuity bridge across a junction (docs/TURN_PICKER.md): the arrival
   * edge's terminal point and the chosen exit's entry point are DIFFERENT
   * world points (a RouteGraph node is a ≤15 m cluster, not a shared
   * vertex). The old mover snapped between them — the owner's "teleport".
   * Stitch a cubic Bézier instead (end tangents = travel chords) and ride
   * it; the junction apron under it is carved road surface anyway.
   */
  private buildBridge(fromEdge: number, fromDir: 1 | -1, arm: GraphArm): Bridge | null {
    const fe = this.graph.edges[fromEdge];
    const te = this.graph.edges[arm.edge];
    if (!fe || !te) return null;
    const pA = (fromDir > 0 ? fe.pts[fe.pts.length - 1] : fe.pts[0]) as RoadPoint | undefined;
    const pB = (arm.end === 0 ? te.pts[0] : te.pts[te.pts.length - 1]) as RoadPoint | undefined;
    if (!pA || !pB) return null;
    const gap = Math.hypot(pB.x - pA.x, pB.z - pA.z);
    if (gap < BRIDGE_MIN_M) return null;
    const tA = this.travelChord(fromEdge, fromDir);
    const tB = this.armDir(arm);
    const k = gap / 3;
    const p1x = pA.x + tA.x * k;
    const p1z = pA.z + tA.z * k;
    const p2x = pB.x - tB.x * k;
    const p2z = pB.z - tB.z * k;
    const toDir: 1 | -1 = arm.end === 0 ? 1 : -1;
    // bridge points are TRAVEL-framed (curSample returns them unmodified)
    const bankA = pA.bank * fromDir;
    const bankB = pB.bank * toDir;
    const n = Math.min(Math.max(Math.ceil(gap / BRIDGE_STEP_M) + 1, 3), 32);
    const pts: RoadPoint[] = [];
    let sAcc = 0;
    let lx = 0;
    let lz = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const x = u * u * u * pA.x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * pB.x;
      const z = u * u * u * pA.z + 3 * u * u * t * p1z + 3 * u * t * t * p2z + t * t * t * pB.z;
      const ease = t * t * (3 - 2 * t);
      if (i > 0) sAcc += Math.hypot(x - lx, z - lz);
      lx = x;
      lz = z;
      pts.push({
        x,
        z,
        y: pA.y + (pB.y - pA.y) * ease,
        bank: bankA + (bankB - bankA) * ease,
        ford: false,
        s: sAcc,
      });
    }
    return { pts, length: sAcc, s: 0 };
  }

  /**
   * Junction choice lifecycle (docs/TURN_PICKER.md). Per fixed step:
   *   remain > show                → no preview
   *   lock < remain ≤ show         → preview open, ←/→ / tap re-selects
   *   remain ≤ lock                → freeze the selection into LockedTurn;
   *                                  the preview dies, so late picks have
   *                                  nothing to mutate (structurally closed)
   * `remain` includes an active bridge; both thresholds add the node's
   * physical radius so the window closes before the roads visibly split.
   */
  private updateJunctionPreview(): void {
    const e = this.graph.edges[this.edge];
    if (!e) {
      this.junction = null;
      this.locked = null;
      return;
    }
    const nodeId = this.dir > 0 ? e.b : e.a;
    // stale guards: a lock/preview made for another approach never applies
    if (this.locked && (this.locked.nodeId !== nodeId || this.locked.viaEdge !== this.edge)) {
      this.locked = null;
    }
    if (
      this.junction &&
      (this.junction.nodeId !== nodeId || this.junction.viaEdge !== this.edge)
    ) {
      this.junction = null;
    }
    const exits = this.graph.exits(nodeId, e.id);
    if (exits.length < 2) {
      this.junction = null;
      return;
    }
    if (this.locked) {
      this.junction = null; // committed — the window stays closed
      return;
    }
    const remain = this.remainToNode();
    const v = this.solver.v;
    const nodeR = this.nodeRadius(nodeId);
    const lockAt = Math.max(LOCK_BASE_M, v * LOCK_LEAD_S) + nodeR;
    const showAt = Math.max(JUNCTION_BASE_M, v * JUNCTION_LEAD_S) + nodeR;
    if (remain <= lockAt) {
      // cutoff: freeze the current selection (or the default if the window
      // never opened — e.g. mounted right next to the node)
      const options = this.junction?.options ?? this.buildOptions(nodeId, e.id, this.dir);
      const def = this.defaultOption(options);
      const chosen = this.junction
        ? (options[this.junction.selected] ?? def)
        : def;
      this.locked = {
        nodeId,
        viaEdge: this.edge,
        arm: chosen.arm,
        turn: chosen.turn,
        cls: chosen.cls,
        angle: chosen.angle,
      };
      this.junction = null;
      return;
    }
    if (remain <= showAt) {
      if (!this.junction) {
        const options = this.buildOptions(nodeId, e.id, this.dir);
        const def = this.defaultOption(options);
        this.junction = {
          nodeId,
          viaEdge: this.edge,
          distM: remain,
          lockM: lockAt,
          options,
          selected: options.indexOf(def),
        };
      } else {
        this.junction.distM = remain;
        this.junction.lockM = lockAt;
      }
    } else {
      this.junction = null;
    }
  }

  /** slope limit for the CURRENT mode (HUD detail) */
  modeMaxSlope(): number {
    return MODE_LIMITS[this.mode].maxSlope;
  }
}

/** |angle| buckets, each side-signed: <14° straight, 14–38° slight,
 *  38–100° normal, 100–150° sharp, ≥150° U-turn (+ = left) */
function classifyTurn(angle: number): Turn {
  const deg = (angle * 180) / Math.PI;
  const a = Math.abs(deg);
  if (a >= 150) return 'u-turn';
  if (a < 14) return 'straight';
  const side = deg > 0 ? 'left' : 'right';
  if (a >= 100) return `sharp-${side}` as Turn;
  if (a < 38) return `slight-${side}` as Turn;
  return side;
}
