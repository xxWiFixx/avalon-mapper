#!/usr/bin/env node
// Нарезка атласа иконок миникарты Albion на отдельные картинки.
//
// Иконки берём из клиента игры (MiniMapAtlas 2048x2048, вытащен UnityPy из
// resources.assets) — это оригинальная графика в нормальном разрешении, а не
// перекрашенные вручную вырезки с чужих карт.
//
// Метаданных спрайтов в сборке нет (il2cpp, тип-три вырезаны), поэтому режем сами:
// берём связные области непрозрачных пикселей. Свечение вокруг иконки прозрачное
// не полностью, так что порог альфы низкий, а близкие куски склеиваем расширением.
//
// Запуск: node tools/cut-atlas.js <атлас.png> <куда>
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const SRC = process.argv[2] || path.join(__dirname, '..', 'app', 'assets', 'atlas', 'MiniMapAtlas.png');
const OUT = process.argv[3] || path.join(__dirname, '..', 'app', 'assets', 'atlas', 'cut');

const ALPHA_MIN = 12;      // ниже — считаем фоном
const GLUE = 1;            // склейка кусков одной иконки (пиксели расширения)
const MIN_SIDE = 16, MAX_SIDE = 200, MIN_AREA = 300;

function dilate(mask, W, H, r) {
  let cur = mask;
  for (let i = 0; i < r; i++) {
    const next = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (cur[p] || cur[p - 1] || cur[p + 1] || cur[p - W] || cur[p + W]) next[p] = 1;
    }
    cur = next;
  }
  return cur;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) if (data[p * 4 + 3] >= ALPHA_MIN) mask[p] = 1;
  const glued = dilate(mask, W, H, GLUE);

  const seen = new Uint8Array(W * H), stack = new Int32Array(W * H);
  const boxes = [];
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!glued[p0] || seen[p0]) continue;
    let sp = 0; stack[sp++] = p0; seen[p0] = 1;
    let n = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    while (sp > 0) {
      const p = stack[--sp], x = p % W, y = (p - x) / W;
      n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && glued[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (n < MIN_AREA || w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) continue;
    boxes.push({ minX, minY, w, h, n });
  }
  boxes.sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
  console.log('найдено иконок:', boxes.length);

  const TH = 96, COLS = 16;
  const parts = [];
  let svg = `<svg width="${COLS * (TH + 8)}" height="${Math.ceil(boxes.length / COLS) * (TH + 24)}" xmlns="http://www.w3.org/2000/svg">`;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const buf = await sharp(SRC).extract({ left: b.minX, top: b.minY, width: b.w, height: b.h }).png().toBuffer();
    fs.writeFileSync(path.join(OUT, String(i).padStart(3, '0') + '.png'), buf);
    const col = i % COLS, row = Math.floor(i / COLS);
    parts.push({ input: await sharp(buf).resize(TH, TH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
      left: col * (TH + 8) + 4, top: row * (TH + 24) + 2 });
    svg += `<text x="${col * (TH + 8) + TH / 2 + 4}" y="${row * (TH + 24) + TH + 16}" fill="#9aa0a6" font-size="13" font-family="sans-serif" text-anchor="middle">${i}</text>`;
  }
  svg += '</svg>';
  parts.push({ input: Buffer.from(svg), left: 0, top: 0 });
  const sheetW = COLS * (TH + 8), sheetH = Math.ceil(boxes.length / COLS) * (TH + 24);
  await sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: '#1c1716' } })
    .composite(parts).png().toFile(path.join(OUT, '..', 'atlas-sheet.png'));
  console.log('лист с номерами:', path.join(OUT, '..', 'atlas-sheet.png'), `${sheetW}x${sheetH}`);
})();
