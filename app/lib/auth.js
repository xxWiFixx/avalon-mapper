// Вход через Discord.
//
// ПРАВИЛО, ОТ КОТОРОГО ЗДЕСЬ ВСЁ ЗАВИСИТ: без входа приложение работает полностью.
// Личная карта — файл на диске, ей сеть не нужна вовсе. Вход открывает только общее:
// комнаты с друзьями и общую карту. Человек скачал, поставил, играет; заводить аккаунт
// ради карты порталов его никто не заставляет.
//
// Почему именно Discord, а не анонимный аккаунт: порог «три подтверждения» имеет смысл,
// только если это три разных ЧЕЛОВЕКА. Анонимный аккаунт накручивается переустановкой,
// аккаунт Discord — нет. И «доверенный игрок» перестаёт быть абстракцией: видно, кому
// выдаёшь право удалять из общей карты.
//
// КАК УСТРОЕН ВХОД. Пароль приложение не видит НИКОГДА — его вводят у себя в браузере,
// на стороне Discord. Схема стандартная для настольных программ (PKCE, RFC 7636):
//   1. придумываем секрет verifier и его отпечаток challenge;
//   2. поднимаем сервер на 127.0.0.1 и открываем СИСТЕМНЫЙ браузер на странице Discord;
//   3. человек подтверждает доступ, Discord возвращает на 127.0.0.1 код авторизации;
//   4. меняем код на токен, предъявив verifier — доказательство, что код наш.
// Обычный поток Supabase кладёт токен во фрагмент адреса (после #), а фрагмент до
// локального сервера не доходит вовсе — поэтому именно PKCE, он возвращает код
// параметром запроса.
//
// state в адресе — защита от подсовывания чужого кода: на 127.0.0.1 может постучаться
// что угодно, и без сверки мы приняли бы любой запрос.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const PORTS = [53682, 53683, 53684];   // те же, что прописаны в Redirect URLs у Supabase
const WAIT_MS = 3 * 60 * 1000;         // столько ждём человека в браузере
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15000;

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Страница, которую человек увидит в браузере после входа. Намеренно без единого
// запроса наружу: это локальный адрес, и тянуть с него шрифты или картинки незачем.
function donePage(ok, text) {
  return `<!doctype html><meta charset="utf-8"><title>Avalon Mapper</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#191413;color:#c9bda6;
font:15px/1.5 'Segoe UI',system-ui,sans-serif">
<div style="text-align:center;max-width:34em;padding:24px">
<div style="font-size:26px;color:${ok ? '#f6c874' : '#c86a5a'};margin-bottom:10px">${ok ? 'Готово' : 'Не вышло'}</div>
<div>${text}</div>
<div style="margin-top:14px;color:#948877">Окно можно закрыть.</div></div>`;
}

