var i18nText = (globalThis.AvalonI18n?.t || ((text, values) => Array.isArray(values) ? text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match) : text));
/* Presentation shared by Statistics and its two independent overlays. */
(() => {
  'use strict';
  const format = n => Number.isFinite(n) ? Math.round(n).toLocaleString((globalThis.AvalonI18n?.locale() || 'ru-RU')) : '—';
  const compactFormatter = new Intl.NumberFormat((globalThis.AvalonI18n?.locale() || 'ru-RU'), { notation: 'compact', maximumFractionDigits: 1 });
  const compact = n => Number.isFinite(n) ? compactFormatter.format(n) : '—';
  const time = ms => {
    const s = Math.floor((ms || 0) / 1000);
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
  };
  function status(s) {
    if (!s.enabled) return { text: i18nText("Счётчики выключены"), short: i18nText("Выключено"), kind: 'paused' };
    if (s.paused) return { text: i18nText("На паузе — фейм и урон не учитываются"), short: i18nText("Пауза"), kind: 'paused' };
    if (s.error) return { text: i18nText("Нет захвата: ") + s.error, short: i18nText("Нет захвата"), kind: 'waiting' };
    if (!s.listening) return { text: i18nText("Подключаюсь к игре…"), short: i18nText("Подключение"), kind: 'waiting' };
    if (!s.lastPacketAt || Date.now() - s.lastPacketAt > 15000) return { text: i18nText("Нет свежих данных игры"), short: i18nText("Нет данных"), kind: 'waiting' };
    if (!s.selfName) return { text: i18nText("Перейди в другую локацию, чтобы определить персонажа"), short: i18nText("Ожидаю персонажа"), kind: 'waiting' };
    return { text: s.fameEnabled && s.damageEnabled ? i18nText("Сбор фейма и урона") : s.fameEnabled ? i18nText("Сбор фейма") : i18nText("Сбор урона"), short: '', kind: 'live' };
  }
  function createWeapon() {
    const icon = document.createElement('span'); icon.className = 'metrics-weapon';
    const fallback = document.createElement('span'); fallback.textContent = '—'; fallback.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img'); img.alt = ''; img.hidden = true;
    img.referrerPolicy = 'no-referrer'; img.decoding = 'async'; img.width = img.height = 64;
    img.addEventListener('load', () => { if (img.getAttribute('src')) { img.hidden = false; fallback.hidden = true; } });
    img.addEventListener('error', () => { img.hidden = true; fallback.hidden = false; });
    icon.append(fallback, img);
    return { icon, img, fallback, key: null };
  }
  function updateWeapon(nodes, row) {
    const key = /^T[1-8]_[A-Z0-9_]+(?:@[1-4])?$/.test(row.weapon?.key || '') ? row.weapon.key : null;
    nodes.icon.title = key ? (globalThis.AvalonI18n?.gameName(row.weapon.name) || row.weapon.name) : row.weaponId === 0 ? i18nText("Без оружия") : i18nText("Оружие пока не определено");
    nodes.icon.setAttribute('aria-label', nodes.icon.title);
    if (nodes.key !== key) {
      nodes.key = key; nodes.img.hidden = true; nodes.fallback.hidden = false;
      if (key) nodes.img.src = 'https://render.albiononline.com/v1/item/' + encodeURIComponent(key) + '.png?size=64';
      else nodes.img.removeAttribute('src');
    }
  }
  function subscribe(render, unavailable) {
    if (!window.api?.getMetrics) { unavailable(); return; }
    // Subscribe before requesting the snapshot so creation cannot lose an update.
    let updated = false;
    window.api.on('metrics-updated', s => { updated = true; render(s); });
    window.api.getMetrics().then(s => { if (!updated) render(s); }).catch(() => { if (!updated) unavailable(); });
  }
  const damageData = s => s.damageSegment === 'overall'
    ? s.overall || { rows: [], totalDamage: 0, partyDps: 0, selfDps: 0, durationMs: 0, segments: 0 } : s;
  window.MetricsUI = { format, compact, time, status, createWeapon, updateWeapon, subscribe, damageData };
})();
