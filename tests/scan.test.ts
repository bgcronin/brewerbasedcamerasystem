import { describe, expect, it } from 'vitest';
import { fixDigits, parseScannedLine, parseScannedLines } from '../src/lib/importers/scanParse';

describe('scanned list parsing', () => {
  it('reads a typical printed row with wide gaps', () => {
    const r = parseScannedLine({ text: '08:45     H100234     FITZGERALD, Eleanor     12/03/1956     F     Review – keratoconus', confidence: 93 });
    expect(r).toMatchObject({ time: '08:45', mrn: 'H100234', name: 'FITZGERALD, Eleanor', dob: '1956-03-12', sex: 'F', rest: 'Review – keratoconus', flagged: false });
  });

  it('reads a row with single spaces and the sex stuck to the next column', () => {
    const r = parseScannedLine({ text: '10:30 H100456 DE LA CRUZ, Mateo 19/12/1958 M Pre-op cataract' });
    expect(r).toMatchObject({ mrn: 'H100456', name: 'DE LA CRUZ, Mateo', dob: '1958-12-19', sex: 'M' });
  });

  it('reads tab-separated PDF text', () => {
    const r = parseScannedLine({ text: '09:00\tH100877\tO’SULLIVAN, Cian\t30/07/1988\tM\tNew – red eye' });
    expect(r).toMatchObject({ mrn: 'H100877', name: 'O’SULLIVAN, Cian', dob: '1988-07-30' });
  });

  it('repairs digits OCR read as letters, and NHS numbers with spaces', () => {
    expect(fixDigits('H1OO877')).toBe('H100877');
    expect(fixDigits('HlO2874')).toBe('H102874');
    expect(fixDigits('Smith')).toBe('Smith');
    const r = parseScannedLine({ text: '123 456 7890  Smith John  01.02.1950' });
    expect(r).toMatchObject({ mrn: '123 456 7890', name: 'Smith John', dob: '1950-02-01' });
  });

  it('never mistakes a date of birth for a hospital number', () => {
    const r = parseScannedLine({ text: 'KELLY Tom   12/03/1956' });
    expect(r?.dob).toBe('1956-03-12');
    expect(r?.mrn).toBeUndefined();
    expect(r?.flagged).toBe(true);
  });

  it('drops titles, column headings and footers', () => {
    const { rows, parsed, skipped } = parseScannedLines([
      { text: 'Cornea Clinic – Ms Brennan' },
      { text: 'Tuesday 11 November 2026 - Outpatients Dept, Room 4 - Printed 08:02' },
      { text: 'Time   Hospital No   Patient   DOB   Sex   Appointment type' },
      { text: '08:45   H100234   FITZGERALD, Eleanor   12/03/1956   F   Review', confidence: 93 },
      { text: 'Page 1 of 1 - 12 patients - Confidential' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(skipped).toBe(4);
    expect(rows[0]).toEqual(['Time', 'Hospital No', 'Name', 'DOB', 'Sex', 'Notes']);
    expect(rows[1]).toEqual(['08:45', 'H100234', 'FITZGERALD, Eleanor', '1956-03-12', 'F', 'Review']);
  });

  it('flags low-confidence lines', () => {
    const r = parseScannedLine({ text: '09:15   H101532   NAKAMURA, Hana   04/11/1972   F', confidence: 60 });
    expect(r?.flagged).toBe(true);
  });
});
