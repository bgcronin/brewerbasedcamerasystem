/**
 * Reads a printed clinic list from a PDF, a scan or a photo, entirely on this
 * computer. A PDF's own text is used when it has one; otherwise the pages are
 * read with Tesseract (OCR) running in a Web Worker. The OCR engine, its
 * English language data and pdf.js's image decoders and fonts are all served
 * from Lumen's own folder. Nothing is uploaded and nothing is fetched from
 * anywhere else.
 *
 * This file is the browser side: getting positioned text out of the file.
 * Turning that text into a table is in scanParse.ts and has no browser code.
 */
import { removeRules } from './rules';
import { readScan, type Box, type PageInput, type ScanReading } from './scanParse';

export type ScanProgress = (p: { label: string; progress?: number }) => void;

const ASSETS = new URL('./ocr/', document.baseURI).toString();
/** Pages of PDF text are cheap to read; pages that need OCR take seconds each. */
const TEXT_PAGE_LIMIT = 200;
const OCR_PAGE_LIMIT = 20;
const START_TIMEOUT = 60_000;
const READ_TIMEOUT = 240_000;

function aborted(): Error {
  return new DOMException('The read was cancelled', 'AbortError');
}
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw aborted();
};
const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '') || 'Unknown error';

/* ───────── PDF text ───────── */

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/**
 * Where each piece of PDF text sits on the page as it is displayed. The page's
 * own rotation is applied (many landscape lists are stored as rotated portrait
 * pages), and if the text itself runs sideways the page is turned to match.
 */
export function itemsToBoxes(items: PdfTextItem[], viewport: number[]): Box[] {
  const placed = items
    .filter((i) => i.str && i.str.trim())
    .map((i) => {
      const [a, b, c, d, e, f] = i.transform;
      const [va, vb, vc, vd, ve, vf] = viewport;
      // viewport × item
      const m = [va * a + vc * b, vb * a + vd * b, va * c + vc * d, vb * c + vd * d, va * e + vc * f + ve, vb * e + vd * f + vf];
      const size = Math.hypot(m[2], m[3]) || i.height || 10;
      const stretch = Math.hypot(m[0], m[1]) / (Math.hypot(a, b) || 1);
      return { str: i.str, x: m[4], y: m[5], size, width: i.width * (stretch || 1), turn: Math.round(Math.atan2(m[1], m[0]) / (Math.PI / 2)) & 3 };
    });
  if (!placed.length) return [];
  // Which way does most of the text run? 0 = across, 1 = down the page, 2 = upside down, 3 = up the page.
  const weight = [0, 0, 0, 0];
  for (const p of placed) weight[p.turn] += p.str.length;
  const turn = weight.indexOf(Math.max(...weight));
  const ux = [1, 0, -1, 0][turn];
  const uy = [0, 1, 0, -1][turn];
  return placed
    .filter((p) => p.turn === turn)
    .map((p) => {
      const x = p.x * ux + p.y * uy;
      const y = -p.x * uy + p.y * ux;
      return { text: p.str, x0: x, x1: x + p.width, y0: y - p.size * 0.8, y1: y + p.size * 0.2 };
    });
}

