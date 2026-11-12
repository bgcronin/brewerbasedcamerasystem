/**
 * Rebuilding Lumen from its archive folder: on a new computer, or after the
 * browser's own data has been cleared.
 *
 * The folder is the record. Each visit's folder holds the photographs and a
 * visit.json that describes them (who, which eye, diagnoses, notes, marks),
 * and the _Lumen folder holds an index of patients, visits and settings.
 * Restoring reads those and puts back whatever Lumen does not already have.
 * It only ever adds: it never changes or removes anything in the folder, and
 * running it twice adds nothing the second time.
 */
import { BACKUP_DIR, MANIFEST, type BackupFile, type Manifest, type ManifestImage } from './archive';
import * as db from './db';
import { encodeBitmap } from './encode';
import { isNotFound, readTextFile } from './fsaccess';
import { uid } from './id';
import { TECHNIQUES, type Annotation, type Capture, type CaptureSource, type Eye, type ImageFormat, type Patient, type Settings, type Visit } from './types';

const IMAGE = /\.(webp|jpe?g|png)$/i;
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const ANNOTATED = /_annotated\.[a-z0-9]+$/i;

export interface ScannedPhoto {
  /** Path relative to the archive folder: "SMITH_John_H1/2026-11-03/H1_….webp". */
  path: string;
  entry: ManifestImage;
  handle: FileSystemFileHandle;
  /** The "_annotated" copy beside it, when the folder has one. */
  annotatedPath?: string;
}

export interface ScannedVisit {
  folder: string;
  date: string;
  manifest: Manifest;
  photos: ScannedPhoto[];
}

export interface ArchiveScan {
  visits: ScannedVisit[];
  backups: BackupFile[];
  /** Photographs listed in a visit.json whose file is not in the folder. */
  missing: string[];
  /** Photographs in the folder that no visit.json describes: left alone, because nothing says whose they are. */
  unlisted: string[];
  /** visit.json files that could not be read. */
  unreadable: string[];
}

export const photosIn = (scan: ArchiveScan) => scan.visits.reduce((n, v) => n + v.photos.length, 0);

/** Read the whole archive folder. Nothing is changed. */
export async function scanArchive(root: FileSystemDirectoryHandle, onProgress?: (folders: number) => void): Promise<ArchiveScan> {
  const scan: ArchiveScan = { visits: [], backups: [], missing: [], unlisted: [], unreadable: [] };
  let folders = 0;
  for await (const [name, entry] of root.entries()) {
    if (entry.kind !== 'directory' || name.startsWith('.')) continue;
    if (name === BACKUP_DIR) {
      for await (const [file, f] of (entry as FileSystemDirectoryHandle).entries()) {
        if (f.kind !== 'file' || !/^backup-.*\.json$/i.test(file)) continue;
        try {
          const parsed = JSON.parse(await (await (f as FileSystemFileHandle).getFile()).text()) as BackupFile;
          if (parsed?.kind === 'backup' && Array.isArray(parsed.patients) && Array.isArray(parsed.visits)) scan.backups.push(parsed);
        } catch {
          scan.unreadable.push(`${BACKUP_DIR}/${file}`);
        }
      }
      continue;
    }
    for await (const [date, visitDir] of (entry as FileSystemDirectoryHandle).entries()) {
      if (visitDir.kind !== 'directory' || !DATE_FOLDER.test(date)) continue;
      const dir = visitDir as FileSystemDirectoryHandle;
      const files = new Map<string, FileSystemFileHandle>();
      for await (const [file, f] of dir.entries()) if (f.kind === 'file' && IMAGE.test(file)) files.set(file, f as FileSystemFileHandle);
      const prefix = `${name}/${date}/`;
      let manifest: Manifest | null = null;
      try {
        const text = await readTextFile(dir, MANIFEST);
        if (text) {
          const parsed = JSON.parse(text) as Manifest;
          if (parsed?.patient && parsed.visit && Array.isArray(parsed.images)) manifest = parsed;
          else scan.unreadable.push(prefix + MANIFEST);
        }
      } catch {
        scan.unreadable.push(prefix + MANIFEST);
      }
      const described = new Set<string>();
      if (manifest) {
        const photos: ScannedPhoto[] = [];
        for (const image of manifest.images) {
          if (!image || typeof image.file !== 'string') continue;
          described.add(image.file);
          if (image.annotatedFile) described.add(image.annotatedFile);
          const handle = files.get(image.file);
          if (!handle) {
            scan.missing.push(prefix + image.file);
            continue;
          }
          photos.push({ path: prefix + image.file, entry: image, handle, annotatedPath: image.annotatedFile && files.has(image.annotatedFile) ? prefix + image.annotatedFile : undefined });
        }
        scan.visits.push({ folder: name, date, manifest, photos });
      }
      for (const file of files.keys()) if (!described.has(file) && !ANNOTATED.test(file)) scan.unlisted.push(prefix + file);
    }
    onProgress?.(++folders);
  }
  scan.visits.sort((a, b) => a.date.localeCompare(b.date) || a.folder.localeCompare(b.folder));
  return scan;
}

