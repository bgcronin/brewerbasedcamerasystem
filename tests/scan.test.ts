/**
 * The printed-list reader, case by case.
 *
 * Every case here once went wrong without warning: a patient dropped, renamed
 * after their appointment type, or given somebody else's number. The rule the
 * tests hold the reader to is the one the reader is built on: each row is
 * either right, or flagged for a person to check. Never silently wrong.
 */
import { describe, expect, it } from 'vitest';
import { applyMapping } from '../src/lib/importers/mapping';
import { checkRows } from '../src/lib/importers/review';
import { readScan, readScannedLines, type PageInput, type ScanReading } from '../src/lib/importers/scanParse';
import { doubtfulMrn, findAnchors, isFurniture, readBirthDate, readTime, repairMrn } from '../src/lib/importers/shapes';
import type { ImportedRecord } from '../src/lib/importers/types';

/* ───────── helpers ───────── */

interface Seen {
  record?: ImportedRecord;
  cells: string[];
  flagged: boolean;
  why: string[];
}

/** What the import sheet would make of a reading: each row as a record, and whether it is held back for checking. */
function seen(r: ScanReading, order: 'auto' | 'DMY' | 'MDY' = 'auto'): Seen[] {
  const data = r.hasHeader ? r.rows.slice(1) : r.rows;
  const readings = r.hasHeader ? r.readings.slice(1) : r.readings;
  const dateOrder = applyMapping(data, r.mapping, order).dateOrder;
  const problems = checkRows(data, r.mapping, dateOrder);
  return data.map((cells, i) => {
    const why = [...(readings[i]?.doubts ?? []).map((d) => d.reason), ...problems[i].map((p) => p.reason)];
    return { cells, record: applyMapping([cells], r.mapping, dateOrder).records[0], flagged: why.length > 0, why };
  });
}

const who = (s: Seen) => (s.record ? `${s.record.mrn ?? ''}|${s.record.lastName}|${s.record.firstName}|${s.record.dob ?? ''}` : '');
const hasName = (r: ScanReading) => r.mapping.some((f) => f === 'fullName' || f === 'lastName' || f === 'firstName');

/**
 * The rule: this patient is on the list exactly as printed, or the row that
 * holds them is flagged, or the reader declined to choose a name column (the
 * sheet then will not import until the user has chosen one).
 */
function expectSafe(r: ScanReading, truth: string): void {
  const rows = seen(r);
  const right = rows.some((s) => !s.flagged && who(s) === truth);
  const mrn = truth.split('|')[0];
  const surname = truth.split('|')[1].toLowerCase();
  const held = rows.some((s) => s.flagged && s.cells.join(' ').toLowerCase().match(new RegExp(`${surname.slice(0, 4)}|${mrn.slice(-4).toLowerCase()}`)));
  expect(right || held || !hasName(r), `${truth} must be right or flagged; got ${JSON.stringify(rows.map((s) => [who(s), s.flagged]))}`).toBe(true);
  // And nobody else may carry this patient's number or name unflagged.
  for (const s of rows) {
    if (s.flagged || !s.record || !hasName(r)) continue;
    const [m, last] = who(s).split('|');
    if (m === mrn || last.toLowerCase() === surname) expect(who(s)).toBe(truth);
  }
}

const P = [
  ['08:45', 'H100234', 'FITZGERALD, Eleanor', '12/03/1956', 'F', 'Review - keratoconus'],
  ['09:00', 'H100877', "O'SULLIVAN, Cian", '30/07/1988', 'M', 'New - red eye'],
  ['09:15', 'H101532', 'NAKAMURA, Hana', '04/11/1972', 'F', 'Post-op graft'],
  ['09:30', 'H098812', 'MURPHY, Declan', '21/01/1949', 'M', 'Review - Fuchs dystrophy'],
];
const TRUTH = ["H100234|Fitzgerald|Eleanor|1956-03-12", "H100877|O'Sullivan|Cian|1988-07-30", 'H101532|Nakamura|Hana|1972-11-04', 'H098812|Murphy|Declan|1949-01-21'];
const text = (rows: string[][], sep = '   ') => rows.map((r) => r.join(sep));
const withCol = (col: number, values: string[], rows = P) => rows.map((r, i) => r.map((c, j) => (j === col ? values[i] ?? c : c)));
const allRight = (r: ScanReading, truth = TRUTH) => {
  const rows = seen(r);
  expect(rows.filter((s) => !s.flagged).map(who)).toEqual(truth);
};

