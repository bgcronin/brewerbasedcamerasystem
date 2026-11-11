import { create } from 'zustand';
import { renderAnnotated } from '../lib/annotations';
import { archiveCapture, archivedFileExists, isArchivedAs, removeArchived, renameArchived, syncAnnotatedCopy, updateArchivedMetadata } from '../lib/archive';
import * as db from '../lib/db';
import { addDiagnosis, hasDiagnosis, removeDiagnosis, sameDiagnosis } from '../lib/diagnoses';
import { todayISO, toISODate } from '../lib/dates';
import { encodeBitmap, warmEncoder } from '../lib/encode';
import { fsSupported, hasPermission, isNotFound, pickDirectory, requestPermission } from '../lib/fsaccess';
import { uid } from '../lib/id';
import { displayName } from '../lib/names';
import type { ImportedRecord, ImportResult } from '../lib/importers';
import { captureFileName, patientFolderName } from '../lib/naming';
import { playShutter } from '../lib/sound';
import { FolderWatcher, TETHER_LAST_ATTEMPT } from '../lib/tether';
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
  /** `arriving`: photos the camera folder has started to receive but that are not complete yet. */
  tether: FolderState & { watching: boolean; lastAt?: number; arriving: number };
  held: HeldPhoto[];
  /** Lumen is already open in another window, which is the one filing photos. */
  secondary: boolean;
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
  tether: { status: fsSupported ? 'none' : 'unsupported', watching: false, arriving: 0 },
  held: [],
  secondary: false,
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
/** Photos inside their undo window after Delete: id → the timer that makes the delete final. */
const pendingDeletes = new Map<string, number>();
/** Photos whose archive file is being written right now. */
const archiving = new Set<string>();
let rawHintShown = false;

/** What a photo is filed with: fixed at the moment it is taken, whatever is selected by the time it has been processed. */
interface Labels {
  patient: Patient | null;
  eye: Eye;
  technique: string | null;
  diagnoses: string[];
}
function currentLabels(): Labels {
  const s = get();
  return { patient: s.patient, eye: s.eye, technique: s.technique, diagnoses: s.diagnoses };
}
/** Labels for `ingest`: the diagnoses at the press only matter if that patient is no longer on screen. */
function labelInput(l: Labels) {
  return { eye: l.eye, technique: l.technique, diagnoses: l.patient && get().activePatientId === l.patient.id ? undefined : l.diagnoses };
}

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
  const saved = await db.kvGet<Partial<Settings>>('settings');
  const settings = { ...DEFAULT_SETTINGS, ...saved, transforms: { ...(saved?.transforms ?? {}) } };
  applyTheme(settings.theme);

  // One window files photos at a time. A second window would watch the camera folder and
  // write to the archive as well, filing every photo twice.
  if (!(await claimWindow(false))) {
    set({ secondary: true, ready: true });
    return;
  }

  warmEncoder();
  set({ settings });

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

  // Finish what the last session left: deletes still in their undo window when the window
  // was closed, and photos that were waiting for a patient.
  for (const c of await db.deletedCaptures()) await commitDelete(c.id);
  // From here on the waiting list is written to the database whenever it changes.
  useApp.subscribe((s, prev) => {
    if (s.held !== prev.held) void db.kvSet('heldPhotos', s.held).catch(() => undefined);
  });
  const waiting = (await db.kvGet<HeldPhoto[]>('heldPhotos')) ?? [];
  // Photos the camera helper had handed over when the window closed, before they were filed.
  const handedOver = await db.kvKeys('incoming:');
  for (const key of handedOver) {
    const item = await db.kvGet<{ header: { name: string; takenAt: number; exposure?: Capture['exposure'] }; blob: Blob }>(key);
    if (!item?.blob) continue;
    const file = new File([item.blob], item.header.name, { type: 'image/jpeg', lastModified: item.header.takenAt });
    waiting.push({ file, receivedAt: Date.now(), source: 'canon', exposure: item.header.exposure });
  }
  if (waiting.length) set({ held: waiting });
  // Only once they are safely on the waiting list are the hand-over copies let go.
  if (handedOver.length) {
    await db.kvSet('heldPhotos', waiting);
    for (const key of handedOver) await db.kvDelete(key);
  }

  await Promise.all([loadRows(), refreshPending(), refreshAllPatients()]);
  // Photos, relabels, marks and removals that never reached the archive folder are put right now.
  if (get().archive.status === 'connected') void syncArchive(true);
  const lastPatient = await db.kvGet<{ id: string; date: string }>('lastPatient');
  if (lastPatient && lastPatient.date === todayISO()) await selectPatient(lastPatient.id);
  set({ ready: true });

  // Ask the browser not to evict our data under storage pressure.
  void navigator.storage?.persist?.().catch(() => undefined);
}

