const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise production orchestration without Tesseract or synthetic OCR accuracy.
// Only image construction is substituted; duration parsing and voting stay real.
function scenario(answer, { region = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../lib/portal-timer.js'), 'utf8');
  const calls = [], locations = [], bar = { bx: 100, by: 100, bh: 11, scale: 1 };
  let fullIndex = 0, digitsIndex = 0;
  const imageTools = {
    findTimerText(frame, anchor, top) {
      locations.push(top);
      const available = typeof region === 'function' ? region(top) : region;
      return available ? { top, left: 200, width: 80, height: 15, kind: 'light' } : null;
    },
    async timerImage(frame, selected, prep) { return selected && { type: 'digits', top: selected.top, prep }; },
  };
  const sandbox = {
    module: { exports: {} },
    require(name) {
      return name === './timer-image' ? imageTools : require(path.join(__dirname, '../lib', name));
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'portal-timer.js' });
  const run = () => sandbox.module.exports.recognizeTimer({}, bar, {
    async crop(frame, left, top, width, height, prep) { return { type: 'full', left, top, width, height, prep }; },
    async ocr(image, opts) {
      const kindIndex = image.type === 'digits' ? digitsIndex++ : fullIndex++;
      const call = { image, opts, index: calls.length, kindIndex };
      calls.push(call);
      return answer(call) || '';
    },
  });
  return { run, calls, locations };
}

test('a complete 59-second closing timer stops after full context and one independent digit reading', async () => {
  const s = scenario(({ image }) => image.type === 'full' ? 'Закроется через59с' : '59с');
  const result = await s.run();
  assert.equal(result.closes, 59);
  assert.equal(result.timerUncertain, false);
  assert.equal(s.calls.length, 2);
});

test('a conflicting narrow reading cannot be outvoted by repeating only the wide crop', () => {
  const { confirmed } = require('../lib/portal-timer');
  const vote = (closes, family) => ({ closes, quality: 1, complete: true, family });
  assert.equal(confirmed([vote(49, 'full'), vote(49, 'full'), vote(49, 'digits'), vote(59, 'digits')]), null);
  assert.equal(confirmed([vote(49, 'full'), vote(49, 'full'), vote(49, 'digits'), vote(49, 'digits'), vote(59, 'digits')]), 49);
});

test('49 versus 59 seconds remains unknown without corroboration', async () => {
  const s = scenario(({ image, kindIndex }) => kindIndex === 0
    ? image.type === 'full' ? 'Закроется через49с' : '59с' : '');
  const result = await s.run();
  assert.equal(result.closes, null);
  assert.equal(result.timerUncertain, true);
});

test('independent rereadings can corroborate the lower short timer rather than extending it', async () => {
  const s = scenario(({ image, kindIndex }) => image.type === 'full'
    ? 'Закроется через49с' : ['59с', '49с', '49с'][kindIndex]);
  const result = await s.run();
  assert.equal(result.closes, 49);
  assert.equal(result.timerUncertain, false);
  assert.equal(s.calls.length, 4);
});

test('lost-unit glyphs cannot produce a confident short timer from a damaged longer one', async () => {
  const s = scenario(({ image, kindIndex }) => image.type === 'full'
    ? 'Закроется через5 59с' : ['5м59', 'ч5 м', '10 Ч ОТ M', '5 59с'][kindIndex]);
  const result = await s.run();
  assert.equal(result.closes, null);
  assert.equal(result.timerUncertain, true);
});

test('an unreadable closing label after a cooldown keeps targeted rereads on that same row', async () => {
  const s = scenario(({ image }) => image.type === 'full'
    ? 'Можно использовать3м49с Закроется через???' : '5м59с');
  const result = await s.run();
  assert.equal(result.closes, 359);
  assert.equal(result.timerUncertain, false);
  assert.ok(s.calls.every(call => call.image.top === 113));
});

test('a cooldown-only first row is replaced by the second row closing time', async () => {
  const s = scenario(({ image }) => image.top === 113 ? 'Можно использовать3м49с'
    : image.type === 'full' ? 'Закроется через59с' : '59с');
  const result = await s.run();
  assert.equal(result.closes, 59);
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.calls.map(call => call.image.top), [113, 137, 137]);
});

test('one unsupported complete digit reading cannot bypass confirmation through fallback', async () => {
  const s = scenario(({ image, kindIndex }) => image.type === 'digits' && kindIndex === 0 ? '59с' : '');
  const result = await s.run();
  assert.equal(result.closes, null);
  assert.equal(result.timerUncertain, true);
});

test('a cooldown first recognized by a later unrestricted pass still advances to the closing row', async () => {
  const s = scenario(({ image, kindIndex }) => {
    if (image.top === 137) return image.type === 'full' ? 'Закроется через59с' : '59с';
    return kindIndex === 0 ? '3м49с' : 'Можно использовать3м49с';
  }, { region: top => top === 137 });
  const result = await s.run();
  assert.equal(result.closes, 59);
  assert.equal(result.timerUncertain, false);
  assert.ok(s.calls.some(call => call.image.top === 137));
});

test('a new third digits-only value cannot silently replace several full closing-label readings', async () => {
  const s = scenario(({ image, kindIndex, opts }) => image.type === 'full'
    ? kindIndex < 4 ? opts.whitelist ? '49с' : 'Закроется через49с' : ''
    : ['59с', '39с', '39с', ''][kindIndex]);
  const result = await s.run();
  assert.equal(result.closes, null);
  assert.equal(result.timerUncertain, true);
});
