// The local server must survive anything a browser (or a stray program) sends it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { SimulatorBackend } from '../src/simulator.js';
import { withoutQuickEdit } from '../src/win-console.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A running helper with the pretend camera connected, and everything it logged. */
async function startHelper(opts = {}) {
  const tmp = opts.tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-server-'));
  const unfiledDir = path.join(tmp, 'unfiled');
  const lines = [];
  const backend = opts.backend ?? new SimulatorBackend();
  const srv = await createServer({ backend, port: 0, version: 'test', unfiledDir, log: (m) => lines.push(m), ...opts.server });
  const connected = backend.state.state === 'connected' || new Promise((r) => backend.on('camera', (s) => s.state === 'connected' && r()));
  backend.start();
  await connected;
  const { port } = srv.server.address();
  return {
    backend,
    port,
    lines,
    tmp,
    unfiledDir,
    /** Photos saved in Unfiled (not the helper's own note beside them). */
    unfiled: () => (fs.existsSync(unfiledDir) ? fs.readdirSync(unfiledDir).filter((f) => !f.startsWith('.')) : []),
    status: async () => JSON.parse((await get(port, '/status')).body),
    stop: async ({ keep = false } = {}) => {
      backend.stop();
      await srv.close();
      if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** A stand-in for one Lumen window. It confirms photos unless told not to. */
async function openWindow(port, { report, confirm = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/camera`);
  const win = { ws, photos: [], notices: [], texts: [], say: (msg) => ws.send(JSON.stringify(msg)) };
  ws.on('message', (raw, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(String(raw));
      win.texts.push(msg);
      if (msg.type === 'notice') win.notices.push(msg);
      return;
    }
    if (raw[0] !== 2) return;
    const headerLength = raw.readUInt32BE(1);
    const header = JSON.parse(raw.subarray(5, 5 + headerLength).toString());
    win.photos.push({ ...header, bytes: raw.length - 5 - headerLength });
    if (confirm) win.say({ type: 'photo-ack', photoId: header.photoId });
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  if (report) win.say({ type: 'active', acks: true, ...report });
  await sleep(30);
  return win;
}

const until = async (what, cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
};

const get = (port, reqPath) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on('error', reject);
  });

test('bad paths and bad messages get an error reply, not a dead process', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-server-'));
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Lumen</title>');
  fs.mkdirSync(path.join(tmp, 'dist-sibling'));
  fs.writeFileSync(path.join(tmp, 'dist-sibling', 'secret.txt'), 'secret');

  const srv = await createServer({ backend: new SimulatorBackend(), port: 0, distDir, version: 'test', unfiledDir: path.join(tmp, 'unfiled'), log: () => {} });
  const { port } = srv.server.address();
  try {
    assert.equal((await get(port, '/%E0%A4%A')).status, 400, 'malformed percent-encoding');
    assert.equal((await get(port, '/status')).status, 200, 'still answers afterwards');
    assert.equal((await get(port, '/%00')).status, 400, 'NUL byte');
    assert.equal((await get(port, '/%2e%2e%2Fdist-sibling/secret.txt')).status, 403, 'encoded ../ to a sibling of dist');
    assert.equal((await get(port, '/..%2Fdist-sibling/secret.txt')).status, 403);
    const index = await get(port, '/index.html');
    assert.equal(index.status, 200);
    assert.match(index.body, /Lumen/);
    assert.equal((await get(port, '/some/route')).status, 200, 'unknown routes fall back to index.html');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/camera`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const results = [];
    const pong = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no reply to the ping')), 5000);
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type !== 'result') return;
        results.push(m);
        if (m.id === 'ping') {
          clearTimeout(t);
          resolve();
        }
      });
    });
    for (const bad of ['null', '42', '"text"', '[]', '{}', '{"type":5}', 'not json']) ws.send(bad);
    ws.send(JSON.stringify({ type: 'nope', id: 'u' }));
    ws.send(JSON.stringify({ type: 'liveview', on: false, id: 'ping' }));
    await pong;
    assert.deepEqual(
      results.map((r) => [r.id, r.ok]),
      [
        ['u', false],
        ['ping', true],
      ],
    );
    const status = await get(port, '/status');
    assert.equal(JSON.parse(status.body).app, 'lumen-camera-link');
    ws.close();
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Lumen’s files are served with the right type, cached only when their name says they never change', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-server-'));
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(distDir, 'ocr'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Lumen</title>');
  fs.writeFileSync(path.join(distDir, 'sw.js'), '// sw');
  fs.writeFileSync(path.join(distDir, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(distDir, 'icon.svg'), '<svg/>');
  fs.writeFileSync(path.join(distDir, 'assets', 'pdf.worker.min-CIqJB0yW.mjs'), 'export {};');
  fs.writeFileSync(path.join(distDir, 'assets', 'index-CB-cLnDA.js'), 'export {};');
  fs.writeFileSync(path.join(distDir, 'assets', 'geist-latin-wght-normal-BgDaEnEv.woff2'), 'font');
  fs.writeFileSync(path.join(distDir, 'ocr', 'tesseract-core-lstm.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  fs.writeFileSync(path.join(distDir, 'ocr', 'tesseract-core-lstm.wasm.js'), '// glue');
  fs.writeFileSync(path.join(distDir, 'ocr', 'worker.min.js'), '// worker');
  fs.writeFileSync(path.join(distDir, 'ocr', 'eng.traineddata.gz'), Buffer.from([0x1f, 0x8b, 8, 0]));
  const srv = await createServer({ backend: new SimulatorBackend(), port: 0, distDir, version: 'test', unfiledDir: path.join(tmp, 'unfiled'), log: () => {} });
  const { port } = srv.server.address();
  const IMMUTABLE = /immutable/;
  try {
    const mjs = await get(port, '/assets/pdf.worker.min-CIqJB0yW.mjs');
    assert.equal(mjs.status, 200);
    assert.match(mjs.headers['content-type'], /^text\/javascript/, 'a .mjs worker is a script');
    assert.match(mjs.headers['cache-control'], IMMUTABLE);
    const wasm = await get(port, '/ocr/tesseract-core-lstm.wasm');
    assert.equal(wasm.headers['content-type'], 'application/wasm');
    assert.equal(wasm.headers['cache-control'], 'no-cache', 'the text reader has no hash in its names');
    const gz = await get(port, '/ocr/eng.traineddata.gz');
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-type'], 'application/gzip');
    assert.equal(gz.headers['content-encoding'], undefined, 'sent as the bytes it is');
    assert.equal(gz.headers['cache-control'], 'no-cache');
    assert.match((await get(port, '/assets/index-CB-cLnDA.js')).headers['cache-control'], IMMUTABLE);
    assert.match((await get(port, '/assets/geist-latin-wght-normal-BgDaEnEv.woff2')).headers['cache-control'], IMMUTABLE);
    assert.equal((await get(port, '/assets/geist-latin-wght-normal-BgDaEnEv.woff2')).headers['content-type'], 'font/woff2');
    for (const p of ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/ocr/worker.min.js', '/ocr/tesseract-core-lstm.wasm.js']) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['cache-control'], 'no-cache', `${p} is checked for a newer copy every time`);
    }

    // A missing file is a 404, never the app's page in its place.
    for (const p of ['/ocr/missing.traineddata.gz', '/assets/gone-AAAAAAAA.js', '/assets/gone.mjs', '/ocr/tesseract-core-simd.wasm', '/favicon.ico']) {
      const r = await get(port, p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.body, /Lumen/);
    }
    for (const p of ['/review', '/some/route', '/assets/', '/ocr']) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.match(r.body, /Lumen/, `${p} opens the app`);
      assert.match(r.headers['content-type'], /^text\/html/);
    }
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the camera’s own button, one Lumen window: the photo arrives, is confirmed, and nothing goes to Unfiled', async () => {
  const h = await startHelper({ server: { ackTimeoutMs: 300 } });
  try {
    const win = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() } });
    win.say({ type: 'sim-button', id: 'b1' }); // no shot from Lumen came before it
    await until('the photo', () => win.photos.length === 1);
    const photo = win.photos[0];
    assert.equal(photo.requestId, undefined, 'nobody in Lumen asked for it');
    assert.match(photo.name, /^IMG_\d+\.JPG$/);
    assert.equal(photo.bytes, photo.size);
    assert.ok(photo.photoId, 'carries an id to confirm');
    assert.equal(photo.exposure.iso, '400');
    await until('the confirmation', () => h.lines.some((l) => /received by Lumen/.test(l)));
    await sleep(450); // well past the time allowed for confirming
    assert.deepEqual(h.unfiled(), []);
    assert.ok(h.lines.indexOf(`sent ${photo.name} to Lumen`) >= 0, 'one window: no window number in the log');
    assert.ok(win.texts.some((m) => m.type === 'result' && m.id === 'b1' && m.ok));
    const status = await h.status();
    assert.deepEqual(status.photos, { sent: 1, confirmed: 1, unfiled: 0, awaitingConfirmation: 0, unfiledNotAnnounced: 0 });
    assert.equal(status.clients, 1);
    assert.equal(status.activeClient, 1);
    assert.deepEqual(status.windows, [{ id: 1, visible: true, focused: true }]);
    win.ws.close();
  } finally {
    await h.stop();
  }
});

