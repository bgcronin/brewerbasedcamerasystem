/** Searching the whole photo library: by diagnosis, patient, hospital number, note, eye or date. */
import { diagnosisSearchText, fold, sameDiagnosis } from './diagnoses';
import { fromISODate, todayISO, addDays } from './dates';
import { techniqueLabel, type Capture, type Patient } from './types';

export type LibraryPeriod = 'any' | '30d' | '12m' | `${number}`;

export interface LibraryQuery {
  text: string;
  eye: 'all' | 'OD' | 'OS';
  starred: boolean;
  annotated: boolean;
  period: LibraryPeriod;
  /** Exact diagnosis filter chosen from the chips. */
  diagnosis: string | null;
}

export const EMPTY_QUERY: LibraryQuery = { text: '', eye: 'all', starred: false, annotated: false, period: 'any', diagnosis: null };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const hayCache = new WeakMap<Capture, { patient: Patient | undefined; hay: string }>();

/** Everything a photo can be found by, folded for accent- and spelling-insensitive matching. */
function haystack(c: Capture, patient: Patient | undefined): string {
  const cached = hayCache.get(c);
  if (cached && cached.patient === patient) return cached.hay;
  const d = fromISODate(c.date);
  const parts = [
    patient?.lastName,
    patient?.firstName,
    patient?.mrn,
    patient?.mrn?.replace(/\s+/g, ''),
    ...(c.diagnoses ?? []).map(diagnosisSearchText),
    c.note,
    techniqueLabel(c.technique),
    c.eye,
    c.eye === 'OD' ? 'right' : c.eye === 'OS' ? 'left' : 'both',
    c.date,
    String(d.getFullYear()),
    MONTHS[d.getMonth()],
    c.annotations?.length ? 'annotated' : '',
    c.starred ? 'starred' : '',
  ];
  const hay = ' ' + parts.filter(Boolean).map((p) => fold(String(p))).join(' ') + ' ';
  hayCache.set(c, { patient, hay });
  return hay;
}

function periodStart(period: LibraryPeriod): { from?: string; to?: string } {
  const today = todayISO();
  if (period === '30d') return { from: addDays(today, -30) };
  if (period === '12m') return { from: addDays(today, -365) };
  if (/^\d{4}$/.test(period)) return { from: `${period}-01-01`, to: `${period}-12-31` };
  return {};
}

/** Every word typed must match something about the photo or its patient. Words match at the start of a word. */
export function searchCaptures(captures: Capture[], patients: Map<string, Patient>, q: LibraryQuery): Capture[] {
  const tokens = fold(q.text).split(' ').filter(Boolean);
  const { from, to } = periodStart(q.period);
  const out = captures.filter((c) => {
    if (q.eye !== 'all' && c.eye !== q.eye && c.eye !== 'OU') return false;
    if (q.starred && !c.starred) return false;
    if (q.annotated && !c.annotations?.length) return false;
    if (from && c.date < from) return false;
    if (to && c.date > to) return false;
    if (q.diagnosis && !(c.diagnoses ?? []).some((d) => sameDiagnosis(d, q.diagnosis!))) return false;
    if (!tokens.length) return true;
    const hay = haystack(c, patients.get(c.patientId));
    // Words match from the start of a word; anything with a digit (part of an MRN, a year) may match mid-word.
    return tokens.every((t) => (/\d/.test(t) ? hay.includes(t) : hay.includes(' ' + t)));
  });
  return out.sort((a, b) => b.takenAt - a.takenAt);
}

export interface DiagnosisCount {
  name: string;
  photos: number;
  patients: number;
}

/** How often each diagnosis has been used, most patients first. */
export function diagnosisCounts(captures: Capture[]): DiagnosisCount[] {
  const map = new Map<string, { name: string; photos: number; patients: Set<string> }>();
  for (const c of captures) {
    for (const d of c.diagnoses ?? []) {
      const key = fold(d);
      let e = map.get(key);
      if (!e) map.set(key, (e = { name: d, photos: 0, patients: new Set() }));
      e.photos++;
      e.patients.add(c.patientId);
    }
  }
  return [...map.values()]
    .map((e) => ({ name: e.name, photos: e.photos, patients: e.patients.size }))
    .sort((a, b) => b.patients - a.patients || b.photos - a.photos || a.name.localeCompare(b.name));
}

export interface PatientGroup {
  patientId: string;
  captures: Capture[];
  latest: number;
}

/** Group results by patient, most recently photographed first; photos within a patient oldest → newest by visit. */
export function groupByPatient(captures: Capture[]): PatientGroup[] {
  const map = new Map<string, PatientGroup>();
  for (const c of captures) {
    let g = map.get(c.patientId);
    if (!g) map.set(c.patientId, (g = { patientId: c.patientId, captures: [], latest: 0 }));
    g.captures.push(c);
    g.latest = Math.max(g.latest, c.takenAt);
  }
  const groups = [...map.values()];
  for (const g of groups) g.captures.sort((a, b) => b.takenAt - a.takenAt);
  return groups.sort((a, b) => b.latest - a.latest);
}
