import { parseDelimited } from '../csv';
import type { ImportResult, WorklistImporter } from './types';

export * from './types';
export * from './mapping';

const ext = (f: File) => f.name.toLowerCase().split('.').pop() ?? '';

/** CSV / TSV / text exports from a PAS, EMR or Excel. */
export const delimitedImporter: WorklistImporter = {
  id: 'csv',
  label: 'CSV or spreadsheet export',
  description: 'Comma, semicolon or tab separated. Save Excel lists as CSV.',
  accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain',
  matches: (f) => ['csv', 'tsv', 'txt'].includes(ext(f)) || f.type === 'text/csv',
  async read(file): Promise<ImportResult> {
    const text = await readText(file);
    return { kind: 'table', table: { rows: parseDelimited(text) }, sourceName: file.name };
  },
};

/** A JSON array of flat objects, e.g. from an EMR report or a script. Keys become columns. */
export const jsonImporter: WorklistImporter = {
  id: 'json',
  label: 'JSON list',
  description: 'An array of objects, one per patient.',
  accept: '.json,application/json',
  matches: (f) => ext(f) === 'json' || f.type === 'application/json',
  async read(file): Promise<ImportResult> {
    const data = JSON.parse(await file.text());
    const list: Record<string, unknown>[] = Array.isArray(data) ? data : Array.isArray(data?.patients) ? data.patients : [];
    const keys = [...new Set(list.flatMap((o) => Object.keys(o ?? {})))];
    const rows = [keys, ...list.map((o) => keys.map((k) => (o?.[k] == null ? '' : String(o[k]))))];
    return { kind: 'table', table: { rows }, sourceName: file.name };
  },
};

const IMAGE_TYPES = /^image\/(png|jpeg|webp)$/;
const isImage = (f: File) => ['png', 'jpg', 'jpeg', 'webp'].includes(ext(f)) || IMAGE_TYPES.test(f.type);

/** A printed list: PDF (its own text, or OCR for scans), or a photo / scan as PNG, JPEG or WebP. Read entirely on this computer. */
export const scanImporter: WorklistImporter = {
  id: 'scan',
  label: 'PDF, scan or photo of the printed list',
  description: 'Read on this computer; nothing is uploaded.',
  accept: '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp',
  matches: (f) => ext(f) === 'pdf' || f.type === 'application/pdf' || isImage(f),
  async read(file, onProgress, signal): Promise<ImportResult> {
    const { scanList } = await import('./scan');
    const r = await scanList(file, onProgress, signal);
    return {
      kind: 'table',
      table: { rows: r.rows },
      sourceName: file.name,
      source: 'scan',
      reading: { rows: r.readings, hasHeader: r.hasHeader, mapping: r.mapping, how: r.how, warnings: r.warnings, notUsed: r.notUsed, pagesNotRead: r.pagesNotRead },
    };
  },
};

/**
 * Registered importers, tried in order. To add a new source (HL7 SIU/ORM,
 * FHIR Appointment bundles, a direct EMR feed), implement WorklistImporter
 * and add it here — the import sheet picks it up automatically.
 */
export const IMPORTERS: WorklistImporter[] = [delimitedImporter, jsonImporter, scanImporter];

export function importerFor(file: File): WorklistImporter | undefined {
  return IMPORTERS.find((i) => i.matches(file));
}

export const ACCEPT_ALL = IMPORTERS.map((i) => i.accept).join(',');

/**
 * Files dropped anywhere on the window. A picture there is a photograph for
 * the selected patient, as it always was; only a document (PDF, CSV, TSV,
 * JSON) opens the list import. A photo of a printed list goes to the import
 * sheet's own drop zone, where it cannot be mistaken for a photo of an eye.
 */
export function routeDroppedFiles(files: File[]): { list?: File; photos: File[] } {
  const photos = files.filter((f) => isImage(f) || /^image\//.test(f.type));
  const list = files.find((f) => !photos.includes(f) && importerFor(f));
  return { list, photos };
}

/** UTF-16 by BOM, or by the NUL in every other byte that ASCII text has in UTF-16LE (Excel "Unicode Text" saves). */
function detectUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const head = bytes.subarray(0, Math.min(64, bytes.length) & ~1);
  if (head.length < 4) return undefined;
  for (let i = 0; i < head.length; i += 2) {
    if (head[i] === 0 || head[i + 1] !== 0) return undefined;
  }
  return 'utf-16le';
}

/** Reads text as UTF-16, UTF-8, or Windows-1252 for legacy exports that are neither. */
export async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf16 = detectUtf16(new Uint8Array(buf));
  if (utf16) return new TextDecoder(utf16).decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function tableFromPastedText(text: string): ImportResult {
  return { kind: 'table', table: { rows: parseDelimited(text) }, sourceName: 'Pasted list' };
}
