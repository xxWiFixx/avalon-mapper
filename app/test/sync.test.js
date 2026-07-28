// Выгрузка порталов в общие карты и приём чужих. Сервер поддельный: проверяем не
// Supabase, а наше поведение — очередь при отсутствии сети, отсутствие ника в общей
// карте, склейку знаний и то, что своё же эхо не возвращается.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createSync, PUBLIC_MAP_ID } = require('../lib/sync');
const store = require('../lib/store');

let ok = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

const GROUP = '11111111-2222-3333-4444-555555555555';

// Поддельный Supabase: держит рёбра в памяти и умеет падать по команде.
function fakeServer() {
  const s = {
    maps: { [GROUP]: [], [PUBLIC_MAP_ID]: [] },
    calls: [], down: false, status: 200,
    fetch: async (url, init) => {
      const fn = String(url).split('/rpc/')[1];
      const body = JSON.parse(init.body);
      s.calls.push({ fn, body, apikey: init.headers.apikey, auth: init.headers.Authorization });
      // s.hold — задержать ответ, пока тест не отпустит: так проверяется гонка
      // «пока запрос в полёте, портал пересканировали»
      if (s.hold) await s.hold;
      if (s.down) throw new Error('сеть недоступна');
      if (s.status !== 200) {
        return { ok: false, status: s.status, text: async () => 'нет такой карты', json: async () => ({}) };
      }
      let out = null;
      if (fn === 'push_edges') {
        const rows = s.maps[body.p_map] || (s.maps[body.p_map] = []);
        for (const e of body.p_edges) {
          const i = rows.findIndex(r => r.a === e.a && r.b === e.b);
          const row = {
            a: e.a, b: e.b, cap_max: e.capMax, cap_max_known: e.capMaxKnown,
            expires_at: e.expiresAt, source: e.source,
            // сервер режет ник у общей карты — повторяем это и здесь
            by_nick: body.p_map === PUBLIC_MAP_ID ? null : (e.by || null),
            updated_at: new Date(Date.now() + rows.length).toISOString(),
          };
          if (i >= 0) rows[i] = row; else rows.push(row);
        }
        out = body.p_edges.length;
      } else if (fn === 'pull_edges') {
        const since = body.p_since ? Date.parse(body.p_since) : -Infinity;
        out = (s.maps[body.p_map] || []).filter(r => Date.parse(r.updated_at) > since);
      } else if (fn === 'create_map') {
        out = GROUP;
      }
      return { ok: true, status: 200, json: async () => out, text: async () => '' };
    },
  };
  return s;
}

function newSync(server, extra = {}) {
  const file = path.join(os.tmpdir(), 'avalon-sync-test-' + Math.round(process.hrtime()[1]) + '.json');
  // По умолчанию «вошёл через Discord». Случай «не вошёл» проверяется отдельно ниже.
  const sync = createSync(Object.assign({
    fetch: server.fetch, file, flushMs: 0, pullMs: 0, getToken: async () => 'токен-игрока',
  }, extra));
  sync.configure(Object.assign({
    syncUrl: 'https://x.supabase.co', syncKey: 'anon-key',
    rooms: [{ id: GROUP, upload: true }], uploadPublic: true, nick: 'me',
  }, extra.config));
  return { sync, file };
}

