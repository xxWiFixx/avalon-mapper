#!/usr/bin/env node
// Сборка набора иконок активностей.
//
// ГЛАВНОЕ: иконки берём из САМОЙ ИГРЫ — атлас миникарты MiniMapAtlas (2048x2048),
// вытащенный из resources.assets клиента (см. tools/README-icons.md). Это оригинальная
// графика, а не перекрашенные вручную вырезки с чужих карт — у тех было и разное
// разрешение, и разный масштаб.
//
// «Большой» показываем так же, как показывает игра: золотым «плюсом» в углу. В атласе
// у ресурсов ровно эта пара — один и тот же предмет с плюсом и без; плюс мы вырезаем
// один раз и ставим тем сущностям, где размер важен (большие сундуки).
//
// Все иконки нормализуются: обрезаются по содержимому и вписываются в один квадрат с
// одинаковой оптической высотой, иначе в ленте оверлея они «пляшут» по размеру.
//
// Запуск: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const ATLAS = path.join(ROOT, 'app', 'assets', 'atlas', 'MiniMapAtlas.png');
const BOXES = path.join(ROOT, 'app', 'assets', 'atlas', 'boxes.json');
const ICONS = path.join(ROOT, 'app', 'assets', 'avalon-icons');
const LEGACY = path.join(ROOT, 'app', 'assets', 'avalon-icons-legacy');

const SIZE = 64;             // канва иконки
const FILL = 0.86;           // какую долю канвы занимает содержимое

// Номера в нарезке атласа (tools/cut-atlas.js). Опознаны глазами по игре.
const FROM_ATLAS = {
  green: 260,        // сундук с зелёным свечением (соло)
  blue: 216,         // с синим (группа)
  gold: 217,         // с золотым (рейд)
  brecilien: 114,    // сиреневый вихрь — портал в Туманы
  // ресурсы: в атласе лежат ВАРИАНТЫ С ПЛЮСОМ, малый получаем стиранием плюса
  ore: 198, wood: 230, fiber: 280, hide: 56, rock: 72,
};
const RES_KEYS = ['ore', 'wood', 'fiber', 'hide', 'rock'];
const BIG_KEYS = ['green', 'blue', 'gold', ...RES_KEYS];

// Вписываем содержимое в квадрат: обрезаем прозрачные поля и масштабируем по большей стороне.
async function normalize(buf) {
  const trimmed = await sharp(buf).trim({ threshold: 4 }).toBuffer();
  const inner = Math.round(SIZE * FILL);
  const fit = await sharp(trimmed)
    .resize({ width: inner, height: inner, fit: 'inside', kernel: 'lanczos3' })
    .toBuffer();
  const m = await sharp(fit).metadata();
  return sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fit, left: Math.round((SIZE - m.width) / 2), top: Math.round((SIZE - m.height) / 2) }])
    .png().toBuffer();
}

// Золотой «плюс» игры: берём из угла ресурсной иконки с плюсом.
async function extractPlus(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const out = Buffer.alloc(W * H * 4);
  let minX = W, maxX = 0, minY = H, maxY = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    // плюс — яркий жёлтый и только в правой верхней части
    const golden = a > 40 && r > 190 && g > 140 && b < 150 && r - b > 70;
    if (golden && x > W * 0.5 && y < H * 0.55) {
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
      n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!n) throw new Error('плюс не найден');
  const img = sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  return { buf: await img.png().toBuffer(), rect: { minX, minY, maxX, maxY } };
}

// Стираем плюс, чтобы получить «малый» вариант того же предмета.
// Стираем ИМЕННО пиксели плюса (и его свечение), а не прямоугольник вокруг: у разных
// ресурсов плюс стоит по-разному, и прямоугольник от соседней иконки срезал сам предмет.
async function removePlus(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const isPlus = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    return a > 30 && r > 205 && g > 150 && b < 150 && r - b > 90 && g - b > 40;
  };
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < Math.round(H * 0.62); y++) {
    for (let x = Math.round(W * 0.45); x < W; x++) {
      if (isPlus((y * W + x) * 4)) mask[y * W + x] = 1;
    }
  }
  // свечение вокруг плюса тоже убираем — расширяем маску на пару пикселей
  for (let step = 0; step < 2; step++) {
    const next = new Uint8Array(mask);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (mask[p - 1] || mask[p + 1] || mask[p - W] || mask[p + W]) next[p] = 1;
    }
    mask.set(next);
  }
  let n = 0;
  for (let p = 0; p < W * H; p++) if (mask[p]) { data[p * 4 + 3] = 0; n++; }
  if (!n) console.log('  (плюс не найден — иконка осталась как есть)');

  // Одного стирания мало: у плюса широкое свечение, и на его месте остаётся «дыра».
  // Поэтому кадрируем по самому ПРЕДМЕТУ — всё, что было в углу с плюсом, просто отрезаем.
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] > 40) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png().toBuffer();
}

// Ставим плюс в правый верхний угол готовой иконки.
async function withPlus(iconBuf, plusBuf) {
  const side = Math.round(SIZE * 0.42);
  const plus = await sharp(plusBuf).resize({ width: side, height: side, fit: 'inside' }).toBuffer();
  const m = await sharp(plus).metadata();
  return sharp(iconBuf)
    .composite([{ input: plus, left: SIZE - m.width - 1, top: 1 }])
    .png().toBuffer();
}

