import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { namesClearlyDiffer } from './importers/identity';
import type { ImportedRecord } from './importers/types';
import { uid } from './id';
import type { Capture, Patient, StoredImage, Visit } from './types';

interface LumenDB extends DBSchema {
  patients: { key: string; value: Patient; indexes: { mrn: string } };
  visits: { key: string; value: Visit; indexes: { date: string; patientId: string; patientDate: [string, string] } };
  captures: { key: string; value: Capture; indexes: { patientId: string; visitId: string; date: string } };
  images: { key: string; value: StoredImage };
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<LumenDB>> | null = null;

export function db(): Promise<IDBPDatabase<LumenDB>> {
  dbPromise ??= openDB<LumenDB>('lumen', 1, {
    upgrade(d) {
      const p = d.createObjectStore('patients', { keyPath: 'id' });
      p.createIndex('mrn', 'mrn');
      const v = d.createObjectStore('visits', { keyPath: 'id' });
      v.createIndex('date', 'date');
      v.createIndex('patientId', 'patientId');
      v.createIndex('patientDate', ['patientId', 'date']);
      const c = d.createObjectStore('captures', { keyPath: 'id' });
      c.createIndex('patientId', 'patientId');
      c.createIndex('visitId', 'visitId');
      c.createIndex('date', 'date');
      d.createObjectStore('images', { keyPath: 'id' });
      d.createObjectStore('kv');
    },
  });
  return dbPromise;
}

/* ───────── key/value ───────── */

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}
export async function kvDelete(key: string): Promise<void> {
  await (await db()).delete('kv', key);
}
/** The keys that start with `prefix`. */
export async function kvKeys(prefix: string): Promise<string[]> {
  const keys = await (await db()).getAllKeys('kv');
  return keys.filter((k) => typeof k === 'string' && k.startsWith(prefix));
}
/** Read, change and write one value in a single transaction, so two updates can never overwrite each other. */
export async function kvUpdate<T>(key: string, change: (current: T | undefined) => T): Promise<T> {
  const tx = (await db()).transaction('kv', 'readwrite');
  const next = change((await tx.store.get(key)) as T | undefined);
  await tx.store.put(next, key);
  await tx.done;
  return next;
}

/* ───────── patients & visits ───────── */

export async function getPatient(id: string): Promise<Patient | undefined> {
  return (await db()).get('patients', id);
}

export async function putPatient(p: Patient): Promise<void> {
  await (await db()).put('patients', { ...p, updatedAt: Date.now() });
}

/** Change some fields of a patient, leaving the rest exactly as they are in the database right now. */
export async function patchPatient(id: string, patch: Partial<Patient>): Promise<Patient | undefined> {
  const tx = (await db()).transaction('patients', 'readwrite');
  const current = await tx.store.get(id);
  if (!current) {
    await tx.done;
    return undefined;
  }
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/**
 * Fix a patient's archive folder name, once. If it is already fixed that name is kept.
 * A name another patient already uses gets a numeric suffix, so two patients never share a folder.
 */
export async function pinArchiveFolder(id: string, wanted: string): Promise<Patient | undefined> {
  const tx = (await db()).transaction('patients', 'readwrite');
  const current = await tx.store.get(id);
  if (!current || current.archiveFolder) {
    await tx.done;
    return current;
  }
  const taken = new Set((await tx.store.getAll()).filter((p) => p.id !== id && p.archiveFolder).map((p) => p.archiveFolder!.toLowerCase()));
  let folder = wanted;
  for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = `${wanted}_${n}`;
  const next = { ...current, archiveFolder: folder };
  await tx.store.put(next);
  await tx.done;
  return next;
}

export async function getVisit(id: string): Promise<Visit | undefined> {
  return (await db()).get('visits', id);
}

export async function putVisit(v: Visit): Promise<void> {
  await (await db()).put('visits', v);
}

export async function deleteVisit(id: string): Promise<void> {
  await (await db()).delete('visits', id);
}

export async function allVisits(): Promise<Visit[]> {
  return (await db()).getAll('visits');
}

export async function visitsForDate(date: string): Promise<Visit[]> {
  return (await db()).getAllFromIndex('visits', 'date', date);
}

export async function visitsForPatient(patientId: string): Promise<Visit[]> {
  const list = await (await db()).getAllFromIndex('visits', 'patientId', patientId);
  return list.sort((a, b) => b.date.localeCompare(a.date));
}

export async function patientsByIds(ids: string[]): Promise<Map<string, Patient>> {
  const d = await db();
  const tx = d.transaction('patients');
  const out = new Map<string, Patient>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const p = await tx.store.get(id);
      if (p) out.set(id, p);
    }),
  );
  await tx.done;
  return out;
}

