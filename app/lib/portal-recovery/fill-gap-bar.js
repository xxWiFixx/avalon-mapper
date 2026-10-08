'use strict';
// Fixed fallback bar detector. Only the fill color gap differs from baseline.
const FULLW_1080=195;
function findFillGapBarCands(frame, scale, box) {
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
    return r >= 195 && g >= 120 && g <= 210 && b <= 95 && r > g && g - b >= 95;
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
module.exports={findFillGapBarCands};
