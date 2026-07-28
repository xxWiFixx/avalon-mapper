#!/usr/bin/env node
// Обрезка карт зон «ровно по краям» + маска ромба.
//
// Ассеты с albiononlinebuilds.com неоднородны: часть — скриншоты игровой карты (песчаная рамка,
// шапка с названием, водяной знак в углу), часть — чистый ромб на белом фоне, размеры от 1042x784
// до 1626x1626. Поэтому геометрию ищем в каждой картинке заново.
//
// Как ищем: внутренность карты — тёмное фиолетовое поле, оно есть у обоих видов ассетов.
// Берём самую большую связную область такого цвета (это и есть ромб), её bbox = края карты.
// Дальше вписываем ромб в прозрачный квадрат: наружу от диагоналей всё срезаем, поэтому
// в оверлее карта выглядит как в игре — ромбом, без «мусорных» углов с водяным знаком.
//
// Запуск: node tools/crop-maps.js            — все карты
//         node tools/crop-maps.js --sample   — 8 разных, в scratchpad для проверки глазами
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const SRC = path.join(__dirname, '..', 'app', 'assets', 'avalon-maps');
const OUT = path.join(__dirname, '..', 'app', 'assets', 'avalon-maps-crop');
const ISO_RATIO = 1.44;            // пропорция ромба карты на игровых скриншотах (замерена)
const OUT_W = 512;                 // ромб вписан в прямоугольник этой ширины…
const OUT_H = Math.round(OUT_W / ISO_RATIO);   // …и такой высоты, то есть в игровой пропорции

// «Внутренность карты» — тёмно-СИРЕНЕВОЕ поле (замер: 54,42,60). Ключ к отбору: у сиреневого
// зелёный канал ниже и красного, и синего. У тёмных стен на фоне игры (16,21,31) наоборот —
// зелёный выше красного, поэтому фон отсекается, хотя он тоже тёмный.
function isField(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 18 && lum < 128 && r > g + 2 && b > g + 2;
}

// Все связные области маски разом: возвращает список {n, bbox}. Обход итеративный —
// на картинке в 2.6 млн пикселей рекурсия переполнит стек.
function components(mask, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!mask[p0] || seen[p0]) continue;
    let sp = 0; stack[sp++] = p0; seen[p0] = 1;
    let n = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    out.push({ n, minX, maxX, minY, maxY });
  }
  return out;
}

