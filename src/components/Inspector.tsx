import { useMemo } from 'react';
import { ageFromDOB, formatShortDate, todayISO } from '../lib/dates';
import { displayName } from '../lib/names';
import { TECHNIQUES, techniqueLabel, type Eye } from '../lib/types';
import { shutter } from '../state/actions';
import { useCamera } from '../state/camera';
import {
  EXPOSURE_KEYS,
  EXPOSURE_LABELS,
  chooseTechnique,
  currentValues,
  describeValues,
  sameValues,
  savePreset,
  setCanonProp,
  useCanon,
  type ExposureKey,
} from '../state/canon';
import { openSheet, setEye, setView, useApp } from '../state/store';
import { Icon } from './Icon';
import { Avatar, Button, Kbd, cx } from './ui';

const SEX: Record<string, string> = { M: 'Male', F: 'Female', O: 'Other' };

function keyName(code: string): string {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace(/^Numpad/, 'Num ');
}

function PatientCard() {
  const patient = useApp((s) => s.patient);
  const rows = useApp((s) => s.rows);
  const visits = useApp((s) => s.patientVisits);
  const captures = useApp((s) => s.captures);
  if (!patient) {
    return (
      <div className="pcard pcard-empty">
        <div className="pcard-empty-icon">
          <Icon name="user" size={22} />
        </div>
        <p>No patient selected</p>
        <span>Choose from the list, or use ↑ ↓</span>
      </div>
    );
  }
  const row = rows.find((r) => r.patient.id === patient.id);
  const visit = row?.visit;
  const age = ageFromDOB(patient.dob);
  const previous = visits.filter((v) => v.date < todayISO() && captures.some((c) => c.visitId === v.id)).length;
  return (
    <div className="pcard">
      <div className="pcard-top">
        <Avatar patient={patient} size={44} />
        <div className="pcard-id">
          <div className="pcard-name">{displayName(patient)}</div>
          {patient.mrn && <div className="pcard-mrn">{patient.mrn}</div>}
        </div>
        <button type="button" className="icon-btn pcard-edit" title="Edit patient" aria-label="Edit patient" onClick={() => openSheet({ type: 'patient', patientId: patient.id, visitId: visit?.id })}>
          <Icon name="edit" size={16} />
        </button>
      </div>
      <dl className="pcard-grid">
        <div>
          <dt>Born</dt>
          <dd>{patient.dob ? `${formatShortDate(patient.dob)}${age != null ? ` (${age})` : ''}` : '—'}</dd>
        </div>
        <div>
          <dt>Sex</dt>
          <dd>{SEX[patient.sex ?? ''] ?? '—'}</dd>
        </div>
        {visit && (visit.time || visit.clinic) && (
          <div>
            <dt>Appointment</dt>
            <dd>{[visit.time, visit.clinic].filter(Boolean).join(' · ')}</dd>
          </div>
        )}
        {visit?.clinician && (
          <div>
            <dt>Clinician</dt>
            <dd>{visit.clinician}</dd>
          </div>
        )}
        {visit?.reason && (
          <div className="pcard-wide">
            <dt>Reason</dt>
            <dd>{visit.reason}</dd>
          </div>
        )}
      </dl>
      {previous > 0 && (
        <button type="button" className="pcard-history" onClick={() => setView('review')}>
          <Icon name="clock" size={15} />
          <span>
            {previous} previous visit{previous === 1 ? '' : 's'} with photos
          </span>
          <Icon name="chevronRight" size={14} />
        </button>
      )}
    </div>
  );
}

const EYES: { eye: Eye; label: string; key: string }[] = [
  { eye: 'OD', label: 'Right', key: 'R' },
  { eye: 'OU', label: 'Both', key: 'B' },
  { eye: 'OS', label: 'Left', key: 'L' },
];

function EyePicker() {
  const eye = useApp((s) => s.eye);
  return (
    <div className="eye-picker" role="radiogroup" aria-label="Eye">
      {EYES.map((e) => (
        <button
          key={e.eye}
          type="button"
          role="radio"
          aria-checked={eye === e.eye}
          className={cx('eye-opt', `eye-${e.eye.toLowerCase()}`, eye === e.eye && 'is-on')}
          onClick={() => setEye(e.eye)}
          title={`${e.label} eye (${e.key})`}
        >
          <span className="eye-opt-code">{e.eye}</span>
          <span className="eye-opt-label">{e.label}</span>
        </button>
      ))}
    </div>
  );
}

