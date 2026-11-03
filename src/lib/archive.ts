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
import { fileExists, getDirPath, readTextFile, writeFile } from './fsaccess';
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
  };
}

async function updateManifest(
  dir: FileSystemDirectoryHandle,
  patient: Patient,
  visit: Visit,
  mutate: (images: ManifestImage[]) => ManifestImage[],
): Promise<void> {
  let manifest: Manifest | null = null;
  const text = await readTextFile(dir, MANIFEST);
  if (text) {
    try {
      manifest = JSON.parse(text) as Manifest;
    } catch {
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

export function removeArchived(root: FileSystemDirectoryHandle, patient: Patient, visit: Visit, capture: Capture): Promise<void> {
  return enqueue(async () => {
    if (!capture.archivedPath) return;
    const segs = capture.archivedPath.split('/');
    const file = segs.pop()!;
    try {
      const dir = await getDirPath(root, segs, false);
      await dir.removeEntry(file);
      await updateManifest(dir, patient, visit, (imgs) => imgs.filter((i) => i.file !== file));
    } catch (e) {
      if ((e as DOMException)?.name !== 'NotFoundError') throw e;
    }
  });
}
