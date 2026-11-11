import { useMemo, useState } from 'react';
import { annotatedName, renderAnnotated } from '../lib/annotations';
import { ageFromDOB, formatClock, formatLongDate, formatShortDate } from '../lib/dates';
import { getImage } from '../lib/db';
import { addDiagnosis } from '../lib/diagnoses';
import { displayName } from '../lib/names';
import { patientFolderName, withSuffix } from '../lib/naming';
import { techniqueLabel, type Capture, type Eye } from '../lib/types';
import { buildZip, downloadBlob, type ZipEntry } from '../lib/zip';
import { openCompare, openLightbox, setView, toast, useApp } from '../state/store';
import { Icon } from './Icon';
import { Avatar, Button, EyeTag, Segmented, Thumb, cx } from './ui';

type Filter = 'all' | 'OD' | 'OS' | 'starred';

function Tile({ c, onOpen, selecting, selected, onToggle }: { c: Capture; onOpen: () => void; selecting: boolean; selected: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={cx('tile', selecting && 'is-selecting', selected && 'is-selected')}
      onClick={selecting ? onToggle : onOpen}
      aria-pressed={selecting ? selected : undefined}
    >
      <Thumb id={c.id} alt={`${c.eye} ${techniqueLabel(c.technique)}`} />
      <span className="tile-top">
        <EyeTag eye={c.eye} />
        <span className="tile-badges">
          {c.note && <span title={c.note} className="tile-badge"><Icon name="note" size={13} /></span>}
          {c.annotations?.length ? <Icon name="annotate" size={13} className="tile-badge" /> : null}
          {c.starred && <Icon name="star" size={13} fill="currentColor" className="tile-star" />}
        </span>
      </span>
      <span className="tile-bottom">
        <span>{formatClock(c.takenAt)}</span>
        {c.technique && <span>{techniqueLabel(c.technique)}</span>}
      </span>
      {selecting && <span className="tile-check">{selected && <Icon name="check" size={14} strokeWidth={2.2} />}</span>}
    </button>
  );
}

