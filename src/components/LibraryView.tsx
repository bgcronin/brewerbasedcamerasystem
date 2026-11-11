import { useEffect, useMemo, useState } from 'react';
import { formatShortDate } from '../lib/dates';
import { addDiagnosis } from '../lib/diagnoses';
import { displayName } from '../lib/names';
import { EMPTY_QUERY, diagnosisCounts, groupByPatient, searchCaptures, type LibraryPeriod, type LibraryQuery, type PatientGroup } from '../lib/search';
import { techniqueLabel, techniqueShort, type Capture, type Patient } from '../lib/types';
import { openLightbox, selectPatient, setView, useApp } from '../state/store';
import { DiagnosisChip } from './DiagnosisPicker';
import { Icon } from './Icon';
import { Avatar, Button, EyeTag, Segmented, Thumb, cx } from './ui';

/** Photos shown per patient before "show all". */
const PER_PATIENT = 6;
/** Patients shown before "show more". */
const PAGE = 30;
/** Diagnosis chips shown before "more". */
const CHIPS = 10;

// The search survives a trip to another view and back.
let remembered: LibraryQuery = EMPTY_QUERY;

function LibraryTile({ c, onOpen }: { c: Capture; onOpen: () => void }) {
  const label = [c.eye, techniqueLabel(c.technique), ...(c.diagnoses ?? [])].filter(Boolean).join(', ');
  return (
    <button type="button" className="tile" onClick={onOpen} title={label}>
      <Thumb id={c.id} alt={label} />
      <span className="tile-top">
        <EyeTag eye={c.eye} />
        <span className="tile-badges">
          {c.annotations?.length ? <Icon name="annotate" size={13} className="tile-badge" /> : null}
          {c.starred && <Icon name="star" size={13} fill="currentColor" className="tile-star" />}
        </span>
      </span>
      <span className="tile-bottom">
        <span>{formatShortDate(c.date)}</span>
        {c.technique && <span>{techniqueShort(c.technique)}</span>}
      </span>
    </button>
  );
}

function Group({
  group,
  patient,
  expanded,
  onExpand,
  onOpen,
  onDiagnosis,
}: {
  group: PatientGroup;
  patient: Patient | undefined;
  expanded: boolean;
  onExpand: () => void;
  onOpen: (id: string) => void;
  onDiagnosis: (name: string) => void;
}) {
  const shown = expanded ? group.captures : group.captures.slice(0, PER_PATIENT);
  const hidden = group.captures.length - shown.length;
  let labels: string[] = [];
  for (const c of group.captures) for (const d of c.diagnoses ?? []) labels = addDiagnosis(labels, d);
  const visits = new Set(group.captures.map((c) => c.visitId)).size;
  const openPatient = () => {
    void selectPatient(group.patientId);
    setView('review');
  };
  return (
    <section className="lib-group">
      <header className="lib-group-head">
        {patient && <Avatar patient={patient} size={36} />}
        <div className="lib-group-id">
          <strong>{patient ? displayName(patient) : 'Unknown patient'}</strong>
          <span className="meta-row">
            {patient?.mrn && <span className="mrn">{patient.mrn}</span>}
            <span>
              {group.captures.length} photo{group.captures.length === 1 ? '' : 's'}
              {visits > 1 ? `, ${visits} visits` : ''}
            </span>
          </span>
        </div>
        <div className="lib-group-dx">
          {labels.slice(0, 4).map((d) => (
            <DiagnosisChip key={d} name={d} onClick={() => onDiagnosis(d)} />
          ))}
        </div>
        {patient && (
          <Button size="sm" variant="ghost" iconRight="chevronRight" onClick={openPatient}>
            All photos
          </Button>
        )}
      </header>
      <div className="tile-grid lib-grid">
        {shown.map((c) => (
          <LibraryTile key={c.id} c={c} onOpen={() => onOpen(c.id)} />
        ))}
        {hidden > 0 && (
          <button type="button" className="tile tile-more" onClick={onExpand}>
            <strong>+{hidden}</strong>
            <span>Show all</span>
          </button>
        )}
      </div>
    </section>
  );
}

