// Exercise the production orchestration with deterministic OCR responses. The
// screenshot benchmark covers the pixels; these tests cover ordering and confidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createNameMatcher, timerConflict, selectTimerReread } = require('../lib/recognition-confidence');
const { exactCapacity, portalSize } = require('../lib/capacity-image');
const source = fs.readFileSync(path.join(__dirname, '../lib/recognize.js'), 'utf8');
function extract(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end);
  return source.slice(start, start + end.index + end[0].length);
}

const LAT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- ';
const WL_DUR = '0123456789чмсЧМС ';
const frame = { width: 1920, height: 1080 };
const defaultBar = { bx: 400, by: 500, bh: 11, span: 258, fill: 158 };
function harness(options = {}) {
  const calls = [], scaleSearches = [], remembered = [], capacityHints = [], timerBars = [], timerScaleCalls = [];
  const names = options.dictionary || ['Touos-Ataglos', 'Touos-Utaglos'];
  const bar = { ...defaultBar, ...options.bar };
  const ctx = vm.createContext({ i18nText: require('../lib/i18n').t,
    ...require('../lib/portal-duration'),
    F: { toFrame: async input => input }, FULLW_1080: 195, LAT, WL_DUR, MAX_HOURS: 24,
    overDay: (hours, minutes) => hours > 24 || (hours === 24 && minutes > 0),
    NAME_TWINS: options.twins || new Map(),
    nameMatcher: createNameMatcher(names),
    ZONE_INFO: new Map(names.map(name => [name, { color: 'avalon', tier: 6 }])),
    nameTokens: raw => (String(raw || '').match(/[A-Za-zА-Яа-я]+/g) || []).map(t => t.toLowerCase()),
    closeEnough: (a, b) => a === b,
    timerConflict, selectTimerReread, exactCapacity, portalSize,
    require: id => {
      assert.equal(id, './portal-recovery/timer-scale');
      return { calibrate: async (input, selected) => {
        assert.equal(input, frame);
        timerScaleCalls.push({ ...selected });
        return options.timerScaleResult ? options.timerScaleResult(selected) : { bar: selected, changed: false };
      } };
    },
    profiles: {
      getScale: () => options.rememberedScale,
      rememberScale: (_, __, scale) => remembered.push(scale),
      getCapacity: () => options.capacityHint,
      rememberCapacity: (_, __, ___, hint) => capacityHints.push(hint),
    },
    findBarCands: (_, scale, box) => {
      scaleSearches.push(scale);
      return options.candidates ? options.candidates(scale, box) : [bar];
    },
    crop: async (_, left, top, width, height, prep = {}) => ({ kind: 'crop', left, top, width, height, prep }),
    capacityImage: async (_, anchor, prep) => ({ kind: 'digits', prep, bar: { ...anchor } }),
    ocr: async (image, opts = {}) => {
      const kind = opts.whitelist === LAT ? 'name'
        : opts.whitelist === '0123456789/' ? image.kind === 'digits' ? 'digits' : 'wide-capacity'
        : image.height === 26 ? 'targeted-timer' : 'timer';
      const nth = calls.filter(call => call.kind === kind).length;
      const call = { kind, nth, image, opts };
      calls.push(call);
      if (options.read) {
        const value = options.read(call);
        if (value !== undefined) return value;
      }
      if (kind === 'name') return names[0];
      if (kind === 'digits' || kind === 'wide-capacity') return '6/7';
      return 'Закроется через 3 ч 09 м';
    },
  });
  const timerModule = { exports: {} };
  const timerContext = vm.createContext({ i18nText: require('../lib/i18n').t, module: timerModule, require: id => id === './timer-image' ? {
    findTimerText: (_, anchor, top) => ({ left: anchor.bx + 180, top, width: 110, height: 26 }),
    timerImage: async (_, region, prep) => ({ kind: 'targeted-timer', ...region, prep }),
  } : require('../lib/' + id.slice(2)) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/portal-timer.js'), 'utf8'), timerContext);
  ctx.recognizeTimer = async (input, anchor, options) => {
    timerBars.push({ ...anchor });
    return timerModule.exports.recognizeTimer(input, anchor, options);
  };
  vm.runInContext(['lev', 'resolveTwin', 'zoneInfo', 'recognizeTooltip']
    .map(extract).join('\n'), ctx);
  return { ctx, calls, scaleSearches, remembered, capacityHints, timerBars, timerScaleCalls,
    run: opts => ctx.recognizeTooltip(frame, { screenHeight: 1080, ...opts }),
  };
}

test('the real name callback follows ambiguity resolution and precedes numeric reads', async () => {
  const s = harness({ read: ({ kind, nth }) => kind === 'name'
    ? ['Touos-Otaglos', 'Touos-Utaglos', 'Touos-Utaglos'][nth] : undefined });
  const seen = [];
  const tip = await s.run({ onName: partial => {
    seen.push(partial);
    assert.equal(s.calls.filter(c => c.kind === 'name').length, 3);
    assert.equal(s.calls.filter(c => c.kind !== 'name').length, 0);
    assert.deepEqual(Object.keys(partial).sort(), ['activities', 'color', 'name', 'quality', 'tier']);
  } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'Touos-Utaglos');
  assert.equal(tip.name, seen[0].name);
});

test('a short Avalon twin is resolved before any map preview is emitted', async () => {
  const short = 'Sectun-Tersas', long = 'Sectun-Et-Tersas';
  const s = harness({ dictionary: [short, long], twins: new Map([[short, [{ mid: 'et', name: long }]]]),
    read: ({ kind, nth }) => kind === 'name' ? nth === 1 ? long : short : undefined });
  const shown = [];
  const tip = await s.run({ onName: partial => { shown.push(partial.name); assert.equal(s.calls.length, 4); } });
  assert.deepEqual(shown, [long]);
  assert.equal(tip.name, long);
});

test('unresolved dictionary ambiguity cannot publish a guessed preview', async () => {
  const s = harness({ read: ({ kind }) => kind === 'name' ? 'Touos-Otaglos' : undefined });
  const shown = [];
  const tip = await s.run({ onName: partial => shown.push(partial) });
  assert.equal(tip, null);
  assert.deepEqual(shown, []);
  assert.equal(s.calls.some(c => c.kind !== 'name'), false);
  assert.deepEqual(s.remembered, []);
});

test('a stale UI scale hint falls back to screen geometry when its name is unreadable', async () => {
  const s = harness({ rememberedScale: 1.5,
    read: ({ kind, image }) => kind === 'name' && image.height > 30 ? '' : undefined });
  const tip = await s.run();
  assert.deepEqual(s.scaleSearches.slice(0, 2), [1.5, 1]);
  assert.equal(tip.name, 'Touos-Ataglos');
  assert.equal(tip.raw.bar.scale, 1);
  assert.deepEqual(s.remembered, [1]);
});

test('a remembered UI scale keeps a portal near the cursor ahead of another valid full-frame candidate', async () => {
  const local = { ...defaultBar, bx: 1000 }, remote = { ...defaultBar, bx: 100 };
  const rememberedSearches = [];
  const s = harness({ rememberedScale: 1.5,
    candidates: (scale, box) => {
      if (scale === 1.5) rememberedSearches.push(box);
      return box ? [local] : [remote, local];
    },
    read: ({ kind, image }) => kind === 'name' ? image.left < 500 ? 'Touos-Utaglos' : 'Touos-Ataglos' : undefined,
  });
  const tip = await s.run({ near: { x: 1000, y: 500 } });
  assert.equal(tip.name, 'Touos-Ataglos');
  assert.equal(tip.raw.bar.bx, local.bx);
  assert.equal(tip.raw.bar.scale, 1.5);
  assert.ok(rememberedSearches[0]);
  assert.ok(rememberedSearches[0].x0 < 1000 && rememberedSearches[0].x1 > 1000);
});

test('a synchronous preview callback failure cannot discard a fully recognized portal', async () => {
  const s = harness();
  let callbacks = 0;
  const tip = await s.run({ onName() { callbacks++; throw new Error('overlay closed'); } });
  assert.equal(callbacks, 1);
  assert.equal(tip.name, 'Touos-Ataglos');
  assert.equal(tip.capMax, 7);
  assert.equal(tip.capNum, null);
  assert.equal(tip.capNumApprox, false);
  assert.equal(tip.closes, 3 * 3600 + 9 * 60);
  assert.ok(s.calls.filter(call => call.kind === 'digits').length >= 2);
});

test('different numerators agree on the portal size and retain the remembered preprocessing order', async () => {
  const s = harness({ capacityHint: { region: 'digits', prep: 2 },
    read: ({ kind, nth }) => kind === 'digits' ? ['3/7', '6/7'][nth] : undefined });
  const tip = await s.run();
  const reads = s.calls.filter(c => c.kind === 'digits');
  assert.equal(reads.length, 2);
  assert.equal(reads[0].image.prep.threshold, 180);
  assert.equal(tip.capMax, 7);
  assert.equal(tip.capNum, null);
  assert.equal(tip.capNumApprox, false);
  assert.equal(s.calls.some(c => c.kind === 'wide-capacity'), false);
  assert.equal(s.capacityHints.length, 1);
});

test('a repeatedly readable size survives a lost slash or clipped numerator without estimating a count', async () => {
  const s = harness({ bar: { fill: 184 }, read: ({ kind, nth }) => kind === 'digits'
    ? ['717', '1/7', '717', '77'][nth] : kind === 'wide-capacity' ? '7/' : undefined });
  const tip = await s.run();
  assert.equal(tip.capMax, 7); assert.equal(tip.capNum, null); assert.equal(tip.capNumApprox, false);
});

test('joined digits and a full fraction agree on size twenty without publishing their numerator', async () => {
  const s = harness({ bar: { fill: 184 }, read: ({ kind }) => kind === 'digits' ? '2020'
    : kind === 'wide-capacity' ? '20/20' : undefined });
  const tip = await s.run();
  assert.equal(tip.capMax, 20); assert.equal(tip.capNum, null); assert.equal(tip.capNumApprox, false);
});

test('a visible denominator survives a missing numerator, zero detected fill and an imprecise name scale', async () => {
  const s = harness({ rememberedScale: 1.25, bar: { fill: 0 },
    read: ({ kind }) => kind === 'digits' ? '/20' : undefined });
  const tip = await s.run();
  assert.equal(tip.raw.bar.scale, 1.25);
  assert.equal(tip.raw.bar.fill, 0);
  assert.equal(tip.capMax, 20);
  assert.equal(tip.capMaxKnown, true);
  assert.equal(tip.capNum, null);
  assert.equal(tip.capNumApprox, false);
  assert.equal(s.calls.some(c => c.kind === 'wide-capacity'), false);
});

test('seven as a numerator cannot turn a visible /20 into a seven-person portal', async () => {
  const s = harness({ read: ({ kind }) => kind === 'digits' ? '7/20' : undefined });
  const tip = await s.run();
  assert.equal(tip.capMax, 20);
  assert.equal(tip.capMaxKnown, true);
  assert.equal(tip.capNum, null);
  assert.equal(tip.capNumApprox, false);
});

test('observed conflicting denominators stay unknown even when one later gains more votes', async () => {
  const s = harness({ read: ({ kind, nth }) => kind === 'digits' ? ['3/7', '12/20', '6/7', '6/7'][nth]
    : kind === 'wide-capacity' ? '6/7' : undefined });
  const tip = await s.run();
  assert.equal(tip.capMax, null);
  assert.equal(tip.capMaxKnown, false);
  assert.equal(tip.capNum, null);
  assert.equal(tip.capNumApprox, false);
  assert.equal(s.capacityHints.length, 0, 'a conflict cannot train the successful-preprocessing hint');
});

test('a lone possible numerator or a cooldown string cannot supply a missing portal size', async () => {
  for (const incomplete of ['7', '20', '7/', '20/', '00:57', '0057', '0020']) {
    const s = harness({ read: ({ kind }) => kind === 'digits' || kind === 'wide-capacity' ? incomplete : undefined });
    const tip = await s.run();
    assert.equal(tip.capMax, null, incomplete);
    assert.equal(tip.capMaxKnown, false, incomplete);
    assert.equal(tip.capNum, null, incomplete);
    assert.equal(tip.capNumApprox, false, incomplete);
    assert.equal(tip.name, 'Touos-Ataglos', 'the known identity survives a size refusal');
  }
});

test('focused original-pixel fraction crops recover a size after narrow and wide reads are empty', async () => {
  const focused = image => image.left === defaultBar.bx + 77 && image.width === 62;
  const s = harness({ bar: { fill: 106 }, read: ({ kind, image }) => {
    if (kind === 'digits') return '';
    if (kind === 'wide-capacity') return focused(image) ? '4/7' : '';
    return undefined;
  } });
  const tip = await s.run();
  const capacityCalls = s.calls.filter(c => c.kind === 'digits' || c.kind === 'wide-capacity');
  const firstFocused = capacityCalls.findIndex(c => c.kind === 'wide-capacity' && focused(c.image));
  assert.ok(firstFocused > 0, 'focused recovery follows the existing reads');
  assert.equal(capacityCalls.slice(0, firstFocused).filter(c => c.kind === 'digits').length, 4);
  assert.ok(capacityCalls.slice(0, firstFocused).some(c => c.kind === 'wide-capacity'), 'retain the ordinary wide fallback');
  const recovered = capacityCalls.slice(firstFocused);
  assert.equal(recovered.length, 2, 'two explicit /7 observations are sufficient');
  assert.ok(recovered.every(c => focused(c.image) && c.image.top === defaultBar.by - 3));
  assert.equal(recovered[0].image.prep.thresh, undefined, 'retain the original grayscale information');
  assert.equal(recovered[1].image.prep.invert, false, 'try the other polarity');
  assert.equal(tip.capMax, 7);
  assert.equal(tip.capMaxKnown, true);
  assert.equal(tip.capNum, null);
  assert.equal(tip.capNumApprox, false);
});

test('capacity retry at screen scale preserves the selected name and timer bar', async () => {
  const original = { ...defaultBar, fill: 185, scale: 1.25 };
  const s = harness({ rememberedScale: original.scale, bar: { fill: original.fill }, read: ({ kind, image }) => {
    if (kind === 'digits') return image.bar.scale === 1
      ? image.prep.threshold === 155 ? '77' : '717' : '';
    if (kind === 'wide-capacity') return '';
    return undefined;
  } });
  const tip = await s.run();
  const digitCalls = s.calls.filter(c => c.kind === 'digits');
  assert.deepEqual(digitCalls.map(c => c.image.bar.scale), [1.25, 1.25, 1.25, 1.25, 1, 1]);
  for (const call of digitCalls) {
    for (const field of ['bx', 'by', 'bh', 'span', 'fill']) assert.equal(call.image.bar[field], original[field], field);
  }
  assert.equal(s.calls.filter(c => c.kind === 'name').length, 1, 'capacity does not reread or replace identity');
  assert.deepEqual(s.remembered, [1.25], 'the local capacity retry does not change the name scale profile');
  assert.deepEqual(s.timerBars, [original], 'the timer receives the original selected bar');
  for (const field of Object.keys(original)) assert.equal(tip.raw.bar[field], original[field], field);
  assert.equal(tip.name, 'Touos-Ataglos');
  assert.equal(tip.capMax, 7);
  assert.equal(tip.capMaxKnown, true);
  assert.equal(tip.capNum, null);
  assert.equal(tip.capNumApprox, false);
  assert.equal(tip.closes, 3 * 3600 + 9 * 60);
});

test('verified timer scale reaches time parsing without changing name or capacity profiles', async () => {
  const original = { ...defaultBar, scale: 1.25 }, calibrated = { ...original, scale: 1 };
  const s = harness({ rememberedScale: 1.25, timerScaleResult: selected => ({
    bar: { ...selected, scale: 1 }, changed: true, previousScale: 1.25, measuredScale: 1,
  }) });
  const tip = await s.run();
  assert.deepEqual(s.timerScaleCalls, [original]);
  assert.deepEqual(s.timerBars, [calibrated]);
  assert.deepEqual(s.remembered, [1.25]);
  assert.ok(s.calls.filter(c => c.kind === 'digits').every(c => c.image.bar.scale === 1.25));
  for (const field of Object.keys(calibrated)) assert.equal(tip.raw.bar[field], calibrated[field], field);
  assert.equal(tip.raw.timerScale.changed, true);
  assert.equal(tip.name, 'Touos-Ataglos');
  assert.equal(tip.capMax, 7);
  assert.equal(tip.capNum, null);
  assert.equal(tip.closes, 3 * 3600 + 9 * 60);
});

test('the last contrast crop confirms a previously unknown size and is skipped for a known size', async () => {
  const lastContrast = call => call.kind === 'wide-capacity'
    && call.image.left === defaultBar.bx + 77 && call.image.width === 62
    && call.image.prep.scale === 5 && call.image.prep.thresh === 120;
  const unknown = harness({ read: call => {
    if (call.kind === 'digits') return call.nth === 0 ? '77' : '';
    if (call.kind === 'wide-capacity') return lastContrast(call) ? '7/7' : '';
    return undefined;
  } });
  const recovered = await unknown.run();
  assert.equal(unknown.calls.filter(lastContrast).length, 1);
  assert.deepEqual([...recovered.raw.capReads], ['77', '7/7'], 'the full fraction confirms the one earlier joined observation');
  assert.equal(recovered.capMax, 7);
  assert.equal(recovered.capMaxKnown, true);
  assert.equal(recovered.capNum, null);
  assert.equal(recovered.capNumApprox, false);
  assert.equal(unknown.capacityHints.length, 0, 'a final fallback does not become a successful narrow-crop profile');

  const known = harness({ read: call => call.kind === 'digits' ? '7/20'
    : lastContrast(call) ? '7/7' : undefined });
  const accepted = await known.run();
  assert.equal(known.calls.filter(lastContrast).length, 0, 'do not spend another OCR read or replace an accepted denominator');
  assert.equal(accepted.capMax, 20);
  assert.equal(accepted.capNum, null);
  assert.equal(accepted.capNumApprox, false);
});

test('targeted timer reads resolve observed disagreement on the closing row after skipping cooldown', async () => {
  const cooldown = defaultBar.by + defaultBar.bh + 2;
  const s = harness({ read: ({ kind, nth, image }) => {
    if (kind === 'timer') {
      if (image.top === cooldown) return 'Можно использовать 3 м 05 с';
      return nth % 2 ? 'Закроется через 17 ч 44 м' : 'Закроется через 7 ч 44 м';
    }
    if (kind === 'targeted-timer') return '7 ч 44 м';
    return undefined;
  } });
  const tip = await s.run();
  const targeted = s.calls.filter(c => c.kind === 'targeted-timer');
  assert.ok(targeted.length >= 2 && targeted.length <= 4);
  assert.ok(targeted.every(c => c.image.top === cooldown + 24));
  assert.equal(tip.closes, 7 * 3600 + 44 * 60);
});

test('new unlabeled timer values cannot replace observed durations during targeted rereads', async () => {
  const s = harness({ read: ({ kind, nth }) => {
    if (kind === 'timer') return nth % 2 ? 'Закроется через 17 ч 44 м' : 'Закроется через 7 ч 44 м';
    if (kind === 'targeted-timer') return '11 ч 44 м';
    return undefined;
  } });
  const tip = await s.run();
  assert.ok(s.calls.filter(c => c.kind === 'targeted-timer').length >= 2);
  assert.equal(tip.closes, 17 * 3600 + 44 * 60);
});
