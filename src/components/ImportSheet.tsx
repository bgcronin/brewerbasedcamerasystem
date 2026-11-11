import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatShortDate, todayISO, type DateOrderResolved } from '../lib/dates';
import {
  ACCEPT_ALL,
  FIELD_LABELS,
  FIELD_ORDER,
  applyMapping,
  detectMapping,
  guessMappingFromValues,
  looksLikeHeader,
  tableFromPastedText,
  type ImportResult,
  type PatientField,
  type RowReading,
} from '../lib/importers';
import { checkRows, type RowProblem } from '../lib/importers/review';
import { displayName } from '../lib/names';
import { cancelImportRead, openFileForImport } from '../state/actions';
import { closeSheet, importToList, toast, useApp } from '../state/store';
import { Icon } from './Icon';
import { Button, Field, Modal, Segmented, SheetHeader, Switch, cx } from './ui';

function ChooseSource({ onResult }: { onResult: (r: ImportResult) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const [over, setOver] = useState(false);

  const loadSample = async () => {
    const text = await (await fetch('./sample-worklist.csv')).text();
    onResult({ ...tableFromPastedText(text), sourceName: 'Sample clinic list' });
  };

  return (
    <div className="import-choose">
      <button
        type="button"
        className={cx('dropzone', over && 'is-over')}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void openFileForImport(f);
        }}
        data-autofocus
      >
        <span className="dropzone-icon">
          <Icon name="import" size={24} />
        </span>
        <strong>Choose the clinic list</strong>
        <span>A CSV export, or a PDF, scan or photo of the printed list. Read on this computer; nothing is uploaded.</span>
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ALL}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openFileForImport(f);
          e.target.value = '';
        }}
      />

      <div className="or-rule">
        <span>or paste rows from Excel or your PAS</span>
      </div>
      <textarea
        className="textarea paste-area"
        rows={5}
        placeholder={'Time\tHospital No\tSurname\tForename\tDOB\n09:00\tH100234\tSMITH\tJohn\t12/03/1956'}
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        spellCheck={false}
      />
      <div className="import-choose-foot">
        <button type="button" className="link-btn" onClick={() => void loadSample()}>
          Use the sample list
        </button>
        <Button variant="primary" disabled={!paste.trim()} onClick={() => onResult(tableFromPastedText(paste))}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/** One row of the list as it stands in the sheet: what was read, plus what the user has done to it. */
interface SheetRow {
  id: number;
  cells: string[];
  reading?: RowReading;
  /** Columns the user has typed in. A doubt about a cell is settled once that cell has been edited. */
  edited: number[];
  confirmed: boolean;
  removed: boolean;
}

const MAX_SHOWN = 400;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Tells the frame whether the table has more to the left or right, so the edges can fade where it does. */
function useScrollEdges(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false, width: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = { left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2, width: el.clientWidth };
      setEdges((prev) => (prev.left === next.left && prev.right === next.right && prev.width === next.width ? prev : next));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref, edges };
}

