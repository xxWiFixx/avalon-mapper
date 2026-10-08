'use strict';
const F=require('../frame'),sharp=require('sharp');
const {createNameMatcher}=require('../recognition-confidence');
const {findTimerText}=require('../timer-image');
const {capacityImage,exactCapacity}=require('../capacity-image');
const {findFillGapBarCands:fillGapBar}=require('./fill-gap-bar');
function createCardRecovery(helpers){
const R={...helpers,_internal:{findBarCands:helpers.findBarCands,crop:helpers.crop}};
const matcher=createNameMatcher(R.DICT);
function refineFilledBar(frame, hint, physicalScale) {
  const s = physicalScale, r = F.region(frame, hint.bx - 80 * s, hint.by - 8 * s, 320 * s, hint.bh + 18 * s);
  if (!r) return null;
  const gold = (x, y) => { const i = (y * r.width + x) * 4, red = r.buf[i], green = r.buf[i + 1], blue = r.buf[i + 2];
    return red >= 170 && green >= 105 && green <= 200 && blue <= 100 && red - green >= 25 && green - blue >= 70; };
  const rows = [];
  for (let y = 0; y < r.height; y++) {
    let start = -1, last = -1, count = 0;
    const emit = () => {
      const width = last - start + 1;
      if (start >= 0 && width >= 165 * s && width <= 210 * s && count / width >= .76)
        rows.push({ y: r.top + y, x0: r.left + start, x1: r.left + last, count });
    };
    for (let x = 0; x < r.width; x++) {
      if (!gold(x, y)) continue;
      if (start < 0 || x - last > 14 * s) { if (start >= 0) emit(); start = x; count = 0; }
      last = x; count++;
    }
    emit();
  }
  const groups = [];
  for (const row of rows) {
    const group = groups.find(g => row.y - g.at(-1).y === 1 && Math.abs(row.x0 - g[0].x0) <= 3 * s
      && Math.abs(row.x1 - g[0].x1) <= 5 * s);
    if (group) group.push(row); else groups.push([row]);
  }
  const valid = groups.filter(g => g.length >= 6 * s && g.length <= 15 * s)
    .sort((a, b) => b.length - a.length || Math.abs(a[0].y - hint.by) - Math.abs(b[0].y - hint.by));
  const group = valid[0]; if (!group) return null;
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const bx = median(group.map(r => r.x0)), right = median(group.map(r => r.x1)), by = group[0].y;
  return { bx, by, bh: group.at(-1).y - by + 1, fill: right - bx + 1, span: right - bx + 1, scale: s,
    source: 'continuous-filled-rectangle', evidence: { seed: hint, rowCount: group.length, rows: group } };
}

function findCandidates(frame, screenHeight) {
  const initial = (screenHeight || frame.height) / 1080;
  const scales = [...new Set([initial, 1, initial * .9, initial * 1.1])].filter(s => s >= .45 && s <= 4);
  const candidates = [];
  for (const scale of scales) for (const [source, fn] of [['original', R._internal.findBarCands], ['fill-gap', fillGapBar]]) {
    for (const bar of fn(frame, scale).slice(0, 6)) {
      if (candidates.some(x => Math.abs(x.bx - bar.bx) <= 5 && Math.abs(x.by - bar.by) <= 3
        && Math.abs(x.scale - scale) < .03)) continue;
      candidates.push({ ...bar, scale, source });
    }
  }
  return candidates;
}

async function whiteTitle(frame, box, threshold) {
  const r = F.region(frame, box.left, box.top, box.width, box.height); if (!r) return null;
  const pixels = Buffer.alloc(r.width * r.height);
  for (let i = 0; i < pixels.length; i++) {
    const red = r.buf[i * 4], green = r.buf[i * 4 + 1], blue = r.buf[i * 4 + 2];
    const low = Math.min(red, green, blue), chroma = Math.max(red, green, blue) - low;
    pixels[i] = low >= threshold && chroma < 55 ? 0 : 255;
  }
  return sharp(pixels, { raw: { width: r.width, height: r.height, channels: 1 } }).resize(r.width * 5, r.height * 5)
    .extend({ left: 14, right: 14, top: 14, bottom: 14, background: '#fff' }).png().toBuffer();
}

async function nameVariants(frame, bar, ocr) {
  const s = bar.scale, { bx, by } = bar;
  const boxes = [
    { left: bx - 15 * s, top: by - 28 * s, width: 310 * s, height: 24 * s, source: 'original' },
    { left: bx + 24 * s, top: by - 26 * s, width: 235 * s, height: 22 * s, source: 'inner-title' },
    { left: bx + 45 * s, top: by - 26 * s, width: 190 * s, height: 22 * s, source: 'center-title' },
  ];
  const reads = [];
  for (const box of boxes) for (const prep of [{ scale: 4 }, { scale: 4, thresh: 150 }, { scale: 4, invert: false }]) {
    const image = await R._internal.crop(frame, box.left, box.top, box.width, box.height, prep);
    const text = image ? await ocr(image, { psm: 7, whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- ' }) : '';
    reads.push({ box, prep, text, ranked: matcher.rank(text) });
  }
  for (const box of boxes.slice(1)) for (const threshold of [155, 180, 205]) {
    const image = await whiteTitle(frame, box, threshold);
    const text = image ? await ocr(image, { psm: 7, whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- ' }) : '';
    reads.push({ box, prep: { family: 'neutral-white', threshold }, text, ranked: matcher.rank(text) });
  }
  return reads;
}

function confirmedName(reads) {
  const clear = reads.filter(r => r.ranked.match && r.ranked.match.score <= .2 && r.ranked.gap >= .04);
  const names = [...new Set(clear.map(r => r.ranked.match.name))];
  if (names.length > 1) return { name: null, reason: 'conflicting-clear-names', names };
  if (names.length !== 1) return { name: null, reason: 'name-not-clearly-readable' };
  const name = names[0], exact = clear.filter(r => r.ranked.exact);
  // A missing middle syllable can make a long name look exactly like its short
  // dictionary twin. This fallback has no independent name-glyph model.
  if (R.NAME_TWINS.has(name)) return { name: null, reason: 'short-twin-needs-independent-glyph-evidence', names: [name] };
  const treatments = new Set(clear.map(r => JSON.stringify(r.prep)));
  if (!exact.length || treatments.size < 2) return { name: null, reason: 'name-needs-exact-and-second-treatment' };
  const resolved = R.resolveTwin(name, reads.map(r => r.text));
  if (resolved !== name) return { name: null, reason: 'long-short-name-conflict', names: [name, resolved] };
  return { name, reason: 'exact-name-with-consistent-other-treatment', clearCount: clear.length,
    exactCount: exact.length, treatments: [...treatments] };
}

async function nameCompleteness(frame, bar, name, reads, ocr) {
  const s = bar.scale, expected = { left: bar.bx + 52 * s, top: bar.by - 30 * s, width: 220 * s, height: 28 * s };
  const r = F.region(frame, expected.left, expected.top, expected.width, expected.height);
  if (!r || r.width < expected.width - 1 || r.height < expected.height - 1)
    return { confirmed: false, reason: 'title-search-clipped-by-frame', variants: [] };
  const variants = [];
  for (const threshold of [155, 180, 205]) {
    const points = [], columns = new Array(r.width).fill(0);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 4, low = Math.min(r.buf[i], r.buf[i + 1], r.buf[i + 2]);
      if (low < threshold || Math.max(r.buf[i], r.buf[i + 1], r.buf[i + 2]) - low >= 55) continue;
      points.push({ x, y }); columns[x]++;
    }
    const runs = []; let start = -1;
    for (let x = 0; x <= r.width; x++) {
      if (columns[x] && start < 0) start = x;
      if (!columns[x] && start >= 0) { runs.push({ start, end: x }); start = -1; }
    }
    const groups = [];
    for (const run of runs) {
      const last = groups.at(-1);
      if (last && run.start - last.end <= 8 * s) last.end = run.end;
      else groups.push({ ...run });
    }
    for (const group of groups) {
      const ink = points.filter(p => p.x >= group.start && p.x < group.end);
      group.ink = ink.length;
      group.top = Math.min(...ink.map(p => p.y)); group.bottom = Math.max(...ink.map(p => p.y)) + 1;
    }
    const substantial = groups.filter(g => g.ink >= 8 * s * s && g.bottom - g.top >= 5 * s);
    const selected = substantial.length === 1 ? substantial[0] : null;
    const bounds = selected && { left: r.left + selected.start, top: r.top + selected.top,
      width: selected.end - selected.start, height: selected.bottom - selected.top };
    const anchored = !!bounds && bounds.left >= bar.bx + 58 * s && bounds.left <= bar.bx + 76 * s
      && bounds.top >= bar.by - 26 * s && bounds.top <= bar.by - 18 * s
      && bounds.width >= 40 * s && bounds.height >= 8 * s && bounds.height <= 20 * s;
    const freeEdges = !!selected && selected.start >= 3 * s && selected.end <= r.width - 3 * s
      && selected.top >= 3 * s && selected.bottom <= r.height - 3 * s;
    const coveringExact = bounds && reads.some(v => v.ranked.exact && v.ranked.match?.name === name
      && v.box.left <= bounds.left - 2 * s && v.box.top <= bounds.top - 2 * s
      && v.box.left + v.box.width >= bounds.left + bounds.width + 2 * s
      && v.box.top + v.box.height >= bounds.top + bounds.height + 2 * s);
    variants.push({ threshold, groups, bounds, anchored, freeEdges, coveringExact, eligible: anchored && freeEdges && !!coveringExact });
  }
  const consistent = variants.filter(a => a.eligible && variants.some(b => a !== b && b.eligible
    && ['left', 'top', 'width', 'height'].every(k => Math.abs(a.bounds[k] - b.bounds[k]) <= 2 * s)));
  const diagnostics = { searchBox: { left: r.left, top: r.top, width: r.width, height: r.height }, variants, reads: [] };
  if (consistent.length < 2) return { confirmed: false, reason: 'title-boundaries-not-stable', ...diagnostics };
  // Re-read the measured complete foreground, including empty margins. The two
  // masks are processing checks on one observation, not independent samples.
  for (const v of consistent) {
    const box = { left: v.bounds.left - 3 * s, top: v.bounds.top - 3 * s,
      width: v.bounds.width + 6 * s, height: v.bounds.height + 6 * s };
    const text = await ocr(await whiteTitle(frame, box, v.threshold),
      { psm: 7, whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- ' });
    const ranked = matcher.rank(text); diagnostics.reads.push({ text, box, threshold: v.threshold, ranked });
  }
  const clear = diagnostics.reads.filter(v => v.ranked.match && v.ranked.match.score <= .2 && v.ranked.gap >= .04);
  if (clear.some(v => v.ranked.match.name !== name)) return { confirmed: false, reason: 'measured-title-conflict', ...diagnostics };
  return { confirmed: clear.some(v => v.ranked.exact), reason: clear.some(v => v.ranked.exact)
    ? 'anchored-complete-title-and-exact-measured-read' : 'measured-title-needs-exact-read', ...diagnostics };
}

async function blueCaption(frame, box, local) {
  const r = F.region(frame, box.left, box.top, box.width, box.height); if (!r) return null;
  const pixels = Buffer.alloc(r.width * r.height);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const i = y * r.width + x;
    if (!local) { pixels[i] = 255 - r.buf[i * 4 + 2]; continue; }
    const neighbors = [];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < r.width && yy >= 0 && yy < r.height) neighbors.push(r.buf[(yy * r.width + xx) * 4 + 2]);
    }
    neighbors.sort((a,b) => a-b);
    pixels[i] = 255 - Math.min(255, Math.max(0, r.buf[i * 4 + 2] - neighbors[Math.floor(neighbors.length * .3)]) * 6);
  }
  return sharp(pixels, { raw: { width: r.width, height: r.height, channels: 1 } }).normalise()
    .resize(r.width * 6, r.height * 6).extend({ left: 16, right: 16, top: 16, bottom: 16, background: '#fff' })
    .withMetadata({ density: 300 }).png().toBuffer();
}

function captionMatch(text) {
  // The service phrase is not a portal identity. Still require both words and
  // most of their letters; a lone "path", portal name or generic UI label fails.
  const clean = String(text || '').toLowerCase().replace(/[^а-я]/gu, '');
  const distance = (a,b) => { let row = Array.from({length:b.length+1},(_,i)=>i);
    for (let i=1;i<=a.length;i++) { const next=[i]; for(let j=1;j<=b.length;j++)
      next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1)); row=next; } return row[b.length]; };
  const lcs = (a,b) => { let row = new Array(b.length+1).fill(0);
    for(const char of a){const next=[0];for(let j=1;j<=b.length;j++)next[j]=char===b[j-1]?row[j-1]+1:Math.max(row[j],next[j-1]);row=next;}return row[b.length];};
  const attempts=[];
  for (const phrase of [clean, clean.endsWith('в') ? clean.slice(0,-1) : clean]) {
    if (phrase.length < 9 || phrase.length > 13) continue;
    for(let split=3;split<=5;split++) {
      const first=phrase.slice(0,split),second=phrase.slice(split);
      const firstEdits=distance(first,'путь'),secondEdits=distance(second,'авалона');
      const firstLetters=lcs(first,'путь'),secondLetters=lcs(second,'авалона');
      attempts.push({phrase,first,second,firstEdits,secondEdits,firstLetters,secondLetters,
        pass: firstEdits<=1 && secondEdits<=2 && firstLetters>=3 && secondLetters>=5 && firstEdits+secondEdits<=3});
    }
  }
  return { matched: attempts.some(a=>a.pass), clean, attempts };
}

function capacitySlash(frame, bar) {
  const s = bar.scale, r = F.region(frame, bar.bx + 84 * s, bar.by - s, 31 * s, bar.bh + 5 * s);
  if (!r) return { confirmed: false, components: [] };
  const light = new Float32Array(r.width * r.height), peaks = new Float32Array(r.width);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const i = (y * r.width + x) * 4, value = .299 * r.buf[i] + .587 * r.buf[i + 1] + .114 * r.buf[i + 2];
    light[y * r.width + x] = value; peaks[x] = Math.max(peaks[x], value);
  }
  const mask = new Uint8Array(light.length);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    let background = 1;
    for (let xx = Math.max(0, x - 6); xx <= Math.min(r.width - 1, x + 6); xx++) background = Math.max(background, peaks[xx]);
    const i = (y * r.width + x) * 4, red = r.buf[i], green = r.buf[i + 1], blue = r.buf[i + 2];
    mask[y * r.width + x] = red - green >= 15 && green - blue >= 20 && light[y * r.width + x] < background * .82 ? 1 : 0;
  }
  const visited = new Uint8Array(mask.length), components = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || visited[p]) continue;
    const queue = [p], points = []; visited[p] = 1;
    for (let at = 0; at < queue.length; at++) {
      const i = queue[at], x = i % r.width, y = Math.floor(i / r.width); points.push({ x, y });
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, j = yy * r.width + xx;
        if (xx >= 0 && xx < r.width && yy >= 0 && yy < r.height && mask[j] && !visited[j]) { visited[j] = 1; queue.push(j); }
      }
    }
    const x0 = Math.min(...points.map(p => p.x)), x1 = Math.max(...points.map(p => p.x));
    const y0 = Math.min(...points.map(p => p.y)), y1 = Math.max(...points.map(p => p.y)), h = y1 - y0 + 1;
    const top = points.filter(p => p.y <= y0 + h * .25), bottom = points.filter(p => p.y >= y1 - h * .25);
    const mean = a => a.reduce((sum, p) => sum + p.x, 0) / a.length;
    components.push({ left: r.left + x0, top: r.top + y0, width: x1 - x0 + 1, height: h,
      pixels: points.length, slant: mean(top) - mean(bottom), localLeft: x0 });
  }
  const slash = components.filter(c => c.localLeft >= 7 * s && c.localLeft <= 18 * s
    && c.height >= bar.bh && c.width <= 6 * s && c.slant >= s
    && components.some(d => d.left + d.width < c.left && d.height >= 7 * s && d.width >= 3 * s)
    && components.some(d => d.left > c.left + c.width && d.height >= 7 * s && d.width >= 3 * s));
  return { confirmed: slash.length === 1, slash: slash[0] || null, components, roi: { left: r.left, top: r.top, width: r.width, height: r.height } };
}

