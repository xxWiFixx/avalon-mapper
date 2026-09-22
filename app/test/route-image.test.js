const assert = require('node:assert/strict');
const { test } = require('node:test');
const { plan, layout, render, LIMITS } = require('../ui/route-image');

const NOW = new Date(2026, 8, 22, 16, 21, 30).getTime();
const step = (from, to, kind = 'walk', extra = {}) => ({ from, to, kind, ...extra });
const route = steps => ({ found: true, steps, etaSec: 300 });
const measure = (text, size) => Array.from(text).length * size * 0.6;

test('a disconnected or missing path is rejected rather than silently repaired', () => {
  for (const invalid of [null, { found: false, steps: [] }, { found: true }, route([step('A', 'B'), step('C', 'D')]),
    { ...route([step('A', 'B')]), from: 'Different' }]) {
    assert.throws(() => plan(invalid, {}, NOW), error => ['NO_ROUTE', 'DISCONNECTED_ROUTE'].includes(error.code));
  }
  assert.throws(() => plan(route([]), {}, NOW), /название/);
  assert.throws(() => plan({ ...route([]), from: 'A', to: 'B' }, {}, NOW), /не совпадает/);
  const here = plan({ ...route([]), from: 'Brecilien', to: 'Brecilien' }, {}, NOW);
  assert.equal(here.nodes.length, 1);
  assert.equal(here.nodes[0].label, 'Старт · финиш');
});

test('every walking node remains in order and input route and zone metadata remain unchanged', () => {
  const original = route([step('A', 'B'), step('B', 'C'), step('C', 'D', 'portal', { capNum: 5, capMax: 7 })]);
  const info = { A: { color: 'city', tier: 4 }, B: { color: 'blue' }, C: { color: 'black' }, D: { color: 'avalon', tier: 6 } };
  const before = JSON.stringify({ original, info });
  const result = plan(original, info, NOW);
  assert.deepEqual(result.nodes.map(node => node.name), ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.nodes.map(node => node.index), [0, 1, 2, 3]);
  assert.deepEqual(result.steps.map(node => node.kind), ['walk', 'walk', 'portal']);
  assert.equal(result.nodes[3].zone.label, 'T6 · Авалон');
  result.nodes[3].zone.color = 'changed'; result.steps[0].to = 'changed';
  assert.equal(JSON.stringify({ original, info }), before);
});

test('portal expiry is absolute to the second, unknown is explicit, and expired or risky portals warn', () => {
  const result = plan(route([
    step('A', 'B', 'portal', { expiresAt: NOW - 1000, capNum: 0, capMax: 20 }),
    step('B', 'C', 'portal', { capMax: 7 }),
    step('C', 'D', 'exit', { expiresAt: NOW + 30000, etaSec: 60 }),
  ]), {}, NOW);
  assert.equal(result.steps[0].expired, true);
  assert.equal(result.steps[0].warning, 'Портал уже закрылся');
  assert.ok(result.steps[0].meta.includes('Места: 0 / 20'));
  assert.ok(result.steps[0].meta.includes('Закрытие: 22.09.2026 16:21:29'));
  assert.ok(result.steps[1].meta.includes('Время закрытия неизвестно'));
  assert.ok(result.steps[1].meta.includes('Места: ? / 7'));
  assert.equal(result.steps[2].risky, true);
  assert.equal(result.risky, true);
  assert.equal(result.generatedAt, NOW);
  assert.match(result.generatedLabel, /22\.09\.2026 16:21:30 · UTC[+−]\d{2}:\d{2}/);
  assert.ok(result.steps.every(item => item.meta.every(text => !text.includes('через'))));
});

test('bidirectional exit edges use zone context rather than falsely calling every portal an exit', () => {
  const result = plan(route([step('City', 'Avalon', 'exit'), step('Avalon', 'World', 'exit')]), {
    City: 'cityblue', Avalon: { color: 'avalon' }, World: 'red',
  }, NOW);
  assert.equal(result.steps[0].kindLabel, 'Вход в Авалон');
  assert.equal(result.steps[1].kindLabel, 'Выход из Авалона');
  assert.equal(result.nodes[0].zone.key, 'city');
});