function MapColumns({ result, onBack }: { result: Extract<ImportResult, { kind: 'table' }>; onBack: () => void }) {
  const viewDate = useApp((s) => s.date);
  const datePref = useApp((s) => s.settings.dateOrder);
  const reading = result.reading;
  const table = result.table.rows;
  const width = Math.max(0, ...table.map((r) => r.length));
  const [rows, setRows] = useState<SheetRow[]>(() =>
    table.map((cells, id) => ({ id, cells: Array.from({ length: width }, (_, i) => cells[i] ?? ''), reading: reading?.rows[id], edited: [], confirmed: false, removed: false })),
  );
  const firstIsHeader = reading ? reading.hasHeader : table.length > 0 && looksLikeHeader(table[0]);
  const [hasHeader, setHasHeader] = useState(firstIsHeader);
  const suggest = (header: boolean): PatientField[] => {
    if (reading && header === reading.hasHeader) return reading.mapping;
    return header ? detectMapping(table[0]) : guessMappingFromValues(table);
  };
  const [mapping, setMapping] = useState<PatientField[]>(() => suggest(firstIsHeader));
  const [order, setOrder] = useState<'auto' | DateOrderResolved>(datePref);
  const [listDate, setListDate] = useState(viewDate || todayISO());
  const [busy, setBusy] = useState(false);

  const toggleHeader = (v: boolean) => {
    setHasHeader(v);
    setMapping(suggest(v));
  };

  const headers = hasHeader && rows.length ? rows[0].cells : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const fullMapping = Array.from({ length: width }, (_, i) => mapping[i] ?? 'ignore');
  const mapKey = fullMapping.join();
  const data = useMemo(() => (hasHeader ? rows.slice(1) : rows).filter((r) => !r.removed), [rows, hasHeader]);
  const removed = rows.filter((r) => r.removed).length;

  // Every row is checked against the columns as they are chosen now, so changing a column or a cell re-checks the list.
  const review = useMemo(() => {
    const cells = data.map((r) => r.cells);
    const dateOrder = applyMapping(cells, fullMapping, order).dateOrder;
    const problems: RowProblem[][] = reading ? checkRows(cells, fullMapping, dateOrder) : cells.map(() => []);
    const state = data.map((r, i) => {
      const doubts = (r.reading?.doubts ?? []).filter((d) => (d.col == null ? r.edited.length === 0 : !r.edited.includes(d.col)));
      const issues = [...doubts, ...problems[i]];
      const blocked = problems[i].some((p) => p.blocking);
      return { row: r, issues, blocked, included: issues.length === 0 || (r.confirmed && !blocked) };
    });
    const mapped = applyMapping(state.filter((s) => s.included).map((s) => s.row.cells), fullMapping, order);
    return { state, mapped, toCheck: state.filter((s) => !s.included).length };
  }, [data, mapKey, order, reading]); // eslint-disable-line react-hooks/exhaustive-deps
  const { mapped, toCheck } = review;

  // Rows that needed checking when the list was opened stay at the top, so a row does not jump away as it is corrected.
  const [pinned] = useState(() => new Set(review.state.filter((s) => s.issues.length).map((s) => s.row.id)));
  const shown = useMemo(() => {
    const top = review.state.filter((s) => pinned.has(s.row.id));
    const rest = review.state.filter((s) => !pinned.has(s.row.id));
    return [...top, ...rest];
  }, [review, pinned]);

  const hasName = fullMapping.some((f) => f === 'fullName' || f === 'lastName' || f === 'firstName');
  const hasMrn = fullMapping.includes('mrn');
  const fileDates = mapped.datesInFile;
  const unread = data.filter((r) => r.reading?.unread).length;
  const { ref: scroller, edges } = useScrollEdges([width, shown.length]);

  const setCol = (i: number, f: PatientField) =>
    setMapping((m) => {
      const next = Array.from({ length: width }, (_, j) => m[j] ?? 'ignore');
      if (f !== 'ignore') for (let j = 0; j < next.length; j++) if (next[j] === f) next[j] = 'ignore';
      next[i] = f;
      return next;
    });
  const patch = (id: number, change: (r: SheetRow) => SheetRow) => setRows((all) => all.map((r) => (r.id === id ? change(r) : r)));
  const editCell = (id: number, col: number, value: string) =>
    patch(id, (r) => ({ ...r, cells: r.cells.map((c, i) => (i === col ? value : c)), edited: r.edited.includes(col) ? r.edited : [...r.edited, col] }));

  const doImport = async () => {
    setBusy(true);
    try {
      await importToList(mapped.records, listDate, result.source ?? 'csv');
      closeSheet();
    } catch (e) {
      toast({ tone: 'error', message: 'Import failed', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const ready = mapped.records.length;
  return (
    <div className="import-map">
      <div className="import-file">
        <Icon name="list" size={16} />
        <strong>{result.sourceName}</strong>
        {reading && <span className="import-notes">Read {reading.how}</span>}
        {result.notes && <span className="import-notes">{result.notes}</span>}
        <span className="flex-1" />
        <label className="inline-switch">
          <span>First row is headings</span>
          <Switch checked={hasHeader} onChange={toggleHeader} label="First row is headings" />
        </label>
      </div>

      {reading && (
        <div className="import-status" role="status">
          <p className={cx('import-count', toCheck > 0 && 'has-checks')}>
            <strong>{plural(ready, 'patient')} ready to import.</strong>{' '}
            {toCheck > 0 && (
              <span className="import-tocheck">
                {plural(toCheck, 'row needs', 'rows need')} checking: {toCheck === 1 ? 'it is' : 'they are'} left out until you correct {toCheck === 1 ? 'it' : 'them'} or tick {toCheck === 1 ? 'it' : 'them'} as correct.
              </span>
            )}
          </p>
          {unread > 0 && <p className="import-warning"><Icon name="alert" size={15} /> {plural(unread, 'line')} couldn’t be read. {unread === 1 ? 'It is' : 'They are'} shown below with the printed text, for you to fill in or remove.</p>}
          {reading.pagesNotRead > 0 && <p className="import-warning"><Icon name="alert" size={15} /> {plural(reading.pagesNotRead, 'page was', 'pages were')} not read. Lumen reads up to 200 pages, and up to 20 that have to be read as pictures.</p>}
          {reading.warnings.map((w) => (
            <p key={w} className="import-warning">
              <Icon name="alert" size={15} /> {w}
            </p>
          ))}
          {reading.notUsed.length > 0 && (
            <details className="import-unused">
              <summary>{plural(reading.notUsed.length, 'other line')} on the page {reading.notUsed.length === 1 ? 'was' : 'were'} not part of the list</summary>
              <ul>
                {reading.notUsed.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className={cx('map-table-frame', edges.left && 'more-left', edges.right && 'more-right')} style={{ ['--frame-w' as string]: `${edges.width}px` }}>
        <div className="map-table-wrap" ref={scroller}>
          <table className="map-table">
            <thead>
              <tr>
                <th className="map-tools" aria-label="Remove" />
                {headers.map((h, i) => (
                  <th key={i}>
                    <div className="map-head">{h || `Column ${i + 1}`}</div>
                    <select
                      className={cx('select select-sm', fullMapping[i] !== 'ignore' && 'is-mapped')}
                      value={fullMapping[i]}
                      onChange={(e) => setCol(i, e.target.value as PatientField)}
                      aria-label={`Field for ${h || `column ${i + 1}`}`}
                    >
                      {FIELD_ORDER.map((f) => (
                        <option key={f} value={f}>
                          {FIELD_LABELS[f]}
                        </option>
                      ))}
                    </select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, MAX_SHOWN).map(({ row, issues, blocked, included }) => {
                const flagged = issues.length > 0;
                const who = row.cells.find((c, i) => c && ['fullName', 'lastName'].includes(fullMapping[i])) || `row ${row.id + 1}`;
                return [
                  <tr key={row.id} className={cx(flagged && 'is-flagged', flagged && included && 'is-confirmed')}>
                    <td className="map-tools">
                      <button type="button" className="row-remove" onClick={() => patch(row.id, (r) => ({ ...r, removed: true }))} aria-label={`Remove ${who} from the import`} title="Remove this row">
                        <Icon name="x" size={13} />
                      </button>
                    </td>
                    {headers.map((h, i) => (
                      <td key={i} className={cx(fullMapping[i] === 'ignore' && 'is-ignored', issues.some((p) => p.col === i) && 'is-doubt')}>
                        <input
                          className={cx('cell', fullMapping[i] === 'mrn' && 'mrn')}
                          value={row.cells[i] ?? ''}
                          size={Math.min(34, Math.max(4, (row.cells[i] ?? '').length + 1))}
                          onChange={(e) => editCell(row.id, i, e.target.value)}
                          aria-label={`${h || `Column ${i + 1}`}, ${who}`}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </td>
                    ))}
                  </tr>,
                  flagged && (
                    <tr key={`${row.id}-why`} className={cx('row-why', included && 'is-confirmed')}>
                      <td colSpan={width + 1}>
                        <div className="row-why-inner">
                          <div className="row-why-text">
                            <strong>{[...new Set(issues.map((p) => p.reason))].join('. ')}.</strong>
                            {row.reading?.source && (
                              <span className="row-source">
                                Printed: <q>{row.reading.source}</q>
                              </span>
                            )}
                          </div>
                          {blocked ? (
                            <span className="row-ok is-blocked">Needs a name before it can be imported</span>
                          ) : (
                            <label className="row-ok">
                              <input type="checkbox" checked={row.confirmed} onChange={(e) => patch(row.id, (r) => ({ ...r, confirmed: e.target.checked }))} />
                              <span>This row is correct</span>
                            </label>
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
      {(shown.length > MAX_SHOWN || removed > 0) && (
        <p className="import-rows-note muted">
          {shown.length > MAX_SHOWN && `Showing the first ${MAX_SHOWN} of ${shown.length} rows; all of them will be imported. `}
          {removed > 0 && (
            <>
              {plural(removed, 'row')} removed.{' '}
              <button type="button" className="link-btn" onClick={() => setRows((all) => all.map((r) => ({ ...r, removed: false })))}>
                Put {removed === 1 ? 'it' : 'them'} back
              </button>
            </>
          )}
        </p>
      )}

      <div className="import-options">
        <Field label="Date format in file">
          <Segmented<'auto' | DateOrderResolved>
            size="sm"
            value={order}
            onChange={setOrder}
            options={[
              { value: 'auto', label: order === 'auto' ? `Auto (${mapped.dateOrder === 'DMY' ? 'DD/MM' : 'MM/DD'})` : 'Auto' },
              { value: 'DMY', label: 'DD/MM/YYYY' },
              { value: 'MDY', label: 'MM/DD/YYYY' },
            ]}
          />
        </Field>
        {fileDates.length ? (
          <Field label="Clinic date">
            <div className="static-field">
              From the file: {formatShortDate(fileDates[0])}
              {fileDates.length > 1 && ` + ${fileDates.length - 1} more day${fileDates.length > 2 ? 's' : ''}`}
            </div>
          </Field>
        ) : (
          <Field label="Add to the list for">
            <input className="input input-sm" type="date" value={listDate} onChange={(e) => setListDate(e.target.value || todayISO())} />
          </Field>
        )}
      </div>

      <div className="import-preview">
        <div className="import-preview-head">
          <span>Preview</span>
          <span className="muted">
            {plural(ready, 'patient')}
            {mapped.skipped > 0 && `, ${plural(mapped.skipped, 'row')} without a name skipped`}
          </span>
        </div>
        {hasName ? (
          <ul className="preview-list">
            {mapped.records.slice(0, 4).map((r, i) => (
              <li key={i}>
                <span className="preview-time">{r.time ?? '—'}</span>
                <strong>{displayName(r)}</strong>
                <span className="muted meta-row">
                  {r.mrn && <span className="mrn">{r.mrn}</span>}
                  {r.dob && <span>{formatShortDate(r.dob)}</span>}
                  {r.sex && <span>{r.sex}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="import-warning">
            <Icon name="alert" size={15} /> Choose which column holds the patient’s name.
          </p>
        )}
        {hasName && mapped.dateOrderAmbiguous && (
          <p className="import-warning">
            <Icon name="alert" size={15} /> Couldn’t tell DD/MM from MM/DD in this file — it’s being read as day first. Check a date of birth in the preview, or set the format above.
          </p>
        )}
        {hasName && mapped.birthDatesRejected > 0 && (
          <p className="import-warning">
            <Icon name="alert" size={15} /> {plural(mapped.birthDatesRejected, 'date of birth is', 'dates of birth are')} in the future or more than 120 years ago, and will be left blank.
          </p>
        )}
        {hasName && !hasMrn && (
          <p className="import-note">
            <Icon name="info" size={15} /> No patient ID column — patients will be matched across days by name and date of birth.
          </p>
        )}
        {hasName && mapped.nameOnly > 0 && (
          <p className="import-note">
            <Icon name="info" size={15} /> {plural(mapped.nameOnly, 'row has', 'rows have')} neither a patient ID nor a date of birth. A name alone is not enough to match someone already on record, so {mapped.nameOnly === 1 ? 'it' : 'each'} may get a new record.
          </p>
        )}
      </div>

      <footer className="sheet-foot">
        <Button variant="ghost" onClick={onBack} icon="chevronLeft">
          Back
        </Button>
        <span className="flex-1" />
        <Button variant="primary" disabled={!hasName || !ready || busy} onClick={() => void doImport()}>
          {busy ? 'Importing…' : `Import ${plural(ready, 'patient')}${toCheck > 0 ? ` (${toCheck} still to check)` : ''}`}
        </Button>
      </footer>
    </div>
  );
}

export function ImportSheet() {
  const sheet = useApp((s) => s.sheet);
  const open = sheet?.type === 'import';
  const reading = open ? sheet.reading : undefined;
  const [result, setResult] = useState<ImportResult | undefined>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setResult(open ? sheet.result : undefined);
    if (open) setNonce((n) => n + 1);
  }, [open, sheet]);

  // However the sheet goes away, a read still in progress is stopped with it.
  useEffect(() => {
    if (!open) cancelImportRead();
  }, [open]);

  const close = () => {
    cancelImportRead();
    closeSheet();
  };

  const onResult = (r: ImportResult) => {
    if (r.kind === 'records') {
      importToList(r.records, useApp.getState().date, 'import')
        .then(closeSheet)
        .catch((e: Error) => toast({ tone: 'error', message: 'Import failed', detail: e.message }));
      return;
    }
    if (!r.table.rows.length) {
      toast({ tone: 'warning', message: 'That list looks empty' });
      return;
    }
    setNonce((n) => n + 1);
    setResult(r);
  };

  return (
    <Modal open={open} onClose={close} width={result ? 1120 : 560} labelledBy="import-title" className="import-sheet">
      <SheetHeader
        id="import-title"
        title="Import clinic list"
        subtitle={result ? 'Check that each column is matched to the right field. You can correct any cell.' : 'Bring in the day’s patients from your PAS or EMR export.'}
        onClose={close}
      />
      {reading ? (
        <div className="import-reading" role="status">
          <div className="import-reading-bar" aria-hidden="true">
            <i style={{ width: `${Math.round((reading.progress ?? 0) * 100)}%` }} className={cx(reading.progress == null && 'is-indeterminate')} />
          </div>
          <strong>{reading.label}…</strong>
          <span>{reading.name}</span>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
      ) : result?.kind === 'table' ? (
        <MapColumns key={nonce} result={result} onBack={() => setResult(undefined)} />
      ) : (
        <ChooseSource onResult={onResult} />
      )}
    </Modal>
  );
}
