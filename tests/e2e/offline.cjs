/**
 * Lumen must open, and read a printed list, with the server gone: the clinic
 * network may be down, or the helper not started yet. This starts its own
 * preview server, lets the service worker install, stops the server, and
 * checks the built app still starts and works from what the browser kept.
 *
 *   npm run build
 *   node tests/e2e/offline.cjs      # needs Playwright + Chromium
 *
 * Options (environment variables):
 *   PORT=4199   port for the temporary server
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = process.env.PORT || '4199';
const URL = `http://localhost:${PORT}/`;

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ✓ ' + msg);
}

async function serverUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  assert(fs.existsSync(path.join(ROOT, 'dist', 'sw.js')), 'the app is built (dist/sw.js exists)');
  const server = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', PORT, '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  const stopServer = () => new Promise((resolve) => (server.exitCode != null ? resolve() : (server.once('exit', resolve), server.kill())));
  let browser;
  try {
    assert(await serverUp(), `preview server answering on ${URL}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-offline-'));
    browser = await chromium.launch();
    const render = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
    await render.goto('file://' + path.join(ROOT, 'tests', 'fixtures', 'clinic-list.html'));
    await render.screenshot({ path: path.join(tmp, 'clinic-list.png'), fullPage: true });
    await render.close();

    const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const readPhoto = async () => {
      await page.click('button:has-text("Import list")');
      await page.waitForSelector('.dropzone');
      await page.locator('.import-choose input[type=file]').setInputFiles(path.join(tmp, 'clinic-list.png'));
      await page.waitForSelector('.map-table', { timeout: 120000 });
      const rows = await page.locator('.map-table tbody tr:not(.row-why)').count();
      await page.keyboard.press('Escape');
      await page.waitForSelector('.map-table', { state: 'detached' });
      return rows;
    };

    console.log('Online, first visit');
    await page.goto(URL);
    await page.waitForSelector('.app[data-ready]');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 });
    const caches1 = await page.evaluate(() => caches.keys());
    assert(caches1.some((k) => /^lumen-[a-z0-9]+$/.test(k)), 'the service worker installed and took control: ' + caches1.join(', '));
    assert((await readPhoto()) === 12, 'a photo of the list reads while online (12 rows)');
    const caches2 = await page.evaluate(() => caches.keys());
    assert(caches2.filter((k) => k.startsWith('lumen-ocr-')).length === 1, 'the text reader’s files are kept in one cache of their own');

    console.log('Server stopped');
    await stopServer();
    let down = false;
    try {
      await fetch(URL);
    } catch {
      down = true;
    }
    assert(down, 'the server is really gone');
    await page.reload();
    await page.waitForSelector('.app[data-ready]', { timeout: 20000 });
    assert(true, 'the app starts with no server');
    await page.click('text=Try it with a sample list');
    await page.waitForSelector('.map-table');
    await page.click('button:has-text("Import 12 patients")');
    await page.waitForSelector('.prow');
    assert((await page.locator('.prow').count()) === 12, 'a list imports offline');
    assert((await readPhoto()) === 12, 'and a photo of a list still reads, from the kept files');
    assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('All good.');
  } finally {
    await browser?.close();
    await stopServer();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
