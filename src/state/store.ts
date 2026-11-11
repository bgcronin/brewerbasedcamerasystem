import { create } from 'zustand';
import { renderAnnotated } from '../lib/annotations';
import { archiveCapture, removeArchived, renameArchived, syncAnnotatedCopy, updateArchivedMetadata } from '../lib/archive';
import * as db from '../lib/db';
import { addDiagnosis, hasDiagnosis, removeDiagnosis, sameDiagnosis } from '../lib/diagnoses';
import { todayISO, toISODate } from '../lib/dates';
import { encodeBitmap, warmEncoder } from '../lib/encode';
import { fsSupported, hasPermission, pickDirectory, requestPermission } from '../lib/fsaccess';
import { uid } from '../lib/id';
import { displayName } from '../lib/names';
import type { ImportedRecord, ImportResult } from '../lib/importers';
import { captureFileName, patientFolderName } from '../lib/naming';
import { playShutter } from '../lib/sound';
import { FolderWatcher } from '../lib/tether';
import { forgetThumb, primeThumb } from '../lib/thumbs';
import {
  DEFAULT_SETTINGS,
  type Annotation,
  type Capture,
  type CaptureSource,
  type Eye,
  type Patient,
  type Settings,
  type Transform,
  type Visit,
} from '../lib/types';

export interface VisitRow {
  visit: Visit;
  patient: Patient;
  count: number;
}

export type View = 'capture' | 'review' | 'library';

export interface Toast {
  id: string;
  message: string;
  detail?: string;
  tone?: 'default' | 'success' | 'warning' | 'error';
  action?: { label: string; run: () => void };
  duration?: number;
}

export type Sheet =
  | { type: 'import'; result?: ImportResult; reading?: { name: string; label: string; progress?: number } }
  | { type: 'patient'; patientId?: string; visitId?: string }
  | { type: 'settings' }
  | { type: 'shortcuts' }
  | { type: 'camera' }
  | null;

export interface FolderState {
  status: 'unsupported' | 'none' | 'needs-permission' | 'connected' | 'error';
  name?: string;
}

interface HeldPhoto {
  file: File;
  receivedAt: number;
  source: 'tether' | 'canon';
  /** Tethered folder the file came from (for tidying up afterwards). */
  parent?: FileSystemDirectoryHandle;
  deviceLabel?: string;
  exposure?: Capture['exposure'];
}

interface AppState {
  ready: boolean;
  settings: Settings;
  date: string;
  rows: VisitRow[];
  allPatients: Patient[];
  activePatientId: string | null;
  patient: Patient | null;
  patientVisits: Visit[];
  captures: Capture[];
  /** Every photo in Lumen (metadata only), loaded when the Library is first opened. */
  library: Capture[] | null;
  eye: Eye;
  technique: string | null;
  /** Diagnosis labels for the active patient's photos today; new photos are filed with them. */
  diagnoses: string[];
  view: View;
  processing: number;
  flashTick: number;
  lastCaptureId: string | null;
  archive: FolderState & { pending: number };
  tether: FolderState & { watching: boolean; lastAt?: number };
  held: HeldPhoto[];
  /** Patient ids in the order the sidebar is showing them (after search / filter), for ↑ ↓. */
  visiblePatientIds: string[] | null;
  toasts: Toast[];
  sheet: Sheet;
  /** `source` says which list the ids come from: the active patient's photos, or the whole library. */
  lightbox: { ids: string[]; index: number; source: 'patient' | 'library' } | null;
  compare: [string, string] | null;
}

const initial: AppState = {
  ready: false,
  settings: DEFAULT_SETTINGS,
  date: todayISO(),
  rows: [],
  allPatients: [],
  activePatientId: null,
  patient: null,
  patientVisits: [],
  captures: [],
  library: null,
  eye: 'OD',
  technique: null,
  diagnoses: [],
  view: 'capture',
  processing: 0,
  flashTick: 0,
  lastCaptureId: null,
  archive: { status: fsSupported ? 'none' : 'unsupported', pending: 0 },
  tether: { status: fsSupported ? 'none' : 'unsupported', watching: false },
  held: [],
  visiblePatientIds: null,
  toasts: [],
  sheet: null,
  lightbox: null,
  compare: null,
};

export const useApp = create<AppState>(() => initial);
const get = useApp.getState;
const set = useApp.setState;

let archiveHandle: FileSystemDirectoryHandle | null = null;
let tetherHandle: FileSystemDirectoryHandle | null = null;
let watcher: FolderWatcher | null = null;
const pendingDeletes = new Map<string, number>();
let rawHintShown = false;

/* ───────────────────────── toasts ───────────────────────── */

export function toast(t: Omit<Toast, 'id'>): string {
  const id = uid();
  set((s) => {
    const withAction = s.toasts.filter((x) => x.action);
    const plain = s.toasts.filter((x) => !x.action).slice(-2);
    return { toasts: [...withAction, ...plain, { id, ...t }] };
  });
  const ms = t.duration ?? (t.action ? 6500 : t.tone === 'error' ? 7000 : t.tone === 'success' ? 2600 : 3200);
  window.setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: string): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/* ───────────────────────── boot ───────────────────────── */