async function loadPdfJs() {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

/* ───────── OCR ───────── */

interface OcrPage {
  boxes: Box[];
  skew: number;
  /** Letters and digits in words the engine was confident of: how much of the page really was read. */
  good: number;
  total: number;
}

interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TessLine {
  words: TessWord[];
  baseline?: { x0: number; y0: number; x1: number; y1: number };
}

type Ocr = Awaited<ReturnType<typeof createOcr>>;

/**
 * Start the OCR worker. Tesseract's own start-up never reports some failures
 * (a missing language file leaves its promise pending for ever), so this adds
 * a time limit, listens for the worker's errors, and keeps hold of the Worker
 * so it can always be stopped.
 */
async function createOcr(onProgress: ScanProgress, signal?: AbortSignal) {
  check(signal);
  onProgress({ label: 'Starting the text reader' });
  const { createWorker, PSM } = await import('tesseract.js');
  let onRecognise: (p: number) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  failed.catch(() => {});

  // createWorker makes its Worker synchronously; catch it as it is made.
  const NativeWorker = window.Worker;
  let raw: Worker | undefined;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      raw = this;
    }
  };
  let starting: Promise<Tesseract.Worker>;
  try {
    starting = createWorker('eng', 1, {
      workerPath: ASSETS + 'worker.min.js',
      corePath: ASSETS,
      langPath: ASSETS.replace(/\/$/, ''),
      gzip: true,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m) => m.status === 'recognizing text' && onRecognise(m.progress),
      errorHandler: (e) => fail(new Error(errorText(e))),
    });
  } finally {
    window.Worker = NativeWorker;
  }
  starting.catch(() => {});
  const stop = () => {
    try {
      raw?.terminate();
    } catch {
      /* already gone */
    }
  };
  const onAbort = () => {
    stop();
    fail(aborted());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const within = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer = 0;
    const late = new Promise<never>((_, reject) => (timer = window.setTimeout(() => reject(new Error(what)), ms)));
    return Promise.race([p, failed, late]).finally(() => window.clearTimeout(timer));
  };

  let worker: Tesseract.Worker;
  try {
    worker = await within(starting, START_TIMEOUT, 'The text reader didn’t start. Its files may be missing from this copy of Lumen: run the build again, then reload.');
    await within(worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' }), START_TIMEOUT, 'The text reader didn’t start.');
  } catch (e) {
    stop();
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw aborted();
    const text = errorText(e);
    throw new Error(/didn’t start/.test(text) ? text : `The text reader couldn’t start (${text}). Its files may be missing from this copy of Lumen: run the build again, then reload.`);
  }

  return {
    async read(source: HTMLCanvasElement, progress: (p: number) => void): Promise<OcrPage> {
      check(signal);
      onRecognise = progress;
      try {
        const { data } = await within(worker.recognize(source, {}, { text: false, blocks: true }), READ_TIMEOUT, 'Reading the page took too long and was stopped.');
        const lines = ((data.blocks ?? []) as unknown as { paragraphs: { lines: TessLine[] }[] }[]).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
        const boxes: Box[] = [];
        const slopes: number[] = [];
        let good = 0;
        let total = 0;
        for (const l of lines) {
          const bl = l.baseline;
          if (bl && bl.x1 - bl.x0 > source.width * 0.25) slopes.push((bl.y1 - bl.y0) / (bl.x1 - bl.x0));
          for (const w of l.words) {
            const text = w.text.trim();
            if (!text) continue;
            boxes.push({ text, x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1, conf: w.confidence });
            const chars = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
            total += chars;
            if (chars >= 2 && w.confidence >= 70) good += chars;
          }
        }
        slopes.sort((a, b) => a - b);
        return { boxes, skew: slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0, good, total };
      } finally {
        onRecognise = () => {};
      }
    },
    close() {
      signal?.removeEventListener('abort', onAbort);
      stop();
    },
  };
}

/** Too little read with confidence for this to be a list the right way up. */
const weak = (p: OcrPage) => p.good < 80 || p.good < p.total * 0.45;

