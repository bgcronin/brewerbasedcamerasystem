/**
 * End-to-end test of the Canon "direct" source against Lumen Camera Link's simulated EOS 60D.
 * Starts the helper itself (which also serves the built app).
 *
 *   npm run build && node tests/e2e/canon.cjs        (needs Playwright + Chromium)
 *   SHOTS=./shots node tests/e2e/canon.cjs           save screenshots
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 47800);
const URL = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS;
const DSF = Number(process.env.DSF || 1);
const HELPER = path.join(__dirname, '..', '..', 'helper', 'src', 'main.js');

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ✓ ' + msg);
}

async function startHelper(extra = []) {
  const proc = spawn(process.execPath, [HELPER, '--simulate', '--port', String(PORT), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  proc.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/status`);
      if (r.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('helper did not start');
}

const stopHelper = (proc) => new Promise((r) => (proc.once('exit', r), proc.kill('SIGTERM')));

(async () => {
  let helper = await startHelper();
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: DSF })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/WebSocket connection/.test(m.text()) && errors.push(m.text()));
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  };
  const readout = () => page.locator('.exposure-readout').innerText();

  try {
    console.log('Connect');
    await page.goto(URL);
    await page.waitForSelector('.app[data-ready]');
    await page.click('text=Try it with a sample list');
    await page.click('button:has-text("Import 12 patients")');
    await page.click('.prow >> nth=0');
    await page.click('.source-chip');
    await page.click('.source-card:has-text("Canon EOS via Camera Link")');
    await page.waitForSelector('canvas.feed-video.is-live', { timeout: 10000 });
    assert(true, 'live view frames are drawn');
    await page.waitForSelector('.exposure-readout');
    let r = await readout();
    assert(/1\/125/.test(r) && /ISO 400/.test(r) && /f\/8/.test(r), `viewfinder readout shows the camera’s settings (${r.replace(/\n/g, ' ')})`);
    assert(await page.locator('.cam-grid select').count() === 4, 'camera panel shows ISO, shutter, aperture and white balance');

    console.log('Settings and presets');
    await page.keyboard.press('6');
    await page.selectOption('select[aria-label="ISO"]', '1600');
    await page.waitForFunction(() => /ISO 1600/.test(document.querySelector('.exposure-readout')?.textContent ?? ''));
    assert(true, 'changing ISO in Lumen changes it on the camera');
    await page.click('button.cam-preset:has-text("Save as Cobalt")');
    await page.waitForSelector('.cam-preset.is-saved');
    assert(true, 'cobalt preset saved');
    await page.keyboard.press('1');
    await page.selectOption('select[aria-label="ISO"]', '200');
    await page.selectOption('select[aria-label="Shutter"]', '1/60');
    await page.waitForFunction(() => /1\/60/.test(document.querySelector('.exposure-readout')?.textContent ?? ''));
    await page.click('button.cam-preset:has-text("Save as Diffuse")');
    await page.waitForSelector('.cam-preset.is-saved');
    await page.keyboard.press('6');
    await page.waitForFunction(() => {
      const t = document.querySelector('.exposure-readout')?.textContent ?? '';
      return /ISO 1600/.test(t) && /1\/125/.test(t);
    });
    assert(true, 'choosing Cobalt again dials its preset back in');
    assert(await page.locator('.tech .tech-preset').count() === 2, 'illuminations with presets are marked');
    await shot('canon-capture');

    console.log('Capture');
    await page.keyboard.press('Space');
    await page.waitForSelector('.film-tile', { timeout: 10000 });
    assert(true, 'photo from the camera is filed to the patient');
    await page.waitForTimeout(600);
    assert((await page.locator('.toast-error, .toast-warning').count()) === 0, 'capture is confirmed with no warnings');
    await page.click('.film-tile .film-open');
    await page.waitForSelector('.viewer .meta-list');
    const meta = await page.locator('.viewer .meta-list').innerText();
    assert(/ISO 1600/.test(meta) && /1\/125/.test(meta) && /f\/8/.test(meta), 'photo records the exposure it was taken with');
    assert(/direct/.test(meta), 'photo records the Canon as its source');
    await page.keyboard.press('Escape');

    await page.click('button[aria-label="Settings"]');
    await page.locator('.set-group:has-text("Canon camera presets")').scrollIntoViewIfNeeded();
    assert((await page.locator('.set-group:has-text("Canon camera presets") .set-row').count()) === 3, 'settings list both presets');
    await shot('canon-presets');
    await page.keyboard.press('Escape');

    console.log('Helper stops and restarts');
    await stopHelper(helper);
    await page.waitForSelector('text=Start Lumen Camera Link', { timeout: 10000 });
    assert(true, 'Lumen explains when Camera Link is not running');
    await shot('canon-offline');
    helper = await startHelper(['--sim-mode', 'Av']);
    await page.waitForSelector('canvas.feed-video.is-live', { timeout: 15000 });
    assert(true, 'reconnects automatically when it comes back');
    await page.waitForSelector('.cam-note:has-text("The dial is on Av")');
    assert(await page.locator('select[aria-label="Shutter"]').isDisabled(), 'shutter speed is locked when the dial is not on M');

    assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log('All good.');
  } finally {
    await browser.close();
    await stopHelper(helper);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
