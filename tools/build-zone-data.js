#!/usr/bin/env node
// Пересборка справочника зон Авалона из ДВУХ источников.
//
// Зачем: старый zones.json (снятый с albiononlinebuilds.com) врёт по активностям —
// blue >= 1 у всех 400 зон подряд (значит «синий сундук» рисовался везде), групповой данж
// отмечен у 2 зон вместо 180, ресурсы расходятся с игрой у 130–250 зон, волокна нет вовсе.
//
// Что откуда:
//   world-raw.json (дамп игры ao-bin-dumps, лежит в проекте) — тир, тип туннеля, ДАНЖИ
//     (dungeon_solo / dungeon_group / dungeon_elite) и РЕСУРСЫ (Ore/Wood/Fiber/Hide/Stone)
//     маркерами миникарты, с координатами. Это первоисточник, ему верим.
//   mapList.json (obxd/roadinator-web) — СУНДУКИ: цвет (Green/Blue/Gold) и размер (Small/Big),
//     а также портал в Brecilien (компонент mistscity) и фракция данжа. Сундуков в дампе мира нет.
//
// Запуск: node tools/build-zone-data.js   (--offline — не ходить в сеть, взять кеш)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAPLIST_URL = 'https://raw.githubusercontent.com/obxd/roadinator-web/main/src/assets/mapList.json';
const MAPLIST_CACHE = path.join(ROOT, 'roadinator-maplist.json');
const WORLD = path.join(ROOT, 'world-raw.json');
// Пишем ВНУТРЬ app/: справочники должны попасть в сборку вместе с приложением.
const OUT = path.join(ROOT, 'app', 'data-static', 'zone-data.json');

// Ресурсы. В дампе игры маркер называется по своему типу (Stone = наш rock).
const RES_KEYS = { Ore: 'ore', Wood: 'wood', Fiber: 'fiber', Hide: 'hide', Stone: 'rock' };
// У roadinator тип ресурса записан парой — «OreRock», «HideOre» и т.п. ПЕРВОЕ слово и есть
// сам ресурс (проверено: у Fasos-Ayiotum пары RockWood/FiberHide/WoodFiber дают ровно
// маркеры Stone+Fiber+Wood из дампа игры), второе — соседний. Всего 820 пар и 820 маркеров,
// то есть одна пара = один узел. Размер (Small/Big) относится к этому узлу.
const RES_PAIRS = { OreRock: 'ore', WoodFiber: 'wood', FiberHide: 'fiber', HideOre: 'hide', RockWood: 'rock' };
const FACTION_RU = { UND: 'Нежить', KPR: 'Хранители', HER: 'Еретики', MOR: 'Моргана', AVA: 'Авалонцы' };

