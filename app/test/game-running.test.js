const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../lib/privileges.js'), 'utf8');
const begin = source.indexOf('async function isGameRunning()');
const end = source.indexOf('// Итоговый вердикт', begin);
assert.ok(begin >= 0 && end > begin);

function check({ window, processes, platform = 'win32' }) {
  let checks = 0;
  const context = vm.createContext({
    process: { platform },
    gameWindow: { state: async () => ({ found: window }) },
    ps: async command => {
      checks++;
      assert.match(command, /Albion-Online_BE/);
      return processes;
    },
  });
  vm.runInContext(source.slice(begin, end), context);
  return { result: context.isGameRunning(), checks: () => checks };
}

test('screen polling stays active for an Albion process when window lookup fails', async () => {
  const result = check({ window: false, processes: '2' });
  assert.equal(await result.result, true);
  assert.equal(result.checks(), 1);
});

test('a recognized game window needs no slower process check', async () => {
  const result = check({ window: true, processes: '' });
  assert.equal(await result.result, true);
  assert.equal(result.checks(), 0);
});

test('screen polling remains off when Albion is absent', async () => {
  assert.equal(await check({ window: false, processes: '0' }).result, false);
  assert.equal(await check({ window: false, processes: '', platform: 'linux' }).result, false);
});