/** A list as positioned boxes: one box per cell (or per word, as OCR gives them), 10-unit type on 20-unit rows. */
function boxes(rows: string[][], xs: number[], opts: { ocr?: boolean; perWord?: boolean; page?: number; conf?: (row: number, col: number) => number } = {}): PageInput {
  const out: NonNullable<PageInput['boxes']> = [];
  rows.forEach((r, ri) => {
    const y = 100 + ri * 20;
    r.forEach((cell, ci) => {
      if (!cell) return;
      const conf = opts.ocr ? opts.conf?.(ri, ci) ?? 92 : undefined;
      if (!opts.perWord) {
        out.push({ text: cell, x0: xs[ci], x1: xs[ci] + cell.length * 5.5, y0: y, y1: y + 10, conf });
        return;
      }
      let x = xs[ci];
      for (const w of cell.split(' ')) {
        out.push({ text: w, x0: x, x1: x + w.length * 5.5, y0: y, y1: y + 10, conf });
        x += w.length * 5.5 + 3;
      }
    });
  });
  return { page: opts.page ?? 1, ocr: !!opts.ocr, boxes: out };
}
const XS = [40, 95, 180, 350, 440, 480];
const HEAD = ['Time', 'Hospital No', 'Patient', 'DOB', 'Sex', 'Appointment type'];

/* ───────── the table ───────── */

