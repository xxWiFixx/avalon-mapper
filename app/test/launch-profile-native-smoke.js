// Native singleton/session isolation: node test/launch-profile-native-smoke.js
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const electron = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-profile-smoke-'));
const children = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(secondary) {
  const child = spawn(electron, [path.join(__dirname, 'launch-profile-native-child.js'), '--test-root=' + root,
    ...(secondary ? ['--second-account'] : [])], { windowsHide: true });
  let text = '';
  child.stdout.on('data', bytes => { text += bytes; }); child.stderr.on('data', bytes => { text += bytes; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve({ code, text })); });
  const item = { child, done }; children.push(item); return item;
}
async function ready(owner) {
  const file = path.join(root, owner + '-ready.json'), end = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(owner + ' profile did not start');
    await wait(50);
  }
  return JSON.parse(fs.readFileSync(file));
}
(async () => {
  try {
    start(false); const first = await ready('first');
    start(true); const second = await ready('second');
    assert.equal(first.userData, root); assert.equal(first.cookie, 'first');
    assert.equal(first.sessionData, root);
    assert.equal(second.userData, root + '-second-account'); assert.equal(second.cookie, 'second');
    assert.equal(second.sessionData, second.userData);
    for (const [profile, owner] of [[first, 'first'], [second, 'second']])
      for (const file of ['auth.json', 'map.json'])
        assert.equal(JSON.parse(fs.readFileSync(path.join(profile.userData, file))).testOwner, owner);
    for (const secondary of [false, true]) {
      const duplicate = await start(secondary).done;
      assert.equal(duplicate.code, 0); assert.match(duplicate.text, /already locked/);
    }
    console.log('PASS: two profiles run concurrently with independent sessions, auth and maps; duplicate launches stay blocked.');
  } finally {
    fs.writeFileSync(path.join(root, 'finish'), 'done');
    const results = await Promise.all(children.map(child => child.done));
    for (const result of results) if (result.code) throw new Error(result.text || 'native profile test failed');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