test('the camera’s own button with Lumen closed: saved to Unfiled, and a window that is looked at later hears of it once', async () => {
  const first = await startHelper();
  first.backend.pressButton();
  await until('the saved photo', () => first.unfiled().length === 1);
  assert.match(first.unfiled()[0], /^\d{4}-\d\d-\d\dT.*_IMG_\d+\.JPG$/);
  assert.ok(first.lines.some((l) => /Lumen is not open — saved IMG_/.test(l)));
  assert.equal((await first.status()).photos.unfiledNotAnnounced, 1);
  await first.stop({ keep: true });

  // Camera Link is restarted before anyone opens Lumen: the note about the photo is still there.
  const h = await startHelper({ tmp: first.tmp });
  try {
    const hidden = await openWindow(h.port, { report: { visible: false, focused: false, at: 0 } });
    assert.deepEqual(hidden.notices, [], 'a window nobody is looking at is not told');
    const seen = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() } });
    await until('the notice', () => seen.notices.length === 1);
    assert.match(seen.notices[0].message, /1 photo from the camera was not filed in Lumen/);
    assert.ok(seen.notices[0].detail.includes(h.unfiledDir));
    hidden.say({ type: 'active', visible: true, focused: true, at: Date.now(), acks: true });
    const third = await openWindow(h.port, { report: { visible: true, focused: false, at: Date.now() } });
    await sleep(100);
    assert.deepEqual([hidden.notices.length, seen.notices.length, third.notices.length], [0, 1, 0], 'told once');
    assert.equal(h.unfiled().length, 1, 'the photo itself stays where it is');
    assert.equal((await h.status()).photos.unfiledNotAnnounced, 0);
    for (const w of [hidden, seen, third]) w.ws.close();
  } finally {
    await h.stop();
  }
});

