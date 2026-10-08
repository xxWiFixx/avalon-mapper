const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise production orchestration without Tesseract or synthetic OCR accuracy.
// Only image construction is substituted; duration parsing and voting stay real.
function scenario(answer, { region = true, redVerifier = null } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../lib/portal-timer.js'), 'utf8');
  const calls = [], locations = [], bar = { bx: 100, by: 100, bh: 11, scale: 1 };
  let fullIndex = 0, digitsIndex = 0;
  const imageTools = {
    findTimerText(frame, anchor, top) {
      locations.push(top);
      const available = typeof region === 'function' ? region(top) : region;
      return available ? { top, left: 200, width: 80, height: 15, kind: 'light',
        ...(typeof available === 'object' ? available : {}) } : null;
    },
    async timerImage(frame, selected, prep) { return selected && { type: 'digits', top: selected.top, prep }; },
  };
  const sandbox = {
    module: { exports: {} },
    require(name) {
      if (name === './red-timer' && redVerifier) return { recognizeRedTimer: redVerifier };
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

test('red verification runs before repeated shortened legacy reads and failed verification cannot bypass it', async () => {
  for (const closes of [1891, 0, null]) {
    const s = scenario(() => '1м31с', { region: { kind: 'red' },
      redVerifier: async () => ({ closes, reason: 'test-verification', reads: [], roi: null }) });
    const result = await s.run();
    assert.equal(result.closes, closes);
    assert.equal(result.timerUncertain, closes === null);
    assert.equal(result.raw.redVerification, 'test-verification');
    assert.equal(s.calls.length, 0, 'legacy OCR must not accept the same shortened crop');
  }
});

test('a red closing timer below a cooldown is verified on the second row', async () => {
  const tops = [];
  const s = scenario(() => 'Можно использовать3м49с', {
    region: top => top === 137 ? { kind: 'red' } : false,
    redVerifier: async (_, __, options) => {
      tops.push(options.top); return { closes: 40, reason: 'single', reads: [], roi: null };
    },
  });
  assert.equal((await s.run()).closes, 40);
  assert.deepEqual(tops, [137]);
});

test('a complete 59-second closing timer stops after full context and one independent digit reading', async () => {
  const s = scenario(({ image }) => image.type === 'full' ? 'Закроется через59с' : '59с');
  const result = await s.run();
  assert.equal(result.closes, 59);
  assert.equal(result.timerUncertain, false);
  assert.equal(s.calls.length, 2);
});

test('English game timers retain their units in isolated OCR and need independent confirmation', async () => {
  for (const [text, seconds] of [['5h 36m', 20160], ['49s', 49]]) {
    const s = scenario(({ image, opts }) => {
      const reading = image.type === 'full' ? 'Closes in ' + text : text;
      return opts.whitelist ? [...reading].filter(character => opts.whitelist.includes(character)).join('') : reading;
    });
    const result = await s.run();
    assert.equal(result.closes, seconds);
    assert.equal(result.timerUncertain, false);
    assert.ok(s.calls.some(call => call.image.type === 'digits'));
  }
});

test('a conflicting narrow reading cannot be outvoted by repeating only the wide crop', () => {
  const { confirmed } = require('../lib/portal-timer');
  const vote = (closes, family) => ({ closes, quality: 1, complete: true, family });
  assert.equal(confirmed([vote(49, 'full'), vote(49, 'full'), vote(49, 'digits'), vote(59, 'digits')]), null);
  assert.equal(confirmed([vote(49, 'full'), vote(49, 'full'), vote(49, 'digits'), vote(49, 'digits'), vote(59, 'digits')]), 49);
});

test('independent reads restore a missing hour only when full and isolated evidence agree', () => {
  const { confirmed } = require('../lib/portal-timer');
  const vote = (closes, family, unit, complete, evidenceKey) =>
    ({ closes, family, unit, complete, quality: 1, evidenceKey });
  const hour = 84 * 60;
  assert.equal(confirmed([
    vote(24 * 60, 'full', 'm', true, 'full-a'),
    vote(hour, 'digits', 'hm', false, 'digits-a'),
    vote(hour, 'digits', 'hm', false, 'digits-b'),
    vote(hour, 'full', 'hm', true, 'full-b'),
  ]), hour);
  assert.equal(confirmed([
    vote(13 * 60, 'full', 'm', true, 'full-a'),
    vote(8 * 3600 + 13 * 60, 'digits', 'hm', true, 'digits-a'),
    vote(8 * 3600 + 13 * 60, 'digits', 'hm', true, 'digits-b'),
    vote(8 * 3600 + 13 * 60, 'digits', 'hm', true, 'digits-c'),
  ]), 8 * 3600 + 13 * 60);
  assert.equal(confirmed([
    vote(12 * 60, 'full', 'm', true, 'full-a'),
    vote(8 * 3600 + 13 * 60, 'digits', 'hm', true, 'digits-a'),
    vote(8 * 3600 + 13 * 60, 'digits', 'hm', true, 'digits-b'),
    vote(8 * 3600 + 13 * 60, 'digits', 'hm', true, 'digits-c'),
  ]), null, 'a different minute reading must not be overruled');
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

test('a 40m29s game capture is recognized with map background beyond the tooltip', { timeout: 20000 }, async () => {
  const recognize = require('../lib/recognize');
  const frame = await require('../lib/frame').fromEncoded(fs.readFileSync(path.join(__dirname, 'fixtures/portal-40m29s.png')));
  try {
    await recognize.init();
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await recognize.recognizeTooltip(frame, { screenHeight: 1080 });
      assert.equal(result?.name, 'Huros-Atontum');
      assert.equal(result.closes, 2429);
      assert.equal(result.timerUncertain, false);
      assert.ok(result.raw.redVerification.startsWith('complete-'));
      assert.ok(result.raw.timerReads.some(read => read.family === 'red-blocks' && read.closes === 2429 && read.complete));
      assert.ok(new Set(result.raw.timerReads.filter(read => read.family === 'red-part').map(read => read.mode)).size >= 2);
    }
  } finally { await recognize.shutdown(); }
});

test('a real 31m31s red timer preserves its leading digit in RGBA and native BGRA captures', { timeout: 20000 }, async () => {
  const recognize = require('../lib/recognize'), F = require('../lib/frame');
  const frame = await F.fromEncoded(fs.readFileSync(path.join(__dirname, 'fixtures/portal-red-31m31s.png')));
  const bitmap = Buffer.from(frame.data);
  for (let i = 0; i < bitmap.length; i += 4) { const red = bitmap[i]; bitmap[i] = bitmap[i + 2]; bitmap[i + 2] = red; }
  try {
    await recognize.init();
    for (const input of [frame, F.fromBitmap(bitmap, frame.width, frame.height)]) {
      const result = await recognize.recognizeTooltip(input, { screenHeight: 1080 });
      assert.equal(result?.name, 'Hiros-Iuaerom');
      assert.equal(result.closes, 1891, 'the leading 3 must not be discarded to produce 91 seconds');
      assert.equal(result.timerUncertain, false);
      assert.equal(result.capMax, 7);
      assert.ok(result.raw.redVerification.startsWith('complete-'));
    }
  } finally { await recognize.shutdown(); }
});
