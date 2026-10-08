'use strict';
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function verify(license, publicKey, userId) {
  try {
    if (!UUID.test(userId || '') || typeof license?.payload !== 'string' || license.payload.length > 4096
        || typeof license.signature !== 'string' || license.signature.length > 128) return null;
    const bytes = Buffer.from(license.payload, 'base64url');
    if (!crypto.verify(null, bytes, publicKey, Buffer.from(license.signature, 'base64url'))) return null;
    const claims = JSON.parse(bytes.toString('utf8'));
    if (claims.v !== 1 || claims.userId !== userId || !Array.isArray(claims.features)
        || claims.features.some(f => !['market','mail'].includes(f))) return null;
    return { market:claims.features.includes('market'), mail:claims.features.includes('mail') };
  } catch { return null; }
}
module.exports = { verify, UUID };
