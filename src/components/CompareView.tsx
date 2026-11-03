import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatClock, formatShortDate } from '../lib/dates';
import { displayName } from '../lib/names';
import { useFullImage } from '../lib/thumbs';
import { techniqueLabel, type Capture } from '../lib/types';
import { closeCompare, useApp } from '../state/store';
import { EyeTag, IconButton, Switch } from './ui';
import { ZOOM_FIT, ZoomPane, type ZoomState } from './ZoomPane';

function Pane({ c, view, onView }: { c: Capture; view: ZoomState; onView: (v: ZoomState) => void }) {
  const url = useFullImage(c.id);
  return (
    <div className="compare-pane">
      <ZoomPane src={url} naturalWidth={c.width} naturalHeight={c.height} view={view} onView={onView} alt="" />
      <div className="compare-label glass">
        <EyeTag eye={c.eye} />
        <strong>{formatShortDate(c.date)}</strong>
        <span>
          {formatClock(c.takenAt)}
          {c.technique && ` · ${techniqueLabel(c.technique)}`}
        </span>
      </div>
    </div>
  );
}

/** Side-by-side comparison, e.g. this visit against the last, with linked zoom. */
export function CompareView() {
  const pair = useApp((s) => s.compare);
  const captures = useApp((s) => s.captures);
  const patient = useApp((s) => s.patient);
  const [sync, setSync] = useState(true);
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
      if (e.key === 'Escape') closeCompare();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pair]);

  if (!pair) return null;
  let [left, right] = pair.map((id) => captures.find((c) => c.id === id));
  if (!left || !right) return null;
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
          <label className="inline-switch">
            <span>Link zoom</span>
            <Switch checked={sync} onChange={(v) => (setSync(v), v && setB(a))} label="Link zoom" />
          </label>
          <IconButton icon="flip" label="Swap sides" onClick={() => setSwapped((s) => !s)} />
        </div>
      </header>
      <div className="compare-body">
        <Pane c={left} view={a} onView={setLeft} />
        <Pane c={right} view={b} onView={setRight} />
      </div>
    </div>,
    document.body,
  );
}
