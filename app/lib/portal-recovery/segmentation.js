'use strict';
// Offline structural alternative. All digit templates and classification gates
// remain frozen. Different masks are correlated views of the same screenshot.
const F = require('../frame');
const { findTimerText } = require('../timer-image');
const G = require('./glyph-verifier');
const { signal } = require('./completeness-image');
let cachedPath, cachedModel;

function rawRuns(mask, width, height) {
  const result = []; let start = -1;
  for (let x = 0; x <= width; x++) {
    let ink = 0;
    if (x < width) for (let y = 0; y < height; y++) ink += mask[y * width + x];
    if (ink && start < 0) start = x;
    if (!ink && start >= 0) { result.push([start, x]); start = -1; }
  }
  return result;
}

function bounds(mask, width, height, left, right) {
  let x0 = width, x1 = -1, y0 = height, y1 = -1, pixels = 0;
  for (let x = Math.max(0, left); x < Math.min(width, right); x++) for (let y = 0; y < height; y++) {
    if (mask[y * width + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); pixels++; }
  }
  return pixels ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels } : null;
}

function vector(mask, width, glyph, lineHeight) {
  const out = new Array(G.W * G.H).fill(0);
  for (let yy = 0; yy < G.H; yy++) for (let xx = 0; xx < G.W; xx++) {
    let sum = 0;
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const x = Math.min(glyph.width - 1, Math.floor((xx + (sx + .5) / 2) * glyph.width / G.W));
      const y = Math.min(glyph.height - 1, Math.floor((yy + (sy + .5) / 2) * glyph.height / G.H));
      sum += mask[(glyph.y + y) * width + glyph.x + x];
    }
    out[yy * G.W + xx] = sum / 4;
  }
  return { vector: out, aspect: glyph.width / glyph.height, relativeHeight: glyph.height / lineHeight };
}

function parse(text) {
  const seconds = G.parse(text);
  return seconds !== null && seconds <= 86400 ? seconds : null;
}

function regions(frame, bar, supplied) {
  const detected = findTimerText(frame, bar, bar.by + bar.bh + 2);
  const hints = [detected, supplied].filter(r => r?.kind === 'light');
  if (detected?.kind === 'red' || supplied?.kind === 'red') return [];
  const physical = Math.max(.6, Math.min(bar.scale || 1, bar.bh / 11 || 1));
  // A slightly stale UI hint must not shrink a real eleven-pixel text row.
  const s = hints.length ? Math.max(physical, Math.min(...hints.map(r => r.height / 11))) : Math.max(.6, bar.bh / 11);
  const list = hints.map(r => {
    const left = Math.round(Math.min(r.left - 22 * s, bar.bx + 194 * s));
    return { kind: 'light', left, top: r.top, width: Math.round(r.left + r.width - left), height: r.height, scale: s, source: 'hint-row' };
  });
  const fallbackScale = bar.span >= 220 * s && bar.span <= 290 * s ? bar.span / 259 : s;
  list.push({ kind: 'light', left: Math.round(bar.bx + 194 * fallbackScale), top: Math.round(bar.by + bar.bh + 9 * fallbackScale),
    width: Math.round(80 * fallbackScale), height: Math.round(16 * fallbackScale), scale: fallbackScale, source: 'bar-row' });
  return list.filter((r, i) => r.width <= 135 * r.scale && list.findIndex(x => x.left === r.left && x.top === r.top
    && x.width === r.width && x.height === r.height) === i);
}

function masks(frame, roi) {
  const data = signal(frame, roi); if (!data) return null;
  const { width, height, v, chroma, local } = data;
  const variants = [];
  for (const threshold of [110, 130, 150]) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = v[i] >= threshold && chroma[i] < 65 ? 1 : 0;
    variants.push({ key: 'absolute-' + threshold, mask, runs: rawRuns(mask, width, height) });
  }
  // Background subtraction handles a faint duration over a uniformly bright
  // map. The contrast levels are fixed before evaluation; no expected value is
  // used to choose a mask, split, or glyph.
  for (const contrast of [18, 30]) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = local[i] >= contrast && chroma[i] < 45 && v[i] > 60 ? 1 : 0;
    variants.push({ key: 'contrast-' + contrast, mask, runs: rawRuns(mask, width, height) });
  }
  return { ...data, variants };
}

