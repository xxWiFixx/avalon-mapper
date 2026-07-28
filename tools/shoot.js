// Снимок интерфейса в PNG — чтобы смотреть на оформление, не поднимая приложение.
// Рисует headless-браузером ту же страницу, что открывает окно карты.
// Требует запущенного стенда:  node tools/dev-server.js
//
//   node tools/shoot.js                        → стенд оформления, 1440x900
//   node tools/shoot.js "/ui/index.html?route" out.png 1500 900
//   node tools/shoot.js "/ui/index.html" ui@2x.png 1300 760 2     ← последний аргумент: масштаб
// В Git Bash путь, начинающийся со «/», превращается в путь Windows — там передавай
// адрес целиком: node tools/shoot.js "http://localhost:5178/ui/harness.html" out.png
//
// Движение по умолчанию выключено (--force-prefers-reduced-motion): иначе кадр ловит
// анимации появления на полпути и шаги маршрута выходят полупрозрачными.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const browser = BROWSERS.find(p => fs.existsSync(p));
if (!browser) { console.error('не нашёл chrome/edge — впиши путь в BROWSERS'); process.exit(1); }

const [pageArg, outArg, wArg, hArg, scaleArg] = process.argv.slice(2);
const page = pageArg || '/ui/harness.html';
const url = page.startsWith('http') ? page : `http://localhost:${process.env.PORT || 5178}${page}`;
const out = path.resolve(outArg || 'shot.png');
const W = Number(wArg) || 1440, H = Number(hArg) || 900, SCALE = Number(scaleArg) || 1;

execFileSync(browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--force-prefers-reduced-motion',
  `--force-device-scale-factor=${SCALE}`,
  `--window-size=${W},${H}`,
  '--virtual-time-budget=6000',
  `--screenshot=${out}`,
  url,
], { stdio: 'inherit' });
console.log(`${out}  ${W}x${H}${SCALE > 1 ? ` @${SCALE}x` : ''}  ←  ${url}`);
