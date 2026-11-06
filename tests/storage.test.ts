import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as db from '../src/lib/db';
import { captureFileName, patientFolderName, safeSegment } from '../src/lib/naming';
import { buildZip, crc32 } from '../src/lib/zip';

describe('naming', () => {
  it('builds readable, filesystem-safe names', () => {
    expect(patientFolderName({ lastName: "O'Brien", firstName: 'Mary Kate', mrn: 'H 100/234' })).toBe("O'BRIEN_Mary-Kate_H-100234");
    const ts = new Date(2026, 10, 3, 14, 32, 5).getTime();
    expect(captureFileName({ mrn: 'H100234', lastName: 'Smith' }, { takenAt: ts, eye: 'OD', technique: 'slit' }, 'image/webp')).toBe(
      'H100234_20261103_143205_OD_slit.webp',
    );
    expect(safeSegment('CON')).toBe('untitled');
    expect(safeSegment('a<b>c:d. ')).toBe('abcd');
  });
});

describe('zip', () => {
  it('computes CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a valid stored archive', async () => {
    const blob = await buildZip([
      { path: 'a.txt', data: 'hello' },
      { path: 'folder/b.txt', data: 'world!' },
    ]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buf.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = buf.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const cdOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
  });
});

describe('database import', () => {
  it('matches patients across days by MRN and avoids duplicate visits', async () => {
    const first = await db.importRecords(
      [
        { mrn: 'H1', firstName: 'John', lastName: 'Smith', dob: '1956-03-12', time: '09:00' },
        { mrn: 'H2', firstName: 'Aoife', lastName: 'Byrne' },
      ],
      '2026-11-03',
      'csv',
    );
    expect(first).toMatchObject({ added: 2, listed: 2 });

    const again = await db.importRecords([{ mrn: 'h1', firstName: 'John', lastName: 'Smith', time: '09:30' }], '2026-11-03', 'csv');
    expect(again).toMatchObject({ added: 0, updated: 1, listed: 0, alreadyListed: 1 });
    const visits = await db.visitsForDate('2026-11-03');
    expect(visits).toHaveLength(2);
    expect(visits.find((v) => v.time === '09:30')).toBeTruthy();

    const nextWeek = await db.importRecords([{ mrn: 'H1', firstName: 'John', lastName: 'Smith' }], '2026-11-10', 'csv');
    expect(nextWeek).toMatchObject({ added: 0, listed: 1 });
    const patients = await db.allPatients();
    expect(patients).toHaveLength(2);
    const john = patients.find((p) => p.mrn === 'H1')!;
    expect(await db.visitsForPatient(john.id)).toHaveLength(2);
  });
});

describe('database rules', () => {
  it('shares one visit when two captures arrive at the same moment', async () => {
    const [a, b] = await Promise.all([db.ensureVisit('race-1', '2026-11-06'), db.ensureVisit('race-1', '2026-11-06')]);
    expect(a.id).toBe(b.id);
    expect((await db.visitsForDate('2026-11-06')).filter((v) => v.patientId === 'race-1')).toHaveLength(1);
  });

  it('treats MRNs the same regardless of spacing and case', async () => {
    await db.importRecords([{ mrn: '123 456 7890', firstName: 'Ann', lastName: 'Byrne' }], '2026-12-01', 'csv');
    const again = await db.importRecords([{ mrn: '1234567890', firstName: 'Ann', lastName: 'Byrne' }], '2026-12-02', 'csv');
    expect(again).toMatchObject({ added: 0, updated: 1 });
    expect((await db.allPatients()).filter((p) => p.firstName === 'Ann')).toHaveLength(1);
    expect(await db.findPatientByMrn(' 1234 567 890')).toBeTruthy();
  });

  it('matches a second row for the same person within one import after assigning an MRN', async () => {
    await db.importRecords([{ firstName: 'Tom', lastName: 'Kelly', dob: '1970-01-01' }], '2026-12-03', 'csv');
    const r = await db.importRecords(
      [
        { mrn: 'K1', firstName: 'Tom', lastName: 'Kelly', dob: '1970-01-01', time: '09:00' },
        { mrn: 'K1', firstName: 'Thomas', lastName: 'Kelly', time: '14:00' },
      ],
      '2026-12-03',
      'csv',
    );
    expect(r.added).toBe(0);
    expect((await db.allPatients()).filter((p) => p.lastName === 'Kelly')).toHaveLength(1);
  });

  it('patches a capture without overwriting newer edits', async () => {
    const base = {
      id: 'cap-1', patientId: 'p', visitId: 'v', date: '2026-11-06', eye: 'OD' as const, takenAt: 1, width: 1, height: 1,
      mime: 'image/webp', bytes: 1, fileName: 'a.webp', source: 'live' as const,
    };
    await db.addCapture(base, { id: 'cap-1', full: new Blob(['x']), thumb: new Blob(['y']) });
    await db.patchCapture('cap-1', { starred: true });
    const next = await db.patchCapture('cap-1', { archivedPath: 'P/2026-11-06/a.webp' });
    expect(next).toMatchObject({ starred: true, archivedPath: 'P/2026-11-06/a.webp' });
  });
});
