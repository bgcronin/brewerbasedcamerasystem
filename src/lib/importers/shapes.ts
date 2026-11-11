/**
 * What a piece of text on a clinic list looks like: a time, a date, a hospital
 * number, a sex, a phone number. Nothing here decides which column is which;
 * it only answers "could this cell be an X?", so the table reader can vote
 * down each column and check each row against the rest.
 */
import { parseDate, parseTime, todayISO, type DateOrderResolved } from '../dates';

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DATE_SRC = [
  String.raw`\d{4}-\d{2}-\d{2}`,
  String.raw`\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}`,
  String.raw`\d{1,2}(?:st|nd|rd|th)?[ \-]${MONTH}\.?[ \-,]+\d{2,4}`,
  String.raw`${MONTH}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}`,
].join('|');
const DATE_ANY = new RegExp(String.raw`(?<![\p{L}\d/.\-|])(?:${DATE_SRC})(?![\p{L}\d/\-])`, 'giu');
const DATE_WHOLE = new RegExp(`^(?:${DATE_SRC})$`, 'i');
/** A numeric date in which OCR may have read some digits as letters: 12/O3/1956, l2/03/19S6. */
const DATE_DAMAGED = /^[\dOoIl|SsBbZz]{1,2}[/.\-][\dOoIl|SsBbZz]{1,2}[/.\-][\dOoIl|SsBbZz]{2,4}$/;

const TIME_SRC = String.raw`\d{1,2}[:h]\d{2}(?::\d{2})?(?: ?[ap]\.?m\.?)?|\d{1,2}\.\d{2}(?: ?[ap]\.?m\.?)|\d{1,2} ?[ap]\.?m\.?`;
const TIME_ANY = new RegExp(String.raw`(?<![\d/.\-:])(?:${TIME_SRC})(?![\d/\-:]|\.\d)`, 'gi');
const TIME_RANGE = new RegExp(String.raw`^(\d{1,2}[:.h]\d{2}(?: ?[ap]\.?m\.?)?)\s*[-–—]\s*\d{1,2}[:.h]\d{2}(?: ?[ap]\.?m\.?)?$`, 'i');

/** One token: an optional short letter prefix joined directly (or by a hyphen or slash) to a run of digits. */
const MRN_ANY = /(?<![A-Za-z0-9/\-.])(?:[A-Za-z]{1,4}[-/]?\d{4,12}[A-Za-z]{0,2}|\d{5,12}[A-Za-z]{0,2}|\d{3} \d{3} \d{4}|\d{2,4}[/\-]\d{4,8})(?![A-Za-z0-9/\-]|\.\d)/g;
const SEX = /^(m|f|male|female|u|unknown)$/i;

export function isSexCell(s: string): boolean {
  return SEX.test(s.trim());
}

/** The clock time a cell holds, also for "09:30 - 09:45" (the start) and "2pm". */
export function readTime(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  const direct = parseTime(s);
  if (direct) return direct;
  const range = s.match(TIME_RANGE);
  if (range) return parseTime(range[1]);
  return undefined;
}

export function isTimeCell(s: string): boolean {
  const t = s.trim();
  if (!t || DATE_WHOLE.test(t)) return false;
  // A bare "0930" is a time only by its column; on its own it is just a number.
  if (/^\d+$/.test(t)) return false;
  return !!readTime(t);
}

export function isDateCell(s: string): boolean {
  const t = s.trim();
  return DATE_WHOLE.test(t) && !!parseDate(t, 'DMY');
}

export function isDamagedDate(s: string): boolean {
  const t = s.trim();
  return !DATE_WHOLE.test(t) && DATE_DAMAGED.test(t) && /\d/.test(t);
}

/** Digits with the punctuation phones are written with, starting 0 or +: 087 123 4567, +353 1 234 5678. */
export function isPhoneLike(s: string): boolean {
  const t = s.trim();
  if (!/^[+(]?[\d ()\-]+$/.test(t)) return false;
  const digits = t.replace(/\D/g, '');
  return (t.startsWith('+') || digits.startsWith('0')) && digits.length >= 9 && digits.length <= 14;
}

/**
 * Could this cell be a hospital number? Deliberately loose: a few letters and
 * at least four digits, nothing that reads as a date or a time.
 */
export function isMrnCell(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 18 || isDateCell(t) || isTimeCell(t)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-/]*$/.test(t)) return false;
  const digits = t.replace(/\D/g, '').length;
  const letters = t.replace(/[^A-Za-z]/g, '').length;
  return digits >= 4 && letters <= 6 && digits >= letters;
}

