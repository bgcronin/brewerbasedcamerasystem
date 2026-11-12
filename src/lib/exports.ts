/**
 * Getting photographs out of Lumen: to the clipboard, as a one-page PDF and
 * as DICOM files. Everything is made in the browser; nothing is uploaded.
 */
import { drawAnnotations } from './annotations';
import { buildDicom, dicomFileName, readJpegInfo } from './dicom';
import { buildPdf, paperFor, type PdfPage } from './pdf';
import { SUMMARY_ROWS_PER_PAGE, drawSummaryPage, summaryRows, type SummaryPhoto } from './summary';
import type { Annotation, Capture, Patient, Visit } from './types';

/** The longest side of a picture copied to the clipboard: plenty for a letter, and quick to paste. */
const CLIPBOARD_MAX = 2400;

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be prepared'))), type, quality));
}

/** The photograph on a canvas, with its marks drawn in when there are any, no larger than `maxSide`. */
export async function renderPhoto(photo: Blob, annotations: Annotation[] | undefined, maxSide = Infinity): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(photo);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (annotations?.length) drawAnnotations(ctx, annotations, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/**
 * Copy a photograph to the clipboard as a picture, ready to paste into a letter or the notes.
 * `load` is not awaited before the clipboard is asked: the browser only allows a copy that
 * starts inside the click or key press that asked for it.
 */
export function copyPhotoToClipboard(load: () => Promise<{ photo: Blob; annotations?: Annotation[] }>): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    return Promise.reject(new Error('This browser can’t copy pictures. Use Chrome or Edge.'));
  }
  const png = load().then(async ({ photo, annotations }) => canvasBlob(await renderPhoto(photo, annotations, CLIPBOARD_MAX), 'image/png'));
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/* ───────── one-page PDF ───────── */

export interface SummarySource {
  capture: Capture;
  photo: Blob;
}

/** A PDF of one visit's photographs: up to six to a page, so usually a single page. */
export async function buildSummaryPdf(opts: { clinicName: string; patient: Patient; visitDate: string; sources: SummarySource[]; locale?: string; title: string }): Promise<Blob> {
  const paper = paperFor(opts.locale ?? navigator.language ?? 'en-GB');
  const rows = summaryRows(opts.sources);
  const pages: PdfPage[] = [];
  const printedAt = new Date();
  const count = Math.ceil(rows.length / SUMMARY_ROWS_PER_PAGE);
  for (let page = 0; page < count; page++) {
    const places = rows.slice(page * SUMMARY_ROWS_PER_PAGE, (page + 1) * SUMMARY_ROWS_PER_PAGE).flat();
    // A single photograph has the page to itself.
    const onPage = opts.sources.length === 1 ? places.filter(Boolean) : places;
    const cells: (SummaryPhoto | null)[] = [];
    for (const s of onPage) {
      if (!s) {
        cells.push(null);
        continue;
      }
      // No photo needs more pixels than its place on the page can show.
      const canvas = await renderPhoto(s.photo, s.capture.annotations, 1800);
      cells.push({ capture: s.capture, image: canvas, width: canvas.width, height: canvas.height });
    }
    const sheet = document.createElement('canvas');
    drawSummaryPage(sheet, { clinicName: opts.clinicName, patient: opts.patient, visitDate: opts.visitDate, cells, ...paper, printedAt, pageLabel: count > 1 ? `${page + 1} of ${count}` : undefined });
    const jpeg = new Uint8Array(await (await canvasBlob(sheet, 'image/jpeg', 0.9)).arrayBuffer());
    pages.push({ jpeg, width: sheet.width, height: sheet.height });
  }
  return new Blob([buildPdf(pages, { ...paper, title: opts.title, created: printedAt }) as BlobPart], { type: 'application/pdf' });
}

/* ───────── DICOM ───────── */

/**
 * The photograph as the JPEG a DICOM file carries. A stored JPEG that is already suitable is used
 * exactly as it is (no quality is lost); anything else (WebP, PNG, a rotated or progressive JPEG,
 * or a copy with marks) is drawn and saved as a high-quality JPEG.
 */
export async function jpegForDicom(photo: Blob, capture: Pick<Capture, 'width' | 'height'>, annotations?: Annotation[]): Promise<Uint8Array> {
  if (!annotations?.length && photo.type === 'image/jpeg') {
    const bytes = new Uint8Array(await photo.arrayBuffer());
    try {
      const info = readJpegInfo(bytes);
      const sequential = info.frame === 0xc0 || info.frame === 0xc1;
      if (sequential && info.precision === 8 && info.width === capture.width && info.height === capture.height) return bytes;
    } catch {
      /* fall through and redraw it */
    }
  }
  const canvas = await renderPhoto(photo, annotations);
  return new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', 0.95)).arrayBuffer());
}

export interface DicomSource {
  capture: Capture;
  photo: Blob;
  patient: Patient;
  visit: Visit;
  /** The photo's place among all the photos of its visit, in the order taken, counting from 1. */
  rank: number;
}

/** Each photo's place within its visit, in the order taken (so its DICOM number is the same whenever it is exported). */
export function ranksWithinVisits(captures: Pick<Capture, 'id' | 'visitId' | 'takenAt'>[]): Map<string, number> {
  const ranks = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const c of [...captures].sort((a, b) => a.takenAt - b.takenAt)) {
    const n = (seen.get(c.visitId) ?? 0) + 1;
    seen.set(c.visitId, n);
    ranks.set(c.id, n);
  }
  return ranks;
}

/**
 * DICOM files for a set of photographs: each original, and for a photo with marks a second,
 * derived image with the marks drawn in. An original is numbered 2n − 1 and its marked copy 2n,
 * where n is its place in the visit.
 */
export async function buildDicomFiles(sources: DicomSource[], clinicName: string, onProgress?: (done: number, total: number) => void): Promise<{ name: string; visitDate: string; data: Blob }[]> {
  const out: { name: string; visitDate: string; data: Blob }[] = [];
  const ordered = [...sources].sort((a, b) => a.capture.takenAt - b.capture.takenAt);
  let done = 0;
  for (const s of ordered) {
    const base = { patient: s.patient, visit: s.visit, capture: s.capture, clinicName };
    const original = await buildDicom({ ...base, jpeg: await jpegForDicom(s.photo, s.capture), instanceNumber: s.rank * 2 - 1 });
    out.push({ name: dicomFileName(s.patient, s.capture), visitDate: s.visit.date, data: new Blob([original as BlobPart], { type: 'application/dicom' }) });
    if (s.capture.annotations?.length) {
      const marked = await buildDicom({ ...base, jpeg: await jpegForDicom(s.photo, s.capture, s.capture.annotations), instanceNumber: s.rank * 2, annotated: true });
      out.push({ name: dicomFileName(s.patient, s.capture, true), visitDate: s.visit.date, data: new Blob([marked as BlobPart], { type: 'application/dicom' }) });
    }
    onProgress?.(++done, ordered.length);
  }
  return out;
}
