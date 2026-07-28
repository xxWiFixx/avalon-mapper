// Выбор области с плашкой зоны: игрок обводит её мышью прямо на снимке своего экрана.
// UI игры у всех разный (миникарту двигают и масштабируют), поэтому жёсткий угол не годится.
//
// Координаты: снимок показан растянутым на всё окно, а сам он в ФИЗИЧЕСКИХ пикселях экрана.
// Пересчёт делаем по отношению натурального размера картинки к размеру окна — так DPI
// и масштабирование Windows учитываются сами собой.
// Node в этом окне нет — только два канала через preload-picker.js
const bridge = window.picker;

const shot = document.getElementById('shot');
const sel = document.getElementById('sel');
const sizeTag = document.getElementById('size');
const veil = document.getElementById('veil');

let natural = { width: 0, height: 0 };
let start = null;

bridge.onShot(({ dataUrl, width, height }) => {
  natural = { width, height };
  shot.src = dataUrl;
});

function toScreen(x, y) {
  return {
    x: Math.round(x * natural.width / window.innerWidth),
    y: Math.round(y * natural.height / window.innerHeight),
  };
}

function draw(a, b) {
  const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
  sel.style.display = 'block';
  veil.style.display = 'none';           // дыру в затемнении рисует сам #sel
  sel.style.left = left + 'px'; sel.style.top = top + 'px';
  sel.style.width = w + 'px'; sel.style.height = h + 'px';
  const s = toScreen(w, h);
  sizeTag.style.display = 'block';
  sizeTag.textContent = `${s.x} × ${s.y} px`;
  sizeTag.style.left = left + 'px';
  sizeTag.style.top = (top > 26 ? top - 26 : top + h + 6) + 'px';
}

window.addEventListener('mousedown', ev => { start = { x: ev.clientX, y: ev.clientY }; draw(start, start); });
window.addEventListener('mousemove', ev => { if (start) draw(start, { x: ev.clientX, y: ev.clientY }); });
window.addEventListener('mouseup', ev => {
  if (!start) return;
  const a = toScreen(Math.min(start.x, ev.clientX), Math.min(start.y, ev.clientY));
  const b = toScreen(Math.max(start.x, ev.clientX), Math.max(start.y, ev.clientY));
  start = null;
  const region = { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  // слишком мелкое выделение — почти наверняка случайный клик, не закрываемся
  if (region.width < 40 || region.height < 10) {
    sel.style.display = 'none'; sizeTag.style.display = 'none'; veil.style.display = 'block';
    return;
  }
  bridge.done(region);
});

window.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') bridge.done(null);
  if (ev.key === ' ') bridge.done('default');
});
