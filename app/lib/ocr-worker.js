'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

// One Tesseract worker, with bounded requests and lazy replacement after a failure.
// Termination alone does not reject Tesseract's pending promises: always reject our
// own wait too, so the caller unwinds and the main OCR queue can advance.
function create({ factory, requestMs = 5000, initMs = 30000 } = {}) {
  const deadlines = new AsyncLocalStorage();
  let worker = null, starting = null, generation = 0;
  const timeoutError = () => Object.assign(new Error('Распознавание заняло слишком долго. Повтори хоткей — OCR восстановится автоматически.'), { code: 'OCR_TIMEOUT' });
  function wait(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), Math.max(1, ms));
    })]).finally(() => clearTimeout(timer));
  }
  function stop(w) { if (w) Promise.resolve().then(() => w.terminate()).catch(() => {}); }
  async function init() {
    if (worker) return worker;
    if (!starting) {
      const id = generation;
      const pending = Promise.resolve().then(factory).then(w => {
        if (id !== generation) { stop(w); throw new Error('OCR остановлен'); }
        worker = w;
        return w;
      });
      starting = pending;
      // Keep a timed-out initialization in flight: never spawn extra workers while
      // it is still loading. A late result remains usable by the next request.
      pending.finally(() => { if (starting === pending) starting = null; }).catch(() => {});
    }
    return wait(starting, initMs);
  }
  async function run(image, parameters) {
    const w = await init();
    const remaining = (deadlines.getStore() ?? Infinity) - Date.now();
    if (remaining <= 0) throw timeoutError();
    try {
      return await wait((async () => {
        await w.setParameters(parameters);
        return w.recognize(image);
      })(), Math.min(requestMs, remaining));
    } catch (err) {
      if (worker === w) worker = null;
      stop(w);
      throw err;
    }
  }
  function withDeadline(fn, ms) { return deadlines.run(Date.now() + ms, fn); }
  async function shutdown() {
    generation++;
    const w = worker; worker = null;
    stop(w);
  }
  return { init, run, withDeadline, shutdown };
}

module.exports = { create };
