import { useEffect, useMemo, useRef, useState } from 'react';
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
} from '../lib/importers';
import { displayName } from '../lib/names';
import { openFileForImport } from '../state/actions';
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

function MapColumns({ result, onBack }: { result: Extract<ImportResult, { kind: 'table' }>; onBack: () => void }) {
  const viewDate = useApp((s) => s.date);
  const datePref = useApp((s) => s.settings.dateOrder);
  const rows = result.table.rows;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const [hasHeader, setHasHeader] = useState(() => rows.length > 0 && looksLikeHeader(rows[0]));
  const headers = hasHeader ? rows[0] : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const dataRows = useMemo(() => (hasHeader ? rows.slice(1) : rows), [rows, hasHeader]);
  const [mapping, setMapping] = useState<PatientField[]>(() => (hasHeader ? detectMapping(rows[0]) : guessMappingFromValues(rows)));
  const [order, setOrder] = useState<'auto' | DateOrderResolved>(datePref);
  const [listDate, setListDate] = useState(viewDate || todayISO());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMapping(hasHeader ? detectMapping(rows[0]) : guessMappingFromValues(rows));
  }, [hasHeader]); // eslint-disable-line react-hooks/exhaustive-deps

  const fullMapping = Array.from({ length: width }, (_, i) => mapping[i] ?? 'ignore');
  const mapped = useMemo(() => applyMapping(dataRows, fullMapping, order), [dataRows, fullMapping.join(), order]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasName = fullMapping.some((f) => f === 'fullName' || f === 'lastName' || f === 'firstName');
  const hasMrn = fullMapping.includes('mrn');
  const fileDates = mapped.datesInFile;

  const setCol = (i: number, f: PatientField) =>
    setMapping((m) => {
      const next = Array.from({ length: width }, (_, j) => m[j] ?? 'ignore');
      if (f !== 'ignore') for (let j = 0; j < next.length; j++) if (next[j] === f) next[j] = 'ignore';
      next[i] = f;
      return next;
    });

  const doImport = async () => {
    setBusy(true);
    try {
      await importToList(mapped.records, listDate, 'csv');
      closeSheet();
    } catch (e) {
      toast({ tone: 'error', message: 'Import failed', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-map">
      <div className="import-file">
        <Icon name="list" size={16} />
        <strong>{result.sourceName}</strong>
        {result.notes && <span className="import-notes">{result.notes}</span>}
        <span className="muted">
          {dataRows.length} row{dataRows.length === 1 ? '' : 's'}, {width} column{width === 1 ? '' : 's'}
        </span>
        <span className="flex-1" />
        <label className="inline-switch">
          <span>First row is headings</span>
          <Switch checked={hasHeader} onChange={setHasHeader} label="First row is headings" />
        </label>
      </div>

      <div className="map-table-wrap">
        <table className="map-table">
          <thead>
            <tr>
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
            {dataRows.slice(0, result.flaggedRows?.length ? 12 : 6).map((r, ri) => (
              <tr key={ri} className={cx(result.flaggedRows?.includes(ri) && 'is-flagged')} title={result.flaggedRows?.includes(ri) ? 'Check this row: something was missing or hard to read' : undefined}>
                {headers.map((_, i) => (
                  <td key={i} className={cx(fullMapping[i] === 'ignore' && 'is-ignored')}>
                    {r[i] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
            {mapped.records.length} patient{mapped.records.length === 1 ? '' : 's'}
            {mapped.skipped > 0 && `, ${mapped.skipped} row${mapped.skipped === 1 ? '' : 's'} without a name skipped`}
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
        {hasName && !hasMrn && (
          <p className="import-note">
            <Icon name="info" size={15} /> No patient ID column — patients will be matched across days by name and date of birth.
          </p>
        )}
      </div>

      <footer className="sheet-foot">
        <Button variant="ghost" onClick={onBack} icon="chevronLeft">
          Back
        </Button>
        <span className="flex-1" />
        <Button variant="primary" disabled={!hasName || !mapped.records.length || busy} onClick={() => void doImport()}>
          {busy ? 'Importing…' : `Import ${mapped.records.length} patient${mapped.records.length === 1 ? '' : 's'}`}
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
    <Modal open={open} onClose={closeSheet} width={result ? 860 : 560} labelledBy="import-title" className="import-sheet">
      <SheetHeader
        id="import-title"
        title="Import clinic list"
        subtitle={result ? 'Check that each column is matched to the right field.' : 'Bring in the day’s patients from your PAS or EMR export.'}
        onClose={closeSheet}
      />
      {reading ? (
        <div className="import-reading" role="status">
          <div className="import-reading-bar" aria-hidden="true">
            <i style={{ width: `${Math.round((reading.progress ?? 0) * 100)}%` }} className={cx(reading.progress == null && 'is-indeterminate')} />
          </div>
          <strong>{reading.label}…</strong>
          <span>{reading.name}</span>
        </div>
      ) : result?.kind === 'table' ? (
        <MapColumns key={nonce} result={result} onBack={() => setResult(undefined)} />
      ) : (
        <ChooseSource onResult={onResult} />
      )}
    </Modal>
  );
}
