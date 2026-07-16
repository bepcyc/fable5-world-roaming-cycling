# War plan: black artifacts, road steps/overlay, blue far grass (2026-07-16)

Owner directive: fix the handoff problems to perfection — black chunks in
vegetation, strange roads/terracing, and the new blue far-grass carpet.
Proof = SBS composites (before/after at the exact same camera). Every fix
ships with a gate that keeps the bug from ever returning.

Main thread (Napoleon) owns research, baselines, delegation and acceptance.
Implementation runs in parallel opus subagents, each in its own worktree.
This rule cannot be dropped.

## Verified facts (main-thread discriminators, 2026-07-16)

1. Real in-game black = black blade slivers in near grass at soft-road
   shoulders. Reproducible: seed 1, T 14,
   cam `-342.36,271.38,120.51,1.1708,-0.7494,55` (p7) and
   `-686.00,257.52,477.08,1.5671,-0.7798,55` (p4).
   Baseline numbers (tools/detect-black.mjs, RGB<=22, minPx 6):
   p7 = 3.506% black / 1664 clusters; p4 = 3.648% / 757 (top p4 clusters are
   legit forest shade at frame top — ROI must exclude it).
2. Gallery stand (`?scene=gallery&flowerdbg=solid`, unlit magenta): stems
   black below the horizon line, magenta above it. NOT post-AO, NOT bounce,
   NOT contact, NOT TAA — ablation matrix proves black persists with all of
   them off. The one remaining untested post stage is the aerial/haze chain
   (no ablate key exists for it yet) and the grade/tonemap tail.
3. `?ablate=bloom` (alone or in any combo) blacks out the ENTIRE frame —
   the post chain's output wiring dies without the bloom node. Separate bug,
   needs fix + gate (it also poisoned earlier kitchen-sink deductions).
4. surfdbg overlay black (band along riverbed + blobs on dirt road at seed 1
   `-685,330,557,0,-1.45`) is NOT post-AO (identical with ablate=ao).
   The black band corresponds in the normal render to the white river-gravel
   ribbon with TERRACED stepped walls. More overlay black fields:
   shots/wip/spot-grass-far-scan.json ranked #10/#11/#18 cams; #16/#19 show a
   red-pink band above the horizon; #17 far-shell overlay decays into noise.
5. Overlay classifies the rendered-asphalt road as dirt (no asphalt/orange
   anywhere in overlay at spot1) — classifier input vs render path diverge.
6. Blue far grass: same spot, two pitches — far band 21.40% bluish pixels,
   near 0.00% (seed 1, cam `-1114.14,173.68,1121.58`, yaw −1.5808, fov 55,
   pitch −0.06 vs −0.75). Scout: grass material (GroundRing.ts:1130..1276)
   was skipped by the silver-wash-cut (51e5d0d — no specularIntensity), tip
   ao=1.0, far band upK=1 points normals at the sky; sky/IBL went blue in
   65a1a68. Post aerial excluded (nearGate 1.8 km).
7. World flowers = GroundRing verge blooms: group 11 road-trefoil (gold),
   group 12 road-thyme (purple), spawned along soft-track shoulders
   (GroundRing.ts:1030-1060). In ringonly=11 debug they form a DENSE
   bleached-white carpet (flowerMaterial emissive 0.72 wash — known bug);
   in the normal render at the same spots NO yellow heads are visible at all.
   Forests classes 12-14 (clsdbg/clsonly=flowers) are a different, rarer
   system.

## Fronts

### Front A — black vegetation (opus agent, worktree, port 5179)

Mission: kill the black blade slivers in game grass AND the stand's
below-horizon black; explain both with a proven mechanism first.

Ordered experiments (stop at first confirmed mechanism, verify by SBS):
1. Instrument PostStack with `?ablate=aerial` (skip the aerial mix into the
   composite) and `?ablate=grade` (bypass color grade); re-shoot stand solid
   and p7. If black dies with aerial off -> fix aerial's treatment of thin
   geometry (it likely samples background depth for sub-pixel blades and
   replaces them with in-scatter, which is black below the horizon).
2. If aerial is innocent: bisect the beauty path — flat-color override on
   grass/flower materials (colorNode constant) at p7; normalNode override
   (facing-up); DoubleSide backface test (flip winding); check
   grassTranslucency/emissive negative or NaN outputs.
3. vdata/parts stand mode: fix the debug material attribute read
   (GalleryScene.ts:183-193) so parts mode is trustworthy again.
4. Fix `ablate=bloom` output wiring (frame must render without bloom).
5. Investigate why trefoil/thyme heads are invisible in the normal render
   (draw distance? density? emissive wash?) — the owner must SEE yellow
   flowers with healthy centers at p7/p4 when done, not just absence of
   black.

Deliverables: SBS before/after at p7 AND p4 AND stand-solid (same cams),
detector numbers in captions (target: grass-ROI blackPct < 0.3%, clusters
< 30 at p7; stand stems magenta full height); gates (below); tsc clean;
boot-smoke; commit(s) in worktree branch.

