const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sharp = require('sharp');
const routeImageFile = require('../lib/route-image-file');
const { create, validatePng, safeFilename, MAX_BYTES, MAX_SIDE } = routeImageFile;
const PREFIX = 'data:image/png;base64,';
const png = sharp({ create: { width: 12, height: 8, channels: 4, background: { r: 30, g: 70, b: 110, alpha: .7 } } }).png().toBuffer();
const url = data => PREFIX + data.toString('base64');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options = {}) {
  const dialogs = [], writes = [], copies = [], errors = [];
  const target = path.resolve('route-test-output.png');
  const api = create({
    showSaveDialog: async opts => { dialogs.push(opts); return { canceled: false, filePath: target }; },
    writeFile: async (filePath, data) => writes.push({ filePath, data }),
    createNativeImage: data => ({ data, isEmpty: () => false }),
    writeClipboardImage: image => copies.push(image),
    onError: error => errors.push(error),
    ...options,
  });
  return { api, dialogs, writes, copies, errors, target };
}

test('PNG validation fully decodes and preserves rendered pixels', async () => {
  const input = await png;
  const result = await validatePng(url(input));
  const decoded = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const original = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 12);
  assert.equal(decoded.info.height, 8);
  assert.deepEqual(decoded.data, original.data);
});

test('malformed data URLs, non-PNG images and truncated PNG payloads are rejected before any dialog', async () => {
  const valid = await png;
  const jpeg = await sharp(valid).jpeg().toBuffer();
  for (const dataUrl of [null, undefined, {}, '', 'https://example.invalid/route.png',
    'data:image/jpeg;base64,' + valid.toString('base64'), PREFIX + '%%%%', PREFIX + 'AAAA=',
    PREFIX + 'AA A', PREFIX + 'AAAA\n', url(jpeg), url(valid.subarray(0, 33))]) {
    const s = fixture();
    const result = await s.api('save', { dataUrl });
    assert.equal(typeof result.error, 'string');
    assert.equal(s.dialogs.length, 0);
    assert.equal(s.writes.length, 0);
    assert.equal(s.copies.length, 0);
  }
});

test('byte, pixel-area and side limits reject large images before decompression', async () => {
  await assert.rejects(validatePng(PREFIX + 'A'.repeat(Math.ceil(MAX_BYTES / 3) * 4 + 4)), /20 МБ/);
  for (const [width, height] of [[0, 10], [MAX_SIDE + 1, 1], [1, MAX_SIDE + 1], [6000, 4001]]) {
    const oversized = Buffer.from(await png);
    oversized.writeUInt32BE(width, 16);
    oversized.writeUInt32BE(height, 20);
    await assert.rejects(validatePng(url(oversized)), /24 мегапикселя/);
  }
});

