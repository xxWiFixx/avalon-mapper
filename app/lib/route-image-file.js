const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 24 * 1000 * 1000;
const MAX_SIDE = 16000;
const PREFIX = 'data:image/png;base64,';
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
class InvalidImage extends Error {}

function safeZoneName(value) {
  const text = (typeof value === 'string' ? value.slice(0, 256) : '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  return text.slice(0, 60).replace(/[\ud800-\udbff]$/g, '').replace(/[. ]+$/g, '') || 'неизвестно';
}

function safeFilename(from, to) {
  return `Маршрут — ${safeZoneName(from)} — ${safeZoneName(to)}.png`;
}

async function validatePng(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) throw new InvalidImage('Не удалось прочитать изображение маршрута. Открой предпросмотр заново.');
  if (dataUrl.length > PREFIX.length + Math.ceil(MAX_BYTES / 3) * 4) throw new InvalidImage('Изображение слишком большое: максимум 20 МБ.');
  const encoded = dataUrl.slice(PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new InvalidImage('Не удалось прочитать PNG маршрута. Открой предпросмотр заново.');
  }
  const input = Buffer.from(encoded, 'base64');
  if (input.length > MAX_BYTES) throw new InvalidImage('Изображение слишком большое: максимум 20 МБ.');
  if (input.toString('base64') !== encoded || input.length < 33 || !input.subarray(0, 8).equals(SIGNATURE)
    || input.readUInt32BE(8) !== 13 || input.toString('ascii', 12, 16) !== 'IHDR') {
    throw new InvalidImage('Файл не является корректным PNG. Открой предпросмотр маршрута заново.');
  }
  const width = input.readUInt32BE(16), height = input.readUInt32BE(20);
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new InvalidImage('Изображение слишком большое: максимум 24 мегапикселя и 16 000 пикселей по стороне.');
  }
  try {
    const image = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
    const meta = await image.metadata();
    if (meta.format !== 'png' || meta.width !== width || meta.height !== height || (meta.pages || 1) !== 1) throw new Error('unexpected image');
    // Fully decode before asking for a destination. A valid header alone does not
    // prove the compressed image is intact. Re-encoding also drops unrelated metadata.
    const buffer = await image.png({ compressionLevel: 6 }).toBuffer();
    if (buffer.length > MAX_BYTES) throw new InvalidImage('Изображение слишком большое: максимум 20 МБ.');
    return buffer;
  } catch (error) {
    if (error instanceof InvalidImage) throw error;
    throw new InvalidImage('PNG маршрута повреждён. Открой предпросмотр заново.');
  }
}

function create({ showSaveDialog, createNativeImage, writeClipboardImage,
  writeFile = (file, data) => fs.promises.writeFile(file, data), onError = () => {} } = {}) {
  let busy = false;
  return async function exportRouteImage(action, payload) {
    if (action !== 'save' && action !== 'copy') return { error: 'Неизвестное действие с изображением маршрута.' };
    if (busy) return { error: 'Дождись завершения предыдущего экспорта маршрута.' };
    busy = true;
    try {
      const buffer = await validatePng(payload && payload.dataUrl);
      if (action === 'copy') {
        const image = createNativeImage(buffer);
        if (!image || image.isEmpty()) throw new Error('native image is empty');
        await writeClipboardImage(image);
        return { ok: true };
      }
      const choice = await showSaveDialog({
        title: 'Сохранить маршрут картинкой',
        defaultPath: safeFilename(payload && payload.from, payload && payload.to),
        filters: [{ name: 'Изображение PNG', extensions: ['png'] }],
        properties: ['showOverwriteConfirmation'],
      });
      if (!choice || choice.canceled || !choice.filePath) return { canceled: true };
      const filePath = choice.filePath;
      // Only the native dialog chooses the destination. Renderer-supplied path
      // fields are never read, and no extension is changed after overwrite approval.
      if (typeof filePath !== 'string' || filePath.includes('\0') || !path.isAbsolute(filePath)) throw new Error('invalid dialog path');
      await writeFile(filePath, buffer);
      return { ok: true, filePath };
    } catch (error) {
      if (error instanceof InvalidImage) return { error: error.message };
      try { onError(error); } catch { /* diagnostics must not block the response */ }
      return { error: action === 'copy'
        ? 'Не удалось скопировать изображение. Попробуй ещё раз.'
        : 'Не удалось сохранить PNG. Проверь доступ к папке и свободное место.' };
    } finally {
      busy = false;
    }
  };
}

module.exports = { create, validatePng, safeFilename, MAX_BYTES, MAX_PIXELS, MAX_SIDE };