function segmentation(data, ink, guide, roi, model, excludeEpisode, classificationCache = new Map()) {
  const { width, height } = data, s = roi.scale;
  const parts = [];
  for (const [left, right] of guide.runs) {
    const b = bounds(ink.mask, width, height, left, right);
    if (!b || b.pixels < 3 * s * s || b.height < 3 * s) continue;
    parts.push(b);
  }
  if (parts.length < 2 || parts.length > 22) return { reason: 'invalid-projection-count' };
  // Resolve the text baseline from realistic tall glyphs, then discard only
  // vertically separated pixels. Internal fragments stay present for merging.
  const tall = parts.filter(p => p.height >= 7.5 * s && p.height <= 13 * s && p.width <= 13 * s);
  if (!tall.length) return { reason: 'no-font-height-anchor' };
  const bottoms = tall.map(p => p.y + p.height).sort((a, b) => a - b);
  const bottom = bottoms[Math.floor(bottoms.length / 2)];
  const line = parts.filter(p => Math.abs(p.y + p.height - bottom) <= 2 * s);
  if (line.length < 2) return { reason: 'no-aligned-line' };
  const lineHeight = Math.max(...line.filter(p => p.height <= 14 * s).map(p => p.height));
  const classified = line.map(p => {
    const cacheKey = `${ink.key}:${p.x},${p.y},${p.width},${p.height}:${lineHeight}`;
    let value = classificationCache.get(cacheKey);
    if (!value) {
      value = p.width <= 15 * s && p.height <= 14 * s
        ? G.classify(vector(ink.mask, width, p, lineHeight), model, { excludeEpisode })
        : { char: null, score: null, margin: 0 };
      classificationCache.set(cacheKey, value);
    }
    return { ...p, left: data.left + p.x, top: data.top + p.y, ...value,
      safe: value.score !== null && value.score <= model.maxDistance && value.margin >= model.minMargin };
  });
  const starts = classified.map((p, i) => p.safe && /\d/.test(p.char) && p.height >= 7.5 * s ? i : -1).filter(i => i >= 0);
  const accepted = [];
  for (const start of starts) {
    const preceding = classified.slice(0, start);
    // Taller unassigned marks immediately before a proposed digit invalidate a
    // suffix. Smaller label letters can remain to the left of the bold timer.
    if (preceding.some(p => p.height >= 8 * s || p.safe && /[0-9чмс]/u.test(p.char))) continue;
    const glyphs = classified.slice(start);
    if (glyphs.length < 2 || glyphs.length > 6 || !glyphs.every(p => p.safe)) continue;
    if (glyphs[0].x === 0 || glyphs.at(-1).x + glyphs.at(-1).width >= width) continue;
    if (glyphs.some((p, i) => i && p.x - glyphs[i - 1].x - glyphs[i - 1].width > 8 * s)) continue;
    const text = glyphs.map(p => p.char).join(''), seconds = parse(text);
    if (seconds === null) continue;
    // Units must occur in the explicit complete grammar. Every retained symbol
    // belongs to that grammar; no best suffix or inferred unit is accepted.
    accepted.push({ text, seconds, glyphs, roi: { kind: 'light', left: glyphs[0].left,
      top: Math.min(...glyphs.map(p => p.top)), width: glyphs.at(-1).left + glyphs.at(-1).width - glyphs[0].left,
      height: Math.max(...glyphs.map(p => p.top + p.height)) - Math.min(...glyphs.map(p => p.top)) },
      mask: ink.key, guide: guide.key });
  }
  return { reason: accepted.length ? 'candidate-found' : 'no-complete-safe-line', candidates: accepted,
    glyphs: classified.map(({ vector, ...p }) => p) };
}

function compatible(a, b, s) {
  return a.text === b.text && a.glyphs.length === b.glyphs.length && a.glyphs.every((p, i) => {
    const q = b.glyphs[i];
    return Math.abs(p.left - q.left) <= 2 * s && Math.abs(p.width - q.width) <= 2 * s
      && Math.abs(p.top - q.top) <= 2 * s && Math.abs(p.height - q.height) <= 2 * s;
  });
}

async function analyze(frame, bar, { timerRegion = null, excludeEpisode = null, modelPath, baseline, previousMethods } = {}) {
  if (!bar) return { proposal: null, decision: 'unknown', reason: 'no-confirmed-bar', candidate: null, diagnostics: {} };
  if (!cachedModel || cachedPath !== modelPath) { cachedModel = G.loadModel(modelPath); cachedPath = modelPath; }
  const model = cachedModel, rois = regions(frame, bar, timerRegion), attempts = [], proposals = [];
  for (let ri = 0; ri < rois.length; ri++) {
    const roi = rois[ri], data = masks(frame, roi); if (!data) continue;
    // A guide can repeat the same bounds on the same ink mask. The model and
    // excluded episode are fixed for this ROI, so its classification is reused.
    const classificationCache = new Map();
    for (const ink of data.variants) for (const guide of data.variants) {
      const result = segmentation(data, ink, guide, roi, model, excludeEpisode, classificationCache);
      attempts.push({ roi: ri, mask: ink.key, guide: guide.key, ...result });
      for (const value of result.candidates || []) proposals.push({ ...value, roiIndex: ri, scale: roi.scale });
    }
  }
  const confirmed = proposals.filter(p => proposals.some(q => p.mask !== q.mask && compatible(p, q, Math.max(p.scale, q.scale))));
  const texts = [...new Set(confirmed.map(p => p.text))];
  const conflicting = proposals.some(p => confirmed.length && p.seconds !== confirmed[0].seconds);
  const selected = texts.length === 1 && !conflicting ? confirmed[0] : null;
  return { proposal: selected?.seconds ?? null, decision: selected ? 'accept' : 'unknown',
    reason: selected ? 'compatible-complete-pixel-segmentations' : conflicting || texts.length > 1 ? 'segmentation-value-conflict' : 'complete-segmentation-unconfirmed',
    candidate: selected, diagnostics: { rois, attempts, candidateCount: proposals.length, confirmedCount: confirmed.length,
      note: 'Masks are correlated; this is one pixel-template method, not two independent recognizers.' } };
}

module.exports = { analyze, regions, masks, segmentation, compatible };
