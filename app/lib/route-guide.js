// Проводник по маршруту: где игрок относительно найденного пути.
//
// ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ. Само по себе «показать следующие зоны» выглядит просто, но
// вся суть в краях: игрок дошёл до конца, игрок ещё не дошёл до начала, игрок свернул
// не туда, портал по дороге закрылся. Каждый такой случай на экране выглядит одинаково —
// строкой из двух названий, — и ошибиться в нём можно молча. Поэтому логика живёт здесь
// и проверяется тестами, а не подбирается в игре между забросами.
//
// ЧТО НА ВХОДЕ. Шаги маршрута от lib/router.js: [{ from, to, kind, expiresAt, … }].
// Они выстроены цепью: to шага i — это from шага i+1.
//
// ЧТО НА ВЫХОДЕ. { state, idx, left, done, off, steps } — состояние словом и хвост пути.
'use strict';

// Максимум шагов, которые показываем на экране. Больше трёх — плашка перестаёт быть
// подсказкой и становится списком, а он есть в окне карты.
const SHOW = 3;

// Где мы на маршруте.
//   'go'      — идём, впереди шаги; idx — индекс ближайшего
//   'done'    — дошли до конечной
//   'off'     — текущая зона на маршруте не встречается: свернули не туда
//   'unknown' — зона ещё не известна (аддон только запустился)
function progress(steps, zone) {
  const list = Array.isArray(steps) ? steps.filter(s => s && s.from && s.to) : [];
  if (!list.length) return { state: 'done', idx: -1, left: 0, steps: [] };
  if (!zone) return { state: 'unknown', idx: 0, left: list.length, steps: list.slice(0, SHOW) };

  // Конечная. Проверяем ПЕРВОЙ: конечная зона может встречаться и как from какого-нибудь
  // шага, если маршрут где-то делает петлю, и тогда «дошёл» превратилось бы в «иди дальше».
  if (zone === list[list.length - 1].to) return { state: 'done', idx: list.length, left: 0, steps: [] };

  const i = list.findIndex(s => s.from === zone);
  if (i >= 0) return { state: 'go', idx: i, left: list.length - i, steps: list.slice(i, i + SHOW) };

  // Зона попадалась как КОНЕЦ шага, но началом никуда не идёт. В честной цепи такого не
  // бывает нигде, кроме конечной, — а её мы уже проверили. Значит цепь порвана: ведём от
  // следующего шага, но честно, а не делая вид, что всё по плану.
  const back = list.findIndex(s => s.to === zone);
  if (back >= 0 && back + 1 < list.length) {
    return { state: 'go', idx: back + 1, left: list.length - back - 1, steps: list.slice(back + 1, back + 1 + SHOW) };
  }

  // Зоны на маршруте нет вовсе. Молчать нельзя: игрок будет идти по подсказке, которая
  // к нему уже не относится. Показываем начало пути и говорим прямо, что свернули.
  return { state: 'off', idx: -1, left: list.length, steps: list.slice(0, SHOW) };
}

// Готовый снимок для оверлея: то, что рисуется, и ничего лишнего.
// Имя цели держим отдельно от шагов — при 'off' и 'done' шагов может не быть вовсе.
function board(guide, zone) {
  if (!guide || !Array.isArray(guide.steps)) return null;
  const p = progress(guide.steps, zone);
  return {
    state: p.state,
    left: p.left,
    total: guide.steps.length,
    to: guide.to || (guide.steps.length ? guide.steps[guide.steps.length - 1].to : null),
    zone: zone || null,
    steps: p.steps.map(s => ({ from: s.from, to: s.to, kind: s.kind || null, expiresAt: s.expiresAt || null })),
  };
}

module.exports = { progress, board, SHOW };
