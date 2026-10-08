var i18nText = (globalThis.AvalonI18n?.t || ((text, values) => Array.isArray(values) ? text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match) : text));
// Единый список активностей зоны для обоих интерфейсов — игрового оверлея и карточки
// в окне карты. Раньше каждый рисовал по-своему, и при смене формы данных один слеп.
//
// Порядок жёсткий, по ценности для игрока (задан игроком):
//   портал в Бресилиен → сундуки золотые (большой, потом малый) → синие → зелёные
//   → подземелья (золотое, синее, зелёное) → ресурсы по убыванию количества.
//
// Размер показывается не буквой, а картинкой: у больших предметов иконка «стопкой»
// (ключ с суффиксом -big, собирает tools/make-icons.js).
(function (root) {
  const FACTION_RU = { UND: i18nText("нежить"), KPR: i18nText("хранители"), HER: i18nText("еретики"), MOR: i18nText("Моргана"), AVA: i18nText("авалонцы") };

  // Размер — НЕ отдельная иконка: в игре пометки «большой/малый» не существует вовсе,
  // рисовать её на самой картинке значит подделывать игровую графику. Поэтому иконка
  // одна, а размер показывает оформление чипа (флаг big → класс .big, см. overlay.css).
  //
  // [ключ иконки, подпись, откуда брать число, большой?]
  const ORDER = [
    ['brecilien', i18nText("Портал в Бресилиен"), a => a.brecilien, false],
    ['gold', i18nText("Большой золотой сундук"), a => a.chests.goldBig, true],
    ['gold', i18nText("Золотой сундук"), a => a.chests.goldSmall, false],
    ['blue', i18nText("Большой синий сундук"), a => a.chests.blueBig, true],
    ['blue', i18nText("Синий сундук"), a => a.chests.blueSmall, false],
    ['green', i18nText("Большой зелёный сундук"), a => a.chests.greenBig || 0, true],
    ['green', i18nText("Зелёный сундук"), a => a.chests.green, false],
    ['dg_gold', i18nText("Золотое подземелье"), a => a.dungeons.elite, false],
    ['dg_group', i18nText("Синее подземелье"), a => a.dungeons.group, false],
    ['dg_solo', i18nText("Зелёное подземелье"), a => a.dungeons.solo, false],
  ];
  const RU = { ore: i18nText("Руда"), wood: i18nText("Дерево"), fiber: i18nText("Волокно"), hide: i18nText("Шкуры"), rock: i18nText("Камень") };

  // activities (запись zone-data.json) → [{ icon, ru, count, big, tier }], уже в нужном порядке.
  //
  // tier есть ТОЛЬКО у ресурсов, и путать его с тиром зоны нельзя: в L1 Royal сама зона
  // четвёртого тира, а руда с деревом в ней шестого. За ресурсом в дорогу и идут, поэтому
  // его тир показывается прямо на значке, а не прячется в подсказке. У сундуков и
  // подземелий тир всегда совпадает с зоной — там показывать нечего.
  function listActivities(a) {
    if (!a || !a.chests) return [];
    const out = [];
    const push = (icon, ru, count, big, tier) => {
      if (count > 0) out.push({ icon, ru, count, big: !!big, tier: tier || null });
    };

    for (const [icon, ru, get, big] of ORDER) push(icon, ru, Number(get(a)) || 0, big, null);

    // РЕСУРСЫ ПАРАМИ. Узел добычи в дороге даёт два вида: «FiberHide» — волокно основное,
    // шкуры дополнительные. Раньше пара разбиралась на первое слово, и второй ресурс
    // терялся молча: по 382 зонам из 400 так пропадало 522 записи.
    //
    // Одинаковые узлы (та же пара, размер и тир) сводим в один значок — иначе у зоны
    // с четырьмя одинаковыми узлами вырастало четыре одинаковых рамки. res: true —
    // знак интерфейсу, что на чипе ни числа, ни тира не рисуют (решение игрока: чип
    // из двух значков и всё, подробности в подсказке), но в группировке и то и другое
    // участвует по-прежнему — T7 и T8 сводить в один значок нельзя.
    const nodes = a.resNodes || [];
    const grouped = new Map();
    for (const nd of nodes) {
      const key = nd.main + '|' + (nd.sub || '') + '|' + (nd.big ? 'b' : 's') + '|' + (nd.tier || '');
      const g = grouped.get(key);
      if (g) g.count++;
      else grouped.set(key, { icon: nd.main, sub: nd.sub || null, count: 1, big: !!nd.big, tier: nd.tier || null, res: true });
    }
    // крупные узлы вперёд, дальше по убыванию количества
    [...grouped.values()]
      .sort((x, y) => (y.big - x.big) || (y.count - x.count))
      .forEach(g => out.push(Object.assign({ ru: RU[g.icon] || g.icon }, g)));
    return out;
  }

  // Подпись значка. У ресурса на самом чипе только картинки, поэтому подсказка несёт
  // ВСЁ остальное: пару, тир, размер и количество узлов. Потерять её — потерять данные.
  function actTitle(item, a) {
    if (item.icon.startsWith('dg_')) return dungeonTitle(a, item.ru);
    if (!item.res) return item.ru;
    // «Волокно + шкуры с того же узла, тир 6, крупный, узлов — 3» — пара объясняется
    // словами: два значка рядом сами по себе не говорят, который основной.
    return item.ru +
      (item.sub ? ' + ' + (RU[item.sub] || item.sub).toLowerCase() + i18nText(" с того же узла") : '') +
      (item.tier ? i18nText(", тир ") + item.tier : '') + (item.big ? i18nText(", крупный") : '') +
      (item.count > 1 ? i18nText(", узлов — ") + item.count : '');
  }

  // подпись с фракциями подземелий — идёт в title подземельных иконок
  function dungeonTitle(a, ru) {
    const f = (a && a.dungeons && a.dungeons.factions) || [];
    return f.length ? ru + ' — ' + f.map(x => FACTION_RU[x] || x).join(', ') : ru;
  }

  // Слой дороги словами. Ярлыки («L1 Royal», «L3 Deep Rest») приходят из mapList.json
  // проекта roadinator, но выдуманы не им: каждый один в один ложится на тип туннеля
  // из игрового дампа, и смысл берётся оттуда.
  //   L1 Royal      → TUNNEL_ROYAL          L2 Outer/Middle/Inner → TUNNEL_LOW/MEDIUM/HIGH
  //   L1 Royal Red  → TUNNEL_ROYAL_RED      L2 Rest               → TUNNEL_HIDEOUT
  //   L1 Outer      → TUNNEL_BLACK_LOW      L3 Hub                → TUNNEL_DEEP_RAID
  //   L1 Middle     → TUNNEL_BLACK_MEDIUM   L3 Deep               → TUNNEL_DEEP
  //   L1 Inner      → TUNNEL_BLACK_HIGH     L3 Deep Rest          → TUNNEL_HIDEOUT_DEEP
  // Число — удалённость от мира, слово — назначение зоны.
  const ROAD_LAYER_RU = { L1: i18nText("первый слой"), L2: i18nText("второй слой"), L3: i18nText("глубокий слой") };
  const ROAD_KIND_RU = {
    'Royal': i18nText("выход в королевские земли"),
    'Royal Red': i18nText("выход в красную зону"),
    'Outer': i18nText("низкая опасность"),
    'Middle': i18nText("средняя опасность"),
    'Inner': i18nText("высокая опасность"),
    'Rest': i18nText("можно ставить убежище"),
    'Deep': i18nText("самая глубина"),
    'Deep Rest': i18nText("убежище в глубине"),
    'Hub': i18nText("рейдовый узел"),
  };
  function roadTypeRu(type) {
  const m = /^(L\d)\s+(.+)$/.exec(String(type || ''));
  if (!m) return String(type || '');
  const layer = ROAD_LAYER_RU[m[1]], kind = ROAD_KIND_RU[m[2]];
  return layer && kind ? layer + ' — ' + kind : String(type);
  }
  root.ZONE_ACTS = { listActivities, dungeonTitle, actTitle, roadTypeRu, FACTION_RU };
})(typeof window !== 'undefined' ? window : globalThis);
