// Распознавание скриншотов Albion: тултип портала + текущая зона.
// Пайплайн отлажен на 25 калибровочных скринах (etap0, 110/110 полей).
// Все геометрические константы заданы для 1080p и умножаются на scale = height/1080.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const F = require('./frame');

// libvips по умолчанию держит кэш операций (50 МБ) и поднимает пул потоков по числу ядер.
// Нам это не нужно: картинки одноразовые, а лишние потоки отбирают CPU у игры.
// Замер: 1 поток — тултип 1215 мс/кадр, 2 потока — 1139 мс; дальше прироста нет,
// а память и борьба за CPU с игрой растут.
sharp.cache({ memory: 16, files: 0, items: 50 });
sharp.concurrency(2);

const FULLW_1080 = 195; // полная ширина жёлтой полосы вместимости при 1080p

// Справочники лежат ВНУТРИ app/ (data-static) — иначе упаковщик их не заберёт.
// Генерируются tools/build-zone-data.js и tools/extract-adjacency.js.
const STATIC = path.join(__dirname, '..', 'data-static');
const zones = JSON.parse(fs.readFileSync(path.join(STATIC, 'zone-data.json'), 'utf8'));
const royalAll = JSON.parse(fs.readFileSync(path.join(STATIC, 'royal-zones.json'), 'utf8'));

