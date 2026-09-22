'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, CODE } = require('../lib/combat-metrics');
const { parse, createStream } = require('../lib/combat-protocol');
const { packetMeta } = require('../lib/capture-socket');
const G = n => Array(16).fill(n);
const event = (code, params) => ({ kind: 'event', code, params });
const join = (id = 1, name = 'Me', g = G(1)) => ({ kind: 'response', code: 2, returnCode: 0, params: { 0: id, 1: g, 2: name } });
function session() {
  let time = 100000;
  const m = create({ now: () => time }); m.consume(join());
  return { m, at: t => { time = 100000 + t; }, send: (c, p) => m.consume(event(c, p)) };
}
const hit = (source, amount, target = 99) => ({ 0: target, 2: -amount, 6: source });

test('party spawns and gear received before own Join survive a zone transition', () => {
  const m = create();
  m.consume(join(), 'old-zone');
  m.consume(event(CODE.PartyJoined, { 8: [G(1), G(2)], 9: ['Me', 'Friend'] }), 'old-zone');
  m.consume(event(CODE.NewCharacter, { 0: 22, 1: 'Friend', 7: G(2), 40: [8610] }), 'new-zone');
  m.consume(event(CODE.CharacterEquipmentChanged, { 0: 22, 2: [7631] }), 'new-zone');
  m.consume(event(CODE.NewCharacter, { 0: 33, 1: 'Stranger', 7: G(3), 40: [8610] }), 'new-zone');
  m.consume(event(CODE.HealthUpdate, hit(22, 999)), 'new-zone');
  assert.equal(m.snapshot().totalDamage, 0); // no unconfirmed damage
  m.consume(join(11), 'new-zone');
  assert.equal(m.snapshot().rows.find(r => r.name === 'Friend').weapon.key, 'T8_2H_HOLYSTAFF@3');
  m.consume(event(CODE.HealthUpdate, hit(22, 300)), 'new-zone');
  m.consume(event(CODE.HealthUpdate, hit(33, 999)), 'new-zone');
  m.consume(event(CODE.HealthUpdate, hit(11, 999, 22)), 'new-zone');
  assert.equal(m.snapshot().totalDamage, 300);
  assert.equal(m.snapshot().overall.totalDamage, 300);
});

test('initial party before Join is restored; Leave ordering, stale data and other servers stay excluded', () => {
  let t = 1000; const m = create({ now: () => t });
  const member = (id, n, g) => event(CODE.NewCharacter, { 0: id, 1: n, 7: G(g), 40: [8610] });
  m.consume(member(22, 'Friend', 2), 'new');
  t += 30001;
  m.consume(event(CODE.PartyJoined, { 8: [G(1), G(2)], 9: ['Me', 'Friend'] }), 'new');
  m.consume(member(44, 'Friend', 2), 'other');
  m.consume(member(55, 'Friend', 2), 'new');
  m.consume(event(CODE.Leave, { 0: 55 }), 'new');
  m.consume(join(11), 'new');
  assert.equal(m.snapshot().partyKnown, true);
  for (const id of [22, 44, 55]) m.consume(event(CODE.HealthUpdate, hit(id, 999)), 'new');
  assert.equal(m.snapshot().totalDamage, 0);
  m.consume(member(66, 'Friend', 2), 'new');
  m.consume(event(CODE.HealthUpdate, hit(66, 123)), 'new');
  assert.equal(m.snapshot().totalDamage, 123);
});

