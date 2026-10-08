'use strict';

const managedWindows = new Set();
let nativeRelease;
function releaseNative(window) {
  if (process.platform !== 'win32' || typeof window.getNativeWindowHandle !== 'function') return false;
  if (!nativeRelease) {
    const koffi = require('koffi');
    const set = koffi.load('user32.dll').func('bool SetWindowDisplayAffinity(void* hwnd, uint32 affinity)');
    nativeRelease = target => set(koffi.decode(target.getNativeWindowHandle(), 'void*'), 0);
  }
  return nativeRelease(window);
}

function register(window, fallback = releaseNative) {
  if (!window || window.isDestroyed()) return;
  // Global display affinity also removes overlays from streams and makes NVIDIA
  // stop desktop recording. Our OCR excludes these windows in its own capture
  // path instead; never mark even a hidden tool as protected content.
  window.setContentProtection(false);
  if (window.isContentProtected?.() === true) {
    try {
      if (!fallback(window)) console.warn('[capture] could not clear overlay display affinity');
    } catch (error) { console.warn('[capture] clearing overlay display affinity failed:', error.message); }
  }
  if (!managedWindows.has(window)) window.once?.('closed', () => managedWindows.delete(window));
  managedWindows.add(window);
}

function overlaps(rect, bounds) {
  return !!bounds && (!rect || (rect.x < bounds.x + bounds.width && rect.x + rect.width > bounds.x
    && rect.y < bounds.y + bounds.height && rect.y + rect.height > bounds.y));
}

// Only overlapping app windows need isolated game-window capture. Elsewhere keep
// the fast rectangular GDI path. Never hide an overlay or alter stream visibility.
function create({ busy = () => {}, windows = () => managedWindows, toPhysical = bounds => bounds,
  captureWindow = null } = {}) {
  let tail = Promise.resolve();
  function covered(rect) {
    for (const window of windows()) {
      if (!window || window.isDestroyed()) { managedWindows.delete(window); continue; }
      if (!window.isVisible?.() || window.isMinimized?.() || !window.getBounds) continue;
      if (overlaps(rect, toPhysical(window.getBounds()))) return true;
    }
    return false;
  }
  function run(rect, capture) {
    const next = tail.then(async () => {
      busy(1);
      try {
        if (captureWindow && covered(rect)) return await captureWindow(rect);
        const result = await capture();
        // A metrics window can appear while an asynchronous desktop snapshot is
        // pending. Do not let that newly visible overlay enter the OCR frame.
        return captureWindow && covered(rect) ? await captureWindow(rect) : result;
      } finally {
        busy(-1);
      }
    });
    tail = next.catch(() => {});
    return next;
  }
  return { run, covered };
}

module.exports = { create, register, overlaps };
