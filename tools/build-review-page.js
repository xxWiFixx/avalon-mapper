#!/usr/bin/env node
// Собирает ОДНУ самодостаточную HTML-страницу со всеми снимками на проверку.
// Нужна, потому что вложения в чате открываются не на всех устройствах, а страницу
// можно открыть по ссылке с телефона. Всё внутри: картинки и шрифт — data:URI,
// внешних запросов нет вовсе.
//
// Запуск: node tools/build-review-page.js [куда.html]
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'app', 'data');
const FONTS = path.join(ROOT, 'app', 'assets', 'fonts');
const OUT = process.argv[2] || path.join(ROOT, 'app', 'data', 'review.html');

// Снимки: [файл, заголовок, пояснение, ширина в странице, раздел]
const SHOTS = [
  ['preview-route.png', 'Маршрут: откуда и куда', 'Два поля вместо привязки к своему месту: путь можно построить откуда угодно куда угодно — товарищу, или заранее. Своя зона подставляется сама, пока поле не тронули руками, и возвращается кнопкой под полями. Сокращения работают в обоих полях: Enter в «откуда» переводит в «куда», Enter в «куда» ищет путь. Каждая зона — своя строка со своим ромбом на рельсе, ромб покрашен в цвет зоны. Любой непеший переход называется порталом: деление на «портал» и «выход» нужно маршрутизатору, а игроку — нет. Время в пути помечено тильдой: это расчёт, а не факт.', 620, 'Маршрут'],
  ['preview-share.png', 'Куда сохранять портал', 'Три независимые галочки. Своя карта — файл на этом компьютере. Карта друзей — по коду, который создаёт один из вас и присылает остальным. Общая — одна на всех, и ник в неё не передаётся вовсе. Можно поставить все три сразу: портал уйдёт во все три места. Можно снять все — тогда он только покажется в плашке и нигде не сохранится. Подключение вводится один раз и сворачивается; строка внизу всегда говорит, ушло или ждёт в очереди.', 620, 'Общие карты'],
  ['preview-settings.png', 'Панель настроек', 'Свёрнут по умолчанию — нужен редко, а места занимал больше всех. Внутрь переехала область плашки зоны: рядом теперь написано, что это за полоска, где она в игре и почему прямоугольник надо брать заметно шире надписи. Второй блок в окне карты. Каждый снимок экрана выключается отдельно, и под переключателем написано, чего лишишься: без слежения за плашкой зоны приложение перестаёт понимать, где персонаж, а без снимка у курсора хоткей открывает поиск зоны руками.', 620, 'Настройки'],
  ['preview-busy.png', 'Отклик на нажатие', 'Между нажатием хоткея и ответом проходит около секунды. Раньше в эту секунду не происходило ничего, и было непонятно, сработало ли вообще, — теперь плашка отзывается сразу, на своём обычном месте, и сменяется результатом. Сколько держать результат на экране — от 3 до 30 секунд, ползунком в настройках.', 1200, 'Плашка поверх игры'],
  ['preview-sizes.png', 'Размер плашки', 'Ползунок 60…250 %. Плашка растёт ВВЕРХ от одного и того же низа — то есть остаётся там, куда её поставили, и не наползает на миникарту.', 1500, 'Настройки'],
  ['preview-nomap.png', 'Карта зоны — выключаемая', 'Без карты остаются свиток с именем и активности: блок становится втрое ниже и почти не закрывает игру. Всё остальное работает как раньше.', 1500, 'Настройки'],
  ['preview-setup.png', 'Задать место мышью', 'Кнопка «Задать место» — и плашка прямо поверх игры становится кликабельной: тянешь мышью, колесо меняет размер, Enter сохраняет, Esc возвращает как было. Пунктирная рамка показывает границы блока, «Стандартное место» гасится, пока своё место не задано.', 1800, 'Настройки'],
  ['preview-search.png', 'Поиск зоны вместо снимка', 'Снимок области у курсора выключен — по хоткею всплывает это окно. Встаёт оно там же, где появляется плашка с картой зоны: над миникартой, низ к низу. У курсора оно выскакивало каждый раз в новом месте, и его приходилось искать глазами. Сокращения те же, что в поле «Куда»: «couexa» находит Coues-Exakrom. После имени можно дописать время до закрытия: одно число — минуты, два — часы и минуты, разделитель любой («45», «5 36», «5.36»). Строка под полем показывает понятое словами и во сколько закроется по часам — ошибка видна до Enter. Размер портала — двумя кнопками, чтобы третья цифра в строке не спорила со временем. Enter — зона за порталом, Ctrl+Enter — «я сейчас здесь» (единственный способ задать своё место, когда слежение за зоной выключено).', 1800, 'Настройки'],

  ['preview-gallery.png', 'Восемь разных зон', 'Как выглядит плашка в реальной работе: разные тиры и наборы содержимого, портал на 7 и на 20, красный таймер за 12 минут до закрытия, непрочитанный размер, зона с выключенной картой и зона мира.', 1970, 'Плашка поверх игры'],
  ['preview-capacity.png', 'Вместимость портала', 'Про портал ровно одно: сколько человек он пропускает. Полоса в цвет — синяя у портала на 7, золотая у портала на 20, — и число рядом. Свободные места и перезарядка убраны совсем. Если размер не прочитался, так и написано: это сигнал навестись и нажать ещё раз.', 1800, 'Плашка поверх игры'],
  ['preview-on-frame.png', 'На кадре игры', 'Стандартное место: над миникартой справа внизу, игровые кнопки не перекрывает.', 1600, 'Плашка поверх игры'],
  ['preview-states.png', 'Пометка размера вблизи', 'Слева Ooros-Ataltum: первый чип — большой золотой сундук (рамка и галочка), второй — обычный золотой. Справа Fuyes-Izohun: обведён большой синий сундук, первым в ленте — портал в Бресилиен.', 1400, 'Плашка поверх игры'],
  ['preview-icons.png', 'Набор иконок', 'Двенадцать штук, все приведены к одному размеру. Сундуки прежние, портал в Бресилиен — из клиента игры, золотое подземелье вырезано с карты Febites-Opavun.', 1400, 'Плашка поверх игры'],

  ['verify-1.png', 'Проверочный лист 1', 'Слева карта зоны из игры, справа — что о ней думает приложение. Золотая рамка и галочка = большой сундук или крупный узел ресурса.', 1126, 'Сверка данных'],
  ['verify-2.png', 'Проверочный лист 2', '', 1126, 'Сверка данных'],
  ['verify-3.png', 'Проверочный лист 3', '', 1126, 'Сверка данных'],
  ['verify-4.png', 'Проверочный лист 4', '', 1126, 'Сверка данных'],
  ['verify-5.png', 'Проверочный лист 5', '', 1126, 'Сверка данных'],
];