test('two Lumen windows: the camera’s button goes to the one used last, a shot from Lumen to the window that asked', async () => {
  const h = await startHelper();
  try {
    const now = Date.now();
    const a = await openWindow(h.port, { report: { visible: true, focused: true, at: now - 5000 } });
    // A second window opens in the background (a restored tab, say). It must not take the photos.
    const b = await openWindow(h.port, { report: { visible: false, focused: false, at: 0 } });
    assert.ok(h.lines.some((l) => /Lumen is open in 2 windows/.test(l)), 'says so once');
    assert.equal((await h.status()).activeClient, 1);

    b.say({ type: 'sim-button' });
    await until('photo 1', () => a.photos.length + b.photos.length === 1);
    assert.deepEqual([a.photos.length, b.photos.length], [1, 0], 'the window on screen gets it, not the newest connection');
    assert.ok(h.lines.some((l) => /sent IMG_\d+\.JPG to Lumen \(window 1 of 2, in front\)/.test(l)), 'the log says which window');

    // The user turns to the other window.
    a.say({ type: 'active', visible: true, focused: false, at: now - 5000, acks: true });
    b.say({ type: 'active', visible: true, focused: true, at: now, acks: true });
    await sleep(30);
    assert.equal((await h.status()).activeClient, 2);
    a.say({ type: 'sim-button' });
    await until('photo 2', () => a.photos.length + b.photos.length === 2);
    assert.deepEqual([a.photos.length, b.photos.length], [1, 1]);

    // A shot asked for by window A comes back to A, although B was used more recently.
    a.say({ type: 'capture', id: 'r1', captureId: 'cap-A' });
    await until('photo 3', () => a.photos.length + b.photos.length === 3);
    assert.equal(a.photos.length, 2);
    assert.equal(a.photos[1].requestId, 'cap-A');

    // A window that has gone to the background loses to one still on screen, however recently it was used.
    b.say({ type: 'active', visible: false, focused: false, at: Date.now(), acks: true });
    await sleep(30);
    b.say({ type: 'sim-button' });
    await until('photo 4', () => a.photos.length + b.photos.length === 4);
    assert.equal(a.photos.length, 3);

    await until('all confirmed', () => h.lines.filter((l) => /received by Lumen/.test(l)).length === 4);
    assert.deepEqual(h.unfiled(), []);
    for (const w of [a, b]) w.ws.close();
  } finally {
    await h.stop();
  }
});

