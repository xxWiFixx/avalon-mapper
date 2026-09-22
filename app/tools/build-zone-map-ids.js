// Таблица «имя зоны → id карты» для оверлея.
//
// ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ. Оверлей знает про зону только ИМЯ: оно приходит с экрана
// (recognize.js) и из справочника зон. Картинки же названы id кластера — 0201.webp.
// Связать одно с другим может только cluster-ids.json, но тащить его в страницу целиком
// незачем: там 854 записи, а карт 438, и половина ключей — дороги Авалона, у которых
// своя папка.
//
// ПОЧЕМУ .js, А НЕ .json. Страница оверлея живёт под жёстким CSP (connect-src 'self'),
// и данные в неё попадают только тегом <script> — так же, как activities.js и
// graph-style.js. Отдельный fetch пришлось бы разрешать в политике, а это лишняя дыра
// ради таблицы, которая меняется раз в патч.
//
// Запуск:  node tools/build-zone-map-ids.js   (после tools/fetch-world-maps.js)
'use strict';
const fs = require('fs');
const path = require('path');

const IDS = require('../data-static/cluster-ids.json');
const MAPS = path.join(__dirname, '..', 'assets', 'world-maps');
const OUT = path.join(__dirname, '..', 'ui', 'zone-maps.js');

const have = new Set(
  (fs.existsSync(MAPS) ? fs.readdirSync(MAPS) : [])
    .filter(n => /^\d{4}\.webp$/.test(n)).map(n => n.slice(0, 4)));

// Одно имя на две зоны встречается ровно один раз — Brecilien (5000 и 5001). Берём ту,
// у которой картинка есть; если есть обе, первую по номеру. Гадать тут не о чем: город
// один, а вторая запись — его же служебный кластер.
const out = {};
for (const [id, name] of Object.entries(IDS)) {
  if (!/^\d{4}$/.test(id) || !have.has(id)) continue;
  if (out[name] && out[name] <= id) continue;
  out[name] = id;
}

const n = Object.keys(out).length;
fs.writeFileSync(OUT,
  '// СОБРАНО tools/build-zone-map-ids.js — руками не править.\n'
  + '// Имя зоны → id её картинки в assets/world-maps. Зоны Авалона сюда не входят:\n'
  + '// у них своя папка avalon-maps-crop и свои, обрезанные под плашку, картинки.\n'
  + 'window.ZONE_MAP_IDS = ' + JSON.stringify(out, null, 0) + ';\n');
console.log('зон с картой:', n, '→', path.relative(path.join(__dirname, '..'), OUT));
const worldTotal = Object.keys(IDS).filter(k => /^\d{4}$/.test(k)).length;
console.log('покрытие зон мира:', n, 'из', worldTotal, '(' + Math.round(n / worldTotal * 100) + '%)');
