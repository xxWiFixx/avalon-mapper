// Распознавание скриншотов Albion: тултип портала + текущая зона.
// Регрессии проверяются на калибровочных кадрах и дополнительных кадрах разных UI.
// 1080p задаёт начальный масштаб; при несовпадении UI подбираем его по полосе тултипа.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const ocrWorker = require('./ocr-worker');
const F = require('./frame');
const { capacityImage, exactCapacity } = require('./capacity-image');
const { createNameMatcher } = require('./recognition-confidence');
const { parseDur, allDurations, sameNumber, MAX_HOURS } = require('./portal-duration');
const { recognizeTimer } = require('./portal-timer');
const { createProfiles } = require('./recognition-profiles');
const profiles = createProfiles();

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
const nameMatcher = createNameMatcher(DICT);
// Тир зон королевства достаётся из имени файла кластера (tools/add-royal-tiers.js) —
// в дампе мира это единственное место, где он записан. У городов его не показываем:
// в игре у них уровня нет, и «T2 Город» читалось бы как ошибка, а не как факт.
const CITY = /^city/;
const ZONE_INFO = new Map([
  ...zones.map(z => [z.name, { color: 'avalon', tier: z.tier, res: z }]),
  // Качество (Q1…Q6) есть только у чёрных зон — так и в игре, и так же в справочнике:
  // у остальных поля просто нет (tools/add-royal-tiers.js).
  ...royalAll.map(z => [z.name, {
    color: z.color,
    tier: CITY.test(z.color || '') ? null : z.tier || null,
    quality: z.quality || null,
  }]),
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
  return nameMatcher.rank(raw).match;
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
    if (m && (!best || m.score < best.score || (m.score === best.score && m.name.length > best.name.length))) best = m;
    const cl = c.toLowerCase();
    // A lone Market/Bank matches many cities. Never choose the first dictionary
    // entry (Caerleon Market) when OCR only read the shared suffix.
    const partial = DICT.filter(name => name.toLowerCase().includes(cl));
    if (partial.length === 1 && cl.length / partial[0].length >= 0.65) {
      const name = partial[0], score = 0.34 - 0.01 * Math.min(c.length, 14);
      if (!best || score < best.score) best = { name, score, raw: c };
    }
  }
  return best;
}

