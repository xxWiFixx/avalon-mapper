#!/usr/bin/env node
// Иконка приложения. Мотив тот же, что во всём интерфейсе: ромб зоны Авалона на тёплом
// почти-чёрном, золото Albion. Внутри — перекрестье дорог: именно дороги мы и картируем.
// Читаться должно с 32 px, поэтому линий мало и они толстые.
//
// Запуск: node tools/make-app-icon.js   → build/icon.png (512x512, из него electron-builder
// соберёт .ico со всеми размерами сам)
const fs = require('fs');
const path = require('path');
const sharp = require('../app/node_modules/sharp');

const OUT = path.join(__dirname, '..', 'build');
const S = 512;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#241d1b"/>
      <stop offset="1" stop-color="#120e0d"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6c874"/>
      <stop offset="1" stop-color="#c98d2a"/>
    </linearGradient>
  </defs>

  <rect width="512" height="512" rx="104" fill="url(#bg)"/>
  <rect x="6" y="6" width="500" height="500" rx="99" fill="none" stroke="#c9bda626" stroke-width="8"/>

  <!-- поле зоны: тот же тёмно-сиреневый, что на игровых картах -->
  <path d="M256 96 L416 256 L256 416 L96 256 Z" fill="#39304a"/>
  <path d="M256 96 L416 256 L256 416 L96 256 Z" fill="none" stroke="url(#gold)" stroke-width="16" stroke-linejoin="round"/>

  <!-- дороги: перекрестье с узлами на концах, как выходы к порталам -->
  <g stroke="#e8a13f" stroke-width="20" stroke-linecap="round">
    <path d="M256 170 L256 342"/>
    <path d="M170 256 L342 256"/>
  </g>
  <g fill="#f6c874">
    <circle cx="256" cy="256" r="26"/>
    <circle cx="256" cy="160" r="17"/>
    <circle cx="256" cy="352" r="17"/>
    <circle cx="160" cy="256" r="17"/>
    <circle cx="352" cy="256" r="17"/>
  </g>
</svg>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const png = path.join(OUT, 'icon.png');
  await sharp(Buffer.from(svg)).png().toFile(png);
  // маленький размер — проверить глазами, что не превращается в кашу
  await sharp(Buffer.from(svg)).resize(32, 32).png().toFile(path.join(OUT, 'icon-32.png'));
  console.log('иконка:', png, '512x512 (+ icon-32.png для проверки)');
})();