// В royal-zones.json 77 записей — это внутренние кластеры движка, а не зоны, которые
// игрок увидит в тултипе: коды PSG-0002…PSG-0050, чисто цифровые имена (0302, 1302…),
// «Conquerors' Hall Lvl. N» и dev-тесты. В словаре OCR они только вредят: почти все
// пары имён на расстоянии Левенштейна 1 приходятся именно на цифровой блок.
const ENGINE_NAME = /^(?:PSG-|DNG-|LEGACY-|\d|Conquerors' Hall)|(?:Debug|VegAnim|Tutorial)/i;
const royal = royalAll.filter(z => !ENGINE_NAME.test(z.name));

const DICT = [...zones.map(z => z.name), ...royal.map(z => z.name)];
// Тир зон королевства достаётся из имени файла кластера (tools/add-royal-tiers.js) —
// в дампе мира это единственное место, где он записан. У городов его не показываем:
// в игре у них уровня нет, и «T2 Город» читалось бы как ошибка, а не как факт.
const CITY = /^city/;
const ZONE_INFO = new Map([
  ...zones.map(z => [z.name, { color: 'avalon', tier: z.tier, res: z }]),
  ...royalAll.map(z => [z.name, { color: z.color, tier: CITY.test(z.color || '') ? null : z.tier || null }]),
]);

// ---------- fuzzy ----------
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function fuzzyMatch(raw) {
  const s = raw.toLowerCase().replace(/[^a-zа-я\- ]/gi, '').trim();
  if (s.length < 4) return null;
  let best = null;
  for (const name of DICT) {
    const dist = lev(s, name.toLowerCase());
    const score = dist / Math.max(s.length, name.length);
    if (!best || score < best.score) best = { name, score, raw };
  }
  return best && best.score <= 0.35 ? best : null;
}
// ---------- близнецы имён ----------
// В словаре 31 пара «трёхчастное имя ↔ двухчастное»: Sectun-Et-Tersas ↔ Sectun-Tersas.
// Если OCR потеряет средний слог целиком, fuzzy найдёт короткого близнеца с идеальным
// счётом 0 — и мы уедем не в ту зону. У Settun-Odetum длинных близнецов сразу три
// (-Al-, -Et-, -In-), поэтому «просто выбрать длинного» нельзя.
// Правило: длинное имя выигрывает ТОЛЬКО если какое-то из прочтений реально увидело
// средний слог. Потерять слог OCR может, придумать несуществующий — нет.
const NAME_TWINS = (() => {
  const byLower = new Map(DICT.map(n => [n.toLowerCase(), n]));
  const map = new Map();
  for (const n of DICT) {
    const p = n.split(/[-\s]+/).filter(Boolean);
    if (p.length !== 3) continue;
    const short = byLower.get(`${p[0]}-${p[2]}`.toLowerCase());
    if (!short) continue;
    map.set(short, [...(map.get(short) || []), { mid: p[1].toLowerCase(), name: n }]);
  }
  return map;
})();

const nameTokens = raw => (String(raw || '').match(/[A-Za-zА-Яа-я]+/g) || []).map(t => t.toLowerCase());
const closeEnough = (a, b) => lev(a, b) / Math.max(a.length, b.length) <= 0.34;

// Ищет в прочтениях тройку «первая часть — средний слог — последняя часть».
// raws — все сырые строки OCR, какие есть по этому имени.
function resolveTwin(shortName, raws) {
  const longs = NAME_TWINS.get(shortName);
  if (!longs) return shortName;
  const [first, last] = shortName.split(/[-\s]+/).map(s => s.toLowerCase());
  for (const raw of raws) {
    const toks = nameTokens(raw);
    for (let i = 0; i + 2 < toks.length; i++) {
      if (toks[i + 1].length > 3) continue;               // средние слоги короткие: Al, Et, In, Qi, Si
      if (!closeEnough(toks[i], first) || !closeEnough(toks[i + 2], last)) continue;
      let best = null;
      for (const l of longs) {
        const d = lev(toks[i + 1], l.mid);
        if (d <= 1 && (!best || d < best.d)) best = { d, name: l.name };
      }
      if (best) return best.name;
    }
  }
  return shortName;
}

function fuzzyFromLine(text) {
  const clean = text.replace(/\d{1,2}:\d{2}/g, ' ');
  const tokens = (clean.match(/[A-Za-z][A-Za-z\-]{1,}/g) || []).filter(t => t.length >= 2);
  const cands = new Set();
  for (let i = 0; i < tokens.length; i++)
    for (let len = 1; len <= 3 && i + len <= tokens.length; len++)
      cands.add(tokens.slice(i, i + len).join(' '));
  let best = null;
  for (const c of cands) {
    if (c.length < 4) continue;
    const m = fuzzyMatch(c);
    if (m && (!best || m.score < best.score)) best = m;
    const cl = c.toLowerCase();
    for (const name of DICT) {
      if (name.toLowerCase().includes(cl)) {
        const score = 0.34 - 0.01 * Math.min(c.length, 14);
        if (!best || score < best.score) best = { name, score, raw: c };
      }
    }
  }
  return best;
}

// ---------- поиск жёлтой полосы (якорь тултипа) ----------
// box — необязательная область поиска {x0,y0,x1,y1}: тултип висит у курсора, и
// прочёсывать ради него весь 4К-кадр незачем.
function findBar(frame, scale, box) {
  const { data, width: w, height: h } = frame;
  const ch = 4;
  const ri = frame.bgra ? 2 : 0, bi = frame.bgra ? 0 : 2;   // Electron отдаёт BGRA
  const X0 = box ? Math.max(0, box.x0 | 0) : 0, X1 = box ? Math.min(w, box.x1 | 0) : w;
  const Y0 = box ? Math.max(0, box.y0 | 0) : 0, Y1 = box ? Math.min(h, box.y1 | 0) : h;
  const FULLW = FULLW_1080 * scale;
  // Полоса вместимости состоит из ДВУХ оттенков: яркая заливка занятых мест
  // (255,178,17) и тёмная дорожка под свободными (146,111,48). Раньше якорем была
  // только заливка — и полностью высосанный портал (0/7) приложение не видело вовсе,
  // а 1/7 не дотягивал до порога длины. Замеры взяты с кадров игрока (calibration/c1, c2).
  const isFill = (i) => {
    const r = data[i + ri], g = data[i + 1], b = data[i + bi];
    return r >= 195 && g >= 120 && g <= 210 && b <= 95 && r > g && g > b;
  };
  const isTrack = (i) => {
    const r = data[i + ri], g = data[i + 1], b = data[i + bi];
    return r >= 112 && r < 195 && g >= 78 && g <= 150 && b <= 105
      && r - g >= 18 && g - b >= 18;
  };
  const isGold = (i) => isFill(i) || isTrack(i);
  // Промежутки внутри полосы — значок человечка и цифры «0/7» поверх неё: до ~14 px
  // при 1080p. Мостим их, иначе полоса распадается на куски короче порога.
  const bridge = Math.round(24 * scale);
  // Докуда отрезку позволено расти. Полоса всегда одной длины (FULLW_1080), правее к ней
  // вплотную примыкает чип «+ 01:14» того же оттенка — на них и рассчитан запас.
  const MAX_SPAN = 330 * scale;
  const rows = [];
  for (let y = Y0; y < Y1; y++) {
    const base = y * w * ch;
    let segs = [], start = -1, last = -1, cnt = 0, f0 = -1, f1 = -1;
    // fill меряем ПРОТЯЖЁННОСТЬЮ яркой части, а не числом ярких пикселей: поверх полосы
    // нарисованы значок и цифры «7/7», и счётчик занижал бы заполненность на их ширину.
    const seg = () => ({ y, minX: start, maxX: last, cnt, fill: f0 < 0 ? 0 : f1 - f0 + 1 });
    for (let x = X0; x < X1; x++) {
      const i = base + x * ch;
      if (isGold(i)) {
        // Отрезок РЕЖЕТСЯ по потолку длины, а не признаётся негодным целиком, и это
        // главное здесь. Тултип может висеть над миникартой, а её песчаная текстура
        // попадает ровно в тот же коричнево-золотой диапазон, что и тёмная дорожка
        // полосы. Промежутки между ними мельче мостика — и мостик, задуманный склеивать
        // цифры поверх полосы, склеивал полосу с картой. Склейка перерастала потолок,
        // отрезок выбрасывался, и от тултипа не оставалось ни одного кандидата: портал
        // над картой не читался никогда, а над тёмным фоном читался всегда.
        // Начало отрезка при этом — настоящий левый край полосы (слева от неё подложка
        // тултипа), поэтому обрезанный по потолку кусок и есть та самая полоса.
        if (start >= 0 && (x - last > bridge || x - start >= MAX_SPAN)) {
          segs.push(seg()); start = x; cnt = 0; f0 = f1 = -1;
        } else if (start < 0) { start = x; cnt = 0; f0 = f1 = -1; }
        last = x; cnt++;
        if (isFill(i)) { if (f0 < 0) f0 = x; f1 = x; }
      }
    }
    if (start >= 0) segs.push(seg());
    for (const s of segs) {
      const span = s.maxX - s.minX + 1;
      // Полная полоса — 184–195 px при 1080p и НЕ ЗАВИСИТ от вместимости: пустой портал
      // рисует ту же полосу, только целиком тёмной. Поэтому порог длины теперь высокий
      // (150 px) — это сильный фильтр от случайной рыжей текстуры, и при этом он
      // ничего не отсекает по заполненности. Верхняя граница с запасом: правее полосы
      // вплотную стоит чип «+ 01:14» того же оттенка, и он к ней примыкает.
      if (s.cnt >= 100 * scale && span >= 150 * scale && span <= 330 * scale && s.cnt / span >= 0.7) rows.push(s);
    }
  }
  const groups = [];
  for (const r of rows) {
    let joined = false;
    for (const g of groups) {
      const lastRow = g.rows[g.rows.length - 1];
      if (r.y - lastRow.y >= 1 && r.y - lastRow.y <= 2 && (Math.abs(r.minX - g.minX0) <= 6 || Math.abs(r.maxX - g.maxX0) <= 6)) { g.rows.push(r); joined = true; break; }
    }
    if (!joined) groups.push({ minX0: r.minX, maxX0: r.maxX, rows: [r] });
  }
  const luma = (x, y) => { const i = (y * w + x) * ch; return 0.3 * data[i + ri] + 0.6 * data[i + 1] + 0.1 * data[i + bi]; };
  const avgLuma = (x0, y0, x1, y1) => {
    let s = 0, n = 0;
    for (let y = Math.max(0, y0) | 0; y < Math.min(h, y1); y += 2)
      for (let x = Math.max(0, x0) | 0; x < Math.min(w, x1); x += 4) { s += luma(x, y); n++; }
    return n ? s / n : 255;
  };
  let best = null;
  for (const g of groups) {
    const hh = g.rows[g.rows.length - 1].y - g.rows[0].y + 1;
    if (hh < 8 * scale || hh > 22 * scale) continue;
    const xs = g.rows.map(r => r.minX).sort((a, b) => a - b);
    const bx = xs[Math.floor(xs.length / 2)];
    const spans = g.rows.map(r => r.maxX - r.minX + 1).sort((a, b) => a - b);
    const span = spans[Math.floor(spans.length / 2)];
    // Длина ЯРКОЙ части — единственное, что говорит о занятых местах: сама полоса
    // всегда одной длины. Берём медиану по строкам, чтобы цифры поверх полосы не врали.
    const fills = g.rows.map(r => r.fill).sort((a, b) => a - b);
    const fill = fills[Math.floor(fills.length / 2)];
    const by = g.rows[0].y;
    const darkAbove = avgLuma(bx + 20 * scale, by - 30 * scale, bx + FULLW - 20 * scale, by - 12 * scale);
    const darkLeft = avgLuma(bx - 14 * scale, by - 2, bx - 5 * scale, by + hh + 2);
    if (darkAbove > 150) continue;
    const score = darkAbove + 0.5 * darkLeft;
    if (!best || score < best.score) best = { bx, by, bh: hh, span, fill, score };
  }
  return best;
}

// ---------- OCR ----------
let worker = null;
async function init() {
  if (worker) return;
  // rus/eng.traineddata рядом с приложением — это КЭШ tesseract.js: сначала он смотрит
  // в cachePath, и только не найдя там, идёт качать ~10 МБ с CDN. По умолчанию cachePath —
  // ТЕКУЩИЙ каталог процесса, а при запуске из ярлыка Windows это System32: словари не
  // находятся, и первый старт у друга висит на загрузке (без сети — вообще не стартует).
  // Прибиваем кэш к каталогу приложения. langPath не трогаем: пусть CDN остаётся запасным
  // путём, если файлов рядом нет. При упаковке в asar каталог вынести в asarUnpack.
  // В собранном приложении код лежит внутри app.asar, а tesseract открывает словари
  // как обычные файлы — путь внутрь архива ему не годится. Поэтому rus/eng.traineddata
  // кладутся рядом с архивом (extraResources), и кэш смотрит туда.
  const packed = /app\.asar/.test(__dirname);
  const cachePath = packed && process.resourcesPath ? process.resourcesPath : path.join(__dirname, '..');
  worker = await createWorker(['rus', 'eng'], undefined, { cachePath });
  // адаптивный классификатор дообучается по ходу сессии → недетерминизм; выключаем
  await worker.setParameters({ classify_enable_learning: '0', classify_enable_adaptive_matcher: '0' });
}
async function shutdown() { if (worker) { await worker.terminate(); worker = null; } }

async function ocr(buf, opts = {}) {
  await worker.setParameters({
    tessedit_char_whitelist: opts.whitelist || '',
    tessedit_pageseg_mode: String(opts.psm || 7),
  });
  const { data } = await worker.recognize(buf);
  return data.text.replace(/\n+/g, ' ').trim();
}

// Кроп берём прямо из сырого кадра: копируем только нужный прямоугольник,
// без распаковки всего экрана (на 4К это 33 МБ на каждый вызов).
async function crop(frame, left, top, width, height, { invert = true, scale = 3, thresh = null, clahe = false } = {}) {
  const r = F.sharpRegion(frame, left, top, width, height);
  if (!r) return null;
  let p = r.img
    .resize(r.width * scale, r.height * scale, { kernel: 'lanczos3' })
    .grayscale();
  p = clahe ? p.clahe({ width: 48, height: 24 }) : p.normalise();
  if (thresh !== null) p = p.threshold(thresh);
  if (invert) p = p.negate();
  return p.png().toBuffer();
}

const LAT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- ';
const WL_DUR = '0123456789чмсЧМС ';

// ---------- парсеры ----------
function normDigits(text) {
  return text
    .replace(/(?<=\d)[ОOоo]|[ОOоo](?=\d)/g, '0')
    .replace(/(?<=\d)S|S(?=\d)/g, '5')
    .replace(/(?<=\d)[lI]|[lI](?=\d)/g, '1')
    .replace(/(?<=\d[\s.]?)[YУyu](?=[\s.]?\d)/g, 'ч');
}
// Потолок часов у портала. Дыра, из-за которой он появился: у формы «X ч Y м» верхней
// границы не было вовсе, и прочтение «24 ч 24 м» проходило как есть — при настоящих
// 2 ч 24 м. Лишняя цифра приклеивается к часам слева, из значка песочных часов и хвоста
// надписи «Закроется через». Самый долгий портал в нашем корпусе — 19 ч 53 м, игрок
// называет ~18 ч; 21 — с запасом выше правды и ниже той самой «24». Отвергнутое
// прочтение не подставляется молча: голосование берёт другой вариант, а если верного
// нет ни одного, таймер остаётся неизвестным — это честнее неверного числа.
const MAX_HOURS = 21;

function parseDur(text) {
  text = normDigits(text);
  let m;
  if ((m = text.match(/(\d+)\s*[чh]\s*(\d+)\s*[мm]/i)) && +m[2] < 60) {
    // Форма «часы и минуты» распознана, но часов столько не бывает — значит к числу
    // приклеилась лишняя цифра. Возвращаем НИЧЕГО, а не «24 минуты»: провалиться на
    // правило поменьше значило бы подсунуть другое неверное число вместо этого.
    if (+m[1] > MAX_HOURS) return null;
    return { sec: +m[1] * 3600 + +m[2] * 60, quality: 2 };
  }
  if ((m = text.match(/(\d+)\s*[мm]\s*(\d+)\s*[сcs]/i)) && +m[2] < 60 && +m[1] < 60) return { sec: +m[1] * 60 + +m[2], quality: 2 };
  if ((m = text.match(/(\d+)\s*[чh](?![\wа-я])/i)) && +m[1] <= MAX_HOURS) return { sec: +m[1] * 3600, quality: 1 };
  if ((m = text.match(/(\d+)\s*[мm](?![\wа-я])/i)) && +m[1] < 60) return { sec: +m[1] * 60, quality: 1 };
  if ((m = text.match(/(\d+)\s*[сc](?![\wа-я])/i)) && +m[1] < 60) return { sec: +m[1], quality: 1 };
  if ((m = text.match(/(?<!\d)(\d)4(\d{2})(?!\d)\s*[мm]/i)) && +m[2] < 60) return { sec: +m[1] * 3600 + +m[2] * 60, quality: 1 };
  if ((m = text.match(/(?<!\d)(\d)(\d{2})(?!\d)\s*[мm]/i)) && +m[2] < 60) return { sec: +m[1] * 3600 + +m[2] * 60, quality: 1 };
  return null;
}
function allDurations(text) {
  text = normDigits(text);
  const out = [];
  const re = /(\d+)\s*[чh]\s*(\d+)\s*[мm]|(\d+)\s*[мm]\s*(\d+)\s*[сcs]|(\d+)\s*[чh](?![\wа-я])|(\d+)\s*[мm](?![\wа-я])|(\d+)\s*[сc](?![\wа-я])/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) { if (+m[2] < 60 && +m[1] <= MAX_HOURS) out.push({ sec: +m[1] * 3600 + +m[2] * 60, q: 2 }); }
    else if (m[3] !== undefined) { if (+m[3] < 60 && +m[4] < 60) out.push({ sec: +m[3] * 60 + +m[4], q: 2 }); }
    else if (m[5] !== undefined) { if (+m[5] <= MAX_HOURS) out.push({ sec: +m[5] * 3600, q: 1 }); }
    else if (m[6] !== undefined) { if (+m[6] < 60) out.push({ sec: +m[6] * 60, q: 1 }); }
    else { if (+m[7] < 60) out.push({ sec: +m[7], q: 1 }); }
  }
  if (!out.length) {
    let m2;
    if ((m2 = text.match(/(?<!\d)(\d)4(\d{2})(?!\d)\s*[мm]/i)) && +m2[2] < 60) out.push({ sec: +m2[1] * 3600 + +m2[2] * 60, q: 1 });
    else if ((m2 = text.match(/(?<!\d)(\d)(\d{2})(?!\d)\s*[мm]/i)) && +m2[2] < 60) out.push({ sec: +m2[1] * 3600 + +m2[2] * 60, q: 1 });
  }
  return out;
}
// Два прочтения одного и того же тултипа разошлись. Одно ли это число и КОТОРОЕ верно?
// → 'lo' (верно младшее), 'hi' (верно старшее) или null (разные числа, не сливаем).
//
// Живёт отдельной функцией, потому что оба правила ниже родились из настоящих ошибок
// в карте игрока, и проверять их надо строками, а не прогоном OCR на кадрах.
function sameNumber(loSec, hiSec) {
  if (!(loSec < hiSec)) return null;
  const d = hiSec - loSec;
  const eq = (u) => Math.floor(loSec / u) % 60 === Math.floor(hiSec / u) % 60;
  const sameH = Math.floor(loSec / 3600) === Math.floor(hiSec / 3600);

  // УДВОЕННАЯ «ч». Шрифт Albion рисует «ч» почти как «4», и tesseract читает ОДИН глиф
  // дважды — сперва цифрой, потом буквой. Из «1 ч 59 м» выходит «14ч59м», из «2 ч 20 м» —
  // «24ч20м» (реже «9» вместо «4»). Минуты и секунды при этом целы, по ним и опознаём:
  // старшие часы равны младшим ×10 + 4 или 9 при том же остатке — верны МЛАДШИЕ.
  // Предел MAX_HOURS этот случай не ловил: 14 меньше 21, и одночасовые порталы молча
  // уезжали в карту четырнадцатичасовыми — ровно на это игрок и пожаловался.
  // Правило нарочно узкое: работает, только когда ОБА прочтения есть в одном голосовании.
  // Настоящие 14 и 19 часов от него не страдают — проверено на 19 ч 53 м, 15 ч 59 м
  // и 10 ч 02 м под тем же ухудшением контраста, на котором ломался разбор.
  const loH = Math.floor(loSec / 3600), hiH = Math.floor(hiSec / 3600);
  if (loSec % 3600 === hiSec % 3600 && loH >= 1 && (hiH === loH * 10 + 4 || hiH === loH * 10 + 9)) return 'lo';

  // ПОТЕРЯННАЯ ЕДИНИЦА: прочтения отличаются ровно на ведущую «1» (7ч44м против 17ч44м) —
  // OCR иногда съедает тонкую единицу. Верно СТАРШЕЕ: обратной ошибки, дорисовать
  // несуществующую «1», на этом шрифте не встречается.
  if ((d === 36000 && eq(60) && eq(1))                    // часы: 7 → 17
    || (d === 600 && sameH && eq(1))                      // минуты
    || (d === 10 && eq(60) && sameH)) return 'hi';        // секунды
  return null;
}

