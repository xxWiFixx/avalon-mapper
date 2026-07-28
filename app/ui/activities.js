// Единый список активностей зоны для обоих интерфейсов — игрового оверлея и карточки
// в окне карты. Раньше каждый рисовал по-своему, и при смене формы данных один слеп.
//
// Порядок жёсткий, по ценности для игрока (задан игроком):
//   портал в Бресилиен → сундуки золотые (большой, потом малый) → синие → зелёные
//   → подземелья (золотое, синее, зелёное) → ресурсы: сначала большие, потом остальные.
//
// Размер показывается не буквой, а картинкой: у больших предметов иконка «стопкой»
// (ключ с суффиксом -big, собирает tools/make-icons.js).
(function (root) {
  const FACTION_RU = { UND: 'нежить', KPR: 'хранители', HER: 'еретики', MOR: 'Моргана', AVA: 'авалонцы' };

  // Размер — НЕ отдельная иконка: в игре пометки «большой/малый» не существует вовсе,
  // рисовать её на самой картинке значит подделывать игровую графику. Поэтому иконка
  // одна, а размер показывает оформление чипа (флаг big → класс .big, см. overlay.css).
  //
  // [ключ иконки, подпись, откуда брать число, большой?]
  const ORDER = [
    ['brecilien', 'Портал в Бресилиен', a => a.brecilien, false],
    ['gold', 'Большой золотой сундук', a => a.chests.goldBig, true],
    ['gold', 'Золотой сундук', a => a.chests.goldSmall, false],
    ['blue', 'Большой синий сундук', a => a.chests.blueBig, true],
    ['blue', 'Синий сундук', a => a.chests.blueSmall, false],
    ['green', 'Большой зелёный сундук', a => a.chests.greenBig || 0, true],
    ['green', 'Зелёный сундук', a => a.chests.green, false],
    ['dg_gold', 'Золотое подземелье', a => a.dungeons.elite, false],
    ['dg_group', 'Синее подземелье', a => a.dungeons.group, false],
    ['dg_solo', 'Зелёное подземелье', a => a.dungeons.solo, false],
  ];
  const RES = [['ore', 'Руда'], ['wood', 'Дерево'], ['fiber', 'Волокно'], ['hide', 'Шкуры'], ['rock', 'Камень']];

  // activities (запись zone-data.json) → [{ icon, ru, count, big }], уже в нужном порядке
  function listActivities(a) {
    if (!a || !a.chests) return [];
    const out = [];
    const push = (icon, ru, count, big) => { if (count > 0) out.push({ icon, ru, count, big: !!big }); };

    for (const [icon, ru, get, big] of ORDER) push(icon, ru, Number(get(a)) || 0, big);

    // ресурсы: сначала все большие, потом все малые
    const res = a.res || {};
    for (const [key, ru] of RES) push(key, 'Большие ' + ru.toLowerCase(), Number(res[key] && res[key].big) || 0, true);
    for (const [key, ru] of RES) push(key, ru, Number(res[key] && res[key].small) || 0, false);
    return out;
  }

  // подпись с фракциями подземелий — идёт в title подземельных иконок
  function dungeonTitle(a, ru) {
    const f = (a && a.dungeons && a.dungeons.factions) || [];
    return f.length ? ru + ' — ' + f.map(x => FACTION_RU[x] || x).join(', ') : ru;
  }

  root.ZONE_ACTS = { listActivities, dungeonTitle, FACTION_RU };
})(typeof window !== 'undefined' ? window : globalThis);
