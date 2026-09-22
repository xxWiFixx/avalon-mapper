(() => {
  'use strict';
  const { format, compact, time, status, createWeapon, updateWeapon, subscribe, damageData } = window.MetricsUI;
  const host = document.getElementById('metrics');
  const fame = new URLSearchParams(location.search).get('kind') === 'fame';
  document.body.classList.add(fame ? 'fame-window' : 'damage-window');
  document.title = (fame ? 'Фейм' : 'Урон') + ' — Avalon Mapper';
  host.setAttribute('aria-label', fame ? 'Личный фейм за сессию' : 'Урон участников группы');
  host.innerHTML = fame ? `
    <div class="fame-chip"><img class="fame-icon" src="../assets/fame.png" alt="" width="32" height="32"><strong data-fame>0</strong></div>` : `
    <header class="damage-head"><h1>Урон</h1><span class="damage-fight"></span><details class="damage-segments"><summary class="damage-tool" title="Выбрать период урона" aria-label="Выбрать период урона"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v13H3Z"/><path d="M3 10h18"/></svg></summary><div class="damage-segment-menu" role="menu" aria-label="Период урона"><button type="button" role="menuitemradio" data-action="segment-overall">Общий урон<small>Overall Data · за сессию</small></button><button type="button" role="menuitemradio" data-action="segment-current">Последний бой<small>Current Segment</small></button></div></details><button type="button" class="damage-tool damage-lock" data-action="lock-damage" aria-label="Закрепить оверлей" title="Закрепить оверлей"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path class="lock-shackle" d="M8 10V6a4 4 0 0 1 8 0v1"/></svg></button><button type="button" class="damage-tool damage-close" data-action="close-overlay" title="Скрыть оверлей урона" aria-label="Скрыть оверлей урона"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <div class="damage-body"><ol class="damage-rows" aria-label="Урон по убыванию"></ol><p class="damage-empty">Ожидание участников группы</p></div>
    <footer class="damage-footer"><span class="damage-total"></span><span class="damage-status" role="status"></span></footer>
    ${['nw','ne','sw','se'].map(corner => `<span class="damage-resize damage-resize-${corner}" data-corner="${corner}" aria-hidden="true"></span>`).join('')}`;
  const $ = selector => host.querySelector(selector);
  const nodes = new Map();
  let state = null, pending = false, actionError = null, interactiveLock = null, lastLocked = null;
  const colors = ['#456e89', '#6b577e', '#3e786f', '#825551', '#526f47', '#775f43'];
  function colorFor(name) {
    let hash = 0;
    for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return colors[hash % colors.length];
  }
  function playerRow(row, index, max, total) {
    let n = nodes.get(row.name);
    if (!n) {
      const el = document.createElement('li'); el.className = 'damage-row';
      const weapon = createWeapon();
      const track = document.createElement('div'); track.className = 'damage-track';
      const bar = document.createElement('span'); bar.className = 'damage-bar'; bar.setAttribute('aria-hidden', 'true');
      const rank = document.createElement('span'); rank.className = 'damage-rank';
      const name = document.createElement('span'); name.className = 'damage-name';
      const values = document.createElement('span'); values.className = 'damage-values';
      const amount = document.createElement('b'), detail = document.createElement('span');
      values.append(amount, detail); track.append(bar, rank, name, values); el.append(weapon.icon, track);
      n = { el, weapon, bar, rank, name, amount, detail }; nodes.set(row.name, n);
    }
    const share = total > 0 ? row.damage / total * 100 : 0;
    const percent = share.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
    n.el.classList.toggle('damage-self', !!row.self);
    n.bar.style.width = (max > 0 ? Math.min(100, Math.max(0, row.damage / max * 100)) : 0) + '%';
    n.bar.style.backgroundColor = row.self ? '#8b6939' : colorFor(row.name);
    n.rank.textContent = index + 1 + '.';
    n.name.textContent = row.name;
    n.amount.textContent = compact(row.damage);
    n.detail.textContent = ` (${compact(row.dps)}, ${percent}%)`;
    n.el.title = `${row.name}${row.self ? ' · ты' : ''} — ${format(row.damage)} урона · ${format(row.dps)} DPS · ${percent}% группы`;
    n.el.setAttribute('aria-label', n.el.title);
    updateWeapon(n.weapon, row);
    return n.el;
  }
  function render(s) {
    state = s;
    const currentStatus = status(s);
    host.dataset.state = currentStatus.kind;
    if (fame) {
      $('[data-fame]').textContent = format(s.fame);
      host.title = `Фейм за сессию: ${format(s.fame)}. ${currentStatus.text}. Перетащи, чтобы переместить. Скрыть можно во вкладке «Статистика».`;
      return;
    }
    const data = damageData(s), overall = s.damageSegment === 'overall', locked = !!s.damageLocked;
    if (lastLocked !== locked) { lastLocked = locked; interactiveLock = null; }
    host.dataset.locked = String(locked);
    const lock = $('.damage-lock');
    lock.setAttribute('aria-pressed', String(locked));
    lock.title = locked ? 'Открепить оверлей' : 'Закрепить: запретить перемещение и размер, пропускать клики в игру';
    lock.setAttribute('aria-label', locked ? 'Открепить оверлей' : 'Закрепить оверлей');
    $('.lock-shackle').setAttribute('d', locked ? 'M8 10V6a4 4 0 0 1 8 0v4' : 'M8 10V6a4 4 0 0 1 8 0v1');
    const menu = $('.damage-segments');
    if (locked) menu.open = false;
    menu.querySelector('summary').setAttribute('aria-disabled', String(locked));
    menu.querySelector('summary').tabIndex = locked ? -1 : 0;
    for (const button of host.querySelectorAll('button[data-action]')) {
      button.disabled = pending || (locked && button !== lock);
      if (button.dataset.action.startsWith('segment-')) button.setAttribute('aria-checked', String(button.dataset.action === 'segment-' + (overall ? 'overall' : 'current')));
    }
    const rows = [...(data.rows || [])].sort((a, b) => b.damage - a.damage || Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
    const max = Math.max(0, ...rows.map(row => row.damage));
    const total = rows.reduce((sum, row) => sum + row.damage, 0);
    const list = $('.damage-rows'), names = new Set();
    rows.forEach((row, index) => { names.add(row.name); list.append(playerRow(row, index, max, total)); });
    for (const [name, n] of nodes) if (!names.has(name)) { n.el.remove(); nodes.delete(name); }
    $('.damage-empty').hidden = rows.length > 0;
    $('.damage-fight').textContent = (overall ? 'Общий' : 'Последний бой') + (total ? ' · ' + time(data.durationMs).replace(/^00:/, '') : '');
    $('.damage-total').textContent = `${compact(total)} · ${compact(data.partyDps)} DPS`;
    $('.damage-total').title = `${overall ? 'За сессию' : 'Последний бой'}: ${format(total)} урона · ${format(data.partyDps)} DPS`;
    $('.damage-status').textContent = actionError || currentStatus.short || (!s.partyKnown ? 'Нет состава пати' : 'Группа');
    $('.damage-status').title = currentStatus.text + (s.partyKnown ? '. Только твоя группа, включая тебя.' : '. Если ты в группе, перезайди в неё для загрузки состава.');
  }
  if (!fame) {
    host.addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled || pending || !state || !window.api?.metricsAction) return;
      const action = button.dataset.action;
      $('.damage-segments').open = false;
      pending = true; actionError = null; render(state);
      try {
        const result = await window.api.metricsAction(action);
        if (result?.ok === false) throw new Error('Action rejected');
      } catch { actionError = 'Не удалось обновить'; }
      finally { pending = false; render(state); interactiveLock = null; }
    });
    // Windows forwards mouse movement while the locked window passes clicks through.
    // Only the lock remains interactive, so it is always possible to unlock in-game.
    document.addEventListener('mousemove', event => {
      const interactive = !!event.target.closest('.damage-lock');
      if (interactiveLock !== interactive) { interactiveLock = interactive; window.api?.metricsPointer?.(interactive); }
    });
    document.addEventListener('mouseleave', () => { interactiveLock = false; window.api?.metricsPointer?.(false); });
    window.addEventListener('blur', () => { interactiveLock = null; });
    const menu = $('.damage-segments');
    document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.open = false; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
    });
    for (const handle of host.querySelectorAll('[data-corner]')) {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !state || state.damageLocked || !window.api?.resizeMetrics) return;
        event.preventDefault(); handle.setPointerCapture(event.pointerId);
        window.api.resizeMetrics(handle.dataset.corner).catch(() => { actionError = 'Не удалось изменить размер'; render(state); });
      });
      const end = event => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        handle.releasePointerCapture(event.pointerId);
      };
      handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', () => { window.api?.resizeMetrics?.('end').catch(() => {}); });
    }
  }
  subscribe(render, () => {
    render({ enabled: false, fame: 0, partyDps: 0, rows: [] });
    if (fame) host.title = 'Счётчик фейма недоступен';
    else $('.damage-status').textContent = 'Счётчики недоступны';
  });
})();