### Front B — roads: bubbles, terraces, overlay black/class drift
(opus agent, worktree, port 5180)

Mission: verify the bubble fix with the existing gate, kill the terraced
walls + overlay black fields + class drift, explain the red horizon band.

Ordered:
1. Run `npx tsx tools/probe-roadshape.ts --seeds 1,2,3` (pre-fix baseline:
   seed1 = 2 bubbles 3.45x/2.14x, seed2 clean, seed3 = 1 bubble 2.24x).
   Green = codex fix 01edbba holds; red = rework relaxProjectedKinks.
2. Terraced stepped walls of the river-gravel ribbon at spot1
   (`-685,330,557,0,-1.45`): find the producer (waterY carve staircase?
   TalusRelax? clipmap LOD?) — use surfdbg + wireframe + a heightfield
   transect probe (sample hf along a line, plot steps numerically).
   Fix root cause, not cosmetics.
3. Overlay black fields + asphalt-vs-dirt classification drift: trace
   surfaceDebugNode input vs the color path's class input at spot1 and at
   scan cams #10/#11/#18 (shots/wip/spot-grass-far-scan.json). The overlay
   must show ONLY legend colors — any fragment outside the palette is a bug.
4. Red-pink band above horizon (#16/#19) + far-shell overlay decay (#17).
5. Froxel ground-hug nearest-height steps (Froxels.ts:129 -> bilinear
   sampleHeight) and far-water min-reduce steps (Heightfield.ts:808-845,
   64 m blocks on mobile) — fix the froxel one; for far-water, prototype and
   measure, escalate to main thread if it needs a redesign (known backlog
   note in code).

Deliverables: SBS before/after at spot1 (normal + surfdbg pairs) and at
scan cams; probe-roadshape/roadgates/deadends green on seeds 1,2,3; gates;
tsc; boot-smoke; commits.

### Front C — blue far grass (opus agent, worktree, port 5181)

Mission: far grass band must read as grass (green family, aerial-hazed is
fine), near grass unchanged, sky/IBL match to ref-04 untouched.

Ordered:
1. Give grass materials the silver-wash-cut treatment: specularIntensity
   (start 0.25; sweep 0.15/0.25/0.35) on GroundRing grassMaterial (both
   near and far variants) — this is the missed 51e5d0d fix.
2. If far band still blue: reduce far-band upK sky-facing bias and/or damp
   env contribution on the far band; check patchGI skylight share.
3. Do NOT touch Atmosphere/PostStack sky matching (dCCT lives there).

Deliverables: SBS before/after with the exact baseline pair (far/near cams
above); numbers in caption (far-band blue < 3%, near = 0, measured the same
way as baseline); a quick check that mid-distance grass did not go gray;
gates; tsc; boot-smoke; commits.

## Contingency branches

- A: if no post stage explains the stand black -> capture the raw scene
  color (bypass post entirely via a debug output node) to split
  beauty-vs-post definitively; if beauty is already black, hunt in material
  compilation (TSL varying/attribute path), not post.
- A: if game slivers and stand black turn out to be different mechanisms,
  split them: game slivers have priority (owner-visible), stand black is
  tooling debt.
- B: if probe-roadshape is red, the geometry correction gets reworked first
  (bubbles are owner-visible); terraces second; overlay third.
- B: if far-water redesign is too big, land the froxel fix + file the
  design note, and gate only the froxel steps.
- C: if spec sweep can't kill the blue without graying the grass, stop and
  report — the fallback is distance-graded specular (full spec near, cut in
  the far band only).

## Gates (never again; wired into one runner)

New `tools/gate-visual.ts` (Front A owns the runner; B and C add their
checks): boots the needed scenes once per check, exits non-zero on any fail.
1. black-veg: p7 + p4 cams, detect-black on grass ROI (rows 25%..100%),
   thresholds blackPct < 0.3% and clusters < 30.
2. stand-solid: gallery flowerdbg=solid, count pixels that are neither
   magenta-family nor background in the stem region — 0 tolerance for pure
   black runs longer than 12 px.
3. ablate-sanity: for each ablate key (ao,bounce,contact,taa,mblur,bloom,
   clouds,aerial,grade) shoot one frame, assert mean luminance > 0.02 —
   catches the bloom-style output kill forever.
4. overlay-palette: surfdbg frames at spot1 + scan cams #10/#18: every
   pixel must sit within tolerance of a legend color (or skybox) — kills
   fall-through-to-black classes and the red band.
5. grass-blue: far/near pair, far-band bluish < 3%, near < 0.05%.
6. roads: existing probe-roadshape + probe-roadgates + probe-deadends,
   seeds 1,2,3.
Wire 1-6 into package.json script `gates:visual`; document in
docs/LAUNCH_AND_DEBUG.md.

## Takeover ledger (2026-07-16 ~13:00, opus agents stopped by owner order)

Owner paradigm shift: opus agents stopped mid-flight, main thread harvested
their worktrees; every NEW agent runs on Fable 5 max with three skills loaded
first (Skill tool) and this war plan in the brief.

What the opus fronts proved before the stop:

- FRONT A (worktree agent-a74fd0c79cac5adfc, uncommitted diff in
  src/render/PostStack.ts): ROOT CAUSE of ALL black-sliver artifacts found
  and fixed. The grade's saturation stage (uSat=1.4 at midday) extrapolates
  away from luma, driving a saturated hue's minor channel NEGATIVE; the next
  contrast pow(neg, 1.07) yields NaN; AgX's channel-mixing matrix smears the
  NaN into pure black. Thin saturated geometry (grass blades, flower stems,
  unlit magenta debug stems) is the victim; above-horizon stand pixels
  survived only because sky bleed desaturated them. Fix: clamp before the
  pow — `c = c.max(0).div(0.18).pow(...)` (PostStack.ts grade tail). Also
  added ?ablate=aerial and ?ablate=grade instrumentation. Numbers: stand
  solid 3.809% black/37 clusters -> 0.248% (badge text only); game p7 grass
  ROI slivers gone (marked SBS in the bot). NOT yet done by A: ablate=bloom
  output-kill fix, parts-mode vdata read fix, visible trefoil heads,
  gate-visual runner.
- FRONT B (worktree agent-a4dab564696c35b6c): probe-roadshape --seeds 1,2,3
  re-run in progress (seed-1 stations measured ratio=1 so far — bubble fix
  01edbba appears to HOLD); tools/probe-terrace.ts written (numeric transect
  across the spot1 river-gravel ribbon incl. surface class per station);
  oblique spot1 pair shot. NOT yet done: terrace root cause, overlay black
  producer, class drift (asphalt rendered vs dirt classified), red horizon
  band, froxel bilinear fix, gates:roads wiring.
- FRONT C (worktree agent-aad0d51b6a94f1561): specularIntensity sweep on
  GroundRing grassMaterial CONFIRMS the fix: far-band blue 21.46% ->
  0.86%/0.92%/0.87% at spec 0.15/0.25/0.35; picked 0.25. tools/
  measure-grass-blue.mjs + montage-grid.mjs written. CAVEAT: C's near-frame
  after-shot shows NEW black slivers — that is Front A's grade-NaN bug
  (C's worktree lacks the clamp; changed shading values push more channels
  negative). Not a spec-fix regression.

MERGE ORDER (hard): A's NaN-guard first (one-line clamp + ablate keys),
then C's spec fix re-validated on top (blue numbers stand, sliver pollution
disappears), then B's road/overlay work. Re-test the spot1 surfdbg BLACK
BAND after A's clamp lands — the overlay palette colors are fully saturated,
so the band may be the same NaN mechanism (untested hypothesis; the earlier
ablate=ao test does NOT rule grade out).

