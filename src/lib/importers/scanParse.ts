/**
 * Turns the lines of a printed clinic list (from a PDF's text layer, or from
 * OCR of a scan or photo) into table rows the import sheet understands.
 *
 * Lists vary a lot between hospitals, so this works per line: it looks for a
 * date of birth, a hospital number and a time by their shape, and treats the
 * longest run of letters that is left as the patient's name. Lines with no
 * name and no number (titles, column headings, page footers) are dropped.
 */
import { parseDate, parseTime } from '../dates';

export interface ScannedRow {
  time?: string;
  mrn?: string;
  name?: string;
  dob?: string;
  sex?: string;
  /** Anything else on the line, usually the appointment type. */
  rest?: string;
  /** 0–1: how sure the reader was of this line (1 for PDF text). */
  confidence: number;
  /** Something looked off: no MRN, no DOB, or low OCR confidence. */
  flagged: boolean;
  line: string;
}

export interface ScannedLine {
  text: string;
  confidence?: number;
}

/** OCR columns are often separated by runs of spaces; PDF extraction marks gaps with tabs. */
const CELL_SPLIT = /\t+|\s{2,}|\s[|¦]\s/;
const DATE_TOKEN = /\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[\s\-]+[A-Za-z]{3,9}[\s\-,]+\d{2,4})\b/;
const TIME_TOKEN = /(?<![\d/.\-])(\d{1,2}[:.]\d{2})(?:\s?[ap]m)?(?![\d/.\-])/i;
/** Hospital numbers: a short letter prefix plus digits, or an NHS-style 10-digit number with optional spaces. */
const MRN_TOKEN = /\b([A-Z]{0,4}[-\s]?\d{5,10}|\d{3}\s\d{3}\s\d{4})\b/;
const SEX_TOKEN = /^(m|f|male|female)$/i;
const NAME_CHARS = /[\p{L}'’\-]/gu;
const HEADING_WORDS = /^(time|patient|name|surname|forename|dob|date of birth|hospital|mrn|no\.?|number|sex|gender|clinic|consultant|appointment|type|reason|page|printed|list|total|confidential)\b/i;
const CALENDAR_WORDS = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
/** Lines that are part of the page, never a patient. */
const PAGE_FURNITURE = /\b(printed|page\s+\d|confidential|total|continued)\b/i;
const CONFUSABLE = /[OoIl|SsBbZzQD]/;

/** OCR reads 0/O, 1/I/l and 5/S interchangeably; inside a number they can only be digits. */
export function fixDigits(token: string): string {
  const letters = token.replace(/[^A-Za-z]/g, '').length;
  const digits = token.replace(/[^0-9]/g, '').length;
  if (digits === 0 || letters > digits) return token;
  // Keep a short leading prefix of letters (the H in H100234), but a letter that
  // could be a misread digit (O, I, l, S…) belongs to the number, not the prefix.
  let i = 0;
  while (i < 4 && i < token.length && /[A-Za-z]/.test(token[i]) && !CONFUSABLE.test(token[i])) i++;
  const body = token.slice(i).replace(/[OoQD]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss]/g, '5').replace(/[Bb]/g, '8').replace(/[Zz]/g, '2');
  return token.slice(0, i).toUpperCase() + body;
}

