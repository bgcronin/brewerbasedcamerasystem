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
import { patientFolderName, withSuffix } from './naming';
import { techniqueLabel, type Capture, type Patient, type Visit } from './types';

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
export function renameArchived(root: FileSystemDirectoryHandle, patient: Patient, visit: Visit, capture: Capture, newFileName: string): Promise<string> {
  return enqueue(async () => {
    if (!capture.archivedPath) return '';
    const segs = capture.archivedPath.split('/');
    const oldName = segs.pop()!;
    const dir = await getDirPath(root, segs, false);
    let name = newFileName;
    for (let n = 2; name !== oldName && (await fileExists(dir, name)); n++) name = withSuffix(newFileName, n);
    await renameFile(dir, oldName, name);
    await updateManifest(dir, patient, visit, (imgs) => imgs.map((i) => (i.file === oldName ? imageEntry(capture, name) : i)));
    return [...segs, name].join('/');
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
    await updateManifest(dir, patient, visit, (imgs) => imgs.filter((i) => i.file !== file));
  });
}
