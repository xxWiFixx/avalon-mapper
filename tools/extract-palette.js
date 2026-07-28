// Достаёт доминирующую палитру из игровых ассетов (карты зон Авалона + иконки активностей).
// Источник правды по цвету — сама игра, а не наши догадки.
const sharp = require('../app/node_modules/sharp');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'app', 'assets');
async function sampleDir(dir, limit) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.webp')).slice(0, limit);
  const buckets = new Map();
  for (const f of files) {
    const { data, info } = await sharp(path.join(dir, f))
      .resize(48, 48, { fit: 'inside' })
      .raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    for (let i = 0; i < data.length; i += ch) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (ch === 4 && data[i + 3] < 128) continue;
      // квантуем до 24 уровней на канал, чтобы близкие оттенки схлопнулись
      const key = [r, g, b].map(v => Math.round(v / 24) * 24).join(',');
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      buckets.set(key, e);
    }
  }
  return [...buckets.entries()]
    .map(([, e]) => ({ n: e.n, r: Math.round(e.r / e.n), g: Math.round(e.g / e.n), b: Math.round(e.b / e.n) }))
    .sort((a, b) => b.n - a.n);
}
const hex = c => '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
function hsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let h = 0;
  if (d) { if (mx === R) h = ((G - B) / d) % 6; else if (mx === G) h = (B - R) / d + 2; else h = (R - G) / d + 4; }
  h = Math.round(h * 60); if (h < 0) h += 360;
  const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return `${h} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

(async () => {
  for (const [label, dir, lim] of [['КАРТЫ ЗОН', path.join(root, 'avalon-maps'), 40], ['ИКОНКИ', path.join(root, 'avalon-icons'), 8]]) {
    const top = await sampleDir(dir, lim);
    const total = top.reduce((s, c) => s + c.n, 0);
    console.log(`\n=== ${label} (${lim} файлов) — топ-14 цветов ===`);
    for (const c of top.slice(0, 14)) {
      console.log(`${hex(c).padEnd(9)} hsl(${hsl(c).padEnd(14)})  ${(100 * c.n / total).toFixed(1)}%`);
    }
  }
})();
