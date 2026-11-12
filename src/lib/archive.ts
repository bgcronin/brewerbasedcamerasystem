/**
 * Writes captures to the clinic's archive folder (a local drive or network
 * share), laid out so it is readable without this app:
 *
 *   Archive/
 *     SMITH_John_MRN12345/
 *       2026-11-03/
 *         MRN12345_20261103_143205_OD_slit.webp
 *         MRN12345_20261103_143212_OS_diffuse.webp
 *         visit.json        ← demographics + per-image metadata
 */
import { fileExists, fileSize, getDirPath, isNotFound, readTextFile, renameFile, writeFile } from './fsaccess';
import { annotatedName } from './annotations';
import { patientFolderName, withSuffix } from './naming';
import { techniqueLabel, type Annotation, type Capture, type Patient, type Settings, type Visit } from './types';

export const MANIFEST = 'visit.json';

export interface ManifestImage {
  file: string;
  eye: string;
  technique?: string;
  takenAt: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
  source: string;
  device?: string;
  note?: string;
  starred?: boolean;
  exposure?: Capture['exposure'];
  diagnoses?: string[];
  /** Marks drawn on the photo, as fractions of its width and height. */
  annotations?: Annotation[];
  /** A copy of the photo with the marks drawn in, beside the original. */
  annotatedFile?: string;
}

export interface Manifest {
  generator: 'Lumen slit lamp imaging';
  version: 1;
  patient: { mrn: string; firstName: string; lastName: string; dob?: string; sex?: string };
  visit: { date: string; time?: string; clinic?: string; clinician?: string; reason?: string };
  images: ManifestImage[];
}

// Serialise writes so concurrent captures never race on visit.json.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const byTime = (a: ManifestImage, b: ManifestImage) => a.takenAt.localeCompare(b.takenAt);

function imageEntry(c: Capture, file: string): ManifestImage {
  return {
    file,
    eye: c.eye,
    technique: c.technique ? techniqueLabel(c.technique) : undefined,
    takenAt: new Date(c.takenAt).toISOString(),
    width: c.width,
    height: c.height,
    format: c.mime,
    bytes: c.bytes,
    source: c.source,
    device: c.deviceLabel,
    note: c.note,
    starred: c.starred || undefined,
    exposure: c.exposure,
    diagnoses: c.diagnoses?.length ? c.diagnoses : undefined,
    annotations: c.annotations?.length ? c.annotations : undefined,
    annotatedFile: c.annotations?.length && c.annotatedPath ? c.annotatedPath.split('/').pop() : undefined,
  };
}

/** Read visit.json. `text` is kept so an unreadable file can be set aside rather than overwritten. */
async function readManifest(dir: FileSystemDirectoryHandle): Promise<{ manifest: Manifest | null; text: string | null }> {
  // A locked or unreadable manifest throws here, so the capture stays pending and is retried
  // later, rather than the manifest being rewritten with only this image in it.
  const text = await readTextFile(dir, MANIFEST);
  if (!text) return { manifest: null, text: null };
  try {
    return { manifest: JSON.parse(text) as Manifest, text };
  } catch {
    return { manifest: null, text };
  }
}

/**
 * Rewrite visit.json with a changed image list. Pass the patient and visit to refresh the
 * heading too; without them (a photo being removed after its visit was) the heading is kept.
 */
async function updateManifest(
  dir: FileSystemDirectoryHandle,
  patient: Patient | null,
  visit: Visit | null,
  mutate: (images: ManifestImage[]) => ManifestImage[],
): Promise<void> {
  const { manifest, text } = await readManifest(dir);
  if (text && !manifest) {
    // Keep whatever was there for a human to look at instead of overwriting it.
    await writeFile(dir, `${MANIFEST}.${Date.now()}.bak`, text);
  }
  if (!manifest && (!patient || !visit)) return; // nothing to tidy and nothing to write a heading from
  const next: Manifest = {
    generator: 'Lumen slit lamp imaging',
    version: 1,
    patient: patient ? { mrn: patient.mrn, firstName: patient.firstName, lastName: patient.lastName, dob: patient.dob, sex: patient.sex || undefined } : manifest!.patient,
    visit: visit ? { date: visit.date, time: visit.time, clinic: visit.clinic, clinician: visit.clinician, reason: visit.reason } : manifest!.visit,
    images: mutate(manifest?.images ?? []),
  };
  await writeFile(dir, MANIFEST, JSON.stringify(next, null, 2));
}

