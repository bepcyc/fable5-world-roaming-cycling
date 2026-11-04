/**
 * Camera rig: WALK mode (grounded RPG exploration — gravity, jump, sprint,
 * head-bob/land-dip/sprint-FOV) + FLY mode (free flight). `V` toggles.
 *
 * Walk is the default for the fresh interactive spawn; ANY programmatic
 * pose (setPose — ?cam=, ?shot=N, bookmarks, flythrough, probes) switches
 * to fly so the entire tooling surface keeps free placement semantics.
 *
 * Camera-motion effects compose onto a separate base position every frame
 * and are stripped from getPose()/`P` — bookmarks and probes always see the
 * clean logical pose. Mouse look is pointer-lock; `P` logs a `?cam=` string.
 */

import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { log } from './Log';
import { isMobileDevice } from './BrowserGate';
import type { CamPose } from './Hooks';

const FORWARD = new Vector3();
const RIGHT = new Vector3();
const MOVE = new Vector3();

// ---- touch controls (mobile only — no keyboard exists on a phone/tablet) ---
// `#app{touch-action:none}` in index.html already hands the whole canvas'
// touch stream to us; this is where FlyCamera claims it. Two independent
// gestures, tracked by pointerId so two fingers never fight each other:
//   left thumb  → a virtual joystick that just sets the SAME WASD entries
//                 the keyboard sets (updateWalk/updateFly read `keys` only —
//                 zero physics duplication, zero drift from the desktop feel)
//   any other finger on the canvas → drag-to-look (yaw/pitch), the touch
//                 equivalent of locked-mouse movementX/Y
const TOUCH_WASD = ['KeyW', 'KeyA', 'KeyS', 'KeyD'] as const;
const JOY_MAX = 38; // px — clamp radius (matches the CSS thumb travel below)
const JOY_DEADZONE = JOY_MAX * 0.32;
const LOOK_SENS = 0.0022; // matches the locked-mouse movementX/Y sensitivity

const TOUCH_STYLE = `
#laas-touch-joy{position:fixed;left:max(18px,env(safe-area-inset-left));
  bottom:max(18px,env(safe-area-inset-bottom));z-index:900;
  width:132px;height:132px;border-radius:50%;
  background:rgba(9,13,11,0.34);border:1px solid rgba(255,255,255,0.16);
  touch-action:none;-webkit-user-select:none;user-select:none}
#laas-touch-joy .thumb{position:absolute;left:50%;top:50%;width:56px;height:56px;
  margin:-28px 0 0 -28px;border-radius:50%;
  background:rgba(207,227,214,0.38);border:1px solid rgba(255,255,255,0.35);
  transition:background 0.12s}
#laas-touch-joy.on .thumb{background:rgba(255,209,102,0.55)}
/* UX-04: JUMP button (walk mode only) — a phone has no Space key. Right
   thumb, mirrors the left-thumb joystick. Deliberately NOT a "control" the
   layout gate audits (no role/cursor:pointer, like the joystick): a
   pointerdown handler drives it, and it sits behind the splash/pause
   overlays in menu states so hit-testing it there would be a false alarm. */
/* sits LEFT of the ⚙ FAB (right:16 bottom:16 48px) — never under it */
#laas-touch-jump{position:fixed;right:calc(76px + env(safe-area-inset-right,0px));
  bottom:max(16px,env(safe-area-inset-bottom));z-index:900;
  width:72px;height:72px;border-radius:50%;display:none;
  align-items:center;justify-content:center;
  background:rgba(9,13,11,0.34);border:1px solid rgba(255,255,255,0.16);
  color:#cfe3d6;font:bold 11px/1.1 ui-monospace,Menlo,monospace;
  letter-spacing:0.08em;text-transform:uppercase;
  touch-action:none;-webkit-user-select:none;user-select:none;
  transition:background 0.12s,transform 0.12s}
#laas-touch-jump.on{display:flex}
#laas-touch-jump.active{background:rgba(255,209,102,0.42);transform:scale(0.94)}
`;

function setKeyState(keys: Set<string>, code: string, on: boolean): void {
  if (on) keys.add(code);
  else keys.delete(code);
}