// Эрозия: срезает тонкие перемычки, которыми поле карты цепляется за тёмный фон игры.
function erode(mask, W, H, r) {
  let cur = mask;
  for (let step = 0; step < r; step++) {
    const next = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (cur[p] && cur[p - 1] && cur[p + 1] && cur[p - W] && cur[p + W]) next[p] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

function dilate(mask, W, H, r) {
  let cur = mask;
  for (let step = 0; step < r; step++) {
    const next = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (cur[p] || cur[p - 1] || cur[p + 1] || cur[p - W] || cur[p + W]) next[p] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// ---------- ромб по песчаной рамке (основной путь для скриншотов) ----------
// Искать ромб по тёмному полю оказалось нельзя: на части скриншотов ФОН ИГРЫ вокруг
// карты тоже тёмно-фиолетовый и проходит проверку isField — связная область уползала
// на весь кадр, и обрезка резала карту как попало (игрок прислал два десятка таких).
// Песчаная рамка карты, наоборот, ни на что в кадре не похожа: светлая и тёплая.
//
// Геометрия берётся не из bbox рамки, а из ВЕРШИН ромба: у левой и правой вершины
// рамка занимает столбик в 4–8 px, и его середина — горизонтальная ось карты. Поэтому
// центр находится верно даже там, где скриншот обрезан сверху или снизу.
// Замер по чистым картам: поле = 0.846 от внешней ширины рамки, пропорция ровно 1.44.
const FIELD_OF_FRAME = 0.846;
function isSand(r, g, b) { return r > 130 && g > 100 && b < r - 30 && r - b > 45; }

function detectBySand(data, W, H) {
  const top = Math.round(H * 0.09), bottom = Math.round(H * 0.97);   // шапка и водяной знак — тоже песок
  const sand = new Uint8Array(W * H);
  let n = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] > 128 && isSand(data[i], data[i + 1], data[i + 2])) { sand[y * W + x] = 1; n++; }
    }
  }
  if (n < W * H * 0.01) return null;

  // крупнейшая связная компонента песка — это рамка карты вместе с дорогами
  const seen = new Uint8Array(W * H), st = new Int32Array(W * H);
  let best = null;
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!sand[p0] || seen[p0]) continue;
    let sp = 0; st[sp++] = p0; seen[p0] = 1;
    let cnt = 0, mnX = W, mxX = -1, mnY = H, mxY = -1;
    const px = [];
    while (sp > 0) {
      const p = st[--sp]; const x = p % W, y = (p - x) / W; cnt++; px.push(p);
      if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (y < mnY) mnY = y; if (y > mxY) mxY = y;
      if (x > 0 && sand[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; st[sp++] = p - 1; }
      if (x < W - 1 && sand[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; st[sp++] = p + 1; }
      if (y > 0 && sand[p - W] && !seen[p - W]) { seen[p - W] = 1; st[sp++] = p - W; }
      if (y < H - 1 && sand[p + W] && !seen[p + W]) { seen[p + W] = 1; st[sp++] = p + W; }
    }
    if (!best || cnt > best.cnt) best = { cnt, mnX, mxX, mnY, mxY, px };
  }
  const outerW = best ? best.mxX - best.mnX + 1 : 0;
  if (!best || outerW < W * 0.4) return null;      // не рамка — что-то мелкое

  // середина короткого столбика у вершины = ось карты по вертикали
  const colCenter = (x0, x1) => {
    let mn = H, mx = -1;
    for (const p of best.px) {
      const x = p % W;
      if (x < x0 || x > x1) continue;
      const y = (p - x) / W;
      if (y < mn) mn = y; if (y > mx) mx = y;
    }
    return mx < 0 ? null : { c: (mn + mx) / 2, span: mx - mn + 1 };
  };
  const L = colCenter(best.mnX, best.mnX + 3), R = colCenter(best.mxX - 3, best.mxX);
  // У НАСТОЯЩЕЙ вершины ромба песок занимает короткий столбик. Если он высокий, найденное
  // — не рамка, а что-то другое того же цвета: на части скриншотов фон сцены сложен из
  // тёплого камня, и он подделывает песок ничуть не хуже, чем тёмная пещера подделывала поле.
  if (!L || !R || L.span > outerW * 0.06 || R.span > outerW * 0.06) return null;
  const cy = (L.c + R.c) / 2;
  const cx = (best.mnX + best.mxX) / 2;
  const width = Math.round(outerW * FIELD_OF_FRAME);
  const height = Math.round(width / ISO_RATIO);
  const outerH = best.mxY - best.mnY + 1;
  return {
    // Рамку отдаём КАК ЕСТЬ, даже если она вылезает за кадр: обрезать её по картинке
    // значило бы сплющить ромб. Недостающее добьётся прозрачным (см. крой ниже).
    rect: { left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height },
    // рамка заметно ниже своей же ширины — значит сам скриншот обрезан, и части карты
    // в источнике просто нет; чинить это обрезкой нельзя, но сказать об этом надо
    cut: Math.abs(outerH - outerW / ISO_RATIO) > (outerW / ISO_RATIO) * 0.06,
  };
}

