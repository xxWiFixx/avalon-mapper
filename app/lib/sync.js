// Общие карты: выгрузка своих порталов и приём чужих.
//
// Места, куда может попасть портал, и каждое включается переключателем отдельно:
//   своя   — файл map.json на диске, никуда не уходит;
//   друзья — карта группы в Supabase, её id знают только те, кому его переслали;
//   общая  — одна карта на всех, id постоянный.
// Здесь живут только вторые два: локальную пишет lib/store.js.
//
// ПРИНЦИПЫ, ОТ КОТОРЫХ ЗДЕСЬ ВСЁ ЗАВИСИТ:
// 1. Сеть не должна мешать игре. Ни один вызов не ждёт ответа сервера: портал
//    ложится в очередь на диске и уходит фоном. Нет интернета — полежит и уйдёт потом.
// 2. Сервер не источник истины. Локальная карта работает сама по себе, чужие рёбра
//    только доливаются в неё. Отвалился Supabase — приложение этого не замечает.
// 3. В общую карту не уходит ник: связка «кто где был» из неё выводиться не должна.
//    (Отрезаем и здесь, и в самой функции push_edges — на случай чужого клиента.)
// 4. Никаких позиций игроков и следов — только порталы.
'use strict';
const fs = require('fs');
const path = require('path');

// Общая карта одна и с постоянным id — тот же, что прописан в supabase/schema.sql
const PUBLIC_MAP_ID = '00000000-0000-0000-0000-0000000000a0';

// ОБЩАЯ КАРТА ВЫКЛЮЧЕНА (2026-07-31, решение игрока).
// Причина не в коде выгрузки — он работал. У общей карты порог в три подтверждения, и
// на живой карте игрока 90 рёбер из 103 висели «1 из 3»: в общую они не попадали, а в
// виде «Все карты» помечались ждущими, потому что подтверждений не хватало ИМЕННО ей.
// Карта, где 87% порталов подписаны «остальные его пока не видят», читается как сломанная.
// Здесь один выключатель, а не удаление: вся механика общей карты остаётся на месте
// и включается обратно этой строкой, когда порог и показ будут продуманы заново.
const PUBLIC_MAP_ON = false;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULTS = {
  pullMs: 20000,        // как часто спрашивать чужие рёбра
  flushMs: 3000,        // как часто выгребать очередь
  retryMaxMs: 300000,   // потолок паузы после отказа сети — 5 минут
  outboxMax: 500,       // очередь не должна расти бесконечно на отключённом интернете
  batch: 100,           // рёбер за один запрос
};

// Сколько раз подряд терпим отказ 4xx по одной порции, прежде чем её выбросить.
// Меньше нельзя: наш же рейт-лимит на сервере приходит как 400, и первая же
// занятая минута на общей карте стоила бы игроку сотни рёбер.
const BAD_TRIES_MAX = 3;

function nowIso(ms) { return new Date(ms).toISOString(); }

// Ребро store → то, что уходит на сервер. Пара сортируется здесь же: портал
// ненаправленный, и без этого одно и то же ребро от двух игроков легло бы дважды.
function wireEdge(e, { withNick }) {
  const [a, b] = [e.a, e.b].slice().sort();
  return {
    a, b,
    capMax: e.capMax != null ? e.capMax : null,
    capMaxKnown: !!e.capMaxKnown,
    expiresAt: e.expiresAt ? nowIso(e.expiresAt) : null,
    source: e.source || 'ocr',
    by: withNick ? (e.by || null) : null,
  };
}

// Строка сервера → ребро в форме store (миллисекунды, camelCase)
function fromWire(r) {
  return {
    a: r.a, b: r.b,
    capMax: r.cap_max != null ? Number(r.cap_max) : null,
    capMaxKnown: !!r.cap_max_known,
    capNum: null,
    expiresAt: r.expires_at ? Date.parse(r.expires_at) : null,
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : Date.now(),
    source: r.source || 'ocr',
    by: r.by_nick || null,
    // Сколько РАЗНЫХ игроков сообщило про этот портал и сколько нужно карте.
    // Своё ещё не подтверждённое ребро сервер отдаёт нам всегда — иначе игрок решил бы,
    // что выгрузка не работает, — но показать его надо иначе, чем принятое всеми.
    confirms: r.confirms != null ? Number(r.confirms) : null,
    needed: r.needed != null ? Number(r.needed) : null,
    // Кто сообщил про портал, в порядке появления: первый внёс, остальные подтвердили.
    // Приезжает только с migration-07 и только из комнат — в общей карте ников нет
    // по замыслу. Не приехало — значит база старее клиента: показываем счётчик, как
    // раньше, и ничего не ломаем. Поэтому здесь null, а не пустой массив: «не знаем»
    // и «никто не подтвердил» — разные вещи, и путать их нельзя.
    reporters: Array.isArray(r.reporters) ? r.reporters.filter(n => typeof n === 'string' && n).slice(0, 24) : null,
  };
}