export async function init(): Promise<void> {
  warmEncoder();
  const saved = await db.kvGet<Partial<Settings>>('settings');
  const settings = { ...DEFAULT_SETTINGS, ...saved, transforms: { ...(saved?.transforms ?? {}) } };
  set({ settings });
  applyTheme(settings.theme);

  if (fsSupported) {
    archiveHandle = (await db.kvGet<FileSystemDirectoryHandle>('archiveHandle')) ?? null;
    tetherHandle = (await db.kvGet<FileSystemDirectoryHandle>('tetherHandle')) ?? null;
    if (archiveHandle) {
      const ok = await hasPermission(archiveHandle, 'readwrite');
      set((s) => ({ archive: { ...s.archive, status: ok ? 'connected' : 'needs-permission', name: archiveHandle!.name } }));
    }
    if (tetherHandle) {
      const mode = settings.removeTetherOriginals ? 'readwrite' : 'read';
      const ok = await hasPermission(tetherHandle, mode);
      set((s) => ({ tether: { ...s.tether, status: ok ? 'connected' : 'needs-permission', name: tetherHandle!.name } }));
      if (ok && settings.source === 'tether') void startTether();
    }
  }

  if (get().archive.status === 'needs-permission') {
    toast({
      tone: 'warning',
      message: 'Reconnect the archive folder',
      detail: `Allow Lumen to keep saving to “${archiveHandle?.name}”. Choose “Allow on every visit” to skip this next time.`,
      action: { label: 'Reconnect', run: () => void reconnectArchive() },
      duration: 15000,
    });
  }

  await Promise.all([loadRows(), refreshPending(), refreshAllPatients()]);
  // Finish anything a previous session left unwritten (photos, or marks drawn just before closing).
  if (get().archive.status === 'connected' && get().archive.pending > 0) void syncArchive(true);
  const lastPatient = await db.kvGet<{ id: string; date: string }>('lastPatient');
  if (lastPatient && lastPatient.date === todayISO()) await selectPatient(lastPatient.id);
  set({ ready: true });

  // Ask the browser not to evict our data under storage pressure.
  void navigator.storage?.persist?.().catch(() => undefined);
}

let mediaQuery: MediaQueryList | null = null;
export function applyTheme(pref: Settings['theme']): void {
  const resolve = () =>
    pref === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = resolve();
  mediaQuery?.removeEventListener('change', onSystemTheme);
  if (pref === 'system') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    mediaQuery.addEventListener('change', onSystemTheme);
  }
}
function onSystemTheme() {
  applyTheme(get().settings.theme);
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...get().settings, ...patch };
  set({ settings });
  if (patch.theme) applyTheme(patch.theme);
  await db.kvSet('settings', settings);
}

export function transformFor(label: string | undefined): Transform {
  return get().settings.transforms[label ?? 'default'] ?? { rotate: 0, flipH: false, flipV: false };
}

export async function setTransform(label: string | undefined, t: Transform): Promise<void> {
  await updateSettings({ transforms: { ...get().settings.transforms, [label ?? 'default']: t } });
}

/* ───────────────────────── worklist ───────────────────────── */

function sortRows(rows: VisitRow[]): VisitRow[] {
  return rows.sort((a, b) => {
    const ta = a.visit.time ?? '99:99';
    const tb = b.visit.time ?? '99:99';
    if (ta !== tb) return ta.localeCompare(tb);
    return a.patient.lastName.localeCompare(b.patient.lastName) || a.visit.createdAt - b.visit.createdAt;
  });
}

export async function loadRows(date = get().date): Promise<void> {
  const [visits, caps] = await Promise.all([db.visitsForDate(date), db.capturesForDate(date)]);
  const patients = await db.patientsByIds(visits.map((v) => v.patientId));
  const counts = new Map<string, number>();
  for (const c of caps) if (!pendingDeletes.has(c.id)) counts.set(c.visitId, (counts.get(c.visitId) ?? 0) + 1);
  const rows = visits
    .filter((v) => patients.has(v.patientId))
    .map((v) => ({ visit: v, patient: patients.get(v.patientId)!, count: counts.get(v.id) ?? 0 }));
  if (get().date === date) set({ rows: sortRows(rows) });
}

export async function refreshAllPatients(): Promise<void> {
  set({ allPatients: await db.allPatients() });
}

export async function setDate(date: string): Promise<void> {
  set({ date });
  await loadRows(date);
}