/** H100234 → A999999; 485 777 3456 → 9999999999. Spacing is not part of the shape. */
export function mrnShape(s: string): string {
  return s.trim().replace(/\s+/g, '').replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9');
}

/** "H100234" for A999999, used to tell the user what the others look like. */
export interface MrnPattern {
  shape: string;
  example: string;
  share: number;
}

/** The shape most hospital numbers on this list share, if there is one. */
export function dominantMrnShape(values: string[]): MrnPattern | undefined {
  const cells = values.map((v) => v.trim()).filter(Boolean);
  if (cells.length < 3) return undefined;
  const counts = new Map<string, { n: number; example: string }>();
  for (const c of cells) {
    const shape = mrnShape(c);
    const e = counts.get(shape);
    if (e) e.n++;
    else counts.set(shape, { n: 1, example: c });
  }
  const [shape, best] = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (best.n < 3 || best.n / cells.length < 0.6 || !/9/.test(shape)) return undefined;
  return { shape, example: best.example, share: best.n / cells.length };
}

const LOOKALIKE: Record<string, string> = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };

/**
 * OCR reads 0 as O, 1 as l or I, 5 as S. Repair those, but only where a digit
 * is certain: against the shape the other numbers on the list have, or, with no
 * such shape, inside the run of digits after the letter prefix. The prefix is
 * never touched. Returns undefined when nothing needed repair or nothing safe
 * could be done.
 */
export function repairMrn(raw: string, pattern?: MrnPattern): string | undefined {
  const t = raw.trim().replace(/\s+/g, '');
  if (!t) return undefined;
  if (pattern) {
    if (mrnShape(t) === pattern.shape || t.length !== pattern.shape.length) return undefined;
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const want = pattern.shape[i];
      const ch = t[i];
      if (want === '9' && !/\d/.test(ch)) {
        const fix = LOOKALIKE[ch];
        if (!fix) return undefined;
        out += fix;
      } else if (want === 'A' && !/[A-Za-z]/.test(ch)) return undefined;
      else if (want !== '9' && want !== 'A' && want !== ch) return undefined;
      else out += ch;
    }
    return out === t ? undefined : out;
  }
  // No shape to go by. A look-alike with digits on both sides is inside the number and can only be a digit;
  // one next to the letters at the front might be part of the prefix, so it is left alone (see `doubtfulMrn`).
  const first = t.search(/\d/);
  const last = t.length - 1 - [...t].reverse().findIndex((c) => /\d/.test(c));
  if (first < 0 || last <= first) return undefined;
  const middle = t.slice(first, last + 1);
  if (!/^[\dOoQDIl|!SsBZz]+$/.test(middle) || /^\d+$/.test(middle)) return undefined;
  return t.slice(0, first) + [...middle].map((c) => LOOKALIKE[c] ?? c).join('') + t.slice(last + 1);
}

/**
 * A number OCR may have got wrong in a way that cannot be put right without
 * guessing: a lower-case l or o, or a look-alike letter between the prefix and
 * the digits (is "HlO2874" H-1-0-2874, or a prefix "HLO"?).
 */
export function doubtfulMrn(raw: string): boolean {
  const t = raw.trim().replace(/\s+/g, '');
  const first = t.search(/\d/);
  if (first < 0) return false;
  const lead = t.slice(0, first);
  return /[lo|!]/.test(t) || (lead.length > 1 && /[OoQDIl|SsBZz]$/.test(lead)) || /[OoQDIl|SsBZz]/.test(t.slice(first).replace(/[A-Za-z]{1,2}$/, ''));
}

/** Repair a numeric date OCR damaged (12/O3/1956). Undefined when it was fine or cannot be repaired. */
export function repairDate(raw: string): string | undefined {
  const t = raw.trim();
  if (!isDamagedDate(t)) return undefined;
  const fixed = [...t].map((c) => (/[/.\-\d]/.test(c) ? c : LOOKALIKE[c] ?? c)).join('');
  return fixed !== t && isDateCell(fixed) ? fixed : undefined;
}

export type AnchorKind = 'time' | 'date' | 'mrn';
export interface Anchor {
  kind: AnchorKind;
  text: string;
  start: number;
  end: number;
}

/**
 * Every date, time and hospital-number-shaped token in a piece of text, in
 * order. Tokens never bridge a gap: a number takes a letter prefix only when
 * the two are written together.
 */
