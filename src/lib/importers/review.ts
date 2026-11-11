/**
 * Deciding what each column of a scanned table holds, and checking every row
 * against the rest of the list. The rule throughout: when the reader is not
 * sure, it says so and leaves the choice to the person importing.
 */
import type { DateOrderResolved } from '../dates';
import { parseDate, todayISO } from '../dates';
import { splitFullName } from '../names';
import { namesClearlyDiffer } from './identity';
import { detectMapping } from './mapping';
import type { ColKind, ScanRow, ScanTable } from './scanTable';
import { dominantMrnShape, doubtfulMrn, isRecentDate, mrnShape, readBirthDate, repairDate, repairMrn } from './shapes';
import type { PatientField } from './types';

const NAME_FIELDS: PatientField[] = ['fullName', 'lastName', 'firstName'];
const NAME_LIKE = /^\p{L}[\p{L}'’\-.]*(?:,? +\(?[\p{L}][\p{L}'’\-.]*\)?){0,4},?$/u;
/** Words that belong to an appointment type, not to a person. */
const CLINIC_WORDS = /\b(review|rev|new|follow[- ]?up|f\/u|post[- ]?op|pre[- ]?op|urgent|routine|clinic|cataract|cornea|corneal|graft|keratitis|keratoconus|glaucoma|retina|laser|injection|assessment|lens|eye|dry|ulcer|lesion|dna|cancelled|check|pressure|iop|yag|biometry|consult|referral|patient|appt|appointment)\b/i;

const median = (nums: number[]) => [...nums].sort((a, b) => a - b)[Math.floor(nums.length / 2)];

export interface ColumnDecision {
  mapping: PatientField[];
  /** Things the user should settle before importing, in plain words. */
  warnings: string[];
}

interface TextStats {
  col: number;
  nameShare: number;
  unique: number;
  clinic: number;
  comma: number;
  words: number;
  caps: number;
  n: number;
}

function textStats(col: number, values: string[]): TextStats {
  // As the name will be tidied: without the bullets, tick boxes and rule fragments around it.
  const v = values.map((x) => x.trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}.)]+$/u, '')).filter(Boolean);
  const n = v.length || 1;
  const share = (pred: (s: string) => boolean) => v.filter(pred).length / n;
  return {
    col,
    n: v.length,
    nameShare: share((s) => NAME_LIKE.test(s)),
    unique: new Set(v.map((s) => s.toLowerCase())).size / n,
    clinic: share((s) => CLINIC_WORDS.test(s)),
    comma: share((s) => s.includes(',')),
    words: v.reduce((a, s) => a + s.split(/[\s,]+/).filter(Boolean).length, 0) / n,
    caps: share((s) => s === s.toUpperCase() && /\p{L}/u.test(s)),
  };
}

/**
 * What each column holds: from the printed headings where there are any, and
 * otherwise from what the cells down each column look like. A field that could
 * be either of two columns is left unassigned, with a warning.
 */
