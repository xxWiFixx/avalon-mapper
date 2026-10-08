var i18nText = (globalThis.AvalonI18n?.t || ((text, values) => Array.isArray(values) ? text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match) : text));
/* Statistics in the main application. */
(() => {
  'use strict';
  const host = document.getElementById('metrics');
  if (!host) return;
  const { format, time, status, createWeapon, updateWeapon, subscribe, damageData } = window.MetricsUI;
  const paths = {
    pause: '<path d="M8 5v14M16 5v14"/>', resume: '<path d="m8 5 11 7-11 7Z"/>',
    reset: '<path d="M4 4v6h6M5 9a8 8 0 1 1-1 6"/>',
    overlay: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 11h9M12 11v9"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  };
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
  const action = (name, text, symbol, cls = '') => `<button type="button" class="btn ${cls}" data-action="${name}">${icon(symbol)}<span data-button-label>${text}</span></button>`;
  const toggle = (kind, text) => `<label class="metrics-toggle"><input type="checkbox" role="switch" data-metric="${kind}" aria-describedby="metrics-capture-note"><span class="metrics-switch" aria-hidden="true"></span><span>${text}</span></label>`;
  const sizeControl = (kind, label) => i18nText("<div class=\"metrics-size-control\" role=\"group\" aria-label=\"Размер оверлея {0}\"><span>{1}</span><button class=\"btn ghost\" data-action=\"scale-{2}-down\" aria-label=\"Уменьшить {3}\">−</button><output data-scale=\"{4}\">100%</output><button class=\"btn ghost\" data-action=\"scale-{5}-up\" aria-label=\"Увеличить {6}\">+</button><button class=\"btn ghost\" data-action=\"scale-{7}-reset\" title=\"Вернуть размер 100%\">Сброс</button></div>", [label, label, kind, label, kind, kind, label, kind]);
  host.innerHTML = i18nText("\n    <header class=\"metrics-head\"><div><span class=\"metrics-eyebrow\">Твоя сессия</span><h1>Статистика</h1></div><div class=\"metrics-overlay-actions\" role=\"group\" aria-label=\"Отдельные оверлеи\"><span>Поверх игры</span>{0}{1}<button type=\"button\" class=\"btn ghost square\" data-action=\"lock-damage\" aria-label=\"Закрепить оверлей урона\" title=\"Закрепить оверлей урона\">{2}</button></div></header>\n    <div class=\"metrics-panel\">\n      <section class=\"metrics-collection\" aria-label=\"Сбор статистики\">\n        <div class=\"metrics-toggles\">{3}{4}</div>\n        <p id=\"metrics-capture-note\">Фейм и урон требуют чтения трафика игры. Счётчики можно включать отдельно.</p>\n        <div class=\"metrics-traffic-row\"><span class=\"metrics-traffic\" role=\"status\"></span><button type=\"button\" class=\"btn ghost\" data-action=\"stop-traffic\" title=\"Выключить оба счётчика. Если зона определяется из трафика, переключить её на чтение с экрана.\">Отключить чтение трафика</button></div>\n        <div class=\"metrics-overlay-sizes\"><span>Размер оверлеев</span>{5}{6}</div>\n      </section>\n      <p class=\"metrics-status\" role=\"status\">Ожидаю данные…</p>\n      <div class=\"metrics-overview\">\n        <section class=\"metrics-fame\" aria-label=\"Личный фейм\"><h2>Личный фейм</h2><div class=\"metrics-values\">\n          <div><span>Фейм / час</span><strong data-value=\"rate\">—</strong></div>\n          <div><span>За сессию</span><strong data-value=\"fame\">0</strong></div>\n        </div></section>\n        <section class=\"metrics-dps\" aria-label=\"Урон в секунду\"><h2>Урон в секунду</h2><div class=\"metrics-values\">\n          <div><span>DPS группы</span><strong data-value=\"party\">0</strong></div>\n          <div><span>Мой DPS</span><strong data-value=\"self\">0</strong></div>\n        </div></section>\n      </div>\n      <div class=\"metrics-table-head\"><h2>Участники группы</h2><select class=\"metrics-segment\" aria-label=\"Период урона\"><option value=\"current\">Последний бой</option><option value=\"overall\">Общий урон за сессию</option></select><span class=\"metrics-fight\"></span></div>\n      <div class=\"metrics-table-wrap\"><table class=\"metrics-table\"><thead><tr><th scope=\"col\">Игрок</th><th scope=\"col\">DPS</th><th scope=\"col\">Урон</th></tr></thead><tbody></tbody></table></div>\n      <p class=\"metrics-party-note\"></p>\n    </div>\n    <footer class=\"metrics-controls\">\n      <span class=\"metrics-time\" title=\"Время учёта фейма без пауз и отключений\"></span>\n      <div class=\"metrics-actions\" role=\"group\" aria-label=\"Управление сессией\">{7}{8}</div>\n      <details class=\"metrics-help\"><summary aria-label=\"Настройки и расчёт статистики\" title=\"Настройки и расчёт статистики\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"5\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"19\" cy=\"12\" r=\"1\"/></svg></summary><div class=\"metrics-options\">\n        <h3>Как считаем</h3><p>За сессию — личный фейм из полученных наград с премиумом и сумкой прозрения. Сбор и крафт тоже входят в сумму. Повторные награды не прибавляются.</p><p>Фейм в час — среднее с первой награды, без пауз и времени отключения фейма.</p><p>DPS — урон между первым и последним ударом группы, минимум за 1 секунду. После 10 секунд без урона начинается новый бой. Общий урон складывается за сессию, его DPS делится на суммарное время боёв без перерывов. Данные далёких участников могут быть неполными.</p><p>Выключение сохраняет накопленные значения и скрывает соответствующий оверлей. Пауза останавливает счётчики, но сохраняет чтение трафика. Полностью остановить его можно кнопкой выше.</p><p>Рядом с ником — последнее известное оружие. При наведении — название и тир.</p><p>Сброс обнуляет фейм, последний бой и общий урон. Перезапуск приложения или смена персонажа начинает новую сессию.</p>\n      </div></details>\n    </footer>", [action('overlay-fame', i18nText("Фейм"), 'overlay', 'ghost'), action('overlay-damage', i18nText("Урон"), 'overlay', 'ghost'), icon('lock'), toggle('fame', i18nText("Фейм")), toggle('damage', i18nText("Урон")), sizeControl('fame', i18nText("Фейм")), sizeControl('damage', i18nText("Урон")), action('pause', i18nText("Пауза"), 'pause'), action('reset', i18nText("Сбросить"), 'reset', 'ghost')]);
  const foodSection = document.createElement('section');
  foodSection.className = 'metrics-food';
  foodSection.setAttribute('aria-label', i18nText('Напоминание о еде'));
  foodSection.innerHTML = `<div class="metrics-food-copy"><h2>${i18nText('Бафф еды')}</h2><p>${i18nText('Предупреждение поверх игры, когда еда скоро закончится. Бафф определяется по твоим игровым эффектам.')}</p><span class="metrics-food-status" role="status"></span></div>
    <div class="metrics-food-controls"><label class="metrics-toggle"><input type="checkbox" role="switch" data-metric="food"><span class="metrics-switch" aria-hidden="true"></span><span>${i18nText('Следить')}</span></label>
    <label class="metrics-food-time">${i18nText('Предупредить за')} <select data-food-minutes aria-label="${i18nText('За сколько минут предупредить о конце еды')}">${[1,2,3,5,10,15,30].map(n => `<option value="${n}">${n} ${i18nText('мин')}</option>`).join('')}</select></label></div>`;
  host.querySelector('.metrics-collection').append(foodSection);
  host.querySelector('#metrics-capture-note').textContent = i18nText('Фейм, урон и еда требуют чтения трафика игры. Их можно включать отдельно.');
  host.querySelector('[data-action="stop-traffic"]').title = i18nText('Выключить фейм, урон и слежение за едой. Если зона определяется из трафика, переключить её на чтение с экрана.');
  const collectorUI = window.CollectorUI?.create(host);
  const $ = selector => host.querySelector(selector);
  let state = null, pending = false, actionError = null;
  const rowNodes = new Map();
  function playerRow(row) {
    let nodes = rowNodes.get(row.name);
    if (!nodes) {
      const tr = document.createElement('tr'), td = document.createElement('td');
      const player = document.createElement('span'); player.className = 'metrics-player';
      const weapon = createWeapon();
      const label = document.createElement('span'); label.className = 'metrics-player-name';
      player.append(weapon.icon, label); td.append(player);
      const dps = document.createElement('td'), damage = document.createElement('td'); tr.append(td, dps, damage);
      nodes = { tr, weapon, label, dps, damage }; rowNodes.set(row.name, nodes);
    }
    nodes.tr.classList.toggle('metrics-self', !!row.self);
    nodes.label.textContent = row.name + (row.self ? i18nText(" · ты") : '');
    nodes.dps.textContent = format(row.dps); nodes.damage.textContent = format(row.damage);
    updateWeapon(nodes.weapon, row);
    return nodes.tr;
  }
  function render(s) {
    state = s;
    collectorUI?.update(s.collectors);
    const data = damageData(s), overall = s.damageSegment === 'overall';
    $('[data-value="rate"]').textContent = format(s.famePerHour);
    $('[data-value="fame"]').textContent = format(s.fame);
    $('[data-value="self"]').textContent = format(data.selfDps);
    $('[data-value="party"]').textContent = format(data.partyDps);
    $('.metrics-time').textContent = time(s.elapsedMs || 0);
    const currentStatus = status(s);
    $('.metrics-status').textContent = actionError || currentStatus.text;
    $('.metrics-status').dataset.state = actionError ? 'waiting' : currentStatus.kind;
    const pause = $('[data-action="pause"]');
    pause.querySelector('[data-button-label]').textContent = s.paused ? i18nText("Продолжить") : i18nText("Пауза");
    pause.querySelector('svg').innerHTML = paths[s.paused ? 'resume' : 'pause'];
    pause.classList.toggle('key', !!s.paused);
    host.querySelectorAll('button[data-action]').forEach(b => { b.disabled = pending; });
    pause.disabled = pending || !s.enabled;
    const reasons = [s.fameEnabled && i18nText("фейм"), s.damageEnabled && i18nText("урон"), s.foodEnabled && i18nText("еда"), s.collectors?.market && 'AODP', s.collectors?.mail && i18nText('торговые письма'), s.zoneSource === 'traffic' && i18nText("определение зоны")].filter(Boolean);
    $('.metrics-traffic').textContent = s.listening ? i18nText("Трафик читается: ") + reasons.join(', ') + '.'
      : s.trafficRequired ? i18nText("Чтение трафика включено: ") + reasons.join(', ') + '.' : i18nText("Чтение трафика отключено.");
    $('[data-action="stop-traffic"]').hidden = !s.trafficRequired;
    for (const input of host.querySelectorAll('[data-metric]')) {
      input.checked = !!s[input.dataset.metric + 'Enabled']; input.disabled = pending;
    }
    $('[data-food-minutes]').value = String(s.foodWarnMinutes ?? 1);
    $('[data-food-minutes]').disabled = pending || !s.foodEnabled;
    const food = s.foodBuff || {};
    $('.metrics-food-status').textContent = !s.foodEnabled ? i18nText('Слежение выключено')
      : !s.listening ? i18nText('Ожидание чтения трафика')
      : !food.known ? i18nText('Ожидание данных о твоих эффектах после перехода в зону')
      : !food.fed ? i18nText('Бафф еды не обнаружен')
      : food.remainingMs === null ? i18nText('Бафф есть, срок окончания неизвестен')
      : i18nText('Осталось около {0} мин', [Math.max(0, Math.ceil(food.remainingMs / 60000))]);
    $('.metrics-fame').dataset.disabled = String(!s.fameEnabled);
    $('.metrics-dps').dataset.disabled = String(!s.damageEnabled);
    for (const kind of ['fame', 'damage']) {
      const button = $('[data-action="overlay-' + kind + '"]'), open = !!s.overlays?.[kind];
      button.setAttribute('aria-pressed', String(open));
      button.title = (open ? i18nText("Скрыть") : i18nText("Показать")) + (kind === 'fame' ? i18nText(" оверлей фейма") : i18nText(" оверлей урона"));
      button.classList.toggle('key', open); button.classList.toggle('ghost', !open);
      button.disabled = pending || !s[kind + 'Enabled'];
      const scale = s[kind + 'OverlayScale'] || 1;
      $('[data-scale="' + kind + '"]').textContent = Math.round(scale * 100) + '%';
      $('[data-action="scale-' + kind + '-down"]').disabled = pending || scale <= 0.75;
      $('[data-action="scale-' + kind + '-up"]').disabled = pending || scale >= 2.5;
    }
    const lock = $('[data-action="lock-damage"]');
    lock.disabled = pending || !s.damageEnabled;
    lock.setAttribute('aria-pressed', String(!!s.damageLocked));
    lock.title = s.damageLocked ? i18nText("Открепить оверлей урона") : i18nText("Закрепить оверлей урона");
    lock.setAttribute('aria-label', lock.title); lock.classList.toggle('key', !!s.damageLocked);
    $('.metrics-segment').value = overall ? 'overall' : 'current';
    $('.metrics-segment').disabled = pending;
    $('.metrics-fight').textContent = data.totalDamage ? time(data.durationMs).replace(/^00:/, '') : '';
    const body = $('.metrics-table tbody'), names = new Set();
    for (const row of data.rows || []) {
      names.add(row.name); body.append(playerRow(row));
    }
    for (const [name, nodes] of rowNodes) if (!names.has(name)) { nodes.tr.remove(); rowNodes.delete(name); }
    $('.metrics-party-note').textContent = !s.damageEnabled ? i18nText("Учёт урона выключен. Накопленные значения сохранены.") : overall ? i18nText("Урон, нанесённый тобой и участниками твоей группы за сессию") : s.partyKnown ? i18nText("Только твоя группа, включая тебя") : s.partySize > 0 ? i18nText("Состав группы пока неполный. Новые участники появятся после событий игры.") : i18nText("Состав группы ещё не пришёл из игры.");

  }
  async function performAction(action) {
    if (!state || pending || !window.api?.metricsAction) return;
    actionError = null; pending = true; render(state);
    try {
      const result = await window.api.metricsAction(action);
      if (result?.ok === false) throw new Error('Action rejected');
      if (result?.state) state = result.state;
    }
    catch { actionError = i18nText("Не удалось обновить счётчики. Повтори действие."); }
    finally { pending = false; render(state); }
  }
  $('.metrics-segment').addEventListener('change', event => performAction('segment-' + event.target.value));
  host.addEventListener('change', event => {
    if (event.target.matches('[data-food-minutes]')) { performAction('food-minutes-' + event.target.value); return; }
    const kind = event.target.dataset.metric;
    if (kind === 'fame' || kind === 'damage' || kind === 'food') performAction((event.target.checked ? 'enable-' : 'disable-') + kind);
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled || !state || pending || !window.api?.metricsAction) return;
    let action = button.dataset.action;
    if (action === 'pause') action = state.paused ? 'resume' : 'pause';
    await performAction(action);
  });
  const help = $('.metrics-help');
  document.addEventListener('click', e => { if (!help.contains(e.target)) help.open = false; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && help.open) { help.open = false; help.querySelector('summary').focus(); } });
  subscribe(render, () => {
    render({ enabled: false, paused: false, fame: 0, elapsedMs: 0, selfDps: 0, partyDps: 0, rows: [] });
    $('.metrics-status').textContent = window.api ? i18nText("Счётчики недоступны") : i18nText("Счётчики доступны в приложении");
    host.querySelectorAll('button, input, select').forEach(b => { b.disabled = true; });
  });
})();
