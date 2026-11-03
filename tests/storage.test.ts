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
