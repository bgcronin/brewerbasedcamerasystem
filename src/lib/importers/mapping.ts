import { inferDateOrderDetailed, parseDate, parseTime, type DateOrderResolved } from '../dates';
import { normaliseNamePart, normaliseSex, splitFullName } from '../names';
import type { ImportedRecord, PatientField } from './types';

export const FIELD_LABELS: Record<PatientField, string> = {
  ignore: 'Ignore',
  mrn: 'Patient ID / MRN',
  fullName: 'Full name',
  firstName: 'First name',
  lastName: 'Surname',
  dob: 'Date of birth',
  sex: 'Sex',
  date: 'Appt date',
  time: 'Appt time',
  clinic: 'Clinic',
  clinician: 'Clinician',
  reason: 'Reason / type',
  notes: 'Notes',
};

export const FIELD_ORDER: PatientField[] = [
  'mrn', 'lastName', 'firstName', 'fullName', 'dob', 'sex', 'time', 'date', 'clinic', 'clinician', 'reason', 'notes', 'ignore',
];

const SYNONYMS: Record<Exclude<PatientField, 'ignore'>, string[]> = {
  mrn: [
    'mrn', 'mrn number', 'hospital number', 'hospital no', 'hosp no', 'hosp number', 'patient id', 'patientid', 'patient number',
    'patient no', 'pt id', 'pid', 'id', 'chart', 'chart number', 'chart no', 'record number', 'medical record number', 'medical record no',
    'nhs number', 'nhs no', 'ihi', 'pas number', 'pas no', 'urn', 'file number', 'file no', 'case number', 'case no', 'mr number', 'chi', 'chi number',
  ],
  fullName: ['name', 'patient name', 'patient', 'full name', 'patient full name', 'patients name', 'pt name', 'client', 'client name'],
  firstName: ['first name', 'firstname', 'forename', 'forenames', 'given name', 'given names', 'givenname', 'first', 'fname', 'christian name'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'familyname', 'last', 'lname', 'second name'],
  dob: ['dob', 'date of birth', 'birth date', 'birthdate', 'born', 'birthday', 'd o b'],
  sex: ['sex', 'gender', 'm f'],
  date: ['date', 'appointment date', 'appt date', 'clinic date', 'visit date', 'session date', 'attendance date'],
  time: ['time', 'appointment time', 'appt time', 'appt', 'appointment', 'slot', 'slot time', 'start time', 'start', 'booked time', 'arrival time'],
  clinic: ['clinic', 'clinic name', 'session', 'location', 'department', 'service', 'site', 'room', 'clinic code'],
  clinician: ['clinician', 'consultant', 'doctor', 'provider', 'physician', 'seen by', 'surgeon', 'optometrist', 'practitioner', 'responsible clinician'],
  reason: ['reason', 'appointment type', 'appt type', 'type', 'visit type', 'procedure', 'indication', 'referral reason', 'diagnosis', 'condition', 'pathway'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'additional info', 'info'],
};