async function detect(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  // Ассеты бывают двух видов. Чистый ренд — ромб без окружения (фон белый или прозрачный):
  // там ничего искать не надо, достаточно границ непустого содержимого.
  let plain = 0;
  const isPlain = i => data[i + 3] < 24 || (data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238);
  for (let i = 0; i < data.length; i += 4) if (isPlain(i)) plain++;
  if (plain / (W * H) > 0.15) {
    let minX = W, maxX = 0, minY = H, maxY = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!isPlain(i)) {
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { rect: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, area: n, W, H, kind: 'ренд' };
  }

  // Скриншот игровой карты: сначала пробуем по песчаной рамке — этот путь надёжнее,
  // потому что фон игры бывает того же тёмно-фиолетового цвета, что и поле карты.
  const bySand = detectBySand(data, W, H);
  if (bySand) return { rect: bySand.rect, area: bySand.rect.width * bySand.rect.height / 2, W, H, kind: 'скриншот', cut: bySand.cut, sand: true };

  // Рамка не опознана — ищем ромб по форме. Это дороже, но не зависит от того,
  // какого цвета фон сцены вокруг карты.
  const byShape = findDiamondGlobal(data, W, H);
  if (byShape) return { rect: byShape.rect, area: byShape.rect.width * byShape.rect.height / 2, W, H, kind: 'скриншот', shape: true };

  // И только если не вышло и это — старый путь: по тёмному полю.
  // Шапку с названием и полосу с водяным знаком выкидываем сразу, они дают ложные области.
  const top = Math.round(H * 0.10), bottom = Math.round(H * 0.96);
  const mask = new Uint8Array(W * H);
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i + 3] > 128 && isField(data[i], data[i + 1], data[i + 2])) mask[y * W + x] = 1;
    }
  }
  const rCut = Math.max(2, Math.round(Math.min(W, H) / 260));
  const eroded = erode(mask, W, H, rCut);
  const all = components(eroded, W, H);
  const cands = all.filter(c => c.n > W * H * 0.02);
  if (!cands.length) return null;

  // Ромб узнаём по форме (bbox вытянут примерно 1.44:1 — изометрия) и по тому, что он в центре кадра.
  const cx = W / 2, cy = H / 2;
  let best = null;
  for (const c of cands) {
    const w = c.maxX - c.minX + 1, h = c.maxY - c.minY + 1;
    const ratio = w / h;
    const shape = ratio >= 0.9 && ratio <= 1.9 ? 1 : 0.25;
    const off = Math.hypot((c.minX + c.maxX) / 2 - cx, (c.minY + c.maxY) / 2 - cy) / Math.hypot(cx, cy);
    const score = c.n * shape * (1 - 0.7 * off);
    if (!best || score > best.score) best = { ...c, score, ratio };
  }
  // эрозия съела края — возвращаем их назад
  const pad = rCut;
  let left = Math.max(0, best.minX - pad);
  let right = Math.min(W - 1, best.maxX + pad);
  let top2 = Math.max(0, best.minY - pad);
  let bottom2 = Math.min(H - 1, best.maxY + pad);

  // Широкая дорога поперёк карты режет поле надвое, и связная область даёт обрезанный по
  // вертикали ромб (замер: 791x444 вместо 791x549). Границы по вертикали поэтому берём НЕ
  // из связной области, а по профилю строк исходной маски в колонках ромба: разрез дорогой
  // тогда не мешает вовсе. Порог в 4% ширины отсекает случайные тёмно-сиреневые пиксели фона.
  const w = right - left + 1;
  const ratio0 = w / (bottom2 - top2 + 1);
  if (Math.abs(ratio0 - ISO_RATIO) > 0.06) {
    // Какая из двух горизонтальных границ настоящая? У ВЕРШИНЫ ромба строка узкая
    // (сходятся две грани), у среза дорогой — широкая почти во всю карту. Поэтому
    // держимся за узкую сторону, а противоположную отмеряем по пропорции.
    const rowWidth = y => {
      let n = 0;
      for (let x = left; x <= right; x++) if (mask[y * W + x]) n++;
      return n;
    };
    const h = Math.round(w / ISO_RATIO);
    if (rowWidth(top2) <= rowWidth(bottom2)) bottom2 = Math.min(H - 1, top2 + h - 1);
    else top2 = Math.max(0, bottom2 - h + 1);
  }
  return {
    rect: { left, top: top2, width: right - left + 1, height: bottom2 - top2 + 1 },
    area: best.n, W, H, kind: 'скриншот',
  };
}

// ---------- доводка по кромке ромба ----------
// Поиск связной области ставит рамку примерно, и у части карт (30 из 396) в кадр
// заезжает песчаная рамка самой карты — по верхним граням ромба идёт светлая полоса.
// Здесь рамка уточняется прямым признаком: у ПРАВИЛЬНОЙ рамки по внутренней стороне
// граней ромба всюду поле, а сразу снаружи — уже не поле. Меряем ровно это и двигаем
// рамку туда, где такое разделение чище всего. Считаем по точкам вдоль периметра,
// а не по всей площади: 2890 вариантов × 360 точек — доли секунды на карту.
const RING_IN = 0.965, RING_OUT = 1.045;   // насколько внутрь и наружу от грани смотрим
const RING_PTS = 360;

function ringScore(data, W, H, rect) {
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const hx = rect.width / 2, hy = rect.height / 2;
  let inBad = 0, inN = 0, outField = 0, outN = 0;
  for (let k = 0; k < RING_PTS; k++) {
    // равномерно по периметру ромба: t в [0,4), по грани на каждую единицу
    const t = (k / RING_PTS) * 4;
    const side = Math.floor(t), u = t - side;
    // единичный ромб: точка на грани в координатах (-1..1)
    let ux, uy;
    if (side === 0) { ux = u; uy = u - 1; }
    else if (side === 1) { ux = 1 - u; uy = u; }
    else if (side === 2) { ux = -u; uy = 1 - u; }
    else { ux = u - 1; uy = -u; }
    for (const [f, isIn] of [[RING_IN, true], [RING_OUT, false]]) {
      const x = Math.round(cx + ux * hx * f), y = Math.round(cy + uy * hy * f);
      if (x < 0 || y < 0 || x >= W || y >= H) { if (isIn) { inN++; inBad++; } continue; }
      const i = (y * W + x) * 4;
      const field = data[i + 3] > 128 && isField(data[i], data[i + 1], data[i + 2]);
      if (isIn) { inN++; if (!field) inBad++; }
      else { outN++; if (field) outField++; }
    }
  }
  // внутри должно быть поле, снаружи — нет; обе ошибки одинаково плохи
  return (inN ? inBad / inN : 1) + (outN ? outField / outN : 1);
}

