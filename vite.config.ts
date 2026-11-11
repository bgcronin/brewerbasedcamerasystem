import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import lock from './package-lock.json';

/**
 * Emits a tiny service worker that caches the built app so Lumen opens even
 * when the clinic network is down. Patient data never goes through it — that
 * lives in the browser's database and the archive folder.
 */
function offlineServiceWorker(): Plugin {
  // The list reader's files change only when its engines do, so their cache is named after those, not after the build.
  const installed = lock.packages as Record<string, { version?: string }>;
  const engines = ['tesseract.js', 'tesseract.js-core', '@tesseract.js-data/eng', 'pdfjs-dist'].map((name) => installed[`node_modules/${name}`]?.version ?? '0').join('_');
  return {
    name: 'lumen-offline-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const assets = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './sample-worklist.csv', ...files.map((f) => './' + f)];
      const version = Date.now().toString(36);
      // No regular expressions with slashes in here: a backslash in this template is gone by the time the file is written.
      const source = `// Generated at build time.
const CACHE = 'lumen-${version}';
const OCR_CACHE = 'lumen-ocr-${engines}';
const ASSETS = ${JSON.stringify([...new Set(assets)])};
// The preview server sends "Vary: Origin", which would stop a cached script matching the page's own request for it.
const ANY = { ignoreVary: true };

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => {
        const mine = keys.filter((k) => k.startsWith('lumen-'));
        const ocr = mine.filter((k) => k.startsWith('lumen-ocr-') || k.endsWith('-ocr'));
        // Keep the previous build's cache: a window still open on it may yet load a lazy chunk (the encoder).
        const builds = mine.filter((k) => !ocr.includes(k) && k !== CACHE).sort();
        const gone = [...builds.slice(0, -1), ...ocr.filter((k) => k !== OCR_CACHE)];
        return Promise.all(gone.map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

// This build's files first. Only what this build does not have (a lazy chunk of the one before) comes from an older cache.
const cached = (req) => caches.open(CACHE).then((c) => c.match(req, ANY)).then((hit) => hit || caches.match(req, ANY));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => cached('./index.html')));
    return;
  }
  // The text reader's engine and language data are large, so they're cached on first use rather than at install.
  if (url.pathname.includes('/ocr/')) {
    e.respondWith(
      caches.open(OCR_CACHE).then((c) =>
        c.match(req, ANY).then((hit) => hit || fetch(req).then((res) => {
          // A server that answers a missing file with the app's page must not have that page kept as the file.
          const html = (res.headers.get('content-type') || '').includes('text/html');
          if (res.ok && !html) c.put(req, res.clone());
          return res;
        })),
      ),
    );
    return;
  }
  e.respondWith(cached(req).then((hit) => hit || fetch(req)));
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
