'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../lib/recognize.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function extract(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `production function ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end);
  return source.slice(start, start + end.index + end[0].length);
}

const frame = { width: 320, height: 180, bgra: true, data: Buffer.alloc(320 * 180 * 4) };
const baseTip = () => ({ name: 'Pures-Ouozlum', color: 'avalon', tier: 4, quality: null,
  capMax: 20, capNum: 11, capMaxKnown: true, capNumApprox: true, closes: 3600, timerUncertain: false,
  raw: { name: 'Pures-Ouozlum', cap: '11/20', capReads: ['11/20', '11/20'],
    bar: { bx: 20, by: 70, bh: 11, scale: 1, fill: 105, span: 195 }, timerReads: [{ text: '1ч', family: 'full' }] } });

// Run the actual public wrapper and lazy factory with deterministic dependencies.
// This checks the production seam without starting a native OCR worker.
function harness({ baseline = baseTip(), recover = async (_, tip) => ({ portal: tip, diagnostics: { version: 5 } }), baseError } = {}) {
  const events = [], calls = [], deadlines = [], warnings = [], factories = [];
  const helpers = { DICT: ['Pures-Ouozlum'], NAME_TWINS: new Map(), resolveTwin: name => name,
    zoneInfo: () => ({ color: 'avalon', tier: 4, quality: null }), findBarCands: () => [], crop: async () => Buffer.from('crop') };
  const ocr = async () => '';
  const ctx = vm.createContext({ ...helpers, ocr, portalRecovery: null, module: { exports: {} },
    init() {}, shutdown() {}, recognizeZone() {}, findBar() {}, fuzzyMatch() {}, fuzzyFromLine() {},
    parseDur() {}, allDurations() {}, sameNumber() {}, MAX_HOURS: 24, ZONE_INFO: new Map(),
    console: { warn: (...args) => warnings.push(args) },
    F: { toFrame: async input => { events.push('frame'); assert.equal(input, frame); return input; } },
    engine: { withDeadline: (fn, ms) => { deadlines.push(ms); return fn(); } },
    recognizeTooltip: async (input, options) => {
      assert.equal(input, frame); events.push('baseline');
      if (baseError) throw baseError;
      if (baseline && options.onName) {
        // The original baseline reader guards callback exceptions itself.
        try { options.onName({ name: baseline.name, color: baseline.color, tier: baseline.tier, quality: baseline.quality }); }
        catch (_) {}
      }
      return baseline;
    },
    require: id => { assert.equal(id, './portal-recovery'); return { createRecovery: passed => {
      factories.push(passed);
      for (const [name, helper] of Object.entries(helpers)) assert.equal(passed[name], helper, name);
      return { recover: async (...args) => { events.push('recovery'); calls.push(args); return recover(...args); } };
    } }; },
  });
  vm.runInContext(extract('getPortalRecovery') + '\n' + extract('recognizePortal') + '\n'
    + source.slice(source.lastIndexOf('\nmodule.exports = {')), ctx);
  return { events, calls, deadlines, warnings, factories, baseline, ocr,
    run: options => ctx.module.exports.recognizeTooltip(frame, options) };
}

test('the public portal path retains its 12s deadline, one lazy runtime and original early name preview', async () => {
  const seen = [], h = harness({ recover: async (input, tip, options) => {
    assert.equal(input, frame);
    assert.equal(seen.length, 1, 'name arrived before verification');
    assert.equal(options.screenHeight, 2160, 'crop height must not replace physical screen height');
    assert.equal(options.excludeEpisode, 'held-out-episode');
    assert.equal(options.includeDiagnostics, true);
    assert.equal(options.ocr, h.ocr);
    return { portal: { ...tip, closes: 7200, timerUncertain: false }, diagnostics: { version: 5, stage: 'verified' } };
  } });
  const tip = await h.run({ screenHeight: 2160, recoveryExcludeEpisode: 'held-out-episode', recoveryDiagnostics: true,
    onName: value => { seen.push(plain(value)); h.events.push('name'); } });
  assert.deepEqual(h.events, ['frame', 'baseline', 'name', 'recovery']);
  assert.deepEqual(h.deadlines, [12000]);
  assert.equal(tip.closes, 7200); assert.equal(tip.timerUncertain, false);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['color', 'name', 'quality', 'tier']);
  // A second frame reuses the module factory, never the per-frame OCR results.
  await h.run({ screenHeight: 2160, recoveryExcludeEpisode: 'held-out-episode', recoveryDiagnostics: true });
  assert.equal(h.factories.length, 1); assert.equal(h.calls.length, 2);
});

test('timer verification cannot replace an established name, capacity or raw numeric evidence', async () => {
  const baseline = baseTip(), original = plain(baseline);
  const h = harness({ baseline, recover: async () => ({ portal: { name: 'Other-Portal', capMax: 7, capNum: 7,
    capMaxKnown: true, capNumApprox: false, closes: 80, timerUncertain: false, raw: { capReads: ['7/7'] } },
    diagnostics: { version: 5, stage: 'timer-recovered' } }) });
  const tip = await h.run();
  for (const key of ['name', 'color', 'tier', 'quality', 'capMax', 'capNum', 'capMaxKnown', 'capNumApprox'])
    assert.equal(tip[key], baseline[key], key);
  assert.deepEqual(plain(tip.raw.capReads), baseline.raw.capReads);
  assert.deepEqual(plain(tip.raw.bar), baseline.raw.bar);
  assert.equal(tip.closes, 80); assert.equal(tip.timerUncertain, false);
  assert.deepEqual(plain(baseline), original, 'caller baseline was not mutated');
});

