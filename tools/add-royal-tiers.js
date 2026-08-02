// Дописывает зонам королевства ТИР и КАЧЕСТВО в royal-zones.json.
//
// ОТКУДА БЕРЁТСЯ ТИР. В сыром дампе мира (world-raw.json) у каждого кластера есть имя
// файла вида «4206_WRL_MN_AUTO_T5_KPR_ROY.cluster.xml» — уровень зоны стоит там же,
// куском «_T5_». Отдельного поля с тиром в дампе нет вовсе, и это единственное место,
// где он записан. Совпадение проверено: тир нашёлся у всех 558 зон.
//
// ОТКУДА БЕРЁТСЯ КАЧЕСТВО. Оно есть ТОЛЬКО у чёрных зон — так и в игре. В дампе оно
// записано ДВАЖДЫ, и это удача: суффиксом «_Q5» в имени файла и номером в типе зоны
// («OPENPVP_BLACK_5»). Замер: у всех 276 чёрных зон оба источника совпали, расхождений
// ноль. Поэтому берём из типа, а имя файла используем как проверку — разойдутся после
// патча игры, скрипт скажет об этом вслух, а не выберет молча один из двух.
// Диапазон Q1…Q6 (в дампе: 126/127/92/51/39/30 зон).
//
// Тир и качество нужны карточке зоны: у Авалона тир был всегда (zone-data.json), а у зон
// мира стояла только полоска цвета — по ней не понять, по зубам ли зона.
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
const qualityOf = new Map();
const conflicts = [];
for (const c of clusters) {
  const name = c['@displayname'];
  const file = c['@file'] || '';
  if (!name) continue;
  const m = /_T(\d)[_.]/.exec(file);
  if (m) tierOf.set(name, Number(m[1]));
  // Качество — только у открытых чёрных зон. Дунжи, переходы и стартовые области тоже
  // носят «_Q» в имени файла, но игрок их качеством не видит, и в справочнике зон им
  // не место: лишнее число в карточке хуже отсутствующего.
  const byType = /^OPENPVP_BLACK_(\d)$/.exec(c['@type'] || '');
  if (!byType) continue;
  const byFile = /_Q(\d)[_.]/.exec(file);
  const q = Number(byType[1]);
  if (byFile && Number(byFile[1]) !== q) { conflicts.push(`${name}: тип ${c['@type']}, файл ${file}`); continue; }
  qualityOf.set(name, q);
}

let changed = 0, missing = [];
const first = JSON.parse(fs.readFileSync(TARGETS[0], 'utf8'));
const out = first.map(z => {
  const tier = tierOf.get(z.name);
  if (tier == null) { missing.push(z.name); return z; }
  if (z.tier !== tier) changed++;
  const quality = qualityOf.get(z.name) ?? null;
  if ((z.quality ?? null) !== quality) changed++;
  // порядок ключей: name, color, tier, quality, type — всё про саму зону, потом её вид.
  // У зоны без качества поля НЕТ вовсе, а не null: справочник читают глазами, и 282
  // строки с «"quality": null» — это шум, из которого не видно главного.
  const row = { name: z.name, color: z.color, tier };
  if (quality != null) row.quality = quality;
  row.type = z.type;
  return row;
});

// Отступ РОВНО такой же, каким файл был раньше (один пробел). С двумя git видит файл
// переписанным целиком: 2791 строка удалена, 3350 добавлены вместо 558 добавленных.
// Для данных, которые меняются раз в патч игры, это разница между «видно, что изменилось»
// и «изменилось всё».
for (const f of TARGETS) fs.writeFileSync(f, JSON.stringify(out, null, 1) + '\n');

const withQ = out.filter(z => z.quality != null);
console.log(`зон: ${out.length}; тир проставлен: ${out.length - missing.length}; изменено полей: ${changed}`);
console.log(`качество проставлено: ${withQ.length} (только чёрные зоны)`);
const spread = new Map();
for (const z of withQ) spread.set(z.quality, (spread.get(z.quality) || 0) + 1);
console.log('по качеству:', [...spread].sort().map(([q, n]) => `Q${q}: ${n}`).join(' | '));
if (missing.length) console.log('без тира:', missing.slice(0, 10).join(', '));
// Тип зоны и имя файла — два независимых источника качества. Пока они сходятся, числу
// можно верить; разойдутся — значит игра сменила схему, и молчать об этом нельзя.
if (conflicts.length) {
  console.log(`\nВНИМАНИЕ: качество расходится между типом зоны и именем файла у ${conflicts.length} зон:`);
  conflicts.slice(0, 10).forEach(c => console.log('  ' + c));
}
