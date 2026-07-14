/**
 * Find road spawns (edge, s, dir) on a seed where, riding forward, the highest
 * peak AND a water body are CLEARLY visible in the distance (occlusion-checked
 * line of sight over terrain, readable distance, open descending vantage).
 * Prints JSON with the top candidates. Trees are scatter (not in the height
 * field), so we bias toward high/open descending spawns to dodge forest cover.
 *
 *   LAAS_PORT=5174 npx tsx tools/find-peak-water-spawn.ts --seed 33726
 */
import { launchWebGPUReal, LAAS_ORIGIN } from './launch-gpu';

const args = process.argv.slice(2);
const seed = Number(args[args.indexOf('--seed') + 1] ?? 1);

async function main(): Promise<void> {
  const { browser } = await launchWebGPUReal();
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  await page.goto(`${LAAS_ORIGIN}/?scene=world&seed=${seed}&T=14&hud=0&freeze=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (window as any).__laas && ((window as any).__laas.ready || (window as any).__laas.error !== null),
    undefined,
    { timeout: 600_000, polling: 500 },
  );

  const out = await page.evaluate(`(() => {
    const dbg = window.__laasDbg;
    const hf = dbg.engine.heightfield;
    const g = dbg.rideGraph;
    const HALF = 2048, EYE = 1.7;

    // highest peak
    let peak = { x: 0, z: 0, h: -1e9 };
    for (let z = -HALF; z <= HALF; z += 28)
      for (let x = -HALF; x <= HALF; x += 28) {
        const h = hf.heightAtCpu(x, z);
        if (h > peak.h) peak = { x, z, h };
      }

    // lakes: cluster water cells (128 m buckets), keep centroids w/ surface Y
    const buckets = new Map();
    for (let z = -HALF; z <= HALF; z += 24)
      for (let x = -HALF; x <= HALF; x += 24)
        if (hf.waterDepthAtCpu(x, z) > 0.5) {
          const k = Math.round(x / 128) + ',' + Math.round(z / 128);
          const b = buckets.get(k) || { sx: 0, sz: 0, n: 0 };
          b.sx += x; b.sz += z; b.n++; buckets.set(k, b);
        }
    const lakes = [];
    for (const b of buckets.values())
      if (b.n >= 6) { const x = b.sx / b.n, z = b.sz / b.n; lakes.push({ x, z, y: hf.heightAtCpu(x, z), cells: b.n }); }
    lakes.sort((a, b) => b.cells - a.cells);

    const yawOf = (dx, dz) => { const L = Math.hypot(dx, dz) || 1; return Math.atan2(-dx / L, -dz / L); };
    const angTo = (ox, oz, yaw, tx, tz) => {
      const dx = tx - ox, dz = tz - oz, d = Math.hypot(dx, dz) || 1;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      return { ang: Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d))) * 180 / Math.PI, d };
    };
    // terrain line-of-sight: straight eye->target, terrain must stay below it
    const losClear = (ox, oz, oy, tx, tz, ty) => {
      const N = 48;
      for (let i = 1; i < N; i++) {
        const t = i / N;
        const th = hf.heightAtCpu(ox + (tx - ox) * t, oz + (tz - oz) * t);
        if (th > oy + (ty - oy) * t + 6) return false;
      }
      return true;
    };

    const cands = [];
    for (const e of g.edges) {
      const sid = e.cls && e.cls.surfaceId;
      if (sid !== 10 && sid !== 11) continue;
      const len = e.length || 0;
      if (len < 140) continue;
      for (const dir of [1, -1]) {
        for (let s0 = 50; s0 < len - 50; s0 += 70) {
          let peakBest = null, lakeBest = null, descend = 0, alt0 = 0;
          const first = g.sample(e.id, s0); alt0 = hf.heightAtCpu(first.x, first.z);
          for (let step = 0; step <= 360; step += 45) {
            const s = s0 + dir * step;
            if (s < 5 || s > len - 5) break;
            const a = g.sample(e.id, s);
            const b = g.sample(e.id, Math.min(len - 2, Math.max(2, s + dir * 8)));
            const yaw = yawOf(b.x - a.x, b.z - a.z);
            const oy = hf.heightAtCpu(a.x, a.z) + EYE;
            // peak: readable distance 900-4500 m, tight cone, clear LOS
            const pk = angTo(a.x, a.z, yaw, peak.x, peak.z);
            if (pk.ang <= 30 && pk.d >= 900 && pk.d <= 4500 && losClear(a.x, a.z, oy, peak.x, peak.z, peak.h))
              if (!peakBest || pk.d < peakBest.d) peakBest = { d: +pk.d.toFixed(0), ang: +pk.ang.toFixed(0), step };
            // lake: 250-3500 m, wider cone, clear LOS to its surface
            for (const lk of lakes) {
              const la = angTo(a.x, a.z, yaw, lk.x, lk.z);
              if (la.ang <= 38 && la.d >= 250 && la.d <= 3500 && losClear(a.x, a.z, oy, lk.x, lk.z, lk.y + 1))
                if (!lakeBest || lk.cells > (lakeBest.cells || 0)) lakeBest = { d: +la.d.toFixed(0), cells: lk.cells, step };
            }
          }
          // descent: ground 200 m ahead lower than spawn (view opens over trees)
          const ahead = g.sample(e.id, Math.min(len - 5, Math.max(5, s0 + dir * 200)));
          descend = alt0 - hf.heightAtCpu(ahead.x, ahead.z);
          if (peakBest && lakeBest) {
            const sm = g.sample(e.id, s0);
            // score: closer peak + bigger lake + descent + higher vantage
            const score = (4500 - peakBest.d) / 100 + Math.min(lakeBest.cells, 200) / 10
              + Math.max(0, descend) / 5 + Math.max(0, alt0 - 600) / 40;
            cands.push({ edge: e.id, route: e.route, s: s0, dir, x: +sm.x.toFixed(1), z: +sm.z.toFixed(1), sid,
              alt: +alt0.toFixed(0), descend: +descend.toFixed(0), peak: peakBest, lake: lakeBest, score: +score.toFixed(1) });
          }
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    return { seed: ${seed}, peakMaxH: +peak.h.toFixed(0), peak: { x: +peak.x.toFixed(0), z: +peak.z.toFixed(0) },
      lakes: lakes.length, top: cands.slice(0, 4) };
  })()`);

  console.log(JSON.stringify(out));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
