import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatClock, formatShortDate } from '../lib/dates';
import { getImage } from '../lib/db';
import { displayName } from '../lib/names';
import { formatBytes, formatLabel, megapixels } from '../lib/naming';
import { useFullImage } from '../lib/thumbs';
import { downloadBlob } from '../lib/zip';
import { TECHNIQUES, techniqueLabel, type Eye, type ImageFormat } from '../lib/types';
import { closeLightbox, deleteCapture, openCompare, updateCapture, useApp } from '../state/store';
import { Icon } from './Icon';
import { Button, EyeTag, IconButton, Segmented, Thumb, cx } from './ui';
import { ZOOM_FIT, ZoomPane, type ZoomState } from './ZoomPane';

export function Lightbox() {
  const lb = useApp((s) => s.lightbox);
  const captures = useApp((s) => s.captures);
  const patient = useApp((s) => s.patient);
  const [view, setView] = useState<ZoomState>(ZOOM_FIT);
  const [info, setInfo] = useState(true);
  // The list follows the live captures: a deleted photo drops out, and comes back on Undo.
  const ids = useMemo(() => (lb ? lb.ids.filter((x) => captures.some((k) => k.id === x)) : []), [lb, captures]);
  const index = lb ? Math.min(lb.index, ids.length - 1) : -1;
  const id = index >= 0 ? ids[index] : null;
  const c = captures.find((x) => x.id === id);
  const url = useFullImage(c?.id);
  const [note, setNote] = useState('');

  useEffect(() => {
    setView(ZOOM_FIT);
    setNote(c?.note ?? '');
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lb && ids.length === 0) closeLightbox();
  }, [lb, ids.length]);

  const step = (delta: number) => {
    if (!lb) return;
    useApp.setState({ lightbox: { ...lb, index: Math.min(ids.length - 1, Math.max(0, index + delta)) } });
  };

  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select')) {
        if (e.key === 'Escape') target.blur();
        return;
      }
      // A held key must never act more than once: Delete in particular.
      if (e.repeat) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'Delete') c && deleteCapture(c.id);
      else if (e.key.toLowerCase() === 's' && c) void updateCapture(c.id, { starred: !c.starred });
      else if (e.key.toLowerCase() === 'i') setInfo((v) => !v);
      else if (e.key === '0') setView(ZOOM_FIT);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lb, c, ids, index]); // eslint-disable-line react-hooks/exhaustive-deps

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
            <span className="meta-row">
              <span>{formatShortDate(c.date)}</span>
              <span>{formatClock(c.takenAt)}</span>
              {c.technique && <span>{techniqueLabel(c.technique)}</span>}
            </span>
          </div>
        </div>
        <span className="viewer-count">
          {index + 1} of {ids.length}
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
          {index > 0 && (
            <button type="button" className="viewer-nav viewer-prev" onClick={() => step(-1)} aria-label="Previous">
              <Icon name="chevronLeft" size={22} />
            </button>
          )}
          {index < ids.length - 1 && (
            <button type="button" className="viewer-nav viewer-next" onClick={() => step(1)} aria-label="Next">
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
                  { value: 'OD', label: 'OD Right' },
                  { value: 'OU', label: 'OU' },
                  { value: 'OS', label: 'OS Left' },
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
                  {c.width} × {c.height} <span className="muted">({megapixels(c.width, c.height)})</span>
                </dd>
              </div>
              <div>
                <dt>File</dt>
                <dd>
                  {formatLabel(c.mime as ImageFormat) ?? c.mime}, {formatBytes(c.bytes)}
                </dd>
              </div>
              {c.exposure && (
                <div>
                  <dt>Exposure</dt>
                  <dd>{[c.exposure.mode, c.exposure.tv, c.exposure.av, c.exposure.iso && `ISO ${c.exposure.iso}`, c.exposure.wb].filter(Boolean).join('  ')}</dd>
                </div>
              )}
              <div>
                <dt>Source</dt>
                <dd>{c.source === 'tether' ? 'Canon EOS (tethered)' : c.source === 'file' ? 'Imported file' : c.source === 'canon' ? `${c.deviceLabel ?? 'Canon EOS'} (direct)` : c.deviceLabel || 'Live camera'}</dd>
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

      {ids.length > 1 && (
        <footer className="viewer-strip">
          {ids.map((x, i) => {
            const k = captures.find((cc) => cc.id === x);
            return (
              <button key={x} type="button" className={cx('viewer-thumb', i === index && 'is-on')} onClick={() => useApp.setState({ lightbox: { ...lb, index: i } })}>
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
