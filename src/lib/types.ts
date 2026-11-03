/** Laterality. OD = right eye, OS = left eye, OU = both eyes. */
export type Eye = 'OD' | 'OS' | 'OU';

export interface Patient {
  id: string;
  /** Hospital / medical record number. Used to match the same patient across days. */
  mrn: string;
  firstName: string;
  lastName: string;
  /** ISO date, YYYY-MM-DD. */
  dob?: string;
  sex?: 'M' | 'F' | 'O' | '';
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/** One appearance of a patient on a day's clinic list. */
export interface Visit {
  id: string;
  patientId: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /** 24h HH:mm. */
  time?: string;
  clinic?: string;
  clinician?: string;
  reason?: string;
  /** Where the entry came from: 'csv', 'manual', 'capture', or a future importer id. */
  source: string;
  createdAt: number;
}

export type CaptureSource = 'live' | 'tether' | 'file';

export interface Capture {
  id: string;
  patientId: string;
  visitId: string;
  /** ISO date of the visit, YYYY-MM-DD (denormalised for fast per-day queries). */
  date: string;
  eye: Eye;
  technique?: string;
  takenAt: number;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  fileName: string;
  source: CaptureSource;
  deviceLabel?: string;
  note?: string;
  starred?: boolean;
  /** Path relative to the archive folder once written to disk. */
  archivedPath?: string;
}

export interface StoredImage {
  id: string;
  full: Blob;
  thumb: Blob;
}

export type ImageFormat = 'image/webp' | 'image/jpeg' | 'image/png';
export type ThemePref = 'dark' | 'light' | 'system';
export type DateOrder = 'auto' | 'DMY' | 'MDY';

export interface Transform {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

export interface Settings {
  clinicName: string;
  format: ImageFormat;
  /** 0.5 – 1.0, ignored for PNG. */
  quality: number;
  /** Store JPEGs from the tethered folder byte-for-byte instead of re-encoding. */
  keepTetherOriginals: boolean;
  /** Delete files from the tethered folder once safely stored. */
  removeTetherOriginals: boolean;
  shutterSound: boolean;
  theme: ThemePref;
  /** KeyboardEvent.code values that fire the shutter (foot pedals usually send one of these). */
  captureKeys: string[];
  dateOrder: DateOrder;
  reticle: boolean;
  source: 'live' | 'tether';
  deviceId?: string;
  /** Per-device orientation fixes, keyed by device label. */
  transforms: Record<string, Transform>;
  /** 'auto' picks the highest resolution the camera offers. */
  resolution: 'auto' | '3840x2160' | '2560x1440' | '1920x1080' | '1280x720';
}

export const DEFAULT_SETTINGS: Settings = {
  clinicName: '',
  format: 'image/webp',
  quality: 0.92,
  keepTetherOriginals: false,
  removeTetherOriginals: false,
  shutterSound: true,
  theme: 'dark',
  captureKeys: ['Space'],
  dateOrder: 'auto',
  reticle: false,
  source: 'live',
  transforms: {},
  resolution: 'auto',
};

export interface Technique {
  id: string;
  label: string;
  short: string;
}

/** Slit lamp illumination techniques, in the order of the 1–8 shortcut keys. */
export const TECHNIQUES: Technique[] = [
  { id: 'diffuse', label: 'Diffuse', short: 'Diffuse' },
  { id: 'slit', label: 'Slit beam', short: 'Slit' },
  { id: 'retro', label: 'Retroillumination', short: 'Retro' },
  { id: 'specular', label: 'Specular reflection', short: 'Specular' },
  { id: 'scatter', label: 'Sclerotic scatter', short: 'Scatter' },
  { id: 'cobalt', label: 'Cobalt blue / NaFl', short: 'Cobalt' },
  { id: 'redfree', label: 'Red-free', short: 'Red-free' },
  { id: 'external', label: 'External / adnexa', short: 'External' },
];

export function techniqueLabel(id?: string): string {
  if (!id) return '';
  return TECHNIQUES.find((t) => t.id === id)?.label ?? id;
}
