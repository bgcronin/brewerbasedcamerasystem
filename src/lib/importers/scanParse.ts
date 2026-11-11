/**
 * From the text found on a printed clinic list (PDF text items or OCR words,
 * with where each one sits on the page) to a table the import sheet can show:
 * the rows, what each column holds, and everything the reader was not sure of.
 *
 * The work is in scanTable.ts (rebuilding the table) and review.ts (deciding
 * the columns and noting doubts). No browser APIs here, so all of it is unit
 * tested.
 */
import { checkRows, decideColumns, noteReadingDoubts } from './review';
import { buildScanTable, type PageInput } from './scanTable';
import type { PatientField, RowReading } from './types';

export type { Box, PageInput } from './scanTable';

export interface ScanReading {
  /** The table, heading row first when the list had one. */
  rows: string[][];
  hasHeader: boolean;
  mapping: PatientField[];
  /** In step with `rows`. */
  readings: (RowReading | undefined)[];
  warnings: string[];
  notUsed: string[];
  /** Rows per page number, so a page that gave nothing can be tried another way. */
  rowsPerPage: Map<number, number>;
  /** Rows that read cleanly: a name, and nothing the reader doubted. */
  clean: number;
  /** Rows that need a person to check them before they can be imported. */
  toCheck: number;
  /** Lines that looked like part of the table but could not be laid out. */
  unread: number;
}

export function readScan(pages: PageInput[]): ScanReading {
  const table = buildScanTable(pages);
  const ocr = pages.some((p) => p.ocr);
  const { mapping, warnings } = decideColumns(table);
  noteReadingDoubts(table.rows, mapping, ocr);
  if (table.usedLineReading && table.rows.length) warnings.push('This list had no clear columns, so it was read line by line. Check the columns below.');

  const data = table.rows.map((r) => r.cells);
  const problems = checkRows(data, mapping, 'DMY');
  const flagged = table.rows.map((r, i) => r.issues.length > 0 || problems[i].length > 0);
  const readings: (RowReading | undefined)[] = table.rows.map((r) => ({ source: r.source, page: r.page, doubts: r.issues.map((i) => ({ col: i.col, reason: i.reason })), unread: r.unread || undefined }));
  const hasHeader = !!table.header;
  const clean = flagged.filter((f) => !f).length;
  // A picture that mostly could not be read should say so plainly, not offer the few rows that happened to come out.
  const lost = table.notUsed.filter((t) => (t.match(/\d/g) ?? []).length >= 4).length + table.rows.filter((r) => r.unread).length;
  if (ocr && table.rows.length + lost >= 3 && clean < (table.rows.length + lost) * 0.34) {
    warnings.unshift('Most of this picture couldn’t be read reliably. Photograph the list again from closer, flat and evenly lit, or use a PDF or CSV if you can.');
  }
  return {
    rows: hasHeader ? [table.header!, ...data] : data,
    hasHeader,
    mapping,
    readings: hasHeader ? [undefined, ...readings] : readings,
    warnings,
    notUsed: table.notUsed,
    rowsPerPage: table.rowsPerPage,
    clean,
    toCheck: flagged.filter(Boolean).length,
    unread: table.rows.filter((r) => r.unread).length,
  };
}

/** Plain lines with no positions (and the unit tests): read by the order of the dates, times and numbers on each line. */
export function readScannedLines(lines: (string | { text: string; confidence?: number })[], ocr = false): ScanReading {
  return readScan([{ page: 1, ocr, lines: lines.map((l) => (typeof l === 'string' ? { text: l } : { text: l.text, conf: l.confidence })) }]);
}
