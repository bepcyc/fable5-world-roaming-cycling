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
    };
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
    this.fly.beginRide(x, y, z, heading);
  }

  /** probe API — force power (keyboard source only) */
  setPower(w: number | null): void {
    const src = this.source as KeyboardPowerSource | null;
    if (src && typeof src.setOverride === 'function') src.setOverride(w);
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

    // pose: probed ground carries the carved road surface (+bank is visual
    // only for now — cockpit lean lands with M1.5)
    const sm2 = this.graph.sample(this.edge, this.s);
    const g2 = this.probe(sm2.x, sm2.z);
    this.posePrev = this.poseCur;
    this.poseCur = {
      x: sm2.x,
      y: g2.ground + EYE_SADDLE,
      z: sm2.z,
      heading: this.heading(sm2.tx, sm2.tz),
    };

    // counters — probes assert against THESE (dashboard parity check)
    const c = this.engine.stats.counters;
    c['ride.kmh100'] = Math.round(this.solver.v * 3.6 * 100);
    c['ride.powerW'] = Math.round(powerW);
    c['ride.grade1000'] = Math.round(grade * 1000);
    c['ride.surface'] = g.surfaceId;
    c['ride.blocked'] = out.blocked ? 1 : 0;
    c['ride.stalled'] = out.stalled ? 1 : 0;
    c['ride.mode'] = MODE_ORDER.indexOf(this.mode);
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