async function getMapList() {
  if (process.argv.includes('--offline') && fs.existsSync(MAPLIST_CACHE)) {
    return JSON.parse(fs.readFileSync(MAPLIST_CACHE, 'utf8'));
  }
  try {
    const res = await fetch(MAPLIST_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    JSON.parse(text);                       // проверяем до записи, чтобы не затереть кеш мусором
    fs.writeFileSync(MAPLIST_CACHE, text);
    console.log('скачано mapList.json:', Math.round(text.length / 1024), 'КБ');
    return JSON.parse(text);
  } catch (err) {
    if (!fs.existsSync(MAPLIST_CACHE)) throw new Error('нет сети и нет кеша: ' + err.message);
    console.log('сеть недоступна (' + err.message + '), беру кеш');
    return JSON.parse(fs.readFileSync(MAPLIST_CACHE, 'utf8'));
  }
}

function findClusters(o) {
  if (!o || typeof o !== 'object') return null;
  if (Array.isArray(o.cluster)) return o.cluster;
  for (const k of Object.keys(o)) { const r = findClusters(o[k]); if (r) return r; }
  return null;
}

(async () => {
  const maps = await getMapList();
  const world = JSON.parse(fs.readFileSync(WORLD, 'utf8'));
  const tunnels = findClusters(world).filter(c => String(c['@type'] || '').startsWith('TUNNEL'));
  console.log('туннелей в дампе игры:', tunnels.length, '| дорог в mapList:', maps.length);

  const byName = new Map(maps.map(m => [m.name, m]));
  const out = [];
  const missing = [];

  for (const c of tunnels) {
    const name = c['@displayname'];
    const m = byName.get(name);
    if (!m) missing.push(name);

    // ---- из дампа игры: данжи и ресурсы маркерами ----
    // Данжи в игре различаются ЦВЕТОМ свечения (сверено по картам зон):
    // solo — зелёный шатёр, group — ворота с синим кристаллом, elite — те же ворота с золотым.
    const markers = [].concat(c.minimapmarkers?.marker || []);
    const dg = { solo: 0, group: 0, elite: 0 };
    const resTotal = { ore: 0, wood: 0, fiber: 0, hide: 0, rock: 0 };
    for (const mk of markers) {
      const t = mk['@type'];
      if (t === 'dungeon_solo') dg.solo++;
      else if (t === 'dungeon_group') dg.group++;
      else if (t === 'dungeon_elite') dg.elite++;
      else if (RES_KEYS[t]) resTotal[RES_KEYS[t]]++;
    }

    // ---- из roadinator: сундуки, портал в Brecilien, фракции данжей ----
    const comps = m ? m.data.components : [];
    const chest = (col, size) => comps.filter(x => x.type === 'chest' && x.bgcolor === col && x.size === size).length;
    const chests = {
      green: chest('Green', 'Small') + chest('Green', 'Big'),
      blueSmall: chest('Blue', 'Small'),
      blueBig: chest('Blue', 'Big'),
      goldSmall: chest('Gold', 'Small'),
      goldBig: chest('Gold', 'Big'),
    };
    const factions = comps.filter(x => x.type === 'dungeon').map(x => x.size);
    const brecilien = comps.some(x => x.type === 'mistscity') ? 1 : 0;

    // ---- размеры ресурсов: количество берём из дампа игры, размер — у roadinator ----
    const res = {};
    for (const k of Object.keys(resTotal)) res[k] = { small: 0, big: 0, n: resTotal[k] };
    for (const x of comps) {
      const key = RES_PAIRS[x.type];
      if (!key) continue;
      res[key][x.size === 'Big' ? 'big' : 'small']++;
    }
    // если источники разошлись — верим дампу игры по количеству, недостачу считаем малыми
    for (const k of Object.keys(res)) {
      const seen = res[k].small + res[k].big;
      if (seen < res[k].n) res[k].small += res[k].n - seen;
      else if (seen > res[k].n) { res[k].big = Math.min(res[k].big, res[k].n); res[k].small = res[k].n - res[k].big; }
    }

    // тир: имя файла кластера (T4/T6/T8) — сходится с тиром сундуков у всех 400 зон
    const tier = Number((/_T(\d)_/.exec(c['@file']) || [])[1]) || null;

    out.push({
      name, tier,
      type: m ? m.data.type : null,          // «слой» дороги: L1 Outer, L3 Hub и т.д.
      tunnel: c['@type'],                    // TUNNEL_BLACK_LOW / TUNNEL_ROYAL / …
      chests, dungeons: { ...dg, factions }, res, brecilien,
      cluster: c['@id'],
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('записано', OUT, '—', out.length, 'зон');
  if (missing.length) console.log('НЕТ в mapList (сундуки неизвестны):', missing.join(', '));

  // ---- сводка: что изменилось против старого zones.json ----
  const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'zones.json'), 'utf8'));
  const oldBy = new Map(old.map(z => [z.name, z]));
  let tierDiff = 0, groupWas = 0, groupNow = 0, blueWas = 0, blueNow = 0;
  for (const z of out) {
    const o = oldBy.get(z.name);
    if (o && o.tier !== z.tier) tierDiff++;
    if (o && o.dg_group > 0) groupWas++;
    if (z.dungeons.group > 0) groupNow++;
    if (o && o.blue > 0) blueWas++;
    if (z.chests.blueBig + z.chests.blueSmall > 0) blueNow++;
  }
  const sum = k => out.reduce((s, z) => s + k(z), 0);
  const resMismatch = out.filter(z => Object.keys(z.res).some(k => z.res[k].small + z.res[k].big !== z.res[k].n)).length;
  console.log('  ресурсы: больших', sum(z => Object.values(z.res).reduce((a, r) => a + r.big, 0)),
    '/ малых', sum(z => Object.values(z.res).reduce((a, r) => a + r.small, 0)), '| расхождений источников:', resMismatch);
  console.log('\nсверка со старым zones.json:');
  console.log('  тир разошёлся у зон:', tierDiff);
  console.log('  групповой данж: было', groupWas, '→ стало', groupNow);
  console.log('  синий сундук:   было', blueWas, '→ стало', blueNow);
  console.log('  соло-данж:', out.filter(z => z.dungeons.solo > 0).length, '| элитный:', out.filter(z => z.dungeons.elite > 0).length);
  console.log('  золотые сундуки: маленьких', sum(z => z.chests.goldSmall), '/ больших', sum(z => z.chests.goldBig),
    '— в зонах:', out.filter(z => z.chests.goldSmall + z.chests.goldBig > 0).length);
  console.log('  портал в Brecilien:', out.filter(z => z.brecilien).length, 'зон');
  console.log('  волокно (новое поле):', out.filter(z => z.res.fiber > 0).length, 'зон');
  console.log('  фракции данжей:', Object.keys(FACTION_RU).join('/'));
})();
