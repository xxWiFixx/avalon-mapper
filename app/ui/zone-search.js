// Поиск зоны по сокращению — общий для поля «Куда» в окне карты и для окна поиска,
// которое всплывает по хоткею, когда снимок области у курсора выключен.
// Оба места обязаны понимать одни и те же сокращения, поэтому логика ровно одна.
//
// Правило простое: запрос раскладывается по НАЧАЛАМ частей имени подряд.
//   «couexa» = cou|Coues + exa|Exakrom, «forster» = for|Fort + ster|Sterling.
// Дефисы и пробелы в запросе игнорируются: «qiient-al» ищется как «qiiental».
(function (root) {
  // имя зоны → части с позициями: "Coues-Exakrom" → [coues@0, exakrom@6]
  function nameParts(name) {
    const parts = [], re = /[^\s-]+/g;
    let m;
    while ((m = re.exec(name))) parts.push({ t: m[0].toLowerCase(), i: m.index });
    return parts;
  }

  // Перебор с откатом: сначала пробуем откусить в часть как можно больше букв.
  // lens[i] — сколько букв запроса ушло в начало i-й части (для подсветки совпадения).
  function matchParts(parts, pi, q, qi, lens) {
    if (qi >= q.length) return true;
    if (pi >= parts.length) return false;
    const part = parts[pi].t;
    const max = Math.min(part.length, q.length - qi);
    for (let k = max; k >= 1; k--) {
      if (!part.startsWith(q.slice(qi, qi + k))) continue;
      lens[pi] = k;
      if (matchParts(parts, pi + 1, q, qi + k, lens)) return true;
      lens[pi] = 0;
    }
    return false;
  }

  // zones: [{ name, color }] → [{ name, color, score, marks }], лучшие сверху
  function search(zones, q, limit = 12) {
    const query = String(q || '').trim().toLowerCase();
    const flat = query.replace(/[\s-]+/g, '');
    if (!flat) return [];
    const found = [];
    for (const z of zones || []) {
      const low = z.name.toLowerCase();
      const parts = nameParts(z.name);
      const lens = new Array(parts.length).fill(0);
      let score = -1, marks = null;
      if (matchParts(parts, 0, flat, 0, lens)) {
        score = low.startsWith(query) ? 0 : 1; // точное начало имени — выше по списку
        marks = parts.map((p, i) => (lens[i] ? [p.i, lens[i]] : null)).filter(Boolean);
      } else {
        const at = low.indexOf(query); // запасной вариант: кусок где-то в середине имени
        if (at > 0) { score = 2; marks = [[at, query.length]]; }
      }
      if (score < 0) continue;
      found.push({ name: z.name, color: z.color, score, marks });
    }
    found.sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
    return found.slice(0, limit);
  }

  // имя с <b> вокруг совпавших кусков; esc — экранирование вызывающей стороны
  function mark(name, marks, esc) {
    const e = esc || (s => String(s));
    if (!marks || !marks.length) return e(name);
    let html = '', pos = 0;
    for (const [i, len] of marks.slice().sort((a, b) => a[0] - b[0])) {
      if (i < pos) continue;
      html += e(name.slice(pos, i)) + '<b>' + e(name.slice(i, i + len)) + '</b>';
      pos = i + len;
    }
    return html + e(name.slice(pos));
  }

  root.ZONE_SEARCH = { search, mark };
})(typeof window !== 'undefined' ? window : globalThis);
