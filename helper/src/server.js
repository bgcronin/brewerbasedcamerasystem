// Local server: Lumen connects over a WebSocket on this computer only.
//
// Text messages are JSON. Binary messages carry images:
//   [0x01][JPEG]                                   live view frame
//   [0x02][uint32 BE header length][JSON][JPEG]    photo
//
// Which window gets a photo: one taken from Lumen goes back to the window that asked for it; one taken
// with the camera's own button goes to the window the user looked at last. Each window reports that with
//   { type: 'active', visible, focused, at, acks: true }
// A photo's header carries a photoId, and Lumen answers { type: 'photo-ack', photoId } as soon as it
// has the frame. A photo that is not confirmed is saved in the Unfiled folder instead of being lost.
//
// As soon as the camera reports a photo taken with its own button, before the file has been fetched,
// that window is sent { type: 'incoming', name }. Lumen notes the patient and eye selected at that
// moment, so the photo is labelled as things stood when it was taken.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

export const PROTOCOL_VERSION = 2;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  // Served as the bytes they are (never with Content-Encoding): the text reader unpacks its own data.
  '.gz': 'application/gzip',
  '.traineddata': 'application/octet-stream',
};
/** Vite's built files carry a content hash in their name (assets/index-CB-cLnDA.js) and so never change. */
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const NO_LIVE_VIEW_MESSAGE = 'Live view is switched off: Lumen Camera Link was started with --no-live-view.';

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

export function defaultUnfiledDir() {
  return path.join(os.homedir(), 'Pictures', 'Lumen Camera Link', 'Unfiled');
}

/**
 * @param {object} opts
 * @param {number} [opts.ackTimeoutMs]  how long Lumen has to confirm a photo before it is saved to Unfiled
 * @param {boolean} [opts.liveView]     false: never turn the camera's live view on (--no-live-view)
 */