test('only own reward: fixed point, premium and satchel; session pauses exclude idle time', () => {
  const { m, send, at } = session();
  send(CODE.UpdateFame, { 0: 2, 2: 9990000n }); assert.equal(m.snapshot().fame, 0);
  send(CODE.UpdateFame, { 0: 1, 2: 1000000n, 5: true, 10: 250000n });
  at(60000); assert.equal(m.snapshot().fame, 175); assert.equal(m.snapshot().famePerHour, 10500);
  m.setPaused(true); at(120000); send(CODE.UpdateFame, { 0: 1, 2: 1000000n });
  assert.equal(m.snapshot().fame, 175); assert.equal(m.snapshot().elapsedMs, 60000);
  m.setPaused(false); at(180000); assert.equal(m.snapshot().elapsedMs, 120000);
});
test('damage accepts self and party only, ignores heals, friendly fire, unknown and malformed sources', () => {
  const { m, send, at } = session();
  send(CODE.PartyJoined, { 8: [G(1), G(2)], 9: ['Me', 'Friend'] });
  send(CODE.NewCharacter, { 0: 2, 1: 'Friend', 7: G(2) });
  send(CODE.NewCharacter, { 0: 3, 1: 'Stranger', 7: G(3) });
  send(CODE.HealthUpdate, hit(1, 100)); at(2000); send(CODE.HealthUpdate, hit(2, 300));
  send(CODE.HealthUpdate, hit(3, 999)); send(CODE.HealthUpdate, hit(9, 999));
  send(CODE.HealthUpdate, hit(1, -300)); send(CODE.HealthUpdate, hit(1, 300, 2));
  send(CODE.HealthUpdate, { 0: 99, 2: -999 }); send(CODE.HealthUpdate, hit(1, NaN));
  const s = m.snapshot(); assert.equal(s.totalDamage, 400); assert.equal(s.partyDps, 200); assert.equal(s.selfDps, 50);
  assert.deepEqual(s.rows.map(r => r.name), ['Friend', 'Me']);
  assert.equal(s.rows.find(r => r.self).name, 'Me');
});
test('noncombat personal fame with a crafting array is not lost or treated as satchel fame', () => {
  const { m, send } = session();
  send(CODE.UpdateFame, { 0: 1, 2: 1000000n, 10: [42, 99] });
  assert.equal(m.snapshot().fame, 100);
});
test('replayed fame rewards count once even in a new UDP command after the transport TTL', () => {
  let t = 0; const m = create({ now: () => t });
  m.feed(packet(body(join()), 1), meta);
  // Same total/reward appeared twice in the 2026-09-10 and 2026-09-12 local recordings.
  const reward = event(CODE.UpdateFame, { 0: 1, 1: 8526299231129n, 2: 1000000n, 5: true });
  m.feed(packet(body(reward), 2), meta);
  t = 70000; m.feed(packet(body(reward), 3), meta);
  assert.equal(m.snapshot().fame, 150);
  m.consume(event(CODE.UpdateFame, { ...reward.params, 1: 8526301231129n }));
  m.consume(event(CODE.UpdateFame, { ...reward.params, 1: 8526300231129n })); // reordered new reward
  assert.equal(m.snapshot().fame, 150); // consume on the wrong peer is ignored
  m.consume(event(CODE.UpdateFame, { ...reward.params, 1: 8526301231129n }), meta.peer);
  m.consume(event(CODE.UpdateFame, { ...reward.params, 1: 8526300231129n }), meta.peer);
  assert.equal(m.snapshot().fame, 450);
});
test('reward deduplication survives pause, reset and reconnect but not a character switch', () => {
  const { m, send } = session();
  const reward = { 0: 1, 1: 9000000n, 2: 1000000n };
  send(CODE.UpdateFame, reward); m.reset(); send(CODE.UpdateFame, reward);
  assert.equal(m.snapshot().fame, 0);
  m.setPaused(true); send(CODE.UpdateFame, { ...reward, 1: 10000000n }); m.setPaused(false);
  send(CODE.UpdateFame, { ...reward, 1: 10000000n }); assert.equal(m.snapshot().fame, 0);
  send(CODE.UpdateFame, { ...reward, 1: 11000000n }); assert.equal(m.snapshot().fame, 100);
  m.disconnect(); m.consume(join(10));
  send(CODE.UpdateFame, { ...reward, 0: 10, 1: 11000000n }); assert.equal(m.snapshot().fame, 100);
  m.disconnect(); m.consume(join(10, 'Other', G(2)));
  assert.equal(m.snapshot().fame, 0);
  send(CODE.UpdateFame, { ...reward, 0: 10 }); assert.equal(m.snapshot().fame, 100);
  m.consume(join(10, 'RenamedOther', G(2))); assert.equal(m.snapshot().fame, 100);
});
test('fame applies a reduction once; positive bonus is already included in the reward', () => {
  const { m, send } = session();
  send(CODE.UpdateFame, { 0: 1, 2: 1000000n, 5: true, 10: 250000n, 17: -0.2 });
  assert.equal(m.snapshot().fame, 140);
  send(CODE.UpdateFame, { 0: 1, 2: 1000000n, 5: true, 10: 250000n, 17: 0.2 });
  assert.equal(m.snapshot().fame, 315);
});
test('weapon icons track own gear before Join and party gear before their first hit', () => {
  const m = create();
  m.consume(event(CODE.CharacterEquipmentChanged, { 0: 1, 2: [8610, 0] }));
  m.consume(join());
  assert.equal(m.snapshot().rows[0].weapon.key, 'T4_MAIN_SWORD');
  m.consume(event(CODE.PartyJoined, { 8: [G(1), G(2)], 9: ['Me', 'Friend'] }));
  m.consume(event(CODE.NewCharacter, { 0: 2, 1: 'Friend', 7: G(2), 40: [7631, 0] }));
  m.consume(event(CODE.NewCharacter, { 0: 3, 1: 'Stranger', 7: G(3), 40: [8610, 0] }));
  let rows = m.snapshot().rows;
  assert.equal(rows.length, 2); assert.equal(rows[1].weapon.key, 'T8_2H_HOLYSTAFF@3');
  assert.match(rows[1].weapon.name, /T8\.3$/);
  m.consume(event(CODE.HealthUpdate, hit(2, 100)));
  m.consume(event(CODE.CharacterEquipmentChanged, { 0: 2, 2: [8610, 0] }));
  assert.equal(m.snapshot().rows[0].weapon.key, 'T4_MAIN_SWORD');
  m.consume(event(CODE.CharacterEquipmentChanged, { 0: 2, 2: [0, 0] }));
  rows = m.snapshot().rows; assert.equal(rows[0].weapon, null); assert.equal(rows[0].weaponId, 0);
  m.consume(event(CODE.CharacterEquipmentChanged, { 0: 2, 2: [-1] }));
  assert.equal(m.snapshot().rows[0].weaponId, 0);
  m.consume(event(CODE.CharacterEquipmentChanged, { 0: 2, 2: [999999] }));
  assert.equal(m.snapshot().rows[0].weapon, null);
  assert.equal(m.snapshot().rows[0].damage, 100);
});
test('equipment from another connection, stale pre-Join data and recycled IDs cannot change own weapon', () => {
  const { m, send, at } = session();
  send(CODE.CharacterEquipmentChanged, { 0: 1, 2: [8610] });
  m.consume(event(CODE.CharacterEquipmentChanged, { 0: 1, 2: [7631] }), 'other');
  assert.equal(m.snapshot().rows[0].weapon.key, 'T4_MAIN_SWORD');
  send(CODE.CharacterEquipmentChanged, { 0: 10, 2: [7631] });
  m.consume(join(10));
  assert.equal(m.snapshot().rows[0].weapon.key, 'T8_2H_HOLYSTAFF@3');
  send(CODE.CharacterEquipmentChanged, { 0: 1, 2: [8610] });
  at(31000); m.consume(join(1)); assert.equal(m.snapshot().rows[0].weapon, null);
  m.disconnect(); m.consume(join(1, 'Other', G(2))); assert.equal(m.snapshot().rows[0].weapon, null);
});
test('batch health changes preserve sparse indices and ignore incoming healing', () => {
  const { m, send } = session();
  send(CODE.HealthUpdates, { 0: 99, 2: { 0: -100, 3: -200, 5: 100 }, 6: { 0: 1, 3: 1, 5: 1 } });
  send(CODE.HealthUpdates, { 0: 99, 2: [-99], 6: [] });
  assert.equal(m.snapshot().totalDamage, 300);
});
test('new fight after gap; pause cannot add damage; reset retains identity and clears totals', () => {
  const { m, send, at } = session();
  send(CODE.HealthUpdate, hit(1, 100)); at(2000); send(CODE.HealthUpdate, hit(1, 300));
  at(13000); assert.equal(m.snapshot().inCombat, false); assert.equal(m.snapshot().partyDps, 200);
  send(CODE.HealthUpdate, hit(1, 50)); assert.equal(m.snapshot().totalDamage, 50);
  m.setPaused(true); send(CODE.HealthUpdate, hit(1, 999)); assert.equal(m.snapshot().totalDamage, 50);
  m.reset(); assert.equal(m.snapshot().selfName, 'Me'); assert.equal(m.snapshot().fame, 0); assert.equal(m.snapshot().totalDamage, 0);
});

