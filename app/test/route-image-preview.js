'use strict';

// Development fixture only: app/test/** is excluded from the packaged application.
(() => {
  const NOW = Date.parse('2026-09-22T12:00:00.000Z');
  const MAX_PIXELS = 24_000_000;
  const MAX_SIDE = 16_000;
  const byId = id => document.getElementById(id);
  const baseInfo = {
    'Qiient-Qi-Odesas': { color: 'avalon', tier: 6 },
    'Coues-Exakrom': { color: 'avalon', tier: 4 },
    'Sectun-Et-Tersas': { color: 'avalon', tier: 6 },
    'Settun-Al-Odetum': { color: 'avalon', tier: 6 },
    'Settun-Odetum': { color: 'avalon', tier: 6 },
    'Murky Fen': { color: 'blue', tier: 4 },
    'Drownhorse Basin': { color: 'yellow', tier: 5 },
    'Windripple Fen': { color: 'blue', tier: 4 },
    'Sleetwater Basin': { color: 'yellow', tier: 5 },
    'Willowsigh Marsh': { color: 'yellow', tier: 5 },
  };

  function makeRoute(names, details = []) {
    let elapsed = 0;
    const steps = names.slice(1).map((to, i) => {
      const detail = details[i] || {};
      const waitSec = detail.waitSec || 0;
      const costSec = 81 + waitSec;
      elapsed += costSec;
      return {
        from: names[i], to, kind: 'portal', capNum: null, capMax: null,
        expiresAt: null, source: 'ocr', risky: false,
        ...detail, waitSec, costSec, etaSec: elapsed,
      };
    });
    const expiring = steps.filter(step => Number.isFinite(step.expiresAt));
    const first = expiring.sort((a, b) => a.expiresAt - b.expiresAt)[0];
    const risky = steps.some(step => step.risky);
    return {
      found: true, from: names[0], to: names[names.length - 1], steps,
      hops: steps.length,
      portalHops: steps.filter(step => step.kind === 'portal').length,
      exitHops: steps.filter(step => step.kind === 'exit').length,
      walkHops: steps.filter(step => step.kind === 'walk').length,
      etaSec: elapsed, etaMin: Math.round(elapsed / 6) / 10,
      costSec: elapsed, arriveAt: NOW + elapsed * 1000, risky,
      reason: risky ? 'Проверь таймеры перед выходом: часть порталов скоро закроется.' : undefined,
      bottleneck: first ? {
        from: first.from, to: first.to, expiresAt: first.expiresAt,
        minutesLeft: Math.round((first.expiresAt - NOW) / 6000) / 10,
      } : null,
    };
  }

  const fixtures = {
    mixed() {
      // The four walking links are present in data-static/world-adjacency.json.
      // Portal links are illustrative: live Road connections are temporary.
      const names = ['Qiient-Qi-Odesas', 'Coues-Exakrom', 'Murky Fen',
        'Drownhorse Basin', 'Windripple Fen', 'Sleetwater Basin', 'Willowsigh Marsh'];
      return {
        description: 'Реальные имена зон: один портал по Авалону, выход в мир и четыре соседние зоны пешком. Должны быть видны все семь зон и два портала.',
        route: makeRoute(names, [
          { capNum: 3, capMax: 7, expiresAt: NOW + 2 * 3600_000 },
          { kind: 'exit', capNum: 11, capMax: 20, expiresAt: NOW + 35 * 60_000 },
          ...Array.from({ length: 4 }, () => ({ kind: 'walk', source: 'world' })),
        ]),
        zoneInfo: { ...baseInfo },
      };
    },
    enter() {
      return {
        description: 'Murky Fen → Coues-Exakrom — kind: exit, но направление ведёт внутрь Авалона. Оба перехода должны называться порталами.',
        route: makeRoute(['Murky Fen', 'Coues-Exakrom', 'Qiient-Qi-Odesas'], [
          { kind: 'exit', capNum: 0, capMax: 20, expiresAt: NOW + 3 * 3600_000 },
          { capNum: 6, capMax: 7, expiresAt: NOW + 93 * 60_000 },
        ]),
        zoneInfo: { ...baseInfo },
      };
    },
    timers() {
      return {
        description: 'Четыре портала: закрыт 30 секунд назад; закроется через 45 секунд; таймер и вместимость неизвестны; известный таймер с waitSec: 95. Образец намеренно содержит уже непроходимый путь.',
        route: makeRoute(['Qiient-Qi-Odesas', 'Coues-Exakrom', 'Sectun-Et-Tersas', 'Settun-Al-Odetum', 'Settun-Odetum'], [
          { capNum: 7, capMax: 7, expiresAt: NOW - 30_000, risky: true },
          { capNum: 1, capMax: 20, expiresAt: NOW + 45_000, risky: true },
          { capNum: null, capMax: null, expiresAt: null },
          { capNum: 0, capMax: 7, expiresAt: NOW + 17 * 60_000, waitSec: 95 },
        ]),
        zoneInfo: { ...baseInfo },
      };
    },
    long() {
      const names = Array.from({ length: 26 }, (_, i) =>
        i % 3 === 0 ? `Long-Synthetic-Avalonian-Highlands-Section-${String(i + 1).padStart(2, '0')}`
          : `Synthetic-${String(i + 1).padStart(2, '0')}-Through-The-Misty-Mountain-Passage`);
      return {
        description: '25 переходов и 26 искусственных зон с длинными именами. Проверка трёх колонок, переносов текста, последовательности и продолжения маршрута на границах колонок.',
        route: makeRoute(names, names.slice(1).map((_, i) => ({
          capNum: i % 7, capMax: i % 4 === 0 ? 20 : 7,
          expiresAt: NOW + (60 + i * 7) * 60_000,
        }))),
        zoneInfo: Object.fromEntries(names.map((name, i) => [name, { color: 'avalon', tier: 4 + i % 5 }])),
        expectedColumns: 3,
      };
    },
    max() {
      const names = Array.from({ length: 101 }, (_, i) =>
        (`Synthetic-${String(i).padStart(3, '0')}-` + 'Very-Long-Avalonian-Zone-Name-'.repeat(12)).slice(0, 240));
      return {
        description: '100 переходов и 101 уникальное искусственное имя ровно по 240 символов. Проверка предельного Canvas, ограничений площади и размеров, переноса имён и последней зоны.',
        route: makeRoute(names, names.slice(1).map((_, i) => ({
          capNum: i % 7, capMax: i % 2 ? 7 : 20,
          expiresAt: NOW + (240 + i) * 60_000,
        }))),
        zoneInfo: Object.fromEntries(names.map(name => [name, { color: 'avalon', tier: 8 }])),
        expectedNameLength: 240,
      };
    },
  };

  let serial = 0;
  function status(state, message) {
    byId('status').dataset.state = state;
    byId('status').textContent = `${state.toUpperCase()}: ${message}`;
  }

  async function render() {
    const run = ++serial;
    const key = byId('fixture').value;
    const fixture = fixtures[key]();
    const { route, zoneInfo } = fixture;
    const names = [route.steps[0].from, ...route.steps.map(step => step.to)];
    const maxNameLength = Math.max(...names.map(name => name.length));
    byId('description').textContent = fixture.description;
    byId('step-count').textContent = `${route.steps.length} / ${names.length}`;
    byId('name-length').textContent = `${maxNameLength} символов`;
    for (const id of ['dimensions', 'image-size', 'generated-at', 'font-state']) byId(id).textContent = '—';
    byId('checks').textContent = 'Ограничения: сторона не более 16 000 px, площадь не более 24 MP.';
    byId('download').hidden = true;
    byId('download').removeAttribute('href');
    byId('preview').hidden = true;
    byId('preview').removeAttribute('src');
    byId('stage').setAttribute('aria-busy', 'true');
    byId('render').disabled = true;
    status('rendering', 'Создаю PNG настоящим Canvas браузера…');
    const started = performance.now();
    try {
      if (typeof window.RouteImage?.render !== 'function') throw new Error('RouteImage.render не загружен. Проверь наличие app/ui/route-image.js и обнови страницу.');
      // Use the same font-face declarations as ui/style.css. Production declares
      // 400/500/700; requests for weight 600 resolve to that same Fira Sans family.
      const faces = await Promise.all([400, 500, 600].map(weight =>
        document.fonts.load(`${weight} 26px "Fira Sans"`, 'Маршрут Qiient-Qi-Odesas 123')));
      if (faces.some(list => !list.length)) throw new Error('Fira Sans не загружен: проверка геометрии на запасном шрифте недостоверна.');
      await document.fonts.ready;
      if (run !== serial) return;
      byId('font-state').textContent = 'Fira Sans · 400 / 500 / 600';
      const result = await window.RouteImage.render(route, { zoneInfo, now: NOW });
      if (run !== serial) return;
      if (!result || !/^data:image\/png;base64,/.test(result.dataUrl || '')) throw new Error('render не вернул PNG data URL.');
      const image = new Image();
      image.src = result.dataUrl;
      await image.decode();
      if (run !== serial) return;
      const { naturalWidth: width, naturalHeight: height } = image;
      const columns = (width + 24) / (760 + 24);
      const failures = [];
      if (width !== result.width || height !== result.height) failures.push('размеры PNG не совпадают с результатом render');
      if (!Number.isInteger(columns) || columns < 1) failures.push('ширина не соответствует колонкам 760 px и зазорам 24 px');
      if (fixture.expectedColumns && columns !== fixture.expectedColumns) failures.push(`ожидалось ${fixture.expectedColumns} колонки`);
      if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) failures.push('превышен лимит размера Canvas');
      if (fixture.expectedNameLength && !names.every(name => name.length === fixture.expectedNameLength)) failures.push('ошибка длины имён в образце');
      if (result.from !== names[0] || result.to !== names[names.length - 1]) failures.push('не совпадают начало или конец маршрута');
      if (result.generatedAt !== NOW) failures.push('generatedAt не совпадает с переданным now');
      byId('dimensions').textContent = `${width} × ${height} px`;
      byId('image-size').textContent = `${Number.isInteger(columns) ? columns : '?'} / ${(width * height / 1_000_000).toFixed(2)} MP`;
      byId('generated-at').textContent = new Date(result.generatedAt).toISOString();
      const preview = byId('preview');
      preview.src = result.dataUrl;
      preview.alt = `Образец ${key}: ${route.steps.length} переходов, ${names.length} зон.`;
      preview.hidden = false;
      byId('stage').scrollLeft = 0;
      byId('stage').scrollTop = 0;
      const download = byId('download');
      download.href = result.dataUrl;
      download.download = `route-image-${key}-${width}x${height}.png`;
      download.hidden = false;
      byId('checks').textContent = failures.length
        ? 'Проверки: ' + failures.join('; ') + '.'
        : 'Проверки: PNG декодирован; размеры, ограничения Canvas, начало и конец маршрута и время создания совпадают.';
      const duration = Math.round(performance.now() - started);
      status(failures.length ? 'error' : 'ready', `${route.steps.length} переходов; ${width} × ${height} px; ${duration} мс.${failures.length ? ' Есть расхождения — смотри проверки ниже.' : ' Можно скачать PNG.'}`);
    } catch (error) {
      if (run === serial) status('error', error?.stack || String(error));
    } finally {
      if (run === serial) {
        byId('stage').setAttribute('aria-busy', 'false');
        byId('render').disabled = false;
      }
    }
  }

  const initial = new URLSearchParams(location.search).get('fixture');
  if (Object.hasOwn(fixtures, initial)) byId('fixture').value = initial;
  byId('render').addEventListener('click', render);
  byId('fixture').addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('fixture', byId('fixture').value);
    history.replaceState(null, '', url);
    render();
  });
  byId('fit').addEventListener('change', () => byId('stage').classList.toggle('fit', byId('fit').checked));
  render();
})();
