/**
 * Blue-grass metric: fraction of "bluish" pixels inside a horizontal band ROI.
 * Matches the main-thread baseline discriminator for the far-grass carpet
 * (WARPLAN fact 6): hue 185..255, sat >= 0.10, value >= 0.45, over rows
 * topFrac..botFrac of the frame (default 0.03..0.33 = the far grass band).
 *
 * Usage:
 *   node tools/measure-grass-blue.mjs --img shots/x.png [--top 0.03] [--bot 0.33]
 * Prints a one-line JSON: {"img":...,"bluePct":...,"blue":N,"total":N,"band":[y0,y1]}
 */
import sharp from 'sharp';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--')) {
        out[k] = n;
        i++;
      } else out[k] = true;
    }
  }
  return out;
}

// standard RGB->HSV; hue in degrees [0,360), sat/val in [0,1]
function rgb2hsv(r, g, b) {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const mx = Math.max(rn, gn, bn),
    mn = Math.min(rn, gn, bn);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (mx === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  const s = mx === 0 ? 0 : d / mx;
  return [h, s, mx];
}

export async function measureBlue(imgPath, topFrac = 0.03, botFrac = 0.33) {
  const { data, info } = await sharp(imgPath)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const y0 = Math.round(height * topFrac);
  const y1 = Math.round(height * botFrac);
  let blue = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const [h, s, v] = rgb2hsv(data[idx], data[idx + 1], data[idx + 2]);
      total++;
      if (h >= 185 && h <= 255 && s >= 0.1 && v >= 0.45) blue++;
    }
  }
  return { bluePct: total ? (100 * blue) / total : 0, blue, total, band: [y0, y1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const img = typeof args.img === 'string' ? args.img : undefined;
  if (!img) throw new Error('need --img <path>');
  const top = args.top !== undefined ? Number(args.top) : 0.03;
  const bot = args.bot !== undefined ? Number(args.bot) : 0.33;
  const r = await measureBlue(img, top, bot);
  console.log(
    JSON.stringify({ img, bluePct: Number(r.bluePct.toFixed(3)), ...r }),
  );
}

// run as CLI only when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[measure-grass-blue] FAILED:', e?.message ?? e);
    process.exit(1);
  });
}