function turned(source: HTMLCanvasElement, quarterTurns: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  const swap = quarterTurns % 2 === 1;
  out.width = swap ? source.height : source.width;
  out.height = swap ? source.width : source.height;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((quarterTurns * Math.PI) / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return out;
}

/**
 * Read one picture. If hardly anything comes out, the page is probably
 * sideways or upside down (a photo with no orientation tag, a sheet fed into
 * the scanner the wrong way), so the other three ways up are tried and the
 * best kept.
 */
async function readPicture(ocr: Ocr, canvas: HTMLCanvasElement, onProgress: (label: string, p: number) => void, signal?: AbortSignal): Promise<OcrPage> {
  let best = await ocr.read(canvas, (p) => onProgress('Reading the list', p));
  if (!weak(best)) return best;
  for (const [n, turns] of [1, 3, 2].entries()) {
    check(signal);
    const page = await ocr.read(turned(canvas, turns), (p) => onProgress('Trying the page another way up', (n + p) / 3));
    if (page.good > best.good * 1.5 + 20) best = page;
    if (!weak(best)) break;
  }
  return best;
}

/**
 * Prepare a photo or scan for reading: upright (by its orientation tag),
 * greyscale, a sensible size (small pictures enlarged so text is about 30 px
 * tall, very large ones reduced), and with any table ruling lines taken out.
 */
export function prepareCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const long = Math.max(width, height);
  const scale = long > 3200 ? 3200 / long : Math.min(4, Math.max(1, 2200 / long));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = 'grayscale(1) contrast(1.15)';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  ctx.filter = 'none';
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  const gray = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
  if (removeRules(gray, canvas.width, canvas.height) > 0) {
    for (let i = 0; i < gray.length; i++) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = gray[i];
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

async function prepareImage(file: Blob): Promise<HTMLCanvasElement> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This picture couldn’t be opened. Use a JPEG or PNG; an iPhone HEIC photo needs to be shared as JPEG first.');
  }
  try {
    return prepareCanvas(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/* ───────── entry point ───────── */

export interface ScanOutcome extends ScanReading {
  /** How the list was read, to finish the sentence "Read …". */
  how: string;
  pagesNotRead: number;
}

async function scanImage(file: File, onProgress: ScanProgress, signal?: AbortSignal): Promise<ScanOutcome> {
  const canvas = await prepareImage(file);
  const ocr = await createOcr(onProgress, signal);
  try {
    const page = await readPicture(ocr, canvas, (label, progress) => onProgress({ label, progress }), signal);
    return { ...readScan([{ page: 1, ocr: true, boxes: page.boxes, skew: page.skew }]), how: 'from the picture, on this computer', pagesNotRead: 0 };
  } finally {
    ocr.close();
  }
}

async function scanPdf(file: File, onProgress: ScanProgress, signal?: AbortSignal): Promise<ScanOutcome> {
  const pdfjs = await loadPdfJs();
  check(signal);
  const task = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    // Decoders for scanned pages (CCITT, JBIG2, JPEG 2000), character maps and the standard fonts, all from Lumen's own folder.
    wasmUrl: ASSETS + 'pdfjs/wasm/',
    cMapUrl: ASSETS + 'pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSETS + 'pdfjs/standard_fonts/',
    iccUrl: ASSETS + 'pdfjs/iccs/',
  });
  const stopTask = () => void task.destroy().catch(() => {});
  signal?.addEventListener('abort', stopTask, { once: true });
  let ocr: Ocr | null = null;
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      if (signal?.aborted) throw aborted();
      if ((e as Error)?.name === 'PasswordException') throw new Error('This PDF is locked with a password. Print it to a new PDF without one, or export the list as a CSV.');
      throw new Error(`This PDF couldn’t be opened (${errorText(e)})`);
    }
    const count = Math.min(doc.numPages, TEXT_PAGE_LIMIT);
    let pagesNotRead = doc.numPages - count;
    const inputs = new Map<number, PageInput>();
    const needOcr: number[] = [];
    const hasPicture = new Map<number, boolean>();
    for (let n = 1; n <= count; n++) {
      check(signal);
      onProgress({ label: `Reading page ${n} of ${doc.numPages}`, progress: (n - 1) / count / 2 });
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const boxes = itemsToBoxes(content.items as PdfTextItem[], page.getViewport({ scale: 1 }).transform);
      if (boxes.map((b) => b.text).join('').replace(/\s/g, '').length > 20) inputs.set(n, { page: n, ocr: false, boxes });
      else needOcr.push(n);
    }
    let reading = readScan([...inputs.values()]);

    // A page with words on it but no patients may be a scan with a stamp or footer of real text over it. Look for a picture.
    const empty = [...inputs.keys()].filter((n) => !reading.rowsPerPage.get(n));
    for (const n of empty) {
      check(signal);
      const ops = await (await doc.getPage(n)).getOperatorList();
      const pictures = [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject] as number[];
      hasPicture.set(n, ops.fnArray.some((f) => pictures.includes(f)));
    }
    const noRows = reading.clean + reading.toCheck === 0;
    for (const n of empty) if (hasPicture.get(n) || noRows) needOcr.push(n);
    needOcr.sort((a, b) => a - b);

    const toRead = needOcr.slice(0, OCR_PAGE_LIMIT);
    pagesNotRead += needOcr.length - toRead.length;
    let usedOcr = false;
    for (const [i, n] of toRead.entries()) {
      check(signal);
      ocr ??= await createOcr(onProgress, signal);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 2.5 });
      const sheet = document.createElement('canvas');
      sheet.width = Math.ceil(viewport.width);
      sheet.height = Math.ceil(viewport.height);
      const ctx = sheet.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      await page.render({ canvas: sheet, canvasContext: ctx, viewport }).promise;
      check(signal);
      const canvas = prepareCanvas(sheet, sheet.width, sheet.height);
      sheet.width = sheet.height = 0;
      const label = toRead.length > 1 ? `Reading scanned page ${i + 1} of ${toRead.length}` : 'Reading the scanned page';
      const read = await readPicture(ocr, canvas, (text, p) => onProgress({ label: text === 'Reading the list' ? label : text, progress: 0.5 + (i + p) / toRead.length / 2 }), signal);
      canvas.width = canvas.height = 0;
      if (read.boxes.length) {
        const before = inputs.get(n);
        inputs.set(n, { page: n, ocr: true, boxes: read.boxes, skew: read.skew });
        // Keep the OCR reading of a page that had text only if it found patients where the text had none.
        if (before) {
          const tried = readScan([...inputs.values()].sort((a, b) => a.page - b.page));
          if (!tried.rowsPerPage.get(n)) inputs.set(n, before);
          else usedOcr = true;
        } else usedOcr = true;
      }
    }
    const pages = [...inputs.values()].sort((a, b) => a.page - b.page);
    if (toRead.length) reading = readScan(pages);
    const anyText = pages.some((p) => !p.ocr);
    const how = !usedOcr ? 'from the PDF’s text' : anyText ? 'from the PDF’s text and its scanned pages, on this computer' : 'from the scanned pages, on this computer';
    return { ...reading, how, pagesNotRead };
  } finally {
    signal?.removeEventListener('abort', stopTask);
    ocr?.close();
    await task.destroy().catch(() => {});
  }
}

export async function scanList(file: File, onProgress: ScanProgress = () => {}, signal?: AbortSignal): Promise<ScanOutcome> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  return isPdf ? scanPdf(file, onProgress, signal) : scanImage(file, onProgress, signal);
}
