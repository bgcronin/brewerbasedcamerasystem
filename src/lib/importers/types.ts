/**
 * Worklist importers.
 *
 * An importer turns some external source (a CSV export, a pasted spreadsheet,
 * and later HL7 / FHIR / an EMR API) into patients for a day's list.
 *
 * Tabular importers return a `table`, which the user maps to fields in the
 * import sheet. Structured importers that already know which value is which
 * return `records` and skip the mapping step.
 */

export type PatientField =
  | 'ignore'
  | 'mrn'
  | 'fullName'
  | 'firstName'
  | 'lastName'
  | 'dob'
  | 'sex'
  | 'date'
  | 'time'
  | 'clinic'
  | 'clinician'
  | 'reason'
  | 'notes';

export interface ImportedRecord {
  mrn?: string;
  firstName: string;
  lastName: string;
  dob?: string;
  sex?: 'M' | 'F' | 'O' | '';
  /** ISO date of the appointment, if the source carries one. */
  date?: string;
  time?: string;
  clinic?: string;
  clinician?: string;
  reason?: string;
  notes?: string;
}

export interface TabularData {
  /** Raw rows including the header row, if any. */
  rows: string[][];
}

export type ImportResult =
  | { kind: 'table'; table: TabularData; sourceName: string; notes?: string; flaggedRows?: number[] }
  | { kind: 'records'; records: ImportedRecord[]; sourceName: string; notes?: string };

export type ImportProgress = (p: { label: string; progress?: number }) => void;

export interface WorklistImporter {
  id: string;
  label: string;
  description: string;
  /** Value for <input type="file" accept>. */
  accept: string;
  matches(file: File): boolean;
  read(file: File, onProgress?: ImportProgress): Promise<ImportResult>;
}
