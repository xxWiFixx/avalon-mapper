'use strict';

const protocol = require('./combat-protocol');
const weapons = require('./weapons');
// Verified against the current EventCodes enum; field references in docs/combat-metrics.md.
const CODE = Object.freeze({ Leave: 1, HealthUpdate: 6, HealthUpdates: 7, NewCharacter: 29,
  UpdateFame: 82, CharacterEquipmentChanged: 90, PartyJoined: 231, PartyDisbanded: 232, PartyPlayerJoined: 233, PartyPlayerLeft: 235 });
const GAP_MS = 10000;
const number = v => typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN;
const id = v => Number.isSafeInteger(number(v)) && number(v) >= 0 ? number(v) : null;
const name = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 100 ? v.trim() : null;
const mainHand = v => Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every(x => id(x) !== null) ? id(v[0]) : null;
const counter = v => typeof v === 'bigint' && v >= 0n ? String(v) : Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
function guid(v) {
  if (v && Buffer.isBuffer(v.bytes)) v = v.bytes;
  if ((!Array.isArray(v) && !Buffer.isBuffer(v)) || v.length !== 16 || !Array.from(v).every(n => Number.isInteger(n) && n >= -128 && n <= 255)) return null;
  const b = Buffer.from(v); return b.some(n => n !== 0) ? b.toString('hex') : null;
}
function roster(p) {
  // Current layout 8/9; old recordings use 4/5. Accept only complete typed lists.
  for (const [g, n] of [[8, 9], [4, 5]]) {
    let ids = p[g], names = p[n];
    if (!Array.isArray(names) || names.length > 20 || !names.every(v => name(v))) continue;
    if ((Array.isArray(ids) || Buffer.isBuffer(ids)) && ids.length === names.length * 16 && Array.from(ids).every(v => typeof v === 'number')) {
      ids = Array.from({ length: names.length }, (_, i) => ids.slice(i * 16, i * 16 + 16));
    }
    if (!Array.isArray(ids) || ids.length !== names.length) continue;
    const pairs = ids.map((v, i) => [guid(v), name(names[i])]);
    if (pairs.every(([g]) => g)) return new Map(pairs);
  }
  return null;
}

