import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseDelimited } from '../src/lib/csv';
import { inferDateOrder, inferDateOrderDetailed, parseDate, parseTime, ageFromDOB } from '../src/lib/dates';
import { applyMapping, detectMapping, guessMappingFromValues, looksLikeHeader, readText } from '../src/lib/importers';
import { displayName, normaliseSex, splitFullName, titleCase } from '../src/lib/names';

describe('csv', () => {
  it('parses quoted fields, embedded commas, newlines and escaped quotes', () => {
    const rows = parseDelimited('a,b,c\n"Smith, John","line1\nline2","say ""hi"""\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['Smith, John', 'line1\nline2', 'say "hi"'],
    ]);
  });

  it('strips a BOM, handles CRLF and drops blank lines', () => {
    expect(parseDelimited('﻿x,y\r\n1,2\r\n\r\n,\r\n')).toEqual([
      ['x', 'y'],
      ['1', '2'],
    ]);
  });

  it('detects semicolons and tabs', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('Name\tMRN\tDOB\nSmith, J\t123\t01/02/1950')).toBe('\t');
    expect(detectDelimiter('"Smith; J",1,2\n"Jones; K",3,4')).toBe(',');
  });

  it('prefers a tab over a comma when both appear once per line (Excel paste)', () => {
    expect(detectDelimiter('SMITH, John\t12/03/1956')).toBe('\t');
    expect(parseDelimited('SMITH, John\t12/03/1956\nBYRNE, Aoife\t30/07/1988')).toEqual([
      ['SMITH, John', '12/03/1956'],
      ['BYRNE, Aoife', '30/07/1988'],
    ]);
  });
});

describe('dates', () => {
  it('parses common formats', () => {
    expect(parseDate('1956-03-12')).toBe('1956-03-12');
    expect(parseDate('12/03/1956', 'DMY')).toBe('1956-03-12');
    expect(parseDate('03/12/1956', 'MDY')).toBe('1956-03-12');
    expect(parseDate('12-Mar-1956')).toBe('1956-03-12');
    expect(parseDate('12 March 1956')).toBe('1956-03-12');
    expect(parseDate('March 12, 1956')).toBe('1956-03-12');
    expect(parseDate('19560312')).toBe('1956-03-12');
    expect(parseDate('12.03.1956')).toBe('1956-03-12');
    expect(parseDate('not a date')).toBeUndefined();
    expect(parseDate('31/02/2000')).toBeUndefined();
  });

  it('recovers when one value contradicts the chosen order', () => {
    expect(parseDate('25/12/1960', 'MDY')).toBe('1960-12-25');
  });

  it('puts two-digit birth years in the past', () => {
    const yy = String((new Date().getFullYear() + 5) % 100).padStart(2, '0');
    expect(parseDate(`01/01/${yy}`, 'DMY', true)?.startsWith('19')).toBe(true);
  });

  it('infers day/month order from the data', () => {
    expect(inferDateOrder(['01/02/1950', '25/02/1960'], 'MDY')).toBe('DMY');
    expect(inferDateOrder(['02/25/1960', '01/02/1950'], 'DMY')).toBe('MDY');
  });

  it('falls back to day-first when no value decides, unless told otherwise', () => {
    expect(inferDateOrder(['01/02/1950', '03/04/1960'])).toBe('DMY');
    expect(inferDateOrder(['01/02/1950'], 'MDY')).toBe('MDY');
    expect(inferDateOrder([])).toBe('DMY');
    expect(inferDateOrderDetailed(['01/02/1950', '25/02/1960'])).toEqual({ order: 'DMY', votes: { dmy: 1, mdy: 0 } });
    expect(inferDateOrderDetailed(['01/02/1950']).votes).toEqual({ dmy: 0, mdy: 0 });
  });

  it('treats a bare four-digit value as a year, not an Excel serial', () => {
    expect(parseDate('1956', 'DMY', true)).toBeUndefined();
    expect(parseDate('2026')).toBeUndefined();
    expect(parseDate('1234', 'DMY', true)).toBe('1903-05-18');
    expect(parseDate('1234')).toBeUndefined();
    expect(parseDate('44927')).toBe('2023-01-01');
  });

  it('parses times', () => {
    expect(parseTime('9:30')).toBe('09:30');
    expect(parseTime('09.30')).toBe('09:30');
    expect(parseTime('0930')).toBe('09:30');
    expect(parseTime('2:15 pm')).toBe('14:15');
    expect(parseTime('12:05am')).toBe('00:05');
    expect(parseTime('14:15:00')).toBe('14:15');
    expect(parseTime('03/11/2026 10:45')).toBe('10:45');
    expect(parseTime('2026-11-03T08:00:00')).toBe('08:00');
    expect(parseTime('9')).toBeUndefined();
    expect(parseTime('25:00')).toBeUndefined();
  });

  it('computes age', () => {
    expect(ageFromDOB('1956-03-12', new Date(2026, 10, 3))).toBe(70);
    expect(ageFromDOB('1956-12-12', new Date(2026, 10, 3))).toBe(69);
  });
});

