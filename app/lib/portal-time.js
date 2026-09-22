// Absolute expiry is fixed once. Re-reading remaining seconds after OCR, queuing
// or waiting for an origin must never add those delays back to a portal's life.
const MAX_TIMESTAMP = 8640000000000000;
const MAX_SECONDS = 48 * 3600; // manual entry supports up to 48 hours
const validTimestamp = value => Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP;
const validDuration = value => Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS;

function expiry(tip, now = Date.now()) {
  if (!tip) return null;
  if (validTimestamp(tip.expiresAt)) return tip.expiresAt;
  if (!validDuration(tip.closes)) return null;
  const start = validTimestamp(tip.capturedAt) ? tip.capturedAt : now;
  if (!validTimestamp(start)) return null;
  const end = start + tip.closes * 1000;
  return validTimestamp(end) ? end : null;
}

function refresh(tip, now = Date.now()) {
  if (!tip) return tip;
  const expiresAt = expiry(tip, now);
  return { ...tip, expiresAt,
    closes: expiresAt !== null && validTimestamp(now) ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : null,
  };
}

function fromCapture(tip, capturedAt, now = Date.now()) {
  if (!tip) return tip;
  return refresh(validTimestamp(capturedAt) ? { ...tip, capturedAt } : tip, now);
}

function expired(tip, now = Date.now()) {
  const end = expiry(tip, now);
  return validTimestamp(now) && end !== null && end <= now;
}

module.exports = { validTimestamp, expiry, refresh, fromCapture, expired };
