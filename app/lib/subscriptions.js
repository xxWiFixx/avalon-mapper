'use strict';
// Recording is free. The server alone owns group-channel entitlements.
function createSubscriptions({ accountId, status, onChange = () => {}, now = Date.now }) {
  let current = null, revision = 0, refreshFlight = null;
  function reset() { revision++; current = null; refreshFlight = null; onChange(snapshot()); }
  function accept(value, user, started) {
    if (started !== revision || accountId() !== user || value?.userId !== user) return false;
    current = { ...value, checkedAt: now(), error: null };
    onChange(snapshot());
    return true;
  }
  function snapshot() {
    if (!current || current.userId !== accountId()) return { ready: false, enabled: false, paymentReady: false, recordingFree: true, unlimited: true };
    const out = structuredClone(current);
    // Expired dates cannot keep a paid badge alive between polls.
    const elapsed = Math.max(0, now() - current.checkedAt);
    const serverNow = Date.parse(current.serverTime) + elapsed;
    out.recordingFree = true;
    out.unlimited = true;
    delete out.unlimitedUntil;
    delete out.personalUntil;
    delete out.includedUntil;
    delete out.trial;
    delete out.quota;
    for (const license of out.licenses || []) license.active = license.active && Date.parse(license.expiresAt) > serverNow;
    for (const group of out.groups || []) {
      if (group.permanent) group.active = true;
      else if (group.expiresAt) group.active = group.active && Date.parse(group.expiresAt) > serverNow;
    }
    out.ready = true;
    return out;
  }
  async function refresh() {
    if (refreshFlight) return refreshFlight;
    const user = accountId(), started = revision;
    if (!user) return snapshot();
    const flight = (async () => {
      try { accept(await status(), user, started); }
      catch (error) {
        if (started !== revision || user !== accountId()) return snapshot();
        // An older server is a staged rollout, never evidence of a paid plan.
        if (!current && ['PGRST202', '42883'].includes(error.code)) {
          current = { userId: user, enabled: false, paymentReady: false, setupPending: true,
            checkedAt: now(), serverTime: new Date(now()).toISOString() };
        } else if (current) current.error = error.message;
        onChange(snapshot());
      }
      return snapshot();
    })();
    refreshFlight = flight;
    try { return await flight; } finally { if (refreshFlight === flight) refreshFlight = null; }
  }
  return { reset, snapshot, refresh };
}
module.exports = { createSubscriptions };
