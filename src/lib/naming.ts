import { fileStamp } from './dates';
import type { Capture, ImageFormat, Patient } from './types';

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Make a string safe as a single Windows / macOS / network-share path segment. */
export function safeSegment(raw: string, fallback = 'untitled'): string {
  let s = raw
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  if (!s || RESERVED.test(s)) s = fallback;
  return s;
}

export function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/webp':
      return 'webp';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    default:
      return 'bin';
  }
}

export function formatLabel(f: ImageFormat): string {
  return { 'image/webp': 'WebP', 'image/jpeg': 'JPEG', 'image/png': 'PNG' }[f];
}

/** Folder for a patient: "SMITH_John_MRN12345". Fixed on first use so history stays together. */
export function patientFolderName(p: Pick<Patient, 'firstName' | 'lastName' | 'mrn' | 'archiveFolder'>): string {
  if (p.archiveFolder) return p.archiveFolder;
  const parts = [p.lastName.toUpperCase(), p.firstName, p.mrn].map((x) => (x ?? '').trim()).filter(Boolean);
  return safeSegment(parts.join('_').replace(/\s+/g, '-'), 'Unnamed');
}

/** File name for a capture: "MRN12345_20261103_143205_OD_slit.webp". */
export function captureFileName(
  p: Pick<Patient, 'mrn' | 'lastName'>,
  c: Pick<Capture, 'takenAt' | 'eye' | 'technique'>,
  mime: string,
): string {
  const id = (p.mrn || p.lastName || 'patient').replace(/\s+/g, '');
  const parts = [id, fileStamp(c.takenAt), c.eye, c.technique].filter(Boolean);
  return safeSegment(parts.join('_'), 'capture') + '.' + extensionFor(mime);
}

export function withSuffix(fileName: string, n: number): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? `${fileName}_${n}` : `${fileName.slice(0, dot)}_${n}${fileName.slice(dot)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function megapixels(w: number, h: number): string {
  const mp = (w * h) / 1e6;
  return mp >= 1 ? `${mp.toFixed(mp >= 10 ? 0 : 1)} MP` : `${w}×${h}`;
}
