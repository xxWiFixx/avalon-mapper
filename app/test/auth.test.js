// Вход через Discord. Ни Discord, ни Supabase здесь нет — проверяется НАШЕ поведение:
// работает ли приложение без входа вовсе, доходит ли код до обмена на токен, переживает
// ли вход перезапуск, и что происходит, когда что-то пошло не так.
//
// Браузер подделан: вместо него функция, которая сама дёргает адрес возврата — ровно то,
// что сделал бы Discord после подтверждения.
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createAuth } = require('../lib/auth');

let ok = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

const URL_ = 'https://x.supabase.co';
const KEY = 'sb_publishable_test';
const USER = {
  id: '00000001-aaaa-bbbb-cccc-dddddddddddd',
  user_metadata: { global_name: 'Тигро', avatar_url: 'https://cdn.discordapp.com/a.png' },
};

function fakeServer() {
  const s = {
    calls: [], refreshOk: true, exchangeOk: true,
    fetch: async (url, init) => {
      const p = String(url).replace(URL_, '');
      const body = init.body ? JSON.parse(init.body) : {};
      s.calls.push({ p, body, headers: init.headers });
      if (p.startsWith('/auth/v1/token?grant_type=pkce')) {
        if (!s.exchangeOk) return { ok: false, status: 400, text: async () => '{"msg":"invalid code verifier"}' };
        return { ok: true, status: 200, text: async () => JSON.stringify({
          access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, user: USER }) };
      }
      if (p.startsWith('/auth/v1/token?grant_type=refresh_token')) {
        if (!s.refreshOk) return { ok: false, status: 400, text: async () => '{"msg":"Invalid Refresh Token"}' };
        return { ok: true, status: 200, text: async () => JSON.stringify({
          access_token: 'access-renewed', refresh_token: 'refresh-2', expires_in: 3600, user: USER }) };
      }
      if (p === '/rest/v1/rpc/ensure_profile') {
        return { ok: true, status: 200, text: async () => JSON.stringify([
          { id: USER.id, nick: body.p_nick || 'кто-то', trusted: false }]) };
      }
      return { ok: false, status: 404, text: async () => 'нет такого пути' };
    },
  };
  return s;
}

// «браузер»: разбирает адрес входа и стучится на адрес возврата, как это сделал бы Discord
function browser(behave = 'ok') {
  const seen = {};
  return {
    seen,
    open: async (url) => {
      const u = new URL(url);
      seen.url = url;
      seen.provider = u.searchParams.get('provider');
      seen.challenge = u.searchParams.get('code_challenge');
      seen.method = u.searchParams.get('code_challenge_method');
      seen.scopes = u.searchParams.get('scopes');
      const back = new URL(u.searchParams.get('redirect_to'));
      seen.port = back.port;
      // state не подставляем: приложение его не отправляет, и Supabase возвращает
      // только код. Свой state как раз и ломал возврат — bad_oauth_state.
      const q = behave === 'отказ'
        ? `?error=access_denied&error_description=${encodeURIComponent('человек отказал')}`
        : `?code=${encodeURIComponent('код-от-discord')}`;
      await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: back.port, path: '/callback' + q, agent: false }, r => {
          r.resume(); r.on('end', res);
        }).on('error', rej);
      });
    },
  };
}

function newAuth(srv, br, extra = {}) {
  const file = path.join(os.tmpdir(), 'avalon-auth-' + Math.round(process.hrtime()[1]) + '.json');
  const a = createAuth(Object.assign({
    fetch: srv.fetch, file, openExternal: br ? br.open : undefined, ports: [53690, 53691, 53692],
  }, extra));
  a.configure({ url: URL_, key: KEY });
  return { a, file };
}

