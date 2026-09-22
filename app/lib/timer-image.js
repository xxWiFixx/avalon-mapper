const sharp = require('sharp');
const F = require('./frame');

// Find the bold duration, including its units. Red urgent text has very little
// grayscale contrast against the translucent tooltip, so preserve its color first.
function findTimerText(frame, bar, top) {
  if (!frame || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || !bar
    || !Number.isFinite(bar.scale) || bar.scale < .45 || bar.scale > 4
    || !Number.isFinite(bar.bx) || !Number.isFinite(top)) return null;
  const s = bar.scale;
  const area = clipped(frame, bar.bx + 100 * s, top, 230 * s, 26 * s);
  if (!area) return null;
  const r = F.region(frame, area.left, area.top, area.width, area.height);
  if (!r) return null;
  const { width, height, buf } = r;
  for (const kind of ['red', 'light']) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) {
      const red = buf[i * 4], green = buf[i * 4 + 1], blue = buf[i * 4 + 2];
      const color = kind === 'red'
        ? red > 115 && red > green * 1.8 && red > blue * 1.65
        : Math.min(red, green, blue) > 155 && Math.max(red, green, blue) - Math.min(red, green, blue) < 60;
      mask[i] = color ? 1 : 0;
    }
    const visited = new Uint8Array(mask.length), components = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || visited[i]) continue;
      const stack = [i], pixels = [];
      visited[i] = 1;
      let x0 = width, y0 = height, x1 = 0, y1 = 0;
      while (stack.length) {
        const p = stack.pop(), x = p % width, y = Math.floor(p / width);
        pixels.push(p); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, next = ny * width + nx;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && !visited[next] && mask[next]) { visited[next] = 1; stack.push(next); }
        }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (h >= 5 * s && h <= 19 * s && w <= 21 * s && pixels.length >= 4 * s * s) components.push({ x0, y0, x1, y1, h, pixels });
    }
    // Bold digits are taller than the closing label. Group nearby glyphs on the
    // same baseline, retaining shorter unit letters around those digits.
    const seeds = components.filter(c => c.h >= 8 * s && c.x1 >= 70 * s);
    const groups = seeds.map(seed => {
      const line = components.filter(c => Math.abs(c.y1 - seed.y1) <= 3 * s).sort((a, b) => a.x0 - b.x0);
      const at = line.indexOf(seed);
      let left = at, right = at;
      while (left > 0 && line[left].x0 - line[left - 1].x1 <= Math.ceil(10 * s)) left--;
      while (right + 1 < line.length && line[right + 1].x0 - line[right].x1 <= Math.ceil(10 * s)) right++;
      return line.slice(left, right + 1);
    }).filter(g => g.length >= 2 && g.length <= 14
      && g[g.length - 1].x1 - g[0].x0 >= 14 * s
      && g[g.length - 1].x1 - g[0].x0 <= 135 * s);
    groups.sort((a, b) => b[b.length - 1].x1 - a[a.length - 1].x1);
    const group = groups[0];
    if (!group) continue;
    const x0 = Math.max(0, Math.min(...group.map(c => c.x0)) - Math.ceil(2 * s));
    const x1 = Math.min(width - 1, Math.max(...group.map(c => c.x1)) + Math.ceil(2 * s));
    const y0 = Math.max(0, Math.min(...group.map(c => c.y0)) - Math.ceil(s));
    const y1 = Math.min(height - 1, Math.max(...group.map(c => c.y1)) + Math.ceil(s));
    return { kind, left: r.left + x0, top: r.top + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }
  return null;
}

async function timerImage(frame, region, { scale = 4, threshold = 150, original = false } = {}) {
  if (!region || !Number.isInteger(scale) || scale < 1 || scale > 8) return null;
  const area = clipped(frame, region.left, region.top, region.width, region.height);
  if (!area) return null;
  const r = F.region(frame, area.left, area.top, area.width, area.height);
  if (!r) return null;
  if (original) {
    return sharp(r.buf, { raw: { width: r.width, height: r.height, channels: 4 } }).removeAlpha()
      .grayscale().normalise().negate().resize(r.width * scale, r.height * scale)
      .extend({ top: 12, bottom: 12, left: 12, right: 12, background: '#fff' }).png().toBuffer();
  }
  const pixels = Buffer.alloc(r.width * r.height);
  for (let i = 0; i < pixels.length; i++) {
    const red = r.buf[i * 4], green = r.buf[i * 4 + 1], blue = r.buf[i * 4 + 2];
    const light = region.kind === 'red'
      ? Math.max(0, red - Math.max(green, blue)) * 2
      : Math.min(red, green, blue);
    pixels[i] = 255 - Math.min(255, light);
  }
  let pipeline = sharp(pixels, { raw: { width: r.width, height: r.height, channels: 1 } }).resize(r.width * scale, r.height * scale);
  if (threshold !== null) pipeline = pipeline.threshold(threshold);
  return pipeline.extend({ top: 12, bottom: 12, left: 12, right: 12, background: '#fff' }).png().toBuffer();
}

module.exports = { findTimerText, timerImage };

function clipped(frame, left, top, width, height) {
  if (!frame || ![frame.width, frame.height, left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const x0 = Math.max(0, Math.round(left)), y0 = Math.max(0, Math.round(top));
  const x1 = Math.min(frame.width, Math.round(left + width)), y1 = Math.min(frame.height, Math.round(top + height));
  return x1 > x0 && y1 > y0 ? { left: x0, top: y0, width: x1 - x0, height: y1 - y0 } : null;
}
