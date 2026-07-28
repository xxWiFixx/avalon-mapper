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

// Всё остальное — палитра интерфейса, те же значения, что в style.css.
// IIFE: файл грузится как обычный <script>, а глобальные const в таком контексте
// падают с «already been declared» при любом повторном подключении и роняют весь UI.
(() => {
const CANVAS = '#100c0b';   // холст графа
const ACCENT = '#e0a53c';   // золото Albion: «ты здесь» и маршрут
const EMBER  = '#e07a35';   // «портал скоро закроется»
const LINE   = '#4a423e';
const TEXT_2 = '#b8ab93';   // кость
const TEXT_3 = '#948877';
const UI_FONT = 'Fira Sans, Segoe UI, sans-serif';

window.GRAPH_STYLE = [
  { selector: 'node', style: {
    label: 'data(label)', color: TEXT_2,
    'font-family': UI_FONT, 'font-size': 11, 'font-weight': 500,
    'text-valign': 'bottom', 'text-margin-y': 7, 'text-wrap': 'wrap', 'text-max-width': 96,
    // подложка под подписью: иначе имя зоны сливается с рёбрами и соседними подписями
    'text-background-color': CANVAS, 'text-background-opacity': 0.84,
    'text-background-padding': 3, 'text-background-shape': 'roundrectangle',
    'min-zoomed-font-size': 7,
    width: 24, height: 24, 'background-color': 'data(color)',
    'border-width': 1.5, 'border-color': '#c9bda647',   // костяная оправа, как у значков игры
    'transition-property': 'border-color, border-width, opacity, background-color',
    'transition-duration': 160, 'transition-timing-function': 'ease-out-cubic',
  }},
  { selector: 'node[?isAvalon]', style: { shape: 'diamond', width: 29, height: 29 } },
  { selector: 'node[?here]', style: { 'border-width': 4, 'border-color': ACCENT, color: ACCENT, 'font-weight': 600 } },
  { selector: 'node:active', style: { 'overlay-color': ACCENT, 'overlay-opacity': 0.12, 'overlay-padding': 8 } },
  { selector: 'edge', style: {
    label: 'data(label)', color: TEXT_3,
    'font-family': UI_FONT, 'font-size': 10,
    'text-background-color': CANVAS, 'text-background-opacity': .86, 'text-background-padding': 3,
    'text-background-shape': 'roundrectangle', 'min-zoomed-font-size': 7,
    width: 2, 'line-color': LINE, 'curve-style': 'bezier',
    'transition-property': 'line-color, width, opacity', 'transition-duration': 160,
  }},
  { selector: 'edge[?soon]', style: { 'line-color': EMBER, color: EMBER, width: 2.5 } },
  // подсветка маршрута: всё вне пути гасим, путь — ярче и толще
  { selector: '.route-dim', style: { opacity: 0.1, 'text-opacity': 0.1 } },
  { selector: 'node.route-hit', style: {
    'border-width': 3, 'border-color': ACCENT, color: '#f6c874',
    'font-size': 12, 'font-weight': 600, 'z-index': 30,
  }},
  { selector: 'edge.route-hit', style: {
    'line-color': ACCENT, width: 4, color: '#f6c874', 'line-style': 'solid', 'z-index': 29,
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
    'border-width': 5, 'border-color': '#7fe3a0', color: '#7fe3a0',
    'font-size': 12, 'font-weight': 600, 'z-index': 40,
    'overlay-color': '#7fe3a0', 'overlay-opacity': .18, 'overlay-padding': 10,
  }},
  { selector: 'edge.fresh', style: {
    'line-color': '#7fe3a0', width: 5, color: '#7fe3a0',
    'line-style': 'solid', opacity: 1, 'z-index': 39,
  }},
  { selector: ':selected', style: { 'overlay-color': ACCENT, 'overlay-opacity': .16, 'overlay-padding': 7 } },
];
})();