async function cardContext(frame, bar, ocr) {
  const capReads = [], slash = capacitySlash(frame, bar);
  for (const threshold of [155, 180]) for (const scale of [4, 5]) {
    const image = await capacityImage(frame, bar, { threshold, scale });
    const text = image ? await ocr(image, { psm: 7, whitelist: '0123456789/' }) : '';
    capReads.push({ text, threshold, scale, parsed: exactCapacity(text, bar) });
  }
  for (const prep of [{ scale: 5, invert: false }, { scale: 5 }, { scale: 5, thresh: 100 }, { scale: 5, thresh: 140 }]) {
    const s = bar.scale;
    const image = await R._internal.crop(frame, bar.bx + 66 * s, bar.by - 3 * s, 62 * s, bar.bh + 6 * s, prep);
    const text = image ? await ocr(image, { psm: 7, whitelist: '0123456789/' }) : '';
    capReads.push({ text, prep, source: 'full-fraction', parsed: exactCapacity(text, bar) });
  }
  for (const prep of [{ scale: 6, invert: false }, { scale: 6 }]) {
    const s = bar.scale;
    const image = await R._internal.crop(frame, bar.bx + 84 * s, bar.by, 31 * s, bar.bh, prep);
    const padded = image && await sharp(image).extend({ left: 20, right: 20, top: 20, bottom: 20,
      background: prep.invert === false ? '#fff' : '#000' }).withMetadata({ density: 300 }).png().toBuffer();
    const text = padded ? await ocr(padded, { psm: 7, whitelist: '0123456789/' }) : '';
    const pixelRepair = slash.confirmed && /^(717|77)$/.test(text) ? '7/7' : null;
    capReads.push({ text, prep, source: 'tight-fraction', pixelRepair,
      parsed: exactCapacity(pixelRepair || text, bar) });
  }
  const fractions = capReads.filter(r => r.parsed).map(r => `${r.parsed.num}/${r.parsed.max}`);
  const unique = [...new Set(fractions)];
  const exact = unique.length === 1 && fractions.length >= 2 ? capReads.find(r => r.parsed)?.parsed : null;
  // The fallback geometry deliberately recovers a continuous filled bar. A
  // contradictory or non-full capacity reading cannot justify those bounds.
  const s = bar.scale, contextReads = [];
  const capacityAgrees = !!exact && exact.num === exact.max;
  const enoughContext = () => {
    const header = contextReads.some(r => r.box.source === 'portal-header' && r.marker);
    const closing = contextReads.some(r => r.box.source === 'closing-row' && r.marker);
    return unique.length <= 1 && (!exact || capacityAgrees)
      && (capacityAgrees && (header || closing) || header && closing);
  };
  const finish = () => ({ capReads, slashEvidence: slash, contextReads, capacity: exact, confirmed: enoughContext(),
    skippedContextReads: (capacityAgrees ? 18 : 14) - contextReads.length,
    contextSearch: { order: capacityAgrees ? 'blue-header-first' : 'original-two-marker-order',
      complete: contextReads.length === (capacityAgrees ? 18 : 14), sufficientEvidence: enoughContext()
        ? capacityAgrees ? 'full-agreeing-capacity-plus-one-context-marker' : 'both-header-and-closing-markers' : null },
    reason: enoughContext() ? capacityAgrees ? 'capacity-and-portal-context' : 'portal-header-and-closing-context'
      : unique.length > 1 ? 'conflicting-capacity-fractions' : 'portal-context-not-confirmed' });
  // All fraction observations above are retained, including later conflicting
  // readings. Context is a monotone OR/AND gate with no negative-reading veto.
  // It is safe to stop only this search once the unchanged gate is satisfied.
  if (unique.length > 1 || exact && !capacityAgrees) return finish();
  if (capacityAgrees) {
    const blueBoxes = [
      { source: 'portal-header', left: bar.bx + 34 * s, top: bar.by - 44 * s, width: 180 * s, height: 20 * s },
      { source: 'portal-header', left: bar.bx + 37 * s, top: bar.by - 42 * s, width: 130 * s, height: 15 * s },
    ];
    for (const box of blueBoxes) for (const local of [false, true]) {
      const text = await ocr(await blueCaption(frame, box, local), { psm: 7 }), phrase = captionMatch(text);
      contextReads.push({ box, prep: { family: 'blue-caption', local }, text, marker: phrase.matched, phrase });
      if (enoughContext()) return finish();
    }
  }
  const boxes = [
    { source: 'portal-header', left: bar.bx - 16 * s, top: bar.by - 50 * s, width: 285 * s, height: 25 * s },
    { source: 'closing-row', left: bar.bx + 95 * s, top: bar.by + bar.bh + 2 * s, width: 185 * s, height: 29 * s },
    { source: 'portal-header', left: bar.bx + 34 * s, top: bar.by - 43 * s, width: 180 * s, height: 15 * s, psm: 7 },
    { source: 'closing-row', left: bar.bx + 130 * s, top: bar.by + bar.bh + 8 * s, width: 145 * s, height: 15 * s, psm: 7 },
  ];
  for (const box of boxes) for (const prep of [{ scale: 4 }, { scale: 4, thresh: 150 }]) {
    const image = await R._internal.crop(frame, box.left, box.top, box.width, box.height, prep);
    const text = image ? await ocr(image, { psm: box.psm || 6 }) : '';
    const marker = box.source === 'portal-header' ? /ав[ао]лон|avalon|portal/iu.test(text)
      : /з[аоa]кро|closes|close\b/iu.test(text);
    contextReads.push({ box, prep, text, marker });
    if (enoughContext()) return finish();
  }
  const captionBoxes = [
    { source: 'portal-header', left: bar.bx + 37 * s, top: bar.by - 42 * s, width: 130 * s, height: 15 * s },
    { source: 'closing-row', left: bar.bx + 133 * s, top: bar.by + bar.bh + 9 * s, width: 73 * s, height: 13 * s },
  ];
  for (const box of captionBoxes) for (const threshold of [100, 125, 150]) {
    const image = await whiteTitle(frame, box, threshold), text = image ? await ocr(image, { psm: 7 }) : '';
    const marker = box.source === 'portal-header' ? /ав[ао]лон|avalon|portal/iu.test(text)
      : /з[аоa]кро|closes|close\b/iu.test(text);
    contextReads.push({ box, prep: { family: 'neutral-caption', threshold }, text, marker });
    if (enoughContext()) return finish();
  }
  return finish();
}

