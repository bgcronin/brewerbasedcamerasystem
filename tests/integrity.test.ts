/**
 * Regression tests for the paths that decide whose photo it is, which eye it is,
 * and whether the archive folder agrees with Lumen. They run the real store
 * against an in-memory database and an in-memory archive folder.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDir, fsControl, readJson, sleep, tree } from './helpers/fakefs';

const g = vi.hoisted(() => {
  // The store expects a browser: give it just enough of one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as unknown as Record<string, any>;
  g.window = g;
  g.addEventListener = () => undefined;
  g.removeEventListener = () => undefined;
  g.showDirectoryPicker = async (opts: { id?: string }) => (opts?.id === 'lumen-tether' ? g.__tether : g.__archive);
  g.createImageBitmap = async () => ({ width: 100, height: 80, close() {} });
  // The 6.5 s undo window is shortened so the tests don't wait for it.
  const realSetTimeout = g.setTimeout;
  g.setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 6500 ? (g.__undoMs ?? 60) : ms, ...rest);
  return g;
});

vi.mock('../src/lib/encode', () => ({
  warmEncoder() {},
  async encodeBitmap(req: { thumbOnly?: boolean; format: string }) {
    await new Promise((r) => setTimeout(r, g.__encodeMs ?? 0));
    return { full: req.thumbOnly ? undefined : new Blob(['full-' + Math.random()], { type: req.format }), thumb: new Blob(['thumb'], { type: 'image/webp' }), width: 100, height: 80 };
  },
}));

import * as db from '../src/lib/db';
import { isArchivedAs } from '../src/lib/archive';
import type { Capture } from '../src/lib/types';
import * as store from '../src/state/store';

const IDENT = { rotate: 0 as const, flipH: false, flipV: false };
const bitmap = () => ({ width: 100, height: 80, close() {} }) as unknown as ImageBitmap;
const state = () => store.useApp.getState();
let archive: FakeDir;
let n = 0;

/** A new patient, selected, with nothing else going on. */
async function patient(last: string) {
  n++;
  const id = await store.savePatient({ mrn: `T${n}`, firstName: 'Test', lastName: last });
  await store.selectPatient(id);
  store.setEye('OD');
  store.setTechnique(null);
  return (await db.getPatient(id))!;
}
const shoot = async () => (await store.ingest({ bitmap: bitmap(), source: 'live', transform: IDENT }))!;
const photos = (folder: string) => tree(archive).filter((f) => f.startsWith(folder) && !f.endsWith('visit.json'));
const manifest = (c: Capture) => readJson<{ images: { file: string; eye: string; technique?: string; diagnoses?: string[] }[] }>(archive, c.archivedPath!.split('/').slice(0, 2).join('/') + '/visit.json');
const stored = async (id: string) => (await db.getCapture(id))!;
/** Wait until background archive work has finished. */
const settled = async () => {
  await sleep(30);
  await store.syncArchive(true);
};

beforeAll(async () => {
  archive = new FakeDir('Archive');
  g.__archive = archive;
  store.useApp.setState({ settings: { ...state().settings, shutterSound: false } });
  await store.chooseArchiveFolder();
});

beforeEach(() => {
  fsControl.reset();
  g.__encodeMs = 0;
  g.__undoMs = 60;
});