// ---------- поиск жёлтой полосы (якорь тултипа) ----------
// box — необязательная область поиска {x0,y0,x1,y1}: тултип висит у курсора, и
// прочёсывать ради него весь 4К-кадр незачем.
function findBarCands(frame, scale, box) {
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
  // Диапазон дорожки НАМЕРЕННО широкий. Сузить его до константы (у одного игрока это
  // rgb(144,109,46)) нельзя: на кадрах другого та же дорожка — rgb(154,102,70), разница
  // по синему в 24 единицы. У игроков разные настройки картинки, и жёсткая константа
  // читалась бы только у автора замера.
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
    let segs = [], start = -1, last = -1, cnt = 0, f0 = -1, f1 = -1, cntAtF0 = 0;
    // fill меряем ПРОТЯЖЁННОСТЬЮ яркой части, а не числом ярких пикселей: поверх полосы
    // нарисованы значок и цифры «7/7», и счётчик занижал бы заполненность на их ширину.
    //
    // ЛЕВЫЙ КРАЙ БЕРЁМ ПО ЗАЛИВКЕ, если она есть. Шкала вместимости заполняется слева
    // направо, поэтому заливка начинается ровно на краю полосы, а её цвет rgb(255,178,18)
    // настолько особый, что текстура мира в него не попадает. Начало же самого отрезка
    // доверия не заслуживает: тултип может лежать на карте зоны, чей песок проходит как
    // дорожка, — отрезок тогда начинается далеко левее полосы, bx уезжает вместе с ним,
    // и имя читается мимо тултипа. Портал над картой не распознавался вовсе именно так.
    // Пиксели левее заливки выкидываем и из счётчика, иначе плотность окажется больше
    // единицы и порог 0.7 перестанет что-либо значить.
    const seg = () => (f0 >= 0
      ? { y, minX: f0, maxX: last, cnt: cnt - cntAtF0 + 1, fill: f1 - f0 + 1 }
      : { y, minX: start, maxX: last, cnt, fill: 0 });
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
        // Растим от ЛЕВОГО КРАЯ ПОЛОСЫ, а не от начала отрезка: если заливка уже
        // встретилась, она и есть край, и потолок длины меряется от неё.
        const from = f0 >= 0 ? f0 : start;
        if (start >= 0 && (x - last > bridge || x - from >= MAX_SPAN)) {
          segs.push(seg()); start = x; cnt = 0; f0 = f1 = -1; cntAtF0 = 0;
        } else if (start < 0) { start = x; cnt = 0; f0 = f1 = -1; cntAtF0 = 0; }
        last = x; cnt++;
        if (isFill(i)) { if (f0 < 0) { f0 = x; cntAtF0 = cnt; } f1 = x; }
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
  // Края сравниваются с ПЕРВОЙ строкой группы, и это осознанно. Пробовали с последней —
  // группа получает право «идти» вслед за плавным дрейфом краёв, а дрейфует не только
  // сглаженный край полосы (399 → 390 за десять строк на кадре игрока), но и песок
  // миникарты с той же скоростью 1–2px на строку: на калибровочном c4 обрезки текстуры
  // склеивались в кандидата проходной высоты и перебивали настоящую полосу. Цена якоря
  // по первой строке — группа иногда теряет крайнюю строку (см. порог высоты ниже).
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
  const cands = [];
  for (const g of groups) {
    const hh = g.rows[g.rows.length - 1].y - g.rows[0].y + 1;
    // Нижний порог 7, а не 8. Группа стабильно короче полосы на экране: верх и низ полосы
    // затемнены градиентом и в золотой диапазон не попадают, а крайнюю строку вдобавок
    // теряет склейка выше (края полосы дрейфуют от сглаживания, а якорь у группы — первая
    // строка). С порогом 8 запаса не оставалось: на кадре игрока при масштабе 1.33 группа
    // вышла высотой 10.0 при минимуме 10.67 — и тултип не читался, пока курсор не сдвинут
    // на волосок. Ниже 7 опускаться нельзя без перепроверки c4: обрезки песка миникарты
    // там высотой 4–5 при масштабе 1.
    if (hh < 7 * scale || hh > 22 * scale) continue;
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
    // Заливка — самый сильный признак настоящей полосы: её цвет rgb(255,178,18) в
    // текстурах мира не встречается (см. isFill), а тени и песок проходят фильтры на
    // одной тёмной дорожке, с fill=0. Кандидат с заливкой правдоподобной длины уходит
    // в начало очереди: на кадре игрока в золотой траве кандидатов было 50, настоящая
    // полоса — десятой по темноте, и до неё перебор не доходил. Пустой портал (0/7)
    // заливки не имеет и преимущества не получает — ему остаётся очередь по темноте.
    // Потолок 1.15: длиннее полосы заливка не бывает, ярко-жёлтая простыня длиннее —
    // это значки на миникарте, слившиеся в строку.
    const fillPlausible = fill >= 0.15 * FULLW && fill <= 1.15 * FULLW;
    cands.push({ bx, by, bh: hh, span, fill, score, rank: score - (fillPlausible ? 60 : 0) });
  }
  return cands.sort((a, b) => a.rank - b.rank);
}

// Лучший кандидат — для тестов и мест, где нужен ровно один.
function findBar(frame, scale, box) {
  return findBarCands(frame, scale, box)[0] || null;
}

// ---------- OCR ----------
const engine = ocrWorker.create({ factory: async () => {
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
  // Request rejection is handled by the guard; do not also throw in Tesseract's
  // message callback (that would bypass the OCR queue's error handler).
  return createWorker(['rus', 'eng'], undefined, { cachePath, errorHandler: () => {} });
} });
const init = () => engine.init();
const shutdown = () => { profiles.clear(); return engine.shutdown(); };

