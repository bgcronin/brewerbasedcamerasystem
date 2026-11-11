// Local server: Lumen connects over a WebSocket on this computer only.
//
// Text messages are JSON. Binary messages carry images:
//   [0x01][JPEG]                                   live view frame
//   [0x02][uint32 BE header length][JSON][JPEG]    photo
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

export const PROTOCOL_VERSION = 1;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
  '.ico': 'image/x-icon',
};

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function createServer({ backend, port = 47800, host = '127.0.0.1', distDir, allowOrigins = [], unfiledDir, version, log = console.log }) {
  const clients = new Set();
  let active = null;
  let unfiledCount = 0;
  const wantLiveView = new Set();
  unfiledDir ??= path.join(os.homedir(), 'Pictures', 'Lumen Camera Link', 'Unfiled');

  const status = () => ({
    app: 'lumen-camera-link',
    version,
    protocol: PROTOCOL_VERSION,
    ...backend.info(),
    camera: backend.state,
  });

  const serveStatic = (req, res) => {
    const root = path.resolve(distDir);
    let file;
    try {
      const url = new URL(req.url, 'http://x');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0')) throw new Error('NUL in path');
      if (pathname === '/' || pathname === '') pathname = '/index.html';
      file = path.resolve(root, '.' + pathname);
    } catch {
      // Malformed percent-encoding (URIError), an unparsable URL, or a NUL byte.
      res.writeHead(400).end();
      return;
    }
    // Anything that resolves outside dist/ (also "dist-sibling/…") is refused.
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, st) => {
      const target = !err && st.isFile() ? file : path.join(root, 'index.html');
      const ext = path.extname(target).toLowerCase();
      const stream = fs.createReadStream(target);
      stream.on('open', () => {
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Cache-Control': /index\.html$|sw\.js$/.test(target) ? 'no-cache' : 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
      });
      stream.on('error', (e) => {
        // The file vanished or can't be read between stat and open.
        if (res.headersSent) res.destroy();
        else res.writeHead(e.code === 'ENOENT' ? 404 : 500).end();
      });
      stream.pipe(res);
    });
  };

  const handleRequest = (req, res) => {
    if (req.url?.startsWith('/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status()));
      return;
    }
    if (distDir && fs.existsSync(path.join(distDir, 'index.html'))) {
      serveStatic(req, res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const cam = backend.state ?? {};
    res.end(`<!doctype html><meta charset="utf-8"><title>Lumen Camera Link</title>
<body style="font:15px system-ui;background:#05080d;color:#eef3fb;display:grid;place-items:center;height:100vh;margin:0">
<div><h1 style="font-weight:650;letter-spacing:-.02em">Lumen Camera Link is running</h1>
<p>Camera: ${cam.state === 'connected' ? cam.model : cam.message ?? cam.state}</p>
<p style="color:#8e9cb2">Open Lumen and choose <b>Canon EOS · direct</b> as the camera source.</p></div>`);
  };

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (e) {
      // No request may take the helper down.
      log(`request ${req.url}: ${e?.message ?? e}`);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    }
  });

  const wss = new WebSocketServer({
    server,
    path: '/camera',
    maxPayload: 1024 * 1024,
    verifyClient: ({ origin }, done) => {
      // Only Lumen on this computer (or an address you allow explicitly) may use the camera.
      const ok = !origin || isLocalOrigin(origin) || allowOrigins.includes(origin);
      if (!ok) log(`refused connection from ${origin}`);
      done(ok, 403, 'Origin not allowed');
    },
  });

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg) => {
    for (const ws of clients) send(ws, msg);
  };
  const updateLiveView = () => backend.setLiveView(wantLiveView.size > 0);

  wss.on('connection', (ws) => {
    clients.add(ws);
    active = ws;
    send(ws, { type: 'hello', ...status() });
    send(ws, { type: 'camera', ...backend.state });
    if (backend.props && Object.keys(backend.props).length) send(ws, { type: 'props', props: backend.props });
    if (unfiledCount) {
      send(ws, {
        type: 'notice',
        tone: 'warning',
        message: `${unfiledCount} photo${unfiledCount === 1 ? ' was' : 's were'} taken while Lumen was closed`,
        detail: `Saved in ${unfiledDir}. Add them to the patient with “Add photos from files”.`,
      });
      unfiledCount = 0;
    }

    // ws emits 'error' for bad frames (too large, invalid UTF-8); unhandled, that would crash the process.
    ws.on('error', (e) => log(`websocket: ${e?.message ?? e}`));

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      const id = msg.id;
      active = ws;
      const reply = (ok, extra = {}) => send(ws, { type: 'result', id, ok, ...extra });
      try {
        switch (msg.type) {
          case 'active':
            break;
          case 'liveview':
            if (msg.on) wantLiveView.add(ws);
            else wantLiveView.delete(ws);
            updateLiveView();
            reply(true);
            break;
          case 'capture':
            await backend.capture(msg.captureId ?? msg.id);
            reply(true);
            break;
          case 'set':
            await backend.setProp(msg.prop, msg.value);
            reply(true);
            break;
          case 'apply':
            reply(true, await backend.applyValues(msg.values));
            break;
          case 'reconnect':
            backend.reconnect();
            reply(true);
            break;
          default:
            reply(false, { error: `Unknown request “${msg.type}”` });
        }
      } catch (e) {
        reply(false, { error: e?.message ?? String(e) });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      wantLiveView.delete(ws);
      if (active === ws) active = [...clients].pop() ?? null;
      updateLiveView();
    });
  });

  backend.on('camera', (s) => broadcast({ type: 'camera', ...s }));
  backend.on('props', (props) => broadcast({ type: 'props', props }));
  backend.on('liveview', (s) => broadcast({ type: 'liveview', ...s }));
  backend.on('notice', (n) => broadcast({ type: 'notice', ...n }));
  backend.on('capture-failed', (f) => broadcast({ type: 'capture-failed', ...f }));

  backend.on('frame', (jpeg) => {
    const packet = Buffer.concat([Buffer.from([1]), jpeg]);
    for (const ws of wantLiveView) {
      // Drop frames rather than queue them if the browser falls behind.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1.5 * 1024 * 1024) ws.send(packet, { binary: true });
    }
  });

  backend.on('photo', (photo) => {
    const header = Buffer.from(
      JSON.stringify({ requestId: photo.requestId, name: photo.name, size: photo.data.length, takenAt: photo.takenAt, exposure: photo.exposure }),
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length, 0);
    const target = active?.readyState === active?.OPEN ? active : [...clients].find((c) => c.readyState === c.OPEN);
    if (target) {
      log(`sent ${photo.name} to Lumen`);
      target.send(Buffer.concat([Buffer.from([2]), len, header, photo.data]), { binary: true });
      return;
    }
    // Nobody is listening: never lose a photo.
    try {
      fs.mkdirSync(unfiledDir, { recursive: true });
      const stamp = new Date(photo.takenAt).toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(unfiledDir, `${stamp}_${photo.name}`), photo.data);
      unfiledCount++;
      log(`Lumen is not open — saved ${photo.name} to ${unfiledDir}`);
    } catch (e) {
      log(`could not save ${photo.name}: ${e.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const close = () =>
      new Promise((r) => {
        // ws doesn't close open connections for us; do it so the process can exit.
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => r());
      });
    server.listen(port, host, () => resolve({ server, wss, close }));
  });
}
