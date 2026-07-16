// black-sliver detector: finds near-black pixel clusters in a frame,
// paints them red on an overlay, extracts zoom crops of the top clusters,
// prints numeric stats (gate material).
// usage: node detect-black.mjs <in.png> <outPrefix> [vMax=22] [minPx=6]
import sharp from 'sharp';

const [inPath, outPrefix, vMaxS, minPxS] = process.argv.slice(2);
const V_MAX = Number(vMaxS ?? 22); // 0..255 max channel value to call "black"
const MIN_PX = Number(minPxS ?? 6); // min cluster size (pixels)

const img = sharp(inPath);
const { width: W, height: H } = await img.metadata();
const raw = await img.clone().raw().toBuffer(); // RGB
const ch = raw.length / (W * H); // 3 or 4

// skip HUD corners (fps chip, gear icon)
const skip = (x, y) => (x < 120 && y < 40) || (x > W - 90 && y > H - 90);

const mask = new Uint8Array(W * H);
let blackCount = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (skip(x, y)) continue;
    const o = (y * W + x) * ch;
    if (raw[o] <= V_MAX && raw[o + 1] <= V_MAX && raw[o + 2] <= V_MAX) {
      mask[y * W + x] = 1;
      blackCount++;
    }
  }
}

// connected components (4-neigh, iterative flood)
const labels = new Int32Array(W * H).fill(-1);
const clusters = [];
const stack = [];
for (let i = 0; i < W * H; i++) {
  if (mask[i] !== 1 || labels[i] !== -1) continue;
  const id = clusters.length;
  let n = 0, minX = W, maxX = 0, minY = H, maxY = 0, sx = 0, sy = 0;
  stack.length = 0;
  stack.push(i);
  labels[i] = id;
  while (stack.length) {
    const p = stack.pop();
    const px = p % W, py = (p / W) | 0;
    n++; sx += px; sy += py;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    const nb = [p - 1, p + 1, p - W, p + W];
    for (const q of nb) {
      if (q < 0 || q >= W * H) continue;
      if (Math.abs((q % W) - px) > 1) continue;
      if (mask[q] === 1 && labels[q] === -1) { labels[q] = id; stack.push(q); }
    }
  }
  clusters.push({ id, n, minX, maxX, minY, maxY, cx: (sx / n) | 0, cy: (sy / n) | 0 });
}
const big = clusters.filter((c) => c.n >= MIN_PX).sort((a, b) => b.n - a.n);

// overlay: black pixels -> pure red
const over = Buffer.from(raw);
for (let i = 0; i < W * H; i++) {
  if (mask[i] === 1 && clusters[labels[i]] && clusters[labels[i]].n >= MIN_PX) {
    over[i * ch] = 255; over[i * ch + 1] = 20; over[i * ch + 2] = 20;
  }
}
await sharp(over, { raw: { width: W, height: H, channels: ch } })
  .png().toFile(`${outPrefix}-marked.png`);

// zoom crops of the 3 biggest clusters (240x240 around centroid, 3x upscale)
for (let k = 0; k < Math.min(3, big.length); k++) {
  const c = big[k];
  const cs = 240;
  const left = Math.max(0, Math.min(W - cs, c.cx - cs / 2));
  const top = Math.max(0, Math.min(H - cs, c.cy - cs / 2));
  await sharp(inPath).extract({ left, top, width: cs, height: cs })
    .resize(cs * 3, cs * 3, { kernel: 'nearest' })
    .png().toFile(`${outPrefix}-zoom${k}.png`);
}

const totPx = W * H;
console.log(JSON.stringify({
  file: inPath, width: W, height: H,
  blackPx: blackCount, blackPct: +(100 * blackCount / totPx).toFixed(3),
  clusters: big.length,
  top: big.slice(0, 8).map((c) => ({ n: c.n, cx: c.cx, cy: c.cy })),
}, null, 1));