describe('rebuilding the table from positions', () => {
  it('reads a list with a title, headings and a footer, and keeps what it did not use', () => {
    const r = readScan([boxes([['Cornea Clinic – Ms Brennan'], HEAD, ...P, ['Page 1 of 1 - 4 patients - Confidential']], XS)]);
    expect(r.hasHeader).toBe(true);
    expect(r.mapping).toEqual(['time', 'mrn', 'fullName', 'dob', 'sex', 'reason']);
    allRight(r);
    expect(r.notUsed).toEqual(['Cornea Clinic – Ms Brennan', 'Page 1 of 1 - 4 patients - Confidential']);
    expect([r.clean, r.toCheck, r.unread]).toEqual([4, 0, 0]);
  });

  it('reads the same list from OCR words', () => {
    allRight(readScan([boxes([['Cornea Clinic – Ms Brennan'], HEAD, ...P], XS, { ocr: true, perWord: true })]));
  });

  it('keeps the raw date text, so the date-order control still works', () => {
    const us = [['09:00', 'H100234', 'SMITH, John', '03/12/1956', 'M'], ['09:15', 'H100235', 'JONES, Mary', '07/04/1960', 'F'], ['09:30', 'H100236', 'DOE, Jane', '03/25/1961', 'F']];
    const r = readScan([boxes(us, XS)]);
    expect(r.rows.map((x) => x[3])).toEqual(['03/12/1956', '07/04/1960', '03/25/1961']);
    // 03/25 can only be month first, so the whole list is read that way…
    expect(seen(r).map((s) => s.record?.dob)).toEqual(['1956-03-12', '1960-07-04', '1961-03-25']);
    // …and the user can still say otherwise.
    expect(seen(r, 'DMY').map((s) => s.record?.dob)).toEqual(['1956-12-03', '1960-04-07', '1961-03-25']);
  });

  it('a missing value leaves its column empty instead of shifting the row (and is flagged)', () => {
    const r = readScan([boxes(withCol(1, ['H100234', '', 'H101532', 'H098812']), XS)]);
    const rows = seen(r);
    expect(rows[1].cells[2]).toBe("O'SULLIVAN, Cian");
    expect(rows[1].flagged).toBe(true);
    expect(rows[1].why.join()).toMatch(/No hospital number/);
    expect(rows.filter((s) => !s.flagged)).toHaveLength(3);
  });

  it('H1: surname and forename in their own columns', () => {
    const split = P.map((r) => [r[0], r[1], ...r[2].split(', '), r[3], r[4], r[5]]);
    const xs = [40, 95, 180, 260, 350, 440, 480];
    for (const rows of [split, [['Time', 'MRN', 'Surname', 'Forename', 'DOB', 'Sex', 'Type'], ...split]]) {
      const r = readScan([boxes(rows, xs)]);
      expect(r.mapping.slice(2, 4)).toEqual(['lastName', 'firstName']);
      allRight(r);
    }
    // A surname of several words keeps them all.
    const cruz = readScan([boxes([...split, ['10:30', 'H100456', 'DE LA CRUZ', 'Mateo', '19/12/1958', 'M', 'Pre-op cataract']], xs)]);
    expect(seen(cruz).map(who)).toContain('H100456|De La Cruz|Mateo|1958-12-19');
  });

  it('H1: the appointment type, the consultant and free text never become the name', () => {
    const cases: string[][][] = [
      withCol(5, ['NEW PATIENT', 'REVIEW', 'POST OP', 'NEW PATIENT'], withCol(2, ['FITZGERALD Eleanor', "O'SULLIVAN Cian", 'NAKAMURA Hana', 'MURPHY Declan'])),
      withCol(5, ['Cornea Clinic', 'Cornea Clinic', 'Cornea Clinic', 'Cornea Clinic'], withCol(2, ['Eleanor Fitzgerald', "Cian O'Sullivan", 'Hana Nakamura', 'Declan Murphy'])),
      withCol(5, ['Review, Dr Kelly', 'Interpreter needed, Polish', 'New, urgent', 'Wheelchair, hoist required']),
      P.map((r) => [...r.slice(0, 5), 'BRENNAN, A', r[5]]),
    ];
    for (const rows of cases) {
      const xs = rows[0].length === 7 ? [40, 95, 180, 350, 440, 480, 560] : XS;
      allRight(readScan([boxes(rows, xs)]));
      allRight(readScannedLines(text(rows, '\t')));
    }
    // Single-spaced, as OCR sometimes returns a line.
    allRight(readScannedLines(['08:45 H100234 Eleanor Fitzgerald 12/03/1956 Review post-op', "09:00 H100877 Cian O'Sullivan 30/07/1988 New", '09:15 H101532 Hana Nakamura 04/11/1972 Review', '09:30 H098812 Declan Murphy 21/01/1949 Post-op day 1']));
  });

  it('H1: two columns that could both be the patient are left for the user to choose', () => {
    const kin = P.map((r, i) => [...r.slice(0, 5), ['SMITH, Mary', 'BYRNE, Tom', 'KELLY, Ann', 'DOYLE, Pat'][i]]);
    const r = readScan([boxes(kin, XS)]);
    expect(hasName(r)).toBe(false);
    expect(r.warnings.join()).toMatch(/More than one column looks like a name/);
    // With the headings printed, there is no doubt.
    const headed = readScan([boxes([['Time', 'Hospital No', 'Patient', 'DOB', 'Sex', 'Next of kin'], ...kin], XS)]);
    allRight(headed);
  });

  it('H2: names that begin like a month or a weekday are names', () => {
    const names = ['MARTIN, Mary', 'MONAGHAN, Declan', 'MARSHALL, Margaret', 'MAY, Julie', 'FRIEL, Mark', 'NOVAK, Jan', 'SATO, Jun', 'JUNE, April'];
    const rows = names.map((n, i) => [`09:${10 + i}`, `H20000${i}`, n, `0${i + 1}/02/1960`, 'F', i % 2 ? 'New patient' : 'Review - dry eye']);
    for (const r of [readScan([boxes(rows, XS)]), readScannedLines(text(rows))]) {
      const got = seen(r);
      expect(got.every((s) => !s.flagged)).toBe(true);
      expect(got.map((s) => `${s.record?.lastName}, ${s.record?.firstName}`)).toEqual(['Martin, Mary', 'Monaghan, Declan', 'Marshall, Margaret', 'May, Julie', 'Friel, Mark', 'Novak, Jan', 'Sato, Jun', 'June, April']);
    }
  });

  it('H3: a patient row is never dropped as page furniture or a heading', () => {
    const types = ['Review - total LSCD', 'Post-op, continued care', 'Printed leaflet given', 'Total corneal graft', 'See page 2 of notes', 'Confidential - staff member', 'Review'];
    const names = ['SMITH, John', 'JONES, Mary', 'BLOGGS, Joe', 'DOE, Jane', 'PAGE, Elliot', 'SMYTH, Ann', 'TOTAL, Anne'];
    const rows = names.map((n, i) => [`10:${10 + i}`, `H30000${i}`, n, `1${i}/03/196${i}`, 'M', types[i]]);
    for (const r of [readScan([boxes(rows, XS)]), readScannedLines(text(rows))]) {
      expect(seen(r).filter((s) => !s.flagged).map((s) => s.record?.mrn)).toEqual(rows.map((x) => x[1]));
      expect(r.notUsed).toEqual([]);
    }
    const heads = ['PAGE, Jimmy', 'LIST, Franz', 'NO, Ivo', 'REASON, Ada', 'PATIENT, Peter', 'TYPE, Una', 'CLINIC, Bob', 'NUMBER, Nell'];
    const rows2 = heads.map((n, i) => [`11:${10 + i}`, `H40000${i}`, n, `1${i}/04/197${i}`, 'M', 'Post-op graft']);
    for (const r of [readScan([boxes(rows2, XS)]), readScannedLines(text(rows2))]) {
      expect(seen(r).filter((s) => !s.flagged).map((s) => s.record?.lastName)).toEqual(['Page', 'List', 'No', 'Reason', 'Patient', 'Type', 'Clinic', 'Number']);
    }
  });

  it('H3: furniture patterns are anchored, and a line with a hospital number or a date of birth is never furniture', () => {
    expect(isFurniture('Page 1 of 2')).toBe(true);
    expect(isFurniture('Printed 08:02 11/11/2026')).toBe(true);
    expect(isFurniture('Total: 12')).toBe(true);
    expect(isFurniture('Review - total LSCD')).toBe(false);
    expect(isFurniture('See page 2 of notes')).toBe(false);
    // In the middle of the list, a stray line is kept and flagged rather than dropped…
    const mid = readScannedLines([...text(P.slice(0, 2)), 'Printed by H100999 KELLY, Tom 01/02/1960', ...text(P.slice(2))]);
    expect(mid.toCheck).toBe(1);
    expect(mid.notUsed).toEqual([]);
    expect(seen(mid)[2].why.join()).toMatch(/“Printed by” is where the other lines have nothing/);
    // …and so is one below it that carries a number shaped like the list's own.
    const tail = readScannedLines([...text(P), 'Added late: H100999 KELLY Tom']);
    expect(tail.unread).toBe(1);
  });

  it('H5: a number never takes the word beside it as its prefix', () => {
    const caps = [['09:00', 'MURPHY, JOHN', '1234567', '12/03/1956', 'M'], ['09:15', 'BYRNE, ANNE', '0123456', '01/02/1960', 'F'], ['09:30', 'KELLY, PATRICK', '7654321', '05/06/1971', 'M'], ['09:45', 'LEE, BO', '2223334', '07/08/1981', 'M']];
    const want = ['1234567|Murphy|John|1956-03-12', '0123456|Byrne|Anne|1960-02-01', '7654321|Kelly|Patrick|1971-06-05', '2223334|Lee|Bo|1981-08-07'];
    allRight(readScan([boxes(caps, [40, 95, 260, 330, 420])]), want);
    allRight(readScannedLines(text(caps, '\t')), want);
    allRight(readScannedLines(text(caps, ' ')), want);
    const sexFirst = readScannedLines(['09:00\tSMITH, John\tM\t0123456\t12/03/1956', '09:15\tBYRNE, Ann\tF\t0123457\t01/02/1960', '09:30\tKELLY, Tom\tM\t0123458\t05/06/1971']);
    expect(seen(sexFirst).map((s) => [s.record?.mrn, s.record?.sex])).toEqual([['0123456', 'M'], ['0123457', 'F'], ['0123458', 'M']]);
    const typeFirst = readScannedLines(['09:00\tNEW\t0123456\tSMITH, John\t12/03/1956', '09:15\tDNA\t0123457\tBYRNE, Ann\t01/02/1960', '09:30\tOPD\t0123458\tKELLY, Tom\t05/06/1971']);
    expect(seen(typeFirst).map((s) => s.record?.mrn)).toEqual(['0123456', '0123457', '0123458']);
    const labelled = readScannedLines(text(withCol(1, ['MRN 445566', 'MRN 445567', 'MRN: 445568', 'MRN 445569'])));
    expect(seen(labelled).map((s) => s.record?.mrn)).toEqual(['445566', '445567', '445568', '445569']);
    expect(findAnchors('MURPHY, JOHN 1234567').map((a) => a.text)).toEqual(['1234567']);
  });

  it('H6: the date of birth comes from its own column, whatever other dates are on the line', () => {
    for (const day of ['10/11/2026', new Date().toLocaleDateString('en-GB'), '12/11/2099']) {
      const r = readScan([boxes(P.map((x) => [day, ...x]), [10, 80, 135, 220, 390, 480, 520])]);
      expect(r.mapping[0]).toBe('date');
      allRight(r);
      allRight(readScannedLines(text(P.map((x) => [day, ...x]))));
    }
    const referred = P.map((x, i) => [...x.slice(0, 3), `0${i + 1}/05/2025`, ...x.slice(3)]);
    const r = readScan([boxes(referred, [40, 95, 180, 350, 440, 530, 570])]);
    allRight(r);
    expect(r.warnings.join()).toMatch(/more than one column of dates/);
  });

  it('H6: a date that cannot be read is flagged, and OCR look-alikes are repaired in the open', () => {
    const r = readScan([boxes([HEAD, ...withCol(3, ['12/O3/1956', 'l2/03/1988', '1110/1977', '21/01/1949'])], XS, { ocr: true })]);
    const rows = seen(r);
    expect(rows[0].record?.dob).toBe('1956-03-12');
    expect(rows[0].why.join()).toMatch(/looked like “12\/O3\/1956”/);
    expect(rows[1].record?.dob).toBe('1988-03-12');
    expect(rows[1].flagged).toBe(true);
    expect(rows[2].record?.dob).toBeUndefined();
    expect(rows[2].why.join()).toMatch(/couldn’t be read/);
    expect(rows[3].flagged).toBe(false);
    // Line reading must not take "2/03/1988" out of "l2/03/1988".
    expect(findAnchors('l2/03/1988').map((a) => a.text)).toEqual([]);
    for (const t of TRUTH) expectSafe(readScannedLines(text(withCol(3, ['12/O3/1956', 'l2/03/1988', '1110/1977', '21/01/1949'])), true), t);
  });

  it('H6: month names, ISO and dotted dates are dates of birth', () => {
    allRight(readScan([boxes(withCol(3, ['12-Mar-1956', '30 July 1988', '1972-11-04', '21.01.1949']), XS)]));
    allRight(readScannedLines(text(withCol(3, ['12-Mar-1956', '30 July 1988', 'Nov 4, 1972', '21.01.1949']))));
  });

  it('H13: two lists side by side become two sets of rows, never one patient with another’s name', () => {
    const pair = [0, 1].map((i) => [...P[i].slice(0, 5), ...P[i + 2].slice(0, 5)]);
    const head = ['Time', 'MRN', 'Patient', 'DOB', 'Sex'];
    const xs = [30, 70, 125, 290, 360, 470, 510, 565, 730, 800];
    const more = pair.map((r) => r.map((c) => c.replace('H10', 'H50').replace('H09', 'H59').replace(', ', ', Ann ')));
    const r = readScan([boxes([[...head, ...head], ...pair, ...more], xs)]);
    expect(r.rows[0]).toEqual(head);
    const got = seen(r);
    expect(got).toHaveLength(8);
    expect(got.every((s) => !s.flagged)).toBe(true);
    for (const t of TRUTH) expect(got.map(who)).toContain(t);
  });

  it('M11: titles, letterheads and contact lines are not patients', () => {
    const top = [['Dr Brennan Cornea Clinic 10/11/2026'], ['Run date: 10/11/2026 07:55   User: KELLY, Mary'], ['Mr J Brennan   Ext 12345'], ['Royal Victoria Eye and Ear Hospital   10/11/2026']];
    const bottom = [['Location: Eye OPD   Room 4   Tel 0871234567'], ['Printed 08:02 11/11/2026']];
    for (const r of [readScan([boxes([...top, HEAD, ...P, ...bottom], XS)]), readScannedLines([...top.map((x) => x[0]), ...text(P), ...bottom.map((x) => x[0])])]) {
      allRight(r);
      expect(seen(r)).toHaveLength(4);
      expect(r.notUsed).toHaveLength(6);
    }
  });

  it('M12: a record printed over two lines is joined; a wrapped name is joined and flagged', () => {
    const above = readScannedLines(['SMITH, John', 'H100234   12/03/1956   M   09:00', 'JONES, Mary', 'H100235   01/02/1960   F   09:15', 'KELLY, Tom', 'H100236   05/06/1971   M   09:30']);
    expect(seen(above).map(who)).toEqual(['H100234|Smith|John|1956-03-12', 'H100235|Jones|Mary|1960-02-01', 'H100236|Kelly|Tom|1971-06-05']);
    const below = readScannedLines(['09:00   H100234   SMITH, John', '        DOB 12/03/1956   M   Review', '09:15   H100235   JONES, Mary', '        DOB 01/02/1960   F   New', '09:30   H100236   KELLY, Tom', '        DOB 05/06/1971   M   New']);
    expect(seen(below).map(who)).toEqual(['H100234|Smith|John|1956-03-12', 'H100235|Jones|Mary|1960-02-01', 'H100236|Kelly|Tom|1971-06-05']);
    // A name that wraps onto the next line, with positions to say which column it is in.
    const wrapped = readScan([boxes([["09:00", 'H100111', "FITZGERALD-O'SULLIVAN,", '12/03/1956', 'M', 'Review'], ['', '', 'Bartholomew'], ...P], XS)]);
    const first = seen(wrapped)[0];
    expect(first.cells[2]).toBe("FITZGERALD-O'SULLIVAN, Bartholomew");
    expect(first.flagged).toBe(true);
    // A wrapped appointment type is only more notes: joined, not flagged.
    const notes = readScan([boxes([P[0], ['', '', '', '', '', 'keratoplasty, Dr Kelly'], ...P.slice(1)], XS)]);
    expect(seen(notes)[0].cells[5]).toBe('Review - keratoconus keratoplasty, Dr Kelly');
    expect(seen(notes)[0].flagged).toBe(false);
    // Without positions there is no telling which column the second line continues: flagged.
    const loose = readScannedLines(["09:00   H100111   FITZGERALD-O'SULLIVAN,   12/03/1956   M   Review", '                  Bartholomew', ...text(P)]);
    expect(seen(loose)[0].flagged).toBe(true);
    allRight(loose);
  });

  it('M13: a phone number, an NHS number or a reference beside the hospital number is not taken for it', () => {
    const phone = P.map((r, i) => [...r, `087 123 456${i}`]);
    allRight(readScan([boxes(phone, [...XS, 640])]));
    allRight(readScannedLines(text(P.map((r, i) => [...r, `Tel 087123456${i}`]))));
    const nhs = P.map((r, i) => [r[0], `485 777 345${i}`, ...r.slice(1)]);
    allRight(readScan([boxes(nhs, [10, 60, 135, 220, 390, 480, 520])]));
    allRight(readScannedLines(text(nhs)));
    // With headings, the hospital number is chosen over the NHS number whichever comes first.
    const headed = readScan([boxes([['Time', 'NHS Number', 'Hospital No', 'Patient', 'DOB', 'Sex', 'Type'], ...nhs], [10, 60, 135, 220, 390, 480, 520])]);
    expect(headed.mapping[2]).toBe('mrn');
    allRight(headed);
    // Two columns of plain numbers with nothing to tell them apart: the user chooses.
    const twins = readScan([boxes(P.map((r, i) => [r[0], `77100${i}`, `88200${i}`, r[2], r[3]]), [10, 60, 135, 220, 390])]);
    expect(twins.mapping).not.toContain('mrn');
    expect(twins.warnings.join()).toMatch(/More than one column looks like a hospital number/);
  });

  it('M13: a hospital number OCR split in two is whole again, or flagged', () => {
    const rows = [...P, ['09:45', 'H102291', 'OKAFOR, Chidi', '15/09/1993', 'M', 'Review'], ['10:00', 'H099023', 'KAVANAGH, Siobhan', '08/05/1965', 'F', 'Review']];
    const split = withCol(1, ['H100234', 'H1 00877', 'H10153 2', 'H098812'], rows);
    const truth = [...TRUTH, 'H102291|Okafor|Chidi|1993-09-15', 'H099023|Kavanagh|Siobhan|1965-05-08'];
    const grid = readScan([boxes(split, XS, { ocr: true, perWord: true })]);
    expect(seen(grid).map((s) => s.record?.mrn?.replace(/\s/g, ''))).toEqual(rows.map((r) => r[1]));
    for (const t of truth) expectSafe(readScannedLines(text(split), true), t);
  });

  it('M15: ruling lines and bullets read as characters do not end up in a name unseen', () => {
    const ruled = readScan([boxes(withCol(2, ['| FITZGERALD, Eleanor |', "• O'SULLIVAN, Cian", '- NAKAMURA, Hana', 'I MURPHY, Declan I']), XS, { ocr: true })]);
    const rows = seen(ruled);
    expect(rows.slice(0, 3).map((s) => s.cells[2])).toEqual(['FITZGERALD, Eleanor', "O'SULLIVAN, Cian", 'NAKAMURA, Hana']);
    expect(rows[3].flagged).toBe(true);
    expect(rows[3].why.join()).toMatch(/ruling line/);
    for (const t of TRUTH) expectSafe(readScannedLines(['08:45 I H100234 I FITZGERALD, Eleanor I 12/03/1956 I F I Review', "09:00 | H100877 | O'SULLIVAN, Cian | 30/07/1988 | M | New", '- 09:15   H101532   NAKAMURA,  Hana   04/11/1972   F   Post-op', '09:30   H098812   - MURPHY, Declan   21/01/1949   M   Review'], true), t);
  });

  it('a garbled line inside the list is shown for checking, with what could be made of it', () => {
    const r = readScan([boxes([HEAD, P[0], P[1], ['oRes', 'i002', 'FITZ0ERALD. Bxeance', '120V19%6', 'F', 'Review'], P[2], P[3]], XS, { ocr: true, perWord: true })]);
    expect([r.clean, r.toCheck, r.unread]).toEqual([4, 1, 1]);
    expect(r.readings[3]?.source).toContain('FITZ0ERALD');
    allRight(r);
  });

  it('a later page with too few rows to find columns from uses the first page’s columns', () => {
    const r = readScan([boxes(P, XS), boxes([['09:45', 'H555555', 'OKAFOR, Chidi', '15/09/1993', 'M', 'Review']], XS, { page: 2 })]);
    expect(seen(r).map(who)).toEqual([...TRUTH, 'H555555|Okafor|Chidi|1993-09-15']);
    expect(r.rowsPerPage.get(2)).toBe(1);
  });

  it('a photo taken at a slight angle still reads row by row', () => {
    const page = boxes([HEAD, ...P], XS, { ocr: true, perWord: true });
    const skew = 0.035; // two degrees
    page.boxes = page.boxes!.map((b) => ({ ...b, y0: b.y0 + skew * b.x0, y1: b.y1 + skew * b.x0 }));
    allRight(readScan([{ ...page, skew }]));
  });

  it('low word confidence on a number, a date or a name flags the row', () => {
    const r = readScan([boxes([HEAD, ...P], XS, { ocr: true, conf: (row, col) => (row === 2 && col === 1 ? 55 : row === 3 && col === 3 ? 62 : 93) })]);
    const rows = seen(r);
    expect(rows.map((s) => s.flagged)).toEqual([false, true, true, false]);
    expect(rows[1].why.join()).toMatch(/hospital number was hard to read/);
    expect(rows[2].why.join()).toMatch(/date of birth was hard to read/);
  });

  it('counts are what the sheet will act on', () => {
    const r = readScan([boxes([HEAD, ...withCol(1, ['H100234', '', 'H101532', 'H098812'])], XS)]);
    expect(r.clean + r.toCheck).toBe(seen(r).length);
    expect(r.clean).toBe(seen(r).filter((s) => !s.flagged).length);
  });
});

