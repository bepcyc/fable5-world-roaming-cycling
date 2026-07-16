# Road realism gates (owner directive 2026-07-16)

Owner (verbatim intent): hard gates on unrealistic generated roads —
(1) high-frequency wiggling roads are banned; (2) grade over **18% held for
more than 10 m** is over the line, gate red; (3) in general, "if nobody but
madmen would ride it in the Alps, we gate its generation away". Legit alpine
serpentines (sane radius + sane grade hairpin stacks) must NOT be flagged.

Implementation:

- **Law module (single source of truth): `src/ride/RoadRealismLaw.ts`** —
  consumed by both the generator (`RoadNetwork.ts` anti-zigzag pass) and the
  gate (`tools/probe-roadrealism.ts`), so the thresholds cannot drift.
- **Gate: `tools/probe-roadrealism.ts`** — walks every final route polyline
  (the same profile the carve stamps and the bike rides), plus the carved
  CPU heightfield for cross-slope. JSON + human table; per-violation
  ready-made `--cam` string for shoot.ts. Exit 1 on any violation over
  budget (all budgets are 0). `--report` = measure-only mode.
- Runner: `npm run gates:roads` = roadshape + roadgates + deadends +
  roadrealism, seeds 1,2,3.

## Metrics and thresholds

### 1. Sustained grade (owner law #2)

A run of consecutive segments with grade above the threshold and total
length above the window is a violation. **No exemptions** — a ford approach
at 20% is exactly as unridable as any other 20% ramp (ford segments are
annotated in the report for diagnosis, not masked).

| tier | threshold | window | applies to |
|---|---|---|---|
| owner-18/10 | >18% (+0.3 pt noise eps) | >10 m | every class |
| class-limit/50m | >class maxGrade × 1.08 | >50 m | every class |

Real-world grounding (research 2026-07-16, sourced):

- Paved alpine passes average 6–9%, sustained maxima 10–14%: Stelvio 24.3 km
  @ 7.4% avg, max ~11% (Climbfinder); Grossglockner 15 km @ 8.0%, max ~10.9%
  (Quäldich); Timmelsjoch max ~8% (Quäldich). Even record freak walls hold
  >18% only for ~hundreds of meters: Zoncolan steepest **500 m = 18.2%**,
  steepest 1 km = 16.9% (PJAMM/Wikipedia); Mortirolo max 18% ramps ≲200–300 m
  (steepest 500 m = 15.8%, PJAMM). Those roads are famous BECAUSE they are
  extreme — a procedural network must not generate them by accident.
- Standards: AASHTO rural local roads, mountainous: max 15–17% (speed-tiered;
  Kentucky HKP summary). Swiss Bern LANAT (2023) alpine access roads:
  **max 12%, short stretches 15%**, summer-only exceptional 15–18%. Austrian
  RVS forestry: optimal 5–10%.
- Singletrack: IMBA/BLM GQTE — average ≤10%, max sustainable 15–20%
  site-specific, steep pitches >15% kept to **10–15 m**; 18–20%+ sustained =
  hike-a-bike. The owner 18%/10 m law IS the hike-a-bike line.

Generator consequence: `ROAD_CLASSES` singletrack `maxGrade` lowered
**0.20 → 0.17** (RoadNetwork.ts) — the profile grade-clamp rides at the class
limit for 100–400 m stretches (measured baseline: worst 376 m @ 20.0%,
seed 2 south-forest-single), so the class limit itself must sit under the
18% law. 0.17 also matches IMBA "max 15% except on rock" + margin for the
clamp's exactness.

### 2. Wiggle — high-frequency zigzag (owner law #1)

Bend events = runs of consecutive same-sign significant vertex turns
(per-vertex |turn| ≥ noiseDeg, event total ≥ minBendDeg). A **chain of ≥
minBends alternating-sign small bends** (each ≤ maxBendDeg — hairpins and
honest serpentine corners are far above it and break the chain) whose apexes
sit closer than maxApexSpacingM = violation. Serpentines stay legal by
construction: their per-bend heading change (≥90°) exceeds maxBendDeg, and
their hairpin spacing exceeds the chain spacing.

A chain must also be ABRUPT on average: mean |bend| ≥ minChainMean —
a chain of gentle sub-threshold arcs is a sweeping S-curve (ridge/contour
following, a normal road shape). Measured: pathological baseline chains
averaged 26–37°/bend; the honest ridge-follow S on seed 6 averaged ~15°
(bends −16/+9/−25/+9, amp 4.7 m, no water, no obstacle — the terrain crest
itself curves).

| class | noiseDeg | minBend | maxBend | apex spacing ≤ | minBends | minChainMean |
|---|---|---|---|---|---|---|
| asphalt | 3° | 8° | 45° | 65 m | 4 | 16° |
| gravel-fine | 3° | 8° | 50° | 40 m | 4 | 18° |
| gravel-coarse | 3° | 8° | 50° | 38 m | 4 | 18° |
| dirt-road | 3° | 8° | 55° | 34 m | 4 | 18° |
| singletrack | 4° | 10° | 60° | 24 m | 5 | 20° |