test('overall adds fights once and uses their combined combat time without gaps or paused damage', () => {
  const { m, send, at } = session();
  send(CODE.PartyJoined, { 8: [G(1), G(2)], 9: ['Me', 'Friend'] });
  send(CODE.NewCharacter, { 0: 2, 1: 'Friend', 7: G(2) });
  send(CODE.HealthUpdate, hit(1, 100)); at(2000); send(CODE.HealthUpdate, hit(2, 300));
  at(13000); send(CODE.HealthUpdate, hit(1, 50));
  let s = m.snapshot();
  assert.equal(s.totalDamage, 50); assert.equal(s.overall.totalDamage, 450);
  assert.equal(s.overall.durationMs, 3000); assert.equal(s.overall.partyDps, 150);
  assert.equal(s.overall.selfDps, 50); assert.equal(s.overall.segments, 2);
  at(15000); send(CODE.HealthUpdate, hit(1, 150));
  s = m.snapshot(); assert.equal(s.totalDamage, 200); assert.equal(s.overall.totalDamage, 600);
  assert.equal(s.overall.durationMs, 4000); assert.equal(s.overall.partyDps, 150);
  m.setPaused(true); at(18000); send(CODE.HealthUpdate, hit(1, 999));
  assert.equal(m.snapshot().overall.totalDamage, 600);
  m.setPaused(false); at(20000); send(CODE.HealthUpdate, hit(1, 100));
  s = m.snapshot(); assert.equal(s.totalDamage, 100); assert.equal(s.overall.totalDamage, 700);
  assert.equal(s.overall.durationMs, 5000); assert.equal(s.overall.segments, 3);
  at(100000); assert.equal(m.snapshot().overall.durationMs, 5000);
});

