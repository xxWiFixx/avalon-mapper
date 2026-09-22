// Portal timers are at most one day. Explicit single-unit timers are complete
// readings too; quality keeps its legacy meaning (number of explicit units).
const MAX_HOURS = 24;
const UNIT = /^[чhмmсcs](?![a-zа-я])/i;
const normDigits = text => String(text || '')
  .replace(/(?<=\d)[ОOоo]|[ОOоo](?=\d)/g, '0')
  // A trailing English S is seconds, not an OCR substitute for five.
  .replace(/S(?=\d)|(?<=\d)S(?=\s*[чhмm])/g, '5')
  .replace(/(?<=\d)[lI]|[lI](?=\d)/g, '1')
  .replace(/(?<=\d[\s.]?)[YУyu](?=[\s.]?\d)/g, 'ч')
  // The red near-expiry glyphs can be read twice, with different casing.
  // Restrict this repair to units immediately after a number, not label words.
  .replace(/(\d\s*)[чh]{2,}(?=\s|\d|$)/gi, '$1ч')
  .replace(/(\d\s*)[мm]{2,}(?=\s|\d|$)/gi, '$1м')
  .replace(/(\d\s*)[сcs]{2,}(?=\s|\d|$)/gi, '$1с');

function danglingDigits(text, start, end) {
  // Dropping a unit must not turn "5 59 с" into "59 с" or "5 м 59"
  // into "5 м". Labels and unrelated letters may remain around the token.
  if (/\d[\s.,:]*$/.test(text.slice(0, start))) return true;
  const after = text.slice(end), number = after.match(/^[\s.,:]*(\d+)/);
  if (!number) return false;
  return !UNIT.test(after.slice(number[0].length).trimStart().slice(0, 2));
}

function scanDurations(input) {
  const text = normDigits(input), explicit = [], inferred = [];
  // Invalid pairs are matched as a whole and discarded; they cannot fall through
  // to a shorter but different timer such as "24 ч 24 м" -> "24 м".
  const re = /(?<![\d.+-])(-?\d+(?:\.\d+)?)\s*[чh]\s*(-?\d+(?:\.\d+)?)\s*[мm](?![a-zа-я])|(?<![\d.+-])(-?\d+(?:\.\d+)?)\s*[мm]\s*(-?\d+(?:\.\d+)?)\s*[сcs](?![a-zа-я])|(?<![\d.+-])(-?\d+(?:\.\d+)?)\s*([чhмmсcs])(?![a-zа-я])/gi;
  const whole = n => Number.isInteger(n) && n >= 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (danglingDigits(text, match.index, re.lastIndex)) continue;
    const raw = match[0];
    if (match[1] !== undefined) {
      const h = +match[1], m = +match[2];
      if (whole(h) && whole(m) && m < 60 && h * 3600 + m * 60 <= MAX_HOURS * 3600) {
        explicit.push({ sec: h * 3600 + m * 60, quality: 2, complete: true, unit: 'hm', raw });
      }
    } else if (match[3] !== undefined) {
      const m = +match[3], s = +match[4];
      if (whole(m) && whole(s) && m < 60 && s < 60) explicit.push({ sec: m * 60 + s, quality: 2, complete: true, unit: 'ms', raw });
    } else {
      const n = +match[5], letter = match[6].toLowerCase();
      const unit = /[чh]/.test(letter) ? 'h' : /[мm]/.test(letter) ? 'm' : 's';
      // A lone token is complete only when it does not leave another unit behind.
      // "ч5м" has lost its hours; "10ч ОТ M" has unreadable minutes. Do not
      // apply this to explicit pairs: noisy labels may contain spare unit glyphs.
      const before = text.slice(0, match.index), after = text.slice(re.lastIndex);
      if (/(?:^|[^a-zа-я])[чhмmсcs]+\s*$/i.test(before)
        || /(?:^|\s)[чhмmсcs](?=\s|$)/i.test(after)) continue;
      if (whole(n) && ((unit === 'h' && n <= MAX_HOURS) || (unit !== 'h' && n < 60))) {
        explicit.push({ sec: n * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1), quality: 1, complete: true, unit, raw });
      } else if (unit === 'm') {
        // Established OCR recovery: 2424м = 2ч24м, 524м = 5ч24м.
        // This contains an inferred unit and is never treated as a complete read.
        const fused = match[5].match(/^(\d{1,2})4(\d{2})$/) || match[5].match(/^(\d{1,2})(\d{2})$/);
        if (fused && +fused[2] < 60 && +fused[1] * 3600 + +fused[2] * 60 <= MAX_HOURS * 3600) {
          inferred.push({ sec: +fused[1] * 3600 + +fused[2] * 60, quality: 1, complete: false, unit: 'hm', raw });
        }
      }
    }
  }
  return explicit.length ? explicit : inferred;
}

function parseDur(text) {
  const durations = scanDurations(text);
  // Retain the established preference for the complete two-unit timer over a
  // spurious short prefix read from the label (e.g. "3ч 5ч36м").
  return durations.find(duration => duration.quality === 2) || durations[0] || null;
}

function allDurations(text) {
  return scanDurations(text).map(duration => ({ ...duration, q: duration.quality }));
}

function sameNumber(loSec, hiSec) {
  if (!Number.isFinite(loSec) || !Number.isFinite(hiSec) || loSec < 0 || !(loSec < hiSec)) return null;
  const loH = Math.floor(loSec / 3600), hiH = Math.floor(hiSec / 3600);
  const loM = Math.floor(loSec / 60) % 60, hiM = Math.floor(hiSec / 60) % 60;
  const loS = loSec % 60, hiS = hiSec % 60;
  // Known doubled hour glyph: 1ч59м is read as 14ч59м or 19ч59м.
  if (loSec % 3600 === hiSec % 3600 && loH >= 1 && (hiH === loH * 10 + 4 || hiH === loH * 10 + 9)) return 'lo';
  const lostOne = (lo, hi) => Number.isInteger(lo) && lo >= 0 && lo <= 9 && String(hi) === `1${lo}`;
  if ((lostOne(loH, hiH) && loM === hiM && loS === hiS)
    || (loH === hiH && lostOne(loM, hiM) && loS === hiS)
    || (loH === hiH && loM === hiM && lostOne(loS, hiS))) return 'hi';
  return null;
}

function parseBottom(input) {
  const text = normDigits(input);
  const res = { canuse: null, closes: null, quality: 0, marker: false, complete: false, unit: null, raw: '' };
  const closeIndex = text.search(/з[аоa]кро|closes|close/i);
  const useMarker = /использ|usable|\buse\b/i;
  const assign = duration => {
    if (duration) Object.assign(res, {
      closes: duration.sec, quality: duration.quality, complete: duration.complete, unit: duration.unit, raw: duration.raw,
    });
  };
  if (closeIndex >= 0) {
    res.marker = true;
    assign(parseDur(text.slice(closeIndex)));
    const before = text.slice(0, closeIndex);
    if (useMarker.test(before)) res.canuse = parseDur(before)?.sec ?? null;
    // An unreadable closing timer must never fall back to the readable cooldown.
    return res;
  }
  const durations = scanDurations(text);
  if (useMarker.test(text) && durations.length === 1) {
    res.canuse = durations[0].sec;
    return res;
  }
  if (durations.length >= 2) res.canuse = durations[0].sec;
  assign(durations.at(-1));
  return res;
}

module.exports = { MAX_HOURS, normDigits, parseDur, allDurations, sameNumber, parseBottom };
