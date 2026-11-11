/**
 * End-to-end test of labelling, searching and annotating:
 * labels a visit with a diagnosis, finds the photos again in the Library,
 * draws on one, and checks the archive folder holds the labels and an
 * "_annotated" copy beside the untouched original.
 *
 *   npm run build && npm run start      # in one terminal
 *   node tests/e2e/features.cjs         # in another (needs Playwright + Chromium)
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['camera'] });
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
  const films = (n) => page.waitForFunction((k) => document.querySelectorAll('.film-tile').length === k, n, { timeout: 15000 });
  const groups = () => page.locator('.lib-group').count();
  const search = async (text) => {
    await page.fill('#library-search', text);
    await page.waitForTimeout(120);
  };
  const archive = () =>
    page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
      const files = [];
      const manifests = {};
      const walk = async (d, p) => {
        for await (const [n, e] of d.entries()) {
          if (e.kind === 'directory') await walk(e, p + n + '/');
          else {
            files.push(p + n);
            if (n === 'visit.json') manifests[p] = JSON.parse(await (await e.getFile()).text());
          }
        }
      };
      await walk(root, '');
      return { files: files.sort(), manifests };
    });

  console.log('Set up');
  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');
  await page.click('text=Try it with a sample list');
  await page.waitForSelector('.map-table');
  await page.click('button:has-text("Import 12 patients")');
  await page.waitForSelector('.prow');
  await page.click('button[aria-label="Settings"]');
  await page.click('.settings-body button:has-text("Choose folder")');
  await page.waitForSelector('.settings-body button:has-text("Change folder")');
  await page.keyboard.press('Escape');
  assert(true, 'sample list imported and archive folder connected');

  console.log('Diagnosis labels');
  await page.click('.prow >> nth=0');
  await page.waitForSelector('.feed-video.is-live', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
  // Label first, then photograph: every photo carries the label.
  await page.keyboard.press('d');
  await page.keyboard.type('kc');
  await page.waitForSelector('.dx-option');
  assert((await page.locator('.dx-option >> nth=0').innerText()).trim() === 'Keratoconus', 'typing “kc” suggests Keratoconus');
  await shot('diagnosis-typing');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert((await page.locator('.inspector .dx-chip').count()) === 1, 'the label shows in the inspector');
  await page.keyboard.press('Space');
  await films(1);
  await page.keyboard.press('l');
  await page.keyboard.press('2');
  await page.keyboard.press('Space');
  await films(2);
  await shot('capture-labelled');

  // Photograph first, then label: the photos already taken today are labelled too.
  await page.click('.prow >> nth=1');
  await page.waitForFunction(() => document.querySelectorAll('.film-tile').length === 0);
  assert((await page.locator('.inspector .dx-chip').count()) === 0, 'the next patient starts with no label');
  await page.keyboard.press('Space');
  await films(1);
  await page.keyboard.press('Space');
  await films(2);
  await page.keyboard.press('d');
  await page.keyboard.type('pteryg');
  await page.keyboard.press('Enter');
  await page.keyboard.type('odd looking thing');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  let a = await archive();
  const second = Object.entries(a.manifests).find(([p]) => p.includes('H100877'))?.[1];
  assert(
    second && second.images.length === 2 && second.images.every((i) => i.diagnoses?.join('|') === 'Pterygium|Odd looking thing'),
    'labels added afterwards reach both photos in visit.json, including one typed by hand',
  );
  const first = Object.entries(a.manifests).find(([p]) => p.includes('H100234'))?.[1];
  assert(first && first.images.every((i) => i.diagnoses?.join('|') === 'Keratoconus'), 'the first patient’s photos are labelled Keratoconus in visit.json');

  // Coming back to a patient picks their label up again.
  await page.click('.prow >> nth=0');
  await films(2);
  assert((await page.locator('.inspector .dx-chip').innerText()).includes('Keratoconus'), 'returning to a patient restores today’s label');
  // Space typed into a text field must never fire the shutter.
  await page.keyboard.press('d');
  await page.keyboard.type('a b');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  assert((await page.locator('.film-tile').count()) === 2, 'typing a space in the diagnosis field does not take a photo');

  console.log('Library search');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.lib-group');
  assert(await page.evaluate(() => document.activeElement?.id === 'library-search'), 'Ctrl+K opens the Library with the cursor in the search box');
  assert((await groups()) === 2, 'both patients with photos are listed');
  await shot('library');
  await search('kerato');
  assert((await groups()) === 1 && (await page.locator('.lib-group .tile').count()) === 2, '“kerato” finds the two keratoconus photos');
  await search('KC');
  assert((await groups()) === 1, 'the abbreviation “KC” finds them too');
  await search('odd look');
  assert((await groups()) === 1 && (await page.locator('.lib-group-id strong').innerText()).includes('SULLIVAN'), 'a hand-typed label is searchable');
  await search('sullivan');
  assert((await groups()) === 1, 'a patient is found by surname without the apostrophe');
  await search('H100234');
  assert((await groups()) === 1 && (await page.locator('.lib-group-id strong').innerText()).includes('FITZGERALD'), 'a patient is found by hospital number');
  await search('fitz pteryg');
  assert((await page.locator('.library-empty h2').innerText()) === 'Nothing matches', 'words that do not belong together match nothing');
  await search('');
  await page.click('.library-dx .dx-chip-btn:has-text("Pterygium")');
  assert((await groups()) === 1 && (await page.locator('.lib-group .tile').count()) === 2, 'a diagnosis chip filters to that diagnosis');
  await page.click('.library-dx .dx-chip-btn:has-text("Pterygium")');
  await page.click('.library-eye .segmented-item:has-text("OS")');
  assert((await page.locator('.lib-group .tile').count()) === 1, 'the eye filter shows only left-eye photos');
  await page.click('.library-eye .segmented-item:has-text("Both eyes")');

  console.log('Viewer labels');
  await search('kerato');
  await page.click('.lib-group .tile >> nth=0');
  await page.waitForSelector('.viewer .zoom-content img');
  assert((await page.locator('.viewer-title strong').innerText()).includes('FITZGERALD'), 'a Library photo opens with its patient’s name');
  // Label one photo differently in the viewer, then give the whole visit the same labels.
  await page.click('.viewer-info .dx-input');
  await page.keyboard.type('fuchs');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer-info .link-btn');
  await page.click('.viewer-info .link-btn');
  await page.waitForTimeout(600);
  a = await archive();
  const relabelled = Object.entries(a.manifests).find(([p]) => p.includes('H100234'))?.[1];
  assert(
    relabelled.images.every((i) => i.diagnoses?.join('|') === 'Keratoconus|Fuchs endothelial dystrophy'),
    'a label added in the viewer can be applied to the whole visit',
  );

  console.log('Annotations');
  await page.keyboard.press('a');
  await page.waitForSelector('.anno-bar');
  const box = await page.locator('.zoom-content').boundingBox();
  const P = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const drag = async (from, to) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
    await page.mouse.move(...to, { steps: 4 });
    await page.mouse.up();
  };
  const marks = () => page.evaluate(() => document.querySelectorAll('.anno-layer > g:nth-of-type(2) > *').length);
  await drag(P(0.38, 0.32), P(0.58, 0.62)); // circle
  assert((await marks()) === 1, 'dragging draws a circle');
  await page.mouse.click(...P(0.1, 0.1)); // a stray click
  assert((await marks()) === 1, 'a stray click draws nothing');
  await page.click('.anno-tool[aria-label="Arrow"]');
  await drag(P(0.85, 0.15), P(0.62, 0.36));
  await page.click('.anno-color[aria-label="Cyan"]');
  await page.click('.anno-tool[aria-label="Text"]');
  await page.mouse.click(...P(0.62, 0.08));
  await page.waitForSelector('.anno-text-input');
  await page.keyboard.type('Vogt striae');
  await shot('annotate-typing');
  await page.keyboard.press('Enter');
  assert((await page.locator('.anno-layer text >> nth=1').textContent()) === 'Vogt striae', 'a text label is placed on the photo');
  const before = await marks();
  await page.click('.anno-tool[aria-label="Erase a mark"]');
  await page.mouse.click(...P(0.62 + 0.02, 0.08));
  await page.waitForTimeout(150);
  assert((await marks()) === before - 1, 'the eraser removes the mark that is clicked');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  assert((await marks()) === before, 'Ctrl+Z brings it back');
  // While drawing, the keys that move between photos or delete them are off.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  assert((await page.locator('.viewer-thumb').count()) === 2 && (await marks()) === before, 'arrow keys and Delete do nothing while annotating');
  await shot('annotated');
  await page.click('.anno-done');
  await page.waitForTimeout(2600);
  a = await archive();
  const annotated = a.files.filter((f) => f.includes('_annotated'));
  assert(annotated.length === 1 && a.files.includes(annotated[0].replace('_annotated', '')), 'an “_annotated” copy sits beside the untouched original in the archive');
  const entry = Object.values(a.manifests)
    .flatMap((m) => m.images)
    .find((i) => i.annotatedFile);
  assert(entry && entry.annotations.length === 3 && annotated[0].endsWith(entry.annotatedFile), 'visit.json records the marks and names the annotated copy');
  const sizes = await page.evaluate(async (file) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    const read = async (p) => {
      const segs = p.split('/');
      const name = segs.pop();
      let d = root;
      for (const s of segs) d = await d.getDirectoryHandle(s);
      const bmp = await createImageBitmap(await (await d.getFileHandle(name)).getFile());
      return [bmp.width, bmp.height];
    };
    return { copy: await read(file), original: await read(file.replace('_annotated', '')) };
  }, annotated[0]);
  assert(sizes.copy[0] === sizes.original[0] && sizes.copy[1] === sizes.original[1], 'the annotated copy is full resolution');

  // Hide and show marks; they survive closing the viewer.
  await page.keyboard.press('m');
  assert((await page.locator('.anno-layer').count()) === 0, 'M hides the marks');
  await page.keyboard.press('m');
  assert((await page.locator('.anno-layer').count()) === 1, 'M shows them again');
  await page.keyboard.press('Escape');
  await search('');
  await page.click('.filter-toggle:has-text("Annotated")');
  assert((await page.locator('.lib-group .tile').count()) === 1, 'the Annotated filter finds the marked photo');
  await page.click('.lib-group .tile >> nth=0');
  await page.waitForSelector('.viewer .anno-layer');
  assert((await marks()) === before, 'the marks are still there when the photo is reopened');

  // Clearing the marks removes the copy again.
  await page.keyboard.press('a');
  await page.click('.anno-text-btn:has-text("Clear all")');
  await page.click('.anno-done');
  await page.waitForTimeout(2600);
  a = await archive();
  assert(!a.files.some((f) => f.includes('_annotated')), 'clearing the marks removes the annotated copy');
  assert(a.files.filter((f) => /\.webp$/.test(f)).length === 4, 'all four original photos are still in the archive');
  await page.keyboard.press('Escape');
  await page.click('.filter-toggle:has-text("Annotated")');

  console.log('From the Library to the patient');
  await search('fitz');
  await page.click('.lib-group button:has-text("All photos")');
  await page.waitForSelector('.review .tile');
  assert((await page.locator('.review-id h1').innerText()).includes('FITZGERALD'), '“All photos” opens that patient in Review');
  assert((await page.locator('.visit-dx .dx-chip').count()) === 2, 'the visit shows its diagnoses');
  await shot('review');

  assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('All good.');
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
