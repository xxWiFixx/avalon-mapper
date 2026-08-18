// Захват трафика игры сырым сокетом. Без драйверов: ни npcap, ни WinPcap.
//
// ПОЧЕМУ СОКЕТ, А НЕ PCAP. Готовые сборщики (albiondata-client) построены на pcap,
// а он на Windows требует npcap — драйвер ядра, который ставится отдельным установщиком
// с правами администратора. Сырой сокет даёт то же самое одними правами администратора,
// а их приложение уже просит: без них хоткей не долетает поверх BattlEye. То есть для
// игрока не меняется ничего — ни новых установщиков, ни второй запущенной программы.
//
// КАК ЭТО РАБОТАЕТ. Сокет AF_INET/SOCK_RAW привязывается к адресу своей машины, затем
// SIO_RCVALL переводит его в режим «отдавай все IP-пакеты этого интерфейса». Дальше
// разбирается заголовок IP, из него берётся UDP, и если порт 5056 — это Photon, трафик
// игры. Ничего не отправляется и не изменяется: сокет только слушает.
//
// ЧТО МЫ ИЗ НЕГО БЕРЁМ. Ровно одно: id кластера при смене зоны (см. lib/cluster.js).
// Ни чата, ни имён игроков, ни чего-либо ещё из пакетов не читается и не сохраняется.
//
// НЕ БЛОКИРУЕМ ГЛАВНЫЙ ПРОЦЕСС. recv на сыром сокете ждёт пакета, а ждать в главном
// процессе Electron нельзя — встанет и окно, и плашка поверх игры. Поэтому сокет
// переводится в неблокирующий режим (FIONBIO), и мы забираем накопившееся по таймеру:
// система буферизует пакеты между опросами сама.
const os = require('os');

const AF_INET = 2, SOCK_RAW = 3, IPPROTO_IP = 0;
const SIO_RCVALL = 0x98000001;
const FIONBIO = 0x8004667e;
const SOL_SOCKET = 0xffff, SO_RCVBUF = 0x1002;
// Буфер приёма ядра. По умолчанию у сырого сокета он в единицы килобайт — это НЕСКОЛЬКО
// пакетов, и всё, что не успели забрать между опросами, Windows выбрасывает молча.
// Нас никто не переспросит: мы пассивный слушатель, а игра свой пакет уже подтвердила.
// Потерянный ответ opChangeCluster = потерянный переход, и зона застревает до следующего.
// Именно так у игрока приложение 21 минуту считало его в одной зоне. 8 МБ — это секунды
// самого плотного трафика: терять становится нечего даже в бою и в городе.
const RCVBUF = 8 * 1024 * 1024;
const PHOTON_PORT = 5056;         // порт Photon, тот же слушает albiondata-client
const BUF = 65535;                // максимальный размер IP-пакета

let koffi = null, ws2 = null, fn = null;

function load() {
  if (fn) return fn;
  koffi = require('koffi');
  ws2 = koffi.load('ws2_32.dll');
  fn = {
    WSAStartup: ws2.func('int __stdcall WSAStartup(uint16 v, _Out_ uint8 *data)'),
    socket: ws2.func('intptr __stdcall socket(int af, int type, int proto)'),
    bind: ws2.func('int __stdcall bind(intptr s, const uint8 *addr, int len)'),
    WSAIoctl: ws2.func('int __stdcall WSAIoctl(intptr s, uint32 code, const uint8 *in, uint32 inLen, _Out_ uint8 *out, uint32 outLen, _Out_ uint32 *ret, void *ov, void *cb)'),
    ioctlsocket: ws2.func('int __stdcall ioctlsocket(intptr s, long cmd, _Inout_ uint32 *arg)'),
    recv: ws2.func('int __stdcall recv(intptr s, _Out_ uint8 *buf, int len, int flags)'),
    setsockopt: ws2.func('int __stdcall setsockopt(intptr s, int level, int optname, const uint8 *val, int len)'),
    closesocket: ws2.func('int __stdcall closesocket(intptr s)'),
    WSAGetLastError: ws2.func('int __stdcall WSAGetLastError()'),
  };
  return fn;
}

// Адреса своих интерфейсов: сырой сокет привязывается к конкретному, а какой из них
// смотрит в игру, заранее неизвестно (Wi-Fi, кабель, VPN). Слушаем все сразу.
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && a.address) out.push(a.address);
    }
  }
  return out;
}

function sockaddrIn(ip) {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(AF_INET, 0);
  b.writeUInt16BE(0, 2);                                  // порт 0 — принимаем всё
  for (const [i, p] of ip.split('.').entries()) b[4 + i] = Number(p) & 0xff;
  return b;
}

