/**
 * Labeled grid montage: lays out N images in a grid with a text caption
 * banner on each cell. English/ASCII labels only (no Cyrillic in tooling).
 *
 * Usage:
 *   node tools/montage-grid.mjs --out out.png --cols 2 --cell 960x540 \
 *     "before|21.46%:a.png" "spec0.25|0.92%:b.png" ...
 * Each positional arg is "LABEL:path" (label may contain | for a second line).
 */
import sharp from 'sharp';

function parseArgs(argv) {
  const opts = {};
  const items = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      opts[a.slice(2)] = argv[i + 1];
      i++;
    } else items.push(a);
  }
  return { opts, items };
}

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function main() {
  const { opts, items } = parseArgs(process.argv.slice(2));
  const out = opts.out ?? 'shots/montage.png';
  const cols = Number(opts.cols ?? 2);
  const [cw, ch] = (opts.cell ?? '960x540').split('x').map(Number);
  const banner = 44;
  const gap = 6;

  const cells = [];
  for (const it of items) {
    const ci = it.lastIndexOf(':');
    const label = it.slice(0, ci);
    const path = it.slice(ci + 1);
    const img = await sharp(path)
      .resize(cw, ch, { fit: 'cover' })
      .toBuffer();
    const lines = label.split('|');
    const tspans = lines
      .map(
        (ln, i) =>
          `<tspan x="12" y="${28 + i * 0}" >${esc(ln)}</tspan>`,
      )
      .join('');
    const text = esc(lines.join('   '));
    const svg = Buffer.from(
      `<svg width="${cw}" height="${banner}"><rect width="${cw}" height="${banner}" fill="#0b0e0c"/><text x="12" y="29" font-family="monospace" font-size="26" fill="#eaeaea">${text}</text></svg>`,
    );
    const cell = await sharp({
      create: {
        width: cw,
        height: ch + banner,
        channels: 3,
        background: { r: 11, g: 14, b: 12 },
      },
    })
      .composite([
        { input: svg, left: 0, top: 0 },
        { input: img, left: 0, top: banner },
      ])
      .png()
      .toBuffer();
    cells.push(cell);
  }

  const rows = Math.ceil(cells.length / cols);
  const cellH = ch + banner;
  const W = cols * cw + (cols - 1) * gap;
  const H = rows * cellH + (rows - 1) * gap;
  const composites = cells.map((buf, idx) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    return { input: buf, left: c * (cw + gap), top: r * (cellH + gap) };
  });
  await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 20, g: 22, b: 20 } },
  })
    .composite(composites)
    .png()
    .toFile(out);
  console.log(`[montage] wrote ${out} (${W}x${H}, ${cells.length} cells)`);
}

main().catch((e) => {
  console.error('[montage] FAILED:', e?.message ?? e);
  process.exit(1);
});