export async function selectPatient(id: string | null): Promise<void> {
  if (!id) {
    set({ activePatientId: null, patient: null, captures: [], patientVisits: [], lastCaptureId: null, diagnoses: [] });
    return;
  }
  // Switch synchronously, so a shutter press straight after choosing a patient can
  // never be filed to the previous one while their history loads.
  const s = get();
  const switching = s.activePatientId !== id;
  const known = s.rows.find((r) => r.patient.id === id)?.patient ?? s.allPatients.find((p) => p.id === id) ?? null;
  if (switching) {
    set({ activePatientId: id, patient: known, captures: [], patientVisits: [], eye: 'OD', lastCaptureId: null, diagnoses: [] });
  }
  const [patient, captures, visits] = await Promise.all([db.getPatient(id), db.capturesForPatient(id), db.visitsForPatient(id)]);
  if (get().activePatientId !== id) return; // the user has already moved on
  if (!patient) {
    set({ activePatientId: null, patient: null });
    return;
  }
  set((st) => {
    // Keep anything captured while the history was loading.
    const loaded = new Set(captures.map((c) => c.id));
    const extra = st.captures.filter((c) => c.patientId === id && !loaded.has(c.id));
    const all = [...captures.filter((c) => !pendingDeletes.has(c.id)), ...extra].sort((a, b) => a.takenAt - b.takenAt);
    return {
      patient,
      captures: all,
      patientVisits: visits,
      // Carry on with whatever today's photos are already labelled, plus anything typed while loading.
      diagnoses: switching ? unionDiagnoses(todaysDiagnoses(all), st.diagnoses) : st.diagnoses,
    };
  });
  void db.kvSet('lastPatient', { id, date: todayISO() });
}

export function selectAdjacent(delta: 1 | -1): void {
  const { rows, activePatientId, visiblePatientIds } = get();
  const ids = visiblePatientIds ?? rows.map((r) => r.patient.id);
  if (!ids.length) return;
  const i = ids.indexOf(activePatientId ?? '');
  const next = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + delta));
  void selectPatient(ids[next]);
}

export async function importToList(records: ImportedRecord[], defaultDate: string, source: string): Promise<void> {
  const summary = await db.importRecords(records, defaultDate, source);
  const target = summary.dates.includes(get().date) ? get().date : summary.dates[0] ?? defaultDate;
  await setDate(target);
  await refreshAllPatients();
  const n = summary.listed + summary.alreadyListed;
  toast({
    tone: 'success',
    message: `${n} patient${n === 1 ? '' : 's'} on the list`,
    detail: [
      summary.added && `${summary.added} new`,
      summary.updated && `${summary.updated} matched to existing records`,
      summary.dates.length > 1 && `across ${summary.dates.length} days`,
    ]
      .filter(Boolean)
      .join(', '),
  });
}

export interface PatientForm {
  mrn: string;
  firstName: string;
  lastName: string;
  dob?: string;
  sex?: Patient['sex'];
  notes?: string;
  time?: string;
  clinic?: string;
  reason?: string;
}

export async function savePatient(form: PatientForm, patientId?: string, visitId?: string): Promise<string> {
  const now = Date.now();
  let patient: Patient;
  const existingWithMrn = form.mrn ? await db.findPatientByMrn(form.mrn) : undefined;
  if (patientId) {
    const existing = await db.getPatient(patientId);
    if (!existing) throw new Error('Patient not found');
    if (existingWithMrn && existingWithMrn.id !== patientId) {
      throw new Error(`${form.mrn} already belongs to ${displayName(existingWithMrn)}. Two patients can’t share an MRN.`);
    }
    patient = { ...existing, mrn: form.mrn, firstName: form.firstName, lastName: form.lastName, dob: form.dob, sex: form.sex, notes: form.notes };
  } else if (existingWithMrn) {
    // Same MRN as a known patient: add the visit to their record rather than renaming them.
    patient = { ...existingWithMrn, dob: existingWithMrn.dob ?? form.dob, sex: existingWithMrn.sex || form.sex };
    toast({ message: `${form.mrn} is already ${displayName(existingWithMrn)}`, detail: 'Their existing record was used. Edit it if the details need changing.', duration: 7000 });
  } else {
    patient = { id: uid(), mrn: form.mrn, firstName: form.firstName, lastName: form.lastName, dob: form.dob, sex: form.sex, notes: form.notes, createdAt: now, updatedAt: now };
  }
  await db.putPatient(patient);

  // Editing a patient must never add them to a day's list; only adding (or editing a listed visit) touches visits.
  const visit = visitId ? await db.getVisit(visitId) : !patientId ? await db.ensureVisit(patient.id, get().date, 'manual') : undefined;
  if (visit) await db.putVisit({ ...visit, time: form.time || undefined, clinic: form.clinic || undefined, reason: form.reason || undefined });

  await Promise.all([loadRows(), refreshAllPatients()]);
  if (get().activePatientId === patient.id || !patientId) await selectPatient(patient.id);
  return patient.id;
}

export async function removeFromList(visitId: string): Promise<void> {
  const caps = (await db.capturesForDate(get().date)).filter((c) => c.visitId === visitId && !pendingDeletes.has(c.id));
  if (caps.length) {
    toast({ tone: 'warning', message: 'This visit has photos', detail: 'Delete the photos first to remove the patient from the list.' });
    return;
  }
  const row = get().rows.find((r) => r.visit.id === visitId);
  await db.deleteVisit(visitId);
  if (row && row.patient.id === get().activePatientId) await selectPatient(null);
  await loadRows();
}

/* ───────────────────────── capture ───────────────────────── */

export function setEye(eye: Eye): void {
  set({ eye });
}

export function setTechnique(technique: string | null): void {
  set({ technique });
}

export function setView(view: View): void {
  set({ view });
  if (view === 'library') void loadLibrary();
}

