// Кадр экрана в сыром виде — общий формат для захвата и распознавания.
//
// Почему не PNG: замер на 4К-экране (3840×2160) в этом же приложении —
//   getSources 520–660 мс | toPNG 1280–1330 мс (5.8 МБ) | toBitmap 7 мс (33 МБ).
// PNG кодировался только чтобы sharp его тут же распаковал: 1.3 с на кадр в никуда.
//
// Electron отдаёт пиксели как BGRA, sharp ждёт RGBA — переворачиваем каналы,
// но только на вырезанном куске: трогать все 33 МБ ради полоски 380×30 незачем.
const sharp = require('sharp');

// { data, width, height, bgra } — data всегда 4 канала
function fromBitmap(data, width, height) {
  return { data, width, height, bgra: true };
}

// PNG/JPEG с диска (калибровочные кадры, симуляция) → тот же формат кадра
async function fromEncoded(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, bgra: false };
}

// Копия кадра в RGBA. GDI отдаёт BGRA, и если отдать такой буфер sharp как RGBA,
// красный с синим меняются местами — а именно по цвету мы ищем золотую полосу.
function toRGBA(frame) {
  const out = Buffer.from(frame.data);
  if (frame.bgra) for (let i = 0; i < out.length; i += 4) { const b = out[i]; out[i] = out[i + 2]; out[i + 2] = b; }
  return out;
}

// Уже кадр — вернуть как есть; Buffer — распаковать
async function toFrame(input) {
  if (input && input.data && input.width) return input;
  return fromEncoded(input);
}

// Прямоугольник кадра как RGBA-буфер для sharp. Границы подрезаются по кадру.
// Возвращает null, если от прямоугольника ничего не осталось.
function region(frame, left, top, w, h) {
  const x0 = Math.max(0, Math.round(left));
  const y0 = Math.max(0, Math.round(top));
  const x1 = Math.min(frame.width, x0 + Math.round(w));
  const y1 = Math.min(frame.height, y0 + Math.round(h));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return null;

  const src = frame.data;
  const out = Buffer.allocUnsafe(rw * rh * 4);
  const rowBytes = rw * 4;
  for (let y = 0; y < rh; y++) {
    const s = ((y0 + y) * frame.width + x0) * 4;
    src.copy(out, y * rowBytes, s, s + rowBytes);
  }
  if (frame.bgra) {                       // BGRA → RGBA: меняем местами первый и третий байт
    for (let i = 0; i < out.length; i += 4) { const b = out[i]; out[i] = out[i + 2]; out[i + 2] = b; }
  }
  return { buf: out, width: rw, height: rh, left: x0, top: y0 };
}

// sharp поверх вырезанного прямоугольника (без единого перекодирования).
// removeAlpha обязателен: в сыром кадре альфа есть всегда, а negate() в sharp
// инвертирует и её — кроп уезжал в полную прозрачность, и OCR читал пустоту.
function sharpRegion(frame, left, top, w, h) {
  const r = region(frame, left, top, w, h);
  if (!r) return null;
  const img = sharp(r.buf, { raw: { width: r.width, height: r.height, channels: 4 } }).removeAlpha();
  return { img, width: r.width, height: r.height };
}

// Чёрный/однотонный кадр. Идём по сетке прямо в сыром буфере: полный проход по 33 МБ
// не нужен, а прежняя проверка через sharp().resize() стоила ~90 мс на кадр.
const BLANK_MEAN = 8;    // почти чёрный кадр
const BLANK_STDEV = 3.5; // однотонная заливка (чёрная, белая, серая) — картинки нет
function stats(frame) {
  const { data, width, height } = frame;
  const stepX = Math.max(1, Math.floor(width / 64));
  const stepY = Math.max(1, Math.floor(height / 36));
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 0; y < height; y += stepY) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += stepX) {
      const i = row + x * 4;
      // веса яркости; порядок каналов на серый почти не влияет, но считаем честно
      const v = frame.bgra
        ? 0.114 * data[i] + 0.587 * data[i + 1] + 0.299 * data[i + 2]
        : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += v; sum2 += v * v; n++;
    }
  }
  const mean = sum / n;
  const stdev = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return { mean, stdev, blank: mean < BLANK_MEAN || stdev < BLANK_STDEV };
}

module.exports = { fromBitmap, fromEncoded, toFrame, toRGBA, region, sharpRegion, stats };
