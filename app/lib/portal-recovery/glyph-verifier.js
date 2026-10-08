'use strict';
// Offline pixel-template experiment. No OCR worker, reference labels or IDs are
// used by recognize(). The caller supplies only pixels, bar geometry and a model.
const fs = require('node:fs');
const path = require('node:path');
const F = require('../frame');
const {findTimerText} = require('../timer-image');
const W = 16, H = 20;
const DEFAULT_MODEL = path.join(__dirname, '../../data-static/portal-timer-glyphs.json');
let cachedModel;

function extract(frame, bar, {threshold = 170, timerRegion = null} = {}) {
  if (!bar || !frame) return {reason: 'no-bar', glyphs: []};
  const roi = timerRegion || findTimerText(frame, bar, bar.by + bar.bh + 2);
  if (!roi) return {reason: 'no-duration-region', glyphs: []};
  const p = F.region(frame, roi.left, roi.top, roi.width, roi.height);
  if (!p) return {reason: 'empty-region', glyphs: [], roi};
  const mask = new Uint8Array(p.width * p.height);
  for (let i = 0; i < mask.length; i++) {
    const r = p.buf[i * 4], g = p.buf[i * 4 + 1], b = p.buf[i * 4 + 2];
    mask[i] = roi.kind === 'red'
      ? +(r > 100 && r - Math.max(g, b) >= threshold * .28 && r > g * 1.65 && r > b * 1.5)
      : +(Math.min(r, g, b) >= threshold && Math.max(r, g, b) - Math.min(r, g, b) < 65);
  }
  const raw = [];
  let start = -1;
  for (let x = 0; x <= p.width; x++) {
    let n = 0;
    if (x < p.width) for (let y = 0; y < p.height; y++) n += mask[y * p.width + x];
    if (n && start < 0) start = x;
    if (!n && start >= 0) {
      let y0 = p.height, y1 = -1, pixels = 0;
      for (let xx = start; xx < x; xx++) for (let y = 0; y < p.height; y++) if (mask[y * p.width + xx]) {
        y0 = Math.min(y0, y); y1 = Math.max(y1, y); pixels++;
      }
      raw.push({left: p.left + start, top: p.top + y0, width: x - start, height: y1 - y0 + 1, pixels, x: start, y: y0});
      start = -1;
    }
  }
  const scale = Math.max(.6, bar.bh / 11 || bar.scale || 1);
  const fragments = raw.filter(g => g.height < 3 * scale || g.pixels < 3 * scale * scale);
  const glyphs = raw.filter(g => !fragments.includes(g));
  if (glyphs.length < 2 || glyphs.length > 8) return {reason: 'invalid-symbol-count', glyphs, roi, fragments};
  if (glyphs.some(g => g.width > 15 * scale || g.height > 20 * scale)) return {reason: 'joined-or-foreign-symbol', glyphs, roi, fragments};
  const lineHeight = Math.max(...glyphs.map(g => g.height));
  for (const g of glyphs) {
    // Area sampling preserves antialiasing caused by the normalization itself.
    const vector = new Array(W * H).fill(0);
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      let sum = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const x = Math.min(g.width - 1, Math.floor((xx + (sx + .5) / 2) * g.width / W));
        const y = Math.min(g.height - 1, Math.floor((yy + (sy + .5) / 2) * g.height / H));
        sum += mask[(g.y + y) * p.width + g.x + x];
      }
      vector[yy * W + xx] = sum / 4;
    }
    g.vector = vector;
    g.aspect = g.width / g.height;
    g.relativeHeight = g.height / lineHeight;
  }
  return {reason: null, glyphs, roi, fragments, lineHeight, threshold};
}

function distance(a, b) {
  let d = 0;
  for (let i = 0; i < a.vector.length; i++) d += Math.abs(a.vector[i] - b.vector[i]);
  return d / a.vector.length + .09 * Math.abs(a.aspect - b.aspect) + .12 * Math.abs(a.relativeHeight - b.relativeHeight);
}

