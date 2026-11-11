// Copies everything the list reader needs into public/ocr, so Lumen reads
// printed lists entirely on this computer and fetches nothing from a CDN:
// the OCR engine and English language data (Tesseract), and pdf.js's decoders
// for scanned pages, character maps and standard fonts.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'ocr');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const tess = path.dirname(require.resolve('tesseract.js/package.json'));
const core = path.dirname(require.resolve('tesseract.js-core/package.json'));
const lang = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
const pdfjs = path.dirname(require.resolve('pdfjs-dist/package.json'));

const files = [
  [path.join(tess, 'dist', 'worker.min.js'), 'worker.min.js'],
  // One of these is chosen at run time by what the CPU supports. Each carries its own WebAssembly, so the bare .wasm files are not needed.
  ...['relaxedsimd-lstm', 'simd-lstm', 'lstm'].map((v) => [path.join(core, `tesseract-core-${v}.wasm.js`), `tesseract-core-${v}.wasm.js`]),
  [path.join(lang, '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.gz'],
  // Decoders for the pictures inside scanned PDFs: fax (CCITT), JBIG2 and JPEG 2000, plus colour profiles.
  ...['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm'].map((f) => [path.join(pdfjs, 'wasm', f), path.join('pdfjs', 'wasm', f)]),
];
let copied = 0;
for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.error(`missing ${from}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  copyFileSync(from, path.join(out, to));
  copied++;
}
for (const dir of ['cmaps', 'standard_fonts', 'iccs']) {
  const from = path.join(pdfjs, dir);
  if (!existsSync(from)) {
    console.error(`missing ${from}`);
    process.exit(1);
  }
  cpSync(from, path.join(out, 'pdfjs', dir), { recursive: true });
}
console.log(`List reader assets: ${copied} files and 3 folders in public/ocr`);
