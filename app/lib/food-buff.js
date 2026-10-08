'use strict';

const catalog = require('../assets/food-effects.json').effects;
const DOTNET_EPOCH_MS = 62135596800000;
const ZONE_SETTLE_MS = 10000;

function startTime(value) {
  try {
    const ticks = BigInt(value);
    const ms = Number(ticks / 10000n) - DOTNET_EPOCH_MS;
    return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
  } catch { return null; }
}

function warningMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(30, Math.round(n))) : 1;
}

function create({ now = Date.now } = {}) {
  let entity = null, zoneAt = 0, observed = false, food = null;
  function join(nextEntity, at = now()) {
    if (entity === nextEntity) return;
    entity = nextEntity;
    zoneAt = at;
    observed = false;
    // Food survives a zone transition, but a new effect list must confirm it.
    food = null;
  }
  function disconnect() { entity = null; zoneAt = 0; observed = false; food = null; }
  function observe(params, at = now()) {
    if (entity === null || Number(params?.[0]) !== entity || !Array.isArray(params[1])) return;
    const ids = params[1];
    // During loading the server emits temporary empty lists. They are not proof of hunger.
    if (!ids.length) { observed = false; return; }
    observed = true;
    const starts = Array.isArray(params[4]) && params[4].length === ids.length ? params[4] : null;
    let best = null;
    for (let i = 0; i < ids.length; i++) {
      const entry = catalog[Number(ids[i])];
      if (!entry || !entry.key.startsWith('FOOD_') || !(entry.duration > 0)) continue;
      const started = starts ? startTime(starts[i]) : null;
      const previous = food?.id === Number(ids[i]) ? food : null;
      const endsAt = started !== null ? started + entry.duration : previous?.endsAt ?? null;
      const candidate = { id: Number(ids[i]), key: entry.key, nameRu: entry.nameRu, nameEn: entry.nameEn,
        duration: entry.duration, endsAt };
      if (!best || candidate.duration > best.duration ||
        (candidate.duration === best.duration && (candidate.endsAt ?? -1) > (best.endsAt ?? -1))) best = candidate;
    }
    food = best;
  }
  function snapshot(minutes = 1, at = now()) {
    const remainingMs = food?.endsAt == null ? null : Math.max(0, food.endsAt - at);
    const settled = entity !== null && observed && at - zoneAt >= ZONE_SETTLE_MS;
    const expired = food?.endsAt != null && food.endsAt <= at;
    const alert = settled && (!food || expired) ? 'missing' : settled && food?.endsAt > at && remainingMs <= warningMinutes(minutes) * 60000 ? 'ending' : null;
    return { known: entity !== null && observed, fed: entity !== null && observed ? !!food && !expired : null,
      food: food && { ...food }, remainingMs, alert, warning: alert !== null };
  }
  return { join, disconnect, observe, snapshot };
}

module.exports = { create, warningMinutes, startTime, ZONE_SETTLE_MS };