// Поиск в два прохода: сначала грубо и широко (промах связной области бывает и на 40 px),
// потом точно вокруг найденного. Так покрывается больший разброс при том же числе проб.
function search(data, W, H, from, { range, step, dsMax, dsStep }) {
  let best = { rect: from, score: ringScore(data, W, H, from) };
  for (let ds = -dsMax; ds <= dsMax + 1e-9; ds += dsStep) {
    const width = Math.round(from.width * (1 + ds));
    const height = Math.round(width / ISO_RATIO);
    if (width < 40 || height < 28) continue;
    for (let dx = -range; dx <= range; dx += step) {
      for (let dy = -range; dy <= range; dy += step) {
        // центр держим на месте, размер меняем вокруг него
        const left = Math.round(from.left + (from.width - width) / 2 + dx);
        const top = Math.round(from.top + (from.height - height) / 2 + dy);
        if (left < 0 || top < 0 || left + width > W || top + height > H) continue;
        const cand = { left, top, width, height };
        const s = ringScore(data, W, H, cand);
        if (s < best.score) best = { rect: cand, score: s };
      }
    }
  }
  return best;
}

// Прямой поиск ромба ПО ФОРМЕ: перебираем центр и размер, оценивая тем же признаком,
// что и доводка, — «внутри грани поле, сразу снаружи не поле». Ни на связные области,
// ни на цвет фона это не опирается вовсе, поэтому работает там, где фон сцены похож
// то на поле, то на песок. Дороже двух других путей, потому и запасной.
function findDiamondGlobal(data, W, H) {
  let best = null;
  for (let k = 0; k <= 10; k++) {
    const width = Math.round(W * (0.35 + k * 0.07));
    const height = Math.round(width / ISO_RATIO);
    if (height > H * 1.3 || width > W) continue;
    const stepX = Math.max(6, Math.round(W / 24)), stepY = Math.max(6, Math.round(H / 24));
    for (let cx = width / 2 - width * 0.15; cx <= W - width / 2 + width * 0.15; cx += stepX) {
      for (let cy = height / 2 - height * 0.2; cy <= H - height / 2 + height * 0.2; cy += stepY) {
        const rect = { left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height };
        const s = ringScore(data, W, H, rect);
        if (!best || s < best.score) best = { rect, score: s };
      }
    }
  }
  if (!best) return null;
  const fine = search(data, W, H, best.rect, { range: 24, step: 3, dsMax: 0.10, dsStep: 0.02 });
  const exact = search(data, W, H, fine.rect, { range: 4, step: 1, dsMax: 0.02, dsStep: 0.01 });
  // 0.5 — «внутри поле, снаружи нет» выполняется хотя бы наполовину; выше этого
  // найденное ромбом не является, и лучше отдать управление старому пути
  return exact.score < 0.5 ? exact : null;
}

function refine(data, W, H, rect) {
  const base = ringScore(data, W, H, rect);
  const coarse = search(data, W, H, rect, { range: 40, step: 5, dsMax: 0.18, dsStep: 0.04 });
  const best = search(data, W, H, coarse.rect, { range: 6, step: 1, dsMax: 0.03, dsStep: 0.01 });
  // Двигаем, только если стало ЗАМЕТНО лучше: иначе на чистых картах доводка ходила бы
  // туда-сюда на пару пикселей от шума и портила уже верную рамку.
  return best.score < base - 0.02 ? { ...best, base, moved: true } : { rect, score: base, base, moved: false };
}

// Ромбовидная маска: всё вне диагоналей — прозрачное.
function diamondMask(w, h) {
  const svg = `<svg width="${w}" height="${h}"><polygon points="${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}" fill="#fff"/></svg>`;
  return Buffer.from(svg);
}

