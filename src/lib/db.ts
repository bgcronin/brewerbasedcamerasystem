import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
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

/* ───────── patients & visits ───────── */

export async function getPatient(id: string): Promise<Patient | undefined> {
  return (await db()).get('patients', id);
}

export async function putPatient(p: Patient): Promise<void> {
  await (await db()).put('patients', { ...p, updatedAt: Date.now() });
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

/** Find or create today's (or any day's) visit for a patient. */
export async function ensureVisit(patientId: string, date: string, source = 'capture'): Promise<Visit> {
  const d = await db();
  const existing = await d.getFromIndex('visits', 'patientDate', [patientId, date]);
  if (existing) return existing;
  const v: Visit = { id: uid(), patientId, date, source, createdAt: Date.now() };
  await d.put('visits', v);
  return v;
}

export interface ImportSummary {
  added: number;
  updated: number;
  listed: number;
  alreadyListed: number;
  dates: string[];
}

/**
 * Merge imported records into the database. Patients are matched by MRN
 * (or, when no MRN is given, by name + date of birth) so the same person
 * keeps one photo history across clinic days.
 */
export async function importRecords(records: ImportedRecord[], defaultDate: string, source: string): Promise<ImportSummary> {
  const d = await db();
  const tx = d.transaction(['patients', 'visits'], 'readwrite');
  const patients = tx.objectStore('patients');
  const visits = tx.objectStore('visits');
  const all = await patients.getAll();
  const byMrn = new Map(all.filter((p) => p.mrn).map((p) => [p.mrn.toLowerCase(), p]));
  const byNameDob = new Map(all.map((p) => [`${p.lastName}|${p.firstName}|${p.dob ?? ''}`.toLowerCase(), p]));
  const summary: ImportSummary = { added: 0, updated: 0, listed: 0, alreadyListed: 0, dates: [] };
  const dates = new Set<string>();
  const now = Date.now();

  for (const r of records) {
    const key = `${r.lastName}|${r.firstName}|${r.dob ?? ''}`.toLowerCase();
    const nameMatch = byNameDob.get(key);
    // Match on MRN first; fall back to name + DOB only when one side has no MRN to compare.
    let p = (r.mrn && byMrn.get(r.mrn.toLowerCase())) || (nameMatch && (!r.mrn || !nameMatch.mrn) ? nameMatch : undefined);
    if (p) {
      const merged: Patient = {
        ...p,
        mrn: p.mrn || r.mrn || '',
        firstName: r.firstName || p.firstName,
        lastName: r.lastName || p.lastName,
        dob: r.dob ?? p.dob,
        sex: r.sex || p.sex,
        updatedAt: now,
      };
      await patients.put(merged);
      p = merged;
      summary.updated++;
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
      if (p.mrn) byMrn.set(p.mrn.toLowerCase(), p);
      byNameDob.set(key, p);
      summary.added++;
    }

    const date = r.date ?? defaultDate;
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

export async function getCapture(id: string): Promise<Capture | undefined> {
  return (await db()).get('captures', id);
}

export async function deleteCapture(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['captures', 'images'], 'readwrite');
  await tx.objectStore('captures').delete(id);
  await tx.objectStore('images').delete(id);
  await tx.done;
}

export async function capturesForPatient(patientId: string): Promise<Capture[]> {
  const list = await (await db()).getAllFromIndex('captures', 'patientId', patientId);
  return list.sort((a, b) => a.takenAt - b.takenAt);
}

export async function capturesForDate(date: string): Promise<Capture[]> {
  return (await db()).getAllFromIndex('captures', 'date', date);
}

export async function unarchivedCaptures(): Promise<Capture[]> {
  const all = await (await db()).getAll('captures');
  return all.filter((c) => !c.archivedPath);
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
  return (await db()).get('images', id);
}
