const assert = require('node:assert/strict');
const { test } = require('node:test');
const gameWindow = require('../lib/game-window');

test('game windows are identified by executable, with title fallback', () => {
  assert.equal(gameWindow.isGameWindow({ path: 'Z:\\Albion\\game\\Albion-Online.exe' }), true);
  assert.equal(gameWindow.isGameWindow({ path: 'Z:\\Albion\\game\\Albion-Online_BE.exe' }), true);
  assert.equal(gameWindow.isGameWindow({ title: 'Albion Online Client' }), true);
  assert.equal(gameWindow.isGameWindow({ path: 'C:\\Game\\Albion-Online-Helper.exe' }), false);
  assert.equal(gameWindow.isGameWindow({ title: 'Albion Mapper' }), false);
});

test('game window state reports minimization and focus separately', () => {
  assert.deepEqual(gameWindow.summarizeWindows([]), { found: false, minimized: false, focused: false });
  assert.deepEqual(gameWindow.summarizeWindows([{ visible: true, iconic: false, focused: true }]),
    { found: true, minimized: false, focused: true });
  assert.deepEqual(gameWindow.summarizeWindows([{ visible: true, iconic: false, focused: false }]),
    { found: true, minimized: false, focused: false });
  assert.deepEqual(gameWindow.summarizeWindows([{ visible: true, iconic: true, focused: true }]),
    { found: true, minimized: true, focused: false });
  assert.deepEqual(gameWindow.summarizeWindows([{ visible: false, iconic: false }]),
    { found: false, minimized: false, focused: false });
});