function isIdentity(t: Transform) {
  return t.rotate === 0 && !t.flipH && !t.flipV;
}

interface IngestInput {
  bitmap?: ImageBitmap;
  original?: File | Blob;
  source: CaptureSource;
  deviceLabel?: string;
  transform: Transform;
  takenAt?: number;
  /** Labels captured at the moment the shutter was pressed (default: current selection). */
  eye?: Eye;
  technique?: string | null;
  diagnoses?: string[];
  exposure?: Capture['exposure'];
}

/** The single path every photo takes into the system: encode → store → archive. */
export async function ingest(input: IngestInput, patientOverride?: Patient): Promise<Capture | null> {
  const s = get();
  const patient = patientOverride ?? s.patient;
  if (!patient) return null;
  const { settings } = s;
  const eye = input.eye ?? s.eye;
  const technique = input.technique !== undefined ? input.technique : s.technique;
  const diagnosesAtPress = input.diagnoses ?? (patient.id === s.activePatientId ? s.diagnoses : []);
  const takenAt = input.takenAt ?? Date.now();
  set((st) => ({ processing: st.processing + 1 }));
  try {
    const visit = await db.ensureVisit(patient.id, todayISO());
    let full: Blob;
    let thumb: Blob;
    let width: number;
    let height: number;

    const keepOriginal =
      !!input.original && settings.keepTetherOriginals && isIdentity(input.transform) && /jpe?g|webp|png/.test(input.original.type || 'image/jpeg');
    const bitmap = input.bitmap ?? (await createImageBitmap(input.original!));
    if (keepOriginal) {
      const r = await encodeBitmap({ bitmap, transform: input.transform, format: settings.format, quality: settings.quality, thumbSize: 640, thumbOnly: true }, input.original);
      full = input.original!;
      ({ thumb, width, height } = r);
    } else {
      const r = await encodeBitmap({ bitmap, transform: input.transform, format: settings.format, quality: settings.quality, thumbSize: 640 }, input.original);
      full = r.full!;
      ({ thumb, width, height } = r);
    }
    const mime = full.type || 'image/jpeg';
    // A label added while the photo was being processed still belongs on it.
    const now = get();
    const diagnoses = input.diagnoses ?? (patient.id === now.activePatientId ? now.diagnoses : diagnosesAtPress);
    const capture: Capture = {
      id: uid(),
      patientId: patient.id,
      visitId: visit.id,
      date: visit.date,
      eye,
      technique: technique ?? undefined,
      takenAt,
      width,
      height,
      mime,
      bytes: full.size,
      fileName: captureFileName(patient, { takenAt, eye, technique: technique ?? undefined }, mime),
      source: input.source,
      deviceLabel: input.deviceLabel,
      exposure: input.exposure,
      diagnoses: diagnoses.length ? diagnoses : undefined,
    };
    await db.addCapture(capture, { id: capture.id, full, thumb });
    primeThumb(capture.id, thumb);

    set((st) => ({
      library: st.library ? [...st.library, capture] : st.library,
      ...(st.activePatientId === patient.id
        ? {
            captures: [...st.captures, capture],
            lastCaptureId: capture.id,
            patientVisits: st.patientVisits.some((v) => v.id === visit.id) ? st.patientVisits : [visit, ...st.patientVisits],
          }
        : {}),
    }));
    void loadRows();

    if (archiveHandle && get().archive.status === 'connected') {
      try {
        const owner = await pinArchiveFolder(patient);
        const path = await archiveCapture(archiveHandle, owner, visit, capture, full);
        const stored = await patchCapture(capture.id, { archivedPath: path });
        // A label, note or star added while the file was being written belongs in visit.json too.
        const meta = (x: Capture) => JSON.stringify([x.diagnoses ?? [], x.note ?? '', !!x.starred]);
        if (stored && meta(stored) !== meta(capture)) await updateArchivedMetadata(archiveHandle, owner, visit, stored);
      } catch (e) {
        set((st) => ({ archive: { ...st.archive, status: 'error' } }));
        toast({ tone: 'error', message: 'Couldn’t write to the archive folder', detail: `Saved safely in Lumen. ${(e as Error).message}` });
        void refreshPending();
      }
    } else {
      void refreshPending();
    }
    return capture;
  } catch (e) {
    toast({ tone: 'error', message: 'Photo not saved', detail: (e as Error).message });
    return null;
  } finally {
    set((st) => ({ processing: st.processing - 1 }));
  }
}

/** Merge a partial change into the stored record and the visible list (never overwrites a newer edit). */
async function patchCapture(id: string, patch: Partial<Capture>): Promise<Capture | undefined> {
  const next = await db.patchCapture(id, patch);
  if (next) {
    set((st) => ({
      captures: st.captures.map((x) => (x.id === id ? next : x)),
      library: st.library ? st.library.map((x) => (x.id === id ? next : x)) : st.library,
    }));
  }
  return next;
}

/** A photo by id, wherever it is currently shown. */
function findCapture(id: string): Capture | undefined {
  const s = get();
  return s.captures.find((x) => x.id === id) ?? s.library?.find((x) => x.id === id);
}

