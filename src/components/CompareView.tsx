import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatClock, formatShortDate } from '../lib/dates';
import { displayName } from '../lib/names';
import { useFullImage } from '../lib/thumbs';
import { techniqueLabel, type Capture } from '../lib/types';
import { closeCompare, useApp } from '../state/store';
import { AnnotationLayer } from './AnnotationLayer';
import { EyeTag, IconButton, Switch } from './ui';
import { ZOOM_FIT, ZoomPane, type ZoomState } from './ZoomPane';

function Pane({ c, view, onView, marks }: { c: Capture; view: ZoomState; onView: (v: ZoomState) => void; marks: boolean }) {
  const url = useFullImage(c.id);
  return (
    <div className="compare-pane">
      <ZoomPane
        src={url}
        naturalWidth={c.width}
        naturalHeight={c.height}
        view={view}
        onView={onView}
        alt=""
        overlay={marks && c.annotations?.length ? <AnnotationLayer width={c.width} height={c.height} annotations={c.annotations} /> : null}
      />
      <div className="compare-label glass">
        <EyeTag eye={c.eye} />
        <strong>{formatShortDate(c.date)}</strong>
        <span className="meta-row">
          <span>{formatClock(c.takenAt)}</span>
          {c.technique && <span>{techniqueLabel(c.technique)}</span>}
        </span>
      </div>
    </div>
  );
}

/** Side-by-side comparison, e.g. this visit against the last, with linked zoom. */
export function CompareView() {
  const pair = useApp((s) => s.compare);
  const captures = useApp((s) => s.captures);
  const library = useApp((s) => s.library);
  const allPatients = useApp((s) => s.allPatients);
  const activePatient = useApp((s) => s.patient);
  const [sync, setSync] = useState(true);
  const [marks, setMarks] = useState(true);
  const [a, setA] = useState<ZoomState>(ZOOM_FIT);
  const [b, setB] = useState<ZoomState>(ZOOM_FIT);
  const [swapped, setSwapped] = useState(false);

  useEffect(() => {
    setA(ZOOM_FIT);
    setB(ZOOM_FIT);
    setSwapped(false);
  }, [pair]);

  useEffect(() => {
    if (!pair) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.repeat) closeCompare();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pair]);

  if (!pair) return null;
  // The pair may come from the patient on screen or, via the Library, from anyone.
  let [left, right] = pair.map((id) => captures.find((c) => c.id === id) ?? library?.find((c) => c.id === id));
  if (!left || !right) return null;
  const patientId = left.patientId;
  const patient = allPatients.find((p) => p.id === patientId) ?? (activePatient?.id === patientId ? activePatient : null);
  const anyMarks = !!(left.annotations?.length || right.annotations?.length);
  if (left.takenAt > right.takenAt) [left, right] = [right, left];
  if (swapped) [left, right] = [right, left];

  const setLeft = (v: ZoomState) => (sync ? (setA(v), setB(v)) : setA(v));
  const setRight = (v: ZoomState) => (sync ? (setA(v), setB(v)) : setB(v));

  return createPortal(
    <div className="viewer compare" role="dialog" aria-modal="true" aria-label="Compare photos">
      <header className="viewer-bar">
        <IconButton icon="chevronLeft" label="Back (Esc)" onClick={closeCompare} />
        <div className="viewer-title">
          <div>
            <strong>Compare</strong>
            <span>{patient ? displayName(patient) : ''}</span>
          </div>
        </div>
        <div className="viewer-actions">
          {anyMarks && (
            <label className="inline-switch">
              <span>Marks</span>
              <Switch checked={marks} onChange={setMarks} label="Show marks" />
            </label>
          )}
          <label className="inline-switch">
            <span>Link zoom</span>
            <Switch checked={sync} onChange={(v) => (setSync(v), v && setB(a))} label="Link zoom" />
          </label>
          <IconButton icon="flip" label="Swap sides" onClick={() => setSwapped((s) => !s)} />
        </div>
      </header>
      <div className="compare-body">
        <Pane c={left} view={a} onView={setLeft} marks={marks} />
        <Pane c={right} view={b} onView={setRight} marks={marks} />
      </div>
    </div>,
    document.body,
  );
}
