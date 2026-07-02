World gen takes ~47–63 s per boot on this box (M1 budget was ≤15 s) — probe suites must boot ONCE and jump bookmarks by key, not boot per shot.

- Boot-to-ready measured 2026-07-02: 63.1 s / 48.5 s / 47.4 s / 46.3 s (native + 1600×900 pages, high preset, Vega 7 RADV headless). shoot.ts's boot-per-shot pattern multiplies this: a 5-shot battery ≈ 4+ min of pure regeneration.
- Working pattern (used by the session-0 baseline probe): one page → `?shot=1` boot → `page.keyboard.press('2'|'3'|...)` (Bookmarks listens on window keydown, applies pose + per-bookmark ToD) → `__laas.settle(120)` → sample/capture → next key. Flythrough via press `'f'`.
- Caveat: bookmark jumps switch the rig to fly mode (setPose contract) and change ToD — CSM/probe-GI re-converge during the settle; 120 frames was enough for stable frame-time sampling.
- For in-page rAF/frame-time sampling, pass the evaluate body as a STRING — tsx/esbuild injects a `__name` helper around named function expressions in compiled evaluate callbacks (ReferenceError in page; trap already documented for probe-pointerlock.ts in STATUS.md, bites every new tool).