function parseBottom(text) {
  const res = { canuse: null, closes: null, quality: 0, marker: false };
  const low = normDigits(text).toLowerCase();
  const iClose = low.search(/з[аоa]кро|closes|close/);
  if (iClose >= 0) {
    const d = parseDur(text.slice(iClose));
    if (d) { res.closes = d.sec; res.quality = d.quality; res.marker = true; }
    const before = text.slice(0, iClose);
    if (/использ|usable|use/i.test(before)) { const c = parseDur(before); if (c) res.canuse = c.sec; }
    if (res.closes !== null) return res;
  }
  const ds = allDurations(text);
  // Качество берём у ТОЙ длительности, которую возвращаем, а не минимум по всем.
  // Иначе фантомное число, слепленное whitelist-ом из слова «через» («3 ч»), роняло
  // качество верного прочтения до 1, и оно вылетало из финального круга голосования —
  // а побеждало соседнее, неверное. Замер: на сетке яркости было 1 ошибка из 13, стало 0.
  if (ds.length >= 2) { res.canuse = ds[0].sec; res.closes = ds[ds.length - 1].sec; res.quality = ds[ds.length - 1].q; res.marker = false; }
  else if (ds.length === 1) { res.closes = ds[0].sec; res.quality = ds[0].q; }
  return res;
}

