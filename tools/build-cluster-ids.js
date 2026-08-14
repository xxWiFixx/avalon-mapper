#!/usr/bin/env node
// Таблица «id кластера → имя зоны». Нужна для определения зоны по трафику игры:
// при смене локации клиент получает операцию opChangeCluster, и в ней лежит id —
// у Дорог строкой «TNL-235», у зон мира числом «4208».
//
// Оба вида берутся из ОДНОГО источника, дампа игры world-raw.json, поэтому таблица
// не может разъехаться сама с собой. Имена зон Авалона при этом уже лежат в
// zone-data.json — здесь только id, чтобы не дублировать остальное.
//
// Запуск: node tools/build-cluster-ids.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'app', 'data-static', 'cluster-ids.json');

function findClusters(o) {
  if (!o || typeof o !== 'object') return null;
  if (Array.isArray(o.cluster)) return o.cluster;
  for (const k of Object.keys(o)) { const r = findClusters(o[k]); if (r) return r; }
  return null;
}

const world = JSON.parse(fs.readFileSync(path.join(ROOT, 'world-raw.json'), 'utf8'));
const clusters = findClusters(world);

const map = {};
let tnl = 0, num = 0, skipped = 0;
for (const c of clusters) {
  const id = String(c['@id'] || '');
  const name = c['@displayname'];
  if (!id || !name) { skipped++; continue; }
  // Берём только то, что игрок реально видит: туннели Авалона и зоны мира с числовым id.
  // Личные острова, гильдейские и служебные кластеры (Debug, ISLAND-*) пропускаем —
  // порталы оттуда не отмечают, а в таблице они только шум.
  if (/^TNL-\d+$/.test(id)) { map[id] = name; tnl++; }
  else if (/^\d{4}$/.test(id)) { map[id] = name; num++; }
  else skipped++;
}

fs.writeFileSync(OUT, JSON.stringify(map, null, 1));
console.log('записано', OUT);
console.log('  туннелей Авалона:', tnl, '| зон мира:', num, '| пропущено служебных:', skipped);
