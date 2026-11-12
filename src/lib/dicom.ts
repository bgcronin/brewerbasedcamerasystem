/**
 * Writes photographs as DICOM files for a PACS or an imaging system such as Forum.
 *
 * Each photo becomes one "VL Photographic Image" (the DICOM object for a
 * colour photograph taken with a camera), carrying a JPEG exactly as a camera
 * would store it. Laterality, the patient's details and the visit go in the
 * header. One visit is one study; its photographs are one series.
 *
 * Everything is built here, in the browser: nothing is sent anywhere.
 */
import { fileStamp } from './dates';
import { techniqueLabel, type Capture, type Patient, type Visit } from './types';

export const SOP_CLASS_VL_PHOTOGRAPHIC = '1.2.840.10008.5.1.4.1.1.77.1.4';
export const TS_EXPLICIT_LITTLE_ENDIAN = '1.2.840.10008.1.2.1';
export const TS_JPEG_BASELINE = '1.2.840.10008.1.2.4.50';
export const TS_JPEG_EXTENDED = '1.2.840.10008.1.2.4.51';
/** Identifies Lumen as the software that wrote the file (a "2.25" UID needs no registration). */
const IMPLEMENTATION_CLASS_UID = '2.25.176278846873787630331307490792747430168';
const IMPLEMENTATION_VERSION = 'LUMEN_1';

type VR = 'CS' | 'DA' | 'DT' | 'IS' | 'LO' | 'LT' | 'OB' | 'PN' | 'SH' | 'SQ' | 'ST' | 'TM' | 'UI' | 'UL' | 'US';

interface Element {
  tag: number;
  vr: VR;
  value: Uint8Array;
}

const utf8 = new TextEncoder();
/** Longest value each text type may hold, in characters. */
const MAX: Partial<Record<VR, number>> = { CS: 16, IS: 12, LO: 64, LT: 10240, PN: 64, SH: 16, ST: 1024, UI: 64 };

/** One value, cleaned up and cut to the length its type allows. */
function clean(vr: VR, raw: string | undefined): string {
  let s = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  // A backslash separates values in DICOM; inside a value it would split it in two.
  if (vr !== 'LT' && vr !== 'ST') s = s.replace(/\\/g, '/');
  const max = MAX[vr];
  if (max && [...s].length > max) s = [...s].slice(0, max).join('').trim();
  return s;
}

/** Text values are an even number of bytes: padded with a space, or with a zero byte for a UID. */
function text(tag: number, vr: VR, raw: string | undefined): Element {
  return encodeText(tag, vr, clean(vr, raw));
}

function encodeText(tag: number, vr: VR, s: string): Element {
  let bytes = utf8.encode(s);
  if (bytes.length % 2) {
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    padded[bytes.length] = vr === 'UI' ? 0x00 : 0x20;
    bytes = padded;
  }
  return { tag, vr, value: bytes };
}

/** Several values of one element, e.g. ImageType "ORIGINAL\PRIMARY". */
const multi = (tag: number, vr: VR, values: string[]): Element => encodeText(tag, vr, values.map((v) => clean(vr, v)).join('\\'));

function u16(tag: number, n: number): Element {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return { tag, vr: 'US', value: b };
}

