const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const recognize=require('../lib/recognize'),F=require('../lib/frame');
const cases=require('./fixtures/portal-archive-cases.json');

test('archived tooltips preserve names, complete timers and portal size despite faint digits, portal glow and map noise', async () => {
  await recognize.init();
  try {
    for (const expected of cases) {
      const frame=await F.fromEncoded(fs.readFileSync(path.join(__dirname,'fixtures',expected.file)));
      const tip=await recognize.recognizeTooltip(frame,{screenHeight:expected.screenHeight});
      assert.equal(tip?.name,expected.name,expected.file);
      assert.equal(tip.closes,expected.closes,expected.name+' timer');
      assert.equal(tip.timerUncertain,false,expected.name+' confidence');
      assert.equal(tip.capMax,expected.capacity,expected.name+' capacity');
      assert.equal(tip.capMaxKnown,true,expected.name+' known size');
      assert.equal(tip.capNum,null,expected.file+' publishes only portal size');
      assert.equal(tip.capNumApprox,false,expected.file+' does not estimate a numerator');
    }
  } finally { await recognize.shutdown(); }
});
