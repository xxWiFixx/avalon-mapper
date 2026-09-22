// Session-only OCR hints. Keys contain geometry, never a screenshot or portal data.
// Callers must still verify a hint and fall back to the normal recognition path.
function createProfiles({ maxEntries = 12 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 256) {
    throw new RangeError('maxEntries must be an integer from 1 to 256');
  }
  const entries = new Map();
  const validScale = scale => Number.isFinite(scale) && scale >= 0.45 && scale <= 4;
  const positive = number => Number.isFinite(number) && number > 0;

  function geometry(frame, screenHeight) {
    if (!frame || !positive(frame.width) || !positive(frame.height)) return null;
    const effectiveHeight = screenHeight === undefined || screenHeight === null || screenHeight === 0
      ? frame.height : screenHeight;
    if (!positive(effectiveHeight)) return null;
    return `${Math.round(frame.width)}:${Math.round(frame.height)}:${Math.round(effectiveHeight)}`;
  }

  function capacityKey(frame, screenHeight, bar) {
    const base = geometry(frame, screenHeight);
    if (!base || !bar || !validScale(bar.scale) || !positive(bar.span) || !positive(bar.bh)
      || !Number.isFinite(bar.fill) || bar.fill < 0) return null;
    const ratio = bar.fill / (195 * bar.scale);
    const polarity = ratio <= 0.2 ? 'dark' : ratio >= 0.8 ? 'full' : 'mixed';
    return `capacity:${base}:${Math.round(bar.span)}:${Math.round(bar.bh)}:${Math.round(bar.scale * 100)}:${polarity}`;
  }

  function get(key) {
    if (!key || !entries.has(key)) return undefined;
    const value = entries.get(key);
    entries.delete(key);
    entries.set(key, value);
    return value;
  }

  function put(key, value) {
    if (!key) return false;
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return true;
  }

  return {
    getScale(frame, screenHeight) {
      const base = geometry(frame, screenHeight);
      return base ? get(`scale:${base}`) : undefined;
    },
    rememberScale(frame, screenHeight, scale) {
      const base = geometry(frame, screenHeight);
      return !!base && validScale(scale) && put(`scale:${base}`, scale);
    },
    getCapacity(frame, screenHeight, bar) {
      const value = get(capacityKey(frame, screenHeight, bar));
      return value ? { ...value } : undefined;
    },
    // Remember only after two exact reads agree. Copy just the processing hint:
    // neither caller mutations nor extra fields may introduce stale portal data.
    rememberCapacity(frame, screenHeight, bar, profile) {
      if (!profile || (Object.getPrototypeOf(profile) !== Object.prototype && Object.getPrototypeOf(profile) !== null)
        || typeof profile.region !== 'string' || !profile.region.trim() || profile.region.length > 64
        || /[\x00-\x1f\x7f]/.test(profile.region)
        || !Number.isInteger(profile.prep) || profile.prep < 0 || profile.prep > 255) return false;
      return put(capacityKey(frame, screenHeight, bar), { region: profile.region, prep: profile.prep });
    },
    clear() { entries.clear(); },
  };
}

module.exports = { createProfiles };
