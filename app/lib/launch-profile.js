'use strict';
const fs = require('node:fs');

const SECOND_ACCOUNT = '--second-account';
function initialize(app, { argv = process.argv, files = fs } = {}) {
  const primaryDataDir = app.getPath('userData');
  const secondary = argv.includes(SECOND_ACCOUNT);
  const dataDir = secondary ? primaryDataDir + '-second-account' : primaryDataDir;
  if (secondary) {
    // Both the singleton lock and Chromium storage must select the profile
    // before app.ready. Never reuse the first account's cookies or token files.
    files.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    app.setPath('sessionData', dataDir);
  }
  return { secondary, dataDir, primaryDataDir,
    title: secondary ? 'Avalon Mapper — Второй аккаунт' : 'Avalon Mapper' };
}

function initialConfig(primary = {}) {
  const config = { zoneSource: 'off', zoneWatch: false, overlayEnabled: false,
    fameEnabled: false, damageEnabled: false, copyWorldZone: false, onboardingSeen: true };
  // Only public connection settings and theme are inherited. Memberships,
  // account ids, personal map, tokens and the upload queue start independently.
  for (const key of ['syncUrl', 'syncKey', 'updateUrl', 'theme', 'language'])
    if (typeof primary[key] === 'string') config[key] = primary[key];
  return config;
}

module.exports = { initialize, initialConfig, SECOND_ACCOUNT };
