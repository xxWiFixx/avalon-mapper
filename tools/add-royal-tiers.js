// Дописывает тир зонам королевства в royal-zones.json.
//
// ОТКУДА БЕРЁТСЯ ТИР. В сыром дампе мира (world-raw.json) у каждого кластера есть имя
// файла вида «4206_WRL_MN_AUTO_T5_KPR_ROY.cluster.xml» — уровень зоны стоит там же,
// куском «_T5_». Отдельного поля с тиром в дампе нет вовсе, и это единственное место,
// где он записан. Совпадение проверено: тир нашёлся у всех 558 зон.
//
// Тир нужен карточке зоны: у Авалона он был всегда (zone-data.json), а у зон мира
// стояла только полоска цвета — по ней не понять, по зубам ли зона.
//
// Запуск:  node tools/add-royal-tiers.js
// Пишет оба файла: корневой (источник правды) и app/data-static (то, что читает приложение).
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'world-raw.json');
const TARGETS = [
  path.join(ROOT, 'royal-zones.json'),
  path.join(ROOT, 'app', 'data-static', 'royal-zones.json'),
];

const world = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const clusters = world.world.clusters.cluster;

// Имя → тир. Берём последнее совпадение «_T<цифра>_» в имени файла: у некоторых кластеров
// есть и другие подчёркивания с буквой T, но уровень всегда идёт цифрой сразу за ней.
const tierOf = new Map();
for (const c of clusters) {
  const name = c['@displayname'];
  const file = c['@file'] || '';
  if (!name) continue;
  const m = /_T(\d)[_.]/.exec(file);
  if (m) tierOf.set(name, Number(m[1]));
}

let changed = 0, missing = [];
const first = JSON.parse(fs.readFileSync(TARGETS[0], 'utf8'));
const out = first.map(z => {
  const tier = tierOf.get(z.name);
  if (tier == null) { missing.push(z.name); return z; }
  if (z.tier !== tier) changed++;
  // порядок ключей: name, color, tier, type — тир рядом с цветом, оба про саму зону
  return { name: z.name, color: z.color, tier, type: z.type };
});

// Отступ РОВНО такой же, каким файл был раньше (один пробел). С двумя git видит файл
// переписанным целиком: 2791 строка удалена, 3350 добавлены вместо 558 добавленных.
// Для данных, которые меняются раз в патч игры, это разница между «видно, что изменилось»
// и «изменилось всё».
for (const f of TARGETS) fs.writeFileSync(f, JSON.stringify(out, null, 1) + '\n');

console.log(`зон: ${out.length}; тир проставлен: ${out.length - missing.length}; изменено: ${changed}`);
if (missing.length) console.log('без тира:', missing.slice(0, 10).join(', '));
