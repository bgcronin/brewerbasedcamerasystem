import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatClock, formatShortDate } from '../lib/dates';
import { getImage } from '../lib/db';
import { displayName } from '../lib/names';
import { formatBytes, formatLabel, megapixels } from '../lib/naming';
import { useFullImage } from '../lib/thumbs';
import { downloadBlob } from '../lib/zip';
import { TECHNIQUES, techniqueLabel, type Eye, type ImageFormat } from '../lib/types';
import { closeLightbox, deleteCapture, openCompare, stepLightbox, updateCapture, useApp } from '../state/store';
import { Icon } from './Icon';
import { Button, EyeTag, IconButton, Segmented, Thumb, cx } from './ui';
import { ZOOM_FIT, ZoomPane, type ZoomState } from './ZoomPane';

export function Lightbox() {
  const lb = useApp((s) => s.lightbox);
  const captures = useApp((s) => s.captures);
  const patient = useApp((s) => s.patient);
  const [view, setView] = useState<ZoomState>(ZOOM_FIT);
  const [info, setInfo] = useState(true);
  const id = lb ? lb.ids[lb.index] : null;
  const c = captures.find((x) => x.id === id);
  const url = useFullImage(c?.id);
  const [note, setNote] = useState('');

  useEffect(() => {
    setView(ZOOM_FIT);
    setNote(c?.note ?? '');
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close if the open photo was deleted.
  useEffect(() => {
    if (lb && !c) {
      const remaining = lb.ids.filter((x) => captures.some((k) => k.id === x));
      if (!remaining.length) closeLightbox();
      else useApp.setState({ lightbox: { ids: remaining, index: Math.min(lb.index, remaining.length - 1) } });
    }
  }, [lb, c, captures]);

  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') stepLightbox(1);
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'Delete' || e.key === 'Backspace') c && deleteCapture(c.id);
      else if (e.key.toLowerCase() === 's' && c) void updateCapture(c.id, { starred: !c.starred });
      else if (e.key.toLowerCase() === 'i') setInfo((v) => !v);
      else if (e.key === '0') setView(ZOOM_FIT);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lb, c]);

  if (!lb || !c) return null;

  const download = async () => {
    const img = await getImage(c.id);
    if (img) downloadBlob(img.full, c.fileName);
  };
  const others = captures.filter((x) => x.id !== c.id && x.eye === c.eye);
  const compareWith = others.filter((x) => x.date < c.date).pop() ?? others[others.length - 1];

  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Photo viewer">
      <header className="viewer-bar">
        <IconButton icon="chevronLeft" label="Back (Esc)" onClick={closeLightbox} />
        <div className="viewer-title">
          <EyeTag eye={c.eye} size="md" />
          <div>
            <strong>{patient ? displayName(patient) : ''}</strong>
            <span>
              {formatShortDate(c.date)} · {formatClock(c.takenAt)}
              {c.technique && ` · ${techniqueLabel(c.technique)}`}
            </span>
          </div>
        </div>
        <span className="viewer-count">
          {lb.index + 1} of {lb.ids.length}
        </span>
        <div className="viewer-actions">
          <IconButton icon="star" label="Star (S)" active={c.starred} onClick={() => void updateCapture(c.id, { starred: !c.starred })} />
          {compareWith && <IconButton icon="compare" label="Compare with another photo of this eye" onClick={() => openCompare(compareWith.id, c.id)} />}
          <IconButton icon="download" label="Download" onClick={() => void download()} />
          <IconButton icon="trash" label="Delete (Del)" onClick={() => deleteCapture(c.id)} />
          <IconButton icon="info" label="Details (I)" active={info} onClick={() => setInfo((v) => !v)} />
        </div>
      </header>

      <div className={cx('viewer-body', info && 'has-info')}>
        <div className="viewer-stage">
          <ZoomPane src={url} naturalWidth={c.width} naturalHeight={c.height} view={view} onView={setView} alt={`${c.eye} ${techniqueLabel(c.technique)}`} />
          {lb.index > 0 && (
            <button type="button" className="viewer-nav viewer-prev" onClick={() => stepLightbox(-1)} aria-label="Previous">
              <Icon name="chevronLeft" size={22} />
            </button>
          )}
          {lb.index < lb.ids.length - 1 && (
            <button type="button" className="viewer-nav viewer-next" onClick={() => stepLightbox(1)} aria-label="Next">
              <Icon name="chevronRight" size={22} />
            </button>
          )}
        </div>

        {info && (
          <aside className="viewer-info">
            <section>
              <h4>Eye</h4>
              <Segmented<Eye>
                value={c.eye}
                onChange={(eye) => void updateCapture(c.id, { eye })}
                options={[
                  { value: 'OD', label: 'OD · Right' },
                  { value: 'OU', label: 'OU' },
                  { value: 'OS', label: 'OS · Left' },
                ]}
                size="sm"
              />
            </section>
            <section>
              <h4>Illumination</h4>
              <select className="select" value={c.technique ?? ''} onChange={(e) => void updateCapture(c.id, { technique: e.target.value || undefined })}>
                <option value="">Not specified</option>
                {TECHNIQUES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </section>
            <section>
              <h4>Note</h4>
              <textarea
                className="textarea"
                rows={3}
                placeholder="Add a note…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onBlur={() => note !== (c.note ?? '') && void updateCapture(c.id, { note: note || undefined })}
              />
            </section>
            <dl className="meta-list">
              <div>
                <dt>Resolution</dt>
                <dd>
                  {c.width} × {c.height} <span className="muted">· {megapixels(c.width, c.height)}</span>
                </dd>
              </div>
              <div>
                <dt>File</dt>
                <dd>
                  {formatLabel(c.mime as ImageFormat) ?? c.mime} · {formatBytes(c.bytes)}
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{c.source === 'tether' ? 'Canon EOS (tethered)' : c.source === 'file' ? 'Imported file' : c.deviceLabel || 'Live camera'}</dd>
              </div>
              <div>
                <dt>Archive</dt>
                <dd className={cx(!c.archivedPath && 'muted')}>{c.archivedPath ?? 'Not yet written to disk'}</dd>
              </div>
            </dl>
            <Button size="sm" variant="ghost" icon="download" onClick={() => void download()}>
              {c.fileName}
            </Button>
          </aside>
        )}
      </div>

      {lb.ids.length > 1 && (
        <footer className="viewer-strip">
          {lb.ids.map((x, i) => {
            const k = captures.find((cc) => cc.id === x);
            return (
              <button key={x} type="button" className={cx('viewer-thumb', i === lb.index && 'is-on')} onClick={() => useApp.setState({ lightbox: { ...lb, index: i } })}>
                <Thumb id={x} alt="" />
                {k && <EyeTag eye={k.eye} />}
              </button>
            );
          })}
        </footer>
      )}
    </div>,
    document.body,
  );
}
