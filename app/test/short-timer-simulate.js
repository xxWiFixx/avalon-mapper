// Generated images exercise short-timer formats and UI scaling. They are not
// screenshots from the game and do not replace validation on players' captures.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const runtime = require('../lib/ocr-worker');
const create = runtime.create;
let engine;
runtime.create = (...args) => (engine = create(...args));
const recognize = require('../lib/recognize');
const { recognizeTimer } = require('../lib/portal-timer');
const F = require('../lib/frame');

const cases = [
  ['59 м 59 с', 3599], ['5 м 59 с', 359], ['1 м 01 с', 61],
  ['1 м', 60], ['59 с', 59], ['49 с', 49], ['15 с', 15], ['5 с', 5], ['0 с', 0],
];
async function fixture(value, scale, color = '#fa5d47') {
  const width = Math.round(345 * scale), height = Math.round(60 * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 345 60">
    <rect width="345" height="60" fill="#251f22"/>
    <text x="300" y="31" text-anchor="end" font-family="Arial" font-size="11" fill="#bcb3a2">Закроется через <tspan font-weight="bold" font-size="12" fill="${color}">${value}</tspan></text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
(async () => {
  const out = path.join(__dirname, '../../out/short-timers');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  try {
    await recognize.init();
    for (const scale of [1, 1180 / 1080, 1.5]) for (const [value, expected] of cases) {
      const image = await fixture(value, scale), frame = await F.fromEncoded(image);
      let calls = 0;
      const start = performance.now();
      const result = await recognizeTimer(frame, { bx: 0, by: 0, bh: 11 * scale, scale }, {
        crop: recognize._internal.crop,
        ocr: async (png, opts = {}) => {
          if (!png) return '';
          calls++;
          const { data } = await engine.run(png, {
            classify_enable_learning: '0', classify_enable_adaptive_matcher: '0',
            tessedit_char_whitelist: opts.whitelist || '', tessedit_pageseg_mode: String(opts.psm || 7),
          });
          return data.text.replace(/\n+/g, ' ').trim();
        },
      });
      const row = { value, scale, expected, actual: result.closes, correct: result.closes === expected,
        ms: performance.now() - start, calls, raw: result.raw };
      results.push(row);
      fs.writeFileSync(path.join(out, `${results.length}.png`), image);
      console.log(`${value} @${scale.toFixed(2)}: ${row.correct ? 'OK' : row.actual + ' WRONG'} (${calls} reads)`);
    }
  } finally { await recognize.shutdown(); }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.correct);
  console.log(`${results.length - failed.length}/${results.length} generated timer images passed`);
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
