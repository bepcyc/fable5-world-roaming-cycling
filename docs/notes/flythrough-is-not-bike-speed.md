The 92 s flythrough moves at ~60–70 m/s (ride HUD read 226–228 km/h) — 4–5× bike speed; it's a fine stress capture but NOT a valid bike-speed proxy for LOD/shadow judgments.

- Evidence 2026-07-02: RideHud (speed from getPose deltas) during `?fly=1` showed 226.0–228.3 km/h; target bike speeds are 40–50 km/h (11–14 m/s).
- Consequence: the "moving capture at bike speed" required by the brief's verification policy needs its own drive — either a speed-limited camera path along a future road (best: reuse the Bookmarks/TOUR Catmull-Rom machinery with a 12 m/s parameterization) or the bike mode itself once M1.3 lands. Until then, flythrough samples overstate motion cost (CSM cache invalidation, LOD churn) — label them "flythrough (≈65 m/s)", never "bike speed".
- Also useful: RideHud doubles as a speedometer for any probe — it reads the logical pose, so bob/effects never pollute the number, and teleports (setPose) reset instead of spiking.