describe('relabelling a photo', () => {
  it('two quick relabels end on the last one, in Lumen, in the file name and in visit.json', async () => {
    const p = await patient('Able');
    const c = await shoot();
    fsControl.delayMs = 30; // a network share
    const first = store.updateCapture(c.id, { eye: 'OU' }); // a mis-click
    await sleep(8);
    const second = store.updateCapture(c.id, { eye: 'OS' }); // corrected at once
    await Promise.all([first, second]);
    const rec = await stored(c.id);
    expect(rec.eye).toBe('OS');
    expect(rec.archivedPath).toMatch(/_OS\.webp$/);
    expect(rec.archiveDirty).toBeFalsy();
    expect(photos(`ABLE_Test_${p.mrn}`)).toEqual([rec.archivedPath]);
    expect((await manifest(rec)).images).toMatchObject([{ file: rec.archivedPath!.split('/').pop(), eye: 'OS' }]);
  });

  it('clearing the illumination renames the file too', async () => {
    await patient('Baker');
    store.setTechnique('slit');
    const c = await shoot();
    expect((await stored(c.id)).archivedPath).toMatch(/_OD_slit\.webp$/);
    await store.updateCapture(c.id, { technique: undefined });
    const rec = await stored(c.id);
    expect(rec.technique).toBeUndefined();
    expect(rec.archivedPath).toMatch(/_OD\.webp$/);
    expect((await manifest(rec)).images[0].technique).toBeUndefined();
  });

  it('a relabel made while the photo is still being written to the archive is not lost', async () => {
    const p = await patient('Carter');
    fsControl.delayMs = 60;
    const shot = shoot();
    await sleep(20);
    const c = state().captures.at(-1)!;
    const relabel = store.updateCapture(c.id, { eye: 'OS' });
    await Promise.all([shot, relabel]);
    await settled();
    const rec = await stored(c.id);
    expect(rec.eye).toBe('OS');
    expect(rec.archivedPath).toMatch(/_OS\.webp$/);
    expect(photos(`CARTER_Test_${p.mrn}`)).toEqual([rec.archivedPath]);
    expect((await manifest(rec)).images).toMatchObject([{ eye: 'OS' }]);
  });

  it('a relabel made while the archive folder is unavailable is applied at the next sync', async () => {
    const p = await patient('Dunne');
    const c = await shoot();
    store.useApp.setState({ archive: { ...state().archive, status: 'needs-permission' } });
    await store.updateCapture(c.id, { eye: 'OS', note: 'check lid' });
    let rec = await stored(c.id);
    expect(rec.eye).toBe('OS');
    expect(rec.archiveDirty).toBe(true);
    expect(rec.archivedPath).toMatch(/_OD\.webp$/); // not reached yet
    expect(state().archive.pending).toBe(1); // and Lumen says so

    await store.reconnectArchive(); // permission given again
    rec = await stored(c.id);
    expect(rec.archiveDirty).toBeFalsy();
    expect(rec.archivedPath).toMatch(/_OS\.webp$/);
    expect(photos(`DUNNE_Test_${p.mrn}`)).toEqual([rec.archivedPath]);
    expect(state().archive.pending).toBe(0);
  });

  it('if visit.json cannot be written after the rename, Lumen still knows the new file name', async () => {
    const p = await patient('Egan');
    const c = await shoot();
    fsControl.failWrite = (path) => path.endsWith('visit.json');
    await store.updateCapture(c.id, { eye: 'OS' });
    let rec = await stored(c.id);
    expect(rec.archivedPath).toMatch(/_OS\.webp$/);
    expect(photos(`EGAN_Test_${p.mrn}`)).toEqual([rec.archivedPath]); // the path points at a file that exists
    expect(rec.archiveDirty).toBe(true); // visit.json is still to do

    fsControl.reset();
    await store.syncArchive(true);
    rec = await stored(c.id);
    expect(rec.archiveDirty).toBeFalsy();
    expect((await manifest(rec)).images).toMatchObject([{ file: rec.archivedPath!.split('/').pop(), eye: 'OS' }]);
  });

  it('an archive copy deleted by hand is written again under the right name', async () => {
    const p = await patient('Flood');
    const c = await shoot();
    const [folder, date, file] = (await stored(c.id)).archivedPath!.split('/');
    ((archive.children.get(folder) as FakeDir).children.get(date) as FakeDir).children.delete(file);
    await store.updateCapture(c.id, { eye: 'OS' });
    await settled();
    const rec = await stored(c.id);
    expect(rec.archivedPath).toMatch(/_OS\.webp$/);
    expect(photos(`FLOOD_Test_${p.mrn}`)).toEqual([rec.archivedPath]);
  });

  it('recognises a file as the one a photo was archived as', () => {
    expect(isArchivedAs('H1_20261103_143205_OD.webp', 'H1_20261103_143205_OD.webp')).toBe(true);
    expect(isArchivedAs('H1_20261103_143205_OD_2.webp', 'H1_20261103_143205_OD.webp')).toBe(true);
    expect(isArchivedAs('H1_20261103_143205_OD_slit.webp', 'H1_20261103_143205_OD.webp')).toBe(false);
    expect(isArchivedAs('H1_20261103_143205_OS.webp', 'H1_20261103_143205_OD.webp')).toBe(false);
  });
});

