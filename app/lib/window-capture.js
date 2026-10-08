'use strict';
const F = require('./frame');
const i18nText = require('./i18n').t;

function rectangle(bounds) {
  if (!bounds) return null;
  const rect = { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
  return valid(rect) ? rect : null;
}
function valid(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    && rect.width > 0 && rect.height > 0 && rect.width <= 16384 && rect.height <= 16384
    && rect.width * rect.height <= 40 * 1024 * 1024;
}

// Embed only the game's pixels in the requested physical desktop rectangle.
// Negative origins, secondary displays and windowed mode use the same transform.
// Outside the game stays empty; other apps/overlays never enter this OCR image.
function cropToDesktop(frame, bounds, requested) {
  const windowRect = rectangle(bounds);
  if (!windowRect || !valid(requested) || !valid({ x: 0, y: 0, width: frame.width, height: frame.height })
    || !Buffer.isBuffer(frame.data) || frame.data.length < frame.width * frame.height * 4)
    throw new Error(i18nText('Некорректный размер снимка окна игры'));
  const target = { x: Math.round(requested.x), y: Math.round(requested.y),
    width: Math.round(requested.width), height: Math.round(requested.height) };
  if (!valid(target)) throw new Error(i18nText('Некорректный размер снимка окна игры'));
  const left = Math.max(target.x, windowRect.x), top = Math.max(target.y, windowRect.y);
  const right = Math.min(target.x + target.width, windowRect.x + windowRect.width);
  const bottom = Math.min(target.y + target.height, windowRect.y + windowRect.height);
  if (right <= left || bottom <= top) throw new Error(i18nText('Область снимка находится вне окна Albion Online'));
  const data = Buffer.alloc(target.width * target.height * 4);
  const exact = frame.width === windowRect.width && frame.height === windowRect.height;
  for (let y = Math.ceil(top); y < bottom; y++) {
    const sy = Math.min(frame.height - 1, Math.floor((y - windowRect.y) * frame.height / windowRect.height));
    const dy = y - target.y;
    if (exact) {
      const start = (sy * frame.width + left - windowRect.x) * 4;
      frame.data.copy(data, (dy * target.width + left - target.x) * 4, start, start + (right - left) * 4);
    } else {
      for (let x = Math.ceil(left); x < right; x++) {
        const sx = Math.min(frame.width - 1, Math.floor((x - windowRect.x) * frame.width / windowRect.width));
        const src = (sy * frame.width + sx) * 4, dst = (dy * target.width + x - target.x) * 4;
        frame.data.copy(data, dst, src, src + 4);
      }
    }
  }
  return F.fromBitmap(data, target.width, target.height);
}

function create({ getGame, getSources, now = Date.now }) {
  async function capture(rect) {
    const game = await getGame();
    const bounds = rectangle(game.bounds);
    if (!game.found || game.minimized || !bounds || !/^\d+$/.test(game.windowId || ''))
      throw new Error(i18nText('Окно Albion Online недоступно для захвата. Вернись в игру и повтори хоткей.'));
    const sources = await getSources({ types: ['window'],
      thumbnailSize: { width: bounds.width, height: bounds.height }, fetchWindowIcons: false });
    const capturedAt = now();
    // Electron adds its own capture-backend suffix; the HWND prefix identifies
    // the exact game window even with several clients or similarly named apps.
    const source = sources.find(source => source.id.startsWith('window:' + game.windowId + ':'));
    if (!source?.thumbnail || source.thumbnail.isEmpty())
      throw new Error(i18nText('Не удалось получить снимок окна Albion Online. Повтори хоткей.'));
    const current = await getGame();
    if (!current.found || current.minimized || current.windowId !== game.windowId
        || ['left', 'top', 'right', 'bottom'].some(key => current.bounds?.[key] !== game.bounds[key]))
      throw new Error(i18nText('Окно игры переместилось во время захвата. Повтори хоткей.'));
    const size = source.thumbnail.getSize();
    const frame = F.fromBitmap(source.thumbnail.toBitmap(), size.width, size.height);
    return { ...cropToDesktop(frame, game.bounds, rect || bounds), capturedAt };
  }
  return { capture };
}

module.exports = { create, cropToDesktop, rectangle };