/** The archive folder is chosen once per patient and then kept, whatever later corrections say. */
async function pinArchiveFolder(patient: Patient): Promise<Patient> {
  if (patient.archiveFolder) return patient;
  const pinned = { ...patient, archiveFolder: patientFolderName(patient) };
  await db.putPatient(pinned);
  set((st) => (st.patient?.id === patient.id ? { patient: pinned } : {}));
  return pinned;
}

/** Fire the shutter for the live camera. */
export async function captureFromLive(grab: () => Promise<ImageBitmap>, deviceLabel: string | undefined): Promise<void> {
  const s = get();
  if (!s.patient) {
    toast({ tone: 'warning', message: 'Choose a patient first', detail: 'Pick someone from the list on the left.' });
    return;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await grab();
  } catch (e) {
    toast({ tone: 'warning', message: (e as Error).message });
    return;
  }
  set((st) => ({ flashTick: st.flashTick + 1 }));
  if (s.settings.shutterSound) playShutter();
  await ingest({ bitmap, source: 'live', deviceLabel, transform: transformFor(deviceLabel) });
}

export async function importFiles(files: File[]): Promise<void> {
  const s = get();
  if (!s.patient) {
    toast({ tone: 'warning', message: 'Choose a patient first' });
    return;
  }
  const images = files.filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
  for (const f of images) {
    // A file's own timestamp is kept only if it was taken today; older files are filed with the time they were added.
    const takenToday = f.lastModified && toISODate(new Date(f.lastModified)) === todayISO();
    await ingest({ original: f, source: 'file', transform: { rotate: 0, flipH: false, flipV: false }, takenAt: takenToday ? f.lastModified : Date.now() });
  }
  if (images.length) toast({ tone: 'success', message: `${images.length} photo${images.length === 1 ? '' : 's'} added` });
  if (images.length < files.length) toast({ tone: 'warning', message: 'Some files were skipped', detail: 'Only JPEG, PNG and WebP images can be imported.' });
}

export async function updateCapture(id: string, patch: Partial<Pick<Capture, 'eye' | 'technique' | 'note' | 'starred' | 'diagnoses'>>): Promise<void> {
  const c = findCapture(id) ?? (await db.getCapture(id));
  if (!c) return;
  const [patient, visit] = await Promise.all([db.getPatient(c.patientId), db.getVisit(c.visitId)]);
  // `'technique' in patch` so that clearing the technique also renames the file.
  const relabelled = (patch.eye && patch.eye !== c.eye) || ('technique' in patch && patch.technique !== c.technique);
  const merged = { ...c, ...patch };
  // The eye and technique are part of the file name, so a relabel renames the file too.
  const fileName = relabelled && patient ? captureFileName(patient, { takenAt: merged.takenAt, eye: merged.eye, technique: merged.technique }, merged.mime) : merged.fileName;
  const next = (await patchCapture(id, { ...patch, fileName })) ?? { ...merged, fileName };
  if (!archiveHandle || !next.archivedPath || get().archive.status !== 'connected' || !patient || !visit) return;
  try {
    if (relabelled) {
      const renamed = await renameArchived(archiveHandle, patient, visit, next, fileName);
      if (renamed) await patchCapture(id, renamed);
    } else {
      await updateArchivedMetadata(archiveHandle, patient, visit, next);
    }
  } catch (e) {
    toast({ tone: 'warning', message: 'Archive copy not updated', detail: `The change is saved in Lumen. ${(e as Error).message}` });
  }
}

/* ───────────────────────── diagnosis labels ───────────────────────── */

function unionDiagnoses(...lists: (string[] | undefined)[]): string[] {
  let out: string[] = [];
  for (const l of lists) for (const d of l ?? []) out = addDiagnosis(out, d);
  return out;
}

function todaysDiagnoses(captures: Capture[]): string[] {
  const today = todayISO();
  return unionDiagnoses(...captures.filter((c) => c.date === today).map((c) => c.diagnoses));
}

function sameDiagnosisList(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((d, i) => sameDiagnosis(d, y[i]));
}

/** Keep the most recently used diagnoses at the top of the suggestions. */
async function rememberDiagnoses(names: string[]): Promise<void> {
  if (!names.length) return;
  const old = get().settings.recentDiagnoses ?? [];
  const next = [...names, ...old.filter((d) => !hasDiagnosis(names, d))].slice(0, 40);
  await updateSettings({ recentDiagnoses: next });
}

// Label changes are applied strictly one after another, each reading the photos as the
// previous change left them. Two labels added in quick succession can never overwrite each other.
let labelWork: Promise<unknown> = Promise.resolve();
function inOrder<T>(job: () => Promise<T>): Promise<T> {
  const run = labelWork.then(job, job);
  labelWork = run.catch(() => undefined);
  return run;
}

/** Change a photo's labels on screen straight away; the stored record follows. */
function showDiagnoses(id: string, diagnoses: string[] | undefined): void {
  const swap = (x: Capture) => (x.id === id ? { ...x, diagnoses } : x);
  set((st) => ({ captures: st.captures.map(swap), library: st.library ? st.library.map(swap) : st.library }));
}

