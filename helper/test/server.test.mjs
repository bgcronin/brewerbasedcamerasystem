// The local server must survive anything a browser (or a stray program) sends it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { SimulatorBackend } from '../src/simulator.js';

const get = (port, reqPath) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
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
