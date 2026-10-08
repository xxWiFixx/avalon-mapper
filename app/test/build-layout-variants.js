'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const {buildVariants,audit}=require('./layout-variants-engine');
const [input,output]=process.argv.slice(2);
const original=fs.readFileSync(input), report=JSON.parse(original),before=JSON.stringify(report.snapshot);
const started=performance.now(),result=buildVariants(report.snapshot);
for(const variant of result.variants) {
  assert.deepEqual(Object.keys(variant.positions).sort(),Object.keys(report.snapshot.positions).sort());
  assert.equal(variant.stats.overlaps,0,'Node boxes overlap');
  assert.equal(variant.stats.collinear,0,'Links overlap along the same line');
  assert.ok(variant.stats.crossings<=15,'Crossing budget exceeded');
  console.log(JSON.stringify({id:variant.id,candidates:variant.candidates,...variant.stats}));
}
assert.equal(JSON.stringify(report.snapshot),before);assert.ok(original.equals(fs.readFileSync(input)));
fs.writeFileSync(output,JSON.stringify({edges:report.snapshot.edges,zoneInfo:report.zoneInfo,at:report.snapshot.t,...result,elapsedMs:performance.now()-started}));
console.log('Duration ms',Math.round(performance.now()-started));