/**
 * `setPointerCapture()` throws a `NotFoundError` (spec-documented: the
 * pointer id is not currently active — reliably reproduced by any synthetic
 * dispatch, and plausible on a real device around a document/activity
 * transition or a UA quirk; a JS event handler always runs to completion, so
 * this is NOT a same-thread tap/release race) whenever called on a pointer
 * id the browser no longer considers live. Uncaught, that exception reaches
 * `installGlobalErrorHooks()` (src/core/Diagnostics.ts), which paints a
 * permanent full-screen fatal overlay over the WHOLE game on ANY uncaught
 * error — so an unguarded capture call turns a routine touch edge case into
 * a session-ending crash. Capture is a nice-to-have (keeps drag tracking
 * once the finger leaves the element's bounds); it must never be allowed to
 * abort the caller. Narrowed to the one documented failure mode (codex
 * review, scenario 1) — anything else re-throws so a real bug is still loud.
 */
function safeCapture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    throw e;
  }
}

/** terrain/water heights + surface class + slope at (x, z) — installed by
 *  the world scene. surfaceId = SurfaceId (src/ride/SurfaceMatrix.ts);
 *  slope = rise/run. Walk/fly use ground+water; ride physics (M1.3), HUD
 *  warnings (P5) and audio (M1.7) consume surfaceId+slope. */
export type GroundProbe = (
  x: number,
  z: number,
) => { ground: number; water: number; surfaceId: number; slope: number };

export type CamMode = 'walk' | 'fly' | 'ride';

// ---- walk tuning (grounded exploration, Pillar-B natural) -------------------
const EYE_HEIGHT = 1.7;
const WALK_SPEED = 4.6; // m/s
const SPRINT_MULT = 2.0;
// M1.3 hike re-judge (ROADMAP): real gravity + a natural standing jump
// (~0.55 m apex — fit athletic human), replacing the inherited 22 m/s²
// game-feel tune; sprint FOV kick removed the same pass (Pillar B bans
// artificial speed cues). Recorded in STATUS Session-3.
const GRAVITY = 9.81; // m/s² — Pillar B
const JUMP_V0 = 3.3; // → ~0.55 m apex at 9.81
const STEP_DOWN = 0.55; // downhill ground-stick range (m)
const GROUND_ACCEL = 10; // exp-damp rate toward wish velocity
const AIR_ACCEL = 2.5; // reduced air control
// effects
const STRIDE_RATE = 1.7; // rad of stride phase per meter at walk speed
const BOB_Y_WALK = 0.026; // m
const BOB_Y_SPRINT_ADD = 0.018; // extra at full sprint
const BOB_LATERAL = 0.55; // fraction of vertical amp, applied on right axis
const BOB_ROLL = 0.0032; // rad
// ride mode: yaw auto-aligns to the route heading once the mouse is idle
const RIDE_ALIGN_IDLE_MS = 1600;
const RIDE_ALIGN_RATE = 2.2; // exp-damp rate (1/s)
const DIP_K = 150; // landing-dip spring stiffness
const DIP_C = 18; // landing-dip spring damping
// fly-mode soft collision (legacy contract from TerrainScene)
const FLY_GROUND_CLEAR = 1.4;
const WADE_CLEAR = 0.45; // eye stays above water (no underwater rendering)
// Browsers enforce a cooldown (~1.25 s in Chromium) after the user exits
// pointer lock with ESC — a requestPointerLock() inside it is REJECTED
// ("pointer lock cannot be acquired immediately after exiting"). Clicks in
// that window must be deferred, not dropped.
const LOCK_COOLDOWN_MS = 1300;
// a deferred/retried request is only honored while the authorizing click is
// recent (transient user activation lasts ~5 s — stay well inside it)
const LOCK_INTENT_MS = 3500;

export class FlyCamera {
  readonly camera: PerspectiveCamera;
  yaw = 0;
  pitch = 0;
  /** base FLY speed in m/s, scroll-scaled (walk speeds are fixed) */
  speed = 24;
  enabled = true;
  /** terrain probe — walk mode is unavailable until the scene installs it */
  groundProbe: GroundProbe | null = null;