// ---------- распознавание текущей зоны ----------
// кадр (или PNG-буфер) → { zone, color, source: 'bar'|'loading', raw } | null
// fast=true: один быстрый OCR-проход; эскалация в полный перебор только если он не дал совпадения
// screenHeight — высота ЭКРАНА, если на вход дали не весь кадр, а вырезанный кусок:
// геометрические константы заданы для 1080p и масштабируются от высоты экрана, а не
// от высоты куска. Приложение сейчас всегда шлёт кадр целиком, но распознавание по
// полоске рабочее и проверяется тестом — пригодится, если решим резать до OCR.
// Где на экране висит баннер экрана загрузки: полоса по центру, чуть выше низа.
// Читается ТОЛЬКО из кадра целиком, а целый кадр приложение снимает лишь запасным путём
// (когда отвалился быстрый захват прямоугольника). В обычной работе баннер не смотрится
// вовсе: ради него пришлось бы делать третий снимок, а выигрыш — пара секунд на переходе,
// которые всё равно перекрывает ожидание зоны в lib/origin.js.
const BANNER_BOX = { cx: 230, up: 180, w: 460, h: 70 };   // в пикселях 1080p
function bannerRegion(width, height, s) {
  return {
    left: width / 2 - BANNER_BOX.cx * s, top: height - BANNER_BOX.up * s,
    width: BANNER_BOX.w * s, height: BANNER_BOX.h * s,
  };
}

