'use strict';

function normalize(saved = {}) {
  const legacy = saved.metricsEnabled === true;
  return Object.fromEntries(['fameEnabled', 'damageEnabled'].map(key =>
    [key, Object.hasOwn(saved, key) ? saved[key] === true : legacy]));
}

const enabled = config => config.fameEnabled === true || config.damageEnabled === true;
const needsTraffic = config => config.zoneSource === 'traffic' || enabled(config);

module.exports = { normalize, enabled, needsTraffic };
