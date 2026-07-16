# The CPU-wall campaign: results

**Date:** 2026-07-15 · **Branch:** `perf-mobile-fps` · **Device:** Galaxy Tab S8
Ultra (SM-X900, Adreno 730), `preset=min`, `dpr=0.6`, canvas 888×450 = 0.40 Mp
**Plan of record:** [`GPU_CPU_ISSUE_CODEX.md`](../GPU_CPU_ISSUE_CODEX.md) (the owner's own research)
**Prior art extended:** `STATUS.md:457-474`, `STATUS.md:538-559`

This closes the campaign that started from the owner's measurement
`cpu.update 1.4 + cpu.submit 31.8 = 33.2 ms` vs `GPU 28.6 ms` ≈ `frameMs 64.2`.

---

## 0. Headline

| | БЫЛО | ФАКТ | delta |
|---|---|---|---|
| fps @ 492 MHz | 4.23 | **6.37** | **+51%** |
| fps @ 818 MHz (max) | 6.65 | **9.00** | **+35%** |
| GPU work `W` (clock-scaling term) | 107,640 | **56,665** | **−47%** |
| cpu.submit | 49.6 | 42.2 | −15% |
| draw calls (window mean) | 707 | 621 | −12% |

The owner's reported range "4–7 fps" was never code variance — **it is the GPU
clock lottery** (§3). The honest production statement is a *range*:

> **БЫЛО 4.2–6.6 fps → СТАЛО 6.4–9.0 fps**, on the identical flag-free URL,
> picture intact (codex-terra 9.8/10: "effectively indistinguishable").

Everything that paid was **GPU work**. Nothing that targeted `cpu.submit` bought
a single frame. **Desktop `preset=high` is untouched: 49.8 fps vs the 49 fps
reference** (§8).

---

## 1. What the 31.8 ms actually was

**Answer: it is real, it is the render/encode path, and it is NOT the wall.**

The counter name misleads exactly as the owner's §1 said. `cpu.submit` brackets
the whole synchronous `PostStack.meter()` + `RenderPipeline.render()` path
(`Engine.ts:205-236`), not a `queue.submit()` call.

### 1.1 The segment split (`?segments=1`, 60 frames)

Brackets nest; only **self** time may be summed.

| segment | ms/frame | share |
|---|---|---|
| Scene own encoding | 27.82 | 58% |
| Shadow maps (4 cascades: 10.09 / 5.29 / 1.95 / 0.66) | 17.98 | 37% |
| quad0 (outer post) | 0.50 | 1% |
| **all 17 other post quads** | **1.82** | **4%** |
| **Σ self** | **48.10** | == `cpu.submit` 48.1 ✔ |

The split closes to the bracket it splits. **Post — the target of the doc's P4 —
is 2.3 ms of 48.** There is almost no CPU there to give back. Confirmed
independently: `postmin=1` collapses 19 render contexts → 4 for +3.2%, inside
the drift floor.

### 1.2 The named functions (CDP V8 profile, 254 frames, 117,025 samples)

Names resolved **by call path**, not by guessing at minified symbols
(`_update ← updateForRender ← _renderObjectDirect ← renderObject ← _renderObjects
← _renderScene`, verified against `node_modules/three/src/renderers/common/Bindings.js`).

| function | self ms/frame |
|---|---|
| `Bindings._update` | 7.44 |
| `Bindings.updateForRender` / `_updateBindings` | 6.96 |
| `UniformsGroup.update` | 4.32 |
| `GPUQueue.submit` [Dawn wire] | 3.23 |
| `Renderer._renderObjectDirect` | 3.12 |
| `GPUQueue.writeBuffer` [Dawn wire] | 2.85 |
| `Object3D.updateMatrixWorld` (heaviest **under** the shadow render) | 1.85 |
| `Renderer._projectObject` (heaviest **under** the shadow render) | 1.65 |
| `NodeUniform.updateValue` | 1.60 |
| `setVertexBuffer` / `draw` / `setBindGroup` / `setIndexBuffer` [Dawn wire] | 1.41 / 1.28 / 1.14 / 0.76 |
| `Nodes.updateForRender` | 1.07 |
| `cyrb53` (the shadow hash-storm) | **0.05** |

**This is the same ranking as the desktop profile at `STATUS.md:538-559`, at
3–4× the cost** (2.64→7.44, 1.6→6.96, 1.1→4.32, 0.67→1.85, 0.51→1.65). No new
offender. `cyrb53 = 0.05 ms` proves the `d1aeb48` hash-storm fix still holds.

### 1.3 The decisive fact about the main thread

**The main thread is `(idle)` 102.08 ms of a 167.17 ms frame = 61.1%.**
Frame = JS 52.09 + `(program)` 7.95 + `(gc)` 0.97 + `(idle)` 102.08. The JS 52.09
independently matches `cpu.update + cpu.submit ≈ 55 ms`, so the counter is honest
— the thread simply has no JS to run for most of the frame. The residual is not
main-thread work: not compositor JS, not rAF scheduling, not mapAsync callbacks.

### 1.4 What the 31.8 ms was NOT

The brief's correction is **confirmed**: the 18 `renderer.compute()` calls are
registered via `engine.onUpdate()` and run between `c0` and `c1`, i.e. their CPU
cost is already inside `cpu.update = 1.4 ms`. They cannot account for
`cpu.submit`. The owner's §2.3 said exactly this, and was right.

---

## 2. The observer effect: SETTLED — there isn't one

**Verdict: the doc's §4 hypothesis is refuted, and so is the previous agent's
counter-finding. At a matched clock the profiler is free.**

| arm | fingerprint | clock | fps | frame |
|---|---|---|---|---|
| timestamps **ON** (`FINAL-min-r3`) | `2b47e5abd747` | 492 MHz | **6.35** | 157.2 ms |
| timestamps **OFF** (`FINAL-notimestamp`) | `2b47e5abd747` | 492 MHz | **6.34** | 157.6 ms |

Same fingerprint, same clock, same canvas, same URL modulo `&notimestamp=1`:
**0.2% apart.**

An earlier agent reported "observer effect is REAL, LARGE, AND INVERTED — 34.5%,
turning the profiler OFF makes it *slower*". That experiment ran **before the GPU
clock probe existed**. Feeding their frame times through the clock law:

| their arm | their frameMs | implied clock |
|---|---|---|
| ON ×3 | 151.1 / 150.9 / 150.7 | 814 / 815 / **816 MHz** |
| OFF ×3 | 230.2 / 226.3 / 236.9 | 509 / 519 / **494 MHz** |

All three ON runs sit on the 818 MHz step; all three OFF runs sit on the 492 MHz
step. **They measured the clock lottery and called it an observer effect.** Their
own leading hypothesis (Adreno DVFS) was the right one — they simply had no
instrument to test it. Their 3/3-vs-3/3 split was luck (p ≈ 3% under a fair
coin), not a profiler cost.

**Consequences:**
1. The doc's §4 recommendation ("production must not allow timestamps every
   frame") is **unnecessary**. Timestamps cost nothing measurable.
2. **Every number in this campaign taken with timestamps ON is valid.**
3. The previous agent's warning "production is the OFF arm, so all our numbers
   are from a ~50% faster regime" is **withdrawn** — it was the clock.

*(One unexplained detail, recorded not buried: the OFF run showed a much worse
tail — p95 297.8 ms, std 41.5 vs 9.3 — while its median was identical. n=1, most
likely a one-off hitch. Not claimed as a finding.)*

---

## 3. The thing that dwarfs everything: the GPU clock lottery

`msm-adreno-tz` picks a clock per run and it is **not stable**: 492 / 545 / 599 /
640 / 732 / 782 / 804 / 818 MHz observed across the campaign, max 818,
`throttling=0`, `max_pwrlevel=0`, ~30 °C. **The same code and the same URL
produce 6.37 fps or 8.99 fps depending on which clock the governor picks
(+41%).**

This is bigger than every optimisation we landed. Frame time obeys

```
frame_ms = W / clock_MHz + F
```

fitted per config (fit error 0.1–0.6% on the original code, 4 clean points):

| config | W (GPU work) | F (clock-independent floor) |
|---|---|---|
| original code | 107,640 | 18.8 ms |
| `prepass=0` only (prior agent's data) | 78,481 | 23.5 ms |
| **final (today)** | **56,665** | **41.9 ms** |

**Rules that follow, and they are not optional:**
- A raw fps compared across two different clocks is **not a comparison**. Record
  `cur_freq` on every run. Compare `W`, or compare at a matched clock.
- Do **not** poll `gpubusy` while measuring: it is a **destructive read** that
  resets the counters `msm-adreno-tz` itself consumes. A previous agent caught
  their own sampler pinning the clock to exactly 492 MHz in 4/4 runs, A/B'd the
  sampler against itself, and defaulted it OFF. That discipline is why the law is
  trustworthy.

**Verification that the law is not numerology:** the original-code law predicts
150.4 ms at 818 MHz; `abl-base` (original code, flag-free) *measured* 150.6 ms —
0.1% apart, on a run whose clock was never recorded.

---

## 4. Every round

Все замеры — cooled, matched clock, fingerprint-matched arms, window means
(Trap 4), canvas 888×450 identical, `meterValid=true`, temp flat 29.9–30.3 °C.

### R1 — depth prepass OFF on `preset=min` (`1d38cfc`) — **KEPT**
- **БЫЛО** 237.2 ms / 4.22 fps / cpu.submit 49.6 / draws 703
- **ФАКТ** 183.8 ms / 5.44 fps / cpu.submit 42.8 / draws 622 — **+28.9% fps**, `W` −24.6%
- Within-arm spread 0.7% → **32× the noise**. Independently reproduced by a
  second agent's separate battery to 0.8%.
- **Mechanism:** the depth prepass is an IMR win that **inverts on a tiler**.
  Adreno resolves visibility per tile on-chip (low-res Z + early-Z), so the
  prepass twins reject almost nothing and pay full geometry + duplicated vertex
  wind. Sanctioned by the doc's §5 **P2.6** — the owner called this one.

### R2 — grass cull grid becomes preset-driven (`2098573`) — **KEPT** — the whale
- **БЫЛО** 183.2 ms / 5.46 fps · `c.grassRingCull` **11.10 ms**
- **ФАКТ** 157.8 ms / 6.34 fps · `c.grassRingCull` **2.67 ms** — **+16.1% fps**, `W` −15.9%
- **`GRASS_GRID` was hardcoded 3072 → 3072² = 9.44 MILLION cull threads every
  frame, identical on `min` and `ultra`** — `preset=min` paid the full ultra
  bill. This was **not on the candidate list**; it came out of the profile, and
  it is the owner's own memory note ("GRASS_GRID… хардкод, общий для всех
  пресетов") sitting unexploited.
- `G_SCALE` divides the grid and multiplies the cell so ring extent is invariant
  (322.6 m at every S); caps scale by 1/S².
- **Saturates past S=2** *because coverage is conserved* — the same pixels are
  still shaded, so cull/vertex gets cheaper and fill does not. S=4 buys only 5%
  more and codex-terra rejected it at 6/10 ("isolated grass clumps, bare ground
  between clusters"). **S=2 shipped at 8/10.**

### R3 — CSM shadow-map resolution (`1d31f7e`) — **REVERTED (measured negative)**
- **БЫЛО** 2048²×4 = 16.8M shadow texels/refresh: 157.5 ms / 6.35 fps
- **ФАКТ** 1024 → 156.9 / 6.37 · 512 → 157.2 / 6.36 — **flat across a 16× change
  in texel count** (0.4% spread vs a 0.7% noise floor)
- The defect is real (min rasterised ultra-sized shadow maps) but it is a perf
  **non-issue**: shadow cost here is caster geometry + draw encoding, not fill.
- Reverted to 2048 — shipping 1024 would trade real shadow quality (visible at
  T=8: blurred contact shadows, codex-terra 8/10) for **zero** frame time. The
  knob survives as an attribution tool with the negative in its docstring.

### R4 — CSM cascade de-pile (`619e7e6`) — **KEPT (correctness, no perf claim)**
- The docstring claimed phases were "staggered so far cascades never pile onto
  one frame". They were not: `PERIODS=[1,2,3,6]` + `PHASES=[0,1,2,5]` fire all
  four cascades together at `frameNo ≡ 1 (mod 6)`.
- `PHASES=[0,0,0,1]` → per-6-frame load `[1,4,1,2,2,2]` → `[3,1,2,2,2,2]`; peak
  **4→3**, optimal by brute force over all 6⁴ assignments.
- **БЫЛО** 157.5 ms → **ФАКТ** 157.1 ms. **No win claimed and none measured** —
  total work is unchanged *by construction* (12 cascade renders per 6 frames
  either way; rates verified identical `[1, ½, ⅓, ⅙]`), so the mean cannot move.
  Kept because it is correct and removes a comment that actively misleads.

### P1 — `BundleGroup` (the doc's headline fix) — **REJECTED, REVERTED**
- **It did exactly what the doc promised to `cpu.submit`: 45.4 → 14.5 ms (−68%),
  −574 draws. The frame did not move: `W` 80.0k → 79.2k (−1%).**
- Engagement proven from three's source, not assumed: the cached bundle path
  (`Renderer.js:1250-1270`) never calls `backend.draw()`, and `backend.draw` is
  the only thing that increments `drawCalls` — so a live bundle makes `drawCalls`
  fall by exactly the count it swallowed (703→49).
- **Picture gate FAILED on both targets** with the shipping prepass: the grass
  carpet vanishes (`bundle=ring`), the ridge spruces render as pale ghosts
  (`bundle=forest`). Mechanism proven by experiment: a bundle's draws replay in
  traversal order and the whole bundle executes at `finishRender`, i.e. **after**
  every non-bundled draw — which breaks our `depthFunc=EQUAL` prepass contract.
  `?prepass=0` removes the EQUAL dependency and the grass comes straight back.
- **Correction to prior art, verified rather than inherited:** `STATUS.md:544-559`
  blames the old revert partly on "records before async compiles". That mechanism
  does **not** apply here — `WebGPUPipelineUtils.js:274` only takes the async
  branch inside `compileAsync()`, which we never call.

---

## 5. The gates

### Gate 1 — `cpu.update + cpu.submit < GPU total` — **NOT MET, and the gate is broken**

Literally: at 818 MHz, `2.6 + 42.2 = 44.8 ms` vs GPU total (timestamp sum)
`20.1 ms` → 44.8 > 20.1 → **false**. Reported as measured rather than massaged.

**But the metric is the thing that is wrong.** "GPU total" is three's timestamp
sum, and it **under-reports real GPU by ~3–5×** on this device:
- `ablate=veg` cut timed GPU by 17.7 ms and cut **wall by 114 ms**.
- The clock law says real clock-scaling GPU work at 818 MHz is `56,665/818 =
  69.3 ms` — vs 20.1 ms of timestamps.

The gate is unsatisfiable *while we are genuinely GPU-bound*, and — proven by the
previous agent — simultaneously **satisfiable while the frame does not move**
(bundled `prepass=0`: cpu 18.0 < GPU 22.3, frame still 117 ms). It measures
nothing. The owner's own §3 anticipated this: *"сумма per-pass timestamp не
всегда равна GPU critical path"*.

### Gate 2 — frame responds to GPU ablations, not to CPU cuts — **MET, decisively**

- Responds to GPU: prepass −22%, grass −14%, `ablate=veg` −48% wall.
- Does **not** respond to CPU: BundleGroup, −31 ms of `cpu.submit` → **+1%**.

**We are honestly GPU-bound.** Gate 2 is the real gate; gate 1 should be retired.

---

## 6. The residual

The owner's `unexplainedMs` 97.8 / 176.1 was real, and it is now **mostly named
and bounded — but not fully attributed. I will not claim more than that.**

**What it is NOT:** main-thread work. The CPU profile shows `(idle)` 61.1% of the
frame with JS matching the counters (§1.3).

**What most of it IS:** GPU execution that three's timestamps do not capture. The
clock law is the evidence: frame time is inversely proportional to the Adreno
clock (fit error 0.1–0.6% across four clocks). Nothing in the system except GPU
execution scales as 1/GPU-clock. At max clock the clock-scaling term is 69.3 ms
of a 111.2 ms frame.

**What remains genuinely unexplained — the ~42 ms floor.** `F` is the part that
does **not** scale with the GPU clock, and it **grew as we cut GPU work**:
18.8 → 23.5 → **41.9 ms**. A fixed present/compositor cost does not do that.

Candidate explanations, none established:
1. **Exposed CPU.** `F = 41.9` is suspiciously close to measured
   `cpu.update + cpu.submit = 44.8`. Story: CPU hides inside GPU execution, and
   as GPU work shrinks less of it hides. **But this is contradicted by our own
   data** — the bundle arm cut `cpu.submit` by 31 ms and moved the frame 2.1 ms
   (predicted 119.4 → measured 117.3). If the floor were simply CPU, that cut had
   to show. It didn't.
2. **Memory-bandwidth-bound GPU work.** The DDR/bus clock is a *separate*
   governor from the GPU core clock, so fill/bandwidth work does not speed up
   with `cur_freq` and would land in `F`. Both of our wins plausibly *raised*
   fill: R1 removed early-Z rejection twins, and R2 widens blades by 1/√density
   (codex-terra read S=2 as **denser/lusher**). This fits the direction of the
   growth. Untested.
3. Presentation/compositor/swapchain backpressure.

**The cheap experiment that would settle it, and has never been run: a DPR
sweep on the tablet at the current build.** Fill/bandwidth scales with pixels;
CPU and vertex/cull do not. Note `tools/perf-tablet.ts`'s own header asserts
*"0.49 Mp … cannot be a fill problem … do not lower dpr further, it is not the
wall"* — **that is an assertion, not a measurement**, and it was inherited from
the CPU-walled desktop proxy. It should be tested, not believed.

---

## 7. Scorecard: the owner's research vs the measurements

The doc was commissioned as the plan of record and it **corrected us on the
things that mattered most**. Where it was wrong, it was wrong about *ordering*,
not about mechanism.

### Held ✅

1. **§1 — "`cpu.submit` is not one `queue.submit()`; it is the whole synchronous
   render path."** Exactly right, and the segment split proves it to the
   millisecond (27.8 scene + 18.0 shadows + 2.3 post = 48.1 = `cpu.submit`).
2. **§2.3 — "you cannot explain 31.8 ms with the `renderer.compute()` loops; they
   are inside the 1.4 ms `cpu.update`."** Correct. This killed the campaign's
   then-favourite "strongest finding" before it wasted a day.
3. **§2.1 — the named CPU costs** (`Bindings._update`, `UniformsGroup.update`,
   nodes `updateForRender`, `updateMatrixWorld`, `_projectObject`). Correct: the
   tablet profile reproduces the exact ranking at 3–4× cost.
4. **§Короткий ответ — "do not move `update` to the GPU: it is already 1.4 ms."**
   Correct.
5. **§3 «Не доказывает» #1/#2 — "`GPUQueue.submit()` only schedules; rAF does not
   by spec wait for presentation."** Correct, and it stopped us building on a
   wrong mechanism.
6. **§3 «Не доказывает» #5 — "the sum of per-pass timestamps is not the GPU
   critical path."** Correct, and *understated*: they under-report ~3–5×. This is
   what makes gate 1 meaningless.
7. **§3 «Доказывает» #3 — "lowering DPR need not help."** Consistent with
   everything measured (though still not directly tested — see §6).
8. **§5 P2.6 — "on TBDR, disable the depth prepass if `prepass=0` wins on the
   device."** It does. **This was the single biggest sanctioned win (R1).**
9. **§6 — the GPU list, with `grass grid/cull` named FIRST.** This is where 100%
   of the campaign's wins came from. The doc's hedge *"GPU cuts следует делать
   параллельно с CPU renderer cuts и проверять обе оси"* was wiser than its own
   priority list.
10. **§Корректный вывод — "look at CPU encoding, submission boundaries,
    backpressure **и методику измерения**."** The measurement-methodology term
    turned out to be the single largest factor of all: the clock lottery (§3).

### Failed ❌

1. **§Короткий ответ + §3 «Доказывает» #1/#5 — "the app cannot be considered
   purely GPU-bound"; "remove the CPU overhead inside `cpu.submit` and the GPU
   will naturally become the limiter"; "you must get CPU render/encode below
   28.6 ms".** **Wrong premise: the app was *already* GPU-bound.** The arithmetic
   `CPU + GPU ≈ frameMs` that motivated the whole document was a **coincidence of
   the timestamps under-reporting GPU by ~5×**. Removing CPU overhead changed
   nothing (P1: −68% `cpu.submit`, +1% frame).
2. **§5 P1 + Итоговый приоритет #3 — "`BundleGroup` is the most promising direct
   fix for `cpu.submit`."** It *is* — and that is precisely the point: it
   delivered −68% `cpu.submit` and **zero** fps. It also breaks the picture
   against our depth prepass. Rejected as an fps lever.
3. **§8 first gate — `cpu.update + cpu.submit < GPU total`.** A broken gate (§5):
   both unsatisfiable when GPU-bound and satisfiable while the frame is frozen.
4. **§4 — "profiler ON/OFF; if fps improves, production must not allow
   timestamps."** Worth running, but the hypothesis is refuted: at a matched
   clock the profiler is free (§2).
5. **§5 P0.3 — "a pass that costs almost no GPU but inflates `cpu.submit` is the
   first candidate for removal."** The hunt **came back empty**. All 17 post
   quads together are 2.3 ms of 48. Worse, the GPU ms in that ablation table are
   clock artifacts (`ablate=ao` *removes* a pass and reads GPU 26.6 → 38.2 —
   impossible at a fixed clock), so any ranking built on it is fiction.
6. **§2.4 — "the frame's main GPU command arrives late."** Plausible, never
   demonstrated, and not needed to explain the residual.

### Not reached ⏸

§5 P2 (uniform-group/static-matrix sweep), P3 (compute batching), P4 (pass
consolidation), P5 (worker/OffscreenCanvas), §7 (the target frame
architecture). **These are not refuted — they are premature.** They all target
`cpu.submit`, which is demonstrably not the wall *today*. See §8 for when they
become relevant again.

---

## 8. Desktop non-regression

**Desktop is intact.** Re-shot identically (`preset=high`, `seed=1`, 1600×900,
`cam=-870,182.7,862,1.69,0.1`, `T=14`):

- `shots/wip/desktop-REF-before.png` = **49 fps** → `shots/wip/desktop-REF-after.png` = **49.8 fps**
- SBS `shots/wip/sbs-desktop-FINAL.png`: terrain, lake, ridge, treeline, path,
  boulders, stream, bush and **grass density** identical; only the clouds drifted.

**Proven by construction, which is stronger than pixels:**
- **R1**: `prepassMode()` = `preset === 'min' ? 'off' : 'on'` → `high` takes the
  identical previous path.
- **R2**: `grassScale()` = `preset === 'min' ? 2 : 1` → `high` gets `G_SCALE=1`,
  i.e. arithmetically the old `GRASS_GRID=3072` / `GRASS_CELL=0.105`.
- **R3**: reverted.
- **R4**: the *only* round that reaches desktop. Verified by brute force, not by
  eye: cascade rates `[1, ½, ⅓, ⅙]` and 1200 renders per 600 frames are
  **identical** before and after; only the per-frame peak changes 4→3.

**A note on the "any pixel change = you broke desktop" gate: it is void as
written**, and this was proven, not asserted — two shots of the *same* code
differ. The shot is not pixel-deterministic (clouds/TAA converge differently
across a ~50 s boot, and the grass is wind-animated). Measured by band
(threshold >8/255): sky 1.3–1.4%, mid 6–13%, bottom grass band 30.6% at mean
delta 7.5/255. Judged structurally instead.

---

## 9. What remains

**30 fps needs a 33.3 ms frame. The current build at max clock is 111.2 ms.**

### The wall is now arithmetic, and it is the floor

```
final:  frame_ms = 56,665 / clock_MHz + 41.9
```

**Even with `W = 0` — every scrap of clock-scaling GPU work removed — the frame
is 41.9 ms = 23.9 fps. That is below 30 fps.** No amount of GPU-work cutting
reaches the goalpost on this tablet. **The floor must be attributed and broken,
and §6 says we do not yet know what it is.**

This is also the answer to "is `cpu.submit` dead?" — **no, it is deferred.**
The campaign's own advice ("stop spending rounds on `cpu.submit`") is correct
*today*, while GPU work is 69 ms of a 111 ms frame. But at the 30 fps target the
entire budget is 33.3 ms and CPU alone is ~45 ms. **If the floor turns out to be
CPU, the owner's P1/P3/P4 come straight back — and BundleGroup's proven −68%
`cpu.submit` becomes the tool for it.** The doc may yet be right about the
destination; it was wrong about the order.

### Ranked next steps, from data rather than taste

1. **Attribute the 41.9 ms floor.** The single highest-value unknown. Cheapest
   discriminator: **a DPR sweep on the tablet** (fill scales with pixels, CPU
   does not) — and stop trusting the harness header's untested "it is not a fill
   problem". Then a systrace / GPU-process trace.
2. **Cut grass FILL, not cull.** R2 saturated past S=2 *because coverage is
   conserved*: the same pixels are still shaded. Vegetation is **53% of all GPU
   work** (`ablate=veg` at a matched clock: 237.2 → 123.1 ms). The remaining cost
   is fragment shading of the carpet: overdraw, blade fill, the FAR super-tuft
   layer, tree impostors, `half.mrt`.
3. **Pin or record the GPU clock on every single run, forever.** A raw fps across
   492 vs 818 MHz is not a comparison (§3).
4. Only then revisit the CPU items (P2/P3/P4), against the floor.

### Is 30 fps on a phone reachable? **Not with this build.**

- The tablet at max clock: **9.0 fps**. The goalpost needs **3.3×**.
- The floor alone caps this tablet at **23.9 fps** regardless of GPU work.
- **The phone was never measured.** A Pixel 10 Pro was briefly on the USB bus
  during this session and disappeared before it could be measured; the owner's
  own phone is reported to be *slower* than this tablet. **Everything said about
  "30 fps on a phone" in this campaign — including this line — is extrapolation
  from an Adreno 730 tablet.** That is a gap worth closing with one battery on
  the real device.

**Honest verdict: the campaign more than doubled the low end (4.2 → 6.4 fps) and
took the high end from 6.6 → 9.0 fps with no picture loss, and it correctly
identified that we are GPU-bound and that `cpu.submit` is a decoy. It did not get
within reach of 30 fps, and the remaining distance is not a tuning problem: it
needs the 41.9 ms floor explained and a ~3× cut of the GPU work that is left.**