/**
 * Hold (or take) the right to be the working Lumen window. Resolves false when another
 * window already has it. If this window later loses it, it stops watching and filing.
 */
function claimWindow(steal: boolean): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    locks
      .request('lumen-window', steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        // Kept for as long as this window lives.
        return lock ? new Promise<void>(() => undefined) : undefined;
      })
      .catch(() => {
        // Another window took over ("Use this window" was chosen there).
        watcher?.stop();
        watcher = null;
        set((s) => ({ secondary: true, lightbox: null, compare: null, sheet: null, tether: { ...s.tether, watching: false } }));
      });
  });
}

/** Make this the working window (the other one steps aside), then start afresh. */
export async function takeOverWindow(): Promise<void> {
  await claimWindow(true);
  window.location.reload();
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
  const all = rows.map((r) => r.patient.id);
  const ids = visiblePatientIds ?? all;
  if (!ids.length) return;
  const i = ids.indexOf(activePatientId ?? '');
  if (i >= 0) {
    void selectPatient(ids[Math.min(ids.length - 1, Math.max(0, i + delta))]);
    return;
  }
  // The active patient is not in the list as filtered (under "To do" they leave it with their
  // first photo): carry on from their place in the day, not from the top.
  const at = all.indexOf(activePatientId ?? '');
  if (at < 0) {
    void selectPatient(delta > 0 ? ids[0] : ids[ids.length - 1]);
    return;
  }
  const onward = delta > 0 ? all.slice(at + 1) : all.slice(0, at).reverse();
  const next = onward.find((id) => ids.includes(id));
  if (next) void selectPatient(next);
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
    // Only the edited fields are written, so nothing else on the record (its archive folder, for one) can be lost.
    const fields = { mrn: form.mrn, firstName: form.firstName, lastName: form.lastName, dob: form.dob, sex: form.sex, notes: form.notes };
    patient = (await db.patchPatient(patientId, fields)) ?? { ...existing, ...fields };
  } else if (existingWithMrn) {
    // Same MRN as a known patient: add the visit to their record rather than renaming them.
    const fields = { dob: existingWithMrn.dob ?? form.dob, sex: existingWithMrn.sex || form.sex };
    patient = (await db.patchPatient(existingWithMrn.id, fields)) ?? { ...existingWithMrn, ...fields };
    toast({ message: `${form.mrn} is already ${displayName(existingWithMrn)}`, detail: 'Their existing record was used. Edit it if the details need changing.', duration: 7000 });
  } else {
    patient = { id: uid(), mrn: form.mrn, firstName: form.firstName, lastName: form.lastName, dob: form.dob, sex: form.sex, notes: form.notes, createdAt: now, updatedAt: now };
    await db.putPatient(patient);
  }

  // Editing a patient must never add them to a day's list; only adding (or editing a listed visit) touches visits.
  const visit = visitId ? await db.getVisit(visitId) : !patientId ? await db.ensureVisit(patient.id, get().date, 'manual') : undefined;
  if (visit) await db.putVisit({ ...visit, time: form.time || undefined, clinic: form.clinic || undefined, reason: form.reason || undefined });

  await Promise.all([loadRows(), refreshAllPatients()]);
  if (get().activePatientId === patient.id || !patientId) await selectPatient(patient.id);
  return patient.id;
}

export async function removeFromList(visitId: string): Promise<void> {
  // A photo deleted a moment ago could still come back with Undo. Make those deletes final first,
  // so a restored photo can never be left belonging to a visit that no longer exists.
  for (const c of await db.deletedCaptures()) if (c.visitId === visitId) await commitDelete(c.id);
  const caps = (await db.capturesForDate(get().date)).filter((c) => c.visitId === visitId);
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
  /** Say nothing if the photo can't be stored: the caller will (it still has the photo, and says where it went). */
  quiet?: boolean;
}

