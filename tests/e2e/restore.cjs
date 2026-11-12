/**
 * End-to-end test of backup and restore: take labelled, annotated photographs
 * with an archive folder connected, wipe the browser's database (a new
 * computer, or cleared browser data), connect the same folder again and
 * restore everything from it.
 *
 *   npm run build && npm run start      # in one terminal
 *   node tests/e2e/restore.cjs          # in another (needs Playwright + Chromium)
 *
 * Options (environment variables): URL, FAKE_VIDEO, SHOTS (see smoke.cjs).
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera'], locale: 'en-GB' });
  // The OS folder picker can't be automated, so hand back a folder from the browser's private file system.
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
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
  const films = (n) => page.waitForFunction((k) => document.querySelectorAll('.film-tile').length === k, n, { timeout: 15000 });
  const folder = () =>
    page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
      const out = {};
      const walk = async (d, p) => {
        for await (const [n, e] of d.entries()) {
          if (e.kind === 'directory') await walk(e, p + n + '/');
          else {
            const f = await e.getFile();
            out[p + n] = /\.json$/.test(n) && !p.startsWith('_Lumen/') ? await f.text() : f.size;
          }
        }
      };
      await walk(root, '');
      return out;
    });
  const connectFolder = async () => {
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-body button:has-text("Choose folder")');
    await page.waitForSelector('.settings-body button:has-text("Change folder")');
  };

  console.log('Before: a clinic with photographs');
  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');
  await page.click('text=Try it with a sample list');
  await page.waitForSelector('.map-table');
  await page.click('button:has-text("Import 12 patients")');
  await page.waitForSelector('.prow');
  await connectFolder();
  await page.fill('.settings-body input >> nth=0', 'Cornea Clinic');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');

  await page.click('.prow >> nth=0');
  await page.waitForSelector('.feed-video.is-live', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
  await page.keyboard.press('d');
  await page.keyboard.type('kc');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('2');
  await page.keyboard.press('Space');
  await films(1);
  await page.keyboard.press('l');
  await page.keyboard.press('Space');
  await films(2);
  // Mark, star and annotate the first one.
  await page.click('.film-tile >> nth=0 >> .film-open');
  await page.waitForSelector('.viewer .zoom-content img');
  await page.keyboard.press('s');
  await page.fill('.viewer-info textarea', 'Vogt striae');
  await page.keyboard.press('Escape'); // leaves the note field, saving it
  await page.keyboard.press('a');
  await page.waitForSelector('.anno-bar');
  const box = await page.locator('.zoom-content').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.65, { steps: 6 });
  await page.mouse.up();
  await page.click('.anno-done');
  await page.keyboard.press('Escape');

  await page.click('.prow >> nth=2');
  await page.waitForFunction(() => document.querySelectorAll('.film-tile').length === 0);
  await page.keyboard.press('6');
  await page.keyboard.press('Space');
  await films(1);
  await page.waitForTimeout(8000); // the marked copy, then the index, are written a few seconds after the last change
  const before = await folder();
  const photos = Object.keys(before).filter((f) => /\.webp$/.test(f) && !f.includes('_annotated'));
  const index = Object.keys(before).filter((f) => f.startsWith('_Lumen/backup-'));
  assert(photos.length === 3, 'three photographs are in the archive folder');
  assert(Object.keys(before).some((f) => f.includes('_annotated')), 'with a copy of the annotated one');
  assert(index.length === 1 && Object.keys(before).includes('_Lumen/README.txt'), 'and Lumen’s index of patients, visits and settings beside them');
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('.set-group:has-text("Backup and restore")');
  assert(/Index written at \d\d:\d\d/.test(await page.locator('.set-group:has-text("Backup and restore")').innerText()), 'Settings shows when the index was written');
  await page.locator('.set-group:has-text("Backup and restore")').scrollIntoViewIfNeeded();
  await shot('backup-settings');
  await page.keyboard.press('Escape');

  console.log('The browser’s data is lost');
  await page.goto(URL + 'manifest.webmanifest'); // the same site, without the app running
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('lumen');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('the database is still open'));
      }),
  );
  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');
  assert((await page.locator('.prow').count()) === 0, 'Lumen starts empty: no patients, no photographs');

  console.log('Restore from the folder');
  await connectFolder();
  await page.waitForSelector('.toast:has-text("This folder already holds Lumen photographs")');
  assert(true, 'connecting the folder offers to restore');
  await page.keyboard.press('Escape');
  await page.click('.toast button:has-text("Restore…")');
  await page.waitForSelector('.restore-found');
  const found = await page.locator('.restore-found').innerText();
  assert(/3 photos are in the folder and not in Lumen/.test(found) && /3 photos of 2 patients over 2 visits/.test(found), 'it says what it found: 3 photos of 2 patients over 2 visits');
  await page.locator('.restore').scrollIntoViewIfNeeded();
  await shot('restore-found');
  await page.click('.restore-found button:has-text("Restore 3 photos")');
  await page.waitForSelector('.restore-found:has-text("Done.")', { timeout: 60000 });
  assert(/3 photos restored/.test(await page.locator('.restore-found').innerText()), 'three photos are restored');
  await shot('restore-done');
  assert((await page.locator('.settings-body input >> nth=0').inputValue()) === 'Cornea Clinic', 'the clinic name came back with the settings');
  await page.keyboard.press('Escape');

  console.log('After: everything is back');
  await page.waitForSelector('.prow');
  assert((await page.locator('.prow').count()) === 12, 'the day’s list of 12 patients is back');
  assert((await page.locator('.prow >> nth=0 >> .prow-status').innerText()).trim() === '2', 'with the first patient’s two photographs counted');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.lib-group');
  assert((await page.locator('.lib-group').count()) === 2 && (await page.locator('.lib-group .tile').count()) === 3, 'the Library shows 3 photos of 2 patients');
  await page.fill('#library-search', 'kerato');
  await page.waitForTimeout(150);
  assert((await page.locator('.lib-group .tile').count()) === 2, 'they can be found by diagnosis');
  await page.click('.filter-toggle:has-text("Annotated")');
  await page.waitForTimeout(150);
  assert((await page.locator('.lib-group .tile').count()) === 1, 'the annotated one is still annotated');
  await page.click('.lib-group .tile >> nth=0');
  await page.waitForSelector('.viewer .anno-layer ellipse');
  assert(true, 'its circle is drawn over the photograph');
  assert((await page.locator('.viewer-info textarea').inputValue()) === 'Vogt striae', 'its note is back');
  assert((await page.locator('.viewer-actions button[aria-label="Star (S)"]').getAttribute('class')).includes('is-active'), 'and its star');
  assert((await page.locator('.viewer-title strong').innerText()).includes('FITZGERALD'), 'under the right patient');
  const size = await page.evaluate(() => {
    const img = document.querySelector('.viewer .zoom-content img');
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  assert(size.w > 600 && size.h > 400, `the photograph itself opens at full size (${size.w} × ${size.h})`);
  await shot('restored-viewer');
  await page.keyboard.press('Escape');

  await page.waitForTimeout(2500);
  const after = await folder();
  const same = Object.keys(before)
    .filter((f) => !f.startsWith('_Lumen/'))
    .every((f) => JSON.stringify(after[f]) === JSON.stringify(before[f]));
  assert(same && Object.keys(after).filter((f) => !f.startsWith('_Lumen/')).length === Object.keys(before).filter((f) => !f.startsWith('_Lumen/')).length, 'nothing in the patients’ folders was changed by restoring');

  // A new photograph for a restored patient carries on in the same folder.
  await page.click('.topbar-views .segmented-item:has-text("Capture")');
  await page.click('.prow >> nth=0');
  await films(2);
  await page.keyboard.press('Space');
  await films(3);
  await page.waitForTimeout(800);
  const later = Object.keys(await folder()).filter((f) => f.startsWith('FITZGERALD_Eleanor_H100234/') && /\.webp$/.test(f) && !f.includes('_annotated'));
  assert(later.length === 3, 'a new photo of a restored patient goes into the folder their history is in');

  assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('All good.');
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