async function recognizeZone(input, { fast = false, zoneBarRegion = null, screenHeight = 0 } = {}) {
  const frame = await F.toFrame(input);
  const meta = { width: frame.width, height: frame.height };
  const s = (screenHeight || meta.height) / 1080;

  async function bestLine(left, top, w2, h2, whitelist) {
    const variants = fast
      ? [[null, 7], [135, 7]]
      : [[null, 7], [120, 7], [135, 7], [150, 7], [100, 7], [null, 6], [null, 7, true], [135, 7, true]];
    let bestM = null, firstRaw = '';
    const raws = [];
    for (const [thresh, psm, clahe] of variants) {
      const buf = await crop(frame, left, top, w2, h2, { invert: false, thresh, clahe });
      if (!buf) continue;
      const t = await ocr(buf, { whitelist, psm });
      raws.push(t);
      if (!firstRaw) firstRaw = t;
      const m = fuzzyFromLine(t);
      if (m && (!bestM || m.score < bestM.score)) { bestM = m; bestM.rawLine = t; }
      // ранний выход — только когда имя однозначное: у короткого близнеца идеальный счёт
      // ещё ничего не доказывает, средний слог мог просто не прочитаться
      if (bestM && bestM.score < 0.1 && !NAME_TWINS.has(bestM.name)) break;
    }
    if (bestM) {
      const resolved = resolveTwin(bestM.name, raws);
      if (resolved !== bestM.name) bestM = { ...bestM, name: resolved };
    }
    return { match: bestM, raw: bestM?.rawLine || firstRaw };
  }

  // плашка текущей зоны: по умолчанию низ-право; кастомный регион — из настроек
  const r = zoneBarRegion || { left: meta.width - 400 * s, top: meta.height - 48 * s, width: 380 * s, height: 30 * s };
  const z = await bestLine(r.left, r.top, r.width, r.height, LAT + '0123456789:');
  if (z.match) return { zone: z.match.name, ...zoneInfo(z.match.name), source: 'bar', raw: z.raw };

  // Баннер экрана загрузки (центр-низ) — только если нам дали кадр целиком.
  // На вырезанной полоске зоны его физически нет, и искать нечего.
  if (meta.height >= 400 * s) {
    const b = bannerRegion(meta.width, meta.height, s);
    const l = await bestLine(b.left, b.top, b.width, b.height, LAT);
    if (l.match) return { zone: l.match.name, ...zoneInfo(l.match.name), source: 'loading', raw: l.raw };
  }
  return null;
}

