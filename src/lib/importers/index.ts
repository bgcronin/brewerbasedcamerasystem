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

/**
 * Registered importers, tried in order. To add a new source (HL7 SIU/ORM,
 * FHIR Appointment bundles, a direct EMR feed), implement WorklistImporter
 * and add it here — the import sheet picks it up automatically.
 */
export const IMPORTERS: WorklistImporter[] = [delimitedImporter, jsonImporter];

export function importerFor(file: File): WorklistImporter | undefined {
  return IMPORTERS.find((i) => i.matches(file));
}

export const ACCEPT_ALL = IMPORTERS.map((i) => i.accept).join(',');

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