/* ───────── hospital numbers ───────── */

describe('hospital numbers', () => {
  it('H4: a letter prefix is never changed, in print or from OCR', () => {
    const prefixes = ['S100234', 'B123456', 'O123456', 'D123456', 'Z123456', 'Q123456', 'I123456'];
    const multi = ['SB123456', 'BS123456', 'MB123456', 'GD123456'];
    for (const set of [prefixes, multi, ['HSE123456', 'HSE223456', 'HSE323456', 'HSE423456'], ['D-123456', 'D-223456', 'D-323456', 'D-423456']]) {
      const rows = set.map((m, i) => [`09:${10 + i}`, m, `SMITH${'ABCDEFG'[i]}, John`, `1${i}/03/1956`, 'M', 'Review']);
      for (const ocr of [false, true]) {
        const g = readScan([boxes(rows, XS, { ocr })]);
        expect(seen(g).map((s) => s.record?.mrn)).toEqual(set);
        expect(seen(readScannedLines(text(rows), ocr)).map((s) => s.record?.mrn)).toEqual(set);
      }
    }
    expect(repairMrn('S100234')).toBeUndefined();
    expect(repairMrn('S100234', { shape: 'A999999', example: 'H100234', share: 1 })).toBeUndefined();
  });

  it('H4: look-alikes are repaired only inside the digits, only for OCR, and every repair is flagged with what was printed', () => {
    const rows = [...P, ['09:45', 'H1OO291', 'OKAFOR, Chidi', '15/09/1993', 'M', 'Review'], ['10:00', 'HlO9023', 'KAVANAGH, Siobhan', '08/05/1965', 'F', 'Review']];
    const ocr = seen(readScan([boxes(rows, XS, { ocr: true })]));
    expect(ocr.map((s) => s.record?.mrn)).toEqual(['H100234', 'H100877', 'H101532', 'H098812', 'H100291', 'H109023']);
    expect(ocr.map((s) => s.flagged)).toEqual([false, false, false, false, true, true]);
    expect(ocr[4].why.join()).toMatch(/looked like “H1OO291” and was read as H100291/);
    // The same characters in a PDF's own text are what was printed: kept, and flagged as unlike the rest.
    const print = seen(readScan([boxes(rows, XS)]));
    expect(print[4].record?.mrn).toBe('H1OO291');
    expect(print[4].why.join()).toMatch(/isn’t shaped like the others/);
    // With no shape to go by, only a look-alike between digits is certain.
    expect(repairMrn('H1OO234')).toBe('H100234');
    expect(repairMrn('S1OO877')).toBe('S100877');
    expect(repairMrn('HlO2874')).toBeUndefined();
    expect(doubtfulMrn('HlO2874')).toBe(true);
    expect(doubtfulMrn('H100234')).toBe(false);
    expect(repairMrn('HlO2874', { shape: 'A999999', example: 'H100234', share: 1 })).toBe('H102874');
    expect(repairMrn('4100234', { shape: 'A999999', example: 'H100234', share: 1 })).toBeUndefined();
  });

  it('M16: a number unlike the rest is flagged; shapes Lumen does not know are kept as printed', () => {
    const rows = [...P, ['09:45', 'H10229', 'OKAFOR, Chidi', '15/09/1993', 'M', 'Review'], ['10:00', 'H099023A', 'KAVANAGH, Siobhan', '08/05/1965', 'F', 'Review']];
    const got = seen(readScan([boxes(rows, XS)]));
    expect(got.map((s) => s.flagged)).toEqual([false, false, false, false, true, true]);
    expect(got[4].why.join()).toMatch(/H10229 isn’t shaped like the others on this list \(for example H100234\)/);
    for (const set of [['IE1234567T', 'IE1234568T', 'IE1234569T', 'IE1234570T'], ['123-456-7890', '123-456-7891', '123-456-7892', '123-456-7893'], ['12/345678', '12/345679', '13/345680', '13/345681'], ['1234567T', '1234568W', '1234569T', '1234570W']]) {
      const r = readScan([boxes([HEAD, ...withCol(1, set)], XS)]);
      expect(seen(r).map((s) => s.record?.mrn)).toEqual(set);
      expect(seen(r).every((s) => !s.flagged)).toBe(true);
    }
  });

  it('two rows with one hospital number and different names are both flagged', () => {
    const got = seen(readScan([boxes(withCol(1, ['H100234', 'H100234', 'H101532', 'H098812']), XS)]));
    expect(got.map((s) => s.flagged)).toEqual([true, true, false, false]);
    expect(got[0].why.join()).toMatch(/same hospital number with a different name/);
  });
});

