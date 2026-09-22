'use strict';
// Protocol18 values shared with the local albion-farm decoder. See docs/combat-metrics.md.
const T = {
  UNKNOWN: 0, BOOL: 2, BYTE: 3, SHORT: 4, FLOAT: 5, DOUBLE: 6, STRING: 7, NULL: 8,
  CINT: 9, CLONG: 10, I1: 11, I1N: 12, I2: 13, I2N: 14, L1: 15, L1N: 16, L2: 17, L2N: 18,
  CUSTOM: 19, DICT: 20, HASH: 21, OBJ_ARR: 23,
  BOOL_F: 27, BOOL_T: 28, SHORT0: 29, INT0: 30, LONG0: 31, FLOAT0: 32, DOUBLE0: 33, BYTE0: 34,
  ARRAY: 0x40, SLIM: 0x80,
};
const MAX_ARR = 65536;

class Reader {
  constructor(b, p = 0) { this.b = b; this.p = p; this.depth = 0; this.items = 0; }
  need(n) { if (!Number.isSafeInteger(n) || n < 0 || this.p + n > this.b.length) throw new Error('truncated'); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const n = this.b.readUInt16LE(this.p); this.p += 2; return n; }
  i16() { this.need(2); const n = this.b.readInt16LE(this.p); this.p += 2; return n; }
  f32() { this.need(4); const n = this.b.readFloatLE(this.p); this.p += 4; return n; }
  f64() { this.need(8); const n = this.b.readDoubleLE(this.p); this.p += 8; return n; }
  vuint() {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      const x = this.u8(); n |= BigInt(x & 127) << BigInt(i * 7);
      if (!(x & 128)) { if (n > 0xffffffffffffffffn) throw new Error('varint'); return n; }
    }
    throw new Error('varint');
  }
  vint32() { const n = this.vuint(); if (n > 0xffffffffn) throw new Error('int32'); return Number((n >> 1n) ^ -(n & 1n)); }
  vint64() { const n = this.vuint(); return (n >> 1n) ^ -(n & 1n); }
  count() {
    const n = Number(this.vuint());
    if (!Number.isSafeInteger(n) || n > MAX_ARR || (this.items += n) > MAX_ARR) throw new Error('count');
    return n;
  }
  bytes(n) { this.need(n); const b = this.b.subarray(this.p, this.p + n); this.p += n; return b; }
  str() { return this.bytes(this.count()).toString('utf8'); }
}

function value(r, tc) {
  if (++r.depth > 32 || ++r.items > MAX_ARR) throw new Error('complexity');
  try { return readValue(r, tc); } finally { r.depth--; }
}
function readValue(r, tc) {
  if (tc >= T.SLIM) return { bytes: r.bytes(r.count()) };   // «тонкий» пользовательский тип — просто байты
  switch (tc) {
    case T.UNKNOWN: case T.NULL: return null;
    case T.BOOL: return r.u8() !== 0;
    case T.BYTE: return r.u8();
    case T.SHORT: return r.i16();
    case T.FLOAT: return r.f32();
    case T.DOUBLE: return r.f64();
    case T.STRING: return r.str();
    case T.CINT: return r.vint32();
    case T.CLONG: return r.vint64();
    case T.I1: return r.u8();
    case T.I1N: return -r.u8();
    case T.I2: return r.u16();
    case T.I2N: return -r.u16();
    case T.L1: return BigInt(r.u8());
    case T.L1N: return -BigInt(r.u8());
    case T.L2: return BigInt(r.u16());
    case T.L2N: return -BigInt(r.u16());
    case T.BOOL_F: return false;
    case T.BOOL_T: return true;
    case T.SHORT0: case T.INT0: case T.FLOAT0: case T.DOUBLE0: case T.BYTE0: return 0;
    case T.LONG0: return 0n;
    case T.CUSTOM: { r.u8(); return { bytes: r.bytes(r.count()) }; }   // код типа + размер + байты
    // Словарь и хэштаблица. Без них не читается ответ о ВХОДЕ В ЗОНУ — тот самый, где
    // лежит СВОЙ id персонажа: на записи ровно 14 ответов спотыкались о тип 20 при
    // 13 переходах, то есть терялся каждый.
    case T.DICT: case T.HASH: return dict(r);
    case T.OBJ_ARR: return objArray(r);
    default:
      // Голый 0x40 — массив, у которого тип элементов записан ОДИН раз внутри, а не в
      // самом коде типа. Разобрать его как «массив элементов типа 0» значит съесть не
      // столько байт и развалить всё дальнейшее.
      if (tc === T.ARRAY) return nestedArray(r);
      if ((tc & T.ARRAY) === T.ARRAY) return array(r, tc & ~T.ARRAY);
      throw new Error('неизвестный тип ' + tc);
  }
}

