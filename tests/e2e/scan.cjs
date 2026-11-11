/**
 * Imports a printed clinic list as a PDF (text layer) and as a photo (OCR),
 * both read entirely in the browser from files served by Lumen itself.
 *
 *   npm run build && npm start      # in one terminal
 *   node tests/e2e/scan.cjs         # in another
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.env.URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS;
const EXPECTED = ['H100234', 'H100877', 'H101532', 'H098812', 'H102291', 'H099023', 'H103348', 'H100456', 'H101990', 'H097761', 'H102874', 'H103512'];

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ✓ ' + msg);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-scan-'));
  const browser = await chromium.launch();

  // Render the fixture list the way a clinic printer would: a PDF, and a slightly blurred photo.
  const render = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
  await render.goto('file://' + path.join(__dirname, '..', 'fixtures', 'clinic-list.html'));
  await render.pdf({ path: path.join(tmp, 'clinic-list.pdf'), format: 'A4', printBackground: true });
  await render.screenshot({ path: path.join(tmp, 'clinic-list.png'), fullPage: true });
  await render.close();

  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const external = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(URL) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url());
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  };

  const importFile = async (file, label) => {
    console.log(label);
    await page.click('button:has-text("Import list")');
    await page.waitForSelector('.dropzone');
    await page.locator('.import-choose input[type=file]').setInputFiles(file);
    await page.waitForSelector('.map-table', { timeout: 90000 });
    const notes = await page.locator('.import-notes').innerText();
    console.log('   ' + notes);
    const preview = await page.locator('.import-preview-head').innerText();
    assert(/12 patients/.test(preview), 'preview counts 12 patients');
    await shot(label.replace(/\W+/g, '-').toLowerCase());
    await page.click('button:has-text("Import 12 patients")');
    await page.waitForFunction(() => document.querySelectorAll('.prow').length === 12, null, { timeout: 15000 });
    const mrns = await page.locator('.prow-mrn').allInnerTexts();
    const found = EXPECTED.filter((m) => mrns.some((x) => x.trim() === m));
    assert(found.length === EXPECTED.length, `all 12 hospital numbers on the list exactly (${found.length}/12)`);
    const names = await page.locator('.prow-name').allInnerTexts();
    assert(names.includes('FITZGERALD, Eleanor') && names.includes('DE LA CRUZ, Mateo') && names.includes("O'SULLIVAN, Cian"), 'names split into surname and forename');
    await page.click('.prow:has-text("FITZGERALD")');
    await page.waitForSelector('.pcard-grid');
    const card = await page.locator('.pcard-grid').innerText();
    assert(/1956/.test(card) && /70|69/.test(card), 'date of birth read and age shown');
  };

  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');
  await importFile(path.join(tmp, 'clinic-list.pdf'), 'PDF with a text layer');
  await importFile(path.join(tmp, 'clinic-list.png'), 'Photo of the printed list (OCR)');
  assert((await page.locator('.prow').count()) === 12, 'importing the same list twice does not duplicate anyone');

  assert(external.length === 0, 'no request left this computer' + (external.length ? ': ' + external.join(', ') : ''));
  assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('All good.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
