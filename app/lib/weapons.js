'use strict';
const { items } = require('../assets/weapons.json');
function lookup(id) {
  if (!Number.isSafeInteger(id) || id <= 0 || !Object.hasOwn(items, id)) return null;
  const [key, name] = items[id];
  const tier = key.match(/^T([1-8])_/)[1], enchantment = key.match(/@([1-4])$/)?.[1];
  return { key, name: `${name} · T${tier}${enchantment ? '.' + enchantment : ''}` };
}
module.exports = { lookup };
