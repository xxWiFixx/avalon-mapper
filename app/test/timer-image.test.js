const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { findTimerText, timerImage } = require('../lib/timer-image');

// Six separate connected glyphs emulate two digits, a short unit, two digits,
// and the final short unit. The final unit approaches the search area's right
// edge so a fixed-duration crop or digit-only bounding box would lose it.
function fixture({ scale = 1, bgra = false, color = [150, 30, 25], text = true, noise = false } = {}) {
  const width = Math.ceil(380 * scale), height = Math.ceil(65 * scale);
  const data = Buffer.alloc(width * height * 4);
  const bar = { bx: Math.round(20 * scale), by: Math.round(10 * scale), bh: Math.round(11 * scale), scale };
  const top = Math.round(25 * scale);
  function pixel(x, y, rgb) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (y * width + x) * 4;
    data[p] = rgb[bgra ? 2 : 0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[bgra ? 0 : 2]; data[p + 3] = 255;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixel(x, y, [28, 26, 23]);
  function rect(x, y, w, h, rgb = color) {
    const left = Math.round(bar.bx + (100 + x) * scale), right = Math.round(bar.bx + (100 + x + w) * scale);
    const upper = Math.round(top + y * scale), bottom = Math.round(top + (y + h) * scale);
    for (let py = upper; py < bottom; py++) for (let px = left; px < right; px++) pixel(px, py, rgb);
    return { left, top: upper, right, bottom };
  }
  if (noise) {
    rect(0, 0, 90, 26); // A large red/light world-texture component is not a glyph.
    for (let x = 96; x < 140; x += 5) rect(x, x % 3, 1, 1);
  }
  const glyphs = text ? [rect(160, 6, 6, 12), rect(172, 6, 6, 12), rect(184, 11, 5, 7),
    rect(198, 6, 6, 12), rect(210, 6, 6, 12), rect(224, 11, 5, 7)] : [];
  return { frame: { data, width, height, bgra }, bar, top, glyphs };
}

async function decoded(png) {
  return sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
}
function inkGroups(data, width, height) {
  const columns = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (data[y * width + x] < 128) { columns.push(x); break; }
    }
  }
  return { columns, count: columns.filter((x, i) => !i || x > columns[i - 1] + 1).length };
}

test('dark red urgent timer retains all digits and short trailing units in its dynamic bounds', async () => {
  const { frame, bar, top, glyphs } = fixture();
  // This red has grayscale brightness ~65, far below a white-text threshold.
  const region = findTimerText(frame, bar, top);
  assert.equal(region.kind, 'red');
  assert.ok(region.left <= glyphs[0].left);
  assert.ok(region.left + region.width >= glyphs.at(-1).right, 'include the last unit');
  assert.ok(region.top <= glyphs[0].top);
  assert.ok(region.top + region.height >= glyphs.at(-1).bottom);
  const { data, info } = await decoded(await timerImage(frame, region));
  const ink = inkGroups(data, info.width, info.height);
  assert.equal(ink.count, 6, 'retain the two shorter unit glyphs');
  assert.ok(ink.columns[0] >= 12);
  assert.ok(ink.columns.at(-1) < info.width - 12);
  assert.equal(data[0], 255);
});

test('neutral white duration uses the light path and preserves both unit glyphs', async () => {
  const { frame, bar, top } = fixture({ color: [220, 220, 220] });
  const region = findTimerText(frame, bar, top);
  assert.equal(region.kind, 'light');
  const { data, info } = await decoded(await timerImage(frame, region));
  assert.equal(inkGroups(data, info.width, info.height).count, 6);
});

test('large colored background components and speckles cannot expand the timer into a whole tooltip', async () => {
  for (const color of [[150, 30, 25], [220, 220, 220]]) {
    const { frame, bar, top, glyphs } = fixture({ color, noise: true });
    const region = findTimerText(frame, bar, top);
    assert.ok(region);
    assert.ok(region.left >= glyphs[0].left - 3);
    assert.ok(region.width < 100);
    const { data, info } = await decoded(await timerImage(frame, region));
    assert.equal(inkGroups(data, info.width, info.height).count, 6);
    const empty = fixture({ color, noise: true, text: false });
    assert.equal(findTimerText(empty.frame, empty.bar, empty.top), null);
  }
});

test('RGBA and native BGRA frames produce identical duration bounds and OCR pixels', async () => {
  for (const color of [[150, 30, 25], [220, 220, 220]]) {
    const a = fixture({ color }), b = fixture({ color, bgra: true });
    const left = findTimerText(a.frame, a.bar, a.top), right = findTimerText(b.frame, b.bar, b.top);
    assert.deepEqual(left, right);
    const first = await decoded(await timerImage(a.frame, left));
    const second = await decoded(await timerImage(b.frame, right));
    assert.deepEqual(first.info, second.info);
    assert.deepEqual(first.data, second.data);
  }
});

test('fractional UI scales retain the final unit and leave bounded white padding', async () => {
  for (const scale of [.5, .75, 1.1, 1.25, 1.5, 2]) {
    const { frame, bar, top, glyphs } = fixture({ scale });
    const region = findTimerText(frame, bar, top);
    assert.ok(region, `UI scale ${scale}`);
    assert.ok(region.left + region.width >= glyphs.at(-1).right, `last unit at ${scale}`);
    assert.ok(region.width <= 140 * scale + 4);
    const { data, info } = await decoded(await timerImage(frame, region, { scale: 3 }));
    assert.equal(inkGroups(data, info.width, info.height).count, 6, `all glyphs at ${scale}`);
    assert.equal(info.width, region.width * 3 + 24);
    assert.equal(info.height, region.height * 3 + 24);
    for (let x = 0; x < info.width; x++) {
      assert.equal(data[x], 255);
      assert.equal(data[(info.height - 1) * info.width + x], 255);
    }
  }
});

test('a frame without timer text leaves the normal OCR fallback in charge', async () => {
  const { frame, bar, top } = fixture({ text: false });
  assert.equal(findTimerText(frame, bar, top), null);
  assert.equal(await timerImage(frame, null), null);
});

test('invalid anchors and entirely off-screen regions safely return null', async () => {
  const { frame, bar, top } = fixture();
  for (const invalid of [null, undefined, {}, { ...bar, scale: 0 }, { ...bar, scale: NaN },
    { ...bar, bx: NaN }, { ...bar, bx: frame.width }, { ...bar, bx: -2000 }]) {
    assert.equal(findTimerText(frame, invalid, top), null);
  }
  for (const badTop of [NaN, Infinity, frame.height, -2000]) assert.equal(findTimerText(frame, bar, badTop), null);
  for (const region of [{ left: frame.width, top: 0, width: 20, height: 20 },
    { left: 0, top: frame.height, width: 20, height: 20 },
    { left: -2000, top: 0, width: 20, height: 20 },
    { left: 0, top: -2000, width: 20, height: 20 },
    { left: NaN, top: 0, width: 20, height: 20 }]) {
    assert.equal(await timerImage(frame, region), null);
  }
});
