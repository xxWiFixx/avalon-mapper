(function () {
  'use strict';
  const api = window.api;
  const t = window.AvalonI18n?.t || (text => text);
  const el = id => document.getElementById(id);
  window.AvalonServerHelp.mount(el('subscription-help'),{t});
  window.AvalonServerHelp.mount(el('help-server-faq'),{t,guide:false});
  let current = null, busy = false, contextMap = null, epoch = 0;
  let target = '';
  const date = value => new Date(value).toLocaleString(window.AvalonI18n?.locale() || 'ru-RU',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const errors = {
    invalid_title: 'Укажи название сервера.',
    license_expired: 'Срок этого кода истёк. Используй новый код.',
    invalid_code: 'Код недействителен или уже использован другим аккаунтом.',
    discord_required: 'Для активации кода войди через Discord.',
    map_owner_required: 'Продлить сервер может только его владелец.',
    group_permanent: 'Этот сервер бесплатный навсегда. Код не потрачен.',
    code_rate_limited: 'Слишком много попыток. Повтори активацию через час.',
    account_changed: 'Аккаунт изменился. Обнови статус подписки.',
    code_setup_pending: 'Активация кодов пока недоступна. Обнови приложение или попробуй позже.',
    code_activation_failed: 'Не удалось активировать код. Проверь соединение и повтори тот же код.'
  };
  function message(text, success = false) {
    const note = el('subscription-code-result');
    note.textContent = text; note.hidden = !text; note.classList.toggle('fld-err', !success);
  }
  function remaining(value) {
    const server = Date.parse(current?.serverTime);
    const serverNow = Number.isFinite(server) ? server + Math.max(0, Date.now() - (current.checkedAt || Date.now())) : Date.now();
    return window.AvalonServerTerm.term(value, serverNow, window.AvalonI18n?.language || 'ru');
  }

  function render(status) {
    const changedAccount = current?.userId && status?.userId !== current.userId;
    status = status ? { ...status, groups: (status.groups || []).filter(group => group.isOwner === true) } : status;
    current = status;
    if (!el('subscription-plan')) return;
    if (changedAccount) { epoch++; contextMap = null; target = ''; el('subscription-code').value = ''; message(''); }
    el('subscription-plan').textContent = t('Запись порталов без лимита');
    el('subscription-usage').textContent = t('Автоматическая и ручная запись доступны бесплатно всем участникам.');
    el('subscription-mode').textContent = !status?.ready
      ? t('Не удалось получить статус. Нажми «Обновить статус».')
      : !status.enabled ? t('Подписки в тестовом режиме. Ограничения пока отключены.')
      : t('Подписка нужна только для своего канала. Участники подключаются бесплатно.');
    el('subscription-error').hidden = !status?.error;
    el('subscription-error').textContent = status?.error ? t('Не удалось обновить статус подписки. Проверь соединение.') : '';
    const context = status?.groups?.find(group => group.mapId === contextMap);
    if (context?.isOwner && !context.permanent) target = context.mapId;
    el('subscription-all').hidden = !contextMap;
    el('subscription-context').hidden = !contextMap;
    el('subscription-context').textContent = context?.title || (contextMap ? t('Сервер группы') : '');
    const form = el('subscription-code-form');
    form.hidden = !status?.groups?.some(group => group.isOwner && !group.permanent) || (!!contextMap && (!context?.isOwner || context.permanent));
    const select = el('subscription-code-target');
    select.replaceChildren();
    const add = (value, label) => { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); };
    for (const group of status?.groups || []) if (group.isOwner && !group.permanent) add(group.mapId, group.title || t('Сервер группы'));
    if (![...select.options].some(option => option.value === target)) target = select.options[0]?.value || '';
    select.value = target;
    const ready = !!target && !!status?.ready && !!status.codeRedemptionReady && !busy;
    select.disabled = !ready;
    el('subscription-code').disabled = !ready;
    el('subscription-code-submit').disabled = !ready;
    el('subscription-code-submit').textContent = t(busy ? 'Активация…' : 'Продлить на 30 дней');
    el('subscription-code-help').textContent = !status?.codeRedemptionReady
      ? t('Активация кодов пока недоступна. Обнови приложение или попробуй позже.')
      : target ? t('Код добавит 30 дней к сроку выбранного сервера. Если срок истёк, отсчёт начнётся сейчас.')
      : t('Код открывает создание одного сервера на 30 дней. Срок начинается при активации кода.');
    const groups = el('subscription-groups'); groups.replaceChildren();
    function row(nameText, detailText, action, group = null) {
      const item = document.createElement('div'); item.className = 'subscription-group';
      const name = document.createElement('strong'); name.textContent = nameText;
      const detail = document.createElement('span'); detail.textContent = detailText;
      item.append(name, detail);
      if (group) { const role = document.createElement('small'); role.textContent = t(group.isOwner ? 'Ты владелец' : 'Ты участник'); item.append(role); }
      if (group?.active && !group.permanent && group.expiresAt) detail.dataset.expires = group.expiresAt;
      if (action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn ghost';
        button.textContent = action.text; button.disabled = busy; button.onclick = action.click; item.append(button); }
      groups.append(item);
    }
    for (const group of status?.groups || []) {
      if (contextMap && group.mapId !== contextMap) continue;
      const detail = group.permanent ? t('Бесплатно навсегда') : group.expiresAt
        ? (group.active ? remaining(group.expiresAt) + ' · ' + t('Действует до {0}', [date(group.expiresAt)])
          : t('Подписка завершена {0}', [date(group.expiresAt)])) : t('Активной подписки нет');
      row(group.title || t('Сервер группы'), detail, group.isOwner && !group.permanent ? {
        text: t('Продлить кодом'), click: () => { target = group.mapId; render(current); el('subscription-code').focus(); }
      } : null, group);
      if (!group.active && !group.permanent && status.enabled) {
        const note = document.createElement('p'); note.className = 'opt-note';
        note.textContent = group.retainedUntil ? t('Роли и участники сохраняются как минимум до {0}.', [date(group.retainedUntil)])
          : t('Сервер приостановлен. Продлить его может владелец.');
        groups.append(note);
      }
    }
    if (!status?.groups?.length && status?.ready) row(t('У тебя пока нет серверов'), t('Создай свой сервер через «+» слева.'));
  }

  async function refresh() {
    const started = epoch; el('subscription-refresh').disabled = true;
    try { const status = api?.billingRefresh ? await api.billingRefresh() : current; if (started === epoch) render(status); }
    catch { if (started === epoch) render({ ...current, error: true }); }
    finally { el('subscription-refresh').disabled = false; }
  }
  async function activate(event) {
    event.preventDefault();
    if (busy || !api?.billingRedeemCode) return;
    const code = el('subscription-code').value;
    if (!/^AM30[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{30}$/.test(code.replace(/[-\s]/g, '').toUpperCase())) {
      message(t(errors.invalid_code)); return;
    }
    if (!target || !current?.groups?.some(group => group.mapId === target && group.isOwner && !group.permanent)) return;
    const map = target, started = epoch;
    el('subscription-code').value = ''; busy = true; message(''); render(current);
    try {
      const result = await api.billingRedeemCode(code, map);
      if (started !== epoch) return;
      if (!result?.ok) { message(t(errors[result?.code] || errors.code_activation_failed)); return; }
      if (result.status) render(result.status);
      message(t(result.alreadyRedeemed ? 'Этот код уже активирован на твоём аккаунте. Повторного списания нет.'
        : 'Код активирован. Доступ действует до {0}.', [date(result.expiresAt)]), true);
    } catch { if (started === epoch) message(t(errors.code_activation_failed)); }
    finally { if (started === epoch) { busy = false; render(current); } }
  }
  function clearContext() { contextMap = null; target = ''; render(current); }
  function openForMap(mapId) {
    closeModals(); openModal('modal-settings', 'set-subscriptions');
    contextMap = null; target = ''; message(''); render(current); refresh();
  }
  el('subscription-code-form').addEventListener('submit', activate);
  el('subscription-code-target').addEventListener('change', () => { target = el('subscription-code-target').value; message(''); render(current); });
  el('subscription-all').onclick = clearContext;
  el('subscription-refresh').onclick = refresh;
  window.AvalonSubscriptionsUI = { render, clearContext, openForMap, errorText: code => t(errors[code] || errors.code_activation_failed) };
  setInterval(() => {
    if (el('set-subscriptions').hidden) return;
    for (const node of el('subscription-groups').querySelectorAll('[data-expires]')) node.textContent = remaining(node.dataset.expires) + ' · ' + t('Действует до {0}', [date(node.dataset.expires)]);
  }, 30000);
  if (api?.billingStatus) {
    api.on('billing-changed', render);
    api.on('auth-changed', () => { epoch++; busy = false; contextMap = null; target = ''; el('subscription-code').value = ''; message(''); render(null); });
    const started = epoch;
    api.billingStatus().then(status => { if (started === epoch) render(status); }).catch(() => { if (started === epoch) render(null); });
  } else render({ ready: true, enabled: false });
})();
