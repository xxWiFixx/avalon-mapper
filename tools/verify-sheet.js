#!/usr/bin/env node
// Лист проверки данных: карта зоны рядом с иконками, которые покажет оверлей.
// Нужен, чтобы глазами сверить наши данные с самой игрой — на карте видно каждый
// сундук, данж и ресурс, и рядом сразу написано, что мы про эту зону думаем.
//
// Запуск: node tools/verify-sheet.js [сколько] [страница]
//   node tools/verify-sheet.js 50        → 50 максимально разных зон, 5 листов по 10
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const ZONES = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'data-static', 'zone-data.json'), 'utf8'));
const MAPS = path.join(ROOT, 'app', 'assets', 'avalon-maps-crop');
const ICONS = path.join(ROOT, 'app', 'assets', 'avalon-icons');
const OUT = path.join(ROOT, 'app', 'data');

const COUNT = Number(process.argv[2]) || 50;
const PER_PAGE = 10;

// Тот же порядок, что в ui/activities.js — лист обязан показывать ровно то, что оверлей.
const ORDER = [
  ['brecilien', z => z.brecilien, false], ['gold', z => z.chests.goldBig, true], ['gold', z => z.chests.goldSmall, false],
  ['blue', z => z.chests.blueBig, true], ['blue', z => z.chests.blueSmall, false], ['green', z => z.chests.green, false],
  ['dg_gold', z => z.dungeons.elite, false], ['dg_group', z => z.dungeons.group, false], ['dg_solo', z => z.dungeons.solo, false],
];
const RES = ['ore', 'wood', 'fiber', 'hide', 'rock'];
function itemsOf(z) {
  const out = [];
  for (const [icon, get, big] of ORDER) { const n = Number(get(z)) || 0; if (n > 0) out.push([icon, n, big]); }
  for (const k of RES) if (z.res[k].big > 0) out.push([k, z.res[k].big, true]);
  for (const k of RES) if (z.res[k].small > 0) out.push([k, z.res[k].small, false]);
  return out;
}

// Выбираем МАКСИМАЛЬНО разные зоны: по одной из каждой «сигнатуры» содержимого,
// пока не наберём нужное количество. Иначе лист забьётся одинаковыми T6-дорогами.
function pickDiverse(n) {
  const sig = z => [z.tier, z.type, z.brecilien, z.dungeons.elite, z.dungeons.group, z.dungeons.solo,
    z.chests.goldBig, z.chests.goldSmall, z.chests.blueBig, Math.min(z.chests.green, 6),
    RES.reduce((a, k) => a + z.res[k].big, 0)].join('/');
  const buckets = new Map();
  for (const z of ZONES) {
    if (!fs.existsSync(path.join(MAPS, z.name + '.webp'))) continue;   // без карты сверять нечего
    const k = sig(z);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(z);
  }
  const keys = [...buckets.keys()];
  const out = [];
  // берём по одной зоне из каждой корзины, идя по всему набору с равномерным шагом
  for (let i = 0; i < keys.length && out.length < n; i++) {
    const idx = Math.floor((i * keys.length) / Math.min(n, keys.length)) % keys.length;
    const list = buckets.get(keys[idx]);
    if (list && list.length && !out.includes(list[0])) out.push(list[0]);
  }
  for (const k of keys) { if (out.length >= n) break; const z = buckets.get(k)[0]; if (!out.includes(z)) out.push(z); }
  return out.slice(0, n);
}

const ROMAN = { 4: 'IV', 6: 'VI', 8: 'VIII' };
const MAP_W = 430, MAP_H = 299, ROW_H = 310, PAD = 12, TEXT_W = 660;

(async () => {
  const picked = pickDiverse(COUNT);
  console.log('выбрано зон:', picked.length);
  const pages = Math.ceil(picked.length / PER_PAGE);
  for (let p = 0; p < pages; p++) {
    const rows = picked.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
    const W = PAD * 3 + MAP_W + TEXT_W, H = PAD * 2 + rows.length * ROW_H;
    const parts = [];
    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let i = 0; i < rows.length; i++) {
      const z = rows[i];
      const top = PAD + i * ROW_H;
      parts.push({ input: await sharp(path.join(MAPS, z.name + '.webp')).resize(MAP_W, MAP_H).png().toBuffer(), left: PAD, top });
      const x0 = PAD * 2 + MAP_W;
      svg += `<text x="${x0}" y="${top + 26}" fill="#f6c874" font-size="21" font-family="sans-serif">${z.name}</text>`;
      svg += `<text x="${x0}" y="${top + 50}" fill="#b8ab93" font-size="15" font-family="sans-serif">T${ROMAN[z.tier] || z.tier} · ${z.type}${z.dungeons.factions.length ? ' · ' + z.dungeons.factions.join(', ') : ''}</text>`;
      const items = itemsOf(z);
      for (let k = 0; k < items.length; k++) {
        const [icon, n, big] = items[k];
        const ix = x0 + (k % 9) * 66, iy = top + 66 + Math.floor(k / 9) * 62;
        parts.push({ input: await sharp(path.join(ICONS, icon + '.webp')).resize(44, 43).png().toBuffer(), left: ix, top: iy });
        svg += `<text x="${ix + 46}" y="${iy + 30}" fill="#ece0c8" font-size="19" font-family="sans-serif" font-weight="bold">${n}</text>`;
        // большой узел/сундук — золотая рамка и галочка над числом, как в самом оверлее
        if (big) {
          svg += `<rect x="${ix - 3}" y="${iy - 3}" width="50" height="49" rx="4" fill="none" stroke="#e0a53c" stroke-width="2"/>`;
          svg += `<path d="M${ix + 46},${iy + 14} l5,-8 l5,8 Z" fill="#f6c874"/>`;
        }
      }
      if (!items.length) svg += `<text x="${x0}" y="${top + 92}" fill="#8b8071" font-size="15" font-family="sans-serif">пусто</text>`;
      svg += `<line x1="${PAD}" y1="${top + ROW_H - 6}" x2="${W - PAD}" y2="${top + ROW_H - 6}" stroke="#332b29"/>`;
    }
    svg += '</svg>';
    parts.push({ input: Buffer.from(svg), left: 0, top: 0 });
    const file = path.join(OUT, `verify-${p + 1}.png`);
    await sharp({ create: { width: W, height: H, channels: 4, background: '#14100f' } }).composite(parts).png().toFile(file);
    console.log('лист', p + 1, '→', file, '(' + rows.map(z => z.name).join(', ') + ')');
  }
})();
