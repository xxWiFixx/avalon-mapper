'use strict';

// Read synchronously while the native receive buffer is valid, then yield to input/UI.
// A busy socket resumes next tick; an empty socket sleeps. No application packet queue.
function create({ readOne, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
  budgetMs = 4, maxPackets = 256, idleMs = 60 } = {}) {
  let closed = false, timer = null;
  function tick() {
    timer = null;
    if (closed) return;
    const started = now();
    let empty = false;
    for (let n = 0; n < maxPackets && !closed; n++) {
      if (!readOne()) { empty = true; break; }
      if (now() - started >= budgetMs) break;
    }
    if (!closed) timer = schedule(tick, empty ? idleMs : 1);
  }
  timer = schedule(tick, idleMs);
  return { close() { closed = true; if (timer !== null) cancel(timer); timer = null; } };
}

module.exports = { create };