test('overall retains former party members, excludes their later hits, and survives own zone IDs and reconnects', () => {
  const { m, send } = session();
  send(CODE.PartyJoined, { 8: [G(1), G(2)], 9: ['Me', 'Friend'] });
  send(CODE.NewCharacter, { 0: 2, 1: 'Friend', 7: G(2), 40: [8610] });
  send(CODE.HealthUpdate, hit(2, 300)); send(CODE.HealthUpdate, hit(1, 100));
  send(CODE.CharacterEquipmentChanged, { 0: 2, 2: [7631] });
  assert.equal(m.snapshot().overall.rows.find(r => r.name === 'Friend').weaponId, 7631);
  send(CODE.PartyPlayerLeft, { 1: G(2) }); send(CODE.HealthUpdate, hit(2, 999));
  m.consume(join(10)); send(CODE.HealthUpdate, hit(10, 50));
  m.disconnect(); m.consume(join(20)); send(CODE.HealthUpdate, hit(20, 25));
  const s = m.snapshot(); assert.equal(s.totalDamage, 25); assert.equal(s.overall.totalDamage, 475);
  assert.deepEqual(s.overall.rows.map(r => [r.name, r.damage]), [['Friend', 300], ['Me', 175]]);
});

test('reset and a different character clear both damage periods without mixing sessions', () => {
  const { m, send } = session();
  send(CODE.HealthUpdate, hit(1, 100)); m.reset();
  let s = m.snapshot(); assert.equal(s.overall.totalDamage, 0); assert.equal(s.overall.durationMs, 0);
  assert.equal(s.overall.segments, 0); assert.equal(s.totalDamage, 0);
  send(CODE.HealthUpdate, hit(1, 50)); m.disconnect(); m.consume(join(1, 'Other', G(9)));
  s = m.snapshot(); assert.equal(s.overall.totalDamage, 0); assert.equal(s.totalDamage, 0);
  send(CODE.HealthUpdate, hit(1, 25)); assert.equal(m.snapshot().overall.totalDamage, 25);
  assert.deepEqual(m.snapshot().overall.rows.map(r => r.name), ['Other']);
});
test('party membership packed GUIDs, departure, disband and new zone entity IDs', () => {
  const { m, send, at } = session();
  send(CODE.PartyJoined, { 8: [...G(1), ...G(2)], 9: ['Me', 'Friend'] });
  assert.equal(m.snapshot().partySize, 2);
  m.consume(join(10));
  send(CODE.NewCharacter, { 0: 20, 1: 'Friend', 7: G(2) });
  send(CODE.HealthUpdate, hit(20, 200));
  send(CODE.HealthUpdate, hit(1, 999)); // old self id is no longer self
  assert.equal(m.snapshot().totalDamage, 200);
  send(CODE.PartyPlayerLeft, { 1: G(2) }); at(1000);
  send(CODE.HealthUpdate, hit(10, 50)); send(CODE.HealthUpdate, hit(20, 999));
  assert.equal(m.snapshot().totalDamage, 50);
  send(CODE.PartyDisbanded, {}); assert.equal(m.snapshot().partySize, 0);
});
test('join failures, another connection, malformed membership and unknown identity fail closed', () => {
  const m = create(); m.consume(event(CODE.HealthUpdate, hit(1, 200)));
  m.consume({ ...join(), returnCode: 1 }); assert.equal(m.snapshot().selfName, null);
  m.consume(join());
  m.consume(event(CODE.PartyJoined, { 8: [G(1)], 9: ['Me', 'Other'] })); assert.equal(m.snapshot().partyKnown, false);
  m.consume(event(CODE.HealthUpdate, hit(1, 999)), 'old-server'); assert.equal(m.snapshot().totalDamage, 0);
  m.disconnect(); m.consume(event(CODE.HealthUpdate, hit(1, 999))); assert.equal(m.snapshot().totalDamage, 0);
});