(async () => {
  console.log('\n=== без входа приложение работает ===');

  await t('не входил — токена нет, и браузер никто не открывает', async () => {
    const srv = fakeServer();
    let открывали = false;
    const { a, file } = newAuth(srv, { open: async () => { открывали = true; } });
    eq(await a.token(), null, 'токена нет');
    eq(a.status().signedIn, false, 'не вошёл');
    eq(открывали, false, 'браузер не дёргали — личная карта работает молча');
    eq(srv.calls.length, 0, 'в сеть не ходили вовсе');
    fs.rmSync(file, { force: true });
  });

  console.log('\n=== вход через Discord ===');

  await t('вход доходит до токена', async () => {
    const srv = fakeServer();
    const br = browser();
    const { a, file } = newAuth(srv, br);
    const st = await a.signIn();
    eq(st.signedIn, true, 'вошёл');
    eq(st.nick, 'Тигро', 'ник взят из Discord');
    eq(await a.token(), 'access-1', 'токен на руках');
    fs.rmSync(file, { force: true });
  });

  await t('в браузер уходит именно Discord и именно PKCE', async () => {
    const srv = fakeServer();
    const br = browser();
    const { a, file } = newAuth(srv, br);
    await a.signIn();
    eq(br.seen.provider, 'discord', 'провайдер');
    eq(br.seen.method, 's256', 'способ подписи запроса');
    eq(!!br.seen.challenge && br.seen.challenge.length > 20, true, 'отпечаток секрета передан');
    eq(/^http:\/\/127\.0\.0\.1:/.test(new URL(br.seen.url).searchParams.get('redirect_to')), true, 'возврат только на свой компьютер');
    const ex = srv.calls.find(c => c.p.includes('grant_type=pkce'));
    eq(ex.body.auth_code, 'код-от-discord', 'код обменян');
    eq(!!ex.body.code_verifier, true, 'секрет предъявлен — без него код чужому бесполезен');
    fs.rmSync(file, { force: true });
  });

  await t('пароль через приложение не проходит ни в каком виде', async () => {
    const srv = fakeServer();
    const br = browser();
    const { a, file } = newAuth(srv, br);
    await a.signIn();
    const всё = JSON.stringify(srv.calls);
    eq(/password|пароль/i.test(всё), false, 'ни одного запроса с паролем');
    fs.rmSync(file, { force: true });
  });

  await t('вход переживает перезапуск', async () => {
    const srv = fakeServer();
    const { a, file } = newAuth(srv, browser());
    await a.signIn();
    const b = createAuth({ fetch: srv.fetch, file });
    b.configure({ url: URL_, key: KEY });
    eq(b.status().signedIn, true, 'после перезапуска всё ещё внутри');
    eq(await b.token(), 'access-renewed', 'сеанс продлён без браузера');
    fs.rmSync(file, { force: true });
  });

  console.log('\n=== второй вход подряд ===');

  // Оба случая поймались на живой настройке и оба ломали ИМЕННО повторную попытку —
  // ту, которая и нужна, когда первая сорвалась.

  // Первый порт занят: адрес возврата обязан указывать туда, где мы реально слушаем.
  // Раньше порт читался через тик после listen, и на втором круге в адрес попадал
  // первый порт — браузер стучался туда, где никого нет.
  await t('первый порт занят — в адрес идёт тот порт, на котором слушаем', async () => {
    const срв = fakeServer();
    const занятый = http.createServer(() => {});
    await new Promise(r => занятый.listen(53690, '127.0.0.1', r));
    try {
      const br = browser();
      const { a, file } = newAuth(срв, br);
      await a.signIn();
      const back = new URL(new URL(br.seen.url).searchParams.get('redirect_to'));
      eq(back.port, '53691', 'адрес возврата указывает на свободный порт, а не на первый');
      eq(br.seen.port, '53691', 'и браузер стучался именно туда');
      fs.rmSync(file, { force: true });
    } finally {
      занятый.closeAllConnections && занятый.closeAllConnections();
      await new Promise(r => занятый.close(r));
    }
  });

  // Первая попытка сорвалась (браузер увели не туда) — сервер ждёт возврата ещё три
  // минуты и держит порт. Нажатие «Войти» должно ОТМЕНИТЬ её и начать заново, а не
  // молча вернуть прошлое обещание: кнопка казалась бы сломанной.
  await t('повторное нажатие отменяет зависшую попытку и начинает заново', async () => {
    const срв = fakeServer();
    let открытий = 0;
    // Поведение «браузера» меняем через переменную: auth.js захватывает саму функцию,
    // поэтому подменять свойство объекта поздно — он держит старую ссылку.
    let ведёт = async () => { открытий++; };          // первая попытка: увели не туда
    const { a, file } = newAuth(срв, { open: url => ведёт(url) });

    const первая = a.signIn().then(() => 'дошла', e => e.message);
    await new Promise(r => setTimeout(r, 40));        // дать серверу подняться и занять порт

    const br = browser();
    ведёт = async url => { открытий++; await br.open(url); };
    const вторая = await a.signIn();

    eq(вторая.signedIn, true, 'вторая попытка довела вход до конца');
    eq(/отмен/.test(await первая), true, 'первая честно отменена: ' + (await первая));
    eq(открытий, 2, 'браузер открывался ровно по разу на попытку');
    fs.rmSync(file, { force: true });
  });

  console.log('\n=== когда что-то пошло не так ===');

  // Свой state в адресе входа ломал возврат: Supabase заводит его сам и по нему находит
  // начатый вход, а посторонний опознать не может — «bad_oauth_state». Поймано вживую.
  await t('свой state не отправляем — его ведёт Supabase', async () => {
    const srv = fakeServer();
    const br = browser();
    const { a, file } = newAuth(srv, br);
    await a.signIn();
    const u = new URL(br.seen.url);
    eq(u.searchParams.get('state'), null, 'посторонний state ломает возврат');
    eq(u.searchParams.get('code_challenge_method'), 's256', 'от подделки защищает PKCE, а не state');
    fs.rmSync(file, { force: true });
  });

  // Чужой код, подсунутый на 127.0.0.1, обменять нельзя: без verifier сервер откажет.
  // Это и есть настоящая защита локального адреса, а не сверка state.
  await t('чужой код без нашего секрета не обменивается', async () => {
    const srv = fakeServer();
    srv.exchangeOk = false;                 // сервер отвергает обмен, как при чужом коде
    const { a, file } = newAuth(srv, browser());
    let упало = null;
    try { await a.signIn(); } catch (e) { упало = e.message; }
    eq(/verifier/.test(упало || ''), true, 'причина: ' + упало);
    eq(a.status().signedIn, false, 'внутрь не пустили');
    fs.rmSync(file, { force: true });
  });

  await t('человек отказал в Discord — говорим это словами', async () => {
    const srv = fakeServer();
    const { a, file } = newAuth(srv, browser('отказ'));
    let упало = null;
    try { await a.signIn(); } catch (e) { упало = e.message; }
    eq(/отказал/.test(упало || ''), true, 'причина: ' + упало);
    fs.rmSync(file, { force: true });
  });

  await t('протухший сеанс — забываем вход, а не тащим в браузер посреди игры', async () => {
    const srv = fakeServer();
    const { a, file } = newAuth(srv, browser());
    await a.signIn();
    srv.refreshOk = false;
    a.state.expiresAt = 0;
    eq(await a.token(), null, 'токена нет');
    eq(a.status().signedIn, false, 'вход забыт — войти предложат кнопкой');
    fs.rmSync(file, { force: true });
  });

  console.log('\n=== профиль ===');

  await t('профиль заводится от имени вошедшего', async () => {
    const srv = fakeServer();
    const { a, file } = newAuth(srv, browser());
    await a.signIn();
    const p = await a.ensureProfile();
    eq(p.nick, 'Тигро', 'ник ушёл на сервер');
    const call = srv.calls.find(c => c.p === '/rest/v1/rpc/ensure_profile');
    eq(call.headers.Authorization, 'Bearer access-1', 'запрос от имени аккаунта');
    eq(call.headers.apikey, KEY, 'публичный ключ на месте');
    fs.rmSync(file, { force: true });
  });

  await t('без входа профиль не запрашивается', async () => {
    const srv = fakeServer();
    const { a, file } = newAuth(srv, null);
    eq(await a.ensureProfile(), null, 'молча null');
    eq(srv.calls.length, 0, 'в сеть не ходили');
    fs.rmSync(file, { force: true });
  });

  await t('выход стирает всё, включая файл на диске', async () => {
    const srv = fakeServer();
    const { a, file } = newAuth(srv, browser());
    await a.signIn();
    eq(fs.existsSync(file), true, 'файл был');
    const st = a.signOut();
    eq(st.signedIn, false, 'вышли');
    eq(st.nick, null, 'ник забыт');
    eq(fs.existsSync(file), false, 'файл удалён');
  });

  console.log('\n=== токен на диске зашифрован ===');

  // Подставное шифрование: настоящее (DPAPI) живёт в Electron, а проверять надо не его,
  // а то, что библиотека им пользуется и переживает старый формат файла.
  const fakeSecret = {
    encrypt: s => 'ШИФР[' + Buffer.from(s, 'utf8').toString('base64') + ']',
    decrypt: s => {
      const m = /^ШИФР\[(.*)\]$/.exec(s);
      if (!m) throw new Error('не наш формат');
      return Buffer.from(m[1], 'base64').toString('utf8');
    },
  };

  await t('токен продления не лежит на диске открытым текстом', async () => {
    const srv = fakeServer();
    const br = browser();
    const { a, file } = newAuth(srv, br, { secret: fakeSecret });
    await a.signIn();
    const raw = fs.readFileSync(file, 'utf8');
    eq(raw.includes('refresh-1'), false, 'токена в файле не видно');
    eq(JSON.parse(raw).v, 2, 'формат помечен как шифрованный');
    eq(JSON.parse(raw).nick, 'Тигро', 'ник остаётся читаемым — он не секрет');
    fs.rmSync(file, { force: true });
  });

  await t('свой же файл читается обратно', async () => {
    const srv = fakeServer();
    const br = browser();
    const { a, file } = newAuth(srv, br, { secret: fakeSecret });
    await a.signIn();
    // второй экземпляр с тем же файлом — как перезапуск приложения
    const b = createAuth({ fetch: srv.fetch, file, secret: fakeSecret });
    b.configure({ url: URL_, key: KEY });
    eq(b.status().signedIn, true, 'вход пережил перезапуск');
    eq(b.state.refreshToken, 'refresh-1', 'токен расшифрован');
    fs.rmSync(file, { force: true });
  });

  await t('старый открытый файл переезжает в шифрованный сам', async () => {
    const srv = fakeServer();
    const file = path.join(os.tmpdir(), 'avalon-auth-old-' + Math.round(process.hrtime()[1]) + '.json');
    fs.writeFileSync(file, JSON.stringify({ refreshToken: 'refresh-old', userId: 'u1', nick: 'Игрок' }));
    const a = createAuth({ fetch: srv.fetch, file, secret: fakeSecret });
    a.configure({ url: URL_, key: KEY });
    eq(a.state.refreshToken, 'refresh-old', 'старый токен прочитан');
    const raw = fs.readFileSync(file, 'utf8');
    eq(raw.includes('refresh-old'), false, 'и тут же переписан шифрованным');
    eq(JSON.parse(raw).v, 2, 'новый формат');
    fs.rmSync(file, { force: true });
  });

  await t('без шифрования библиотека работает как раньше', async () => {
    const srv = fakeServer();
    const br = browser();
    const { a, file } = newAuth(srv, br);   // secret не передан — запуск вне Electron
    await a.signIn();
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq(j.v, 1, 'формат помечен как открытый — врать про защиту нельзя');
    eq(j.refreshToken, 'refresh-1', 'токен на месте');
    fs.rmSync(file, { force: true });
  });

  await t('чужой шифр не роняет приложение, а просто просит войти заново', async () => {
    const srv = fakeServer();
    const file = path.join(os.tmpdir(), 'avalon-auth-bad-' + Math.round(process.hrtime()[1]) + '.json');
    fs.writeFileSync(file, JSON.stringify({ v: 2, enc: 'мусор-с-другой-машины', userId: 'u1', nick: 'Игрок' }));
    const a = createAuth({ fetch: srv.fetch, file, secret: fakeSecret });
    a.configure({ url: URL_, key: KEY });
    eq(a.status().signedIn, false, 'считаем, что входа нет');
    eq(a.status().nick, 'Игрок', 'имя всё равно прочиталось');
    fs.rmSync(file, { force: true });
  });

  console.log(`\n${fail ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ЗЕЛЕНО'}: ${ok}/${ok + fail} проверок пройдено`);
  process.exit(fail ? 1 : 0);
})();
