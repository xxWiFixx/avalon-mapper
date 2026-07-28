#!/usr/bin/env node
// Предпросмотр оверлея НА НАСТОЯЩЕМ кадре игры: снимает блок с прозрачным фоном
// и кладёт его туда, куда его поставит приложение — над миникартой справа внизу.
//
// Требует запущенного стенда: node tools/dev-server.js
// Запуск: node tools/preview-overlay.js [зона] [кадр.png]
//
// Геометрия взята из замеров по калибровочным кадрам 1080p: верх компаса «N» миникарты
// на 267 px выше верха плашки зоны, сама плашка — 380x30 в правом нижнем углу.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'app', 'data');
const zone = process.argv[2] || 'Oiros-Alaiam';
const frame = process.argv[3] || path.join(ROOT, 'calibration', 'a1.png');
const PORT = process.env.PORT || 5178;

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const browser = BROWSERS.find(p => fs.existsSync(p));
if (!browser) { console.error('не нашёл chrome/edge'); process.exit(1); }

const BLOCK = path.join(OUT_DIR, 'preview-block.png');
fs.mkdirSync(OUT_DIR, { recursive: true });

execFileSync(browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-prefers-reduced-motion',
  '--default-background-color=00000000',            // прозрачный фон страницы
  '--window-size=300,520', '--virtual-time-budget=6000',   // с запасом: блок прижат к низу, лишнее срежет trim
  `--screenshot=${BLOCK}`,
  // состояние портала можно задать: PREVIEW_QUERY="cap=2&closes=780&canuse=95"
  `http://localhost:${PORT}/ui/overlay-preview.html?zone=${encodeURIComponent(zone)}${process.env.PREVIEW_QUERY ? '&' + process.env.PREVIEW_QUERY : ''}`,
], { stdio: 'inherit' });

(async () => {
  const block = sharp(BLOCK);
  const bm = await block.metadata();
  // обрезаем прозрачные поля снимка, чтобы блок лёг ровно
  const trimmed = await block.trim({ threshold: 1 }).toBuffer();
  const tm = await sharp(trimmed).metadata();

  const bg = sharp(frame);
  const fm = await bg.metadata();
  const s = fm.height / 1080;                       // все константы заданы для 1080p
  const barLeft = Math.round(fm.width - 400 * s);   // левый край плашки зоны (стандартная раскладка)
  const compassTop = Math.round(fm.height - 48 * s - 267 * s);  // верх компаса «N» миникарты
  const left = barLeft;
  const top = Math.max(0, compassTop - 12 - tm.height);

  await bg.composite([{ input: trimmed, left, top }])
    .png().toFile(path.join(OUT_DIR, 'preview-on-frame.png'));
  await sharp(trimmed).resize(tm.width * 3, tm.height * 3, { kernel: 'lanczos3' })
    .flatten({ background: '#14100f' }).png().toFile(path.join(OUT_DIR, 'preview-block-2x.png'));

  console.log('блок:', tm.width + 'x' + tm.height, '(снимок был ' + bm.width + 'x' + bm.height + ')');
  console.log('кадр:', fm.width + 'x' + fm.height, '→ блок поставлен в', left + ',' + top);
  console.log('готово:', path.join(OUT_DIR, 'preview-on-frame.png'), 'и preview-block-2x.png');
})();
