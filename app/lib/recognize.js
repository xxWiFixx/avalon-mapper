// Распознавание скриншотов Albion: тултип портала + текущая зона.
// Регрессии проверяются на калибровочных кадрах и дополнительных кадрах разных UI.
// 1080p задаёт начальный масштаб; при несовпадении UI подбираем его по полосе тултипа.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const ocrWorker = require('./ocr-worker');
const F = require('./frame');
const { capacityImage, portalSize } = require('./capacity-image');
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
    return r >= 195 && g >= 120 && g <= 210 && b <= 95 && r > g && g - b >= 110;
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
  const flatRows = [];
  for (let y = Y0; y < Y1; y++) {
    const base = y * w * ch;
    let segs = [], start = -1, last = -1, cnt = 0, f0 = -1, f1 = -1, cntAtF0 = 0;
    // fill меряем ПРОТЯЖЁННОСТЬЮ яркой части, а не числом ярких пикселей: поверх полосы
    // нарисованы значок и цифры «7/7», и счётчик занижал бы заполненность на их ширину.
    //
    // ЛЕВЫЙ КРАЙ БЕРЁМ ПО ЗАЛИВКЕ, если она есть. Шкала вместимости заполняется слева
    // направо, поэтому заливка начинается на краю полосы. Начало же самого отрезка
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
    // Bright grass and yellow map textures can pass isFill too. A long bridged
    // segment then starts in the world and cuts the real bar in half. Recover
    // its edge from a flat stretch of fill, independently of those segments.
    // The game's fill is uniform; scene textures vary even within a gold row.
    const flatMin = Math.max(12, Math.round(35 * scale));
    for (let x = X0; x < X1; x++) {
      const seed = base + x * ch;
      if (!isFill(seed)) continue;
      const closeColor = (i) => isFill(i)
        && Math.abs(data[i + ri] - data[seed + ri]) <= 6
        && Math.abs(data[i + 1] - data[seed + 1]) <= 6
        && Math.abs(data[i + bi] - data[seed + bi]) <= 6;
      let end = x + 1;
      while (end < X1 && closeColor(base + end * ch)) end++;
      if (end - x >= flatMin && end - x <= FULLW * 1.08) {
        let last = x, count = 0, fillEnd = x;
        for (let right = x; right < Math.min(X1, x + MAX_SPAN); right++) {
          const i = base + right * ch;
          if (right - last > bridge) break;
          if (isGold(i)) { last = right; count++; }
          if (right - x < FULLW * 1.08 && closeColor(i)) fillEnd = right;
        }
        const span = last - x + 1;
        if (count >= 100 * scale && span >= 150 * scale && count / span >= 0.7)
          flatRows.push({ y, minX: x, maxX: last, cnt: count, fill: fillEnd - x + 1, flat: true });
      }
      x = end - 1;
    }
  }
  // Края сравниваются с ПЕРВОЙ строкой группы, и это осознанно. Пробовали с последней —
  // группа получает право «идти» вслед за плавным дрейфом краёв, а дрейфует не только
  // сглаженный край полосы (399 → 390 за десять строк на кадре игрока), но и песок
  // миникарты с той же скоростью 1–2px на строку: на калибровочном c4 обрезки текстуры
  // склеивались в кандидата проходной высоты и перебивали настоящую полосу. Цена якоря
  // по первой строке — группа иногда теряет крайнюю строку (см. порог высоты ниже).
  const groups = [];
  for (const r of [...rows, ...flatRows]) {
    let joined = false;
    for (const g of groups) {
      const lastRow = g.rows[g.rows.length - 1];
      if (!!r.flat === !!lastRow.flat && r.y - lastRow.y >= 1 && r.y - lastRow.y <= 2 && (Math.abs(r.minX - g.minX0) <= 6 || (!r.flat && Math.abs(r.maxX - g.maxX0) <= 6))) { g.rows.push(r); joined = true; break; }
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
    // Заливка — сильный признак настоящей полосы, а тени и песок обычно проходят фильтры на
    // одной тёмной дорожке, с fill=0. Кандидат с заливкой правдоподобной длины уходит
    // в начало очереди: на кадре игрока в золотой траве кандидатов было 50, настоящая
    // полоса — десятой по темноте, и до неё перебор не доходил. Пустой портал (0/7)
    // заливки не имеет и преимущества не получает — ему остаётся очередь по темноте.
    // Потолок 1.15: длиннее полосы заливка не бывает, ярко-жёлтая простыня длиннее —
    // это значки на миникарте, слившиеся в строку.
    const fillPlausible = fill >= 0.15 * FULLW && fill <= 1.15 * FULLW;
    cands.push({ bx, by, bh: hh, span, fill, score, flat: !!g.rows[0].flat,
      rank: score - (fillPlausible ? 60 : 0) - (g.rows[0].flat ? 20 : 0) });
  }
  // The digits split a uniform fill into multiple stretches. Only its first
  // edge is an anchor; an interior stretch would crop away part of the name
  // and move the capacity reader onto the cooldown chip (calibration/a23).
  return cands.filter(candidate => !candidate.flat || !cands.some(other => other.flat
    && Math.abs(candidate.by - other.by) <= 3 && other.bx < candidate.bx - 6
    && other.bx + other.fill > candidate.bx))
    .sort((a, b) => a.rank - b.rank).filter((candidate, index, sorted) => !sorted.slice(0, index).some(other =>
      Math.abs(candidate.bx - other.bx) <= 6 && Math.abs(candidate.by - other.by) <= 3))
    .map(({ flat, ...candidate }) => candidate);
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
// Each call sets all effective options and disables adaptive learning. This
// allows exact duplicate OCR inputs to be reused within one recovery attempt.
ocr.memoContract = 'stateless-png-psm-whitelist-v1';

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
    const scales = [initial * 0.9, initial * 0.75, initial * 1.25, initial * 0.5, initial * 1.5, initial * 2, 1];
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

  // ---------- размер портала ----------
  // Нужен только знаменатель: /7 или /20. Не восстанавливаем числитель по
  // заливке и не отвергаем размер из-за несогласованного числителя/масштаба.
  const CAP_REGIONS = [
    [bx + FULLW / 2 - 45 * s, 90 * s],
    [bx - 4 * s, FULLW + 8 * s],
    [bx + FULLW / 2 - 62 * s, 120 * s],
  ];
  const CAP_PREP = [
    { invert: false, thresh: null }, { invert: true, thresh: null },
    { invert: false, thresh: 140 }, { invert: true, thresh: 140 },
    { invert: false, thresh: 100 },
  ];
  const digitReads = [], capReads = [], explicitVotes = new Map(), joinedVotes = new Map();
  let capText = '';
  const observeSize = (text, allowJoined = true) => {
    if (!text) return;
    const explicit = portalSize(text);
    const size = explicit ?? (allowJoined ? portalSize(text, { joined: true }) : null);
    if (size == null) return;
    if (!capText || explicit != null) capText = text;
    const votes = explicit == null ? joinedVotes : explicitVotes;
    votes.set(size, (votes.get(size) || 0) + 1);
  };
  const confirmedSize = allowJoined => {
    // Conflicting explicit denominators stay unknown; never break a tie by
    // choosing the smaller portal or by looking at the occupied bar length.
    if (explicitVotes.size > 1) return null;
    if (explicitVotes.size === 1) {
      const [size, count] = [...explicitVotes.entries()][0];
      return count >= 2 || (joinedVotes.get(size) || 0) >= 1 ? size : null;
    }
    if (allowJoined && joinedVotes.size === 1) {
      const [size, count] = [...joinedVotes.entries()][0];
      return count >= 2 ? size : null;
    }
    return null;
  };
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
    digitReads.push(t); observeSize(t);
    if (confirmedSize(false) != null) {
      profiles.rememberCapacity(frame, screenHeight, bar, { region: 'digits', prep: index });
      break;
    }
  }
  // A lost slash can support a size, but first try the wider capacity crops.
  // Neither a bare numerator nor the cooldown clock supplies a denominator.
  capLoop:
  for (const region of confirmedSize(false) != null ? [] : CAP_REGIONS) {
    for (const prep of CAP_PREP) {
      const buf = await crop(frame, region[0], by - 4 * s, region[1], bh + 8 * s, { ...prep, scale: 4 });
      const t = await ocr(buf, { whitelist: '0123456789/', psm: 7 });
      if (!t) continue;
      // The full-track crop may touch the cooldown when the scale is wrong.
      // It can confirm an explicit /7 or /20, never a slashless clock suffix.
      capReads.push(t); observeSize(t, region !== CAP_REGIONS[1]);
      if (confirmedSize(false) != null || (capReads.length >= 4 && confirmedSize(true) != null)) break capLoop;
    }
  }
  // A fraction straddling the bright/dim fill boundary needs the original
  // grayscale pixels, not just the normalized dark-ink mask. Keep this crop
  // around the fraction so that the adjacent cooldown cannot supply a size.
  if (confirmedSize(true) == null && explicitVotes.size <= 1) {
    const screenScale = screenHeight / 1080;
    const capacityScales = [s];
    // Name OCR may have selected an oversized scale. Retry capacity at the
    // captured screen's scale only when the observed bar height also fits it.
    if (screenScale >= .45 && screenScale <= 4 && Math.abs(screenScale - s) > .03
      && bh >= 7 * screenScale && bh <= 18 * screenScale) capacityScales.push(screenScale);
    sizeRecovery:
    for (const scale of capacityScales) {
      if (scale !== s) {
        for (const threshold of [155, 180]) {
          const t = await ocr(await capacityImage(frame, { ...bar, scale }, { threshold, scale: 4 }),
            { whitelist: '0123456789/', psm: 7 });
          if (t) { capReads.push(t); observeSize(t); }
          if (confirmedSize(true) != null) break sizeRecovery;
        }
      }
      for (const prep of [{ scale: 4 }, { scale: 4, invert: false }, { scale: 4, thresh: 140 }]) {
        const image = await crop(frame, bx + 77 * scale, by - 3 * scale, 62 * scale, bh + 6 * scale, prep);
        const t = await ocr(image, { whitelist: '0123456789/', psm: 7 });
        if (t) { capReads.push(t); observeSize(t); }
        if (confirmedSize(true) != null) break sizeRecovery;
      }
    }
    // Last contrast check only for a still unknown size. It cannot replace an
    // already accepted denominator or train a preprocessing hint for later frames.
    if (confirmedSize(true) == null && explicitVotes.size <= 1) for (const scale of capacityScales) {
      const image = await crop(frame, bx + 77 * scale, by - 3 * scale, 62 * scale, bh + 6 * scale,
        { scale: 5, thresh: 120 });
      const t = await ocr(image, { whitelist: '0123456789/', psm: 7 });
      if (t) { capReads.push(t); observeSize(t); }
      if (confirmedSize(true) != null) break;
    }
  }
  const capMax = confirmedSize(true), capMaxKnown = capMax != null;
  const capNum = null, capNumApprox = false;

  // Чип перезарядки («через сколько откроется») НЕ читаем: игроку эта информация не нужна,
  // а стоила она трёх лишних проходов OCR на каждое нажатие хоткея.

  const timerScale = await require('./portal-recovery/timer-scale').calibrate(frame, bar);
  const timerBar = timerScale.bar;
  const timer = await recognizeTimer(frame, timerBar, { ocr, crop });

  return {
    name: nm.name, ...zoneInfo(nm.name),
    capNum, capMax, capMaxKnown, capNumApprox, closes: timer.closes, timerUncertain: timer.timerUncertain,
    raw: { name: nameText, cap: capText, capReads: [...digitReads, ...capReads], capacityMode: 'size-only', ...timer.raw, bar: timerBar, timerScale },
  };
}

