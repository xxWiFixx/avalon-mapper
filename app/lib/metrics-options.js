'use strict';

function normalize(saved = {}) {
  const legacy = saved.metricsEnabled === true;
  return Object.fromEntries(['fameEnabled', 'damageEnabled'].map(key =>
    [key, Object.hasOwn(saved, key) ? saved[key] === true : legacy]));
}

const enabled = config => config.fameEnabled === true || config.damageEnabled === true;
const needsTraffic = (config, collectorActive = false) => config.zoneSource === 'traffic' || enabled(config) || config.foodEnabled === true || collectorActive === true;
function scale(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0.75, Math.min(2.5, Math.round(value * 100) / 100)) : 1;
}

module.exports = { normalize, enabled, needsTraffic, scale };
