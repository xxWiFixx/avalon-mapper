'use strict';

// The main process owns all data. Tool windows are disposable views: recover a
// dead/frozen renderer, but never reopen a window the player closed deliberately.
function create({ paused = () => false, stopped = () => false, log = () => {},
  now = Date.now, schedule = setTimeout, cancel = clearTimeout,
  probeMs = 15000, timeoutMs = 5000, reviveMs = 1500 } = {}) {
  const entries = new Set(), failures = new Map();
  let graceUntil = 0, lastIdleSeconds = 0;
  function watch(window, { kind, current = () => true, ready = () => true,
    lost = () => {}, recover, recoverClosed = false }) {
    const entry = { window, kind, current, ready, lost, recover, timer: null, probe: null, disposed: false, loadingAt: now() };
    entries.add(entry);
    const listeners = [];
    const on = (target, event, fn) => { target.on(event, fn); listeners.push([target, event, fn]); };
    function clearProbe() {
      if (entry.probe) cancel(entry.probe.timer);
      entry.probe = null;
    }
    function dispose() {
      entry.disposed = true; clearProbe(); cancel(entry.timer); entries.delete(entry);
      for (const [target, event, fn] of listeners) target.removeListener(event, fn);
    }
    entry.clearProbe = clearProbe; entry.dispose = dispose;
    entry.fail = reason => {
      if (entry.disposed || entry.timer !== null || stopped() || !current()) return;
      clearProbe(); lost();
      const planned = reason.startsWith('system-') || reason === 'idle-return';
      const recent = planned ? [] : (failures.get(kind) || []).filter(at => now() - at < 60000);
      // Back off repeated failures instead of permanently disabling the overlay.
      const delay = recent.length >= 3 ? Math.max(reviveMs, 60000 - (now() - recent[0])) : reviveMs;
      if (!planned) failures.set(kind, [...recent, now()].slice(-3));
      log({ kind, event: 'recover-scheduled', reason, delayMs: delay });
      entry.timer = schedule(() => {
        entry.timer = null;
        if (stopped() || !current()) { dispose(); return; }
        dispose();
        log({ kind, event: 'recover', reason });
        recover(reason);
      }, delay);
    };
    on(window.webContents, 'did-finish-load', () => { entry.loadingAt = now(); clearProbe(); });
    on(window.webContents, 'render-process-gone', () => entry.fail('renderer-gone'));
    on(window.webContents, 'did-fail-load', (_, code, __, ___, main) => {
      if (main && code !== -3) entry.fail('load-failed');
    });
    on(window.webContents, 'unresponsive', () => probe(entry, true));
    on(window.webContents, 'responsive', clearProbe);
    on(window, 'closed', () => {
      if (recoverClosed && current() && !stopped()) entry.fail('window-closed');
      else dispose();
    });
    return dispose;
  }
  function probe(entry, urgent = false) {
    if (entry.disposed || entry.timer !== null || entry.probe || stopped() || paused() || now() < graceUntil || !entry.current()) return;
    const window = entry.window;
    if (window.isDestroyed()) return;
    if (!entry.ready()) {
      if (now() - entry.loadingAt > 20000) entry.fail('load-timeout');
      return;
    }
    if (!urgent && now() - entry.loadingAt < probeMs) return;
    entry.loadingAt = now();
    const check = { at: now(), timer: null }; entry.probe = check;
    check.timer = schedule(() => {
      if (entry.probe !== check) return;
      entry.probe = null;
      // A suspended PC or a stalled main event loop cannot run a timeout on time.
      // Give it a fresh probe after waking instead of blaming every renderer.
      if (paused() || now() - check.at > timeoutMs + 5000) { graceUntil = now() + timeoutMs; return; }
      entry.fail('renderer-timeout');
    }, timeoutMs);
    try {
      Promise.resolve(window.webContents.executeJavaScript('document.readyState')).then(() => {
        if (entry.probe === check) entry.clearProbe();
      }, () => { if (entry.probe === check) entry.fail('renderer-error'); });
    } catch { entry.fail('renderer-error'); }
  }
  function tick() { for (const entry of entries) probe(entry); }
  function wake(reason = 'system-resume') {
    if (stopped()) return;
    graceUntil = now() + timeoutMs;
    // Recreate native transparent windows too: after resume/GPU reset a live
    // renderer and isVisible=true do not prove that Windows still composites it.
    for (const entry of entries) { entry.clearProbe(); entry.fail(reason); }
  }
  function close() { for (const entry of [...entries]) entry.dispose(); }
  function activity(idleSeconds) {
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return;
    const returned = lastIdleSeconds >= 15 * 60 && idleSeconds < lastIdleSeconds;
    lastIdleSeconds = idleSeconds;
    if (returned) wake('idle-return');
  }
  return { watch, tick, wake, activity, close };
}

module.exports = { create };
