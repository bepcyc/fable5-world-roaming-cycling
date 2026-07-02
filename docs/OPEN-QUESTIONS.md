# OPEN QUESTIONS — PROJECT RANDO — ALL ANSWERED (owner, 2026-07-02)

*This is now a DECISION RECORD. The owner answered every question line by line the same day; answers are appended per question and are binding. The implementation gate is OPEN — Session 1 starts ROADMAP M1.1.*

**Q1. Target play machine.** This dev box (Ryzen 4650G, Vega 7 iGPU) runs the world at single-digit fps; owner directive says fps is the last priority *for this machine*. Is there a different intended play machine (for you and friends), and when do we name it?
**Recommendation (updated after remote inspection 2026-07-02):** the `pop-os` box — Ryzen 9 3950X / 128 GB / **RX 6800 XT** (see `docs/notes/pop-os-target-machine.md`) — is the obvious play/perf-target machine; confirm it, keep developing visuals-first on this box, and run the M1.4 real-sensor test + Phase-3 high-speed pass there (`just run-rxgpu` is prepared; node/npm need installing).
**ANSWER: pop-os.** ✓

**Q2. Route network determinism.** Should the road/trail network be a pure function of the world seed (`?seed=N` reproduces roads exactly), matching LAAS's determinism law?
**Recommendation:** yes — same seed ⇒ same network; route-graph generation gets its own named RNG stream (house pattern `seed.rng('roads')`, `src/core/Seed.ts`) so adding roads never re-rolls the existing world.
**ANSWER: да.** ✓

**Q3. Physics probe runtime.** Probes P1–P6: drive the real engine in headless Chrome (slow boot ~1 min on this box, but tests the truth) vs a node-side reimplementation of the solver (fast, but can drift from the engine)?
**Recommendation:** headless browser driving the real engine (proven today: HUD verify + baseline probes work on the NixOS recipe); keep solver math in a pure module so a fast node-side unit layer can *additionally* cover the formulas.
**ANSWER: да.** ✓

**Q4. Codename.** Brief proposes **RANDO** (randonnée = long hike *and* long ride — covers both modes; file stays `PROJECT_RIDE_v1.md`).
**Recommendation:** adopt RANDO.
**ANSWER: да.** ✓

**Q5. Physics input priority.** You named HR / cadence / speed as the metrics; Zwift-class physics is power-driven. When only a wheel-speed sensor exists (classic trainer), game speed must come from a zPower-style curve instead.
**Recommendation:** power source preferred (FTMS trainer or BLE power meter) → full solver; CSC wheel-speed fallback → zPower-style estimated power into the same solver; cadence/HR are display-only (never physics inputs); dashboard shows "—" for absent channels.
**ANSWER: да, мощность нужна** — power source is the physics driver as recommended. ✓

**Q6. Trainer resistance control (FTMS SIM gradient) — MVP or Phase 3?** Sending the road gradient to the trainer is the full Zwift feel but adds control-point complexity and per-brand quirks.
**Recommendation:** land it in M1.4 *if* your trainer supports FTMS control (tell me the model); otherwise read-only power in MVP and SIM in Phase 3.
**ANSWER: «лучше сделай»** — SIM-gradient resistance goes INTO M1.4 (MVP), with graceful read-only fallback for trainers without the control point. Trainer/HR models still unnamed — capture them at the future hardware-test session. ✓

**Q7. Demo mode reach.** Dev/showcase only, or player-visible option?
**Recommendation:** player-visible (friends without sensors can look around the bike experience) but always DEMO-badged, never writes ride stats, and never unlocks anything real sensors would.
**ANSWER: согласен во всём.** ✓

**Q8. Real-sensor test hardware.** This dev box has **no Bluetooth adapter at all** — and remote inspection shows **pop-os has none either**. The M1.4 exit criterion is a real ride on a real trainer + HR strap.
**Recommendation:** one cheap USB BT5 dongle for whichever box hosts the trainer test (pop-os per Q1); name your trainer + HR strap models now so the FTMS/CSC parsing targets real hardware from day one.
**ANSWER: писать BLE-часть СЕЙЧАС БЕЗ живого теста.** Owner will attach a dongle later and run a dedicated test session with ALL sensors active at once. Consequence: M1.4's real-hardware exit criterion moves to that separate owner-scheduled session; M1.4 closes on seam-level tests (fake BLE transport under the adapter interface, P6/P7 green). ✓

**Q9. Natural-physics scope vs inherited walk feel.** Pillar B (no unnatural gravity/FOV) conflicts with inherited walk tuning: gravity 22 m/s², +6° sprint-FOV kick (`src/core/FlyCamera.ts:31,42`) — upstream chose game-feel over realism.
**Recommendation:** retune in M1.3 to 9.81 with re-derived jump velocity (keeps ~1.1 m apex ⇒ v0 ≈ 4.6 m/s), remove the FOV kick; you judge the two side by side live and we either keep natural or record an explicit approved deviation.
**ANSWER: делать по рекомендации.** ✓

**Q10. Rider/bike parameters for the solver.** Realistic speed needs mass + CdA + drivetrain loss.
**Recommendation:** defaults rider 75 kg / bike 8–10–13 kg per type / CdA 0.32–0.36–0.42 (road/gravel/MTB) / loss 3–5%, editable in one settings block next to the surface matrix; you can enter your real weight later — not blocking.
**ANSWER: да.** ✓
