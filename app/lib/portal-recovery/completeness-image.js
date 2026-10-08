'use strict';
// The earlier candidate's image treatments, bound to the frozen app frame
// helper. No live production recognizer is imported or invoked by this file.
const sharp = require('sharp'), F = require('../frame');
function signal(frame, box) {
  const r = F.region(frame, box.left, box.top, box.width, box.height);
  if (!r) return null;
  const v = new Float32Array(r.width * r.height), chroma = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const red = r.buf[i * 4], green = r.buf[i * 4 + 1], blue = r.buf[i * 4 + 2];
    v[i] = Math.min(red, green, blue); chroma[i] = Math.max(red, green, blue) - v[i];
  }
  const local = new Float32Array(v.length);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const neighborhood = [];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < r.width && yy >= 0 && yy < r.height) neighborhood.push(v[yy * r.width + xx]);
    }
    neighborhood.sort((a, b) => a - b);
    local[y * r.width + x] = Math.max(0, v[y * r.width + x] - neighborhood[Math.floor(neighborhood.length * .3)]);
  }
  return { ...r, v, chroma, local };
}
async function image(frame, box, mode = 'gray', scale = 4) {
  const r = signal(frame, box); if (!r) return null;
  let pipeline;
  if (mode === 'gray') pipeline = sharp(r.buf, { raw: { width: r.width, height: r.height, channels: 4 } })
    .removeAlpha().grayscale().normalise().negate();
  else {
    const pixels = Buffer.alloc(r.v.length);
    for (let i = 0; i < pixels.length; i++) {
      const value = mode === 'local' ? Math.min(255, r.local[i] * 4)
        : r.v[i] * (1 - Math.min(1, r.chroma[i] / 80));
      pixels[i] = 255 - Math.min(255, Math.max(0, value));
    }
    pipeline = sharp(pixels, { raw: { width: r.width, height: r.height, channels: 1 } }).normalise();
  }
  pipeline = pipeline.resize(r.width * scale, r.height * scale);
  return sharp(await pipeline.png().toBuffer()).extend({ left: 16, right: 16, top: 16, bottom: 16, background: '#fff' })
    .withMetadata({ density: 300 }).png().toBuffer();
}
module.exports = { signal, image };
