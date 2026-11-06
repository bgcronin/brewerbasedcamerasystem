/** Date and time helpers. All "ISO dates" here are local calendar dates: YYYY-MM-DD. */

export type DateOrderResolved = 'DMY' | 'MDY' | 'YMD';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function fromISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function validYMD(y: number, m: number, d: number): boolean {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1850 && y <= 2200)) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function expandYear(y: number, pivotToPast: boolean): number {
  if (y >= 100) return y;
  const now = new Date().getFullYear();
  const century = Math.floor(now / 100) * 100;
  let full = century + y;
  // Two-digit years: for birth dates anything in the future belongs to the previous century.
  if (pivotToPast ? full > now : full > now + 20) full -= 100;
  return full;
}

/** Guess the day/month order used by a column of date strings, with the vote counts so callers can tell an ambiguous column. */
export function inferDateOrderDetailed(
  values: string[],
  fallback: DateOrderResolved = 'DMY',
): { order: DateOrderResolved; votes: { dmy: number; mdy: number } } {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = v.trim().match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  const order: DateOrderResolved = dmy > mdy ? 'DMY' : mdy > dmy ? 'MDY' : fallback;
  return { order, votes: { dmy, mdy } };
}

/** UK/Irish clinics: when the data cannot decide, assume day first. */
export function inferDateOrder(values: string[], fallback: DateOrderResolved = 'DMY'): DateOrderResolved {
  return inferDateOrderDetailed(values, fallback).order;
}

/**
 * Parse the many shapes dates arrive in from clinic systems.
 * Returns an ISO date, or undefined if the value is not recognisable.
 */
export function parseDate(raw: string | undefined, order: DateOrderResolved = 'DMY', isBirthDate = false): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;

  // ISO and ISO-like: 1956-03-12, 1956/03/12, 1956-03-12T00:00:00
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYMD(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : undefined;
  }

  // Compact 19560312
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validYMD(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // Numeric with separators: 12/03/1956, 3-12-56, 12.03.1956
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:\s|T|$)/);
  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    const y = expandYear(Number(m[3]), isBirthDate);
    let [d, mo] = order === 'MDY' ? [second, first] : [first, second];
    if (!validYMD(y, mo, d)) {
      // The order guess was wrong for this value (e.g. 25/12 in an MDY file); try the other way.
      [d, mo] = [mo, d];
      if (!validYMD(y, mo, d)) return undefined;
    }
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // Month names: 12 Mar 1956, 12-Mar-56, 12 March 1956, March 12, 1956, Mar 12 1956
  m = s.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
    const y = expandYear(Number(m[3]), isBirthDate);
    const d = Number(m[1]);
    if (mo && validYMD(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
    const y = expandYear(Number(m[3]), isBirthDate);
    const d = Number(m[2]);
    if (mo && validYMD(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // Excel serial day numbers (days since 1899-12-30). A bare four-digit value is a year, not a date,
  // unless it is a birth date below 1900 where no plausible year exists.
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    const plausible = serial >= 10000 ? serial < 80000 : isBirthDate && serial < 1900;
    if (serial > 1000 && plausible) {
      const base = new Date(1899, 11, 30);
      base.setDate(base.getDate() + serial);
      return toISODate(base);
    }
  }
  return undefined;
}

/** Parse a clock time into 24h HH:mm. Accepts 9:30, 09.30, 0930, 9:30 am, 14:15:00, and date-times. */
export function parseTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().toLowerCase();
  if (!s) return undefined;
  // If a date-time, keep the part after the date.
  const dt = s.match(/(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})[t\s]+(.+)$/);
  if (dt) s = dt[1];
  const m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?$/) ?? s.match(/^(\d{2})(\d{2})$/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.[0];
  if (ampm === 'p' && h < 12) h += 12;
  if (ampm === 'a' && h === 12) h = 0;
  if (!m[2] && !ampm) return undefined; // a bare number is not a time
  if (h > 23 || min > 59) return undefined;
  return `${pad(h)}:${pad(min)}`;
}

export function ageFromDOB(dob: string | undefined, on: Date = new Date()): number | undefined {
  if (!dob) return undefined;
  const d = fromISODate(dob);
  if (Number.isNaN(d.getTime())) return undefined;
  let age = on.getFullYear() - d.getFullYear();
  const beforeBirthday = on.getMonth() < d.getMonth() || (on.getMonth() === d.getMonth() && on.getDate() < d.getDate());
  if (beforeBirthday) age--;
  return age >= 0 && age < 130 ? age : undefined;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts);
    fmtCache.set(key, f);
  }
  return f;
}

/** 12 Mar 1956 */
export function formatShortDate(iso: string | undefined): string {
  if (!iso) return '';
  return fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(fromISODate(iso));
}

/** Tuesday 3 November */
export function formatDayHeading(iso: string): string {
  return fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(fromISODate(iso));
}

/** Tuesday 3 November 2026 */
export function formatLongDate(iso: string): string {
  return fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(fromISODate(iso));
}

/** 14:32 */
export function formatClock(ts: number): string {
  return fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

export function relativeDayLabel(iso: string): string {
  const today = todayISO();
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  return fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(fromISODate(iso));
}

/** Compact local timestamp for file names: 20261103_143205 */
export function fileStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