// [типКлюча][типЗначения][счётчик]{ключ,значение}… Нулевой тип — «у каждого свой».
function dict(r) {
  const keyTC = r.u8(), valTC = r.u8();
  const n = r.count();
  if (n < 0 || n > MAX_ARR) throw new Error('размер словаря ' + n);
  const out = {};
  for (let i = 0; i < n; i++) {
    const kt = keyTC === 0 ? r.u8() : keyTC;
    const vt = valTC === 0 ? r.u8() : valTC;
    const key = value(r, kt);
    // Ключ приходит снаружи, поэтому кладём через Object.create(null)-подобную защиту:
    // «__proto__» обычным присваиванием подменил бы прототип, а не завёл поле.
    Object.defineProperty(out, String(key), { value: value(r, vt), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

// Массив разнотипных значений: у каждого свой код типа.
function objArray(r) {
  const n = r.count();
  if (n < 0 || n > MAX_ARR) throw new Error('размер массива ' + n);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = value(r, r.u8());
  return out;
}

// Массив одного типа, но код типа записан внутри, а не в коде массива.
function nestedArray(r) {
  const n = r.count();
  if (n < 0 || n > MAX_ARR) throw new Error('размер массива ' + n);
  const tc = r.u8();
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = value(r, tc);
  return out;
}

function array(r, elemType) {
  const n = r.count();
  if (n < 0 || n > MAX_ARR) throw new Error('длина массива ' + n);
  const out = new Array(n);
  // Protocol18 boolean arrays pack eight flags into each byte (LSB first).
  if (elemType === T.BOOL) {
    const size = Math.ceil(n / 8);
    if (r.p + size > r.b.length) throw new Error('неполный массив флагов');
    const packed = r.bytes(size);
    for (let i = 0; i < n; i++) out[i] = !!(packed[i >> 3] & (1 << (i & 7)));
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = value(r, elemType);
  return out;
}

// Таблица параметров: [count][key,type,value]…
function paramTable(r) {
  const count = r.count();
  if (count < 0 || count > MAX_ARR) throw new Error('число параметров ' + count);
  const params = {};
  r.seen = [];
  for (let i = 0; i < count; i++) {
    const key = r.u8();
    const tc = r.u8();
    r.seen.push(key + ':' + tc);
    params[key] = value(r, tc);
  }
  return params;
}

function parse(body) {
  if (!body || body.length < 4 || body[0] !== 0xf3 || ![3, 4, 7].includes(body[1])) return null;
  // Move is the hot path and carries no statistics.
  if (body[1] === 4 && body[2] === 3) return null;
  const r = new Reader(body, 3);
  try {
    const kind = body[1] === 4 ? 'event' : 'response';
    let returnCode = 0;
    if (kind === 'response') { returnCode = r.i16(); value(r, r.u8()); }
    const params = paramTable(r);
    const code = params[kind === 'event' ? 252 : 253];
    if (r.p !== body.length || !Number.isInteger(code)) return null;
    return { kind, code, returnCode, params };
  } catch { return null; }
}

// Deduplicate COMMANDS, never equal damage amounts: two identical hits can be real.
// Keys include the server connection and channel; fragments cannot cross connections.
function createStream() {
  const seen = new Map(), pending = new Map();
  const ttl = 60000, maxSeen = 32768, maxSize = 1024 * 1024;
  let sweepAt = 0;
  function feed(pl, peer, now = Date.now()) {
    const out = [];
    if (!Buffer.isBuffer(pl) || pl.length < 12 || pl[2] !== 0 || !peer) return out;
    if (now >= sweepAt) {
      for (const [k, t] of seen) if (now - t > ttl) seen.delete(k);
      for (const [k, v] of pending) if (now - v.at > 15000) pending.delete(k);
      sweepAt = now + 1000;
    }
    const connection = peer + ':' + pl.readUInt16BE(0);
    for (let i = 0, p = 12; i < pl[3]; i++) {
      if (p + 12 > pl.length) break;
      const type = pl[p], channel = pl[p + 1], len = pl.readUInt32BE(p + 4);
      if (len < 12 || p + len > pl.length) break;
      const seq = pl.readUInt32BE(p + 8);
      let body = pl.subarray(p + 12, p + len);
      p += len;
      if (![6, 7, 8].includes(type) || (type === 7 && body.length < 4)) continue;
      const key = connection + ':' + channel + ':' + type + ':' + seq + (type === 7 ? ':' + body.readUInt32BE(0) : '');
      if (seen.has(key)) continue;
      seen.set(key, now);
      if (seen.size > maxSeen) seen.delete(seen.keys().next().value);
      if (type === 7) body = body.subarray(4);
      if (type === 8) {
        if (body.length < 20) continue;
        const start = body.readUInt32BE(0), count = body.readUInt32BE(4), no = body.readUInt32BE(8);
        const size = body.readUInt32BE(12), off = body.readUInt32BE(16), data = body.subarray(20);
        if (!size || size > maxSize || !count || count > 4096 || no >= count || !data.length || off + data.length > size) continue;
        const k = connection + ':' + channel + ':' + start;
        let seg = pending.get(k);
        if (!seg) {
          if (pending.size >= 8) pending.delete(pending.keys().next().value);
          seg = { size, count, chunks: new Map(), at: now }; pending.set(k, seg);
        }
        if (seg.size !== size || seg.count !== count) { pending.delete(k); continue; }
        if (seg.chunks.has(no)) continue;
        seg.chunks.set(no, { off, data: Buffer.from(data) });
        if (seg.chunks.size !== count) continue;
        pending.delete(k);
        const chunks = [...seg.chunks.values()].sort((a, b) => a.off - b.off);
        let end = 0;
        for (const c of chunks) { if (c.off !== end) { end = -1; break; } end += c.data.length; }
        if (end !== size) continue;
        body = Buffer.concat(chunks.map(c => c.data), size);
      }
      const message = parse(body);
      if (message) out.push(message);
    }
    return out;
  }
  return { feed, reset() { seen.clear(); pending.clear(); }, pendingCount: () => pending.size };
}

module.exports = { parse, createStream };
