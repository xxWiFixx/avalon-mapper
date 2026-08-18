// Разбор протокола Photon — ровно настолько, чтобы отличить ОДНУ операцию от всех прочих.
//
// ЗАЧЕМ ЭТО ВООБЩЕ ПОЯВИЛОСЬ. Сначала зона искалась в пакете поиском строки: «есть
// TNL-244 — значит игрок там». На записи настоящей игры это дало 497 срабатываний
// и 167 разных зон там, где переходов было тринадцать. Причина простая: id зоны лежит
// не только в сообщении о переходе. Его шлют opGetClusterMapInfo (открытая карта),
// opSubscribeToCluster (список соседей), opClientPerformanceStats (телеметрия) и opJoin.
// Отличить их по содержимому нельзя — они выглядят одинаково. Отличить можно только
// по тому, ЧТО ЗА СООБЩЕНИЕ пришло, а для этого его надо разобрать.
//
// ЧТО РАЗБИРАЕМ. Только ответы на операции (тип 3). Событий в потоке в триста раз
// больше (105930 против 331 на нашей записи), и ни одно из них нам не нужно — поэтому
// они даже не читаются. Это не упрощение ради лени, а экономия: разбор идёт на каждый
// пакет живого трафика.
//
// ЧЕГО НЕ УМЕЕМ. Таблица типов неполная: составные значения (массивы, словари) внутри
// больших ответов вроде opJoin не читаются. Встретили незнакомый тип — сообщение
// отбрасывается целиком. Для нашей задачи этого хватает: у ответа opChangeCluster
// параметры простые (строка, число), и на записи разобрались все тринадцать.
//
// ГЛАВНАЯ СТРАХОВКА. Разбор обязан закончиться ровно на конце сообщения. Если сошлись
// не байт в байт — значит таблица типов где-то соврала, и такому разбору верить нельзя:
// сообщение отбрасывается. Без этой проверки ошибка в размере одного типа сдвинула бы
// всё дальнейшее и выдала бы мусор, похожий на настоящую зону.

const MAGIC = 0xf3;
const RESPONSE = 3;                 // тип сообщения: ответ на операцию
const CMD_HDR = 12;                 // заголовок команды Photon
const P_OPCODE = 253;               // параметр с кодом операции
const CMD_RELIABLE = 6, CMD_UNRELIABLE = 7;

// Размеры значений с фиксированной длиной. Выведены из записи: подбирался тот размер,
// при котором разбор сходится на конце сообщения (см. страховку выше).
const SIZE = { 0: 0, 1: 0, 8: 0, 4: 2, 11: 1, 13: 2, 71: 1 };
const T_STRING = 7, T_INT16 = 4, T_INT8 = 11, T_INT16B = 13, T_BYTE = 71;

// Длина строки — переменная (LEB128), как и везде в этом протоколе.
function varint(b, p) {
  let n = 0, sh = 0;
  for (;;) {
    if (p >= b.length) return null;
    const x = b[p++];
    n |= (x & 0x7f) << sh;
    if (!(x & 0x80)) return [n, p];
    sh += 7;
    if (sh > 28) return null;
  }
}

// Конец значения типа t, начинающегося в p. null — тип незнаком или значение не влезло.
function skip(b, p, t) {
  const fixed = SIZE[t];
  if (fixed !== undefined) return p + fixed <= b.length ? p + fixed : null;
  if (t === T_STRING) {
    const v = varint(b, p);
    if (!v) return null;
    return v[1] + v[0] <= b.length ? v[1] + v[0] : null;
  }
  return null;
}

function read(b, p, t) {
  if (t === T_STRING) { const v = varint(b, p); return v && b.toString('utf8', v[1], v[1] + v[0]); }
  if (t === T_INT16 || t === T_INT16B) return b.readUInt16LE(p);
  if (t === T_INT8 || t === T_BYTE) return b[p];
  return null;
}

// Ответ на операцию → { code, params } либо null.
// Раскладка: f3 03 | поле(1) | returnCode(2) | debugMessage(типизированное) | число(1) | параметры
function parseResponse(b) {
  if (b.length < 8 || b[0] !== MAGIC || (b[1] & 0x7f) !== RESPONSE) return null;
  let p = 5;
  p = skip(b, p + 1, b[p]);                       // debugMessage — обычно пусто
  if (p === null || p >= b.length) return null;
  const count = b[p++];
  const params = {};
  for (let i = 0; i < count; i++) {
    if (p + 2 > b.length) return null;
    const key = b[p], t = b[p + 1];
    const end = skip(b, p + 2, t);
    if (end === null) return null;
    params[key] = read(b, p + 2, t);
    p = end;
  }
  if (p !== b.length) return null;                // сошлось не байт в байт — не верим
  const code = params[P_OPCODE];
  return typeof code === 'number' ? { code, params } : null;
}

// Все ответы на операции из одного UDP-пакета Photon.
// Пакет: заголовок 12 байт, где байт 3 — число команд; дальше команды подряд.
function responses(pl) {
  const out = [];
  if (!pl || pl.length < CMD_HDR) return out;
  let p = CMD_HDR;
  for (let i = 0, n = pl[3]; i < n; i++) {
    if (p + CMD_HDR > pl.length) break;
    const type = pl[p], len = pl.readInt32BE(p + 4);
    if (len < CMD_HDR || p + len > pl.length) break;
    if (type === CMD_RELIABLE || type === CMD_UNRELIABLE) {
      // у ненадёжной команды перед телом ещё четыре байта своего номера
      const body = pl.subarray(p + CMD_HDR + (type === CMD_UNRELIABLE ? 4 : 0), p + len);
      if (body.length > 1 && body[0] === MAGIC && (body[1] & 0x7f) === RESPONSE) {
        const m = parseResponse(body);
        if (m) out.push(m);
      }
    }
    p += len;
  }
  return out;
}

module.exports = { responses };
