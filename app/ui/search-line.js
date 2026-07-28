// Разбор строки окна поиска: «имя зоны [время до закрытия]».
// Например: «couexa», «couexa 45», «couexa 5 36», «couexa 5.36», «couexa 11.5».
//
// ПРАВИЛО, В КОТОРОМ НЕЧЕГО УГАДЫВАТЬ:
//   одно число — минуты, два числа — часы и минуты.
// Разделитель любой: пробел, точка, двоеточие, «ч».
//
// Почему не «две последние цифры — минуты»: игра пишет минуты без ведущего нуля
// («11 ч 5 м»), игрок стирает пробелы и набирает 115 — и такое правило прочитало бы
// это как 1:15. Поэтому голые цифры всегда минуты: 115 → 115 минут, а кто хотел
// час пятнадцать, ставит разделитель. Плюс окно показывает разобранное словами —
// ошибка видна до Enter, а не через час на карте.
(function (root) {
  const MAX_H = 48;                 // столько же, сколько допускает разбор тултипа в recognize.js
  const MAX_BARE_MIN = MAX_H * 60;

  const BARE = /^\d{1,4}$/;
  const H_M = /^(\d{1,2})\s*[.:чh]\s*(\d{1,2})\s*[мm]?$/i;  // 5.36 · 5:36 · 5ч36 · 5ч36м
  const H_ONLY = /^(\d{1,2})\s*[чh]$/i;                     // 5ч
  const M_ONLY = /^(\d{1,4})\s*[мm]$/i;                     // 45м

  // hm — форма «часы разделитель минуты»: в ней минуты обязаны быть меньше 60,
  // а вот в одиноких «90м» минут может быть сколько угодно (это полтора часа)
  function explicit(tok) {
    let m;
    if ((m = tok.match(H_M))) return { h: +m[1], m: +m[2], hm: true };
    if ((m = tok.match(H_ONLY))) return { h: +m[1], m: 0 };
    if ((m = tok.match(M_ONLY))) return { h: 0, m: +m[1], bare: true };
    return null;
  }

  // текст строки → { query, sec, error }
  //   query — что искать среди имён зон (время из него вырезано)
  //   sec   — время до закрытия портала в секундах или null
  //   error — человеческая причина, почему время не понято (Enter при ней блокируем)
  function parse(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return { query: '', sec: null, error: null };
    const tok = s.split(/\s+/);
    const timeish = t => BARE.test(t) || !!explicit(t);

    // Сначала отрезаем ВЕСЬ числовой хвост и только потом решаем, время ли это:
    // иначе при ошибке кусок хвоста остался бы в запросе и зона искалась бы по «couexa 5».
    let tail = 0;
    while (tail < tok.length && timeish(tok[tok.length - 1 - tail])) tail++;
    const query = tok.slice(0, tok.length - tail).join(' ');
    const bad = () => ({ query, sec: null, error: 'не понял время «' + tok.slice(tok.length - tail).join(' ') + '»' });

    if (!tail) return { query, sec: null, error: null };
    if (tail > 2) return bad();   // три числа подряд — это уже не «имя и время»

    let h, m;
    if (tail === 1) {
      const ex = explicit(tok[tok.length - 1]);
      if (ex) { h = ex.h; m = ex.m; if (ex.hm && m > 59) return bad(); }
      else { h = 0; m = +tok[tok.length - 1]; }         // голое число — минуты
      if (h === 0 && m > MAX_BARE_MIN) return bad();
    } else {
      const a = tok[tok.length - 2], b = tok[tok.length - 1];
      const ea = explicit(a), eb = explicit(b);
      if (!ea && !eb) { h = +a; m = +b; }                                // 5 36
      else if (!ea && eb && eb.bare) { h = +a; m = eb.m; }               // 5 36м
      else if (ea && eb && !ea.bare && eb.bare) { h = ea.h; m = eb.m; }  // 5ч 36м
      else return bad();
      if (m > 59) return bad();
    }
    if (h > MAX_H) return bad();
    const sec = h * 3600 + m * 60;
    if (sec <= 0) return { query, sec: null, error: 'время должно быть больше нуля' };
    return { query, sec, error: null };
  }

  // 20460 → «5 ч 41 мин»; минуты без часов — «45 мин»
  function fmtDur(sec) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h} ч ${m} мин` : `${m} мин`;
  }

  // во сколько закроется по часам игрока: «через 5 ч 41 мин» протухает, «в 06:12» — нет
  function fmtAt(sec, now) {
    const d = new Date((now == null ? Date.now() : now) + sec * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  root.SEARCH_LINE = { parse, fmtDur, fmtAt, MAX_H };
})(typeof window !== 'undefined' ? window : globalThis);