export interface RestoreCount {
  /** Photographs in the folder, and how many of them Lumen does not have yet. */
  photos: number;
  newPhotos: number;
  /** Patients the folder's photographs belong to. */
  patients: number;
  visits: number;
}

const personKey = (p: { mrn?: string; firstName: string; lastName: string; dob?: string }) =>
  db.normaliseMrn(p.mrn) || `${p.lastName.trim().toLowerCase()}|${p.firstName.trim().toLowerCase()}|${p.dob ?? ''}`;

/** What a restore would add, for the summary shown before anything is done. */
export async function countRestore(scan: ArchiveScan): Promise<RestoreCount> {
  const have = new Set((await db.allCaptures()).map((c) => c.archivedPath).filter(Boolean));
  let photos = 0;
  let newPhotos = 0;
  const people = new Set<string>();
  for (const v of scan.visits) {
    if (v.photos.length) people.add(personKey(v.manifest.patient));
    for (const p of v.photos) {
      photos++;
      if (!have.has(p.path)) newPhotos++;
    }
  }
  return { photos, newPhotos, patients: people.size, visits: scan.visits.filter((v) => v.photos.length).length };
}

export interface RestoreResult {
  photos: number;
  patients: number;
  visits: number;
  /** Photographs that could not be read or made sense of, with the reason. */
  failed: { path: string; reason: string }[];
  stopped: boolean;
  /** Settings carried over from the backup (only into a Lumen that had no patients). */
  settings?: Partial<Settings>;
}