const b64 = (buf) => buf.toString('base64');

async function image(file, width) {
  const src = path.join(DATA, file);
  if (!fs.existsSync(src)) return null;
  const meta = await sharp(src).metadata();
  const w = Math.min(width, meta.width);
  const webp = await sharp(src).resize({ width: w, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  return { uri: 'data:image/webp;base64,' + b64(webp), width: w, height: Math.round(meta.height * w / meta.width), kb: Math.round(webp.length / 1024) };
}

function fontFace(family, weight, files) {
  return files.map(([file, range]) => {
    const p = path.join(FONTS, file);
    if (!fs.existsSync(p)) return '';
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;` +
      `src:url(data:font/woff2;base64,${b64(fs.readFileSync(p))}) format('woff2');unicode-range:${range};}`;
  }).join('\n');
}

(async () => {
  const CYR = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
  const LAT = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
  const fonts = [
    fontFace('Fira Sans', 400, [['fira-400-cyrillic.woff2', CYR], ['fira-400-latin.woff2', LAT]]),
    fontFace('Fira Sans', 500, [['fira-500-cyrillic.woff2', CYR], ['fira-500-latin.woff2', LAT]]),
    fontFace('Fira Sans', 700, [['fira-700-cyrillic.woff2', CYR], ['fira-700-latin.woff2', LAT]]),
  ].join('\n');

  const blocks = [];
  let total = 0;
  let group = null;
  for (const [file, title, note, width, sect] of SHOTS) {
    const img = await image(file, width);
    if (!img) { console.log('пропуск (нет файла):', file); continue; }
    if (sect && sect !== group) { group = sect; blocks.push(`<h2 class="sect">${sect}</h2>`); }
    total += img.kb;
    console.log(file.padEnd(26), img.width + 'x' + img.height, img.kb + ' КБ');
    blocks.push(`<figure class="shot" id="${file.replace('.png', '')}">
      <figcaption>
        <h2>${title}</h2>
        ${note ? `<p>${note}</p>` : ''}
      </figcaption>
      <div class="frame">
        <img src="${img.uri}" alt="${title}" width="${img.width}" height="${img.height}"
             style="max-width:${img.width}px" loading="lazy">
      </div>
      <div class="meta"><span>${file}</span><span>${img.width}&nbsp;×&nbsp;${img.height}</span></div>
    </figure>`);
  }

  const nav = SHOTS.filter(([f]) => fs.existsSync(path.join(DATA, f)))
    .map(([f, t, , , sect]) => `<a href="#${f.replace('.png', '')}" data-sect="${sect || ''}">${t}</a>`).join('');

  const html = `<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Avalon Mapper — снимки на проверку</title>
<style>
${fonts}
/* Палитра взята из самого приложения (app/ui/style.css): тёплый почти-чёрный,
   кость и золото Albion. Светлая тема — тот же тёплый ряд, только на пергаменте. */
:root{
  --bg:#14100f; --panel:#1c1716; --panel-2:#241d1b; --edge:#c9bda626; --edge-lit:#c9bda659;
  --text:#ece0c8; --muted:#b8ab93; --dim:#8b8071; --gold:#e0a53c; --gold-hi:#f6c874;
  --shadow:0 18px 40px -22px #000;
}
@media (prefers-color-scheme: light){
  :root{ --bg:#efe7db; --panel:#f7f1e7; --panel-2:#efe6d8; --edge:#3a2a1a1f; --edge-lit:#3a2a1a40;
    --text:#2c2118; --muted:#6b5b48; --dim:#877462; --gold:#9a6a12; --gold-hi:#7d5507;
    --shadow:0 14px 30px -20px #4a3a2a66; }
}
:root[data-theme="dark"]{
  --bg:#14100f; --panel:#1c1716; --panel-2:#241d1b; --edge:#c9bda626; --edge-lit:#c9bda659;
  --text:#ece0c8; --muted:#b8ab93; --dim:#8b8071; --gold:#e0a53c; --gold-hi:#f6c874;
  --shadow:0 18px 40px -22px #000;
}
:root[data-theme="light"]{
  --bg:#efe7db; --panel:#f7f1e7; --panel-2:#efe6d8; --edge:#3a2a1a1f; --edge-lit:#3a2a1a40;
  --text:#2c2118; --muted:#6b5b48; --dim:#877462; --gold:#9a6a12; --gold-hi:#7d5507;
  --shadow:0 14px 30px -20px #4a3a2a66;
}

*{box-sizing:border-box;}
body{
  margin:0; padding:0 16px 72px;
  background:var(--bg); color:var(--text);
  font:400 16px/1.55 'Fira Sans','Segoe UI',system-ui,sans-serif;
  font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1180px; margin:0 auto; display:flex; flex-direction:column; gap:34px;}

header{padding:38px 0 6px; display:flex; flex-direction:column; gap:10px;}
h1{margin:0; font-size:clamp(26px,4.4vw,38px); font-weight:500; letter-spacing:.2px; text-wrap:balance;}
h1 b{color:var(--gold); font-weight:500;}
.lede{margin:0; max-width:62ch; color:var(--muted);}

nav{display:flex; flex-wrap:wrap; gap:8px; padding-top:6px;}
nav a{
  font-size:13px; color:var(--muted); text-decoration:none;
  padding:6px 11px; border:1px solid var(--edge); border-radius:3px; background:var(--panel);
}
nav a:hover, nav a:focus-visible{color:var(--gold-hi); border-color:var(--edge-lit); outline:none;}

.shot{margin:0; display:flex; flex-direction:column; gap:12px; scroll-margin-top:16px;}
figcaption{display:flex; flex-direction:column; gap:6px;}
h2{margin:0; font-size:20px; font-weight:500; color:var(--gold);}
/* разделитель разделов: волосяная линия и негромкая надпись — как в самой панели игры */
h2.sect{
  margin:16px 0 -10px; padding-top:22px; border-top:1px solid var(--edge);
  font-size:11px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--dim);
}
figcaption p{margin:0; max-width:70ch; color:var(--muted); font-size:15px;}

.frame{
  background:var(--panel); border:1px solid var(--edge); border-radius:4px;
  box-shadow:var(--shadow); padding:10px; overflow-x:auto;
}
/* картинку не растягиваем шире её собственных пикселей: узкие снимки (панель настроек)
   иначе размывались бы на всю ширину страницы. Предел задаётся на самом <img>. */
.frame img{display:block; width:100%; height:auto; border-radius:2px;}
/* «во весь размер»: картинка перестаёт ужиматься, а рамка скроллится по горизонтали */
.frame.full img{width:auto; max-width:none;}

.meta{display:flex; justify-content:space-between; gap:12px; font-size:12.5px; color:var(--dim);}

.tools{display:flex; gap:8px; align-items:center;}
button{
  font:500 13px/1 'Fira Sans',system-ui,sans-serif; color:var(--text);
  background:var(--panel-2); border:1px solid var(--edge-lit); border-radius:3px;
  padding:8px 12px; cursor:pointer;
}
button:hover{border-color:var(--gold); color:var(--gold-hi);}
button:focus-visible{outline:2px solid var(--gold); outline-offset:2px;}

footer{color:var(--dim); font-size:13.5px; border-top:1px solid var(--edge); padding-top:18px;}
@media (max-width:620px){ body{padding:0 12px 56px;} .frame{padding:6px;} }
</style>

<div class="wrap">
  <header>
    <h1>Avalon Mapper — <b>снимки на проверку</b></h1>
    <p class="lede">Что нового к 26 июля: общие карты — портал уходит в свою карту, в карту друзей и в общую, тремя независимыми галочками; панель настроек — плашку поверх игры можно двигать, менять размер, отключать карту зоны, а любой снимок экрана выключать целиком. Ниже — как выглядит сама плашка и листы сверки данных с игровыми картами. Страница автономна: картинки внутри неё, интернет для просмотра не нужен.</p>
    <nav>${nav}</nav>
    <div class="tools">
      <button id="full">Показать в полном размере</button>
      <button id="theme">Светлая тема</button>
    </div>
  </header>

  ${blocks.join('\n')}

  <footer>Собрано <code>tools/build-review-page.js</code> из файлов в <code>app/data</code>. Пересобрать после новых снимков: <code>node tools/build-review-page.js</code>.</footer>
</div>

<script>
  // «Полный размер» — для листов сверки: там важны детали иконок.
  const fullBtn = document.getElementById('full');
  let full = false;
  fullBtn.addEventListener('click', () => {
    full = !full;
    document.querySelectorAll('.frame').forEach(f => f.classList.toggle('full', full));
    fullBtn.textContent = full ? 'Вписать по ширине' : 'Показать в полном размере';
  });

  // Тема: кнопка перекрывает системную настройку в обе стороны.
  const themeBtn = document.getElementById('theme');
  const root = document.documentElement;
  const dark = () => (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const sync = () => { themeBtn.textContent = dark() ? 'Светлая тема' : 'Тёмная тема'; };
  themeBtn.addEventListener('click', () => { root.dataset.theme = dark() ? 'light' : 'dark'; sync(); });
  sync();
</script>`;

  fs.writeFileSync(OUT, html);
  console.log('\nстраница:', OUT, '—', Math.round(fs.statSync(OUT).size / 1024), 'КБ (картинок', total, 'КБ)');
})();
