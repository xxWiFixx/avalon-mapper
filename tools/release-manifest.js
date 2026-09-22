'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'app/package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const name = 'AvalonMapper-' + pkg.version + '-setup.exe';
const data = fs.readFileSync(path.join(dist, name));
const sha256 = crypto.createHash('sha256').update(data).digest('hex');
const onGitHub = process.env.GITHUB_ACTIONS === 'true';
const info = {
  version: pkg.version, file: name, bytes: data.length, sha256,
  source: onGitHub ? 'github-actions' : 'local',
  commit: onGitHub ? process.env.GITHUB_SHA : null,
  repository: onGitHub ? process.env.GITHUB_REPOSITORY : null,
  run: onGitHub ? 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID : null,
};
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), sha256 + '  ' + name + '\n');
fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('Created SHA256SUMS and build-info.json for ' + name);
