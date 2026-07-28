#!/usr/bin/env node
// Варианты пометки «большой сундук / большой ресурс» прямо в чипе оверлея.
// В игре такой пометки нет вовсе, значок «+» на миникарте означает другое,
// поэтому язык придумываем свой — и сразу смотрим его в ленте, а не по одной иконке.
//
// Запуск: node tools/big-variants.js
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'app', 'assets', 'avalon-icons');
const OUT = path.join(ROOT, 'app', 'data', 'preview-big-variants.png');

const CHIP_H = 34, GAP = 6, ICON = 26, ICON_SM = 19;
const GOLD = '#e0a53c', EDGE = '#4a423e', TEXT = '#ece0c8';

// Чип: подложка + иконка + число. Всё остальное — оформление варианта.
async function chip({ icon, count, big, mode }) {
  const iconSize = mode === 'size' && !big ? ICON_SM : (mode === 'size' && big ? ICON + 5 : ICON);
  const w = iconSize + 30;
  const parts = [];
  let svg = `<svg width="${w}" height="${CHIP_H}" xmlns="http://www.w3.org/2000/svg">`;
  const stroke = (big && mode === 'frame') ? GOLD : EDGE;
  const strokeW = (big && mode === 'frame') ? 1.6 : 1;
  const bg = (big && mode === 'fill') ? 'url(#g)' : '#241d1b';
  svg += `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#3a2c17"/><stop offset="1" stop-color="#241d1b"/></linearGradient></defs>`;
  svg += `<rect x="0.5" y="0.5" width="${w - 1}" height="${CHIP_H - 1}" rx="3" fill="${bg}" stroke="${stroke}" stroke-width="${strokeW}"/>`;
  if (big && mode === 'ribbon') svg += `<path d="M${w - 11},1 L${w - 1},1 L${w - 1},11 Z" fill="${GOLD}"/>`;
  if (big && mode === 'bar') svg += `<rect x="3" y="${CHIP_H - 4}" width="${w - 6}" height="2" rx="1" fill="${GOLD}"/>`;
  svg += `<text x="${w - 8}" y="${CHIP_H / 2 + 5}" fill="${TEXT}" font-size="14" font-weight="bold" font-family="sans-serif" text-anchor="end">${count}</text>`;
  if (big && mode === 'caret') svg += `<path d="M${w - 21},${CHIP_H / 2 - 5} l4,-5 l4,5 Z" fill="${GOLD}"/>`;
  svg += '</svg>';
  parts.push({ input: Buffer.from(svg), left: 0, top: 0 });
  parts.push({ input: await sharp(path.join(ICONS, icon + '.webp')).resize(iconSize, iconSize).png().toBuffer(), left: 4, top: Math.round((CHIP_H - iconSize) / 2) });
  if (big && mode === 'glow') {
    // золотой ореол вокруг самой иконки
    const halo = await sharp(path.join(ICONS, icon + '.webp')).resize(iconSize + 6, iconSize + 6)
      .modulate({ brightness: 1.6, saturation: 0 }).tint(GOLD).blur(2.5).png().toBuffer();
    parts.splice(1, 0, { input: halo, left: 1, top: Math.round((CHIP_H - iconSize - 6) / 2) });
  }
  return sharp({ create: { width: w, height: CHIP_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts).png().toBuffer();
}

const ROWS = [
  ['А. рамка золотом', 'frame'],
  ['Б. уголок-лента', 'ribbon'],
  ['В. крупнее', 'size'],
  ['Г. полоска снизу', 'bar'],
  ['Д. галочка у числа', 'caret'],
  ['Е. золотой ореол', 'glow'],
];
const ITEMS = [
  { icon: 'green', count: 5, big: false }, { icon: 'green', count: 1, big: true },
  { icon: 'blue', count: 1, big: false }, { icon: 'blue', count: 1, big: true },
  { icon: 'gold', count: 1, big: false }, { icon: 'gold', count: 1, big: true },
  { icon: 'hide', count: 2, big: false }, { icon: 'hide', count: 1, big: true },
];

(async () => {
  const LABEL_W = 230, ROW_H = 54, SCALE = 2;
  const width = LABEL_W + ITEMS.length * 70 + 20;
  const height = ROWS.length * ROW_H + 16;
  const parts = [];
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  for (let r = 0; r < ROWS.length; r++) {
    const [label, mode] = ROWS[r];
    svg += `<text x="12" y="${r * ROW_H + 36}" fill="${GOLD}" font-size="16" font-family="sans-serif">${label}</text>`;
    let x = LABEL_W;
    for (const it of ITEMS) {
      const buf = await chip({ ...it, mode });
      const m = await sharp(buf).metadata();
      parts.push({ input: buf, left: x, top: r * ROW_H + 12 });
      x += m.width + GAP;
    }
  }
  svg += '</svg>';
  parts.push({ input: Buffer.from(svg), left: 0, top: 0 });
  const sheet = await sharp({ create: { width, height, channels: 4, background: '#17120f' } })
    .composite(parts).png().toBuffer();
  await sharp(sheet).resize(width * SCALE, height * SCALE, { kernel: 'nearest' }).png().toFile(OUT);
  console.log('готово:', OUT);
})();
