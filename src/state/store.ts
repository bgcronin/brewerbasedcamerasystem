import { create } from 'zustand';
import { archiveCapture, removeArchived, updateArchivedMetadata } from '../lib/archive';
import * as db from '../lib/db';
import { todayISO } from '../lib/dates';
import { encodeBitmap } from '../lib/encode';
import { fsSupported, hasPermission, pickDirectory, requestPermission } from '../lib/fsaccess';
import { uid } from '../lib/id';
import type { ImportedRecord, ImportResult } from '../lib/importers';
import { captureFileName } from '../lib/naming';
import { playShutter } from '../lib/sound';
import { FolderWatcher } from '../lib/tether';
import { forgetThumb, primeThumb } from '../lib/thumbs';
import {
  DEFAULT_SETTINGS,
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

export type View = 'capture' | 'review';

export interface Toast {
  id: string;
  message: string;
  detail?: string;
  tone?: 'default' | 'success' | 'warning' | 'error';
  action?: { label: string; run: () => void };
  duration?: number;
}

export type Sheet =
  | { type: 'import'; result?: ImportResult }
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
  eye: Eye;
  technique: string | null;
  view: View;
  processing: number;
  flashTick: number;
  lastCaptureId: string | null;
  archive: FolderState & { pending: number };
  tether: FolderState & { watching: boolean; lastAt?: number };
  held: HeldPhoto[];
  toasts: Toast[];
  sheet: Sheet;
  lightbox: { ids: string[]; index: number } | null;
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
  eye: 'OD',
  technique: null,
  view: 'capture',
  processing: 0,
  flashTick: 0,
  lastCaptureId: null,
  archive: { status: fsSupported ? 'none' : 'unsupported', pending: 0 },
  tether: { status: fsSupported ? 'none' : 'unsupported', watching: false },
  held: [],
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
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, ...t }] }));
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
    set({ activePatientId: null, patient: null, captures: [], patientVisits: [], lastCaptureId: null });
    return;
  }
  // Switch synchronously, so a shutter press straight after choosing a patient can
  // never be filed to the previous one while their history loads.
  const s = get();
  const switching = s.activePatientId !== id;
  const known = s.rows.find((r) => r.patient.id === id)?.patient ?? s.allPatients.find((p) => p.id === id) ?? null;
  if (switching) {
    set({ activePatientId: id, patient: known, captures: [], patientVisits: [], eye: 'OD', lastCaptureId: null });
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
    return {
      patient,
      captures: [...captures.filter((c) => !pendingDeletes.has(c.id)), ...extra].sort((a, b) => a.takenAt - b.takenAt),
      patientVisits: visits,
    };
  });
  void db.kvSet('lastPatient', { id, date: todayISO() });
}

export function selectAdjacent(delta: 1 | -1): void {
  const { rows, activePatientId } = get();
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.patient.id === activePatientId);
  const next = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + delta));
  void selectPatient(rows[next].patient.id);
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
      .join(' · '),
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
  if (patientId) {
    const existing = await db.getPatient(patientId);
    if (!existing) throw new Error('Patient not found');
    patient = { ...existing, mrn: form.mrn, firstName: form.firstName, lastName: form.lastName, dob: form.dob, sex: form.sex, notes: form.notes };
  } else {
    const dupe = form.mrn ? get().allPatients.find((p) => p.mrn && p.mrn.toLowerCase() === form.mrn.toLowerCase()) : undefined;
    patient = dupe
      ? { ...dupe, firstName: form.firstName, lastName: form.lastName, dob: form.dob ?? dupe.dob, sex: form.sex || dupe.sex }
      : { id: uid(), mrn: form.mrn, firstName: form.firstName, lastName: form.lastName, dob: form.dob, sex: form.sex, notes: form.notes, createdAt: now, updatedAt: now };
  }
  await db.putPatient(patient);

  const visit = visitId ? await db.getVisit(visitId) : await db.ensureVisit(patient.id, get().date, 'manual');
  if (visit) await db.putVisit({ ...visit, time: form.time || undefined, clinic: form.clinic || undefined, reason: form.reason || undefined });

  await Promise.all([loadRows(), refreshAllPatients()]);
  if (get().activePatientId === patient.id || !patientId) await selectPatient(patient.id);
  return patient.id;
}