/** Write one capture. Returns its path relative to the archive root. */
export function archiveCapture(
  root: FileSystemDirectoryHandle,
  patient: Patient,
  visit: Visit,
  capture: Capture,
  blob: Blob,
): Promise<string> {
  return enqueue(async () => {
    const segs = [patientFolderName(patient), visit.date];
    const dir = await getDirPath(root, segs, true);
    // Look at visit.json before writing anything: if it can't be read, fail now rather than
    // leave a photo on disk that the next attempt would write a second time.
    const listed = new Set(((await readManifest(dir)).manifest?.images ?? []).map((i) => i.file));
    let name = capture.fileName;
    for (let n = 2; await fileExists(dir, name); n++) {
      // Not in visit.json, and either the same size or empty: our own file from an attempt
      // that failed part-way. Write over it instead of adding "_2".
      const size = listed.has(name) ? null : await fileSize(dir, name);
      if (size === blob.size || size === 0) break;
      name = withSuffix(capture.fileName, n);
    }
    await writeFile(dir, name, blob);
    await updateManifest(dir, patient, visit, (imgs) => [...imgs.filter((i) => i.file !== name), imageEntry(capture, name)]);
    return [...segs, name].join('/');
  });
}

/** True when the file on disk is the one a capture called `wanted` would have been written as (allowing a "_2" suffix). */
export function isArchivedAs(onDisk: string, wanted: string): boolean {
  if (onDisk === wanted) return true;
  const dot = wanted.lastIndexOf('.');
  const stem = dot < 0 ? wanted : wanted.slice(0, dot);
  const ext = dot < 0 ? '' : wanted.slice(dot);
  return onDisk.startsWith(stem + '_') && onDisk.endsWith(ext) && /^\d+$/.test(onDisk.slice(stem.length + 1, onDisk.length - ext.length));
}

/** Keep visit.json in step with edits (star, note, eye, technique). */
export function updateArchivedMetadata(root: FileSystemDirectoryHandle, patient: Patient, visit: Visit, capture: Capture): Promise<void> {
  return enqueue(async () => {
    if (!capture.archivedPath) return;
    const segs = capture.archivedPath.split('/');
    const file = segs.pop()!;
    const dir = await getDirPath(root, segs, false);
    const entry = imageEntry(capture, file);
    // An entry for the same photo under a name that no longer exists (a rename that was cut
    // short before visit.json could be updated) is dropped rather than left to mislead.
    const gone = new Set<string>();
    for (const i of (await readManifest(dir)).manifest?.images ?? []) {
      if (i.file !== file && i.takenAt === entry.takenAt && !(await fileExists(dir, i.file))) gone.add(i.file);
    }
    await updateManifest(dir, patient, visit, (imgs) => [...imgs.filter((i) => i.file !== file && !gone.has(i.file)), entry].sort(byTime));
  });
}

/**
 * Rename the archived file so its name matches a new eye / technique label.
 * `saved` is called with the new paths as soon as the files are renamed and before visit.json is
 * touched, so the database can never be left pointing at a name that no longer exists.
 */
export function renameArchived(
  root: FileSystemDirectoryHandle,
  patient: Patient,
  visit: Visit,
  capture: Capture,
  newFileName: string,
  saved: (paths: { archivedPath: string; annotatedPath?: string }) => Promise<void>,
): Promise<void> {
  return enqueue(async () => {
    if (!capture.archivedPath) return;
    const segs = capture.archivedPath.split('/');
    const oldName = segs.pop()!;
    const dir = await getDirPath(root, segs, false);
    let name = newFileName;
    for (let n = 2; name !== oldName && (await fileExists(dir, name)); n++) name = withSuffix(newFileName, n);
    await renameFile(dir, oldName, name);
    // The annotated copy follows its original.
    let annotatedPath = capture.annotatedPath;
    if (annotatedPath) {
      const oldAnnotated = annotatedPath.split('/').pop()!;
      try {
        await renameFile(dir, oldAnnotated, annotatedName(name), true);
        annotatedPath = [...segs, annotatedName(name)].join('/');
      } catch (e) {
        if (!isNotFound(e)) throw e;
        annotatedPath = undefined;
      }
    }
    await saved({ archivedPath: [...segs, name].join('/'), annotatedPath });
    await updateManifest(dir, patient, visit, (imgs) => [...imgs.filter((i) => i.file !== oldName && i.file !== name), imageEntry({ ...capture, annotatedPath }, name)]);
  });
}