async function recover(frame, options = {}) {
  if (typeof options.ocr !== 'function') return { decision: 'unknown', reason: 'ocr-not-provided', portal: null, diagnostics: {} };
  const initial = (options.screenHeight || frame.height) / 1080;
  const found = findCandidates(frame, options.screenHeight);
  const candidates = [];
  for (const hint of found) {
    const bar = refineFilledBar(frame, hint, initial);
    if (bar && !candidates.some(c => Math.abs(c.bx - bar.bx) <= 4 && Math.abs(c.by - bar.by) <= 3)) candidates.push(bar);
  }
  const diagnostics = { originalCandidates: found, candidates, attempts: [] }, passing = [];
  if (candidates.length > 6) return { decision: 'unknown', reason: 'too-many-card-candidates', portal: null, diagnostics };
  for (const bar of candidates) {
    const names = await nameVariants(frame, bar, options.ocr), name = confirmedName(names);
    const attempt = { bar, names, name }; diagnostics.attempts.push(attempt);
    if (!name.name) continue;
    const complete = await nameCompleteness(frame, bar, name.name, names, options.ocr); attempt.nameCompleteness = complete;
    if (!complete.confirmed) continue;
    const context = await cardContext(frame, bar, options.ocr); attempt.context = context;
    if (!context.confirmed) continue;
    const timerRegion = findTimerText(frame, bar, bar.by + bar.bh + 2);
    const cleanBar = { bx: bar.bx, by: bar.by, bh: bar.bh, fill: bar.fill, span: bar.span, scale: bar.scale };
    passing.push({ name: name.name, ...R.zoneInfo(name.name), closes: null,
      capNum: null, capMax: context.capacity?.max ?? null, capMaxKnown: !!context.capacity, capNumApprox: false,
      raw: { name: names.find(r => r.ranked.exact)?.text || '',
        nameReads: names.map(r => ({ text: r.text, score: r.ranked.match?.score ?? null, margin: r.ranked.gap,
          match: r.ranked.match?.name ?? null, exact: r.ranked.exact, box: r.box, prep: r.prep })),
        bar: cleanBar, timerRegion, timerReads: [], capacityReads: context.capReads, portalContextReads: context.contextReads,
        cardRecovery: { nameReason: name.reason, nameCompleteness: complete.reason, geometrySource: bar.source, contextReason: context.reason } } });
  }
  if (passing.length > 1) return { decision: 'reject', reason: 'multiple-confirmed-card-identities', portal: null, diagnostics };
  if (!passing.length) return { decision: diagnostics.attempts.some(a => a.name.reason === 'conflicting-clear-names') ? 'reject' : 'unknown',
    reason: diagnostics.attempts.some(a => a.name.reason === 'conflicting-clear-names') ? 'conflicting-clear-names' : 'card-not-completely-confirmed', portal: null, diagnostics };
  return { decision: 'accept', reason: 'pixel-bar-exact-name-and-portal-context', portal: passing[0], diagnostics };
}
return { recover, findCandidates, nameVariants, refineFilledBar, confirmedName, nameCompleteness, captionMatch };
}
module.exports={createCardRecovery};
