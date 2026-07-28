// Проверка обновлений: приложение раздаётся файлом, а не магазином, поэтому само
// смотрит, не вышла ли новая версия, и говорит об этом строкой внизу панели.
//
// Никакой автозагрузки и тем более автозапуска чужого файла: мы только СРАВНИВАЕМ
// версии и показываем ссылку. Скачивание и установку человек делает сам, руками —
// это единственный честный вариант для приложения, которое просят запускать
// от администратора.
//
// Откуда берётся версия — два варианта, оба через один и тот же адрес в настройках:
//   1. GitHub Releases — вписывается «owner/repo» или ссылка на репозиторий, дальше
//      приложение само ходит в api.github.com и читает последний выпуск. Ничего
//      выкладывать вручную не надо: тег выпуска и есть версия.
//   2. Свой файл: { "version": "0.2.0", "url": "https://…/setup.exe", "notes": "…" }
'use strict';

const CHECK_EVERY_MS = 3600 * 1000;   // раз в час
const TIMEOUT_MS = 8000;

// «0.2.0» → [0,2,0]; мусор и хвосты вроде «1.2.3-beta» не ломают сравнение
function parts(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[.\-+]/)
    .map(x => parseInt(x, 10)).filter(Number.isFinite);
}
// > 0 — a новее b
function compare(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
const isNewer = (remote, local) => compare(remote, local) > 0;

// «owner/repo», ссылка на репозиторий или на выпуски → адрес API последнего выпуска.
// Любой другой https-адрес остаётся как есть: это свой файл с версией.
const GH_REPO = /^[\w.-]+\/[\w.-]+$/;
function normalizeUrl(input) {
  const v = String(input || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (GH_REPO.test(v)) return `https://api.github.com/repos/${v}/releases/latest`;
  const m = v.match(/^https:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)(?:\/.*)?$/i);
  if (m) return `https://api.github.com/repos/${m[1]}/releases/latest`;
  return /^https:\/\//i.test(v) ? v : '';
}

// «api.github.com» и «github.com» — один и тот же владелец, а вот «github.com.evil.net» —
// уже нет. Раньше здесь сравнивались две последние части имени, и это неверно для
// многосоставных суффиксов: «a.github.io» и «b.github.io» (а также pages.dev, co.uk) —
// разные люди с одинаковым хвостом, и подменённый файл версий увёл бы игрока к соседу.
// Правильный признак — не хвост, а вложенность: тот же хост либо его поддомен.
// Граница обязательно по точке, иначе «github.com.evil.net» сошёл бы за github.com.
// Список публичных суффиксов сюда не тянем: он большой, живой, и без него точнее.
function sameSite(a, b) {
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
}

// Ссылку открывает система, поэтому проверяем её строго: только https и только туда же,
// откуда пришёл сам ответ. Иначе подменённый файл версий уводил бы игрока куда угодно.
function safeUrl(url, sourceUrl) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return null;
    if (sourceUrl && !sameSite(u.host, new URL(String(sourceUrl)).host)) return null;
    return u.href;
  } catch { return null; }
}

// Один запрос. fetchImpl и now подменяются в тестах.
async function fetchInfo(url, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!url) return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    // Ответ GitHub: tag_name — версия, html_url — страница выпуска со всеми файлами.
    // Ведём именно на страницу, а не на .exe: человек видит, что качает, и откуда.
    const version = j && (j.version || j.tag_name);
    if (!version) throw new Error('в ответе нет версии');
    // html_url — ПЕРВЫМ. У настоящего ответа GitHub Releases поле url есть всегда и
    // ведёт на JSON этого же API: с «j.url ||» игрок по кнопке «вышла версия» открывал
    // бы в браузере сырой JSON вместо страницы выпуска. У своего файла версий html_url
    // нет, и тогда берётся его url — ссылка на установщик.
    const link = j.html_url || j.url;
    const notes = j.notes || j.body || '';
    return {
      version: String(version),
      url: safeUrl(link, url),
      notes: String(notes).trim().slice(0, 400),
    };
  } finally { if (timer) clearTimeout(timer); }
}

// Состояние проверки: что нашли, когда смотрели, чем кончилось.
function createChecker({ currentVersion, getUrl, onFound, log = () => {}, fetchImpl, now = () => Date.now() }) {
  const state = { checkedAt: 0, latest: null, error: null, busy: false };
  let timer = null;

  async function check(force) {
    const url = getUrl();
    if (!url || state.busy) return state;
    if (!force && now() - state.checkedAt < CHECK_EVERY_MS) return state;
    state.busy = true;
    try {
      const info = await fetchInfo(url, { fetchImpl });
      state.checkedAt = now();
      state.error = null;
      if (info && isNewer(info.version, currentVersion)) {
        const fresh = !state.latest || state.latest.version !== info.version;
        state.latest = info;
        if (fresh && onFound) onFound(info);
        log(`[обновление] доступна версия ${info.version} (у нас ${currentVersion})`);
      } else {
        state.latest = null;
      }
    } catch (err) {
      // Нет сети или адрес не отвечает — это не повод беспокоить игрока: обновление
      // не то, ради чего стоит показывать ошибку поверх игры.
      state.error = err.message;
      log('[обновление] проверить не вышло: ' + err.message);
    } finally { state.busy = false; }
    return state;
  }

  return {
    check,
    start() {
      if (timer) return;
      timer = setInterval(() => { check(); }, CHECK_EVERY_MS);
      if (timer.unref) timer.unref();
      check(true);
    },
    stop() { clearInterval(timer); timer = null; },
    status() {
      return {
        current: currentVersion,
        latest: state.latest ? state.latest.version : null,
        url: state.latest ? state.latest.url : null,
        notes: state.latest ? state.latest.notes : '',
        checkedAt: state.checkedAt,
        error: state.error,
      };
    },
  };
}

module.exports = { createChecker, fetchInfo, compare, isNewer, safeUrl, normalizeUrl, sameSite, CHECK_EVERY_MS };
