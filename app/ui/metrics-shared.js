/* Presentation shared by Statistics and its two independent overlays. */
(() => {
  'use strict';
  const format = n => Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU') : '—';
  const compactFormatter = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
  const compact = n => Number.isFinite(n) ? compactFormatter.format(n) : '—';
  const time = ms => {
    const s = Math.floor((ms || 0) / 1000);
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
  };
  function status(s) {
    if (!s.enabled) return { text: 'Счётчики выключены', short: 'Выключено', kind: 'paused' };
    if (s.paused) return { text: 'На паузе — фейм и урон не учитываются', short: 'Пауза', kind: 'paused' };
    if (s.error) return { text: 'Нет захвата: ' + s.error, short: 'Нет захвата', kind: 'waiting' };
    if (!s.listening) return { text: 'Подключаюсь к игре…', short: 'Подключение', kind: 'waiting' };
    if (!s.lastPacketAt || Date.now() - s.lastPacketAt > 15000) return { text: 'Нет свежих данных игры', short: 'Нет данных', kind: 'waiting' };
    if (!s.selfName) return { text: 'Перейди в другую локацию, чтобы определить персонажа', short: 'Ожидаю персонажа', kind: 'waiting' };
    return { text: 'Сбор данных', short: '', kind: 'live' };
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
    nodes.icon.title = key ? row.weapon.name : row.weaponId === 0 ? 'Без оружия' : 'Оружие пока не определено';
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