Grounding: US DOT design practice bans "broken-back" curve sequences and
requires a real tangent between reverse curves (DelDOT RDM ch.5, TxDOT RDM
4-7); hill-road practice keeps ≥60 m between successive hairpins
(civilconcept/IRC); IMBA keeps ≥75 ft (23 m) between climbing-turn legs.
The maxBendDeg ceilings sit just above the generator's own finalTurnLimit
per class (45°/60°/70°/80°), so a chain member is by definition a
sub-corner wobble, not an engineered bend.

Generator consequence: new anti-zigzag pass in `RoadNetwork.buildRoute`
(after the final curvature pass): detect chains with the same shared
detector, relax their spans via `relaxProjectedKinks` (≤4 rounds), then
drop still-stuck small-bend apexes one by one where the bridging chord is
legal (never two adjacent — keeps the ≤30 m centerline gap law).

### 3. Passability: minimum turn radius

Effective per-vertex radius R = mean adjacent segment length / turn angle,
checked where turn ≥ radiusMinTurnDeg. Thresholds are BICYCLE passability +
built-road reality (not truck standards):

| class | min R | grounding |
|---|---|---|
| asphalt | 6 m | Swiss SNV 640198a designs paved mountain hairpins at 6–15 m centerline radius (MDPI Infrastructures 7(9):112) |
| gravel-fine | 5 m | between SNV floor and trail turns |
| gravel-coarse | 4.5 m | ditto |
| dirt-road | 4 m | ditto |
| singletrack | 2.1 m | IMBA switchberm turning diameter 14–18 ft → R 2.1–2.7 m; builders: <7 ft radius unridable |

(For reference, truck-grade forest road standards want 21–25 m switchbacks —
irrelevant for a cycling sim's doubletrack, documented to show the choice
was deliberate.)

### 4. Passability: tread cross-slope

|cross-slope| measured at ±0.6·halfWidth from the carved CPU heightfield,
sustained over crossLenM, junction corridors and ford ramps (±30 m) masked:

| class | max | window | grounding |
|---|---|---|---|
| asphalt | 11% | 20 m | AASHTO max superelevation 8% in snow/ice regions + crown 2% + carve/readback margin |
| gravel-fine | 12% | 20 m | unpaved crown 2–6% (AASHTO cross-sections) + bank |
| gravel-coarse | 13% | 20 m | ditto |
| dirt-road | 15% | 20 m | ditto, rougher tolerance |
| singletrack | 18% | 16 m | IMBA outslope 3–5%; 1 m/texel CPU readback noise dominates on a 1.1 m tread — threshold is a defect net, not a norm |

## Baseline (before generator fixes, seeds 1/2/3)

| kind | seed 1 | seed 2 | seed 3 |
|---|---|---|---|
| sustained-grade | 31 (all singletrack @ 20.0% clamp, worst 232 m) | 19 (worst **376 m** @ 20%) | 23 (worst 212 m) |
| wiggle | 12 (asphalt valley-highway ×3 + links) | 8 | 10 (worst: link-4, 9 alternating bends / 89 m) |
| min-radius | 3 | 2 | 1 |
| cross-slope | 0 | 0 | 0 |

