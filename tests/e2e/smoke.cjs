/**
 * End-to-end smoke test: imports the sample list, captures photos from
 * Chromium's fake camera, checks they are archived, then simulates a Canon
 * EOS Utility shot landing in the tethered folder.
 *
 *   npm run build && npm run start      # in one terminal
 *   node tests/e2e/smoke.cjs            # in another (needs Playwright + Chromium)
 *
 * Options (environment variables):
 *   URL=http://localhost:4173/   app address
 *   FAKE_VIDEO=/path/eye.mjpeg   use a video file as the camera instead of Chrome's test pattern
 *   SHOTS=./shots                save screenshots of each step
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS;

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ✓ ' + msg);
}

(async () => {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (process.env.FAKE_VIDEO) args.push(`--use-file-for-fake-video-capture=${process.env.FAKE_VIDEO}`);
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['camera'] });
  // The OS folder picker can't be automated, so hand back folders from the browser's private file system.
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async (opts) => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(opts?.id === 'lumen-tether' ? 'EOS_Tether' : 'Archive', { create: true });
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  };

  console.log('Import');
  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');
  await page.click('text=Try it with a sample list');
  await page.waitForSelector('.map-table');
  await shot('import');
  await page.click('button:has-text("Import 12 patients")');
  await page.waitForSelector('.prow');
  assert((await page.locator('.prow').count()) === 12, '12 patients on the list');

  console.log('Archive folder');
  await page.click('button[aria-label="Settings"]');
  await page.click('.settings-body button:has-text("Choose folder")');
  await page.waitForSelector('.settings-body button:has-text("Change folder")');
  await page.keyboard.press('Escape');
  assert(await page.locator('.pill-ok').isVisible(), 'archive connected');

  console.log('Live capture');
  await page.click('.prow >> nth=0');
  await page.waitForSelector('.feed-video.is-live', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
  await page.keyboard.press('Space');
  await page.waitForSelector('.film-tile');
  await page.keyboard.press('l');
  await page.keyboard.press('2');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelectorAll('.film-tile').length === 2, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  await shot('capture');
  const files = await page.evaluate(async () => {
    const out = [];
    const walk = async (d, p) => {
      for await (const [n, e] of d.entries()) e.kind === 'directory' ? await walk(e, p + n + '/') : out.push(p + n);
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive'), '');
    return out;
  });
  assert(files.filter((f) => f.endsWith('.webp')).length === 2, 'two WebP files in the archive');
  assert(files.some((f) => f.endsWith('_OS_slit.webp')), 'file name carries eye and technique');
  assert(files.some((f) => f.endsWith('visit.json')), 'visit.json written');

  console.log('Review');
  await page.keyboard.press('v');
  await page.waitForSelector('.review .tile');
  assert((await page.locator('.review .tile').count()) === 2, 'review shows both photos');
  await shot('review');
  await page.click('.tile >> nth=0');
  await page.waitForSelector('.viewer .zoom-pane img');
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');

  console.log('Canon tethered folder');
  await page.click('.prow >> nth=1');
  await page.click('.source-chip');
  await page.click('.source-card:has-text("Choose the EOS Utility folder")');
  await page.waitForSelector('.tether-wait');
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(1200, 800);
    const x = c.getContext('2d');
    x.fillStyle = '#345';
    x.fillRect(0, 0, 1200, 800);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('EOS_Tether');
    const w = await (await dir.getFileHandle('IMG_0001.JPG', { create: true })).createWritable();
    await w.write(blob);
    await w.close();
  });
  await page.waitForSelector('.feed-still', { timeout: 10000 });
  assert((await page.locator('.film-tile').count()) === 1, 'tethered photo filed to the selected patient');
  await shot('tether');

  assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('All good.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
