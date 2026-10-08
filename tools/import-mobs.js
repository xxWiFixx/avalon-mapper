'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [mobFile, localizationFile] = process.argv.slice(2);
if (!mobFile || !localizationFile) throw new Error('Pass mobs.json and localization.json from ao-data/ao-bin-dumps');
const raw = fs.readFileSync(mobFile), mobs = JSON.parse(raw).Mobs.Mob;
const loc = new Map();
for (const entry of JSON.parse(fs.readFileSync(localizationFile, 'utf8')).tmx.body.tu) {
  if (!entry['@tuid'].startsWith('@MOB_')) continue;
  const translations = Array.isArray(entry.tuv) ? entry.tuv : [entry.tuv];
  const text = translations.find(t => t['@xml:lang'] === 'RU-RU')?.seg || translations.find(t => t['@xml:lang'] === 'EN-US')?.seg;
  if (typeof text === 'string') loc.set(entry['@tuid'], text);
}
const namesByVisual = new Map();
const visual = mob => [mob['@faction'], mob['@avatar']].join(':');
for (const mob of mobs) {
  const label = loc.get(mob['@namelocatag']) || loc.get('@MOB_' + mob['@uniquename']);
  if (label && mob['@faction'] && mob['@avatar']) {
    const names = namesByVisual.get(visual(mob)) || new Set(); names.add(label); namesByVisual.set(visual(mob), names);
  }
}
const items = Object.fromEntries(mobs.map((mob, index) => {
  const candidates = namesByVisual.get(visual(mob));
  const label = loc.get(mob['@namelocatag']) || loc.get('@MOB_' + mob['@uniquename']) ||
    (candidates?.size === 1 ? [...candidates][0] : null) || mob['@uniquename'];
  return [index + 16, [mob['@uniquename'], label, Number(mob['@tier']) || null]];
}));
if (Object.keys(items).length < 1000 || loc.size < 100) throw new Error('Incomplete catalog');
fs.writeFileSync(path.join(__dirname, '../app/assets/mobs.json'), JSON.stringify({
  source: 'https://github.com/ao-data/ao-bin-dumps', built: new Date().toISOString(),
  hash: crypto.createHash('sha256').update(raw).digest('hex'), offset: 16, items,
}) + '\n');
console.log('Imported mobs:', Object.keys(items).length, 'localized names:', loc.size);
