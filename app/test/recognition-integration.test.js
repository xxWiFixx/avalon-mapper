// Exercise the production orchestration with deterministic OCR responses. The
// screenshot benchmark covers the pixels; these tests cover ordering and confidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createNameMatcher, timerConflict, selectTimerReread } = require('../lib/recognition-confidence');
const { exactCapacity } = require('../lib/capacity-image');
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
  const calls = [], scaleSearches = [], remembered = [], capacityHints = [];
  const names = options.dictionary || ['Touos-Ataglos', 'Touos-Utaglos'];
  const bar = { ...defaultBar, ...options.bar };
  const ctx = vm.createContext({
    ...require('../lib/portal-duration'),
    F: { toFrame: async input => input }, FULLW_1080: 195, LAT, WL_DUR, MAX_HOURS: 24,
    overDay: (hours, minutes) => hours > 24 || (hours === 24 && minutes > 0),
    NAME_TWINS: options.twins || new Map(),
    nameMatcher: createNameMatcher(names),
    ZONE_INFO: new Map(names.map(name => [name, { color: 'avalon', tier: 6 }])),
    nameTokens: raw => (String(raw || '').match(/[A-Za-zА-Яа-я]+/g) || []).map(t => t.toLowerCase()),
    closeEnough: (a, b) => a === b,
    timerConflict, selectTimerReread, exactCapacity,
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
    capacityImage: async (_, __, prep) => ({ kind: 'digits', prep }),
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
  const timerContext = vm.createContext({ module: timerModule, require: id => id === './timer-image' ? {
    findTimerText: (_, anchor, top) => ({ left: anchor.bx + 180, top, width: 110, height: 26 }),
    timerImage: async (_, region, prep) => ({ kind: 'targeted-timer', ...region, prep }),
  } : require('../lib/' + id.slice(2)) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/portal-timer.js'), 'utf8'), timerContext);
  ctx.recognizeTimer = timerModule.exports.recognizeTimer;
  vm.runInContext(['lev', 'resolveTwin', 'zoneInfo', 'recognizeTooltip']
    .map(extract).join('\n'), ctx);
  return { ctx, calls, scaleSearches, remembered, capacityHints,
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
  assert.equal(tip.capNum, 6);
  assert.equal(tip.closes, 3 * 3600 + 9 * 60);
  assert.ok(s.calls.filter(call => call.kind === 'digits').length >= 2);
});

test('disagreeing exact digit reads require a second matching observation, even with a remembered preprocessing hint', async () => {
  const s = harness({ capacityHint: { region: 'digits', prep: 2 },
    read: ({ kind, nth }) => kind === 'digits' ? ['6/7', '5/7', '6/7'][nth] : undefined });
  const tip = await s.run();
  const reads = s.calls.filter(c => c.kind === 'digits');
  assert.equal(reads.length, 3);
  assert.equal(reads[0].image.prep.threshold, 180);
  assert.equal(tip.capNum, 6);
  assert.equal(tip.capNumApprox, false);
  assert.equal(s.calls.some(c => c.kind === 'wide-capacity'), false);
  assert.equal(s.capacityHints.length, 1);
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
