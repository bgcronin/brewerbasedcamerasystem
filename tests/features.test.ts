import { describe, expect, it } from 'vitest';
import { annotatedName, arrowHead, isTrivial, metrics, simplify } from '../src/lib/annotations';
import { addDiagnosis, canonicalDiagnosis, fold, hasDiagnosis, removeDiagnosis, sameDiagnosis, suggestDiagnoses } from '../src/lib/diagnoses';
import { EMPTY_QUERY, diagnosisCounts, groupByPatient, searchCaptures } from '../src/lib/search';
import type { Capture, Patient } from '../src/lib/types';

describe('diagnosis labels', () => {
  it('finds a diagnosis by abbreviation, part of a word, or either spelling', () => {
    expect(suggestDiagnoses('kc')[0]).toBe('Keratoconus');
    expect(suggestDiagnoses('hsk')[0]).toBe('Herpes simplex keratitis');
    expect(suggestDiagnoses('pteryg')[0]).toBe('Pterygium');
    expect(suggestDiagnoses('corneal edema')[0]).toBe('Corneal oedema');
    expect(suggestDiagnoses('corneal oedema')[0]).toBe('Corneal oedema');
    expect(suggestDiagnoses('fuchs')[0]).toBe('Fuchs endothelial dystrophy');
    expect(suggestDiagnoses('ulcer')).toContain('Microbial keratitis');
  });

  it('offers nothing until something is typed, except recent and earlier labels', () => {
    expect(suggestDiagnoses('')).toEqual([]);
    expect(suggestDiagnoses('', { preferred: ['Pterygium', 'Odd looking thing'] })).toEqual(['Pterygium', 'Odd looking thing']);
  });

  it('puts the patient’s earlier and recent labels first, and never repeats one already chosen', () => {
    const list = suggestDiagnoses('kerat', { preferred: ['Marginal keratitis'], exclude: ['Keratoconus'] });
    expect(list[0]).toBe('Marginal keratitis');
    expect(list).not.toContain('Keratoconus');
    // A label typed by hand earlier is suggested again.
    expect(suggestDiagnoses('odd', { preferred: ['Odd looking thing'] })).toEqual(['Odd looking thing']);
  });

  it('tidies hand-typed labels without changing what was meant', () => {
    expect(canonicalDiagnosis('  keratoconus ')).toBe('Keratoconus');
    expect(canonicalDiagnosis('odd   looking thing')).toBe('Odd looking thing');
    // An abbreviation is kept as typed: "KC" is not silently rewritten.
    expect(canonicalDiagnosis('KC')).toBe('KC');
    expect(canonicalDiagnosis('')).toBe('');
  });

  it('treats spelling and accent variants as the same label', () => {
    expect(sameDiagnosis('Corneal oedema', 'corneal edema')).toBe(true);
    expect(sameDiagnosis('Conjunctival naevus', 'conjunctival nevus')).toBe(true);
    expect(fold('Sjögren’s  syndrome')).toBe('sjogrens syndrome');
    const list = addDiagnosis(['Corneal oedema'], 'corneal edema');
    expect(list).toEqual(['Corneal oedema']);
    expect(hasDiagnosis(list, 'CORNEAL EDEMA')).toBe(true);
    expect(removeDiagnosis(list, 'corneal edema')).toEqual([]);
    expect(addDiagnosis(undefined, 'pterygium')).toEqual(['Pterygium']);
  });
});

function capture(over: Partial<Capture>): Capture {
  return {
    id: Math.random().toString(36).slice(2),
    patientId: 'p1',
    visitId: 'v1',
    date: '2026-11-03',
    eye: 'OD',
    takenAt: new Date('2026-11-03T10:00:00').getTime(),
    width: 100,
    height: 100,
    mime: 'image/webp',
    bytes: 1,
    fileName: 'x.webp',
    source: 'live',
    ...over,
  };
}

