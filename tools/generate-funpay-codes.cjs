#!/usr/bin/env node
'use strict';
// Offline operator tool. Never bundle this or the generated private directory with the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REPOSITORY = path.resolve(__dirname, '..');
function normalizeCode(code) {
  const normalized = String(code).replace(/[-\s]/g, '').toUpperCase();
  if (!/^AM30[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{30}$/.test(normalized)) throw new Error('Invalid code format');
  return normalized;
}
function hashCode(code) { return crypto.createHash('sha256').update(normalizeCode(code), 'utf8').digest('hex'); }
function generateCode() {
  const random = crypto.randomBytes(30);
  const body = Array.from(random, n => ALPHABET[n & 31]).join('');
  return 'AM30-' + body.match(/.{5}/g).join('-');
}
function makeBatch(count) {
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Count must be an integer from 1 to 10000');
  const codes = new Set();
  while (codes.size < count) codes.add(generateCode());
  return { batchId: crypto.randomUUID(), codes: [...codes], hashes: [...codes].map(hashCode) };
}
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function restrictDirectory(directory) {
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return; }
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (identity.status !== 0 || !sid) throw new Error('Cannot determine owner identity; no codes saved');
  const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'],
    { encoding: 'utf8', windowsHide: true });
  if (acl.status !== 0) throw new Error('Cannot restrict private directory permissions; no codes saved');
}
function writeBatch(batch, parentDirectory) {
  const parent = path.resolve(parentDirectory);
  if (isInside(REPOSITORY, parent)) throw new Error('Codes must be saved outside the repository');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = fs.realpathSync(parent);
  if (isInside(fs.realpathSync(REPOSITORY), canonicalParent)) throw new Error('Codes must be saved outside the repository');
  const directory = path.join(canonicalParent, batch.batchId);
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  restrictDirectory(directory);
  const write = (name, content) => fs.writeFileSync(path.join(directory, name), content, { flag: 'wx', mode: 0o600 });
  const manifest = { batchId: batch.batchId, count: batch.codes.length, product: 'group', durationHours: 720,
    preparedAt: new Date().toISOString(), status: 'PREPARED_NOT_REGISTERED', hashes: batch.hashes };
  write('batch.json', JSON.stringify(manifest, null, 2) + '\n');
  write('codes.txt', batch.codes.join('\n') + '\n');
  write('register.sql', '-- Apply migration 22 first. This file contains SHA-256 hashes only.\n' +
    '-- Registration is idempotent. Confirm registered/available equal the expected count before sale.\n' +
    "select public.billing_register_codes('" + batch.batchId + "'::uuid, '" + JSON.stringify(batch.hashes) + "'::jsonb);\n" +
    "select public.billing_code_batch_status('" + batch.batchId + "'::uuid);\n");
  write('README.txt', 'PRIVATE SALES INVENTORY\n\n' +
    'codes.txt contains bearer activation codes. Keep it private and distribute each code once.\n' +
    'The codes are NOT registered yet and are NOT READY FOR SALE.\n' +
    'Apply migration 22, import register.sql into the correct Supabase project, and verify its returned counts.\n' +
    'Keep a record of delivered codes so the same code cannot be sold twice.\n' +
    'One activation grants one new group slot or renews one owned group for exactly 720 hours.\n' +
    'The clock starts at activation. Renewal extends from the later of server time and current expiry.\n' +
    'Do not activate sales codes for testing. Generate a separate test batch in an isolated database.\n');
  return { directory, batchId: batch.batchId, count: batch.codes.length, status: manifest.status };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const countAt = args.indexOf('--count');
    const outputAt = args.indexOf('--output');
    if (countAt < 0 || args.some((arg, i) => !['--count', '--output'].includes(arg) && !['--count', '--output'].includes(args[i - 1]))) {
      throw new Error('Usage: node tools/generate-funpay-codes.cjs --count 20 [--output ABSOLUTE_PRIVATE_DIRECTORY]');
    }
    const root = outputAt < 0 ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
      'AvalonMapper', 'private-code-batches') : args[outputAt + 1];
    if (!root || !path.isAbsolute(root)) throw new Error('Output directory must be absolute');
    const result = writeBatch(makeBatch(Number(args[countAt + 1])), root);
    // No open codes or hashes in stdout, stderr or command-line arguments.
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
module.exports = { ALPHABET, normalizeCode, hashCode, generateCode, makeBatch, writeBatch, isInside };
