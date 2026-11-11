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

/** Something the reader was unsure of on one row. `col` ties it to a cell; without it, it is about the whole row. */
export interface ReadDoubt {
  col?: number;
  reason: string;
}

/** What a reader that had to interpret its source (a scan, a photo, a PDF) can tell the import sheet about a row. */
export interface RowReading {
  /** The line as it was printed. */
  source: string;
  page?: number;
  doubts: ReadDoubt[];
  /** The line looked like part of the list but could not be laid out into columns. */
  unread?: boolean;
}

export interface TableReading {
  /** One entry per row of the table, in step with `table.rows` (nothing for a heading row). */
  rows: (RowReading | undefined)[];
  hasHeader: boolean;
  /** The reader's own choice of field for each column. */
  mapping: PatientField[];
  /** How it was read, as a short phrase: "from the PDF’s text". */
  how: string;
  /** Things to settle before importing: a column the reader could not decide, pages it did not read. */
  warnings: string[];
  /** Lines on the page that are not part of the table (titles, footers), kept so nothing disappears unseen. */
  notUsed: string[];
  pagesNotRead: number;
}

export type ImportResult =
  | { kind: 'table'; table: TabularData; sourceName: string; notes?: string; source?: string; reading?: TableReading }
  | { kind: 'records'; records: ImportedRecord[]; sourceName: string; notes?: string };

export type ImportProgress = (p: { label: string; progress?: number }) => void;

export interface WorklistImporter {
  id: string;
  label: string;
  description: string;
  /** Value for <input type="file" accept>. */
  accept: string;
  matches(file: File): boolean;
  /** `signal` is aborted when the user closes the import sheet: stop reading and free whatever was started. */
  read(file: File, onProgress?: ImportProgress, signal?: AbortSignal): Promise<ImportResult>;
}