describe('names', () => {
  it('splits full names in clinic formats', () => {
    expect(splitFullName('SMITH, John')).toEqual({ lastName: 'Smith', firstName: 'John' });
    expect(splitFullName('Mr John Smith')).toEqual({ firstName: 'John', lastName: 'Smith' });
    expect(splitFullName("O'BRIEN Mary")).toEqual({ lastName: "O'Brien", firstName: 'Mary' });
    expect(splitFullName('Anne-Marie van der Berg')).toEqual({ firstName: 'Anne-Marie', lastName: 'van der Berg' });
    expect(splitFullName('MCDONALD, SEAN (Mr)')).toEqual({ lastName: 'McDonald', firstName: 'Sean' });
  });

  it('reads two all-caps tokens as surname first', () => {
    expect(splitFullName('SMITH JOHN')).toEqual({ lastName: 'Smith', firstName: 'John' });
    expect(splitFullName('JOHN PAUL SMITH')).toEqual({ firstName: 'John Paul', lastName: 'Smith' });
    expect(splitFullName('Smith')).toEqual({ firstName: '', lastName: 'Smith' });
  });

  it('drops a trailing title after a comma', () => {
    expect(splitFullName('Smith, John, Mr')).toEqual({ lastName: 'Smith', firstName: 'John' });
    expect(splitFullName('SMITH, JOHN, MRS.')).toEqual({ lastName: 'Smith', firstName: 'John' });
    expect(splitFullName('SMITH, J.')).toEqual({ lastName: 'Smith', firstName: 'J.' });
  });

  it('title-cases and displays names clinically', () => {
    expect(titleCase('MARY-KATE')).toBe('Mary-Kate');
    expect(displayName({ firstName: 'John', lastName: 'Smith' })).toBe('SMITH, John');
  });

  it('normalises sex', () => {
    expect(normaliseSex('Male')).toBe('M');
    expect(normaliseSex('f')).toBe('F');
    expect(normaliseSex('')).toBe('');
  });
});

