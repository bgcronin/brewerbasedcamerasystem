/**
 * Reads a printed clinic list from a PDF, a scan or a photo, entirely on this
 * computer. A PDF's own text is used when it has one; otherwise the pages are
 * read with Tesseract (OCR) running in a Web Worker, with the engine and the
 * English language data served from Lumen's own folder. Nothing is uploaded.
 */
import { parseScannedLines, type ScannedLine, type ScanParseResult } from './scanParse';

export type ScanProgress = (p: { label: string; progress?: number }) => void;

const OCR_DIR = new URL('./ocr/', document.baseURI).toString();
const PAGE_LIMIT = 20;

/* ───────── PDF ───────── */

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

async function loadPdfJs() {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs;
}

/** Group a page's text items into lines; a wide horizontal gap becomes a tab, i.e. a column boundary. */
export function itemsToLines(items: TextItem[]): string[] {
  const glyphs = items
    .filter((i) => i.str.trim())
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10 }));
  if (!glyphs.length) return [];
  glyphs.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: (typeof glyphs)[] = [];
  for (const g of glyphs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - g.y) <= Math.max(2, last[0].h * 0.5)) last.push(g);
    else lines.push([g]);
  }
  return lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    let out = '';
    let cursor = line[0].x;
    for (const g of line) {
      const charW = g.w / Math.max(1, g.str.length) || g.h * 0.5;
      const gap = g.x - cursor;
      if (out) out += gap > charW * 2.5 ? '\t' : gap > charW * 0.3 ? ' ' : '';
      out += g.str;
      cursor = g.x + g.w;
    }
    return out;
  });
}

async function readPdf(file: File, onProgress: ScanProgress): Promise<{ lines: ScannedLine[]; ocrPages: number }> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  const pages = Math.min(doc.numPages, PAGE_LIMIT);
  const lines: ScannedLine[] = [];
  let ocrPages = 0;
  let ocr: Awaited<ReturnType<typeof createOcr>> | null = null;
  try {
    for (let n = 1; n <= pages; n++) {
      onProgress({ label: `Reading page ${n} of ${pages}`, progress: (n - 1) / pages });
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = itemsToLines(content.items as TextItem[]);
      if (text.join('').replace(/\s/g, '').length > 20) {
        lines.push(...text.map((t) => ({ text: t })));
        continue;
      }
      // No text layer: it's a scan inside a PDF. Draw the page and read it.
      ocrPages++;
      ocr ??= await createOcr(onProgress);
      const viewport = page.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      lines.push(...(await ocr.read(canvas, (p) => onProgress({ label: `Reading page ${n} of ${pages}`, progress: (n - 1 + p) / pages }))));
    }
  } finally {
    await ocr?.close();
    await task.destroy();
  }
  return { lines, ocrPages };
}

/* ───────── OCR ───────── */

async function createOcr(onProgress: ScanProgress) {
  onProgress({ label: 'Starting the text reader' });
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    workerPath: OCR_DIR + 'worker.min.js',
    corePath: OCR_DIR,
    langPath: OCR_DIR.replace(/\/$/, ''),
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none',
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  return {
    async read(source: HTMLCanvasElement, progress: (p: number) => void): Promise<ScannedLine[]> {
      progress(0.1);
      const { data } = await worker.recognize(source, {}, { text: true, blocks: true });
      progress(1);
      return (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)).map((l) => ({ text: l.text.replace(/\n$/, ''), confidence: l.confidence }));
    },
    close: () => worker.terminate(),
  };
}

/** Prepare a photo or scan for reading: upright, greyscale, and large enough that text is ~30px tall. */
export async function prepareImage(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(4, Math.max(1, 2200 / Math.max(bitmap.width, bitmap.height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = 'grayscale(1) contrast(1.15)';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

async function readImage(file: File, onProgress: ScanProgress): Promise<ScannedLine[]> {
  const canvas = await prepareImage(file);
  const ocr = await createOcr(onProgress);
  try {
    return await ocr.read(canvas, (p) => onProgress({ label: 'Reading the list', progress: p }));
  } finally {
    await ocr.close();
  }
}

/* ───────── entry point ───────── */

export interface ScanOutcome extends ScanParseResult {
  /** Plain-language summary for the import sheet. */
  notes: string;
  usedOcr: boolean;
}

export async function scanList(file: File, onProgress: ScanProgress = () => {}): Promise<ScanOutcome> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  let lines: ScannedLine[];
  let usedOcr: boolean;
  if (isPdf) {
    const r = await readPdf(file, onProgress);
    lines = r.lines;
    usedOcr = r.ocrPages > 0;
  } else {
    lines = await readImage(file, onProgress);
    usedOcr = true;
  }
  const parsed = parseScannedLines(lines);
  const n = parsed.parsed.length;
  const parts = [
    `${n} patient${n === 1 ? '' : 's'} found`,
    usedOcr ? 'read from the image on this computer' : 'read from the PDF’s text',
    parsed.flagged ? `${parsed.flagged} to check` : '',
  ].filter(Boolean);
  return { ...parsed, notes: parts.join(', '), usedOcr };
}