export function decideColumns(table: Pick<ScanTable, 'kinds' | 'header' | 'rows'>): ColumnDecision {
  const k = table.kinds.length;
  const warnings: string[] = [];
  const mapping: PatientField[] = table.header ? detectMapping(table.header.concat(Array(Math.max(0, k - table.header.length)).fill(''))).slice(0, k) : Array.from({ length: k }, () => 'ignore');
  while (mapping.length < k) mapping.push('ignore');
  const good = table.rows.filter((r) => !r.unread);
  const column = (c: number) => good.map((r) => r.cells[c] ?? '');
  const has = (f: PatientField) => mapping.includes(f);
  const free = (c: number) => mapping[c] === 'ignore';
  const of = (kind: ColKind) => table.kinds.map((kd, c) => (kd === kind && free(c) ? c : -1)).filter((c) => c >= 0);

  // A heading that contradicts what is in its column is a misread heading: let the cells decide.
  mapping.forEach((f, c) => {
    const kd = table.kinds[c];
    const clash =
      (f === 'dob' && kd !== 'date' && kd !== 'empty') ||
      (f === 'mrn' && kd !== 'mrn' && kd !== 'empty') ||
      (f === 'time' && (kd === 'date' || kd === 'mrn')) ||
      (NAME_FIELDS.includes(f) && kd !== 'text' && kd !== 'empty');
    if (clash) mapping[c] = 'ignore';
  });

  if (!has('time') && of('time').length) mapping[of('time')[0]] = 'time';
  if (!has('sex') && of('sex').length) mapping[of('sex')[0]] = 'sex';

  if (!has('mrn')) {
    let cands = of('mrn');
    if (cands.length > 1) {
      // An NHS number sits beside the hospital number on many lists; the hospital number is the one Lumen files by.
      const nhs = cands.filter((c) => column(c).filter(Boolean).every((v) => mrnShape(v) === '9999999999'));
      if (nhs.length && nhs.length < cands.length) cands = cands.filter((c) => !nhs.includes(c));
    }
    if (cands.length === 1) mapping[cands[0]] = 'mrn';
    else if (cands.length > 1) warnings.push('More than one column looks like a hospital number. Choose which one it is.');
    else warnings.push('No column of hospital numbers was found. Without one, patients are matched by name and date of birth.');
  }

  const dates = of('date').map((c) => {
    const iso = column(c).map((v) => parseDate(v, 'DMY', true)).filter((d): d is string => !!d);
    // Dates around today, or still to come, are when the appointment is, not when anyone was born.
    const now = todayISO();
    return { c, year: iso.length ? median(iso.map((d) => Number(d.slice(0, 4)))) : 0, recent: iso.length > 0 && iso.filter((d) => d > now || isRecentDate(d, 400)).length / iso.length >= 0.8 };
  });
  const births = dates.filter((d) => !d.recent);
  const appts = dates.filter((d) => d.recent);
  if (!has('dob') && births.length) {
    const oldest = [...births].sort((a, b) => a.year - b.year)[0];
    mapping[oldest.c] = 'dob';
    if (births.length > 1) warnings.push('There is more than one column of dates. The oldest was taken as the date of birth; check it is the right one.');
  }
  if (!has('date') && appts.length) mapping[appts[0].c] = 'date';
  if (!has('dob')) warnings.push('No column of dates of birth was found.');

  if (!NAME_FIELDS.some(has)) {
    const stats = table.kinds.map((kd, c) => (kd === 'text' && free(c) ? textStats(c, column(c)) : undefined)).filter((s): s is TextStats => !!s && s.n > 0);
    const enough = good.length >= 4;
    // A name column has a name on most rows; a stray word in an otherwise empty column is not one.
    const names = stats.filter((s) => s.n >= good.length * 0.5 && s.nameShare >= 0.8 && s.clinic < 0.4 && (enough ? s.unique >= 0.7 : s.unique > 0.5 || s.n === 1));
    const single = (s: TextStats) => s.words < 1.5 && s.comma < 0.2;
    if (names.length === 1) mapping[names[0].col] = 'fullName';
    else if (names.length === 2 && names[1].col === names[0].col + 1 && single(names[1]) && (single(names[0]) || names[0].caps >= 0.8) && names[0].comma < 0.2) {
      // Surname and forename in their own columns. Capitals mark the surname; otherwise forename comes first.
      const [a, b] = names;
      const surnameFirst = a.caps >= 0.8 || (b.caps < 0.8 && !single(a));
      mapping[a.col] = surnameFirst ? 'lastName' : 'firstName';
      mapping[b.col] = surnameFirst ? 'firstName' : 'lastName';
    } else if (names.length >= 2) warnings.push('More than one column looks like a name. Choose which holds the patient’s name.');
    else warnings.push('Lumen couldn’t tell which column holds the patient’s name. Choose it above.');
  }

  if (!has('reason')) {
    const reason = table.kinds
      .map((kd, c) => (kd === 'text' && free(c) ? textStats(c, column(c)) : undefined))
      .filter((s): s is TextStats => !!s && s.n > 0)
      .find((s) => s.clinic >= 0.4);
    if (reason) mapping[reason.col] = 'reason';
  }
  return { mapping, warnings };
}

const FIELD_WORDS: Partial<Record<PatientField, string>> = { mrn: 'hospital number', dob: 'date of birth', fullName: 'name', lastName: 'surname', firstName: 'forename' };

/**
 * Tidy the cells and note what was uncertain about reading them. For OCR,
 * look-alike characters inside a number or a date are repaired, and every
 * repair is reported with what was printed. Runs once, on the reader's own
 * choice of columns.
 */
