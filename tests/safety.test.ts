/**
 * The safety net under every import, CSV included: an import never renames a
 * patient, never changes a date of birth, and never attaches a row to somebody
 * it cannot be sure is the same person. Also where dropped files go.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as db from '../src/lib/db';
import { routeDroppedFiles } from '../src/lib/importers';
import { namesClearlyDiffer } from '../src/lib/importers/identity';

const n = (lastName: string, firstName: string) => ({ lastName, firstName });

describe('is it the same name?', () => {
  it('does not count capitals, accents, punctuation, order, titles, initials or a spelling slip as different', () => {
    const same: [ReturnType<typeof n>, ReturnType<typeof n>][] = [
      [n('SMITH', 'John'), n('Smith', 'john')],
      [n('Smith', 'John'), n('John', 'Smith')],
      [n("O'SULLIVAN", 'Cian'), n('O’Sullivan', 'Cian')],
      [n('OSullivan', 'Cian'), n("O'Sullivan", 'Cian')],
      [n('KAVANAGH', 'Siobhán'), n('Kavanagh', 'Siobhan')],
      [n('McCarthy', 'Seán'), n('Mc Carthy', 'Sean')],
      [n('De La Cruz', 'Mateo'), n('DELACRUZ', 'Mateo')],
      [n('Smith', 'J'), n('Smith', 'John')],
      [n('Smith', 'John Paul'), n('Smith', 'John')],
      [n('Smith-Jones', 'Mary'), n('Smith', 'Mary')],
      [n('Smith', 'Mr John'), n('Smith', 'John')],
      [n('Kavanagh', 'Siobhan'), n('Cavanagh', 'Siobhan')],
      [n('Kelly', 'Tom'), n('Kelly', 'Thomas')],
      [n('Byrne', 'Kate'), n('Byrne', 'Katherine')],
      [n('Fitzgerald', 'Eleanor'), n('Fitzgerld', 'Eleanor')],
      [n('Smith', ''), n('Smith', 'John')],
    ];
    for (const [a, b] of same) expect(namesClearlyDiffer(a, b), `${a.lastName}, ${a.firstName} / ${b.lastName}, ${b.firstName}`).toBe(false);
  });

  it('knows two different people', () => {
    const different: [ReturnType<typeof n>, ReturnType<typeof n>][] = [
      [n('Kelly', 'Tom'), n('Smith', 'John')],
      [n('Smith', 'John'), n('Smith', 'Mary')],
      [n('Smith', 'Mary'), n('Jones', 'Mary')],
      [n('Ng', 'Li'), n('Wu', 'Li')],
      [n('Byrne', 'Ann'), n('Doyle', 'Pat')],
      [n('Murphy', 'Declan'), n('Murphy', 'Aoife')],
    ];
    for (const [a, b] of different) expect(namesClearlyDiffer(a, b), `${a.lastName}, ${a.firstName} / ${b.lastName}, ${b.firstName}`).toBe(true);
  });
});

describe('importing never renames anyone', () => {
  it('a row whose hospital number belongs to someone else is left out and reported', async () => {
    await db.importRecords([{ mrn: 'S100234', firstName: 'Tom', lastName: 'Kelly', dob: '1970-01-01' }], '2026-11-01', 'csv');
    // A misread number (S100234 for 5100234, say) arriving with another patient's details.
    const r = await db.importRecords([{ mrn: 'S100234', firstName: 'John', lastName: 'Smith', dob: '1956-03-12', time: '09:00' }], '2026-11-11', 'scan');
    expect(r).toMatchObject({ added: 0, updated: 0, listed: 0 });
    expect(r.conflicts).toEqual(['S100234 already belongs to KELLY, Tom; the row for SMITH, John was left out']);
    const tom = (await db.findPatientByMrn('S100234'))!;
    expect([tom.firstName, tom.lastName, tom.dob]).toEqual(['Tom', 'Kelly', '1970-01-01']);
    expect(await db.visitsForPatient(tom.id)).toHaveLength(1);
    expect((await db.allPatients()).filter((p) => p.lastName === 'Smith')).toHaveLength(0);
  });

  it('…also when the row has no date of birth, or the record has none', async () => {
    await db.importRecords([{ mrn: 'A1', firstName: 'Ann', lastName: 'Byrne' }], '2026-11-01', 'csv');
    const r = await db.importRecords([{ mrn: 'A1', firstName: 'Pat', lastName: 'Doyle', dob: '1960-02-02' }, { mrn: 'A1', firstName: 'Sam', lastName: 'Nolan' }], '2026-11-11', 'csv');
    expect(r.conflicts).toHaveLength(2);
    const ann = (await db.findPatientByMrn('A1'))!;
    expect([ann.firstName, ann.lastName, ann.dob]).toEqual(['Ann', 'Byrne', undefined]);
  });

  it('a different name with the same hospital number and the same date of birth is the same person, and keeps the name on record', async () => {
    await db.importRecords([{ mrn: 'M7', firstName: 'Mary', lastName: 'Smith', dob: '1980-05-05' }], '2026-11-01', 'csv');
    const r = await db.importRecords([{ mrn: 'M7', firstName: 'Mary', lastName: 'Jones', dob: '1980-05-05' }], '2026-11-11', 'csv');
    expect(r).toMatchObject({ added: 0, updated: 1, listed: 1, conflicts: [] });
    expect((await db.findPatientByMrn('M7'))!.lastName).toBe('Smith');
  });

  it('a match fills in only what was blank: never the name, never the date of birth', async () => {
    await db.importRecords([{ mrn: 'F1', firstName: 'Eleanor', lastName: 'Fitzgerald', dob: '1956-03-12' }], '2026-11-01', 'csv');
    await db.importRecords([{ mrn: 'F1', firstName: 'ELEANOR M', lastName: 'FITZGERALD', dob: '1956-12-03', sex: 'F' }], '2026-11-11', 'csv');
    const p = (await db.findPatientByMrn('F1'))!;
    expect([p.firstName, p.lastName, p.dob, p.sex]).toEqual(['Eleanor', 'Fitzgerald', '1956-03-12', 'F']);
    // A hospital number arriving for someone known only by name and date of birth is filled in.
    await db.importRecords([{ firstName: 'Hana', lastName: 'Nakamura', dob: '1972-11-04' }], '2026-11-01', 'csv');
    const r = await db.importRecords([{ mrn: 'N9', firstName: 'Hana', lastName: 'Nakamura', dob: '1972-11-04' }], '2026-11-11', 'csv');
    expect(r).toMatchObject({ added: 0, updated: 1 });
    expect((await db.findPatientByMrn('N9'))!.dob).toBe('1972-11-04');
  });

  it('two rows in one list with the same number and different names: the second is left out', async () => {
    const r = await db.importRecords(
      [
        { mrn: 'D5', firstName: 'Ann', lastName: 'Byrne', dob: '1950-01-01' },
        { mrn: 'D5', firstName: 'Pat', lastName: 'Doyle', dob: '1960-02-02' },
      ],
      '2026-11-11',
      'scan',
    );
    expect(r).toMatchObject({ added: 1, listed: 1 });
    expect(r.conflicts).toHaveLength(1);
  });

  it('a name alone is not enough to match: a separate record is made, and said so', async () => {
    await db.importRecords([{ mrn: 'Q1', firstName: 'Declan', lastName: 'Murphy', dob: '1949-01-21' }], '2026-11-01', 'csv');
    const r = await db.importRecords([{ firstName: 'Declan', lastName: 'Murphy' }], '2026-11-11', 'csv');
    expect(r).toMatchObject({ added: 1, updated: 0 });
    expect(r.keptSeparate).toHaveLength(1);
    expect(r.keptSeparate[0]).toMatch(/MURPHY, Declan has no hospital number or date of birth/);
    expect((await db.allPatients()).filter((p) => p.lastName === 'Murphy')).toHaveLength(2);
    expect((await db.findPatientByMrn('Q1'))!.dob).toBe('1949-01-21');
    // The same name-only list imported again for the same day is the same list, not a third Declan Murphy.
    const again = await db.importRecords([{ firstName: 'Declan', lastName: 'Murphy', time: '10:00' }], '2026-11-11', 'csv');
    expect(again).toMatchObject({ added: 0, alreadyListed: 1 });
    expect((await db.allPatients()).filter((p) => p.lastName === 'Murphy')).toHaveLength(2);
    // A number with a name but no date of birth does not claim a namesake either.
    const numbered = await db.importRecords([{ mrn: 'Q2', firstName: 'Declan', lastName: 'Murphy' }], '2026-11-12', 'csv');
    expect(numbered).toMatchObject({ added: 1 });
    expect(numbered.keptSeparate).toHaveLength(1);
  });
});

describe('files dropped on the window', () => {
  const file = (name: string, type: string) => new File([new Uint8Array(4)], name, { type });

  it('photographs go to the patient, as they always did', () => {
    const photos = [file('IMG_0001.JPG', 'image/jpeg'), file('eye.png', 'image/png'), file('os.webp', 'image/webp')];
    const r = routeDroppedFiles(photos);
    expect(r.list).toBeUndefined();
    expect(r.photos).toEqual(photos);
  });

  it('only a document opens the list import', () => {
    for (const f of [file('clinic.pdf', 'application/pdf'), file('list.csv', 'text/csv'), file('list.tsv', ''), file('list.json', 'application/json'), file('export.txt', 'text/plain')]) {
      expect(routeDroppedFiles([f])).toEqual({ list: f, photos: [] });
    }
    const pdf = file('clinic.pdf', 'application/pdf');
    const photo = file('IMG_0002.jpg', 'image/jpeg');
    expect(routeDroppedFiles([photo, pdf])).toEqual({ list: pdf, photos: [photo] });
  });

  it('anything else is neither', () => {
    expect(routeDroppedFiles([file('notes.docx', 'application/vnd.openxmlformats')])).toEqual({ list: undefined, photos: [] });
  });
});
