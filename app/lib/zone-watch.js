// Зона игрока из трафика. Связывает захват (capture-socket) и разбор (cluster)
// и отдаёт наружу ровно одно событие: «игрок перешёл в такую-то зону».
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ СЛОЙ. Захват знает про сокеты и ничего про игру; cluster знает про
// зоны и ничего про сеть. Здесь встречаются только их выводы — и здесь же живут правила
// «чему верить», которые не относятся ни к тому, ни к другому.
//
// ПОВТОРЫ. Один и тот же id приходит пачкой: сервер шлёт подтверждения, клиент
// переспрашивает. Сообщать о переходе на каждый пакет нельзя — журнал утонет, а маршрут
// пересчитается десять раз подряд. Поэтому наружу уходит только СМЕНА зоны.
const cluster = require('./cluster');

function create({ onZone, onError } = {}) {
  let socks = [];
  let last = null;

  function feed(payload) {
    const hit = cluster.pickCluster(payload);
    if (!hit || hit.id === last) return;
    last = hit.id;
    if (onZone) onZone(hit);
  }

  function start(capture) {
    stop();
    const ips = capture.localAddresses();
    if (!ips.length) throw new Error('не нашёл ни одного сетевого интерфейса');
    const errs = [];
    for (const ip of ips) {
      // Интерфейсов обычно несколько, и часть из них к игре отношения не имеет.
      // Отказ на одном — не повод бросать остальные: игра может идти по любому.
      try { socks.push(capture.open(ip, feed, onError)); }
      catch (err) { errs.push(ip + ': ' + err.message); }
    }
    if (!socks.length) throw new Error('ни один интерфейс не открылся — ' + errs.join('; '));
    return { listening: socks.map(s => s.ip), failed: errs };
  }

  function stop() {
    for (const s of socks) { try { s.close(); } catch (_) { /* уже закрыт */ } }
    socks = [];
  }

  // last сбрасываем: после паузы игрок мог перейти, и первая же зона снова новость
  function reset() { last = null; }

  return { start, stop, reset, feed, get zone() { return last && cluster.IDS[last]; } };
}

module.exports = { create };