export function findAnchors(text: string, ocr = false): Anchor[] {
  const found: Anchor[] = [];
  let masked = text;
  const take = (re: RegExp, kind: AnchorKind, ok: (s: string) => boolean = () => true) => {
    for (const m of masked.matchAll(re)) {
      if (!ok(m[0])) continue;
      found.push({ kind, text: m[0], start: m.index, end: m.index + m[0].length });
    }
    for (const a of found) masked = masked.slice(0, a.start) + ' '.repeat(a.end - a.start) + masked.slice(a.end);
  };
  take(DATE_ANY, 'date', (s) => !!parseDate(s, 'DMY'));
  take(TIME_ANY, 'time', (s) => !!parseTime(s));
  take(MRN_ANY, 'mrn');
  if (ocr) {
    // A date OCR broke with look-alike letters: 12/O3/1956, l2/03/1988.
    for (const m of masked.matchAll(/(?<![A-Za-z0-9/.\-])[\dOoIl|SsBbZz]{1,2}[/.\-][\dOoIl|SsBbZz]{1,2}[/.\-][\dOoIl|SsBbZz]{2,4}(?![A-Za-z0-9/\-])/g)) {
      if (!/\d/.test(m[0])) continue;
      found.push({ kind: 'date', text: m[0], start: m.index, end: m.index + m[0].length });
      masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
    }
    // A number OCR broke with look-alike letters: H1OO234, HlO2874.
    for (const m of masked.matchAll(/(?<![A-Za-z0-9])[A-Za-z]{0,4}[\dOoQDIl|SsBZz]{5,12}(?![A-Za-z0-9])/g)) {
      if (/\d{2}/.test(m[0]) && (m[0].match(/\d/g) ?? []).length >= 3 && !/^[A-Za-z]+$/.test(m[0])) found.push({ kind: 'mrn', text: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Lines that are part of the page, never a patient. Anchored: "Review - total LSCD" is not one of these. */
const FURNITURE = [
  /^page \d+( of \d+)?\b/i,
  /^\d+ of \d+$/i,
  /^-? ?\d+ ?-?$/,
  /^printed\b/i,
  /^print date\b/i,
  /^run (date|time)\b/i,
  /^(report )?generated\b/i,
  /^\d+ (patients?|appointments?|records?)\b/i,
  /^total\b[:\s]*\d+/i,
  /^(strictly )?(private and )?confidential\b/i,
  /^end of (list|report|clinic)\b/i,
  /^\*+ ?end of/i,
  /^continued\b/i,
];

export function isFurniture(text: string): boolean {
  const t = text.trim();
  return FURNITURE.some((re) => re.test(t));
}

/** Nothing but ruling characters or punctuation. */
export function isRuleOnly(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

export interface BirthDateReading {
  iso?: string;
  /** Why this date cannot be taken at face value, in plain words. */
  problem?: string;
  /** A problem that leaves the date unusable (as opposed to one that needs a second look). */
  unusable?: boolean;
}

function localYear(): number {
  return Number(todayISO().slice(0, 4));
}

/**
 * Read a date of birth and say what, if anything, is doubtful about it:
 * unreadable, in the future, an impossible age, or a two-digit year that could
 * be either century.
 */
export function readBirthDate(raw: string | undefined, order: DateOrderResolved): BirthDateReading {
  const s = (raw ?? '').trim();
  if (!s) return {};
  const iso = parseDate(s, order, true);
  if (!iso) return { problem: `The date of birth “${s}” couldn’t be read`, unusable: true };
  const today = todayISO();
  if (iso > today) return { problem: `The date of birth ${s} is in the future`, unusable: true };
  const year = Number(iso.slice(0, 4));
  if (localYear() - year > 120) return { problem: `The date of birth ${s} would make this patient over 120`, unusable: true };
  const twoDigit = s.match(/^\d{1,2}[/.\-]\d{1,2}[/.\-](\d{2})$/) ?? s.match(/^\d{1,2}[ \-][A-Za-z]{3,9}\.?[ \-,]+(\d{2})$/);
  if (twoDigit && year >= 2000 && localYear() - (year - 100) <= 120) {
    return { iso, problem: `The year “${twoDigit[1]}” could be ${year - 100} or ${year}; it was read as ${year}` };
  }
  return { iso };
}

/** A date close to today is the clinic or print date, not somebody's birthday. */
export function isRecentDate(iso: string, days = 60): boolean {
  const t = new Date(todayISO()).getTime();
  const d = new Date(iso).getTime();
  return Math.abs(t - d) <= days * 86400000;
}
