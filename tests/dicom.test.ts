import dicomParser from 'dicom-parser';
import { describe, expect, it } from 'vitest';
import { SOP_CLASS_VL_PHOTOGRAPHIC, TS_JPEG_BASELINE, buildDicom, dicomFileName, readJpegInfo, uidFor, type DicomPhoto } from '../src/lib/dicom';

/** A real 32 × 24 baseline JPEG (a blue disc on brown), and the same picture saved as a progressive JPEG. */
const JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAYACADASEAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5arpfCng/UNei+1eYtpZ7ioldSS/X7q9wDwTkfjgis8JhpYmoqcTpxWJjhqbnIseJvAuoaRaNe28631vGuZNqFXTrk7cnKjjnPfpgZrkqrGYSWFqcj18ycHi44qnzrTyCvWviJcalpvgLf4XB8tERGlhO5orbafnQ5z2X5uSASeMZHdlTap1XH4rK34nDmqTnSUtrv9Cl8FtQ1/UNCuH1dpp7ZZALS4mJLydd43E5YA4wT6kZ4wPPdZS3j1e9jsyptluJFhKtuGwMduD3GMc08xcpYalKe+v3f1YnLUo4irGG2n9fmVK7Twf45l0q2Sw1KKS6tU4jdCPMjXH3cH7wzjHIwM9eAOHA4t4WrzdOp347CLFUuXr0Lfib4hG6tGtdGgmtzIuGuJCA69chQM4PT5s+vGcGuAq8wxv1qomtEtiMBg/qtNp6t7n/2Q=='), (c) => c.charCodeAt(0));
const PROGRESSIVE = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wgARCAAYACADASIAAhEBAxEB/8QAGAAAAwEBAAAAAAAAAAAAAAAAAAUGAwf/xAAXAQEBAQEAAAAAAAAAAAAAAAABAwAC/9oADAMBAAIQAxAAAAHljNZW9ZSop55MXQQvtPgn/8QAGxAAAgIDAQAAAAAAAAAAAAAAAwQAAgEFEhD/2gAIAQEAAQUCiqZD4ZRIKvmxsQaGlIcgDc4LE3siqzsOqz//xAAaEQADAQEBAQAAAAAAAAAAAAABAgMAEUEE/9oACAEDAQE/AfooU4F90KMxKt5nmrjh05rMcXf/xAAaEQADAQEBAQAAAAAAAAAAAAABAgMAEUEE/9oACAECAQE/AfnmG6W815qAGX3JRkPV1KNQ9bf/xAAiEAACAQIFBQAAAAAAAAAAAAABAhIAEQMQMUFREyIkMkL/2gAIAQEABj8CqV4pzU1M1Gufi6cjZabq3K37WO9OE9ZG2UMQFl25FRwQVv8ARy//xAAgEAACAQQBBQAAAAAAAAAAAAABESEAEDFRcUFhgaHR/9oACAEBAAE/IaiU5MM8CjsETAIjxq7NgABlKMj1NEgxtrtPWgRCAUuHFgAZ5DBrvT9WTkHH23//2gAMAwEAAgADAAAAELUfnv/EABkRAAIDAQAAAAAAAAAAAAAAAAABESFBUf/aAAgBAwEBPxBNSeuF4T0RJlEID//EABoRAAMAAwEAAAAAAAAAAAAAAAABESExQVH/2gAIAQIBAT8Q26XHpjfXDLKjKgp//8QAHRABAQEBAAIDAQAAAAAAAAAAAREhMRBBAFFxgf/aAAgBAQABPxD52Igcvf6A4tP7E+Uagp666aM2++QvmBmvWm3t9exBXJQqzBi9ppoGRftLkHMTBBKw+yTfGP0VmD0eLJpC9wEUyCA7UBY86+8sfH//2Q=='), (c) => c.charCodeAt(0));

const photo = (over: Partial<DicomPhoto> = {}): DicomPhoto => ({
  patient: { mrn: 'H100234', firstName: 'Siobhán', lastName: "O'Brien", dob: '1956-03-12', sex: 'F' },
  visit: { id: 'visit-1', date: '2026-11-03', time: '08:45', clinician: 'Ms Brennan' },
  capture: { id: 'cap-1', eye: 'OS', technique: 'slit', takenAt: new Date(2026, 10, 3, 14, 32, 5).getTime(), note: 'Vogt striae', diagnoses: ['Keratoconus'], deviceLabel: 'Canon EOS 60D' },
  jpeg: JPEG,
  instanceNumber: 3,
  clinicName: 'Cornea Clinic',
  ...over,
});

