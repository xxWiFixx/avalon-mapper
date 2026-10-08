'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');

function productionFunction(name) {
  let start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'Missing production function: ' + name);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  return source.slice(start, start + end.index + end[0].length);
}

function loadFlow(context) {
  vm.runInContext(source.slice(source.indexOf('let uIOhook ='),
    source.indexOf('// ---------- захват экрана ----------')), context);
  vm.runInContext(source.slice(source.indexOf('let search = null,'),
    source.indexOf("ipcMain.handle('open-shots'")), context);
  vm.runInContext(['runHotkeySearch', 'saveEdge', 'savePortal', 'applyTip']
    .map(productionFunction).join('\n'), context);
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('capture-binding'"),
    source.indexOf("ipcMain.handle('clear-overlay-toggle-binding'")), context);
}

module.exports = { loadFlow, productionFunction };