function zoneInfo(name) {
  const i = ZONE_INFO.get(name) || {};
  return { color: i.color || null, tier: i.tier || null, activities: i.res || null };
}

// ---------- распознавание тултипа портала ----------
// кадр (или PNG-буфер) → { name, color, tier, activities, capNum, capMax, capMaxKnown, closes, raw } | null
// near — точка курсора: тултип всплывает рядом с ней, и якорь ищется сначала в этом
// квадрате. На 4К это 1.4 млн пикселей вместо 8.3 млн; не нашли — идём по всему кадру.
// screenHeight — как в recognizeZone: если на вход дали квадрат вокруг курсора,
// масштаб констант считаем от высоты ЭКРАНА, а не от высоты квадрата.
async function recognizeTooltip(input, { near = null, nearRadius = 620, screenHeight = 0 } = {}) {
  const frame = await F.toFrame(input);
  const meta = { width: frame.width, height: frame.height };
  const s = (screenHeight || meta.height) / 1080;
  const FULLW = FULLW_1080 * s;
  const R = nearRadius * s;
  let bar = near
    ? findBar(frame, s, { x0: near.x - R, y0: near.y - R, x1: near.x + R, y1: near.y + R })
    : null;
  if (!bar) bar = findBar(frame, s);
  if (!bar) return null;
  const { bx, by, bh, fill } = bar;

  const nameRegion = [bx - 15 * s, by - 28 * s, 310 * s, 24 * s];
  const nameText = await ocr(await crop(frame, ...nameRegion), { whitelist: LAT, psm: 7 });
  let nm = fuzzyMatch(nameText);
  if (!nm) return null; // полоса без читаемого имени — не тултип портала
  // Совпал короткий близнец — доснимаем имя другими предобработками: вдруг средний
  // слог всё-таки читается. Лишний OCR тратим только на 31 имя из 958.
  if (NAME_TWINS.has(nm.name)) {
    const raws = [nameText];
    for (const opts of [{ thresh: 150 }, { scale: 4 }, { invert: false }]) {
      raws.push(await ocr(await crop(frame, ...nameRegion, opts), { whitelist: LAT, psm: 7 }));
    }
    const resolved = resolveTwin(nm.name, raws);
    if (resolved !== nm.name) nm = { ...nm, name: resolved, twinRaws: raws };
  }

  // ---------- вместимость портала ----------
  // Главное здесь — ЗНАМЕНАТЕЛЬ: сколько человек портал пропускает всего, 7 или 20.
  // Это свойство самого портала, оно не меняется, и по нему игрок решает, вести ли туда
  // группу. Числитель (сколько мест свободно СЕЙЧАС) устаревает за минуты, поэтому он
  // второстепенный: если прочитать не удалось — так и пишем «неизвестно», а не выдумываем.
  //
  // Поэтому знаменатель не берём из первого попавшегося прочтения, а голосуем: перебираем
  // области и предобработки (в том числе ОБЕ полярности — на полной полосе цифры тёмные
  // на золоте, на полупустой светлые на тёмном) и считаем, какой знаменатель встретился чаще.
  const VALID_DEN = new Set([7, 20]);
  const CAP_REGIONS = [
    [bx + FULLW / 2 - 45 * s, 90 * s],   // по центру полосы — там текст стоит обычно
    [bx - 4 * s, FULLW + 8 * s],         // вся полоса целиком
    [bx + FULLW / 2 - 62 * s, 120 * s],  // шире и левее: у /20 текст длиннее и смещён
  ];
  const CAP_PREP = [
    { invert: false, thresh: null }, { invert: true, thresh: null },
    { invert: false, thresh: 140 }, { invert: true, thresh: 140 },
    { invert: false, thresh: 100 },
  ];
  const capReads = [];
  const denVotes = new Map();
  let capText = '';
  capLoop:
  for (const region of CAP_REGIONS) {
    for (const prep of CAP_PREP) {
      const buf = await crop(frame, region[0], by - 4 * s, region[1], bh + 8 * s, { ...prep, scale: 4 });
      const t = await ocr(buf, { whitelist: '0123456789/', psm: 7 });
      if (!t) continue;
      capReads.push(t);
      if (!capText && t.replace(/\D/g, '').length >= 2) capText = t;
      const m = t.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) continue;
      capText = t;
      const den = +m[2];
      if (!VALID_DEN.has(den)) continue;
      denVotes.set(den, (denVotes.get(den) || 0) + 1);
      // два независимых прочтения с одним знаменателем — дальше можно не тратить время
      if (denVotes.get(den) >= 2) break capLoop;
    }
  }

  // Слэш OCR теряет постоянно: «7/7» приходит как «877», «807», «277». Числитель из такого
  // не вытащить (лишняя цифра слева, а слэш иногда читается как 0), но РАЗМЕР вытащить можно:
  // он всегда в конце строки и равен 7 или 20. Мягкий разбор идёт только если строгий
  // (со слэшем) не дал ни одного голоса — и даёт голос лишь знаменателю.
  if (!denVotes.size) {
    for (const t of capReads) {
      const digits = t.replace(/\D/g, '');
      if (digits.length < 2) continue;
      const den = digits.endsWith('20') ? 20 : digits.endsWith('7') ? 7 : null;
      if (den) denVotes.set(den, (denVotes.get(den) || 0) + 1);
    }
  }

  let capMax = null, capNum = null, capNumApprox = false;
  if (denVotes.size) {
    capMax = [...denVotes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    // числитель берём из того прочтения, где знаменатель совпал с победившим
    for (const t of capReads) {
      const m = t.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m || +m[2] !== capMax) continue;
      let num = m[1];
      // OCR любит приклеить лишнюю цифру слева («86/7» вместо «6/7») — снимаем, пока не влезет
      while (num.length > 1 && +num > capMax) num = num.slice(1);
      if (+num <= capMax) { capNum = +num; break; }
    }
  }
  // Числитель не прочитался — оцениваем по длине заливки. Это приблизительно (левый край
  // полосы «съедается», см. findBar), поэтому помечаем и в интерфейсе показываем мягче.
  if (capNum == null && capMax != null) {
    // цифры не прочитались — прикидываем занятые места по длине ЯРКОЙ части полосы
    capNum = Math.max(0, Math.min(capMax, Math.round(fill / FULLW * capMax)));
    capNumApprox = true;
  }
  // Размер портала не прочитался вообще: НЕ подставляем 7 молча — пусть слой карты
  // возьмёт ранее прочитанный размер этого же портала (store хранит его «липко»).
  const capMaxKnown = capMax != null;

  // Чип перезарядки («через сколько откроется») НЕ читаем: игроку эта информация не нужна,
  // а стоила она трёх лишних проходов OCR на каждое нажатие хоткея.

  // нижняя строка: голосование между вариантами предобработки.
  // Помимо полного кропа добавлены «правые» кропы — только блок жирных цифр «17 ч 44 м»:
  // без длинного лейбла tesseract реже теряет тонкую «1» в начале числа.
  const votes = [];
  let botText = '';
  const BOT_VARIANTS = [
    { psm: 7 },
    { psm: 6 },
    { psm: 7, thresh: 150 },
    { psm: 7, thresh: 150, whitelist: WL_DUR },
    { psm: 7, whitelist: WL_DUR },
    { psm: 7, whitelist: WL_DUR, right: true },
    { psm: 7, thresh: 150, whitelist: WL_DUR, right: true },
    { psm: 7, thresh: 120, whitelist: WL_DUR, right: true },
  ];
  for (const opts of BOT_VARIANTS) {
    const left = opts.right ? bx + 110 * s : bx - 20 * s;
    const width = opts.right ? 210 * s : 320 * s;
    const buf = await crop(frame, left, by + bh + 2, width, 28 * s, { scale: 4, thresh: opts.thresh ?? null });
    const t = await ocr(buf, opts);
    if (!botText) botText = t;
    const p = parseBottom(t);
    p.weight = 1 + (opts.whitelist ? 1 : 0) + (opts.thresh ? 1 : 0);
    p.fullCrop = !opts.right;
    if (p.quality > 0) { votes.push(p); botText = t; }
    // перф-стоп: три согласных полных парса — дальше можно не жечь OCR
    if (votes.filter(v => v.quality === 2 && v.closes === p.closes).length >= 3) break;
  }
  let closes = null;
  if (votes.length) {
    const qMax = Math.max(...votes.map(v => v.quality));
    const top = votes.filter(v => v.quality === qMax);
    const groups = new Map();
    for (let i = 0; i < top.length; i++) {
      const v = top[i];
      const g = groups.get(v.closes) || { closes: v.closes, count: 0, marker: false, weight: 0, first: i };
      g.count++; g.marker = g.marker || v.marker; g.weight += v.weight;
      groups.set(v.closes, g);
    }
    // Слияние «потерянной единицы»: если два прочтения отличаются ровно на ведущую «1»
    // в часах/минутах/секундах (7ч44м против 17ч44м), это одно и то же число — OCR
    // иногда съедает тонкую «1». Побеждает вариант С единицей: обратная ошибка
    // (дорисовать несуществующую «1») на этом шрифте не встречается.
    const glist = [...groups.values()];
    for (const g of glist) g.values = new Set([g.closes]); // все прочтения, слитые в группу
    for (const a of glist) {
      for (const b of glist) {
        if (a === b || a.dead || b.dead || a.closes === b.closes) continue;
        const lo = a.closes < b.closes ? a : b;
        const hi = a.closes < b.closes ? b : a;
        const win = sameNumber(lo.closes, hi.closes);
        if (!win) continue;
        const [keep, drop] = win === 'lo' ? [lo, hi] : [hi, lo];
        keep.count += drop.count; keep.weight += drop.weight;
        keep.marker = keep.marker || drop.marker;
        keep.first = Math.min(keep.first, drop.first);
        for (const v of drop.values) keep.values.add(v);
        drop.dead = true;
      }
    }
    const bestG = glist.filter(g => !g.dead).sort((a, b) =>
      b.count - a.count || (b.marker - a.marker) || b.weight - a.weight || a.first - b.first)[0];
    closes = bestG.closes;
  }

  return {
    name: nm.name, ...zoneInfo(nm.name),
    capNum, capMax, capMaxKnown, capNumApprox, closes,
    raw: { name: nameText, cap: capText, capReads, bottom: botText, bar },
  };
}

module.exports = {
  init, shutdown, recognizeZone, recognizeTooltip, zoneInfo, DICT, ZONE_INFO, NAME_TWINS, resolveTwin,
  _internal: { findBar, crop, fuzzyMatch, parseDur, allDurations, sameNumber, MAX_HOURS },   // для тестов и отладки пайплайна
};
