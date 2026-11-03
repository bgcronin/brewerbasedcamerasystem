import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { kindLabel, classifyDevice } from '../lib/camera';
import { formatClock, todayISO } from '../lib/dates';
import { fsSupported } from '../lib/fsaccess';
import { displayName } from '../lib/names';
import { useFullImage } from '../lib/thumbs';
import { techniqueLabel, type Capture, type Transform } from '../lib/types';
import { toggleStageFullscreen } from '../state/actions';
import { refreshStreamInfo, useCamera } from '../state/camera';
import {
  deleteCapture,
  discardHeldPhotos,
  fileHeldPhotos,
  openLightbox,
  openSheet,
  setTransform,
  setView,
  startTether,
  transformFor,
  updateCapture,
  updateSettings,
  useApp,
} from '../state/store';
import { Icon } from './Icon';
import { Button, EyeTag, IconButton, StatusDot, Thumb, cx } from './ui';

const ZOOMS = [1, 2, 4] as const;

/** Fit-aware CSS transform so rotated feeds still fill the stage correctly. */
function useFeedTransform(box: React.RefObject<HTMLDivElement | null>, mediaW: number, mediaH: number, t: Transform, zoom: number) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [box]);
  return useMemo(() => {
    let fit = 1;
    if ((t.rotate === 90 || t.rotate === 270) && mediaW && mediaH && size.w && size.h) {
      const s0 = Math.min(size.w / mediaW, size.h / mediaH);
      const s1 = Math.min(size.w / mediaH, size.h / mediaW);
      fit = s1 / s0;
    }
    const sx = fit * zoom * (t.flipH ? -1 : 1);
    const sy = fit * zoom * (t.flipV ? -1 : 1);
    return `rotate(${t.rotate}deg) scale(${sx}, ${sy})`;
  }, [t, zoom, mediaW, mediaH, size]);
}

function Reticle() {
  return (
    <svg className="reticle" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <circle cx="50" cy="50" r="34" />
      <circle cx="50" cy="50" r="17" />
      <circle cx="50" cy="50" r="0.6" className="reticle-dot" />
      <path d="M50 6v8M50 86v8M6 50h8M86 50h8M47 50h-3M53 50h3M50 47v-3M50 53v3" />
    </svg>
  );
}