function u32(tag: number, n: number): Element {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return { tag, vr: 'UL', value: b };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function tagBytes(tag: number): Uint8Array {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  v.setUint16(0, tag >>> 16, true);
  v.setUint16(2, tag & 0xffff, true);
  return b;
}

/** One element in "explicit VR little endian", the encoding used throughout the file. */
function encode(e: Element): Uint8Array {
  const long = e.vr === 'OB' || e.vr === 'SQ';
  const head = new Uint8Array(long ? 12 : 8);
  const v = new DataView(head.buffer);
  head.set(tagBytes(e.tag));
  head[4] = e.vr.charCodeAt(0);
  head[5] = e.vr.charCodeAt(1);
  if (long) v.setUint32(8, e.value.length, true);
  else v.setUint16(6, e.value.length, true);
  return concat([head, e.value]);
}

/** Elements must appear in ascending tag order. */
const serialise = (elements: Element[]): Uint8Array => concat([...elements].sort((a, b) => a.tag - b.tag).map(encode));

/** A sequence: a list of items, each a small data set of its own. */
function sequence(tag: number, items: Element[][]): Element {
  const parts: Uint8Array[] = [];
  for (const item of items) {
    const body = serialise(item);
    const head = new Uint8Array(8);
    head.set(tagBytes(0xfffee000));
    new DataView(head.buffer).setUint32(4, body.length, true);
    parts.push(head, body);
  }
  return { tag, vr: 'SQ', value: concat(parts) };
}

/** The compressed image: an empty offset table, the JPEG as a single fragment, and a closing delimiter. */
function encapsulatedPixelData(jpeg: Uint8Array): Uint8Array {
  const even = jpeg.length + (jpeg.length % 2);
  const out = new Uint8Array(12 + 8 + 8 + even + 8);
  const v = new DataView(out.buffer);
  out.set(tagBytes(0x7fe00010), 0);
  out[4] = 0x4f; // 'O'
  out[5] = 0x42; // 'B'
  v.setUint32(8, 0xffffffff, true); // undefined length: the items follow
  out.set(tagBytes(0xfffee000), 12); // basic offset table, empty
  v.setUint32(16, 0, true);
  out.set(tagBytes(0xfffee000), 20); // the one fragment
  v.setUint32(24, even, true);
  out.set(jpeg, 28);
  out.set(tagBytes(0xfffee0dd), 28 + even); // sequence delimiter
  v.setUint32(32 + even, 0, true);
  return out;
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  /** 0xC0 baseline, 0xC1 extended sequential, 0xC2 progressive. */
  frame: number;
  precision: number;
}

/** Read the frame header of a JPEG: its size, and which kind of JPEG it is. */
export function readJpegInfo(jpeg: Uint8Array): JpegInfo {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG image');
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) throw new Error('The JPEG image is damaged');
    const marker = jpeg[at + 1];
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    const length = (jpeg[at + 2] << 8) | jpeg[at + 3];
    // Start-of-frame markers, except the ones in that range that mean something else (DHT, JPG, DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { frame: marker, precision: jpeg[at + 4], height: (jpeg[at + 5] << 8) | jpeg[at + 6], width: (jpeg[at + 7] << 8) | jpeg[at + 8], components: jpeg[at + 9] };
    }
    at += 2 + length;
  }
  throw new Error('The JPEG image has no frame header');
}

/**
 * A DICOM unique identifier made from Lumen's own ids, so that exporting the same photo twice
 * gives the same identifier and a PACS recognises it as the same image rather than a new one.
 */
