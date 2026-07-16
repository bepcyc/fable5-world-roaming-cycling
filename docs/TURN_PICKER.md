# Turn picker — geometry-true layout + pre-committed turns (no teleports)

Owner directives (2026-07-16):
1. Option layout MUST match junction geometry — "left" can never render to
   the right of "straight". Arrows must reflect the real exit angle.
2. Zwift rule — the choice window CLOSES before the junction; the committed
   route then carries the bike through the node physically. Choosing after
   the cutoff is structurally impossible; the bike position NEVER jumps.

## Why it was broken

### Layout (mirrored sign)
`BikeRig.buildOptions()` computed the signed exit angle as
`cross = inx*oz − inz*ox`. In the three.js frame (x right, z south, y up,
heading = atan2(−x, −z)) a POSITIVE rotation about +y is a LEFT turn, and the
correct left-positive cross term is `inz*ox − inx*oz` — the code had it
negated. Every option was therefore mirrored: a physically-left road was
classified `right`, drawn with a right arrow, and sorted to the right of
"straight" (the sort itself, angle-descending, was correct). Proof case:
heading north `in=(0,−1)`, exit east `out=(1,0)` (a right turn) gave
`cross=+1 → +90° → 'sharp-left'`.

### Teleport (edges do not share a point at a node)
`RouteGraph` nodes are CLUSTERS: member points of different routes join
within `JOIN_R = 15 m`, and each edge keeps its own polyline. The terminal
point of the arrival edge (pA) and the entry point of the chosen exit (pB)
are different world points, up to ~15+ m apart. The old mover swapped
`this.edge/this.s` at the node in one fixed step — the pose sampled pB right
after pA: an instantaneous lateral jump. It looked worst when picking at the
last moment (the picker stayed open until `remain = 0`), because pB could
already be BEHIND the rider.

## The model

### Option geometry (BikeRig.buildOptions)
- Incoming direction: chord of the last ~12 m of the arrival edge (travel
  oriented). Outgoing direction per exit arm: chord of the first ~12 m of
  the exit edge from its node-side endpoint. Chords, not point tangents —
  junction aprons wiggle, chords read like a rider does.
- Signed angle `atan2(inz*ox − inx*oz, in·out)` — **positive = left**.
- Options sorted by angle DESCENDING → leftmost card = leftmost road, always,
  for any exit count (>3 exits and "two lefts" both resolve by pure angle
  order).
- Glyph buckets from |angle|: <14° straight, 14–38° slight, 38–100° normal,
  100–150° sharp, >150° u-turn (each side-signed). Card tooltip carries the
  exact signed degrees.

### Choice lifecycle (per approach: edge + dir → node with ≥2 exits)
Let `R_node` = max distance from the node centroid to any arm's node-side
endpoint (the physical spread of the junction cluster; 0 for tight joins,
up to ~15 m for lattice-snapped connectors).

- SHOW at `remain ≤ max(45, v·5.5) + R_node` — the existing lead, pushed out
  by the junction's physical size.
- LOCK at `remain ≤ max(8, v·1.2) + R_node` — the cutoff. `v·1.2 s` covers
  about one steering reaction; the 8 m floor keeps a walking-pace approach
  from choosing inside the apron; `+R_node` locks BEFORE the roads visibly
  split, which is what "физически проехана развилка" was.
  At lock the current selection (default = straightest exit) is frozen into
  `lockedTurn`; the picker preview becomes `null`, so `pick()` /
  `pickJunctionOption()` have nothing to mutate — a late tap/keypress is
  impossible by construction, not by flag-checking.
- CROSS: the node consumes `lockedTurn` (stale locks — teleport, dismount,
  U-turn, other node — are dropped, default applies). No pick → the lock
  froze the default anyway.
- Edge cases: stopping inside the cutoff keeps the lock (crossing happens
  whenever motion resumes); mounting inside the cutoff locks the default on
  the next fixed step; several nodes crossed in one step take the
  straightest exit beyond the first (unchanged); dead ends still U-turn.

### Continuity bridge (no jumps, physics leads the turn)
At the crossing the mover no longer snaps to pB. It builds a **bridge**: a
cubic Bézier from pA to pB, end tangents = travel directions of the two
edges, control length = |pB−pA|/3, sampled every ~2 m into a polyline with
true arclength. The solver keeps integrating `v` and the pose advances ALONG
the bridge — the bike physically steers through the junction apron (which is
carved road surface — that is what aprons are). Grade/bank interpolate;
speed × time stays exact (dashboard parity holds). Bridges shorter than
0.05 m collapse to the old direct hop. While bridging, `edge/s/dir` already
point at the exit edge entry, so route lookups (hazard scan, look-ahead)
walk the committed route; look-ahead targets resolve on the bridge first.

## Gate — tools/probe-turnpicker.ts (`npm run gates:turnpicker`)
Headless ride to a real ≥3-arm fork at three power levels. Asserts:
(a) rendered option order == geometry: exit-arm chord angles recomputed
    independently in the gate, strictly descending left→right, glyph side
    matches angle sign;
(b) the picker DOM is hidden at every frame inside the lock distance;
(c) a pick at the last pickable moment AND
(d) no pick at all (default route) — per-frame pose delta stays
    ≤ max(1 m, 3·v·dt) through the crossing: a teleport reads red.
Touch stays honest: the gate taps a card (Playwright touch) and asserts the
selection moved — same path probe-ui-touch audits geometrically.