describe('who and which eye a photo is filed under', () => {
  it('a batch of dropped files all goes to the patient and eye selected when it was dropped', async () => {
    const a = await patient('Grace');
    const files = [1, 2, 3, 4, 5, 6].map((i) => new File(['x' + i], `IMG_${i}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }));
    g.__encodeMs = 25;
    const batch = store.importFiles(files);
    await sleep(40); // part-way through, the user moves on
    const b = await patient('Hayes');
    store.setEye('OS');
    await batch;
    const forA = await db.capturesForPatient(a.id);
    expect(forA).toHaveLength(6);
    expect(forA.every((c) => c.eye === 'OD')).toBe(true);
    expect(await db.capturesForPatient(b.id)).toHaveLength(0);
  });

  it('a live capture is filed with what was selected at the press, not when the frame arrives', async () => {
    const a = await patient('Irwin');
    const slowGrab = async () => {
      await sleep(40);
      return bitmap();
    };
    const press = store.captureFromLive(slowGrab, 'Mizar');
    await sleep(10);
    const b = await patient('Joyce'); // ↓ pressed straight after the shutter
    store.setEye('OS');
    await press;
    const forA = await db.capturesForPatient(a.id);
    expect(forA).toHaveLength(1);
    expect(forA[0].eye).toBe('OD');
    expect(await db.capturesForPatient(b.id)).toHaveLength(0);
  });

  it('a photo from the camera folder is filed with what was selected when it started to arrive', async () => {
    const tether = new FakeDir('EOS');
    g.__tether = tether;
    tether.drop('OLD_0001.JPG', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])])); // already there: left alone
    const a = await patient('Kelly');
    await store.chooseTetherFolder();
    expect(state().tether.watching).toBe(true);

    tether.drop('IMG_0002.JPG', new Blob([new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])]));
    await sleep(1300); // seen by now, but not yet read
    expect(state().tether.arriving).toBe(1);
    const b = await patient('Lynch'); // the operator has moved on
    store.setEye('OS');
    await sleep(2600);

    const forA = await db.capturesForPatient(a.id);
    expect(forA).toHaveLength(1);
    expect(forA[0]).toMatchObject({ eye: 'OD', source: 'tether' });
    expect(await db.capturesForPatient(b.id)).toHaveLength(0);
    expect(state().tether.arriving).toBe(0);

    // A viewer touching the file (new timestamp, same size) is not a new photo.
    (tether.children.get('IMG_0002.JPG') as { modified: number }).modified = Date.now() - 1;
    await sleep(2800);
    expect(await db.capturesForPatient(a.id)).toHaveLength(1);
    store.stopTether();
  }, 15000);

  it('photos that arrived while Lumen was not watching wait for a patient instead of going to whoever is selected', async () => {
    const tether: FakeDir = g.__tether;
    await sleep(20);
    tether.drop('IMG_0003.JPG', new Blob([new Uint8Array([0xff, 0xd8, 9, 0xff, 0xd9])]));
    const p = await patient('Moran');
    const before = state().held.length;
    await store.startTether();
    expect(state().held.length).toBe(before + 1);
    expect(await db.capturesForPatient(p.id)).toHaveLength(0);
    await store.fileHeldPhotos(); // the user says whose it is
    expect(await db.capturesForPatient(p.id)).toHaveLength(1);
    expect(state().held).toHaveLength(0);
    store.stopTether();
  });

  it('does not write a stale copy of the patient back when their first photo is archived', async () => {
    const p = await patient('Nolan');
    // The record gains a correction in the database (an import, an edit in another place)…
    await db.patchPatient(p.id, { mrn: 'CORRECTED', firstName: 'Niamh' });
    // …while the screen still holds the old copy. The first photo fixes the archive folder:
    await shoot();
    const now = (await db.getPatient(p.id))!;
    expect(now.mrn).toBe('CORRECTED');
    expect(now.firstName).toBe('Niamh');
    expect(now.archiveFolder).toBeTruthy();
  });

  it('two patients with the same name and no hospital number never share a folder', async () => {
    const one = await store.savePatient({ mrn: '', firstName: 'Sam', lastName: 'Twin' });
    await store.selectPatient(one);
    const c1 = await shoot();
    const two = await store.savePatient({ mrn: '', firstName: 'Sam', lastName: 'Twin' });
    await store.selectPatient(two);
    const c2 = await shoot();
    const f1 = (await stored(c1.id)).archivedPath!.split('/')[0];
    const f2 = (await stored(c2.id)).archivedPath!.split('/')[0];
    expect(f1).toBe('TWIN_Sam');
    expect(f2).toBe('TWIN_Sam_2');
  });
});

describe('deleting a photo', () => {
  it('is recorded at once, so closing the window during the undo period cannot bring it back', async () => {
    const p = await patient('Owens');
    const c = await shoot();
    g.__undoMs = 400;
    store.deleteCapture(c.id);
    await sleep(20);
    // What a freshly opened window would read from the database:
    expect(await db.getCapture(c.id)).toBeUndefined();
    expect(await db.capturesForPatient(p.id)).toHaveLength(0);
    expect((await db.deletedCaptures()).map((x) => x.id)).toContain(c.id); // made final at the next start
    await sleep(500);
    expect(await db.getCaptureRaw(c.id)).toBeUndefined();
    expect(photos(`OWENS_Test_${p.mrn}`)).toEqual([]);
  });

  it('Undo brings the photo back whole', async () => {
    const p = await patient('Power');
    const c = await shoot();
    g.__undoMs = 300;
    store.deleteCapture(c.id);
    await sleep(20);
    state().toasts.find((t) => t.action)!.action!.run();
    await sleep(350);
    expect((await db.capturesForPatient(p.id)).map((x) => x.id)).toEqual([c.id]);
    expect(state().captures.map((x) => x.id)).toContain(c.id);
    expect(photos(`POWER_Test_${p.mrn}`)).toHaveLength(1);
  });

  it('removes the archive file even when Delete is pressed before the file has finished writing', async () => {
    const p = await patient('Quinn');
    fsControl.delayMs = 80;
    const shot = shoot();
    await sleep(15);
    store.deleteCapture(state().captures.at(-1)!.id);
    await shot;
    fsControl.delayMs = 0;
    await sleep(150);
    await settled();
    expect(photos(`QUINN_Test_${p.mrn}`)).toEqual([]);
    expect(await db.capturesForPatient(p.id)).toHaveLength(0);
  });

  it('removes the archive file when the patient is taken off the list inside the undo period', async () => {
    const p = await patient('Roche');
    const c = await shoot();
    g.__undoMs = 5000;
    store.deleteCapture(c.id);
    await sleep(20);
    const visitId = state().rows.find((r) => r.patient.id === p.id)!.visit.id;
    await store.removeFromList(visitId);
    expect(photos(`ROCHE_Test_${p.mrn}`)).toEqual([]);
    // Undo after that does nothing: no photo is left belonging to a visit that has gone.
    state()
      .toasts.filter((t) => t.action)
      .forEach((t) => t.action!.run());
    await sleep(30);
    expect(await db.capturesForPatient(p.id)).toHaveLength(0);
  });
});

describe('writing to the archive folder', () => {
  it('a failed write is retried without leaving a second copy of the photo', async () => {
    const p = await patient('Shaw');
    fsControl.failWrite = (path) => path.endsWith('visit.json'); // the photo lands, visit.json is locked
    const c = await shoot();
    expect((await stored(c.id)).archivedPath).toBeUndefined();
    fsControl.reset();
    await store.reconnectArchive();
    const rec = await stored(c.id);
    expect(rec.archivedPath).toBeTruthy();
    expect(photos(`SHAW_Test_${p.mrn}`)).toEqual([rec.archivedPath]); // one file, not "…_2.webp" as well
    expect((await manifest(rec)).images).toHaveLength(1);
  });

  it('recovers by itself: the next photo after a failure writes the backlog too', async () => {
    const p = await patient('Tobin');
    fsControl.failWrite = () => true;
    const c1 = await shoot();
    expect(state().archive.status).toBe('error');
    fsControl.reset();
    const c2 = await shoot(); // nobody clicked anything
    await settled();
    expect(state().archive.status).toBe('connected');
    expect((await stored(c1.id)).archivedPath).toBeTruthy();
    expect((await stored(c2.id)).archivedPath).toBeTruthy();
    expect(photos(`TOBIN_Test_${p.mrn}`)).toHaveLength(2);
  });

  it('one photo that cannot be written does not hold up the rest', async () => {
    const p = await patient('Usher');
    store.useApp.setState({ archive: { ...state().archive, status: 'needs-permission' } });
    store.setEye('OD');
    const c1 = await shoot();
    store.setEye('OS');
    const c2 = await shoot();
    store.setEye('OU');
    const c3 = await shoot();
    fsControl.failWrite = (path) => /_OD\.webp$/.test(path);
    await store.reconnectArchive();
    expect((await stored(c1.id)).archivedPath).toBeUndefined();
    expect((await stored(c2.id)).archivedPath).toBeTruthy();
    expect((await stored(c3.id)).archivedPath).toBeTruthy();
    fsControl.reset();
    await store.syncArchive(true);
    expect((await stored(c1.id)).archivedPath).toBeTruthy();
    expect(photos(`USHER_Test_${p.mrn}`)).toHaveLength(3);
  });

  it('two syncs started together write each photo once', async () => {
    const p = await patient('Vance');
    store.useApp.setState({ archive: { ...state().archive, status: 'needs-permission' } });
    await shoot();
    await shoot();
    store.useApp.setState({ archive: { ...state().archive, status: 'connected' } });
    fsControl.delayMs = 20;
    await Promise.all([store.syncArchive(true), store.syncArchive(true)]);
    expect(photos(`VANCE_Test_${p.mrn}`)).toHaveLength(2);
  });

  it('after the archive folder is changed, the new folder is filled in', async () => {
    const p = await patient('Walsh');
    const c = await shoot();
    const old = archive;
    archive = new FakeDir('NewArchive');
    g.__archive = archive;
    await store.chooseArchiveFolder();
    const rec = await stored(c.id);
    expect(photos(`WALSH_Test_${p.mrn}`)).toEqual([rec.archivedPath]);
    expect(tree(old).length).toBeGreaterThan(0); // the old folder is left as it was
  });
});

describe('moving through the list with the arrow keys', () => {
  it('carries on from the current patient when they have dropped out of a filtered list', async () => {
    const ids = [await store.savePatient({ mrn: 'L1', firstName: 'A', lastName: 'List' }), await store.savePatient({ mrn: 'L2', firstName: 'B', lastName: 'List' }), await store.savePatient({ mrn: 'L3', firstName: 'C', lastName: 'List' })];
    const order = state().rows.map((r) => r.patient.id).filter((id) => ids.includes(id));
    await store.selectPatient(order[1]);
    // "To do" no longer lists the patient just photographed:
    store.useApp.setState({ visiblePatientIds: state().rows.map((r) => r.patient.id).filter((id) => id !== order[1]) });
    store.selectAdjacent(1);
    await sleep(20);
    expect(state().activePatientId).toBe(order[2]);
    await store.selectPatient(order[1]);
    store.selectAdjacent(-1);
    await sleep(20);
    expect(state().activePatientId).toBe(order[0]);
    store.useApp.setState({ visiblePatientIds: null });
  });
});
