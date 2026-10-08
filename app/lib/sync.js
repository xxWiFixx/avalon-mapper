const i18nText = require("./i18n").t;
// Portal synchronization. Local writes remain in store.js; this module queues
// private personal-cloud and group writes in Supabase.
'use strict';
const fs = require('fs');
const jsonFile = require('./json-file');
const syncWire = require('../ui/sync-wire');

// Retained only to discard obsolete configuration and cached map membership.
const PUBLIC_MAP_ID = '00000000-0000-0000-0000-0000000000a0';

const PUBLIC_MAP_ON = false;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULTS = {
  requestTimeoutMs: 15000,
  pullMs: 20000,        // как часто спрашивать чужие рёбра
  flushMs: 3000,        // как часто выгребать очередь
  retryMaxMs: 300000,   // потолок паузы после отказа сети — 5 минут
  outboxMax: 5000,      // includes the first cloud backup of an existing personal map
  batch: 100,           // рёбер за один запрос
};

// Неисправимые 4xx повторяем ограниченно; ограничения частоты не удаляют очередь.
const BAD_TRIES_MAX = 3;
function retryable(err) {
  return !err.status || err.status >= 500 || [401, 408, 429].includes(err.status)
    || (err.code === 'P0001' && /слишком часто|rate limit|too many requests/i.test(err.message));
}

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
    captureReceipt: e.captureReceipt || null,
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
    firstSeenAt: r.first_seen_at ? Date.parse(r.first_seen_at) : null,
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
  // Токен гостевого или Discord-аккаунта. Если его нет, локальная карта
  // продолжает работать, а облачная синхронизация ждёт восстановления входа.
  const getToken = o.getToken || (async () => null);      // подменяется в тестах
  const now = o.now || (() => Date.now());
  const state = {
    url: '', key: '', accountId: null, personalMapId: null, policyReady: false,
    // Цель выгрузки — ИМЕННО id карты, а не имя вида «group». Раньше комната могла быть
    // только одна: id хранился отдельным полем, а цели назывались group/public, и второй
    // комнате в этой схеме просто не было места. Теперь целей сколько угодно, и общая
    // карта — одна из них, с постоянным id.
    targets: [],                                       // [mapId]
    readTargets: [],
    pausedTargets: [],
    versions: {},
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
  let revision = 0;
  let snapshotSupported = null;
  let snapshotProbeAt = 0;
  let layoutSinceSupported = null;
  let compactSupported = null;

  // ---------- настройки ----------
  function configure(c = {}) {
    const previous = JSON.stringify([state.url, state.key, state.accountId, state.readTargets, state.targets, state.policyReady]);
    const previousServer = state.url + '|' + state.key;
    state.url = String(c.syncUrl || '').trim().replace(/\/+$/, '');
    state.key = String(c.syncKey || '').trim();
    state.accountId = c.syncAccountId || null;
    const policy = c.accountPolicy && c.accountPolicy.personalMap === state.accountId ? c.accountPolicy : null;
    state.personalMapId = UUID_RE.test(String(state.accountId || '')) ? state.accountId : null;
    state.policyReady = !!policy;
    if (previousServer !== state.url + '|' + state.key) {
      snapshotSupported = null; snapshotProbeAt = 0; layoutSinceSupported = null; compactSupported = null;
    }
    // Group uploads are optional. Personal-cloud uploads are always enabled
    // for a signed-in account; the aggregate is never a write target.
    const rooms = Array.isArray(c.rooms) ? c.rooms : [];
    state.pausedTargets = rooms.filter(r => r?.paused).map(r => String(r.id));
    const ids = rooms
      // Наблюдателя сервер не пустит писать, и очередь копила бы отказы: три неудачи
      // подряд, и порция выбрасывается. Пусть лучше цель не заводится вовсе — тумблер
      // при этом остаётся включённым и заработает сам, как только выдадут роль.
      .filter(r => r && r.upload && r.role !== 'viewer' && UUID_RE.test(String(r.id || '')))
      .map(r => String(r.id));
    if (state.personalMapId) ids.push(state.personalMapId);
    // Ignore the obsolete uploadPublic setting from older configuration files.
    state.targets = [...new Set(ids)].filter(id => id !== PUBLIC_MAP_ID);
    state.readTargets = [...new Set(rooms.filter(r => r && UUID_RE.test(String(r.id || '')))
      .map(r => String(r.id)))].filter(id => id !== PUBLIC_MAP_ID);
    if (state.personalMapId) state.readTargets.push(state.personalMapId);
    if (previous !== JSON.stringify([state.url, state.key, state.accountId, state.readTargets, state.targets, state.policyReady])) {
      revision++;
      state.lastPullAt = 0;
      state.versions = {};
      state.since = {};
      state.failUntil = 0; state.backoff = 0; state.badTries = 0;
      // Before account_policy has loaded, keep the previous account's disk queue.
      // A failed/offline sign-in must not erase observations waiting for upload.
      if (state.accountId) state.outbox = state.outbox.filter(x => state.targets.includes(x.target));
      save();
    }
    state.nick = c.nick || 'me';
  }

  function ready() { return !!(state.url && state.key && fetchImpl); }
  function enabled() { return ready() && state.readTargets.length > 0; }
  const isTarget = id => state.targets.includes(id);

  // ---------- очередь ----------
  function load() {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j.outbox)) state.outbox = j.outbox
        .filter(x => x && x.target !== PUBLIC_MAP_ID && (x.remove || (x.edge && Date.parse(x.edge.expiresAt) > now())))
        .slice(-o.outboxMax);
      if (j.since) state.since = Object.assign(state.since, j.since);
    } catch (e) { /* первого запуска файла нет — норм */ }
  }
  let saveTimer = null;
  function save() {
    if (!file) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  function saveNow() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      jsonFile.writeObject(file, { outbox: state.outbox, since: state.since });
    } catch (err) { log(i18nText("[синх] очередь не сохранилась: ") + err.message); }
  }

  // Портал → в очередь на все включённые удалённые карты.
  // Локальная карта пишется отдельно (store) и сюда не попадает.
  function push(edge) {
    if (!edge || !edge.a || !edge.b || edge.a === edge.b
        || !Number.isFinite(edge.expiresAt) || edge.expiresAt <= now()) return 0;
    let n = 0;
    for (const target of state.targets) {
      if (state.pausedTargets.includes(target)) continue;
      const wire = wireEdge(edge, { withNick: true });
      // то же ребро в очереди заменяем: смысла слать две версии подряд нет
      state.outbox = state.outbox.filter(x => !(x.target === target && x.remove && x.remove.a === wire.a && x.remove.b === wire.b));
      const i = state.outbox.findIndex(x => x.target === target && x.edge && x.edge.a === wire.a && x.edge.b === wire.b);
      if (i >= 0) state.outbox[i] = { target, edge: wire };
      else state.outbox.push({ target, edge: wire });
      n++;
    }
    if (state.outbox.length > o.outboxMax) state.outbox.splice(0, state.outbox.length - o.outboxMax);
    if (n) save();
    return n;
  }

  function pushPersonal(edge, { restore = false } = {}) {
    if (!state.personalMapId || !edge || !edge.a || !edge.b || edge.a === edge.b
        || !Number.isFinite(edge.expiresAt) || edge.expiresAt <= now()) return 0;
    const target = state.personalMapId;
    const wire = wireEdge(edge, { withNick: true });
    if (restore) { wire.source = 'manual'; wire.captureReceipt = null; }
    state.outbox = state.outbox.filter(x => !(x.target === target && x.remove && x.remove.a === wire.a && x.remove.b === wire.b));
    const i = state.outbox.findIndex(x => x.target === target && x.edge && x.edge.a === wire.a && x.edge.b === wire.b);
    if (i >= 0) state.outbox[i] = { target, edge: wire };
    else state.outbox.push({ target, edge: wire });
    if (state.outbox.length > o.outboxMax) state.outbox.splice(0, state.outbox.length - o.outboxMax);
    save();
    return 1;
  }

  function removePersonal(a, b, accountId = null) {
    const target = state.personalMapId || (UUID_RE.test(String(accountId || '')) ? accountId : null);
    if (!target || !a || !b || a === b) return false;
    [a, b] = [a, b].sort();
    state.outbox = state.outbox.filter(x => !(x.target === target
      && ((x.edge && x.edge.a === a && x.edge.b === b)
        || (x.remove && x.remove.a === a && x.remove.b === b))));
    state.outbox.push({ target, remove: { a, b } });
    save();
    return true;
  }

  // ---------- сеть ----------
  async function rpc(fn, body, timeoutMs = o.requestTimeoutMs) {
    // Два разных предъявления, и путать их нельзя.
    // apikey — публичный ключ проекта, он у всех одинаковый и говорит серверу лишь
    //   «этот запрос к нашему проекту»; секретом он не является.
    // Authorization — токен ВОШЕДШЕГО игрока. Именно по нему сервер понимает, кто
    //   сообщил про портал, пускать ли в комнату и можно ли удалять.
    // Без токена облачные карты ждут входа; локальная карта остаётся доступной.
    const started = revision;
    const token = await getToken();
    if (started !== revision) throw new Error(i18nText("настройки синхронизации изменились"));
    if (!token) { const e = new Error(i18nText("облачный вход недоступен")); e.status = 401; throw e; }
    const headers = {
      apikey: state.key,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    const ctrl = new AbortController();
    const deadline = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
    const res = await fetchImpl(state.url + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (started !== revision) {
      const error = new Error('account_changed'); error.code = 'account_changed'; error.reason = 'account_changed'; throw error;
    }
    if (!res.ok) {
      // В теле отказа лежит объяснение от самой базы — его и показываем человеку,
      // а не голый номер: «роли раздаёт хранитель карты» понятнее, чем «HTTP 403».
      let msg = text.slice(0, 200);
      let code = null;
      try { const j = JSON.parse(text); if (j && j.message) msg = j.message; code = j && j.code; } catch (e) { /* не json */ }
      const err = new Error(msg ? 'HTTP ' + res.status + ': ' + msg : 'HTTP ' + res.status);
      err.status = res.status;
      err.code = code;
      err.reason = msg;
      throw err;
    }
    // ПУСТОЕ ТЕЛО — ЭТО УСПЕХ, А НЕ ПОЛОМКА. Функции, объявленные как `returns void`
    // (set_member_role, kick_member, leave_map), PostgREST отдаёт как 204 без тела.
    // Прежний безусловный res.json() падал на них с «Unexpected end of JSON input»,
    // и выходило худшее: на сервере роль менялась, а игрок видел ошибку и откат фишки.
    if (!text) return null;
    return JSON.parse(text);
    } finally { clearTimeout(deadline); }
  }

  // Отказ сети — ждём с удвоением паузы. Ответ 4xx означает «данные не те»:
  // повторять бессмысленно, поэтому такие рёбра выбрасываем, а не крутим вечно.
  function fail(err, drop) {
    state.lastError = err.message;
    if (drop) { log(i18nText("[синх] запрос отклонён, порция выброшена: ") + err.message); state.backoff = 0; return; }
    state.backoff = Math.min(state.backoff ? state.backoff * 2 : 5000, o.retryMaxMs);
    state.failUntil = now() + state.backoff;
    log(i18nText("[синх] сеть недоступна (") + err.message + i18nText("), следующая попытка через ") + Math.round(state.backoff / 1000) + i18nText(" с"));
  }
  function good() { state.backoff = 0; state.failUntil = 0; state.lastError = null; }

  async function flush() {
    if (!enabled() || !state.outbox.length || now() < state.failUntil) return 0;
    const started = revision;
    // Не вошёл — очередь просто ЖДЁТ. Ни одной попытки, ни одного выброшенного ребра:
    // войдёт позже, и всё накопленное уйдёт. Раньше сюда прилетал бы 401, а он попадает
    // под «данные не те» и после трёх попыток стёр бы порцию.
    if (!await getToken() || started !== revision) return 0;
    // одна порция за раз и по одной карте: так проще и понятнее, чем гнать всё сразу
    const first = state.outbox.find(x => !state.pausedTargets.includes(x.target)
      && (x.target !== state.personalMapId || state.policyReady));
    if (!first) return 0;
    const target = first.target;
    // Из комнаты вышли, пока рёбра лежали в очереди — слать их некуда, чистим.
    if (!isTarget(target)) { state.outbox = state.outbox.filter(x => x.target !== target); save(); return 0; }
    const removing = !!first.remove;
    const batch = state.outbox.filter(x => x.target === target && !!x.remove === removing)
      .slice(0, removing ? 1 : o.batch);
    const mapId = target;
    // Из очереди вычёркиваем ИМЕННО отправленные записи, по ссылке на объект.
    // Ключ (a, b) для этого не годится: пока идёт запрос, push() кладёт на то же место
    // НОВЫЙ объект с тем же ребром (пересканировали портал — свежий expiresAt), и снятие
    // по ключу выбросило бы свежую версию, которую сервер так и не увидел.
    const mine = new Set(batch);
    try {
      if (removing) await rpc('delete_edge', {
        p_map: mapId, p_a: batch[0].remove.a, p_b: batch[0].remove.b,
      });
      else await rpc('push_edges', { p_map: mapId, p_edges: batch.map(x => x.edge) });
      if (started !== revision) return 0;
      state.outbox = state.outbox.filter(x => !mine.has(x));
      state.pushed += batch.length;
      state.lastPushAt = now();
      state.badTries = 0;
      good();
      save();
      return batch.length;
    } catch (err) {
      if (started !== revision) return 0;
      if (err.reason === 'group_subscription_expired') {
        if (!state.pausedTargets.includes(target)) state.pausedTargets.push(target);
        if (o.onAccess) await o.onAccess(target, { paused: true });
        return 0;
      }
      const bad = !retryable(err);
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
    const started = revision;
    let compact = null;
    if(o.compactReads && o.onSnapshot && compactSupported!==false && state.readTargets.length<=128){
      const versions=Object.fromEntries(state.readTargets.filter(id=>id!==state.personalMapId||state.policyReady).map(id=>[id,state.versions[id]||null]));
      try{compact=syncWire.batch(await rpc('pull_maps_compact',{p_versions:versions,p_context:false})).snapshots;compactSupported=true;}
      catch(err){
        if(started!==revision)return 0;
        if(err.status===404&&['PGRST202','42883'].includes(err.code))compactSupported=false;
        else {state.lastPullAt=now();fail(err,!retryable(err));return 0;}
      }
      if(started!==revision)return 0;
    }
    for (const target of [...state.readTargets]) {
      if (started !== revision) break;
      if (target === state.personalMapId && !state.policyReady) continue;
      const mapId = target;
      try {
        if (o.onSnapshot && (snapshotSupported !== false || now() >= snapshotProbeAt)) {
          let snapshot;
          try {
            snapshot = compact ? syncWire.unwrap(compact[mapId]) : await rpc('pull_map_snapshot', { p_map: mapId, p_version: state.versions[target] || null });
            snapshotSupported = true;
          } catch (err) {
            if (err.status !== 404 || !['PGRST202', '42883'].includes(err.code)) throw err;
            snapshotSupported = false;
            snapshotProbeAt = now() + 60000;
            log(i18nText("[синх] сервер использует прежний протокол; требуется migration-08"));
          }
          if (started !== revision || !state.readTargets.includes(target)) break;
          if (snapshotSupported) {
            if (!snapshot || typeof snapshot !== 'object') throw new Error(i18nText("некорректный ответ карты"));
            state.lastPullAt = now();
            if (snapshot.paused) {
              if (o.onAccess) await o.onAccess(target, snapshot);
              good();
              continue; // Subscription expiry preserves cached portals and membership.
            }
            if (snapshot.denied) {
              await o.onSnapshot([], target, []);
              state.versions[target] = null;
              if (o.onAccess) await o.onAccess(target, { role: 'none' });
              continue;
            }
            if (typeof snapshot.version !== 'string' || typeof snapshot.unchanged !== 'boolean'
                || (!snapshot.unchanged && !Array.isArray(snapshot.edges))) throw new Error(i18nText("неполный ответ карты"));
            if (!snapshot.unchanged) {
              const removals = new Set(state.outbox.filter(x => x.target === target && x.remove)
                .map(x => x.remove.a + '|' + x.remove.b));
              const all = snapshot.edges.map(fromWire)
                .filter(x => !removals.has([x.a, x.b].sort().join('|')));
              const pending = state.outbox.filter(x => x.target === target && x.edge).map(x => x.edge);
              const applied = await o.onSnapshot(all, target, pending);
              total += Number(applied) || 0;
              state.pulled += Number(applied) || 0;
              state.versions[target] = snapshot.version;
            }
            if (o.onAccess) await o.onAccess(target, snapshot);
            good();
            continue;
          }
        }
        const rows = await rpc('pull_edges', { p_map: mapId, p_since: state.since[target] });
        if (started !== revision || !state.readTargets.includes(target)) break;
        good();
        // Отметку ставим по факту ОПРОСА, а не по факту улова. Иначе на тихой карте —
        // а это обычное состояние — она навсегда остаётся нулевой, условие в tick()
        // выполняется всегда, и вместо опроса раз в 20 с мы дёргаем сервер каждые 3 с.
        state.lastPullAt = now();
        if (!Array.isArray(rows) || !rows.length) continue;
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
        if (all.length && o.onMerge) await o.onMerge(all, target);
        for (const r of rows) {
          if (r.updated_at && (!state.since[target] || r.updated_at > state.since[target])) state.since[target] = r.updated_at;
        }
        save();
      } catch (err) {
        if (started !== revision) break;
        // Отметку ставим и здесь. Отказ — это тоже поход к серверу, а при 4xx fail()
        // паузы не берёт вовсе: без этой строки опрос упирался бы в tick и молотил
        // раз в 3 с. Для нашего же рейт-лимита (он приходит как 400) цикл был бы
        // самоподдерживающимся: отказ → сразу новый запрос → снова отказ.
        state.lastPullAt = now();
        fail(err, !retryable(err));
      }
    }
    return total;
  }

  // ---------- цикл ----------
  async function tick(force = false) {
    if (state.busy) return;
    state.busy = true;
    try {
      await flush();
      if (force || now() - state.lastPullAt >= o.pullMs) await pull();
    } catch (err) {
      log(i18nText("[синх] сбой цикла: ") + (err && err.message));
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
    saveNow();
  }

  // Что показать в панели: включено ли, сколько ждёт в очереди, когда была связь
  function status() {
    return {
      ready: ready(), enabled: enabled(),
      targets: state.targets.slice(),
      readTargets: state.readTargets.slice(),
      legacyServer: snapshotSupported === false,
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
  async function createGroup(title, code) {
    if (code !== undefined) return rpc('create_server_with_code', { p_title: title, p_code: code });
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    const out = await rpc('create_map', { p_title: title || null });
    const id = typeof out === 'string' ? out : (Array.isArray(out) ? out[0] : out && out.id);
    if (!UUID_RE.test(String(id))) throw new Error(i18nText("сервер вернул не id карты"));
    return String(id);
  }

  async function accountPolicy() {
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    return rpc('account_policy', {});
  }

  // Войти в комнату по коду. Сервер запомнит членство и вернёт её название —
  // приложению этого хватает, чтобы нарисовать канал в списке слева.
  async function joinGroup(id) {
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    if (!/^AVI-[0-9A-F]{32}$/i.test(String(id || '').trim())) throw new Error(i18nText("Нужен код приглашения AVI от хранителя или модератора."));
    const out = await rpc('join_server_with_invite', { p_code: String(id).trim() });
    if (!out?.ok) throw new Error(i18nText(out?.code === 'server_paused' ? 'Сервер приостановлен. Владельцу нужно продлить подписку.' : 'Приглашение недействительно, истекло или доступ закрыт.'));
    const row = Array.isArray(out) ? out[0] : out;
    return { id: String(row.id), title: (row && row.title) || null, kind: (row && row.kind) || 'group' };
  }

  async function leaveGroup(id) {
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
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
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    const out = await rpc('delete_edge', { p_map: String(mapId), p_a: String(a), p_b: String(b) });
    return Number(Array.isArray(out) ? out[0] : out) || 0;
  }

  // Список своих комнат с сервера: он источник истины, а не файл настроек.
  // Вошёл с другого компьютера — комнаты те же.
  async function myMaps() {
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
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
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    const out = await rpc('map_members_list', { p_map: String(mapId) });
    return (Array.isArray(out) ? out : []).map(r => ({
      id: String(r.user_id), nick: r.nick || i18nText("игрок"), role: r.role || 'viewer',
      isOwner: !!r.is_owner, joinedAt: r.joined_at ? Date.parse(r.joined_at) : 0,
    }));
  }
  async function setRole(mapId, userId, role) {
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    await rpc('set_member_role', { p_map: String(mapId), p_user: String(userId), p_role: String(role) });
    return true;
  }
  async function kickMember(mapId, userId) {
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    await rpc('kick_member', { p_map: String(mapId), p_user: String(userId) });
    return true;
  }
  // Порог подтверждений карты. 0 — порога нет вовсе, и тогда «проверенные» ничем не
  // отличаются от обычных: подтверждать нечего.
  async function setPolicy(mapId, confirmRequired) {
    if (!ready()) throw new Error(i18nText("не заданы адрес и ключ Supabase"));
    const out = await rpc('set_map_policy', { p_map: String(mapId), p_confirm: Number(confirmRequired) || 0 });
    return Number(Array.isArray(out) ? out[0] : out) || 0;
  }

  // Fixed backend endpoint: neither a renderer nor a checkout can change the sync server.
  async function checkout(product, currency, mapId = null) {
    if (product !== 'group' || !['RUB', 'USD'].includes(currency)
        || (mapId && !UUID_RE.test(mapId))) throw new Error('invalid_purchase');
    const started = revision, token = await getToken();
    if (!token || started !== revision) throw new Error('account_required');
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), o.requestTimeoutMs);
    try {
      const response = await fetchImpl(state.url + '/functions/v1/billing-checkout', {
        method: 'POST', signal: controller.signal,
        headers: { apikey: state.key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, currency, mapId }),
      });
      const result = JSON.parse(await response.text());
      if (started !== revision) throw new Error('account_changed');
      if (!response.ok) throw new Error(result.error || 'checkout_unavailable');
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port
          || /^(localhost|127\.|\[|10\.|192\.168\.|169\.254\.)/i.test(url.hostname)) throw new Error('invalid_checkout_url');
      return url.href;
    } finally { clearTimeout(deadline); }
  }

  load();
  return {
    configure, push, pushPersonal, removePersonal, flush, pull, tick, start, stop, status,
    accountPolicy,
    billingStatus: () => rpc('billing_status', {}),
    billingRedeemCode: (code, mapId = null) => {
      if (typeof code !== 'string' || code.length > 128
          || !/^AM30[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{30}$/.test(code.replace(/[-\s]/g, '').toUpperCase())
          || (mapId !== null && (typeof mapId !== 'string' || !UUID_RE.test(mapId)))) {
        return Promise.reject(Object.assign(new Error('invalid_code'), { code: 'invalid_code', reason: 'invalid_code' }));
      }
      return rpc('billing_redeem_code', { p_code: code, p_map: mapId });
    },
    mapLayout: async (mapId, positions = null, version = null, replace = false) => {
      if (!UUID_RE.test(String(mapId))) throw new Error('invalid_map');
      if (positions === null && !replace && layoutSinceSupported !== false) {
        try {
          const result = await rpc('map_layout_since', { p_map: mapId, p_revision: version }, 2500);
          layoutSinceSupported = true;
          return result;
        } catch (error) {
          if (!['PGRST202', '42883'].includes(error.code)) throw error;
          // An older project keeps using the existing RPC until the migration is applied.
          layoutSinceSupported = false;
        }
      }
      return rpc('map_layout', { p_map: mapId, p_positions: positions, p_revision: version, p_replace: !!replace }, 2500);
    },
    mapLayoutMerge: (mapId, bridge, positions, revision) => rpc('map_layout_merge', {p_map:mapId,p_bridge:bridge,p_positions:positions,p_revision:revision},5000),
    checkout,
    createGroup, joinGroup, leaveGroup, myMaps, deleteEdge,
    serverAccess: (action, params) => { const allowed = {create_map_invite: ['p_map','p_mode','p_hours'], map_invites_list:['p_map'], active_map_invites:['p_map'], revoke_map_invite:['p_map','p_invite'], map_bans_list:['p_map'],ban_member:['p_map','p_user'],unban_member:['p_map','p_user'],map_members_list:['p_map'],set_member_role:['p_map','p_user','p_role'],kick_member:['p_map','p_user'],set_map_policy:['p_map','p_confirm']}; if(!Object.hasOwn(allowed,action)||!UUID_RE.test(params?.p_map||''))throw new Error('invalid_server_action'); return rpc(action,Object.fromEntries(allowed[action].map(k=>[k,params[k]??null]))); },
    members, setRole, kickMember, setPolicy, state, PUBLIC_MAP_ID, PUBLIC_MAP_ON,
  };
}

module.exports = { createSync, PUBLIC_MAP_ID, PUBLIC_MAP_ON, UUID_RE };