export function createServer({
  backend,
  port = 47800,
  host = '127.0.0.1',
  distDir,
  allowOrigins = [],
  unfiledDir,
  version,
  log = console.log,
  ackTimeoutMs = 10_000,
  liveView = true,
}) {
  /** Open Lumen windows: socket → { id, visible, focused, at, acks }. */
  const clients = new Map();
  let nextClientId = 1;
  const wantLiveView = new Set();
  /** Which window asked for which capture: captureId → { ws, at }. */
  const captureOwners = new Map();
  /** Photos sent and not yet confirmed: photoId → { photo, ws, timer, fail }. */
  const awaitingAck = new Map();
  /** The window told that a camera-button photo is on its way: shot name → { ws, at }. */
  const announcedTo = new Map();
  /** Photos given up on, in case their confirmation still turns up: photoId → { name, file }. */
  const gaveUp = new Map();
  let nextPhotoId = 1;
  const counters = { sent: 0, confirmed: 0, unfiled: 0 };
  unfiledDir = path.resolve(unfiledDir ?? defaultUnfiledDir());

  /* ───────── the Unfiled folder ───────── */

  // Files saved there that no Lumen window has been told about yet. Kept on disk, so the notice
  // survives a restart of Camera Link and is shown once, to a window somebody is looking at.
  const noticeFile = path.join(unfiledDir, '.not-yet-announced.json');
  let unannounced = [];
  try {
    const saved = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
    if (Array.isArray(saved)) unannounced = saved.filter((f) => typeof f === 'string' && fs.existsSync(path.join(unfiledDir, path.basename(f))));
  } catch {
    /* nothing waiting */
  }
  const rememberUnannounced = () => {
    try {
      if (unannounced.length) fs.writeFileSync(noticeFile, JSON.stringify(unannounced));
      else fs.rmSync(noticeFile, { force: true });
    } catch {
      /* the notice is a convenience; the photos themselves are already saved */
    }
  };

  /** Write a file from the camera into the Unfiled folder. Returns its file name, or null. */
  const writeUnfiled = (item) => {
    try {
      fs.mkdirSync(unfiledDir, { recursive: true });
      const stamp = new Date(item.takenAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
      const file = `${stamp}_${path.basename(String(item.name)).replace(/[\\/:*?"<>|]/g, '_')}`;
      fs.writeFileSync(path.join(unfiledDir, file), item.data);
      return file;
    } catch (e) {
      log(`could not save ${item.name} in ${unfiledDir}: ${e.message}`);
      return null;
    }
  };

  /** Never lose a photo: one that can't be handed to Lumen is kept on disk, and Lumen is told. */
  const saveUnfiled = (photo, why, except) => {
    const file = writeUnfiled(photo);
    if (!file) return null;
    counters.unfiled++;
    unannounced.push(file);
    rememberUnannounced();
    log(`${why} — saved ${photo.name} to ${unfiledDir}`);
    announceUnfiled(pickClient({ visibleOnly: true, except }));
    return file;
  };

  const announceUnfiled = (ws) => {
    if (!ws || !unannounced.length) return;
    unannounced = unannounced.filter((f) => fs.existsSync(path.join(unfiledDir, f)));
    const n = unannounced.length;
    if (n) {
      send(ws, {
        type: 'notice',
        tone: 'warning',
        message: `${n} photo${n === 1 ? '' : 's'} from the camera ${n === 1 ? 'was' : 'were'} not filed in Lumen`,
        detail: `Saved in ${unfiledDir}. Add them to the patient with “Add photos from files”.`,
      });
    }
    unannounced = [];
    rememberUnannounced();
  };

  /* ───────── Lumen windows ───────── */

  /** The window to hand a photo to: one on screen before one that is hidden, then the one used most recently. */
  const pickClient = ({ visibleOnly = false, except } = {}) => {
    let best = null;
    let bestMeta = null;
    for (const [ws, meta] of clients) {
      if (ws === except || ws.readyState !== ws.OPEN) continue;
      if (visibleOnly && !meta.visible) continue;
      const better = !bestMeta || Number(meta.visible) - Number(bestMeta.visible) || meta.at - bestMeta.at || meta.id - bestMeta.id;
      if (better === true || better > 0) {
        best = ws;
        bestMeta = meta;
      }
    }
    return best;
  };

  const describeWindow = (ws) => {
    const meta = clients.get(ws);
    if (!meta || clients.size < 2) return '';
    return ` (window ${meta.id} of ${clients.size}, ${meta.focused ? 'in front' : meta.visible ? 'on screen' : 'in the background'})`;
  };

  const status = () => {
    const activeWs = pickClient();
    return {
      app: 'lumen-camera-link',
      version,
      protocol: PROTOCOL_VERSION,
      ...backend.info(),
      camera: backend.state,
      liveViewAllowed: liveView,
      clients: clients.size,
      activeClient: activeWs ? clients.get(activeWs).id : null,
      windows: [...clients.values()].map(({ id, visible, focused }) => ({ id, visible, focused })),
      photos: { ...counters, awaitingConfirmation: awaitingAck.size, unfiledNotAnnounced: unannounced.length },
      unfiledDir,
    };
  };

  /* ───────── HTTP: status, and Lumen itself ───────── */

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
      let target = file;
      if (err || !st.isFile()) {
        // Page addresses (/, /review) open the app. A missing file is missing: answering it with
        // index.html would leave whatever asked for it (a script, the text reader's data) waiting forever.
        if (path.extname(file)) {
          res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
          return;
        }
        target = path.join(root, 'index.html');
      }
      const ext = path.extname(target).toLowerCase();
      const hashed = HASHED_ASSET.test(path.relative(root, target).split(path.sep).join('/'));
      const stream = fs.createReadStream(target);
      stream.on('open', () => {
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          // Only files with a content hash in their name may be kept; everything else is checked each time,
          // so a new build (index.html, sw.js, icons, the text reader under /ocr/) is picked up.
          'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    const cam = backend.state ?? {};
    res.end(`<!doctype html><meta charset="utf-8"><title>Lumen Camera Link</title>
<body style="font:15px system-ui;background:#05080d;color:#eef3fb;display:grid;place-items:center;height:100vh;margin:0">
<div><h1 style="font-weight:650;letter-spacing:-.02em">Lumen Camera Link is running</h1>
<p>Camera: ${cam.state === 'connected' ? cam.model : cam.message ?? cam.state}</p>
<p style="color:#8e9cb2">Lumen itself is not being served from here${distDir ? ' because it has not been built: see the Camera Link window for the reason' : ''}.
Open Lumen and choose <b>Canon EOS via Camera Link</b> as the camera source.</p></div>`);
  };

  const onRequest = (req, res) => {
    try {
      handleRequest(req, res);
    } catch (e) {
      // No request may take the helper down.
      log(`request ${req.url}: ${e?.message ?? e}`);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    }
  };

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    verifyClient: ({ origin }, done) => {
      // Only Lumen on this computer (or an address you allow explicitly) may use the camera.
      const ok = !origin || isLocalOrigin(origin) || allowOrigins.includes(origin);
      if (!ok) log(`refused connection from ${origin}`);
      done(ok, 403, 'Origin not allowed');
    },
  });
  const onUpgrade = (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      /* not a path we serve */
    }
    if (pathname !== '/camera') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg) => {
    for (const ws of clients.keys()) send(ws, msg);
  };
  const updateLiveView = () => backend.setLiveView(liveView && wantLiveView.size > 0);

  /* ───────── photos ───────── */

  const deliver = (photo, ws) => {
    const meta = clients.get(ws);
    const photoId = `p${nextPhotoId++}`;
    const header = Buffer.from(
      JSON.stringify({ photoId, requestId: photo.requestId, name: photo.name, size: photo.data.length, takenAt: photo.takenAt, exposure: photo.exposure }),
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length, 0);
    let done = false;
    // Only this window is tried: offering the photo to another one as well could file it twice.
    const fail = (why) => {
      if (done) return;
      done = true;
      clearTimeout(awaitingAck.get(photoId)?.timer);
      awaitingAck.delete(photoId);
      const file = saveUnfiled(photo, why, ws);
      gaveUp.set(photoId, { name: photo.name, file });
      if (gaveUp.size > 50) gaveUp.delete(gaveUp.keys().next().value);
    };
    // Windows from before photos were confirmed (an old Lumen left open) are trusted as they always were.
    if (meta?.acks) {
      const timer = setTimeout(() => fail(`Lumen did not confirm ${photo.name} within ${Math.round(ackTimeoutMs / 100) / 10} s`), ackTimeoutMs);
      awaitingAck.set(photoId, { photo, ws, timer, fail, settle: () => (done = true) });
    }
    ws.send(Buffer.concat([Buffer.from([2]), len, header, photo.data]), { binary: true }, (err) => {
      if (err) fail(`sending ${photo.name} to Lumen failed (${err.message})`);
    });
    counters.sent++;
    log(`sent ${photo.name} to Lumen${describeWindow(ws)}`);
  };

  /** The window that asked for a capture, if it is still there. `done` once its photo has been handed over. */
  const ownerOf = (requestId, done = false) => {
    if (requestId == null) return null;
    const owner = captureOwners.get(requestId)?.ws;
    if (done) captureOwners.delete(requestId);
    return owner && owner.readyState === owner.OPEN ? owner : null;
  };

  /** IMG_0001 for IMG_0001.JPG and IMG_0001.CR2: the two files of one shot share it. */
  const shotName = (name) => String(name).replace(/\.[^.]*$/, '').toUpperCase();

  // The camera's own button was pressed and a photo is on its way. Tell the window that will get it,
  // and remember which one that was, so the photo follows even if another window comes forward meanwhile.
  backend.on('incoming', ({ name }) => {
    const now = Date.now();
    for (const [key, told] of announcedTo) if (now - told.at > 2 * 60_000) announcedTo.delete(key);
    const ws = pickClient();
    if (!ws) return;
    announcedTo.set(shotName(name), { ws, at: now });
    send(ws, { type: 'incoming', name });
  });

  const toldAbout = (photo) => {
    if (photo.requestId != null) return null;
    const key = shotName(photo.name);
    const ws = announcedTo.get(key)?.ws;
    announcedTo.delete(key);
    return ws && ws.readyState === ws.OPEN ? ws : null;
  };

  backend.on('photo', (photo) => {
    const target = ownerOf(photo.requestId, true) ?? toldAbout(photo) ?? pickClient();
    if (target) deliver(photo, target);
    else saveUnfiled(photo, 'Lumen is not open');
  });

  // Saving to the computer only, a RAW file has no copy on the memory card: keep it beside the unfiled photos.
  let rawKeptAt = 0;
  backend.on('raw', (raw) => {
    if (!writeUnfiled(raw)) return;
    rawKeptAt = Date.now();
    log(`kept ${raw.name} in ${unfiledDir} (RAW files are not shown in Lumen)`);
  });

  backend.on('camera', (s) => broadcast({ type: 'camera', ...s }));
  backend.on('props', (props) => broadcast({ type: 'props', props }));
  backend.on('liveview', (s) => broadcast({ type: 'liveview', ...s }));
  backend.on('notice', (n) => {
    const keptRaw = n.code === 'raw-only' && Date.now() - rawKeptAt < 15_000;
    broadcast({ type: 'notice', ...n, ...(keptRaw ? { detail: `The RAW file was saved in ${unfiledDir}.` } : {}) });
  });
  backend.on('capture-failed', (f) => {
    // The window that pressed the shutter is the one to tell; if it has gone, tell them all.
    // It stays the owner: a photo that turns up late is still its photo, and it kept the labels for it.
    const owner = ownerOf(f.requestId);
    const msg = { type: 'capture-failed', ...f };
    if (owner) send(owner, msg);
    else broadcast(msg);
  });

  backend.on('frame', (jpeg) => {
    const packet = Buffer.concat([Buffer.from([1]), jpeg]);
    for (const ws of wantLiveView) {
      // Drop frames rather than queue them if the browser falls behind.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1.5 * 1024 * 1024) ws.send(packet, { binary: true });
    }
  });

  /* ───────── the conversation with each window ───────── */

  wss.on('connection', (ws) => {
    // A new window counts as being looked at only once it says so.
    const meta = { id: nextClientId++, visible: false, focused: false, at: 0, acks: false };
    clients.set(ws, meta);
    if (clients.size > 1) {
      log(`warning: Lumen is open in ${clients.size} windows. Photos taken with the camera’s own button go to the one used most recently.`);
    }
    send(ws, { type: 'hello', ...status() });
    send(ws, { type: 'camera', ...backend.state });
    if (backend.props && Object.keys(backend.props).length) send(ws, { type: 'props', props: backend.props });

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
      const reply = (ok, extra = {}) => send(ws, { type: 'result', id, ok, ...extra });
      try {
        switch (msg.type) {
          case 'active': {
            // Older Lumen builds send a bare "active" when their window gains focus.
            const visible = msg.visible === undefined ? true : !!msg.visible;
            meta.visible = visible;
            meta.focused = msg.focused === undefined ? visible : !!msg.focused;
            if (Number.isFinite(msg.at) && msg.at > 0) meta.at = Math.min(msg.at, Date.now());
            else if (msg.at === undefined && visible) meta.at = Date.now();
            if (msg.acks === true) meta.acks = true;
            if (visible) announceUnfiled(ws);
            break;
          }
          case 'photo-ack': {
            const waiting = awaitingAck.get(msg.photoId);
            if (waiting && waiting.ws === ws) {
              clearTimeout(waiting.timer);
              waiting.settle();
              awaitingAck.delete(msg.photoId);
              counters.confirmed++;
              log(`${waiting.photo.name} received by Lumen`);
            } else if (gaveUp.has(msg.photoId)) {
              // It did arrive, just late. The copy in Unfiled stays (never delete a photo); it only goes unmentioned.
              const late = gaveUp.get(msg.photoId);
              gaveUp.delete(msg.photoId);
              unannounced = unannounced.filter((f) => f !== late.file);
              rememberUnannounced();
              log(`${late.name} was received by Lumen after all; the copy in ${unfiledDir} is a spare`);
            }
            break;
          }
          case 'liveview':
            if (msg.on && !liveView) {
              wantLiveView.delete(ws);
              send(ws, { type: 'liveview', on: false, error: NO_LIVE_VIEW_MESSAGE });
              reply(true);
              break;
            }
            if (msg.on) wantLiveView.add(ws);
            else wantLiveView.delete(ws);
            updateLiveView();
            reply(true);
            break;
          case 'capture': {
            const captureId = msg.captureId ?? msg.id;
            if (captureId != null) {
              for (const [key, owner] of captureOwners) if (Date.now() - owner.at > 5 * 60_000) captureOwners.delete(key);
              captureOwners.set(captureId, { ws, at: Date.now() });
            }
            try {
              await backend.capture(captureId);
            } catch (e) {
              captureOwners.delete(captureId);
              throw e;
            }
            reply(true);
            break;
          }
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
          case 'sim-button':
            // For trying things out and for tests: press the pretend camera's own shutter button.
            if (backend.name !== 'simulator' || typeof backend.pressButton !== 'function') {
              reply(false, { error: 'Only the simulated camera’s button can be pressed from here.' });
              break;
            }
            // delay: how long the pretend camera takes to hand the photo over (default about a third of a second).
            backend.pressButton(Number.isFinite(msg.delay) ? Math.max(0, Math.min(5000, msg.delay)) : undefined);
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
      for (const waiting of [...awaitingAck.values()]) {
        if (waiting.ws === ws) waiting.fail(`Lumen closed before confirming ${waiting.photo.name}`);
      }
      updateLiveView();
    });
  });

  /* ───────── listening ───────── */

  const servers = [];
  const makeServer = () => {
    const s = http.createServer(onRequest);
    s.on('upgrade', onUpgrade);
    return s;
  };
  const server = makeServer();

  const close = () =>
    new Promise((resolve) => {
      // A photo still waiting for its confirmation must not vanish with the helper.
      for (const waiting of [...awaitingAck.values()]) waiting.fail(`Camera Link stopped before Lumen confirmed ${waiting.photo.name}`);
      // ws doesn't close open connections for us; do it so the process can exit.
      for (const c of wss.clients) c.terminate();
      wss.close();
      let left = servers.length;
      if (!left) resolve();
      for (const s of servers) {
        s.closeAllConnections?.();
        s.close(() => --left || resolve());
      }
    });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      server.on('error', (e) => log(`server: ${e?.message ?? e}`));
      servers.push(server);
      const actualPort = server.address().port;
      const ready = () => resolve({ server, wss, close, unfiledDir, port: actualPort });
      if (host !== '127.0.0.1') {
        ready();
        return;
      }
      // Browsers may try "localhost" as ::1 (IPv6) first. Answer there too where the computer has it;
      // where it doesn't, or the port is taken there, IPv4 alone works as before.
      const v6 = makeServer();
      v6.once('error', ready);
      v6.listen({ port: actualPort, host: '::1', ipv6Only: true }, () => {
        v6.off('error', ready);
        v6.on('error', (e) => log(`server (::1): ${e?.message ?? e}`));
        servers.push(v6);
        ready();
      });
    });
  });
}
