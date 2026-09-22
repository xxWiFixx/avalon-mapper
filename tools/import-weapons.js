// Copy the verified Ava Buff item index into a standalone, minimal weapon catalog.
// Usage: node tools/import-weapons.js ../avalon-buffs/data/items.json
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const source = process.argv[2];
if (!source) throw new Error('Pass the path to Ava Buff data/items.json');
const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
const items = Object.fromEntries(Object.entries(raw.items).filter(([id, item]) =>
  /^\d+$/.test(id) && item.s === 'mainhand' && /^T[1-8]_[A-Z0-9_]+(?:@[1-4])?$/.test(item.k)
).map(([id, item]) => [id, [item.k, item.ru || item.en || item.k]]));
if (Object.keys(items).length < 1000) throw new Error('Incomplete weapon catalog');
fs.writeFileSync(path.join(__dirname, '../app/assets/weapons.json'), JSON.stringify({
  source: 'Ava Buff items.json', built: raw.built, rule: raw.rule, items,
}) + '\n');
console.log(`Imported ${Object.keys(items).length} main-hand items`);