let portalRecovery;
function getPortalRecovery() {
  if (!portalRecovery) portalRecovery = require('./portal-recovery').createRecovery({
    DICT, NAME_TWINS, resolveTwin, zoneInfo, findBarCands, crop,
  });
  return portalRecovery;
}

// Keep the early name preview and the existing capacity reader. White timers
// always pass the completeness/pixel checks, including a number already found
// by baseline OCR: a confident but shortened timer must still be rejectable.
async function recognizePortal(input, options = {}) {
  const frame = await F.toFrame(input);
  const baseline = await recognizeTooltip(frame, options);
  const onName = typeof options.onName === 'function' ? partial => {
    try { options.onName(partial); }
    catch (error) { console.warn('[OCR] preview unavailable:', error?.message || error); }
  } : null;
  try {
    const recovered = await getPortalRecovery().recover(frame, baseline, {
      ocr, screenHeight: options.screenHeight || 0, onName,
      // Only archive validation supplies an episode exclusion. Live captures
      // use the packaged model without requiring any archive on the machine.
      excludeEpisode: options.recoveryExcludeEpisode ?? null,
      includeDiagnostics: options.recoveryDiagnostics === true,
    });
    const tip = baseline ? {
      ...baseline,
      closes: recovered.portal?.closes ?? null,
      timerUncertain: recovered.portal?.timerUncertain !== false,
    } : recovered.portal;
    if (!tip) return null;
    return { ...tip, raw: { ...tip.raw, portalRecovery: recovered.diagnostics } };
  } catch (error) {
    console.warn('[OCR] portal verification unavailable:', error?.message || error);
    // An interrupted verification cannot endorse the unchecked baseline time.
    // Its known name/capacity remain useful; the next queued capture may retry.
    return baseline ? { ...baseline, closes: null, timerUncertain: true,
      raw: { ...baseline.raw, portalRecovery: { version: 5, stage: 'verification-unavailable',
        reason: error?.code || 'RECOVERY_ERROR' } } } : null;
  }
}

module.exports = {
  init, shutdown,
  recognizeZone: (...args) => engine.withDeadline(() => recognizeZone(...args), 6000),
  recognizeTooltip: (...args) => engine.withDeadline(() => recognizePortal(...args), 12000),
  zoneInfo, DICT, ZONE_INFO, NAME_TWINS, resolveTwin,
  _internal: { findBar, findBarCands, crop, fuzzyMatch, fuzzyFromLine, parseDur, allDurations, sameNumber, MAX_HOURS },   // для тестов и отладки пайплайна
};
