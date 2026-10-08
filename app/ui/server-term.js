(function (root) {
  'use strict';
  function term(expiresAt, now = Date.now(), language = 'ru') {
    const left = Date.parse(expiresAt) - now;
    if (!Number.isFinite(left) || left <= 0) return language === 'en' ? 'Server paused' : 'Сервер приостановлен';
    const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
    const part = (n, en, ru) => n + ' ' + (language === 'en' ? en + (n === 1 ? '' : 's') : plural(n, ru));
    const days = left >= 86400000 ? Math.ceil(left / 86400000) : 0;
    if (days) return part(days, 'day', ['день', 'дня', 'дней']);
    const minutes = Math.floor(left / 60000), hours = Math.floor(minutes / 60);
    if (!minutes) return language === 'en' ? 'Less than a minute' : 'Меньше минуты';
    return (hours ? part(hours, 'hour', ['час', 'часа', 'часов']) + ' ' : '') + part(minutes % 60, 'minute', ['минута', 'минуты', 'минут']);
  }
  if (typeof module === 'object' && module.exports) module.exports = { term };
  else root.AvalonServerTerm = { term };
})(typeof globalThis !== 'undefined' ? globalThis : this);
