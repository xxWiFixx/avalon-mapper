'use strict';
// Offline prototype. Geometry and OCR observations are the only runtime inputs.
// This is a completeness check, not an independent digit recognizer.
const { findTimerText } = require('../timer-image');
const { parseBottom } = require('../portal-duration');
const candidate = require('./completeness-image');
const WL = '0123456789чмсЧМСhHmMsS ';

function strictToken(input) {
  const text = String(input || '').trim().replace(/\s+/g, '').toLowerCase()
    .replace(/h/g, 'ч').replace(/m/g, 'м').replace(/[cs]/g, 'с')
    .replace(/([чмс])\1+/g, '$1');
  const pair = text.match(/^(\d{1,2})(ч|м)(\d{1,2})(м|с)$/u);
  if (pair) {
    const first = Number(pair[1]), second = Number(pair[3]);
    const unit = pair[2] + pair[4];
    if (second >= 60 || !['чм', 'мс'].includes(unit)) return null;
    const sec = unit === 'чм' ? first * 3600 + second * 60 : first * 60 + second;
    if ((unit === 'чм' && sec > 86400) || (unit === 'мс' && first >= 60)) return null;
    return { text, sec, glyphCount: text.length, unit };
  }
  const single = text.match(/^(\d{1,2})(ч|м|с)$/u);
  if (!single) return null;
  const n = Number(single[1]), unit = single[2];
  if (unit === 'ч' ? n > 24 : n >= 60) return null;
  return { text, sec: n * (unit === 'ч' ? 3600 : unit === 'м' ? 60 : 1), glyphCount: text.length, unit };
}

function observedToken(read) {
  const parsed = parseBottom(read.text);
  return parsed.complete ? strictToken(parsed.raw) : null;
}

function project(frame, box, s, mode) {
  const data = candidate.signal(frame, box, 'light');
  if (!data) return [];
  const { width, height, v, local, chroma } = data;
  const mask = new Uint8Array(width * height), columns = new Uint8Array(width);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    mask[i] = v[i] > (mode === 'core' ? 100 : 60)
      && local[i] > (mode === 'core' ? 18 : 10) && chroma[i] < 45 ? 1 : 0;
    columns[x] += mask[i];
  }
  const parts = []; let start = null;
  for (let x = 0; x <= width; x++) {
    const ink = x < width && columns[x] >= Math.max(1, Math.round(s));
    if (ink && start === null) start = x;
    if (!ink && start !== null) {
      let y0 = height, y1 = -1, pixels = 0;
      for (let xx = start; xx < x; xx++) for (let y = 0; y < height; y++) {
        if (mask[y * width + xx]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); pixels++; }
      }
      parts.push({ left: data.left + start, top: data.top + y0, width: x - start,
        height: y1 - y0 + 1, pixels });
      start = null;
    }
  }
  return parts.filter(p => p.width >= 2 * s && p.height >= 5.5 * s && p.pixels >= 10 * s * s);
}

function layout(frame, bar, inputRegion) {
  if (!bar) return { stable: false, reason: 'no-bar' };
  const detectedRegion = findTimerText(frame, bar, bar.by + bar.bh + 2);
  // Production sometimes stores its final expanded retry rectangle here. The
  // pixel detector supplies a tighter starting line before independent padding.
  const region = detectedRegion?.kind === 'light' ? detectedRegion : inputRegion || detectedRegion;
  if (!region || region.kind !== 'light') return { stable: false, reason: 'no-white-timer-region', region };
  // Region height estimates the physical font size. A thick bar can overstate
  // that size, so bh/11 is not used to move the left boundary of this crop.
  const s = Math.max(.5, bar.scale || 1, region.height / 11);
  const searchLeft = Math.round(Math.min(region.left - 14 * s, bar.bx + 194 * s));
  const box = { kind: 'light', scale: s, left: searchLeft,
    top: Math.round(region.top), width: Math.round(region.left + region.width - searchLeft),
    height: Math.round(region.height) };
  const passes = ['core', 'soft'].map(mode => {
    const parts = project(frame, box, s, mode);
    const inside = parts.filter(p => p.left + p.width > region.left + s
      && p.left < region.left + region.width - s);
    if (!inside.length) return { mode, parts, glyphs: [], valid: false };
    const bottoms = inside.map(p => p.top + p.height).sort((a, b) => a - b);
    const bottom = bottoms[Math.floor(bottoms.length / 2)];
    const aligned = parts.filter(p => Math.abs(p.top + p.height - bottom) <= 2 * s);
    let glyphs = inside.filter(p => Math.abs(p.top + p.height - bottom) <= 2 * s);
    // Inspect the whole timer edge, including a missing first unit block. Bold
    // number glyphs are taller than the closing label. Their shorter unit
    // glyphs are then retained between the first number and the right edge.
    const prefix = aligned.filter(p => p.left >= bar.bx + 196 * s && p.left < glyphs[0]?.left
      && p.height >= 8.5 * s && p.height <= 13 * s && p.width <= 12 * s);
    if (prefix.length) glyphs = aligned.filter(p => p.left >= prefix[0].left
      && p.left < region.left + region.width - s);
    glyphs = glyphs.sort((a, b) => a.left - b.left);
    const valid = glyphs.length >= 2 && glyphs.length <= 6
      && glyphs.every(p => p.width <= 12 * s && p.height <= 14 * s)
      && glyphs.every((p, i) => i === 0 || p.left - glyphs[i - 1].left - glyphs[i - 1].width <= 8 * s);
    return { mode, parts, glyphs, valid };
  });
  const [a, b] = passes;
  const stable = a.valid && b.valid && a.glyphs.length === b.glyphs.length
    && a.glyphs.every((p, i) => Math.abs(p.left - b.glyphs[i].left) <= 2 * s
      && Math.abs(p.width - b.glyphs[i].width) <= 2 * s);
  const glyphs = stable ? b.glyphs : [];
  const fullBox = stable ? { kind: 'light', scale: s, left: glyphs[0].left - Math.ceil(2 * s),
    top: Math.min(...glyphs.map(p => p.top)) - Math.ceil(2 * s),
    width: glyphs.at(-1).left + glyphs.at(-1).width - glyphs[0].left + Math.ceil(4 * s),
    height: Math.max(...glyphs.map(p => p.top + p.height)) - Math.min(...glyphs.map(p => p.top)) + Math.ceil(4 * s) } : null;
  return { stable, reason: stable ? 'stable-glyph-layout' : 'ambiguous-glyph-layout',
    scale: s, region, searchBox: box, fullBox, glyphs, passes,
    addedLeadingGlyph: stable && glyphs[0].left + glyphs[0].width <= region.left + s };
}