function TechniqueGrid() {
  const technique = useApp((s) => s.technique);
  const presets = useApp((s) => (s.settings.source === 'canon' ? s.settings.cameraPresets : null));
  return (
    <div className="tech-grid">
      {TECHNIQUES.map((t, i) => (
        <button
          key={t.id}
          type="button"
          className={cx('tech', technique === t.id && 'is-on')}
          aria-pressed={technique === t.id}
          onClick={() => chooseTechnique(technique === t.id ? null : t.id)}
          title={`${t.label} (${i + 1})${presets?.[t.id] ? ` · camera preset: ${describeValues(presets[t.id])}` : ''}`}
        >
          <span className={cx('tech-swatch', `tech-${t.id}`)} aria-hidden="true" />
          <span className="tech-label">{t.short}</span>
          {presets?.[t.id] && <span className="tech-preset" aria-label="has camera preset" />}
          <span className="tech-key">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

function CameraPanel() {
  const props = useCanon((s) => s.props);
  const camera = useCanon((s) => s.camera);
  const link = useCanon((s) => s.link);
  const busy = useCanon((s) => s.pendingSets > 0);
  const technique = useApp((s) => s.technique);
  const presets = useApp((s) => s.settings.cameraPresets);
  if (link !== 'online' || camera?.state !== 'connected') return null;

  const mode = props.mode?.value;
  const values = currentValues();
  const preset = technique ? presets[technique] : undefined;
  const matches = sameValues(preset, values);
  const battery = props.battery?.value;
  const locked = EXPOSURE_KEYS.filter((k) => props[k] && !props[k]!.writable);

  return (
    <section className="insp-section">
      <h3 className="insp-title">
        Camera
        <span className="insp-keys cam-status">
          {mode && <span className="cam-mode">{mode}</span>}
          {battery != null && <span>{battery === 'AC' ? 'Mains' : `${battery}%`}</span>}
          {busy && <span className="spinner spinner-sm" />}
        </span>
      </h3>
      <div className="cam-grid">
        {EXPOSURE_KEYS.map((k: ExposureKey) => {
          const p = props[k];
          return (
            <label key={k} className={cx('cam-field', !p?.writable && 'is-locked')}>
              <span className="cam-label">{EXPOSURE_LABELS[k]}</span>
              <select
                className="cam-select"
                value={p?.value ?? ''}
                disabled={!p?.writable || !p.options?.length}
                onChange={(e) => void setCanonProp(k, e.target.value)}
                aria-label={EXPOSURE_LABELS[k]}
              >
                {p?.value && !p.options?.includes(p.value) && <option value={p.value}>{p.value}</option>}
                {(p?.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      {locked.some((k) => k === 'tv' || k === 'av') && mode && mode !== 'M' && (
        <p className="cam-note">The dial is on {mode}. Turn it to M to set shutter speed and aperture here.</p>
      )}
      {technique ? (
        matches ? (
          <div className="cam-preset is-saved">
            <span>✓ {techniqueLabel(technique)} preset</span>
          </div>
        ) : (
          <button type="button" className="cam-preset" onClick={() => void savePreset(technique)}>
            {preset ? `Update ${techniqueLabel(technique)} preset` : `Save as ${techniqueLabel(technique)} preset`}
          </button>
        )
      ) : (
        <p className="cam-note">Choose an illumination to save these settings as its preset.</p>
      )}
    </section>
  );
}

function ShutterArea() {
  const patient = useApp((s) => s.patient);
  const source = useApp((s) => s.settings.source);
  const keys = useApp((s) => s.settings.captureKeys);
  const tether = useApp((s) => s.tether);
  const eye = useApp((s) => s.eye);
  const captures = useApp((s) => s.captures);
  const camStatus = useCamera((s) => s.status);
  const canonOk = useCanon((s) => s.link === 'online' && s.camera?.state === 'connected');
  const today = useMemo(() => captures.filter((c) => c.date === todayISO()).length, [captures]);

  if (source === 'tether') {
    const ready = tether.watching && !!patient;
    return (
      <div className="shutter-area">
        <div className={cx('tether-indicator', ready && 'is-ready', `eye-${eye.toLowerCase()}`)}>
          <span className="tether-indicator-core">
            <Icon name="camera" size={24} />
          </span>
        </div>
        <div className="shutter-caption">
          {ready ? (
            <>
              <strong>Ready · {eye}</strong>
              <span>Press the shutter on the Canon</span>
            </>
          ) : (
            <>
              <strong>{tether.watching ? 'Choose a patient' : 'Camera folder not connected'}</strong>
              <span>{tether.watching ? 'Photos will be filed to them' : 'Set it up from the live view'}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  const disabled = !patient || (source === 'canon' ? !canonOk : camStatus !== 'live');
  return (
    <div className="shutter-area">
      <button
        type="button"
        className={cx('shutter', `eye-${eye.toLowerCase()}`)}
        disabled={disabled}
        onClick={(e) => {
          shutter();
          (e.currentTarget as HTMLButtonElement).blur();
        }}
        aria-label={`Capture ${eye}`}
      >
        <span className="shutter-ring" />
        <span className="shutter-core" />
      </button>
      <div className="shutter-caption">
        {disabled ? (
          <>
            <strong>{!patient ? 'Choose a patient' : source === 'canon' ? 'Canon not connected' : 'Camera not connected'}</strong>
            <span>{!patient ? 'to start photographing' : source === 'canon' ? 'See the live view for help' : 'Start it from the live view'}</span>
          </>
        ) : (
          <>
            <strong>
              Capture {eye}
              {today > 0 && <span className="shutter-count"> · {today} today</span>}
            </strong>
            <span>
              <Kbd>{keyName(keys[0] ?? 'Space')}</Kbd> or foot switch
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export function Inspector() {
  const isCanon = useApp((s) => s.settings.source === 'canon');
  return (
    <aside className="inspector" aria-label="Capture controls">
      <PatientCard />
      <section className="insp-section">
        <h3 className="insp-title">
          Eye <span className="insp-keys">R · B · L</span>
        </h3>
        <EyePicker />
      </section>
      <section className="insp-section">
        <h3 className="insp-title">
          Illumination <span className="insp-keys">1 – 8</span>
        </h3>
        <TechniqueGrid />
      </section>
      {isCanon && <CameraPanel />}
      <div className="flex-1" />
      <ShutterArea />
      <div className="insp-foot">
        <Button variant="ghost" size="sm" icon="import" onClick={() => document.getElementById('add-photos-input')?.click()}>
          Add photos from files
        </Button>
      </div>
    </aside>
  );
}