/**
 * Write (or remove) the "_annotated" copy that sits beside an archived photo,
 * so the marks are visible to anyone opening the folder without Lumen.
 * Pass `blob: null` when the photo no longer has any marks.
 */
export function syncAnnotatedCopy(root: FileSystemDirectoryHandle, patient: Patient, visit: Visit, capture: Capture, blob: Blob | null): Promise<string | undefined> {
  return enqueue(async () => {
    if (!capture.archivedPath) return undefined;
    const segs = capture.archivedPath.split('/');
    const file = segs.pop()!;
    const dir = await getDirPath(root, segs, false);
    const name = annotatedName(file);
    const previous = capture.annotatedPath?.split('/').pop();
    if (previous && previous !== name) await dir.removeEntry(previous).catch(() => undefined);
    let annotatedPath: string | undefined;
    if (blob) {
      await writeFile(dir, name, blob);
      annotatedPath = [...segs, name].join('/');
    } else {
      await dir.removeEntry(name).catch((e) => {
        if (!isNotFound(e)) throw e;
      });
    }
    await updateManifest(dir, patient, visit, (imgs) => imgs.map((i) => (i.file === file ? imageEntry({ ...capture, annotatedPath }, file) : i)));
    return annotatedPath;
  });
}

/** Remove a photo (and its annotated copy) from the archive by path alone; its visit may no longer exist. */
export function removeArchived(root: FileSystemDirectoryHandle, archivedPath: string): Promise<void> {
  return enqueue(async () => {
    const segs = archivedPath.split('/');
    const file = segs.pop()!;
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await getDirPath(root, segs, false);
    } catch (e) {
      if (isNotFound(e)) return; // the whole visit folder is gone
      throw e;
    }
    try {
      await dir.removeEntry(file);
    } catch (e) {
      if (!isNotFound(e)) throw e; // already deleted by hand: still tidy the manifest
    }
    await dir.removeEntry(annotatedName(file)).catch(() => undefined);
    await updateManifest(dir, null, null, (imgs) => imgs.filter((i) => i.file !== file));
  });
}

/** Is the file a capture was archived as present under this root? (Used after the archive folder is changed.) */
export async function archivedFileExists(root: FileSystemDirectoryHandle, archivedPath: string): Promise<boolean> {
  const segs = archivedPath.split('/');
  const file = segs.pop()!;
  try {
    return await fileExists(await getDirPath(root, segs, false), file);
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/* ───────── backup index ───────── */

/** Where Lumen keeps its own index inside the archive folder (never a patient's folder). */
export const BACKUP_DIR = '_Lumen';

/**
 * What the photographs' own folders don't hold: every patient (with their notes), every visit
 * (including ones with no photos yet), and the settings worth carrying to another computer.
 * With the visit.json files beside the photos, this makes the archive folder a complete backup.
 */
export interface BackupFile {
  app: 'Lumen slit lamp imaging';
  kind: 'backup';
  version: 1;
  /** Which Lumen wrote it: each browser keeps its own file, so two never overwrite each other. */
  libraryId: string;
  writtenAt: string;
  settings: Partial<Settings>;
  patients: Patient[];
  visits: Visit[];
}

export const backupFileName = (libraryId: string) => `backup-${libraryId}.json`;

const BACKUP_README = `This folder is written by Lumen slit lamp imaging.

It holds an index of patients, visits and settings. Together with the photographs
and the visit.json file in each visit's folder, it lets Lumen be restored on a new
computer: connect this archive folder in Lumen's Settings and choose "Restore".

Please keep it with the photographs when you copy or back up the archive.
`;

export function writeBackup(root: FileSystemDirectoryHandle, backup: BackupFile): Promise<void> {
  return enqueue(async () => {
    const dir = await root.getDirectoryHandle(BACKUP_DIR, { create: true });
    await writeFile(dir, backupFileName(backup.libraryId), JSON.stringify(backup));
    if (!(await fileExists(dir, 'README.txt'))) await writeFile(dir, 'README.txt', BACKUP_README);
  });
}
