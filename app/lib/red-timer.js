const { findRedTimerGlyphs, redTimerImage, joinGlyphs } = require('./red-timer-image');

const MODES = ['soft', 'gray', 'core'];
const UNITS = 'мМmMсСcCsSчЧhH';
const normalize = text => String(text || '').trim().replace(/\s+/g, '').replace(/[OОоo]/g, '0').replace(/[Зз]/g, '3');

function parseNumber(text, count) {
  const value = normalize(text).replace(/[Ss]/g, '5');
  if (!new RegExp(`^\\d{${count}}$`).test(value)) return null;
  return Number(value) < 60 ? Number(value) : null;
}

function parseBlock(text, count, unit) {
  const match = normalize(text).match(new RegExp(`^([0-9Ss]{${count}})${unit === 'm' ? '[мmМM]+' : '[сcsСCS]+'}$`, 'u'));
  return match ? parseNumber(match[1], count) : null;
}

function parseSingle(text, count) {
  const match = normalize(text).match(new RegExp(`^([0-9Ss]{${count}})([мmМM]+|[сcsСCS]+|[чЧhH]+)$`, 'u'));
  if (!match) return null;
  const number = Number(match[1].replace(/[Ss]/g, '5')), hour = /^[чЧhH]+$/.test(match[2]);
  if (hour ? number > 24 : number >= 60) return null;
  return number * (hour ? 3600 : /^[мmМM]+$/.test(match[2]) ? 60 : 1);
}

function isUnit(text, type) {
  const value = String(text || '').trim().replace(/\s+/g, '').toLowerCase();
  return type === 'm' ? /^[мm]+$/u.test(value) : /^[сcs]+$/u.test(value);
}

// Two page-segmentation modes on one processed image count as one view.
// A tied alternative across views remains unresolved.
function corroborated(readings) {
  const groups = new Map();
  for (const reading of readings) {
    if (reading.value == null) continue;
    const group = groups.get(reading.value) || { value: reading.value, modes: new Set(), count: 0 };
    group.modes.add(reading.mode); group.count++; groups.set(reading.value, group);
  }
  const ranked = [...groups.values()].sort((a, b) => b.modes.size - a.modes.size || b.count - a.count);
  if (!ranked.length || ranked[0].modes.size < 2
    || (ranked[1] && ranked[0].modes.size === ranked[1].modes.size)) return null;
  return ranked[0].value;
}

function layouts(glyphs) {
  const result = [];
  for (const minutes of [1, 2]) for (const seconds of [1, 2]) {
    if (minutes + seconds + 2 === glyphs.length) result.push({ minutes, seconds });
  }
  return result;
}

