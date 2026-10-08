import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const destination = path.join(root, 'site/assets/map');
fs.mkdirSync(path.join(destination, 'zones'), { recursive: true });
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'app/data-static', name), 'utf8'));
const zones = [...read('zone-data.json').map(zone => ({ ...zone, color: 'avalon' })), ...read('royal-zones.json')];
const records = zones.map(zone => {
  const record = { ...zone };
  const image = zone.name + '.webp';
  if (/^[a-zA-Z0-9 -]+\.webp$/.test(image)) {
    const source = path.join(root, 'app/assets/avalon-maps-crop', image);
    if (fs.existsSync(source)) { fs.copyFileSync(source, path.join(destination, 'zones', image)); record.image = image; }
  }
  return record;
});
fs.writeFileSync(path.join(destination, 'zones.json'), JSON.stringify(records));
fs.copyFileSync(path.join(root, 'app/data-static/world-adjacency.json'), path.join(destination, 'world-adjacency.json'));
fs.mkdirSync(path.join(destination, 'icons'), { recursive: true });
for (const image of fs.readdirSync(path.join(root, 'app/assets/avalon-icons'))) {
  if (/^[a-z_]+\.webp$/.test(image)) fs.copyFileSync(path.join(root, 'app/assets/avalon-icons', image), path.join(destination, 'icons', image));
}
console.log(`Exported ${records.length} public game zones and ${records.filter(zone => zone.image).length} zone images. No player data exported.`);