test('a camera-button photo is announced to one window, and follows there even if another comes forward', async () => {
  const h = await startHelper();
  try {
    const a = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() - 2000 } });
    const b = await openWindow(h.port, { report: { visible: true, focused: false, at: Date.now() - 9000 } });
    b.say({ type: 'sim-button', delay: 400 });
    await until('the announcement', () => a.texts.some((m) => m.type === 'incoming'));
    const told = a.texts.find((m) => m.type === 'incoming');
    assert.match(told.name, /^IMG_\d+\.JPG$/);
    assert.equal(a.photos.length, 0, 'told before the file is there');
    assert.ok(!b.texts.some((m) => m.type === 'incoming'), 'only the window that will get the photo is told');
    // The other window comes to the front while the file is on its way.
    b.say({ type: 'active', visible: true, focused: true, at: Date.now(), acks: true });
    await until('the photo', () => a.photos.length + b.photos.length === 1);
    assert.equal(a.photos.length, 1, 'the photo goes where its labels were noted');
    assert.equal(a.photos[0].name, told.name);
    for (const w of [a, b]) w.ws.close();
  } finally {
    await h.stop();
  }
});

test('a shot from Lumen whose window has closed goes to the window in use, not into the void', async () => {
  const h = await startHelper();
  try {
    const a = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() } });
    const b = await openWindow(h.port, { report: { visible: true, focused: false, at: Date.now() - 9000 } });
    b.say({ type: 'capture', id: 'r1', captureId: 'cap-B' });
    await until('the shutter', () => b.texts.some((m) => m.type === 'result' && m.id === 'r1'));
    b.ws.terminate(); // the simulated camera delivers 350 ms after the press
    await until('the photo', () => a.photos.length === 1);
    assert.equal(a.photos[0].requestId, 'cap-B');
    a.ws.close();
  } finally {
    await h.stop();
  }
});

test('a photo that arrives after its capture was reported as failed still goes to the window that asked', async () => {
  const h = await startHelper();
  try {
    const asked = await openWindow(h.port, { report: { visible: true, focused: false, at: Date.now() - 9000 } });
    const front = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() } });
    asked.say({ type: 'capture', id: 'r1', captureId: 'cap-late' });
    await until('photo 1', () => asked.photos.length === 1);
    // What the camera side does when a photo is slow: first "failed", later the photo, under the same request.
    asked.say({ type: 'capture', id: 'r2', captureId: 'cap-slow' });
    await until('the shutter', () => asked.texts.some((m) => m.type === 'result' && m.id === 'r2'));
    h.backend.emit('capture-failed', { requestId: 'cap-slow', message: 'No photo arrived from the camera.' });
    await until('the failure', () => asked.texts.some((m) => m.type === 'capture-failed'));
    assert.ok(!front.texts.some((m) => m.type === 'capture-failed'), 'only the window that pressed the shutter is told');
    await until('photo 2', () => asked.photos.length === 2);
    assert.equal(asked.photos[1].requestId, 'cap-slow');
    assert.equal(front.photos.length, 0, 'the window in front has no labels for it, so it must not get it');
    for (const w of [asked, front]) w.ws.close();
  } finally {
    await h.stop();
  }
});

test('a photo Lumen does not confirm in time is saved to Unfiled, and offered to no other window', async () => {
  const h = await startHelper({ server: { ackTimeoutMs: 200 } });
  try {
    const deaf = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() }, confirm: false });
    const other = await openWindow(h.port, { report: { visible: true, focused: false, at: Date.now() - 9000 } });
    other.say({ type: 'sim-button' });
    await until('the photo', () => deaf.photos.length === 1);
    assert.deepEqual(h.unfiled(), [], 'not yet: Lumen still has time to confirm');
    await until('the saved copy', () => h.unfiled().length === 1);
    assert.ok(h.lines.some((l) => /Lumen did not confirm IMG_\d+\.JPG within 0\.2 s — saved/.test(l)));
    assert.equal(other.photos.length, 0, 'never sent to a second window: that could file it twice');
    await until('the notice', () => other.notices.length === 1);
    assert.equal(deaf.notices.length, 0, 'the window that went quiet is told when it is next looked at');

    // The confirmation turns up after all: say so, keep the spare copy, and don't nag about it.
    deaf.say({ type: 'photo-ack', photoId: deaf.photos[0].photoId });
    await until('the late confirmation', () => h.lines.some((l) => /received by Lumen after all/.test(l)));
    assert.equal(h.unfiled().length, 1);
    const status = await h.status();
    assert.equal(status.photos.unfiled, 1);
    assert.equal(status.photos.awaitingConfirmation, 0);
    for (const w of [deaf, other]) w.ws.close();
  } finally {
    await h.stop();
  }
});