test('invalid names, capacities, times and step kinds fail with actionable errors', () => {
  const invalidSteps = [step('', 'B'), step('A', 'B', 'teleport'), step('A', 'B', 'portal', { capNum: 8, capMax: 7 }),
    step('A', 'B', 'portal', { capMax: NaN }), step('A', 'B', 'portal', { expiresAt: Infinity }), step('A', 'B', 'walk', { waitSec: -5 })];
  for (const item of invalidSteps) assert.throws(() => plan(route([item]), {}, NOW), error => error.code === 'INVALID_ROUTE');
  assert.throws(() => plan(route([step('A'.repeat(241), 'B')]), {}, NOW), error => error.code === 'NAME_TOO_LONG');
  assert.throws(() => plan(route([step('A', 'B')]), {}, NaN), /время/);
  assert.equal(plan(route([step('A\n\u202e B', 'C')]), {}, NOW).from, 'A B');
});

test('long routes flow to columns with every step once and remain within backend pixel limits', () => {
  const steps = Array.from({ length: 100 }, (_, i) => step(`Zone-${i}`, `Zone-${i + 1}`, i % 2 ? 'walk' : 'portal'));
  const result = layout(plan(route(steps), {}, NOW), measure);
  assert.ok(result.columns.length > 1);
  assert.equal(result.width, result.columns.length * LIMITS.columnWidth + (result.columns.length - 1) * LIMITS.columnGap);
  assert.deepEqual(result.columns.flatMap(column => column.rows.map(row => row.index)), Array.from({ length: 101 }, (_, i) => i));
  assert.ok(result.width <= LIMITS.side && result.height <= LIMITS.side && result.width * result.height <= LIMITS.pixels);
  assert.ok(result.nameSize >= 22);
  assert.throws(() => plan(route([...steps, step('Zone-100', 'Zone-101')]), {}, NOW), error => error.code === 'ROUTE_TOO_LONG');
});

test('full long names wrap by measured width without ellipsis and an oversized layout fails explicitly', () => {
  const long = 'Long-name-' + 'VeryLongUnbrokenLocation'.repeat(8);
  const result = layout(plan(route([step('Start', long)]), {}, NOW), measure);
  const destination = result.columns[0].rows[1];
  assert.ok(destination.nameLines.length > 1);
  assert.equal(destination.nameLines.join(''), long);
  assert.ok(destination.nameLines.every(line => measure(line, result.nameSize) <= LIMITS.columnWidth - 134));
  assert.throws(() => layout(plan(route([step('A', 'B')]), {}, NOW), () => 1e9), error => error.code === 'IMAGE_TOO_LARGE');
});

test('pathological maximum-length names cannot create an image over the pixel budget', () => {
  const names = Array.from({ length: 101 }, (_, index) => 'W'.repeat(234) + '-' + index);
  const steps = names.slice(1).map((to, index) => step(names[index], to, 'portal', { expiresAt: 0, capNum: 5, capMax: 20 }));
  const model = plan(route(steps), {}, NOW);
  assert.equal(model.steps.length, 100);
  assert.throws(() => layout(model, (text, size) => text.length * size * 0.95), error => error.code === 'IMAGE_TOO_LARGE');
});

test('render waits for fonts, uses a bounded canvas, and returns a PNG with endpoints and timestamp', async () => {
  const events = [], context = new Proxy({
    measureText(text) { return { width: text.length * 12 }; },
  }, { get(target, key) { return key in target ? target[key] : () => {}; }, set(target, key, value) { target[key] = value; return true; } });
  const canvas = { width: 0, height: 0, getContext: () => context, toDataURL(type) { assert.equal(type, 'image/png'); return 'data:image/png;base64,fixture'; } };
  let releaseFonts;
  const ready = new Promise(resolve => { releaseFonts = resolve; });
  const document = { fonts: { load: async () => { events.push('font'); }, ready }, createElement(tag) { assert.equal(tag, 'canvas'); events.push('canvas'); return canvas; } };
  const pending = render(route([step('A', 'B')]), { now: NOW, document });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events.includes('canvas'), false, 'font readiness is awaited before measuring names');
  releaseFonts();
  const result = await pending;
  assert.equal(events.at(-1), 'canvas');
  assert.equal(result.dataUrl, 'data:image/png;base64,fixture');
  assert.equal(result.from, 'A'); assert.equal(result.to, 'B'); assert.equal(result.generatedAt, NOW);
  assert.equal(result.width, 760);
  assert.ok(result.width * result.height <= LIMITS.pixels);
});