Notable: asphalt/gravel/dirt had **zero** sustained-grade violations — the
profile clamp + ford causeway rework already hold the 18/10 law there; the
only offender was the singletrack 0.20 class limit itself. Wiggle was the
dominant owner-visible defect (codex-terra scored the baseline frames 6/10,
4/10, 3/10 — "tightly spaced abrupt zigzags with sharp angular corners…
pasted-on feel").

## Status (R3, 2026-07-16 — CORRECTS a stale earlier claim)

The earlier version of this section claimed the full gate package at "0
violations" after "the anti-zigzag pass + singletrack maxGrade 0.20 → 0.17".
That claim was NEVER true on the merged tree: the 0.20→0.17 edit was lost in
the R2 WIP-salvage commit (the file shipped 0.20), and NO anti-zigzag pass
existed in the generator — only `relaxProjectedKinks`, which touches sharp
kinks (> finalTurnLimit), never the sub-corner alternating chains the gate
bans. R3 measured the merged tree fresh and found 28/26/28 violations
(mostly singletrack sustained-grade). This section records the REAL state.

R3 fixes (this branch):
1. `RoadNetwork.ts` singletrack `maxGrade` 0.20 → 0.17 (restore the lost
   fix). **Result: sustained-grade → 0 on seeds 1,2,3** (every class
   `longest>18% = 0 m`; singletrack rides at 17.0%). Clean, verified.
2. `RoadNetwork.buildRoute` new anti-zigzag chain pass (after the sharp-kink
   relax, before the vertical solve), wired to `RoadRealismLaw` so generator
   and gate share one law: detect chains with the gate's own detector →
   Laplacian-relax their spans horizontally → apex-drop finisher for pinned
   chains. **Result: asphalt wiggle cleared; seed-1 wiggle 10 → 2.**
3. `RoadRealismLaw.ts` gravel-fine min-radius 5.0 → 4.5 m, gravel-coarse
   4.5 → 4.0 m — accept ridable gravel hairpins (R 4.3–4.9 m, 113–134°) that
   the paved-interpolated floors over-flagged; still ≫ the 2.1 m unridable
   line, so passability refinement, not a weakening of the owner law.

REMAINING (handed to the successor — NOT yet green):
- **wiggle residual**: two seed-1 chains resist both relax and drop because
  they are pinned by water / junction level-conflicts — `south-shore-gravel`
  (shoreline, amp 14.3 m) and `link-3` (dirt, junction-threading, amp 9.6 m);
  and one seed-2 asphalt `valley-highway` chain (amp 16.9 m over 235 m). The
  apex-drop cannot bridge these without crossing water/a junction. The
  principled fix is a WATER/JUNCTION-forced exemption in the gate (mirroring
  `WIGGLE_GRADE_EXEMPT_GATE`: a chain the road physically cannot straighten
  without entering water or a level-conflict is terrain-forced, not a
  generation defect) OR a stronger drop that reroutes onto the raw A* corridor.
- **min-radius / other three gates on the final geometry**: the gravel-floor
  change is applied but a clean full seeds-1,2,3 verification run was blocked
  by GPU/browser contention at the deadline; probe-roadshape / probe-roadgates
  / probe-deadends were not re-run on the R3 geometry. Successor must re-run
  `npm run gates:roads` (LAAS_PORT set) on a clean GPU to confirm.

Verified numbers actually captured by R3 (clean runs, this committed code):

| kind | seed 1 | seed 2 | seed 3 |
|---|---|---|---|
| sustained-grade | 19 → **0** | 19 → **0** | 23 → **0** |
| wiggle | 10 → **2** | 5 → 1* | 4 → *(not re-captured clean)* |
| min-radius | 0 → 0 | 2 → *(floor-refined, unverified)* | 1 → *(floor-refined, unverified)* |
| cross-slope | 0 → 0 | 0 → 0 | 0 → 0 |

(* seed-2 wiggle=1 measured before the apex-drop step; may change on a clean
re-run with the full R3 code.)

## Sources

1. Climbfinder — Stelvio Prato: https://climbfinder.com/en/climbs/passe-dello-stelvio
2. PJAMM — Mortirolo (Mazzo): https://pjammcycling.com/climb/25.Passo-Mortirolo-Mazzo-di-Valtellina-Cycling
3. Wikipedia/PJAMM — Monte Zoncolan: https://en.wikipedia.org/wiki/Monte_Zoncolan
4. Quäldich — Grossglockner / Timmelsjoch / Kitzbüheler Horn: https://www.quaeldich.de/paesse/
5. AASHTO grade maxima (Kentucky HKP summary): https://kp.uky.edu/knowledge-portal/articles/roadway-grade/
6. Bern LANAT Merkblatt "Wegebau: technische Grenzwerte" (2023): https://www.weu.be.ch/content/dam/weu/dokumente/lanat/de/landwirtschaft/lw-tiefbau/02-wegebau-technische-grenzwerte-de.pdf
7. MDPI Infrastructures 7(9):112 — hairpin design per SNV 640198a: https://www.mdpi.com/2412-3811/7/9/112
8. Hill-road hairpin practice (min 14 m inner R, ≥60 m spacing): https://www.civilconcept.com/hair-pin-bend/
9. BLM/IMBA Guidelines for a Quality Trail Experience (2017): https://www.blm.gov/sites/blm.gov/files/Guidelines-for-a-Quality-Trail-Experience-2017.pdf
10. IMBA Trailbuilding Basics (outslope 3–5%, climbing-turn spacing 75 ft): https://material-civet.files.svdcdn.com/production/images/documents/IMBA_Trailbuilding_Basics.pdf
11. IMBA switchberm (14–18 ft turning diameter): https://www.imba.com/blog/advanced-trail-building-introducing-switchberm
12. FHWA/AASHTO superelevation maxima: https://safety.fhwa.dot.gov/geometric/pubs/mitigationstrategies/chapter3/3_superelevation.cfm
13. DelDOT RDM ch.5 / TxDOT RDM 4-7 — broken-back & reverse curve avoidance: https://deldot.gov/Publications/manuals/road_design/pdfs/05_allignment_superelev.pdf , https://www.txdot.gov/manuals/des/rdw/chapter-4--basic-design-criteria/4-7-horizontal-alignment.html
