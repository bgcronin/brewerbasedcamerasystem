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
import { fileExists, getDirPath, isNotFound, readTextFile, renameFile, writeFile } from './fsaccess';
import { annotatedName } from './annotations';
import { patientFolderName, withSuffix } from './naming';
import { techniqueLabel, type Annotation, type Capture, type Patient, type Visit } from './types';

const MANIFEST = 'visit.json';

interface ManifestImage {
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

interface Manifest {
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

async function updateManifest(
  dir: FileSystemDirectoryHandle,
  patient: Patient,
  visit: Visit,
  mutate: (images: ManifestImage[]) => ManifestImage[],
): Promise<void> {
  let manifest: Manifest | null = null;
  // A locked or unreadable manifest throws here, so the capture stays pending and is retried
  // later, rather than the manifest being rewritten with only this image in it.
  const text = await readTextFile(dir, MANIFEST);
  if (text) {
    try {
      manifest = JSON.parse(text) as Manifest;
    } catch {
      // Keep whatever was there for a human to look at instead of overwriting it.
      await writeFile(dir, `${MANIFEST}.${Date.now()}.bak`, text);
      manifest = null;
    }
  }
  const next: Manifest = {
    generator: 'Lumen slit lamp imaging',
    version: 1,
    patient: { mrn: patient.mrn, firstName: patient.firstName, lastName: patient.lastName, dob: patient.dob, sex: patient.sex || undefined },
    visit: { date: visit.date, time: visit.time, clinic: visit.clinic, clinician: visit.clinician, reason: visit.reason },
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
    let name = capture.fileName;
    for (let n = 2; await fileExists(dir, name); n++) name = withSuffix(capture.fileName, n);
    await writeFile(dir, name, blob);
    await updateManifest(dir, patient, visit, (imgs) => [...imgs.filter((i) => i.file !== name), imageEntry(capture, name)]);
    return [...segs, name].join('/');
  });
}

/** Keep visit.json in step with edits (star, note, eye, technique). */
export function updateArchivedMetadata(root: FileSystemDirectoryHandle, patient: Patient, visit: Visit, capture: Capture): Promise<void> {
  return enqueue(async () => {
    if (!capture.archivedPath) return;
    const segs = capture.archivedPath.split('/');
    const file = segs.pop()!;
    const dir = await getDirPath(root, segs, false);
    await updateManifest(dir, patient, visit, (imgs) => imgs.map((i) => (i.file === file ? imageEntry(capture, file) : i)));
  });
}

/** Rename the archived file so its name matches a new eye / technique label. Returns the new relative path. */
export function renameArchived(
  root: FileSystemDirectoryHandle,
  patient: Patient,
  visit: Visit,
  capture: Capture,
  newFileName: string,
): Promise<{ archivedPath: string; annotatedPath?: string } | null> {
  return enqueue(async () => {
    if (!capture.archivedPath) return null;
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
        await renameFile(dir, oldAnnotated, annotatedName(name));
        annotatedPath = [...segs, annotatedName(name)].join('/');
      } catch (e) {
        if (!isNotFound(e)) throw e;
        annotatedPath = undefined;
      }
    }
    await updateManifest(dir, patient, visit, (imgs) => imgs.map((i) => (i.file === oldName ? imageEntry({ ...capture, annotatedPath }, name) : i)));
    return { archivedPath: [...segs, name].join('/'), annotatedPath };
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

export function removeArchived(root: FileSystemDirectoryHandle, patient: Patient, visit: Visit, capture: Capture): Promise<void> {
  return enqueue(async () => {
    if (!capture.archivedPath) return;
    const segs = capture.archivedPath.split('/');
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
    await updateManifest(dir, patient, visit, (imgs) => imgs.filter((i) => i.file !== file));
  });
}
