'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const recognize = require('../lib/recognize');
const F = require('../lib/frame');
// Full captures contain players' names and remain in the local private archive.
// Public CI uses the anonymous tooltip crops and synthetic recovery tests.
const manifest = path.join(__dirname, 'fixtures/portal-recovery-cases.json');
const cases = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : [];

// Original archive pixels, including the scene outside the tooltip. Cropping
// these further would remove the background that caused the original failures.
// These are regression fixtures, not a new independent accuracy benchmark.
test('production portal recovery preserves full hours, verifies faint/scaled rows and refuses overlapping timers', { skip: cases.length === 0 ? 'Private full-screen archive is not distributed' : false }, async t => {
  await recognize.init();
  try {
    for (const expected of cases) {
      await t.test(expected.file, async () => {
        const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', expected.file));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, 'unchanged source pixels');
        const frame = await F.fromEncoded(bytes), previews = [];
        const tip = await recognize.recognizeTooltip(frame, {
          screenHeight: expected.screenHeight,
          // Exclude every template from this capture episode, including when
          // its source was previously used to construct the frozen model.
          recoveryExcludeEpisode: expected.excludeEpisode,
          onName: value => previews.push(value),
        });
        assert.equal(tip?.name, expected.name, 'portal identity');
        assert.equal(tip.closes, expected.closes, 'complete duration or explicit refusal');
        assert.equal(tip.timerUncertain, expected.closes === null, 'uncertainty must match the delivered result');
        assert.equal(tip.capMax, expected.capMax, 'capacity size');
        assert.equal(tip.capNum, null, 'only portal size is published, never the current numerator');
        assert.equal(tip.capMaxKnown, expected.capMax !== null);
        assert.equal(tip.capNumApprox, false, 'fill geometry cannot create an estimated count');
        assert.equal(tip.raw.portalRecovery.version, 5);
        assert.equal(tip.raw.portalRecovery.excludedEpisode, expected.excludeEpisode);
        assert.ok(previews.length > 0, 'original or recovered identity is available to preview');
        assert.ok(previews.every(p => p.name === expected.name), 'no conflicting intermediate identity');
        for (const preview of previews) {
          assert.equal(Object.hasOwn(preview, 'closes'), false, 'preview cannot publish an unchecked timer');
          assert.equal(Object.hasOwn(preview, 'capMax'), false, 'preview is not a writable numeric observation');
        }
      });
    }
  } finally {
    await recognize.shutdown();
  }
});
