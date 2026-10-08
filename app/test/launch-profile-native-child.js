// Child of launch-profile-native-smoke.js: no accounts, game capture or network.
const { app, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { initialize } = require('../lib/launch-profile');
const base = process.argv.find(arg => arg.startsWith('--test-root=')).slice('--test-root='.length);
fs.mkdirSync(base, { recursive: true }); app.setPath('userData', base);
const profile = initialize(app);
if (!app.requestSingleInstanceLock()) { console.log('profile already locked'); app.exit(0); }
else app.whenReady().then(async () => {
  const owner = profile.secondary ? 'second' : 'first';
  await session.defaultSession.cookies.set({ url: 'http://profile.invalid', name: 'account', value: owner });
  fs.writeFileSync(path.join(profile.dataDir, 'auth.json'), JSON.stringify({ testOwner: owner }));
  fs.writeFileSync(path.join(profile.dataDir, 'map.json'), JSON.stringify({ testOwner: owner }));
  const cookies = await session.defaultSession.cookies.get({ url: 'http://profile.invalid', name: 'account' });
  const report = { owner, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), cookie: cookies[0]?.value };
  fs.writeFileSync(path.join(base, owner + '-ready.json'), JSON.stringify(report));
  const watchdog = setTimeout(() => app.exit(2), 30000);
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(base, 'finish'))) return;
    clearInterval(timer); clearTimeout(watchdog); app.exit(0);
  }, 50);
}).catch(error => { console.error(error); app.exit(1); });
