// Окно поиска зоны. Всплывает по хоткею вместо снимка области у курсора: игрок сам
// печатает, куда ведёт портал. Сокращения те же, что в поле «Куда» на карте, —
// разбор общий (ui/zone-search.js), чтобы одно и то же нельзя было понять по-разному.
// Вне Electron (стенд оформления) моста нет — берём тот же список зон из файлов,
// чтобы окно можно было посмотреть и поправить в браузере, как и остальные экраны.
const bridge = window.search || {
  onInit: cb => Promise.all([
    fetch('../data-static/zone-data.json').then(r => r.json()).then(l => l.map(z => ({ name: z.name, color: 'avalon' }))),
    fetch('../data-static/royal-zones.json').then(r => r.json()).then(l => l.map(z => ({ name: z.name, color: z.color }))),
  ]).then(([a, b]) => {
    // на стенде состояние задаётся адресом: ?q=couexa&here=…&watch=0
    const q = new URLSearchParams(location.search);
    cb({
      zones: a.concat(b),
      here: q.has('here') ? q.get('here') : 'Coues-Exakrom',
      zoneWatch: q.get('watch') !== '0',
      mode: q.get('mode'),
      binding: q.get('binding') || (q.get('mode') === 'lookup' ? 'F10' : 'F9'),
    });
    if (q.get('q')) { el('q').value = q.get('q'); update(); }
    if (q.get('size')) setSize(Number(q.get('size')));
  }),
  pick: (name, mode, closes, capMax) => console.log('выбрано:', { name, mode, closes, capMax }),
  close: () => console.log('закрыто'),
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = id => document.getElementById(id);

let zones = [];      // [{ name, color }] — Авалон + королевство
let items = [];      // текущие подсказки
let idx = -1;        // выделенная строка
let line = { query: '', sec: null, error: null };  // разбор строки: имя + время (ui/search-line.js)
let size = null;     // размер портала кнопками: 7, 20 или ничего
let lookup = false;

bridge.onInit(({ zones: list, here, zoneWatch, mode, binding }) => {
  lookup = mode === 'lookup';
  zones = Array.isArray(list) ? list : [];
  if (lookup) zones = zones.filter(z => z.color === 'avalon');
  document.title = lookup ? 'Поиск Авалона' : 'Куда ведёт портал';
  document.querySelector('.ttl').textContent = document.title;
  document.querySelector('.sizes').hidden = lookup;
  el('echo').hidden = lookup;
  el('q').placeholder = lookup ? 'Название или первые буквы: Peb Avo' : 'couexa 5 36 — зона и время до закрытия';
  document.querySelector('footer').innerHTML = lookup
    ? '<span><i class="k">↑ ↓</i>выбрать</span><span><i class="k">Enter</i>показать локацию</span><span><i class="k">' + esc(binding || 'F10') + '</i>повторно — закрыть</span>'
    : '<span><i class="k">Enter</i>зона за порталом</span><span><i class="k">Ctrl+Enter</i>я сейчас здесь</span><span><i class="k">Esc</i>закрыть</span>';
  const from = el('from');
  if (lookup) {
    from.textContent = 'Карта и активности любого Авалона';
    from.classList.remove('unknown');
  } else if (here) {
    from.innerHTML = 'откуда: <b>' + esc(here) + '</b>';
    from.classList.remove('unknown');
  } else {
    // без точки старта ребро карты не появится — говорим об этом сразу, а не после выбора
    from.textContent = zoneWatch
      ? 'зона ещё не распознана — портал запишется без начала'
      : 'слежение за зоной выключено — укажи её через Ctrl+Enter';
    from.classList.add('unknown');
  }
  el('q').focus();
  update();
});

function render() {
  const box = el('list');
  if (!items.length) {
    box.innerHTML = line.query.trim()
      ? '<div class="empty">такой зоны нет в списке</div>'
      : '<div class="empty">начни печатать название зоны</div>';
    return;
  }
  box.innerHTML = items.map((z, i) =>
    '<div class="item' + (i === idx ? ' on' : '') + '" data-i="' + i + '">' +
      '<i class="dot ' + esc(z.color || 'avalon') + '"></i>' +
      '<span>' + window.ZONE_SEARCH.mark(z.name, z.marks, esc) + '</span>' +
    '</div>').join('');
}

// Эхо разбора: что именно мы поняли, пока игрок ещё печатает. Любое правило можно
// набрать неверно — видно это должно быть ДО Enter, а не через час на карте.
// Абсолютное время показываем рядом нарочно: «через 5 ч 36 мин» протухает, «в 06:12» — нет.
function echo() {
  const box = el('echo');
  box.classList.toggle('bad', !!line.error);
  if (line.error) { box.textContent = line.error; return; }
  if (line.sec != null) {
    box.innerHTML = 'закроется через <b>' + esc(SEARCH_LINE.fmtDur(line.sec)) + '</b>' +
      ' <span class="at">— примерно в ' + esc(SEARCH_LINE.fmtAt(line.sec)) + '</span>';
    return;
  }
  box.innerHTML = '<span class="fmt">время до закрытия — необязательно: 45 · 5 36 · 5.36</span>';
}

function update() {
  line = lookup ? { query: el('q').value, sec: null, error: null } : SEARCH_LINE.parse(el('q').value);
  items = window.ZONE_SEARCH.search(zones, line.query, 40);
  idx = items.length ? 0 : -1;
  echo();
  render();
}

function move(d) {
  if (!items.length) return;
  idx = (idx + d + items.length) % items.length;
  render();
  const on = el('list').children[idx];
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

// mode: 'portal' — зона за порталом, 'here' — «я сейчас здесь»
function pick(mode) {
  const z = items[idx];
  if (!z) return;
  if (lookup) return bridge.pick(z.name, 'lookup', null, null);
  // время не понято — не отправляем ничего: иначе портал молча уехал бы в карту
  // с неверным таймером, а игрок бы этого не заметил
  if (line.error) { el('echo').classList.add('bad'); return; }
  bridge.pick(z.name, mode, mode === 'here' ? null : line.sec, mode === 'here' ? null : size);
}

function setSize(v) {
  size = size === v ? null : v;   // повторный клик снимает выбор
  document.querySelectorAll('.sizes button').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === size));
}
document.querySelector('.sizes').addEventListener('mousedown', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  ev.preventDefault();          // поле ввода не должно терять фокус
  setSize(Number(b.dataset.size));
});

el('q').addEventListener('input', update);
el('list').addEventListener('mousedown', ev => {
  const item = ev.target.closest('.item');
  if (!item) return;
  ev.preventDefault();
  idx = Number(item.dataset.i);
  pick(ev.ctrlKey ? 'here' : 'portal');
});
window.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') return bridge.close();
  if (ev.key === 'ArrowDown') { ev.preventDefault(); return move(1); }
  if (ev.key === 'ArrowUp') { ev.preventDefault(); return move(-1); }
  if (ev.key === 'Enter') { ev.preventDefault(); return pick(ev.ctrlKey ? 'here' : 'portal'); }
});
update();
