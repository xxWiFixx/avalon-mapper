#!/usr/bin/env node
// Снимки экранов, добавленных вместе с настройками: панель переключателей, плашка
// разного размера, плашка без карты, режим «задать место» и окно поиска зоны.
// Всё рисуется headless-браузером с тех же страниц, что показывает приложение, —
// нарисованных «макетов» здесь нет вовсе.
//
// Требует запущенного стенда: node tools/dev-server.js
// Запуск: node tools/preview-ui.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'app', 'data');
const TMP = path.join(OUT, '_tmp');
const PORT = process.env.PORT || 5178;
const FRAME = path.join(ROOT, 'calibration', 'a1.png');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const browser = BROWSERS.find(p => fs.existsSync(p));
if (!browser) { console.error('не нашёл chrome/edge'); process.exit(1); }

fs.mkdirSync(TMP, { recursive: true });
const BG = '#14100f';

function shot(page, file, w, h, scale = 2, transparent = false) {
  const out = path.join(TMP, file);
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-prefers-reduced-motion',
    ...(transparent ? ['--default-background-color=00000000'] : []),
    `--force-device-scale-factor=${scale}`,
    `--window-size=${w},${h}`, '--virtual-time-budget=6000',
    `--screenshot=${out}`, `http://localhost:${PORT}${page}`,
  ], { stdio: 'inherit' });
  return out;
}

