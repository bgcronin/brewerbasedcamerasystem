import { useEffect, useState } from 'react';
import { fsSupported } from '../lib/fsaccess';
import { formatBytes } from '../lib/naming';
import type { DateOrder, ImageFormat, ThemePref } from '../lib/types';
import {
  chooseArchiveFolder,
  closeSheet,
  disconnectArchive,
  reconnectArchive,
  syncArchive,
  updateSettings,
  useApp,
} from '../state/store';
import { Icon } from './Icon';
import { Button, Kbd, Modal, Segmented, SheetHeader, StatusDot, Switch } from './ui';

function keyLabel(code: string): string {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace(/^Numpad/, 'Num ').replace(/^Arrow/, '');
}

function Row({ title, detail, children }: { title: string; detail?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <span className="set-row-title">{title}</span>
        {detail && <span className="set-row-detail">{detail}</span>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function KeyBinder() {
  const keys = useApp((s) => s.settings.captureKeys);
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Escape' && !keys.includes(e.code)) void updateSettings({ captureKeys: [...keys, e.code] });
      setListening(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, keys]);
  return (
    <div className="key-binder">
      {keys.map((k) => (
        <span key={k} className="key-chip">
          <Kbd>{keyLabel(k)}</Kbd>
          {keys.length > 1 && (
            <button type="button" aria-label={`Remove ${keyLabel(k)}`} onClick={() => void updateSettings({ captureKeys: keys.filter((x) => x !== k) })}>
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ))}
      <Button size="sm" variant={listening ? 'primary' : 'secondary'} onClick={() => setListening((l) => !l)}>
        {listening ? 'Press the key or pedal…' : 'Add key'}
      </Button>
    </div>
  );
}

export function SettingsSheet() {
  const open = useApp((s) => s.sheet?.type === 'settings');
  const settings = useApp((s) => s.settings);
  const archive = useApp((s) => s.archive);
  const [usage, setUsage] = useState<{ used: number; quota: number; persisted: boolean } | null>(null);
  const [clinic, setClinic] = useState(settings.clinicName);

  useEffect(() => {
    if (!open) return;
    setClinic(settings.clinicName);
    void (async () => {
      const est = await navigator.storage?.estimate?.();
      const persisted = (await navigator.storage?.persisted?.()) ?? false;
      if (est) setUsage({ used: est.usage ?? 0, quota: est.quota ?? 0, persisted });
    })();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const lossy = settings.format !== 'image/png';

  return (
    <Modal open={open} onClose={closeSheet} variant="side" width={460} labelledBy="settings-title">
      <SheetHeader id="settings-title" title="Settings" onClose={closeSheet} />
      <div className="settings-body">
        <section className="set-group">
          <h3>Clinic</h3>
          <div className="set-card">
            <Row title="Clinic name" detail="Shown in the top bar.">
              <input
                className="input input-sm"
                value={clinic}
                placeholder="e.g. Cornea Clinic"
                onChange={(e) => {
                  setClinic(e.target.value);
                  void updateSettings({ clinicName: e.target.value.trim() });
                }}
              />
            </Row>
          </div>
        </section>

        <section className="set-group">
          <h3>Archive folder</h3>
          <div className="set-card">
            {!fsSupported ? (
              <p className="set-note">
                Writing to folders needs Google Chrome or Microsoft Edge. Photos are still kept in this browser and can be exported from Review.
              </p>
            ) : (
              <>
                <div className="archive-status">
                  <StatusDot tone={archive.status === 'connected' ? 'ok' : archive.status === 'none' ? 'off' : archive.status === 'error' ? 'error' : 'warn'} />
                  <div>
                    <strong>{archive.name ?? 'Not connected'}</strong>
                    <span>
                      {archive.status === 'connected'
                        ? 'Each photo is written here as it’s taken, in a folder per patient and visit.'
                        : archive.status === 'needs-permission'
                          ? 'The browser needs permission again after a restart.'
                          : archive.status === 'error'
                            ? 'The folder couldn’t be written — is the drive or network share available?'
                            : 'Choose a folder on a backed-up drive or network share.'}
                    </span>
                  </div>
                </div>
                <div className="set-actions">
                  {archive.status === 'connected' ? (
                    <Button size="sm" icon="folder" onClick={() => void chooseArchiveFolder()}>
                      Change folder
                    </Button>
                  ) : archive.name ? (
                    <Button size="sm" variant="primary" icon="link" onClick={() => void reconnectArchive()}>
                      Reconnect
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" icon="folder" onClick={() => void chooseArchiveFolder()}>
                      Choose folder
                    </Button>
                  )}
                  {archive.pending > 0 && archive.status === 'connected' && (
                    <Button size="sm" icon="refresh" onClick={() => void syncArchive()}>
                      Write {archive.pending} pending
                    </Button>
                  )}
                  {archive.name && (
                    <Button size="sm" variant="ghost" onClick={() => void disconnectArchive()}>
                      Disconnect
                    </Button>
                  )}
                </div>
                {archive.pending > 0 && archive.status !== 'connected' && (
                  <p className="set-note warn">
                    {archive.pending} photo{archive.pending === 1 ? ' is' : 's are'} only in this browser so far.
                  </p>
                )}
              </>
            )}
            {usage && (
              <Row title="Browser storage" detail={usage.persisted ? 'Protected from automatic clean-up.' : 'Not yet protected — the browser may ask.'}>
                <span className="set-value">
                  {formatBytes(usage.used)} <span className="muted">of {formatBytes(usage.quota)}</span>
                </span>
              </Row>
            )}
          </div>
        </section>

        <section className="set-group">
          <h3>Photo format</h3>
          <div className="set-card">
            <Row title="File format" detail={settings.format === 'image/webp' ? 'About a third smaller than JPEG at the same quality.' : settings.format === 'image/png' ? 'Lossless. Files are 5–10× larger.' : 'Universally compatible.'}>
              <Segmented<ImageFormat>
                size="sm"
                value={settings.format}
                onChange={(format) => void updateSettings({ format })}
                options={[
                  { value: 'image/webp', label: 'WebP' },
                  { value: 'image/jpeg', label: 'JPEG' },
                  { value: 'image/png', label: 'PNG' },
                ]}
              />
            </Row>
            {lossy && (
              <Row title="Quality" detail={settings.quality >= 0.9 ? 'Visually lossless — recommended for clinical records.' : settings.quality >= 0.8 ? 'High. Fine detail may soften slightly.' : 'Smaller files; detail is lost.'}>
                <div className="range-wrap">
                  <input
                    className="range"
                    type="range"
                    min={0.7}
                    max={1}
                    step={0.01}
                    value={settings.quality}
                    onChange={(e) => void updateSettings({ quality: Number(e.target.value) })}
                  />
                  <span className="set-value tabular">{Math.round(settings.quality * 100)}</span>
                </div>
              </Row>
            )}
            <Row title="Keep camera originals" detail="Store JPEGs from the Canon or imported files exactly as the camera wrote them, instead of converting.">
              <Switch checked={settings.keepTetherOriginals} onChange={(v) => void updateSettings({ keepTetherOriginals: v })} label="Keep camera originals" />
            </Row>
          </div>
        </section>

        <section className="set-group">
          <h3>Capture</h3>
          <div className="set-card">
            <Row title="Shutter keys" detail="Set your foot switch to send one of these, or press Add key and tap the pedal.">
              <KeyBinder />
            </Row>
            <Row title="Shutter sound">
              <Switch checked={settings.shutterSound} onChange={(v) => void updateSettings({ shutterSound: v })} label="Shutter sound" />
            </Row>
            <Row title="Centring reticle" detail="Concentric guide over the live view.">
              <Switch checked={settings.reticle} onChange={(v) => void updateSettings({ reticle: v })} label="Centring reticle" />
            </Row>
            <Row title="Tidy the Canon folder" detail="Delete each photo from the EOS Utility folder once it’s safely stored.">
              <Switch checked={settings.removeTetherOriginals} onChange={(v) => void updateSettings({ removeTetherOriginals: v })} label="Remove originals after import" />
            </Row>
          </div>
        </section>

        <section className="set-group">
          <h3>Appearance</h3>
          <div className="set-card">
            <Row title="Theme" detail="Night keeps the room dark for slit lamp work.">
              <Segmented<ThemePref>
                size="sm"
                value={settings.theme}
                onChange={(theme) => void updateSettings({ theme })}
                options={[
                  { value: 'dark', label: <><Icon name="moon" size={14} />Night</> },
                  { value: 'light', label: <><Icon name="sun" size={14} />Day</> },
                  { value: 'system', label: 'Auto' },
                ]}
              />
            </Row>
          </div>
        </section>

        <section className="set-group">
          <h3>Importing</h3>
          <div className="set-card">
            <Row title="Dates in lists" detail="Auto works it out from the file; set it if your lists are ambiguous.">
              <Segmented<DateOrder>
                size="sm"
                value={settings.dateOrder}
                onChange={(dateOrder) => void updateSettings({ dateOrder })}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'DMY', label: 'DD/MM' },
                  { value: 'MDY', label: 'MM/DD' },
                ]}
              />
            </Row>
          </div>
        </section>

        <p className="settings-foot">
          Lumen runs entirely on this computer. Patient details and photographs are never uploaded — they live in this browser and your archive folder.
        </p>
      </div>
    </Modal>
  );
}