export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[._\-/#:()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Synonyms too generic to match loosely on their own: "Last Visit" is not a surname column. */
const NO_LOOSE_MATCH = new Set(['last', 'first', 'second', 'id', 'pid', 'no']);

function scoreHeader(header: string, field: Exclude<PatientField, 'ignore'>): number {
  const h = normaliseHeader(header);
  if (!h) return 0;
  const syn = SYNONYMS[field];
  if (syn.includes(h)) return 100;
  // Loose matches: "Patient Surname", "Pt. DOB (dd/mm/yyyy)", "Appointment Start Time".
  const words = new Set(h.split(' '));
  let best = 0;
  for (const s of syn) {
    const sw = s.split(' ');
    if (sw.length > 1 && sw.every((w) => words.has(w))) best = Math.max(best, 60 + sw.length);
    else if (sw.length === 1 && s.length > 2 && !NO_LOOSE_MATCH.has(s) && words.has(s)) best = Math.max(best, 50);
  }
  if (field === 'dob' && /birth/.test(h)) best = Math.max(best, 70);
  if (field === 'lastName' && /surname/.test(h)) best = Math.max(best, 70);
  return best;
}

/** Does this row look like a header row rather than data? */
export function looksLikeHeader(row: string[]): boolean {
  let hits = 0;
  for (const cell of row) {
    for (const f of Object.keys(SYNONYMS) as Exclude<PatientField, 'ignore'>[]) {
      if (scoreHeader(cell, f) >= 50) {
        hits++;
        break;
      }
    }
  }
  return hits >= Math.min(2, row.filter((c) => c).length);
}

/** Map headers to fields, each field used at most once, best-scoring first. */
export function detectMapping(headers: string[]): PatientField[] {
  const candidates: { col: number; field: Exclude<PatientField, 'ignore'>; score: number }[] = [];
  headers.forEach((h, col) => {
    for (const f of Object.keys(SYNONYMS) as Exclude<PatientField, 'ignore'>[]) {
      const score = scoreHeader(h, f);
      if (score > 0) candidates.push({ col, field: f, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  const mapping: PatientField[] = headers.map(() => 'ignore');
  const used = new Set<string>();
  for (const c of candidates) {
    if (mapping[c.col] !== 'ignore' || used.has(c.field)) continue;
    mapping[c.col] = c.field;
    used.add(c.field);
  }
  // A plain "Date" column next to an explicit DOB column is the appointment date; without one it's ambiguous, so keep it.
  return mapping;
}

/** Hospital numbers: up to four letters, then digits, e.g. H100234, NHS 123 456 7890, 10234. */
const MRN_SHAPE = /^[A-Za-z]{0,4}[\s-]?\d{3,}[A-Za-z0-9\s-]*$/;

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** For files without a header row, guess from the values themselves. */
export function guessMappingFromValues(rows: string[][]): PatientField[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const mapping: PatientField[] = Array.from({ length: width }, () => 'ignore');
  const used = new Set<PatientField>();
  const pick = (col: number, f: PatientField) => {
    if (!used.has(f)) {
      mapping[col] = f;
      used.add(f);
    }
  };
  const sample = rows.slice(0, 30);
  const nameCols: { col: number; allCaps: boolean }[] = [];
  const dateCols: { col: number; year: number }[] = [];
  for (let col = 0; col < width; col++) {
    const vals = sample.map((r) => (r[col] ?? '').trim()).filter(Boolean);
    if (!vals.length) continue;
    const ratio = (pred: (v: string) => boolean) => vals.filter(pred).length / vals.length;
    const parsed = vals.map((v) => parseDate(v, 'DMY', true));
    const dates = parsed.filter((d): d is string => !!d);
    // Bare digit strings (10234, 20261103) are hospital numbers, not dates; a date column has separators.
    const datedWithSeparators = vals.filter((v, i) => parsed[i] && /[\s/.\-]/.test(v)).length / vals.length >= 0.8;
    if (ratio((v) => MRN_SHAPE.test(v)) >= 0.8 && !datedWithSeparators) pick(col, 'mrn');
    else if (ratio((v) => !!parseTime(v) && !parseDate(v)) >= 0.8) pick(col, 'time');
    else if (dates.length / vals.length >= 0.8) dateCols.push({ col, year: median(dates.map((d) => Number(d.slice(0, 4)))) });
    else if (ratio((v) => /^[mfu]$|^(male|female)$/i.test(v)) >= 0.8) pick(col, 'sex');
    else if (ratio((v) => /^[\p{L}'’\- ,.]+$/u.test(v) && v.length > 2) >= 0.8) {
      if (ratio((v) => v.includes(',')) >= 0.8) pick(col, 'fullName');
      else nameCols.push({ col, allCaps: ratio((v) => v === v.toUpperCase()) >= 0.8 });
    }
  }

  // Two plain name columns: "SMITH | John" is surname first, "John | Smith" is forename first.
  if (!used.has('fullName') && nameCols.length >= 2) {
    const [a, b] = nameCols;
    pick(a.col, a.allCaps ? 'lastName' : 'firstName');
    pick(b.col, a.allCaps ? 'firstName' : 'lastName');
  } else if (!used.has('fullName') && nameCols.length === 1) {
    pick(nameCols[0].col, 'fullName');
  }

  // Two date columns: the one with the older median year is the date of birth.
  const thisYear = new Date().getFullYear();
  if (dateCols.length === 1) pick(dateCols[0].col, 'dob');
  else if (dateCols.length >= 2) {
    const [older, newer] = [...dateCols].sort((a, b) => a.year - b.year);
    if (older.year <= thisYear - 15) {
      pick(older.col, 'dob');
      pick(newer.col, 'date');
    } else pick(dateCols[0].col, 'date');
  }
  return mapping;
}

export interface MappedImport {
  records: ImportedRecord[];
  skipped: number;
  dateOrder: DateOrderResolved;
  /** Auto order was requested but no value could decide day/month, so the DMY default was assumed. */
  dateOrderAmbiguous: boolean;
  datesInFile: string[];
}

export function applyMapping(
  dataRows: string[][],
  mapping: PatientField[],
  dateOrderPref: 'auto' | DateOrderResolved,
): MappedImport {
  const colOf = (f: PatientField) => mapping.indexOf(f);
  const get = (row: string[], f: PatientField) => {
    const i = colOf(f);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };

  const dateValues = [colOf('dob'), colOf('date')]
    .filter((i) => i >= 0)
    .flatMap((i) => dataRows.map((r) => r[i] ?? ''));
  const inferred = inferDateOrderDetailed(dateValues);
  const dateOrder: DateOrderResolved = dateOrderPref === 'auto' ? inferred.order : dateOrderPref;
  const hasNumericDate = dateValues.some((v) => /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/.test(v.trim()));
  const dateOrderAmbiguous = dateOrderPref === 'auto' && hasNumericDate && inferred.votes.dmy === 0 && inferred.votes.mdy === 0;

  const records: ImportedRecord[] = [];
  const dates = new Set<string>();
  let skipped = 0;

  for (const row of dataRows) {
    let firstName = normaliseNamePart(get(row, 'firstName'));
    let lastName = normaliseNamePart(get(row, 'lastName'));
    const full = get(row, 'fullName');
    if (full && (!firstName || !lastName)) {
      const split = splitFullName(full);
      firstName ||= split.firstName;
      lastName ||= split.lastName;
    } else if (!full && lastName && !firstName && lastName.includes(',')) {
      const split = splitFullName(lastName);
      firstName = split.firstName;
      lastName = split.lastName;
    }
    const mrn = get(row, 'mrn').replace(/\s+/g, ' ');
    if (!firstName && !lastName) {
      skipped++;
      continue;
    }
    const rawDate = get(row, 'date');
    const rawTime = get(row, 'time');
    // Combined "03/11/2026 09:30" values can sit in either column.
    const date = parseDate(rawDate, dateOrder) ?? (/\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}/.test(rawTime) ? parseDate(rawTime, dateOrder) : undefined);
    if (date) dates.add(date);
    const time = parseTime(rawTime) ?? (rawDate ? parseTime(rawDate) : undefined);
    records.push({
      mrn: mrn || undefined,
      firstName,
      lastName,
      dob: parseDate(get(row, 'dob'), dateOrder, true),
      sex: normaliseSex(get(row, 'sex')),
      date,
      time,
      clinic: get(row, 'clinic') || undefined,
      clinician: get(row, 'clinician') || undefined,
      reason: get(row, 'reason') || undefined,
      notes: get(row, 'notes') || undefined,
    });
  }
  return { records, skipped, dateOrder, dateOrderAmbiguous, datesInFile: [...dates].sort() };
}