/* ───────── dates and times ───────── */

describe('dates of birth and times', () => {
  it('L2: a two-digit year that could be either century is flagged; impossible dates are refused', () => {
    expect(readBirthDate('12/03/56', 'DMY')).toEqual({ iso: '1956-03-12' });
    const young = readBirthDate('05/06/20', 'DMY');
    expect(young.iso).toBe('2020-06-05');
    expect(young.problem).toMatch(/could be 1920 or 2020/);
    expect(readBirthDate('12/03/1856', 'DMY').unusable).toBe(true);
    expect(readBirthDate('21/01/2149', 'DMY').unusable).toBe(true);
    expect(readBirthDate('31/04/1956', 'DMY').unusable).toBe(true);
    const got = seen(readScan([boxes(withCol(3, ['12/03/56', '05/06/20', '12/03/1856', '21/01/2149']), XS)]));
    expect(got.map((s) => s.flagged)).toEqual([false, true, true, true]);
    expect(got.map((s) => s.record?.dob)).toEqual(['1956-03-12', '2020-06-05', undefined, undefined]);
  });

  it('L1: the time comes from the time column; a decimal in the notes is not a time', () => {
    const rows = [['9.30', 'H100234', 'SMITH, John', '12/03/1956', 'VA 6.12'], ['09:30-09:45', 'H100235', 'BYRNE, Ann', '01/02/1960', 'IOP 21.50'], ['2pm', 'H100236', 'KELLY, Tom', '05/06/1971', 'K 7.80'], ['14:15', 'H100237', 'DOYLE, Pat', '07/08/1981', 'Fee 45.00']];
    for (const r of [readScan([boxes(rows, [40, 120, 200, 370, 460])]), readScannedLines(text(rows))]) expect(seen(r).map((s) => s.record?.time)).toEqual(['09:30', '09:30', '14:00', '14:15']);
    expect(readTime('09:30 - 09:45')).toBe('09:30');
    expect(findAnchors('IOP 21.50').filter((a) => a.kind === 'time')).toEqual([]);
  });
});
