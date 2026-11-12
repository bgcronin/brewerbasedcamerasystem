import { describe, expect, it } from 'vitest';
import { A4, LETTER, buildPdf, paperFor } from '../src/lib/pdf';
import { summaryRows } from '../src/lib/summary';

const JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAYACADASEAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5arpfCng/UNei+1eYtpZ7ioldSS/X7q9wDwTkfjgis8JhpYmoqcTpxWJjhqbnIseJvAuoaRaNe28631vGuZNqFXTrk7cnKjjnPfpgZrkqrGYSWFqcj18ycHi44qnzrTyCvWviJcalpvgLf4XB8tERGlhO5orbafnQ5z2X5uSASeMZHdlTap1XH4rK34nDmqTnSUtrv9Cl8FtQ1/UNCuH1dpp7ZZALS4mJLydd43E5YA4wT6kZ4wPPdZS3j1e9jsyptluJFhKtuGwMduD3GMc08xcpYalKe+v3f1YnLUo4irGG2n9fmVK7Twf45l0q2Sw1KKS6tU4jdCPMjXH3cH7wzjHIwM9eAOHA4t4WrzdOp347CLFUuXr0Lfib4hG6tGtdGgmtzIuGuJCA69chQM4PT5s+vGcGuAq8wxv1qomtEtiMBg/qtNp6t7n/2Q=='), (c) => c.charCodeAt(0));
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('PDF writer', () => {
  const pdf = buildPdf([{ jpeg: JPEG, width: 32, height: 24 }], { ...A4, title: 'O’BRIEN, Siobhán · Łukasz', created: new Date(2026, 10, 3, 14, 32, 5) });
  const text = latin1(pdf);

  it('starts and ends as a PDF must', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('has a cross-reference table whose every entry points at its object', () => {
    const xref = Number(text.match(/startxref\n(\d+)\n%%EOF/)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const count = Number(text.slice(xref).match(/^xref\n0 (\d+)\n/)![1]);
    const rows = text.slice(xref).split('\n').slice(2, 2 + count);
    expect(rows[0]).toBe('0000000000 65535 f ');
    for (let n = 1; n < count; n++) {
      const offset = Number(rows[n].slice(0, 10));
      expect(text.slice(offset, offset + `${n} 0 obj`.length), `object ${n}`).toBe(`${n} 0 obj`);
    }
    expect(text).toContain(`/Size ${count} /Root 1 0 R`);
  });

  it('embeds the JPEG untouched and says how long it is', () => {
    const at = text.indexOf('stream\n\xFF\xD8');
    expect(at).toBeGreaterThan(0);
    expect(Array.from(pdf.subarray(at + 7, at + 7 + JPEG.length))).toEqual(Array.from(JPEG));
    expect(text).toContain(`/Width 32 /Height 24 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${JPEG.length}`);
    expect(text.slice(at + 7 + JPEG.length, at + 7 + JPEG.length + 10)).toBe('\nendstream');
  });

  it('sizes the page as A4 and fills it with the picture', () => {
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('q 595.28 0 0 841.89 0 0 cm /Im0 Do Q');
  });

  it('keeps any character in the title', () => {
    // UTF-16 with a byte-order mark: Ł is 0141, the curly apostrophe 2019.
    expect(text).toMatch(/\/Title <FEFF[0-9A-F]*2019[0-9A-F]*0141[0-9A-F]*>/);
    expect(text).toContain('/CreationDate (D:20261103143205)');
  });

  it('writes several pages when asked', () => {
    const two = latin1(buildPdf([{ jpeg: JPEG, width: 32, height: 24 }, { jpeg: JPEG, width: 32, height: 24 }], LETTER));
    expect(two).toContain('/Kids [4 0 R 7 0 R] /Count 2');
    expect(two.match(/\/Type \/Page /g)).toHaveLength(2);
    expect(two).toContain('/MediaBox [0 0 612.00 792.00]');
  });

  it('chooses the paper people print on', () => {
    expect(paperFor('en-GB')).toBe(A4);
    expect(paperFor('en-IE')).toBe(A4);
    expect(paperFor('en-US')).toBe(LETTER);
    expect(paperFor('fr-CA')).toBe(LETTER);
    expect(paperFor('de')).toBe(A4);
  });
});

describe('summary page layout', () => {
  const p = (eye: 'OD' | 'OS' | 'OU', takenAt: number) => ({ id: `${eye}${takenAt}`, capture: { eye, takenAt } });
  const ids = (rows: ({ id: string } | null)[][]) => rows.map((r) => r.map((c) => c?.id ?? '-').join(' '));

  it('puts the right eye down the left column and the left eye down the right, like a chart', () => {
    expect(ids(summaryRows([p('OS', 1), p('OD', 2), p('OD', 3)]))).toEqual(['OD2 OS1', 'OD3 -']);
    expect(ids(summaryRows([p('OD', 1), p('OS', 2), p('OS', 3), p('OU', 4)]))).toEqual(['OD1 OS2', '- OS3', 'OU4 -']);
  });

  it('runs photographs of one eye across the page in the order taken', () => {
    expect(ids(summaryRows([p('OD', 3), p('OD', 1), p('OD', 2)]))).toEqual(['OD1 OD2', 'OD3 -']);
    expect(ids(summaryRows([p('OS', 1)]))).toEqual(['OS1 -']);
  });
});