function createAuth(opts = {}) {
  const o = Object.assign({ log: () => {} }, opts);
  const fetchImpl = o.fetch || globalThis.fetch;
  const now = o.now || (() => Date.now());
  const openExternal = o.openExternal || (() => { throw new Error('нечем открыть браузер'); });
  const file = o.file || null;
  const ports = o.ports || PORTS;
  const state = {
    url: '', key: '',
    accessToken: null, refreshToken: null, expiresAt: 0,
    userId: null, nick: null, avatar: null, trusted: false,
    lastError: null, busy: null, pendingWait: null,
  };

  function configure({ url, key }) {
    state.url = String(url || '').replace(/\/+$/, '');
    state.key = String(key || '');
  }

  // ХРАНЕНИЕ ТОКЕНА ПРОДЛЕНИЯ.
  //
  // Это единственный секрет приложения на диске, и он лежит в файле, который читает
  // любая программа, запущенная под тем же пользователем Windows. Режим 0600 тут не
  // спасает: Node на Windows переносит из него только флаг «только для чтения», прав
  // POSIX там нет вовсе — проверено, файл выходит с обычными правами.
  //
  // Поэтому токен шифруется средством самой системы (DPAPI через Electron safeStorage,
  // main.js передаёт его сюда как secret). Ключ привязан к учётной записи Windows:
  // унесённый на другую машину или открытый другим пользователем файл бесполезен.
  // От программы, работающей ПОД ТЕМ ЖЕ пользователем, это не защищает — такой защиты
  // не существует вовсе, — но от копирования файла защищает.
  //
  // secret нет (тесты, запуск вне Electron) — пишем как раньше, открытым текстом,
  // и это видно по полю v в файле.
  const secret = o.secret || null;
  function seal(text) {
    if (!secret || !text) return null;
    try { return secret.encrypt(text); } catch (err) { o.log('[вход] шифрование недоступно: ' + err.message); return null; }
  }
  function unseal(text) {
    if (!secret || !text) return null;
    try { return secret.decrypt(text); } catch (err) { o.log('[вход] расшифровать не вышло: ' + err.message); return null; }
  }

  function load() {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j) return;
      // enc — зашифрованный токен, refreshToken — открытый (старый формат и запуск
      // без Electron). Открытый после успешной расшифровки перезапишется при первом
      // же save(), поэтому переход происходит сам собой.
      const token = unseal(j.enc) || (typeof j.refreshToken === 'string' ? j.refreshToken : null);
      if (token) state.refreshToken = token;
      if (typeof j.userId === 'string') state.userId = j.userId;
      if (typeof j.nick === 'string') state.nick = j.nick;
      // Файл в старом формате, а шифровать теперь есть чем — перекладываем сразу,
      // не дожидаясь следующего входа.
      if (token && j.enc == null && secret) save();
    } catch (e) { /* не входил ещё — норм */ }
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const enc = seal(state.refreshToken);
      const body = { v: enc ? 2 : 1, userId: state.userId, nick: state.nick };
      if (enc) body.enc = enc; else body.refreshToken = state.refreshToken;
      fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    } catch (err) { o.log('[вход] не сохранился: ' + err.message); }
  }
  function forget() {
    state.accessToken = null; state.refreshToken = null; state.expiresAt = 0;
    state.userId = null; state.nick = null; state.avatar = null; state.trusted = false;
    if (file) { try { fs.rmSync(file, { force: true }); } catch (e) { /* и ладно */ } }
  }

  async function call(pathname, body, { auth = false } = {}) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const headers = { apikey: state.key, 'Content-Type': 'application/json' };
      if (auth && state.accessToken) headers.Authorization = 'Bearer ' + state.accessToken;
      const res = await fetchImpl(state.url + pathname, {
        method: 'POST', headers, body: JSON.stringify(body || {}),
        signal: ctrl ? ctrl.signal : undefined,
      });
      const text = await res.text().catch(() => '');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* не json — покажем как есть */ }
      if (!res.ok) {
        const msg = (json && (json.msg || json.message || json.error_description || json.error)) || text.slice(0, 200);
        const err = new Error('HTTP ' + res.status + (msg ? ': ' + msg : ''));
        err.status = res.status;
        throw err;
      }
      return json;
    } finally { if (timer) clearTimeout(timer); }
  }

  // Ник и картинка приходят от Discord в метаданных пользователя. Имена полей у провайдеров
  // разные, поэтому перебираем известные, а не полагаемся на одно.
  function nickFrom(user) {
    const m = (user && user.user_metadata) || {};
    return m.global_name || m.full_name || m.name || m.user_name || m.preferred_username
      || (user && user.email ? String(user.email).split('@')[0] : null);
  }

  function remember(session) {
    if (!session || !session.access_token) throw new Error('в ответе нет токена');
    state.accessToken = session.access_token;
    state.refreshToken = session.refresh_token || state.refreshToken;
    state.expiresAt = now() + (Number(session.expires_in) || 3600) * 1000;
    if (session.user) {
      state.userId = session.user.id || state.userId;
      state.nick = nickFrom(session.user) || state.nick;
      state.avatar = (session.user.user_metadata && session.user.user_metadata.avatar_url) || null;
    }
    state.lastError = null;
    save();
  }

  // Дождаться возврата из браузера. Сервер живёт ровно один вход и умирает сразу после:
  // держать открытый порт всё время работы приложения незачем.
  function waitForCode() {
    let stop = () => {};
    // Порт возвращаем ОБЕЩАНИЕМ, а не читаем через тик из общего поля.
    // Раньше адрес возврата собирался после setImmediate, в надежде, что listen уже
    // отработал. Когда первый порт свободен, так и есть. А когда занят — а он занят
    // ровно после неудачной попытки, сервер живёт ещё три минуты, — listen уходит на
    // второй круг, тик успевает раньше, и в адрес попадает НЕ ТОТ порт: браузер стучится
    // туда, где никого нет. Второй вход подряд ломался бы всегда.
    let onPort = () => {};
    const port = new Promise(r => { onPort = r; });
    const promise = new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => {
        if (done) return; done = true; clearTimeout(timer);
        // closeAllConnections обязателен: браузер держит соединение живым, и один close()
        // ждал бы его вечно — процесс не завершался бы вовсе.
        if (server.closeAllConnections) server.closeAllConnections();
        server.close();
        fn(arg);
      };
      // Закрыть сервер снаружи. Без этого сорвавшееся открытие браузера оставляло бы
      // порт занятым до конца работы приложения, и повторный вход был бы невозможен.
      stop = () => finish(reject, new Error('вход отменён'));
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const code = u.searchParams.get('code');
        const err = u.searchParams.get('error_description') || u.searchParams.get('error');
        const bad = err ? err : (!code ? 'Discord не вернул код' : null);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(donePage(!bad, bad ? String(bad).slice(0, 200) : 'Вход выполнен, вернись в приложение.'));
        if (bad) finish(reject, new Error(String(bad).slice(0, 200)));
        else finish(resolve, code);
      });
      const timer = setTimeout(() => finish(reject, new Error('вход не завершён за три минуты')), WAIT_MS);
      // Перебор портов. Тонкость, на которой это уже сломалось: обработчик, переданный
      // третьим аргументом в server.listen, вешается на событие 'listening' и НЕ снимается,
      // если попытка провалилась. После EADDRINUSE он остаётся висеть и срабатывает, когда
      // получится СЛЕДУЮЩИЙ порт, — с портом из своего замыкания, то есть с занятым.
      // Приложение слушало 53691, а браузеру называло 53682. Поэтому подписки ставим сами
      // и на каждом исходе снимаем обе: выживает ровно одна.
      let i = 0;
      const tryPort = () => {
        if (i >= ports.length) {
          onPort(null);   // сообщаем ждущему, что порта не будет, иначе он повиснет навсегда
          return finish(reject, new Error('все порты для входа заняты: ' + ports.join(', ')));
        }
        const p = ports[i++];
        const onErr = err => {
          server.removeListener('listening', onOk);
          if (err && err.code === 'EADDRINUSE') tryPort(); else finish(reject, err);
        };
        const onOk = () => {
          server.removeListener('error', onErr);
          server.on('error', e => finish(reject, e));
          onPort(p);
        };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(p, '127.0.0.1');
      };
      tryPort();
    });
    promise.catch(() => {});   // ждущий появится через тик — необработанным отказ не считаем
    return { promise, port, stop };
  }

  // Открыть браузер и довести вход до конца. Возвращает статус.
  async function signIn() {
    if (!state.url || !state.key) throw new Error('не задан адрес проекта');
    // Новое нажатие ОТМЕНЯЕТ прошлую попытку. Раньше оно молча возвращало её обещание:
    // если первый вход сорвался (браузер увело не туда), кнопка три минуты не делала
    // ничего видимого — сервер ждал возврата, которого уже не будет, и держал порт.
    if (state.pendingWait) { state.pendingWait.stop(); state.pendingWait = null; }
    if (state.busy) { try { await state.busy; } catch (e) { /* прошлая попытка отменена */ } }
    state.busy = (async () => {
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const wait = waitForCode();
      state.pendingWait = wait;
      // Порт узнаём от самого сервера, а не гадаем: занятый первый порт уводит listen
      // на второй круг, и адрес возврата обязан указывать туда же, где мы слушаем.
      const port = await wait.port;
      if (!port) return wait.promise;   // портов не нашлось — бросит настоящую причину
      const redirect = `http://127.0.0.1:${port}/callback`;
      const url = state.url + '/auth/v1/authorize?provider=discord'
        + '&redirect_to=' + encodeURIComponent(redirect)
        // ПРОСИМ ТОЛЬКО identify — имя, id и аватарку, и больше ничего.
        //
        // По умолчанию Supabase просит у Discord identify И email, то есть почта каждого
        // игрока оседала бы в auth.users на нашем сервере. Она приложению не нужна ни для
        // чего: аккаунты различаются по uuid, ник берётся из global_name, писать людям мы
        // не собираемся. А раз не нужна — незачем и хранить: чего нет, то не утечёт и не
        // придётся охранять.
        + '&scopes=identify'
        + '&code_challenge=' + challenge + '&code_challenge_method=s256';
      // Своего state здесь БЫТЬ НЕ ДОЛЖНО. Supabase заводит его сам — по нему он потом
      // находит начатый вход, — и посторонний state ломает возврат с ошибкой
      // bad_oauth_state: «OAuth state parameter is invalid». Проверено вживую.
      // От подделки нас защищает не он, а PKCE: код меняется на токен только вместе
      // с verifier, а тот не покидает приложение. Чужой код, подсунутый на 127.0.0.1,
      // обменять невозможно — попытка кончится ошибкой, и мы её покажем.
      try {
        await openExternal(url);
        const code = await wait.promise;
        remember(await call('/auth/v1/token?grant_type=pkce', { auth_code: code, code_verifier: verifier }));
        o.log('[вход] Discord: ' + (state.nick || state.userId));
        return status();
      } catch (err) {
        state.lastError = err.message;
        o.log('[вход] не удалось: ' + err.message);
        throw err;
      } finally { wait.stop(); if (state.pendingWait === wait) state.pendingWait = null; state.busy = null; }
    })();
    return state.busy;
  }

  async function refresh() {
    if (!state.refreshToken) return false;
    try {
      remember(await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: state.refreshToken }));
      return true;
    } catch (err) {
      o.log('[вход] сеанс не продлился (' + err.message + ')');
      // 4xx значит «этот токен больше не годится» — вход придётся повторить руками.
      // Молча открывать браузер посреди игры нельзя, поэтому просто забываем.
      if (err.status >= 400 && err.status < 500) { forget(); }
      return false;
    }
  }

  // Действующий токен или null. САМА НЕ ВХОДИТ: без входа общие карты просто выключены,
  // а выдёргивать человека в браузер из-за фонового запроса — худшее, что можно сделать.
  async function token() {
    if (!state.url || !state.key || !fetchImpl) return null;
    if (!state.refreshToken && !state.accessToken) return null;
    if (state.accessToken && now() < state.expiresAt - REFRESH_MARGIN_MS) return state.accessToken;
    if (state.busy) { try { await state.busy; } catch (e) { /* уже записано в lastError */ } return state.accessToken; }
    state.busy = (async () => {
      try { return (await refresh()) ? state.accessToken : null; }
      finally { state.busy = null; }
    })();
    return state.busy;
  }

  // Профиль на сервере: заводится при первом обращении, отдаёт ник и признак доверия.
  async function ensureProfile() {
    const t = await token();
    if (!t) return null;
    try {
      const rows = await call('/rest/v1/rpc/ensure_profile', { p_nick: state.nick || null }, { auth: true });
      const p = Array.isArray(rows) ? rows[0] : rows;
      if (p) { state.nick = p.nick || state.nick; state.trusted = !!p.trusted; state.userId = p.id || state.userId; save(); }
      return p || null;
    } catch (err) {
      state.lastError = err.message;
      o.log('[вход] профиль не создан: ' + err.message);
      return null;
    }
  }

  function signOut() { forget(); o.log('[вход] выход выполнен'); return status(); }

  function status() {
    return {
      signedIn: !!(state.refreshToken || state.accessToken),
      userId: state.userId,
      nick: state.nick,
      avatar: state.avatar,
      trusted: state.trusted,
      error: state.lastError,
    };
  }

  load();
  return { configure, signIn, signOut, token, ensureProfile, status, state };
}

module.exports = { createAuth };