// Wire fixtures generated from Protocol18 types, including real parameter layouts.
function vint(n) { const a = []; do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function value(v) {
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([Buffer.from([7]), vint(BigInt(b.length)), b]); }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from([23]), vint(BigInt(v.length)), ...v.map(value)]);
  if (typeof v === 'boolean') return Buffer.from([v ? 28 : 27]);
  const big = BigInt(v); return Buffer.concat([Buffer.from([typeof v === 'bigint' ? 10 : 9]), vint(big >= 0 ? big * 2n : -big * 2n - 1n)]);
}
function body(m) {
  const p = { ...m.params, [m.kind === 'response' ? 253 : 252]: m.code };
  const table = Buffer.concat([vint(BigInt(Object.keys(p).length)), ...Object.entries(p).map(([k, v]) => Buffer.concat([Buffer.from([+k]), value(v)]))]);
  return Buffer.concat([Buffer.from(m.kind === 'response' ? [243, 3, 1, 0, 0, 8] : [243, 4, 1]), table]);
}
function packet(b, seq = 1, type = 6, channel = 0) {
  const h = Buffer.alloc(24); h[3] = 1; h[12] = type; h[13] = channel; h.writeUInt32BE(b.length + 12, 16); h.writeUInt32BE(seq, 20);
  return Buffer.concat([h, b]);
}
const meta = { incoming: true, peer: 'server:5056>client:32100' };
test('end-to-end wire decoding: repeated UDP commands count once, identical distinct hits count twice', () => {
  const m = create(); m.feed(packet(body(join()), 1), meta);
  const b = body(event(CODE.HealthUpdate, hit(1, 100)));
  m.feed(packet(b, 2), meta); m.feed(packet(b, 2), meta); m.feed(packet(b, 3), meta);
  assert.equal(m.snapshot().totalDamage, 200);
  const f = packet(body(event(CODE.UpdateFame, { 0: 1, 2: 1000000n })), 4);
  m.feed(f, meta); m.feed(f, meta); assert.equal(m.snapshot().fame, 100);
  m.reset(); m.feed(f, meta); assert.equal(m.snapshot().fame, 0);
  m.feed(packet(b, 5), { ...meta, incoming: false }); assert.equal(m.snapshot().totalDamage, 0);
});
function fragment(data, start, no, count, size, off, seq) {
  const h = Buffer.alloc(20); [start, count, no, size, off].forEach((n, i) => h.writeUInt32BE(n, i * 4));
  return packet(Buffer.concat([h, data]), seq, 8);
}
test('fragmented Join is reassembled out of order; duplicate interfaces cannot duplicate the event', () => {
  const s = createStream(), b = body(join()), split = 18;
  const a = fragment(b.subarray(0, split), 10, 0, 2, b.length, 0, 10);
  const z = fragment(b.subarray(split), 10, 1, 2, b.length, split, 11);
  assert.deepEqual(s.feed(z, 'a'), []); assert.deepEqual(s.feed(z, 'a'), []);
  const result = s.feed(a, 'a'); assert.equal(result[0].params[2], 'Me');
  assert.deepEqual(s.feed(a, 'a'), []); assert.equal(s.pendingCount(), 0);
});
test('fragments cannot mix peers or overlapping offsets; malformed messages and encrypted packets ignored', () => {
  const s = createStream(), b = body(join());
  assert.deepEqual(s.feed(fragment(b.subarray(0, 20), 10, 0, 2, b.length, 0, 10), 'a'), []);
  assert.deepEqual(s.feed(fragment(b.subarray(20), 10, 1, 2, b.length, 20, 11), 'b'), []);
  assert.deepEqual(s.feed(fragment(b.subarray(20), 10, 1, 2, b.length, 19, 12), 'a'), []);
  assert.equal(parse(b.subarray(0, b.length - 1)), null);
  assert.equal(parse(Buffer.concat([b, Buffer.from([0])])), null);
  const encrypted = packet(b); encrypted[2] = 1; assert.deepEqual(s.feed(encrypted, 'a'), []);
});
test('UDP metadata identifies incoming flow without confusing network interfaces', () => {
  const b = Buffer.alloc(28); b[0] = 0x45; b[9] = 17; b.set([1, 2, 3, 4], 12); b.set([5, 6, 7, 8], 16);
  b.writeUInt16BE(5056, 20); b.writeUInt16BE(1234, 22);
  assert.deepEqual(packetMeta(b, 28), { incoming: true, peer: '1.2.3.4:5056>5.6.7.8:1234' });
  b.writeUInt16BE(1234, 20); assert.equal(packetMeta(b, 28).incoming, false);
  b[6] = 0x20; assert.equal(packetMeta(b, 28), null);
});
test('zone watcher fans packets to metrics even without a zone transition', () => {
  const calls = [];
  const watcher = require('../lib/zone-watch').create({ onPacket: (p, m) => calls.push(m) });
  watcher.feed(packet(body(event(CODE.HealthUpdate, hit(1, 10)))), meta);
  assert.equal(calls[0], meta);
});
test('partial Market and Bank cannot invent a city; complete market name beats city prefix', () => {
  const match = require('../lib/recognize')._internal.fuzzyFromLine;
  assert.equal(match('Market'), null); assert.equal(match('Bank'), null);
  assert.equal(match('Brecilien Market 05:40').name, 'Brecilien Market');
  assert.equal(match('Caerleon Market').name, 'Caerleon Market');
  assert.equal(match('Brecilien').name, 'Brecilien');
});

