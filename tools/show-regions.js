// Сохраняет в PNG ровно те куски экрана, которые снимает приложение:
// полоску с плашкой зоны (фоновый опрос) и квадрат вокруг курсора (хоткей по тултипу).
// Запуск при работающей игре:  node tools/show-regions.js
// Файлы кладутся в app/data/regions/.
const path = require('path');
const fs = require('fs');
const APP = path.join(__dirname, '..', 'app');
const gdi = require(path.join(APP, 'lib', 'capture-gdi'));
const sharp = require(path.join(APP, 'node_modules', 'sharp'));
const koffi = require(path.join(APP, 'node_modules', 'koffi'));

// Обычный node-процесс не DPI-aware: без этого Windows отдаёт виртуальные 1920x1080
// вместо настоящих пикселей. В Electron это уже сделано за нас.
const user32 = koffi.load('user32.dll');
user32.func('int SetProcessDPIAware()')();
const GetCursorPos = user32.func('int GetCursorPos(void* lpPoint)');

const OUT = path.join(APP, 'data', 'regions');

async function save(name, x, y, w, h) {
  const frame = gdi.grab(x, y, w, h);
  const rgba = Buffer.from(frame.data);
  for (let i = 0; i < rgba.length; i += 4) { const b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b; }
  const file = path.join(OUT, name + '.png');
  await sharp(rgba, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toFile(file);
  console.log(`${name}: ${w}x${h} в (${x}, ${y}) → ${file}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { width: W, height: H } = gdi.screenSize();
  const s = H / 1080;
  console.log(`экран ${W}x${H}`);

  // 1. полоска зоны — то, что снимается раз в 1.5–6 с
  await save('zone-strip', Math.round(W - 400 * s), Math.round(H - 48 * s), Math.round(380 * s), Math.round(30 * s));

  // 2. квадрат вокруг курсора — то, что снимается по хоткею
  const pt = Buffer.alloc(8);
  GetCursorPos(pt);
  const cx = pt.readInt32LE(0), cy = pt.readInt32LE(4);
  const R = Math.round(420 * s);
  const x = Math.max(0, Math.min(W - 2 * R, cx - R));
  const y = Math.max(0, Math.min(H - 2 * R, cy - R));
  await save('cursor-box', x, y, Math.min(2 * R, W), Math.min(2 * R, H));
  console.log(`курсор был в (${cx}, ${cy})`);

  gdi.release();
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
