// Кладёт шрифты локально в app/assets/fonts, чтобы приложение не зависело от сети.
// Fira Sans — гуманистический гротеск, ближайший свободный аналог шрифта интерфейса Albion
// (сравнивал с трекером заданий и плашкой зоны на официальных скриншотах); кириллица есть.
// Cinzel — римская капитель, только для логотипа.
// Побочный продукт — app/assets/fonts/fonts.css с готовыми @font-face (unicode-range
// переносим как есть из Google, поэтому кириллица и латиница грузятся раздельно).
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const OUT = path.join(__dirname, '..', 'app', 'assets', 'fonts');
// UA современного браузера — иначе Google отдаёт ttf вместо woff2
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FAMILIES = [
  { css: 'Fira+Sans:wght@400;500;700', file: 'fira', subsets: ['cyrillic', 'latin'] },
  { css: 'Cinzel:wght@600..700', file: 'cinzel', subsets: ['latin'] },
];

function get(url, binary = false) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, binary));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f)); // чистим прошлый заход
  const faces = [];

  for (const fam of FAMILIES) {
    const css = await get(`https://fonts.googleapis.com/css2?family=${fam.css}&display=swap`);
    // Google подписывает каждый блок комментарием с именем подмножества: /* cyrillic */
    const blocks = css.split('/*').slice(1);
    const seen = new Map();   // sha1 файла → уже записанное начертание
    for (const b of blocks) {
      const subset = b.slice(0, b.indexOf('*/')).trim();
      if (!fam.subsets.includes(subset)) continue;              // latin-ext, greek и т.п. не нужны
      const url = (b.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
      const weight = (b.match(/font-weight:\s*([\d ]+);/) || [])[1].trim() || '400';
      const family = (b.match(/font-family:\s*'([^']+)'/) || [])[1] || fam.file;
      const range = (b.match(/unicode-range:\s*([^;]+);/) || [])[1];
      if (!url) continue;
      const buf = await get(url, true);
      // У вариативных семейств Google отдаёт ОДИН файл на все веса. Не плодим копии:
      // одинаковое содержимое → одно начертание с диапазоном весов.
      const sha = crypto.createHash('sha1').update(buf).digest('hex');
      const twin = seen.get(sha);
      if (twin) {
        const lo = Math.min(Number(twin.weight.split(' ')[0]), Number(weight.split(' ')[0]));
        const hi = Math.max(Number(twin.weight.split(' ').pop()), Number(weight.split(' ').pop()));
        twin.weight = `${lo} ${hi}`;
        console.log(`  = ${path.basename(twin.name)} покрывает и вес ${weight}`);
        continue;
      }
      const name = `${fam.file}-${weight.replace(/ /g, '-')}-${subset}.woff2`;
      fs.writeFileSync(path.join(OUT, name), buf);
      console.log(`  ${name.padEnd(30)} ${(buf.length / 1024).toFixed(1)} КБ`);
      const face = { family, weight, name, range };
      seen.set(sha, face);
      faces.push(face);
    }
  }

  const css = faces.map(f =>
    `@font-face {\n` +
    `  font-family: '${f.family}';\n` +
    `  font-style: normal;\n` +
    `  font-weight: ${f.weight};\n` +
    `  font-display: swap;\n` +
    `  src: url('./${f.name}') format('woff2');\n` +
    (f.range ? `  unicode-range: ${f.range};\n` : '') +
    `}`).join('\n');
  fs.writeFileSync(path.join(OUT, 'fonts.css'), '/* Сгенерировано tools/fetch-fonts.js — руками не править. */\n' + css + '\n');
  console.log(`готово: ${faces.length} начертаний → ${OUT}`);
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
