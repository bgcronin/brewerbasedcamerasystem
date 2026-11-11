/**
 * Imports printed clinic lists as PDFs (text layer), scans and photos (OCR),
 * all read in the browser from files served by Lumen itself, and checks the
 * review step: rows the reader is unsure of are held back until a person has
 * corrected or confirmed them.
 *
 *   npm run build && npm start      # in one terminal
 *   node tests/e2e/scan.cjs         # in another (needs Playwright + Chromium)
 *
 * Options (environment variables):
 *   URL=http://localhost:4173/   app address
 *   SHOTS=./shots                save screenshots of each step
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.env.URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS;
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const EXPECTED = ['H100234', 'H100877', 'H101532', 'H098812', 'H102291', 'H099023', 'H103348', 'H100456', 'H101990', 'H097761', 'H102874', 'H103512'];

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ✓ ' + msg);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-scan-'));
  const browser = await chromium.launch();

  // Render the fixture lists the way a clinic printer and a phone would: a PDF, and a picture.
  const render = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
  for (const name of ['clinic-list', 'clinic-list-split', 'clinic-list-check']) {
    await render.goto('file://' + path.join(FIXTURES, name + '.html'));
    await render.pdf({ path: path.join(tmp, name + '.pdf'), format: 'A4', printBackground: true });
    await render.screenshot({ path: path.join(tmp, name + '.png'), fullPage: true });
  }
  await render.close();

  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  };

  /** Choose a file in the import sheet and wait for the review table. */
  const open = async (file) => {
    await page.click('button:has-text("Import list")');
    await page.waitForSelector('.dropzone');
    await page.locator('.import-choose input[type=file]').setInputFiles(file);
    await page.waitForSelector('.map-table', { timeout: 120000 });
    return sheet();
  };
  /** What the sheet says and shows. */
  const sheet = () =>
    page.evaluate(() => ({
      how: document.querySelector('.import-notes')?.textContent ?? '',
      count: document.querySelector('.import-count')?.textContent ?? '',
      ready: Number((document.querySelector('.import-count strong')?.textContent ?? '').match(/\d+/)?.[0] ?? NaN),
      button: document.querySelector('.sheet-foot button:last-child')?.textContent ?? '',
      fields: [...document.querySelectorAll('.map-table thead select')].map((s) => s.selectedOptions[0].textContent),
      rows: [...document.querySelectorAll('.map-table tbody tr:not(.row-why)')].map((tr) => ({ flagged: tr.classList.contains('is-flagged') && !tr.classList.contains('is-confirmed'), cells: [...tr.querySelectorAll('input.cell')].map((i) => i.value) })),
      why: [...document.querySelectorAll('.map-table tbody tr.row-why')].map((tr) => tr.textContent),
      unused: [...document.querySelectorAll('.import-unused li')].map((li) => li.textContent),
    }));
  const confirm = async (n) => {
    await page.click(`button:has-text("Import ${n} patient")`);
    await page.waitForSelector('.map-table', { state: 'detached', timeout: 15000 });
  };
  const listed = async () => ({ mrns: (await page.locator('.prow-mrn').allInnerTexts()).map((x) => x.trim()), names: await page.locator('.prow-name').allInnerTexts() });
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast-close').forEach((b) => b.click()));

  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');

  console.log('PDF with a text layer');
  let s = await open(path.join(tmp, 'clinic-list.pdf'));
  assert(/from the PDF’s text/.test(s.how), 'read from the PDF’s own text');
  assert(s.ready === 12 && /^Import 12 patients$/.test(s.button), 'all 12 patients ready, none to check');
  assert(s.fields.join() === 'Appt time,Patient ID / MRN,Full name,Date of birth,Sex,Reason / type', 'each column matched from its printed heading');
  assert(s.rows.length === 12 && s.rows[0].cells[3] === '12/03/1956', 'every row shown, dates kept as printed');
  assert(s.unused.length === 3 && s.unused.some((t) => /Cornea Clinic/.test(t)), 'the title and footers are listed as not used, not hidden');
  await shot('scan-pdf');
  await confirm(12);
  await page.waitForFunction(() => document.querySelectorAll('.prow').length === 12, null, { timeout: 15000 });
  let on = await listed();
  assert(EXPECTED.every((m) => on.mrns.includes(m)), 'all 12 hospital numbers on the list exactly');
  assert(on.names.includes('FITZGERALD, Eleanor') && on.names.includes('DE LA CRUZ, Mateo') && on.names.includes("O'SULLIVAN, Cian"), 'names split into surname and forename');
  await page.click('.prow:has-text("FITZGERALD")');
  await page.waitForSelector('.pcard-grid');
  const card = await page.locator('.pcard-grid').innerText();
  assert(/1956/.test(card) && /70|69/.test(card), 'date of birth read and age shown');

  console.log('Photo of the same list (OCR)');
  s = await open(path.join(tmp, 'clinic-list.png'));
  assert(/from the picture, on this computer/.test(s.how), 'read from the picture on this computer');
  const held = s.rows.filter((r) => r.flagged);
  assert(s.rows.length === 12 && s.ready + held.length === 12, `12 rows: ${s.ready} ready, ${held.length} held back for checking`);
  assert(s.rows.every((r) => EXPECTED.includes(r.cells[1])), 'every hospital number read exactly, including any held back');
  // Rows the reader was unsure of are not imported until a person has looked: tick each one.
  const boxes = page.locator('.row-why .row-ok input');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
  s = await sheet();
  assert(s.ready === 12 && /^Import 12 patients$/.test(s.button), 'once checked, all 12 are ready');
  await shot('scan-photo');
  await confirm(12);
  await page.waitForFunction(() => document.querySelectorAll('.prow').length === 12, null, { timeout: 15000 });
  assert((await page.locator('.prow').count()) === 12, 'importing the same list twice does not duplicate anyone');
  await clearToasts();

  console.log('Ruled list with separate surname and forename columns');
  for (const kind of ['pdf', 'png']) {
    s = await open(path.join(tmp, 'clinic-list-split.' + kind));
    assert(s.fields.slice(0, 5).join() === 'Appt time,Patient ID / MRN,Surname,First name,Date of birth', `${kind}: surname and forename columns recognised`);
    assert(s.rows.length === 8, `${kind}: all 8 rows found (cell borders and all)`);
    const names = s.rows.map((r) => `${r.cells[2]}, ${r.cells[3]}`);
    assert(['MARTIN, Mary', 'PAGE, Declan', 'MAY, Julie', 'DE LA CRUZ, Mateo'].every((n) => names.includes(n)), `${kind}: MARTIN, PAGE, MAY and DE LA CRUZ are names, not headings or months`);
    assert(s.rows.every((r) => /^H\d{6}$/.test(r.cells[1]) && !/review|post-op|new/i.test(r.cells[2] + r.cells[3])), `${kind}: no appointment type in a name, no name in a number`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.map-table', { state: 'detached' });
  }

  console.log('Rows that need checking');
  s = await open(path.join(tmp, 'clinic-list-check.pdf'));
  // Put this list on a day of its own, so what it adds can be counted.
  await page.locator('.import-options input[type=date]').fill('2026-11-18');
  assert(s.ready === 4 && /Import 4 patients \(2 still to check\)/.test(s.button), 'the button says 4 will be imported and 2 still need checking');
  assert(s.rows[0].flagged && s.rows[1].flagged && !s.rows[2].flagged, 'the two doubtful rows are shown first');
  assert(/No hospital number was read/.test(s.why[0]) && /Printed:.*O'SULLIVAN, Cian/.test(s.why[0]), 'each says why, with the line as printed');
  assert(/H09881 isn’t shaped like the others on this list \(for example H100234\)/.test(s.why[1]), 'a number unlike the rest is called out');
  await shot('scan-check');
  await confirm(4);
  await page.waitForFunction(() => document.querySelectorAll('.prow').length === 4, null, { timeout: 15000 });
  on = await listed();
  assert(!on.names.some((n) => /O'SULLIVAN|MURPHY/.test(n)), 'rows not yet checked were left out of the import');
  await clearToasts();

  s = await open(path.join(tmp, 'clinic-list-check.pdf'));
  // Correct one by typing the number in; confirm the other as printed.
  await page.locator('.map-table tbody tr.is-flagged').nth(0).locator('input.cell').nth(1).fill('H100877');
  s = await sheet();
  assert(s.ready === 5 && !s.rows[0].flagged, 'typing the missing hospital number clears the flag');
  await page.locator('.row-why .row-ok input').first().check();
  s = await sheet();
  assert(s.ready === 6 && /^Import 6 patients$/.test(s.button), 'ticking the other row as correct makes all 6 ready');
  await confirm(6);
  await page.waitForFunction(() => document.querySelectorAll('.prow').length === 6, null, { timeout: 15000 });
  on = await listed();
  assert(on.mrns.includes('H100877') && on.mrns.includes('H09881'), 'the corrected and the confirmed hospital numbers are saved as shown');
  assert(on.names.includes("O'SULLIVAN, Cian") && on.names.includes('MURPHY, Declan'), 'and their patients are on the list');
  await clearToasts();

  console.log('Removing a row, and a scanned PDF');
  s = await open(path.join(FIXTURES, 'scanned-list-fax.pdf'));
  assert(/from the scanned pages, on this computer/.test(s.how) && s.rows.length === 12, 'a fax-compressed scan is decoded and read (12 rows)');
  assert(requests.some((u) => u.startsWith(URL) && /\/ocr\/pdfjs\/wasm\//.test(u)), 'its decoder came from Lumen’s own folder');
  const before = s.ready;
  await page.locator('.map-table tbody tr:not(.is-flagged) .row-remove').first().click();
  s = await sheet();
  assert(s.rows.length === 11 && s.ready === before - 1, 'a removed row is not imported');
  await page.click('.import-rows-note .link-btn');
  assert((await sheet()).rows.length === 12, 'and can be put back');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.map-table', { state: 'detached' });

  console.log('Dropping files on the window');
  const drop = (files) =>
    page.evaluate(async (list) => {
      const dt = new DataTransfer();
      for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type, lastModified: Date.now() }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, files);
  await page.click('.prow:has-text("FITZGERALD")');
  await page.waitForSelector('.pcard-grid');
  const photo = { name: 'IMG_0001.png', type: 'image/png', b64: fs.readFileSync(path.join(tmp, 'clinic-list.png')).toString('base64') };
  await drop([photo]);
  await page.waitForSelector('.toast:has-text("1 photo added")', { timeout: 20000 });
  assert(!(await page.locator('.import-sheet').count()), 'a picture dropped on the window is a photograph for the selected patient, not a list');
  await clearToasts();
  await drop([{ name: 'clinic-list.pdf', type: 'application/pdf', b64: fs.readFileSync(path.join(tmp, 'clinic-list.pdf')).toString('base64') }]);
  await page.waitForSelector('.map-table', { timeout: 30000 });
  assert((await page.locator('.import-file strong').innerText()) === 'clinic-list.pdf' && (await sheet()).rows.length === 12, 'a PDF dropped on the window opens the list import');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.map-table', { state: 'detached' });

  console.log('Closing the sheet while a list is being read');
  await page.click('button:has-text("Import list")');
  await page.waitForSelector('.dropzone');
  await page.locator('.import-choose input[type=file]').setInputFiles(path.join(tmp, 'clinic-list.png'));
  await page.waitForSelector('.import-reading');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.import-sheet', { state: 'detached' });
  await page.click('button:has-text("Import list")');
  await page.fill('.paste-area', 'Time\tHospital No\tSurname\tForename\tDOB\n09:00\tZ999001\tPASTED\tPerson\t01/01/1990');
  await page.click('.import-choose-foot button:has-text("Continue")');
  await page.waitForSelector('.map-table');
  await page.waitForTimeout(6000);
  s = await sheet();
  assert(s.rows.length === 1 && s.rows[0].cells[1] === 'Z999001', 'the abandoned read never replaces the list now on screen');
  assert(page.workers().every((w) => !/ocr\/worker/.test(w.url())), 'and its text reader was shut down');
  await page.keyboard.press('Escape');

  const external = requests.filter((u) => !u.startsWith(URL) && !u.startsWith('data:') && !u.startsWith('blob:'));
  assert(requests.some((u) => /\/ocr\/eng\.traineddata/.test(u)) && requests.some((u) => /\/ocr\/pdfjs\//.test(u)), 'the text reader and the PDF decoders were fetched from Lumen itself');
  assert(external.length === 0, 'no request left this computer' + (external.length ? ': ' + external.join(', ') : ''));
  assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('All good.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