export function noteReadingDoubts(rows: ScanRow[], mapping: PatientField[], ocr: boolean): void {
  const mrnCol = mapping.indexOf('mrn');
  const dobCol = mapping.indexOf('dob');
  const nameCols = mapping.map((f, c) => (NAME_FIELDS.includes(f) ? c : -1)).filter((c) => c >= 0);
  const pattern = mrnCol >= 0 ? dominantMrnShape(rows.filter((r) => !r.unread).map((r) => r.cells[mrnCol] ?? '')) : undefined;
  for (const r of rows) {
    r.cells = r.cells.map((c) => c.replace(/\s+/g, ' ').replace(/^[|¦]+\s*|\s*[|¦]+$/g, '').trim());
    for (const c of nameCols) {
      // Bullets, tick boxes and bits of ruling line around a name are not part of it.
      r.cells[c] = r.cells[c].replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}.)]+$/u, '');
    }
    if (mrnCol >= 0) r.cells[mrnCol] = r.cells[mrnCol].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (dobCol >= 0) r.cells[dobCol] = r.cells[dobCol].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    // A line joined from below matters when it changed a name; in a notes column it is just more notes.
    r.issues = r.issues.filter((i) => !i.joined || (i.col != null && nameCols.includes(i.col)));
    if (!ocr) continue;
    if (mrnCol >= 0 && r.cells[mrnCol]) {
      const printed = r.cells[mrnCol];
      const fixed = repairMrn(printed, pattern);
      if (fixed) {
        r.cells[mrnCol] = fixed;
        r.issues.push({ col: mrnCol, reason: `The hospital number looked like “${printed}” and was read as ${fixed}` });
      } else if ((!pattern || mrnShape(printed) !== pattern.shape) && doubtfulMrn(printed)) {
        r.issues.push({ col: mrnCol, reason: `The hospital number “${printed}” may have a letter in it that is really a digit` });
      }
    }
    for (const c of nameCols) {
      if (/^[Il|] | [Il|]$/.test(r.cells[c])) r.issues.push({ col: c, reason: 'A ruling line may have been read as a letter at the edge of this name' });
    }
    if (dobCol >= 0 && r.cells[dobCol]) {
      const printed = r.cells[dobCol];
      const fixed = repairDate(printed);
      if (fixed) {
        r.cells[dobCol] = fixed;
        r.issues.push({ col: dobCol, reason: `The date of birth looked like “${printed}” and was read as ${fixed}` });
      }
    }
    for (const c of [mrnCol, dobCol, ...nameCols]) {
      if (c < 0 || !r.cells[c] || r.conf[c] == null) continue;
      // Clean print reads at 80 and over. Below these, a character may well be wrong.
      const limit = NAME_FIELDS.includes(mapping[c]) ? 60 : 70;
      if (r.conf[c]! < limit && !r.issues.some((i) => i.col === c)) r.issues.push({ col: c, reason: `The ${FIELD_WORDS[mapping[c]]} was hard to read` });
    }
  }
}

export interface RowProblem {
  col?: number;
  reason: string;
  /** The row cannot be imported at all until this is put right. */
  blocking?: boolean;
}

/**
 * Check each row against the columns chosen and against the other rows:
 * a name, a hospital number shaped like the rest, a date of birth that can be
 * read and is possible. Runs again whenever a cell or a column choice changes.
 */
export function checkRows(rows: string[][], mapping: PatientField[], order: DateOrderResolved): RowProblem[][] {
  const colOf = (f: PatientField) => mapping.indexOf(f);
  const mrnCol = colOf('mrn');
  const dobCol = colOf('dob');
  const get = (row: string[], f: PatientField) => (colOf(f) >= 0 ? (row[colOf(f)] ?? '').trim() : '');
  const nameOf = (row: string[]) => {
    const full = get(row, 'fullName');
    const split = full ? splitFullName(full) : { firstName: '', lastName: '' };
    return { firstName: get(row, 'firstName') || split.firstName, lastName: get(row, 'lastName') || split.lastName };
  };
  const pattern = mrnCol >= 0 ? dominantMrnShape(rows.map((r) => r[mrnCol] ?? '')) : undefined;
  const byMrn = new Map<string, number[]>();
  if (mrnCol >= 0) {
    rows.forEach((r, i) => {
      const key = (r[mrnCol] ?? '').replace(/\s+/g, '').toLowerCase();
      if (key) byMrn.set(key, [...(byMrn.get(key) ?? []), i]);
    });
  }
  const hasNameCol = NAME_FIELDS.some((f) => colOf(f) >= 0);
  const nameCol = ['fullName', 'lastName', 'firstName'].map((f) => colOf(f as PatientField)).find((c) => c >= 0);

  return rows.map((row, i) => {
    const out: RowProblem[] = [];
    const name = nameOf(row);
    if (hasNameCol && !name.firstName && !name.lastName) out.push({ col: nameCol, reason: 'No name was read', blocking: true });
    else if (hasNameCol) {
      const text = NAME_FIELDS.map((f) => get(row, f)).join(' ');
      if (/\d/.test(text)) out.push({ col: nameCol, reason: 'The name has a number in it' });
      else if ((text.match(/\p{L}/gu) ?? []).length < 2) out.push({ col: nameCol, reason: 'The name is very short' });
    }
    if (mrnCol >= 0) {
      const mrn = (row[mrnCol] ?? '').trim();
      if (!mrn) out.push({ col: mrnCol, reason: 'No hospital number was read' });
      else {
        if (pattern && mrnShape(mrn) !== pattern.shape) out.push({ col: mrnCol, reason: `The hospital number ${mrn} isn’t shaped like the others on this list (for example ${pattern.example})` });
        const twins = (byMrn.get(mrn.replace(/\s+/g, '').toLowerCase()) ?? []).filter((j) => j !== i);
        const clash = twins.find((j) => namesClearlyDiffer(name, nameOf(rows[j])));
        if (clash != null) out.push({ col: mrnCol, reason: `Another row has the same hospital number with a different name` });
      }
    }
    if (dobCol >= 0) {
      const raw = (row[dobCol] ?? '').trim();
      if (!raw) out.push({ col: dobCol, reason: 'No date of birth was read' });
      else {
        const read = readBirthDate(raw, order);
        if (read.problem) out.push({ col: dobCol, reason: read.problem });
      }
    }
    return out;
  });
}