describe('column mapping', () => {
  it('maps typical PAS export headers', () => {
    const headers = ['Appt Time', 'Hospital No.', 'Surname', 'Forename', 'D.O.B.', 'Sex', 'Clinic', 'Consultant', 'Appointment Type'];
    expect(looksLikeHeader(headers)).toBe(true);
    expect(detectMapping(headers)).toEqual(['time', 'mrn', 'lastName', 'firstName', 'dob', 'sex', 'clinic', 'clinician', 'reason']);
  });

  it('maps a single name column and appointment date', () => {
    expect(detectMapping(['Patient Name', 'Patient ID', 'Date of Birth', 'Appointment Date', 'Time'])).toEqual([
      'fullName', 'mrn', 'dob', 'date', 'time',
    ]);
  });

  it('does not mistake data for a header', () => {
    expect(looksLikeHeader(['09:00', 'MRN100234', 'Smith, John', '12/03/1956'])).toBe(false);
  });

  it('does not read "Last Visit" as a surname column', () => {
    expect(detectMapping(['Last Visit', 'Name', 'Hospital No'])).toEqual(['ignore', 'fullName', 'mrn']);
    expect(detectMapping(['Last Seen', 'First Attended', 'Surname', 'First Name'])).toEqual(['ignore', 'ignore', 'lastName', 'firstName']);
  });

  it('guesses columns when there is no header row', () => {
    const rows = [
      ['09:00', 'H100234', 'SMITH, John', '12/03/1956'],
      ['09:15', 'H100877', 'BYRNE, Aoife', '30/07/1988'],
    ];
    expect(guessMappingFromValues(rows)).toEqual(['time', 'mrn', 'fullName', 'dob']);
  });

  it('guesses bare-number MRNs and split name columns without a header row', () => {
    expect(guessMappingFromValues([
      ['10234', 'SMITH', 'John', '12/03/1956'],
      ['10877', 'BYRNE', 'Aoife', '30/07/1988'],
    ])).toEqual(['mrn', 'lastName', 'firstName', 'dob']);
    expect(guessMappingFromValues([
      ['John', 'Smith', '20261103'],
      ['Aoife', 'Byrne', '20261104'],
    ])).toEqual(['firstName', 'lastName', 'mrn']);
  });

  it('gives the older of two date columns to date of birth', () => {
    expect(guessMappingFromValues([
      ['03/11/2026', 'SMITH, John', '12/03/1956'],
      ['03/11/2026', 'BYRNE, Aoife', '30/07/1988'],
    ])).toEqual(['date', 'fullName', 'dob']);
  });

  it('turns rows into records', () => {
    const { records, skipped, dateOrder } = applyMapping(
      [
        ['09:00', 'H100234', 'SMITH, John', '12/03/1956', 'M'],
        ['', '', '', '', ''],
        ['2:30 pm', 'H100877', 'Aoife Byrne', '30/07/1988', 'F'],
      ],
      ['time', 'mrn', 'fullName', 'dob', 'sex'],
      'auto',
    );
    expect(skipped).toBe(1);
    expect(dateOrder).toBe('DMY');
    expect(records[0]).toMatchObject({ mrn: 'H100234', lastName: 'Smith', firstName: 'John', dob: '1956-03-12', time: '09:00', sex: 'M' });
    expect(records[1]).toMatchObject({ lastName: 'Byrne', firstName: 'Aoife', dob: '1988-07-30', time: '14:30', sex: 'F' });
  });

  it('flags an ambiguous day/month order and assumes day first', () => {
    const rows = [['SMITH, John', '01/02/1950'], ['BYRNE, Aoife', '03/04/1988']];
    const auto = applyMapping(rows, ['fullName', 'dob'], 'auto');
    expect(auto.dateOrder).toBe('DMY');
    expect(auto.dateOrderAmbiguous).toBe(true);
    expect(auto.records[0].dob).toBe('1950-02-01');
    expect(applyMapping(rows, ['fullName', 'dob'], 'MDY')).toMatchObject({ dateOrderAmbiguous: false, dateOrder: 'MDY' });
    expect(applyMapping([['SMITH, John', '25/02/1950']], ['fullName', 'dob'], 'auto').dateOrderAmbiguous).toBe(false);
    expect(applyMapping([['SMITH, John', '1950-02-25']], ['fullName', 'dob'], 'auto').dateOrderAmbiguous).toBe(false);
  });
});

describe('file decoding', () => {
  const utf16le = (text: string, bom = true) => {
    const units = [...(bom ? '\ufeff' : ''), ...text].map((c) => c.charCodeAt(0));
    return new Uint8Array(units.flatMap((u) => [u & 0xff, u >> 8]));
  };
  const file = (bytes: Uint8Array<ArrayBuffer>) => new File([bytes], 'list.csv', { type: 'text/csv' });

  it('decodes UTF-16LE with a BOM', async () => {
    expect(await readText(file(utf16le('Name,DOB\nSMITH, John,12/03/1956')))).toBe('Name,DOB\nSMITH, John,12/03/1956');
  });

  it('decodes UTF-16 without a BOM and big-endian with one', async () => {
    expect(await readText(file(utf16le('Name\tDOB\nSMITH\t12/03/1956', false)))).toBe('Name\tDOB\nSMITH\t12/03/1956');
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x2c, 0x00, 0x42]);
    expect(await readText(file(be))).toBe('A,B');
  });

  it('still reads UTF-8 and falls back to Windows-1252', async () => {
    expect(await readText(file(new TextEncoder().encode('Ó Briain,1')))).toBe('Ó Briain,1');
    expect(await readText(file(new Uint8Array([0xd3, 0x20, 0x42, 0x72, 0x69, 0x61, 0x69, 0x6e])))).toBe('Ó Briain');
  });
});
