import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseDelimited } from '../src/lib/csv';
import { inferDateOrder, parseDate, parseTime, ageFromDOB } from '../src/lib/dates';
import { applyMapping, detectMapping, guessMappingFromValues, looksLikeHeader } from '../src/lib/importers';
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
    expect(inferDateOrder(['01/02/1950', '25/02/1960'])).toBe('DMY');
    expect(inferDateOrder(['02/25/1960', '01/02/1950'])).toBe('MDY');
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

  it('guesses columns when there is no header row', () => {
    const rows = [
      ['09:00', 'H100234', 'SMITH, John', '12/03/1956'],
      ['09:15', 'H100877', 'BYRNE, Aoife', '30/07/1988'],
    ];
    expect(guessMappingFromValues(rows)).toEqual(['time', 'mrn', 'fullName', 'dob']);
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
});
