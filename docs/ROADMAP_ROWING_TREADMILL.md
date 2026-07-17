# Roadmap: treadmill-driven hiking & rowing/kayaking

Written right after the `complete-ble-support` merge (v0.6.0), while the new
device layer is fresh. Two future sport modes, ordered by effort: treadmill →
hike is mostly wiring; rowing is a real feature with world generation behind
it. Nothing here is scheduled — this is the map, not the commitment.

## What we already have (post-merge inventory)

The expensive half of both features is DONE and merged:

- **Packet parsing**: FTMS Treadmill Data (speed/incline/total distance/pace),
  FTMS Rower Data (stroke rate, stroke count, split pace, power), Concept2 PM5
  (3-characteristic merge: stroke data, split, calories), KayakFirst
  (serial-over-BLE, handshake + 1 Hz polling), RSC (running cadence/speed) —
  `src/ride/ble/machines/*`, `providers/*`.
- **Device resolution**: 38-descriptor registry with machine-type/sport per
  descriptor (`src/ride/ble/DeviceResolver.ts`).
- **Recording**: sport-aware session model + FIT/TCX/CSV/JSON export with the
  full sport-id map (Run/Walk/Rowing/Kayaking already encode correctly) —
  `src/ride/session/`.
- **Replay**: imported activities can drive a `ReplaySensorSource`
  (`src/ride/replay/`).
- **Roles**: RoleMux carries power/cadence/speed/heartRate/control from ANY
  machine already; a rower's stroke rate lands in `cadence`, a treadmill's
  belt speed in `speed`.

What is missing is exactly one layer everywhere: **sport modes in the sim
itself** — today `RideMode = hike|road|gravel|mtb` and only bikes consume
sensor power.

## Phase T — treadmill drives the hike (small)

Goal: walk the alpine world by walking on the physical treadmill.

1. **Speed-driven hike.** New seam in `FlyCamera` walk mode: when a treadmill
   (or RSC pod) feeds the `speed` role, the walk rig's forward speed follows
   the belt speed (capped by hike surface `maxSpeed` honesty from
   `SurfaceMatrix`). Steering stays on look direction / touch stick. No
   keyboard needed — matches the mobile-first rule.
2. **Incline out (optional, later).** FTMS treadmills accept
   `setTargetInclination`; mirror the terrain grade under the walker the same
   way trainers get `setSimState(grade, crr)` today (`RoleMux.setSimState` is
   already the seam; the opcode encoder already exists in `Parsers.ts`).
3. **Hike HUD variant.** When the active source's sport is Run/Walk: pace
   (min/km) instead of km/h, step cadence (RSC) instead of rpm. The session
   layer already formats pace per sport (`speedOrPaceString`).
4. **Recording.** Set activity sport from the resolved descriptor
   (Run/Walk) — encoder support exists; only the plumb-through is missing.
5. **Honesty gates.** Same as bikes: no treadmill speed → hike stays
   free-walk; never synthesize.

Effort feel: days, not weeks. No world work at all.

## Phase R — rowing / kayaking on generated water (large, the fun one)

Owner's sketch: an option to generate HUGE bodies of water and paddle a kayak
through scenic views. Split into honest stages:

### R1 — world: big-water generation option
- A generation preset/flag (e.g. `water=lakes`): the macro pass reserves one
  or several large basins (fjord-scale lake fed by existing river network)
  instead of only carving rivers/ponds. Shoreline detail (beaches, reeds,
  rocky banks) reuses the GroundRing/vegetation pools; distant shore +
  mountain reflections are the scenic payoff.
- Water surface at lake scale: current water rendering is river/pond-tuned;
  needs LOD for multi-km sheets (wave spectrum tiling, horizon blending).
- Deep water stays `WaterDeep` for every land mode — the kayak is the only
  thing allowed on it (matrix gets a `row` column, or the boat bypasses the
  land matrix entirely and reads water depth).

### R2 — routes on water
- Water routes = the rowing equivalent of the road graph: hand-authored or
  auto-traced loops across the basin (shore-following scenic line + open
  crossings), reusing `RouteGraph` so junction choice/turn picker/U-turn all
  work unchanged on water.

### R3 — boat physics + rig
- `stepBoat`: power → hull speed via water drag (cubic drag dominates; add
  wind later). Inputs from roles exactly like bikes: rower/kayak-erg power,
  stroke rate as cadence. C2 split (/500 m) and SPM come straight from the
  parsers.
- Boat pose: waterline height + gentle stroke-coupled pitch/roll (reuse the
  ride-feel one-pole smoothing patterns from `BikeRig`), camera low over the
  water — that is the "beautiful views" shot.
- Kayak cockpit (paddle + hands) is its own M-scale art task; ship the mode
  camera-only first (like early bike phases).

### R4 — sport UI + session
- Rowing HUD: split /500 m, SPM, stroke count, distance; record sport
  Rowing/Kayaking (encoders ready); Strava upload works unchanged.
- Device manager: rower/kayak descriptors already resolve — only role labels
  ("CADENCE" shown as "STROKE RATE" for rowing sports) need a sport-aware
  label pass.

### Order & effort feel
R1 (water option) and R3 (physics) can go in parallel; R2 needs R1's basins.
R1 is the heavyweight (world-gen + water rendering LOD). A minimal joyride —
one generated lake, one loop route, camera-only kayak driven by a rower erg —
is the right first milestone.

## Shared prerequisite for both phases

`SportMode` above `RideMode`: `ride | hike | row`, each with its own solver,
HUD variant and sport id for the session layer. `BikeRig` keeps owning ride;
hike keeps `FlyCamera`; row gets the new boat mover. RoleMux/session/replay
need no structural change — they are already sport-agnostic.
