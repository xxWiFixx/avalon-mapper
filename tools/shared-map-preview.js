// Two browser clients using the real sync/store modules and PostgreSQL functions in a disposable database.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabase } = require('../app/test/helpers/shared-database');
const { createSync } = require('../app/lib/sync');
const recognize = require('../app/lib/recognize');
const root = path.resolve(__dirname, '../app');
const port = Number(process.env.PORT) || 5189;
const viewerSnapshot = process.env.AVALON_VIEWER_SNAPSHOT || '';
const previewOwnerId = process.env.AVALON_PREVIEW_OWNER_ID || '';

(async () => {
  const db = await createDatabase();
  const roomTitle = viewerSnapshot ? 'GENIUS' : 'Проверка общей карты';
  const room = await db.rpc('alice', 'create_map', { p_title: roomTitle });
  await db.rpc('bob', 'join_map', { p_map: room });
  if (viewerSnapshot) {
    await db.rpc('alice', 'set_member_role', { p_map: room, p_user: db.users.bob, p_role: 'member' });
    await db.rpc('alice', 'set_map_policy', { p_map: room, p_confirm: 3 });
    const rows = JSON.parse(fs.readFileSync(viewerSnapshot, 'utf8').replace(/^\uFEFF/, ''));
    for (const row of rows) {
      if (!row.a || !row.b || !row.expires_at || Date.parse(row.expires_at) <= Date.now()) continue;
      await db.db.query(`insert into public.edges
        (map_id, a, b, cap_max, cap_max_known, expires_at, source, by_nick, updated_at, confirms, trusted)
        values ($1, $2, $3, $4, true, $5, 'ocr', $6, now() - interval '10 minutes', $7, $8)`,
      [room, row.a, row.b, row.cap_max ? Number(row.cap_max) : null, row.expires_at,
        row.by_nick || null, Number(row.confirms) || 0, row.trusted === 'true']);
    }
  }
  const clients = {};
  for (const user of ['alice', 'bob']) {
    delete require.cache[require.resolve('../app/lib/store')];
    const store = require('../app/lib/store');
    store.setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-map-preview-')));
    const streams = new Set();
    const config = { nick: viewerSnapshot && user === 'bob' ? 'Участник' : user, saveLocal: true, uploadPublic: false, theme: 'albion',
      zoneSource: 'off', overlayEnabled: true, overlayMap: true, overlayScale: 1, overlayHoldSec: 7,
      cursorScan: true, copyWorldZone: false, saveShots: false, appVersion: 'test', dev: false,
      binding: { label: 'F9' }, searchBinding: { label: 'F8' },
      syncUrl: 'https://fixture.supabase.co', syncKey: 'fixture-public-key',
      rooms: [{ id: room, title: roomTitle, upload: user === 'alice',
        role: user === 'alice' ? 'admin' : viewerSnapshot ? 'member' : 'viewer',
        isOwner: user === 'alice', confirmRequired: viewerSnapshot ? 3 : 0 }] };
    const emit = (event, data) => { for (const stream of streams) stream.write('data: ' + JSON.stringify({ event, data }) + '\n\n'); };
    const sync = createSync({ fetch: db.fetch, getToken: async () => user, flushMs: 1000, pullMs: 1000,
      onSnapshot: (rows, scope, pending) => {
        const changed = store.replaceRemote(rows, scope, pending);
        if (changed) emit('map-updated', store.snapshot());
        return changed;
      },
      onAccess: (id, access) => {
        const current = config.rooms.find(r => r.id === id);
        if (!current) return;
        if (access.role === 'none') config.rooms = [];
        else {
          if (current.role === access.role && current.confirmRequired === access.confirmRequired) return;
          current.role = access.role; current.confirmRequired = access.confirmRequired;
        }
        sync.configure(config); emit('rooms-changed', config.rooms); emit('sync-status', sync.status());
      },
    });
    sync.configure(config); sync.start();
    clients[user] = { config, store, sync, streams, emit };
  }
  async function call(user, method, args) {
    const c = clients[user];
    if (!c) throw new Error('unknown client');
    const reply = () => ({ ok: true, rooms: c.config.rooms, status: c.sync.status() });
    const actions = {
      getMap: () => c.store.snapshot(), getConfig: () => c.config,
      getZoneInfo: name => recognize.zoneInfo(name),
      getZoneNames: () => [...recognize.ZONE_INFO.keys()].map(name => recognize.zoneInfo(name)),
      roomsList: () => c.config.rooms, roomsSync: reply, syncStatus: () => c.sync.status(),
      authStatus: () => ({ signedIn: true, nick: c.config.nick,
        userId: user === 'alice' && previewOwnerId ? previewOwnerId : db.users[user], trusted: false }),
      updateStatus: () => ({ current: 'test', checkedAt: Date.now() }),
      setOption: (key, value) => { c.config[key] = value; return c.config; },
      roomUpload: (id, on) => { c.config.rooms.find(r => r.id === id).upload = on;
        c.sync.configure(c.config); c.emit('rooms-changed', c.config.rooms); return reply(); },
      mapMembers: async id => ({ ok: true, members: (await db.rpc(user, 'map_members_list', { p_map: id }))
        .map(m => ({ id: m.user_id, nick: m.nick, role: m.role, isOwner: m.is_owner })) }),
      mapSetRole: async (id, who, role) => { await db.rpc(user, 'set_member_role', { p_map: id, p_user: who, p_role: role }); return actions.mapMembers(id); },
      mapPolicy: async (id, n) => ({ ok: true, confirmRequired: await db.rpc(user, 'set_map_policy', { p_map: id, p_confirm: n }) }),
      removeEdge: async (a, b, scope) => {
        if (scope !== 'local') await c.sync.deleteEdge(scope, a, b);
        c.store.removeEdgeFromMap(a, b, scope); c.emit('map-updated', c.store.snapshot());
        return { ok: true, snapshot: c.store.snapshot() };
      },
      roomLeave: async id => { await c.sync.leaveGroup(id); c.config.rooms = c.config.rooms.filter(r => r.id !== id);
        c.store.dropMap(id); c.sync.configure(c.config); c.emit('rooms-changed', c.config.rooms);
        c.emit('map-updated', c.store.snapshot()); return reply(); },
    };
    return actions[method] ? actions[method](...args) : {};
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + port);
    const user = url.searchParams.get('client') || 'alice';
    try {
      if (url.pathname === '/events') {
        const c = clients[user];
        if (!c) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        c.streams.add(res); req.on('close', () => c.streams.delete(res));
        c.emit('ready', { binding: c.config.binding.label, searchBinding: c.config.searchBinding.label });
        c.emit('game-state', { running: true });
        return;
      }
      if (url.pathname === '/test-ipc.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(`const client = new URLSearchParams(location.search).get('client') || 'alice';
          const listeners = new Map(), latest = new Map();
          window.api = new Proxy({}, { get: (_, method) => method === 'on' ? (name, cb) => {
            if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(cb);
            if (latest.has(name)) queueMicrotask(() => cb(latest.get(name)));
            return () => listeners.get(name).delete(cb);
          } : (...args) => fetch('/api?client='+client, {method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({method,args})}).then(r=>r.json()) });
          new EventSource('/events?client='+client).onmessage = event => {
            const m=JSON.parse(event.data); latest.set(m.event,m.data);
            for (const cb of listeners.get(m.event)||[]) cb(m.data);
          };`);
        return;
      }
      if (url.pathname === '/api' && req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks));
        const result = await call(user, request.method, request.args || []);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)); return;
      }
      if (url.pathname === '/test-action' && req.method === 'POST') {
        const action = url.searchParams.get('action');
        const actor = clients[user];
        if (action === 'add' || action === 'correct') {
          const tip = { name: 'Touos-Ataglos', capMax: 20, capMaxKnown: true,
            expiresAt: Date.now() + (action === 'correct' ? 120000 : 3600000) };
          const e = actor.store.addEdge('Qiient-Si-Tertum', tip, user, 'ocr', ['local', ...actor.sync.status().targets]);
          actor.sync.push(e); actor.emit('map-updated', actor.store.snapshot()); await actor.sync.tick(true);
        } else if (action === 'promote') {
          await db.rpc('alice', 'set_member_role', { p_map: room, p_user: db.users.bob, p_role: 'member' });
        } else if (action === 'delete') {
          await db.rpc('alice', 'delete_edge', { p_map: room, p_a: 'Qiient-Si-Tertum', p_b: 'Touos-Ataglos' });
        }
        for (const c of Object.values(clients)) await c.sync.tick(true);
        res.writeHead(200).end('ok'); return;
      }
      const rel = url.pathname === '/' ? '/ui/index.html' : decodeURIComponent(url.pathname);
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      let bytes = await fs.promises.readFile(file);
      if (rel === '/ui/index.html') bytes = Buffer.from(bytes.toString().replace('<script src="../node_modules/cytoscape', '<script src="/test-ipc.js"></script><script src="../node_modules/cytoscape'));
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
        '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': (type || 'application/octet-stream') + (type?.startsWith('text/') ? '; charset=utf-8' : ''),
        'Cache-Control': 'no-store' }).end(bytes);
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message })); }
  });
  server.listen(port, '127.0.0.1', () => console.log('Shared map preview: http://127.0.0.1:' + port + '/ui/index.html?client=alice and /ui/index.html?client=bob'));
  process.on('SIGINT', async () => { for (const c of Object.values(clients)) { c.sync.stop(); c.store.flush(); }
    server.close(); await db.close(); process.exit(0); });
})().catch(e => { console.error(e.message); process.exitCode = 1; });