/**
 * Label the active patient's visit. The labels go on every photo taken today
 * (those already taken and those still to come).
 */
export function setVisitDiagnoses(next: string[]): Promise<void> {
  const s = get();
  const prev = s.diagnoses;
  const patientId = s.activePatientId;
  const added = next.filter((d) => !hasDiagnosis(prev, d));
  const removed = prev.filter((d) => !hasDiagnosis(next, d));
  set({ diagnoses: next });
  void rememberDiagnoses(added);
  if (!patientId || (!added.length && !removed.length)) return Promise.resolve();
  const today = todayISO();
  return inOrder(async () => {
    // Read from storage, not the screen: the user may already be on the next patient.
    const todays = (await db.capturesForPatient(patientId)).filter((c) => c.date === today && !pendingDeletes.has(c.id));
    for (const c of todays) {
      let list = c.diagnoses ?? [];
      for (const d of added) list = addDiagnosis(list, d);
      for (const d of removed) list = removeDiagnosis(list, d);
      if (!sameDiagnosisList(list, c.diagnoses)) await updateCapture(c.id, { diagnoses: list.length ? list : undefined });
    }
  });
}

/** Label one photo (from the viewer). */
export function setCaptureDiagnoses(id: string, next: string[]): Promise<void> {
  const c = findCapture(id);
  if (!c) return Promise.resolve();
  const diagnoses = next.length ? next : undefined;
  void rememberDiagnoses(next.filter((d) => !hasDiagnosis(c.diagnoses, d)));
  showDiagnoses(id, diagnoses);
  return inOrder(async () => {
    await updateCapture(id, { diagnoses });
    followTodaysLabels(c.patientId);
  });
}

/** Give every photo of the same visit this photo's diagnoses. Returns how many were changed. */
export function applyDiagnosesToVisit(id: string): Promise<number> {
  return inOrder(async () => {
    const c = (await db.getCapture(id)) ?? findCapture(id);
    if (!c) return 0;
    const siblings = (await db.capturesForPatient(c.patientId)).filter((x) => x.visitId === c.visitId && x.id !== id && !pendingDeletes.has(x.id));
    let changed = 0;
    for (const x of siblings) {
      if (sameDiagnosisList(x.diagnoses, c.diagnoses)) continue;
      await updateCapture(x.id, { diagnoses: c.diagnoses?.length ? [...c.diagnoses] : undefined });
      changed++;
    }
    followTodaysLabels(c.patientId);
    return changed;
  });
}

/** After labels are edited in the viewer, new photos of the active patient follow what today's photos now say. */
function followTodaysLabels(patientId: string): void {
  const s = get();
  if (s.activePatientId !== patientId) return;
  const today = todayISO();
  if (!s.captures.some((c) => c.date === today)) return;
  set({ diagnoses: todaysDiagnoses(s.captures) });
}

/* ───────────────────────── annotations ───────────────────────── */

const annotationTimers = new Map<string, number>();

/**
 * Save the marks drawn on a photo. The photo itself is never changed; shortly
 * afterwards an "_annotated" copy is written beside it in the archive folder.
 */
export async function setAnnotations(id: string, annotations: Annotation[]): Promise<void> {
  await patchCapture(id, { annotations: annotations.length ? annotations : undefined, annotationsAt: Date.now() });
  window.clearTimeout(annotationTimers.get(id));
  annotationTimers.set(
    id,
    window.setTimeout(() => {
      annotationTimers.delete(id);
      void writeAnnotatedCopy(id)
        .catch(() => undefined) // left pending; the next archive sync retries
        .then(() => refreshPending());
    }, 1500),
  );
  void refreshPending();
}

async function writeAnnotatedCopy(id: string): Promise<boolean> {
  if (!archiveHandle || get().archive.status !== 'connected') return false;
  const c = await db.getCapture(id);
  if (!c || !db.annotatedCopyStale(c) || pendingDeletes.has(id)) return false;
  const [patient, visit, img] = await Promise.all([db.getPatient(c.patientId), db.getVisit(c.visitId), db.getImage(id)]);
  if (!patient || !visit || !img) return false;
  const blob = c.annotations?.length ? await renderAnnotated(img.full, c.annotations, c.mime, get().settings.quality) : null;
  const annotatedPath = await syncAnnotatedCopy(archiveHandle, patient, visit, c, blob);
  await patchCapture(id, { annotatedPath, annotatedAt: c.annotationsAt });
  return true;
}

/* ───────────────────────── library ───────────────────────── */

export async function loadLibrary(): Promise<void> {
  const all = (await db.allCaptures()).filter((c) => !pendingDeletes.has(c.id));
  set({ library: all });
  void refreshAllPatients();
}