  private modeV: CamMode = 'fly';
  private keys = new Set<string>();
  private vel = new Vector3(); // fly velocity / walk horizontal velocity
  private locked = false;
  // walk state — basePos is the LOGICAL eye position; camera.position gets
  // basePos + bob/dip offsets composed per frame
  private basePos = new Vector3();
  private velY = 0;
  private grounded = false;
  private stridePhase = 0;
  private bobK = 0; // smoothed 0..1+ speed factor driving bob amplitude
  private dipY = 0;
  private dipV = 0;
  private baseFov: number;
  // ride mode (M1.3): position is driven externally by the BikeRig each
  // frame; the camera keeps free mouse-look and eases back to the travel
  // heading once the mouse has been idle a moment
  private ridePos = new Vector3();
  private rideHeading = 0;
  private lastMouseAt = -1e9;
  /** ride pose provider — called DURING update so the camera always renders
   *  the freshest fixed-step interpolation (BikeRig installs it) */
  rideDriver:
    | ((out: { x: number; y: number; z: number; heading: number; roll: number }) => void)
    | null = null;
  private rideOut = { x: 0, y: 0, z: 0, heading: 0, roll: 0 };
  // jump input buffer: keydown-edge timestamp — a tap shorter than a frame
  // still jumps on the next grounded update (≤150 ms grace)
  private jumpAt = -1;
  // touch controls (mobile only — see the block above the class). A SEPARATE
  // set from `keys`: the joystick used to write/delete the same WASD codes
  // the keyboard uses, so releasing the joystick could erase a real
  // keyboard/Bluetooth-keyboard key still physically held (codex review,
  // scenario 1) — keyHeld() merges both at read time instead.
  private touchKeys = new Set<string>();
  private touchJoyEl: HTMLDivElement | null = null;
  private touchJoyThumb: HTMLDivElement | null = null;
  private touchJumpEl: HTMLDivElement | null = null;
  private touchJoyId: number | null = null;
  private touchJoyCenter = { x: 0, y: 0 };
  // UX-04 analog joystick: fraction of full deflection (0 below the deadzone,
  // 1 at the rim) throttles walk speed; a full push sets the sprint flag —
  // the digital 8-way bits alone can express neither "walk slowly" nor sprint
  // on touch. Reset with the joystick.
  private touchWalkFrac = 0;
  private touchSprint = false;
  private touchLookId: number | null = null;
  private touchLookLast = { x: 0, y: 0 };
  // bound once inside initTouchControls (closures over `base`/`thumb`); null
  // on desktop, where resetTouchJoy()/resetTouchLook() are harmless no-ops
  private touchJoyReset: (() => void) | null = null;
  private touchLookReset: (() => void) | null = null;