// IP-пакет → полезная нагрузка UDP, если это Photon. Иначе null.
// Разбираем ровно два заголовка и ни байтом больше: нам нужен только порт и тело.
function udpPayload(buf, len) {
  if (len < 28) return null;
  const ihl = (buf[0] & 0x0f) * 4;                        // длина заголовка IP
  if (buf[9] !== 17 || len < ihl + 8) return null;        // 17 = UDP
  const src = buf.readUInt16BE(ihl), dst = buf.readUInt16BE(ihl + 2);
  if (src !== PHOTON_PORT && dst !== PHOTON_PORT) return null;
  return buf.subarray(ihl + 8, len);
}

// Один слушатель на интерфейс. onPacket получает тело UDP-пакета Photon.
function open(ip, onPacket, onError) {
  const w = load();
  const wsa = Buffer.alloc(408);
  w.WSAStartup(0x0202, wsa);
  const s = w.socket(AF_INET, SOCK_RAW, IPPROTO_IP);
  if (s === -1 || s === 0xffffffffn) {
    const e = w.WSAGetLastError();
    // 10013 (WSAEACCES) — самый частый и единственный, который игрок может исправить сам.
    // Остальные коды оставляем числом: гадать по ним хуже, чем показать как есть.
    throw new Error(e === 10013
      ? 'нет прав на сырой сокет — запусти приложение от администратора'
      : 'socket: ' + e);
  }
  try {
    if (w.bind(s, sockaddrIn(ip), 16) !== 0) throw new Error('bind: ' + w.WSAGetLastError());
    const on = Buffer.alloc(4); on.writeUInt32LE(1, 0);
    const out = Buffer.alloc(4), ret = Buffer.alloc(4);
    // Без SIO_RCVALL сокет отдаёт только пакеты, адресованные нам самим, а нужен весь
    // интерфейс. Именно этот вызов и требует прав администратора.
    if (w.WSAIoctl(s, SIO_RCVALL, on, 4, out, 4, ret, null, null) !== 0) {
      throw new Error('SIO_RCVALL: ' + w.WSAGetLastError() + ' (нужны права администратора)');
    }
    // Буфер приёма расширяем ДО перевода в неблокирующий режим и до первого пакета.
    // Ошибку не считаем смертельной: приём заработает и с буфером по умолчанию, просто
    // будет терять под нагрузкой — а это лучше, чем не слушать вовсе.
    const rb = Buffer.alloc(4); rb.writeInt32LE(RCVBUF, 0);
    if (w.setsockopt(s, SOL_SOCKET, SO_RCVBUF, rb, 4) !== 0) {
      console.warn('[зона] не удалось расширить буфер приёма:', w.WSAGetLastError(),
        '— под нагрузкой возможны пропуски переходов');
    }
    const nb = Buffer.alloc(4); nb.writeUInt32LE(1, 0);
    w.ioctlsocket(s, FIONBIO, nb);
  } catch (err) { w.closesocket(s); throw err; }

  const buf = Buffer.alloc(BUF);
  // 60 мс — вчетверо чаще, чем игрок успевает сменить зону, и вчетверо реже, чем
  // тикает игра: на глаз мгновенно, по нагрузке незаметно.
  // ВЫЧЕРПЫВАЕМ ДО КОНЦА, а не «не больше 64 за раз». Прежний потолок давал around
  // тысячу пакетов в секунду, а игра шлёт больше: одних evMove за сессию набегает
  // под сотню тысяч. Не успели забрать — ядро выбрасывает, и вместе с мусором улетает
  // тот единственный ответ, из которого мы узнаём о смене зоны.
  // Потолок всё же есть, но огромный: он защищает не от нагрузки, а от бесконечного
  // цикла, если recv вдруг начнёт возвращать данные без остановки.
  const DRAIN_MAX = 20000;
  let overflow = 0;
  const timer = setInterval(() => {
    let i = 0;
    for (; i < DRAIN_MAX; i++) {
      const n = w.recv(s, buf, BUF, 0);
      if (n <= 0) break;                                  // -1 = буфер пуст (неблокирующий)
      try {
        const p = udpPayload(buf, n);
        if (p && p.length) onPacket(p);
      } catch (err) { if (onError) onError(err); }
    }
    // Уткнулись в потолок — значит забирали медленнее, чем приходило, и часть пакетов
    // ядро уже выбросило. Молчать об этом нельзя: именно так теряются переходы.
    if (i >= DRAIN_MAX && ++overflow % 10 === 1) {
      console.warn('[зона] не успеваю вычерпывать трафик — возможны пропуски переходов');
    }
  }, 60);

  return { close() { clearInterval(timer); w.closesocket(s); }, ip };
}

module.exports = { open, localAddresses, udpPayload, PHOTON_PORT };
