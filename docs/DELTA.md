# DELTA log — reference-gap tracking (newest phase first)

## Phase 1 close (2026-06-11) — terrain vs refs (geometry/classification scope)

Shots: `shots/phase-1/vista-massif.png`, `erosion-split.png`, `top-down.png`
References: Witcher alpine (lighting/snow/peaks), scene1/3 (karst).

Top-10 deltas (ranked by visual impact):
1. Lighting is flat — no shadows, no GI, white ambient. **[Phase 2/3 structural]**
2. No atmosphere: sky is a debug gradient, zero aerial perspective/haze layering,
   no clouds. **[Phase 2 structural]**
3. ~~Massif faces monotone beige~~ → FIXED: iron-oxide elevation bands, lichen
   splotches, strata contrast retune.
4. ~~Snow too sparse/gray on the massif~~ → FIXED: landform-scale slope hold
   (16/28 m support), couloir accumulation term, perceptual pow boost, brighter
   palette. South hero face still bare-ish — re-judge at Phase 2 golden vista
   (N/NE aspects + low sun are the reference's snowy condition).
5. Zero vegetation/debris — lowlands read as green felt. **[Phase 4/5 structural]**
6. ~~Karst tower walls repeat a uniform scallop~~ → FIXED: two-scale worley mix
   + wall-line wobble noise.
7. River trench shoulders hard-edged; no gravel bars/banks. **[Phase 5/6]**
8. Far shell uniform pale; needs haze + palette work. **[Phase 2]**
9. Ground-level (<10 m) is texture-smooth — needs debris/cobble/grass geometry
   per Pillar A. **[Phase 4/5 structural]**
10. Lowland hills silhouette slightly felt-like at mid distance; revisit with
    vegetation cover + Phase 5 far-detail pass.

Verdicts: silhouette test PASS (serrated massif, craggy karst, no smooth
low-poly outlines in hero shots). Tiling test PASS (multi-scale procedural
breakup, no visible repetition at mid-range). Erosion split view PASS.
Self-score (terrain geology row): 6/10 — same class as refs at vista range,
betrayed up close (by design until Phases 4/5).