test('metrics-only traffic listener does not overwrite manually selected zone', async () => {
  const fs = require('fs'), vm = require('vm'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  let callbacks, packets = 0;
  const context = vm.createContext({
    config: { zoneSource: 'off', fameEnabled: true, damageEnabled: true }, quitting: false, zoneRevision: 0, zoneFromTraffic: false,
    metricsOptions: require('../lib/metrics-options'),
    privileges: { isElevated: async () => true },
    combat: { disconnect() {}, feed() { packets++; } },
    zoneTraffic: { create: options => { callbacks = options; return { start: () => ({ listening: [], failed: [] }), stop() {} }; } },
    trafficHealth: { createHealth: () => ({ reset() {} }) }, captureSocket: {},
    console: { log() {}, warn() {}, error() {} }, send() {}, pushConfig() {},
    applyZone: () => assert.fail('metrics changed the manual zone'),
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(src.slice(src.indexOf('let traffic = null;'), src.indexOf('// Единственное место, где включается')), context);
  assert.equal(await context.startTraffic(), true);
  callbacks.onZone({ zone: 'Another' }); callbacks.onPacket(Buffer.alloc(0), meta);
  assert.equal(packets, 1);
  context.stopTraffic(); callbacks.onPacket(Buffer.alloc(0), meta); assert.equal(packets, 1);
});

test('fame and damage overlays have sandboxed preloads and close independently without resetting counters', () => {
  const fs = require('fs'), vm = require('vm'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), windows = [];
  class Window {
    constructor(options) { this.options = options; this.handlers = {}; this.messages = []; this.webContents = { setWindowOpenHandler() {}, on() {}, send: (channel, data) => this.messages.push({ channel, data }) }; windows.push(this); }
    setAlwaysOnTop() {} once(k, cb) { this.handlers[k] = cb; } on(k, cb) { this.handlers[k] = cb; }
    loadFile(p, options) { this.file = p; this.query = options.query; } isDestroyed() { return !!this.closed; } showInactive() { this.shown = true; }
    close() { this.closed = true; this.handlers.closed(); }
    setResizable(value) { this.resizable = value; } setMovable(value) { this.movable = value; }
    setIgnoreMouseEvents(value) { this.ignoring = value; }
    getBounds() { return { x: this.options.x, y: this.options.y, width: this.options.width, height: this.options.height }; }
    setBounds(value) { Object.assign(this.options, value); }
  }
  const metrics = { snapshot: () => ({ fame: 12345, totalDamage: 6789 }), reset: () => assert.fail('closing an overlay reset the session') };
  const handlers = {}, mainContents = {};
  const context = vm.createContext({ combatMetrics: { create: () => metrics }, BrowserWindow: Window,
    metricsWindowControls: require('../lib/metrics-window-controls'),
    config: { theme: 'dark', fameEnabled: true, damageEnabled: true }, traffic: null, trafficError: null, send() {},
    metricsOptions: require('../lib/metrics-options'),
    path, __dirname: path.join(__dirname, '..'), webPrefs: require('../lib/win-prefs').webPrefs,
    screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0 } }) },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: (name, fn) => { handlers[name] = fn; } }, win: { webContents: mainContents },
  });
  vm.runInContext(src.slice(src.indexOf('const combat = combatMetrics.create(config);'), src.indexOf('let traffic = null;')), context);
  vm.runInContext(src.slice(src.indexOf("ipcMain.handle('get-metrics'"), src.indexOf('// dev включает блок')), context);
  const action = (sender, value) => handlers['metrics-action']({ sender }, value);
  assert.equal(action({}, 'overlay-fame').ok, false);
  assert.equal(action(mainContents, 'overlay-fame').ok, true);
  assert.equal(action(mainContents, 'overlay-damage').ok, true);
  assert.equal(windows.length, 2);
  const [fame, damage] = windows;
  for (const w of windows) {
    assert.equal(w.options.webPreferences.sandbox, true);
    assert.ok(w.options.webPreferences.preload.endsWith('preload-metrics.js'));
    assert.ok(w.file.endsWith('metrics.html'));
    w.handlers['ready-to-show'](); assert.equal(w.shown, true);
    assert.equal(w.messages.at(-1).data.fame, 12345);
  }
  assert.equal(fame.query.kind, 'fame'); assert.equal(damage.query.kind, 'damage');
  assert.equal(fame.options.resizable, false); assert.equal(damage.options.resizable, true);
  action(mainContents, 'segment-overall'); assert.equal(context.metricsSnapshot().damageSegment, 'overall');
  action(mainContents, 'segment-current'); assert.equal(context.metricsSnapshot().damageSegment, 'current');
  action(damage.webContents, 'lock-damage');
  assert.equal(context.metricsSnapshot().damageLocked, true); assert.equal(damage.resizable, false);
  assert.equal(damage.movable, false); assert.equal(damage.ignoring, true);
  handlers['metrics-pointer']({ sender: fame.webContents }, true); assert.equal(damage.ignoring, true);
  handlers['metrics-pointer']({ sender: damage.webContents }, true); assert.equal(damage.ignoring, false);
  assert.equal(handlers['metrics-resize']({ sender: damage.webContents }, 'se').ok, false);
  assert.equal(handlers['metrics-resize']({ sender: fame.webContents }, 'se').ok, false);
  action(mainContents, 'lock-damage'); assert.equal(damage.movable, true); assert.equal(damage.resizable, true);
  assert.ok(damage.options.y >= fame.options.y + fame.options.height);
  action(mainContents, 'overlay-fame');
  assert.equal(fame.closed, true); assert.equal(damage.isDestroyed(), false);
  assert.equal(context.metricsSnapshot().overlays.fame, false);
  assert.equal(context.metricsSnapshot().overlays.damage, true);
  assert.equal(context.metricsSnapshot().fame, 12345);
  action(mainContents, 'overlay-fame');
  const reopened = windows[2];
  fame.handlers.closed(); // A late callback from the old window cannot clear its replacement.
  assert.equal(context.metricsSnapshot().overlays.fame, true);
  action(damage.webContents, 'close-overlay');
  assert.equal(damage.closed, true); assert.equal(reopened.isDestroyed(), false);
  assert.equal(context.metricsSnapshot().overlays.damage, false);
  assert.equal(context.metricsSnapshot().totalDamage, 6789);
  assert.equal(action(mainContents, 'close-overlay').ok, false);
  assert.equal(action(fame.webContents, 'overlay-damage').ok, false);
});