export async function removeFromList(visitId: string): Promise<void> {
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
      const r = await encodeBitmap({ bitmap, transform: input.transform, format: settings.format, quality: settings.quality, thumbSize: 640, thumbOnly: true });
      full = input.original!;
      ({ thumb, width, height } = r);
    } else {
      const r = await encodeBitmap({ bitmap, transform: input.transform, format: settings.format, quality: settings.quality, thumbSize: 640 });
      full = r.full!;
      ({ thumb, width, height } = r);
    }
    const mime = full.type || 'image/jpeg';
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
    };
    await db.addCapture(capture, { id: capture.id, full, thumb });
    primeThumb(capture.id, thumb);

    set((st) =>
      st.activePatientId === patient.id
        ? {
            captures: [...st.captures, capture],
            lastCaptureId: capture.id,
            patientVisits: st.patientVisits.some((v) => v.id === visit.id) ? st.patientVisits : [visit, ...st.patientVisits],
          }
        : {},
    );
    void loadRows();

    if (archiveHandle && get().archive.status === 'connected') {
      try {
        const path = await archiveCapture(archiveHandle, patient, visit, capture, full);
        await commitCapture({ ...capture, archivedPath: path });
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

async function commitCapture(c: Capture): Promise<void> {
  await db.putCapture(c);
  set((st) => ({ captures: st.captures.map((x) => (x.id === c.id ? c : x)) }));
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
  for (const f of images) await ingest({ original: f, source: 'file', transform: { rotate: 0, flipH: false, flipV: false }, takenAt: f.lastModified || Date.now() });
  if (images.length) toast({ tone: 'success', message: `${images.length} photo${images.length === 1 ? '' : 's'} added` });
  if (images.length < files.length) toast({ tone: 'warning', message: 'Some files were skipped', detail: 'Only JPEG, PNG and WebP images can be imported.' });
}

export async function updateCapture(id: string, patch: Partial<Pick<Capture, 'eye' | 'technique' | 'note' | 'starred'>>): Promise<void> {
  const c = get().captures.find((x) => x.id === id) ?? (await db.getCapture(id));
  if (!c) return;
  const next = { ...c, ...patch };
  await commitCapture(next);
  if (archiveHandle && next.archivedPath && get().archive.status === 'connected') {
    const [patient, visit] = await Promise.all([db.getPatient(next.patientId), db.getVisit(next.visitId)]);
    if (patient && visit) void updateArchivedMetadata(archiveHandle, patient, visit, next).catch(() => undefined);
  }
}

/** Delete with a short undo window, Apple-style. */
export function deleteCapture(id: string): void {
  const c = get().captures.find((x) => x.id === id);
  if (!c) return;
  set((st) => ({
    captures: st.captures.filter((x) => x.id !== id),
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
        set((st) =>
          st.activePatientId === c.patientId
            ? { captures: [...st.captures, c].sort((a, b) => a.takenAt - b.takenAt) }
            : {},
        );
        void loadRows();
      },
    },
  });
}

async function commitDelete(c: Capture): Promise<void> {
  pendingDeletes.delete(c.id);
  await db.deleteCapture(c.id);
  forgetThumb(c.id);
  if (archiveHandle && c.archivedPath && get().archive.status === 'connected') {
    const [patient, visit] = await Promise.all([db.getPatient(c.patientId), db.getVisit(c.visitId)]);
    if (patient && visit) await removeArchived(archiveHandle, patient, visit, c).catch(() => undefined);
  }
  void refreshPending();
}

/* ───────────────────────── archive folder ───────────────────────── */

async function refreshPending(): Promise<void> {
  const pending = (await db.unarchivedCaptures()).filter((c) => !pendingDeletes.has(c.id)).length;
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

/** Write anything that was captured while the archive folder was unavailable. */
export async function syncArchive(): Promise<void> {
  if (!archiveHandle) return;
  const pending = (await db.unarchivedCaptures()).filter((c) => !pendingDeletes.has(c.id));
  let done = 0;
  for (const c of pending) {
    const [patient, visit, img] = await Promise.all([db.getPatient(c.patientId), db.getVisit(c.visitId), db.getImage(c.id)]);
    if (!patient || !visit || !img) continue;
    try {
      const path = await archiveCapture(archiveHandle, patient, visit, c, img.full);
      await commitCapture({ ...c, archivedPath: path });
      done++;
    } catch (e) {
      set((s) => ({ archive: { ...s.archive, status: 'error' } }));
      toast({ tone: 'error', message: 'Archive sync stopped', detail: (e as Error).message });
      break;
    }
  }
  if (done) toast({ tone: 'success', message: `${done} photo${done === 1 ? '' : 's'} written to the archive` });
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

export function openLightbox(ids: string[], index: number): void {
  set({ lightbox: { ids, index } });
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
