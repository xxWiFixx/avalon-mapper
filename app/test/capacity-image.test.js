const assert = require('node:assert/strict');
const { test } = require('node:test');
const sharp = require('sharp');
const { capacityImage, exactCapacity } = require('../lib/capacity-image');

const anchor = (num, max, scale = 1) => ({ fill: num / max * 195 * scale, scale });

test('exact capacity accepts valid available slots and rejects malformed or oversized text', () => {
  for (const [text, num, max] of [['0/7', 0, 7], ['7/7', 7, 7], ['11/20', 11, 20], ['20 / 20', 20, 20]]) {
    assert.deepEqual(exactCapacity(text, anchor(num, max)), { num, max });
  }
  for (const text of ['', null, undefined, '20', '11/2', '11/200', '2/5', '8/7', '21/20',
    '86/7', '117/20', '-1/7', '6.5/7', 'portal 7/7', '7/7 timer', '7/7\n1/7']) {
    assert.equal(exactCapacity(text, anchor(7, 7)), null, String(text));
  }
});

test('a cropped leading digit is rejected when the visible fill proves it cannot be correct', () => {
  for (const scale of [0.5, 1, 1.5, 2]) {
    assert.equal(exactCapacity('9/20', anchor(19, 20, scale)), null);
    assert.equal(exactCapacity('1/20', anchor(11, 20, scale)), null);
    assert.deepEqual(exactCapacity('19/20', anchor(19, 20, scale)), { num: 19, max: 20 });
  }
  assert.deepEqual(exactCapacity('6/7', { fill: 155, scale: 1 }), { num: 6, max: 7 });
  // An anchor merged with another gold UI region is not reliable fill evidence.
  assert.deepEqual(exactCapacity('9/20', { fill: 350, scale: 1 }), { num: 9, max: 20 });
});

test('unknown fill geometry does not become zero or throw away a valid exact reading', () => {
  for (const bar of [undefined, null, {}, { fill: null, scale: 1 }, { fill: undefined, scale: 1 },
    { fill: NaN, scale: 1 }, { fill: 190, scale: null }, { fill: 190, scale: undefined }]) {
    assert.deepEqual(exactCapacity('7/7', bar), { num: 7, max: 7 });
    assert.equal(exactCapacity('8/7', bar), null);
  }
});

// A small synthetic tooltip strip with a silhouette, a separating gap and five
// separate glyphs (11/20). Distinct red/blue channels catch accidental BGRA reads.
function syntheticBar(uiScale = 1, bgra = false) {
  const width = Math.ceil(260 * uiScale), height = Math.ceil(45 * uiScale);
  const data = Buffer.alloc(width * height * 4);
  const bar = { bx: Math.round(20 * uiScale), by: Math.round(15 * uiScale), bh: Math.round(11 * uiScale),
    span: Math.round(258 * uiScale), scale: uiScale, fill: 195 * uiScale };
  const setPixel = (x, y, rgb) => {
    const i = (y * width + x) * 4;
    data[i] = rgb[bgra ? 2 : 0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[bgra ? 0 : 2]; data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const within = y >= bar.by && y < bar.by + bar.bh && x >= bar.bx && x < bar.bx + 195 * uiScale;
    setPixel(x, y, within ? [230, 162, 52] : [35, 42, 58]);
  }
  const rect = (left, top, w, h) => {
    for (let y = Math.round(top * uiScale); y < Math.round((top + h) * uiScale); y++) {
      for (let x = Math.round(left * uiScale); x < Math.round((left + w) * uiScale); x++) {
        setPixel(bar.bx + Math.round(62 * uiScale) + x, bar.by + y, [22, 14, 6]);
      }
    }
  };
  rect(5, 2, 8, 8); // Player silhouette must be excluded by the gap crop.
  rect(24, 2, 3, 8); rect(32, 2, 3, 8);
  for (let y = 2; y < 10; y++) rect(44 - Math.floor(y / 2), y, 2, 1);
  rect(49, 2, 6, 2); rect(53, 3, 2, 3); rect(49, 5, 6, 2); rect(49, 6, 2, 3); rect(49, 8, 6, 2);
  rect(61, 2, 6, 2); rect(61, 8, 6, 2); rect(61, 2, 2, 8); rect(65, 2, 2, 8);
  return { frame: { data, width, height, bgra }, bar };
}

async function pixels(png) {
  return sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
}

function occupiedColumns(data, width, height) {
  const columns = [];
  for (let x = 0; x < width; x++) {
    if (Array.from({ length: height }, (_, y) => data[y * width + x]).some(value => value < 128)) columns.push(x);
  }
  return columns;
}

test('capacity preprocessing produces identical glyph pixels from RGBA and native BGRA captures', async () => {
  const rgba = syntheticBar(), bgra = syntheticBar(1, true);
  const first = await capacityImage(rgba.frame, rgba.bar);
  const second = await capacityImage(bgra.frame, bgra.bar);
  assert.ok(first && second);
  const a = await pixels(first), b = await pixels(second);
  assert.deepEqual(a.info, b.info);
  assert.deepEqual(a.data, b.data);
  assert.ok(a.data.includes(0) && a.data.includes(255));
  const columns = occupiedColumns(a.data, a.info.width, a.info.height);
  const glyphs = columns.filter((x, i) => i === 0 || x > columns[i - 1] + 1).length;
  assert.equal(glyphs, 5, 'keep both leading digits and the slash, exclude the player silhouette');
  assert.ok(columns[0] >= 12 && columns.at(-1) < a.info.width - 12, 'leave white OCR padding');
});

test('fractional UI scales and output magnification retain readable ink within white padding', async () => {
  for (const uiScale of [0.5, 1, 1.5, 2]) {
    const { frame, bar } = syntheticBar(uiScale);
    for (const scale of [2, 4]) {
      const png = await capacityImage(frame, bar, { scale });
      assert.ok(png, `UI scale ${uiScale}, OCR scale ${scale}`);
      const { data, info } = await pixels(png);
      assert.equal(info.height, bar.bh * scale + 24);
      assert.ok(data.includes(0));
      for (let x = 0; x < info.width; x++) {
        assert.equal(data[x], 255);
        assert.equal(data[(info.height - 1) * info.width + x], 255);
      }
    }
  }
});

test('missing separator and off-screen geometry safely leave the established OCR fallback in charge', async () => {
  const { frame, bar } = syntheticBar();
  const dark = { ...frame, data: Buffer.alloc(frame.data.length) };
  assert.equal(await capacityImage(dark, bar), null);
  assert.equal(await capacityImage(frame, { ...bar, bx: frame.width }), null);
  assert.equal(await capacityImage(frame, { ...bar, by: frame.height }), null);
  assert.equal(await capacityImage(frame, { ...bar, bh: 0 }), null);
});