## Frost bisection verdict (2026-07-16 ~14:20, main thread)

Owner clue: frost never existed before the codex commit 7db9995. Three-point
proof at one camera (seed 1 far-meadow band, bluish share): pre-codex
7db9995^ = 0.83% (no frost), today = 21.40%, full material rollback = 21.64%
(unchanged). Root: the petal REWIND in 7db9995 — near-white umbel petals
(FLOWER_COLOR 0.75,0.75,0.7) used to face DOWN (dark, invisible fields) and
now face the SKY: white albedo in full light at 60-150 m = frost carpet.
flowerMaterial is innocent; its codex hacks (emissive 0.72 / aoNode=1 /
flattened darkening) are retired in 7b98e65 (they fought the grade-NaN black,
already fixed at the root). Cure owned by Front F: distance albedo fade
toward the meadow tone + мuted umbel white; criterion frost-cam band < 3%.

## Process law for every agent (cannot be dropped)

- Own worktree (Agent isolation=worktree), own LAAS_PORT, own dev server:
  symlink node_modules from the main repo
  (`ln -s /d/models2/dev/my/fable5-world-roaming-cycling/node_modules <wt>/node_modules`),
  then `npm run dev -- --port <port> --strictPort` in background.
- Telegram scripts and hooks are NOT tracked: call them by absolute path
  from the main repo: `/d/models2/dev/my/fable5-world-roaming-cycling/.claude/telegram/tg-photo.sh`.
- Every screenshot: Read with your own eyes -> compose an SBS composite
  (before/after at the SAME camera via tools/compare.ts or a labeled
  montage) -> send via tg-photo.sh with a Russian ОЖИДАЛ/ВИЖУ caption.
  Single frames NEVER count. No naked text to the bot.
- No Cyrillic anywhere in code/comments/logs (i18n files excluded).
- Foreground commands <= 10 min; long runs in background; timeouts >= 20 min.
- Headless Chrome discipline: one clean run; on "No REAL WebGPU adapter"
  pkill your own headless chrome, pause, retry once.
- Before "done": tsc clean, boot-smoke (shoot one world frame), gates green,
  kill own processes (vite/tsx/chrome), leave the worktree committed.
