'use strict';
const { items } = require('../assets/mobs.json');
function lookup(index) {
  const item = Number.isSafeInteger(index) && Object.hasOwn(items, index) ? items[index] : null;
  return item ? { key: item[0], name: item[1], tier: item[2] } : null;
}
module.exports = { lookup };
