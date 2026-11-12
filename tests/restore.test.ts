/**
 * Backup and restore, end to end against an in-memory archive folder:
 * build an archive with the real app code, throw the database away (a new
 * computer, or a browser whose data was cleared), and rebuild Lumen from the
 * folder alone.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { todayISO } from '../src/lib/dates';
import { FakeDir, FakeFile, readJson, sleep, tree } from './helpers/fakefs';

const g = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as unknown as Record<string, any>;
  g.window = g;
  g.addEventListener = () => undefined;
  g.removeEventListener = () => undefined;
  g.showDirectoryPicker = async () => g.__archive;
  g.createImageBitmap = async () => ({ width: 100, height: 80, close() {} });
  // Restoring settings re-applies the theme, which is written on the page's root element.
  g.document = { documentElement: { dataset: {} } };
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return g;
});

vi.mock('../src/lib/encode', () => ({
  warmEncoder() {},
  async encodeBitmap(req: { thumbOnly?: boolean; format: string }) {
    return { full: req.thumbOnly ? undefined : new Blob(['full-' + Math.random()], { type: req.format }), thumb: new Blob(['thumb'], { type: 'image/webp' }), width: 100, height: 80 };
  },
}));

// Drawing the copy with the marks in needs a real canvas; here it is enough that a copy is written.
vi.mock('../src/lib/annotations', async (original) => ({
  ...(await original<typeof import('../src/lib/annotations')>()),
  renderAnnotated: async () => new Blob(['photo with marks'], { type: 'image/webp' }),
}));

type Store = typeof import('../src/state/store');
type Db = typeof import('../src/lib/db');

const IDENT = { rotate: 0 as const, flipH: false, flipV: false };
/** Photographs are filed under the day they are taken, which in these tests is today. */
const TODAY = todayISO();
const STAMP = TODAY.replace(/-/g, '');
const at = (h: number, m: number) => new Date(`${TODAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).getTime();
const bitmap = () => ({ width: 100, height: 80, close() {} }) as unknown as ImageBitmap;
let archive: FakeDir;

/** Start Lumen as a fresh page load would: new copies of the app's modules, over whatever database exists. */
async function boot(): Promise<{ store: Store; db: Db }> {
  vi.resetModules();
  const store = await import('../src/state/store');
  const db = await import('../src/lib/db');
  store.useApp.setState({ settings: { ...store.useApp.getState().settings, shutterSound: false } });
  return { store, db };
}

/** Throw the browser's data away, as on a new computer. The archive folder is all that is left. */
async function newComputer(old: Db): Promise<{ store: Store; db: Db }> {
  (await old.db()).close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('lumen');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  return boot();
}

const photoFiles = () => tree(archive).filter((f) => !f.startsWith('_Lumen/'));
const fileBytes = async (path: string) => {
  const segs = path.split('/');
  let dir: FakeDir = archive;
  for (const s of segs.slice(0, -1)) dir = dir.children.get(s) as FakeDir;
  return (dir.children.get(segs[segs.length - 1]) as FakeFile).data;
};

describe('backup and restore', () => {
  let old: { store: Store; db: Db };
  let ids: { fitz: string; twin: string; listed: string };
  let before: { files: string[]; manifests: Record<string, unknown> };

  beforeAll(async () => {
    archive = new FakeDir('Archive');
    g.__archive = archive;
    old = await boot();
    const { store, db } = old;
    await store.chooseArchiveFolder();
    await store.updateSettings({ clinicName: 'Cornea Clinic', cameraPresets: { cobalt: { iso: '1600', tv: '1/125' } }, recentDiagnoses: ['Keratoconus'] });

    // A patient with a hospital number, two eyes, a diagnosis, a note, a star and marks.
    const fitz = await store.savePatient({ mrn: 'H100234', firstName: 'Eleanor', lastName: 'Fitzgerald', dob: '1956-03-12', sex: 'F', notes: 'Allergic to fluorescein', time: '08:45', clinic: 'Cornea', reason: 'Review' });
    await store.selectPatient(fitz);
    await store.setVisitDiagnoses(['Keratoconus']);
    store.setTechnique('slit');
    const a = (await store.ingest({ bitmap: bitmap(), source: 'live', transform: IDENT, takenAt: at(9, 0) }))!;
    store.setEye('OS');
    store.setTechnique(null);
    const b = (await store.ingest({ bitmap: bitmap(), source: 'canon', deviceLabel: 'Canon EOS 60D', transform: IDENT, takenAt: at(9, 1), exposure: { iso: '400', tv: '1/125', av: 'f/8', mode: 'M' } }))!;
    await store.updateCapture(a.id, { note: 'Vogt striae', starred: true });
    await store.setAnnotations(a.id, [
      { id: 'm1', kind: 'ellipse', color: '#FFD60A', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.08 },
      { id: 'm2', kind: 'text', color: '#34D3FF', x: 0.6, y: 0.2, text: 'Apical thinning' },
    ]);

    // A patient with no hospital number and no date of birth.
    const twin = await store.savePatient({ mrn: '', firstName: 'Sam', lastName: 'Twin' });
    await store.selectPatient(twin);
    store.setEye('OD');
    await store.ingest({ bitmap: bitmap(), source: 'live', transform: IDENT });

    // A patient who is on the list but has not been photographed.
    const listed = await store.savePatient({ mrn: 'H777', firstName: 'Aoife', lastName: 'Byrne', dob: '2001-06-02', time: '10:45' });
    ids = { fitz, twin, listed };

    await sleep(1800); // the copy with the marks drawn in is written a moment after the marks
    await store.syncArchive(true);
    await sleep(1300); // and the index follows a sync
    expect(a.id).not.toBe(b.id);
    before = { files: photoFiles(), manifests: {} };
    for (const f of before.files.filter((x) => x.endsWith('visit.json'))) before.manifests[f] = await readJson(archive, f);
    expect((await db.allCaptures()).every((c) => c.archivedPath)).toBe(true);
  }, 20000);

  it('keeps an index of patients, visits and settings in the folder, beside the photographs', async () => {
    const index = tree(archive).filter((f) => f.startsWith('_Lumen/'));
    expect(index).toHaveLength(2); // this Lumen's backup and a note saying what the folder is
    expect(index).toContain('_Lumen/README.txt');
    const backup = await readJson<{ kind: string; patients: { lastName: string; notes?: string }[]; visits: unknown[]; settings: Record<string, unknown> }>(archive, index.find((f) => f.endsWith('.json'))!);
    expect(backup.kind).toBe('backup');
    expect(backup.patients.map((p) => p.lastName).sort()).toEqual(['Byrne', 'Fitzgerald', 'Twin']);
    expect(backup.patients.find((p) => p.lastName === 'Fitzgerald')!.notes).toBe('Allergic to fluorescein');
    expect(backup.visits).toHaveLength(3);
    expect(backup.settings).toMatchObject({ clinicName: 'Cornea Clinic', recentDiagnoses: ['Keratoconus'] });
    // Nothing about which camera is plugged into this particular computer.
    expect(backup.settings).not.toHaveProperty('deviceId');
    expect(backup.settings).not.toHaveProperty('source');
    expect(old.store.useApp.getState().archive.backupAt).toBeGreaterThan(0);
  });

  describe('on a new computer', () => {
    let fresh: { store: Store; db: Db };

    beforeAll(async () => {
      fresh = await newComputer(old.db);
      expect(await fresh.db.allPatients()).toHaveLength(0);
      expect(await fresh.db.allCaptures()).toHaveLength(0);
    });

    it('connecting the folder offers to restore, and says what it would bring back', async () => {
      const { store } = fresh;
      await store.chooseArchiveFolder();
      const offer = store.useApp.getState().toasts.find((t) => t.action?.label === 'Restore…');
      expect(offer?.message).toBe('This folder already holds Lumen photographs');

      await store.checkArchiveForRestore();
      const found = store.useApp.getState().restore;
      expect(found.status).toBe('found');
      if (found.status !== 'found') return;
      expect(found.count).toEqual({ photos: 3, newPhotos: 3, patients: 2, visits: 2 });
      expect(found.hasIndex).toBe(true);
      expect(found.missing).toBe(0);
      expect(found.unlisted).toEqual([]);
      expect(await fresh.db.allCaptures()).toHaveLength(0); // looking changes nothing
    });

    it('restores every photograph with its labels, note, star and marks', async () => {
      const { store, db } = fresh;
      await store.runRestore();
      const done = store.useApp.getState().restore;
      if (done.status === 'error') throw new Error(done.message);
      expect(done).toMatchObject({ status: 'done', photos: 3, failed: [], stopped: false });

      const patients = await db.allPatients();
      const fitz = patients.find((p) => p.mrn === 'H100234')!;
      expect(fitz).toMatchObject({ firstName: 'Eleanor', lastName: 'Fitzgerald', dob: '1956-03-12', sex: 'F', notes: 'Allergic to fluorescein', archiveFolder: 'FITZGERALD_Eleanor_H100234' });
      const photos = await db.capturesForPatient(fitz.id);
      expect(photos).toHaveLength(2);
      const [a, b] = photos;
      expect(a).toMatchObject({ eye: 'OD', technique: 'slit', note: 'Vogt striae', starred: true, diagnoses: ['Keratoconus'], source: 'live', date: TODAY });
      expect(a.takenAt).toBe(at(9, 0));
      expect(a.annotations).toEqual([
        { id: 'm1', kind: 'ellipse', color: '#FFD60A', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.08 },
        { id: 'm2', kind: 'text', color: '#34D3FF', x: 0.6, y: 0.2, text: 'Apical thinning' },
      ]);
      expect(a.archivedPath).toBe(`FITZGERALD_Eleanor_H100234/${TODAY}/H100234_${STAMP}_090000_OD_slit.webp`);
      expect(a.annotatedPath).toMatch(/_OD_slit_annotated\.webp$/);
      expect(db.needsArchiveWork(a)).toBe(false); // the folder already agrees with it: nothing to write back
      expect(b).toMatchObject({ eye: 'OS', technique: undefined, diagnoses: ['Keratoconus'], source: 'canon', deviceLabel: 'Canon EOS 60D', exposure: { iso: '400', tv: '1/125', av: 'f/8', mode: 'M' } });

      // The photograph itself is back in Lumen, byte for byte, with a thumbnail.
      const image = (await db.getImage(a.id))!;
      expect(await image.full.text()).toBe(await (await fileBytes(a.archivedPath!)).text());
      expect(image.thumb.size).toBeGreaterThan(0);
    });

    it('restores visits, patients who were only on the list, and the settings', async () => {
      const { store, db } = fresh;
      const patients = await db.allPatients();
      expect(patients.map((p) => p.lastName).sort()).toEqual(['Byrne', 'Fitzgerald', 'Twin']);
      const fitz = patients.find((p) => p.mrn === 'H100234')!;
      expect(await db.visitsForPatient(fitz.id)).toMatchObject([{ date: TODAY, time: '08:45', clinic: 'Cornea', reason: 'Review' }]);
      const byrne = patients.find((p) => p.lastName === 'Byrne')!;
      expect(await db.visitsForPatient(byrne.id)).toMatchObject([{ time: '10:45' }]);
      expect(await db.capturesForPatient(byrne.id)).toHaveLength(0);
      const settings = store.useApp.getState().settings;
      expect(settings.clinicName).toBe('Cornea Clinic');
      expect(settings.cameraPresets).toEqual({ cobalt: { iso: '1600', tv: '1/125' } });
      expect(settings.recentDiagnoses).toEqual(['Keratoconus']);
      // The same people keep the same identity as before, so nothing that refers to them breaks.
      expect([fitz.id, byrne.id, patients.find((p) => p.lastName === 'Twin')!.id].sort()).toEqual([ids.fitz, ids.listed, ids.twin].sort());
    });

    it('changes nothing in the folder', async () => {
      expect(photoFiles()).toEqual(before.files);
      for (const [f, was] of Object.entries(before.manifests)) expect(await readJson(archive, f)).toEqual(was);
    });

    it('adds nothing when run a second time', async () => {
      const { store, db } = fresh;
      await store.checkArchiveForRestore();
      const found = store.useApp.getState().restore;
      expect(found.status === 'found' && found.count).toMatchObject({ photos: 3, newPhotos: 0 });
      await store.runRestore();
      expect(store.useApp.getState().restore).toMatchObject({ status: 'done', photos: 0, patients: 0 });
      expect(await db.allCaptures()).toHaveLength(3);
      expect(await db.allPatients()).toHaveLength(3);
    });

    it('brings back just what is missing', async () => {
      const { store, db } = fresh;
      const all = await db.allCaptures();
      await db.deleteCapture(all[0].id);
      await store.checkArchiveForRestore();
      const found = store.useApp.getState().restore;
      expect(found.status === 'found' && found.count.newPhotos).toBe(1);
      await store.runRestore();
      expect(await db.allCaptures()).toHaveLength(3);
    });

    it('files a restored patient’s next photograph in the folder their history is in', async () => {
      const { store, db } = fresh;
      const fitz = (await db.allPatients()).find((p) => p.mrn === 'H100234')!;
      await store.selectPatient(fitz.id);
      const c = (await store.ingest({ bitmap: bitmap(), source: 'live', transform: IDENT }))!;
      expect((await db.getCapture(c.id))!.archivedPath).toMatch(/^FITZGERALD_Eleanor_H100234\//);
      expect(await db.capturesForPatient(fitz.id)).toHaveLength(3);
    });

    it('never takes a name alone as proof of who someone is', async () => {
      // Another Sam Twin is registered here; the folder's Sam Twin has no number and no date of birth either.
      const again = await newComputer(fresh.db);
      await again.store.chooseArchiveFolder();
      const other = await again.store.savePatient({ mrn: '', firstName: 'Sam', lastName: 'Twin' });
      await again.store.checkArchiveForRestore();
      await again.store.runRestore();
      const twins = (await again.db.allPatients()).filter((p) => p.lastName === 'Twin');
      expect(twins).toHaveLength(2);
      expect(await again.db.capturesForPatient(other)).toHaveLength(0); // the photo went to the folder's own patient
      const restored = twins.find((p) => p.id !== other)!;
      expect(await again.db.capturesForPatient(restored.id)).toHaveLength(1);
      // Settings are only carried over into a Lumen with no patients; this one had one.
      expect(again.store.useApp.getState().settings.clinicName).toBe('');
      fresh = again;
    });

    it('reports files it cannot account for, and leaves them alone', async () => {
      const again = await newComputer(fresh.db);
      await again.store.chooseArchiveFolder();
      const visit = (archive.children.get('FITZGERALD_Eleanor_H100234') as FakeDir).children.get(TODAY) as FakeDir;
      visit.drop('stray-photo.jpg', new Blob(['?'])); // nothing says whose this is
      const listed = [...visit.children.keys()].find((f) => /_OS\.webp$/.test(f))!;
      const kept = visit.children.get(listed)!;
      visit.children.delete(listed); // a photo the record lists has gone
      await again.store.checkArchiveForRestore();
      const found = again.store.useApp.getState().restore;
      expect(found.status).toBe('found');
      if (found.status !== 'found') return;
      expect(found.unlisted).toEqual([`FITZGERALD_Eleanor_H100234/${TODAY}/stray-photo.jpg`]);
      expect(found.missing).toBe(1);
      await again.store.runRestore();
      const fitz = (await again.db.allPatients()).find((p) => p.mrn === 'H100234')!;
      const restored = await again.db.capturesForPatient(fitz.id);
      expect(restored.map((c) => c.fileName)).not.toContain('stray-photo.jpg');
      expect(restored.every((c) => c.archivedPath !== `FITZGERALD_Eleanor_H100234/${TODAY}/${listed}`)).toBe(true);
      visit.children.set(listed, kept);
      visit.children.delete('stray-photo.jpg');
      fresh = again;
    });

    it('can be stopped and carried on later', async () => {
      const again = await newComputer(fresh.db);
      await again.store.chooseArchiveFolder();
      await again.store.checkArchiveForRestore();
      const total = (again.store.useApp.getState().restore as { count: { newPhotos: number } }).count.newPhotos;
      expect(total).toBeGreaterThan(2);
      // Stop as soon as the first photograph is in.
      const unsubscribe = again.store.useApp.subscribe((s) => {
        if (s.restore.status === 'restoring' && s.restore.done >= 1) again.store.stopRestore();
      });
      await again.store.runRestore();
      unsubscribe();
      const partial = again.store.useApp.getState().restore;
      expect(partial).toMatchObject({ status: 'done', stopped: true });
      const sofar = (await again.db.allCaptures()).length;
      expect(sofar).toBeGreaterThan(0);
      expect(sofar).toBeLessThan(total);
      await again.store.checkArchiveForRestore();
      await again.store.runRestore();
      expect(await again.db.allCaptures()).toHaveLength(total);
      expect(again.store.useApp.getState().restore).toMatchObject({ status: 'done', stopped: false });
    }, 20000);
  });
});