test('default names cannot inject directories, Windows control characters, device paths or excessively long filenames', () => {
  for (const [from, to] of [['../../CON', '..\\..\\NUL'], ['C:\\secret\u0000\n<>:|?*', 'A\u202eexe'],
    ['.'.repeat(500), '\\?\\C:\\'], ['😀'.repeat(500), 'z'.repeat(500)], [null, {}]]) {
    const filename = safeFilename(from, to);
    assert.equal(path.basename(filename), filename);
    assert.doesNotMatch(filename, /[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    assert.match(filename, /^Маршрут — .+ — .+\.png$/);
    assert.ok(filename.length < 160);
    assert.doesNotMatch(filename, /^(?:CON|NUL|PRN|AUX|COM\d|LPT\d)(?:\.|$)/i);
  }
});

test('save writes only the path chosen by the native dialog and waits for asynchronous completion', async () => {
  const started = deferred(), pendingWrite = deferred();
  let file, bytes;
  const s = fixture({ writeFile: async (filePath, data) => {
    file = filePath; bytes = data; started.resolve(); await pendingWrite.promise;
  } });
  let completed = false;
  const work = s.api('save', { dataUrl: url(await png), from: '../A', to: '..\\B', filePath: 'C:\\untrusted-renderer.png' })
    .then(result => { completed = true; return result; });
  await started.promise;
  assert.equal(file, s.target);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(completed, false);
  assert.deepEqual(s.dialogs[0].filters, [{ name: 'Изображение PNG', extensions: ['png'] }]);
  assert.ok(s.dialogs[0].properties.includes('showOverwriteConfirmation'));
  assert.equal(path.basename(s.dialogs[0].defaultPath), s.dialogs[0].defaultPath);
  pendingWrite.resolve();
  assert.deepEqual(await work, { ok: true, filePath: s.target });
});

test('canceling the dialog has no error and releases the single-export guard', async () => {
  let canceled = true;
  const s = fixture({ showSaveDialog: async () => canceled ? { canceled: true } : { canceled: false, filePath: path.resolve('chosen.png') } });
  const payload = { dataUrl: url(await png), from: 'A', to: 'B' };
  assert.deepEqual(await s.api('save', payload), { canceled: true });
  assert.equal(s.writes.length, 0);
  canceled = false;
  assert.equal((await s.api('save', payload)).ok, true);
  assert.equal(s.writes.length, 1);
});

test('a second save or copy cannot open another dialog or allocate another native image while an export is active', async () => {
  const opened = deferred(), dialog = deferred();
  let calls = 0;
  const s = fixture({ showSaveDialog: () => { calls++; opened.resolve(); return dialog.promise; } });
  const payload = { dataUrl: url(await png) };
  const work = s.api('save', payload);
  await opened.promise;
  assert.match((await s.api('save', payload)).error, /Дождись/);
  assert.match((await s.api('copy', payload)).error, /Дождись/);
  assert.equal(calls, 1);
  assert.equal(s.copies.length, 0);
  dialog.resolve({ canceled: true });
  assert.deepEqual(await work, { canceled: true });
  assert.deepEqual(await s.api('copy', payload), { ok: true });
});

test('clipboard export uses a native image and never opens a save dialog or writes a file', async () => {
  const s = fixture();
  assert.deepEqual(await s.api('copy', { dataUrl: url(await png) }), { ok: true });
  assert.equal(s.copies.length, 1);
  assert.equal(s.copies[0].isEmpty(), false);
  assert.equal((await sharp(s.copies[0].data).metadata()).format, 'png');
  assert.equal(s.dialogs.length, 0);
  assert.equal(s.writes.length, 0);
});

test('file and clipboard failures produce Russian errors, release the guard, and never report success', async () => {
  let fail = true;
  const s = fixture({ writeFile: async () => { if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  const payload = { dataUrl: url(await png) };
  const result = await s.api('save', payload);
  assert.match(result.error, /Не удалось сохранить PNG/);
  assert.equal(result.ok, undefined);
  assert.equal(s.errors.length, 1);
  fail = false;
  assert.equal((await s.api('save', payload)).ok, true);
  for (const options of [{ createNativeImage: () => ({ isEmpty: () => true }) },
    { writeClipboardImage: () => { throw new Error('clipboard unavailable'); } }]) {
    assert.match((await fixture(options).api('copy', payload)).error, /Не удалось скопировать/);
  }
});

test('unknown actions and invalid paths returned by a broken dialog cannot write files', async () => {
  const payload = { dataUrl: url(await png) };
  const unknown = fixture();
  assert.match((await unknown.api('delete', payload)).error, /Неизвестное действие/);
  assert.equal(unknown.dialogs.length, 0);
  for (const filePath of ['relative.png', 'C:\\route\0.png', 4]) {
    const s = fixture({ showSaveDialog: async () => ({ canceled: false, filePath }) });
    assert.equal(typeof (await s.api('save', payload)).error, 'string');
    assert.equal(s.writes.length, 0);
  }
});

test('the production IPC handler authorizes only the live main-window main frame', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('export-route-image',");
  assert.notEqual(start, -1);
  const end = source.indexOf('\n});', start) + '\n});'.length;
  const mainFrame = {}, contents = { mainFrame, isDestroyed: () => false };
  let handler, calls = 0;
  const ctx = vm.createContext({
    ipcMain: { handle: (_, callback) => { handler = callback; } },
    win: { isDestroyed: () => false, webContents: contents },
    exportRouteImage: async (action, payload) => { calls++; return { ok: true, action, payload }; },
  });
  vm.runInContext(source.slice(start, end), ctx);
  for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender: contents, senderFrame: {} }, { sender: contents, senderFrame: null }]) {
    assert.match((await handler(event, 'save', {})).error, /главного окна/);
  }
  const payload = { dataUrl: 'valid-through-helper' };
  const result = await handler({ sender: contents, senderFrame: mainFrame }, 'copy', payload);
  assert.equal(result.ok, true);
  assert.equal(result.payload, payload);
  assert.equal(calls, 1);
  ctx.win = null;
  assert.match((await handler({ sender: contents, senderFrame: mainFrame }, 'save', {})).error, /главного окна/);
  assert.equal(calls, 1);
});

test('the preload exposes only the route-image action and payload through its dedicated IPC channel', () => {
  let api;
  const invoked = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { api = value; } },
      ipcRenderer: { invoke: (...args) => invoked.push(args) } }),
  });
  const payload = { dataUrl: 'image', from: 'A', to: 'B' };
  api.exportRouteImage('save', payload);
  assert.deepEqual(invoked, [['export-route-image', 'save', payload]]);
});
