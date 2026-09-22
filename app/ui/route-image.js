(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RouteImage = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const LIMITS = Object.freeze({ steps: 100, nameLength: 240, pixels: 24000000, side: 16000, columnWidth: 760, columnGap: 24 });
  const PALETTE = {
    avalon: { color: '#b59be2', label: 'Авалон' },
    blue: { color: '#79b7de', label: 'Синяя зона' },
    yellow: { color: '#e3c570', label: 'Жёлтая зона' },
    red: { color: '#e68c80', label: 'Красная зона' },
    black: { color: '#c2bdb2', label: 'Чёрная зона' },
    city: { color: '#8bc99d', label: 'Город' },
    unknown: { color: '#ded5c4', label: '' },
  };
  const C = { background: '#171614', card: '#211f1b', border: '#3f382d', gold: '#d9b77a', text: '#f0e9dd', muted: '#aaa294', line: '#514634', danger: '#ef9d8c', dangerBg: '#38231f' };
  const FONT = '"Fira Sans", "Segoe UI", sans-serif';
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const finiteTime = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000;
  const pad = value => String(value).padStart(2, '0');

  function timestamp(value) {
    const date = new Date(value);
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  function offset(value) {
    const minutes = -new Date(value).getTimezoneOffset(), absolute = Math.abs(minutes);
    return `UTC${minutes < 0 ? '−' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  }
  function name(value) {
    if (typeof value !== 'string') fail('INVALID_ROUTE', 'У маршрута отсутствует название локации.');
    const clean = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) fail('INVALID_ROUTE', 'У маршрута отсутствует название локации.');
    if (clean.length > LIMITS.nameLength) fail('NAME_TOO_LONG', `Название локации длиннее ${LIMITS.nameLength} символов. Изображение не создано.`);
    return clean;
  }
  function optionalNumber(value, field, { integer = false, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) {
      fail('INVALID_ROUTE', `Некорректные данные маршрута: ${field}.`);
    }
    return value;
  }
  function duration(seconds) {
    if (seconds === null) return 'неизвестно';
    const total = Math.round(seconds), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    if (h) return `${h} ч${m ? ` ${m} мин` : ''}`;
    if (m) return `${m} мин${s ? ` ${s} с` : ''}`;
    return `${s} с`;
  }
  function transitionCount(count) {
    const last = count % 10, lastTwo = count % 100;
    return `${count} ${last === 1 && lastTwo !== 11 ? 'переход' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'перехода' : 'переходов'}`;
  }
  function zone(name, info) {
    const meta = info && typeof info.get === 'function' ? info.get(name) : info && Object.prototype.hasOwnProperty.call(info, name) ? info[name] : null;
    const raw = typeof meta === 'string' ? meta : meta?.color;
    const key = typeof raw === 'string' && raw.startsWith('city') ? 'city' : Object.prototype.hasOwnProperty.call(PALETTE, raw) ? raw : 'unknown';
    const tier = key !== 'city' && Number.isInteger(meta?.tier) && meta.tier >= 1 && meta.tier <= 8 ? meta.tier : null;
    return { key, color: PALETTE[key].color, label: [tier ? `T${tier}` : '', PALETTE[key].label].filter(Boolean).join(' · ') };
  }

  function plan(route, zoneInfo = {}, now = Date.now()) {
    if (!route || route.found !== true || !Array.isArray(route.steps)) fail('NO_ROUTE', 'Сначала построй маршрут, который можно пройти.');
    if (!finiteTime(now)) fail('INVALID_ROUTE', 'Не удалось определить время создания изображения.');
    if (route.steps.length > LIMITS.steps) fail('ROUTE_TOO_LONG', `Маршрут содержит больше ${LIMITS.steps} переходов. Сократи его для экспорта.`);
    const generatedAt = Math.trunc(now), steps = [];
    for (const [index, source] of route.steps.entries()) {
      if (!source || !['portal', 'exit', 'walk'].includes(source.kind)) fail('INVALID_ROUTE', `Неизвестный тип перехода в шаге ${index + 1}.`);
      const from = name(source.from), to = name(source.to);
      if (index && steps[index - 1].to !== from) fail('DISCONNECTED_ROUTE', `Маршрут разорван перед шагом ${index + 1}. Построй его заново.`);
      const expiresAt = source.expiresAt === null || source.expiresAt === undefined ? null
        : finiteTime(source.expiresAt) && source.expiresAt >= 0 ? Math.trunc(source.expiresAt)
          : fail('INVALID_ROUTE', `Некорректное время закрытия в шаге ${index + 1}.`);
      const capMax = optionalNumber(source.capMax, 'вместимость портала', { integer: true, max: 1000 });
      const capNum = optionalNumber(source.capNum, 'свободные места', { integer: true, max: 1000 });
      if (capMax === 0 || (capMax !== null && capNum !== null && capNum > capMax)) fail('INVALID_ROUTE', `Некорректная вместимость портала в шаге ${index + 1}.`);
      const waitSec = optionalNumber(source.waitSec, 'ожидание', { max: 604800 });
      const etaSec = optionalNumber(source.etaSec, 'время в пути', { max: 604800 });
      const isPortal = source.kind !== 'walk';
      const expired = isPortal && expiresAt !== null && expiresAt <= generatedAt;
      const arrivalRisk = isPortal && expiresAt !== null && etaSec !== null && generatedAt + etaSec * 1000 >= expiresAt;
      const risky = source.risky === true || expired || arrivalRisk;
      const toZone = zone(to, zoneInfo), fromZone = zone(from, zoneInfo);
      const kindLabel = source.kind === 'walk' ? 'Переход по миру' : source.kind === 'exit'
        ? toZone.key === 'avalon' ? 'Вход в Авалон' : fromZone.key === 'avalon' ? 'Выход из Авалона' : 'Портал'
        : 'Портал';
      const meta = [];
      if (isPortal) {
        if (capMax !== null) meta.push(`Места: ${capNum === null ? '?' : capNum} / ${capMax}`);
        else if (capNum !== null) meta.push(`Мест свободно: ${capNum} · вместимость неизвестна`);
        meta.push(expiresAt === null ? 'Время закрытия неизвестно' : `Закрытие: ${timestamp(expiresAt)}`);
      }
      if (waitSec > 0) meta.push(`Ожидание: ~${duration(waitSec)}`);
      const warning = expired ? 'Портал уже закрылся' : risky ? 'Риск: времени может не хватить' : null;
      steps.push({ index: index + 1, from, to, kind: source.kind, kindLabel, expiresAt, capNum, capMax, waitSec, etaSec, expired, risky, warning, meta, zone: toZone });
    }
    const from = steps.length ? steps[0].from : name(route.from);
    const to = steps.length ? steps.at(-1).to : name(route.to);
    if ((!steps.length && from !== to) || (route.from != null && name(route.from) !== from) || (route.to != null && name(route.to) !== to)) {
      fail('DISCONNECTED_ROUTE', 'Начало или конец маршрута не совпадает с его шагами. Построй маршрут заново.');
    }
    const etaSec = optionalNumber(route.etaSec, 'общее время в пути', { max: 604800 });
    const expired = steps.some(step => step.expired), risky = route.risky === true || steps.some(step => step.risky);
    const warnings = [];
    if (expired) warnings.push('Есть закрывшиеся порталы. Проверь маршрут перед выходом.');
    else if (risky) warnings.push('Маршрут с риском: можно не успеть к закрытию портала.');
    const portals = steps.filter(step => step.kind !== 'walk').length;
    const summary = [steps.length ? transitionCount(steps.length) : 'Уже на месте', portals ? `Порталов: ${portals}` : '', etaSec !== null && steps.length ? `В пути ~${duration(etaSec)}` : ''].filter(Boolean).join('  ·  ');
    const nodes = [{ index: 0, name: from, label: steps.length ? 'Старт' : 'Старт · финиш', zone: zone(from, zoneInfo), meta: [], warning: null }];
    for (const step of steps) nodes.push({ index: step.index, name: step.to, label: step.kindLabel + (step.index === steps.length ? ' · финиш' : ''), zone: { ...step.zone }, meta: [...step.meta], warning: step.warning });
    return { from, to, steps, nodes, generatedAt, generatedLabel: `${timestamp(generatedAt)} · ${offset(generatedAt)}`, etaSec, risky, expired, warnings, summary };
  }

  function wrap(text, width, size, weight, measure) {
    const lines = [], tokens = String(text).split(/(?<=[\s-])/u);
    let line = '';
    for (const token of tokens) {
      if (measure(line + token, size, weight) <= width) { line += token; continue; }
      if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
      for (const character of Array.from(token.trimStart())) {
        if (measure(character, size, weight) > width) fail('IMAGE_TOO_LARGE', 'Текст маршрута не помещается в изображение с читаемым размером шрифта.');
        if (line && measure(line + character, size, weight) > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    if (line.trim() || !lines.length) lines.push(line.trimEnd());
    return lines;
  }

  function layout(model, measure = (text, size) => Array.from(text).length * size * 0.56) {
    if (!model || !Array.isArray(model.nodes) || !model.nodes.length) fail('INVALID_ROUTE', 'Не удалось подготовить маршрут к экспорту.');
    for (const nameSize of [26, 24, 22]) {
      const textWidth = LIMITS.columnWidth - 134, nameLine = nameSize + 7;
      const headerWarnings = model.warnings.flatMap(text => wrap(text, LIMITS.columnWidth - 80, 17, 500, measure));
      const summaryLines = wrap(model.summary, LIMITS.columnWidth - 80, 18, 400, measure);
      const headerHeight = 124 + summaryLines.length * 26 + (headerWarnings.length ? headerWarnings.length * 24 + 24 : 0);
      const rows = model.nodes.map(node => {
        const nameLines = wrap(node.name, textWidth, nameSize, 600, measure);
        const labelLines = wrap(node.label.toUpperCase(), textWidth, 13, 600, measure);
        const metaLines = node.meta.flatMap(text => wrap(text, textWidth, 17, 400, measure));
        const warningLines = node.warning ? wrap(node.warning, textWidth, 17, 600, measure) : [];
        const height = 36 + labelLines.length * 19 + nameLines.length * nameLine + (node.zone.label ? 26 : 0)
          + (metaLines.length ? 8 + metaLines.length * 25 : 0) + (warningLines.length ? 8 + warningLines.length * 24 : 0);
        return { ...node, nameLines, labelLines, metaLines, warningLines, height };
      });
      const columns = [];
      let column = { rows: [], height: 0 };
      for (const row of rows) {
        if (column.rows.length && (column.rows.length >= 11 || column.height + row.height > 2350)) {
          columns.push(column); column = { rows: [], height: 0 };
        }
        column.rows.push({ ...row, y: column.height }); column.height += row.height;
      }
      if (column.rows.length) columns.push(column);
      const width = columns.length * LIMITS.columnWidth + (columns.length - 1) * LIMITS.columnGap;
      const bodyTop = headerHeight + 34, bodyHeight = Math.max(...columns.map(item => item.height));
      const footerLines = [
        `Создано ${model.generatedLabel}`,
        'Время устройства. Данные на момент создания. Порталы могут закрыться.',
      ].flatMap(text => wrap(text, Math.min(width - 80, 1050), 15, 400, measure));
      const height = bodyTop + bodyHeight + 42 + footerLines.length * 23 + 24;
      if (width <= LIMITS.side && height <= LIMITS.side && width * height <= LIMITS.pixels) {
        return { width, height, nameSize, nameLine, headerHeight, bodyTop, bodyHeight, columns, summaryLines, headerWarnings, footerLines };
      }
    }
    fail('IMAGE_TOO_LARGE', 'Маршрут слишком большой для читаемого изображения. Раздели его на несколько маршрутов.');
  }

  function rounded(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function font(ctx, size, weight = 400) { ctx.font = `${weight} ${size}px ${FONT}`; }
  function lines(ctx, items, x, y, lineHeight, color, size, weight = 400) {
    font(ctx, size, weight); ctx.fillStyle = color;
    for (const text of items) { ctx.fillText(text, x, y); y += lineHeight; }
    return y;
  }

  async function render(route, { zoneInfo = {}, now = Date.now(), document: providedDocument } = {}) {
    const model = plan(route, zoneInfo, now);
    const doc = providedDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc?.createElement) fail('NO_CANVAS', 'Не удалось создать изображение маршрута.');
    if (doc.fonts?.load) {
      await Promise.all([doc.fonts.load(`600 26px ${FONT}`), doc.fonts.load(`400 17px ${FONT}`)]);
    }
    if (doc.fonts?.ready) await doc.fonts.ready;
    const canvas = doc.createElement('canvas'), ctx = canvas.getContext('2d');
    if (!ctx) fail('NO_CANVAS', 'Не удалось создать изображение маршрута.');
    const geometry = layout(model, (text, size, weight) => { font(ctx, size, weight); return ctx.measureText(text).width; });
    canvas.width = geometry.width; canvas.height = geometry.height;
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.background; ctx.fillRect(0, 0, canvas.width, canvas.height);
    rounded(ctx, 0.5, 0.5, canvas.width - 1, canvas.height - 1, 18, null, C.border);
    ctx.fillStyle = C.gold; ctx.fillRect(40, 28, 42, 3);
    lines(ctx, ['AVALON MAPPER'], 94, 21, 20, C.gold, 15, 600);
    lines(ctx, ['Маршрут'], 40, 57, 44, C.text, 36, 600);
    let headerY = lines(ctx, geometry.summaryLines, 40, 106, 26, C.muted, 18);
    if (geometry.headerWarnings.length) {
      rounded(ctx, 28, headerY + 9, LIMITS.columnWidth - 56, geometry.headerWarnings.length * 24 + 16, 9, C.dangerBg);
      lines(ctx, geometry.headerWarnings, 40, headerY + 17, 24, C.danger, 17, 500);
    }
    for (const [columnIndex, column] of geometry.columns.entries()) {
      const x = columnIndex * (LIMITS.columnWidth + LIMITS.columnGap);
      const first = column.rows[0].index, last = column.rows.at(-1).index;
      const caption = columnIndex === 0 ? 'СЛЕДУЙ ПО ПОРЯДКУ' : `ПРОДОЛЖЕНИЕ · ШАГИ ${first}–${last} →`;
      lines(ctx, [caption], x + 40, geometry.headerHeight + 4, 20, C.muted, 13, 600);
      for (const [rowIndex, row] of column.rows.entries()) {
        const y = geometry.bodyTop + row.y;
        rounded(ctx, x + 20, y + 5, LIMITS.columnWidth - 40, row.height - 10, 11, C.card);
        const railX = x + 48, circleY = y + 34;
        if (rowIndex < column.rows.length - 1) {
          ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(railX, circleY + 16); ctx.lineTo(railX, y + row.height + 34); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(railX, circleY, 17, 0, Math.PI * 2);
        ctx.fillStyle = row.zone.key === 'black' ? '#171614' : '#2d2923'; ctx.fill();
        ctx.strokeStyle = row.zone.color; ctx.lineWidth = 1.5; ctx.stroke();
        font(ctx, row.index > 99 ? 12 : 15, 600); ctx.fillStyle = row.zone.color; ctx.textAlign = 'center'; ctx.fillText(String(row.index), railX, circleY - 9); ctx.textAlign = 'left';
        let textY = lines(ctx, row.labelLines, x + 88, y + 19, 19, C.gold, 13, 600);
        textY = lines(ctx, row.nameLines, x + 88, textY + 3, geometry.nameLine, row.zone.color, geometry.nameSize, 600);
        if (row.zone.label) textY = lines(ctx, [row.zone.label], x + 88, textY + 2, 26, C.muted, 15);
        if (row.metaLines.length) textY = lines(ctx, row.metaLines, x + 88, textY + 8, 25, C.text, 17);
        if (row.warningLines.length) lines(ctx, row.warningLines, x + 88, textY + 8, 24, C.danger, 17, 600);
      }
    }
    const footerY = geometry.bodyTop + geometry.bodyHeight + 24;
    ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(40, footerY); ctx.lineTo(canvas.width - 40, footerY); ctx.stroke();
    lines(ctx, geometry.footerLines, 40, footerY + 18, 23, C.muted, 15);
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, from: model.from, to: model.to, generatedAt: model.generatedAt };
  }

  return { plan, render, layout, LIMITS };
});
