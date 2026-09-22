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
  host.innerHTML = `
    <header class="metrics-head"><div><span class="metrics-eyebrow">Твоя сессия</span><h1>Статистика</h1></div><div class="metrics-overlay-actions" role="group" aria-label="Отдельные оверлеи"><span>Поверх игры</span>${action('overlay-fame', 'Фейм', 'overlay', 'ghost')}${action('overlay-damage', 'Урон', 'overlay', 'ghost')}<button type="button" class="btn ghost square" data-action="lock-damage" aria-label="Закрепить оверлей урона" title="Закрепить оверлей урона">${icon('lock')}</button></div></header>
    <div class="metrics-panel">
      <section class="metrics-collection" aria-label="Сбор статистики">
        <div class="metrics-toggles">${toggle('fame', 'Фейм')}${toggle('damage', 'Урон')}</div>
        <p id="metrics-capture-note">Фейм и урон требуют чтения трафика игры. Счётчики можно включать отдельно.</p>
        <div class="metrics-traffic-row"><span class="metrics-traffic" role="status"></span><button type="button" class="btn ghost" data-action="stop-traffic" title="Выключить оба счётчика. Если зона определяется из трафика, переключить её на чтение с экрана.">Отключить чтение трафика</button></div>
      </section>
      <p class="metrics-status" role="status">Ожидаю данные…</p>
      <div class="metrics-overview">
        <section class="metrics-fame" aria-label="Личный фейм"><h2>Личный фейм</h2><div class="metrics-values">
          <div><span>Фейм / час</span><strong data-value="rate">—</strong></div>
          <div><span>За сессию</span><strong data-value="fame">0</strong></div>
        </div></section>
        <section class="metrics-dps" aria-label="Урон в секунду"><h2>Урон в секунду</h2><div class="metrics-values">
          <div><span>DPS группы</span><strong data-value="party">0</strong></div>
          <div><span>Мой DPS</span><strong data-value="self">0</strong></div>
        </div></section>
      </div>
      <div class="metrics-table-head"><h2>Участники группы</h2><select class="metrics-segment" aria-label="Период урона"><option value="current">Последний бой</option><option value="overall">Общий урон за сессию</option></select><span class="metrics-fight"></span></div>
      <div class="metrics-table-wrap"><table class="metrics-table"><thead><tr><th scope="col">Игрок</th><th scope="col">DPS</th><th scope="col">Урон</th></tr></thead><tbody></tbody></table></div>
      <p class="metrics-party-note"></p>
    </div>
    <footer class="metrics-controls">
      <span class="metrics-time" title="Время учёта фейма без пауз и отключений"></span>
      <div class="metrics-actions" role="group" aria-label="Управление сессией">${action('pause', 'Пауза', 'pause')}${action('reset', 'Сбросить', 'reset', 'ghost')}</div>
      <details class="metrics-help"><summary aria-label="Настройки и расчёт статистики" title="Настройки и расчёт статистики"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div class="metrics-options">
        <h3>Как считаем</h3><p>За сессию — личный фейм из полученных наград с премиумом и сумкой прозрения. Сбор и крафт тоже входят в сумму. Повторные награды не прибавляются.</p><p>Фейм в час — среднее с первой награды, без пауз и времени отключения фейма.</p><p>DPS — урон между первым и последним ударом группы, минимум за 1 секунду. После 10 секунд без урона начинается новый бой. Общий урон складывается за сессию, его DPS делится на суммарное время боёв без перерывов. Данные далёких участников могут быть неполными.</p><p>Выключение сохраняет накопленные значения и скрывает соответствующий оверлей. Пауза останавливает счётчики, но сохраняет чтение трафика. Полностью остановить его можно кнопкой выше.</p><p>Рядом с ником — последнее известное оружие. При наведении — название и тир.</p><p>Сброс обнуляет фейм, последний бой и общий урон. Перезапуск приложения или смена персонажа начинает новую сессию.</p>
      </div></details>
    </footer>`;
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
    nodes.label.textContent = row.name + (row.self ? ' · ты' : '');
    nodes.dps.textContent = format(row.dps); nodes.damage.textContent = format(row.damage);
    updateWeapon(nodes.weapon, row);
    return nodes.tr;
  }
  function render(s) {
    state = s;
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
    pause.querySelector('[data-button-label]').textContent = s.paused ? 'Продолжить' : 'Пауза';
    pause.querySelector('svg').innerHTML = paths[s.paused ? 'resume' : 'pause'];
    pause.classList.toggle('key', !!s.paused);
    host.querySelectorAll('button[data-action]').forEach(b => { b.disabled = pending; });
    pause.disabled = pending || !s.enabled;
    const reasons = [s.fameEnabled && 'фейм', s.damageEnabled && 'урон', s.zoneSource === 'traffic' && 'определение зоны'].filter(Boolean);
    $('.metrics-traffic').textContent = s.listening ? 'Трафик читается: ' + reasons.join(', ') + '.'
      : s.trafficRequired ? 'Чтение трафика включено: ' + reasons.join(', ') + '.' : 'Чтение трафика отключено.';
    $('[data-action="stop-traffic"]').hidden = !s.trafficRequired;
    for (const input of host.querySelectorAll('[data-metric]')) {
      input.checked = !!s[input.dataset.metric + 'Enabled']; input.disabled = pending;
    }
    $('.metrics-fame').dataset.disabled = String(!s.fameEnabled);
    $('.metrics-dps').dataset.disabled = String(!s.damageEnabled);
    for (const kind of ['fame', 'damage']) {
      const button = $('[data-action="overlay-' + kind + '"]'), open = !!s.overlays?.[kind];
      button.setAttribute('aria-pressed', String(open));
      button.title = (open ? 'Скрыть' : 'Показать') + (kind === 'fame' ? ' оверлей фейма' : ' оверлей урона');
      button.classList.toggle('key', open); button.classList.toggle('ghost', !open);
      button.disabled = pending || !s[kind + 'Enabled'];
    }
    const lock = $('[data-action="lock-damage"]');
    lock.disabled = pending || !s.damageEnabled;
    lock.setAttribute('aria-pressed', String(!!s.damageLocked));
    lock.title = s.damageLocked ? 'Открепить оверлей урона' : 'Закрепить оверлей урона';
    lock.setAttribute('aria-label', lock.title); lock.classList.toggle('key', !!s.damageLocked);
    $('.metrics-segment').value = overall ? 'overall' : 'current';
    $('.metrics-segment').disabled = pending;
    $('.metrics-fight').textContent = data.totalDamage ? time(data.durationMs).replace(/^00:/, '') : '';
    const body = $('.metrics-table tbody'), names = new Set();
    for (const row of data.rows || []) {
      names.add(row.name); body.append(playerRow(row));
    }
    for (const [name, nodes] of rowNodes) if (!names.has(name)) { nodes.tr.remove(); rowNodes.delete(name); }
    $('.metrics-party-note').textContent = !s.damageEnabled ? 'Учёт урона выключен. Накопленные значения сохранены.' : overall ? 'Урон, нанесённый тобой и участниками твоей группы за сессию' : s.partyKnown ? 'Только твоя группа, включая тебя' : 'Нет состава пати. Если ты в группе, перезайди в неё.';
  }
  async function performAction(action) {
    if (!state || pending || !window.api?.metricsAction) return;
    actionError = null; pending = true; render(state);
    try {
      const result = await window.api.metricsAction(action);
      if (result?.ok === false) throw new Error('Action rejected');
      if (result?.state) state = result.state;
    }
    catch { actionError = 'Не удалось обновить счётчики. Повтори действие.'; }
    finally { pending = false; render(state); }
  }
  $('.metrics-segment').addEventListener('change', event => performAction('segment-' + event.target.value));
  host.addEventListener('change', event => {
    const kind = event.target.dataset.metric;
    if (kind === 'fame' || kind === 'damage') performAction((event.target.checked ? 'enable-' : 'disable-') + kind);
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
    $('.metrics-status').textContent = window.api ? 'Счётчики недоступны' : 'Счётчики доступны в приложении';
    host.querySelectorAll('button, input, select').forEach(b => { b.disabled = true; });
  });
})();
