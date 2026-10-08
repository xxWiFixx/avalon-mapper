const sharp = require('sharp');
const F = require('./frame');

function redPixels(frame, box) {
  const r = F.region(frame, box.left, box.top, box.width, box.height);
  if (!r) return null;
  const values = new Float32Array(r.width * r.height), core = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const red = r.buf[i * 4], green = r.buf[i * 4 + 1], blue = r.buf[i * 4 + 2];
    const delta = red - Math.max(green, blue);
    values[i] = Math.max(0, delta);
    core[i] = red > 100 && delta > 40 && red > green * 1.65 && red > blue * 1.5 ? 1 : 0;
  }
  return { ...r, values, core };
}

function components(pixels) {
  const { width, height, core } = pixels;
  const seen = new Uint8Array(core.length), list = [];
  for (let i = 0; i < core.length; i++) {
    if (!core[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let x0 = width, y0 = height, x1 = 0, y1 = 0, count = 0;
    while (stack.length) {
      const at = stack.pop(), x = at % width, y = Math.floor(at / width);
      count++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, next = yy * width + xx;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && !seen[next] && core[next]) {
          seen[next] = 1; stack.push(next);
        }
      }
    }
    list.push({ left: pixels.left + x0, top: pixels.top + y0, width: x1 - x0 + 1, height: y1 - y0 + 1, count });
  }
  return list;
}

// Search beyond the original narrow crop so its missing leading digit cannot
// be confirmed by repeated OCR of that same truncated image.
function findRedTimerGlyphs(frame, bar, { top } = {}) {
  if (!frame?.data || ![frame.width, frame.height, bar?.bx, bar?.by, bar?.bh, bar?.scale].every(Number.isFinite)
    || bar.scale < .45 || bar.scale > 4 || bar.bh <= 0 || (top != null && !Number.isFinite(top))) return null;
  const scale = Math.max(.6, Math.min(3, bar.bh / 11 || bar.scale));
  const box = { left: bar.bx + 140 * scale, top: top ?? bar.by + bar.bh + 2 * scale,
    width: 170 * scale, height: 35 * scale };
  const p = redPixels(frame, box);
  if (!p) return null;
  const pieces = components(p).filter(c => c.height >= 4 * scale && c.height <= 18 * scale
    && c.width <= 20 * scale && c.count >= 4 * scale * scale);
  const candidates = pieces.filter(c => c.height >= 7 * scale).map(seed => {
    const aligned = pieces.filter(c => Math.abs(c.top + c.height - seed.top - seed.height) <= 3 * scale)
      .sort((a, b) => a.left - b.left);
    let left = aligned.indexOf(seed), right = left;
    while (left > 0 && aligned[left].left - (aligned[left - 1].left + aligned[left - 1].width) <= 9 * scale) left--;
    while (right + 1 < aligned.length && aligned[right + 1].left - (aligned[right].left + aligned[right].width) <= 9 * scale) right++;
    return aligned.slice(left, right + 1);
  }).filter(g => g.length >= 2 && g.length <= 8 && g.at(-1).left + g.at(-1).width - g[0].left < 115 * scale);
  candidates.sort((a, b) => b.at(-1).left - a.at(-1).left || b.length - a.length);
  const group = candidates[0];
  if (!group) return null;
  const x0 = Math.min(...group.map(c => c.left)), y0 = Math.min(...group.map(c => c.top));
  const x1 = Math.max(...group.map(c => c.left + c.width)), y1 = Math.max(...group.map(c => c.top + c.height));
  const roi = { kind: 'red', left: x0 - 2, top: y0 - 2, width: x1 - x0 + 4, height: y1 - y0 + 4, scale };
  const q = redPixels(frame, roi), runs = [];
  let start = null;
  for (let x = 0; x <= q.width; x++) {
    let count = 0;
    if (x < q.width) for (let y = 0; y < q.height; y++) count += q.core[y * q.width + x];
    if (count && start == null) start = x;
    if (!count && start != null) {
      runs.push({ left: q.left + start, top: q.top, width: x - start, height: q.height }); start = null;
    }
  }
  // Touching digit/unit pairs can have a thin bridge. Split only wide runs at
  // a sufficiently sparse column, retaining every other occupied column.
  const glyphs = runs.flatMap(g => {
    if (g.width <= 12 * scale) return [g];
    const mask = redPixels(frame, g), counts = Array.from({ length: mask.width }, (_, x) => {
      let n = 0; for (let y = 0; y < mask.height; y++) n += mask.core[y * mask.width + x]; return n;
    });
    let cut = -1, best = Infinity;
    for (let x = Math.ceil(3 * scale); x < g.width - 3 * scale; x++) {
      if (counts[x] < best) { best = counts[x]; cut = x; }
    }
    return cut > 0 && best <= Math.ceil(2 * scale)
      ? [{ ...g, width: cut }, { ...g, left: g.left + cut + 1, width: g.width - cut - 1 }] : [g];
  });
  return { roi, glyphs };
}

function joinGlyphs(parts) {
  const first = parts[0], last = parts.at(-1);
  return { left: first.left - 1, top: first.top, width: last.left + last.width - first.left + 2, height: first.height };
}

async function redTimerImage(frame, box, mode = 'soft', scale = 5) {
  const p = redPixels(frame, box);
  if (!p) return null;
  let png;
  if (mode === 'gray') {
    png = await sharp(p.buf, { raw: { width: p.width, height: p.height, channels: 4 } }).removeAlpha()
      .grayscale().normalise().negate().resize(p.width * scale, p.height * scale).png().toBuffer();
  } else {
    const ink = Buffer.alloc(p.values.length);
    for (let i = 0; i < ink.length; i++) {
      const intensity = mode === 'soft' ? Math.max(0, Math.min(255, (p.values[i] - 20) * 2.2)) : p.core[i] * 255;
      ink[i] = 255 - intensity;
    }
    png = await sharp(ink, { raw: { width: p.width, height: p.height, channels: 1 } })
      .resize(p.width * scale, p.height * scale, { kernel: 'lanczos3' }).png().toBuffer();
  }
  return sharp(png).extend({ left: 18, right: 18, top: 18, bottom: 18, background: '#fff' })
    .withMetadata({ density: 300 }).png().toBuffer();
}

module.exports = { findRedTimerGlyphs, redTimerImage, joinGlyphs };
