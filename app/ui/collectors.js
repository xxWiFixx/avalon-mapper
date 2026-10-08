/* Private collector controls are created only after main confirms account access. */
(() => {
  'use strict';
  const t = (text, values) => globalThis.AvalonI18n?.t(text, values) || text;
  window.CollectorUI = { create(host) {
    let section = null, state = null, busy = false, error = '', offset = 0, total = 0, generation = 0, loadedCount = -1, loading = false;
    const number = n => new Intl.NumberFormat(document.documentElement.lang || 'ru', { maximumFractionDigits: 2 }).format(n);
    const messages = {
      access_denied: 'Доступ недоступен для этого аккаунта.', profile_unavailable: 'Не удалось подтвердить вход. Проверь соединение и повтори.',
      save_failed: 'Не удалось сохранить настройку.', read_timeout: 'Не удалось прочитать письма. Повтори.',
      collector_failed: 'Не удалось запустить сборщик.', collector_stopped: 'Сборщик остановился. Включи его повторно.',
      decode_failed: 'Не удалось разобрать часть данных игры.', upload_unavailable: 'Avalon Market недоступен. Данные сохранены и отправятся позже.',
      private_region_mismatch: 'Avalon Market принимает данные сервера Europe.', pow_budget_exceeded: 'Отправка в AODP отложена. Сборщик повторит её позже.',
    };
    function textError(code) { return t(messages[code] || 'Не удалось выполнить действие. Повтори.'); }
    function remove() { generation++; section?.remove(); section = null; state = null; loadedCount = -1; loading = false; busy = false; offset = 0; total = 0; error = ''; }
    function build() {
      section = document.createElement('section'); section.className = 'metrics-collectors';
      section.setAttribute('aria-label', t('Рынок и торговые письма'));
      section.innerHTML = `<div class="collector-control"><div><h2>AODP</h2><p>${t('Собирает цены и историю рынка, которые ты открываешь в игре. Отдельный клиент не нужен.')}</p></div><label class="metrics-toggle"><input type="checkbox" role="switch" data-collector="market"><span class="metrics-switch" aria-hidden="true"></span><span>${t('Включить AODP')}</span></label></div>
        <p class="collector-market-status" role="status"></p>
        <div class="collector-control"><div><h2>${t('Торговые письма')}</h2><p>${t('Открой письма о покупках и продажах в игре: сделки сохранятся в базе на этом компьютере. Личная переписка не сохраняется.')}</p></div><label class="metrics-toggle"><input type="checkbox" role="switch" data-collector="mail"><span class="metrics-switch" aria-hidden="true"></span><span>${t('Просмотр сообщений')}</span></label></div>
        <p class="collector-mail-status" role="status"></p><p class="collector-error" role="alert" hidden></p>
        <details class="collector-inbox"><summary>${t('Сохранённые сделки')} <span data-mail-total></span></summary>
          <div class="collector-inbox-toolbar"><button type="button" class="btn ghost" data-mail-refresh>${t('Обновить')}</button><span data-mail-page></span><button type="button" class="btn ghost" data-mail-prev>${t('Назад')}</button><button type="button" class="btn ghost" data-mail-next>${t('Далее')}</button></div>
          <p data-mail-empty></p><div class="collector-mail-table-wrap"><table class="collector-mail-table"><thead><tr>${['Дата','Персонаж','Город','Сделка','Предмет','Количество','Цена','Итого'].map(label => `<th scope="col">${t(label)}</th>`).join('')}</tr></thead><tbody></tbody></table></div>
        </details>`;
      host.querySelector('.metrics-panel').append(section);
      section.addEventListener('change', async event => {
        const kind = event.target.dataset.collector; if (!kind || busy || !state) return;
        const mine = generation, value = event.target.checked; busy = true; error = ''; update(state);
        try { const result = await window.api.collectorAction(kind, value); if (mine !== generation) return;
          if (!result?.ok) error = textError(result?.error);
          if (result?.state?.collectors) state = result.state.collectors;
        } catch { if (mine === generation) error = textError('profile_unavailable'); }
        finally { if (mine === generation) { busy = false; update(state); } }
      });
      section.querySelector('.collector-inbox').addEventListener('toggle', () => { if (section?.querySelector('.collector-inbox').open) read(); });
      section.querySelector('[data-mail-refresh]').onclick = () => read(true);
      section.querySelector('[data-mail-prev]').onclick = () => { offset = Math.max(0, offset - 50); read(true); };
      section.querySelector('[data-mail-next]').onclick = () => { offset += 50; read(true); };
    }
    async function read(force = false) {
      if (!section || loading || (!force && loadedCount === state?.mails)) return;
      loading = true; const mine = generation; setPaging();
      try { const result = await window.api.collectorMails({ offset, limit: 50 }); if (mine !== generation || !section) return;
        if (result?.error) { error = textError(result.error); loadedCount = state?.mails || 0; return; }
        total = result.total; loadedCount = state?.mails || 0;
        const rows = document.createDocumentFragment();
        for (const row of result.rows) {
          const tr = document.createElement('tr');
          const date = new Date(row.receivedAt || row.observedAt);
          const values = [date.toLocaleString(document.documentElement.lang || 'ru'), row.character, row.city, t(row.direction === 'buy' ? 'Покупка' : 'Продажа'), row.item, number(row.quantity), number(row.unitPrice), number(row.total)];
          for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
          rows.append(tr);
        }
        section.querySelector('tbody').replaceChildren(rows);
        section.querySelector('[data-mail-empty]').textContent = total ? '' : t('Пока нет сохранённых сделок. После включения открой торговые письма в игре. Если данные не появились, перейди в другую зону и открой письма ещё раз.');
      } catch { if (mine === generation) { error = textError('read_timeout'); loadedCount = state?.mails || 0; } }
      finally { if (mine === generation && section) { loading = false; update(state); } }
    }
    function setPaging() {
      section.querySelector('[data-mail-page]').textContent = total ? `${Math.min(offset + 1, total)}–${Math.min(offset + 50, total)} / ${number(total)}` : '';
      section.querySelector('[data-mail-prev]').disabled = loading || !offset;
      section.querySelector('[data-mail-next]').disabled = loading || offset + 50 >= total;
      section.querySelector('[data-mail-refresh]').disabled = loading;
    }
    function update(s) {
      if (!s?.allowed) { remove(); return; } state = s;
      if (!section) build();
      for (const input of section.querySelectorAll('[data-collector]')) { input.checked = !!s[input.dataset.collector]; input.disabled = busy; }
      const marketStatus = section.querySelector('.collector-market-status');
      marketStatus.textContent = !s.market ? t('Сбор рынка выключен') : t('Снимков рынка: {0} · Отправлено: {1} · В очереди: {2}', [number(s.observations || 0), number(s.uploaded || 0), number(s.queued || 0)]);
      if (s.market && s.encrypted) marketStatus.textContent += ' · ' + t('Игра передаёт зашифрованные пакеты. Доступные цены продолжают сохраняться.');
      if (s.market && s.error) marketStatus.textContent += ' · ' + textError(s.error);
      if (s.market && !s.destination) marketStatus.textContent += ' · ' + t('Сохранение только в локальную базу');
      section.querySelector('.collector-mail-status').textContent = (s.mail ? t('Сканер включён') : t('Сканер выключен')) + ' · ' + t('Сделок в базе: {0}', [number(s.mails || 0)]);
      const alert = section.querySelector('.collector-error'); alert.hidden = !error; alert.textContent = error;
      section.querySelector('[data-mail-total]').textContent = number(s.mails || 0); setPaging();
      if (section.querySelector('.collector-inbox').open && loadedCount !== (s.mails || 0)) read();
    }
    return { update, remove };
  } };
})();