const EYES: Eye[] = ['OD', 'OS', 'OU'];
const SOURCES: CaptureSource[] = ['live', 'tether', 'file', 'canon'];
const FORMATS: ImageFormat[] = ['image/webp', 'image/jpeg', 'image/png'];
const mimeOf = (name: string): ImageFormat => (/\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/webp');

/** visit.json stores the illumination by its label ("Slit beam"); Lumen keeps its short id ("slit"). */
function techniqueId(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const key = label.trim().toLowerCase();
  return TECHNIQUES.find((t) => t.label.toLowerCase() === key || t.short.toLowerCase() === key || t.id === key)?.id ?? label.trim();
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keep only marks that are whole: a damaged one is dropped rather than drawn wrongly. */
function validAnnotations(raw: unknown): Annotation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Annotation[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    if (!a || typeof a.color !== 'string') continue;
    const id = typeof a.id === 'string' ? a.id : uid();
    if (a.kind === 'ellipse' && num(a.cx) && num(a.cy) && num(a.rx) && num(a.ry)) out.push({ id, kind: 'ellipse', color: a.color, cx: a.cx, cy: a.cy, rx: a.rx, ry: a.ry });
    else if (a.kind === 'arrow' && num(a.x1) && num(a.y1) && num(a.x2) && num(a.y2)) out.push({ id, kind: 'arrow', color: a.color, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
    else if (a.kind === 'pen' && Array.isArray(a.points) && a.points.every(num)) out.push({ id, kind: 'pen', color: a.color, points: a.points as number[] });
    else if (a.kind === 'text' && num(a.x) && num(a.y) && typeof a.text === 'string') out.push({ id, kind: 'text', color: a.color, x: a.x, y: a.y, text: a.text });
  }
  return out.length ? out : undefined;
}

/** Settings that make sense on another computer (not which camera is plugged in, or how it is turned). */
const PORTABLE: (keyof Settings)[] = ['clinicName', 'format', 'quality', 'keepTetherOriginals', 'removeTetherOriginals', 'shutterSound', 'theme', 'captureKeys', 'dateOrder', 'reticle', 'cameraPresets', 'recentDiagnoses', 'resolution'];
export function portableSettings(s: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of PORTABLE) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

/**
 * Put back whatever the folder holds and Lumen does not. Patients are matched by the folder they
 * were filed in, then hospital number, then name with date of birth; a name alone is never taken
 * as proof of who someone is, so such a patient is added as their own record.
 */
export async function restoreArchive(
  scan: ArchiveScan,
  opts: { thumbnail: { format: ImageFormat; quality: number }; onProgress?: (done: number, total: number, label: string) => void; shouldStop?: () => boolean },
): Promise<RestoreResult> {
  const result: RestoreResult = { photos: 0, patients: 0, visits: 0, failed: [], stopped: false };
  const now = Date.now();

  const known = await db.allPatients();
  const wasEmpty = known.length === 0;
  const byId = new Map(known.map((p) => [p.id, p]));
  const byFolder = new Map(known.filter((p) => p.archiveFolder).map((p) => [p.archiveFolder!, p]));
  const byMrn = new Map(known.filter((p) => db.normaliseMrn(p.mrn)).map((p) => [db.normaliseMrn(p.mrn), p]));
  const byNameDob = new Map(known.filter((p) => p.dob).map((p) => [personKey({ ...p, mrn: '' }), p]));
  const remember = (p: Patient) => {
    byId.set(p.id, p);
    if (p.archiveFolder) byFolder.set(p.archiveFolder, p);
    if (db.normaliseMrn(p.mrn)) byMrn.set(db.normaliseMrn(p.mrn), p);
    if (p.dob) byNameDob.set(personKey({ ...p, mrn: '' }), p);
  };
  const match = (p: { mrn?: string; firstName: string; lastName: string; dob?: string }) =>
    (db.normaliseMrn(p.mrn) ? byMrn.get(db.normaliseMrn(p.mrn)) : undefined) ?? (p.dob ? byNameDob.get(personKey({ ...p, mrn: '' })) : undefined);

  // 1. The index: patients (with their notes) and visits, including those with no photographs.
  const backups = [...scan.backups].sort((a, b) => (b.writtenAt ?? '').localeCompare(a.writtenAt ?? ''));
  for (const backup of backups) {
    const ids = new Map<string, string>();
    for (const p of backup.patients) {
      if (!p || typeof p.id !== 'string' || typeof p.lastName !== 'string' || typeof p.firstName !== 'string') continue;
      const mine = byId.get(p.id) ?? match(p);
      if (mine) {
        ids.set(p.id, mine.id);
        // Only blanks are filled: what Lumen already says about a patient is never overwritten.
        const fill: Partial<Patient> = {};
        if (!mine.dob && p.dob) fill.dob = p.dob;
        if (!mine.sex && p.sex) fill.sex = p.sex;
        if (!mine.notes && p.notes) fill.notes = p.notes;
        if (!mine.archiveFolder && p.archiveFolder && !byFolder.has(p.archiveFolder)) fill.archiveFolder = p.archiveFolder;
        if (Object.keys(fill).length) remember((await db.patchPatient(mine.id, fill)) ?? mine);
      } else {
        const added: Patient = { ...p, createdAt: p.createdAt ?? now, updatedAt: now };
        await db.putPatient(added);
        remember(added);
        ids.set(p.id, p.id);
        result.patients++;
      }
    }
    for (const v of backup.visits) {
      if (!v || typeof v.id !== 'string' || typeof v.date !== 'string') continue;
      const patientId = ids.get(v.patientId) ?? v.patientId;
      if (!byId.has(patientId) || (await db.getVisit(v.id))) continue;
      if ((await db.visitsForPatient(patientId)).some((x) => x.date === v.date)) continue;
      await db.putVisit({ ...v, patientId });
    }
  }
  if (wasEmpty && backups.length) result.settings = portableSettings(backups[0].settings ?? {});

  // 2. The photographs, visit by visit, from each visit's own visit.json.
  const inLumen = await db.allCaptures();
  const have = new Set(inLumen.map((c) => c.archivedPath).filter(Boolean));
  // A second safeguard against restoring a photograph twice: the same patient, moment and size is the same photograph,
  // whatever path Lumen has it under.
  const sameShot = (patientId: string, takenAt: number, bytes: number) => `${patientId}|${takenAt}|${bytes}`;
  const shots = new Set(inLumen.map((c) => sameShot(c.patientId, c.takenAt, c.bytes)));
  const total = scan.visits.reduce((n, v) => n + v.photos.filter((p) => !have.has(p.path)).length, 0);
  let done = 0;
  for (const visit of scan.visits) {
    const todo = visit.photos.filter((p) => !have.has(p.path));
    if (!todo.length) continue;
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    const mp = visit.manifest.patient;
    let patient = byFolder.get(visit.folder) ?? match(mp);
    if (!patient) {
      patient = { id: uid(), mrn: mp.mrn ?? '', firstName: mp.firstName ?? '', lastName: mp.lastName ?? '', dob: mp.dob, sex: mp.sex === 'M' || mp.sex === 'F' || mp.sex === 'O' ? mp.sex : '', archiveFolder: visit.folder, createdAt: now, updatedAt: now };
      await db.putPatient(patient);
      remember(patient);
      result.patients++;
    } else if (!patient.archiveFolder && !byFolder.has(visit.folder)) {
      // Later photographs of this patient carry on in the folder their history is in.
      patient = (await db.pinArchiveFolder(patient.id, visit.folder)) ?? patient;
      remember(patient);
    }

    const mv = visit.manifest.visit;
    let record: Visit | undefined = (await db.visitsForPatient(patient.id)).find((x) => x.date === visit.date);
    if (!record) {
      record = { id: uid(), patientId: patient.id, date: visit.date, time: mv.time, clinic: mv.clinic, clinician: mv.clinician, reason: mv.reason, source: 'restore', createdAt: now };
      await db.putVisit(record);
    }
    let added = 0;
    for (const photo of todo) {
      if (opts.shouldStop?.()) {
        result.stopped = true;
        break;
      }
      opts.onProgress?.(done, total, `${patient.lastName.toUpperCase()}, ${patient.firstName}`);
      done++;
      const e = photo.entry;
      try {
        if (!EYES.includes(e.eye as Eye)) throw new Error(`visit.json gives its eye as “${e.eye}”`);
        const file = await photo.handle.getFile();
        const mime = FORMATS.includes(e.format as ImageFormat) ? (e.format as ImageFormat) : mimeOf(e.file);
        // A copy of the bytes, not a pointer at the file: Lumen's own record must not depend on the folder staying put.
        const full = new Blob([await file.arrayBuffer()], { type: mime });
        const when = Date.parse(e.takenAt);
        if (Number.isFinite(when) && shots.has(sameShot(patient.id, when, full.size))) {
          have.add(photo.path);
          continue; // already in Lumen
        }
        const bitmap = await createImageBitmap(full);
        const made = await encodeBitmap({ bitmap, transform: { rotate: 0, flipH: false, flipV: false }, format: opts.thumbnail.format, quality: opts.thumbnail.quality, thumbSize: 640, thumbOnly: true }, full);
        const taken = Date.parse(e.takenAt);
        const annotations = validAnnotations(e.annotations);
        const marksAt = annotations ? file.lastModified || now : undefined;
        const capture: Capture = {
          id: uid(),
          patientId: patient.id,
          visitId: record.id,
          date: visit.date,
          eye: e.eye as Eye,
          technique: techniqueId(e.technique),
          takenAt: Number.isFinite(taken) ? taken : file.lastModified || now,
          width: made.width,
          height: made.height,
          mime,
          bytes: full.size,
          fileName: e.file,
          source: SOURCES.includes(e.source as CaptureSource) ? (e.source as CaptureSource) : 'file',
          deviceLabel: typeof e.device === 'string' ? e.device : undefined,
          note: typeof e.note === 'string' ? e.note : undefined,
          starred: e.starred === true ? true : undefined,
          exposure: e.exposure && typeof e.exposure === 'object' ? e.exposure : undefined,
          diagnoses: Array.isArray(e.diagnoses) && e.diagnoses.every((d) => typeof d === 'string') && e.diagnoses.length ? e.diagnoses : undefined,
          annotations,
          annotationsAt: marksAt,
          // If the copy with the marks drawn in is missing from the folder, the next sync writes it again.
          annotatedPath: annotations ? photo.annotatedPath : undefined,
          annotatedAt: annotations && photo.annotatedPath ? marksAt : undefined,
          archivedPath: photo.path,
        };
        await db.addCapture(capture, { id: capture.id, full, thumb: made.thumb });
        have.add(photo.path);
        shots.add(sameShot(patient.id, capture.takenAt, capture.bytes));
        result.photos++;
        added++;
      } catch (err) {
        result.failed.push({ path: photo.path, reason: isNotFound(err) ? 'The file has gone from the folder' : (err as Error)?.message || 'The file could not be read' });
      }
    }
    if (added) result.visits++;
    if (result.stopped) break;
  }
  opts.onProgress?.(done, total, '');
  return result;
}
