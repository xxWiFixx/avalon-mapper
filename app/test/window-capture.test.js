'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, cropToDesktop } = require('../lib/window-capture');
const gameWindow = require('../lib/game-window');

function frame(width = 4, height = 3) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    data.set([x + 1, y + 1, 9, 255], (y * width + x) * 4);
  return { data, width, height, bgra: true };
}
const pixel = (f, x, y) => Array.from(f.data.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4));
const bounds = { left: -100, top: 20, right: -96, bottom: 23 };

test('window pixels are cropped at physical coordinates with negative monitor origins', () => {
  const result = cropToDesktop(frame(), bounds, { x: -99, y: 21, width: 2, height: 2 });
  assert.deepEqual(pixel(result, 0, 0), [2, 2, 9, 255]);
  assert.deepEqual(pixel(result, 1, 1), [3, 3, 9, 255]);
});

test('desktop-sized fallback contains game pixels and blank outside; scaled thumbnails retain coordinates', () => {
  const result = cropToDesktop(frame(), bounds, { x: -101, y: 19, width: 7, height: 5 });
  assert.deepEqual(pixel(result, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(result, 1, 1), [1, 1, 9, 255]);
  assert.deepEqual(pixel(result, 4, 3), [4, 3, 9, 255]);
  assert.deepEqual(pixel(result, 6, 4), [0, 0, 0, 0]);
  const doubled = { left: 0, top: 0, right: 8, bottom: 6 };
  const scaled = cropToDesktop(frame(), doubled, { x: 2, y: 2, width: 4, height: 4 });
  assert.deepEqual(pixel(scaled, 0, 0), [2, 2, 9, 255]);
  assert.deepEqual(pixel(scaled, 3, 3), [3, 3, 9, 255]);
});

test('invalid buffers, oversized images and rectangles outside the game are rejected', () => {
  assert.throws(() => cropToDesktop(frame(), bounds, { x: 0, y: 0, width: 3, height: 3 }), /вне окна/);
  assert.throws(() => cropToDesktop({ ...frame(), data: Buffer.alloc(1) }, bounds, { x: -100, y: 20, width: 1, height: 1 }), /размер/);
  for (const width of [0, -1, NaN, 20000])
    assert.throws(() => cropToDesktop(frame(), bounds, { x: -100, y: 20, width, height: 1 }), /размер/);
});

function session() {
  const game = { found: true, minimized: false, bounds: { ...bounds }, windowId: '123' };
  const own = frame(), calls = [];
  const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 4, height: 3 }), toBitmap: () => own.data };
  let states = () => ({ ...game, bounds: { ...game.bounds } });
  let sources = [{ id: 'window:123:2', name: 'Anything', thumbnail }];
  const api = create({ getGame: async () => states(), now: () => 456,
    getSources: async options => { calls.push(options); return sources; } });
  return { api, game, calls, setSources: value => { sources = value; }, setStates: value => { states = value; } };
}

test('only the exact game HWND is selected, regardless of title or capture-backend suffix', async () => {
  const s = session();
  const result = await s.api.capture({ x: -99, y: 21, width: 2, height: 2 });
  assert.equal(result.capturedAt, 456); assert.deepEqual(pixel(result, 0, 0), [2, 2, 9, 255]);
  assert.deepEqual(s.calls[0], { types: ['window'], thumbnailSize: { width: 4, height: 3 }, fetchWindowIcons: false });
  s.setSources([{ id: 'window:124:2', name: 'Albion Online', thumbnail: { isEmpty: () => false } }]);
  await assert.rejects(s.api.capture(), /снимок окна/);
});

test('minimized, missing or changed game windows never fall back to recording the desktop', async () => {
  const s = session(); s.game.minimized = true;
  await assert.rejects(s.api.capture(), /недоступно/); assert.equal(s.calls.length, 0);
  s.game.minimized = false;
  let n = 0; s.setStates(() => n++ ? { ...s.game, windowId: '124' } : s.game);
  await assert.rejects(s.api.capture(), /переместилось/);
  n = 0; s.setStates(() => n++ ? { ...s.game, bounds: { ...bounds, left: -99 } } : s.game);
  await assert.rejects(s.api.capture(), /переместилось/);
});

test('window selection retains the focused game HWND for multiple clients and four displays', () => {
  const second = { left: 3840, top: -1440, right: 6400, bottom: 0 };
  const result = gameWindow.summarizeWindows([
    { visible: true, iconic: false, focused: false, bounds, windowId: '123' },
    { visible: true, iconic: false, focused: true, bounds: second, windowId: '456' },
  ]);
  assert.equal(result.windowId, '456'); assert.equal(result.bounds, second);
});
