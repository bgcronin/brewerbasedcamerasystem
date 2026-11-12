/**
 * End-to-end test of getting photographs out of Lumen: copy to the clipboard,
 * the one-page PDF, and DICOM files (checked with an independent DICOM reader).
 *
 *   npm run build && npm run start      # in one terminal
 *   node tests/e2e/exports.cjs          # in another (needs Playwright + Chromium)
 *
 * Options (environment variables): URL, FAKE_VIDEO (see smoke.cjs);
 * SHOTS=./dir also saves the PDF page and the files that were downloaded.
 */
const { chromium } = require('playwright');
const dicomParser = require('dicom-parser');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.env.URL || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS;

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg);
  console.log('  ✓ ' + msg);
}

/** The files in a ZIP written without compression (which is how Lumen writes them). */
function unzip(buf) {
  const files = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 30, at + 30 + nameLen);
    const start = at + 30 + nameLen + extraLen;
    files[name] = buf.subarray(start, start + size);
    at = start + size;
  }
  return files;
}

/** Width and height from a JPEG's frame header, and whether it is a baseline JPEG. */
function jpegInfo(b) {
  let at = 2;
  while (at < b.length) {
    const marker = b[at + 1];
    const len = b.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { baseline: marker === 0xc0, height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    at += 2 + len;
  }
  throw new Error('no frame header');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-exports-'));
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (process.env.FAKE_VIDEO) args.push(`--use-file-for-fake-video-capture=${process.env.FAKE_VIDEO}`);
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['camera', 'clipboard-read', 'clipboard-write'], locale: 'en-GB', acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const films = (n) => page.waitForFunction((k) => document.querySelectorAll('.film-tile').length === k, n, { timeout: 15000 });
  const download = async (click) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), click()]);
    const file = path.join(tmp, d.suggestedFilename());
    await d.saveAs(file);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.copyFileSync(file, path.join(SHOTS, d.suggestedFilename()));
    }
    return { name: d.suggestedFilename(), data: fs.readFileSync(file) };
  };
  const clipboardImage = () =>
    page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes('image/png'));
      if (!item) return null;
      const bmp = await createImageBitmap(await item.getType('image/png'));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const g = canvas.getContext('2d');
      g.drawImage(bmp, 0, 0);
      // A fingerprint of the pixels, to tell two pictures apart.
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 97) sum = (sum + px[i] * (i % 251)) >>> 0;
      return { width: bmp.width, height: bmp.height, sum };
    });

  console.log('Set up');
  await page.goto(URL);
  await page.waitForSelector('.app[data-ready]');
  await page.click('text=Try it with a sample list');
  await page.waitForSelector('.map-table');
  await page.click('button:has-text("Import 12 patients")');
  await page.waitForSelector('.prow');
  await page.click('button[aria-label="Settings"]');
  await page.fill('.settings-body input >> nth=0', 'Cornea Clinic');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await page.click('.prow >> nth=1'); // O'SULLIVAN, Cian: an apostrophe in the name
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
  await page.keyboard.press('1');
  await page.keyboard.press('Space');
  await films(2);
  await page.keyboard.press('r');
  await page.keyboard.press('Space');
  await films(3);
  assert(true, 'three labelled photos taken (OD slit, OS diffuse, OD diffuse)');
  const size = await page.evaluate(() => ({ w: document.querySelector('video').videoWidth, h: document.querySelector('video').videoHeight }));

  console.log('Copy to the clipboard');
  await page.keyboard.press('v');
  await page.waitForSelector('.review .tile');
  await page.click('.review .tile >> nth=0');
  await page.waitForSelector('.viewer .zoom-content img');
  await page.keyboard.press('c');
  await page.waitForSelector('.toast:has-text("Photo copied")');
  const plain = await clipboardImage();
  assert(plain && plain.width === Math.min(size.w, 2400) && plain.height === Math.round((size.h * plain.width) / size.w), `C puts the photo on the clipboard as a picture (${plain?.width} × ${plain?.height})`);

  // Draw a circle, then copy again: the picture on the clipboard now has the mark in it.
  await page.keyboard.press('a');
  await page.waitForSelector('.anno-bar');
  const box = await page.locator('.zoom-content').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.65, { steps: 4 });
  await page.mouse.up();
  await page.click('.anno-done');
  await page.waitForFunction(() => !document.querySelector('.toast'));
  await page.click('.viewer-actions button[aria-label^="Copy with marks"]');
  await page.waitForSelector('.toast:has-text("Photo copied with its marks")');
  const marked = await clipboardImage();
  assert(marked && marked.width === plain.width && marked.sum !== plain.sum, 'with marks showing, the copy includes them');
  await page.keyboard.press('m'); // hide the marks
  await page.waitForFunction(() => !document.querySelector('.toast'));
  await page.keyboard.press('Control+c');
  await page.waitForSelector('.toast:has-text("Photo copied")');
  const hidden = await clipboardImage();
  assert(hidden && hidden.sum === plain.sum, 'with marks hidden, Ctrl+C copies the clean photo');
  await page.keyboard.press('m');

  console.log('One-page PDF');
  const pdf = await download(() => page.click('.viewer-export button:has-text("One-page PDF")'));
  const pdfText = pdf.data.toString('latin1');
  assert(pdf.name === "O'SULLIVAN_Cian_H100877_" + new Date().toLocaleDateString('en-CA') + '_OD.pdf', `the PDF is named after the patient, the date and the eye (${pdf.name})`);
  assert(pdfText.startsWith('%PDF-1.4') && pdfText.trimEnd().endsWith('%%EOF'), 'it is a PDF');
  assert((pdfText.match(/\/Type \/Page /g) || []).length === 1 && pdfText.includes('/MediaBox [0 0 595.28 841.89]'), 'one A4 page');
  const jpegAt = pdf.data.indexOf(Buffer.from([0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x0a, 0xff, 0xd8])) + 7;
  const jpegLen = Number(pdfText.match(/\/Filter \/DCTDecode \/Length (\d+)/)[1]);
  const sheet = pdf.data.subarray(jpegAt, jpegAt + jpegLen);
  const sheetInfo = jpegInfo(sheet);
  assert(sheetInfo.width === 1654 && sheetInfo.height === 2339, 'the page is drawn at 200 dots per inch');
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'summary-one-photo.jpg'), sheet);

  console.log('DICOM from the viewer');
  const pair = await download(() => page.click('.viewer-export button:has-text("DICOM file")'));
  assert(/_DICOM\.zip$/.test(pair.name), 'a photo with marks exports as a pair of files in a ZIP');
  const both = unzip(pair.data);
  const names = Object.keys(both).sort();
  assert(names.length === 2 && names[0].endsWith('_annotated.dcm') !== names[1].endsWith('_annotated.dcm'), 'the original and the copy with marks');
  const original = dicomParser.parseDicom(new Uint8Array(both[names.find((n) => !n.endsWith('_annotated.dcm'))]));
  const copy = dicomParser.parseDicom(new Uint8Array(both[names.find((n) => n.endsWith('_annotated.dcm'))]));
  const str = (ds, tag) => {
    const e = ds.elements[tag];
    return e ? Buffer.from(ds.byteArray.subarray(e.dataOffset, e.dataOffset + e.length)).toString('utf8').replace(/[\0 ]+$/, '') : undefined;
  };
  assert(str(original, 'x00020002') === '1.2.840.10008.5.1.4.1.1.77.1.4' && str(original, 'x00080060') === 'XC', 'a VL Photographic Image, modality XC');
  assert(str(original, 'x00100010') === "O'Sullivan^Cian" && str(original, 'x00100020') === 'H100877' && str(original, 'x00100030') === '19880730', 'with the patient’s name, hospital number and date of birth');
  assert(str(original, 'x00200062') === 'R', 'the right eye is recorded as laterality R');
  assert(str(original, 'x00080080') === 'Cornea Clinic', 'and the clinic’s name');
  assert(str(original, 'x00204000').includes('Keratoconus') && /Slit beam|Diffuse/.test(str(original, 'x00204000')), 'the diagnosis and illumination are in the image comments');
  assert(original.uint16('x00280011') === size.w && original.uint16('x00280010') === size.h, `the header gives the photo’s real size (${size.w} × ${size.h})`);
  const frame = Buffer.from(dicomParser.readEncapsulatedPixelDataFromFragments(original, original.elements.x7fe00010, 0, 1));
  const info = jpegInfo(frame);
  assert(str(original, 'x00020010') === '1.2.840.10008.1.2.4.50' && info.baseline, 'the picture inside is a baseline JPEG, as the file declares');
  assert(info.width === size.w && info.height === size.h, 'and is the size the header says');
  assert(str(copy, 'x00080008') === 'DERIVED\\SECONDARY' && str(copy, 'x00280301') === 'YES', 'the marked copy is declared a derived image with burned-in annotation');
  assert(str(copy, 'x0020000d') === str(original, 'x0020000d') && str(copy, 'x00080018') !== str(original, 'x00080018'), 'both belong to the same study, as separate images');
  await page.keyboard.press('Escape');

  console.log('From the Review screen');
  const visitPdf = await download(() => page.click('.visit-tools button:has-text("Summary PDF")'));
  const visitText = visitPdf.data.toString('latin1');
  assert((visitText.match(/\/Type \/Page /g) || []).length === 1, 'the visit summary of three photos is one page');
  if (SHOTS) {
    const at = visitPdf.data.indexOf(Buffer.from([0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x0a, 0xff, 0xd8])) + 7;
    fs.writeFileSync(path.join(SHOTS, 'summary-visit.jpg'), visitPdf.data.subarray(at, at + Number(visitText.match(/\/Filter \/DCTDecode \/Length (\d+)/)[1])));
  }
  await page.click('.review-actions .menu button');
  await page.waitForSelector('.menu-list');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'review-export-menu.png') });
  const all = await download(() => page.click('.menu-item:has-text("DICOM (ZIP)")'));
  const files = unzip(all.data);
  const paths = Object.keys(files).sort();
  assert(all.name === "O'SULLIVAN_Cian_H100877_DICOM.zip" && paths.length === 4, 'Export → DICOM gives every photo, plus the marked copy (4 files)');
  assert(paths.every((p) => /^O'SULLIVAN_Cian_H100877_DICOM\/\d{4}-\d{2}-\d{2}\/[^/]+\.dcm$/.test(p)), 'in one folder per visit');
  const sets = paths.map((p) => dicomParser.parseDicom(new Uint8Array(files[p])));
  assert(new Set(sets.map((d) => str(d, 'x0020000d'))).size === 1 && new Set(sets.map((d) => str(d, 'x00080018'))).size === 4, 'one study, four different images');
  assert(sets.map((d) => str(d, 'x00200062')).sort().join('') === 'LRRR', 'each with its own eye');
  assert(new Set(sets.map((d) => str(d, 'x00200013'))).size === 4, 'and its own number in the series');
  const again = sets.find((d) => str(d, 'x00080018') === str(original, 'x00080018'));
  assert(!!again, 'a photo exported twice keeps the same identifier, so a PACS sees one image, not two');

  assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('All good.');
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
