#!/usr/bin/env node
// Одна самодостаточная страница со ВСЕМИ обрезанными картами зон — чтобы глазами
// проверить, где обрезка сработала плохо. Отсортировано по подозрительности
// (tools/check-crops.js): сначала то, где вдоль кромки ромба лежит песчаная рамка
// или чернота, потом чистые.
//
// Запуск: node tools/check-crops.js && node tools/build-crops-page.js
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'app', 'assets', 'avalon-maps-crop');
const FONTS = path.join(ROOT, 'app', 'assets', 'fonts');
const QUALITY = path.join(ROOT, 'app', 'data', 'crop-quality.json');
const OUT = process.argv[2] || path.join(ROOT, 'app', 'data', 'crops.html');

const BAD = 0.04;    // выше этого — помечаем: сплошная полоса чужого вдоль кромки
const THUMB = 210;   // ширина плитки в сетке
const BIG = 420;     // ширина крупной плитки для подозрительных

const b64 = buf => buf.toString('base64');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fontFace(family, weight, files) {
  return files.map(([file, range]) => {
    const p = path.join(FONTS, file);
    if (!fs.existsSync(p)) return '';
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;` +
      `src:url(data:font/woff2;base64,${b64(fs.readFileSync(p))}) format('woff2');unicode-range:${range};}`;
  }).join('\n');
}

(async () => {
  if (!fs.existsSync(QUALITY)) { console.error('нет crop-quality.json — сначала node tools/check-crops.js'); process.exit(1); }
  const list = JSON.parse(fs.readFileSync(QUALITY, 'utf8'));
  let bytes = 0;

  const cell = async (r, width) => {
    const file = path.join(DIR, r.name + '.webp');
    if (!fs.existsSync(file)) return '';
    const buf = await sharp(file).resize({ width }).webp({ quality: width > 300 ? 72 : 62 }).toBuffer();
    bytes += buf.length;
    // Обрезанный ИСТОЧНИК — не брак обрезки: части карты нет в самом ассете, и
    // никакая обрезка её не вернёт. Помечаем иначе, чтобы не путать одно с другим.
    const cutSrc = r.cover < 0.95;
    const cls = cutSrc ? ' cut' : (r.bad >= BAD ? ' bad' : '');
    const tag = cutSrc ? 'источник обрезан' : (r.edge * 100).toFixed(1) + '%';
    return `<figure class="m${cls}" data-bad="${r.bad.toFixed(4)}">
      <img src="data:image/webp;base64,${b64(buf)}" alt="${esc(r.name)}" width="${width}" loading="lazy">
      <figcaption><b>${esc(r.name)}</b><span>${tag}</span></figcaption>
    </figure>`;
  };

  const suspicious = list.filter(r => r.bad >= BAD);
  const big = [];
  // крупно показываем верхушку списка целиком, даже если помеченных мало
  for (const r of list.slice(0, 12)) big.push(await cell(r, BIG));
  const all = [];
  for (const r of list) all.push(await cell(r, THUMB));

  const CYR = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
  const LAT = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
  const fonts = [
    fontFace('Fira Sans', 400, [['fira-400-cyrillic.woff2', CYR], ['fira-400-latin.woff2', LAT]]),
    fontFace('Fira Sans', 500, [['fira-500-cyrillic.woff2', CYR], ['fira-500-latin.woff2', LAT]]),
    fontFace('Fira Sans', 700, [['fira-700-cyrillic.woff2', CYR], ['fira-700-latin.woff2', LAT]]),
  ].join('\n');

  const html = `<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Avalon Mapper — обрезка карт зон</title>
<style>
${fonts}
:root{
  --bg:#14100f; --panel:#1c1716; --edge:#c9bda626; --edge-lit:#c9bda659;
  --text:#ece0c8; --muted:#b8ab93; --dim:#8b8071; --gold:#e0a53c; --gold-hi:#f6c874; --warn:#e07a35;
}
@media (prefers-color-scheme: light){
  :root{ --bg:#efe7db; --panel:#f7f1e7; --edge:#3a2a1a1f; --edge-lit:#3a2a1a40;
    --text:#2c2118; --muted:#6b5b48; --dim:#877462; --gold:#9a6a12; --gold-hi:#7d5507; --warn:#a8501a; }
}
:root[data-theme="dark"]{
  --bg:#14100f; --panel:#1c1716; --edge:#c9bda626; --edge-lit:#c9bda659;
  --text:#ece0c8; --muted:#b8ab93; --dim:#8b8071; --gold:#e0a53c; --gold-hi:#f6c874; --warn:#e07a35;
}
:root[data-theme="light"]{
  --bg:#efe7db; --panel:#f7f1e7; --edge:#3a2a1a1f; --edge-lit:#3a2a1a40;
  --text:#2c2118; --muted:#6b5b48; --dim:#877462; --gold:#9a6a12; --gold-hi:#7d5507; --warn:#a8501a;
}
*{box-sizing:border-box;}
body{margin:0; padding:0 16px 64px; background:var(--bg); color:var(--text);
  font:400 15px/1.5 'Fira Sans','Segoe UI',system-ui,sans-serif; font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;}
.wrap{max-width:1400px; margin:0 auto;}
header{padding:34px 0 8px;}
h1{margin:0 0 8px; font-size:clamp(24px,4vw,34px); font-weight:500;}
h1 b{color:var(--gold); font-weight:500;}
.lede{margin:0; max-width:70ch; color:var(--muted);}
h2{margin:34px 0 4px; font-size:19px; font-weight:500; color:var(--gold);}
h2 + p{margin:0 0 14px; color:var(--muted); font-size:14px; max-width:70ch;}
.tools{display:flex; flex-wrap:wrap; gap:8px; margin-top:16px;}
button{font:500 13px/1 'Fira Sans',system-ui,sans-serif; color:var(--text); background:var(--panel);
  border:1px solid var(--edge-lit); border-radius:3px; padding:8px 12px; cursor:pointer;}
button:hover{border-color:var(--gold); color:var(--gold-hi);}
button[aria-pressed="true"]{background:var(--gold); border-color:var(--gold); color:#1a1206;}
button:focus-visible{outline:2px solid var(--gold); outline-offset:2px;}

.grid{display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(200px,1fr));}
.grid.big{grid-template-columns:repeat(auto-fill,minmax(380px,1fr));}
.m{margin:0; background:var(--panel); border:1px solid var(--edge); border-radius:4px; padding:5px;}
/* обрезка подозрительная — рамка того же цвета, что «скоро закроется» в приложении */
.m.bad{border-color:var(--warn); box-shadow:inset 0 0 0 1px #e07a3540;}
.m img{display:block; width:100%; height:auto; border-radius:2px;}
figcaption{display:flex; justify-content:space-between; gap:8px; align-items:baseline;
  padding:5px 3px 1px; font-size:11.5px; color:var(--dim);}
figcaption b{font-weight:500; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.m.bad figcaption span{color:var(--warn);}
/* источник обрезан — не наша вина и не чинится обрезкой; метка спокойная */
.m.cut{border-color:var(--edge-lit);}
.m.cut figcaption span{color:var(--muted); font-size:10.5px;}
footer{margin-top:34px; padding-top:16px; border-top:1px solid var(--edge); color:var(--dim); font-size:13px;}
code{color:var(--gold); font-size:12.5px;}
@media (max-width:620px){ body{padding:0 10px 48px;} .grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));} }
</style>

<div class="wrap">
  <header>
    <h1>Обрезка карт зон — <b>все ${list.length}</b></h1>
    <p class="lede">Карта каждой зоны вырезается из скриншота ромбом, ровно по краю поля.
    Число рядом с именем — самая длинная <b>сплошная</b> полоса чужого вдоль кромки ромба
    (песчаная рамка карты или чернота вокруг неё), в долях периметра. Считаем именно сплошную:
    у каждой карты в середине граней есть свои «ворота», где песок врезается внутрь ромба, —
    это не брак. Помечено оранжевым выше ${(BAD * 100).toFixed(0)}% — ${suspicious.length} штук${suspicious.length === 1 ? '' : 'и'}.
    Отдельная метка «источник обрезан» (${list.filter(r => r.cover < 0.95).length}) — там часть карты
    отсутствует в самом скачанном ассете, обрезкой это не лечится.
    Всё остальное отсортировано следом, от худшего к чистому.</p>
    <div class="tools">
      <button id="only" aria-pressed="false">Показать только подозрительные</button>
      <button id="theme">Светлая тема</button>
    </div>
  </header>

  <h2>Крупно: худшие ${big.length}</h2>
  <p>Здесь видно, что именно не так: если по краю ромба тянется светлая песчаная полоса — взяли шире самой карты.
  Маленькие песчаные клинья в середине граней — это ворота самой карты, так и должно быть.</p>
  <div class="grid big">${big.join('')}</div>

  <h2>Все карты по порядку</h2>
  <p>От самых подозрительных к чистым. Назови имена тех, что выглядят плохо, — переделаю обрезку для них.</p>
  <div class="grid" id="all">${all.join('')}</div>

  <footer>Собрано <code>tools/build-crops-page.js</code> по оценкам <code>tools/check-crops.js</code>.
  Сами файлы — <code>app/assets/avalon-maps-crop</code>, обрезка — <code>tools/crop-maps.js</code>.</footer>
</div>

<script>
  const onlyBtn = document.getElementById('only');
  let only = false;
  onlyBtn.addEventListener('click', () => {
    only = !only;
    onlyBtn.setAttribute('aria-pressed', String(only));
    onlyBtn.textContent = only ? 'Показать все' : 'Показать только подозрительные';
    document.querySelectorAll('#all .m').forEach(m => {
      m.style.display = only && !m.classList.contains('bad') ? 'none' : '';
    });
  });
  const themeBtn = document.getElementById('theme');
  const root = document.documentElement;
  const dark = () => (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const sync = () => { themeBtn.textContent = dark() ? 'Светлая тема' : 'Тёмная тема'; };
  themeBtn.addEventListener('click', () => { root.dataset.theme = dark() ? 'light' : 'dark'; sync(); });
  sync();
</script>`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`подозрительных: ${suspicious.length} из ${list.length}`);
  console.log(`страница: ${OUT} — ${Math.round(fs.statSync(OUT).size / 1024)} КБ (картинок ${Math.round(bytes / 1024)} КБ)`);
})();
