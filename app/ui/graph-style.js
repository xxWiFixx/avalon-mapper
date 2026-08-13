// Оформление графа зон. Единственный источник правды: используется и приложением (map.js),
// и стендом оформления (harness.html), чтобы они не разъезжались.
// Цвета зон — канон Albion, это семантика данных, а не декор: менять нельзя.
window.ZONE_COLORS = {
  avalon: '#a78bfa',
  blue: '#3b82f6',
  yellow: '#eab308',
  red: '#ef4444',
  black: '#27272a',
  city: '#22c55e',
  'city-black': '#166534',
};

// Всё остальное — палитра интерфейса, и она БЕРЁТСЯ ИЗ style.css, а не повторяется здесь.
// Раньше значения были выписаны рядом «те же, что в style.css» — пока тема была одна, это
// работало; со второй темой такой список молча остался бы от первой, и граф светил бы
// костяными подписями по пергаменту. Теперь цвета читаются из тех же переменных, что
// красят весь остальной интерфейс, поэтому разъехаться им негде.
//
// IIFE: файл грузится как обычный <script>, а глобальные const в таком контексте
// падают с «already been declared» при любом повторном подключении и роняют весь UI.
// Тир зоны цифрой на самом узле — как у порталлера. У cytoscape подпись у узла ровно
// одна, и она занята именем зоны, поэтому число рисуется картинкой поверх заливки.
// Тиров всего три (4, 6, 8), картинки собираются один раз и кэшируются: на сотне зон
// это три строки в памяти, а не сто.
//
// Цифра тёмная со светлым ореолом: узлы бывают и фиолетовыми, и жёлтыми, и почти
// чёрными (зона black — #27272a), и одного цвета, читаемого на всех, не существует.
const TIER_CACHE = {};
window.tierBadge = function (tier) {
  if (TIER_CACHE[tier]) return TIER_CACHE[tier];
  // Рисуем в 64 px и показываем в 21: у cytoscape картинка узла масштабируется как
  // растр, и в исходном размере цифра расплывалась на любом зуме крупнее единицы.
  //
  // Белая цифра с тонкой тёмной кромкой. Толстый светлый ореол пробовали — он съедал
  // сам узел: на ромбе в 29 px от заливки оставалась одна рамка, и цвет зоны переставал
  // читаться. Тонкая кромка держит цифру на фиолетовом, жёлтом и почти чёрном одинаково,
  // а узел остаётся узлом.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<text x="32" y="46" text-anchor="middle" font-family="Fira Sans, Segoe UI, sans-serif" ' +
    'font-size="44" font-weight="700" stroke="#100c0b" stroke-width="7" stroke-linejoin="round" ' +
    'paint-order="stroke" fill="#ffffff">' + tier + '</text></svg>';
  return (TIER_CACHE[tier] = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg));
};

