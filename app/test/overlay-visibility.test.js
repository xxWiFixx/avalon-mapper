const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const begin = source.indexOf('function syncOverlayWindowVisibility()');
const end = source.indexOf('function metricsSnapshot()', begin);
assert.ok(begin >= 0 && end > begin);

function fakeWindow() {
  return {
    shown: true, focused: false, hides: 0, shows: 0, _readyToShow: true,
    isDestroyed: () => false,
    isVisible() { return this.shown; },
    isFocused() { return this.focused; },
    hide() { this.shown = false; this.hides++; },
    showInactive() { this.shown = true; this.shows++; },
  };
}

test('losing focus or minimizing hides overlays; focusing the game restores them', async () => {
  const overlay = fakeWindow(), fame = fakeWindow(), damage = fakeWindow();
  let gameState = { found: true, minimized: false, focused: true };
  let closedSearches = 0;
  const context = vm.createContext({
    overlay, overlayReady: true, search: null, picker: null,
    metricsWindows: { fame, damage }, suspendedOverlay: false,
    manualOverlaysHidden: false, gameOverlaysInactive: false, gameWindowSeen: false,
    gameWindowCheckRunning: false, quitting: false,
    overlaysHidden: () => context.manualOverlaysHidden || context.gameOverlaysInactive,
    closeSearch: () => closedSearches++, pushConfig() {},
    gameWindow: { state: async () => gameState }, console,
  });
  vm.runInContext(source.slice(begin, end), context);
  await vm.runInContext('checkGameWindowVisibility()', context);
  assert.deepEqual([overlay.shown, fame.shown, damage.shown], [true, true, true]);

  gameState = { found: true, minimized: false, focused: false };
  await vm.runInContext('checkGameWindowVisibility()', context);
  assert.deepEqual([overlay.shown, fame.shown, damage.shown], [false, false, false]);
  assert.equal(closedSearches, 1);

  gameState = { found: true, minimized: false, focused: true };
  await vm.runInContext('checkGameWindowVisibility()', context);
  assert.deepEqual([overlay.shown, fame.shown, damage.shown], [true, true, true]);

  fame.focused = true;
  gameState = { found: true, minimized: false, focused: false };
  await vm.runInContext('checkGameWindowVisibility()', context);
  assert.deepEqual([overlay.shown, fame.shown, damage.shown], [true, true, true],
    'Clicking an overlay must not make it disappear');

  gameState = { found: true, minimized: true, focused: false };
  await vm.runInContext('checkGameWindowVisibility()', context);
  assert.deepEqual([overlay.shown, fame.shown, damage.shown], [false, false, false]);
  fame.focused = false;
  gameState = { found: true, minimized: false, focused: true };
  await vm.runInContext('checkGameWindowVisibility()', context);

  context.manualOverlaysHidden = true;
  vm.runInContext('syncOverlayWindowVisibility()', context);
  gameState = { found: true, minimized: true, focused: false };
  await vm.runInContext('checkGameWindowVisibility()', context);
  gameState = { found: true, minimized: false, focused: true };
  await vm.runInContext('checkGameWindowVisibility()', context);
  assert.deepEqual([overlay.shown, fame.shown, damage.shown], [false, false, false],
    'Manual hide remains active after the game is restored');
});
