'use strict';
// Release gate: report file names and categories, never the matching credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Fingerprints of retired developer/demo identifiers. Do not reintroduce them as plaintext.
const retired = new Set([
  '3569ad4c8084400e32ff919694f0533dad3da67f392b13cd43d292b8604bb459',
  '3f06ca288df2427bee8885d739d31b5e9be1e33f6c658ce824a2e140e691ad14',
  '5d0b65f28f5fb93be31cd6be6b80df6a3481bf2431e474c85613cb678dc50941',
  'a348677b8ac1d07fda47af31830acf638813909b4a70856c696dd2615558628e',
  'd30f1a0d3eb1257e7e0b21165dd872ee339693edd07717e6304191a06748faca',
  '4c95eec85aae6597ce8a54e48ae76108449727236e83799162e607df1c25916c',
  '64aa7f59dc3f110e2d43b1423719bad9b7d67991f2ee39f0759d1afdc55bbe53',
  'ee4484d8c1c29489a74b3725103cd14fb2f5f702ac9f6dc38f194620e76ba804',
  '745a3476e94e2c87e4cd0245bae4060f6a28a45d9b86d9f9a909cf68b4002846',
  'd3767fb7f4c9c0aed5a6b859b77b681f90db78b33cf245ce49942484ebd48dab',
  '3a1a900d8a1a30d401e4ca51f3fa41fa490b2a05d75b604101162c157b0e7a0f',
  '441c10cad1a2f4fdfab5d3cbc8e051656b32965cdf5ef3cdb2c7c6fd82d2bbff',
]);
const textExt = /\.(?:js|cjs|mjs|json|html|css|txt|md|yml|yaml|sql|svg)$/i;
const mediaExt = /\.(?:png|jpe?g|webp|gif|ico)$/i;
const reviewedMedia = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, 'privacy-reviewed-media.json'), 'utf8'))));
function inspectText(text) {
  const reasons = new Set();
  if (/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<|%)[a-z0-9_.-]+/i.test(text) || /\/Users\/[a-z0-9_.-]+\//i.test(text)) reasons.add('personal-machine-path');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) reasons.add('private-key');
  if (/\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,}|sb_secret_[a-zA-Z0-9_-]{20,}|sk_live_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)) reasons.add('secret-key');
  if (/"(?:refresh_token|access_token|client_secret|service_role_key|private_key)"\s*:\s*"[a-zA-Z0-9_+=./-]{20,}"/.test(text)) reasons.add('stored-credential');
  if (/[a-z0-9._%+-]{1,64}@(?:gmail|yandex|mail|outlook|hotmail|yahoo)\.[a-z]{2,12}/i.test(text)) reasons.add('personal-email');
  for (const token of new Set(text.toLowerCase().match(/[a-z0-9_.@-]+/g) || [])) if (retired.has(hash(token))) reasons.add('retired-personal-identifier');
  for (const jwt of text.matchAll(/\beyJ[a-zA-Z0-9_-]+\.([a-zA-Z0-9_-]+)\.[a-zA-Z0-9_-]+/g)) {
    try { const claims = JSON.parse(Buffer.from(jwt[1], 'base64url')); if (claims.role !== 'anon') reasons.add('private-jwt'); } catch { reasons.add('unrecognized-jwt'); }
  }
  return [...reasons];
}
function walk(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symlink cannot be released: ' + name);
    return entry.isDirectory() ? walk(root, name + '/') : [name];
  });
}
function sourceFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json')));
  const { minimatch } = require(path.join(APP, 'node_modules/minimatch'));
  const positive = pkg.build.files.filter(p => !p.startsWith('!'));
  const negative = pkg.build.files.filter(p => p.startsWith('!')).map(p => p.slice(1));
  if (positive.some(p => p === '**/*' || p === '**')) throw new Error('Release must use an explicit runtime allowlist');
  const all = fs.readdirSync(APP, { withFileTypes: true }).flatMap(e => {
    if (['node_modules', 'test', 'tools', 'data', 'out'].includes(e.name)) return [];
    if (e.isSymbolicLink()) throw new Error('Symlink in app root');
    return e.isDirectory() ? walk(APP, e.name + '/') : [e.name];
  });
  return all.filter(f => positive.some(p => minimatch(f, p)) && !negative.some(p => minimatch(f, p)));
}
async function inspectEntries(entries, read, { dependencies = false } = {}) {
  const findings = [], totals = { files: 0, text: 0, images: 0 };
  const sharp = require(path.join(APP, 'node_modules/sharp'));
  for (const name of entries) {
    const dependency = name.startsWith('node_modules/');
    if (dependency && !dependencies) continue;
    totals.files++;
    if (!dependency && /(?:^|\/)(?:data|out|shots|failed|portal-archive|\.git|\.env(?:\.[^/]*)?|auth\.json|config\.json|credentials[^/]*|.*\.log|.*\.pcap)$/i.test(name)) findings.push({ file: name, category: 'private-file' });
    if (textExt.test(name)) {
      totals.text++;
      for (const category of inspectText(read(name).toString('utf8'))) {
        // Third-party packages include their maintainers' public contact addresses.
        if (dependency && category === 'personal-email') continue;
        findings.push({ file: name, category });
      }
    } else if (mediaExt.test(name) && !dependency) {
      totals.images++;
      if (!reviewedMedia.has(hash(read(name)))) findings.push({ file: name, category: 'unreviewed-image' });
      try {
        const metadata = await sharp(read(name), { animated: true }).metadata();
        if (metadata.exif || metadata.xmp || metadata.iptc) findings.push({ file: name, category: 'image-personal-metadata-review-required' });
      } catch (error) {
        // ICO is supplied to Electron; sharp does not decode that container.
        if (!name.endsWith('.ico')) findings.push({ file: name, category: 'unreadable-image' });
      }
    }
  }
  return { ...totals, findings };
}
function assertClean(label, result) {
  console.log(JSON.stringify({ privacy: label, ...result }));
  if (result.findings.length) throw new Error('Privacy gate failed: ' + label);
  return result;
}
async function checkSource() { return assertClean('runtime sources', await inspectEntries(sourceFiles(), name => fs.readFileSync(path.join(APP, name)))); }
async function checkAsar(file) {
  const asar = require(path.join(APP, 'node_modules/@electron/asar'));
  const names = asar.listPackage(file).map(n => n.replace(/\\/g, '/').replace(/^\//, '')).filter(n => !asar.statFile(file, path.normalize(n)).files);
  const allowed = new Set(sourceFiles());
  const unexpected = names.filter(n => !n.startsWith('node_modules/') && !allowed.has(n));
  if (unexpected.length) throw new Error('Unexpected packaged files: ' + unexpected.join(', '));
  return assertClean('packaged app', await inspectEntries(names, name => asar.extractFile(file, path.normalize(name)), { dependencies: true }));
}
async function checkSite() {
  const directory = path.join(ROOT, 'site');
  const names = walk(directory);
  const result = await inspectEntries(names, name => fs.readFileSync(path.join(directory, name)));
  for (const name of names) if (/\.(?:md|sql|map|log|zip)$/i.test(name) || /(?:^|\/)\./.test(name)) result.findings.push({ file: name, category: 'nonpublic-site-file' });
  return assertClean('static website', result);
}
// electron-builder calls beforePack before producing the archive, and afterPack afterwards.
async function hook(context) {
  // Always audit sources; an old archive must never substitute for this check.
  await checkSource();
  if (context?.appOutDir) {
    const archive = path.join(context.appOutDir, 'resources', 'app.asar');
    if (fs.existsSync(archive)) await checkAsar(archive);
  }
}
module.exports = hook;
module.exports.inspectText = inspectText;
module.exports.sourceFiles = sourceFiles;
module.exports.checkSource = checkSource;
module.exports.checkAsar = checkAsar;
module.exports.checkSite = checkSite;
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--asar' && args[1]) await checkAsar(path.resolve(args[1]));
  else if (args.includes('--site')) await checkSite();
  else await checkSource();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
