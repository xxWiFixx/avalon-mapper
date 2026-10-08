// Use the same cached game dump as the mob index; never change protocol IDs.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const [localizationFile, mobsFile, weaponsFile] = process.argv.slice(2);
const translations = new Map(), names = {};
for (const entry of JSON.parse(fs.readFileSync(localizationFile,'utf8')).tmx.body.tu) {
  const entries = Array.isArray(entry.tuv) ? entry.tuv : [entry.tuv];
  const en = entries.find(t => t?.['@xml:lang'] === 'EN-US')?.seg;
  const ru = entries.find(t => t?.['@xml:lang'] === 'RU-RU')?.seg;
  if (typeof en !== 'string') continue;
  translations.set(entry['@tuid'],en);
  if (entry['@tuid'].startsWith('@MOB_') && typeof ru === 'string') names[ru] = en;
}
const mobs = JSON.parse(fs.readFileSync(mobsFile,'utf8')).Mobs.Mob;
const visuals = new Map();
const visual = m => [m['@faction'],m['@avatar']].join(':');
for (const mob of mobs) {
  const label = translations.get(mob['@namelocatag']) || translations.get('@MOB_' + mob['@uniquename']);
  if (label && mob['@faction'] && mob['@avatar']) { const labels = visuals.get(visual(mob)) || new Set(); labels.add(label); visuals.set(visual(mob),labels); }
}
const catalog = require('../app/assets/mobs.json').items;
for (const [index,item] of Object.entries(catalog)) {
  const mob = mobs[Number(index)-16];
  if (mob?.['@uniquename'] !== item[0]) throw new Error('Game dump does not match existing mob IDs');
  const candidates = visuals.get(visual(mob));
  const label = translations.get(mob['@namelocatag']) || translations.get('@MOB_' + item[0]) || (candidates?.size === 1 ? [...candidates][0] : null);
  if (label) names[item[1]] = label;
}
for (const item of Object.values(JSON.parse(fs.readFileSync(weaponsFile,'utf8')).items)) if (item.s === 'mainhand' && item.ru && item.en) names[item.ru] = item.en;
const file = path.join(__dirname,'../app/locales/game-names.en.js');
fs.writeFileSync(file,"/* Official Albion localization, presentation only. */\n(function(root){ const names=" + JSON.stringify(names) + "; if(typeof module==='object'&&module.exports)module.exports=names;else root.AvalonGameNames=names;})(globalThis);\n");
console.log('English game names:', Object.keys(names).length);