(() => {
const UI_FONT = 'Fira Sans, Segoe UI, sans-serif';
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Пересобирается на каждую смену темы: cytoscape держит разобранный стиль у себя,
// и просто сменить переменную мало — холст о ней не знает.
window.graphStyle = function () {
const CANVAS = css('--bg-deep');   // холст графа: подложка под подписями
const ACCENT = css('--gold');      // золото Albion: «ты здесь» и маршрут
const ROUTE  = css('--gold-hi');   // подпись на подсвеченном маршруте
const EMBER  = css('--ember');     // «портал скоро закроется»
const LINE   = css('--graph-line');
const NODE_EDGE = css('--graph-node-edge');
const FRESH  = css('--fresh');
const TEXT_2 = css('--text-2');
const TEXT_3 = css('--text-3');

return [
  { selector: 'node', style: {
    label: 'data(label)', color: TEXT_2,
    'font-family': UI_FONT, 'font-size': 11, 'font-weight': 500,
    'text-valign': 'bottom', 'text-margin-y': 7, 'text-wrap': 'wrap', 'text-max-width': 96,
    // подложка под подписью: иначе имя зоны сливается с рёбрами и соседними подписями
    'text-background-color': CANVAS, 'text-background-opacity': 0.84,
    'text-background-padding': 3, 'text-background-shape': 'roundrectangle',
    'min-zoomed-font-size': 7,
    width: 24, height: 24, 'background-color': 'data(color)',
    'border-width': 1.5, 'border-color': NODE_EDGE,   // оправа, как у значков игры
    'transition-property': 'border-color, border-width, opacity, background-color',
    'transition-duration': 160, 'transition-timing-function': 'ease-out-cubic',
  }},
  { selector: 'node[?isAvalon]', style: { shape: 'diamond', width: 29, height: 29 } },
  // Цифра тира поверх заливки. Ромб Авалона обрезает картинку по своей форме, поэтому
  // значок заметно мельче узла — иначе у него срезало бы углы вместе с цифрой.
  { selector: 'node[tierIcon]', style: {
    'background-image': 'data(tierIcon)', 'background-fit': 'none',
    'background-width': '21px', 'background-height': '21px',
    'background-image-opacity': 1, 'background-clip': 'node',
  }},
  // ГДЕ ИГРОК СЕЙЧАС. Была только оправа потолще — на графе из сотни зон её не находил
  // глаз. Добавлен ореол: единственный светящийся узел читается сразу, а цвет тот же
  // акцентный, так что новой сущности в оформлении не появилось.
  //
  // Эта отметка живёт ТОЛЬКО на своей машине. Позиции игроков не выгружаются никуда
  // (в lib/sync.js нет ни слова про players), а чужие записи main.js стирает при запуске:
  // видеть, кто где стоит, нельзя ни друзьям про тебя, ни тебе про друзей.
  { selector: 'node[?here]', style: {
    'border-width': 4, 'border-color': ACCENT, color: ACCENT, 'font-weight': 600,
    'overlay-color': ACCENT, 'overlay-opacity': 0.14, 'overlay-padding': 9, 'z-index': 35,
  }},
  // Короткая вспышка после нажатия «Моя зона»: камера доехала, но глазу нужно за что-то
  // зацепиться в момент прибытия.
  { selector: 'node.locate', style: {
    'overlay-color': ACCENT, 'overlay-opacity': 0.3, 'overlay-padding': 18, 'z-index': 41,
  }},
  { selector: 'node:active', style: { 'overlay-color': ACCENT, 'overlay-opacity': 0.12, 'overlay-padding': 8 } },
  { selector: 'edge', style: {
    label: 'data(label)', color: TEXT_3,
    'font-family': UI_FONT, 'font-size': 10,
    'text-background-color': CANVAS, 'text-background-opacity': .86, 'text-background-padding': 3,
    'text-background-shape': 'roundrectangle', 'min-zoomed-font-size': 7,
    width: 2, 'line-color': LINE, 'curve-style': 'bezier',
    // ПЕРЕХОД ПО line-color И width УБРАН — он ломал раскраску рёбер насмерть.
    //
    // Механизм: переход стиля cytoscape проигрывает через bypass на элементе, и этот
    // bypass остаётся висеть, если анимацию прервать (а её прерывает любая перерисовка
    // данных, которая у нас идёт тиком раз в пять секунд). Дальше bypass НАВСЕГДА
    // перекрывает правила: сколько ни ставь флаг, цвет и толщина не меняются.
    // Замер на стенде: ребро застревало на width 2.000001px — это лерпнутое значение,
    // отпечаток недоигранного перехода; `removeStyle()` снимал bypass, и правило вставало.
    //
    // Из-за этого НЕ РАБОТАЛО и давнее правило `edge[?soon]`: портал, которому осталось
    // меньше получаса, оранжевым не становился. Полсекунды плавности не стоят того,
    // чтобы цвет ребра не работал вовсе; opacity оставлен — на нём подсветка маршрута,
    // и там переход отыгрывает.
    'transition-property': 'opacity', 'transition-duration': 160,
  }},
  { selector: 'edge[?soon]', style: { 'line-color': EMBER, color: EMBER, width: 2.5 } },
  // Портал, записанный только что (первые 5 минут): зелёный, чтобы его было видно среди
  // сотни прочих без поиска по названию. Спокойнее, чем вспышка `.fresh` ниже: та держится
  // секунды и кричит «вот прямо сейчас», а эта висит пять минут — кричать всё это время
  // нельзя, граф станет нечитаемым. Стоит ВЫШЕ правил маршрута нарочно: когда игрок
  // смотрит путь, подсветка пути важнее свежести и должна перебивать.
  { selector: 'edge[?recent]', style: { 'line-color': FRESH, color: FRESH, width: 3 } },
  // подсветка маршрута: всё вне пути гасим, путь — ярче и толще
  { selector: '.route-dim', style: { opacity: 0.1, 'text-opacity': 0.1 } },
  { selector: 'node.route-hit', style: {
    'border-width': 3, 'border-color': ACCENT, color: ROUTE,
    'font-size': 12, 'font-weight': 600, 'z-index': 30,
  }},
  { selector: 'edge.route-hit', style: {
    'line-color': ACCENT, width: 4, color: ROUTE, 'line-style': 'solid', 'z-index': 29,
  }},
  // Связь, дорисованная на время показа маршрута: такого ребра в карте нет (выход в мир,
  // чужая зона), но без него путь на графе рвался и читался кусками. Тоньше настоящего —
  // чтобы не выдавать себя за известный портал.
  { selector: 'edge.route-ghost', style: {
    'line-color': ACCENT, width: 3, opacity: .75, 'curve-style': 'straight',
    'line-style': 'solid', 'z-index': 28, label: '',
  }},
  // Только что записанный портал: держится несколько секунд, чтобы глаз нашёл его сам,
  // без поиска по названию. Ярче маршрута — маршрут статичен, а это событие «прямо сейчас».
  { selector: 'node.fresh', style: {
    'border-width': 5, 'border-color': FRESH, color: FRESH,
    'font-size': 12, 'font-weight': 600, 'z-index': 40,
    'overlay-color': FRESH, 'overlay-opacity': .18, 'overlay-padding': 10,
  }},
  { selector: 'edge.fresh', style: {
    'line-color': FRESH, width: 5, color: FRESH,
    'line-style': 'solid', opacity: 1, 'z-index': 39,
  }},
  { selector: ':selected', style: { 'overlay-color': ACCENT, 'overlay-opacity': .16, 'overlay-padding': 7 } },
];
};

// Стенд оформления и первый запуск приложения берут стиль отсюда; смена темы зовёт
// graphStyle() заново.
window.GRAPH_STYLE = window.graphStyle();
})();