export async function uidFor(...parts: string[]): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(['lumen', ...parts].join(':'))));
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(hash[i]);
  return `2.25.${n}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const dicomDate = (iso: string | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.replace(/-/g, '') : '');
const dicomTime = (d: Date) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const localDate = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
function utcOffset(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

export interface DicomPhoto {
  patient: Pick<Patient, 'mrn' | 'firstName' | 'lastName' | 'dob' | 'sex'>;
  visit: Pick<Visit, 'id' | 'date' | 'time' | 'clinician'>;
  capture: Pick<Capture, 'id' | 'eye' | 'technique' | 'takenAt' | 'note' | 'diagnoses' | 'deviceLabel'>;
  /** The photograph as a JPEG (baseline or extended sequential, 8 bits, colour or greyscale). */
  jpeg: Uint8Array;
  /** Its number within the visit, counting from 1. */
  instanceNumber: number;
  clinicName?: string;
  /** True for the copy with the annotations drawn in: stored as a derived image beside the original. */
  annotated?: boolean;
}

/** Build one DICOM file. */
export async function buildDicom(p: DicomPhoto): Promise<Uint8Array> {
  const info = readJpegInfo(p.jpeg);
  if (info.precision !== 8) throw new Error('Only 8-bit photographs can be exported to DICOM');
  if (info.frame !== 0xc0 && info.frame !== 0xc1) throw new Error('This kind of JPEG (progressive) cannot be stored in DICOM');
  if (info.components !== 3 && info.components !== 1) throw new Error('Only colour or greyscale photographs can be exported to DICOM');
  const transferSyntax = info.frame === 0xc0 ? TS_JPEG_BASELINE : TS_JPEG_EXTENDED;

  const taken = new Date(p.capture.takenAt);
  const [studyUid, seriesUid, sopUid] = await Promise.all([
    uidFor('study', p.visit.id),
    uidFor('series', p.visit.id),
    uidFor('image', p.capture.id, p.annotated ? 'annotated' : 'original'),
  ]);
  const comments = [techniqueLabel(p.capture.technique), ...(p.capture.diagnoses ?? []), p.capture.note].filter(Boolean).join('. ');
  const laterality = p.capture.eye === 'OD' ? 'R' : p.capture.eye === 'OS' ? 'L' : 'B';
  const sex = p.patient.sex === 'M' || p.patient.sex === 'F' || p.patient.sex === 'O' ? p.patient.sex : '';
  const device = p.capture.deviceLabel ?? '';

  const dataset: Element[] = [
    text(0x00080005, 'CS', 'ISO_IR 192'), // text below is UTF-8, so accented names are stored correctly
    multi(0x00080008, 'CS', p.annotated ? ['DERIVED', 'SECONDARY'] : ['ORIGINAL', 'PRIMARY']),
    text(0x00080016, 'UI', SOP_CLASS_VL_PHOTOGRAPHIC),
    text(0x00080018, 'UI', sopUid),
    text(0x00080020, 'DA', dicomDate(p.visit.date)), // study date
    text(0x00080022, 'DA', localDate(taken)), // acquisition date
    text(0x00080023, 'DA', localDate(taken)), // content date
    text(0x0008002a, 'DT', `${localDate(taken)}${dicomTime(taken)}`),
    text(0x00080030, 'TM', p.visit.time && /^\d{2}:\d{2}$/.test(p.visit.time) ? `${p.visit.time.replace(':', '')}00` : ''), // study time
    text(0x00080032, 'TM', dicomTime(taken)),
    text(0x00080033, 'TM', dicomTime(taken)),
    text(0x00080050, 'SH', ''), // accession number: none
    text(0x00080060, 'CS', 'XC'), // modality: external-camera photography
    text(0x00080070, 'LO', /canon/i.test(device) ? 'Canon' : ''),
    text(0x00080090, 'PN', ''), // referring physician: not recorded
    text(0x00080201, 'SH', utcOffset(taken)),
    text(0x00081030, 'LO', 'Slit lamp photography'),
    text(0x0008103e, 'LO', 'Slit lamp photographs'),
    sequence(0x00082218, [[text(0x00080100, 'SH', '81745001'), text(0x00080102, 'SH', 'SCT'), text(0x00080104, 'LO', 'Eye')]]), // anatomic region
    text(0x00100010, 'PN', [p.patient.lastName, p.patient.firstName].map((n) => n.trim().replace(/\^/g, ' ')).filter(Boolean).join('^')),
    text(0x00100020, 'LO', p.patient.mrn),
    text(0x00100030, 'DA', dicomDate(p.patient.dob)),
    text(0x00100040, 'CS', sex),
    text(0x00181020, 'LO', 'Lumen'),
    text(0x0020000d, 'UI', studyUid),
    text(0x0020000e, 'UI', seriesUid),
    text(0x00200010, 'SH', dicomDate(p.visit.date)), // study ID
    text(0x00200011, 'IS', '1'),
    text(0x00200013, 'IS', String(p.instanceNumber)),
    text(0x00200020, 'CS', ''), // patient orientation: not applicable to a slit lamp photograph
    text(0x00200062, 'CS', laterality),
    u16(0x00280002, info.components),
    text(0x00280004, 'CS', info.components === 3 ? 'YBR_FULL_422' : 'MONOCHROME2'),
    u16(0x00280010, info.height),
    u16(0x00280011, info.width),
    u16(0x00280100, 8),
    u16(0x00280101, 8),
    u16(0x00280102, 7),
    u16(0x00280103, 0),
    text(0x00280301, 'CS', p.annotated ? 'YES' : 'NO'), // burned-in annotation
    text(0x00282110, 'CS', '01'), // lossy compression has been applied
    text(0x00282114, 'CS', 'ISO_10918_1'),
    sequence(0x00400555, []), // acquisition context: nothing to add
  ];
  if (info.components === 3) dataset.push(u16(0x00280006, 0));
  if (p.clinicName) dataset.push(text(0x00080080, 'LO', p.clinicName));
  if (device) dataset.push(text(0x00081090, 'LO', device));
  if (p.visit.clinician) dataset.push(text(0x00081048, 'PN', p.visit.clinician.replace(/\s+/g, ' '))); // physician of record
  if (comments) dataset.push(text(0x00204000, 'LT', comments));
  if (p.annotated) dataset.push(text(0x00082111, 'ST', 'Copy with annotations drawn on the photograph in Lumen'));

  const meta = serialise([
    { tag: 0x00020001, vr: 'OB', value: new Uint8Array([0x00, 0x01]) },
    text(0x00020002, 'UI', SOP_CLASS_VL_PHOTOGRAPHIC),
    text(0x00020003, 'UI', sopUid),
    text(0x00020010, 'UI', transferSyntax),
    text(0x00020012, 'UI', IMPLEMENTATION_CLASS_UID),
    text(0x00020013, 'SH', IMPLEMENTATION_VERSION),
  ]);

  const preamble = new Uint8Array(132);
  preamble.set(utf8.encode('DICM'), 128);
  return concat([preamble, encode(u32(0x00020000, meta.length)), meta, serialise(dataset), encapsulatedPixelData(p.jpeg)]);
}

/** "H100234_20261103_143205_OD_slit.dcm", matching the photo's own file name. */
export function dicomFileName(patient: Pick<Patient, 'mrn' | 'lastName'>, capture: Pick<Capture, 'takenAt' | 'eye' | 'technique'>, annotated = false): string {
  const id = (patient.mrn || patient.lastName || 'patient').replace(/[^A-Za-z0-9]+/g, '');
  return [id || 'patient', fileStamp(capture.takenAt), capture.eye, capture.technique, annotated ? 'annotated' : ''].filter(Boolean).join('_') + '.dcm';
}