// подпись над картинкой: без неё три одинаковые плашки рядом ничего не объясняют
function label(text, w, h, size = 26) {
  const esc = String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<text x="0" y="${size}" font-family="Fira Sans, Segoe UI, sans-serif" font-size="${size}" ` +
    `fill="#b8ab93">${esc}</text></svg>`);
}

(async () => {
  // ---------- 1. панели «куда сохранять» и «настройки» ----------
  // Каждый блок снимаем ОТДЕЛЬНО: страница по ?only=<id> прячет всё остальное, и снимок
  // обрезается сам по содержимому. Замеренные координаты не годились — стоило измениться
  // высоте любого блока выше по панели, и вырезка молча съезжала.
  // Настройки живут в окне поверх, поэтому нужному разделу его сначала открывают (?open=…),
  // а уже потом ?only вырезает из него один блок.
  const BLOCKS = [
    ['preview-route.png', 'маршрут откуда-куда', 'route-block', 'route'],
    ['preview-share.png', 'куда сохранять портал', 'set-maps', 'open=set-maps'],
    ['preview-settings.png', 'панель настроек', 'set-overlay', 'open=set-overlay'],
  ];
  for (const [file, title, id, q] of BLOCKS) {
    // ?route — панель сразу с найденным маршрутом, иначе снимок был бы с пустой подсказкой
    const p = shot(`/ui/index.html?${q}&only=${id}`, `only-${id}.png`, 340, 2200, 2, true);
    const buf = await sharp(p).trim({ threshold: 1 }).flatten({ background: BG }).toBuffer();
    const m = await sharp(buf).metadata();
    await sharp(buf).png().toFile(path.join(OUT, file));
    console.log(title + ':', Math.round(m.width / 2) + 'x' + Math.round(m.height / 2));
  }

  // ---------- 2. размер плашки ----------
  const zone = 'Xiros-Aiairom';
  const sizes = [0.8, 1, 1.5];
  const blocks = [];
  for (const k of sizes) {
    const f = shot(`/ui/overlay-preview.html?zone=${zone}&size=20`, `size-${k}.png`, 300, 560, k, true);
    blocks.push({ k, buf: await sharp(f).trim({ threshold: 1 }).toBuffer() });
  }
  for (const b of blocks) b.meta = await sharp(b.buf).metadata();
  {
    const gap = 34, pad = 24, top = 46;
    const w = pad * 2 + blocks.reduce((a, b) => a + b.meta.width, 0) + gap * (blocks.length - 1);
    const h = top + Math.max(...blocks.map(b => b.meta.height)) + pad;
    const layers = [];
    let x = pad;
    const bottom = h - pad;   // плашка растёт ВВЕРХ от одного и того же низа — так и показываем
    for (const b of blocks) {
      layers.push({ input: label(Math.round(b.k * 100) + '%', b.meta.width, top - 8), left: x, top: 8 });
      layers.push({ input: b.buf, left: x, top: bottom - b.meta.height });
      x += b.meta.width + gap;
    }
    await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
      .composite(layers).png().toFile(path.join(OUT, 'preview-sizes.png'));
    console.log('размеры плашки:', w + 'x' + h);
  }

  // ---------- 3. с картой и без ----------
  {
    const withMap = await sharp(shot(`/ui/overlay-preview.html?zone=${zone}&size=20`, 'map1.png', 300, 560, 2, true))
      .trim({ threshold: 1 }).toBuffer();
    const noMap = await sharp(shot(`/ui/overlay-preview.html?zone=${zone}&size=20&map=0`, 'map0.png', 300, 560, 2, true))
      .trim({ threshold: 1 }).toBuffer();
    const a = await sharp(withMap).metadata(), b = await sharp(noMap).metadata();
    const gap = 40, pad = 24, top = 46;
    const w = pad * 2 + a.width + b.width + gap;
    const h = top + Math.max(a.height, b.height) + pad;
    await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
      .composite([
        { input: label('карта включена', a.width, top - 8), left: pad, top: 8 },
        { input: withMap, left: pad, top },
        { input: label('карта выключена', b.width, top - 8), left: pad + a.width + gap, top: 8 },
        // без карты блок ниже — прижимаем к тому же низу, как это и выглядит поверх игры
        { input: noMap, left: pad + a.width + gap, top: top + a.height - b.height },
      ]).png().toFile(path.join(OUT, 'preview-nomap.png'));
    console.log('с картой и без:', w + 'x' + h);
  }

  // ---------- 3б. отклик на нажатие ----------
  {
    const busy = await sharp(shot('/ui/overlay-preview.html?busy=1', 'busy.png', 300, 300, 2, true))
      .trim({ threshold: 1 }).toBuffer();
    const done = await sharp(shot(`/ui/overlay-preview.html?zone=${zone}&size=20&map=0`, 'done.png', 300, 560, 2, true))
      .trim({ threshold: 1 }).toBuffer();
    const a = await sharp(busy).metadata(), b = await sharp(done).metadata();
    const gap = 40, pad = 24, top = 46;
    const w = pad * 2 + a.width + b.width + gap;
    const h = top + Math.max(a.height, b.height) + pad;
    await sharp({ create: { width: w, height: h, channels: 4, background: BG } })
      .composite([
        { input: label('нажал хоткей', a.width, top - 8), left: pad, top: 8 },
        { input: busy, left: pad, top: top + Math.max(0, b.height - a.height) },
        { input: label('через секунду', b.width, top - 8), left: pad + a.width + gap, top: 8 },
        { input: done, left: pad + a.width + gap, top },
      ]).png().toFile(path.join(OUT, 'preview-busy.png'));
    console.log('отклик на нажатие:', w + 'x' + h);
  }

  // ---------- 4. окно поиска зоны на кадре игры ----------
  {
    // окно снимаем широким: headless-браузер не делает окон уже ~500 px, а панель
    // внутри всё равно ровно той ширины, что и в приложении, — лишнее срежет trim
    // «откуда» берём тот же, что в кадре игры (Cairn Camain на плашке зоны) — снимок
    // должен читаться как одна сцена, а не как склейка из разных состояний
    const f = shot('/ui/search.html?q=couexa%205%2036&here=Cairn%20Camain&size=20', 'search.png', 700, 430, 2, true);
    const win = await sharp(f).trim({ threshold: 1 }).toBuffer();
    const wm = await sharp(win).metadata();
    const bg = sharp(FRAME);
    const fm = await bg.metadata();
    const s = fm.height / 1080;
    // Окно встаёт ТУДА ЖЕ, где плашка с картой зоны: левый край по плашке зоны,
    // низ — по низу блока над миникартой. Те же константы, что в lib/overlay-place.js,
    // иначе снимок показывал бы не то место, где окно появится на самом деле.
    const shown = Math.round(wm.width * s / 2), shownH = Math.round(wm.height * s / 2);
    const left = Math.round(fm.width - 400 * s);                      // левый край плашки зоны
    const overlayBottom = Math.round(fm.height - 48 * s - (267 + 12) * s);  // низ блока над миникартой
    const top = Math.max(0, overlayBottom - shownH);
    await bg.composite([{ input: await sharp(win).resize(shown).toBuffer(), left, top }])
      .png().toFile(path.join(OUT, 'preview-search.png'));
    console.log('окно поиска:', wm.width + 'x' + wm.height, '→ на кадре', fm.width + 'x' + fm.height);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('готово:', OUT);
})();
