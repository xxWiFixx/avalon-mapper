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
// У roadinator тип ресурса записан парой — «OreRock», «FiberHide» и т.п. ОБА слова означают
// настоящие ресурсы зоны, а не один узел с «соседом»: у Fasos-Ayiotum пары RockWood/FiberHide/
// WoodFiber дают Rock, Wood, Fiber, Hide — ровно те четыре вида, что перечислены в блоке
// distribution дампа игры. Раньше здесь было написано обратное, и второе слово отбрасывалось:
// маркеров миникарты в зоне три, пар тоже три, счёт сходился — и ошибка выглядела проверенной.
// Отсюда бралось количество узлов; теперь оно берётся из distribution, а пары нужны только
// ради размера (Small/Big), которого в дампе нет.
const RES_PAIRS = { OreRock: 'ore', WoodFiber: 'wood', FiberHide: 'fiber', HideOre: 'hide', RockWood: 'rock' };
// distribution зовёт ресурсы по-своему: ROCK вместо Stone и всё в верхнем регистре
// ВТОРОЕ слово пары — дополнительный ресурс того же узла
const RES_PAIR_SUB = { OreRock: 'rock', WoodFiber: 'fiber', FiberHide: 'hide', HideOre: 'ore', RockWood: 'wood' };
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

    // ---- ресурсы ----
    // Узел добычи в дороге ПАРНЫЙ: «FiberHide» значит волокно как основное и шкуры как
    // дополнительное с того же узла. Это не причуда именования у roadinator — блок
    // distribution дампа игры перечисляет ровно те виды, что упомянуты в парах: у
    // Fasos-Ayiotum пары RockWood/FiberHide/WoodFiber, а в distribution Rock, Wood,
    // Fiber, Hide. Поэтому пару НЕ РАЗБИРАЕМ на первое слово, как делалось раньше:
    // так терялся второй ресурс, а с ним 522 записи по 382 зонам из 400.
    //
    // resNodes — сами узлы: что основное, что дополнительное, размер и тир.
    // res — прежние итоги по видам, они нужны маршрутизатору и старым проверкам.
    const resNodes = [];
    const res = {};
    for (const k of Object.keys(resTotal)) res[k] = { small: 0, big: 0, n: resTotal[k] };
    for (const x of comps) {
      const main = RES_PAIRS[x.type];
      if (!main) continue;
      const sub = RES_PAIR_SUB[x.type] || null;
      const big = x.size === 'Big';
      resNodes.push({ main, sub, big, tier: Number(x.tier) || null });
      res[main][big ? 'big' : 'small']++;
    }
    // если источники разошлись — верим дампу игры по количеству, недостачу считаем малыми
    for (const k of Object.keys(res)) {
      const seen = res[k].small + res[k].big;
      if (seen < res[k].n) res[k].small += res[k].n - seen;
      else if (seen > res[k].n) { res[k].big = Math.min(res[k].big, res[k].n); res[k].small = res[k].n - res[k].big; }
    }

    // тир: имя файла кластера (T4/T6/T8) — сходится с тиром сундуков у всех 400 зон
    const tier = Number((/_T(\d)_/.exec(c['@file']) || [])[1]) || null;

    // Тир РЕСУРСОВ — отдельное число, и путать его с тиром зоны нельзя: в L1 Royal зона
    // четвёртого тира, а руда с деревом в ней шестого. Игрок идёт в дорогу именно за
    // ресурсом, поэтому его тир важнее тира самой зоны.
    //
    // Берём максимум по ресурсным узлам зоны, но на деле выбирать не из чего: на всех
    // 400 зонах у ресурсов ОДИН тир внутри слоя (L1 Royal и L2 Outer — T6, глубокие
    // L3 Deep и L3 Hub — T8, остальные T7). Максимум стоит на случай, если игра однажды
    // смешает тиры в одной зоне: тогда мы покажем лучший, а не случайный.
    const resTiers = resNodes.map(r => r.tier).filter(Boolean);
    const resTier = resTiers.length ? Math.max(...resTiers) : null;

    out.push({
      name, tier, resTier,
      type: m ? m.data.type : null,          // «слой» дороги: L1 Outer, L3 Hub и т.д.
      tunnel: c['@type'],                    // TUNNEL_BLACK_LOW / TUNNEL_ROYAL / …
      chests, dungeons: { ...dg, factions }, res, resNodes, brecilien,
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