(async () => {
  console.log('\n=== выгрузка ===');

  await t('портал уходит и в карту друзей, и в общую', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv);
    sync.push({ a: 'Coues-Exakrom', b: 'Cairn Camain', capMax: 7, capMaxKnown: true, expiresAt: Date.now() + 3600e3, source: 'ocr', by: 'me' });
    eq(sync.status().queued, 2, 'в очереди две записи');
    await sync.flush(); await sync.flush();
    eq(srv.maps[GROUP].length, 1, 'у друзей');
    eq(srv.maps[PUBLIC_MAP_ID].length, 1, 'в общей');
    eq(sync.status().queued, 0, 'очередь пуста');
  });

  await t('в общую карту ник не уходит, друзьям — уходит', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv);
    sync.push({ a: 'A-zone', b: 'B-zone', capMax: 20, capMaxKnown: true, expiresAt: Date.now() + 3600e3, source: 'ocr', by: 'me' });
    await sync.flush(); await sync.flush();
    const toPublic = srv.calls.find(c => c.fn === 'push_edges' && c.body.p_map === PUBLIC_MAP_ID);
    const toGroup = srv.calls.find(c => c.fn === 'push_edges' && c.body.p_map === GROUP);
    eq(toPublic.body.p_edges[0].by, null, 'общая карта');
    eq(toGroup.body.p_edges[0].by, 'me', 'карта друзей');
  });

  await t('пара зон сортируется — одно ребро, а не два', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { uploadPublic: false } });
    sync.push({ a: 'Zed', b: 'Alpha', source: 'ocr', by: 'me' });
    sync.push({ a: 'Alpha', b: 'Zed', source: 'ocr', by: 'me' });
    await sync.flush();
    eq(srv.maps[GROUP].length, 1, 'строк на сервере');
    eq(srv.maps[GROUP][0].a, 'Alpha', 'первым идёт меньшее имя');
  });

  await t('выключенная галочка — выгрузки нет', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { rooms: [], uploadPublic: false } });
    eq(sync.push({ a: 'A', b: 'B', by: 'me' }), 0, 'в очередь ничего не легло');
    await sync.flush();
    eq(srv.calls.length, 0, 'сервер не тронут');
  });

  await t('без id группы галочка «друзьям» не работает', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { rooms: [{ id: 'не-код', upload: true }], uploadPublic: false } });
    eq(sync.status().enabled, false, 'выгрузка выключена');
    sync.push({ a: 'A', b: 'B', by: 'me' });
    eq(sync.status().queued, 0, 'очередь пуста');
  });

  console.log('\n=== несколько комнат ===');

  // Раньше комната могла быть только одна: её id лежал отдельным полем, а цели назывались
  // group/public. Второй комнате в такой схеме места не было вовсе.
  const ROOM2 = '22222222-3333-4444-5555-666666666666';

  await t('портал уходит в обе комнаты и в общую — тремя разными записями', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: {
      rooms: [{ id: GROUP, upload: true }, { id: ROOM2, upload: true }], uploadPublic: true } });
    sync.push({ a: 'A-zone', b: 'B-zone', expiresAt: Date.now() + 3600e3, by: 'me' });
    eq(sync.status().queued, 3, 'три цели — три записи');
    await sync.flush(); await sync.flush(); await sync.flush();
    eq(srv.maps[GROUP].length, 1, 'первая комната');
    eq(srv.maps[ROOM2].length, 1, 'вторая комната');
    eq(srv.maps[PUBLIC_MAP_ID].length, 1, 'общая');
  });

  await t('комната без галочки не получает ничего', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: {
      rooms: [{ id: GROUP, upload: true }, { id: ROOM2, upload: false }], uploadPublic: false } });
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    await sync.flush(); await sync.flush();
    eq(srv.maps[GROUP].length, 1, 'куда просили');
    eq((srv.maps[ROOM2] || []).length, 0, 'куда не просили');
  });

  // Время закрытия — половина смысла портала: без него маршрутизатор не знает, успеет ли
  // игрок, и ребро живёт двенадцать часов «на всякий случай». В своей карте и у друзей это
  // терпимо — там знают, кто записал. В общей нет: чужой маршрут поведёт к закрытому проходу.
  await t('портал без времени: друзьям уходит, в общую — нет', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: {
      rooms: [{ id: GROUP, upload: true }], uploadPublic: true } });
    sync.push({ a: 'A-zone', b: 'B-zone', expiresAt: null, by: 'me' });
    eq(sync.status().queued, 1, 'в очереди только карта друзей');
    await sync.flush(); await sync.flush();
    eq(srv.maps[GROUP].length, 1, 'друзьям ушло');
    eq((srv.maps[PUBLIC_MAP_ID] || []).length, 0, 'в общую не ушло');
  });

  await t('вышел из комнаты — её очередь не висит вечно', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: {
      rooms: [{ id: GROUP, upload: true }, { id: ROOM2, upload: true }], uploadPublic: false } });
    srv.down = true;
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    eq(sync.status().queued, 2, 'обе ждут');
    srv.down = false;
    // из второй комнаты вышли: рёбер туда больше не отправить
    sync.configure({ syncUrl: 'https://x.supabase.co', syncKey: 'anon-key',
      rooms: [{ id: GROUP, upload: true }], uploadPublic: false, nick: 'me' });
    sync.state.failUntil = 0;
    await sync.flush(); await sync.flush();
    eq(sync.status().queued, 0, 'очередь разобрана, а не заклинила на мёртвой цели');
    eq(srv.maps[GROUP].length, 1, 'живая комната своё получила');
  });

  await t('в очереди видно, сколько ждёт по каждой карте', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: {
      rooms: [{ id: GROUP, upload: true }], uploadPublic: true } });
    srv.down = true;
    sync.push({ a: 'A-zone', b: 'B-zone', expiresAt: Date.now() + 3600e3, by: 'me' });
    await sync.flush();
    const by = sync.status().queuedBy;
    eq(by[GROUP], 1, 'по комнате');
    eq(by[PUBLIC_MAP_ID], 1, 'по общей');
  });

  console.log('\n=== не вошёл через Discord ===');

  // Главное правило модели доступа: без входа работает личная карта, а очередь в общие
  // просто ЖДЁТ. Ни одной попытки в сеть и ни одного выброшенного ребра — человек войдёт
  // позже, и всё накопленное уйдёт. Раньше сюда прилетал бы 401, а он попадает под
  // «данные не те» и после трёх попыток стёр бы порцию.
  await t('без входа очередь копится, а в сеть не ходим вовсе', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { getToken: async () => null, config: { uploadPublic: false } });
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    await sync.flush();
    await sync.pull();
    eq(sync.status().queued, 1, 'ребро на месте');
    eq(srv.calls.length, 0, 'ни одного запроса');
    eq(sync.status().lastError, null, 'это не ошибка, а обычное состояние');
  });

  await t('вошёл позже — накопленное уходит', async () => {
    const srv = fakeServer();
    let вошёл = false;
    const { sync } = newSync(srv, { getToken: async () => (вошёл ? 'токен' : null), config: { uploadPublic: false } });
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    sync.push({ a: 'C-zone', b: 'D-zone', by: 'me' });
    await sync.flush();
    eq(sync.status().queued, 2, 'пока не вошёл — ждут оба');
    вошёл = true;
    await sync.flush();
    eq(sync.status().queued, 0, 'после входа очередь ушла');
    eq(srv.maps[GROUP].length, 2, 'дошли оба');
  });

  await t('токен игрока предъявляется каждым запросом', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { uploadPublic: false } });
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    await sync.flush();
    const c = srv.calls[0];
    eq(c.auth, 'Bearer токен-игрока', 'кто сообщил про портал — видно серверу');
    eq(c.apikey, 'anon-key', 'публичный ключ проекта тоже на месте');
  });

  console.log('\n=== сеть отвалилась ===');

  await t('нет сети — портал ждёт в очереди и уходит потом', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { uploadPublic: false } });
    srv.down = true;
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    await sync.flush();
    eq(sync.status().queued, 1, 'ребро не потерялось');
    eq(sync.status().waitingSec > 0, true, 'взята пауза перед повтором');
    srv.down = false;
    sync.state.failUntil = 0;            // пауза вышла
    await sync.flush();
    eq(sync.status().queued, 0, 'ушло');
    eq(srv.maps[GROUP].length, 1, 'дошло до сервера');
  });

  await t('очередь переживает перезапуск приложения', async () => {
    const srv = fakeServer();
    const { sync, file } = newSync(srv, { config: { uploadPublic: false } });
    srv.down = true;
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    await sync.flush();
    await new Promise(r => setTimeout(r, 500));           // очередь пишется с задержкой
    const again = createSync({ fetch: srv.fetch, file, flushMs: 0, pullMs: 0, getToken: async () => 'токен-игрока' });
    again.configure({ syncUrl: 'https://x.supabase.co', syncKey: 'k', rooms: [{ id: GROUP, upload: true }], nick: 'me' });
    eq(again.status().queued, 1, 'после перезапуска ребро на месте');
    srv.down = false;
    await again.flush();
    eq(srv.maps[GROUP].length, 1, 'дошло');
    fs.rmSync(file, { force: true });
  });

  // Раньше 4xx выбрасывал порцию с первого раза. Так нельзя: наш собственный рейт-лимит
  // на сервере поднимает P0001, и PostgREST отдаёт его как 400 — на общей карте, где
  // предел один на всех игроков, это рядовой ответ, а не «данные не те».
  await t('отказ 4xx сперва повторяется и только потом выбрасывает порцию', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { uploadPublic: false } });
    srv.status = 400;
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    await sync.flush();
    eq(sync.status().queued, 1, 'с первого отказа не выбрасываем');
    sync.state.failUntil = 0;
    await sync.flush();
    eq(sync.status().queued, 1, 'со второго тоже');
    sync.state.failUntil = 0;
    await sync.flush();
    eq(sync.status().queued, 0, 'на третий порция выброшена — вечно не крутимся');
    eq(sync.status().lastError.includes('400'), true, 'причина сохранена');
  });

  await t('рейт-лимит переживается: отказ, пауза, успех — ребро не потеряно', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { uploadPublic: false } });
    srv.status = 400;                       // «слишком часто» приходит именно так
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me' });
    await sync.flush();
    eq(sync.status().queued, 1, 'ребро дождалось следующей попытки');
    srv.status = 200;
    sync.state.failUntil = 0;
    await sync.flush();
    eq(srv.maps[GROUP].length, 1, 'дошло до сервера, а не выброшено');
  });

  // Находка ультраревью: catch стирал ВСЮ очередь карты, а не отправленную порцию.
  // После долгого офлайна один отказ уносил сотни рёбер, которых сервер не видел.
  await t('отказ 4xx выбрасывает только свою порцию, остальная очередь цела', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { batch: 2, config: { uploadPublic: false } });
    srv.status = 400;
    for (const n of ['A', 'B', 'C', 'D', 'E']) sync.push({ a: n + '-one', b: n + '-two', by: 'me' });
    eq(sync.status().queued, 5, 'в очереди пять рёбер');
    for (let i = 0; i < 3; i++) { sync.state.failUntil = 0; await sync.flush(); }
    eq(sync.status().queued, 3, 'ушла только порция из двух, три остались ждать');
    srv.status = 200;
    sync.state.failUntil = 0;
    await sync.flush();
    eq(srv.maps[GROUP].length, 2, 'уцелевшие дошли, когда сервер ожил');
  });

  // Находка ультраревью: снятие из очереди шло по ключу (a, b), а push() кладёт на то же
  // место НОВЫЙ объект. Свежая версия ребра исчезала, не побывав на сервере.
  await t('свежая версия ребра не теряется, если пришла во время запроса', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { config: { uploadPublic: false } });
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me', capMax: 7, capMaxKnown: true });
    let release;
    srv.hold = new Promise(r => { release = r; });
    const flying = sync.flush();
    // Ждём, пока порция снята и запрос реально ушёл: перед этим flush спрашивает токен,
    // и без паузы второй push успел бы попасть в ту же порцию — проверялось бы не то.
    await new Promise(r => setTimeout(r, 10));
    sync.push({ a: 'A-zone', b: 'B-zone', by: 'me', capMax: 20, capMaxKnown: true });
    release();
    await flying;
    eq(sync.status().queued, 1, 'свежая версия осталась в очереди');
    srv.hold = null;
    await sync.flush();
    const row = srv.maps[GROUP].find(r => r.a === 'A-zone');
    eq(row && row.cap_max, 20, 'на сервер ушла свежая версия, а не потерялась');
  });

  console.log('\n=== приём чужих ===');

  // Находка ультраревью: отметка времени опроса ставилась ПОСЛЕ выхода по пустому ответу.
  // На тихой карте — обычное состояние — она навсегда оставалась нулевой, и вместо
  // одного опроса в 20 с приложение дёргало общий бесплатный Supabase каждые 3 с.
  await t('пустой ответ — тоже опрос: сервер не дёргается каждый тик', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { pullMs: 20000, config: { uploadPublic: false } });
    await sync.tick();
    await sync.tick();
    await sync.tick();
    const pulls = srv.calls.filter(c => c.fn === 'pull_edges').length;
    eq(pulls, 1, 'три тика подряд — один опрос: интервал ещё не вышел');
  });

  // Тот же дефект на пути ОТКАЗА: fail() при 4xx паузы не берёт, поэтому без отметки
  // времени опрос упирался бы в tick. С нашим рейт-лимитом (он приходит как 400) это
  // самоподдерживающийся цикл: отказ → сразу новый запрос → снова отказ.
  await t('отказ опроса тоже считается походом к серверу — не долбим 4xx каждые 3 с', async () => {
    const srv = fakeServer();
    const { sync } = newSync(srv, { pullMs: 20000, config: { uploadPublic: false } });
    srv.status = 400;
    for (let i = 0; i < 5; i++) await sync.tick();
    const pulls = srv.calls.filter(c => c.fn === 'pull_edges').length;
    eq(pulls, 1, 'пять тиков после отказа — один опрос, а не пять');
  });

  await t('чужое ребро приходит, своё эхо — нет', async () => {
    const srv = fakeServer();
    const got = [];
    const { sync } = newSync(srv, { onMerge: (list, scope) => got.push([list, scope]), config: { uploadPublic: false } });
    srv.maps[GROUP].push(
      { a: 'A-zone', b: 'B-zone', cap_max: 7, cap_max_known: true, expires_at: new Date(Date.now() + 3600e3).toISOString(), source: 'ocr', by_nick: 'друг', updated_at: new Date().toISOString() },
      { a: 'C-zone', b: 'D-zone', cap_max: null, cap_max_known: false, expires_at: null, source: 'ocr', by_nick: 'me', updated_at: new Date().toISOString() },
    );
    await sync.pull();
    eq(got.length, 1, 'один вызов слияния');
    eq(got[0][0].length, 1, 'только чужое ребро');
    eq(got[0][0][0].by, 'друг', 'от кого');
    eq(got[0][1], GROUP, 'из какой карты — теперь это её id, а не слово');
  });

  await t('второй запрос тянет только новое', async () => {
    const srv = fakeServer();
    const got = [];
    const { sync } = newSync(srv, { onMerge: l => got.push(l), config: { uploadPublic: false } });
    srv.maps[GROUP].push({ a: 'A-zone', b: 'B-zone', cap_max: 7, cap_max_known: true, expires_at: null, source: 'ocr', by_nick: 'друг', updated_at: new Date(Date.now() - 1000).toISOString() });
    await sync.pull();
    await sync.pull();
    eq(got.length, 1, 'повторно то же не приходит');
  });

  console.log('\n=== склейка знаний в карте ===');

  await t('чужое ребро появляется, если своего нет', () => {
    store.state.edges = {}; store.state.players = {}; store.state.journal = [];
    const n = store.mergeRemote([{ a: 'A-zone', b: 'B-zone', capMax: 7, capMaxKnown: true, expiresAt: Date.now() + 3600e3, source: 'ocr', by: 'друг', updatedAt: Date.now() }], 'group');
    eq(n, 1, 'применено');
    const e = store.snapshot().edges[0];
    eq(e.scope, 'group', 'помечено как чужое');
    eq(e.capMax, 7, 'размер портала');
  });

  await t('чужая запись не понижает своё ребро до чужого', () => {
    store.state.edges = {};
    store.addEdge('A-zone', { name: 'B-zone', capMax: 20, capMaxKnown: true, closes: 3600 }, 'me');
    store.mergeRemote([{ a: 'A-zone', b: 'B-zone', capMax: 20, capMaxKnown: true, expiresAt: Date.now() + 3500e3, source: 'ocr', by: 'друг', updatedAt: Date.now() }], 'public');
    eq(store.snapshot().edges[0].scope, 'local', 'осталось своим');
  });

  await t('размер портала складывается: друг прочитал — мы знаем', () => {
    store.state.edges = {};
    store.addEdge('A-zone', { name: 'B-zone', capMax: null, capMaxKnown: false, closes: 3600 }, 'me');
    eq(store.snapshot().edges[0].capMaxKnown, false, 'своего размера нет');
    const n = store.mergeRemote([{ a: 'A-zone', b: 'B-zone', capMax: 20, capMaxKnown: true, expiresAt: null, source: 'ocr', by: 'друг', updatedAt: Date.now() }], 'group');
    eq(n, 1, 'изменение применено');
    eq(store.snapshot().edges[0].capMax, 20, 'размер приехал от друга');
  });

  // Пассивные рёбра убраны из приложения: это был вывод из перемещений игрока, а не
  // прочитанный портал. Свои мы их не делаем — и чужие не принимаем: у друга может
  // стоять сборка постарше, которая их ещё шлёт.
  await t('чужое пассивное ребро в карту не пускаем', () => {
    store.state.edges = {};
    const applied = store.mergeRemote([{ a: 'A-zone', b: 'B-zone', capMax: null, capMaxKnown: false, expiresAt: null, source: 'passive', by: 'друг', updatedAt: Date.now() }], 'group');
    eq(applied, 0, 'ничего не применилось');
    eq(store.snapshot().edges.length, 0, 'карта осталась пустой');
  });

  await t('чужое пассивное ребро не портит уже прочитанный портал', () => {
    store.state.edges = {};
    store.addEdge('A-zone', { name: 'B-zone', capMax: 7, capMaxKnown: true, closes: 3600 }, 'me');
    store.mergeRemote([{ a: 'A-zone', b: 'B-zone', capMax: null, capMaxKnown: false, expiresAt: null, source: 'passive', by: 'друг', updatedAt: Date.now() + 1000 }], 'group');
    const e = store.snapshot().edges[0];
    eq(e.source, 'ocr', 'источник');
    eq(e.capMax, 7, 'размер на месте');
  });

  await t('одинаковое ребро дважды — карта не дёргается', () => {
    store.state.edges = {};
    const row = { a: 'A-zone', b: 'B-zone', capMax: 7, capMaxKnown: true, expiresAt: Date.now() + 3600e3, source: 'ocr', by: 'друг', updatedAt: Date.now() };
    eq(store.mergeRemote([row], 'group'), 1, 'первый раз');
    eq(store.mergeRemote([row], 'group'), 0, 'второй раз ничего не меняет');
  });

  await t('закрывшийся портал из чужой карты не принимаем', () => {
    store.state.edges = {};
    eq(store.mergeRemote([{ a: 'A-zone', b: 'B-zone', expiresAt: Date.now() - 60e3, source: 'ocr', by: 'друг', updatedAt: Date.now() }], 'group'), 0, 'отброшено');
  });

  console.log(`\n${fail ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ЗЕЛЕНО'}: ${ok}/${ok + fail} проверок пройдено`);
  process.exit(fail ? 1 : 0);
})();
