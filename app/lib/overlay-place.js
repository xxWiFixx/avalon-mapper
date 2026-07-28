// Где и какого размера стоит игровой оверлей. Вынесено из main.js отдельно по одной
// причине: эта арифметика уже ломалась на втором мониторе и на масштабе Windows,
// а проверить её внутри main.js нельзя — там Electron. Здесь чистые функции,
// на вход — то, что main спросил у screen.*, на выход — готовые границы окна.
//
// Единицы. Замеры экрана (плашка зоны) — в ФИЗИЧЕСКИХ пикселях виртуального рабочего
// стола: так их отдаёт наш захват через BitBlt. Границы окна Electron задаёт в ТОЧКАХ
// (DIP). Перевод один: физические / scaleFactor того экрана, на котором окно стоит.
'use strict';

const W_1080 = 290;            // ширина блока в вёрстке (ui/overlay.css)
const H_1080 = 470;            // с запасом: блок прижат к низу окна, лишнее прозрачно
const MINIMAP_TOP_1080 = 267;  // от верха плашки зоны до верхушки компаса «N» миникарты
const GAP_1080 = 12;           // зазор между нашим блоком и миникартой
const SCALE_MIN = 0.6, SCALE_MAX = 2.5;
const EDGE_KEEP = 40;          // столько пикселей плашки всегда остаётся на экране

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function clampScale(v) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, SCALE_MIN, SCALE_MAX) : 1;
}

// Своё место годится, только если оно ещё существует: монитор могли отключить,
// разрешение сменить. display — тот, что screen отдал как ближайший к точке.
function validPos(pos, display) {
  if (!pos || !display) return false;
  const { x, bottom } = pos;
  if (!Number.isFinite(x) || !Number.isFinite(bottom)) return false;
  const b = display.bounds;
  return x >= b.x - EDGE_KEEP && x <= b.x + b.width - EDGE_KEEP
    && bottom >= b.y + 20 && bottom <= b.y + b.height + 20;
}

// strip: прямоугольник плашки зоны в физических пикселях + высота экрана,
//        то есть ровно то, что возвращает zoneStripRect() в main.js;
// pos:   своё место игрока { x, bottom } в точках (DIP) или null;
// display: экран, на котором окно окажется (для pos — ближайший к нему,
//        иначе — тот, где курсор). Нужен только его scaleFactor.
function bounds({ strip, scale = 1, pos = null, display = null }) {
  const game = strip.screenHeight / 1080;        // масштаб интерфейса игры
  const s = game * clampScale(scale);            // × размер, выбранный игроком
  const w = Math.round(W_1080 * s), h = Math.round(H_1080 * s);
  const sf = (display && display.scaleFactor) || 1;
  const width = Math.round(w / sf), height = Math.round(h / sf);
  const zoom = s / sf;
  // своё место: держим НИЖНИЙ край. Содержимое разной высоты и рост от масштаба
  // тянутся вверх, а низ остаётся там, где его поставили
  if (pos) return { x: Math.round(pos.x), y: Math.round(pos.bottom - height), width, height, zoom };
  // стандартное: над миникартой, по левому краю плашки зоны. Якорь считаем по масштабу
  // ИГРЫ — миникарта не двигается от того, что игрок сделал нашу плашку крупнее
  const bottom = strip.y - MINIMAP_TOP_1080 * game - GAP_1080 * game;
  return {
    x: Math.round(strip.x / sf), y: Math.round(bottom / sf) - height,
    width, height, zoom,
  };
}

// Окно, прижатое к тому же нижнему левому углу, что и плашка. По этому правилу встаёт
// окно поиска зоны: игрок уже знает, где ждать плашку с картой, — пусть и поиск
// появляется там же, а не там, где в этот миг оказалась мышь.
// box — границы плашки (DIP), workArea — рабочая область экрана без панели задач.
function anchorTo(box, { width, height, workArea }) {
  return {
    width, height,
    x: Math.round(clamp(box.x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(box.y + box.height - height, workArea.y, workArea.y + workArea.height - height)),
  };
}

// Куда встанет окно при перетаскивании: границы на момент захвата + сдвиг курсора,
// но так, чтобы кусок плашки всегда остался на экране.
function dragTo({ bounds: b, dx, dy, workArea: wa }) {
  const x = clamp(b.x + dx, wa.x - b.width + EDGE_KEEP, wa.x + wa.width - EDGE_KEEP);
  const bottom = clamp(b.y + b.height + dy, wa.y + EDGE_KEEP, wa.y + wa.height);
  return { x: Math.round(x), y: Math.round(bottom - b.height), width: b.width, height: b.height };
}

module.exports = {
  W_1080, H_1080, MINIMAP_TOP_1080, SCALE_MIN, SCALE_MAX, EDGE_KEEP,
  clamp, clampScale, validPos, bounds, dragTo, anchorTo,
};
