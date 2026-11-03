import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, ageFromDOB, formatDayHeading, relativeDayLabel, todayISO } from '../lib/dates';
import { tableFromPastedText } from '../lib/importers';
import { displayName } from '../lib/names';
import type { Patient } from '../lib/types';
import { openSheet, selectPatient, setDate, toast, useApp, type VisitRow } from '../state/store';
import { Icon } from './Icon';
import { Button, IconButton, Kbd, cx } from './ui';

function matches(p: Patient, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const hay = `${p.firstName} ${p.lastName} ${p.lastName} ${p.firstName} ${p.mrn}`.toLowerCase();
  return s.split(/\s+/).every((t) => hay.includes(t));
}

function sexLabel(s?: string) {
  return s === 'M' ? 'M' : s === 'F' ? 'F' : s === 'O' ? 'X' : '';
}

function PatientRow({ row, active }: { row: VisitRow; active: boolean }) {
  const { patient: p, visit, count } = row;
  const age = ageFromDOB(p.dob);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      className={cx('prow', active && 'is-active', count > 0 && 'is-done')}
      onClick={() => void selectPatient(p.id)}
      aria-current={active || undefined}
    >
      <span className="prow-time">{visit.time ?? '—'}</span>
      <span className="prow-main">
        <span className="prow-name">{displayName(p)}</span>
        <span className="prow-meta">
          {p.mrn && <span className="prow-mrn">{p.mrn}</span>}
          {(age != null || p.sex) && (
            <span>
              {age != null ? `${age}` : ''}
              {sexLabel(p.sex)}
            </span>
          )}
          {visit.reason && <span className="prow-reason">{visit.reason}</span>}
        </span>
      </span>
      <span className="prow-status">
        {count > 0 ? (
          <span className="count-badge" title={`${count} photo${count === 1 ? '' : 's'}`}>
            <Icon name="camera" size={12} strokeWidth={1.8} />
            {count}
          </span>
        ) : (
          <span className="prow-dot" />
        )}
      </span>
    </button>
  );
}

function OtherRow({ patient, active }: { patient: Patient; active: boolean }) {
  const age = ageFromDOB(patient.dob);
  return (
    <button type="button" className={cx('prow prow-other', active && 'is-active')} onClick={() => void selectPatient(patient.id)}>
      <span className="prow-time">
        <Icon name="user" size={14} />
      </span>
      <span className="prow-main">
        <span className="prow-name">{displayName(patient)}</span>
        <span className="prow-meta">
          {patient.mrn && <span className="prow-mrn">{patient.mrn}</span>}
          {age != null && <span>{age}{sexLabel(patient.sex)}</span>}
        </span>
      </span>
      <span className="prow-status" />
    </button>
  );
}

function EmptyList() {
  const total = useApp((s) => s.allPatients.length);
  const date = useApp((s) => s.date);
  const loadSample = async () => {
    try {
      const res = await fetch('./sample-worklist.csv');
      const text = await res.text();
      openSheet({ type: 'import', result: { ...tableFromPastedText(text), sourceName: 'Sample clinic list' } });
    } catch {
      toast({ tone: 'error', message: 'Couldn’t load the sample list' });
    }
  };
  return (
    <div className="empty-list">
      <div className="empty-rings" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h3>{date === todayISO() ? 'No patients yet today' : 'No patients on this day'}</h3>
      <p>Import the clinic list as a CSV — or drop the file anywhere in this window.</p>
      {total === 0 && (
        <button type="button" className="link-btn" onClick={() => void loadSample()}>
          Try it with a sample list
        </button>
      )}
    </div>
  );
}

export function Worklist() {
  const rows = useApp((s) => s.rows);
  const date = useApp((s) => s.date);
  const activeId = useApp((s) => s.activePatientId);
  const allPatients = useApp((s) => s.allPatients);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all');
  const dateInput = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => rows.filter((r) => matches(r.patient, query) && (filter === 'all' || (filter === 'done' ? r.count > 0 : r.count === 0))),
    [rows, query, filter],
  );
  const others = useMemo(() => {
    if (query.trim().length < 2) return [];
    const listed = new Set(rows.map((r) => r.patient.id));
    return allPatients.filter((p) => !listed.has(p.id) && matches(p, query)).slice(0, 25);
  }, [allPatients, rows, query]);

  const done = rows.filter((r) => r.count > 0).length;
  const isToday = date === todayISO();

  return (
    <aside className="sidebar" aria-label="Clinic list">
      <div className="sidebar-head">
        <div className="daynav">
          <IconButton icon="chevronLeft" label="Previous day" onClick={() => void setDate(addDays(date, -1))} />
          <button
            type="button"
            className="daynav-label"
            onClick={() => {
              const el = dateInput.current;
              if (el && 'showPicker' in el) el.showPicker();
            }}
            title="Choose a date"
          >
            <span className="daynav-rel">{relativeDayLabel(date)}</span>
            <span className="daynav-full">{formatDayHeading(date)}</span>
            <input
              ref={dateInput}
              type="date"
              className="sr-only"
              tabIndex={-1}
              value={date}
              onChange={(e) => e.target.value && void setDate(e.target.value)}
            />
          </button>
          <IconButton icon="chevronRight" label="Next day" onClick={() => void setDate(addDays(date, 1))} />
        </div>
        {!isToday && (
          <button type="button" className="back-today" onClick={() => void setDate(todayISO())}>
            Back to today
          </button>
        )}

        <label className="search">
          <Icon name="search" size={16} />
          <input
            id="worklist-search"
            type="search"
            placeholder="Search name or MRN"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {!query && <Kbd>/</Kbd>}
        </label>

        {rows.length > 0 && (
          <div className="list-summary">
            <div className="list-filters" role="tablist">
              {(['all', 'todo', 'done'] as const).map((f) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} className={cx('chip', filter === f && 'is-on')} onClick={() => setFilter(f)}>
                  {f === 'all' ? `All ${rows.length}` : f === 'todo' ? `To do ${rows.length - done}` : `Done ${done}`}
                </button>
              ))}
            </div>
            <div className="progress" aria-label={`${done} of ${rows.length} photographed`}>
              <i style={{ width: `${rows.length ? (done / rows.length) * 100 : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="sidebar-list">
        {visible.map((r) => (
          <PatientRow key={r.visit.id} row={r} active={r.patient.id === activeId} />
        ))}
        {rows.length > 0 && !visible.length && !others.length && <p className="list-note">No matches on this list.</p>}
        {others.length > 0 && (
          <>
            <div className="list-section">Other patients</div>
            {others.map((p) => (
              <OtherRow key={p.id} patient={p} active={p.id === activeId} />
            ))}
          </>
        )}
        {!rows.length && !query && <EmptyList />}
      </div>

      <div className="sidebar-foot">
        <Button variant="primary" icon="import" onClick={() => openSheet({ type: 'import' })}>
          Import list
        </Button>
        <Button icon="plus" onClick={() => openSheet({ type: 'patient' })} title="Add a patient">
          Patient
        </Button>
      </div>
    </aside>
  );
}