/** Delete with a short undo window, Apple-style. */
export function deleteCapture(id: string): void {
  const c = findCapture(id);
  if (!c) return;
  set((st) => ({
    captures: st.captures.filter((x) => x.id !== id),
    library: st.library ? st.library.filter((x) => x.id !== id) : st.library,
    lastCaptureId: st.lastCaptureId === id ? null : st.lastCaptureId,
    rows: st.rows.map((r) => (r.visit.id === c.visitId ? { ...r, count: Math.max(0, r.count - 1) } : r)),
  }));
  const timer = window.setTimeout(() => void commitDelete(c), 6500);
  pendingDeletes.set(id, timer);
  toast({
    message: 'Photo deleted',
    action: {
      label: 'Undo',
      run: () => {
        window.clearTimeout(timer);
        pendingDeletes.delete(id);
        set((st) => ({
          library: st.library && !st.library.some((x) => x.id === c.id) ? [...st.library, c] : st.library,
          ...(st.activePatientId === c.patientId && !st.captures.some((x) => x.id === c.id)
            ? { captures: [...st.captures, c].sort((a, b) => a.takenAt - b.takenAt) }
            : {}),
        }));
        void loadRows();
      },
    },
  });
}

interface ArchiveRemoval {
  capture: Capture;
  patientId: string;
  visitId: string;
}

async function commitDelete(c: Capture): Promise<void> {
  pendingDeletes.delete(c.id);
  await db.deleteCapture(c.id);
  forgetThumb(c.id);
  if (c.archivedPath) {
    // Remember the file to remove even if the archive folder is unavailable right now.
    const queued = (await db.kvGet<ArchiveRemoval[]>('archiveRemovals')) ?? [];
    await db.kvSet('archiveRemovals', [...queued.filter((r) => r.capture.id !== c.id), { capture: c, patientId: c.patientId, visitId: c.visitId }]);
    await processArchiveRemovals();
  }
  void refreshPending();
}

async function processArchiveRemovals(): Promise<void> {
  if (!archiveHandle || get().archive.status !== 'connected') return;
  const queued = (await db.kvGet<ArchiveRemoval[]>('archiveRemovals')) ?? [];
  const remaining: ArchiveRemoval[] = [];
  for (const r of queued) {
    const [patient, visit] = await Promise.all([db.getPatient(r.patientId), db.getVisit(r.visitId)]);
    if (!patient || !visit) continue;
    try {
      await removeArchived(archiveHandle, patient, visit, r.capture);
    } catch {
      remaining.push(r);
    }
  }
  await db.kvSet('archiveRemovals', remaining);
}

/** Deletes still inside their undo window are committed if the page is closed. */
function flushPendingDeletes(): void {
  for (const [id, timer] of pendingDeletes) {
    window.clearTimeout(timer);
    pendingDeletes.delete(id);
    void db.getCapture(id).then((c) => c && commitDelete(c));
  }
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPendingDeletes);

/* ───────────────────────── archive folder ───────────────────────── */

async function refreshPending(): Promise<void> {
  const all = await db.allCaptures();
  // Marks drawn a moment ago are about to be written; they only count once that has failed or been missed.
  const pending = all.filter((c) => !pendingDeletes.has(c.id) && (!c.archivedPath || (db.annotatedCopyStale(c) && !annotationTimers.has(c.id)))).length;
  set((s) => ({ archive: { ...s.archive, pending } }));
}

export async function chooseArchiveFolder(): Promise<void> {
  const handle = await pickDirectory('lumen-archive', 'readwrite');
  if (!handle) return;
  archiveHandle = handle;
  await db.kvSet('archiveHandle', handle);
  set((s) => ({ archive: { ...s.archive, status: 'connected', name: handle.name } }));
  toast({ tone: 'success', message: `Archiving to “${handle.name}”` });
  await syncArchive();
}

export async function reconnectArchive(): Promise<boolean> {
  if (!archiveHandle) {
    await chooseArchiveFolder();
    return get().archive.status === 'connected';
  }
  const ok = await requestPermission(archiveHandle, 'readwrite');
  set((s) => ({ archive: { ...s.archive, status: ok ? 'connected' : 'needs-permission' } }));
  if (ok) await syncArchive();
  return ok;
}

export async function disconnectArchive(): Promise<void> {
  archiveHandle = null;
  await db.kvDelete('archiveHandle');
  set((s) => ({ archive: { ...s.archive, status: fsSupported ? 'none' : 'unsupported', name: undefined } }));
}

/** Write anything that was captured (or marked up) while the archive folder was unavailable. */
export async function syncArchive(quiet = false): Promise<void> {
  if (!archiveHandle) return;
  const pending = (await db.unarchivedCaptures()).filter((c) => !pendingDeletes.has(c.id));
  let done = 0;
  for (const c of pending) {
    const [patient, visit, img] = await Promise.all([db.getPatient(c.patientId), db.getVisit(c.visitId), db.getImage(c.id)]);
    if (!patient || !visit || !img) continue;
    try {
      const owner = await pinArchiveFolder(patient);
      const path = await archiveCapture(archiveHandle, owner, visit, c, img.full);
      await patchCapture(c.id, { archivedPath: path });
      done++;
    } catch (e) {
      set((s) => ({ archive: { ...s.archive, status: 'error' } }));
      toast({ tone: 'error', message: 'Archive sync stopped', detail: (e as Error).message });
      break;
    }
  }
  if (done && !quiet) toast({ tone: 'success', message: `${done} photo${done === 1 ? '' : 's'} written to the archive` });
  if (get().archive.status === 'connected') {
    for (const c of (await db.allCaptures()).filter((x) => db.annotatedCopyStale(x) && !annotationTimers.has(x.id))) {
      try {
        await writeAnnotatedCopy(c.id);
      } catch {
        break; // the folder has gone away again; try next time
      }
    }
  }
  await processArchiveRemovals();
  await refreshPending();
}

