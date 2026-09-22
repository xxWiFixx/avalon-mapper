'use strict';

function create({ now = Date.now, retryMs = 30000, release = () => {} } = {}) {
  let retryAt = 0;
  return {
    available: () => now() >= retryAt,
    failed() { retryAt = now() + retryMs; release(); },
  };
}

// Desktop capture cannot be cancelled by Electron. Time out the caller but keep the
// native request registered until it actually ends; repeated hotkeys cannot pile up
// expensive captures or accidentally reuse a screenshot from an earlier hotkey.
function singleFlight({ timeoutMs = 8000 } = {}) {
  let active = null;
  return async function run(fn) {
    if (active) throw new Error('Захват экрана ещё занят. Повтори хоткей через несколько секунд.');
    const pending = Promise.resolve().then(fn);
    active = pending;
    pending.finally(() => { if (active === pending) active = null; }).catch(() => {});
    let timer;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Захват экрана не ответил вовремя. Повтори хоткей.')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
}

module.exports = { create, singleFlight };