(async () => {
  const boxes = JSON.parse(fs.readFileSync(BOXES, 'utf8'));
  const cut = async (idx) => {
    const b = boxes[idx];
    if (!b) throw new Error('нет иконки #' + idx + ' в нарезке атласа');
    return sharp(ATLAS).extract({ left: b.minX, top: b.minY, width: b.w, height: b.h }).png().toBuffer();
  };

  // старые иконки сохраняем: по ним ещё сверяются скриншоты и они пригодятся для сравнения
  if (!fs.existsSync(LEGACY)) {
    fs.mkdirSync(LEGACY, { recursive: true });
    for (const f of fs.readdirSync(ICONS)) fs.copyFileSync(path.join(ICONS, f), path.join(LEGACY, f));
    console.log('старый набор сохранён в', LEGACY);
  }

  const plusSrc = await cut(FROM_ATLAS.hide);
  const { buf: plusBuf, rect: plusRect } = await extractPlus(plusSrc);
  fs.writeFileSync(path.join(ROOT, 'app', 'assets', 'atlas', 'plus.png'), plusBuf);

  const made = [];
  // ---- портал в Туманы: из атласа игры ----
  for (const key of ['brecilien']) {
    const icon = await normalize(await cut(FROM_ATLAS[key]));
    fs.writeFileSync(path.join(ICONS, key + '.webp'), await sharp(icon).webp({ quality: 95 }).toBuffer());
    made.push(key);
  }
  // ---- сундуки: прежние «сундук на подставке» ----
  // В атласе миникарты есть сундуки-маркеры со свечением, но это НЕ сундуки Дорог, а
  // общие значки добычи. Игрок узнаёт именно подставку с карты зоны, поэтому берём её.
  for (const key of ['green', 'blue', 'gold']) {
    const src = path.join(LEGACY, key + '.webp');
    if (!fs.existsSync(src)) { console.log('нет исходной иконки', key); continue; }
    fs.writeFileSync(path.join(ICONS, key + '.webp'),
      await sharp(await normalize(fs.readFileSync(src))).webp({ quality: 95 }).toBuffer());
    made.push(key);
  }
  // ---- ресурсы ----
  // В атласе миникарты лежат только БОЛЬШИЕ узлы (с плюсом); обычных того же рисунка там
  // нет, а стирать плюс нельзя — его свечение накрывает сам предмет, остаётся дыра.
  // Поэтому предмет берём из прежнего набора (это тоже рендеры игры, только чистые),
  // а «большой» помечаем ИГРОВЫМ золотым плюсом из атласа. Пара получается одинаковой.
  for (const key of RES_KEYS) {
    const src = path.join(LEGACY, key + '.webp');
    if (!fs.existsSync(src)) { console.log('нет исходной иконки', key); continue; }
    fs.writeFileSync(path.join(ICONS, key + '.webp'),
      await sharp(await normalize(fs.readFileSync(src))).webp({ quality: 95 }).toBuffer());
    made.push(key);
  }
  // Отдельных иконок для «больших» больше нет: в игре такой пометки не существует,
  // поэтому размер показывает САМ ИНТЕРФЕЙС (см. ui/overlay.css, класс .act.big) —
  // так одну и ту же иконку не приходится держать в двух вариантах.
  for (const f of fs.readdirSync(ICONS)) if (f.endsWith('-big.webp')) fs.unlinkSync(path.join(ICONS, f));

  // ---- подземелья: в атласе миникарты их нет (в игре это объекты на карте, а не значки),
  // поэтому берём прежние рендеры и приводим к общему размеру; золотое — из синего сдвигом тона
  for (const key of ['dg_solo', 'dg_group']) {
    const src = path.join(LEGACY, key + '.webp');
    if (!fs.existsSync(src)) continue;
    fs.writeFileSync(path.join(ICONS, key + '.webp'), await sharp(await normalize(fs.readFileSync(src))).webp({ quality: 95 }).toBuffer());
    made.push(key);
  }
  // Золотое (авалонское) подземелье — те же ворота, но с золотым кристаллом. Значка в атласе
  // нет, поэтому вырезаем с карты зоны: берём Febites-Opavun — её карта крупнее прочих
  // элитных (1410x1033), объект там читается заметно лучше. Прозрачность — по яркости.
  const goldGateMap = path.join(ROOT, 'app', 'assets', 'avalon-maps', 'Febites-Opavun.webp');
  if (fs.existsSync(goldGateMap)) {
    const raw = await sharp(goldGateMap).extract({ left: 790, top: 508, width: 66, height: 60 }).png().toBuffer();
    const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      data[i + 3] = lum <= 58 ? 0 : lum >= 128 ? 255 : Math.round(255 * (lum - 58) / 70);
    }
    const cutout = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    fs.writeFileSync(path.join(ICONS, 'dg_gold.webp'),
      await sharp(await normalize(cutout)).sharpen({ sigma: 0.7 }).webp({ quality: 95 }).toBuffer());
    made.push('dg_gold (с карты Febites-Opavun)');
  }

  // манифест ассетов знает только про скачанные иконки — обновляем список
  const list = fs.readdirSync(ICONS).filter(f => f.endsWith('.webp')).sort();
  const manifestPath = path.join(ROOT, 'app', 'assets', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.icons = list.map(f => f.replace('.webp', ''));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  }
  console.log('готово:', made.join(', '));
  console.log('иконок:', list.length);
})();
