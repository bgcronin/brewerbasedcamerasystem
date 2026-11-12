import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ANNOTATION_COLORS, annotatedName, metrics, renderAnnotated, type AnnotationTool } from '../lib/annotations';
import { formatClock, formatShortDate } from '../lib/dates';
import { getImage, getVisit } from '../lib/db';
import { addDiagnosis, sameDiagnosis } from '../lib/diagnoses';
import { buildDicomFiles, buildSummaryPdf, copyPhotoToClipboard, ranksWithinVisits } from '../lib/exports';
import { uid } from '../lib/id';
import { displayName } from '../lib/names';
import { formatBytes, formatLabel, megapixels, patientFolderName } from '../lib/naming';
import { useOverlayFocus } from '../lib/overlay';
import { useFullImageFor } from '../lib/thumbs';
import { buildZip, downloadBlob } from '../lib/zip';
import { TECHNIQUES, techniqueLabel, type Annotation, type Capture, type Eye, type ImageFormat } from '../lib/types';
import { applyDiagnosesToVisit, closeLightbox, deleteCapture, openCompare, setAnnotations, setCaptureDiagnoses, toast, updateCapture, useApp } from '../state/store';
import { AnnotationLayer } from './AnnotationLayer';
import { DiagnosisPicker } from './DiagnosisPicker';
import { Icon, type IconName } from './Icon';
import { Button, EyeTag, IconButton, Segmented, Thumb, cx } from './ui';
import { ZOOM_FIT, ZoomPane, type ZoomState } from './ZoomPane';

const TOOLS: { tool: AnnotationTool; icon: IconName; label: string }[] = [
  { tool: 'ellipse', icon: 'ellipse', label: 'Circle (hold Shift for a perfect circle)' },
  { tool: 'arrow', icon: 'arrow', label: 'Arrow' },
  { tool: 'pen', icon: 'pen', label: 'Freehand' },
  { tool: 'text', icon: 'text', label: 'Text' },
  { tool: 'erase', icon: 'eraser', label: 'Erase a mark' },
];

/** How many thumbnails to keep either side of the current photo in the strip. */
const STRIP_REACH = 30;

/** A path that may wrap after "/" or "_", never in the middle of a word or the file extension. */
function breakable(path: string) {
  return path.split(/(?<=[/_])/).map((part, i) => (
    <Fragment key={i}>
      {part}
      <wbr />
    </Fragment>
  ));
}

/** Space, or any key the foot switch is set to send. */
function isPedal(e: KeyboardEvent): boolean {
  return e.code === 'Space' || useApp.getState().settings.captureKeys.includes(e.code);
}

function sameLabels(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((d) => y.some((e) => sameDiagnosis(d, e)));
}