function cleanName(raw: string): string {
  return raw
    .replace(/[^\p{L}'’\-,.\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
}

function looksLikeName(s: string): boolean {
  const t = s.trim();
  if (/\d/.test(t) || HEADING_WORDS.test(t)) return false;
  const words = t.split(/[\s,]+/).filter(Boolean);
  if (words.length < 2 && !t.includes(',')) return false; // "Tuesday", "Printed": not a patient
  if (words.every((w) => CALENDAR_WORDS.test(w))) return false;
  const letters = (t.match(NAME_CHARS) ?? []).length;
  return letters >= 3 && letters >= t.replace(/\s/g, '').length * 0.7;
}

/** Parse one line into its parts. */
export function parseScannedLine(line: ScannedLine): ScannedRow | null {
  let text = line.text.replace(/\s+$/, '');
  if (!text.trim() || PAGE_FURNITURE.test(text)) return null;
  const row: ScannedRow = { confidence: line.confidence == null ? 1 : Math.max(0, Math.min(1, line.confidence / 100)), flagged: false, line: text };

  // Dates first (so a DOB is never mistaken for an MRN), then times, then the hospital number.
  const d = text.match(DATE_TOKEN);
  if (d) {
    const iso = parseDate(fixDigits(d[1]).replace(/^[A-Z]+/, ''), 'DMY', true) ?? parseDate(d[1], 'DMY', true);
    // A date of birth is in the past; today's date on a list heading is not one.
    if (iso && iso < new Date().toISOString().slice(0, 10)) {
      row.dob = iso;
      text = text.replace(d[0], '  ');
    }
  }
  const t = text.match(TIME_TOKEN);
  if (t) {
    const hhmm = parseTime(t[0]);
    if (hhmm) {
      row.time = hhmm;
      text = text.replace(t[0], '  ');
    }
  }
  const m = text.match(MRN_TOKEN);
  if (m) {
    row.mrn = fixDigits(m[1]).replace(/\s+/g, ' ');
    text = text.replace(m[0], '  ');
  } else {
    // OCR may have turned digits into letters: look for a token that is mostly digits once fixed.
    const alt = text.split(/\s+/).find((w) => w.length >= 5 && /\d/.test(w) && /^[A-Za-z]{0,4}[0-9OoIl|SsBbZzQD]+$/.test(w) && fixDigits(w).replace(/\D/g, '').length >= 5);
    if (alt) {
      row.mrn = fixDigits(alt);
      text = text.replace(alt, '  ');
    }
  }

  // What remains: cells of letters. The best name candidate wins; the rest is kept as context.
  const cells: string[] = [];
  for (const raw of text.split(CELL_SPLIT).map((c) => c.trim()).filter(Boolean)) {
    // "M Pre-op cataract": a sex letter stuck to the next column when the list had single spaces.
    const sexPrefix = raw.match(/^([MF])\s+(\p{L}.*)$/u);
    if (sexPrefix) cells.push(sexPrefix[1], sexPrefix[2]);
    else cells.push(raw);
  }
  const nameCells = cells.filter(looksLikeName);
  const sexCell = cells.find((c) => SEX_TOKEN.test(c));
  if (sexCell) row.sex = sexCell[0].toUpperCase();
  if (nameCells.length) {
    // Prefer a cell with a comma ("SMITH, John"), then the one with the most capitals, then the longest.
    const score = (c: string) => (c.includes(',') ? 1000 : 0) + (c.match(/\p{Lu}/gu) ?? []).length * 3 + c.length;
    const best = [...nameCells].sort((a, b) => score(b) - score(a))[0];
    row.name = cleanName(best);
    const others = cells.filter((c) => c !== best && c !== sexCell);
    if (others.length) row.rest = others.join(' ');
  } else if (cells.length) {
    row.rest = cells.join(' ');
  }

  if (!row.name && !row.mrn) return null;
  if (row.name && !row.mrn && !row.dob) return null; // a title or a stray word, not a patient
  row.flagged = !row.name || !row.mrn || !row.dob || row.confidence < 0.75;
  return row;
}

export interface ScanParseResult {
  rows: string[][];
  parsed: ScannedRow[];
  skipped: number;
  flagged: number;
}

/** Parse all lines and shape them as a table with a heading row, ready for the import sheet. */
export function parseScannedLines(lines: ScannedLine[]): ScanParseResult {
  const parsed: ScannedRow[] = [];
  let skipped = 0;
  for (const l of lines) {
    const row = parseScannedLine(l);
    if (row) parsed.push(row);
    else if (l.text.trim()) skipped++;
  }
  const header = ['Time', 'Hospital No', 'Name', 'DOB', 'Sex', 'Notes'];
  const rows = [header, ...parsed.map((r) => [r.time ?? '', r.mrn ?? '', r.name ?? '', r.dob ?? '', r.sex ?? '', r.rest ?? ''])];
  return { rows, parsed, skipped, flagged: parsed.filter((r) => r.flagged).length };
}
