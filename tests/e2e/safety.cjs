/**
 * End-to-end checks of two safety nets that need a real browser:
 *  - a deleted photo stays deleted if the window is reloaded inside the undo period;
 *  - a second Lumen window does not take photographs alongside the first.
 *
 *   npm run build && npm run start      # in one terminal
 *   node tests/e2e/safety.cjs           # in another (needs Playwright + Chromium)
 */
const { chromium } = require('playwright');

const URL = process.env.URL || 'http://localhost:4173/';

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ✓ ' + msg);
}

(async () => {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (process.env.FAKE_VIDEO) args.push(`--use-file-for-fake-video-capture=${process.env.FAKE_VIDEO}`);
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const films = (p, n) => p.waitForFunction((k) => document.querySelectorAll('.film-tile').length === k, n, { timeout: 15000 });

  console.log('Delete, then reload');
  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');
  await page.click('text=Try it with a sample list');
  await page.waitForSelector('.map-table');
  await page.click('button:has-text("Import 12 patients")');
  await page.waitForSelector('.prow');
  await page.click('.prow >> nth=0');
  await page.waitForSelector('.feed-video.is-live', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.press('Space');
    await films(page, i);
  }
  // Delete two of the three, then reload at once, well inside the undo period.
  await page.hover('.film-tile >> nth=0');
  await page.click('.film-tile >> nth=0 >> button[title="Delete"]');
  await films(page, 2);
  await page.hover('.film-tile >> nth=0');
  await page.click('.film-tile >> nth=0 >> button[title="Delete"]');
  await films(page, 1);
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForSelector('.app[data-ready]');
  await page.waitForSelector('.film-tile');
  await page.waitForTimeout(600);
  assert((await page.locator('.film-tile').count()) === 1, 'photos deleted just before a reload stay deleted');
  assert((await page.locator('.prow >> nth=0 >> .prow-status').innerText()).trim() === '1', 'the list shows one photo for that patient');

  console.log('Second window');
  const second = await ctx.newPage();
  await second.goto(URL);
  await second.waitForSelector('.other-window');
  assert((await second.locator('.other-window h1').innerText()) === 'Lumen is open in another window', 'a second window says Lumen is already open');
  assert((await second.locator('.app').count()) === 0, 'and offers nothing to photograph with');
  assert((await page.locator('.other-window').count()) === 0, 'the first window carries on');
  await second.click('button:has-text("Use this window")');
  await second.waitForSelector('.app[data-ready]');
  await page.waitForSelector('.other-window');
  assert(true, '“Use this window” moves the work to the second window, and the first steps aside');
  await second.waitForSelector('.prow');
  assert((await second.locator('.prow').count()) === 12, 'the second window has the same list');

  assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('All good.');
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
