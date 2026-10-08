import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { syncAppInterface } from './scripts/app-interface.js';
import { cleanStaleBundles } from './scripts/clean-stale-bundles.js';
syncAppInterface();
export default defineConfig({
  plugins: [react(), tailwindcss(), cleanStaleBundles()],
  base: './',
  publicDir: false,
  build: { outDir: '../site', emptyOutDir: false, assetsDir: 'bundle', sourcemap: false,
    rollupOptions: { input: { home: fileURLToPath(new URL('./index.html', import.meta.url)),
      map: fileURLToPath(new URL('./map/index.html', import.meta.url)),
      auth: fileURLToPath(new URL('./auth/callback/index.html', import.meta.url)) } } },
});