/** The single path every photo takes into the system: encode → store → archive. */
export async function ingest(input: IngestInput, patientOverride?: Patient): Promise<Capture | null> {
  const s = get();
  const patient = patientOverride ?? s.patient;
  if (!patient || s.secondary) return null;
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

    // A folder that failed last time is tried again with every photo, so it recovers by itself.
    const status = get().archive.status;
    if (archiveHandle && (status === 'connected' || status === 'error')) {
      archiving.add(capture.id);
      try {
        const owner = await pinArchiveFolder(patient);
        const path = await archiveCapture(archiveHandle, owner, visit, capture, full);
        await afterArchived(capture, path);
        if (status === 'error') {
          set((st) => ({ archive: { ...st.archive, status: 'connected' } }));
          void syncArchive(true);
        }
      } catch (e) {
        if (status !== 'error') {
          set((st) => ({ archive: { ...st.archive, status: 'error' } }));
          toast({ tone: 'error', message: 'Couldn’t write to the archive folder', detail: `Saved safely in Lumen. ${(e as Error).message}` });
        }
        void refreshPending();
      } finally {
        archiving.delete(capture.id);
      }
    } else {
      void refreshPending();
    }
    return capture;
  } catch (e) {
    if (!input.quiet) toast({ tone: 'error', message: 'Photo not saved', detail: (e as Error).message });
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

/**
 * The archive folder is chosen once per patient and then kept, whatever later corrections say.
 * Only that one field is written, on the record as it is in the database now.
 */
async function pinArchiveFolder(patient: Patient): Promise<Patient> {
  if (patient.archiveFolder) return patient;
  // Photos archived before folders were fixed stay where they are: carry on in the same folder.
  const earlier = (await db.capturesForPatient(patient.id)).find((c) => c.archivedPath)?.archivedPath?.split('/')[0];
  const pinned = (await db.pinArchiveFolder(patient.id, earlier ?? patientFolderName(patient))) ?? patient;
  if (pinned.archiveFolder) {
    const archiveFolder = pinned.archiveFolder;
    set((st) => (st.patient?.id === patient.id ? { patient: { ...st.patient, archiveFolder } } : {}));
  }
  return pinned;
}

/** What visit.json and the file name say about a photo. */
const archiveMeta = (x: Capture) => JSON.stringify([x.fileName, x.eye, x.technique ?? '', x.diagnoses ?? [], x.note ?? '', !!x.starred]);

/** Record where a photo was written, and put right anything that changed (or was deleted) while it was being written. */
async function afterArchived(written: Capture, path: string): Promise<void> {
  const stored = await patchCapture(written.id, { archivedPath: path });
  if (!stored) {
    // Deleted for good while its file was still being written: the file must go too.
    await queueRemoval(path);
    void processArchiveRemovals();
    return;
  }
  if (stored.deletedAt) {
    // Deleted while the file was being written. Inside the undo period the file is dealt with
    // when the delete is made final; if that is already under way, it is queued here.
    if (!pendingDeletes.has(written.id)) {
      await queueRemoval(path);
      void processArchiveRemovals();
    }
    return;
  }
  if (archiveMeta(stored) !== archiveMeta(written)) {
    await patchCapture(written.id, { archiveDirty: true });
    await inCaptureOrder(() => reconcileArchive(written.id)).catch(() => undefined);
  }
}

/** Fire the shutter for the live camera. */
export async function captureFromLive(grab: () => Promise<ImageBitmap>, deviceLabel: string | undefined): Promise<void> {
  // Who and which eye are fixed now, at the press, not when the frame has been grabbed and encoded.
  const labels = currentLabels();
  if (!labels.patient) {
    toast({ tone: 'warning', message: 'Choose a patient first', detail: 'Pick someone from the list on the left.' });
    return;
  }
  const takenAt = Date.now();
  let bitmap: ImageBitmap;
  try {
    bitmap = await grab();
  } catch (e) {
    toast({ tone: 'warning', message: (e as Error).message });
    return;
  }
  set((st) => ({ flashTick: st.flashTick + 1 }));
  if (get().settings.shutterSound) playShutter();
  await ingest({ bitmap, source: 'live', deviceLabel, transform: transformFor(deviceLabel), takenAt, ...labelInput(labels) }, labels.patient);
}

export async function importFiles(files: File[]): Promise<void> {
  // The whole batch goes to the patient, eye and illumination selected when it was dropped,
  // even if the selection moves on while the files are still being read.
  const labels = currentLabels();
  if (!labels.patient) {
    toast({ tone: 'warning', message: 'Choose a patient first' });
    return;
  }
  const images = files.filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
  let added = 0;
  for (const f of images) {
    // A file's own timestamp is kept only if it was taken today; older files are filed with the time they were added.
    const takenToday = f.lastModified && toISODate(new Date(f.lastModified)) === todayISO();
    const c = await ingest(
      { original: f, source: 'file', transform: { rotate: 0, flipH: false, flipV: false }, takenAt: takenToday ? f.lastModified : Date.now(), ...labelInput(labels) },
      labels.patient,
    );
    if (c) added++;
  }
  if (added) toast({ tone: 'success', message: `${added} photo${added === 1 ? '' : 's'} added to ${displayName(labels.patient)}` });
  if (images.length < files.length) toast({ tone: 'warning', message: 'Some files were skipped', detail: 'Only JPEG, PNG and WebP images can be imported.' });
}

// Changes to a photo are applied strictly one after another, each starting from the record as
// the last one left it: two quick relabels can never cross, in the database or in the archive.
let captureWork: Promise<unknown> = Promise.resolve();
function inCaptureOrder<T>(job: () => Promise<T>): Promise<T> {
  const run = captureWork.then(job, job);
  captureWork = run.catch(() => undefined);
  return run;
}

type CaptureEdit = Partial<Pick<Capture, 'eye' | 'technique' | 'note' | 'starred' | 'diagnoses'>>;

export function updateCapture(id: string, patch: CaptureEdit): Promise<void> {
  // Shown at once; the stored record and the archive follow in order.
  const show = (x: Capture) => (x.id === id ? { ...x, ...patch } : x);
  set((st) => ({ captures: st.captures.map(show), library: st.library ? st.library.map(show) : st.library }));
  return inCaptureOrder(async () => {
    const c = await db.getCapture(id);
    if (!c) return;
    const merged = { ...c, ...patch };
    // The eye and technique are part of the file name, so a relabel renames the file too.
    const relabelled = merged.eye !== c.eye || merged.technique !== c.technique;
    const patient = relabelled ? await db.getPatient(c.patientId) : undefined;
    const fileName = patient ? captureFileName(patient, { takenAt: merged.takenAt, eye: merged.eye, technique: merged.technique }, merged.mime) : c.fileName;
    // The archive copy is marked out of date in the same write as the change itself, so the two can never part company.
    await patchCapture(id, { ...patch, fileName, archiveDirty: c.archivedPath ? true : c.archiveDirty });
    try {
      await reconcileArchive(id);
    } catch (e) {
      warnArchiveBehind(e);
    }
    void refreshPending();
  });
}

let lastArchiveWarning = 0;
function warnArchiveBehind(e: unknown): void {
  if (Date.now() - lastArchiveWarning < 15_000) return;
  lastArchiveWarning = Date.now();
  toast({ tone: 'warning', message: 'Archive copy not updated yet', detail: `The change is saved in Lumen and will be written to the folder at the next sync. ${(e as Error)?.message ?? ''}` });
}

/**
 * Bring a photo's archive copy into line with its record: the file name (eye and technique are
 * part of it) and its entry in visit.json. Works from the record as it is now, not from what a
 * particular edit asked for, so it is safe to run late, twice, or after several edits at once.
 * If the folder is unavailable the photo simply stays marked and the next sync does it.
 */
async function reconcileArchive(id: string): Promise<void> {
  if (!archiveHandle || get().archive.status !== 'connected') return;
  const c = await db.getCapture(id);
  if (!c?.archivedPath || !c.archiveDirty) return;
  const [patient, visit] = await Promise.all([db.getPatient(c.patientId), db.getVisit(c.visitId)]);
  if (!patient || !visit) return;
  try {
    const onDisk = c.archivedPath.split('/').pop()!;
    if (isArchivedAs(onDisk, c.fileName)) {
      await updateArchivedMetadata(archiveHandle, patient, visit, c);
    } else {
      // The new path is saved the moment the file has its new name, before visit.json is touched.
      await renameArchived(archiveHandle, patient, visit, c, c.fileName, async (paths) => {
        await patchCapture(id, paths);
      });
    }
    await patchCapture(id, { archiveDirty: undefined });
  } catch (e) {
    if (!isNotFound(e)) throw e;
    // The archive copy was moved or deleted by hand. Forget it: the next sync writes a fresh one.
    await patchCapture(id, { archivedPath: undefined, annotatedPath: undefined, annotatedAt: undefined, archiveDirty: undefined });
    void syncArchive(true);
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

const UNDO_MS = 6500;

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
  // Marked in the database straight away: closing or reloading the window during the undo
  // period can no longer bring the photo back. The mark is made final when the period ends,
  // or at the next start.
  void db.patchCapture(id, { deletedAt: Date.now() });
  pendingDeletes.set(id, window.setTimeout(() => void commitDelete(id), UNDO_MS));
  toast({ message: 'Photo deleted', action: { label: 'Undo', run: () => void undoDelete(id) }, duration: UNDO_MS });
}

async function undoDelete(id: string): Promise<void> {
  const timer = pendingDeletes.get(id);
  if (timer == null) return; // already final
  window.clearTimeout(timer);
  pendingDeletes.delete(id);
  const c = await db.patchCapture(id, { deletedAt: undefined });
  if (!c) return;
  set((st) => ({
    library: st.library && !st.library.some((x) => x.id === id) ? [...st.library, c] : st.library,
    ...(st.activePatientId === c.patientId && !st.captures.some((x) => x.id === id) ? { captures: [...st.captures, c].sort((a, b) => a.takenAt - b.takenAt) } : {}),
  }));
  void loadRows();
  void refreshPending();
}

/** Make a delete final: the archive file is queued for removal first, then the record goes. */
async function commitDelete(id: string): Promise<void> {
  const timer = pendingDeletes.get(id);
  if (timer != null) window.clearTimeout(timer);
  pendingDeletes.delete(id);
  // The record as it is now, not as it was when Delete was pressed: its archive file may
  // only have been written since.
  const c = await db.getCaptureRaw(id);
  if (!c?.deletedAt) return;
  if (c.archivedPath) await queueRemoval(c.archivedPath);
  await db.deleteCapture(id);
  forgetThumb(id);
  await processArchiveRemovals();
  void refreshPending();
}

/** Files to remove from the archive folder, remembered until it has been done (the folder may be away). */
type Removal = { path: string } | { capture: Capture }; // the second shape is from earlier versions
const removalPath = (r: Removal) => ('path' in r ? r.path : r.capture?.archivedPath);

async function queueRemoval(path: string): Promise<void> {
  await db.kvUpdate<Removal[]>('archiveRemovals', (list) => [...(list ?? []).filter((r) => removalPath(r) !== path), { path }]);
}

let removals: Promise<void> = Promise.resolve();
function processArchiveRemovals(): Promise<void> {
  removals = removals
    .then(async () => {
      if (!archiveHandle || get().archive.status !== 'connected') return;
      for (const r of (await db.kvGet<Removal[]>('archiveRemovals')) ?? []) {
        const path = removalPath(r);
        try {
          if (path) await removeArchived(archiveHandle, path);
        } catch {
          continue; // still queued; tried again at the next sync
        }
        await db.kvUpdate<Removal[]>('archiveRemovals', (list) => (list ?? []).filter((x) => removalPath(x) !== path));
      }
    })
    .catch(() => undefined);
  return removals;
}

/* ───────────────────────── archive folder ───────────────────────── */

async function refreshPending(): Promise<void> {
  const all = await db.allCaptures();
  // Marks drawn a moment ago are about to be written; they only count once that has failed or been missed.
  const waiting = (c: Capture) => !c.archivedPath || !!c.archiveDirty || (db.annotatedCopyStale(c) && !annotationTimers.has(c.id));
  const pending = all.filter(waiting).length;
  set((s) => ({ archive: { ...s.archive, pending } }));
}

export async function chooseArchiveFolder(): Promise<void> {
  const handle = await pickDirectory('lumen-archive', 'readwrite');
  if (!handle) return;
  const previous = archiveHandle;
  archiveHandle = handle;
  await db.kvSet('archiveHandle', handle);
  set((s) => ({ archive: { ...s.archive, status: 'connected', name: handle.name } }));
  toast({ tone: 'success', message: `Archiving to “${handle.name}”` });
  const sameFolder = previous ? await previous.isSameEntry(handle).catch(() => false) : false;
  if (previous && !sameFolder) await forgetCopiesNotIn(handle);
  await syncArchive();
}

/**
 * After the archive folder is changed, photos that are not in the new folder are no longer
 * counted as archived, so the sync that follows writes them there and the new folder is complete.
 */
async function forgetCopiesNotIn(root: FileSystemDirectoryHandle): Promise<void> {
  for (const c of (await db.allCaptures()).filter((x) => x.archivedPath)) {
    try {
      if (await archivedFileExists(root, c.archivedPath!)) continue;
    } catch {
      return; // the folder can't be read; leave the records as they are
    }
    await patchCapture(c.id, { archivedPath: undefined, annotatedPath: undefined, annotatedAt: undefined, archiveDirty: undefined });
  }
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

let syncing: Promise<void> | null = null;

/**
 * Bring the archive folder up to date: photos not yet written, relabels and edits that
 * never reached it, annotated copies, and files waiting to be removed. Only one sync runs at
 * a time; asking again while one is running waits for that one.
 */
export function syncArchive(quiet = false): Promise<void> {
  syncing ??= runSync(quiet).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function runSync(quiet: boolean): Promise<void> {
  if (!archiveHandle) return;
  const root = archiveHandle;
  let done = 0;
  let failed = 0;
  let streak = 0;
  let lastError = '';

  // 1. Relabels and edits made while the folder was away.
  for (const c of (await db.allCaptures()).filter((x) => x.archivedPath && x.archiveDirty)) {
    try {
      await inCaptureOrder(() => reconcileArchive(c.id));
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  // 2. Photos not written yet. One that fails is skipped, not allowed to hold up the rest.
  for (const listed of (await db.allCaptures()).filter((x) => !x.archivedPath)) {
    if (streak >= 3) break; // the folder itself is unavailable: stop rather than fail once per photo
    if (archiving.has(listed.id)) continue; // being written by the capture that made it
    const c = await db.getCapture(listed.id);
    if (!c || c.archivedPath) continue;
    const [patient, visit, img] = await Promise.all([db.getPatient(c.patientId), db.getVisit(c.visitId), db.getImage(c.id)]);
    if (!patient || !visit || !img) continue;
    archiving.add(c.id);
    try {
      const owner = await pinArchiveFolder(patient);
      const path = await archiveCapture(root, owner, visit, c, img.full);
      await afterArchived(c, path);
      done++;
      streak = 0;
      if (done % 10 === 0) void refreshPending();
    } catch (e) {
      failed++;
      streak++;
      lastError = (e as Error).message;
    } finally {
      archiving.delete(c.id);
    }
  }

  if (failed && !done) {
    set((s) => ({ archive: { ...s.archive, status: 'error' } }));
    toast({ tone: 'error', message: 'Archive sync stopped', detail: lastError });
  } else {
    if (get().archive.status === 'error') set((s) => ({ archive: { ...s.archive, status: 'connected' } }));
    if (failed) toast({ tone: 'warning', message: `${failed} photo${failed === 1 ? '' : 's'} could not be written yet`, detail: `They are safe in Lumen and will be tried again. ${lastError}` });
    if (done && !quiet) toast({ tone: 'success', message: `${done} photo${done === 1 ? '' : 's'} written to the archive` });
  }

  if (get().archive.status === 'connected') {
    // 3. Annotated copies.
    for (const c of (await db.allCaptures()).filter((x) => db.annotatedCopyStale(x) && !annotationTimers.has(x.id))) {
      try {
        await writeAnnotatedCopy(c.id);
      } catch {
        break; // the folder has gone away again; try next time
      }
    }
    // 4. Files of photos that have been deleted.
    await processArchiveRemovals();
  }
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

/** What was selected when each arriving file was first seen, by its path in the folder. */
const tetherLabels = new Map<string, Labels>();
let tetherHeartbeat: number | null = null;

/** Remember when this folder was last being watched, so photos that arrive while it isn't can be found afterwards. */
function noteTetherWatched(): void {
  if (tetherHandle && watcher?.running) void db.kvSet('tetherWatchedAt', { name: tetherHandle.name, at: Date.now() }).catch(() => undefined);
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
  tetherLabels.clear();
  const missed: HeldPhoto[] = [];
  watcher = new FolderWatcher(tetherHandle, {
    // The photo is labelled with what is selected NOW, as it starts to arrive. It takes a
    // second or two more to finish writing, and the selection may have moved on by then.
    onSeen: (path) => {
      if (tetherLabels.has(path)) return;
      tetherLabels.set(path, currentLabels());
      set((s) => ({ tether: { ...s.tether, arriving: tetherLabels.size } }));
    },
    onFile: onTetherFile,
    onMissed: (file, _path, _handle, parent) => missed.push({ file, parent, receivedAt: Date.now(), source: 'tether' }),
    onRawOnly: () => {
      if (rawHintShown) return;
      rawHintShown = true;
      toast({
        tone: 'warning',
        message: 'Unsupported photo format',
        detail: 'Browsers can’t display RAW or HEIF. Set the camera to JPEG (L, fine). RAW + JPEG also works.',
        duration: 9000,
      });
    },
    onError: (e, streak) => {
      if ((e as DOMException)?.name === 'NotAllowedError') {
        set((s) => ({ tether: { ...s.tether, status: 'needs-permission', watching: false } }));
        watcher?.stop();
      } else if (streak === 5) {
        // Say so rather than go on showing "Watching" over a folder that can't be read.
        set((s) => ({ tether: { ...s.tether, status: 'error' } }));
        toast({
          tone: 'error',
          message: 'The camera folder can’t be read',
          detail: `Lumen keeps trying. Check that “${tetherHandle?.name}” still exists and its drive is connected. ${(e as Error)?.message ?? ''}`,
          duration: 12000,
        });
      }
    },
    onRecovered: () => set((s) => (s.tether.status === 'error' ? { tether: { ...s.tether, status: 'connected' } } : {})),
  });
  const before = await db.kvGet<{ name: string; at: number }>('tetherWatchedAt');
  await watcher.start(before?.name === tetherHandle.name ? before.at : undefined);
  set((s) => ({ tether: { ...s.tether, status: 'connected', watching: true, arriving: 0 } }));
  noteTetherWatched();
  if (tetherHeartbeat != null) window.clearInterval(tetherHeartbeat);
  tetherHeartbeat = window.setInterval(noteTetherWatched, 15_000);
  if (missed.length) {
    // Taken while Lumen was closed or waiting for permission. They are not filed to whoever
    // happens to be selected now: they wait until someone says whose they are.
    set((s) => ({ held: [...s.held, ...missed] }));
    toast({
      tone: 'warning',
      message: `${missed.length} photo${missed.length === 1 ? '' : 's'} arrived while Lumen wasn’t watching`,
      detail: 'Choose the patient, then “File to”. Dismiss them if they are not for a patient.',
      duration: 12000,
    });
  }
}

export function stopTether(): void {
  noteTetherWatched();
  if (tetherHeartbeat != null) window.clearInterval(tetherHeartbeat);
  tetherHeartbeat = null;
  watcher?.stop();
  watcher = null;
  tetherLabels.clear();
  set((s) => ({ tether: { ...s.tether, watching: false, arriving: 0 } }));
}

async function onTetherFile(file: File, path: string, _handle: FileSystemFileHandle, parent: FileSystemDirectoryHandle, attempt: number): Promise<void> {
  const labels = tetherLabels.get(path);
  const settle = () => {
    tetherLabels.delete(path);
    set((s) => ({ tether: { ...s.tether, lastAt: Date.now(), arriving: tetherLabels.size } }));
  };
  const h: HeldPhoto = { file, parent, receivedAt: Date.now(), source: 'tether' };
  const patient = labels ? labels.patient : get().patient;
  if (!patient) {
    // Nobody was selected when it was taken: it waits for a patient.
    settle();
    holdPhoto(h);
    return;
  }
  if (await fileHeldPhoto(h, patient, labels)) {
    settle();
    return;
  }
  // Not readable yet (perhaps still being written): the watcher tries twice more, with the same labels.
  if (attempt < TETHER_LAST_ATTEMPT) throw new Error('Photo not readable yet');
  settle();
  toast({
    tone: 'error',
    message: `Couldn’t read ${file.name}`,
    detail: 'It is still in the camera folder. If it opens in a photo viewer, add it with “Add photos from files”.',
    duration: 15000,
  });
}

/**
 * Keep a photo in the waiting banner: it arrived with no patient selected, or (`'failed'`) it
 * could not be stored just now. Either way it is not lost, and it survives a reload.
 */
export function holdPhoto(h: HeldPhoto, why: 'no-patient' | 'failed' = 'no-patient'): void {
  const first = get().held.length === 0;
  set((s) => ({ held: [...s.held, h] }));
  if (why === 'failed') {
    toast({ tone: 'error', message: 'Photo not filed yet', detail: 'It couldn’t be stored just now, so it is waiting above the live view. Choose “File to” to try again.', duration: 9000 });
    return;
  }
  // One notice is enough: the banner over the live view keeps count of the rest.
  if (first) toast({ tone: 'warning', message: 'Photo received. Choose a patient', detail: 'It’s waiting and will be filed to the patient you select.' });
}

/**
 * File a photo that arrived from the camera rather than from a shutter press in Lumen.
 * Returns false if it could not be read or stored (nothing is lost: the caller still has it).
 */
export async function fileHeldPhoto(h: HeldPhoto, patient?: Patient, labels?: Labels): Promise<boolean> {
  const label = h.deviceLabel ?? 'Canon EOS (tethered)';
  // A camera's clock can be hours out. Its time is used only when it agrees with when the photo arrived.
  const fileTime = h.file.lastModified;
  const takenAt = fileTime && Math.abs(fileTime - h.receivedAt) < 10 * 60_000 ? fileTime : h.receivedAt;
  const c = await ingest(
    { original: h.file, source: h.source, deviceLabel: label, transform: transformFor(label), takenAt, exposure: h.exposure, quiet: true, ...(labels ? labelInput(labels) : {}) },
    patient,
  );
  if (!c) return false;
  if (get().settings.shutterSound) playShutter();
  set((st) => ({ flashTick: st.flashTick + 1 }));
  if (h.source === 'tether' && h.parent && get().settings.removeTetherOriginals) {
    // The camera's own copy is only tidied away once the photo is safely in the archive folder
    // (or when no archive folder is in use and Lumen is the record by choice).
    const status = get().archive.status;
    const archived = !!(await db.getCapture(c.id))?.archivedPath;
    if (archived || status === 'none' || status === 'unsupported') {
      try {
        await h.parent.removeEntry(h.file.name);
      } catch {
        /* leave it; it's already safely stored */
      }
    }
  }
  return true;
}

export async function fileHeldPhotos(): Promise<void> {
  const { held, patient } = get();
  if (!patient || !held.length) return;
  set({ held: [] });
  const labels = currentLabels();
  const failed: HeldPhoto[] = [];
  for (const h of held) if (!(await fileHeldPhoto(h, patient, labels))) failed.push(h);
  // Anything that could not be read stays in the banner rather than disappearing.
  if (failed.length) {
    set((s) => ({ held: [...failed, ...s.held] }));
    toast({
      tone: 'error',
      message: `${failed.length} photo${failed.length === 1 ? '' : 's'} couldn’t be filed`,
      detail: 'They are still waiting above the live view. Try again, or dismiss them if the files are damaged.',
      duration: 9000,
    });
  }
  const filed = held.length - failed.length;
  if (filed) toast({ tone: 'success', message: `${filed} waiting photo${filed === 1 ? '' : 's'} filed to ${displayName(patient)}` });
}

export function discardHeldPhotos(): void {
  const dropped = get().held;
  if (!dropped.length) return;
  set({ held: [] });
  toast({
    message: `${dropped.length} waiting photo${dropped.length === 1 ? '' : 's'} discarded`,
    action: { label: 'Undo', run: () => set((s) => ({ held: [...dropped, ...s.held] })) },
  });
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
