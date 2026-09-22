// Real screenshot benchmark. Initialization/PNG decoding are outside the measured path.
// node test/recognition-benchmark.js ../out/recognition-before.json
const fs = require('fs');
const path = require('path');
const runtime = require('../lib/ocr-worker');
const create = runtime.create;
let calls;
runtime.create = (...args) => {
  const engine = create(...args), run = engine.run;
  engine.run = async (buf, params) => {
    const kind = params.tessedit_char_whitelist === '0123456789/' ? 'capacity'
      : params.tessedit_char_whitelist?.includes('ABC') ? 'name' : 'timer';
    const start = performance.now();
    try { return await run(buf, params); }
    finally { if (calls) { calls[kind].count++; calls[kind].ms += performance.now() - start; } }
  };
  return engine;
};
const recognize = require('../lib/recognize');
const F = require('../lib/frame');
const truth = require('../../etap0/truth');
const extra = [
  ['c1-drained-0-7', 0, 'Coues-Exakrom', '0/7', 11880],
  ['c2-gold-19-20', 0, 'Suyitos-Oyarlos', '19/20', 8400],
  ['c3-longmarch-1-7', 1080, 'Longmarch Meadow', '1/7', 15840],
  ['c4-minimap-7-7', 1080, 'Conos-Avaelum', '7/7', 36060],
  ['c5-zonemap-5-7', 1080, 'Xasos-Aeoilos', '5/7', 40260],
  ['c6-grass-minimap-6-7', 1080, 'Coues-Exakrom', '6/7', 77040],
  ['c7-ultrawide-2560x1180', 1180, 'Touos-Ataglos', '11/20', 11340],
];
const cases = Object.entries(truth).filter(([, v]) => v.tip)
  .map(([id, { tip }]) => ({ id, ...tip, screenHeight: 0 }))
  .concat(extra.map(([id, screenHeight, name, cap, closes]) => ({ id, screenHeight, name, cap, closes })));
(async () => {
  const results = [];
  try {
    await recognize.init();
    for (const expected of cases) {
      const frame = await F.fromEncoded(fs.readFileSync(path.join(__dirname, '../../calibration', expected.id + '.png')));
      calls = Object.fromEntries(['name', 'capacity', 'timer'].map(k => [k, { count: 0, ms: 0 }]));
      const start = performance.now();
      let previewMs = null;
      const tip = await recognize.recognizeTooltip(frame, {
        screenHeight: expected.screenHeight, onName: () => { previewMs = performance.now() - start; },
      });
      const actual = tip && { name: tip.name, cap: `${tip.capNum}/${tip.capMax}`, closes: tip.closes };
      const errors = ['name', 'cap', 'closes'].filter(k => actual?.[k] !== expected[k]);
      const row = { id: expected.id, ms: performance.now() - start, previewMs, calls, actual,
        approximate: tip?.capNumApprox, errors, raw: tip?.raw };
      results.push(row);
      console.log(`${row.id}: ${Math.round(row.ms)} ms, cap ${calls.capacity.count} reads, ${errors.length ? errors.join(', ') : 'OK'}`);
    }
  } finally { await recognize.shutdown(); }
  const output = path.resolve(process.argv[2] || '../out/recognition-benchmark.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.errors.length);
  console.log(`${results.length} frames, ${failed.length} failed, mean ${Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length)} ms`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
