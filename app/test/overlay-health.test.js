'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { create } = require('../lib/overlay-health');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let clock = 0, id = 0, paused = false, stopped = false;
  const timers = new Map(), events = [], revived = [];
  const health = create({ now: () => clock, paused: () => paused, stopped: () => stopped,
    schedule: (fn, ms) => { timers.set(++id, { fn, at: clock + ms }); return id; },
    cancel: key => timers.delete(key), log: event => events.push(event) });
  function advance(ms) {
    const end = clock + ms;
    while (true) {
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    clock = end;
  }
  function attach(kind = 'damage', options = {}) {
    const window = new EventEmitter(); window.webContents = new EventEmitter();
    window.isDestroyed = () => window.destroyed === true;
    window.webContents.executeJavaScript = () => Promise.resolve('complete');
    window.close = () => { window.destroyed = true; window.emit('closed'); };
    health.watch(window, { kind, recover: reason => revived.push({ kind, reason }), ...options });
    return window;
  }
  return { health, attach, advance, events, revived, timers,
    pause: value => { paused = value; }, stop: () => { stopped = true; },
    jump: ms => { clock += ms; }, runOverdue() { for (const [id, job] of [...timers]) { if (job.at <= clock) { timers.delete(id); job.fn(); } } } };
}

test('all four overlay renderers recover independently after a crash', () => {
  const f = fixture();
  for (const kind of ['portal', 'fame', 'damage', 'food']) f.attach(kind).webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(f.revived.length, 0); f.advance(1500);
  assert.deepEqual(f.revived.map(row => row.kind), ['portal', 'fame', 'damage', 'food']);
  assert.equal(f.timers.size, 0);
});

test('a renderer that silently stops answering is replaced and a late response cannot revive it twice', async () => {
  const f = fixture(), window = f.attach(); let answer;
  window.webContents.executeJavaScript = () => new Promise(resolve => { answer = resolve; });
  f.advance(15000); f.health.tick(); f.health.tick();
  assert.equal(f.timers.size, 1, 'one in-flight health check only');
  f.advance(5000); f.advance(1500);
  assert.equal(f.revived[0].reason, 'renderer-timeout');
  answer('complete'); await turn(); assert.equal(f.revived.length, 1);
});

test('normal hidden renderers answer probes; an unresponsive renderer gets a bounded check', async () => {
  const f = fixture(), window = f.attach();
  f.advance(15000); f.health.tick(); await turn(); f.advance(7000);
  assert.equal(f.revived.length, 0); assert.equal(f.timers.size, 0);
  window.webContents.executeJavaScript = () => new Promise(() => {});
  window.webContents.emit('unresponsive'); f.advance(6500);
  assert.equal(f.revived.length, 1);
});

test('four hours AFK followed by unlock recovers every native window even when JS still answers', () => {
  const f = fixture();
  for (const kind of ['portal', 'fame', 'damage', 'food']) f.attach(kind);
  f.pause(true); f.advance(4 * 60 * 60 * 1000); f.health.tick();
  assert.equal(f.timers.size, 0, 'no renderer work while the game is inactive');
  f.pause(false); f.health.wake('system-unlock-screen'); f.advance(1500);
  assert.equal(f.revived.length, 4);
  assert.ok(f.revived.every(event => event.reason === 'system-unlock-screen'));
});

test('a stalled main clock after sleep does not mistake every page for a frozen renderer', async () => {
  const f = fixture(), window = f.attach();
  window.webContents.executeJavaScript = () => new Promise(() => {});
  f.advance(15000); f.health.tick(); f.jump(4 * 60 * 60 * 1000); f.runOverdue();
  assert.equal(f.revived.length, 0); assert.equal(f.timers.size, 0);
  window.webContents.executeJavaScript = () => Promise.resolve('complete');
  f.advance(5000); f.health.tick(); await turn(); f.advance(6500);
  assert.equal(f.revived.length, 0);
});

test('closing a tool while its recovery is pending prevents it reopening; stopping cancels all work', () => {
  const f = fixture(), window = f.attach();
  window.webContents.emit('render-process-gone'); window.close(); f.advance(1500);
  assert.equal(f.revived.length, 0);
  const other = f.attach('fame'); other.webContents.emit('render-process-gone');
  f.stop(); f.health.close(); f.advance(60000);
  assert.equal(f.revived.length, 0); assert.equal(f.timers.size, 0);
});

test('repeated immediate crashes back off and recover later instead of permanently giving up', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) { f.attach('portal').webContents.emit('render-process-gone'); f.advance(1500); }
  f.attach('portal').webContents.emit('render-process-gone');
  f.advance(1500); assert.equal(f.revived.length, 3);
  f.advance(60000); assert.equal(f.revived.length, 4);
});

test('lost native portal windows recover, aborted loads are ignored and a stale window cannot affect its replacement', () => {
  const f = fixture(); let current = true;
  const window = f.attach('portal', { recoverClosed: true, current: () => current });
  window.webContents.emit('did-fail-load', {}, -3, '', '', true);
  assert.equal(f.timers.size, 0);
  window.close(); f.advance(1500); assert.equal(f.revived.length, 1);
  const stale = f.attach('damage', { current: () => current }); current = false;
  stale.webContents.emit('render-process-gone'); f.advance(20000);
  assert.equal(f.revived.length, 1);
});

test('return from long AFK rebuilds native views once, without treating ordinary input as a failure', () => {
  const f = fixture(); f.attach('portal');
  f.health.activity(4 * 3600); assert.equal(f.revived.length, 0);
  f.health.activity(0); f.health.activity(0); f.advance(1500);
  assert.equal(f.revived.length, 1); assert.equal(f.revived[0].reason, 'idle-return');
  f.attach('damage'); f.health.activity(2); f.health.activity(0); f.advance(1500);
  assert.equal(f.revived.length, 1);
});

test('normal sleep/wake transitions do not exhaust the failure recovery budget', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) { f.attach('portal'); f.health.wake('system-resume'); f.advance(1500); }
  assert.equal(f.revived.length, 5);
  assert.ok(f.events.filter(event => event.event === 'recover-scheduled').every(event => event.delayMs === 1500));
});
