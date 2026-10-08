import { defineConfig } from 'vite';
import { createReadStream, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import main from '../../vite.config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = resolve(root, '../site/assets');
const mime = { '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };
export default defineConfig({ ...main, root, server: { host: '127.0.0.1', port: 5196, strictPort: true, fs: { allow: [resolve(root, '..')] } },
  plugins: [...main.plugins, { name: 'local-map-review', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/map/') { req.url = '/test/browser/index.html' + url.search; return next(); }
      if (!url.pathname.startsWith('/assets/')) return next();
      const path = resolve(assets, decodeURIComponent(url.pathname.slice('/assets/'.length)));
      if (!path.startsWith(assets + sep)) { res.statusCode = 403; return res.end(); }
      try { if (!statSync(path).isFile()) return next(); } catch { return next(); }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      createReadStream(path).pipe(res);
    });
  } }] });