test('a missing or rejected recovered timer clears the old number while retaining known capacity', async () => {
  const h = harness({ recover: async () => ({ portal: null, diagnostics: { version: 5, stage: 'conflict-refused' } }) });
  const tip = await h.run();
  assert.equal(tip.name, h.baseline.name); assert.equal(tip.capMax, 20);
  assert.equal(tip.closes, null); assert.equal(tip.timerUncertain, true);
  assert.equal(tip.raw.portalRecovery.stage, 'conflict-refused');
});

test('verification errors including OCR timeout fail closed on time and permit subsequent calls', async () => {
  for (const code of ['OCR_TIMEOUT', 'MODEL_UNAVAILABLE']) {
    let calls = 0;
    const h = harness({ recover: async (_, tip) => {
      if (++calls === 1) throw Object.assign(new Error('verification failed'), { code });
      return { portal: { ...tip, closes: 125, timerUncertain: false }, diagnostics: { version: 5, stage: 'verified' } };
    } });
    const failed = await h.run();
    assert.equal(failed.closes, null); assert.equal(failed.timerUncertain, true);
    assert.equal(failed.capNum, 11); assert.equal(failed.capMaxKnown, true);
    assert.equal(failed.raw.portalRecovery.reason, code);
    assert.equal((await h.run()).closes, 125);
    assert.equal(h.factories.length, 1);
  }
  const absent = harness({ baseline: null, recover: async () => { throw new Error('unavailable'); } });
  assert.equal(await absent.run(), null, 'no invented portal after a recovery failure');
});

test('a newly confirmed card can publish its name before time is ready and tolerate a closed preview', async () => {
  const seen = [], recovered = { ...baseTip(), closes: null, timerUncertain: true };
  const h = harness({ baseline: null, recover: async (_, tip, options) => {
    assert.equal(tip, null);
    options.onName({ name: recovered.name, color: recovered.color, tier: recovered.tier, quality: recovered.quality });
    assert.equal(seen.length, 1);
    return { portal: recovered, diagnostics: { version: 5, stage: 'timer-not-confirmed' } };
  } });
  const tip = await h.run({ onName: value => { seen.push(value); throw new Error('overlay closed'); } });
  assert.equal(seen.length, 1); assert.equal(tip.name, recovered.name);
  assert.equal(tip.closes, null); assert.equal(tip.timerUncertain, true); assert.equal(tip.capMax, 20);
  assert.equal(h.warnings.length, 1);
});

test('baseline failure remains an error and cannot silently enter recovery with an unconfirmed identity', async () => {
  const error = Object.assign(new Error('baseline timed out'), { code: 'OCR_TIMEOUT' });
  const h = harness({ baseError: error });
  await assert.rejects(h.run(), { code: 'OCR_TIMEOUT' });
  assert.equal(h.calls.length, 0);
});

function runtime() {
  const R = require('../lib/recognize');
  return require('../lib/portal-recovery').createRecovery({ DICT: R.DICT, NAME_TWINS: R.NAME_TWINS,
    resolveTwin: R.resolveTwin, zoneInfo: R.zoneInfo, findBarCands: R._internal.findBarCands, crop: R._internal.crop });
}

function syntheticFrame(scale = 1, bgra = false, gold = false) {
  const width = 440 * scale, height = 180 * scale, data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const filled = gold && x >= 30 * scale && x < 214 * scale && y >= 80 * scale && y < 91 * scale;
    const rgb = filled ? [230, 165, 45] : [23, 31, 49], i = (y * width + x) * 4;
    data[i] = rgb[bgra ? 2 : 0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[bgra ? 0 : 2]; data[i + 3] = 255;
  }
  return { data, width, height, bgra };
}

test('packaged recovery rejects unrelated pixels without OCR or name publication', async () => {
  const reader = runtime(); let callbacks = 0;
  for (const bgra of [false, true]) {
    const result = await reader.recover(syntheticFrame(1, bgra), null, {
      screenHeight: 1080, onName: () => { callbacks++; }, ocr: async () => { assert.fail('blank UI must not request OCR'); },
    });
    assert.equal(result.portal, null); assert.equal(result.diagnostics.version, 5);
  }
  assert.equal(callbacks, 0);
});

test('a gold UI bar plus fabricated dictionary OCR cannot bypass complete-name pixels, in RGBA/BGRA and cropped scales', async () => {
  const reader = runtime();
  for (const scale of [1, 2]) {
    const logs = [];
    for (const bgra of [false, true]) {
      const calls = []; let callbacks = 0;
      const result = await reader.recover(syntheticFrame(scale, bgra, true), null, {
        screenHeight: 1080 * scale, onName: () => { callbacks++; },
        ocr: async (png, options) => {
          calls.push([createHash('sha256').update(png).digest('hex'), options.psm, options.whitelist]);
          return 'Pures-Ouozlum';
        },
      });
      assert.equal(result.portal, null); assert.equal(callbacks, 0);
      assert.ok(calls.length > 0, 'exercise the pixel completeness guard after name OCR');
      logs.push(calls);
    }
    assert.deepEqual(logs[1], logs[0], 'BGRA conversion must produce identical OCR images at this physical scale');
  }
});

test('an already verified red timer keeps the original portal fields without entering white OCR', async () => {
  const reader = runtime(), baseline = baseTip();
  baseline.closes = 45; baseline.raw.timerRegion = { kind: 'red', left: 40, top: 100, width: 50, height: 12 };
  const before = plain(baseline);
  const result = await reader.recover(syntheticFrame(), baseline, { screenHeight: 1080,
    ocr: async () => { assert.fail('verified red branch must not issue white-timer OCR'); } });
  assert.equal(result.portal.name, baseline.name); assert.equal(result.portal.closes, 45);
  assert.equal(result.portal.timerUncertain, false); assert.equal(result.portal.capMax, 20);
  assert.deepEqual(plain(baseline), before);
});