export function ReviewView() {
  const patient = useApp((s) => s.patient);
  const captures = useApp((s) => s.captures);
  const visits = useApp((s) => s.patientVisits);
  const [filter, setFilter] = useState<Filter>('all');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [exporting, setExporting] = useState<string | null>(null);

  const shown = useMemo(
    () => captures.filter((c) => (filter === 'all' ? true : filter === 'starred' ? c.starred : c.eye === filter)),
    [captures, filter],
  );
  const byDate = useMemo(() => {
    const m = new Map<string, Capture[]>();
    for (const c of shown) m.set(c.date, [...(m.get(c.date) ?? []), c]);
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [shown]);
  const order = useMemo(() => byDate.flatMap(([, list]) => list).map((c) => c.id), [byDate]);

  if (!patient) {
    return (
      <section className="review review-empty">
        <div className="empty-rings" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h2>Choose a patient to review</h2>
        <p>Their photographs from every visit appear here, right eye beside left.</p>
      </section>
    );
  }

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));

  const exportZip = async () => {
    if (!captures.length) return;
    setExporting('Preparing…');
    try {
      const root = patientFolderName(patient);
      const entries: ZipEntry[] = [];
      const used = new Set<string>();
      const fileOf = new Map<string, string>();
      for (const c of captures) {
        const img = await getImage(c.id);
        if (!img) continue;
        let name = c.fileName;
        for (let n = 2; used.has(`${c.date}/${name}`); n++) name = withSuffix(c.fileName, n);
        used.add(`${c.date}/${name}`);
        fileOf.set(c.id, `${c.date}/${name}`);
        entries.push({ path: `${root}/${c.date}/${name}`, data: img.full, modified: new Date(c.takenAt) });
        if (c.annotations?.length) {
          // A second copy with the marks drawn in, beside the untouched original.
          const marked = await renderAnnotated(img.full, c.annotations, c.mime);
          entries.push({ path: `${root}/${c.date}/${annotatedName(name)}`, data: marked, modified: new Date(c.annotationsAt ?? c.takenAt) });
        }
      }
      entries.push({
        path: `${root}/patient.json`,
        data: JSON.stringify(
          {
            patient: { mrn: patient.mrn, firstName: patient.firstName, lastName: patient.lastName, dob: patient.dob, sex: patient.sex },
            images: captures.map((c) => ({
              file: fileOf.get(c.id) ?? `${c.date}/${c.fileName}`,
              eye: c.eye,
              technique: techniqueLabel(c.technique) || undefined,
              takenAt: new Date(c.takenAt).toISOString(),
              width: c.width,
              height: c.height,
              note: c.note,
              starred: c.starred || undefined,
              diagnoses: c.diagnoses?.length ? c.diagnoses : undefined,
              annotations: c.annotations?.length ? c.annotations : undefined,
            })),
          },
          null,
          2,
        ),
      });
      const zip = await buildZip(entries, (d, t) => setExporting(`Packing ${d} of ${t}…`));
      downloadBlob(zip, `${root}.zip`);
      toast({ tone: 'success', message: 'Export ready', detail: `${captures.length} photos in ${root}.zip` });
    } catch (e) {
      toast({ tone: 'error', message: 'Export failed', detail: (e as Error).message });
    } finally {
      setExporting(null);
    }
  };

  const age = ageFromDOB(patient.dob);
  const visitFor = (date: string) => visits.find((v) => v.date === date);

  return (
    <section className="review">
      <header className="review-head">
        <Avatar patient={patient} size={52} />
        <div className="review-id">
          <h1>{displayName(patient)}</h1>
          <p>
            {patient.mrn && <span className="mrn">{patient.mrn}</span>}
            {patient.dob && (
              <span>
                Born {formatShortDate(patient.dob)}
                {age != null ? ` (${age})` : ''}
              </span>
            )}
            <span className="muted">
              {shown.length} photo{shown.length === 1 ? '' : 's'} across {byDate.length || 0} visit{byDate.length === 1 ? '' : 's'}
            </span>
          </p>
        </div>
        <div className="review-actions">
          <Segmented<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'OD', label: 'OD' },
              { value: 'OS', label: 'OS' },
              { value: 'starred', label: <Icon name="star" size={14} /> , title: 'Starred' },
            ]}
          />
          <Button
            size="sm"
            icon="compare"
            variant={selecting ? 'primary' : 'secondary'}
            onClick={() => {
              setSelecting((s) => !s);
              setSelected([]);
            }}
            disabled={captures.length < 2}
          >
            Compare
          </Button>
          <Button size="sm" icon="download" onClick={() => void exportZip()} disabled={!captures.length || !!exporting}>
            {exporting ?? 'Export'}
          </Button>
        </div>
      </header>

      {!captures.length ? (
        <div className="review-none">
          <Icon name="image" size={28} />
          <h3>No photographs yet</h3>
          <p>Head back to Capture to take the first one.</p>
          <Button variant="primary" icon="camera" onClick={() => setView('capture')}>
            Go to Capture
          </Button>
        </div>
      ) : (
        <div className="review-scroll">
          {byDate.map(([date, list]) => {
            const v = visitFor(date);
            const col = (eye: Eye) => list.filter((c) => c.eye === eye);
            const od = col('OD');
            const os = col('OS');
            const ou = col('OU');
            let labels: string[] = [];
            for (const c of list) for (const d of c.diagnoses ?? []) labels = addDiagnosis(labels, d);
            const tiles = (cs: Capture[]) =>
              cs.map((c) => (
                <Tile
                  key={c.id}
                  c={c}
                  selecting={selecting}
                  selected={selected.includes(c.id)}
                  onToggle={() => toggle(c.id)}
                  onOpen={() => openLightbox(order, order.indexOf(c.id))}
                />
              ));
            return (
              <section key={date} className="visit-block">
                <h2 className="visit-head">
                  <span>{formatLongDate(date)}</span>
                  <span className="visit-meta">
                    <span>
                      {list.length} photo{list.length === 1 ? '' : 's'}
                    </span>
                    {v?.reason && <span>{v.reason}</span>}
                    {v?.clinician && <span>{v.clinician}</span>}
                  </span>
                  {labels.length > 0 && (
                    <span className="visit-dx">
                      {labels.map((d) => (
                        <span key={d} className="dx-chip">
                          <span className="dx-chip-name">{d}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </h2>
                <div className="eye-columns">
                  {(filter === 'all' || filter === 'OD' || filter === 'starred') && (
                    <div className="eye-col">
                      <div className="eye-col-head">
                        <EyeTag eye="OD" /> Right eye <span className="muted">{od.length}</span>
                      </div>
                      <div className="tile-grid">{od.length ? tiles(od) : <span className="tile-none">No photos</span>}</div>
                    </div>
                  )}
                  {(filter === 'all' || filter === 'OS' || filter === 'starred') && (
                    <div className="eye-col">
                      <div className="eye-col-head">
                        <EyeTag eye="OS" /> Left eye <span className="muted">{os.length}</span>
                      </div>
                      <div className="tile-grid">{os.length ? tiles(os) : <span className="tile-none">No photos</span>}</div>
                    </div>
                  )}
                </div>
                {ou.length > 0 && (
                  <div className="eye-col eye-col-ou">
                    <div className="eye-col-head">
                      <EyeTag eye="OU" /> Both eyes <span className="muted">{ou.length}</span>
                    </div>
                    <div className="tile-grid">{tiles(ou)}</div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {selecting && (
        <div className="select-bar">
          <span>{selected.length === 2 ? 'Ready to compare' : `Select two photos (${selected.length} of 2)`}</span>
          <Button size="sm" variant="primary" disabled={selected.length !== 2} onClick={() => (openCompare(selected[0], selected[1]), setSelecting(false), setSelected([]))}>
            Compare
          </Button>
          <Button size="sm" variant="ghost" onClick={() => (setSelecting(false), setSelected([]))}>
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}