describe('library search', () => {
  const patients = new Map<string, Patient>([
    ['p1', { id: 'p1', mrn: 'H100234', firstName: 'Eleanor', lastName: 'Fitzgerald', createdAt: 0, updatedAt: 0 }],
    ['p2', { id: 'p2', mrn: 'H 200 877', firstName: 'Cian', lastName: "O'Sullivan", createdAt: 0, updatedAt: 0 }],
  ]);
  const a = capture({ id: 'a', diagnoses: ['Keratoconus'], technique: 'slit', note: 'Vogt striae seen' });
  const b = capture({ id: 'b', eye: 'OS', diagnoses: ['Keratoconus'], starred: true, takenAt: new Date('2026-11-03T10:05:00').getTime() });
  const c = capture({
    id: 'c',
    patientId: 'p2',
    visitId: 'v2',
    date: '2025-06-20',
    takenAt: new Date('2025-06-20T09:00:00').getTime(),
    diagnoses: ['Corneal oedema', 'Odd looking thing'],
    annotations: [{ id: 'm', kind: 'ellipse', color: '#fff', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 }],
  });
  const d = capture({ id: 'd', patientId: 'p2', visitId: 'v3', eye: 'OU', date: '2026-01-15', takenAt: new Date('2026-01-15T09:00:00').getTime() });
  const all = [a, b, c, d];
  const find = (text: string, more: Partial<typeof EMPTY_QUERY> = {}) =>
    searchCaptures(all, patients, { ...EMPTY_QUERY, text, ...more })
      .map((x) => x.id)
      .sort()
      .join('');

  it('finds photos by diagnosis, including abbreviations and the other spelling', () => {
    expect(find('keratoconus')).toBe('ab');
    expect(find('kerato')).toBe('ab');
    expect(find('kc')).toBe('ab');
    expect(find('edema')).toBe('c');
    expect(find('oedema')).toBe('c');
    expect(find('odd look')).toBe('c');
  });

  it('finds photos by patient name and hospital number', () => {
    expect(find('fitz')).toBe('ab');
    // An apostrophe in a name never gets in the way.
    expect(find('osullivan')).toBe('cd');
    expect(find("o'sullivan")).toBe('cd');
    expect(find('sullivan')).toBe('cd');
    expect(find('H100234')).toBe('ab');
    expect(find('0234')).toBe('ab'); // part of a number matches anywhere in it
    expect(find('200877')).toBe('cd'); // spaces in the stored number do not matter
  });

  it('needs every word to match, and matches words from their start', () => {
    expect(find('fitz keratoconus')).toBe('ab');
    expect(find('fitz oedema')).toBe('');
    expect(find('conus')).toBe(''); // not the start of a word
    expect(find('vogt')).toBe('a');
    expect(find('slit')).toBe('a');
  });

  it('finds photos by date words', () => {
    expect(find('2025')).toBe('c');
    expect(find('june')).toBe('c');
    expect(find('sullivan 2026')).toBe('d');
  });

  it('applies the filters', () => {
    expect(find('', { starred: true })).toBe('b');
    expect(find('', { annotated: true })).toBe('c');
    expect(find('', { eye: 'OS' })).toBe('bd'); // a both-eyes photo shows under either eye
    expect(find('', { eye: 'OD' })).toBe('acd');
    expect(find('', { period: '2025' })).toBe('c');
    expect(find('', { diagnosis: 'corneal edema' })).toBe('c');
    expect(find('', { diagnosis: 'Keratoconus', eye: 'OS' })).toBe('b');
    expect(find('')).toBe('abcd');
  });

  it('counts diagnoses by patient and groups results by patient, newest first', () => {
    const counts = diagnosisCounts(all);
    expect(counts.find((k) => k.name === 'Keratoconus')).toMatchObject({ photos: 2, patients: 1 });
    expect(counts.find((k) => k.name === 'Corneal oedema')).toMatchObject({ photos: 1, patients: 1 });
    const groups = groupByPatient(searchCaptures(all, patients, EMPTY_QUERY));
    expect(groups.map((g) => g.patientId)).toEqual(['p1', 'p2']);
    expect(groups[0].captures.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('annotations', () => {
  it('names the annotated copy after its original', () => {
    expect(annotatedName('H100234_20261103_143205_OD_slit.webp')).toBe('H100234_20261103_143205_OD_slit_annotated.webp');
    expect(annotatedName('photo')).toBe('photo_annotated');
  });

  it('scales line weight and text with the photo', () => {
    const small = metrics(1280, 720);
    const large = metrics(5184, 3456);
    expect(large.stroke / small.stroke).toBeCloseTo(5184 / 1280);
    expect(large.halo).toBeGreaterThan(large.stroke);
    expect(large.font).toBeGreaterThan(large.stroke * 5);
  });

  it('ignores stray clicks but keeps deliberate marks', () => {
    expect(isTrivial({ id: '1', kind: 'ellipse', color: '#fff', cx: 0.5, cy: 0.5, rx: 0.001, ry: 0.001 })).toBe(true);
    expect(isTrivial({ id: '1', kind: 'ellipse', color: '#fff', cx: 0.5, cy: 0.5, rx: 0.05, ry: 0.03 })).toBe(false);
    expect(isTrivial({ id: '2', kind: 'arrow', color: '#fff', x1: 0.5, y1: 0.5, x2: 0.501, y2: 0.5 })).toBe(true);
    expect(isTrivial({ id: '2', kind: 'arrow', color: '#fff', x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.3 })).toBe(false);
    expect(isTrivial({ id: '3', kind: 'pen', color: '#fff', points: [0.1, 0.1, 0.1, 0.1] })).toBe(true);
    expect(isTrivial({ id: '4', kind: 'text', color: '#fff', x: 0.1, y: 0.1, text: '   ' })).toBe(true);
    expect(isTrivial({ id: '4', kind: 'text', color: '#fff', x: 0.1, y: 0.1, text: 'Infiltrate' })).toBe(false);
  });

  it('thins a freehand stroke but keeps both ends', () => {
    const points: number[] = [];
    for (let i = 0; i <= 200; i++) points.push(0.2 + i * 0.0005, 0.5);
    const out = simplify(points);
    expect(out.length).toBeLessThan(points.length / 3);
    expect(out.slice(0, 2)).toEqual([0.2, 0.5]);
    expect(out.slice(-2)).toEqual([points[points.length - 2], 0.5]);
    expect(simplify([0.1, 0.1, 0.2, 0.2])).toEqual([0.1, 0.1, 0.2, 0.2]);
  });

  it('draws the arrowhead at the end of the line, pointing along it', () => {
    const [tip, left, right] = arrowHead(0, 0, 100, 0, 10);
    expect(tip).toEqual([100, 0]);
    expect(left[0]).toBeLessThan(100);
    expect(right[0]).toBeLessThan(100);
    expect(left[1]).toBeCloseTo(-right[1]);
  });
});