export function Lightbox() {
  const lb = useApp((s) => s.lightbox);
  const patientCaptures = useApp((s) => s.captures);
  const library = useApp((s) => s.library);
  const allPatients = useApp((s) => s.allPatients);
  const activePatient = useApp((s) => s.patient);
  const recent = useApp((s) => s.settings.recentDiagnoses);
  const [view, setView] = useState<ZoomState>(ZOOM_FIT);
  const [info, setInfo] = useState(true);

  // The list follows the live photos: a deleted photo drops out, and comes back on Undo.
  const pool: Capture[] = lb?.source === 'library' ? (library ?? []) : patientCaptures;
  const byId = useMemo(() => new Map(pool.map((k) => [k.id, k])), [pool]);
  const ids = useMemo(() => (lb ? lb.ids.filter((x) => byId.has(x)) : []), [lb, byId]);
  const index = lb ? Math.min(lb.index, ids.length - 1) : -1;
  const id = index >= 0 ? ids[index] : null;
  const c = id ? byId.get(id) : undefined;
  const { url, forId: shownId } = useFullImageFor(c?.id);
  const [note, setNote] = useState('');

  // Annotation state. `marks` is the working copy, so quick strokes never race the save.
  const [annotating, setAnnotating] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>('ellipse');
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0].value);
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [showMarks, setShowMarks] = useState(true);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [textAt, setTextAt] = useState<{ x: number; y: number; clientX: number; clientY: number; scale: number } | null>(null);
  const [text, setText] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const clinicName = useApp((s) => s.settings.clinicName);
  const [busy, setBusy] = useState<'pdf' | 'dicom' | null>(null);
  /** The keyboard handler reaches the current copy action through this. */
  const copyRef = useRef<() => void>(() => undefined);
  const history = useRef<Annotation[][]>([]);
  const [undoable, setUndoable] = useState(0);
  const textCancelled = useRef(false);

  useEffect(() => {
    setView(ZOOM_FIT);
    setNote(c?.note ?? '');
    setMarks(c?.annotations ?? []);
    setTextAt(null);
    history.current = [];
    setUndoable(0);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lb && ids.length === 0) closeLightbox();
  }, [lb, ids.length]);

  useOverlayFocus(!!lb && !!c, root);

  useEffect(() => {
    if (!lb) {
      setAnnotating(false);
      setShowMarks(true);
    }
  }, [lb]);

  const step = (delta: number) => {
    if (!lb) return;
    useApp.setState({ lightbox: { ...lb, index: Math.min(ids.length - 1, Math.max(0, index + delta)) } });
  };

  const apply = (next: Annotation[]) => {
    if (!c) return;
    history.current.push(marks);
    setUndoable(history.current.length);
    setMarks(next);
    void setAnnotations(c.id, next);
  };
  const undo = () => {
    const prev = history.current.pop();
    if (!c || !prev) return;
    setUndoable(history.current.length);
    setMarks(prev);
    void setAnnotations(c.id, prev);
  };
  const startAnnotating = () => {
    setAnnotating(true);
    setShowMarks(true);
  };
  const commitText = () => {
    const at = textAt;
    const value = text.trim();
    setTextAt(null);
    setText('');
    if (textCancelled.current) {
      textCancelled.current = false;
      return;
    }
    if (at && value) apply([...marks, { id: uid(), kind: 'text', color, x: at.x, y: at.y, text: value }]);
  };

  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select')) {
        if (e.key === 'Escape') target.blur();
        return;
      }
      // The foot switch (Space, or whichever key it sends) must never "press" a button that
      // happens to have focus here, such as Delete after it was last clicked.
      if (isPedal(e) && !(annotating && e.code === 'Space')) {
        e.preventDefault();
        return;
      }
      if (annotating) {
        // While drawing, only the drawing keys work: nothing here can move to another photo or delete one.
        if (e.code === 'Space') {
          e.preventDefault();
          setSpaceHeld(true);
        } else if (e.repeat) return;
        else if (e.key === 'Escape') setAnnotating(false);
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') undo();
        else if (e.key === '0') setView(ZOOM_FIT);
        else return;
        e.preventDefault();
        return;
      }
      // A held key must never act more than once: Delete in particular.
      if (e.repeat || e.altKey) return;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+C copies the photo, unless some text is selected (then it copies the text, as usual).
        if (e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
          e.preventDefault();
          copyRef.current();
        }
        return;
      }
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'Delete') c && deleteCapture(c.id);
      else if (e.key.toLowerCase() === 's' && c) void updateCapture(c.id, { starred: !c.starred });
      else if (e.key.toLowerCase() === 'i') setInfo((v) => !v);
      else if (e.key.toLowerCase() === 'a') startAnnotating();
      else if (e.key.toLowerCase() === 'm' && marks.length) setShowMarks((v) => !v);
      else if (e.key.toLowerCase() === 'c') copyRef.current();
      else if (e.key === '0') setView(ZOOM_FIT);
      else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
      if (isPedal(e) && !(e.target as HTMLElement | null)?.closest?.('input, textarea, select')) e.preventDefault();
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [lb, c, ids, index, annotating, marks]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!lb || !c) return null;

  const everything = library ?? patientCaptures;
  const patient = allPatients.find((p) => p.id === c.patientId) ?? (activePatient?.id === c.patientId ? activePatient : null);
  const samePatient = everything.filter((x) => x.patientId === c.patientId);
  const sameEye = samePatient.filter((x) => x.id !== c.id && x.eye === c.eye).sort((a, b) => a.takenAt - b.takenAt);
  const compareWith = sameEye.filter((x) => x.date < c.date).pop() ?? sameEye[sameEye.length - 1];
  const visitMates = samePatient.filter((x) => x.visitId === c.visitId && x.id !== c.id);
  const matesDiffer = visitMates.some((x) => !sameLabels(x.diagnoses, c.diagnoses));

  // Suggest this patient's other diagnoses first, then the ones used most recently.
  let preferred: string[] = [];
  for (const x of [...samePatient].sort((a, b) => b.takenAt - a.takenAt)) for (const d of x.diagnoses ?? []) preferred = addDiagnosis(preferred, d);
  for (const d of recent ?? []) preferred = addDiagnosis(preferred, d);

  const download = async (withMarks: boolean) => {
    const img = await getImage(c.id);
    if (!img) return;
    if (withMarks && marks.length) downloadBlob(await renderAnnotated(img.full, marks, c.mime), annotatedName(c.fileName));
    else downloadBlob(img.full, c.fileName);
  };
  const applyToVisit = async () => {
    const n = await applyDiagnosesToVisit(c.id);
    toast({ tone: 'success', message: `Labelled ${n} more photo${n === 1 ? '' : 's'} from this visit` });
  };

  const marksVisible = showMarks || annotating;
  const shownMarks = marksVisible && marks.length ? marks : undefined;
  const failed = (what: string) => (e: unknown) => toast({ tone: 'error', message: what, detail: (e as Error)?.message });

  /** What is on screen goes to the clipboard: with its marks if they are showing. */
  const copy = () => {
    copyPhotoToClipboard(async () => {
      const img = await getImage(c.id);
      if (!img) throw new Error('The photo could not be read.');
      return { photo: img.full, annotations: shownMarks };
    }).then(() => toast({ tone: 'success', message: shownMarks ? 'Photo copied with its marks' : 'Photo copied', detail: 'Paste it into your letter or notes.' }), failed('Couldn’t copy the photo'));
  };
  copyRef.current = copy;

  const pdf = async () => {
    if (!patient) return;
    setBusy('pdf');
    try {
      const img = await getImage(c.id);
      if (!img) throw new Error('The photo could not be read.');
      const blob = await buildSummaryPdf({
        clinicName,
        patient,
        visitDate: c.date,
        sources: [{ capture: { ...c, annotations: shownMarks }, photo: img.full }],
        title: `${displayName(patient)}, ${formatShortDate(c.date)}`,
      });
      downloadBlob(blob, `${patientFolderName(patient)}_${c.date}_${c.eye}.pdf`);
    } catch (e) {
      failed('Couldn’t make the PDF')(e);
    } finally {
      setBusy(null);
    }
  };

  const dicom = async () => {
    if (!patient) return;
    setBusy('dicom');
    try {
      const [img, visit] = await Promise.all([getImage(c.id), getVisit(c.visitId)]);
      if (!img || !visit) throw new Error('The photo could not be read.');
      const rank = ranksWithinVisits(samePatient).get(c.id) ?? 1;
      const files = await buildDicomFiles([{ capture: { ...c, annotations: marks.length ? marks : undefined }, photo: img.full, patient, visit, rank }], clinicName);
      // One file as it is; an original with its marked copy as a pair in a ZIP.
      if (files.length === 1) downloadBlob(files[0].data, files[0].name);
      else downloadBlob(await buildZip(files.map((f) => ({ path: f.name, data: f.data }))), files[0].name.replace(/\.dcm$/, '_DICOM.zip'));
      toast({ tone: 'success', message: files.length === 1 ? 'DICOM file ready' : 'DICOM files ready', detail: files.length === 1 ? files[0].name : 'The photo and its marked copy, in a ZIP.' });
    } catch (e) {
      failed('Couldn’t make the DICOM file')(e);
    } finally {
      setBusy(null);
    }
  };
  const drawing = annotating && !spaceHeld;
  const from = Math.max(0, index - STRIP_REACH);
  const strip = ids.slice(from, index + STRIP_REACH + 1);

  return createPortal(
    <div ref={root} tabIndex={-1} className={cx('viewer', annotating && 'is-annotating')} role="dialog" aria-modal="true" aria-label="Photo viewer">
      {annotating ? (
        <header className="viewer-bar anno-bar" role="toolbar" aria-label="Annotation tools">
          <div className="anno-group">
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                type="button"
                className={cx('anno-tool', tool === t.tool && 'is-on')}
                onClick={() => setTool(t.tool)}
                aria-pressed={tool === t.tool}
                aria-label={t.label}
                title={t.label}
              >
                <Icon name={t.icon} size={18} />
              </button>
            ))}
          </div>
          <span className="anno-sep" aria-hidden="true" />
          <div className="anno-group">
            {ANNOTATION_COLORS.map((k) => (
              <button
                key={k.value}
                type="button"
                className={cx('anno-color', color === k.value && 'is-on')}
                style={{ ['--c' as string]: k.value }}
                onClick={() => {
                  setColor(k.value);
                  if (tool === 'erase') setTool('ellipse');
                }}
                aria-pressed={color === k.value}
                aria-label={k.label}
                title={k.label}
              />
            ))}
          </div>
          <span className="anno-sep" aria-hidden="true" />
          <div className="anno-group">
            <button type="button" className="anno-tool" onClick={undo} disabled={!undoable} aria-label="Undo" title="Undo (Ctrl+Z)">
              <Icon name="undo" size={18} />
            </button>
            <button type="button" className="anno-text-btn" onClick={() => apply([])} disabled={!marks.length}>
              Clear all
            </button>
          </div>
          <p className="anno-hint">
            {tool === 'text' ? 'Click where the label should go.' : tool === 'erase' ? 'Click a mark to remove it.' : 'Drag on the photo to draw.'} Scroll to zoom, hold Space to move. The original
            photo is never changed.
          </p>
          <button type="button" className="anno-done" onClick={() => setAnnotating(false)}>
            Done
          </button>
        </header>
      ) : (
        <header className="viewer-bar">
          <IconButton icon="chevronLeft" label="Back (Esc)" onClick={closeLightbox} />
          <div className="viewer-title">
            <EyeTag eye={c.eye} size="md" />
            <div>
              <strong>
                {patient ? displayName(patient) : ''}
                {patient?.mrn && <span className="mrn">{patient.mrn}</span>}
              </strong>
              <span className="meta-row">
                <span>{formatShortDate(c.date)}</span>
                <span>{formatClock(c.takenAt)}</span>
                {c.technique && <span>{techniqueLabel(c.technique)}</span>}
                {(c.diagnoses ?? []).map((d) => (
                  <span key={d} className="viewer-dx">
                    {d}
                  </span>
                ))}
              </span>
            </div>
          </div>
          <span className="viewer-count">
            {index + 1} of {ids.length}
          </span>
          <div className="viewer-actions">
            <IconButton icon="star" label="Star (S)" active={c.starred} onClick={() => void updateCapture(c.id, { starred: !c.starred })} />
            <IconButton icon="annotate" label="Annotate (A)" active={annotating} onClick={() => (annotating ? setAnnotating(false) : startAnnotating())} />
            {marks.length > 0 && !annotating && (
              <IconButton icon={showMarks ? 'eye' : 'eyeOff'} label={showMarks ? 'Hide marks (M)' : 'Show marks (M)'} onClick={() => setShowMarks((v) => !v)} />
            )}
            {compareWith && <IconButton icon="compare" label="Compare with another photo of this eye" onClick={() => openCompare(compareWith.id, c.id)} />}
            <IconButton icon="copy" label={shownMarks ? 'Copy with marks, to paste into a letter (C)' : 'Copy, to paste into a letter (C)'} onClick={copy} />
            <IconButton
              icon="download"
              label={marks.length && marksVisible ? 'Download with marks' : 'Download'}
              onClick={() => void download(marksVisible)}
            />
            <IconButton
              icon="trash"
              label="Delete (Del)"
              onClick={(e) => {
                deleteCapture(c.id);
                // The button stays on screen for the next photo: never leave it armed for Enter.
                e.currentTarget.blur();
              }}
            />
            <IconButton icon="info" label="Details (I)" active={info} onClick={() => setInfo((v) => !v)} />
          </div>
        </header>
      )}

      <div className={cx('viewer-body', info && 'has-info')}>
        <div className="viewer-stage">
          <ZoomPane
            src={url}
            naturalWidth={c.width}
            naturalHeight={c.height}
            view={view}
            onView={setView}
            alt={`${c.eye} ${techniqueLabel(c.technique)}`}
            locked={drawing}
            className={cx(annotating && spaceHeld && 'is-panning')}
            overlay={
              // Marks wait until their own photo is on screen (the previous one lingers for a moment when stepping).
              marksVisible && shownId === c.id && (marks.length > 0 || annotating) ? (
                <AnnotationLayer
                  width={c.width}
                  height={c.height}
                  annotations={marks}
                  tool={drawing ? tool : null}
                  color={color}
                  onAdd={(a) => apply([...marks, a])}
                  onRemove={(markId) => apply(marks.filter((m) => m.id !== markId))}
                  onText={(at) => {
                    setText('');
                    setTextAt(at);
                  }}
                />
              ) : null
            }
          />

          {textAt && (
            <input
              className="anno-text-input"
              autoFocus
              value={text}
              placeholder="Label"
              maxLength={60}
              style={{ left: textAt.clientX, top: textAt.clientY, fontSize: Math.max(13, metrics(c.width, c.height).font * textAt.scale), color }}
              onChange={(e) => setText(e.target.value)}
              onBlur={commitText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitText();
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                  textCancelled.current = true;
                  commitText();
                }
              }}
            />
          )}

          {!annotating && index > 0 && (
            <button type="button" className="viewer-nav viewer-prev" onClick={() => step(-1)} aria-label="Previous">
              <Icon name="chevronLeft" size={22} />
            </button>
          )}
          {!annotating && index < ids.length - 1 && (
            <button type="button" className="viewer-nav viewer-next" onClick={() => step(1)} aria-label="Next">
              <Icon name="chevronRight" size={22} />
            </button>
          )}
        </div>

        {info && (
          <aside className="viewer-info">
            <section>
              <h4>Diagnosis</h4>
              <DiagnosisPicker value={c.diagnoses ?? []} onChange={(next) => void setCaptureDiagnoses(c.id, next)} preferred={preferred} />
              {matesDiffer && (
                <button type="button" className="link-btn" onClick={() => void applyToVisit()}>
                  {c.diagnoses?.length ? 'Use for' : 'Clear on'} all {visitMates.length + 1} photos of this visit
                </button>
              )}
            </section>
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
            <section className="viewer-export">
              <h4>Export</h4>
              <Button size="sm" variant="ghost" icon="copy" onClick={copy}>
                Copy to clipboard
              </Button>
              <Button size="sm" variant="ghost" icon="download" onClick={() => void download(false)}>
                Download photo
              </Button>
              {marks.length > 0 && (
                <Button size="sm" variant="ghost" icon="download" onClick={() => void download(true)}>
                  Download with marks
                </Button>
              )}
              <Button size="sm" variant="ghost" icon="page" disabled={!patient || busy === 'pdf'} onClick={() => void pdf()}>
                {busy === 'pdf' ? 'Making the PDF…' : 'One-page PDF'}
              </Button>
              <Button size="sm" variant="ghost" icon="export" disabled={!patient || busy === 'dicom'} onClick={() => void dicom()}>
                {busy === 'dicom' ? 'Making the file…' : 'DICOM file'}
              </Button>
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
                  <br />
                  <span className="muted">{breakable(c.fileName)}</span>
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
                <dd className={cx(!c.archivedPath && 'muted')}>{c.archivedPath ? breakable(c.archivedPath) : 'Not yet written to disk'}</dd>
              </div>
            </dl>
          </aside>
        )}
      </div>

      {ids.length > 1 && (
        <footer className="viewer-strip">
          {strip.map((x, i) => {
            const k = byId.get(x);
            return (
              <button key={x} type="button" className={cx('viewer-thumb', from + i === index && 'is-on')} onClick={() => useApp.setState({ lightbox: { ...lb, index: from + i } })}>
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