async function ocr(buf, opts = {}) {
  if (!buf) return '';
  const { data } = await engine.run(buf, {
    classify_enable_learning: '0', classify_enable_adaptive_matcher: '0',
    tessedit_char_whitelist: opts.whitelist || '',
    tessedit_pageseg_mode: String(opts.psm || 7),
  });
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

// ---------- распознавание текущей зоны ----------
// кадр (или PNG-буфер) → { zone, color, source: 'bar'|'loading', raw } | null
// fast=true: две быстрые предобработки каждой проверяемой области.
// screenHeight — высота ЭКРАНА, если на вход дали не весь кадр, а вырезанный кусок:
// геометрические константы заданы для 1080p и масштабируются от высоты экрана, а не
// от высоты куска. В обычной работе приложение присылает только полоску зоны.
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

  // Плашка текущей зоны: по умолчанию низ-право; кастомный регион — из настроек.
  // Широкая область захватывает иконку, уровень и часы. На затемнённой игре OCR
  // склеивает их с именем в мусор, хотя само имя в центре читается безошибочно.
  // Сначала читаем середину; если длинное имя не поместилось, пробуем всю область.
  const r = zoneBarRegion || { left: meta.width - 400 * s, top: meta.height - 48 * s, width: 380 * s, height: 30 * s };
  const boxes = [];
  if (r.width >= 250 * s && r.height >= 22 * s) {
    const left = Math.min(80 * s, r.width * 0.21);
    const right = Math.min(90 * s, r.width * 0.24);
    const top = Math.min(10 * s, r.height * 0.15);
    boxes.push([r.left + left, r.top + top, r.width - left - right, r.height - 2 * top]);
    // Длинному имени может понадобиться ещё место справа; эта вторая область
    // оставляет больше текста, но всё ещё отрезает часы у края плашки.
    const widerRight = Math.min(65 * s, r.width * 0.18);
    boxes.push([r.left + left, r.top + top, r.width - left - widerRight, r.height - 2 * top]);
  }
  boxes.push([r.left, r.top, r.width, r.height]);
  for (const box of boxes) {
    const z = await bestLine(...box, LAT + '0123456789:');
    if (z.match) return { zone: z.match.name, ...zoneInfo(z.match.name), source: 'bar', raw: z.raw };
  }

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
  return { color: i.color || null, tier: i.tier || null, quality: i.quality || null, activities: i.res || null };
}

