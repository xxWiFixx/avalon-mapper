const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPortalShotArchive, failureReasons } = require('../lib/portal-shot-archive');

test('each portal capture keeps its own images and failed captures are grouped with reasons', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avalon-portal-archive-'));
  t.after(async () => {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(root).startsWith(tempRoot));
    await fs.rm(root, { recursive: true, force: true });
  });
  let sequence = 0;
  const archive = createPortalShotArchive(root, {
    encode: async frame => Buffer.from(frame.bytes),
    uid: () => `case${++sequence}00000000`,
  });
  const capturedAt = Date.parse('2026-09-25T10:11:12.000Z');
  const first = archive.capture({
    portalFrame: { bytes: 'portal-one' }, zoneFrame: { bytes: 'current-zone-one' },
    capturedAt, source: 'screen', originAtCapture: 'Martlock', zoneExpected: true,
  });
  await first.finish({
    tip: { name: 'Quaent-In-Nusis', capNum: 2, capMax: 7, closes: 4000,
      timerUncertain: false, capNumApprox: false, raw: { name: 'Quaent-In-Nusis' } },
    zone: { zone: 'Martlock' },
  });
  const second = archive.capture({
    portalFrame: { bytes: 'portal-two' }, zoneFrame: { bytes: 'current-zone-two' },
    capturedAt, source: 'screen', originAtCapture: 'Martlock', zoneExpected: true,
  });
  const record = await second.finish({
    tip: { name: 'Spindlewood', capNum: null, capMax: null, closes: null,
      timerUncertain: true, raw: { capReads: ['?/?'] } },
    zone: null,
  });
  const third = archive.capture({
    portalFrame: { bytes: 'portal-three', width: 1440, height: 700 }, capturedAt, source: 'traffic', originAtCapture: null,
    screenHeight: 1080, cursor: { x: 720, y: 400 },
  });
  const approximateRecord = await third.finish({
    tip: { name: 'Puros-Amayam', capNum: 4, capMax: 7, capNumApprox: true, closes: 3600 },
  });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(record.reasons, ['timer_unread', 'capacity_unread']);
  assert.deepEqual(approximateRecord.reasons, []);
  assert.deepEqual(approximateRecord.capture, { width: 1440, height: 700, screenHeight: 1080, cursor: { x: 720, y: 400 } });
  assert.equal((await fs.readdir(archive.allDir)).length, 8);
  assert.equal(await fs.readFile(path.join(archive.allDir, `${first.id}_portal.png`), 'utf8'), 'portal-one');
  assert.equal(await fs.readFile(path.join(archive.allDir, `${second.id}_portal.png`), 'utf8'), 'portal-two');
  assert.equal(await fs.readFile(path.join(archive.failedDir, `${second.id}_current-zone.png`), 'utf8'), 'current-zone-two');
  assert.equal(JSON.parse(await fs.readFile(path.join(archive.failedDir, `${second.id}.json`), 'utf8')).result.portalZone, 'Spindlewood');
  assert.deepEqual((await fs.readdir(archive.failedDir)).sort(), [
    `${second.id}.json`, `${second.id}_current-zone.png`, `${second.id}_portal.png`,
  ].sort());
});

test('failed means unread portal data, not approximate occupancy or unknown current zone', () => {
  assert.deepEqual(failureReasons({ tip: null, zoneExpected: false, originAtCapture: 'Thetford' }), ['portal_zone_unread']);
  assert.deepEqual(failureReasons({ tip: { name: 'Puros-Amayam', capNum: 4, capMax: 7,
    capNumApprox: true, closes: 100 }, zoneExpected: false, originAtCapture: null }), []);
  assert.deepEqual(failureReasons({ tip: { name: 'Spindlewood', capNum: null, capMax: 7,
    closes: 100 }, zoneExpected: true, zoneCaptured: true, zone: null }), []);
  assert.deepEqual(failureReasons({ tip: { name: 'Spindlewood', capNum: 4, capMax: 7,
    capMaxKnown: false, closes: 100 } }), ['capacity_unread']);
  assert.deepEqual(failureReasons({ blank: true }), ['blank_capture']);
});

test('captured raw pixels are stored as a readable PNG', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avalon-portal-png-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const archive = createPortalShotArchive(root);
  const attempt = archive.capture({
    portalFrame: { width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]) },
    originAtCapture: 'Martlock', capturedAt: Date.parse('2026-09-25T10:11:12.000Z'),
  });
  await attempt.finish({ tip: { name: 'Spindlewood', capNum: 3, capMax: 7, closes: 3600 } });
  const png = await fs.readFile(path.join(archive.allDir, `${attempt.id}_portal.png`));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