function LiveFeed({ zoom, transform }: { zoom: number; transform: Transform }) {
  const status = useCamera((s) => s.status);
  const error = useCamera((s) => s.error);
  const info = useCamera((s) => s.info);
  const setVideo = useCamera((s) => s.setVideo);
  const deviceId = useApp((s) => s.settings.deviceId);
  const resolution = useApp((s) => s.settings.resolution);
  const box = useRef<HTMLDivElement>(null);
  const tf = useFeedTransform(box, info?.width ?? 0, info?.height ?? 0, transform, zoom);
  const started = useRef(false);

  // Start automatically when the browser already trusts this site with the camera.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const cam = useCamera.getState();
    if (cam.status !== 'idle') return;
    void navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((p) => {
        if (p.state === 'granted') void cam.start(deviceId, resolution);
      })
      .catch(() => undefined);
  }, [deviceId, resolution]);

  return (
    <div className="feed" ref={box}>
      <video
        ref={setVideo}
        className={cx('feed-video', status === 'live' && 'is-live')}
        style={{ transform: tf }}
        muted
        playsInline
        autoPlay
        onLoadedMetadata={refreshStreamInfo}
      />
      {status !== 'live' && (
        <div className="stage-empty">
          {status === 'starting' ? (
            <>
              <div className="spinner" />
              <p>Starting camera…</p>
            </>
          ) : (
            <>
              <div className={cx('stage-empty-icon', status === 'error' && 'is-error')}>
                <Icon name={status === 'error' ? 'alert' : 'camera'} size={26} />
              </div>
              <h3>{status === 'error' ? 'Camera unavailable' : status === 'unsupported' ? 'Camera not supported' : 'Connect the slit lamp camera'}</h3>
              <p>
                {status === 'error'
                  ? error
                  : status === 'unsupported'
                    ? 'This browser can’t access cameras. Use Chrome or Edge on the clinic PC.'
                    : 'The CSO Mizar, a Canon EOS in webcam mode, or an HDMI capture device will show here live.'}
              </p>
              <div className="stage-empty-actions">
                {status !== 'unsupported' && (
                  <Button variant="primary" icon="camera" onClick={() => void useCamera.getState().start(deviceId, resolution)}>
                    {status === 'error' ? 'Try again' : 'Start camera'}
                  </Button>
                )}
                <Button icon="usb" onClick={() => openSheet({ type: 'camera' })}>
                  Choose source
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TetherFeed({ zoom, lastCapture }: { zoom: number; lastCapture?: Capture }) {
  const tether = useApp((s) => s.tether);
  const url = useFullImage(lastCapture?.id);
  const box = useRef<HTMLDivElement>(null);
  const tf = useFeedTransform(box, 0, 0, { rotate: 0, flipH: false, flipV: false }, zoom);

  if (!fsSupported) {
    return (
      <div className="feed">
        <div className="stage-empty">
          <div className="stage-empty-icon is-error">
            <Icon name="alert" size={26} />
          </div>
          <h3>Folder watching needs Chrome or Edge</h3>
          <p>Open Lumen in Google Chrome or Microsoft Edge on the clinic PC to receive photos from the Canon.</p>
        </div>
      </div>
    );
  }

  if (!tether.watching) {
    const needsPermission = tether.status === 'needs-permission';
    return (
      <div className="feed">
        <div className="stage-empty">
          <div className="stage-empty-icon">
            <Icon name="folder" size={26} />
          </div>
          <h3>{needsPermission ? 'Allow access to the camera folder' : 'Connect the Canon EOS'}</h3>
          <p>
            {needsPermission
              ? `The browser needs your permission again to watch “${tether.name}”.`
              : 'Set EOS Utility’s Remote Shooting destination to a folder, then choose that folder here. Every shot appears instantly at full resolution.'}
          </p>
          <div className="stage-empty-actions">
            <Button variant="primary" icon="folder" onClick={() => void startTether()}>
              {needsPermission ? 'Allow and start' : tether.name ? `Watch “${tether.name}”` : 'Choose folder'}
            </Button>
            <Button icon="usb" onClick={() => openSheet({ type: 'camera' })}>
              Choose source
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="feed" ref={box}>
      {url ? (
        <img key={lastCapture?.id} src={url} className="feed-still" style={{ transform: tf }} alt="Last photo from the camera" />
      ) : (
        <div className="tether-wait">
          <div className="tether-rings" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h3>Ready for the Canon</h3>
          <p>Press the shutter or foot switch. Each photo saved to “{tether.name}” appears here.</p>
        </div>
      )}
    </div>
  );
}

function HeldBanner() {
  const held = useApp((s) => s.held);
  const patient = useApp((s) => s.patient);
  if (!held.length) return null;
  return (
    <div className="held-banner">
      <Icon name="image" size={16} />
      <span>
        {held.length} photo{held.length === 1 ? '' : 's'} waiting for a patient
      </span>
      {patient ? (
        <Button size="sm" variant="primary" onClick={() => void fileHeldPhotos()}>
          File to {displayName(patient)}
        </Button>
      ) : (
        <span className="held-hint">Choose a patient from the list</span>
      )}
      <Button size="sm" variant="ghost" onClick={discardHeldPhotos}>
        Dismiss
      </Button>
    </div>
  );
}

function Stage({ lastCapture }: { lastCapture?: Capture }) {
  const source = useApp((s) => s.settings.source);
  const reticle = useApp((s) => s.settings.reticle);
  const eye = useApp((s) => s.eye);
  const technique = useApp((s) => s.technique);
  const flashTick = useApp((s) => s.flashTick);
  const processing = useApp((s) => s.processing);
  const patient = useApp((s) => s.patient);
  const tether = useApp((s) => s.tether);
  useApp((s) => s.settings.transforms);
  const status = useCamera((s) => s.status);
  const label = useCamera((s) => s.deviceLabel);
  const info = useCamera((s) => s.info);
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
  const [isFull, setFull] = useState(false);

  const deviceKey = source === 'tether' ? 'Canon EOS (tethered)' : label;
  const t = transformFor(deviceKey);

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const live = source === 'live' ? status === 'live' : tether.watching;
  const kind = label ? classifyDevice(label) : 'generic';

  return (
    <div className={cx('stage', live && 'is-live')}>
      {source === 'live' ? <LiveFeed zoom={zoom} transform={t} /> : <TetherFeed zoom={zoom} lastCapture={lastCapture} />}

      {reticle && live && <Reticle />}
      {flashTick > 0 && <div key={flashTick} className="flash" aria-hidden="true" />}

      {live && (
        <div className="hud hud-tl">
          <div className={cx('eye-hud', `eye-${eye.toLowerCase()}`)}>
            <span className="eye-hud-code">{eye}</span>
            <span className="eye-hud-text">
              <span>{eye === 'OD' ? 'Right eye' : eye === 'OS' ? 'Left eye' : 'Both eyes'}</span>
              {technique && <span className="eye-hud-tech">{techniqueLabel(technique)}</span>}
            </span>
            {patient && (
              <span className="eye-hud-patient">
                <span>{displayName(patient)}</span>
                {patient.mrn && <span className="eye-hud-tech">{patient.mrn}</span>}
              </span>
            )}
          </div>
        </div>
      )}

      {live && (
        <div className="hud hud-tr glass-bar">
          <IconButton icon="reticle" label="Centring reticle (G)" active={reticle} onClick={() => void updateSettings({ reticle: !reticle })} />
          <button
            type="button"
            className={cx('icon-btn zoom-btn', zoom > 1 && 'is-active')}
            onClick={() => setZoom(ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length])}
            title="Focus magnifier"
            aria-label={`Magnify, currently ${zoom}×`}
          >
            {zoom}×
          </button>
          {source === 'live' && (
            <>
              <IconButton icon="rotate" label="Rotate 90°" onClick={() => void setTransform(deviceKey, { ...t, rotate: (((t.rotate + 90) % 360) as Transform['rotate']) })} />
              <IconButton icon="flip" label="Mirror image" active={t.flipH} onClick={() => void setTransform(deviceKey, { ...t, flipH: !t.flipH })} />
            </>
          )}
          <IconButton icon={isFull ? 'collapse' : 'expand'} label="Full screen (F)" onClick={toggleStageFullscreen} />
        </div>
      )}

      <div className="hud hud-bl">
        <button type="button" className="source-chip glass" onClick={() => openSheet({ type: 'camera' })}>
          <StatusDot tone={live ? 'live' : 'off'} />
          {source === 'live' ? (
            <>
              <span className="source-name">{status === 'live' ? label : 'No camera'}</span>
              {status === 'live' && info && (
                <span className="source-meta">
                  {kindLabel(kind) !== 'Camera' && <>{kindLabel(kind)} · </>}
                  {info.width}×{info.height}
                  {info.frameRate ? ` · ${info.frameRate} fps` : ''}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="source-name">Canon EOS · tethered</span>
              <span className="source-meta">{tether.watching ? `Watching “${tether.name}”` : 'Not watching'}</span>
            </>
          )}
          <Icon name="chevronDown" size={14} />
        </button>
      </div>

      {processing > 0 && (
        <div className="hud hud-br">
          <span className="saving glass">
            <span className="spinner spinner-sm" />
            Saving
          </span>
        </div>
      )}

      {!patient && live && <div className="stage-hint glass">Choose a patient to start photographing</div>}
      <HeldBanner />
    </div>
  );
}

function FilmTile({ c, index, ids, isNew }: { c: Capture; index: number; ids: string[]; isNew: boolean }) {
  return (
    <div className={cx('film-tile', isNew && 'is-new')}>
      <button type="button" className="film-open" onClick={() => openLightbox(ids, index)} aria-label={`Open photo ${index + 1}, ${c.eye}`}>
        <Thumb id={c.id} alt={`${c.eye} ${techniqueLabel(c.technique)}`} />
      </button>
      <EyeTag eye={c.eye} />
      {c.starred && (
        <span className="film-star">
          <Icon name="star" size={12} fill="currentColor" />
        </span>
      )}
      <div className="film-actions">
        <button type="button" title={c.starred ? 'Unstar' : 'Star'} onClick={() => void updateCapture(c.id, { starred: !c.starred })}>
          <Icon name="star" size={14} fill={c.starred ? 'currentColor' : 'none'} />
        </button>
        <button type="button" title="Delete" onClick={() => deleteCapture(c.id)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <span className="film-time">{formatClock(c.takenAt)}</span>
    </div>
  );
}

function Filmstrip({ today }: { today: Capture[] }) {
  const patient = useApp((s) => s.patient);
  const total = useApp((s) => s.captures.length);
  const lastId = useApp((s) => s.lastCaptureId);
  const keys = useApp((s) => s.settings.captureKeys);
  const tethered = useApp((s) => s.settings.source === 'tether');
  const strip = useRef<HTMLDivElement>(null);
  const ids = today.map((c) => c.id);

  useEffect(() => {
    const el = strip.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [today.length]);

  const counts = { OD: 0, OS: 0, OU: 0 };
  for (const c of today) counts[c.eye]++;

  return (
    <div className="filmstrip">
      <div className="film-head">
        <span className="film-title">Today</span>
        {today.length > 0 && (
          <span className="film-counts">
            <span className="eye-count eye-od">OD {counts.OD}</span>
            <span className="eye-count eye-os">OS {counts.OS}</span>
            {counts.OU > 0 && <span className="eye-count eye-ou">OU {counts.OU}</span>}
          </span>
        )}
        <span className="flex-1" />
        {patient && total > today.length && (
          <button type="button" className="link-btn" onClick={() => setView('review')}>
            {total - today.length} earlier · View history
          </button>
        )}
      </div>
      <div className="film-track" ref={strip}>
        {today.length ? (
          today.map((c, i) => <FilmTile key={c.id} c={c} index={i} ids={ids} isNew={c.id === lastId} />)
        ) : (
          <div className="film-empty">
            {patient && tethered ? (
              'Photos from the Canon appear here as soon as they’re taken.'
            ) : patient ? (
              <>
                Photos appear here. Press <kbd className="kbd">{keys[0] === 'Space' ? 'Space' : keys[0]}</kbd> or the shutter to capture.
              </>
            ) : (
              'Select a patient to begin.'
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function CaptureView() {
  const captures = useApp((s) => s.captures);
  const today = useMemo(() => captures.filter((c) => c.date === todayISO()), [captures]);
  const lastTether = useMemo(() => [...today].reverse().find((c) => c.source === 'tether'), [today]);
  return (
    <section className="capture">
      <Stage lastCapture={lastTether} />
      <Filmstrip today={today} />
    </section>
  );
}
