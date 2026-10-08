const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { parseBlock, parseSingle, corroborated } = require('../lib/red-timer');

// These cases exercise conservation of visible glyphs and unresolved conflicts.
// Real OCR is also covered by the archived regression fixture.
function scenario(count, answer) {
  const calls = [], glyphs = Array.from({ length: count }, (_, i) => ({ left: 300 + i * 12, top: 40, width: 7, height: 15 }));
  const imageTools = {
    findRedTimerGlyphs: () => ({ roi: { left: 298, top: 38, width: count * 12, height: 19 }, glyphs }),
    joinGlyphs: require('../lib/red-timer-image').joinGlyphs,
    redTimerImage: async (_, box, mode) => ({ ...box, mode }),
  };
  const sandbox = { module: { exports: {} }, require: name => {
    assert.equal(name, './red-timer-image'); return imageTools;
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/red-timer.js'), 'utf8'), sandbox);
  return { calls, run: () => sandbox.module.exports.recognizeRedTimer({}, {}, {
    ocr: async (image, options) => {
      const call = { image, options, index: calls.length }; calls.push(call); return answer(call);
    },
  }) };
}

test('a visible extra leading digit cannot be silently dropped by repeated block or digit OCR', async () => {
  const s = scenario(6, ({ image }) => {
    if (image.left >= 359) return 'с';
    if (image.left >= 335) return image.width > 20 ? '31с' : '31';
    if (image.left >= 323) return 'м';
    return image.width > 20 ? '1м' : '1';
  });
  const actual = await s.run();
  assert.equal(actual.closes, null, 'six glyphs cannot establish the five-glyph duration 1m31s');
  assert.equal(actual.reason, 'unconfirmed-blocks');
});

test('complete blocks establish 31m31s before legacy shortened readings can be used', async () => {
  const s = scenario(6, ({ image }) => image.left < 330 ? '31м' : '31с');
  const actual = await s.run();
  assert.equal(actual.closes, 1891);
  assert.equal(actual.reason, 'complete-minute-second-blocks-fast-path');
  assert.equal(s.calls.length, 4);
});

test('unresolved block disagreement after detailed rereading stays unknown', async () => {
  const s = scenario(6, ({ image, options, index }) => {
    if (index < 6) return image.left < 330 ? ['31м', '32м', ''][Math.floor(index / 2)] : '31с';
    if (image.left >= 359) return 'с';
    if (image.left >= 335) return image.width > 20 ? '31с' : '31';
    if (image.left >= 323) return 'м';
    const value = options.psm === 7 ? '31' : '32';
    return image.width > 20 ? value + 'м' : value;
  });
  assert.equal((await s.run()).closes, null);
});

test('single seconds, minutes and zero remain complete durations without invented extra units', async () => {
  for (const [text, count, expected] of [['40с', 3, 40], ['40s', 3, 40], ['1м', 2, 60], ['0с', 2, 0]]) {
    const s = scenario(count, () => text);
    const actual = await s.run();
    assert.equal(actual.closes, expected, text);
    assert.equal(actual.reason, 'complete-single-block-fast-path');
  }
});

test('units and exact digit count are required, and range violations are not shortened', () => {
  for (const text of ['31', '3 1', '31ч', '60м', '-1м', '3.1м']) assert.equal(parseBlock(text, 2, 'm'), null, text);
  assert.equal(parseBlock('1м', 2, 'm'), null);
  assert.equal(parseBlock('31 Мм', 2, 'm'), 31);
  assert.equal(parseBlock('31 S', 2, 's'), 31);
  for (const text of ['40', '60с', '25ч', '1м40с', '-1с']) assert.equal(parseSingle(text, 2), null, text);
  assert.equal(parseSingle('17ч', 2), 61200);
  assert.equal(parseSingle('0с', 1), 0);
  assert.equal(parseSingle('Sc', 1), 5, 'a numeric S can be five without replacing an English seconds unit');
  assert.equal(parseSingle('5S', 1), 5);
});

test('repeating page segmentation on the same processed view cannot create corroboration', () => {
  assert.equal(corroborated([{ mode: 'soft', value: 31 }, { mode: 'soft', value: 31 }]), null);
  assert.equal(corroborated([{ mode: 'soft', value: 0 }, { mode: 'gray', value: 0 }]), 0);
  assert.equal(corroborated([{ mode: 'soft', value: 31 }, { mode: 'gray', value: 32 }]), null);
});
