import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Emits a tiny service worker that caches the built app so Lumen opens even
 * when the clinic network is down. Patient data never goes through it — that
 * lives in the browser's database and the archive folder.
 */
function offlineServiceWorker(): Plugin {
  return {
    name: 'lumen-offline-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const assets = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './sample-worklist.csv', ...files.map((f) => './' + f)];
      const version = Date.now().toString(36);
      const source = `// Generated at build time.
const CACHE = 'lumen-${version}';
const ASSETS = ${JSON.stringify([...new Set(assets)])};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // Keep the previous build's cache: a window still open on it may yet load a lazy chunk (the encoder).
  e.waitUntil(
    caches.keys()
      .then((keys) => {
        const old = keys.filter((k) => k.startsWith('lumen-') && k !== CACHE).sort();
        return Promise.all(old.slice(0, -1).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), offlineServiceWorker()],
  worker: { format: 'es' },
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: { target: 'es2022', sourcemap: false },
});