(async () => {
  const sample = process.argv.includes('--sample');
  // --only Имя-Зоны[,Ещё-Одна] — пересобрать одну-две карты, не трогая остальные 396.
  // Нужно, когда приходит недостающий исходник: полный прогон переписал бы все файлы
  // и утопил бы настоящую правку в шуме диффа.
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? String(process.argv[onlyArg + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;
  fs.mkdirSync(OUT, { recursive: true });
  let files = fs.readdirSync(SRC).filter(f => f.endsWith('.webp'));
  if (sample) files = ['Oiros-Alaiam.webp', 'Fuyes-Izohun.webp', 'Hynes-Ieatun.webp', 'Qiient-Al-Viesis.webp',
    'Cases-Ugumlos.webp', 'Fasos-Ayiotum.webp', 'Xynos-Oyogam.webp', 'Settun-Al-Odetum.webp'].filter(f => fs.existsSync(path.join(SRC, f)));
  if (only) {
    files = only.map(n => n.endsWith('.webp') ? n : n + '.webp');
    const gone = files.filter(f => !fs.existsSync(path.join(SRC, f)));
    if (gone.length) { console.error('нет исходника:', gone.join(', ')); process.exit(1); }
  }

  const mask = diamondMask(OUT_W, OUT_H);
  const report = [];
  let done = 0, moved = 0;
  const cutSrc = [];
  let bySandN = 0, byShapeN = 0;
  for (const f of files) {
    const src = path.join(SRC, f);
    const d = await detect(src);
    if (!d) { report.push([f, 'не найдено поле карты']); continue; }
    const ratio = d.rect.width / d.rect.height;
    if (d.sand) bySandN++;
    if (d.shape) byShapeN++;
    // Доводка по кромке — только для игровых скриншотов: у рендеров поля с песчаной
    // рамкой нет вовсе, и признак «внутри поле, снаружи не поле» там не работает.
    let note = '';
    if (d.cut) { note = ' · ИСТОЧНИК ОБРЕЗАН: части карты нет в самом ассете'; cutSrc.push(f); }
    if (d.kind === 'скриншот' && !d.sand) {
      const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const r = refine(data, info.width, info.height, d.rect);
      if (r.moved) {
        note = ` · доводка ${d.rect.width}x${d.rect.height}(${d.rect.left},${d.rect.top}) → ${r.rect.width}x${r.rect.height}(${r.rect.left},${r.rect.top}), кромка ${r.base.toFixed(2)}→${r.score.toFixed(2)}`;
        moved++;
      }
      d.rect = r.rect;
    }
    // Ромб может выходить за край картинки (скриншот обрезан) — тогда берём то, что
    // есть, и добиваем недостающее прозрачным. Иначе ромб пришлось бы сплющить.
    const clip = {
      left: Math.max(0, d.rect.left), top: Math.max(0, d.rect.top),
      width: 0, height: 0,
    };
    clip.width = Math.min(d.rect.left + d.rect.width, d.W) - clip.left;
    clip.height = Math.min(d.rect.top + d.rect.height, d.H) - clip.top;
    if (clip.width < 20 || clip.height < 14) { report.push([f, 'ромб почти целиком вне кадра']); continue; }
    const pad = {
      left: clip.left - d.rect.left, top: clip.top - d.rect.top,
      right: (d.rect.left + d.rect.width) - (clip.left + clip.width),
      bottom: (d.rect.top + d.rect.height) - (clip.top + clip.height),
    };
    const padded = pad.left || pad.top || pad.right || pad.bottom;
    if (padded) note += ` · добито прозрачным: ${pad.left}/${pad.top}/${pad.right}/${pad.bottom}`;
    let img = sharp(src).extract(clip).ensureAlpha();
    if (padded) img = img.extend({ ...pad, background: { r: 0, g: 0, b: 0, alpha: 0 } });
    const buf = await img
      // Часть ассетов — не изометрия, а вид сверху (ромб-квадрат). Приводим все к игровой
      // пропорции, иначе в оверлее карта у одних зон выше, у других ниже.
      .resize(OUT_W, OUT_H, { fit: 'fill' })
      .composite([{ input: mask, blend: 'dest-in' }])
      .webp({ quality: 90 }).toBuffer();
    fs.writeFileSync(path.join(sample ? OUT : OUT, f), buf);
    report.push([f, `${d.kind} ${d.W}x${d.H} → ${d.rect.width}x${d.rect.height} (${d.rect.left},${d.rect.top}) пропорция ${ratio.toFixed(2)}${note}`]);
    if (++done % 50 === 0) console.log('  обработано', done, 'из', files.length);
  }
  for (const [f, s] of report) console.log(f.padEnd(26), s);
  console.log('готово:', report.length, '→', OUT, '| по рамке', bySandN, '| по форме', byShapeN, '| доводка у', moved);
  if (cutSrc.length) console.log('обрезаны в самом источнике (' + cutSrc.length + '):', cutSrc.map(x => x.replace('.webp', '')).join(', '));
})();