async function verify(frame, bar, { ocr, baseline = null, timerRegion = null, reads = [] } = {}) {
  const observations = Array.isArray(reads) ? reads : [];
  const baselineValue = typeof baseline === 'number' ? baseline : baseline?.closes ?? null;
  const scan = layout(frame, bar, timerRegion);
  const diagnostics = { ...scan, baseline: baselineValue };
  const finish = (proposal, decision, reason, additional = []) => ({ proposal, decision, reason, reads: additional, diagnostics });
  if (!scan.stable) return finish(null, 'unknown', scan.reason);
  const count = scan.glyphs.length;
  const tokens = observations.map(observedToken).filter(Boolean);
  diagnostics.observedTokens = tokens;
  diagnostics.glyphCount = count;
  const consistent = tokens.filter(t => t.sec === baselineValue);
  const covered = consistent.filter(t => t.glyphCount === count);
  const contradictory = tokens.filter(t => t.glyphCount === count && t.sec !== baselineValue);
  // Fast acceptance only certifies that the existing explicit token accounts
  // for every glyph. Digit identity is checked by the separate recognizer.
  if (baselineValue !== null && covered.length && !contradictory.length) {
    return finish(baselineValue, 'accept', 'baseline-accounts-for-all-glyphs');
  }
  const added = [], votes = new Map();
  if (typeof ocr !== 'function') return finish(null, 'unknown', 'complete-ocr-unavailable');
  for (const mode of ['gray', 'local', 'soft']) {
    const text = await ocr(await candidate.image(frame, scan.fullBox, mode), { psm: 7, whitelist: WL });
    const token = strictToken(text);
    const complete = token && token.glyphCount === count;
    added.push({ family: 'completeness', mode, text, token, allGlyphsCovered: !!complete });
    if (complete) { const modes = votes.get(token.sec) || new Set(); modes.add(mode); votes.set(token.sec, modes); }
  }
  const values = [...votes].filter(([, modes]) => modes.size >= 2).map(([sec]) => sec);
  diagnostics.completeValues = [...votes].map(([sec, modes]) => ({ sec, modes: [...modes] }));
  if (votes.size === 1 && values.length === 1) {
    const proposed = values[0];
    // A newly recovered value additionally needs closing-label context. An
    // existing baseline match already passed the application's context gate.
    const contextKnown = observations.some(r => /з[аоa]кро|closes|close\b/iu.test(r.text || ''));
    let context = contextKnown;
    if (baselineValue !== proposed && !context) {
      const box = { ...scan.fullBox, left: scan.fullBox.left - Math.round(180 * scan.scale),
        width: scan.fullBox.width + Math.round(180 * scan.scale) };
      const text = await ocr(await candidate.image(frame, box, 'gray'), { psm: 7 });
      added.push({ family: 'completeness-context', mode: 'gray', text });
      context = /з[аоa]кро|closes|close\b/iu.test(text);
    }
    if (baselineValue === proposed || context) return finish(proposed, 'accept',
      baselineValue === proposed ? 'full-crop-confirms-baseline' : 'full-crop-complete-rescue', added);
    return finish(null, 'unknown', 'closing-label-not-confirmed', added);
  }
  if (baselineValue !== null && consistent.length && consistent.every(t => t.glyphCount < count)) {
    // A prefix found outside the detector's crop can belong to a taller part
    // of the closing label. If complete duration OCR cannot assign that prefix,
    // do not claim its identity or reject an otherwise supported single unit.
    if (scan.addedLeadingGlyph) return finish(null, 'unknown', 'unassigned-left-prefix', added);
    return finish(null, 'reject', 'baseline-leaves-visible-glyphs-unread', added);
  }
  if (votes.size > 1) return finish(null, 'reject', 'conflicting-complete-crop-readings', added);
  return finish(null, 'unknown', 'full-crop-not-confirmed', added);
}

module.exports = { verify, layout, strictToken };
