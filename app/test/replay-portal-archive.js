// Replay saved portal screenshots without changing the user's archive or map.
// Usage: node test/replay-portal-archive.js [directory containing archive JSON] [minimum filename]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const recognize = require('../lib/recognize');
const frame = require('../lib/frame');

const archive = process.argv[2] || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'avalon-mapper', 'shots', 'portal-archive', 'failed');

(async () => {
  const entries = fs.readdirSync(archive).filter(name => name.endsWith('.json')
    && (!process.argv[3] || name >= process.argv[3])).sort();
  await recognize.init();
  try {
    for (const name of entries) {
      const record = JSON.parse(fs.readFileSync(path.join(archive, name), 'utf8'));
      const png = path.join(archive, record.images.portal);
      const image = await frame.fromEncoded(fs.readFileSync(png));
      const started = Date.now();
      // Archived hotkey frames are cropped around the pointer; their height is
      // not the game's full screen height. The saved anchor records UI scale.
      const screenHeight = Number(process.env.REPLAY_SCREEN_HEIGHT) || record.capture?.screenHeight
        || Math.round((record.raw?.bar?.scale || 1) * 1080);
      const tip = await recognize.recognizeTooltip(image, { screenHeight });
      console.log(JSON.stringify({ id: record.id, ms: Date.now() - started,
        name: tip?.name ?? null, cap: tip ? `${tip.capNum}/${tip.capMax}` : null,
        closes: tip?.closes ?? null, timerUncertain: tip?.timerUncertain ?? null,
        bar: tip?.raw?.bar ?? null, timerRegion: tip?.raw?.timerRegion ?? null,
        capReads: tip?.raw?.capReads ?? null, approximate: tip?.capNumApprox ?? null,
        timerReads: tip?.raw?.timerReads ?? null }));
    }
  } finally { await recognize.shutdown(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