export async function allPatients(): Promise<Patient[]> {
  return (await db()).getAll('patients');
}

/** MRNs compare without case or spacing: "123 456 7890" and "1234567890" are the same number. */
export function normaliseMrn(mrn: string | undefined): string {
  return (mrn ?? '').replace(/\s+/g, '').toLowerCase();
}

function nameDobKey(p: { firstName: string; lastName: string; dob?: string }): string {
  const clean = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${clean(p.lastName)}|${clean(p.firstName)}|${p.dob ?? ''}`;
}

export async function findPatientByMrn(mrn: string): Promise<Patient | undefined> {
  const key = normaliseMrn(mrn);
  if (!key) return undefined;
  const all = await allPatients();
  return all.find((p) => normaliseMrn(p.mrn) === key);
}

// Concurrent captures (a burst, or a tethered file landing as Space is pressed)
// must share one visit, so look-up and insert happen in one transaction and
// callers for the same patient/day share one in-flight promise.
const visitInFlight = new Map<string, Promise<Visit>>();

/** Find or create today's (or any day's) visit for a patient. */
export function ensureVisit(patientId: string, date: string, source = 'capture'): Promise<Visit> {
  const key = `${patientId}|${date}`;
  let p = visitInFlight.get(key);
  if (!p) {
    p = (async () => {
      const d = await db();
      const tx = d.transaction('visits', 'readwrite');
      const existing = await tx.store.index('patientDate').get([patientId, date]);
      if (existing) {
        await tx.done;
        return existing;
      }
      const v: Visit = { id: uid(), patientId, date, source, createdAt: Date.now() };
      await tx.store.put(v);
      await tx.done;
      return v;
    })().finally(() => visitInFlight.delete(key));
    visitInFlight.set(key, p);
  }
  return p;
}

export interface ImportSummary {
  added: number;
  updated: number;
  listed: number;
  alreadyListed: number;
  dates: string[];
  /** Rows left out because their hospital number is on record for somebody with a different name. One sentence each. */
  conflicts: string[];
  /** Rows given a record of their own because only a name tied them to someone already on file. One sentence each. */
  keptSeparate: string[];
}

const fullName = (p: { firstName: string; lastName: string }) => [p.lastName.toUpperCase(), p.firstName].filter(Boolean).join(', ') || 'an unnamed patient';

/**
 * Merge imported records into the database. Patients are matched by MRN
 * (or, when one side has no MRN, by name + date of birth) so the same person
 * keeps one photo history across clinic days.
 *
 * An import never renames anyone and never changes a date of birth: on a
 * match it fills in only what the record did not have. A row whose hospital
 * number belongs to somebody with a clearly different name is not attached to
 * them (a misread or mistyped number must not move one patient's visit onto
 * another); it is left out and reported. A row that only a name connects to an
 * existing patient is not merged either: it gets its own record, and that is
 * reported too.
 */
export async function importRecords(records: ImportedRecord[], defaultDate: string, source: string): Promise<ImportSummary> {
  const d = await db();
  const tx = d.transaction(['patients', 'visits'], 'readwrite');
  const patients = tx.objectStore('patients');
  const visits = tx.objectStore('visits');
  const all = await patients.getAll();
  const byMrn = new Map(all.filter((p) => normaliseMrn(p.mrn)).map((p) => [normaliseMrn(p.mrn), p]));
  const byNameDob = new Map(all.filter((p) => p.dob).map((p) => [nameDobKey(p), p]));
  const nameKey = (p: { firstName: string; lastName: string }) => nameDobKey({ ...p, dob: undefined });
  const byName = new Map<string, Patient[]>();
  const remember = (p: Patient) => {
    const list = (byName.get(nameKey(p)) ?? []).filter((x) => x.id !== p.id);
    byName.set(nameKey(p), [...list, p]);
    if (normaliseMrn(p.mrn)) byMrn.set(normaliseMrn(p.mrn), p);
    if (p.dob) byNameDob.set(nameDobKey(p), p);
  };
  all.forEach(remember);
  const summary: ImportSummary = { added: 0, updated: 0, listed: 0, alreadyListed: 0, dates: [], conflicts: [], keptSeparate: [] };
  const dates = new Set<string>();
  const now = Date.now();

  const seenThisImport = new Set<string>();

  for (const r of records) {
    const mrnKey = normaliseMrn(r.mrn);
    const date = r.date ?? defaultDate;
    let p: Patient | undefined;
    const holder = mrnKey ? byMrn.get(mrnKey) : undefined;
    if (holder) {
      // Same number. The same person unless the name is plainly someone else's and the date of birth does not vouch for them.
      const sameBirth = !!r.dob && !!holder.dob && r.dob === holder.dob;
      if (namesClearlyDiffer(r, holder) && !sameBirth) {
        summary.conflicts.push(`${holder.mrn} already belongs to ${fullName(holder)}; the row for ${fullName(r)} was left out`);
        continue;
      }
      p = holder;
    } else if (r.dob) {
      // Name and date of birth, when one side has no MRN to compare.
      const twin = byNameDob.get(nameDobKey(r));
      if (twin && (!mrnKey || !normaliseMrn(twin.mrn))) p = twin;
    } else {
      // Only a name to go on. That is not enough to say it is the same person…
      const namesakes = (byName.get(nameKey(r)) ?? []).filter((x) => !mrnKey || !normaliseMrn(x.mrn));
      if (!mrnKey) {
        // …unless it is plainly this same list being imported again: no number or date of birth on either side, already on that day.
        for (const x of namesakes) {
          if (!normaliseMrn(x.mrn) && !x.dob && (seenThisImport.has(x.id) || (await visits.index('patientDate').get([x.id, date])))) {
            p = x;
            break;
          }
        }
      }
      if (!p && namesakes.length) summary.keptSeparate.push(`${fullName(r)} has no ${mrnKey ? '' : 'hospital number or '}date of birth to match on, so a new record was made rather than adding to the ${fullName(namesakes[0])} already on file`);
    }
    if (p) {
      const merged: Patient = {
        ...p,
        mrn: p.mrn || r.mrn || '',
        firstName: p.firstName || r.firstName,
        lastName: p.lastName || r.lastName,
        dob: p.dob ?? r.dob,
        sex: p.sex || r.sex || '',
      };
      const changed = merged.mrn !== p.mrn || merged.firstName !== p.firstName || merged.lastName !== p.lastName || merged.dob !== p.dob || merged.sex !== p.sex;
      if (changed) {
        merged.updatedAt = now;
        await patients.put(merged);
      }
      p = merged;
      // Keep the look-ups current so a second row for the same person matches too.
      remember(p);
      if (!seenThisImport.has(p.id)) summary.updated++;
    } else {
      p = {
        id: uid(),
        mrn: r.mrn ?? '',
        firstName: r.firstName,
        lastName: r.lastName,
        dob: r.dob,
        sex: r.sex ?? '',
        notes: r.notes,
        createdAt: now,
        updatedAt: now,
      };
      await patients.put(p);
      remember(p);
      summary.added++;
    }
    seenThisImport.add(p.id);

    dates.add(date);
    const existing = await visits.index('patientDate').get([p.id, date]);
    if (existing) {
      await visits.put({
        ...existing,
        time: r.time ?? existing.time,
        clinic: r.clinic ?? existing.clinic,
        clinician: r.clinician ?? existing.clinician,
        reason: r.reason ?? existing.reason,
      });
      summary.alreadyListed++;
    } else {
      await visits.put({
        id: uid(),
        patientId: p.id,
        date,
        time: r.time,
        clinic: r.clinic,
        clinician: r.clinician,
        reason: r.reason,
        source,
        createdAt: now,
      });
      summary.listed++;
    }
  }
  await tx.done;
  summary.dates = [...dates].sort();
  return summary;
}

/* ───────── captures & images ───────── */

export async function addCapture(c: Capture, img: StoredImage): Promise<void> {
  const d = await db();
  const tx = d.transaction(['captures', 'images'], 'readwrite');
  await tx.objectStore('images').put(img);
  await tx.objectStore('captures').put(c);
  await tx.done;
}

export async function putCapture(c: Capture): Promise<void> {
  await (await db()).put('captures', c);
}

/** Apply a partial update to the stored record, so a slow archive write can't overwrite a newer edit. */
export async function patchCapture(id: string, patch: Partial<Capture>): Promise<Capture | undefined> {
  const d = await db();
  const tx = d.transaction('captures', 'readwrite');
  const current = await tx.store.get(id);
  if (!current) {
    await tx.done;
    return undefined;
  }
  const next = { ...current, ...patch };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** A photo by id. A photo whose Delete is still inside its undo window counts as gone. */
export async function getCapture(id: string): Promise<Capture | undefined> {
  const c = await (await db()).get('captures', id);
  return c && !c.deletedAt ? c : undefined;
}

/** The stored record whatever its state, including one that is waiting to be deleted. */
export async function getCaptureRaw(id: string): Promise<Capture | undefined> {
  return (await db()).get('captures', id);
}

export async function deleteCapture(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['captures', 'images'], 'readwrite');
  await tx.objectStore('captures').delete(id);
  await tx.objectStore('images').delete(id);
  await tx.done;
}

const live = (c: Capture) => !c.deletedAt;

export async function capturesForPatient(patientId: string): Promise<Capture[]> {
  const list = await (await db()).getAllFromIndex('captures', 'patientId', patientId);
  return list.filter(live).sort((a, b) => a.takenAt - b.takenAt);
}

export async function capturesForDate(date: string): Promise<Capture[]> {
  return (await (await db()).getAllFromIndex('captures', 'date', date)).filter(live);
}

export async function allCaptures(): Promise<Capture[]> {
  return (await (await db()).getAll('captures')).filter(live);
}

/** Photos whose Delete was pressed but not yet made final (the undo window, or Lumen was closed first). */
export async function deletedCaptures(): Promise<Capture[]> {
  return (await (await db()).getAll('captures')).filter((c) => !!c.deletedAt);
}

/** True when the marks on a photo have changed since its "_annotated" copy was last written. */
export function annotatedCopyStale(c: Capture): boolean {
  return !!c.archivedPath && (c.annotationsAt ?? 0) > (c.annotatedAt ?? 0);
}

/** True when the archive folder is missing something for this photo: the file, a relabel, or its marks. */
export function needsArchiveWork(c: Capture): boolean {
  return !c.archivedPath || !!c.archiveDirty || annotatedCopyStale(c);
}

export async function unarchivedCaptures(): Promise<Capture[]> {
  return (await allCaptures()).filter((c) => !c.archivedPath);
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
  return (await db()).get('images', id);
}