/** Parse with an independent DICOM reader: if it can read the file back, so can a PACS. */
const parse = async (p: DicomPhoto) => {
  const bytes = await buildDicom(p);
  return { bytes, ds: dicomParser.parseDicom(bytes) };
};
const utf8 = (ds: dicomParser.DataSet, tag: string) => {
  const e = ds.elements[tag];
  return new TextDecoder().decode(ds.byteArray.subarray(e.dataOffset, e.dataOffset + e.length)).replace(/[\0 ]+$/, '');
};

describe('DICOM export', () => {
  it('writes a file an independent DICOM reader accepts', async () => {
    const { bytes, ds } = await parse(photo());
    expect(new TextDecoder().decode(bytes.subarray(128, 132))).toBe('DICM');
    expect(ds.string('x00020002')).toBe(SOP_CLASS_VL_PHOTOGRAPHIC);
    expect(ds.string('x00020010')).toBe(TS_JPEG_BASELINE);
    expect(ds.string('x00080016')).toBe(SOP_CLASS_VL_PHOTOGRAPHIC);
    expect(ds.string('x00020003')).toBe(ds.string('x00080018'));
    expect(ds.string('x00080060')).toBe('XC');
    // The group length says exactly how long the file's heading is.
    const metaEnd = ds.elements.x00020013.dataOffset + ds.elements.x00020013.length;
    expect(ds.uint32('x00020000')).toBe(metaEnd - (ds.elements.x00020000.dataOffset + 4));
  });

  it('carries the patient, the visit and the eye', async () => {
    const { ds } = await parse(photo());
    expect(utf8(ds, 'x00100010')).toBe("O'Brien^Siobhán"); // accents survive (the file declares UTF-8)
    expect(ds.string('x00080005')).toBe('ISO_IR 192');
    expect(ds.string('x00100020')).toBe('H100234');
    expect(ds.string('x00100030')).toBe('19560312');
    expect(ds.string('x00100040')).toBe('F');
    expect(ds.string('x00080020')).toBe('20261103');
    expect(ds.string('x00080030')).toBe('084500');
    expect(ds.string('x00080022')).toBe('20261103');
    expect(ds.string('x00080032')).toBe('143205');
    expect(ds.string('x00200062')).toBe('L'); // OS
    expect(ds.string('x00200013')).toBe('3');
    expect(ds.string('x00080080')).toBe('Cornea Clinic');
    expect(ds.string('x00081090')).toBe('Canon EOS 60D');
    expect(ds.string('x00080070')).toBe('Canon');
    expect(utf8(ds, 'x00204000')).toBe('Slit beam. Keratoconus. Vogt striae');
    expect(ds.string('x00080008')).toBe('ORIGINAL\\PRIMARY');
    expect(ds.string('x00280301')).toBe('NO');
    const region = ds.elements.x00082218.items![0].dataSet!;
    expect([region.string('x00080100'), region.string('x00080102'), region.string('x00080104')]).toEqual(['81745001', 'SCT', 'Eye']);
    expect((await parse(photo({ capture: { ...photo().capture, eye: 'OD' } }))).ds.string('x00200062')).toBe('R');
    expect((await parse(photo({ capture: { ...photo().capture, eye: 'OU' } }))).ds.string('x00200062')).toBe('B');
  });

  it('describes the picture as the JPEG really is, and stores it untouched', async () => {
    const { ds } = await parse(photo());
    expect(ds.uint16('x00280010')).toBe(24); // rows
    expect(ds.uint16('x00280011')).toBe(32); // columns
    expect(ds.uint16('x00280002')).toBe(3);
    expect(ds.string('x00280004')).toBe('YBR_FULL_422');
    expect([ds.uint16('x00280100'), ds.uint16('x00280101'), ds.uint16('x00280102'), ds.uint16('x00280103')]).toEqual([8, 8, 7, 0]);
    expect(ds.string('x00282110')).toBe('01');
    const pixels = ds.elements.x7fe00010;
    expect(pixels.encapsulatedPixelData).toBe(true);
    expect(pixels.fragments).toHaveLength(1);
    const frame = dicomParser.readEncapsulatedPixelDataFromFragments(ds, pixels, 0, 1);
    expect(Array.from(frame.subarray(0, JPEG.length))).toEqual(Array.from(JPEG));
    expect(frame.length % 2).toBe(0); // padded to an even length, as DICOM requires
  });

  it('lists its elements in ascending order with even lengths', async () => {
    const { ds } = await parse(photo());
    // In the order they sit in the file:
    const tags = Object.keys(ds.elements).sort((a, b) => ds.elements[a].dataOffset - ds.elements[b].dataOffset);
    expect(tags).toEqual([...tags].sort());
    for (const t of tags) if (t !== 'x7fe00010') expect(ds.elements[t].length % 2, t).toBe(0);
  });

  it('gives the same photo the same identifiers every time, and different photos different ones', async () => {
    const a = (await parse(photo())).ds;
    const again = (await parse(photo())).ds;
    const other = (await parse(photo({ capture: { ...photo().capture, id: 'cap-2' }, instanceNumber: 4 }))).ds;
    expect(again.string('x00080018')).toBe(a.string('x00080018'));
    expect(other.string('x00080018')).not.toBe(a.string('x00080018'));
    // Photos of one visit belong to one study and one series.
    expect(other.string('x0020000d')).toBe(a.string('x0020000d'));
    expect(other.string('x0020000e')).toBe(a.string('x0020000e'));
    expect((await parse(photo({ visit: { ...photo().visit, id: 'visit-2' } }))).ds.string('x0020000d')).not.toBe(a.string('x0020000d'));
    for (const tag of ['x00080018', 'x0020000d', 'x0020000e']) expect(a.string(tag)).toMatch(/^2\.25\.[1-9]\d{0,38}$/);
    expect(await uidFor('image', 'x')).toBe(await uidFor('image', 'x'));
  });

  it('marks the annotated copy as a derived image with the marks burned in', async () => {
    const original = (await parse(photo())).ds;
    const marked = (await parse(photo({ annotated: true }))).ds;
    expect(marked.string('x00080008')).toBe('DERIVED\\SECONDARY');
    expect(marked.string('x00280301')).toBe('YES');
    expect(marked.string('x00080018')).not.toBe(original.string('x00080018'));
    expect(marked.string('x0020000d')).toBe(original.string('x0020000d'));
  });

  it('copes with missing details and awkward text', async () => {
    const { ds } = await parse(
      photo({
        patient: { mrn: '', firstName: 'A\\B', lastName: 'x'.repeat(90), dob: undefined, sex: '' },
        visit: { id: 'v', date: '2026-11-03' },
        capture: { id: 'c', eye: 'OD', takenAt: Date.now() },
        clinicName: undefined,
      }),
    );
    // Present but empty, as the standard asks for details that are not known.
    for (const tag of ['x00100020', 'x00100030', 'x00100040', 'x00080030']) expect(ds.elements[tag]?.length, tag).toBe(0);
    expect(ds.elements.x00080080).toBeUndefined();
    expect(utf8(ds, 'x00100010').length).toBeLessThanOrEqual(64);
    expect(utf8(ds, 'x00100010')).not.toContain('\\'); // a backslash would split the name in two
  });

  it('refuses a progressive JPEG, which DICOM cannot hold, rather than write a file a PACS would reject', async () => {
    expect(readJpegInfo(JPEG)).toMatchObject({ width: 32, height: 24, components: 3, frame: 0xc0, precision: 8 });
    expect(readJpegInfo(PROGRESSIVE).frame).toBe(0xc2);
    await expect(buildDicom(photo({ jpeg: PROGRESSIVE }))).rejects.toThrow(/progressive/);
    await expect(buildDicom(photo({ jpeg: new Uint8Array([1, 2, 3, 4]) }))).rejects.toThrow(/Not a JPEG/);
  });

  it('names the file after the photo', () => {
    const taken = new Date(2026, 10, 3, 14, 32, 5).getTime();
    expect(dicomFileName({ mrn: 'H 100/234', lastName: 'Smith' }, { takenAt: taken, eye: 'OD', technique: 'slit' })).toBe('H100234_20261103_143205_OD_slit.dcm');
    expect(dicomFileName({ mrn: '', lastName: "O'Brien" }, { takenAt: taken, eye: 'OS' }, true)).toBe('OBrien_20261103_143205_OS_annotated.dcm');
  });
});