/* ───────────────────────── tethered folder (Canon EOS) ───────────────────────── */

export async function chooseTetherFolder(): Promise<void> {
  const mode = get().settings.removeTetherOriginals ? 'readwrite' : 'read';
  const handle = await pickDirectory('lumen-tether', mode);
  if (!handle) return;
  tetherHandle = handle;
  await db.kvSet('tetherHandle', handle);
  set((s) => ({ tether: { ...s.tether, status: 'connected', name: handle.name } }));
  await updateSettings({ source: 'tether' });
  await startTether();
}

export async function startTether(): Promise<void> {
  if (!tetherHandle) {
    await chooseTetherFolder();
    return;
  }
  const mode = get().settings.removeTetherOriginals ? 'readwrite' : 'read';
  const ok = (await hasPermission(tetherHandle, mode)) || (await requestPermission(tetherHandle, mode));
  if (!ok) {
    set((s) => ({ tether: { ...s.tether, status: 'needs-permission', watching: false } }));
    return;
  }
  watcher?.stop();
  watcher = new FolderWatcher(tetherHandle, {
    onFile: onTetherFile,
    onRawOnly: () => {
      if (rawHintShown) return;
      rawHintShown = true;
      toast({
        tone: 'warning',
        message: 'Unsupported photo format',
        detail: 'Browsers can’t display RAW or HEIF. Set the camera to JPEG (L, fine) — RAW + JPEG also works.',
        duration: 9000,
      });
    },
    onError: (e) => {
      if ((e as DOMException)?.name === 'NotAllowedError') {
        set((s) => ({ tether: { ...s.tether, status: 'needs-permission', watching: false } }));
        watcher?.stop();
      }
    },
  });
  await watcher.start();
  set((s) => ({ tether: { ...s.tether, status: 'connected', watching: true } }));
}

export function stopTether(): void {
  watcher?.stop();
  watcher = null;
  set((s) => ({ tether: { ...s.tether, watching: false } }));
}

async function onTetherFile(file: File, path: string, _handle: FileSystemFileHandle, parent: FileSystemDirectoryHandle): Promise<void> {
  set((s) => ({ tether: { ...s.tether, lastAt: Date.now() } }));
  if (!get().patient) {
    holdPhoto({ file, parent, receivedAt: Date.now(), source: 'tether' });
    return;
  }
  void path;
  await fileHeldPhoto({ file, parent, receivedAt: Date.now(), source: 'tether' });
}

/** A photo arrived with no patient selected: keep it until one is chosen. */
export function holdPhoto(h: HeldPhoto): void {
  set((s) => ({ held: [...s.held, h] }));
  toast({ tone: 'warning', message: 'Photo received — choose a patient', detail: 'It’s waiting and will be filed to the patient you select.' });
}

/** File a photo that arrived from the camera rather than from a shutter press in Lumen. */
export async function fileHeldPhoto(h: HeldPhoto, patient?: Patient): Promise<void> {
  if (get().settings.shutterSound) playShutter();
  set((st) => ({ flashTick: st.flashTick + 1 }));
  const label = h.deviceLabel ?? 'Canon EOS (tethered)';
  const c = await ingest(
    { original: h.file, source: h.source, deviceLabel: label, transform: transformFor(label), takenAt: h.file.lastModified || h.receivedAt, exposure: h.exposure },
    patient,
  );
  if (c && h.source === 'tether' && h.parent && get().settings.removeTetherOriginals) {
    try {
      await h.parent.removeEntry(h.file.name);
    } catch {
      /* leave it; it's already safely stored */
    }
  }
}

export async function fileHeldPhotos(): Promise<void> {
  const { held, patient } = get();
  if (!patient || !held.length) return;
  set({ held: [] });
  for (const h of held) await fileHeldPhoto(h, patient);
  toast({ tone: 'success', message: `${held.length} waiting photo${held.length === 1 ? '' : 's'} filed` });
}

export function discardHeldPhotos(): void {
  set({ held: [] });
}

/* ───────────────────────── sheets & viewer ───────────────────────── */

export function openSheet(sheet: Sheet): void {
  set({ sheet });
}

export function closeSheet(): void {
  set({ sheet: null });
}

export function openLightbox(ids: string[], index: number, source: 'patient' | 'library' = 'patient'): void {
  set({ lightbox: { ids, index, source } });
}

export function closeLightbox(): void {
  set({ lightbox: null });
}

export function stepLightbox(delta: number): void {
  const lb = get().lightbox;
  if (!lb) return;
  const index = Math.min(lb.ids.length - 1, Math.max(0, lb.index + delta));
  set({ lightbox: { ...lb, index } });
}

export function openCompare(a: string, b: string): void {
  set({ compare: [a, b], lightbox: null });
}

export function closeCompare(): void {
  set({ compare: null });
}