function classify(g, model, {excludeEpisode = null} = {}) {
  const scores = [];
  for (const [char, templates] of Object.entries(model.classes)) {
    let best = Infinity, source = null;
    for (const t of templates) {
      if (excludeEpisode && t.episode === excludeEpisode) continue;
      const d = distance(g, t);
      if (d < best) { best = d; source = t.source; }
    }
    if (Number.isFinite(best)) scores.push({char, score: best, source});
  }
  scores.sort((a, b) => a.score - b.score);
  const best = scores[0], second = scores[1];
  return {char: best?.char ?? null, score: best?.score ?? null, margin: best && second ? second.score - best.score : 0, candidates: scores.slice(0, 3)};
}

function parse(text) {
  let m;
  if ((m = text.match(/^(\d{1,2})ч(?:(\d{1,2})м)?$/u))) {
    const h = +m[1], minutes = +(m[2] || 0);
    return h <= 24 && minutes < 60 ? h * 3600 + minutes * 60 : null;
  }
  if ((m = text.match(/^(\d{1,2})м(?:(\d{1,2})с)?$/u))) {
    const minutes = +m[1], seconds = +(m[2] || 0);
    return minutes < 60 && seconds < 60 ? minutes * 60 + seconds : null;
  }
  if ((m = text.match(/^(\d{1,2})с$/u))) return +m[1] < 60 ? +m[1] : null;
  return null;
}

function loadModel(file = DEFAULT_MODEL) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

async function recognize(frame, bar, options = {}) {
  const model = options.model || (cachedModel ||= loadModel(options.modelPath));
  const variants = [];
  for (const threshold of model.thresholds) {
    const extraction = extract(frame, bar, {threshold, timerRegion: options.timerRegion});
    if (extraction.reason) { variants.push({threshold, reason: extraction.reason}); continue; }
    const scale = Math.max(.6, bar.bh / 11 || bar.scale || 1);
    const leftStrip = extract(frame, bar, {threshold, timerRegion: {...extraction.roi, left: extraction.roi.left - 20 * scale, width: 20 * scale}});
    const bottom = Math.max(...extraction.glyphs.map(g => g.top + g.height));
    const outside = leftStrip.glyphs.filter(g => g.height >= extraction.lineHeight * .84 && g.width <= 12 * scale && g.pixels >= 5 * scale * scale
      && Math.abs(g.top + g.height - bottom) <= 2 * scale && extraction.roi.left - g.left - g.width <= 8 * scale);
    if (outside.length) { variants.push({threshold, reason: 'tall-symbol-before-crop', outside: outside.map(({vector,...g})=>g)}); continue; }
    const chars = extraction.glyphs.map(g => classify(g, model, options));
    const text = chars.map(c => c.char || '?').join('');
    const seconds = parse(text);
    const safe = chars.every(c => c.score <= model.maxDistance && c.margin >= model.minMargin);
    variants.push({threshold, text, seconds, safe, chars, extraction});
  }
  const usable = variants.filter(v => v.safe && v.seconds !== null);
  const values = [...new Set(usable.map(v => v.seconds))];
  const conflicts = variants.some(v => v.safe && v.seconds !== null && v.seconds !== values[0]);
  const accepted = usable.length >= model.minAgree && values.length === 1 && !conflicts;
  const selected = usable[0] || variants.find(v => v.extraction);
  return {
    proposal: accepted ? values[0] : null,
    reason: accepted ? 'pixel-templates-agree' : values.length > 1 ? 'pixel-template-conflict' : usable.length ? 'insufficient-independent-mask-agreement' : 'uncertain-pixel-glyphs',
    glyphs: selected?.extraction?.glyphs.map(({vector, ...g}) => g) || [],
    diagnostics: {text: selected?.text || null, roi: selected?.extraction?.roi || null, variants: variants.map(({extraction, ...v}) => v)}
  };
}

module.exports = {recognize, extract, classify, distance, parse, loadModel, W, H};
