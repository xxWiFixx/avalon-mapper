'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const gate = require('../../tools/build-privacy.cjs');
const pkg = require('../package.json');
const { minimatch } = require('../node_modules/minimatch');
const included = name => pkg.build.files.some(p => !p.startsWith('!') && minimatch(name, p)) && !pkg.build.files.some(p => p.startsWith('!') && minimatch(name, p.slice(1)));
test('release excludes developer state and includes runtime modules', () => {
  for (const f of ['out/screenshot.png','data/auth.json','test/fixtures/portal.png','tools/review.js','scratch.js','.env','notes.md']) assert.equal(included(f), false, f);
  for (const f of ['main.js','preload.js','lib/sync.js','ui/map.js','locales/en.js','assets/server-help/server-roles.png','data-static/zone-data.json']) assert.equal(included(f), true, f);
  assert.ok(pkg.build.beforePack && pkg.build.afterPack);
});
test('credential gate distinguishes publishable anon key from private session JWT', () => {
  const jwt = payload => ['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify(payload)).toString('base64url'),'signature'].join('.');
  assert.deepEqual(gate.inspectText(jwt({role:'anon'})), []);
  assert.ok(gate.inspectText(jwt({role:'authenticated',sub:'test-account'})).includes('private-jwt'));
  assert.ok(gate.inspectText(jwt({role:'service_role'})).includes('private-jwt'));
  assert.ok(gate.inspectText('-----BEGIN PRIVATE KEY-----').includes('private-key'));
  assert.ok(gate.inspectText(JSON.stringify({refresh_token:'example'.repeat(6)})).includes('stored-credential'));
});
test('machine paths are flagged without exposing their value', () => {
  assert.ok(gate.inspectText('C:\\Users\\ExamplePerson\\Desktop\\capture.png').includes('personal-machine-path'));
  assert.deepEqual(gate.inspectText('%APPDATA%/avalon-mapper'), []);
  assert.deepEqual(gate.inspectText('https://github.com/example/project/releases'), []);
});
test('packaged sources do not include hooks, tests or runtime state', () => {
  const files = gate.sourceFiles();
  assert.ok(files.length > 100);
  assert.equal(files.some(f => /^(?:test|tools|data|out)\//.test(f)), false);
  assert.ok(files.includes(path.posix.join('ui','server-help.js')));
});