  constructor(camera: PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.baseFov = camera.fov;

    // ---- pointer lock, cooldown-aware ----------------------------------
    // A click during the post-ESC cooldown used to fire requestPointerLock()
    // unconditionally: the browser rejected it (console SecurityError — the
    // `void` didn't swallow the promise rejection) and the click was lost;
    // the user had to guess when to click again. Now: clicks inside the
    // cooldown schedule the request for the cooldown's end, and a rejection/
    // pointerlockerror retries while the click intent is fresh.
    let unlockAt = -1e9; // performance.now() of the last lock exit
    let lockIntentAt = -1e9; // last click asking for the lock
    let relockTimer: number | undefined;
    const clearRelock = (): void => {
      if (relockTimer !== undefined) {
        window.clearTimeout(relockTimer);
        relockTimer = undefined;
      }
    };
    const retryLock = (delayMs: number): void => {
      // bounded: never re-lock without a recent user gesture
      if (performance.now() - lockIntentAt > LOCK_INTENT_MS) return;
      if (relockTimer !== undefined) return;
      relockTimer = window.setTimeout(() => {
        relockTimer = undefined;
        acquireLock();
      }, delayMs);
    };
    const acquireLock = (): void => {
      if (!this.enabled || this.locked) return;
      clearRelock();
      const wait = unlockAt + LOCK_COOLDOWN_MS - performance.now();
      if (wait > 0) {
        // inside the browser cooldown — defer instead of burning the request
        relockTimer = window.setTimeout(() => {
          relockTimer = undefined;
          acquireLock();
        }, wait + 60);
        return;
      }
      let p: Promise<void> | undefined;
      try {
        // Safari returns undefined (no promise) — guard before .catch
        p = dom.requestPointerLock() as unknown as Promise<void> | undefined;
      } catch {
        retryLock(350);
        return;
      }
      if (p !== undefined && typeof p.catch === 'function') {
        p.catch(() => retryLock(350));
      }
    };
    dom.addEventListener('click', () => {
      // a phone/tablet has no mouse to lock — touch drives look via the
      // pointer-event drag below, and requesting a lock on Chrome Android is
      // unreliable at best (and pointless: there is no cursor to hide)
      if (isMobileDevice()) return;
      if (!this.enabled || this.locked) return;
      lockIntentAt = performance.now();
      acquireLock();
    });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === dom;
      if (was && !this.locked) unlockAt = performance.now();
      if (this.locked) clearRelock();
    });
    document.addEventListener('pointerlockerror', () => {
      // cooldown miss or focus race — re-request once the window passes
      retryLock(Math.max(unlockAt + LOCK_COOLDOWN_MS - performance.now() + 60, 300));
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lastMouseAt = performance.now();
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP') {
        log.info('pose', `cam=${this.toCamString()}`);
      }
      if (e.code === 'KeyV' && this.enabled && this.modeV !== 'ride') {
        // ride mode owns its own exit (M key via BikeRig) — V is walk⇄fly
        this.setMode(this.modeV === 'walk' ? 'fly' : 'walk');
      }
      if (e.code === 'Space' && !e.repeat) this.jumpAt = performance.now();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.resetTouchJoy();
      this.resetTouchLook();
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.modeV !== 'fly') return;
        this.speed *= Math.pow(1.15, -Math.sign(e.deltaY));
        this.speed = Math.min(2000, Math.max(0.5, this.speed));
      },
      { passive: false },
    );

    if (isMobileDevice()) this.initTouchControls(dom);
  }

  /**
   * Virtual joystick (left thumb, movement) + drag-to-look (any other
   * finger on the canvas) — the phone/tablet has no WASD and no mouse, so
   * without this a touch player cannot move a single step from spawn.
   */
  private initTouchControls(dom: HTMLElement): void {
    const style = document.createElement('style');
    style.textContent = TOUCH_STYLE;
    document.head.appendChild(style);

    const base = document.createElement('div');
    base.id = 'laas-touch-joy';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    base.appendChild(thumb);
    document.body.appendChild(base);
    this.touchJoyEl = base;
    this.touchJoyThumb = thumb;
    // hidden while riding a bike — the bike drives itself, WASD does nothing
    base.style.display = this.modeV === 'ride' ? 'none' : 'flex';

    // JUMP button (UX-04) — walk mode only; the tap equivalent of Space
    const jump = document.createElement('div');
    jump.id = 'laas-touch-jump';
    jump.textContent = 'JUMP';
    jump.setAttribute('aria-label', 'jump');
    document.body.appendChild(jump);
    this.touchJumpEl = jump;
    jump.classList.toggle('on', this.modeV === 'walk');
    jump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      jump.classList.add('active');
      this.triggerJump();
      safeCapture(jump, e.pointerId);
    });
    const releaseJump = (): void => jump.classList.remove('active');
    jump.addEventListener('pointerup', releaseJump);
    jump.addEventListener('pointercancel', releaseJump);
    jump.addEventListener('lostpointercapture', releaseJump);

    this.touchJoyReset = () => {
      this.touchJoyId = null;
      base.classList.remove('on');
      thumb.style.transform = 'translate(0,0)';
      this.touchWalkFrac = 0;
      this.touchSprint = false;
      for (const code of TOUCH_WASD) this.touchKeys.delete(code);
    };
    this.touchLookReset = () => {
      this.touchLookId = null;
    };

    base.addEventListener('pointerdown', (e) => {
      if (this.touchJoyId !== null) return;
      e.preventDefault();
      this.touchJoyId = e.pointerId;
      const r = base.getBoundingClientRect();
      this.touchJoyCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      base.classList.add('on');
      this.applyJoyVector(e.clientX, e.clientY);
      safeCapture(base, e.pointerId);
    });
    base.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.touchJoyId) return;
      e.preventDefault();
      this.applyJoyVector(e.clientX, e.clientY);
    });
    const releaseJoy = (e: PointerEvent): void => {
      if (e.pointerId !== this.touchJoyId) return;
      this.resetTouchJoy();
    };
    // pointerup/pointercancel are the normal lift/interrupt path;
    // lostpointercapture additionally covers the browser reassigning capture
    // out from under us — without it a joystick held through one of those
    // could leave WASD stuck "on" forever (codex review, scenario 1)
    base.addEventListener('pointerup', releaseJoy);
    base.addEventListener('pointercancel', releaseJoy);
    base.addEventListener('lostpointercapture', releaseJoy);

    dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.touchLookId !== null) return;
      this.touchLookId = e.pointerId;
      this.touchLookLast = { x: e.clientX, y: e.clientY };
      safeCapture(dom, e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.touchLookId) return;
      const dx = e.clientX - this.touchLookLast.x;
      const dy = e.clientY - this.touchLookLast.y;
      this.touchLookLast = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * LOOK_SENS;
      this.pitch -= dy * LOOK_SENS;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    });
    const releaseLook = (e: PointerEvent): void => {
      if (e.pointerId !== this.touchLookId) return;
      this.resetTouchLook();
    };
    dom.addEventListener('pointerup', releaseLook);
    dom.addEventListener('pointercancel', releaseLook);
    dom.addEventListener('lostpointercapture', releaseLook);

    // document/activity transitions the pointerup/pointercancel path never
    // sees on Android: the Custom Tab going to the background (task switch,
    // an incoming-call overlay, the system back gesture) mid-drag. Without
    // these a backgrounded tab can resume with a phantom key still held.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.resetTouchJoy();
        this.resetTouchLook();
        this.touchJumpEl?.classList.remove('active');
      }
    });
    window.addEventListener('pagehide', () => {
      this.resetTouchJoy();
      this.resetTouchLook();
      this.touchJumpEl?.classList.remove('active');
    });
  }

  /** idempotent — safe to call even when touch controls were never
   *  initialized (desktop), and from setMode() when hiding the joystick. */
  private resetTouchJoy(): void {
    this.touchJoyReset?.();
  }

  private resetTouchLook(): void {
    this.touchLookReset?.();
  }

  /** joystick drag → clamp to the base radius, position the thumb, and set
   *  the same WASD entries the keyboard sets (digital, 8-way — matches the
   *  keyboard's own all-or-nothing feel; keyHeld() merges keyboard + touch
   *  at read time, so updateWalk/updateFly never know the difference). */
  private applyJoyVector(clientX: number, clientY: number): void {
    const dx0 = clientX - this.touchJoyCenter.x;
    const dy0 = clientY - this.touchJoyCenter.y;
    const mag = Math.hypot(dx0, dy0);
    const clamped = Math.min(mag, JOY_MAX);
    const dx = mag > 1e-6 ? (dx0 / mag) * clamped : 0;
    const dy = mag > 1e-6 ? (dy0 / mag) * clamped : 0;
    if (this.touchJoyThumb) this.touchJoyThumb.style.transform = `translate(${dx}px, ${dy}px)`;
    setKeyState(this.touchKeys, 'KeyA', dx < -JOY_DEADZONE);
    setKeyState(this.touchKeys, 'KeyD', dx > JOY_DEADZONE);
    setKeyState(this.touchKeys, 'KeyW', dy < -JOY_DEADZONE);
    setKeyState(this.touchKeys, 'KeyS', dy > JOY_DEADZONE);
    // analog throttle: 0 at the deadzone, 1 at the rim; full push = sprint
    this.touchWalkFrac =
      clamped <= JOY_DEADZONE ? 0 : Math.min((clamped - JOY_DEADZONE) / (JOY_MAX - JOY_DEADZONE), 1);
    this.touchSprint = this.touchWalkFrac > 0.9;
  }

  /** touch JUMP button (UX-04): the tap equivalent of Space — a phone has no
   *  keyboard. Buffers exactly like a keydown tap so a sub-frame press still
   *  jumps on the next grounded update (≤150 ms grace). */
  triggerJump(): void {
    this.jumpAt = performance.now();
  }

  /** true if either the keyboard or the touch joystick currently holds
   *  `code` — the one merge point updateWalk/updateFly read through. */
  private keyHeld(code: string): boolean {
    return this.keys.has(code) || this.touchKeys.has(code);
  }

  get mode(): CamMode {
    return this.modeV;
  }

  /** ride travel heading as rendered THIS frame (rideDriver-interpolated) —
   *  the cockpit's yaw anchor; free mouse-look (yaw) stays independent */
  get rideViewHeading(): number {
    return this.rideHeading;
  }

  /**
   * Switch walk/fly. Walking needs a ground probe; entering walk snaps the
   * eye onto the terrain below the current position. Leaving walk strips
   * the effect offsets so the camera holds the logical pose.
   */
  setMode(mode: CamMode): void {
    if (mode === this.modeV) return;
    if (mode === 'ride') {
      // entered via beginRide() only — it seeds ridePos/heading first
      this.resetEffects();
      this.vel.set(0, 0, 0);
      this.velY = 0;
    } else if (mode === 'walk') {
      if (!this.groundProbe) {
        log.warn('laas', 'walk mode unavailable — no terrain in this scene');
        return;
      }
      this.basePos.copy(this.camera.position);
      const g = this.groundProbe(this.basePos.x, this.basePos.z);
      this.basePos.y = Math.max(g.ground + EYE_HEIGHT, g.water + WADE_CLEAR);
      this.velY = 0;
      this.vel.set(0, 0, 0);
      this.grounded = true;
    } else {
      // strip effect offsets; keep the logical pose
      this.camera.position.copy(this.basePos);
      this.resetEffects();
    }
    this.modeV = mode;
    if (this.touchJoyEl) this.touchJoyEl.style.display = mode === 'ride' ? 'none' : 'flex';
    // JUMP is a walk-only affordance (no jump in fly/ride)
    if (this.touchJumpEl) this.touchJumpEl.classList.toggle('on', mode === 'walk');
    // hiding the joystick mid-drag (mounting a bike while holding it) used to
    // leave WASD stuck "on" forever — nothing left to fire its own pointerup
    // once the element is display:none (codex review, scenario 1)
    if (mode === 'ride') this.resetTouchJoy();
    this.applyRotation(0);
    this.camera.updateMatrixWorld();
    log.info('laas', `camera mode: ${mode} (V toggles)`);
  }

  /**
   * Programmatic poses imply free placement (bookmarks, ?cam=, flythrough,
   * probes) — they always switch to fly so nothing falls out of the sky or
   * snaps to terrain. Interactive walking resumes via V.
   */
  setPose(pose: CamPose): void {
    if (this.modeV === 'walk') {
      this.modeV = 'fly';
      this.resetEffects();
    }
    this.camera.position.set(pose.p[0], pose.p[1], pose.p[2]);
    this.basePos.copy(this.camera.position);
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
    if (pose.fov !== undefined) {
      this.baseFov = pose.fov;
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }
    this.applyRotation(0);
    // recompose matrixWorld/matrixWorldInverse NOW: subsystems copy camera
    // state in their own updateFns and must never read a stale matrix
    this.camera.updateMatrixWorld();
  }

  getPose(): CamPose {
    // walk mode reports the LOGICAL pose — bob/dip offsets stripped
    const p = this.modeV === 'walk' ? this.basePos : this.camera.position;
    return {
      p: [p.x, p.y, p.z],
      yaw: this.yaw,
      pitch: this.pitch,
      fov: this.baseFov,
    };
  }

  toCamString(): string {
    const p = this.modeV === 'walk' ? this.basePos : this.camera.position;
    const f = (v: number): string => v.toFixed(2);
    return `${f(p.x)},${f(p.y)},${f(p.z)},${this.yaw.toFixed(4)},${this.pitch.toFixed(4)},${this.baseFov.toFixed(0)}`;
  }

  private resetEffects(): void {
    this.stridePhase = 0;
    this.bobK = 0;
    this.dipY = 0;
    this.dipV = 0;
    if (this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private applyRotation(roll: number): void {
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    if (roll !== 0) this.camera.rotateZ(roll);
  }

  update(dt: number): void {
    if (!this.enabled) return;
    if (this.modeV === 'walk') {
      this.updateWalk(dt);
    } else if (this.modeV === 'ride') {
      this.updateRide(dt);
    } else {
      this.updateFly(dt);
    }
  }

  /** enter ride mode at a route pose (BikeRig calls this once on mount) */
  beginRide(x: number, y: number, z: number, heading: number): void {
    this.ridePos.set(x, y, z);
    this.rideHeading = heading;
    this.yaw = heading;
    this.setMode('ride');
  }

  private updateRide(dt: number): void {
    if (this.rideDriver) {
      this.rideDriver(this.rideOut);
      this.ridePos.set(this.rideOut.x, this.rideOut.y, this.rideOut.z);
      this.rideHeading = this.rideOut.heading;
    }
    // free mouse-look; yaw eases to the travel heading after mouse idle
    if (performance.now() - this.lastMouseAt > RIDE_ALIGN_IDLE_MS) {
      let d = this.rideHeading - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest arc
      this.yaw += d * (1 - Math.exp(-dt * RIDE_ALIGN_RATE));
      const pt = -0.06 - this.pitch; // settle to a slight down-gaze
      this.pitch += pt * (1 - Math.exp(-dt * RIDE_ALIGN_RATE * 0.6));
    }
    this.basePos.copy(this.ridePos);
    // eye rolls a fraction of the bike lean; fades out during free-look so a
    // world-stable gaze off to the side never tilts the horizon
    const align = Math.max(Math.cos(this.yaw - this.rideHeading), 0);
    this.applyRotation(this.rideOut.roll * align);
    this.camera.position.copy(this.basePos);
    this.camera.updateMatrixWorld();
  }

  private updateFly(dt: number): void {
    this.applyRotation(0);

    FORWARD.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    RIGHT.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    MOVE.set(0, 0, 0);
    if (this.keyHeld('KeyW')) MOVE.add(FORWARD);
    if (this.keyHeld('KeyS')) MOVE.sub(FORWARD);
    if (this.keyHeld('KeyD')) MOVE.add(RIGHT);
    if (this.keyHeld('KeyA')) MOVE.sub(RIGHT);
    if (this.keys.has('KeyE')) MOVE.y += 1;
    if (this.keys.has('KeyQ')) MOVE.y -= 1;
    let target = 0;
    if (MOVE.lengthSq() > 0) {
      MOVE.normalize();
      target = this.speed;
      if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) target *= 6;
      if (this.keys.has('AltLeft')) target *= 0.15;
    }
    const damp = 1 - Math.exp(-dt * 9);
    this.vel.lerp(MOVE.multiplyScalar(target), damp);
    this.camera.position.addScaledVector(this.vel, dt);

    // soft ground collision + underwater guard (no underwater rendering:
    // the refraction texture is garbage from below — hold above the water)
    if (this.groundProbe) {
      const c = this.camera.position;
      const g = this.groundProbe(c.x, c.z);
      const floor = Math.max(g.ground + FLY_GROUND_CLEAR, g.water + WADE_CLEAR);
      if (c.y < floor) c.y = floor;
    }
    this.basePos.copy(this.camera.position);
    // matrices fresh for every subsystem updateFn that runs after this one
    this.camera.updateMatrixWorld();
  }

  private updateWalk(dt: number): void {
    const probe = this.groundProbe;
    if (!probe) {
      this.setMode('fly');
      return;
    }

    // ---- horizontal wish velocity (yaw-plane only — pitch never tilts gait)
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    FORWARD.set(-sinY, 0, -cosY);
    RIGHT.set(cosY, 0, -sinY);
    MOVE.set(0, 0, 0);
    if (this.keyHeld('KeyW')) MOVE.add(FORWARD);
    if (this.keyHeld('KeyS')) MOVE.sub(FORWARD);
    if (this.keyHeld('KeyD')) MOVE.add(RIGHT);
    if (this.keyHeld('KeyA')) MOVE.sub(RIGHT);
    const sprinting =
      (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint) &&
      MOVE.lengthSq() > 0;
    let target = 0;
    if (MOVE.lengthSq() > 0) {
      MOVE.normalize();
      target = WALK_SPEED * (sprinting ? SPRINT_MULT : 1);
      if (this.keys.has('AltLeft')) target *= 0.35;
      // UX-04 analog throttle (touch only): below a full push the joystick
      // magnitude scales walk speed, so "walk slowly" exists on a phone.
      // Keyboard (touchWalkFrac stays 0) and sprint are untouched.
      if (this.touchWalkFrac > 0 && !sprinting) target *= Math.max(this.touchWalkFrac, 0.35);
    }
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const damp = 1 - Math.exp(-dt * accel);
    MOVE.multiplyScalar(target);
    this.vel.x += (MOVE.x - this.vel.x) * damp;
    this.vel.z += (MOVE.z - this.vel.z) * damp;
    this.basePos.x += this.vel.x * dt;
    this.basePos.z += this.vel.z * dt;

    // ---- vertical: gravity, jump (held OR buffered tap), ground clamp
    const jumpBuffered = this.jumpAt >= 0 && performance.now() - this.jumpAt < 150;
    if (this.grounded && (this.keys.has('Space') || jumpBuffered)) {
      this.velY = JUMP_V0;
      this.grounded = false;
      this.jumpAt = -1;
    }
    // velocity-Verlet half-step: the arc is EXACTLY ballistic at any dt
    // (plain semi-implicit Euler biases the jump apex by −v0·dt/2 —
    // frame-rate-dependent jump height)
    this.basePos.y += (this.velY - GRAVITY * dt * 0.5) * dt;
    this.velY -= GRAVITY * dt;

    const g = probe(this.basePos.x, this.basePos.z);
    const eyeFloor = g.ground + EYE_HEIGHT;
    if (this.basePos.y <= eyeFloor) {
      // landing dip ∝ impact speed (skip the trivial walk-downhill touches)
      if (!this.grounded && this.velY < -3) {
        this.dipV -= Math.min(Math.abs(this.velY) * 0.035, 0.2) * 9;
      }
      this.basePos.y = eyeFloor;
      this.velY = 0;
      this.grounded = true;
    } else if (this.grounded && this.velY <= 0 && this.basePos.y - eyeFloor < STEP_DOWN) {
      // stick to ground walking downhill (no micro-airborne flicker)
      this.basePos.y = eyeFloor;
      this.velY = 0;
    } else if (this.basePos.y - eyeFloor > 0.02) {
      this.grounded = false;
    }
    // wade: eye stays above the water surface
    const wadeFloor = g.water + WADE_CLEAR;
    if (this.basePos.y < wadeFloor) {
      this.basePos.y = wadeFloor;
      if (this.velY < 0) this.velY = 0;
      this.grounded = true;
    }

    // ---- camera-motion effects ------------------------------------------------
    const speedH = Math.hypot(this.vel.x, this.vel.z);
    const speedK = Math.min(speedH / WALK_SPEED, SPRINT_MULT);
    // bob amplitude factor: fades in/out, zero while airborne
    const bobTarget = this.grounded ? Math.min(speedK, 1.3) : 0;
    this.bobK += (bobTarget - this.bobK) * (1 - Math.exp(-dt * 8));
    // stride cadence rises SUB-linearly with speed (sprint = longer strides,
    // not double-time steps); frozen while airborne — no steps in the air
    if (this.grounded && speedH > 0.3) {
      const rate = STRIDE_RATE * WALK_SPEED * (0.55 + 0.45 * Math.min(speedK, 2));
      this.stridePhase += rate * dt;
    }
    const ampY = (BOB_Y_WALK + BOB_Y_SPRINT_ADD * Math.max(Math.min(speedK - 1, 1), 0)) * this.bobK;
    const bobY = Math.sin(this.stridePhase * 2) * ampY;
    const bobX = Math.sin(this.stridePhase) * ampY * BOB_LATERAL;
    const roll = Math.sin(this.stridePhase) * BOB_ROLL * this.bobK;
    // landing-dip spring (semi-implicit Euler — stable at the engine dt cap)
    this.dipV += (-DIP_K * this.dipY - DIP_C * this.dipV) * dt;
    this.dipY += this.dipV * dt;
    // (sprint FOV kick removed — M1.3 Pillar-B re-judge: no artificial
    // speed cues; sprint reads through stride/bob alone)

    // compose: camera = logical pose + effect offsets (getPose strips these)
    this.applyRotation(roll);
    RIGHT.set(cosY, 0, -sinY);
    this.camera.position
      .copy(this.basePos)
      .addScaledVector(RIGHT, bobX)
      .add(MOVE.set(0, bobY + this.dipY, 0));
    this.camera.updateMatrixWorld();
  }
}
