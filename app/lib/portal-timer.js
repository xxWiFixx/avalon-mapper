const { parseBottom, sameNumber } = require('./portal-duration');
const { isCompleteTimer, timerConflict, selectTimerReread } = require('./recognition-confidence');
const { findTimerText, timerImage } = require('./timer-image');

const WHITELIST = '0123456789чмсЧМС ';
const PREPS = [{ scale: 4, threshold: 150 }, { scale: 3, original: true }, { scale: 4, threshold: null }, { scale: 4, original: true }];

function confirmed(votes) {
  const complete = votes.filter(isCompleteTimer), groups = new Map();
  for (const v of complete) {
    const list = groups.get(v.closes) || [];
    list.push(v); groups.set(v.closes, list);
  }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
  if (!ranked.length) return null;
  const winner = ranked[0];
  // A second reading must include the isolated digits, not just another pass of
  // the same noisy label. Any competing complete reading requires more evidence.
  if (winner.length < 2 || !winner.some(v => v.family === 'digits')) return null;
  // A new value isolated from a noisy crop cannot overrule an explicitly read
  // different full-line duration without corroborating label-context evidence.
  if (complete.some(v => v.family !== 'digits') && !winner.some(v => v.family !== 'digits')) return null;
  if (ranked.length > 1 && (winner.length < 3 || winner.length < ranked[1].length + 2
    || winner.filter(v => v.family === 'digits').length < 2)) return null;
  return winner[0].closes;
}

function fallback(votes) {
  if (!votes.length) return null;
  const complete = votes.filter(isCompleteTimer);
  const quality = Math.max(...votes.map(v => v.quality));
  const top = complete.length ? complete : votes.filter(v => v.quality === quality);
  const groups = new Map();
  for (const v of top) {
    const g = groups.get(v.closes) || { closes: v.closes, count: 0, marker: false, weight: 0 };
    g.count++; g.marker ||= v.marker; g.weight += v.weight || 1;
    groups.set(v.closes, g);
  }
  // A disputed short timer must never be extended by the old leading-one repair.
  if (groups.size > 1 && [...groups.keys()].some(sec => sec < 3600)) return null;
  const list = [...groups.values()];
  for (const a of list) for (const b of list) {
    if (a === b || a.dead || b.dead || a.closes >= b.closes) continue;
    const win = sameNumber(a.closes, b.closes);
    if (!win) continue;
    const [keep, drop] = win === 'lo' ? [a, b] : [b, a];
    keep.count += drop.count; keep.weight += drop.weight; keep.marker ||= drop.marker; drop.dead = true;
  }
  const ranked = list.filter(g => !g.dead).sort((a, b) => b.count - a.count || Number(b.marker) - Number(a.marker) || b.weight - a.weight);
  // Unsupported single-unit fragments aren't valid timers; complete seconds and
  // minutes are valid, even though the legacy quality field for them is only 1.
  if (!complete.length) return null;
  // One correct-looking OCR pass is not enough. Inferred fused-unit readings may
  // corroborate an explicit matching duration, but cannot establish it alone.
  if (votes.filter(v => v.closes === ranked[0]?.closes).length < 2) return null;
  return ranked[0]?.closes ?? null;
}

async function recognizeTimer(frame, bar, { ocr, crop, row = 0 }) {
  const s = bar.scale, { bx, by, bh } = bar;
  const reads = [], votes = [], targeted = [];
  let bottom = '', sawCanuse = false, sawClose = false, closingTop = by + bh + 2 + row * 24 * s;

  async function record(image, opts, family, evidence = '') {
    if (!image) return null;
    const text = await ocr(image, opts);
    if (!text) return null;
    bottom = text;
    const parsed = parseBottom(text);
    sawClose ||= parsed.marker;
    parsed.family = family;
    parsed.evidenceKey = `${row}:${family}:${evidence || JSON.stringify(opts)}`;
    parsed.weight = 1 + (family === 'digits' ? 1 : 0) + (opts.thresh ? 1 : 0);
    reads.push({ text, family, closes: parsed.closes, complete: isCompleteTimer(parsed) });
    if (/использ|usable|can\s+use/i.test(text)) sawCanuse = true;
    if (parsed.closes !== null && parsed.quality > 0) votes.push(parsed);
    if (family === 'digits' && parsed.closes !== null) targeted.push(parsed);
    return parsed;
  }

  async function full(top, opts = { psm: 7 }) {
    return record(await crop(frame, bx - 20 * s, top, 320 * s, 28 * s, { scale: 4, thresh: opts.thresh ?? null }), opts, 'full');
  }

  await full(closingTop);
  if (sawCanuse && !sawClose) {
    if (row === 0) return recognizeTimer(frame, bar, { ocr, crop, row: 1 });
    return { closes: null, timerUncertain: true, raw: { bottom, timerReads: reads, timerRegion: null } };
  }

  const region = findTimerText(frame, bar, closingTop);
  for (const prep of PREPS) {
    await record(await timerImage(frame, region, prep), { psm: 7, whitelist: WHITELIST }, 'digits', JSON.stringify(prep));
    const result = confirmed(votes);
    if (result !== null && !(sawCanuse && !sawClose)) {
      return { closes: result, raw: { bottom, timerReads: reads, timerRegion: region }, timerUncertain: false };
    }
    if (!region) break;
  }

  // Established wider crops remain a bounded fallback when segmentation or a
  // thin unit glyph fails. Read closing/cooldown context with an unrestricted pass.
  const variants = [
    { psm: 6 }, { psm: 7, thresh: 150 },
    { psm: 7, thresh: 150, whitelist: WHITELIST },
    { psm: 7, whitelist: WHITELIST },
    { psm: 7, whitelist: WHITELIST, right: true },
    { psm: 7, thresh: 150, whitelist: WHITELIST, right: true },
    { psm: 7, thresh: 120, whitelist: WHITELIST, right: true },
  ];
  for (const opts of variants) {
    const left = opts.right ? bx + 110 * s : bx - 20 * s;
    const width = opts.right ? 210 * s : 320 * s;
    await record(await crop(frame, left, closingTop, width, 28 * s, { scale: 4, thresh: opts.thresh ?? null }), opts, opts.right ? 'right' : 'full');
    const result = confirmed(votes);
    if (result !== null && !(sawCanuse && !sawClose)) {
      return { closes: result, raw: { bottom, timerReads: reads, timerRegion: region }, timerUncertain: false };
    }
  }
  let closes = fallback(votes);
  const contextual = votes.filter(v => v.family !== 'digits');
  // Short-duration conflicts require the stronger combined confirmation above.
  // Do not let two narrow guesses bypass its margin against contrary full reads.
  if (timerConflict(contextual) && !votes.some(v => isCompleteTimer(v) && v.closes < 3600)) {
    closes = selectTimerReread(contextual, targeted, closes);
  }
  if (sawCanuse && !sawClose) {
    if (row === 0) return recognizeTimer(frame, bar, { ocr, crop, row: 1 });
    closes = null;
  }
  return { closes, timerUncertain: closes === null, raw: { bottom, timerReads: reads, timerRegion: region } };
}

module.exports = { recognizeTimer, confirmed, fallback };