function createSync(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const log = o.log || (() => {});
  const fetchImpl = o.fetch || globalThis.fetch;
  // Токен вошедшего игрока. По умолчанию его нет — значит общие карты выключены,
  // и это НОРМАЛЬНОЕ состояние, а не поломка: приложение работает с личной картой.
  const getToken = o.getToken || (async () => null);      // подменяется в тестах
  const now = o.now || (() => Date.now());
  const state = {
    url: '', key: '',
    // Цель выгрузки — ИМЕННО id карты, а не имя вида «group». Раньше комната могла быть
    // только одна: id хранился отдельным полем, а цели назывались group/public, и второй
    // комнате в этой схеме просто не было места. Теперь целей сколько угодно, и общая
    // карта — одна из них, с постоянным id.
    targets: [],                                       // [mapId]
    nick: 'me',
    outbox: [],                                        // [{ target: mapId, edge }]
    since: {},                                         // mapId → ISO последней принятой правки
    failUntil: 0, backoff: 0,
    lastError: null, lastPushAt: 0, lastPullAt: 0, pushed: 0, pulled: 0,
    // отказов 4xx подряд. Счётчик общий, не по конкретной порции: flush всегда выгребает
    // одну цель подряд, так что на практике это и есть «подряд по текущей порции»
    badTries: 0,
    running: false, busy: false,
  };
  const file = o.file || null;                         // где хранить очередь между запусками
  let timer = null;

  // ---------- настройки ----------
  function configure(c = {}) {
    state.url = String(c.syncUrl || '').trim().replace(/\/+$/, '');
    state.key = String(c.syncKey || '').trim();
    // rooms — комнаты, в которые игрок вошёл: [{ id, upload }]. Выгружаем в те, где
    // переключатель включён; общая карта добавляется своим. Порядок не важен,
    // важно, что каждая цель — самостоятельный id, и очередь для них раздельная.
    const rooms = Array.isArray(c.rooms) ? c.rooms : [];
    const ids = rooms
      // Наблюдателя сервер не пустит писать, и очередь копила бы отказы: три неудачи
      // подряд, и порция выбрасывается. Пусть лучше цель не заводится вовсе — тумблер
      // при этом остаётся включённым и заработает сам, как только выдадут роль.
      .filter(r => r && r.upload && r.role !== 'viewer' && UUID_RE.test(String(r.id || '')))
      .map(r => String(r.id));
    if (PUBLIC_MAP_ON && c.uploadPublic) ids.push(PUBLIC_MAP_ID);
    // Даже если в чужом конфиге остался включённый тумблер общей карты — цели её не знают:
    // выключатель обязан держать и старую настройку, иначе выгрузка продолжится молча.
    state.targets = [...new Set(ids)].filter(id => PUBLIC_MAP_ON || id !== PUBLIC_MAP_ID);
    state.nick = c.nick || 'me';
  }

  function ready() { return !!(state.url && state.key && fetchImpl); }
  function enabled() { return ready() && state.targets.length > 0; }
  const isTarget = id => state.targets.includes(id);

  // ---------- очередь ----------
  function load() {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j.outbox)) state.outbox = j.outbox.slice(-o.outboxMax);
      if (j.since) state.since = Object.assign(state.since, j.since);
    } catch (e) { /* первого запуска файла нет — норм */ }
  }
  let saveTimer = null;
  function save() {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ outbox: state.outbox, since: state.since }));
      } catch (err) { log('[синх] очередь не сохранилась: ' + err.message); }
    }, 400);
  }

  // Портал → в очередь на все включённые удалённые карты.
  // Локальная карта пишется отдельно (store) и сюда не попадает.
  function push(edge) {
    if (!edge || !edge.a || !edge.b || edge.a === edge.b) return 0;
    let n = 0;
    for (const target of state.targets) {
      // В ОБЩУЮ КАРТУ ТОЛЬКО СО ВРЕМЕНЕМ ЗАКРЫТИЯ. Без него портал висел бы там
      // двенадцать часов как живой, и чужой маршрут вёл бы к закрытому проходу.
      // Сервер такое ребро тоже не примет (push_edges), но занимать им очередь и тратить
      // на него запрос незачем — отсекаем здесь же.
      if (target === PUBLIC_MAP_ID && !edge.expiresAt) continue;
      const wire = wireEdge(edge, { withNick: target !== PUBLIC_MAP_ID });
      // то же ребро в очереди заменяем: смысла слать две версии подряд нет
      const i = state.outbox.findIndex(x => x.target === target && x.edge.a === wire.a && x.edge.b === wire.b);
      if (i >= 0) state.outbox[i] = { target, edge: wire };
      else state.outbox.push({ target, edge: wire });
      n++;
    }
    if (state.outbox.length > o.outboxMax) state.outbox.splice(0, state.outbox.length - o.outboxMax);
    if (n) save();
    return n;
  }

  // ---------- сеть ----------
  async function rpc(fn, body) {
    // Два разных предъявления, и путать их нельзя.
    // apikey — публичный ключ проекта, он у всех одинаковый и говорит серверу лишь
    //   «этот запрос к нашему проекту»; секретом он не является.
    // Authorization — токен ВОШЕДШЕГО игрока. Именно по нему сервер понимает, кто
    //   сообщил про портал, пускать ли в комнату и можно ли удалять.
    // Без токена общие карты не работают вовсе (см. getToken ниже) — личная от этого
    // не страдает, она живёт файлом на диске.
    const token = await getToken();
    if (!token) { const e = new Error('нужен вход через Discord'); e.status = 401; throw e; }
    const headers = {
      apikey: state.key,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    const res = await fetchImpl(state.url + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // В теле отказа лежит объяснение от самой базы — его и показываем человеку,
      // а не голый номер: «роли раздаёт хранитель карты» понятнее, чем «HTTP 403».
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); if (j && j.message) msg = j.message; } catch (e) { /* не json */ }
      const err = new Error(msg ? 'HTTP ' + res.status + ': ' + msg : 'HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    // ПУСТОЕ ТЕЛО — ЭТО УСПЕХ, А НЕ ПОЛОМКА. Функции, объявленные как `returns void`
    // (set_member_role, kick_member, leave_map), PostgREST отдаёт как 204 без тела.
    // Прежний безусловный res.json() падал на них с «Unexpected end of JSON input»,
    // и выходило худшее: на сервере роль менялась, а игрок видел ошибку и откат фишки.
    if (!text) return null;
    return JSON.parse(text);
  }

  // Отказ сети — ждём с удвоением паузы. Ответ 4xx означает «данные не те»:
  // повторять бессмысленно, поэтому такие рёбра выбрасываем, а не крутим вечно.
  function fail(err, drop) {
    state.lastError = err.message;
    if (drop) { log('[синх] запрос отклонён, порция выброшена: ' + err.message); state.backoff = 0; return; }
    state.backoff = Math.min(state.backoff ? state.backoff * 2 : 5000, o.retryMaxMs);
    state.failUntil = now() + state.backoff;
    log('[синх] сеть недоступна (' + err.message + '), следующая попытка через ' + Math.round(state.backoff / 1000) + ' с');
  }
  function good() { state.backoff = 0; state.failUntil = 0; state.lastError = null; }

  async function flush() {
    if (!enabled() || !state.outbox.length || now() < state.failUntil) return 0;
    // Не вошёл — очередь просто ЖДЁТ. Ни одной попытки, ни одного выброшенного ребра:
    // войдёт позже, и всё накопленное уйдёт. Раньше сюда прилетал бы 401, а он попадает
    // под «данные не те» и после трёх попыток стёр бы порцию.
    if (!await getToken()) return 0;
    // одна порция за раз и по одной карте: так проще и понятнее, чем гнать всё сразу
    const target = state.outbox[0].target;
    // Из комнаты вышли, пока рёбра лежали в очереди — слать их некуда, чистим.
    if (!isTarget(target)) { state.outbox = state.outbox.filter(x => x.target !== target); return 0; }
    const batch = state.outbox.filter(x => x.target === target).slice(0, o.batch);
    const mapId = target;
    // Из очереди вычёркиваем ИМЕННО отправленные записи, по ссылке на объект.
    // Ключ (a, b) для этого не годится: пока идёт запрос, push() кладёт на то же место
    // НОВЫЙ объект с тем же ребром (пересканировали портал — свежий expiresAt), и снятие
    // по ключу выбросило бы свежую версию, которую сервер так и не увидел.
    const mine = new Set(batch);
    try {
      await rpc('push_edges', { p_map: mapId, p_edges: batch.map(x => x.edge) });
      state.outbox = state.outbox.filter(x => !mine.has(x));
      state.pushed += batch.length;
      state.lastPushAt = now();
      state.badTries = 0;
      good();
      save();
      return batch.length;
    } catch (err) {
      // 4xx — «данные не те», повторять бессмысленно. Но под тот же 4xx попадает и наш
      // собственный рейт-лимит: push_edges поднимает P0001, а PostgREST отдаёт его как 400.
      // На общей карте предел один на всех игроков, так что 400 там — обычное дело, и
      // сдаваться с первого раза нельзя: сперва повторяем с паузой.
      // 401 — «войди», а не «данные не те». Выбрасывать из-за него рёбра нельзя:
      // человек войдёт через минуту, и всё накопленное должно уйти как было.
      const bad = err.status >= 400 && err.status < 500 && err.status !== 401;
      const drop = bad && ++state.badTries >= BAD_TRIES_MAX;
      // ...и выбрасываем ТОЛЬКО эту порцию. Раньше стиралась вся очередь карты: после
      // долгого офлайна один отказ уносил и те сотни рёбер, которых сервер не видел.
      if (drop) { state.outbox = state.outbox.filter(x => !mine.has(x)); state.badTries = 0; save(); }
      if (!bad) state.badTries = 0;
      fail(err, drop);
      return 0;
    }
  }

  // Чужие рёбра. onMerge получает [{ edge, scope }] — что делать дальше, решает store.
  async function pull() {
    if (!enabled() || now() < state.failUntil) return 0;
    if (!await getToken()) return 0;   // не вошёл — чужого нам не покажут, и спрашивать незачем
    let total = 0;
    for (const target of state.targets) {
      const mapId = target;
      try {
        const rows = await rpc('pull_edges', { p_map: mapId, p_since: state.since[target] });
        good();
        // Отметку ставим по факту ОПРОСА, а не по факту улова. Иначе на тихой карте —
        // а это обычное состояние — она навсегда остаётся нулевой, условие в tick()
        // выполняется всегда, и вместо опроса раз в 20 с мы дёргаем сервер каждые 3 с.
        state.lastPullAt = now();
        if (!Array.isArray(rows) || !rows.length) continue;
        for (const r of rows) {
          if (r.updated_at && (!state.since[target] || r.updated_at > state.since[target])) {
            state.since[target] = r.updated_at;
          }
        }
        // Своё эхо тоже сливаем, и это важно. Раньше строки со своим ником отбрасывались
        // здесь целиком — «зачем нам то, что мы сами и отправили». А нужно: именно по
        // возврату ребро узнаёт, что оно ЕСТЬ в этой карте. Без этого своё ребро вечно
        // оставалось помеченным только личной картой, и канал комнаты показывал одни
        // чужие порталы. Понизить своё знание слияние не может: bestScope держит 'local'
        // выше комнаты, а размер портала и время закрытия только уточняются.
        const all = rows.map(fromWire);
        const fresh = all.filter(e => !e.by || e.by !== state.nick);
        // в счётчике «принято чужих» по-прежнему только чужое: своё эхо туда попадать
        // не должно, иначе строка состояния врёт про оживлённость карты
        state.pulled += fresh.length;
        total += fresh.length;
        if (all.length && o.onMerge) o.onMerge(all, target);
        save();
      } catch (err) {
        // Отметку ставим и здесь. Отказ — это тоже поход к серверу, а при 4xx fail()
        // паузы не берёт вовсе: без этой строки опрос упирался бы в tick и молотил
        // раз в 3 с. Для нашего же рейт-лимита (он приходит как 400) цикл был бы
        // самоподдерживающимся: отказ → сразу новый запрос → снова отказ.
        state.lastPullAt = now();
        fail(err, err.status >= 400 && err.status < 500);
      }
    }
    return total;
  }

  // ---------- цикл ----------
  async function tick() {
    if (state.busy) return;
    state.busy = true;
    try {
      await flush();
      if (now() - state.lastPullAt >= o.pullMs) await pull();
    } catch (err) {
      log('[синх] сбой цикла: ' + (err && err.message));
    } finally {
      state.busy = false;
    }
  }

  function start() {
    if (timer || !o.flushMs) return;
    state.running = true;
    timer = setInterval(() => { tick(); }, o.flushMs);
    if (timer.unref) timer.unref();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    state.running = false;
  }

  // Что показать в панели: включено ли, сколько ждёт в очереди, когда была связь
  function status() {
    return {
      ready: ready(), enabled: enabled(),
      targets: state.targets.slice(),
      // сколько рёбер ждёт по каждой карте: с несколькими комнатами одно общее число
      // уже ни о чём не говорит — застрять может одна из них
      queuedBy: state.outbox.reduce((m, x) => (m[x.target] = (m[x.target] || 0) + 1, m), {}),
      queued: state.outbox.length,
      pushed: state.pushed, pulled: state.pulled,
      lastPushAt: state.lastPushAt, lastPullAt: state.lastPullAt,
      lastError: state.lastError,
      waitingSec: state.failUntil > now() ? Math.round((state.failUntil - now()) / 1000) : 0,
    };
  }

  // Создать комнату — id возвращается наружу, его игрок и рассылает друзьям
  async function createGroup(title) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    const out = await rpc('create_map', { p_title: title || null });
    const id = typeof out === 'string' ? out : (Array.isArray(out) ? out[0] : out && out.id);
    if (!UUID_RE.test(String(id))) throw new Error('сервер вернул не id карты');
    return String(id);
  }

  // Войти в комнату по коду. Сервер запомнит членство и вернёт её название —
  // приложению этого хватает, чтобы нарисовать канал в списке слева.
  async function joinGroup(id, title) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    if (!UUID_RE.test(String(id || ''))) throw new Error('код карты не похож на код');
    const out = await rpc('join_map', { p_map: String(id), p_title: title || null });
    const row = Array.isArray(out) ? out[0] : out;
    return { id: String(id), title: (row && row.title) || title || null, kind: (row && row.kind) || 'group' };
  }

  async function leaveGroup(id) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    await rpc('leave_map', { p_map: String(id) });
    // рёбра этой комнаты слать больше некуда
    state.outbox = state.outbox.filter(x => x.target !== String(id));
    delete state.since[String(id)];
    save();
    return true;
  }

  // Удалить ребро с карты на сервере. Право проверяет сервер: владелец карты или
  // доверенный аккаунт. Всем остальным ответит отказом — и это правильно, иначе общую
  // карту мог бы чистить кто угодно, а добавлять в неё может любой вошедший.
  async function deleteEdge(mapId, a, b) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    const out = await rpc('delete_edge', { p_map: String(mapId), p_a: String(a), p_b: String(b) });
    return Number(Array.isArray(out) ? out[0] : out) || 0;
  }

  // Список своих комнат с сервера: он источник истины, а не файл настроек.
  // Вошёл с другого компьютера — комнаты те же.
  async function myMaps() {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    const out = await rpc('my_maps', {});
    return (Array.isArray(out) ? out : []).map(r => ({
      id: String(r.id), title: r.title || null, kind: r.kind || 'group',
      confirmRequired: Number(r.confirm_required) || 0, isOwner: !!r.is_owner,
      role: r.role || 'member',
    }));
  }

  // ---------- участники и роли ----------
  // Всё право решает сервер: здесь только вызовы. Клиент прячет кнопки, которых у игрока
  // нет, но это удобство, а не защита — отказ придёт и в обход интерфейса.
  async function members(mapId) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    const out = await rpc('map_members_list', { p_map: String(mapId) });
    return (Array.isArray(out) ? out : []).map(r => ({
      id: String(r.user_id), nick: r.nick || 'игрок', role: r.role || 'viewer',
      isOwner: !!r.is_owner, joinedAt: r.joined_at ? Date.parse(r.joined_at) : 0,
    }));
  }
  async function setRole(mapId, userId, role) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    await rpc('set_member_role', { p_map: String(mapId), p_user: String(userId), p_role: String(role) });
    return true;
  }
  async function kickMember(mapId, userId) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    await rpc('kick_member', { p_map: String(mapId), p_user: String(userId) });
    return true;
  }
  // Порог подтверждений карты. 0 — порога нет вовсе, и тогда «проверенные» ничем не
  // отличаются от обычных: подтверждать нечего.
  async function setPolicy(mapId, confirmRequired) {
    if (!ready()) throw new Error('не заданы адрес и ключ Supabase');
    const out = await rpc('set_map_policy', { p_map: String(mapId), p_confirm: Number(confirmRequired) || 0 });
    return Number(Array.isArray(out) ? out[0] : out) || 0;
  }

  load();
  return {
    configure, push, flush, pull, tick, start, stop, status,
    createGroup, joinGroup, leaveGroup, myMaps, deleteEdge,
    members, setRole, kickMember, setPolicy, state, PUBLIC_MAP_ID, PUBLIC_MAP_ON,
  };
}

module.exports = { createSync, PUBLIC_MAP_ID, PUBLIC_MAP_ON, wireEdge, fromWire, UUID_RE };
