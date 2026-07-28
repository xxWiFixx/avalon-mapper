// Сквозной тест без игры и без Electron: прогоняет калибровочные скрины a1–a25
// как «игровую сессию» через recognize + store и печатает получившийся граф.
const path = require('path');
const fs = require('fs');
const recognize = require('../lib/recognize');
const store = require('../lib/store');
const F = require('../lib/frame');

const CAL = path.join(__dirname, '..', '..', 'calibration');
// скрины с тултипом → хоткей; экраны загрузки и чистые кадры → только зона
const SEQUENCE = [
  ['a1', true], ['a2', true], ['a3', false], ['a4', true], ['a5', true], ['a6', true], ['a7', true],
  ['a8', false], ['a9', true], ['a10', false], ['a11', true], ['a12', false], ['a13', true],
  ['a14', true], ['a15', false], ['a16', true], ['a17', false], ['a18', true], ['a19', true],
  ['a20', false], ['a21', true], ['a22', true], ['a23', true], ['a24', true], ['a25', false],
];

let currentZone = null;
(async () => {
  // Пишем во временную папку, а НЕ в app/data. Раньше симуляция сохраняла карту туда же,
  // где лежало рабочее состояние приложения, и её игрок 'tester' уехал в боевую карту
  // вместе с разовым переносом app/data → userData, после чего годами висел в графе.
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'avalon-sim-'));
  store.setDataDir(tmp);
  // чистое состояние
  store.state.edges = {}; store.state.players = {}; store.state.journal = [];
  await recognize.init();
  const t0 = Date.now();
  for (const [name, withTooltip] of SEQUENCE) {
    // распаковываем один раз в кадр — ровно как это делает приложение с захватом экрана
    const frame = await F.fromEncoded(fs.readFileSync(path.join(CAL, `${name}.png`)));
    let tip = null;
    if (withTooltip) tip = await recognize.recognizeTooltip(frame);
    const z = await recognize.recognizeZone(frame, { fast: !withTooltip });
    if (z && z.zone !== currentZone) {
      currentZone = z.zone;
      // как в main.js: смена зоны рёбер не создаёт, только отмечает, где игрок
      store.setPlayerZone('tester', z.zone);
    }
    if (tip && currentZone) store.addEdge(currentZone, tip, 'tester');
    console.log(`${name}: зона=${z?.zone ?? '—'}${tip ? ` | портал → ${tip.name} ${tip.capNum}/${tip.capMax} закроется=${tip.closes}с` : ''}`);
  }
  const snap = store.snapshot();
  console.log(`\n=== ГРАФ (${Object.keys(snap.edges).length} рёбер, ${((Date.now() - t0) / 1000).toFixed(0)}с) ===`);
  for (const e of snap.edges) {
    const left = e.expiresAt ? Math.round((e.expiresAt - Date.now()) / 60000) : null;
    console.log(`${e.a} ⇄ ${e.b} | ${e.capNum ?? '?'}/${e.capMax ?? '?'} | ${left != null ? left + ' мин' : 'таймер ?'} | ${e.source}`);
  }
  console.log('\nСлед игрока:', store.state.players.tester.trail.map(t => t.zone).join(' → '));

  // ожидаемая сеть из калибровочной сессии
  const expected = [
    'Cairn Camain|Coues-Exakrom', 'Brons Hill|Coues-Exakrom', 'Coues-Exakrom|Quaent-Al-Qintis',
    'Coues-Exakrom|Qiient-Qi-Odesas', 'Qiient-Qi-Odesas|Xiros-Aiairom', 'Curites-Exakrom|Pen Gent',
    'Curites-Exakrom|Qiient-Et-Nusas', 'Qiient-Et-Nusas|Qiient-Qinsum', 'Qiient-Et-Nusas|Qiient-Qinsum',
    'Honos-Umayaum|Sandrift Steppe', 'Honos-Umayaum|Northstrand Dunes', 'Hynites-Ogozlum|Timbertop Wood',
    'Hynites-Ogozlum|Quaent-In-Odesum',
  ];
  const have = new Set(snap.edges.map(e => [e.a, e.b].sort().join('|')));
  const missing = [...new Set(expected)].filter(k => !have.has(k));
  console.log(missing.length ? `\nНЕ ХВАТАЕТ РЁБЕР: ${missing.join(', ')}` : '\nВсе ожидаемые рёбра на месте ✔');

  // Electron отдаёт пиксели в порядке BGRA, файлы с диска — RGBA. Перепутанные каналы
  // убили бы поиск жёлтой полосы-якоря, поэтому проверяем оба порядка на одном кадре.
  const rgba = await F.fromEncoded(fs.readFileSync(path.join(CAL, 'a5.png')));
  const bgra = { ...rgba, data: Buffer.from(rgba.data), bgra: true };
  for (let i = 0; i < bgra.data.length; i += 4) { const r = bgra.data[i]; bgra.data[i] = bgra.data[i + 2]; bgra.data[i + 2] = r; }
  const [tA, tB] = [await recognize.recognizeTooltip(rgba), await recognize.recognizeTooltip(bgra)];
  const same = tA && tB && tA.name === tB.name && tA.closes === tB.closes && tA.capNum === tB.capNum;
  console.log(same
    ? `Кадр BGRA даёт то же, что RGBA (${tB.name}, ${tB.capNum}/${tB.capMax}, ${tB.closes}с) ✔`
    : `ПОРЯДОК КАНАЛОВ СЛОМАН: RGBA=${JSON.stringify(tA && tA.name)} BGRA=${JSON.stringify(tB && tB.name)}`);
  if (!same) missing.push('bgra');

  // Опрос берёт из потока не весь экран, а полоску с плашкой зоны. Проверяем, что
  // распознавание по полоске даёт тот же результат, что по целому кадру.
  const sZ = rgba.height / 1080;
  const stripRect = { x: rgba.width - 400 * sZ, y: rgba.height - 48 * sZ, width: 380 * sZ, height: 30 * sZ };
  const sr = F.region(rgba, stripRect.x, stripRect.y, stripRect.width, stripRect.height);
  const stripFrame = { data: sr.buf, width: sr.width, height: sr.height, bgra: false };
  const zFull = await recognize.recognizeZone(rgba, { fast: true });
  const zStrip = await recognize.recognizeZone(stripFrame, {
    fast: true, screenHeight: rgba.height,
    zoneBarRegion: { left: 0, top: 0, width: sr.width, height: sr.height },
  });
  const stripOk = zFull && zStrip && zFull.zone === zStrip.zone;
  console.log(stripOk
    ? `Полоска ${sr.width}x${sr.height} даёт ту же зону, что целый кадр (${zStrip.zone}) ✔`
    : `ПОЛОСКА РАСХОДИТСЯ С КАДРОМ: целый=${zFull && zFull.zone} полоска=${zStrip && zStrip.zone}`);
  if (!stripOk) missing.push('strip');

  // и курсор: якорь тултипа должен находиться в квадрате вокруг него так же, как по всему кадру
  const near = tA ? { x: tA.raw.bar.bx + 60, y: tA.raw.bar.by - 40 } : null;
  const tNear = near ? await recognize.recognizeTooltip(rgba, { near }) : null;
  const nearOk = tNear && tA && tNear.name === tA.name && tNear.closes === tA.closes;
  console.log(nearOk ? 'Поиск якоря рядом с курсором даёт то же ✔' : 'ПОИСК У КУРСОРА РАСХОДИТСЯ С ПОЛНЫМ КАДРОМ');
  if (!nearOk) missing.push('near');

  // Хоткей снимает не весь экран, а прямоугольник вокруг курсора (размеры замерены в игре:
  // тултип висит НАД курсором и перекидывается влево-вправо). Проверяем на настоящем кадре.
  const BOX = { left: 360, right: 360, up: 150, down: 120 };   // синхронно с TIP_BOX в main.js
  // курсор ставим так, как он и стоял: у нижнего правого угла тултипа
  const cx = tA ? tA.raw.bar.bx + 300 : rgba.width / 2, cy = tA ? tA.raw.bar.by + 30 : rgba.height / 2;
  const bw = Math.round((BOX.left + BOX.right) * sZ), bh2 = Math.round((BOX.up + BOX.down) * sZ);
  const bx = Math.max(0, Math.min(rgba.width - bw, Math.round(cx - BOX.left * sZ)));
  const by = Math.max(0, Math.min(rgba.height - bh2, Math.round(cy - BOX.up * sZ)));
  const br = F.region(rgba, bx, by, bw, bh2);
  const boxFrame = { data: br.buf, width: br.width, height: br.height, bgra: false };
  const tBox = await recognize.recognizeTooltip(boxFrame, { screenHeight: rgba.height });
  const boxOk = tBox && tA && tBox.name === tA.name && tBox.closes === tA.closes && tBox.capNum === tA.capNum;
  console.log(boxOk
    ? `Прямоугольник ${br.width}x${br.height} у курсора даёт тот же тултип (${tBox.name}, ${tBox.closes}с) ✔`
    : `ПРЯМОУГОЛЬНИК У КУРСОРА РАСХОДИТСЯ: кадр=${tA && tA.name}/${tA && tA.closes} область=${tBox && tBox.name}/${tBox && tBox.closes}`);
  if (!boxOk) missing.push('box');
  // Кадры, присланные игроком 27 июля. Здесь важна ЗАПОЛНЕННОСТЬ полосы: якорем тултипа
  // была яркая заливка, и портал 0/7 (полоса целиком тёмная) приложение не видело вовсе,
  // а 1/7 не дотягивал до порога длины. Плюс это единственный настоящий кадр портала на 20.
  const EXTRA = [
    ['c1-drained-0-7', { name: 'Coues-Exakrom', capNum: 0, capMax: 7, closes: 3 * 3600 + 18 * 60 }, 0],
    ['c2-gold-19-20', { name: 'Suyitos-Oyarlos', capNum: 19, capMax: 20, closes: 2 * 3600 + 20 * 60 }, 0],
    // третий — обрезок экрана, а не полный кадр: масштаб задаём явно, как это делает
    // приложение для прямоугольника у курсора
    ['c3-longmarch-1-7', { name: 'Longmarch Meadow', capNum: 1, capMax: 7, closes: 4 * 3600 + 24 * 60 }, 1080],
  ];
  for (const [file, want, screenHeight] of EXTRA) {
    const p = path.join(CAL, `${file}.png`);
    if (!fs.existsSync(p)) { console.log(`${file}: кадра нет — пропуск`); continue; }
    const t = await recognize.recognizeTooltip(fs.readFileSync(p), { screenHeight });
    const got = t ? `${t.name} ${t.capNum}/${t.capMax} ${t.closes}с` : 'НЕ НАЙДЕН';
    const okAll = t && t.name === want.name && t.capNum === want.capNum
      && t.capMax === want.capMax && t.closes === want.closes;
    console.log(okAll
      ? `${file}: ${got} ✔`
      : `${file}: РАСХОЖДЕНИЕ — получил ${got}, ждал ${want.name} ${want.capNum}/${want.capMax} ${want.closes}с`);
    if (!okAll) missing.push(file);
  }

  // Pen Gent|Cairn Camain и переходы через загрузку дают ещё пассивные рёбра — это норма
  await recognize.shutdown();
  process.exit(missing.length ? 1 : 0);
})();
