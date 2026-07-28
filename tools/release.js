#!/usr/bin/env node
// Собрать установщик и приготовить файл версий рядом с ним.
//
// Приложение раздаётся файлом, поэтому релиз — это ровно две вещи:
//   dist/AvalonMapper-<версия>-setup.exe   — то, что скачивают
//   dist/latest.json                       — то, по чему приложение узнаёт о новой версии
// Оба кладутся в одно место (любой хостинг со ссылкой по https), и адрес latest.json
// вписывается в приложении: «Подключение» → «Адрес файла версий».
//
// Запуск: node tools/release.js "что нового одной строкой"
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const DIST = path.join(ROOT, 'dist');
const notes = process.argv.slice(2).join(' ').trim();

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const version = pkg.version;
const setup = `AvalonMapper-${version}-setup.exe`;

// ---------- что попадёт игроку ----------
// Список файлов сборки — чёрный: «всё, кроме перечисленного» (app/package.json → build.files).
// Такой список молча пропускает НОВОЕ. Так в установщик 0.2.0 и уехали три черновых
// скрипта из корня app/ — check-weights.js, mycheck.js, mycheck2.js, — причём один из них
// прямо в шапке просил себя удалить. Ничего опасного они не делали, но игроку в сборке
// не место ничему, чего мы туда не клали осознанно.
//
// Поэтому перед сборкой сверяем корень app/ со списком того, что там имеет право быть.
const ALLOWED_ROOT = new Set([
  'main.js', 'preload.js', 'preload-overlay.js', 'preload-search.js', 'preload-picker.js',
]);
const strays = fs.readdirSync(APP)
  .filter(n => n.endsWith('.js') && !ALLOWED_ROOT.has(n));
if (strays.length) {
  console.error('\nВ корне app/ лежат посторонние скрипты — они уедут в установщик:');
  for (const n of strays) console.error('  app/' + n);
  console.error('\nУбери их или впиши в ALLOWED_ROOT в tools/release.js, если они нужны.');
  process.exit(1);
}

console.log(`сборка версии ${version}…`);
// Зовём electron-builder НАПРЯМУЮ его же файлом, а не через npx.
//
// Раньше тут был execFileSync('npx.cmd', …) — и на Node 24 он падает с EINVAL: с версии
// 20 Node на Windows отказывается запускать .cmd и .bat без shell: true, потому что это
// была дыра с подстановкой аргументов (CVE-2024-27980). Включать shell ради этого не
// хочется: тогда всё, что мы передаём, снова проходит через разбор командной строки.
// Свой же файл в node_modules запускается тем самым node, что уже работает, и никакого
// разбора строки в этом пути нет вовсе.
const builder = require.resolve('electron-builder/cli.js', { paths: [APP] });
execFileSync(process.execPath, [builder, '--win', '--x64'], { cwd: APP, stdio: 'inherit' });

const exe = path.join(DIST, setup);
if (!fs.existsSync(exe)) { console.error('не нашёл', exe); process.exit(1); }
const mb = (fs.statSync(exe).size / 1048576).toFixed(1);

// БАЗОВЫЙ АДРЕС — куда ты кладёшь файлы. Ссылка на установщик должна быть на ТОМ ЖЕ
// хосте, что и сам latest.json: приложение открывает только такие (см. lib/update.js).
const base = (process.env.RELEASE_BASE || '').replace(/\/+$/, '');
const latest = {
  version,
  url: base ? `${base}/${setup}` : '',
  notes: notes || `версия ${version}`,
  size: Number(mb),
  date: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(path.join(DIST, 'latest.json'), JSON.stringify(latest, null, 1));

console.log('\nготово:');
console.log('  ' + exe, `(${mb} МБ)`);
console.log('  ' + path.join(DIST, 'latest.json'));
// Куда приложение будет смотреть за обновлениями, зашито в сборку. От этого зависит и то,
// что делать дальше: у GitHub Releases свой список файлов, и latest.json там не нужен вовсе.
const builtin = /const BUILTIN_UPDATE = '([^']*)'/.exec(
  fs.readFileSync(path.join(APP, 'main.js'), 'utf8'));
const target = builtin ? builtin[1] : '';
const gh = /^[\w.-]+\/[\w.-]+$/.test(target);

console.log('\nДальше:');
if (gh) {
  console.log(`  1. https://github.com/${target}/releases/new`);
  console.log(`  2. тег v${version}, к нему прикрепить ${setup}`);
  console.log('  3. Publish release');
  console.log(`\nПриложение спрашивает про новые версии у https://api.github.com/repos/${target}/releases/latest`);
  console.log('и ведёт игрока на страницу выпуска. latest.json для этого пути не нужен —');
  console.log('он лежит рядом на случай, если раздача когда-нибудь переедет на свой хостинг.');
} else if (target) {
  console.log('  оба файла — на хостинг ' + target);
} else {
  console.log('  BUILTIN_UPDATE в app/main.js пуст — приложение не будет искать обновления вовсе.');
}
if (!gh && !base) {
  console.log('\nАдрес раздачи не задан — в latest.json пустая ссылка. Задай так:');
  console.log('  RELEASE_BASE=https://твой-хост/avalon node tools/release.js "что нового"');
}