async function recognizeRedTimer(frame, bar, { ocr, top } = {}) {
  const found = findRedTimerGlyphs(frame, bar, { top });
  const reads = [], proposals = [];
  if (!found) return { closes: null, reason: 'unsegmented-red-timer', reads, roi: null, calls: 0 };
  const { roi, glyphs } = found;
  const singleCount = glyphs.length >= 2 && glyphs.length <= 3 ? glyphs.length - 1 : null;
  const candidates = layouts(glyphs);
  const images = new Map();
  let calls = 0;

  async function read(name, box, mode, psm, whitelist, parse) {
    const key = [box.left, box.top, box.width, box.height, mode].join(':');
    if (!images.has(key)) images.set(key, await redTimerImage(frame, box, mode));
    const text = await ocr(images.get(key), { psm, whitelist });
    calls++;
    const value = parse(text);
    const reading = { name, box, mode, psm, text, value };
    reads.push(reading);
    return reading;
  }

  // Every layout consumes all glyphs, and each block includes its unit. A
  // narrow OCR reading of "1м31с" cannot validate six glyphs from "31м31с".
  if (singleCount != null) {
    const votes = [];
    for (const mode of MODES) {
      votes.push(await read('single-duration', joinGlyphs(glyphs), mode, 7, '0123456789' + UNITS,
        text => parseSingle(text, singleCount)));
      const distinct = new Set(votes.filter(r => r.value != null).map(r => r.value));
      const value = corroborated(votes);
      if (distinct.size === 1 && value != null) return result(value, 'complete-single-block-fast-path');
    }
  }
  for (const { minutes, seconds } of candidates) {
    const votes = [];
    for (const mode of MODES) {
      const m = await read('minutes-with-unit', joinGlyphs(glyphs.slice(0, minutes + 1)), mode, 7,
        '0123456789мМmM', text => parseBlock(text, minutes, 'm'));
      const s = await read('seconds-with-unit', joinGlyphs(glyphs.slice(minutes + 1)), mode, 7,
        '0123456789сСcCsS', text => parseBlock(text, seconds, 's'));
      votes.push({ mode, value: m.value != null && s.value != null ? m.value * 60 + s.value : null });
      const distinct = new Set(votes.filter(r => r.value != null).map(r => r.value));
      const value = corroborated(votes);
      if (distinct.size === 1 && value != null) { proposals.push(value); break; }
    }
  }
  const fastValues = [...new Set(proposals)];
  if (fastValues.length === 1) return result(fastValues[0], 'complete-minute-second-blocks-fast-path');

  const memo = new Map();
  async function readPart(name, box, kind, count) {
    const key = [box.left, box.top, box.width, box.height, kind, count].join(':');
    if (memo.has(key)) return memo.get(key);
    const values = [];
    const parse = kind === 'number' ? text => parseNumber(text, count)
      : kind === 'single' ? text => parseSingle(text, count)
        : kind.startsWith('pair-') ? text => parseBlock(text, count, kind.slice(5)) : text => isUnit(text, kind);
    for (const mode of MODES) {
      const psms = kind === 'number' || kind === 'single' || kind.startsWith('pair-') ? [7, 8] : [8, 13];
      for (const psm of psms) values.push(await read(name, box, mode, psm,
        kind === 'single' ? '0123456789' + UNITS : kind === 'number' || kind.startsWith('pair-') ? '' : UNITS, parse));
      if (kind === 'number' && count === 1 && !values.some(r => r.mode === mode && r.value != null)) {
        for (const psm of [10, 13]) values.push(await read(name, box, mode, psm, '0123456789', parse));
      }
    }
    memo.set(key, values);
    return values;
  }
  if (singleCount != null) {
    const values = await readPart('single-duration', joinGlyphs(glyphs), 'single', singleCount);
    const value = corroborated(values);
    if (value != null) proposals.push(value);
  }
  for (const { minutes, seconds } of candidates) {
    const mi = minutes, si = glyphs.length - 1;
    const mUnit = await readPart('minute-unit', joinGlyphs([glyphs[mi]]), 'm');
    const sUnit = await readPart('second-unit', joinGlyphs([glyphs[si]]), 's');
    const mPair = await readPart('minutes-with-unit', joinGlyphs(glyphs.slice(0, mi + 1)), 'pair-m', minutes);
    const sPair = await readPart('seconds-with-unit', joinGlyphs(glyphs.slice(mi + 1)), 'pair-s', seconds);
    if (!mUnit.some(r => r.value) && !mPair.some(r => r.value != null)) continue;
    if (!sUnit.some(r => r.value) && !sPair.some(r => r.value != null)) continue;
    const mDigits = await readPart('minutes', joinGlyphs(glyphs.slice(0, mi)), 'number', minutes);
    const sDigits = await readPart('seconds', joinGlyphs(glyphs.slice(mi + 1, si)), 'number', seconds);
    const m = corroborated([...mDigits, ...mPair]), s = corroborated([...sDigits, ...sPair]);
    if (m != null && s != null) proposals.push(m * 60 + s);
  }
  const values = [...new Set(proposals)];
  return result(values.length === 1 ? values[0] : null,
    values.length === 1 ? 'complete-blocks-reread' : values.length > 1 ? 'conflicting-blocks' : 'unconfirmed-blocks');

  function result(closes, reason) { return { closes, reason, reads, roi, glyphs, calls }; }
}

module.exports = { recognizeRedTimer, parseBlock, parseSingle, corroborated };