test('a window that closes before confirming: the photo is saved to Unfiled at once', async () => {
  const h = await startHelper({ server: { ackTimeoutMs: 5000 } });
  try {
    const win = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() }, confirm: false });
    win.say({ type: 'sim-button' });
    await until('the photo', () => win.photos.length === 1);
    win.ws.terminate();
    await until('the saved copy', () => h.unfiled().length === 1, 2000);
    assert.ok(h.lines.some((l) => /Lumen closed before confirming IMG_/.test(l)));
    assert.equal((await h.status()).photos.unfiledNotAnnounced, 1);
  } finally {
    await h.stop();
  }
});

test('an older Lumen that never confirms photos is trusted as before', async () => {
  const h = await startHelper({ server: { ackTimeoutMs: 150 } });
  try {
    const old = await openWindow(h.port, { confirm: false });
    old.say({ type: 'active' }); // what earlier builds sent on focus
    await sleep(30);
    assert.deepEqual((await h.status()).windows, [{ id: 1, visible: true, focused: true }]);
    old.say({ type: 'sim-button' });
    await until('the photo', () => old.photos.length === 1);
    await sleep(400);
    assert.deepEqual(h.unfiled(), []);
    old.ws.close();
  } finally {
    await h.stop();
  }
});

test('--no-live-view: the helper never turns live view on, and says why', async () => {
  const h = await startHelper({ server: { liveView: false } });
  try {
    const win = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() } });
    win.say({ type: 'liveview', on: true, id: 'lv' });
    await until('the reply', () => win.texts.some((m) => m.type === 'result' && m.id === 'lv'));
    const answer = win.texts.find((m) => m.type === 'liveview');
    assert.equal(answer.on, false);
    assert.match(answer.error, /--no-live-view/);
    assert.equal(h.backend.liveView, false);
    assert.equal((await h.status()).liveViewAllowed, false);
    // Photos still work.
    win.say({ type: 'capture', id: 'c', captureId: 'cap-1' });
    await until('the photo', () => win.photos.length === 1);
    win.ws.close();
  } finally {
    await h.stop();
  }
});

test('only the simulated camera has a button that can be pressed over the link', async () => {
  class RealCamera extends EventEmitter {
    state = { state: 'connected', model: 'Canon EOS 60D' };
    props = {};
    name = 'edsdk';
    pressed = 0;
    info() {
      return { backend: 'edsdk' };
    }
    start() {}
    stop() {}
    setLiveView() {}
    pressButton() {
      this.pressed++;
    }
  }
  const backend = new RealCamera();
  const h = await startHelper({ backend });
  try {
    const win = await openWindow(h.port);
    win.say({ type: 'sim-button', id: 'x' });
    await until('the reply', () => win.texts.some((m) => m.type === 'result' && m.id === 'x'));
    assert.equal(win.texts.find((m) => m.id === 'x').ok, false);
    assert.equal(backend.pressed, 0);
    win.ws.close();
  } finally {
    await h.stop();
  }
});

test('a RAW file from a camera saving to the computer only is kept in Unfiled, without a notice', async () => {
  const h = await startHelper();
  try {
    const win = await openWindow(h.port, { report: { visible: true, focused: true, at: Date.now() } });
    h.backend.emit('raw', { name: 'IMG_0007.CR2', data: Buffer.from('raw bytes'), takenAt: Date.now() });
    assert.equal(h.unfiled().length, 1);
    assert.match(h.unfiled()[0], /_IMG_0007\.CR2$/);
    h.backend.emit('notice', { code: 'raw-only', message: 'RAW files can’t be shown in a browser.' });
    await until('the notice', () => win.notices.length === 1);
    assert.ok(win.notices[0].detail.includes(h.unfiledDir), 'the RAW-only notice says where the file went');
    assert.equal((await h.status()).photos.unfiledNotAnnounced, 0);
    win.ws.close();
  } finally {
    await h.stop();
  }
});

test('switching QuickEdit off keeps the rest of the console mode', () => {
  assert.equal(withoutQuickEdit(0x01f7), 0x01b7 | 0x0080);
  assert.equal(withoutQuickEdit(0x0007), 0x0087);
});
