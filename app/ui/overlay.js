// Оверлей: что внутри зоны за порталом. Порядок как в игре — карта, свиток с именем,
// под ним содержимое. Данные приходят из lib/recognize.js (zoneInfo → zone-data.json).
const ipc = window.api || null;

const ZONE_TYPE_RU = {
  avalon: 'Путь Авалона', blue: 'Синяя зона', yellow: 'Жёлтая зона', red: 'Красная зона',
  black: 'Чёрная зона', city: 'Город', 'city-black': 'Город ЧЗ',
};
const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII' };
// Порядок и подписи активностей — общие с карточкой окна карты, см. ui/activities.js
const ACTS = window.ZONE_ACTS;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = id => document.getElementById(id);

function fmtLeft(sec) {
  if (sec == null) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}ч ${String(m).padStart(2, '0')}м`;
  if (m > 0) return `${m}м`;
  return `${sec}с`;
}

// Значок слева от имени — как череп у чёрной зоны в плашке игры.
function markSvg(color) {
  if (color === 'avalon' || color === 'black' || color === 'city-black') {
    return '<svg viewBox="0 0 16 16"><path fill="#3b2a19" d="M8 1C5 1 3 3.2 3 6c0 1.7.8 2.7 1.5 3.3V11c0 .6.4 1 1 1h1v2h1.5v-2h1V14H10v-2h1c.6 0 1-.4 1-1V9.3C12.7 8.7 13.5 7.7 13.5 6 13.5 3.2 11 1 8 1zm-2.2 5.3a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zm4.4 0a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z"/></svg>';
  }
  const fill = { blue: '#2f6fd0', yellow: '#c99a12', red: '#c03a2e', city: '#2b8f4e' }[color] || '#6a4a26';
  return `<svg viewBox="0 0 16 16"><path fill="${fill}" d="M8 2l6 6-6 6-6-6z"/></svg>`;
}

// Подсветка чипа: золото — золотым, портал в Туманы — сиреневым, подземелья — синим ободком
function chipClass(icon) {
  if (icon === 'brecilien') return ' brec';
  if (icon.startsWith('gold') || icon === 'dg_gold') return ' gold';
  if (icon.startsWith('dg_')) return ' dg';
  return '';
}

// У ресурсов на чипе ТОЛЬКО значки: основной и парный на его углу. Ни числа, ни тира —
// решение игрока: с ними чип разбухал, и «что тут фармить» переставало читаться.
// Всё снятое живёт в подсказке (actTitle). Счётчик остался сундукам и подземельям.
function chip(item, a) {
  const ico = k => '<img src="../assets/avalon-icons/' + k + '.webp" alt="">';
  return '<span class="act' + chipClass(item.icon) + (item.big ? ' big' : '') + (item.sub ? ' pair' : '') +
    '" title="' + esc(ACTS.actTitle(item, a)) + '">' +
    '<span class="ic">' + ico(item.icon) +
    (item.sub ? '<span class="sub">' + ico(item.sub) + '</span>' : '') + '</span>' +
    (!item.res && item.count > 1 ? '<b>' + item.count + '</b>' : '') + '</span>';
}

// ---------- режим настройки места ----------
// Обычно плашка некликабельна и живёт 7 секунд. Здесь наоборот: ловит мышь и висит,
// пока игрок не скажет «готово». Само окно двигает main-процесс по позиции курсора —
// координаты мыши в странице зависят от zoom-фактора, а курсор на экране нет.
let setupOn = false;

// Подсказку собираем здесь, а не в разметке: страниц с оверлеем две (боевая и стенд
// предпросмотра), и любой дубль вёрстки между ними рано или поздно расходится.
function setupPanel() {
  let box = el('ovSetup');
  if (box) return box;
  box = document.createElement('div');
  box.className = 'ov-setup';
  box.id = 'ovSetup';
  box.innerHTML =
    '<div class="su-line"><b>Тяни плашку мышью</b><span id="suScale">100%</span></div>' +
    '<div class="su-hint">колесо — размер · <i>Enter</i> — готово · <i>Esc</i> — отмена</div>' +
    '<div class="su-btns">' +
      '<button data-act="done" class="su-key">Готово</button>' +
      '<button data-act="reset">Стандартное место</button>' +
      '<button data-act="cancel">Отмена</button>' +
    '</div>';
  const host = el('box');
  host.insertBefore(box, host.firstChild);
  if (ipc && typeof ipc.setup === 'function') {
    box.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (b) ipc.setup(b.dataset.act);
    });
  }
  return box;
}

function setSetup(payload) {
  setupOn = !!payload.setup;
  document.body.classList.toggle('setup', setupOn);
  const box = el('ovSetup');
  if (!setupOn) { if (box) box.hidden = true; return; }
  const panel = setupPanel();
  panel.hidden = false;
  el('suScale').textContent = Math.round((payload.scale || 1) * 100) + '%';
  panel.querySelector('[data-act="reset"]').disabled = !payload.custom;
}

if (ipc && typeof ipc.drag === 'function') {
  const box = el('box');
  box.addEventListener('pointerdown', ev => {
    if (!setupOn || ev.button !== 0 || ev.target.closest('.su-btns')) return;
    ev.preventDefault();
    box.setPointerCapture(ev.pointerId);   // отпустят мышь за пределами окна — событие всё равно наше
    ipc.drag('start');
  });
  const stop = () => { if (setupOn) ipc.drag('end'); };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  window.addEventListener('wheel', ev => {
    if (!setupOn) return;
    ev.preventDefault();
    ipc.scale(ev.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  window.addEventListener('keydown', ev => {
    if (!setupOn) return;
    if (ev.key === 'Enter') ipc.setup('done');
    else if (ev.key === 'Escape') ipc.setup('cancel');
  });
}

// Исчезновение — плавное: класс запускает анимацию, окно main спрячет, когда она доиграет.
// instant — выход из режима настройки: там гасить нечего.
let hideTimer = null;
function hide(instant) {
  const box = el('box');
  clearTimeout(hideTimer);
  if (instant) { box.classList.remove('out'); box.hidden = true; return; }
  if (box.hidden) return;
  box.classList.add('out');
  hideTimer = setTimeout(() => { box.hidden = true; box.classList.remove('out'); }, 300);
}

function show(payload) {
  const box = el('box');
  clearTimeout(hideTimer);
  box.classList.remove('out');   // пришёл новый портал, пока старый гас

  // Хоткей нажат, распознавание идёт. Показываем это сразу: между нажатием и ответом
  // около секунды, и без отклика игрок не знает, сработало ли, — жмёт ещё раз.
  box.classList.toggle('busy', !!payload.busy);
  if (payload.busy) {
    document.querySelector('.ov-map').classList.add('empty');
    el('ovTier').textContent = ''; el('ovMark').innerHTML = ''; el('ovTime').textContent = '';
    el('ovName').textContent = 'Распознаю…';
    el('ovPanel').innerHTML = '<div class="ov-busy"><i></i><i></i><i></i></div>';
    box.hidden = false;
    return;
  }
  setSetup(payload);
  if (payload.error) {
    el('ovMap').removeAttribute('src');
    document.querySelector('.ov-map').classList.add('missing');
    el('ovName').textContent = 'Не распознано';
    el('ovTier').textContent = ''; el('ovMark').innerHTML = ''; el('ovTime').textContent = '';
    el('ovPanel').innerHTML = '<div class="ov-error">' + esc(payload.error) + '</div>';
    box.hidden = false;
    return;
  }

  const t = payload.tip;
  const color = t.color || 'avalon';
  const a = t.activities || null;

  // карта зоны: обрезанный ромб; у зон королевства карт нет вовсе,
  // а ещё её можно выключить настройкой — тогда остаются имя и активности
  const map = document.querySelector('.ov-map');
  const img = el('ovMap');
  map.classList.remove('missing', 'empty');
  if (color === 'avalon' && payload.showMap !== false) {
    img.onerror = () => map.classList.add('missing');
    img.src = '../assets/avalon-maps-crop/' + encodeURIComponent(t.name) + '.webp';
  } else {
    map.classList.add('empty');
    img.removeAttribute('src');
  }

  // Тир римской цифрой, как в игре, и качество в скобках следом: «VIII (5)».
  // Качество есть только у чёрных зон — у остальных скобок нет вовсе, а не «(—)».
  el('ovTier').textContent = t.tier
    ? (ROMAN[t.tier] || t.tier) + (t.quality ? ' (' + t.quality + ')' : '')
    : '';
  el('ovMark').innerHTML = markSvg(color);
  el('ovName').textContent = t.name;
  const time = el('ovTime');
  time.textContent = t.closes != null ? fmtLeft(t.closes) : '';
  time.classList.toggle('soon', t.closes != null && t.closes < 900);   // меньше 15 минут

  const html = [];

  // Про портал показываем ровно одну вещь — его размер (7 или 20). Ни свободных мест,
  // ни времени до открытия: и то и другое живёт минуты, и к моменту, когда игрок туда
  // добежит, уже неверно. Полоса в цвет портала и число: синяя — на 7, золотая — на 20
  // (ui/overlay.css). Строку показываем всегда: «не прочитан» — сигнал нажать ещё раз.
  const sizeKnown = t.capMaxKnown !== false && t.capMax != null;
  const size = sizeKnown ? Number(t.capMax) : null;
  // зону выбрали руками в окне поиска — размер портала никто не читал, так и пишем
  const noSize = payload.manual ? 'зона выбрана вручную' : 'размер портала не прочитан';
  html.push('<div class="ov-cap ' + (sizeKnown ? 'size-' + size : 'size-unknown') + '">' +
    '<span class="cap-line"></span>' +
    '<b class="cap-num">' + (sizeKnown ? size : '') + '</b>' +
    '<span class="cap-word">' + noSize + '</span>' +
    '</div>');

  // СЛОЙ ДОРОГИ. Он говорит, куда зона выходит и насколько глубоко сидит, а по нему же
  // предсказуем тир ресурсов. В окне карты это чип в карточке, но в бою игрок смотрит
  // сюда, а не в окно, — значит и здесь слой нужен. Строкой, а не значком: ярлык
  // «L1 Outer» сам по себе не говорит ничего, расшифровка нужна рядом.
  if (a && a.type) {
    const ru = ACTS.roadTypeRu(a.type);
    const tail = ru.includes(' — ') ? ru.slice(ru.indexOf(' — ') + 3) : ru;
    html.push('<div class="ov-road"><b>' + esc(a.type) + '</b> · ' + esc(tail) + '</div>');
  }

  if (a && a.chests) {
    const items = ACTS.listActivities(a);
    html.push(items.length
      ? '<div class="ov-acts">' + items.map(it => chip(it, a)).join('') + '</div>'
      : '<div class="ov-empty">активностей не отмечено</div>');
  } else if (color !== 'avalon') {
    html.push('<div class="ov-empty">' + esc(ZONE_TYPE_RU[color] || 'Зона мира') + ' — содержимое не отслеживаем</div>');
  }

  if (payload.copied) html.push('<div class="ov-copied">скопировано: <b>' + esc(payload.copied) + '</b></div>');
  // Зона на момент нажатия неизвестна — портал отложен, а не потерян и не записан наугад.
  // Игрок должен это видеть: иначе решит, что портал уже в карте, и не проверит ещё раз.
  // Про плашку зоны здесь НЕ говорим: при источнике «Из трафика» её никто не читает,
  // и обещание «прочитаю плашку» игрок ждал бы напрасно. Текст одинаков для всех
  // источников — важно, что портал не потерян, а не каким путём выясняется зона.
  if (payload.waiting) html.push('<div class="ov-wait">жду, откуда портал — запишу, как только пойму, где ты</div>');
  // Слежение выключено и зона не задана: ждать нечего, портал не запишется сам никогда.
  // Молчать здесь нельзя — игрок решит, что портал уже в карте.
  if (payload.noOrigin) html.push('<div class="ov-wait">портал не записан: сначала укажи свою зону — <b>Ctrl+Enter</b></div>');

  el('ovPanel').innerHTML = html.join('');
  box.hidden = false;
}

if (ipc) {
  ipc.on('overlay-show', payload => { try { show(payload); } catch (e) { console.error(e); } });
  ipc.on('overlay-hide', payload => hide(payload && payload.instant));
}
window.__overlayShow = show;      // для стенда предпросмотра
