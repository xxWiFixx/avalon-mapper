#!/usr/bin/env node
// Оценка качества обрезки карт зон: что попало в ромб, кроме самой карты.
//
// Обрезка (tools/crop-maps.js) ищет ромб поля по цвету и накладывает альфа-маску.
// Ошибиться она может двумя способами, и оба видны по КРАЯМ ромба:
//   взяли шире — вдоль кромки лежит песчаная рамка карты или чёрный фон вокруг неё;
//   взяли уже/сместили — у кромки провал в пустоту, а содержимое ужалось к центру.
// Меряем САМУЮ ДЛИННУЮ НЕПРЕРЫВНУЮ полосу «не поля» вдоль кромки — именно она означает
// брак. Общая доля для этого не годится: у каждой карты в середине граней есть свои
// «ворота» (песок врезается внутрь ромба), и по доле нормальные карты попадали в брак.
//
// Запуск: node tools/check-crops.js [--json файл]
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'app', 'assets', 'avalon-maps-crop');
const OUT_JSON = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : path.join(ROOT, 'app', 'data', 'crop-quality.json');

const RING = 0.955;      // насколько внутрь от грани смотрим
const PTS = 720;         // точек по периметру ромба

// Поле карты — тёмно-фиолетовое: зелёный канал ниже красного И синего.
// Тот же признак, по которому ромб и находится в crop-maps.js.
function isField(r, g, b) {
  const lum = 0.3 * r + 0.6 * g + 0.1 * b;
  return lum >= 14 && lum <= 150 && r > g + 1 && b > g + 1;
}

// Меряем САМУЮ ДЛИННУЮ НЕПРЕРЫВНУЮ полосу «не поля» вдоль кромки ромба, а не общую
// долю. Так плохая обрезка (песчаная рамка тянется вдоль целой грани) отличается от
// нормальной карты, у которой в середине каждой грани есть свои «ворота» — вырез
// песком внутрь ромба. По общей доле ворота выглядели как брак, и половина списка
// оказывалась ложной тревогой.
async function score(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  const cx = (W - 1) / 2, cy = (H - 1) / 2;
  const flags = new Uint8Array(PTS);   // 1 — вдоль кромки лежит не поле
  let bad = 0, sand = 0, dark = 0;
  for (let k = 0; k < PTS; k++) {
    const t = (k / PTS) * 4, side = Math.floor(t), u = t - side;
    let ux, uy;
    if (side === 0) { ux = u; uy = u - 1; }
    else if (side === 1) { ux = 1 - u; uy = u; }
    else if (side === 2) { ux = -u; uy = 1 - u; }
    else { ux = u - 1; uy = -u; }
    const x = Math.round(cx + ux * cx * RING), y = Math.round(cy + uy * cy * RING);
    if (x < 0 || y < 0 || x >= W || y >= H) { flags[k] = 1; bad++; continue; }
    const i = (y * W + x) * ch;
    const a = ch === 4 ? data[i + 3] : 255;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.3 * r + 0.6 * g + 0.1 * b;
    if (a < 40) continue;                       // прозрачное — за маской, это норма
    if (isField(r, g, b)) continue;
    flags[k] = 1; bad++;
    if (r > 140 && g > 115 && b < r - 25) sand++;
    else if (lum < 12) dark++;
  }
  // самая длинная непрерывная полоса по кругу
  let run = 0, bestRun = 0;
  for (let k = 0; k < PTS * 2; k++) {
    if (flags[k % PTS]) { run++; if (run > bestRun) bestRun = run; } else run = 0;
  }
  bestRun = Math.min(bestRun, PTS);

  // заполнение: границы непустого содержимого внутри маски
  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * ch;
    if ((ch === 4 ? data[i + 3] : 255) > 40 && 0.3 * data[i] + 0.6 * data[i + 1] + 0.1 * data[i + 2] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const cover = Math.min((maxX - minX + 1) / W, (maxY - minY + 1) / H);
  return {
    name: path.basename(file, '.webp'),
    edge: bestRun / PTS,          // сплошная полоса чужого — главный признак брака
    total: bad / PTS,             // сколько чужого всего (ворота сюда тоже попадают)
    sand: sand / PTS, dark: dark / PTS,
    cover,
  };
}

(async () => {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.webp')).sort();
  const out = [];
  for (let i = 0; i < files.length; i++) {
    out.push(await score(path.join(DIR, files[i])));
    if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${files.length}\r`);
  }
  // Итоговая подозрительность: чужое у кромки — главный признак, недобор содержимого — второй
  for (const r of out) r.bad = r.edge + Math.max(0, 0.97 - r.cover) * 1.5;
  out.sort((a, b) => b.bad - a.bad);

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1));

  const q = p => out[Math.floor((out.length - 1) * p)].bad.toFixed(3);
  console.log(`\nпроверено ${out.length} карт`);
  console.log(`подозрительность: худшая ${out[0].bad.toFixed(3)} | 10% ${q(0.1)} | медиана ${q(0.5)} | лучшая ${out[out.length - 1].bad.toFixed(3)}`);
  console.log('\nхудшие 15:');
  for (const r of out.slice(0, 15)) {
    console.log(`  ${r.name.padEnd(24)} сплошная полоса ${(r.edge * 100).toFixed(1)}% периметра (всего чужого ${(r.total * 100).toFixed(1)}%) · заполнение ${(r.cover * 100).toFixed(0)}%`);
  }
  console.log('\nсписок:', OUT_JSON);
})();
