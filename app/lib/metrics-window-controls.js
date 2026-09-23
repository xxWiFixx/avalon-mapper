'use strict';

const MIN_WIDTH = 280, MIN_HEIGHT = 140;
const corners = new Set(['nw', 'ne', 'sw', 'se']);
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));

function normalizeBounds(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]) && Math.abs(value[key]) < 2147483647)
    || value.width <= 0 || value.height <= 0) return null;
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(value[key])]));
}

function restoreBounds(kind, value, area) {
  const saved = normalizeBounds(value), fame = kind === 'fame';
  const width = Math.min(area.width, fame ? 250 : Math.max(MIN_WIDTH, saved?.width ?? 360));
  const height = Math.min(area.height, fame ? 48 : Math.max(MIN_HEIGHT, saved?.height ?? 288));
  return {
    x: Math.round(clamp(saved?.x ?? area.x + 20, area.x, area.x + area.width - width)),
    y: Math.round(clamp(saved?.y ?? area.y + (fame ? 80 : 140), area.y, area.y + area.height - height)),
    width, height,
  };
}

function resizeBounds(bounds, dx, dy, corner, area) {
  let { x, y, width, height } = bounds;
  if (corner.includes('w')) {
    width = clamp(bounds.width - dx, MIN_WIDTH, bounds.x + bounds.width - area.x);
    x = bounds.x + bounds.width - width;
  } else width = clamp(bounds.width + dx, MIN_WIDTH, area.x + area.width - bounds.x);
  if (corner.includes('n')) {
    height = clamp(bounds.height - dy, MIN_HEIGHT, bounds.y + bounds.height - area.y);
    y = bounds.y + bounds.height - height;
  } else height = clamp(bounds.height + dy, MIN_HEIGHT, area.y + area.height - bounds.y);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function create({ window, screen, locked = false, onLockChange = () => {},
  schedule = setInterval, cancel = clearInterval, now = Date.now }) {
  let timer = null, resize = null, ignoring = null;
  function pointer(interactive) {
    const ignore = locked && !interactive;
    if (ignore === ignoring || window.isDestroyed()) return;
    ignoring = ignore;
    window.setIgnoreMouseEvents(ignore, { forward: true });
  }
  function tick() {
    if (!resize || window.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    window.setBounds(resizeBounds(resize.bounds, p.x - resize.from.x, p.y - resize.from.y, resize.corner, resize.area));
  }
  function stopResize() {
    if (timer !== null) cancel(timer);
    timer = null;
    tick(); resize = null;
  }
  function setLocked(value) {
    stopResize(); locked = !!value;
    if (!window.isDestroyed()) {
      window.setResizable(!locked); window.setMovable(!locked);
      pointer(false);
    }
    onLockChange(locked);
  }
  function startResize(corner) {
    if (locked || window.isDestroyed() || !corners.has(corner)) return false;
    stopResize();
    const from = screen.getCursorScreenPoint();
    resize = { corner, from, bounds: window.getBounds(), area: screen.getDisplayNearestPoint(from).workArea, at: now() };
    timer = schedule(() => {
      if (window.isDestroyed() || !resize || now() - resize.at > 30000) stopResize();
      else tick();
    }, 16);
    return true;
  }
  setLocked(locked);
  return { setLocked, isLocked: () => locked, pointer, startResize, stopResize, dispose: stopResize };
}

module.exports = { create, resizeBounds, normalizeBounds, restoreBounds, MIN_WIDTH, MIN_HEIGHT };
