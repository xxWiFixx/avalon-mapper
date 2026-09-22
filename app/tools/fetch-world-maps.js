// Карты зон КОРОЛЕВСТВА и чёрных земель — из открытого проекта OpenRadar.
//
// ЗАЧЕМ. Оверлей умеет показывать карту зоны, но только для Авалона: свои 397 картинок
// лежат в assets/avalon-maps-crop. Для зон мира карт не было вовсе — в overlay.js так и
// написано: «у зон королевства карт нет». OpenRadar (github.com/Nouuu/Albion-Online-OpenRadar,
// лицензия MIT) держит фоны зон, названные ровно теми же id кластеров, что у нас в
// data-static/cluster-ids.json. Совпадение полное: из 454 наших зон мира картинка есть
// у 438.
//
// ПОЧЕМУ ИНСТРУМЕНТОМ, А НЕ ФАЙЛАМИ В РЕПОЗИТОРИИ. Двадцать два мегабайта чужих
// картинок в истории git — решение владельца, а не моё. Скачал — они появились; не
// нужны — удалил папку, и приложение честно вернётся к «карты нет».
//
// ЧТО НЕ БЕРЁМ. Только фоны зон. Сам радар OpenRadar показывает позиции ЧУЖИХ игроков —
// именно то, что поддержка Albion назвала строго запрещённым (см. память проекта).
// Оттуда сюда не переезжает ничего, кроме картинок местности.
//
// Запуск:  node tools/fetch-world-maps.js
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'Nouuu/Albion-Online-OpenRadar';
const LIST = 'https://api.github.com/repos/' + REPO + '/contents/web/images/Maps';
const OUT = path.join(__dirname, '..', 'assets', 'world-maps');
const IDS = require('../data-static/cluster-ids.json');
const UA = { 'User-Agent': 'avalon-mapper-fetch-maps', Accept: 'application/vnd.github+json' };

function get(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers, timeout: 30000 }, res => {
      // GitHub отдаёт файлы редиректом на другой хост — идём за ним сами.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, headers));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve(Buffer.concat(parts)));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('таймаут ' + url)); });
  });
}

// Зоны мира — четырёхзначный id. Дороги Авалона (TNL-…) пропускаем: своих карт у нас
// больше и они уже обрезаны под плашку.
const wanted = new Set(Object.keys(IDS).filter(k => /^\d{4}$/.test(k)));

(async () => {
  console.log('зон мира в справочнике:', wanted.size);
  let list;
  try {
    list = JSON.parse((await get(LIST, UA)).toString('utf8'));
  } catch (err) {
    console.error('не удалось получить список картинок:', err.message);
    process.exit(1);
  }
  const files = list.filter(f => /^\d{4}\.webp$/.test(f.name) && wanted.has(f.name.slice(0, 4)));
  const bytes = files.reduce((s, f) => s + f.size, 0);
  console.log('нашлось подходящих:', files.length, '(' + (bytes / 1048576).toFixed(1) + ' МБ)');

  fs.mkdirSync(OUT, { recursive: true });
  let got = 0, skip = 0, bad = 0;
  for (const f of files) {
    const dst = path.join(OUT, f.name);
    // Уже скачанное не трогаем: инструмент можно гонять повторно, он до-качивает.
    if (fs.existsSync(dst) && fs.statSync(dst).size === f.size) { skip++; continue; }
    try {
      fs.writeFileSync(dst, await get(f.download_url, { 'User-Agent': UA['User-Agent'] }));
      got++;
      if (got % 50 === 0) console.log('  скачано', got + '…');
    } catch (err) { bad++; console.warn('  не вышло', f.name + ':', err.message); }
  }

  // MIT требует сохранить уведомление об авторстве рядом с файлами. Не формальность:
  // без него через полгода никто не вспомнит, откуда взялась папка на двадцать мегабайт.
  fs.writeFileSync(path.join(OUT, 'ОТКУДА.txt'),
    'Фоны зон взяты из OpenRadar — https://github.com/' + REPO + '\n'
    + 'Лицензия проекта: MIT. Уведомление об авторстве сохраняется здесь по её требованию.\n\n'
    + 'MIT License, Copyright (c) OpenRadar contributors.\n'
    + 'Permission is hereby granted, free of charge, to any person obtaining a copy of this\n'
    + 'software and associated documentation files (the "Software"), to deal in the Software\n'
    + 'without restriction... (полный текст — в LICENSE репозитория выше).\n\n'
    + 'Сама местность на картинках — игровые данные Sandbox Interactive. Здесь они лежат\n'
    + 'для личного использования в этом приложении; распространять их отдельно не следует.\n\n'
    + 'Скачано инструментом tools/fetch-world-maps.js, ' + new Date().toISOString().slice(0, 10) + '\n');

  const have = fs.readdirSync(OUT).filter(n => /^\d{4}\.webp$/.test(n)).length;
  const miss = [...wanted].filter(id => !fs.existsSync(path.join(OUT, id + '.webp')));
  console.log('\nскачано ' + got + ', уже было ' + skip + ', не вышло ' + bad);
  console.log('карт в папке: ' + have + ' из ' + wanted.size + ' зон мира ('
    + Math.round(have / wanted.size * 100) + '%)');
  if (miss.length) console.log('без карты остались: ' + miss.map(id => id + ' ' + IDS[id]).join(', '));
})();