function create({ now = Date.now, fameEnabled = true, damageEnabled = true } = {}) {
  const stream = protocol.createStream();
  let self = null, peer = null, entities = new Map(), party = new Map(), partyKnown = false;
  let fame = 0, startedAt = null, pausedAt = fameEnabled ? null : now(), pausedMs = 0, paused = false;
  const fameStopped = () => paused || !fameEnabled;
  let fight = null, newFight = false, lastPacketAt = null, lastEventAt = null;
  const overallRows = new Map();
  let completedCombatMs = 0, segments = 0;
  const fightDuration = () => fight ? Math.max(1000, fight.lastAt - fight.startedAt) : 0;
  // Character identity and reward deduplication survive capture reconnects and Reset.
  let sessionCharacter = null;
  const seenRewards = new Set(), pendingEquipment = new Map();
  const pendingIdentity = new Map();

  // On a zone change the server can announce nearby characters and the party
  // before replying to our Join. Retain only identity/gear, scoped to that server;
  // never count damage or fame from an unconfirmed connection.
  function stageIdentity(m, connection, t) {
    const p = m.params || {}, fields = {};
    if (m.code === CODE.NewCharacter) {
      if (id(p[0]) === null || !name(p[1])) return;
      Object.assign(fields, { 0: id(p[0]), 1: name(p[1]), 7: guid(p[7]) ? Buffer.from(guid(p[7]), 'hex') : null,
        40: mainHand(p[40]) === null ? [] : [mainHand(p[40])] });
    } else if (m.code === CODE.CharacterEquipmentChanged) {
      if (id(p[0]) === null || mainHand(p[2]) === null) return;
      Object.assign(fields, { 0: id(p[0]), 2: [mainHand(p[2])] });
    } else if (m.code === CODE.Leave) {
      if (id(p[0]) === null) return;
      fields[0] = id(p[0]);
    } else if (m.code === CODE.PartyJoined) {
      const members = roster(p); if (!members) return;
      fields[8] = [...members.keys()].map(g => Buffer.from(g, 'hex'));
      fields[9] = [...members.values()];
    } else if (m.code === CODE.PartyPlayerJoined) {
      if (!guid(p[1]) || !name(p[2])) return;
      Object.assign(fields, { 1: Buffer.from(guid(p[1]), 'hex'), 2: name(p[2]) });
    } else if (m.code === CODE.PartyPlayerLeft) {
      if (!guid(p[1])) return;
      fields[1] = Buffer.from(guid(p[1]), 'hex');
    } else if (m.code !== CODE.PartyDisbanded) return;
    for (const [key, events] of pendingIdentity) if (t - events[events.length - 1].at > 30000) pendingIdentity.delete(key);
    if (!pendingIdentity.has(connection)) {
      if (pendingIdentity.size >= 4) pendingIdentity.delete(pendingIdentity.keys().next().value);
      pendingIdentity.set(connection, []);
    }
    const events = pendingIdentity.get(connection);
    if (events.length >= 1024) events.shift();
    events.push({ m: { kind: 'event', code: m.code, params: fields }, at: t });
  }

  function reset() {
    fame = 0; startedAt = null; pausedMs = 0; pausedAt = fameStopped() ? now() : null;
    fight = null; newFight = false;
    overallRows.clear(); completedCombatMs = 0; segments = 0;
    // Keep identity, membership and transport deduplication on session reset.
  }
  function updateFameClock(wasStopped) {
    if (wasStopped === fameStopped()) return;
    const t = now();
    if (fameStopped()) pausedAt = t;
    else { if (startedAt !== null) pausedMs += t - pausedAt; pausedAt = null; }
  }
  function setPaused(value) {
    if (!!value === paused) return;
    const wasStopped = fameStopped();
    paused = !!value;
    updateFameClock(wasStopped); newFight = true;
  }
  function setEnabled(options) {
    const wasStopped = fameStopped();
    if (damageEnabled !== options.damageEnabled) newFight = true;
    fameEnabled = options.fameEnabled === true;
    damageEnabled = options.damageEnabled === true;
    updateFameClock(wasStopped);
  }
  function disconnect() {
    self = null; peer = null; entities.clear(); party.clear(); partyKnown = false;
    stream.reset(); lastPacketAt = null; newFight = true;
    pendingEquipment.clear();
    pendingIdentity.clear();
  }
  function actor(entity) {
    if (self && entity === self.id) return { ...self, self: true };
    const a = entities.get(entity);
    if (!a) return null;
    if (a.guid ? party.has(a.guid) : [...party.values()].includes(a.name)) return a;
    return null;
  }
  function damage(source, target, delta, t) {
    if (!damageEnabled || paused || !self || !Number.isFinite(delta) || delta >= 0 || source === null || target === null || source === target) return;
    const a = actor(source);
    if (!a || actor(target)) return; // outgoing damage; friendly fire excluded
    if (!fight || newFight || t - fight.lastAt > GAP_MS) {
      completedCombatMs += fightDuration(); segments++;
      fight = { startedAt: t, lastAt: t, rows: new Map() }; newFight = false;
    }
    const key = a.guid || a.name;
    for (const rows of [fight.rows, overallRows]) {
      const row = rows.get(key) || rows.get(a.name) || { name: a.name, self: !!a.self, damage: 0 };
      if (key !== a.name) rows.delete(a.name);
      row.name = a.name; row.weaponId = a.weaponId;
      row.damage += -delta;
      rows.set(key, row);
    }
    fight.lastAt = t;
  }
  function consume(m, connection = 'test', t = now()) {
    const p = m.params || {};
    // Own equipment can arrive before the Join response (also on zone changes).
    if (m.kind === 'event' && m.code === CODE.CharacterEquipmentChanged && id(p[0]) !== null && mainHand(p[2]) !== null) {
      const key = connection + ':' + id(p[0]);
      pendingEquipment.delete(key);
      pendingEquipment.set(key, { weaponId: mainHand(p[2]), at: t });
      if (pendingEquipment.size > 256) pendingEquipment.delete(pendingEquipment.keys().next().value);
    }
    if (m.kind === 'response') {
      if (m.code !== 2 || m.returnCode !== 0 || id(p[0]) === null || !name(p[2])) return;
      const next = { id: id(p[0]), name: name(p[2]), guid: guid(p[1]) };
      const changed = sessionCharacter && (next.guid && sessionCharacter.guid
        ? next.guid !== sessionCharacter.guid : next.name !== sessionCharacter.name);
      if (changed) { reset(); seenRewards.clear(); party.clear(); partyKnown = false; }
      sessionCharacter = { name: next.name, guid: next.guid };
      const held = pendingEquipment.get(connection + ':' + next.id);
      next.weaponId = held && t - held.at <= 30000 ? held.weaponId
        : !changed && peer === connection && self?.id === next.id ? self.weaponId : null;
      pendingEquipment.clear();
      if (peer !== connection || !self || next.id !== self.id) { entities.clear(); newFight = true; }
      self = next; peer = connection; lastEventAt = t;
      const staged = pendingIdentity.get(connection) || [];
      pendingIdentity.clear();
      for (const entry of staged) if (t - entry.at <= 30000) consume(entry.m, connection, entry.at);
      return;
    }
    if (m.kind !== 'event') return;
    if (!self || peer !== connection) { stageIdentity(m, connection, t); return; }
    switch (m.code) {
      case CODE.NewCharacter:
        if (id(p[0]) !== null && name(p[1])) {
          if (entities.size >= 4096) entities.delete(entities.keys().next().value);
          const entity = { id: id(p[0]), name: name(p[1]), guid: guid(p[7]), weaponId: mainHand(p[40]) };
          entities.set(entity.id, entity);
          if (entity.id === self.id) self.weaponId = entity.weaponId;
          for (const rows of [fight?.rows, overallRows]) {
            const row = rows?.get(entity.guid || entity.name) || rows?.get(entity.name);
            if (row) row.weaponId = entity.weaponId;
          }
        }
        break;
      case CODE.CharacterEquipmentChanged: {
        const weaponId = mainHand(p[2]), entityId = id(p[0]);
        if (weaponId === null) break;
        const entity = entityId === self.id ? self : entities.get(entityId);
        if (entity) {
          entity.weaponId = weaponId;
          for (const rows of [fight?.rows, overallRows]) {
            const row = rows?.get(entity.guid || entity.name) || rows?.get(entity.name);
            if (row) row.weaponId = weaponId;
          }
        }
        break;
      }
      case CODE.Leave:
        entities.delete(id(p[0]));
        break;
      case CODE.PartyJoined: {
        const next = roster(p);
        if (next) { party = next; partyKnown = true; newFight = true; }
        break;
      }
      case CODE.PartyPlayerJoined:
        if (guid(p[1]) && name(p[2]) && party.size < 20) { party.set(guid(p[1]), name(p[2])); newFight = true; }
        break;
      case CODE.PartyPlayerLeft:
        if (!guid(p[1])) break;
        if (self && (guid(p[1]) === self.guid || party.get(guid(p[1])) === self.name)) { party.clear(); partyKnown = false; }
        else party.delete(guid(p[1]));
        newFight = true;
        break;
      case CODE.PartyDisbanded:
        party.clear(); partyKnown = false; newFight = true;
        break;
      case CODE.UpdateFame: {
        if (id(p[0]) !== self.id) break;
        const base = number(p[2]) / 10000;
        // Crafting can use p10 for an array; that is not a satchel reward.
        const satchel = typeof p[10] === 'number' || typeof p[10] === 'bigint' ? number(p[10]) / 10000 : 0;
        if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(satchel) || satchel < 0) break;
        // Server reward, including premium and satchel. Never sum equipment fame events.
        // Positive p17 bonuses are already in the reward; a negative value is a reduction.
        const factor = typeof p[17] === 'number' && p[17] >= -1 && p[17] < 0 ? 1 + p[17] : 1;
        const gain = (base * (p[5] === true ? 1.5 : 1) + satchel) * factor;
        const total = counter(p[1]);
        if (total !== null) {
          // Use the server's lifetime counter as a reward identity, not as a gain:
          // its delta need not include premium/satchel. Equal-size new rewards still count.
          const key = [total, String(p[2]), p[5] === true, satchel, factor].join(':');
          if (seenRewards.has(key)) break;
          seenRewards.add(key);
          if (seenRewards.size > 8192) seenRewards.delete(seenRewards.values().next().value);
        }
        // Observe rewards on pause too, so their replays cannot enter the next session.
        if (fameStopped() || gain <= 0) break;
        if (startedAt === null) { startedAt = t; pausedMs = 0; }
        fame += gain; lastEventAt = t;
        break;
      }
      case CODE.HealthUpdate:
        if (!damageEnabled) break;
        damage(id(p[6]), id(p[0]), number(p[2]), t); lastEventAt = t;
        break;
      case CODE.HealthUpdates: {
        if (!damageEnabled) break;
        const deltas = p[2], sources = p[6];
        // Arrays and sparse dictionaries use matching indices, never Object.values pairing.
        if (!deltas || !sources || typeof deltas !== 'object' || typeof sources !== 'object') break;
        for (const k of Object.keys(deltas).slice(0, 4096)) {
          if (/^\d+$/.test(k) && Object.hasOwn(sources, k)) damage(id(sources[k]), id(p[0]), number(deltas[k]), t);
        }
        lastEventAt = t;
        break;
      }
    }
  }
  function feed(payload, meta) {
    if (!meta || !meta.incoming || !meta.peer) return;
    const t = now(); lastPacketAt = t;
    for (const m of stream.feed(payload, meta.peer, t)) consume(m, meta.peer, t);
  }
  function damageSnapshot(source, durationMs) {
    const rows = source ? [...source.values()].map(r => ({ ...r, dps: durationMs ? r.damage * 1000 / durationMs : 0 })) : [];
    if (self && !rows.some(r => r.self)) rows.push({ name: self.name, self: true, weaponId: self.weaponId, damage: 0, dps: 0 });
    for (const [g, n] of party) if (!rows.some(r => r.name === n)) {
      const entity = [...entities.values()].find(a => a.guid === g || (!a.guid && a.name === n));
      rows.push({ name: n, self: !!self && n === self.name, weaponId: entity?.weaponId, damage: 0, dps: 0 });
    }
    rows.sort((a, b) => b.damage - a.damage || Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
    const totalDamage = rows.reduce((s, r) => s + r.damage, 0);
    return { durationMs, totalDamage, partyDps: durationMs ? totalDamage * 1000 / durationMs : 0,
      selfDps: rows.find(r => r.self)?.dps || 0,
      rows: rows.map(r => ({ ...r, weapon: weapons.lookup(r.weaponId) })) };
  }
  function snapshot() {
    const t = now(), elapsedMs = startedAt === null ? 0 : Math.max(0, (fameStopped() ? pausedAt : t) - startedAt - pausedMs);
    return { paused, selfName: self && self.name, partyKnown, partySize: party.size, fame, elapsedMs,
      famePerHour: elapsedMs >= 1000 ? fame * 3600000 / elapsedMs : null,
      ...damageSnapshot(fight?.rows, fightDuration()),
      overall: { ...damageSnapshot(overallRows, completedCombatMs + fightDuration()), segments },
      inCombat: damageEnabled && !!fight && !paused && !newFight && t - fight.lastAt <= GAP_MS,
      lastPacketAt, lastEventAt };
  }
  return { feed, consume, snapshot, reset, setPaused, setEnabled, disconnect };
}

module.exports = { create, CODE, GAP_MS };