// ---------- распознавание тултипа портала ----------
// кадр (или PNG-буфер) → { name, color, tier, activities, capNum, capMax, capMaxKnown, closes, raw } | null
// near — точка курсора: тултип всплывает рядом с ней, и якорь ищется сначала в этом
// квадрате. На 4К это 1.4 млн пикселей вместо 8.3 млн; не нашли — идём по всему кадру.
// screenHeight — как в recognizeZone: если на вход дали квадрат вокруг курсора,
// масштаб констант считаем от высоты ЭКРАНА, а не от высоты квадрата.
async function recognizeTooltip(input, { near = null, nearRadius = 620, screenHeight = 0, onName = null } = {}) {
  const frame = await F.toFrame(input);
  const meta = { width: frame.width, height: frame.height };
  let s = (screenHeight || meta.height) / 1080;
  const R = nearRadius * s;
  // Кандидатов в якоря ПЕРЕБИРАЕМ, а не берём одного лучшего. Очки у кандидата — это
  // «насколько темно вокруг», и на ярком фоне настоящая полоса их проигрывает: на кадре
  // игрока тултип лежал на светлой бумаге миникарты (92.7 очков темноты), а тень в траве
  // набрала 81.3 — и тултип не распознавался вовсе, хотя его полоса прошла все фильтры.
  // Судья, который не ошибается, — ИМЯ: над настоящей полосой читается зона из словаря
  // на 958 имён, над тенью в траве — мусор. Цена перебора — один OCR имени (~100 мс)
  // на каждого ложного кандидата, и платится она только там, где раньше был отказ.
  const nearCands = near
    ? findBarCands(frame, s, { x0: near.x - R, y0: near.y - R, x1: near.x + R, y1: near.y + R })
    : [];
  // Полный кадр пробуем не только когда у курсора пусто, но и когда все кандидаты
  // у курсора провалили проверку именем: тултип мог всплыть дальше от мыши, чем R.
  const cands = nearCands.slice(0, 4);
  const tried = [];
  let bar = null, nm = null, nameText = '';
  async function readName(c, scale) {
    const region = [c.bx - 15 * scale, c.by - 28 * scale, 310 * scale, 24 * scale];
    const raws = [await ocr(await crop(frame, ...region), { whitelist: LAT, psm: 7 })];
    const ranked = nameMatcher.rank(raws[0]);
    if (ranked.ambiguous) {
      for (const prep of [{ thresh: 150 }, { scale: 4 }]) {
        raws.push(await ocr(await crop(frame, ...region, prep), { whitelist: LAT, psm: 7 }));
      }
    }
    const match = ranked.ambiguous ? nameMatcher.resolve(raws) : ranked.match;
    return match && { ...match, raws };
  }
  // A remembered UI scale is only a first attempt. A changed in-game UI must
  // still reach the original screen-height search and bounded scale fallback.
  const rememberedScale = profiles.getScale(frame, screenHeight);
  if (rememberedScale && Math.abs(rememberedScale - s) > 0.03) {
    const radius = nearRadius * rememberedScale;
    const nearby = near ? findBarCands(frame, rememberedScale, {
      x0: near.x - radius, y0: near.y - radius, x1: near.x + radius, y1: near.y + radius,
    }) : [];
    const rememberedCandidates = nearby.length ? nearby : findBarCands(frame, rememberedScale);
    for (const c of rememberedCandidates.slice(0, 2)) {
      const m = await readName(c, rememberedScale);
      if (m && m.score <= .2) { bar = c; nm = m; nameText = m.raw; s = rememberedScale; break; }
    }
  }
  for (let phase = 0; phase < 2 && !bar; phase++) {
    if (phase === 1) {
      const seen = new Set(cands.map(c => c.bx + ':' + c.by));
      cands.length = 0;
      for (const c of findBarCands(frame, s)) {
        if (!seen.has(c.bx + ':' + c.by)) cands.push(c);
        if (cands.length >= 4) break;
      }
    }
    for (const c of cands) {
      tried.push(c);
      const m = await readName(c, s);
      if (m) { bar = c; nm = m; nameText = m.raw; break; }
    }
  }
  // UI scale is independent of desktop resolution (custom modes and in-game UI size).
  // First reuse the visible bar: its solid gold band is about 11 px at the reference
  // size. If the initial size rejected the bar entirely, search a bounded scale range.
  // Every fallback still needs a clearly readable dictionary name above the bar.
  if (!bar) {
    const seen = new Set();
    let attempts = 0;
    async function tryScaled(c, scale) {
      if (!Number.isFinite(scale) || scale < 0.45 || scale > 4) return false;
      const key = [Math.round(c.bx / 3), Math.round(c.by / 3), Math.round(scale * 20)].join(':');
      if (seen.has(key) || attempts >= 10) return false;
      seen.add(key); attempts++;
      const m = await readName(c, scale);
      if (!m || m.score > 0.2) return false;
      bar = c; nm = m; nameText = m.raw; s = scale;
      return true;
    }
    for (const c of tried) if (await tryScaled(c, c.bh / 11)) break;
    const initial = (screenHeight || meta.height) / 1080;
    const scales = [initial * 0.75, initial * 1.25, initial * 0.5, initial * 1.5, initial * 2, 1];
    for (const scale of scales) {
      if (bar || attempts >= 10) break;
      if (scale < 0.45 || scale > 4) continue;
      const radius = nearRadius * Math.max(initial, scale);
      const box = near ? { x0: near.x - radius, y0: near.y - radius, x1: near.x + radius, y1: near.y + radius } : null;
      for (const c of findBarCands(frame, scale, box).slice(0, 3)) {
        if (await tryScaled(c, c.bh / 11) || await tryScaled(c, scale)) break;
      }
    }
  }
  if (!bar) return null; // ни над одним кандидатом не читается имя зоны — тултипа в кадре нет
  bar = { ...bar, scale: s };
  const FULLW = FULLW_1080 * s;
  const { bx, by, bh, fill } = bar;
  const nameRegion = [bx - 15 * s, by - 28 * s, 310 * s, 24 * s];
  // Совпал короткий близнец — доснимаем имя другими предобработками: вдруг средний
  // слог всё-таки читается. Лишний OCR тратим только на 31 имя из 958.
  if (NAME_TWINS.has(nm.name)) {
    const raws = nm.raws.slice();
    for (const opts of [{ thresh: 150 }, { scale: 4 }, { invert: false }]) {
      raws.push(await ocr(await crop(frame, ...nameRegion, opts), { whitelist: LAT, psm: 7 }));
    }
    const resolved = resolveTwin(nm.name, raws);
    if (resolved !== nm.name) nm = { ...nm, name: resolved, twinRaws: raws };
  }
  profiles.rememberScale(frame, screenHeight, s);
  // No capacity, timer or writeable edge is published until the final result.
  if (typeof onName === 'function') {
    try { onName({ name: nm.name, ...zoneInfo(nm.name) }); }
    catch (error) { console.warn('[OCR] preview unavailable:', error?.message || error); }
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
  const softVotes = new Map();      // знаменатель по хвосту цифр, когда слэш не читается
  let capText = '';
  const preciseVotes = new Map();
  let precise = null;
  const digitPreps = [
    { threshold: 155, scale: 4 }, { threshold: 155, scale: 5 },
    { threshold: 180, scale: 4 }, { threshold: 180, scale: 5 },
  ];
  const hint = profiles.getCapacity(frame, screenHeight, bar);
  const order = digitPreps.map((_, i) => i);
  if (hint?.region === 'digits' && order.includes(hint.prep)) {
    order.splice(order.indexOf(hint.prep), 1); order.unshift(hint.prep);
  }
  for (const index of order) {
    const t = await ocr(await capacityImage(frame, bar, digitPreps[index]), { whitelist: '0123456789/', psm: 7 });
    if (!t) continue;
    capReads.push(t);
    const read = exactCapacity(t, bar);
    if (!read) continue;
    const key = `${read.num}/${read.max}`;
    const group = preciseVotes.get(key) || { ...read, count: 0, prep: index };
    group.count++;
    preciseVotes.set(key, group);
    capText = t;
    if (group.count >= 2) {
      precise = group;
      profiles.rememberCapacity(frame, screenHeight, bar, { region: 'digits', prep: group.prep });
      break;
    }
  }
  // Wider crops remain the bounded fallback for a clipped/atypical tooltip.
  // Incomplete narrow reads cannot provide an exact numerator on their own.
  const digitReads = capReads.splice(0);
  let digitDen = null;
  if (!precise && preciseVotes.size === 1 && fill <= FULLW * 1.08) {
    const candidate = [...preciseVotes.values()][0];
    const supporting = digitReads.filter(t => {
      const digits = t.replace(/\D/g, '');
      return digits.length >= 2 && digits.endsWith(String(candidate.max));
    });
    // Several readings establish the size, but only one saw the whole pair:
    // keep the same explicitly approximate fill estimate as the wider fallback.
    if (supporting.length >= 3) digitDen = candidate.max;
  }
  capLoop:
  for (const region of precise || digitDen ? [] : CAP_REGIONS) {
    for (const prep of CAP_PREP) {
      const buf = await crop(frame, region[0], by - 4 * s, region[1], bh + 8 * s, { ...prep, scale: 4 });
      const t = await ocr(buf, { whitelist: '0123456789/', psm: 7 });
      if (!t) continue;
      capReads.push(t);
      if (!capText && t.replace(/\D/g, '').length >= 2) capText = t;
      const m = t.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) {
        // Слэш не прочитался — но по хвосту цифр знаменатель всё равно виден (тот же
        // разбор, что и после цикла). Считаем эти голоса ПРЯМО ЗДЕСЬ ради остановки:
        // на кадре, где цифры не читаются в принципе («86», «267»…), цикл раньше выжигал
        // все 15 комбинаций — 1.2 секунды на каждое нажатие — хотя знаменатель был ясен
        // со второго-третьего чтения. Точный числитель ниже этих затрат не стоит: он
        // устаревает за минуты и при нечитаемых цифрах всё равно оценивается по заливке.
        const digits = t.replace(/\D/g, '');
        const den = digits.endsWith('20') ? 20 : digits.endsWith('7') ? 7 : null;
        if (den) softVotes.set(den, (softVotes.get(den) || 0) + 1);
        if (!denVotes.size && capReads.length >= 4 && Math.max(0, ...softVotes.values()) >= 2) break capLoop;
        continue;
      }
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
  if (precise) {
    capMax = precise.max; capNum = precise.num;
  } else if (digitDen) {
    capMax = digitDen;
  } else if (denVotes.size) {
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

  const timer = await recognizeTimer(frame, bar, { ocr, crop });

  return {
    name: nm.name, ...zoneInfo(nm.name),
    capNum, capMax, capMaxKnown, capNumApprox, closes: timer.closes, timerUncertain: timer.timerUncertain,
    raw: { name: nameText, cap: capText, capReads: [...digitReads, ...capReads], ...timer.raw, bar },
  };
}

module.exports = {
  init, shutdown,
  recognizeZone: (...args) => engine.withDeadline(() => recognizeZone(...args), 6000),
  recognizeTooltip: (...args) => engine.withDeadline(() => recognizeTooltip(...args), 12000),
  zoneInfo, DICT, ZONE_INFO, NAME_TWINS, resolveTwin,
  _internal: { findBar, findBarCands, crop, fuzzyMatch, fuzzyFromLine, parseDur, allDurations, sameNumber, MAX_HOURS },   // для тестов и отладки пайплайна
};
