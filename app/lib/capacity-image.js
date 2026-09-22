const sharp = require('sharp');
const F = require('./frame');

function exactCapacity(text, bar) {
  const match = String(text || '').trim().match(/^(\d{1,2})\s*\/\s*(7|20)$/);
  if (!match) return null;
  const num = +match[1], max = +match[2];
  if (num > max) return null;
  const ratio = bar && Number.isFinite(bar.fill) && bar.fill >= 0
    && Number.isFinite(bar.scale) && bar.scale > 0 ? bar.fill / (195 * bar.scale) : NaN;
  // A missing leading digit must not turn a nearly full 20-person portal into
  // 9/20. Ignore this check when the anchor also includes another gold UI area.
  if (ratio >= 0 && ratio <= 1.08 && Math.abs(num - ratio * max) > Math.max(1.5, max * .15)) return null;
  return { num, max };
}

// Remove the capacity track's two background colors before reading its digits.
// Local bright pixels estimate the background; only the small text area is copied.
async function capacityImage(frame, bar, { threshold = 180, scale = 4 } = {}) {
  if (!bar || !Number.isFinite(bar.scale) || bar.scale < .45 || bar.scale > 4
    || !Number.isFinite(bar.bx) || !Number.isFinite(bar.by) || !Number.isFinite(bar.bh) || bar.bh <= 0) return null;
  const s = bar.scale;
  const region = F.region(frame, bar.bx + 62 * s, bar.by, 73 * s, bar.bh);
  if (!region) return null;
  const { width, height, buf } = region;
  const gray = new Uint8Array(width * height), peaks = new Uint8Array(width);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const light = Math.round(buf[i] * .299 + buf[i + 1] * .587 + buf[i + 2] * .114);
    gray[y * width + x] = light;
    peaks[x] = Math.max(peaks[x], light);
  }
  const radius = Math.max(2, Math.round(5 * s));
  const normalized = Buffer.alloc(width * height), ink = new Uint16Array(width);
  for (let x = 0; x < width; x++) {
    let background = 1;
    for (let j = Math.max(0, x - radius); j <= Math.min(width - 1, x + radius); j++) background = Math.max(background, peaks[j]);
    for (let y = 0; y < height; y++) {
      const value = Math.min(255, Math.round(gray[y * width + x] * 255 / background));
      normalized[y * width + x] = value;
      if (value < threshold) ink[x]++;
    }
  }
  // Locate the space after the player silhouette, before the first digit.
  // Geometry bounds prevent a gap between two digits from becoming the crop start.
  const from = Math.max(0, Math.round(10 * s)), to = Math.min(width, Math.round(26 * s));
  let gap = null;
  for (let x = from; x < to; x++) {
    if (ink[x]) continue;
    const start = x;
    while (x + 1 < to && !ink[x + 1]) x++;
    const score = Math.abs((start + x) / 2 - 18 * s);
    if (x - start + 1 >= Math.max(1, Math.round(s)) && (!gap || score < gap.score)) gap = { end: x, score };
  }
  if (!gap) return null; // keep the established wider OCR fallbacks
  const left = Math.max(0, gap.end - Math.round(s));
  return sharp(normalized, { raw: { width, height, channels: 1 } })
    .extract({ left, top: 0, width: width - left, height })
    .resize((width - left) * scale, height * scale).threshold(threshold)
    .extend({ top: 12, bottom: 12, left: 12, right: 12, background: '#fff' })
    .png().toBuffer();
}

module.exports = { capacityImage, exactCapacity };