/** Every photo in Lumen, searchable by diagnosis, patient, hospital number, note or date. */
export function LibraryView() {
  const library = useApp((s) => s.library);
  const allPatients = useApp((s) => s.allPatients);
  const [q, setQ] = useState<LibraryQuery>(remembered);
  const [pages, setPages] = useState(1);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [allChips, setAllChips] = useState(false);

  useEffect(() => {
    remembered = q;
    setPages(1);
  }, [q]);

  const patients = useMemo(() => new Map(allPatients.map((p) => [p.id, p])), [allPatients]);
  const results = useMemo(() => (library ? searchCaptures(library, patients, q) : []), [library, patients, q]);
  const groups = useMemo(() => groupByPatient(results), [results]);
  const counts = useMemo(() => (library ? diagnosisCounts(library) : []), [library]);
  const years = useMemo(() => [...new Set((library ?? []).map((c) => c.date.slice(0, 4)))].sort().reverse(), [library]);
  // The viewer steps through the results in the order they are listed.
  const order = useMemo(() => groups.flatMap((g) => g.captures.map((c) => c.id)), [groups]);

  const patch = (p: Partial<LibraryQuery>) => setQ((old) => ({ ...old, ...p }));
  const filtered = q.text.trim() !== '' || q.eye !== 'all' || q.starred || q.annotated || q.period !== 'any' || q.diagnosis !== null;
  const toggleDiagnosis = (name: string) => patch({ diagnosis: q.diagnosis === name ? null : name });

  if (!library) {
    return (
      <section className="library library-empty">
        <div className="spinner" />
      </section>
    );
  }

  const chips = allChips ? counts : counts.slice(0, CHIPS);
  // A chosen diagnosis stays visible even when it is not among the most common.
  const pinned = q.diagnosis && !chips.some((k) => k.name === q.diagnosis) ? counts.find((k) => k.name === q.diagnosis) : undefined;

  return (
    <section className="library">
      <header className="library-head">
        <div className="library-top">
          <label className="search library-search">
            <Icon name="search" size={18} />
            <input
              id="library-search"
              type="search"
              autoFocus
              placeholder="Search by diagnosis, name, hospital number, note or date"
              value={q.text}
              onChange={(e) => patch({ text: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Segmented<LibraryQuery['eye']>
            size="sm"
            ariaLabel="Eye"
            className="library-eye"
            value={q.eye}
            onChange={(eye) => patch({ eye })}
            options={[
              { value: 'all', label: 'Both eyes' },
              { value: 'OD', label: 'OD' },
              { value: 'OS', label: 'OS' },
            ]}
          />
          <button type="button" className={cx('filter-toggle', q.starred && 'is-on')} aria-pressed={q.starred} onClick={() => patch({ starred: !q.starred })}>
            <Icon name="star" size={14} fill={q.starred ? 'currentColor' : undefined} />
            Starred
          </button>
          <button type="button" className={cx('filter-toggle', q.annotated && 'is-on')} aria-pressed={q.annotated} onClick={() => patch({ annotated: !q.annotated })}>
            <Icon name="annotate" size={14} />
            Annotated
          </button>
          <select className="select select-sm library-period" value={q.period} onChange={(e) => patch({ period: e.target.value as LibraryPeriod })} aria-label="When">
            <option value="any">Any time</option>
            <option value="30d">Last 30 days</option>
            <option value="12m">Last 12 months</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        {counts.length > 0 && (
          <div className="library-dx" aria-label="Diagnoses">
            {pinned && <DiagnosisChip name={pinned.name} count={pinned.patients} active onClick={() => toggleDiagnosis(pinned.name)} />}
            {chips.map((k) => (
              <DiagnosisChip key={k.name} name={k.name} count={k.patients} active={q.diagnosis === k.name} onClick={() => toggleDiagnosis(k.name)} />
            ))}
            {counts.length > CHIPS && (
              <button type="button" className="link-btn" onClick={() => setAllChips((v) => !v)}>
                {allChips ? 'Fewer' : `${counts.length - CHIPS} more`}
              </button>
            )}
          </div>
        )}
      </header>

      {library.length === 0 ? (
        <div className="library-empty">
          <div className="empty-rings" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>Your photographs will collect here</h2>
          <p>Label them with a diagnosis as you take them, and find any of them again in a moment.</p>
          <Button variant="primary" icon="camera" onClick={() => setView('capture')}>
            Go to Capture
          </Button>
        </div>
      ) : results.length === 0 ? (
        <div className="library-empty">
          <Icon name="search" size={28} />
          <h2>Nothing matches</h2>
          <p>Try fewer words, or part of a name or hospital number.</p>
          <Button onClick={() => setQ(EMPTY_QUERY)}>Clear the search</Button>
        </div>
      ) : (
        <div className="library-scroll">
          <p className="library-summary">
            <span>
              {results.length} photo{results.length === 1 ? '' : 's'} of {groups.length} patient{groups.length === 1 ? '' : 's'}
            </span>
            {filtered && (
              <button type="button" className="link-btn" onClick={() => setQ(EMPTY_QUERY)}>
                Clear filters
              </button>
            )}
          </p>
          {groups.slice(0, pages * PAGE).map((g) => (
            <Group
              key={g.patientId}
              group={g}
              patient={patients.get(g.patientId)}
              expanded={expanded.includes(g.patientId)}
              onExpand={() => setExpanded((e) => [...e, g.patientId])}
              onOpen={(id) => openLightbox(order, order.indexOf(id), 'library')}
              onDiagnosis={toggleDiagnosis}
            />
          ))}
          {groups.length > pages * PAGE && (
            <div className="library-more">
              <Button onClick={() => setPages((p) => p + 1)}>Show {Math.min(PAGE, groups.length - pages * PAGE)} more patients</Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
