// Copies the OCR engine and English language data into public/ocr so Lumen
// reads printed lists entirely on this computer: nothing is fetched from a CDN.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'ocr');
mkdirSync(out, { recursive: true });

const tess = path.dirname(require.resolve('tesseract.js/package.json'));
const core = path.dirname(require.resolve('tesseract.js-core/package.json'));
const lang = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));

const files = [
  [path.join(tess, 'dist', 'worker.min.js'), 'worker.min.js'],
  // One of these is chosen at run time by what the CPU supports.
  ...['relaxedsimd-lstm', 'simd-lstm', 'lstm'].flatMap((v) => [
    [path.join(core, `tesseract-core-${v}.wasm.js`), `tesseract-core-${v}.wasm.js`],
    [path.join(core, `tesseract-core-${v}.wasm`), `tesseract-core-${v}.wasm`],
  ]),
  [path.join(lang, '4.0.0_best_int', 'eng.traineddata.gz'), 'eng.traineddata.gz'],
];
let copied = 0;
for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.error(`missing ${from}`);
    process.exit(1);
  }
  copyFileSync(from, path.join(out, to));
  copied++;
}
console.log(`OCR assets: ${copied} files in public/ocr`);
